/**
 * dsh-market host entry: mounts the market's HTTP routes once the profile
 * composes the webServer and shell services.
 */
import { createDesktopPluginRuntime } from './dsh-cli.js';
import { mountMarketRoutes } from './routes.js';
export const name = 'dsh-market';
/**
 * Resolve the host's `agents` inventory lazily — at request time, not at
 * market startup, so the guard sees whichever agents exist by the time an
 * update is asked for. Hosts without the service return undefined and the
 * update route stays open (see src/agents.ts).
 */
function agentsLookupOf(ctx) {
    return () => ctx.get('agents');
}
export function apply(ctx, _config) {
    ctx.inject(['webServer', 'loader'], (hostCtx) => {
        const host = hostCtx;
        const desktopProfiles = ctx.get('desktopProfiles');
        if (desktopProfiles === undefined) {
            throw new Error('dsh-desktop-market requires the Desktop profile service.');
        }
        // Desktop's supported cross-environment contract guarantees that
        // desktopProfiles exists before Loader entries mount, and prescribes this
        // presence check plus a nested desktopPnpm injection:
        // https://github.com/anywhere-labs/deepseek-harness-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md#L190-L243
        hostCtx.inject(['desktopPnpm'], (desktopCtx) => {
            const current = desktopProfiles.current;
            const service = desktopCtx.desktopPnpm;
            const runtime = createDesktopPluginRuntime(service, current.dir);
            const resolved = {
                profile: current.name,
                profileDirectory: current.dir,
                // Relaunching a raw Electron process would bypass Desktop's launcher
                // lifecycle. The shell remains responsible for restart in this mode.
                allowRestart: false,
            };
            const desktopHost = desktopCtx;
            desktopHost.effect(() => {
                const disposeRoutes = mountMarketRoutes(host, resolved, runtime, agentsLookupOf(ctx));
                return async () => {
                    disposeRoutes();
                    await runtime.dispose();
                };
            }, 'dsh-market: Desktop http routes and package operations');
        });
    });
}
