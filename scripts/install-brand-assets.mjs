import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(scriptPath), '..')

function replaceRequired(contents, search, replacement, file) {
  if (contents.includes(replacement)) return contents
  const candidates = Array.isArray(search) ? search : [search]
  for (const candidate of candidates) {
    if (contents.includes(candidate)) return contents.replace(candidate, replacement)
  }
  throw new Error(`Could not update DSH Desktop branding in ${file}: expected content was not found`)
}

export async function installBrandAssets({
  packageRoot = projectRoot,
  assetRoot = projectRoot,
  log = true
} = {}) {
  const source = path.join(assetRoot, 'build', 'icon.png')
  const brandSource = path.join(assetRoot, 'build', 'brand.png')
  const destinationDirectory = path.join(
    packageRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-web-frontend',
    'dist'
  )
  const destination = path.join(destinationDirectory, 'dsh-desktop-logo.png')
  const lightDestination = path.join(destinationDirectory, 'dsh-desktop-logo-light.png')
  const darkDestination = path.join(destinationDirectory, 'dsh-desktop-logo-dark.png')
  const indexPath = path.join(destinationDirectory, 'index.html')
  const manifestPath = path.join(destinationDirectory, 'manifest.webmanifest')

  await mkdir(destinationDirectory, { recursive: true })
  await copyFile(source, destination)
  await copyFile(brandSource, lightDestination)
  await copyFile(brandSource, darkDestination)

  const index = await readFile(indexPath, 'utf8')
  await writeFile(
    indexPath,
    replaceRequired(
      index,
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
      '<link rel="icon" type="image/png" href="/dsh-desktop-logo.png" />',
      path.relative(packageRoot, indexPath)
    )
  )

  const manifest = await readFile(manifestPath, 'utf8')
  await writeFile(
    manifestPath,
    replaceRequired(
      manifest,
      [
        '"src": "/favicon.svg",\n      "sizes": "any",\n      "type": "image/svg+xml"',
        '"src": "/dsh-desktop-logo.png",\n      "sizes": "1254x1254",\n      "type": "image/png"'
      ],
      '"src": "/dsh-desktop-logo.png",\n      "sizes": "1024x1024",\n      "type": "image/png"',
      path.relative(packageRoot, manifestPath)
    )
  )

  const installed = [destination, lightDestination, darkDestination]
  if (log) {
    console.log(
      `Installed DSH Desktop brand assets: ${installed
        .map((file) => path.relative(packageRoot, file))
        .join(', ')}`
    )
  }
  return installed
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await installBrandAssets()
}
