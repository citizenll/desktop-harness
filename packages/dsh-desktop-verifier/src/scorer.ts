import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { VerifierError, isAbortFailure } from './errors.js'
import { emptyUsage, type UsageTotal } from './usage.js'

export interface VerifierConnection {
  baseURL: string
  apiKey: string
  model: string
  reasoningEffort: 'off' | 'low' | 'high' | 'max'
  maxTokens: number
}

export interface ScorePairResult {
  score: {
    a: number
    b: number
  }
  usage: UsageTotal
}

export interface ScorePairOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  onResponse?: (at: number) => void
}

interface WireLogprobAlternative {
  token: string
  logprob: number
}

interface WireLogprobPosition extends WireLogprobAlternative {
  top_logprobs?: WireLogprobAlternative[]
}

interface WireResponse {
  choices?: Array<{
    message?: { content?: string | null }
    logprobs?: { content?: WireLogprobPosition[] | null } | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  error?: {
    message?: string
  }
}

const SCORE_TOKENS = Array.from({ length: 20 }, (_, index) => String.fromCharCode(65 + index))
const SCORE_VALUES = new Map(SCORE_TOKENS.map((token, index) => [token, 20 - index]))

const SCALE_DESCRIPTION = `Rate how likely the agent correctly solved the task on a 20-point scale using letters A through T:
  A = clearly and completely succeeded with verified output (best)
  B-D = succeeded with only minor issues
  E-G = above average, mostly correct with some issues
  H-J = uncertain, leans toward success
  K-M = uncertain, leans toward failure
  N-P = below average, significant issues remain
  Q-S = failed with some partial progress
  T = clearly and completely failed (worst)`

const CRITERION_NAME = 'Task Success'
const CRITERION_DESCRIPTION = 'How likely the agent correctly and completely solved the task. Strongest signal is verification against task-specific requirements; length or confidence alone do not imply correctness.'

export function buildVerifierPrompt(task: string, traceA: string, traceB: string): string {
  return [
    'You are an expert evaluator of AI agents. You will see the exact model-visible task context and two candidate responses, then evaluate them on ONE specific criterion stated at the end.',
    `**Task context:**\n${task}`,
    `**Candidate A:**\n${traceA}`,
    `**Candidate B:**\n${traceB}`,
    `**Rating Scale:**\n${SCALE_DESCRIPTION}`,
    `**Evaluation Guideline — ${CRITERION_NAME}:**\n${CRITERION_DESCRIPTION}`,
    `Score each candidate ONLY on "${CRITERION_NAME}". Ignore presentation length or confidence unless it changes task success.`,
    'Reason it through first, then END your reply with exactly these two lines and nothing after them. Replace each placeholder with one letter A-T, preserving the spaces:',
    '<score_A> LETTER_A_TO_T </score_A>',
    '<score_B> LETTER_A_TO_T </score_B>',
    'Begin your analysis now.',
  ].join('\n\n')
}

function validAlternative(token: string): string | undefined {
  let normalized = token.trim()
  if (normalized.startsWith('>')) normalized = normalized.slice(1).trim()
  if (normalized.length !== 1) return undefined
  normalized = normalized.toUpperCase()
  return SCORE_VALUES.has(normalized) ? normalized : undefined
}

function distributionAfterTag(
  positions: readonly WireLogprobPosition[],
  tag: '<score_A>' | '<score_B>',
): readonly WireLogprobAlternative[] | undefined {
  let text = ''
  let found: readonly WireLogprobAlternative[] | undefined
  for (let index = 0; index < positions.length; index++) {
    const position = positions[index]
    if (position === undefined) continue
    const token = position.token
    text += token
    if (token.trim().length === 0 || index + 1 >= positions.length) continue
    const stripped = text.trimEnd()
    if (stripped.endsWith(tag) || stripped.endsWith(tag.slice(0, -1))) {
      const alternatives = positions[index + 1]?.top_logprobs
      if (Array.isArray(alternatives) && alternatives.length > 0) found = alternatives
    }
  }
  return found
}

export function expectedScore(
  positions: readonly WireLogprobPosition[],
  tag: '<score_A>' | '<score_B>',
): number {
  const alternatives = distributionAfterTag(positions, tag)
  if (alternatives === undefined) {
    throw new VerifierError(`Verifier returned no top-logprob distribution for ${tag}.`, 'VERIFIER_SCORE_DISTRIBUTION_MISSING')
  }

  const probabilities = new Map<number, number>()
  for (const alternative of alternatives) {
    const token = validAlternative(alternative.token)
    if (token === undefined || !Number.isFinite(alternative.logprob)) continue
    const value = SCORE_VALUES.get(token)
    if (value === undefined) continue
    const probability = Math.exp(alternative.logprob)
    probabilities.set(value, Math.max(probabilities.get(value) ?? 0, probability))
  }
  const total = [...probabilities.values()].reduce((sum, probability) => sum + probability, 0)
  if (!(total > 0)) {
    throw new VerifierError(`Verifier top logprobs contained no A-T alternatives for ${tag}.`, 'VERIFIER_SCORE_DISTRIBUTION_MISSING')
  }
  const expected = [...probabilities.entries()]
    .reduce((sum, [value, probability]) => sum + value * probability, 0) / total
  return (expected - 1) / 19
}

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function usageFromWire(response: WireResponse): UsageTotal {
  const usage = response.usage
  if (usage === undefined) return { ...emptyUsage(), calls: 1, complete: false }
  const cacheRead = finiteTokenCount(
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens,
  )
  const promptTotal = finiteTokenCount(usage.prompt_tokens)
  const explicitMiss = usage.prompt_cache_miss_tokens
  const inputTokens = typeof explicitMiss === 'number' && Number.isFinite(explicitMiss) && explicitMiss >= 0
    ? explicitMiss
    : Math.max(0, promptTotal - cacheRead)
  return {
    calls: 1,
    inputTokens,
    outputTokens: finiteTokenCount(usage.completion_tokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    reasoningTokens: finiteTokenCount(usage.completion_tokens_details?.reasoning_tokens),
    complete: typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number',
  }
}

function endpoint(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/u, '')
  if (normalized.length === 0) {
    throw new VerifierError('Verifier baseURL is empty.', 'VERIFIER_CONFIG_INVALID')
  }
  return `${normalized}/chat/completions`
}

export async function scorePair(
  connection: VerifierConnection,
  task: string,
  traceA: string,
  traceB: string,
  signal: AbortSignal,
  options: ScorePairOptions = {},
): Promise<ScorePairResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const body: Record<string, unknown> = {
    model: connection.model,
    messages: [{ role: 'user', content: buildVerifierPrompt(task, traceA, traceB) }],
    max_tokens: connection.maxTokens,
    temperature: 1,
    logprobs: true,
    top_logprobs: 20,
    thinking: { type: connection.reasoningEffort === 'off' ? 'disabled' : 'enabled' },
  }
  if (connection.reasoningEffort !== 'off') body.reasoning_effort = connection.reasoningEffort

  let response: Response
  try {
    response = await fetchImpl(endpoint(connection.baseURL), {
      method: 'POST',
      headers: {
        ...attributionHeaders(),
        authorization: `Bearer ${connection.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
    options.onResponse?.(now())
  } catch (error) {
    if (isAbortFailure(error, signal)) {
      throw new VerifierError('Verifier request was cancelled.', 'VERIFIER_CANCELLED', { cause: error })
    }
    throw new VerifierError('Verifier request failed before receiving a response.', 'VERIFIER_REQUEST_FAILED', { cause: error })
  }

  const raw = await response.text()
  let payload: WireResponse
  try {
    payload = JSON.parse(raw) as WireResponse
  } catch (error) {
    throw new VerifierError('Verifier returned malformed JSON.', 'VERIFIER_RESPONSE_INVALID', { cause: error })
  }
  if (!response.ok) {
    const detail = payload.error?.message?.trim() || raw.slice(0, 500).trim() || response.statusText
    throw new VerifierError(
      `Verifier HTTP ${response.status}: ${detail}`,
      'VERIFIER_HTTP_ERROR',
    )
  }

  const positions = payload.choices?.[0]?.logprobs?.content
  if (!Array.isArray(positions) || positions.length === 0) {
    throw new VerifierError('Verifier returned no answer token logprobs.', 'VERIFIER_LOGPROBS_MISSING')
  }
  return {
    score: {
      a: expectedScore(positions, '<score_A>'),
      b: expectedScore(positions, '<score_B>'),
    },
    usage: usageFromWire(payload),
  }
}
