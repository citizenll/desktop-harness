/** Embedded renderer carrier: custom-scheme fetch for unary calls and SSE streams. */

import { AbstractApiClient } from './api.ts'

/** Canonical origin owned by the Electron desktop protocol adapter. */
export const DESKTOP_ORIGIN = 'dsh://app'

/**
 * Renderer client for an embedded application whose privileged main process
 * handles fetch requests. The base class keeps SSE downlinks, so no socket or
 * listening port is required.
 */
export class EmbeddedApiClient extends AbstractApiClient {
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }

  protected override resolveBase(): string {
    return DESKTOP_ORIGIN
  }
}
