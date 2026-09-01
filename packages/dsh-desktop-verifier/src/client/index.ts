import { en, zh, type Translate } from './locales.ts'
import { VerifierProgress, VerifierToggle } from './VerifierControl.tsx'

const NS = 'dsh-desktop-verifier'

interface LocaleService {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
}

interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown): unknown
}

interface RemoteResult {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
  remote: {
    commands: {
      execute(sessionId: string, line: string, images: readonly unknown[]): Promise<RemoteResult>
    }
  }
}

export const name = 'dsh-desktop-verifier'
export const inject = ['slots', 'remote', 'remote.commands', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-desktop-verifier: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'dsh-desktop-verifier-toggle',
    order: 40,
    locale: NS,
    inject: (sessionId: string) => ({
      t,
      setEnabled: async (enabled: boolean): Promise<string | null> => {
        const result = await ctx.remote.commands.execute(sessionId, `/verify ${enabled ? 'on' : 'off'}`, [])
        if (!result.ok) {
          const error = result.error
          return error === undefined ? t('toggleFailed') : `${error.message} (${error.code})`
        }
        if (result.value === undefined) return t('toggleFailed')
        return null
      },
    }),
  }, VerifierToggle as unknown as (props: Record<string, unknown>) => unknown))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-desktop-verifier-progress',
    order: 40,
    locale: NS,
    inject: () => ({ t }),
  }, VerifierProgress as unknown as (props: Record<string, unknown>) => unknown))
}
