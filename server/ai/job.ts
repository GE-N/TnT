import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseAllDocuments} from 'yaml';
import {AuthoringHttpError} from '../authoring/errors.js';
import {assertUniqueMembers, requireRevision, requireWorkspaceId} from '../authoring/schema.js';
import {CONTRACT_VERSION, type Preview} from '../authoring/types.js';
import {AiHttpError, canAutoRetry, mapProviderFailure} from './errors.js';
import {formatAiLog, type AiLogEvent} from './log.js';
import {assertUserPrompt, assembleCall, packPrompt, type PromptContext} from './prompt.js';
import {MAX_REPAIR_ROUNDS, repairDecision, repairNote} from './repair.js';
import {abortError, isAbortError, MAX_UPSTREAM_POSTS, ProviderRequestError, RESPONSE_BYTE_LIMIT, type FlowModelProvider, type Msg, type UpstreamBudget, type Usage} from './providers/types.js';
import {createJobStore, generationView, jobExpiry, type GenerationView, type StoredJob} from './store.js';

export const SUBMISSION_DEADLINE_MS = 120_000;
export const MAX_PROVIDER_RETRIES = 1;
export const MAX_OUTPUT_TOKENS = 8_192;
export {MAX_UPSTREAM_POSTS, RESPONSE_BYTE_LIMIT};

const FLOW_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/contracts/ai-flow-v1/flow-draft.schema.json', import.meta.url)), 'utf8')) as object;
const APP_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Timeouts = {deadlineMs: number};

export type ResolvedModel = {
  provider: FlowModelProvider;
  model: string;
  providerId: string;
  /** Fires if this provider's key is removed while the call is in flight. */
  bindRemoval?: (abort: () => void) => () => void;
};
export type Scheduler = {
  now(): number;
  delay(ms: number, signal?: AbortSignal): Promise<void>;
  schedule(ms: number, fn: () => void): () => void;
};

export function realScheduler(): Scheduler {
  return {
    now: () => Date.now(),
    delay(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(abortError()); return; }
        const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
        const onAbort = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        signal?.addEventListener('abort', onAbort, {once: true});
      });
    },
    schedule(ms, fn) {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };
}

type AuthoringApi = {
  context(input: unknown, topKeys?: string[]): Promise<unknown>;
  preview(input: unknown, topKeys?: string[]): Promise<Preview>;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function list(value: unknown) { return Array.isArray(value) ? value : []; }

function appIdOf(yaml: string) {
  try {
    const value = parseAllDocuments(yaml)[0]?.toJS() as {appId?: unknown} | undefined;
    return typeof value?.appId === 'string' && APP_ID.test(value.appId) ? value.appId : '';
  } catch { return ''; }
}

function factsFrom(context: unknown): PromptContext {
  const body = record(context) ?? {};
  const execution = record(body.executionOptions) ?? {};
  const available = record(record(body.capabilities)?.available);
  return {
    screens: list(body.screens).flatMap(item => {
      const row = record(item);
      if (!row || typeof row.screenId !== 'string') return [];
      return [{screenId: row.screenId, title: typeof row.title === 'string' ? row.title : ''}];
    }),
    targets: list(body.targets).flatMap(item => {
      const row = record(item);
      const selector = row && record(row.selector);
      if (!row || !selector || typeof row.ref !== 'string' || typeof row.screenId !== 'string') return [];
      if (typeof selector.target !== 'string' || typeof selector.match !== 'string' || typeof selector.value !== 'string') return [];
      return [{ref: row.ref, screenId: row.screenId, role: typeof row.role === 'string' ? row.role : '', selector: {target: selector.target, match: selector.match, value: selector.value}}];
    }),
    setups: list(execution.setups).flatMap(item => {
      const row = record(item);
      if (!row || typeof row.ref !== 'string') return [];
      return [{ref: row.ref, file: typeof row.file === 'string' ? row.file : '', parameterNames: list(row.parameterNames).filter((name): name is string => typeof name === 'string')}];
    }),
    handlers: list(execution.handlers).flatMap(item => {
      const row = record(item);
      if (!row || typeof row.ref !== 'string') return [];
      return [{ref: row.ref, name: typeof row.name === 'string' ? row.name : ''}];
    }),
    mocks: list(execution.mocks).flatMap(item => {
      const row = record(item);
      return row && typeof row.ref === 'string' ? [{ref: row.ref}] : [];
    }),
    omissions: list(body.omissions).flatMap(item => {
      const row = record(item);
      if (!row || typeof row.kind !== 'string') return [];
      return [{kind: row.kind, reason: typeof row.reason === 'string' ? row.reason : ''}];
    }),
    ...(available && typeof available.screens === 'number' ? {availableScreens: available.screens} : {}),
    ...(available && typeof available.transitions === 'number' ? {availableTransitions: available.transitions} : {}),
  };
}

/** Exactly one JSON document. One surrounding fence is tolerated; a fragment inside prose is not. */
function unwrap(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

function parseModelDraft(text: string): {ok: true; value: unknown} | {ok: false; code: string} {
  const source = unwrap(text);
  if (Buffer.byteLength(source) > RESPONSE_BYTE_LIMIT) return {ok: false, code: 'OUTPUT_TOO_LARGE'};
  try { assertUniqueMembers(source); }
  catch (error) {
    if (error instanceof AuthoringHttpError && error.code === 'DUPLICATE_MEMBER') return {ok: false, code: 'DUPLICATE_MEMBER'};
    return {ok: false, code: 'INVALID_JSON'};
  }
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {ok: false, code: 'INVALID_JSON'};
    return {ok: true, value};
  } catch { return {ok: false, code: 'INVALID_JSON'}; }
}

function requestOf(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Provide a generation request.');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !['workspaceId', 'expectedRevision', 'expectedSettingsRevision', 'prompt', 'previousJobId'].includes(key))) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Unknown generation field.');
  let expectedSettingsRevision: number | undefined;
  if (body.expectedSettingsRevision !== undefined) {
    if (!Number.isInteger(body.expectedSettingsRevision) || (body.expectedSettingsRevision as number) < 0) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Provide the settings revision.');
    expectedSettingsRevision = body.expectedSettingsRevision as number;
  }
  let previousJobId: string | undefined;
  if (body.previousJobId !== undefined) {
    if (typeof body.previousJobId !== 'string' || !ID.test(body.previousJobId)) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Provide the previous generation.');
    previousJobId = body.previousJobId;
  }
  return {
    workspaceId: requireWorkspaceId(body.workspaceId),
    expectedRevision: requireRevision(body.expectedRevision),
    prompt: assertUserPrompt(body.prompt),
    expectedSettingsRevision,
    previousJobId,
  };
}

function submissionBudget(deadlineAt: number, now: () => number): UpstreamBudget & {used(): number} {
  let used = 0;
  return {
    used: () => used,
    remaining() {
      if (now() >= deadlineAt) return 0;
      return Math.max(0, MAX_UPSTREAM_POSTS - used);
    },
    tryConsume() {
      if (now() >= deadlineAt || used >= MAX_UPSTREAM_POSTS) return false;
      used += 1;
      return true;
    },
  };
}

function rememberUsage(job: StoredJob, usage: Usage | undefined) {
  if (usage?.inputTokens !== undefined) job.inputTokens = usage.inputTokens;
  else delete job.inputTokens;
  if (usage?.outputTokens !== undefined) job.outputTokens = usage.outputTokens;
  else delete job.outputTokens;
  if (usage?.cost !== undefined) job.cost = usage.cost;
  else delete job.cost;
}

function asProviderError(error: unknown) {
  if (error instanceof ProviderRequestError) return error;
  if (error instanceof TypeError) return new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The provider could not be reached.', retryable: true, reason: 'network'});
  return;
}

export function createJobs(deps: {
  authoring: AuthoringApi;
  readWorkspace: (id: string) => Promise<{yaml: string}>;
  store: ReturnType<typeof createJobStore>;
  now: () => Date;
  log: (line: string) => void;
  scheduler?: Scheduler;
  timeouts?: Partial<Timeouts>;
  resolveProvider: () => Promise<ResolvedModel>;
  settingsRevision: () => Promise<number>;
}) {
  const scheduler = deps.scheduler ?? realScheduler();
  const timeouts: Timeouts = {deadlineMs: SUBMISSION_DEADLINE_MS, ...deps.timeouts};
  const memory = new Map<string, StoredJob>();
  const active = new Map<string, string>();
  const runtimes = new Map<string, AbortController>();
  const runs = new Map<string, Promise<void>>();

  function release(job: StoredJob) {
    if (active.get(job.workspaceId) === job.id) active.delete(job.workspaceId);
  }

  function fail(job: StoredJob, code: string, message: string, retryable: boolean) {
    if (job.state !== 'running') return false;
    job.state = 'failed';
    job.error = {code, message, retryable};
    release(job);
    return true;
  }

  function logEvent(event: AiLogEvent) { deps.log(formatAiLog(event)); }

  async function recover() {
    for (const job of await deps.store.list()) {
      if (Date.parse(job.expiresAt) <= deps.now().getTime()) { await deps.store.remove(job.id); continue; }
      if (job.state === 'running') {
        job.state = 'failed';
        job.error = {code: 'INTERRUPTED', message: 'Generation stopped because the workbench restarted.', retryable: true};
        await deps.store.save(job);
      }
      memory.set(job.id, job);
    }
  }

  async function load(id: string) {
    if (!ID.test(id)) throw new AiHttpError(404, 'UNKNOWN_JOB', 'Unknown generation.');
    const job = memory.get(id) ?? await deps.store.read(id);
    if (!job || Date.parse(job.expiresAt) <= deps.now().getTime()) {
      if (job) { memory.delete(job.id); await deps.store.remove(job.id); }
      throw new AiHttpError(404, 'UNKNOWN_JOB', 'Unknown generation.');
    }
    if (job.preview && job.previewExpiresAt && Date.parse(job.previewExpiresAt) <= deps.now().getTime()) {
      delete job.preview;
      await deps.store.save(job);
    }
    memory.set(job.id, job);
    return job;
  }

  async function oneCall(job: StoredJob, resolved: ResolvedModel, system: string, messages: Msg[], parent: AbortSignal, budget: UpstreamBudget) {
    if (job.state !== 'running') return 'stopped' as const;
    const call = new AbortController();
    const onParent = () => call.abort();
    if (parent.aborted) call.abort();
    else parent.addEventListener('abort', onParent, {once: true});
    let text = '';
    let usage: Usage | undefined;
    let reportedModel: string | undefined;
    let upstreamProvider: string | undefined;
    const started = scheduler.now();
    try {
      for await (const event of resolved.provider.generate({system, messages, schema: FLOW_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS, signal: call.signal, budget})) {
        if (job.state !== 'running') return 'stopped' as const;
        if (event.delta) text += event.delta;
        if (Buffer.byteLength(text) > RESPONSE_BYTE_LIMIT) throw new ProviderRequestError({code: 'PROVIDER_REJECTED', message: 'The model output was too large.', retryable: false, outputTooLarge: true});
        if (event.done) {
          if (event.done.text) text = event.done.text;
          if (event.done.usage) usage = event.done.usage;
          if (event.done.model) reportedModel = event.done.model;
          if (event.done.upstreamProvider) upstreamProvider = event.done.upstreamProvider;
        }
      }
    } catch (error) {
      if (job.state !== 'running' || isAbortError(error)) return 'stopped' as const;
      throw error;
    } finally {
      parent.removeEventListener('abort', onParent);
    }
    if (job.state !== 'running') return 'stopped' as const;
    if (Buffer.byteLength(text) > RESPONSE_BYTE_LIMIT) throw new ProviderRequestError({code: 'PROVIDER_REJECTED', message: 'The model output was too large.', retryable: false, outputTooLarge: true});
    rememberUsage(job, usage);
    if (reportedModel) job.model = reportedModel;
    else delete job.model;
    if (upstreamProvider) job.upstreamProvider = upstreamProvider;
    else delete job.upstreamProvider;
    logEvent({
      requestId: job.id, provider: resolved.providerId, model: job.model ?? resolved.model, upstreamProvider: job.upstreamProvider,
      durationMs: Math.max(0, scheduler.now() - started), inputTokens: job.inputTokens, outputTokens: job.outputTokens, cost: job.cost,
      contractVersion: CONTRACT_VERSION, diagnosticCodes: job.contextTrimmed ? ['CONTEXT_TRIMMED'] : [], outcome: 'model',
    });
    return {text};
  }

  async function callWithRetries(job: StoredJob, resolved: ResolvedModel, system: string, messages: Msg[], parent: AbortSignal, budget: ReturnType<typeof submissionBudget>, deadlineAt: number) {
    let retried = false;
    for (;;) {
      if (job.state !== 'running') return 'stopped' as const;
      try {
        return await oneCall(job, resolved, system, messages, parent, budget);
      } catch (error) {
        if (job.state !== 'running' || isAbortError(error)) return 'stopped' as const;
        const providerError = asProviderError(error);
        if (!providerError) throw error;
        const wait = providerError.retryAfterMs ?? 0;
        const fits = scheduler.now() + wait <= deadlineAt && budget.remaining() >= 1;
        if (retried || !canAutoRetry(providerError) || !fits) throw providerError;
        retried = true;
        try { await scheduler.delay(wait, parent); }
        catch (delayError) {
          if (job.state !== 'running' || isAbortError(delayError)) return 'stopped' as const;
          throw delayError;
        }
      }
    }
  }

  function keepLast(job: StoredJob) {
    if (job.preview) {
      job.state = job.preview.applicable ? 'pending' : 'needsInfo';
      release(job);
      return;
    }
    fail(job, 'INVALID_AI_OUTPUT', 'The model did not return a flow draft.', false);
  }

  async function execute(job: StoredJob, resolved: ResolvedModel, prompt: string, draft: unknown, parent: AbortSignal, budget: ReturnType<typeof submissionBudget>, deadlineAt: number) {
    job.phase = 'context';
    const context = await deps.authoring.context({workspaceId: job.workspaceId, expectedRevision: job.baseRevision});
    if (job.state !== 'running') return;
    const workspace = await deps.readWorkspace(job.workspaceId);
    if (job.state !== 'running') return;
    const appId = appIdOf(workspace.yaml);
    if (!appId) { fail(job, 'APP_ID_MISMATCH', 'This workspace has no app id to author against.', false); return; }
    const contextId = record(context)?.contextId;
    if (typeof contextId !== 'string' || !contextId) { fail(job, 'AUTHORING_INVALID', 'The workspace could not be prepared for generation.', false); return; }
    const schemaBytes = Buffer.byteLength(JSON.stringify(FLOW_SCHEMA));
    const packed = packPrompt({prompt, appId, context: factsFrom(context), ...(draft !== undefined ? {draft} : {}), extraBytes: schemaBytes});
    if (packed.contextTrimmed) job.contextTrimmed = true;
    let round = 0;
    let previous = '';
    let note = '';
    while (job.state === 'running') {
      job.phase = round === 0 ? 'model' : 'repairing';
      const assembled = assembleCall({
        system: packed.system,
        user: packed.user,
        previous: round === 0 ? undefined : previous,
        repair: round === 0 ? undefined : note,
        extraBytes: schemaBytes,
      });
      if (!assembled.fits || budget.remaining() < 1) {
        if (round === 0 && !assembled.fits) { fail(job, 'PROMPT_TOO_LONG', 'The prompt does not fit the model budget.', false); return; }
        if (round === 0) { fail(job, 'TIMEOUT', 'The generation timed out.', true); return; }
        keepLast(job);
        return;
      }
      const result = await callWithRetries(job, resolved, packed.system, assembled.messages, parent, budget, deadlineAt);
      if (result === 'stopped' || job.state !== 'running') return;
      previous = result.text;
      job.phase = 'validating';
      const parsed = parseModelDraft(result.text);
      if (!parsed.ok) {
        if (parsed.code === 'OUTPUT_TOO_LARGE' || round >= MAX_REPAIR_ROUNDS || budget.remaining() < 1) {
          fail(job, 'INVALID_AI_OUTPUT', parsed.code === 'OUTPUT_TOO_LARGE' ? 'The model output was too large.' : 'The model did not return a flow draft.', false);
          return;
        }
        note = repairNote([{code: parsed.code, path: '', severity: 'error'}]);
        round++;
        continue;
      }
      job.phase = 'previewing';
      const preview = await deps.authoring.preview({workspaceId: job.workspaceId, expectedRevision: job.baseRevision, contextId, draft: parsed.value});
      if (job.state !== 'running') return;
      job.draft = parsed.value;
      const decision = preview.applicable ? 'accept' : repairDecision(preview.diagnostics);
      if (decision === 'repair' && round < MAX_REPAIR_ROUNDS && budget.remaining() >= 1) {
        const repairAssembled = assembleCall({system: packed.system, user: packed.user, previous: result.text, repair: repairNote(preview.diagnostics), extraBytes: schemaBytes});
        if (!repairAssembled.fits) {
          job.preview = preview;
          job.previewId = preview.previewId;
          job.previewExpiresAt = preview.expiresAt;
          keepLast(job);
          return;
        }
        note = repairNote(preview.diagnostics);
        round++;
        continue;
      }
      job.preview = preview;
      job.previewId = preview.previewId;
      job.previewExpiresAt = preview.expiresAt;
      job.phase = 'previewing';
      job.state = preview.applicable || decision === 'accept' ? 'pending' : 'needsInfo';
      release(job);
      return;
    }
  }

  async function run(job: StoredJob, resolved: ResolvedModel, prompt: string, draft: unknown) {
    const controller = new AbortController();
    runtimes.set(job.id, controller);
    const started = scheduler.now();
    const deadlineAt = started + timeouts.deadlineMs;
    const budget = submissionBudget(deadlineAt, () => scheduler.now());
    const releaseRemoval = resolved.bindRemoval?.(() => {
      if (fail(job, 'AI_NOT_CONFIGURED', 'The API key was removed.', false)) controller.abort();
    });
    const cancelJob = scheduler.schedule(timeouts.deadlineMs, () => {
      if (fail(job, 'TIMEOUT', 'The generation timed out.', true)) controller.abort();
    });
    try { await execute(job, resolved, prompt, draft, controller.signal, budget, deadlineAt); }
    catch (error) {
      if (job.state === 'running') {
        if (error instanceof AuthoringHttpError) {
          const stale = error.status === 409 && (error.code === 'REVISION_CONFLICT' || error.code === 'CONTEXT_CHANGED');
          fail(job, stale ? 'WORKSPACE_STALE' : 'AUTHORING_INVALID', stale ? 'The workspace changed. Refresh and try again.' : 'The draft could not be checked against the workspace.', false);
        } else if (error instanceof ProviderRequestError) {
          const mapped = mapProviderFailure(error);
          fail(job, mapped.code, mapped.message, mapped.retryable);
        } else if (error instanceof AiHttpError) fail(job, error.code, error.message, false);
        else fail(job, 'PROVIDER_UNAVAILABLE', 'Generation failed.', true);
      }
    } finally {
      cancelJob();
      releaseRemoval?.();
      runtimes.delete(job.id);
      release(job);
      try { await deps.store.save(job); } catch { /* retention is best-effort; the in-memory job still answers GET */ }
      const errorCode = job.error?.code;
      const diagnosticCodes = job.preview?.diagnostics.map(item => item.code) ?? (errorCode ? [errorCode] : []);
      if (job.contextTrimmed && !diagnosticCodes.includes('CONTEXT_TRIMMED')) diagnosticCodes.push('CONTEXT_TRIMMED');
      logEvent({
        requestId: job.id, provider: resolved.providerId, model: job.model ?? resolved.model, upstreamProvider: job.upstreamProvider,
        durationMs: Math.max(0, scheduler.now() - started), inputTokens: job.inputTokens, outputTokens: job.outputTokens, cost: job.cost,
        callCount: budget.used(), contractVersion: CONTRACT_VERSION, diagnosticCodes,
        outcome: job.state === 'failed' ? errorCode ?? 'failed' : job.state,
      });
    }
  }

  return {
    ready: recover(),
    async start(input: unknown): Promise<GenerationView> {
      const request = requestOf(input);
      if (request.expectedSettingsRevision !== undefined && request.expectedSettingsRevision !== await deps.settingsRevision()) {
        throw new AiHttpError(409, 'SETTINGS_CHANGED', 'Settings changed in another session. Refresh and try again.');
      }
      if (active.has(request.workspaceId)) throw new AiHttpError(409, 'GENERATION_BUSY', 'A generation is already running for this workspace.');
      let draft: unknown;
      if (request.previousJobId) {
        const previous = await load(request.previousJobId);
        if (previous.workspaceId !== request.workspaceId) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Refine against a generation from this workspace.');
        if (previous.draft === undefined) throw new AiHttpError(409, 'INVALID_ENVELOPE', 'That generation has no draft to refine.');
        draft = previous.draft;
      }
      const now = deps.now();
      const job: StoredJob = {
        id: randomUUID(), workspaceId: request.workspaceId, baseRevision: request.expectedRevision, state: 'running', phase: 'context',
        provenance: 'ai', contractVersion: 1, createdAt: now.toISOString(), expiresAt: jobExpiry(now),
      };
      active.set(job.workspaceId, job.id);
      memory.set(job.id, job);
      let resolved: ResolvedModel;
      try { resolved = await deps.resolveProvider(); }
      catch (error) {
        memory.delete(job.id);
        release(job);
        if (error instanceof AiHttpError && error.code === 'PROVIDER_CONFIG' && (error.message === 'Add an API key.' || error.message === 'Choose a model.')) {
          throw new AiHttpError(400, 'AI_NOT_CONFIGURED', error.message);
        }
        throw error;
      }
      const promise = run(job, resolved, request.prompt, draft).catch(() => { if (job.state === 'running') fail(job, 'PROVIDER_UNAVAILABLE', 'Generation failed.', true); });
      runs.set(job.id, promise);
      void promise.finally(() => { if (runs.get(job.id) === promise) runs.delete(job.id); });
      return generationView(job, deps.now().getTime());
    },
    async get(id: string) {
      const job = await load(id);
      if (job.state !== 'running') await runs.get(job.id);
      return generationView(job, deps.now().getTime());
    },
    async idle() { await Promise.all([...runs.values()]); },
    async cancel(id: string) {
      const job = await load(id);
      if (job.state !== 'running') return generationView(job, deps.now().getTime());
      job.state = 'cancelled';
      delete job.error;
      release(job);
      runtimes.get(job.id)?.abort();
      await deps.store.save(job);
      return generationView(job, deps.now().getTime());
    },
  };
}

export type {GenerationView, StoredJob};
