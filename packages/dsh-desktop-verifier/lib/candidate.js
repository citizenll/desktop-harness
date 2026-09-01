import { contentHasImage, isTokenDelta, } from '@deepseek-ai/dsh-llm';
import { VerifierError } from './errors.js';
import { usageFromDsh } from './usage.js';
function mergeTokenUsage(current, next) {
    return {
        inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
        outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
        cacheReadTokens: (current?.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
        cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
        reasoningTokens: (current?.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
    };
}
function indent(text, spaces = 2) {
    const prefix = ' '.repeat(spaces);
    return text.split('\n').map(line => prefix + line).join('\n');
}
function serializeBlock(block) {
    if (block.type === 'text')
        return `text:\n${indent(block.text)}`;
    if (block.type === 'reasoning')
        return `reasoning:\n${indent(block.text)}`;
    if (block.type === 'image')
        return 'image: [unsupported image evidence]';
    if (block.type === 'tool-call') {
        return [
            `tool-call: ${block.name}`,
            `id: ${String(block.id)}`,
            'arguments:',
            indent(block.arguments),
        ].join('\n');
    }
    if (block.type === 'tool-result') {
        const nested = block.content.map(serializeBlock).join('\n\n');
        return [
            `tool-result: ${String(block.toolCallId)}${block.isError === true ? ' (error)' : ''}`,
            indent(nested),
        ].join('\n');
    }
    return `unknown-block:\n${indent(JSON.stringify(block))}`;
}
function serializeMessage(message, index) {
    const source = JSON.stringify(message.source);
    const body = message.content.map(serializeBlock).join('\n\n');
    return [
        `Message ${index + 1} (${message.role}; source=${source})`,
        body,
    ].join('\n');
}
export function serializeRequestContext(options) {
    const sections = [];
    if (options.system !== undefined)
        sections.push(`System prompt:\n${options.system}`);
    sections.push(`Conversation messages:\n${options.messages.map(serializeMessage).join('\n\n---\n\n')}`);
    if (options.tools !== undefined && options.tools.length > 0) {
        sections.push(`Available tools:\n${JSON.stringify(options.tools, null, 2)}`);
    }
    return sections.join('\n\n===\n\n');
}
export function requestContainsImage(options) {
    return options.messages.some(message => contentHasImage(message.content));
}
export async function collectCandidate(stream, observer = {}) {
    const chunks = [];
    const blocks = new Map();
    let usage;
    let finish;
    let firstTokenSeen = false;
    const now = observer.now ?? Date.now;
    for await (const chunk of stream) {
        chunks.push(chunk);
        if (!firstTokenSeen && isTokenDelta(chunk)) {
            firstTokenSeen = true;
            observer.onFirstToken?.(now());
        }
        if (chunk.type === 'block-end')
            blocks.set(chunk.index, chunk.block);
        else if (chunk.type === 'usage')
            usage = mergeTokenUsage(usage, chunk.usage);
        else if (chunk.type === 'finish')
            finish = chunk;
    }
    if (finish === undefined) {
        throw new VerifierError('Candidate stream ended without a terminal finish.', 'VERIFIER_CANDIDATE_INCOMPLETE');
    }
    if (finish.reason.kind === 'error' || finish.reason.kind === 'aborted') {
        throw new VerifierError(`Candidate generation failed: ${finish.reason.failure.message}`, finish.reason.kind === 'aborted' ? 'VERIFIER_CANCELLED' : 'VERIFIER_CANDIDATE_FAILED');
    }
    if (blocks.size === 0) {
        throw new VerifierError('Candidate generation returned no content.', 'VERIFIER_CANDIDATE_EMPTY');
    }
    const ordered = [...blocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, block]) => block);
    return {
        chunks,
        trace: ordered.map(serializeBlock).join('\n\n---\n\n'),
        usage: usageFromDsh(usage),
    };
}
