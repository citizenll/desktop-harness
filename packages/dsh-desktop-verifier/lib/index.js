import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { isAgentLoopRequest, isTokenDelta, } from '@deepseek-ai/dsh-llm';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { z as wire } from 'zod';
import { collectCandidate, requestContainsImage, serializeRequestContext } from './candidate.js';
import { shouldVerifyRequest } from './eligibility.js';
import { isAbortFailure, VerifierError, verifierError } from './errors.js';
import { applyVerifierEvent, INITIAL_VERIFIER_STATE, parseVerifierTarget, verifierProjection, } from './mode.js';
import { selectVerifiedCandidate } from './pipeline.js';
import { VerifierProgressStore, } from './progress.js';
import { scorePair } from './scorer.js';
import { addUsage, emptyUsage } from './usage.js';
export const name = 'dsh-desktop-verifier';
export const inject = ['llm', 'agents', 'credentials'];
const SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop-verifier');
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_REASONING_EFFORT = 'high';
const DEFAULT_MAX_TOKENS = 32_768;
export const Config = z.object({
    verifierModel: z.string().default(DEFAULT_MODEL),
    baseURL: z.string().default(DEFAULT_BASE_URL),
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
    reasoningEffort: z.union(['off', 'low', 'high', 'max']).default(DEFAULT_REASONING_EFFORT),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
});
function normalizeBaseURL(raw) {
    const value = raw.trim().replace(/\/+$/u, '');
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch (error) {
        throw new VerifierError('Verifier baseURL must be an absolute HTTP(S) URL.', 'VERIFIER_CONFIG_INVALID', { cause: error });
    }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
        throw new VerifierError('Verifier baseURL must be an absolute HTTP(S) URL without credentials, query, or fragment.', 'VERIFIER_CONFIG_INVALID');
    }
    return value;
}
export function resolveConfig(config) {
    const verifierModel = (config.verifierModel ?? DEFAULT_MODEL).trim();
    if (verifierModel.length === 0) {
        throw new VerifierError('Verifier model must not be empty.', 'VERIFIER_CONFIG_INVALID');
    }
    const apiKeyEnv = (config.apiKeyEnv ?? DEFAULT_API_KEY_ENV).trim();
    try {
        credentialRef(apiKeyEnv);
    }
    catch (error) {
        throw new VerifierError('Verifier credential reference is invalid.', 'VERIFIER_CONFIG_INVALID', { cause: error });
    }
    const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
        throw new VerifierError('Verifier maxTokens must be a positive safe integer.', 'VERIFIER_CONFIG_INVALID');
    }
    return {
        verifierModel,
        baseURL: normalizeBaseURL(config.baseURL ?? DEFAULT_BASE_URL),
        apiKeyEnv,
        reasoningEffort: config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        maxTokens,
    };
}
const projectionStateSchema = wire.object({
    active: wire.boolean(),
    running: wire.object({
        commandId: wire.string(),
        wanted: wire.boolean(),
    }).strict().nullable(),
}).strict();
const projectionViewSchema = wire.object({
    active: wire.boolean(),
    pending: wire.boolean(),
}).strict();
function combinedSignal(signal, controller) {
    return signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
}
function failureChunk(error, cancelled) {
    return {
        type: 'finish',
        reason: {
            kind: cancelled ? 'aborted' : 'error',
            failure: {
                code: error.code,
                message: error.message,
            },
        },
    };
}
function writeJson(response, status, value) {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(JSON.stringify(value));
}
function upsertIndexed(values, index, create, update) {
    const position = values.findIndex(value => value.index === index);
    if (position < 0)
        return [...values, update(create())].sort((left, right) => left.index - right.index);
    const next = [...values];
    const current = next[position];
    if (current !== undefined)
        next[position] = update(current);
    return next;
}
function runDiagnostic(sessionId, state) {
    return JSON.stringify({
        event: 'verifier-run',
        sessionId,
        runId: state.runId,
        status: state.status,
        winner: state.winner,
        candidatesCompleted: state.candidatesCompleted,
        comparisonsCompleted: state.comparisonsCompleted,
        usage: state.usage,
        timing: state.timing,
        error: state.error,
    });
}
export function apply(ctx, entry = {}) {
    let source = () => entry;
    resolveConfig(source());
    installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, entry, {
        setSource: current => { source = current; },
        onChange: () => { },
        validate: value => { resolveConfig(value); },
    });
    const progress = new VerifierProgressStore();
    const nestedCandidates = new WeakSet();
    const logger = ctx.logger(name);
    ctx.inject(['sessionProjections'], projectionCtx => {
        projectionCtx.sessionProjections.register({
            key: 'verifier',
            stateSchema: projectionStateSchema,
            init: () => INITIAL_VERIFIER_STATE,
            apply: applyVerifierEvent,
            wire: {
                viewSchema: projectionViewSchema,
                view: verifierProjection,
            },
            stateVersion: 1,
        });
    });
    ctx.inject(['commands'], commandCtx => {
        commandCtx.commands.register({
            name: 'verify',
            description: 'Enable or disable best-of-three response verification for this session',
            input: { hint: '<on|off>' },
            handler: ({ agent, rawInput }) => {
                const target = parseVerifierTarget(rawInput);
                if (target === undefined) {
                    return { kind: 'error', text: 'usage: /verify on|off' };
                }
                if (!target)
                    progress.clear(String(agent.session.id));
                return {
                    kind: 'success',
                    text: target ? 'Verifier enabled for this session.' : 'Verifier disabled for this session.',
                };
            },
        });
    });
    ctx.inject(['webServer'], webCtx => {
        webCtx.webServer.register({
            kind: 'exact',
            path: '/dsh-desktop-verifier/state',
            handler: (request, response) => {
                if (request.method !== 'GET') {
                    response.setHeader('allow', 'GET');
                    writeJson(response, 405, { error: 'method-not-allowed' });
                    return;
                }
                const origin = `http://${request.headers.host ?? '127.0.0.1'}`;
                const sessionId = new URL(request.url ?? '/', origin).searchParams.get('sessionId')?.trim();
                if (sessionId === undefined || sessionId.length === 0) {
                    writeJson(response, 400, { error: 'session-id-required' });
                    return;
                }
                writeJson(response, 200, progress.read(sessionId));
            },
        });
    });
    ctx.on('session/disposed', session => {
        progress.clear(String(session.id));
    });
    ctx.on('llm/stream', (options, next) => {
        const initiator = ctx.agents.currentInitiator();
        const state = initiator === undefined
            ? undefined
            : ctx.get('sessionProjections')?.stateOf(initiator.session, 'verifier');
        const eligible = shouldVerifyRequest(options, {
            bypassed: nestedCandidates.has(options),
            agentLoopRequest: isAgentLoopRequest(options),
            active: state?.active === true,
            initiatorSessionId: initiator === undefined ? undefined : String(initiator.session.id),
        });
        if (!eligible)
            return next();
        return (async function* verifiedStream() {
            const sessionId = String(options.sessionId);
            const run = progress.start(sessionId);
            const runId = run.runId;
            const controller = new AbortController();
            const signal = combinedSignal(options.signal, controller);
            let candidateUsage = emptyUsage();
            try {
                if (signal.aborted)
                    throw new VerifierError('Verifier request was cancelled.', 'VERIFIER_CANCELLED');
                if (requestContainsImage(options)) {
                    throw new VerifierError('Verifier mode does not support image-bearing requests.', 'VERIFIER_IMAGES_UNSUPPORTED');
                }
                const config = resolveConfig(source());
                const credential = await ctx.credentials.resolve(credentialRef(config.apiKeyEnv));
                if (credential === undefined || credential.value.trim().length === 0) {
                    throw new VerifierError(`No credential is configured for ${config.apiKeyEnv}.`, 'VERIFIER_CREDENTIAL_MISSING');
                }
                if (signal.aborted)
                    throw new VerifierError('Verifier request was cancelled.', 'VERIFIER_CANCELLED');
                const connection = {
                    baseURL: config.baseURL,
                    apiKey: credential.value,
                    model: config.verifierModel,
                    reasoningEffort: config.reasoningEffort,
                    maxTokens: config.maxTokens,
                };
                const candidatePromises = Array.from({ length: 3 }, async (_, index) => {
                    const startedAt = Date.now();
                    progress.update(sessionId, runId, current => ({
                        ...current,
                        timing: {
                            ...current.timing,
                            candidates: upsertIndexed(current.timing.candidates, index, () => ({ index, startedAt }), timing => ({ ...timing, startedAt })),
                        },
                    }));
                    const candidateOptions = { ...options, signal };
                    nestedCandidates.add(candidateOptions);
                    let candidate;
                    try {
                        candidate = await collectCandidate(ctx.llm.stream(candidateOptions), {
                            onFirstToken: firstTokenAt => {
                                progress.update(sessionId, runId, current => ({
                                    ...current,
                                    timing: {
                                        ...current.timing,
                                        candidates: upsertIndexed(current.timing.candidates, index, () => ({ index, startedAt }), timing => ({ ...timing, firstTokenAt })),
                                    },
                                }));
                            },
                        });
                    }
                    catch (error) {
                        const endedAt = Date.now();
                        progress.update(sessionId, runId, current => ({
                            ...current,
                            timing: {
                                ...current.timing,
                                candidates: upsertIndexed(current.timing.candidates, index, () => ({ index, startedAt }), timing => ({ ...timing, endedAt })),
                            },
                        }));
                        throw error;
                    }
                    const endedAt = Date.now();
                    candidateUsage = addUsage(candidateUsage, candidate.usage);
                    progress.update(sessionId, runId, current => ({
                        ...current,
                        candidatesCompleted: current.candidatesCompleted + 1,
                        usage: { ...current.usage, candidates: candidateUsage },
                        timing: {
                            ...current.timing,
                            candidates: upsertIndexed(current.timing.candidates, index, () => ({ index, startedAt }), timing => ({ ...timing, endedAt, usage: candidate.usage })),
                        },
                    }));
                    return candidate;
                });
                const candidates = await Promise.all(candidatePromises);
                const generationEndedAt = Date.now();
                progress.update(sessionId, runId, current => ({
                    ...current,
                    timing: { ...current.timing, generationEndedAt },
                }));
                const task = serializeRequestContext(options);
                let comparisonsCompleted = 0;
                let comparisonIndex = 0;
                let verifierUsage = emptyUsage();
                const selection = await selectVerifiedCandidate(candidates, async (pair, candidateA, candidateB) => {
                    const index = comparisonIndex++;
                    const stage = index < 3 ? 'scoring-ring' : 'scoring-pivots';
                    const startedAt = Date.now();
                    const pairValue = [pair[0], pair[1]];
                    progress.update(sessionId, runId, current => ({
                        ...current,
                        timing: {
                            ...current.timing,
                            comparisons: upsertIndexed(current.timing.comparisons, index, () => ({ index, stage, pair: pairValue, startedAt }), timing => ({ ...timing, stage, pair: pairValue, startedAt })),
                        },
                    }));
                    try {
                        const result = await scorePair(connection, task, candidateA.trace, candidateB.trace, signal, {
                            onResponse: responseAt => {
                                progress.update(sessionId, runId, current => ({
                                    ...current,
                                    timing: {
                                        ...current.timing,
                                        comparisons: upsertIndexed(current.timing.comparisons, index, () => ({ index, stage, pair: pairValue, startedAt }), timing => ({ ...timing, responseAt })),
                                    },
                                }));
                            },
                        });
                        const endedAt = Date.now();
                        progress.update(sessionId, runId, current => ({
                            ...current,
                            timing: {
                                ...current.timing,
                                comparisons: upsertIndexed(current.timing.comparisons, index, () => ({ index, stage, pair: pairValue, startedAt }), timing => ({ ...timing, endedAt, usage: result.usage })),
                            },
                        }));
                        return result;
                    }
                    catch (error) {
                        const endedAt = Date.now();
                        progress.update(sessionId, runId, current => ({
                            ...current,
                            timing: {
                                ...current.timing,
                                comparisons: upsertIndexed(current.timing.comparisons, index, () => ({ index, stage, pair: pairValue, startedAt }), timing => ({ ...timing, endedAt })),
                            },
                        }));
                        throw error;
                    }
                }, {
                    stage: status => {
                        const startedAt = Date.now();
                        progress.update(sessionId, runId, current => ({
                            ...current,
                            status,
                            timing: {
                                ...current.timing,
                                scoringStartedAt: current.timing.scoringStartedAt ?? startedAt,
                            },
                        }));
                    },
                    comparisonCompleted: usage => {
                        comparisonsCompleted += 1;
                        verifierUsage = addUsage(verifierUsage, usage);
                        progress.update(sessionId, runId, current => ({
                            ...current,
                            comparisonsCompleted,
                            usage: { ...current.usage, verifier: verifierUsage },
                        }));
                    },
                });
                const winner = candidates[selection.winner];
                if (winner === undefined) {
                    throw new VerifierError('Verifier selected an absent candidate.', 'VERIFIER_SELECTION_INVALID');
                }
                const scoringEndedAt = Date.now();
                const replayStartedAt = Date.now();
                progress.update(sessionId, runId, current => ({
                    ...current,
                    status: 'replaying',
                    winner: selection.winner,
                    comparisonsCompleted: 5,
                    usage: {
                        candidates: candidateUsage,
                        verifier: selection.usage,
                    },
                    timing: {
                        ...current.timing,
                        scoringEndedAt,
                        replayStartedAt,
                    },
                }));
                let replayFirstTokenSeen = false;
                for (const chunk of winner.chunks) {
                    if (!replayFirstTokenSeen && isTokenDelta(chunk)) {
                        replayFirstTokenSeen = true;
                        const replayFirstTokenAt = Date.now();
                        progress.update(sessionId, runId, current => ({
                            ...current,
                            timing: { ...current.timing, replayFirstTokenAt },
                        }));
                    }
                    yield chunk;
                }
                const endedAt = Date.now();
                progress.update(sessionId, runId, current => ({
                    ...current,
                    status: 'complete',
                    timing: {
                        ...current.timing,
                        replayEndedAt: endedAt,
                        endedAt,
                    },
                }));
                logger.info(runDiagnostic(sessionId, progress.read(sessionId)));
            }
            catch (error) {
                controller.abort(error);
                const normalized = verifierError(error, 'VERIFIER_FAILED');
                const cancelled = normalized.code === 'VERIFIER_CANCELLED' || isAbortFailure(error, signal);
                const endedAt = Date.now();
                progress.update(sessionId, runId, current => ({
                    ...current,
                    status: cancelled ? 'cancelled' : 'error',
                    error: { code: normalized.code, message: normalized.message },
                    timing: { ...current.timing, endedAt },
                }));
                logger.info(runDiagnostic(sessionId, progress.read(sessionId)));
                yield failureChunk(normalized, cancelled);
            }
        })();
    });
}
