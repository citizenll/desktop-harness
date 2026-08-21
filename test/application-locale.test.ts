import { describe, expect, it } from 'vitest'
import { resolveHarnessLocale } from '../src/main/application-locale'

describe('application locale', () => {
  it('uses the saved DSH preference when one exists', () => {
    expect(resolveHarnessLocale('en', ['zh-Hans-CN'])).toBe('en')
    expect(resolveHarnessLocale('zh', ['en-US'])).toBe('zh')
  })

  it('defaults a first launch to Chinese', () => {
    expect(resolveHarnessLocale(undefined, ['zh-Hans-CN', 'en-US'])).toBe('zh')
    expect(resolveHarnessLocale(undefined, ['zh-Hant-TW', 'en-US'])).toBe('zh')
    expect(resolveHarnessLocale(undefined, ['en-US', 'zh-Hans-CN'])).toBe('zh')
    expect(resolveHarnessLocale(undefined, [])).toBe('zh')
  })

  it('uses the system language only for an explicit auto preference', () => {
    expect(resolveHarnessLocale('auto', ['zh-CN'])).toBe('zh')
    expect(resolveHarnessLocale('auto', ['en-US'])).toBe('en')
    expect(resolveHarnessLocale({ value: 'zh' }, ['en-US'])).toBe('zh')
  })
})
