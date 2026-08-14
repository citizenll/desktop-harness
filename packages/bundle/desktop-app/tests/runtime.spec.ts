/** Desktop runtime prompt and shell-environment contributions. */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import { apply, DSH_DESKTOP_URL } from '../src/index.ts'

interface ShellContribution {
  name: string
  variables: Record<string, { description: string }>
  resolve(): Record<string, string>
}

describe('desktop-app runtime', () => {
  it('describes the embedded surface and exports its renderer URL to shells', async () => {
    const ctx = new Context()
    const contributions: ShellContribution[] = []
    ctx.provide('shellEnv', {
      register: (contribution: ShellContribution) => {
        contributions.push(contribution)
        return () => {}
      },
    } as never)
    apply(ctx)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await new Promise(resolve => setTimeout(resolve, 0))

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'harness:source')?.text)
      .toContain('DeepSeek Harness implementation checkout')
    const surface = assembly.sections.find(section => section.name === 'app:desktop-surface')
    expect(surface?.text).toContain('Electron desktop application')
    expect(surface?.text).toContain('without a listening port')
    expect(surface?.text).toContain('without restarting the desktop process')
    expect(contributions.find(contribution => contribution.name === 'desktop-runtime')?.resolve())
      .toEqual({ DSH_DESKTOP_URL })
    await ctx.fiber.dispose()
  })

  it('does not require either optional registry', () => {
    expect(() => { apply(new Context()) }).not.toThrow()
  })
})
