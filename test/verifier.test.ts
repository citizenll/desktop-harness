import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  collectCandidate,
  requestContainsImage,
} from '../packages/dsh-desktop-verifier/src/candidate'
import { shouldVerifyRequest } from '../packages/dsh-desktop-verifier/src/eligibility'
import { VerifierError } from '../packages/dsh-desktop-verifier/src/errors'
import { resolveConfig } from '../packages/dsh-desktop-verifier/src/index'
import {
  applyVerifierEvent,
  foldVerifierMode,
  INITIAL_VERIFIER_STATE,
  parseVerifierTarget,
  verifierProjection,
} from '../packages/dsh-desktop-verifier/src/mode'
import { selectVerifiedCandidate } from '../packages/dsh-desktop-verifier/src/pipeline'
import { VerifierProgressStore } from '../packages/dsh-desktop-verifier/src/progress'
import {
  expectedScore,
  scorePair,
  usageFromWire,
} from '../packages/dsh-desktop-verifier/src/scorer'
import {
  BO3_RING,
  bradleyTerry,
  pairKey,
  pivotRoundPairs,
  selectPivots,
  selectWinner,
  type DirectedPair,
  type PairScore,
} from '../packages/dsh-desktop-verifier/src/tournament'
import { emptyUsage } from '../packages/dsh-desktop-verifier/src/usage'

const projectRoot = path.resolve(import.meta.dirname, '..')

function sessionEvent(type: string, data: Record<string, unknown>, seq = 0): SessionEvent {
  return { type, data, seq, time: 1_700_000_000_000 } as unknown as SessionEvent
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'test-provider',
    model: 'test-model',
    messages: [],
    sessionId: 'session-a' as GenerateOptions['sessionId'],
    ...overrides,
  }
}

function streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function scorePositions(
  tag: '<score_A>' | '<score_B>',
  alternatives: Array<{ token: string; logprob: number }>,
) {
  return [
    { token: tag, logprob: 0, top_logprobs: [{ token: tag, logprob: 0 }] },
    { token: ' A', logprob: alternatives[0]?.logprob ?? 0, top_logprobs: alternatives },
  ]
}

describe('Verifier session mode', () => {
  it('accepts only the exact on/off grammar', () => {
    expect(parseVerifierTarget(' on ')).toBe(true)
    expect(parseVerifierTarget('off')).toBe(false)
    expect(parseVerifierTarget('true')).toBeUndefined()
    expect(parseVerifierTarget(undefined)).toBeUndefined()
  })

  it('commits only a successful matching command lifecycle and replays durably', () => {
    const runOn = sessionEvent('command/run', {
      commandId: 'verify-1',
      name: 'verify',
      args: ' on',
      source: 'composer',
    }, 1)
    const pending = applyVerifierEvent(INITIAL_VERIFIER_STATE, runOn)
    expect(verifierProjection(pending)).toEqual({ active: false, pending: true })

    const unrelatedDone = sessionEvent('command/done', {
      commandId: 'other',
      kind: 'success',
    }, 2)
    expect(applyVerifierEvent(pending, unrelatedDone)).toBe(pending)

    const failed = sessionEvent('command/done', {
      commandId: 'verify-1',
      kind: 'error',
      text: 'rejected',
    }, 3)
    expect(applyVerifierEvent(pending, failed)).toEqual({ active: false, running: null })

    const successfulEvents = [
      runOn,
      sessionEvent('command/done', { commandId: 'verify-1', kind: 'success' }, 2),
    ]
    expect(foldVerifierMode(successfulEvents)).toBe(true)

    const replayedOff = [
      ...successfulEvents,
      sessionEvent('command/run', {
        commandId: 'verify-2',
        name: 'verify',
        args: ' off',
        source: 'composer',
      }, 3),
      sessionEvent('command/done', { commandId: 'verify-2', kind: 'success' }, 4),
    ]
    expect(foldVerifierMode(replayedOff)).toBe(false)
  })
})

describe('Verifier request boundary', () => {
  const eligible = {
    bypassed: false,
    agentLoopRequest: true,
    active: true,
    initiatorSessionId: 'session-a',
  }

  it('verifies only the active ordinary request of the exact initiating session', () => {
    expect(shouldVerifyRequest(request(), eligible)).toBe(true)
    expect(shouldVerifyRequest(request({ purpose: 'compaction' }), eligible)).toBe(false)
    expect(shouldVerifyRequest(request({ sessionId: 'session-b' as GenerateOptions['sessionId'] }), eligible)).toBe(false)
    expect(shouldVerifyRequest(request(), { ...eligible, bypassed: true })).toBe(false)
    expect(shouldVerifyRequest(request(), { ...eligible, agentLoopRequest: false })).toBe(false)
    expect(shouldVerifyRequest(request(), { ...eligible, active: false })).toBe(false)
    expect(shouldVerifyRequest(request(), { ...eligible, initiatorSessionId: undefined })).toBe(false)
  })

  it('detects image evidence before generation', () => {
    const imageRequest = request({
      messages: [{
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: { id: 'image-1' } }],
      }] as unknown as GenerateOptions['messages'],
    })
    expect(requestContainsImage(imageRequest)).toBe(true)
    expect(requestContainsImage(request())).toBe(false)
  })
})

describe('Verifier candidate buffering', () => {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'done' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
    {
      type: 'usage',
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 },
    },
    { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'r1' } } },
  ]

  it('retains every original winner chunk by object identity', async () => {
    const onFirstToken = vi.fn()
    const candidate = await collectCandidate(streamOf(chunks), {
      now: () => 1_234,
      onFirstToken,
    })
    expect(candidate.chunks).toEqual(chunks)
    candidate.chunks.forEach((chunk, index) => expect(chunk).toBe(chunks[index]))
    expect(candidate.trace).toContain('text:\n  done')
    expect(candidate.usage).toMatchObject({ calls: 1, inputTokens: 4, outputTokens: 2 })
    expect(onFirstToken).toHaveBeenCalledOnce()
    expect(onFirstToken).toHaveBeenCalledWith(1_234)
  })

  it('fails closed on incomplete, failed, and empty streams', async () => {
    await expect(collectCandidate(streamOf(chunks.slice(0, -1)))).rejects.toMatchObject({
      code: 'VERIFIER_CANDIDATE_INCOMPLETE',
    })
    await expect(collectCandidate(streamOf([{
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'failed' } },
    }]))).rejects.toMatchObject({ code: 'VERIFIER_CANDIDATE_FAILED' })
    await expect(collectCandidate(streamOf([{
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } },
    }]))).rejects.toMatchObject({ code: 'VERIFIER_CANCELLED' })
    await expect(collectCandidate(streamOf([{
      type: 'finish',
      reason: { kind: 'stop' },
    }]))).rejects.toMatchObject({ code: 'VERIFIER_CANDIDATE_EMPTY' })
  })
})

describe('Probabilistic Pivot Tournament', () => {
  it('uses the fixed seed-zero BO3 ring and deterministic pivot ties', () => {
    expect(BO3_RING).toEqual([[0, 2], [2, 1], [1, 0]])
    expect(selectPivots([1, 1, 1], [2, 2, 2], 1)).toEqual([0])
    expect(pivotRoundPairs(3, [0])).toEqual([[1, 0], [2, 0]])
    expect(bradleyTerry(0.5, 0.5)).toBe(0.5)
  })

  it('performs exactly three ring and two pivot comparisons', async () => {
    const candidates = [0, 1, 2].map(index => ({
      chunks: [],
      trace: String(index),
      usage: emptyUsage(),
    }))
    const calls: DirectedPair[] = []
    const stages: string[] = []
    let completions = 0
    const result = await selectVerifiedCandidate(
      candidates,
      async (pair, candidateA, candidateB) => {
        calls.push(pair)
        const a = Number(candidateA.trace)
        const b = Number(candidateB.trace)
        return {
          score: { a: a === 0 ? 1 : 0, b: b === 0 ? 1 : 0 },
          usage: { ...emptyUsage(), calls: 1 },
        }
      },
      {
        stage: stage => { stages.push(stage) },
        comparisonCompleted: () => { completions += 1 },
      },
    )

    expect(calls).toEqual([[0, 2], [2, 1], [1, 0], [1, 0], [2, 0]])
    expect(stages).toEqual(['scoring-ring', 'scoring-pivots'])
    expect(completions).toBe(5)
    expect(result).toMatchObject({ winner: 0, usage: { calls: 5 } })
  })

  it('resolves a full-selection tie to the lowest candidate index', () => {
    const ring = new Map<string, PairScore>(BO3_RING.map(pair => [pairKey(pair), { a: 0.5, b: 0.5 }]))
    const pivots = pivotRoundPairs(3, [0])
    const pivotScores = new Map<string, PairScore>(pivots.map(pair => [pairKey(pair), { a: 0.5, b: 0.5 }]))
    expect(selectWinner(3, ring, pivots, pivotScores)).toEqual({
      winner: 0,
      means: [0.5, 0.5, 0.5],
    })
  })
})

describe('Verifier logprob scoring', () => {
  it('computes the normalized expected A-T reward and rejects absent distributions', () => {
    const positions = scorePositions('<score_A>', [
      { token: ' A', logprob: Math.log(0.75) },
      { token: 'T', logprob: Math.log(0.25) },
    ])
    expect(expectedScore(positions, '<score_A>')).toBeCloseTo(0.75, 10)
    expect(() => expectedScore([], '<score_A>')).toThrowError(VerifierError)
    try {
      expectedScore([], '<score_A>')
    } catch (error) {
      expect(error).toMatchObject({ code: 'VERIFIER_SCORE_DISTRIBUTION_MISSING' })
    }
  })

  it('sends one strict DeepSeek-compatible scoring request and records disjoint usage', async () => {
    const seen = vi.fn()
    const positions = [
      ...scorePositions('<score_A>', [{ token: 'A', logprob: 0 }]),
      { token: '</score_A>\n', logprob: 0, top_logprobs: [] },
      ...scorePositions('<score_B>', [{ token: 'T', logprob: 0 }]),
    ]
    const fetchImpl: typeof fetch = async (input, init) => {
      seen(String(input), JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'verdict' }, logprobs: { content: positions } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 20 },
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const onResponse = vi.fn()
    const result = await scorePair({
      baseURL: 'https://api.deepseek.com/',
      apiKey: 'secret',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      maxTokens: 32768,
    }, 'task', 'A trace', 'B trace', new AbortController().signal, {
      fetchImpl,
      now: () => 2_345,
      onResponse,
    })

    expect(result.score.a).toBe(1)
    expect(result.score.b).toBe(0)
    expect(result.usage).toEqual({
      calls: 1,
      inputTokens: 80,
      outputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
      complete: true,
    })
    expect(seen).toHaveBeenCalledOnce()
    expect(onResponse).toHaveBeenCalledOnce()
    expect(onResponse).toHaveBeenCalledWith(2_345)
    const call = seen.mock.calls[0]
    expect(call).toBeDefined()
    const [url, body] = call!
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      temperature: 1,
      logprobs: true,
      top_logprobs: 20,
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })

  it('exposes stable failure codes without literal-label fallback', async () => {
    const connection = {
      baseURL: 'https://api.deepseek.com',
      apiKey: 'secret',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high' as const,
      maxTokens: 32768,
    }
    const signal = new AbortController().signal
    const failing = async (payload: unknown, status = 200) => scorePair(
      connection,
      'task',
      'A',
      'B',
      signal,
      {
        fetchImpl: async () => new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status }),
      },
    )

    await expect(failing('not-json')).rejects.toMatchObject({ code: 'VERIFIER_RESPONSE_INVALID' })
    await expect(failing({ error: { message: 'denied' } }, 401)).rejects.toMatchObject({
      code: 'VERIFIER_HTTP_ERROR',
    })
    await expect(failing({ choices: [{ message: { content: '<score_A> A </score_A>' } }] }))
      .rejects.toMatchObject({ code: 'VERIFIER_LOGPROBS_MISSING' })
    await expect(scorePair(connection, 'task', 'A', 'B', signal, {
      fetchImpl: async () => {
        throw new DOMException('aborted', 'AbortError')
      },
    })).rejects.toMatchObject({ code: 'VERIFIER_CANCELLED' })
  })

  it('does not invent missing provider usage', () => {
    expect(usageFromWire({})).toEqual({ ...emptyUsage(), calls: 1, complete: false })
  })
})

describe('Verifier configuration, progress, and UI boundary', () => {
  it('resolves fixed defaults and rejects invalid connection settings', () => {
    expect(resolveConfig({})).toEqual({
      verifierModel: 'deepseek-v4-flash',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      reasoningEffort: 'high',
      maxTokens: 32768,
    })
    expect(() => resolveConfig({ baseURL: 'relative/path' })).toThrowError(VerifierError)
    expect(() => resolveConfig({ apiKeyEnv: 'not valid' })).toThrowError(VerifierError)
  })

  it('keeps progress session-scoped and rejects stale run updates', () => {
    const store = new VerifierProgressStore(() => 1_700_000_000_000)
    const first = store.start('session-a')
    const second = store.start('session-a')
    store.update('session-a', first.runId!, current => ({ ...current, status: 'error' }))
    expect(store.read('session-a').runId).toBe(second.runId)
    expect(store.read('session-a').status).toBe('generating')
    expect(store.read('session-a').timing).toMatchObject({
      startedAt: 1_700_000_000_000,
      candidates: [],
      comparisons: [],
    })
    expect(store.read('session-b').status).toBe('idle')
  })

  it('registers only the toggle and progress slots and preflights before candidate calls', async () => {
    const [clientSource, hostSource] = await Promise.all([
      readFile(path.join(projectRoot, 'packages', 'dsh-desktop-verifier', 'src', 'client', 'index.ts'), 'utf8'),
      readFile(path.join(projectRoot, 'packages', 'dsh-desktop-verifier', 'src', 'index.ts'), 'utf8'),
    ])
    expect(clientSource.match(/ctx\.slots\.inject\(/gu)).toHaveLength(2)
    expect(clientSource).toContain("ctx.slots.inject('conversation.input.right'")
    expect(clientSource).toContain("ctx.slots.inject('conversation.input.dock'")
    expect(clientSource).not.toContain('candidate.trace')

    const imageCheck = hostSource.indexOf('if (requestContainsImage(options))')
    const credentialCheck = hostSource.indexOf('await ctx.credentials.resolve')
    const candidateDispatch = hostSource.indexOf('const candidatePromises')
    expect(imageCheck).toBeGreaterThan(-1)
    expect(credentialCheck).toBeGreaterThan(imageCheck)
    expect(candidateDispatch).toBeGreaterThan(credentialCheck)
  })
})
