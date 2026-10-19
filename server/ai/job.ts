import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseAllDocuments} from 'yaml';
import {AuthoringHttpError} from '../authoring/errors.js';
import {assertUniqueMembers, requireRevision, requireWorkspaceId} from '../authoring/schema.js';
import {CONTRACT_VERSION, REQUEST_LIMIT, type Preview} from '../authoring/types.js';
import {AiHttpError} from './errors.js';
import {formatAiLog, type AiLogEvent} from './log.js';
import {assertUserPrompt, assembleCall, packPrompt, type PromptContext} from './prompt.js';
import {MAX_REPAIR_ROUNDS, repairDecision, repairNote} from './repair.js';
import {abortError, isAbortError, ProviderRequestError, type FlowModelProvider, type Msg, type Usage} from './providers/types.js';
import {createJobStore, generationView, jobExpiry, type GenerationView, type StoredJob} from './store.js';

export const FIRST_TOKEN_MS = 20_000;
export const CALL_TIMEOUT_MS = 90_000;
export const JOB_TIMEOUT_MS = 180_000;
export const RETRY_BACKOFF_MS = [1_000, 4_000] as const;
export const MAX_PROVIDER_RETRIES = 2;
export const MAX_OUTPUT_TOKENS = 8_192;

const FLOW_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/contracts/ai-flow-v1/flow-draft.schema.json', import.meta.url)), 'utf8')) as object;
const APP_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Timeouts = {firstTokenMs: number; callMs: number; jobMs: number};
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

function unwrap(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

function parseModelDraft(text: string): {ok: true; value: unknown} | {ok: false; code: string} {
  const source = unwrap(text);
  if (Buffer.byteLength(source) > REQUEST_LIMIT) return {ok: false, code: 'OUTPUT_TOO_LARGE'};
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
  if (Object.keys(body).some(key => !['workspaceId', 'expectedRevision', 'prompt'].includes(key))) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Unknown generation field.');
  return {workspaceId: requireWorkspaceId(body.workspaceId), expectedRevision: requireRevision(body.expectedRevision), prompt: assertUserPrompt(body.prompt)};
}

function retryableProvider(error: unknown) {
  if (error instanceof ProviderRequestError) return error.retryable ? error : undefined;
  if (error instanceof TypeError) return new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: true});
  return undefined;
}

export function createJobs(deps: {
  authoring: AuthoringApi;
  readWorkspace: (id: string) => Promise<{yaml: string}>;
  store: ReturnType<typeof createJobStore>;
  now: () => Date;
  log: (line: string) => void;
  scheduler?: Scheduler;
  timeouts?: Partial<Timeouts>;
  resolveProvider: () => Promise<{provider: FlowModelProvider; model: string}>;
}) {
  const scheduler = deps.scheduler ?? realScheduler();
  const timeouts: Timeouts = {firstTokenMs: FIRST_TOKEN_MS, callMs: CALL_TIMEOUT_MS, jobMs: JOB_TIMEOUT_MS, ...deps.timeouts};
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

  async function oneCall(job: StoredJob, provider: FlowModelProvider, model: string, system: string, messages: Msg[], parent: AbortSignal) {
    if (job.state !== 'running') return 'stopped' as const;
    const call = new AbortController();
    const onParent = () => call.abort();
    if (parent.aborted) call.abort();
    else parent.addEventListener('abort', onParent, {once: true});
    let sawToken = false;
    const cancelFirst = scheduler.schedule(timeouts.firstTokenMs, () => {
      if (sawToken || !fail(job, 'PROVIDER_TIMEOUT', 'Timed out before the first token.', true)) return;
      call.abort();
    });
    const cancelCall = scheduler.schedule(timeouts.callMs, () => {
      if (!fail(job, 'PROVIDER_TIMEOUT', 'The model call timed out.', true)) return;
      call.abort();
    });
    let text = '';
    let usage: Usage | undefined;
    const started = scheduler.now();
    try {
      for await (const event of provider.generate({system, messages, schema: FLOW_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS, signal: call.signal})) {
        if (job.state !== 'running') return 'stopped' as const;
        if (!sawToken) { sawToken = true; cancelFirst(); }
        if (event.delta) text += event.delta;
        if (event.done) {
          if (event.done.text) text = event.done.text;
          if (event.done.usage) usage = event.done.usage;
        }
      }
    } catch (error) {
      if (job.state !== 'running' || isAbortError(error)) return 'stopped' as const;
      throw error;
    } finally {
      cancelFirst();
      cancelCall();
      parent.removeEventListener('abort', onParent);
    }
    if (job.state !== 'running') return 'stopped' as const;
    logEvent({provider: provider.id, model, durationMs: Math.max(0, scheduler.now() - started), inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, contractVersion: CONTRACT_VERSION, diagnosticCodes: [], outcome: 'model'});
    return {text, usage};
  }

  async function callWithRetries(job: StoredJob, provider: FlowModelProvider, model: string, system: string, messages: Msg[], parent: AbortSignal) {
    for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt++) {
      if (job.state !== 'running') return 'stopped' as const;
      try {
        return await oneCall(job, provider, model, system, messages, parent);
      } catch (error) {
        if (job.state !== 'running' || isAbortError(error)) return 'stopped' as const;
        const retryable = retryableProvider(error);
        if (!retryable || attempt === MAX_PROVIDER_RETRIES) throw retryable ?? error;
        const wait = Math.max(RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1], retryable.retryAfterMs ?? 0);
        try { await scheduler.delay(wait, parent); }
        catch (delayError) {
          if (job.state !== 'running' || isAbortError(delayError)) return 'stopped' as const;
          throw delayError;
        }
      }
    }
    return 'stopped' as const;
  }

  async function execute(job: StoredJob, provider: FlowModelProvider, model: string, prompt: string, parent: AbortSignal) {
    job.phase = 'context';
    const context = await deps.authoring.context({workspaceId: job.workspaceId, expectedRevision: job.baseRevision});
    if (job.state !== 'running') return;
    const workspace = await deps.readWorkspace(job.workspaceId);
    if (job.state !== 'running') return;
    const appId = appIdOf(workspace.yaml);
    if (!appId) { fail(job, 'APP_ID_MISMATCH', 'This workspace has no app id to author against.', false); return; }
    const contextId = record(context)?.contextId;
    if (typeof contextId !== 'string' || !contextId) { fail(job, 'INTERNAL', 'Generation failed.', true); return; }
    const packed = packPrompt({prompt, appId, context: factsFrom(context)});
    let round = 0;
    let previous = '';
    let note = '';
    while (job.state === 'running') {
      job.phase = round === 0 ? 'model' : 'repairing';
      const messages = assembleCall({system: packed.system, user: packed.user, previous: round === 0 ? undefined : previous, repair: round === 0 ? undefined : note});
      const result = await callWithRetries(job, provider, model, packed.system, messages, parent);
      if (result === 'stopped' || job.state !== 'running') return;
      previous = result.text;
      job.phase = 'validating';
      const parsed = parseModelDraft(result.text);
      if (!parsed.ok) {
        if (round >= MAX_REPAIR_ROUNDS) { fail(job, 'INVALID_MODEL_OUTPUT', 'The model did not return a flow draft.', false); return; }
        note = repairNote([{code: parsed.code, path: '', severity: 'error'}]);
        round++;
        continue;
      }
      job.phase = 'previewing';
      const preview = await deps.authoring.preview({workspaceId: job.workspaceId, expectedRevision: job.baseRevision, contextId, draft: parsed.value});
      if (job.state !== 'running') return;
      job.draft = parsed.value;
      const decision = preview.applicable ? 'accept' : repairDecision(preview.diagnostics);
      if (decision === 'repair' && round < MAX_REPAIR_ROUNDS) {
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

  async function run(job: StoredJob, resolved: {provider: FlowModelProvider; model: string}, prompt: string) {
    const controller = new AbortController();
    runtimes.set(job.id, controller);
    const started = scheduler.now();
    const cancelJob = scheduler.schedule(timeouts.jobMs, () => {
      if (fail(job, 'PROVIDER_TIMEOUT', 'The generation timed out.', true)) controller.abort();
    });
    try { await execute(job, resolved.provider, resolved.model, prompt, controller.signal); }
    catch (error) {
      if (job.state === 'running') {
        if (error instanceof AuthoringHttpError) fail(job, error.code, error.message, error.status === 409 || error.status === 410 || error.status >= 500);
        else if (error instanceof ProviderRequestError) {
          const retryable = error.code === 'PROVIDER_TIMEOUT' || error.code === 'PROVIDER_UNAVAILABLE';
          fail(job, error.code, error.message, retryable);
        } else if (error instanceof AiHttpError) fail(job, error.code, error.message, false);
        else fail(job, 'INTERNAL', 'Generation failed.', true);
      }
    } finally {
      cancelJob();
      runtimes.delete(job.id);
      release(job);
      try { await deps.store.save(job); } catch { /* retention is best-effort; the in-memory job still answers GET */ }
      const errorCode = job.error?.code;
      logEvent({
        provider: resolved.provider.id, model: resolved.model, durationMs: Math.max(0, scheduler.now() - started), contractVersion: CONTRACT_VERSION,
        diagnosticCodes: job.preview?.diagnostics.map(item => item.code) ?? (errorCode ? [errorCode] : []),
        outcome: job.state === 'failed' ? errorCode ?? 'failed' : job.state,
      });
    }
  }

  return {
    ready: recover(),
    async start(input: unknown): Promise<GenerationView> {
      const request = requestOf(input);
      if (active.has(request.workspaceId)) throw new AiHttpError(409, 'GENERATION_BUSY', 'A generation is already running for this workspace.');
      const now = deps.now();
      const job: StoredJob = {
        id: randomUUID(), workspaceId: request.workspaceId, baseRevision: request.expectedRevision, state: 'running', phase: 'context',
        provenance: 'ai', contractVersion: 1, createdAt: now.toISOString(), expiresAt: jobExpiry(now),
      };
      active.set(job.workspaceId, job.id);
      memory.set(job.id, job);
      let resolved: {provider: FlowModelProvider; model: string};
      try { resolved = await deps.resolveProvider(); }
      catch (error) {
        memory.delete(job.id);
        release(job);
        throw error;
      }
      const promise = run(job, resolved, request.prompt).catch(() => { if (job.state === 'running') fail(job, 'INTERNAL', 'Generation failed.', true); });
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
