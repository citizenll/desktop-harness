import * as nodeModule from 'node:module'

const fallbackUrl = process.env.DSH_DESKTOP_MODULE_FALLBACK_URL

function isBarePackageSpecifier(specifier) {
  return (
    typeof specifier === 'string' &&
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('\\') &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(specifier) &&
    !/^[a-zA-Z]:[\\/]/u.test(specifier)
  )
}

if (fallbackUrl && typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (profileError) {
        if (!isBarePackageSpecifier(specifier) || context.parentURL === fallbackUrl) {
          throw profileError
        }
        try {
          return nextResolve(specifier, { ...context, parentURL: fallbackUrl })
        } catch {
          throw profileError
        }
      }
    }
  })
}
