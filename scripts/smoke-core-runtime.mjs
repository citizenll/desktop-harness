import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { extract } from 'tar'
import { coreDistributionRoot } from './core-runtime-lib.mjs'

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a Core smoke-test port.'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

const home = await mkdtemp(path.join(tmpdir(), 'dsh-core-smoke-'))
const releaseRoot = path.join(coreDistributionRoot, 'core-release')
const artifact = JSON.parse(await readFile(path.join(releaseRoot, 'artifact.json'), 'utf8'))
const archivePath = path.join(releaseRoot, artifact.archive.fileName)
const archiveBytes = await readFile(archivePath)
if (
  archiveBytes.byteLength !== artifact.archive.size ||
  createHash('sha256').update(archiveBytes).digest('hex') !== artifact.archive.sha256
) {
  throw new Error('Core smoke-test archive does not match artifact.json.')
}
const extractedRoot = path.join(home, 'artifact')
await mkdir(extractedRoot, { recursive: true })
await extract({
  cwd: extractedRoot,
  file: archivePath,
  gzip: true,
  strict: true,
  preservePaths: false
})
const descriptor = JSON.parse(await readFile(path.join(extractedRoot, 'core.json'), 'utf8'))
if (JSON.stringify(descriptor) !== JSON.stringify(artifact.core)) {
  throw new Error('Core smoke-test descriptor does not match artifact.json.')
}
const coreRuntimeRoot = path.join(extractedRoot, 'runtime')
const runner = path.join(
  coreDistributionRoot,
  'core-runner',
  process.platform === 'win32' ? 'node.exe' : 'node'
)
const dshEntry = path.join(coreRuntimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const nodeEntry = path.join(coreRuntimeRoot, 'resources', 'harness-node-entry.mjs')
const patch = path.join(coreRuntimeRoot, 'resources', 'dsh-desktop.patch.yml')
const fallbackHook = path.join(coreRuntimeRoot, 'resources', 'runtime-module-fallback.mjs')
const port = await reservePort()
const url = `http://127.0.0.1:${port}`
const environment = {
  ...process.env,
  DSH_HOME: path.join(home, 'harness'),
  DSH_DESKTOP_CORE_ID: descriptor.coreId,
  DSH_DESKTOP_CORE_GENERATION: String(descriptor.generation),
  DSH_DESKTOP_CORE_PROTOCOL: String(descriptor.desktopProtocol),
  DSH_DESKTOP_MODULE_FALLBACK_URL: pathToFileURL(path.join(coreRuntimeRoot, 'package.json')).href,
  NODE_PATH: path.join(coreRuntimeRoot, 'node_modules'),
  NODE_OPTIONS: `--import=${pathToFileURL(fallbackHook).href}`,
  NO_COLOR: '1'
}
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(
  runner,
  [
    '--expose-internals',
    nodeEntry,
    dshEntry,
    'web',
    '--patch',
    patch,
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    String(port)
  ],
  {
    cwd: home,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  }
)
let output = ''
let handshake = false
child.stdout.on('data', (chunk) => { output += chunk.toString('utf8') })
child.stderr.on('data', (chunk) => { output += chunk.toString('utf8') })
child.on('message', (message) => {
  if (
    message?.type === 'dsh-core-ready' &&
    message.coreId === descriptor.coreId &&
    message.generation === descriptor.generation &&
    message.modules === descriptor.runnerAbi
  ) {
    handshake = true
  }
})

try {
  const deadline = Date.now() + (process.platform === 'win32' ? 120_000 : 75_000)
  let healthySince
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (handshake && response.status >= 200 && response.status < 500) {
        healthySince ??= Date.now()
        if (Date.now() - healthySince >= 500) {
          console.log(`Core smoke test passed for ${descriptor.coreId}.`)
          process.exitCode = 0
          break
        }
      } else {
        healthySince = undefined
      }
    } catch {
      healthySince = undefined
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (process.exitCode !== 0) {
    throw new Error(`Core did not become ready.\n${output.slice(-20_000)}`)
  }
} finally {
  if (child.exitCode === null) {
    if (process.platform === 'win32' && child.pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.once('error', resolve)
        killer.once('exit', resolve)
      })
    } else if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  await rm(home, { recursive: true, force: true })
}
