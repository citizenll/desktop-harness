import { lstat, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLock, writeFileAtomic } from '../src/index.ts'

const fsControl = vi.hoisted(() => ({
  renameCalls: 0,
  renameFailures: [] as string[],
  persistentRenameFailure: undefined as string | undefined,
  renameStarted: undefined as (() => void) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async rename(...args: Parameters<typeof actual.rename>): ReturnType<typeof actual.rename> {
      fsControl.renameCalls += 1
      fsControl.renameStarted?.()
      const code = fsControl.renameFailures.shift() ?? fsControl.persistentRenameFailure
      if (code !== undefined) {
        throw Object.assign(new Error(`${code}: injected rename failure`), { code })
      }
      return actual.rename(...args)
    },
  }
})

afterEach(() => {
  fsControl.renameCalls = 0
  fsControl.renameFailures.length = 0
  fsControl.persistentRenameFailure = undefined
  fsControl.renameStarted = undefined
  vi.useRealTimers()
})

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-atomic-write-'))
}

async function onPlatform<T>(platform: NodeJS.Platform, operation: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (descriptor === undefined) throw new Error('process.platform descriptor is absent')
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  try {
    return await operation()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

describe('writeFileAtomic', () => {
  it('creates the file and its parents with exactly the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'nested', 'deep', 'doc.yaml')
    await writeFileAtomic(target, 'a: 1\n', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('a: 1\n')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces existing content and narrows a wider-permission file to the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old', { mode: 0o644 })
    await writeFileAtomic(target, 'new', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('new')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('retries transient Windows rename contention without abandoning the atomic replacement', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old', { mode: 0o600 })
    fsControl.renameFailures.push('EPERM', 'EACCES', 'EBUSY')

    await onPlatform('win32', () => writeFileAtomic(target, 'new', { mode: 0o600 }))

    expect(fsControl.renameCalls).toBe(4)
    expect(await readFile(target, 'utf8')).toBe('new')
    expect((await readdir(dir)).filter(entry => entry.endsWith('.tmp'))).toEqual([])
  })

  it('does not retry rename failures away from Windows', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old', { mode: 0o600 })
    fsControl.renameFailures.push('EPERM')

    await onPlatform('linux', () => expect(writeFileAtomic(target, 'new', { mode: 0o600 }))
      .rejects.toMatchObject({ code: 'EPERM' }))

    expect(fsControl.renameCalls).toBe(1)
    expect(await readFile(target, 'utf8')).toBe('old')
    expect((await readdir(dir)).filter(entry => entry.endsWith('.tmp'))).toEqual([])
  })

  it('bounds persistent Windows rename contention and removes the staged file', async () => {
    vi.useFakeTimers()
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old', { mode: 0o600 })
    fsControl.persistentRenameFailure = 'EPERM'
    let markRenameStarted!: () => void
    const renameStarted = new Promise<void>((resolve) => { markRenameStarted = resolve })
    fsControl.renameStarted = markRenameStarted

    const writing = onPlatform('win32', () => writeFileAtomic(target, 'new', { mode: 0o600 }))
    await renameStarted
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(writing).rejects.toMatchObject({ code: 'EPERM' })

    expect(fsControl.renameCalls).toBeGreaterThan(1)
    expect(await readFile(target, 'utf8')).toBe('old')
    expect((await readdir(dir)).filter(entry => entry.endsWith('.tmp'))).toEqual([])
  })

  it('replaces a symlinked target itself without writing through to the referent', async () => {
    const dir = await scratch()
    const victim = join(dir, 'victim')
    await writeFile(victim, 'victim-content')
    const target = join(dir, 'doc.yaml')
    await symlink(victim, target)
    await writeFileAtomic(target, 'replaced', { mode: 0o600 })
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('replaced')
    expect(await readFile(victim, 'utf8')).toBe('victim-content')
  })

  it('leaves no temp sibling and rethrows when the rename fails', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old')
    fsControl.renameFailures.push('EIO')
    await expect(writeFileAtomic(target, 'content', { mode: 0o600 })).rejects.toMatchObject({ code: 'EIO' })
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })
})

describe('withFileLock', () => {
  it('rejects an invalid parent hierarchy before running the operation', async () => {
    const dir = await scratch()
    const parent = join(dir, 'not-a-directory')
    await writeFile(parent, 'occupied')
    let called = false

    await expect(withFileLock(join(parent, 'document'), async () => {
      called = true
    })).rejects.toThrow(/ENOENT|ENOTDIR|not a directory/i)
    expect(called).toBe(false)
  })
})
