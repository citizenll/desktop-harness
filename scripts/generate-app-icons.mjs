import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectory = path.join(projectRoot, 'build')
const source = path.join(buildDirectory, 'app-icon.png')
const iconsetDirectory = path.join(buildDirectory, 'app-icon.iconset')
const icnsDestination = path.join(buildDirectory, 'icon.icns')
const icoDestination = path.join(buildDirectory, 'icon.ico')

await rm(iconsetDirectory, { recursive: true, force: true })
await mkdir(iconsetDirectory, { recursive: true })

function resizePng(size, destination) {
  if (process.platform === 'darwin') {
    execFileSync('sips', [
      '-z',
      String(size),
      String(size),
      source,
      '--out',
      destination
    ])
    return
  }

  execFileSync('magick', [
    source,
    '-filter',
    'Lanczos',
    '-resize',
    `${size}x${size}`,
    destination
  ])
}

for (const size of [16, 32, 128, 256, 512]) {
  resizePng(size, path.join(iconsetDirectory, `icon_${size}x${size}.png`))
  resizePng(size * 2, path.join(iconsetDirectory, `icon_${size}x${size}@2x.png`))
}

if (process.platform === 'darwin') {
  execFileSync('iconutil', ['-c', 'icns', iconsetDirectory, '-o', icnsDestination])
} else {
  const icnsImages = [
    ['icp4', 'icon_16x16.png'],
    ['icp5', 'icon_32x32.png'],
    ['icp6', 'icon_32x32@2x.png'],
    ['ic07', 'icon_128x128.png'],
    ['ic08', 'icon_256x256.png'],
    ['ic09', 'icon_512x512.png'],
    ['ic10', 'icon_512x512@2x.png']
  ]
  const chunks = []
  for (const [type, filename] of icnsImages) {
    const image = await readFile(path.join(iconsetDirectory, filename))
    const chunk = Buffer.alloc(8 + image.length)
    chunk.write(type, 0, 4, 'ascii')
    chunk.writeUInt32BE(chunk.length, 4)
    image.copy(chunk, 8)
    chunks.push(chunk)
  }
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
  await writeFile(icnsDestination, Buffer.concat([header, ...chunks]))
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-icons-'))
const icoImages = []
for (const size of icoSizes) {
  const destination = path.join(icoDirectory, `icon-${size}.png`)
  resizePng(size, destination)
  icoImages.push(await readFile(destination))
}
const header = Buffer.alloc(6 + icoImages.length * 16)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(icoImages.length, 4)

let offset = header.length
for (let index = 0; index < icoImages.length; index += 1) {
  const size = icoSizes[index]
  const entry = 6 + index * 16
  header.writeUInt8(size === 256 ? 0 : size, entry)
  header.writeUInt8(size === 256 ? 0 : size, entry + 1)
  header.writeUInt8(0, entry + 2)
  header.writeUInt8(0, entry + 3)
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(icoImages[index].length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += icoImages[index].length
}

await writeFile(icoDestination, Buffer.concat([header, ...icoImages]))
await rm(icoDirectory, { recursive: true, force: true })

const icon = await readFile(source)
console.log(`Generated app icons from ${path.relative(projectRoot, source)} (${icon.length} bytes PNG).`)
