import type { TokenUsage } from '@deepseek-ai/dsh-llm'

export interface UsageTotal {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  complete: boolean
}

export function emptyUsage(): UsageTotal {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    complete: true,
  }
}

export function usageFromDsh(usage: TokenUsage | undefined): UsageTotal {
  if (usage === undefined) return { ...emptyUsage(), calls: 1, complete: false }
  return {
    calls: 1,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    complete: true,
  }
}

export function addUsage(target: UsageTotal, value: UsageTotal): UsageTotal {
  return {
    calls: target.calls + value.calls,
    inputTokens: target.inputTokens + value.inputTokens,
    outputTokens: target.outputTokens + value.outputTokens,
    cacheReadTokens: target.cacheReadTokens + value.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + value.cacheWriteTokens,
    reasoningTokens: target.reasoningTokens + value.reasoningTokens,
    complete: target.complete && value.complete,
  }
}
