import { packageStagedCore, prepareCoreRuntime, stageCoreRuntime } from './core-runtime-lib.mjs'

const mode = process.argv[2]
if (mode === '--stage-only') await stageCoreRuntime()
else if (mode === '--package-only') await packageStagedCore()
else if (mode === undefined) await prepareCoreRuntime()
else throw new Error(`Unknown Core build mode: ${mode}`)
