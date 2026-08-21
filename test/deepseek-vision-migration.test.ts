import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { migrateDeepSeekVisionSettings } from '../src/main/state/deepseek-vision-migration'

interface SettingsDocument {
  'llm-deepseek'?: {
    models?: Array<Record<string, unknown>>
  }
  [key: string]: unknown
}

async function createHome(settings?: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-vision-migration-'))
  await mkdir(home, { recursive: true })
  if (settings !== undefined) await writeFile(join(home, 'settings.yaml'), settings, 'utf8')
  return home
}

describe('DeepSeek Vision settings migration', () => {
  it('repairs legacy explicit catalogs without disturbing other settings', async () => {
    const home = await createHome(
      [
        '# keep this user comment',
        'ui-theme:',
        '  preference: dark',
        'llm-deepseek:',
        '  models:',
        '    - id: deepseek-v4-flash',
        '      inputModalities: [text]',
        '    - id: deepseek-v4-flash-vision-exp',
        '      name: DeepSeek-V4-Flash-Vision',
        'agent-default-model:',
        '  provider: deepseek-official',
        '  model: deepseek-v4-flash-vision-exp',
        ''
      ].join('\n')
    )

    await expect(migrateDeepSeekVisionSettings(home)).resolves.toEqual({
      changed: true,
      repairedModels: 1
    })

    const migratedText = await readFile(join(home, 'settings.yaml'), 'utf8')
    const migrated = parse(migratedText) as SettingsDocument
    expect(migratedText).toContain('# keep this user comment')
    expect(migrated['ui-theme']).toEqual({ preference: 'dark' })
    expect(migrated['agent-default-model']).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp'
    })
    expect(migrated['llm-deepseek']?.models).toEqual([
      { id: 'deepseek-v4-flash', inputModalities: ['text'] },
      {
        id: 'deepseek-v4-flash-vision-exp',
        name: 'DeepSeek-V4-Flash-Vision',
        inputModalities: ['text', 'image']
      }
    ])

    await expect(migrateDeepSeekVisionSettings(home)).resolves.toEqual({
      changed: false,
      repairedModels: 0
    })
  })

  it('corrects a text-only declaration for the canonical official Vision model', async () => {
    const home = await createHome(
      [
        'llm-deepseek:',
        '  models:',
        '    - id: deepseek-v4-flash-vision-exp',
        '      inputModalities: [text]',
        ''
      ].join('\n')
    )

    await expect(migrateDeepSeekVisionSettings(home)).resolves.toEqual({
      changed: true,
      repairedModels: 1
    })
    const migrated = parse(await readFile(join(home, 'settings.yaml'), 'utf8')) as SettingsDocument
    expect(migrated['llm-deepseek']?.models?.[0]?.inputModalities).toEqual(['text', 'image'])
  })

  it('leaves adapter defaults and custom models untouched', async () => {
    const defaultHome = await createHome('agent-default-model:\n  model: deepseek-v4-flash\n')
    await expect(migrateDeepSeekVisionSettings(defaultHome)).resolves.toEqual({
      changed: false,
      repairedModels: 0
    })

    const customHome = await createHome(
      [
        'llm-deepseek:',
        '  models:',
        '    - id: company-vision-model',
        '      inputModalities: [text]',
        ''
      ].join('\n')
    )
    await expect(migrateDeepSeekVisionSettings(customHome)).resolves.toEqual({
      changed: false,
      repairedModels: 0
    })
  })
})
