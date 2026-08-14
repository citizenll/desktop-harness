// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SourceRepositorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { SourceEvolutionSettingsTab } from '../src/client/SourceEvolutionSettingsTab.tsx'
import type {
  SourceEvolutionSettingsTabInjected,
  SourceEvolutionSettingsTabProps,
} from '../src/client/SourceEvolutionSettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: PluginInventoryLocaleKey): string => en[key]) as SourceEvolutionSettingsTabProps['t']
const READY = {
  state: 'ready',
  root: 'C:\\Users\\fixture\\.dsh\\source\\deepseek-harness',
  branch: 'main',
  head: '0123456789abcdef0123456789abcdef01234567',
  clean: true,
  operation: null,
  official: { name: 'upstream', url: 'https://github.com/deepseek-ai/deepseek-harness.git', branch: 'master' },
  user: { name: 'origin', url: 'git@github.com:fixture/deepseek-harness.git' },
  ahead: 2,
  behind: 1,
} as SourceRepositorySnapshot

function receipt(repository = READY) {
  if (repository.state !== 'ready') throw new Error('fixture must be ready')
  return { repository, runtime: 'unchanged' as const }
}

function props(
  snapshot: SourceRepositorySnapshot,
  overrides: Partial<SourceEvolutionSettingsTabInjected> = {},
): SourceEvolutionSettingsTabProps {
  return {
    t,
    inspect: async () => snapshot,
    initialize: async () => receipt(),
    fetchOfficial: async () => receipt(),
    updateOfficial: async () => receipt(),
    configureUserRemote: async () => receipt(),
    pushUser: async () => receipt(),
    ...overrides,
  } as SourceEvolutionSettingsTabProps
}

describe('SourceEvolutionSettingsTab', () => {
  it('initializes a missing source workspace from its capsule', async () => {
    const initialize = vi.fn(async () => receipt())
    render(<SourceEvolutionSettingsTab {...props({
      state: 'missing',
      root: 'C:\\source',
      capsuleAvailable: true,
      official: { name: 'upstream', url: 'https://github.com/deepseek-ai/deepseek-harness.git', branch: 'master' },
    }, { initialize })} />)

    expect(await screen.findByText(en.sourceMissingCapsule)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.initialize }))
    await waitFor(() => { expect(initialize).toHaveBeenCalledOnce() })
    expect(await screen.findByText(en.runtimeUnchanged)).toBeTruthy()
  })

  it('fetches, updates, configures, and pushes through separate remotes', async () => {
    const fetchOfficial = vi.fn(async () => receipt())
    const updateOfficial = vi.fn(async () => receipt())
    const configureUserRemote = vi.fn(async () => receipt())
    const pushUser = vi.fn(async () => receipt())
    render(<SourceEvolutionSettingsTab {...props(READY, {
      fetchOfficial,
      updateOfficial,
      configureUserRemote,
      pushUser,
    })} />)
    await screen.findByText('2 ahead / 1 behind')

    fireEvent.click(screen.getByRole('button', { name: en.fetch }))
    await waitFor(() => { expect(fetchOfficial).toHaveBeenCalledOnce() })

    expect(screen.getByLabelText<HTMLSelectElement>(en.strategy).value).toBe('merge')
    fireEvent.click(screen.getByRole('button', { name: en.updateSource }))
    await waitFor(() => { expect(updateOfficial).toHaveBeenCalledWith('merge') })

    fireEvent.change(screen.getByLabelText(en.remoteUrl), { target: { value: 'git@github.com:new/repo.git' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveRemote }))
    await waitFor(() => { expect(configureUserRemote).toHaveBeenCalledWith('git@github.com:new/repo.git') })

    fireEvent.change(screen.getByLabelText(en.destinationBranch), { target: { value: 'custom' } })
    fireEvent.click(screen.getByRole('button', { name: en.push }))
    await waitFor(() => { expect(pushUser).toHaveBeenCalledWith('custom') })
  })

  it('blocks integration and push for a dirty worktree and reports mutation errors', async () => {
    const dirty = { ...READY, clean: false } as SourceRepositorySnapshot
    const configureUserRemote = vi.fn(async () => { throw new Error('embedded credentials rejected') })
    render(<SourceEvolutionSettingsTab {...props(dirty, { configureUserRemote })} />)
    await screen.findByText(en.dirty)
    expect(screen.getByRole('button', { name: en.updateSource }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.push }).hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByLabelText(en.remoteUrl), { target: { value: 'https://token@example.com/repo.git' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveRemote }))
    expect((await screen.findByRole('alert')).textContent).toContain('embedded credentials rejected')
  })
})
