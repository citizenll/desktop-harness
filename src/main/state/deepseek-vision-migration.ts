import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isSeq, parseDocument } from 'yaml'

const OFFICIAL_VISION_MODEL = 'deepseek-v4-flash-vision-exp'
const OFFICIAL_VISION_MODALITIES = ['text', 'image'] as const

export interface DeepSeekVisionMigrationResult {
  changed: boolean
  repairedModels: number
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOfficialVisionModalities(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== OFFICIAL_VISION_MODALITIES.length) return false
  return OFFICIAL_VISION_MODALITIES.every((modality) => value.includes(modality))
}

/**
 * Repair the capability metadata written by DSH versions whose Models editor
 * exposed a DeepSeek catalog row without exposing `inputModalities`.
 *
 * An explicit `llm-deepseek.models` array replaces the adapter defaults. The
 * adapter deliberately treats a missing modality declaration as text-only, so
 * selecting the official Vision model by id is not sufficient. Capability is
 * factual provider metadata rather than a user preference: the canonical
 * official Vision id always accepts text and image input.
 */
export async function migrateDeepSeekVisionSettings(
  dshHome: string
): Promise<DeepSeekVisionMigrationResult> {
  const settingsPath = join(dshHome, 'settings.yaml')
  const text = await readOptional(settingsPath)
  if (text === undefined) return { changed: false, repairedModels: 0 }

  const document = parseDocument(text)
  if (document.errors.length > 0) {
    throw new Error(`Could not parse ${settingsPath}: ${document.errors[0]?.message}`)
  }

  const settings = document.toJS() as unknown
  if (!isRecord(settings)) return { changed: false, repairedModels: 0 }
  const deepseek = settings['llm-deepseek']
  if (!isRecord(deepseek) || !Array.isArray(deepseek.models)) {
    return { changed: false, repairedModels: 0 }
  }

  const modelsNode = document.getIn(['llm-deepseek', 'models'], true)
  if (!isSeq(modelsNode)) return { changed: false, repairedModels: 0 }

  let repairedModels = 0
  for (const [index, model] of deepseek.models.entries()) {
    if (!isRecord(model) || model.id !== OFFICIAL_VISION_MODEL) continue
    if (hasOfficialVisionModalities(model.inputModalities)) continue

    const modelNode = modelsNode.items[index]
    if (!isMap(modelNode)) continue
    modelNode.set('inputModalities', document.createNode([...OFFICIAL_VISION_MODALITIES]))
    repairedModels += 1
  }

  if (repairedModels === 0) return { changed: false, repairedModels: 0 }
  await writeFileAtomic(settingsPath, String(document), {
    mode: 0o600,
    dirMode: 0o700
  })
  return { changed: true, repairedModels }
}
