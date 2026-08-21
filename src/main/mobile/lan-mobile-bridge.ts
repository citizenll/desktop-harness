import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import QRCode from 'qrcode'
import {
  startCloudflareQuickTunnel,
  type PublicTunnelHandle,
  type PublicTunnelSnapshot,
  type StartPublicTunnelOptions
} from './public-tunnel'
import {
  renderDesktopPairingPage,
  renderMobilePage,
  renderMobileReconnectPage,
  renderPairingWaitPage
} from './lan-mobile-pages'

const MAX_BODY_BYTES = 64 * 1024
const PAIRING_TTL_MS = 5 * 60 * 1000
const MOBILE_CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"

const RPC_ALLOWLIST = new Set([
  'workspace.list',
  'session.list',
  'session.history',
  'session.create',
  'session.prompt',
  'session.cancel'
])

type MobileTransport = 'desktop' | 'lan' | 'public'

interface MobileRequestContext {
  transport: MobileTransport
  socketAddress: string
  clientAddress: string
}

type PublicTunnelStarter = (options: StartPublicTunnelOptions) => Promise<PublicTunnelHandle>

class RequestPolicyError extends Error {}

export interface LanMobileBridgeOptions {
  harnessUrl(): string | undefined
  locale?: 'en' | 'zh' | (() => 'en' | 'zh')
  brandLogoPaths?: { light: string; dark: string }
  appIconPath?: string
  port?: number
  now?: () => number
  onReconnectRequested?: () => void
  tunnelCacheDirectory?: string
  startPublicTunnel?: PublicTunnelStarter
  lanAddress?: () => string | undefined
}

export interface LanMobileBridgeSnapshot {
  running: boolean
  connected: boolean
  port?: number
  pairingUrl?: string
  lanPairingUrl?: string
  publicPairingUrl?: string
  desktopUrl?: string
  expiresAt?: number
  tunnel: PublicTunnelSnapshot
}

interface MobileSession {
  token: string
  remoteAddress: string
  transport: MobileTransport
}

interface PendingPairing {
  id: string
  remoteAddress: string
  transport: MobileTransport
  expiresAt: number
  decision?: boolean
}

export class LanMobileBridge {
  private server?: ReturnType<typeof createServer>
  private port?: number
  private pairingToken?: string
  private pairingExpiresAt?: number
  private readonly sessions = new Map<string, MobileSession>()
  private readonly suspendedSessions = new Map<string, MobileSession>()
  private readonly pendingPairings = new Map<string, PendingPairing>()
  private readonly now: () => number
  private tunnelState: PublicTunnelSnapshot = { phase: 'idle' }
  private tunnelHandle?: PublicTunnelHandle
  private tunnelStart?: Promise<LanMobileBridgeSnapshot>
  private tunnelAbort?: AbortController
  private tunnelExitUnsubscribe?: () => void
  private tunnelGeneration = 0

  constructor(private readonly options: LanMobileBridgeOptions) {
    this.now = options.now ?? Date.now
  }

  async start(): Promise<LanMobileBridgeSnapshot> {
    if (this.server) {
      this.ensurePairingToken()
      return this.snapshot()
    }
    this.rotatePairingToken()
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.json(response, error instanceof RequestPolicyError ? 403 : 500, {
          ok: false,
          error: message
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(this.options.port ?? 0, '0.0.0.0', resolve)
    })
    this.port = (this.server.address() as AddressInfo).port
    return this.snapshot()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.port = undefined
    await this.stopPublicAccess()
    this.pairingToken = undefined
    this.pairingExpiresAt = undefined
    this.sessions.clear()
    this.suspendedSessions.clear()
    this.pendingPairings.clear()
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  snapshot(): LanMobileBridgeSnapshot {
    const snapshot: LanMobileBridgeSnapshot = {
      running: Boolean(this.server),
      connected: this.sessions.size > 0,
      tunnel: { ...this.tunnelState }
    }
    if (!this.server || !this.port) return snapshot
    snapshot.port = this.port
    snapshot.desktopUrl = `http://127.0.0.1:${this.port}/desktop`
    if (!this.pairingToken || !this.pairingExpiresAt || this.pairingExpiresAt < this.now()) {
      return snapshot
    }
    snapshot.expiresAt = this.pairingExpiresAt
    const address = (this.options.lanAddress ?? preferredLanAddress)()
    if (address) {
      snapshot.lanPairingUrl = `http://${address}:${this.port}/pair?token=${this.pairingToken}`
      snapshot.pairingUrl = snapshot.lanPairingUrl
    }
    if (this.tunnelState.phase === 'ready' && this.tunnelState.url) {
      snapshot.publicPairingUrl = `${this.tunnelState.url}/pair?token=${this.pairingToken}`
    }
    return snapshot
  }

  async startPublicAccess(): Promise<LanMobileBridgeSnapshot> {
    if (!this.server || !this.port) await this.start()
    this.ensurePairingToken()
    if (this.tunnelHandle && this.tunnelState.phase === 'ready') return this.snapshot()
    if (this.tunnelStart) return await this.tunnelStart

    const generation = ++this.tunnelGeneration
    const abort = new AbortController()
    this.tunnelAbort = abort
    this.tunnelState = { phase: 'locating' }
    const starter = this.options.startPublicTunnel ?? startCloudflareQuickTunnel
    const port = this.port!
    const operation = (async (): Promise<LanMobileBridgeSnapshot> => {
      try {
        const handle = await starter({
          port,
          cacheDirectory:
            this.options.tunnelCacheDirectory ?? join(tmpdir(), 'dsh-desktop-cloudflared'),
          edgeBindAddress: (this.options.lanAddress ?? preferredLanAddress)(),
          signal: abort.signal,
          onPhase: (phase) => {
            if (generation !== this.tunnelGeneration || phase === 'ready' || phase === 'error') return
            this.tunnelState = { phase }
          }
        })
        if (generation !== this.tunnelGeneration || abort.signal.aborted) {
          await handle.stop()
          throw abortedTunnelStart()
        }
        let tunnelUrl: string
        try {
          tunnelUrl = normalizeTunnelUrl(handle.url)
        } catch (error) {
          await handle.stop().catch(() => undefined)
          throw error
        }
        this.tunnelHandle = handle
        this.tunnelState = { phase: 'ready', url: tunnelUrl }
        this.tunnelExitUnsubscribe?.()
        this.tunnelExitUnsubscribe = handle.onExit((error) => {
          if (this.tunnelHandle !== handle || generation !== this.tunnelGeneration) return
          this.tunnelHandle = undefined
          this.tunnelExitUnsubscribe = undefined
          this.tunnelState = error
            ? { phase: 'error', error: publicTunnelError(error) }
            : { phase: 'idle' }
        })
        return this.snapshot()
      } catch (error) {
        if (generation === this.tunnelGeneration) {
          this.tunnelState =
            error instanceof Error && error.name === 'AbortError'
              ? { phase: 'idle' }
              : { phase: 'error', error: publicTunnelError(error) }
        }
        throw error
      } finally {
        if (generation === this.tunnelGeneration) {
          this.tunnelStart = undefined
          this.tunnelAbort = undefined
        }
      }
    })()
    this.tunnelStart = operation
    return await operation
  }

  async stopPublicAccess(): Promise<LanMobileBridgeSnapshot> {
    ++this.tunnelGeneration
    const start = this.tunnelStart
    const handle = this.tunnelHandle
    this.tunnelStart = undefined
    this.tunnelHandle = undefined
    this.tunnelAbort?.abort()
    this.tunnelAbort = undefined
    this.tunnelExitUnsubscribe?.()
    this.tunnelExitUnsubscribe = undefined
    this.tunnelState = { phase: 'idle' }
    await handle?.stop().catch(() => undefined)
    await start?.catch(() => undefined)
    return this.snapshot()
  }

  private rotatePairingToken(): void {
    this.pairingToken = randomBytes(32).toString('base64url')
    this.pairingExpiresAt = this.now() + PAIRING_TTL_MS
  }

  private ensurePairingToken(): void {
    if (!this.pairingToken || !this.pairingExpiresAt || this.pairingExpiresAt < this.now()) {
      this.rotatePairingToken()
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('x-frame-options', 'DENY')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader(
      'content-security-policy',
      `${MOBILE_CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`
    )

    const context = this.requestContext(request)
    if (!context) return this.text(response, 403, 'This connection route is not allowed.')
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (request.method === 'GET' && url.pathname.startsWith('/brand-logo/')) {
      const variant = url.pathname === '/brand-logo/dark' ? 'dark' : 'light'
      const path = this.options.brandLogoPaths?.[variant]
      if (!path) return this.text(response, 404, 'Brand asset not found.')
      try {
        const body = await readFile(path)
        response.statusCode = 200
        response.setHeader('content-type', 'image/png')
        response.setHeader('cache-control', 'public, max-age=3600')
        response.end(body)
      } catch {
        this.text(response, 404, 'Brand asset not found.')
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/app-icon') {
      const path = this.options.appIconPath
      if (!path) return this.text(response, 404, 'App icon not found.')
      try {
        const body = await readFile(path)
        response.statusCode = 200
        response.setHeader('content-type', 'image/png')
        response.setHeader('cache-control', 'public, max-age=86400')
        response.end(body)
      } catch {
        this.text(response, 404, 'App icon not found.')
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/desktop') {
      if (context.transport !== 'desktop') return this.text(response, 403, 'Desktop only.')
      const embedded = url.searchParams.get('embedded') === '1'
      const parentOrigin = embedded ? trustedHarnessOrigin(this.options.harnessUrl()) : undefined
      if (embedded && !parentOrigin) {
        return this.text(response, 503, 'The Harness origin is not ready for an embedded panel.')
      }
      if (parentOrigin) {
        response.removeHeader('x-frame-options')
        response.setHeader(
          'content-security-policy',
          `${MOBILE_CONTENT_SECURITY_POLICY}; frame-ancestors ${parentOrigin}`
        )
      }
      this.ensurePairingToken()
      const snapshot = this.snapshot()
      if (!snapshot.desktopUrl || !snapshot.expiresAt) return this.text(response, 503, 'Bridge unavailable.')
      return this.html(
        response,
        renderDesktopPairingPage({
          lanPairingUrl: snapshot.lanPairingUrl,
          publicPairingUrl: snapshot.publicPairingUrl,
          tunnel: snapshot.tunnel,
          expiresAt: snapshot.expiresAt,
          locale: this.locale(),
          connected: this.sessions.size > 0,
          embedded,
          parentOrigin
        })
      )
    }

    if (request.method === 'GET' && url.pathname === '/desktop/qr') {
      if (context.transport !== 'desktop') return this.text(response, 403, 'Desktop only.')
      this.ensurePairingToken()
      const snapshot = this.snapshot()
      const target = url.searchParams.get('target')
      const pairingUrl = target === 'public' ? snapshot.publicPairingUrl : snapshot.lanPairingUrl
      if (!pairingUrl) return this.text(response, 404, 'Connection route unavailable.')
      const svg = await QRCode.toString(pairingUrl, { type: 'svg', margin: 1, width: 240 })
      response.statusCode = 200
      response.setHeader('content-type', 'image/svg+xml; charset=utf-8')
      response.end(svg)
      return
    }

    if (request.method === 'GET' && url.pathname === '/desktop/pending') {
      if (context.transport !== 'desktop') return this.text(response, 403, 'Desktop only.')
      const pending = [...this.pendingPairings.values()].find(
        (item) => item.decision === undefined && item.expiresAt >= this.now()
      )
      return this.json(
        response,
        200,
        pending ? { id: pending.id, remoteAddress: pending.remoteAddress, transport: pending.transport } : {}
      )
    }

    if (request.method === 'GET' && url.pathname === '/desktop/status') {
      if (context.transport !== 'desktop') return this.text(response, 403, 'Desktop only.')
      this.ensurePairingToken()
      return this.json(response, 200, this.snapshot())
    }

    if (request.method === 'POST' && url.pathname === '/desktop/tunnel/start') {
      if (context.transport !== 'desktop') return this.text(response, 403, 'Desktop only.')
      this.verifySameOrigin(request)
      return this.json(response, 200, await this.startPublicAccess())
    }

    if (request.method === 'POST' && url.pathname === '/desktop/tunnel/stop') {
      if (context.transport !== 'desktop') return this.text(response, 403, 'Desktop only.')
      this.verifySameOrigin(request)
      return this.json(response, 200, await this.stopPublicAccess())
    }

    if (request.method === 'POST' && url.pathname === '/desktop/disconnect') {
      if (context.transport !== 'desktop') return this.text(response, 403, 'Desktop only.')
      this.verifySameOrigin(request)
      for (const [token, session] of this.sessions) this.suspendedSessions.set(token, session)
      this.sessions.clear()
      this.pendingPairings.clear()
      this.rotatePairingToken()
      return this.json(response, 200, { ok: true })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/decide') {
      if (context.transport !== 'desktop') return this.text(response, 403, 'Desktop only.')
      this.verifySameOrigin(request)
      const input = JSON.parse(await readBody(request)) as { id?: unknown; approved?: unknown }
      const pending = typeof input.id === 'string' ? this.pendingPairings.get(input.id) : undefined
      if (!pending || typeof input.approved !== 'boolean') {
        return this.text(response, 404, 'Pairing request not found.')
      }
      pending.decision = input.approved
      return this.json(response, 200, { ok: true })
    }

    if (request.method === 'GET' && url.pathname === '/disconnected') {
      return this.html(response, renderMobileReconnectPage(this.locale()))
    }

    if (request.method === 'GET' && url.pathname === '/reconnect') {
      const pending = this.reconnectPairing(context)
      this.options.onReconnectRequested?.()
      return this.html(response, renderPairingWaitPage(pending.id, this.locale()))
    }

    if (request.method === 'POST' && url.pathname === '/pair/retry') {
      this.verifySameOrigin(request)
      const pending = this.reconnectPairing(context)
      this.options.onReconnectRequested?.()
      return this.json(response, 200, { id: pending.id, expiresAt: pending.expiresAt })
    }

    if (request.method === 'GET' && url.pathname === '/pair') {
      if (this.authorized(request, context)) {
        response.statusCode = 302
        response.setHeader('location', '/')
        response.end()
        return
      }
      if (!this.validPairingToken(url.searchParams.get('token'))) {
        return this.text(response, 401, 'This pairing link is invalid or expired.')
      }
      const id = randomUUID()
      this.pendingPairings.set(id, {
        id,
        remoteAddress: context.clientAddress,
        transport: context.transport,
        expiresAt: this.pairingExpiresAt!
      })
      return this.html(response, renderPairingWaitPage(id, this.locale()))
    }

    if (request.method === 'GET' && url.pathname === '/pair/status') {
      const id = url.searchParams.get('id')
      const pending = id ? this.pendingPairings.get(id) : undefined
      if (!pending) return this.json(response, 200, { expired: true })
      if (pending.expiresAt < this.now()) {
        this.pendingPairings.delete(pending.id)
        return this.json(response, 200, { expired: true })
      }
      if (pending.decision === false) {
        this.pendingPairings.delete(pending.id)
        return this.json(response, 200, { denied: true })
      }
      if (pending.decision !== true) return this.json(response, 200, { pending: true })
      const existingToken = this.mobileToken(request)
      if (existingToken && this.suspendedSessions.has(existingToken)) {
        this.sessions.set(existingToken, {
          token: existingToken,
          remoteAddress: pending.remoteAddress,
          transport: pending.transport
        })
        this.suspendedSessions.delete(existingToken)
      }
      for (const [savedToken, session] of this.suspendedSessions) {
        if (session.remoteAddress !== pending.remoteAddress || session.transport !== pending.transport) continue
        this.sessions.set(savedToken, session)
        this.suspendedSessions.delete(savedToken)
      }
      const token = randomBytes(32).toString('base64url')
      this.sessions.set(token, {
        token,
        remoteAddress: pending.remoteAddress,
        transport: pending.transport
      })
      this.pendingPairings.delete(pending.id)
      this.pairingToken = undefined
      this.pairingExpiresAt = undefined
      const secure = pending.transport === 'public' ? '; Secure' : ''
      response.setHeader(
        'set-cookie',
        `dsh_mobile=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`
      )
      return this.json(response, 200, { approved: true })
    }

    if (!this.authorized(request, context)) {
      this.rememberMobileContext(request, context)
      if (!this.authorized(request, context)) {
        if (request.method === 'GET' && url.pathname === '/') {
          return this.html(response, renderMobileReconnectPage(this.locale()))
        }
        return this.text(response, 401, 'Pair your phone again.')
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      return this.json(response, 200, { connected: true })
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return this.html(response, renderMobilePage({ locale: this.locale() }))
    }
    if (request.method === 'POST' && url.pathname === '/api/rpc') {
      this.verifySameOrigin(request)
      const input = JSON.parse(await readBody(request)) as { method?: unknown; payload?: unknown }
      if (typeof input.method !== 'string' || !RPC_ALLOWLIST.has(input.method)) {
        return this.json(response, 403, { ok: false, error: 'RPC method is not available on mobile.' })
      }
      const result = await this.forwardRpc(input.method, input.payload ?? {})
      return this.json(response, result.ok ? 200 : 400, result)
    }
    this.text(response, 404, 'Not found.')
  }

  private requestContext(request: IncomingMessage): MobileRequestContext | undefined {
    const socketAddress = normalizeRemoteAddress(request.socket.remoteAddress ?? '')
    const host = normalizeHost(request.headers.host)
    if (isLoopbackAddress(socketAddress) && isTryCloudflareHost(host)) {
      const activeHost = this.tunnelState.url ? normalizeHost(new URL(this.tunnelState.url).host) : ''
      if (!activeHost || host !== activeHost) return undefined
      return {
        transport: 'public',
        socketAddress,
        clientAddress: forwardedClientAddress(request) ?? socketAddress
      }
    }
    if (isLoopbackAddress(socketAddress)) {
      if (!isDesktopHost(host)) return undefined
      return { transport: 'desktop', socketAddress, clientAddress: socketAddress }
    }
    if (isPrivateAddress(socketAddress)) {
      return { transport: 'lan', socketAddress, clientAddress: socketAddress }
    }
    return undefined
  }

  private locale(): 'en' | 'zh' {
    const value = this.options.locale
    return typeof value === 'function' ? value() : value ?? 'en'
  }

  private validPairingToken(candidate: string | null): boolean {
    if (!candidate || !this.pairingToken || !this.pairingExpiresAt) return false
    if (this.now() > this.pairingExpiresAt) return false
    const left = Buffer.from(candidate)
    const right = Buffer.from(this.pairingToken)
    return left.length === right.length && timingSafeEqual(left, right)
  }

  private reconnectPairing(context: MobileRequestContext): PendingPairing {
    const current = [...this.pendingPairings.values()].find(
      (item) =>
        item.remoteAddress === context.clientAddress &&
        item.transport === context.transport &&
        item.decision === undefined &&
        item.expiresAt >= this.now()
    )
    if (current) return current
    const pending = {
      id: randomUUID(),
      remoteAddress: context.clientAddress,
      transport: context.transport,
      expiresAt: this.now() + PAIRING_TTL_MS
    }
    this.pendingPairings.set(pending.id, pending)
    return pending
  }

  private authorized(request: IncomingMessage, context: MobileRequestContext): boolean {
    const token = this.mobileToken(request)
    if (token && this.sessions.has(token)) return true
    if (context.transport === 'public') return false
    return [...this.sessions.values()].some(
      (session) =>
        session.transport !== 'public' && session.remoteAddress === context.clientAddress
    )
  }

  private mobileToken(request: IncomingMessage): string | undefined {
    const cookie = request.headers.cookie ?? ''
    return /(?:^|;\s*)dsh_mobile=([^;]+)/.exec(cookie)?.[1]
  }

  private rememberMobileContext(request: IncomingMessage, context: MobileRequestContext): void {
    if (context.transport === 'public') return
    const token = this.mobileToken(request)
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return
    const sameDeviceIsActive = [...this.sessions.values()].some(
      (session) =>
        session.transport !== 'public' && session.remoteAddress === context.clientAddress
    )
    if (sameDeviceIsActive) {
      this.sessions.set(token, {
        token,
        remoteAddress: context.clientAddress,
        transport: context.transport
      })
      this.suspendedSessions.delete(token)
      return
    }
    if (!this.suspendedSessions.has(token) && this.suspendedSessions.size >= 16) {
      const oldest = this.suspendedSessions.keys().next().value
      if (oldest) this.suspendedSessions.delete(oldest)
    }
    this.suspendedSessions.set(token, {
      token,
      remoteAddress: context.clientAddress,
      transport: context.transport
    })
  }

  private verifySameOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin
    const host = request.headers.host
    if (!origin || !host) return
    try {
      if (normalizeHost(new URL(origin).host) === normalizeHost(host)) return
    } catch {
      // Invalid origins are rejected below.
    }
    throw new RequestPolicyError('Cross-origin request rejected.')
  }

  private async forwardRpc(
    method: string,
    payload: unknown
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    const base = this.options.harnessUrl()
    if (!base) return { ok: false, error: 'Harness is not ready.' }
    const rpcId = randomUUID()
    const response = await fetch(new URL(`/api/${method}`, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) return { ok: false, error: `Harness transport returned HTTP ${response.status}.` }
    const envelope = (await response.json()) as {
      rpcId?: unknown
      result?: { ok?: unknown; value?: unknown; error?: { message?: unknown } }
    }
    if (envelope.rpcId !== rpcId) {
      return { ok: false, error: 'Harness RPC response did not match the request.' }
    }
    if (envelope.result?.ok !== true) {
      const message = envelope.result?.error?.message
      return {
        ok: false,
        error: typeof message === 'string' ? message : 'Harness rejected the request.'
      }
    }
    return { ok: true, value: envelope.result.value }
  }

  private html(response: ServerResponse, body: string): void {
    response.statusCode = 200
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(body)
  }

  private text(response: ServerResponse, status: number, body: string): void {
    response.statusCode = status
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.end(body)
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) {
      response.end()
      return
    }
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.end(JSON.stringify(body))
  }
}

export function preferredLanAddress(): string | undefined {
  return selectPreferredLanAddress(networkInterfaces())
}

export function selectPreferredLanAddress(
  interfaces: ReturnType<typeof networkInterfaces>
): string | undefined {
  const candidates: Array<{ address: string; score: number; order: number }> = []
  let order = 0
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      const currentOrder = order++
      if (entry.family !== 'IPv4' || entry.internal || !isPrivateAddress(entry.address)) continue
      if (/^169\.254\./.test(entry.address)) continue
      candidates.push({
        address: entry.address,
        score: addressPreference(entry.address) + interfacePreference(name),
        order: currentOrder
      })
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.order - right.order)
  return candidates[0]?.address
}

export function normalizeRemoteAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

export function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address === '127.0.0.1'
}

export function isPrivateAddress(address: string): boolean {
  if (isLoopbackAddress(address)) return true
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true
  const match = /^172\.(\d+)\./.exec(address)
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true
  return /^f[cd][0-9a-f]{2}:/i.test(address) || /^fe[89ab][0-9a-f]:/i.test(address)
}

function addressPreference(address: string): number {
  if (/^192\.168\./.test(address)) return 90
  if (/^10\./.test(address)) return 70
  if (/^172\./.test(address)) return 40
  return 10
}

function interfacePreference(name: string): number {
  const normalized = name.toLowerCase()
  if (
    /vethernet|hyper-v|wsl|docker|container|vmware|virtualbox|tailscale|zerotier|radmin|hamachi|vpn|tun|tap|loopback|bluetooth|bridge/.test(
      normalized
    )
  ) {
    return -500
  }
  if (/wi-?fi|wlan|wireless|无线|en\d+|wl[a-z0-9]+/.test(normalized)) return 260
  if (/ethernet|以太网|本地连接|eth\d+/.test(normalized)) return 220
  return 0
}

function forwardedClientAddress(request: IncomingMessage): string | undefined {
  const cloudflare = headerValue(request.headers['cf-connecting-ip'])
  const forwarded = headerValue(request.headers['x-forwarded-for'])?.split(',', 1)[0]?.trim()
  const candidate = cloudflare ?? forwarded
  return candidate ? normalizeRemoteAddress(candidate) : undefined
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function normalizeHost(value: string | undefined): string {
  if (!value) return ''
  const lower = value.trim().toLowerCase().replace(/\.$/, '')
  if (lower.startsWith('[')) {
    const closingBracket = lower.indexOf(']')
    return closingBracket >= 0 ? lower.slice(0, closingBracket + 1) : lower
  }
  return lower.replace(/:\d+$/, '')
}

function isDesktopHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

function trustedHarnessOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      !isDesktopHost(url.hostname.toLowerCase())
    ) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}

function isTryCloudflareHost(host: string): boolean {
  return /^[a-z0-9-]+\.trycloudflare\.com$/i.test(host)
}

function normalizeTunnelUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !isTryCloudflareHost(normalizeHost(url.host))) {
    throw new Error('cloudflared returned an unexpected public URL.')
  }
  return `${url.protocol}//${normalizeHost(url.host)}`
}

function publicTunnelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 1200 ? `${message.slice(0, 1200)}…` : message
}

function abortedTunnelStart(): Error {
  const error = new Error('Public access startup was cancelled.')
  error.name = 'AbortError'
  return error
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
