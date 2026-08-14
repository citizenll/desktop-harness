// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProfilePluginsSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type {
  PluginInventorySettingsTabInjected,
  PluginInventorySettingsTabProps,
} from '../src/client/PluginInventorySettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

type RuntimeSnapshot = Awaited<ReturnType<PluginInventorySettingsTabInjected['listRuntime']>>
const t = ((key: PluginInventoryLocaleKey): string => en[key]) as PluginInventorySettingsTabProps['t']

const PROFILE = {
  profile: 'web',
  profileDir: 'C:\\Users\\fixture\\.dsh\\profiles\\web',
  entries: [
    {
      packageName: '@deepseek-ai/dsh-web-app',
      requestedSpec: null,
      installedVersion: '0.1.0',
      kind: 'system-bundle',
      active: true,
      mutable: false,
    },
    {
      packageName: '@fixture/theme-bundle',
      requestedSpec: '1.2.3',
      installedVersion: '1.2.3',
      kind: 'extension-bundle',
      active: true,
      mutable: true,
    },
    {
      packageName: '@fixture/helper',
      requestedSpec: '2.0.0',
      installedVersion: '2.0.0',
      kind: 'library',
      active: false,
      mutable: true,
    },
  ],
} satisfies ProfilePluginsSnapshot

const RUNTIME = {
  entries: [
    { entryId: '8a1b2c3d', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
    { entryId: 'pending', moduleName: 'cordis:pending-name', enabled: true, fiberPhase: 'pending' },
    { entryId: 'loading', moduleName: '@fixture/loading-name', enabled: true, fiberPhase: 'loading' },
    { entryId: 'failed', moduleName: '@fixture/failed-name', enabled: true, fiberPhase: 'failed' },
    { entryId: 'unloading', moduleName: '@fixture/unloading-name', enabled: true, fiberPhase: 'unloading' },
    { entryId: 'unobserved', moduleName: '@fixture/unobserved-name', enabled: true, fiberPhase: null },
    { entryId: 'disabled-entry', moduleName: '@deepseek-ai/dsh-host-directory-picker-native', enabled: false, fiberPhase: null },
  ],
} as unknown as RuntimeSnapshot

function receipt(profile = PROFILE) {
  return { plugins: profile, activation: 'host-recomposed' as const }
}

function props(overrides: Partial<PluginInventorySettingsTabInjected> = {}): PluginInventorySettingsTabProps {
  return {
    t,
    listProfile: async () => PROFILE,
    listRuntime: async () => RUNTIME,
    install: async () => receipt(),
    update: async () => receipt(),
    remove: async () => receipt(),
    reloadClient: vi.fn(),
    ...overrides,
  } as PluginInventorySettingsTabProps
}

describe('PluginInventorySettingsTab', () => {
  it('renders profile roles and runtime Fiber phases', async () => {
    const deferredProfile = Promise.withResolvers<ProfilePluginsSnapshot>()
    const deferredRuntime = Promise.withResolvers<RuntimeSnapshot>()
    const view = render(<PluginInventorySettingsTab {...props({
      listProfile: () => deferredProfile.promise,
      listRuntime: () => deferredRuntime.promise,
    })} />)
    expect(screen.getByText(en.loading)).toBeTruthy()

    await act(async () => {
      deferredProfile.resolve(PROFILE)
      deferredRuntime.resolve(RUNTIME)
    })

    expect(screen.getByRole('heading', { name: en.profileTitle })).toBeTruthy()
    expect(view.container.querySelectorAll('[data-package]')).toHaveLength(3)
    expect(screen.getByText(en.systemBundle)).toBeTruthy()
    expect(screen.getByText(en.extensionBundle)).toBeTruthy()
    expect(screen.getByText(en.library)).toBeTruthy()
    expect(view.container.querySelector('[data-plugin-count]')?.textContent).toBe('7')
    for (const value of ['Mounted', 'Waiting for dependencies', 'Loading', 'Mount failed', 'Unloading', 'Not mounted']) {
      expect(screen.getByRole('img', { name: value })).toBeTruthy()
    }

    const active = screen.getByRole('button', { name: 'hmr, Mounted, Enabled' })
    fireEvent.click(active)
    expect(view.container.querySelector('[data-loader-entry]')?.textContent).toBe('8a1b2c3d')
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'disabled-entry' } })
    expect(view.container.querySelector('[data-loader-entry]')).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('installs, updates, and confirms removal before reloading the client', async () => {
    const install = vi.fn(async () => receipt())
    const update = vi.fn(async () => receipt())
    const remove = vi.fn(async () => receipt())
    const reloadClient = vi.fn()
    render(<PluginInventorySettingsTab {...props({ install, update, remove, reloadClient })} />)
    await screen.findByRole('heading', { name: en.installTitle })

    fireEvent.change(screen.getByLabelText(en.installSpec), { target: { value: '@fixture/new-bundle@1.0.0' } })
    fireEvent.click(screen.getByRole('button', { name: en.install }))
    await waitFor(() => { expect(install).toHaveBeenCalledWith('@fixture/new-bundle@1.0.0') })
    expect(reloadClient).toHaveBeenCalledTimes(1)

    const row = screen.getByText('@fixture/theme-bundle').closest('tr')!
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => { expect(update).toHaveBeenCalledWith('@fixture/theme-bundle') })
    expect(reloadClient).toHaveBeenCalledTimes(2)

    const buttons = Array.from(row.querySelectorAll('button'))
    fireEvent.click(buttons.at(-1)!)
    expect(screen.getByRole('button', { name: en.confirmRemove })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.confirmRemove }))
    await waitFor(() => { expect(remove).toHaveBeenCalledWith('@fixture/theme-bundle') })
    expect(reloadClient).toHaveBeenCalledTimes(3)
  })

  it('contains load failures but exposes package-manager failures', async () => {
    const failed = render(<PluginInventorySettingsTab {...props({
      listProfile: async () => { throw new Error('private transport detail') },
    })} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.queryByText('private transport detail')).toBeNull()
    failed.unmount()

    render(<PluginInventorySettingsTab {...props({
      install: async () => { throw new Error('registry denied package') },
    })} />)
    await screen.findByRole('heading', { name: en.installTitle })
    fireEvent.change(screen.getByLabelText(en.installSpec), { target: { value: '@fixture/denied' } })
    fireEvent.click(screen.getByRole('button', { name: en.install }))
    expect((await screen.findByRole('alert')).textContent).toContain('registry denied package')
  })
})
