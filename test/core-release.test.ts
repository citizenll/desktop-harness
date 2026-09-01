import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

describe('independent Core release contract', () => {
  it('publishes one signed immutable generation for every Desktop target', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'core-release.yml'),
      'utf8'
    )

    for (const target of ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64']) {
      expect(workflow).toContain(`target: ${target}`)
    }
    expect(workflow).toContain("tags:\n      - 'core-g*'")
    expect(workflow).toContain('node scripts/verify-core-release-tag.mjs')
    expect(workflow).toContain('npm run typecheck:host')
    expect(workflow).toContain(
      'npm --prefix packages/dsh-desktop-market run typecheck:client'
    )
    expect(workflow).toContain('npm --prefix packages/dsh-desktop-verifier run typecheck')
    expect(workflow).toContain('node scripts/smoke-core-runtime.mjs')
    expect(workflow).toContain('npm run core:verify-reproducible')
    expect(workflow).toContain('CORE_UPDATE_PRIVATE_KEY')
    expect(workflow).toContain('gh release create "$GITHUB_REF_NAME"')
    expect(workflow).toContain('gh release upload core-channel-stable')
    expect(workflow).toContain('retention-days: 1')
  })

  it('keeps a Core generation independent from the Desktop version and reproducible', async () => {
    const [runtimeBuilder, packageJson, verifier] = await Promise.all([
      readFile(path.join(projectRoot, 'scripts', 'core-runtime-lib.mjs'), 'utf8'),
      readFile(path.join(projectRoot, 'package.json'), 'utf8').then((text) => JSON.parse(text)),
      readFile(path.join(projectRoot, 'scripts', 'verify-core-reproducibility.mjs'), 'utf8')
    ])

    expect(runtimeBuilder).toContain('version: `0.0.0-core.g${release.generation}`')
    expect(runtimeBuilder).not.toContain('version: sourceManifest.version')
    expect(runtimeBuilder).toContain('noDirRecurse: true')
    expect(runtimeBuilder).toContain('const entries = await deterministicArchiveEntries(coreArtifactRoot)')
    expect(packageJson.scripts['core:verify-reproducible']).toBe(
      'node scripts/verify-core-reproducibility.mjs'
    )
    expect(packageJson.scripts['core:package']).toContain('npm run verifier:build')
    expect(verifier).toContain('did not produce identical bytes')
  })

  it('embeds the already-published immutable Core in formal Desktop releases', async () => {
    const [desktopWorkflow, coreWorkflow, baselineInstaller, runtimeStager] = await Promise.all([
      readFile(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8'),
      readFile(path.join(projectRoot, '.github', 'workflows', 'core-release.yml'), 'utf8'),
      readFile(path.join(projectRoot, 'scripts', 'prepare-published-core-baseline.mjs'), 'utf8'),
      readFile(path.join(projectRoot, 'scripts', 'prepare-runtime.mjs'), 'utf8')
    ])

    expect(coreWorkflow).toContain('cp core-artifacts/channel.json release-assets/channel.json')
    expect(desktopWorkflow.match(/run: npm run core:baseline:published/gu)).toHaveLength(4)
    expect(desktopWorkflow.match(/run: npm run typecheck:host/gu)).toHaveLength(4)
    expect(
      desktopWorkflow.match(/run: npm --prefix packages\/dsh-desktop-market run typecheck:client/gu)
    ).toHaveLength(4)
    expect(
      desktopWorkflow.match(/run: npm --prefix packages\/dsh-desktop-verifier run typecheck/gu)
    ).toHaveLength(4)
    expect(desktopWorkflow).toContain("DSH_USE_PUBLISHED_CORE_BASELINE: '1'")
    expect(baselineInstaller).toContain('verifyCoreChannelEnvelope')
    expect(baselineInstaller).toContain('Published Core is incompatible with the Desktop Core Runner.')
    expect(runtimeStager).toContain("process.env.DSH_USE_PUBLISHED_CORE_BASELINE !== '1'")
  })

  it('revalidates every immutable archive before signing or refreshing the channel', async () => {
    const [signer, refresh] = await Promise.all([
      readFile(path.join(projectRoot, 'scripts', 'create-core-channel.mjs'), 'utf8'),
      readFile(
        path.join(projectRoot, '.github', 'workflows', 'core-channel-refresh.yml'),
        'utf8'
      )
    ])

    expect(signer).toContain('archive bytes do not match artifact.json')
    expect(signer).toContain('archive core.json does not match artifact.json')
    expect(signer).toContain('contains an invalid immutable Core id')
    expect(signer).toContain('does not belong to the same governed Core release train')
    expect(refresh).toContain('verify-core-channel-release.mjs')
    expect(refresh).toContain("require('./current-channel/release.json').generation")
    expect(refresh).toContain('CORE_RELEASE_FILE: current-channel/release.json')
    expect(refresh).toContain("require('./core-artifacts/$target/artifact.json').archive.fileName")
    expect(refresh).toContain('--pattern "$archive"')
  })

  it('keeps the macOS Core Runner hardened without disabling Library Validation', async () => {
    const [workflow, entitlements] = await Promise.all([
      readFile(path.join(projectRoot, '.github', 'workflows', 'core-release.yml'), 'utf8'),
      readFile(path.join(projectRoot, 'build', 'core-runner-entitlements.plist'), 'utf8')
    ])

    expect(entitlements).toContain('com.apple.security.cs.allow-jit')
    expect(entitlements).not.toContain('com.apple.security.cs.disable-library-validation')
    expect(workflow).toContain('com.apple.security.cs.allow-jit')
    expect(workflow).toContain('Core Runner must keep Library Validation enabled.')
    expect(workflow).toContain('xcrun notarytool submit')
  })

  it('separates the Host typecheck from unrelated marketplace server tests', async () => {
    const [packageJson, hostConfig] = await Promise.all([
      readFile(path.join(projectRoot, 'package.json'), 'utf8').then((text) => JSON.parse(text)),
      readFile(path.join(projectRoot, 'tsconfig.host.json'), 'utf8').then((text) => JSON.parse(text))
    ])

    expect(packageJson.scripts['typecheck:host']).toBe('tsc --noEmit -p tsconfig.host.json')
    expect(hostConfig.include).toEqual([
      'electron.vite.config.ts',
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'src/shared/**/*.ts'
    ])
  })
})
