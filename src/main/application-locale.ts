export type HarnessLocale = 'en' | 'zh'

export function resolveHarnessLocale(
  preference: unknown,
  preferredSystemLanguages: readonly string[]
): HarnessLocale {
  if (preference === 'zh' || preference === 'en') return preference

  if (preference === 'auto') {
    return preferredSystemLanguages[0]?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  }

  return 'zh'
}
