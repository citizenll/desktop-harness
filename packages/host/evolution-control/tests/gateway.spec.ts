import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProfilePlugins, {
  type ProfilePluginMutationReceipt,
  type ProfilePluginsSnapshot,
} from '@deepseek-ai/dsh-profile-plugins'
import SourceRepository, {
  type SourceRepositoryMutationReceipt,
  type SourceRepositorySnapshot,
  type SourceUpdateStrategy,
} from '@deepseek-ai/dsh-source-repository'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import EvolutionControlGateway from '../src/index.ts'

const contexts: Context[] = []
const READY = {
  state: 'ready',
  root: '/source',
  branch: 'main',
  head: '0123456789abcdef0123456789abcdef01234567',
  clean: true,
  operation: null,
  official: { name: 'upstream', url: 'https://github.com/deepseek-ai/deepseek-harness.git', branch: 'master' },
  user: null,
  ahead: 0,
  behind: 0,
} as SourceRepositorySnapshot
const SOURCE_RECEIPT = {
  repository: READY,
  runtime: 'unchanged',
} as SourceRepositoryMutationReceipt
const PLUGINS = {
  profile: 'desktop',
  profileDir: '/profiles/desktop',
  entries: [],
} satisfies ProfilePluginsSnapshot
const PLUGIN_RECEIPT = {
  plugins: PLUGINS,
  activation: 'host-recomposed',
} satisfies ProfilePluginMutationReceipt

class FakeSourceRepository extends SourceRepository {
  inspect = vi.fn<() => Promise<SourceRepositorySnapshot>>(async () => READY)
  initialize = vi.fn<() => Promise<SourceRepositoryMutationReceipt>>(async () => SOURCE_RECEIPT)
  fetchOfficial = vi.fn<() => Promise<SourceRepositoryMutationReceipt>>(async () => SOURCE_RECEIPT)
  updateOfficial = vi.fn<(strategy: SourceUpdateStrategy) => Promise<SourceRepositoryMutationReceipt>>(async () => SOURCE_RECEIPT)
  configureUserRemote = vi.fn<(url: string) => Promise<SourceRepositoryMutationReceipt>>(async () => SOURCE_RECEIPT)
  pushUser = vi.fn<(branch?: string) => Promise<SourceRepositoryMutationReceipt>>(async () => SOURCE_RECEIPT)
}

class FakeProfilePlugins extends ProfilePlugins {
  list = vi.fn<() => Promise<ProfilePluginsSnapshot>>(async () => PLUGINS)
  install = vi.fn<(spec: string) => Promise<ProfilePluginMutationReceipt>>(async () => PLUGIN_RECEIPT)
  update = vi.fn<(packageName: string) => Promise<ProfilePluginMutationReceipt>>(async () => PLUGIN_RECEIPT)
  remove = vi.fn<(packageName: string) => Promise<ProfilePluginMutationReceipt>>(async () => PLUGIN_RECEIPT)
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<{
  readonly gateway: EvolutionControlGateway
  readonly source: FakeSourceRepository
  readonly plugins: FakeProfilePlugins
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FakeSourceRepository)
  await ctx.plugin(FakeProfilePlugins)
  await ctx.plugin(EvolutionControlGateway)
  return {
    gateway: ctx.get('evolution') as EvolutionControlGateway,
    source: ctx.sourceRepository as FakeSourceRepository,
    plugins: ctx.profilePlugins as FakeProfilePlugins,
  }
}

describe('EvolutionControlGateway', () => {
  it('publishes the complete privileged evolution method set', async () => {
    const { gateway } = await harness()
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'evolution', namespace: 'evolution' })
    expect(remoteMethods(gateway).map(method => method.method)).toEqual([
      'sourceInspect',
      'sourceInitialize',
      'sourceFetchOfficial',
      'sourceUpdateOfficial',
      'sourceConfigureUserRemote',
      'sourcePushUser',
      'pluginsList',
      'pluginsInstall',
      'pluginsUpdate',
      'pluginsRemove',
    ])
  })

  it('delegates source and profile operations without rewriting receipts', async () => {
    const { gateway, source, plugins } = await harness()
    await expect(gateway.sourceInspect()).resolves.toBe(READY)
    await expect(gateway.sourceInitialize()).resolves.toBe(SOURCE_RECEIPT)
    await expect(gateway.sourceFetchOfficial()).resolves.toBe(SOURCE_RECEIPT)
    await expect(gateway.sourceUpdateOfficial('ff-only')).resolves.toBe(SOURCE_RECEIPT)
    await expect(gateway.sourceConfigureUserRemote('git@example.com:user/repo.git')).resolves.toBe(SOURCE_RECEIPT)
    await expect(gateway.sourcePushUser(null)).resolves.toBe(SOURCE_RECEIPT)
    expect(source.updateOfficial).toHaveBeenCalledWith('ff-only')
    expect(source.configureUserRemote).toHaveBeenCalledWith('git@example.com:user/repo.git')
    expect(source.pushUser).toHaveBeenCalledWith(undefined)

    await expect(gateway.pluginsList()).resolves.toBe(PLUGINS)
    await expect(gateway.pluginsInstall('@fixture/plugin')).resolves.toBe(PLUGIN_RECEIPT)
    await expect(gateway.pluginsUpdate('@fixture/plugin')).resolves.toBe(PLUGIN_RECEIPT)
    await expect(gateway.pluginsRemove('@fixture/plugin')).resolves.toBe(PLUGIN_RECEIPT)
    expect(plugins.install).toHaveBeenCalledWith('@fixture/plugin')
    expect(plugins.update).toHaveBeenCalledWith('@fixture/plugin')
    expect(plugins.remove).toHaveBeenCalledWith('@fixture/plugin')
  })
})
