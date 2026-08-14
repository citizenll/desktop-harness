/** Host registry plus trusted-fetch and optional HTTP adapters for Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  clientRequestSchema,
  RpcId,
  type ClientRequest,
  type RpcError,
  type RpcErrorDetailsMap,
  type RpcId as RpcIdType,
  type ServerResponse as RpcServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { bridge, type FetchHandler } from './http-bridge.ts'
import { isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type {
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: FetchHandler
  readonly options: ConnectionRpcHandlerOptions
}

interface DedicatedConnectionRpc {
  readonly fetchHandler: FetchHandler
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly channels = new Map<string, DedicatedConnectionRpc>()

  /**
   * Provide the Host half independently of a physical carrier.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by trusted-host channels.
   * @param apiFallback - transport-independent `/api` gateway fallback.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly apiFallback: FetchHandler,
  ) {
    super(ctx, 'connection')
  }

  /**
   * Dispatch an already-authorized Request through the shared or dedicated
   * channel tables. Physical carriers own their own admission checks.
   * @param request - trusted carrier request.
   * @returns the selected channel response, or 404 for an unknown path.
   */
  fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (pathname === API_PATH || pathname.startsWith(`${API_PATH}/`)) {
      return this.dispatchShared(API_PATH, this.apiFallback, request, false)
    }
    for (const [channel, registered] of this.channels) {
      if (pathname === channel || pathname.startsWith(`${channel}/`)) {
        return registered.fetchHandler.fetch(request)
      }
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler, options) => this.register(owner, channel, handler, options),
      intercept: (channel, matches, handler, options) =>
        this.registerInterceptor(owner, channel, matches, handler, options),
    }
  }

  /**
   * Compose one shared-channel Fetch handler from its interceptor and fallback.
   * @param channel - shared channel mounted by Connection.
   * @param fallback - handler for endpoints not claimed by the interceptor.
   * @returns Fetch handler that selects exactly one target for each request.
   */
  createSharedFetchHandler(
    channel: '/api',
    fallback: FetchHandler,
  ): FetchHandler {
    return {
      fetch: request => this.dispatchShared(channel, fallback, request, true),
    }
  }

  private dispatchShared(
    channel: '/api',
    fallback: FetchHandler,
    request: Request,
    enforceAuthority: boolean,
  ): Promise<Response> {
    const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
    const interceptor = this.interceptors.get(channel)
    if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
      return fallback.fetch(request)
    }
    if (enforceAuthority
      && interceptor.options.authority === 'loopback'
      && !isTrustedApiRequest(request, [])) {
      return Promise.resolve(new Response('forbidden', { status: 403 }))
    }
    return interceptor.fetchHandler.fetch(request)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    assertChannel(channel)
    const fetchHandler = rpcFetchHandler(channel, handler)
    return owner.effect(() => {
      if (this.channels.has(channel)) {
        throw new Error(`connection: RPC channel ${JSON.stringify(channel)} already has a handler`)
      }
      this.channels.set(channel, { fetchHandler })
      const httpFiber = owner.inject(['webServer'], (httpCtx) => {
        const trustedHosts = options.authority === 'loopback' ? [] : this.trustedHosts
        const route: WebRoute = {
          kind: 'prefix',
          path: channel,
          handler: async (req, res) => {
            if (!isTrustedApiRequest(req, trustedHosts)) {
              res.writeHead(403)
              res.end('forbidden')
              return
            }
            await bridge(req, res, fetchHandler)
          },
        }
        httpCtx.effect(
          () => httpCtx.webServer.register(route),
          `client-connection: ${channel} rpc HTTP channel`,
        )
      })
      return async () => {
        this.channels.delete(channel)
        await httpFiber.dispose()
      }
    }, `client-connection: ${channel} rpc channel`)
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler),
      options,
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
): FetchHandler {
  return {
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal)
        return fullResponse(message.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: RpcErrorDetailsMap['bad-request']['issues']): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: RpcError): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: RpcServerResponse['result']): Response {
  const body: RpcServerResponse = { type: 'server-response', rpcId, result }
  return Response.json(body)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}
