import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { normalizePluginInstallSource } from '../shared/plugin-install-intent'

export const DEFAULT_PLUGIN_INSTALL_WEB_PORT = 3080

const LOOPBACK_HOST = '127.0.0.1'
const INSTALL_PATH = '/plugin/install'
const MAX_REQUEST_BYTES = 8 * 1024
const REQUEST_TOKEN_TTL_MS = 2 * 60 * 1000

interface PluginInstallWebBridgeOptions {
  port?: number
  onInstallRequest(source: string): void | Promise<void>
}

interface InstallRequestBody {
  source?: unknown
  token?: unknown
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Stable loopback entry point for browser-originated plugin install links.
 *
 * Harness intentionally runs on a random private port. URL fragments are not
 * sent in HTTP requests, so a `/#dsh-plugin-install=...` link cannot be
 * forwarded by a normal redirect. This bridge serves a tiny same-origin page
 * on port 3080; the page reads its own fragment and submits the source to the
 * Desktop main process, which then opens the normal confirmation dialog.
 */
export class PluginInstallWebBridge {
  private readonly requestedPort: number
  private readonly onInstallRequest: PluginInstallWebBridgeOptions['onInstallRequest']
  private readonly requestTokens = new Map<string, number>()
  private server: Server | undefined
  private origin: string | undefined

  constructor(options: PluginInstallWebBridgeOptions) {
    this.requestedPort = options.port ?? DEFAULT_PLUGIN_INSTALL_WEB_PORT
    this.onInstallRequest = options.onInstallRequest
  }

  async start(): Promise<string> {
    if (this.server && this.origin) return this.origin

    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        const status = error instanceof RequestError ? error.status : 500
        const message = error instanceof Error ? error.message : String(error)
        this.sendJson(response, status, { ok: false, error: message })
      })
    })
    this.server = server

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(this.requestedPort, LOOPBACK_HOST, () => {
          server.off('error', onError)
          resolve()
        })
      })
    } catch (error) {
      this.server = undefined
      server.close()
      throw error
    }

    const address = server.address() as AddressInfo | null
    if (!address) {
      await this.stop()
      throw new Error('The plugin install web bridge did not expose a loopback address.')
    }
    this.origin = `http://${LOOPBACK_HOST}:${String(address.port)}`
    return this.origin
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.origin = undefined
    this.requestTokens.clear()
    if (!server?.listening) return

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.origin || !this.isTrustedHost(request.headers.host)) {
      throw new RequestError(403, 'Untrusted loopback host.')
    }

    const url = new URL(request.url ?? '/', this.origin)
    if (request.method === 'GET' && url.pathname === '/') {
      const token = this.issueRequestToken()
      this.sendHtml(response, pluginInstallBridgePage(token))
      return
    }
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204, this.securityHeaders())
      response.end()
      return
    }
    if (request.method !== 'POST' || url.pathname !== INSTALL_PATH) {
      throw new RequestError(404, 'Not found.')
    }
    if (request.headers.origin !== this.origin) {
      throw new RequestError(403, 'The install request must come from the loopback bridge page.')
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      throw new RequestError(415, 'The install request must be JSON.')
    }

    const body = await readInstallRequestBody(request)
    if (typeof body.token !== 'string' || !this.consumeRequestToken(body.token)) {
      throw new RequestError(403, 'The install request has expired. Reload the link and try again.')
    }
    const source = normalizePluginInstallSource(body.source)
    if (!source) throw new RequestError(400, 'The plugin source is invalid.')

    await this.onInstallRequest(source)
    this.sendJson(response, 202, { ok: true })
  }

  private issueRequestToken(): string {
    const now = Date.now()
    for (const [token, expiresAt] of this.requestTokens) {
      if (expiresAt <= now) this.requestTokens.delete(token)
    }
    const token = randomBytes(24).toString('base64url')
    this.requestTokens.set(token, now + REQUEST_TOKEN_TTL_MS)
    return token
  }

  private consumeRequestToken(token: string): boolean {
    const expiresAt = this.requestTokens.get(token)
    this.requestTokens.delete(token)
    return expiresAt !== undefined && expiresAt > Date.now()
  }

  private isTrustedHost(host: string | undefined): boolean {
    if (!host || !this.origin) return false
    const port = new URL(this.origin).port
    return host === `${LOOPBACK_HOST}:${port}` || host === `localhost:${port}`
  }

  private securityHeaders(): Record<string, string> {
    return {
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    }
  }

  private sendHtml(response: ServerResponse, body: string): void {
    response.writeHead(200, {
      ...this.securityHeaders(),
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    })
    response.end(body)
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent || response.writableEnded) return
    response.writeHead(status, {
      ...this.securityHeaders(),
      'content-type': 'application/json; charset=utf-8',
    })
    response.end(JSON.stringify(body))
  }
}

async function readInstallRequestBody(request: IncomingMessage): Promise<InstallRequestBody> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new RequestError(413, 'The install request is too large.')
    chunks.push(buffer)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as InstallRequestBody
  } catch {
    throw new RequestError(400, 'The install request is not valid JSON.')
  }
}

export function pluginInstallBridgePage(token: string): string {
  const encodedToken = JSON.stringify(token)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>DSH Desktop · Plugin Install</title>
  <style>
    :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:#17181a}
    main{width:min(520px,calc(100vw - 40px));box-sizing:border-box;padding:28px;border:1px solid #dfe1e5;border-radius:16px;background:#fff;box-shadow:0 18px 55px rgba(0,0,0,.12)}
    h1{margin:0 0 10px;font-size:20px}p{margin:0;color:#666b73;font-size:14px;line-height:1.65}.source{margin-top:18px;padding:12px;border-radius:10px;background:#f4f5f7;color:#25272b;overflow-wrap:anywhere}.error{color:#b42318}
    @media(prefers-color-scheme:dark){body{background:#171719;color:#f5f5f6}main{border-color:#343438;background:#232326}.source{background:#303034;color:#f5f5f6}p{color:#a9abb2}.error{color:#ff8a80}}
  </style>
</head>
<body>
  <main>
    <h1 id="title">正在发送插件安装请求…</h1>
    <p id="status">请稍候，DSH Desktop 将显示安装确认窗口。</p>
    <p class="source" id="source" hidden></p>
  </main>
  <script>
    (() => {
      const token = ${encodedToken};
      const params = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
      const source = params.get('dsh-plugin-install');
      const chinese = (navigator.language || '').toLowerCase().startsWith('zh');
      const title = document.getElementById('title');
      const status = document.getElementById('status');
      const sourceNode = document.getElementById('source');
      const fail = (message) => {
        title.textContent = chinese ? '无法发送安装请求' : 'Unable to send install request';
        status.textContent = message;
        status.className = 'error';
      };
      if (!source) {
        fail(chinese ? '链接中缺少 dsh-plugin-install 参数。' : 'The link has no dsh-plugin-install parameter.');
        return;
      }
      sourceNode.hidden = false;
      sourceNode.textContent = source;
      params.delete('dsh-plugin-install');
      history.replaceState(history.state, '', location.pathname + location.search + (params.toString() ? '#' + params : ''));
      fetch('${INSTALL_PATH}', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({source, token}),
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok !== true) throw new Error(body.error || 'HTTP ' + response.status);
        title.textContent = chinese ? '已发送到 DSH Desktop' : 'Sent to DSH Desktop';
        status.textContent = chinese ? '请返回应用并确认安装。此页面可以关闭。' : 'Return to the app and confirm the installation. You can close this page.';
      }).catch((error) => fail(error instanceof Error ? error.message : String(error)));
    })();
  </script>
</body>
</html>`
}
