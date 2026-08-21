import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_PACKAGE = /^@deepseek-ai\/dsh(?:-|$)/u
const FORBIDDEN_NPM_FLAGS = /npm(?:\.cmd)?\s+[^\r\n]*--(?:legacy-peer-deps|force)\b/iu

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'))
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function expectedPatchFile(packageName, version) {
  return `${packageName.replace('/', '+')}+${version}.patch`
}

async function workflowFiles(root) {
  const directory = path.join(root, '.github', 'workflows')
  if (!(await exists(directory))) return []
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
}

export async function checkDshReleaseTrain(root = projectRoot) {
  const failures = []
  const manifest = await readJson(path.join(root, 'package.json'))
  const lockfile = await readJson(path.join(root, 'package-lock.json'))
  const patchManifest = await readJson(path.join(root, 'patches', 'manifest.json'))
  const expected = patchManifest.upstream?.version

  if (typeof expected !== 'string' || expected.length === 0) {
    failures.push('patches/manifest.json does not declare upstream.version.')
  }

  const declared = { ...manifest.devDependencies, ...manifest.dependencies }
  const directDsh = Object.entries(declared).filter(([name]) => DSH_PACKAGE.test(name))
  if (!directDsh.some(([name]) => name === '@deepseek-ai/dsh')) {
    failures.push('package.json does not declare @deepseek-ai/dsh.')
  }
  for (const [name, specifier] of directDsh) {
    if (specifier !== expected) {
      failures.push(`${name} is declared as ${specifier}; expected exact ${expected}.`)
    }
  }

  const resolvedDsh = Object.entries(lockfile.packages ?? {}).filter(([location]) =>
    /(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/u.test(location.replaceAll('\\', '/'))
  )
  for (const [location, entry] of resolvedDsh) {
    if (entry.version !== expected) {
      failures.push(`${location} resolves ${entry.version ?? 'without a version'}; expected ${expected}.`)
    }
  }

  if (manifest.dependencies?.dshmarket !== undefined) {
    failures.push('The npm dshmarket dependency must not return; Desktop owns the market package.')
  }
  if (manifest.dependencies?.['dsh-desktop-market'] !== 'file:packages/dsh-desktop-market') {
    failures.push('dsh-desktop-market must be consumed from packages/dsh-desktop-market.')
  }
  const marketManifest = await readJson(
    path.join(root, 'packages', 'dsh-desktop-market', 'package.json')
  )
  const forbiddenMarketPeers = Object.keys(marketManifest.peerDependencies ?? {}).filter((name) =>
    DSH_PACKAGE.test(name)
  )
  if (forbiddenMarketPeers.length > 0) {
    failures.push(`The Desktop market has DSH peer dependencies: ${forbiddenMarketPeers.join(', ')}.`)
  }

  const patchDirectory = path.join(root, 'patches')
  const dshPatchFiles = (await readdir(patchDirectory))
    .filter((name) => name.startsWith('@deepseek-ai+dsh') && name.endsWith('.patch'))
    .sort()
  const listedFiles = new Set()
  for (const entry of patchManifest.patches ?? []) {
    const expectedFile = expectedPatchFile(entry.package, expected)
    if (entry.file !== expectedFile) {
      failures.push(`${entry.package} lists ${entry.file}; expected ${expectedFile}.`)
    }
    if (listedFiles.has(entry.file)) failures.push(`Patch manifest lists ${entry.file} more than once.`)
    listedFiles.add(entry.file)
    if (!(await exists(path.join(patchDirectory, entry.file)))) {
      failures.push(`Patch manifest references missing ${entry.file}.`)
    }
    if (typeof entry.intent !== 'string' || entry.intent.trim().length === 0) {
      failures.push(`${entry.file} has no intent.`)
    }
    if (typeof entry.removalWhen !== 'string' || entry.removalWhen.trim().length === 0) {
      failures.push(`${entry.file} has no removal condition.`)
    }
    if (!Array.isArray(entry.tests) || entry.tests.length === 0) {
      failures.push(`${entry.file} has no behavior tests.`)
    } else {
      for (const test of entry.tests) {
        if (!(await exists(path.join(root, test)))) failures.push(`${entry.file} references missing ${test}.`)
      }
    }
  }
  for (const patch of dshPatchFiles) {
    if (!listedFiles.has(patch)) failures.push(`${patch} is not recorded in patches/manifest.json.`)
  }

  const installSurfaces = [path.join(root, 'package.json'), ...(await workflowFiles(root))]
  const npmrc = path.join(root, '.npmrc')
  if (await exists(npmrc)) installSurfaces.push(npmrc)
  for (const target of installSurfaces) {
    const content = await readFile(target, 'utf8')
    if (FORBIDDEN_NPM_FLAGS.test(content) || /legacy-peer-deps\s*=\s*true/iu.test(content)) {
      failures.push(`${path.relative(root, target)} bypasses npm dependency resolution.`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`DSH release-train validation failed:\n- ${failures.join('\n- ')}`)
  }

  return {
    version: expected,
    directPackages: directDsh.length,
    resolvedPackages: resolvedDsh.length,
    patches: dshPatchFiles.length
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkDshReleaseTrain()
  console.log(
    `DSH ${result.version}: ${result.directPackages} direct / ${result.resolvedPackages} resolved packages; ${result.patches} governed patches.`
  )
}
