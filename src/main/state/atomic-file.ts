import { randomBytes } from 'node:crypto'
import { open, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'

export interface AtomicWriteOptions {
  mode?: number
  dirMode?: number
}

export async function writeFileAtomic(
  target: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const directory = dirname(target)
  await mkdir(directory, { recursive: true, mode: options.dirMode ?? 0o700 })
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  )

  try {
    const handle = await open(temporary, 'wx', options.mode ?? 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
    if (process.platform !== 'win32') {
      const directoryHandle = await open(directory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function writeJsonAtomic(
  target: string,
  value: unknown,
  options?: AtomicWriteOptions
): Promise<void> {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, options)
}
