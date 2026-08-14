/**
 * Electron desktop surface composition and model-visible runtime context.
 * The package also owns `cordis.patch.yml`, declared by `dsh.bundle.patch`.
 * @module @deepseek-ai/dsh-desktop-app
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { addHarnessSourceSection } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Stable Cordis plugin name. */
export const name = 'desktop-app'
/** The canonical renderer URL owned by the Electron protocol handler. */
export const DSH_DESKTOP_URL = 'dsh://app/'
/** Environment variable exposing the embedded renderer URL to agent shells. */
export const DSH_DESKTOP_URL_KEY = 'DSH_DESKTOP_URL'
/** This installation's root from either the source or built package entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** Optional registries receive the surface contributions when composed. */
export const inject: string[] = []

function desktopSurfacePrompt(): string {
  return 'You are interacting with the user through the DeepSeek Harness Electron desktop application. '
    + 'When the user refers to "this app", "this window", or "the desktop app" without naming another target, they mean this application. '
    + 'The renderer provides no implicit DOM, route, screenshot, or selected-file context. '
    + 'The desktop application runs the Host and Client plugin graph in one process tree and serves the built Web shell through dsh://app without a listening port. '
    + 'Profile patch and installed bundle changes recompose the Host without restarting the desktop process; the plugin center reloads the renderer when its roster changes. '
    + 'TypeScript core-source changes affect the managed checkout only until a validated runtime generation is built and activated. '
    + 'Starting a separate Web server does not update this desktop window.'
}

/**
 * Register the Desktop orientation prompt and shell-visible renderer URL.
 * @param ctx - Host context that may acquire system-prompt and shell registries.
 */
export function apply(ctx: Context): void {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    addHarnessSourceSection(promptCtx, process.env.DSH_SOURCE_WORKSPACE ?? SOURCE_ROOT)
    promptCtx.systemPrompt.section({
      name: 'app:desktop-surface',
      order: -98,
      text: desktopSurfacePrompt,
    })
  })
  ctx.inject(['shellEnv'], (runtimeCtx) => {
    runtimeCtx.shellEnv.register({
      name: 'desktop-runtime',
      variables: {
        [DSH_DESKTOP_URL_KEY]: {
          description: 'Canonical renderer URL of the DeepSeek Harness Electron desktop application.',
        },
      },
      resolve: () => ({ [DSH_DESKTOP_URL_KEY]: DSH_DESKTOP_URL }),
    })
  })
}
