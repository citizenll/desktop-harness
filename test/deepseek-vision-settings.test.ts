import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { patchPath } from './patch-path'

describe('DeepSeek Vision settings surface', () => {
  it('shows image capability and keeps the canonical Vision model truthful', async () => {
    const [patch, installed] = await Promise.all([
      readFile(patchPath('@deepseek-ai/dsh-client-ui-settings-models'), 'utf8'),
      readFile('node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js', 'utf8')
    ])

    for (const source of [patch, installed]) {
      expect(source).toContain('OFFICIAL_DEEPSEEK_VISION_MODEL')
      expect(source).toContain('deepseek-v4-flash-vision-exp')
      expect(source).toContain('normalizeDeepSeekModels')
      expect(source).toContain('inputModalities: ["text", "image"]')
      expect(source).toContain('modelInputCapabilities')
      expect(source).toContain('modelImageInput')
      expect(source).toContain('输入能力')
      expect(source).toContain('图片')
    }

    expect(installed).toContain('checked: supportsImageInput(model)')
    expect(installed).toContain('disabled: props.disabled || officialVision')
    expect(installed).toContain('event.target.checked ? ["text", "image"] : ["text"]')
  })
})
