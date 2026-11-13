import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseAllDocuments} from 'yaml';
import {AuthoringHttpError} from '../authoring/errors.js';
import {assertUniqueMembers, requireRevision, requireWorkspaceId} from '../authoring/schema.js';
import {CONTRACT_VERSION, type Preview} from '../authoring/types.js';
import {decodeDiagramImage, diagramUserMessage, isMermaidFlow, nextDiagramTurn, pathPrompt, proposeDiagram, type DiagramImage, type StoredDiagram} from './diagram.js';
import {AiHttpError, canAutoRetry, mapProviderFailure} from './errors.js';
import {formatAiLog, type AiLogEvent} from './log.js';
import {assertUserPrompt, assembleCall, packPrompt, schemaAttachment, type PromptContext} from './prompt.js';
import {assertAnswers, modelDraftSchema, sanitizeQuestions, splitModelDraft, type ClarifyingAnswer, type ClarifyingQuestion} from './questions.js';
import {MAX_REPAIR_ROUNDS, repairDecision, repairNote} from './repair.js';
import {abortError, isAbortError, MAX_UPSTREAM_POSTS, ProviderRequestError, RESPONSE_BYTE_LIMIT, type FlowModelProvider, type Msg, type UpstreamBudget, type Usage} from './providers/types.js';
import {planAnswer, knowledgeUserMessage, proposeKnowledge} from './knowledge-update.js';
import {finishDraftQuestion, misroute, namedOtherScenario, otherScenarioQuestion, routerUserMessage, settleRouter, unclearQuestion, type RouterIntent, type ScenarioCatalog} from './router.js';
import {loadBundledSkills, type Skill} from './skills.js';
import {createJobStore, generationView, jobExpiry, type GenerationView, type KnowledgeDraft, type StoredJob} from './store.js';

export const SUBMISSION_DEADLINE_MS = 120_000;
export const MAX_PROVIDER_RETRIES = 1;
export const MAX_OUTPUT_TOKENS = 8_192;
export {MAX_UPSTREAM_POSTS, RESPONSE_BYTE_LIMIT};

const FLOW_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/contracts/ai-flow-v1/flow-draft.schema.json', import.meta.url)), 'utf8')) as object;
/** Contract schema plus clarifying questions. Sent to the model only; stripped before preview. */
const MODEL_SCHEMA = modelDraftSchema(FLOW_SCHEMA);
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
  if (Object.keys(body).some(key => !['workspaceId', 'expectedRevision', 'expectedSettingsRevision', 'prompt', 'previousJobId', 'answers', 'image', 'authorPath'].includes(key))) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Unknown generation field.');
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
  const answers = body.answers === undefined ? undefined : assertAnswers(body.answers);
  if (answers?.length && !previousJobId) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Answer a question by refining the current generation.');
  const image = body.image === undefined ? undefined : decodeDiagramImage(body.image);
  if (image && previousJobId) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Attach the image to the first message.');
  let authorPath: string | undefined;
  if (body.authorPath !== undefined) {
    if (typeof body.authorPath !== 'string' || !/^path-[1-9][0-9]{0,2}$/.test(body.authorPath)) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Name one saved path.');
    authorPath = body.authorPath;
  }
  const prompt = image && (body.prompt === undefined || body.prompt === '') ? '' : assertDiagramPrompt(body.prompt);
  return {
    workspaceId: requireWorkspaceId(body.workspaceId),
    expectedRevision: requireRevision(body.expectedRevision),
    prompt,
    expectedSettingsRevision,
    previousJobId,
    ...(answers?.length ? {answers} : {}),
    ...(image ? {image} : {}),
    ...(authorPath ? {authorPath} : {}),
  };
}

function assertDiagramPrompt(value: unknown) {
  if (typeof value === 'string' && isLongMermaid(value)) return value.trim();
  return assertUserPrompt(value);
}

function isLongMermaid(value: string) {
  const text = value.trim();
  return text.length <= 16_000 && !text.includes('\0') && /^(?:```(?:mermaid)?\s*)?(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\b/i.test(text);
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
  readCatalog?: (workspaceId: string) => Promise<ScenarioCatalog>;
  readDiagram?: (workspaceId: string, scenarioId: string) => Promise<StoredDiagram | null>;
  skills?: {router: Skill; knowledgeUpdate: Skill; diagram: Skill};
}) {
  const skills = deps.skills ?? loadBundledSkills();
  const scheduler = deps.scheduler ?? realScheduler();
  const timeouts: Timeouts = {deadlineMs: SUBMISSION_DEADLINE_MS, ...deps.timeouts};
  const memory = new Map<string, StoredJob>();
  const images = new Map<string, DiagramImage>();
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

  async function oneCall(job: StoredJob, resolved: ResolvedModel, system: string, messages: Msg[], parent: AbortSignal, budget: UpstreamBudget, schema: object = MODEL_SCHEMA) {
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
      for await (const event of resolved.provider.generate({system, messages, schema, maxOutputTokens: MAX_OUTPUT_TOKENS, signal: call.signal, budget})) {
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

  async function callWithRetries(job: StoredJob, resolved: ResolvedModel, system: string, messages: Msg[], parent: AbortSignal, budget: ReturnType<typeof submissionBudget>, deadlineAt: number, schema: object = MODEL_SCHEMA) {
    let retried = false;
    for (;;) {
      if (job.state !== 'running') return 'stopped' as const;
      try {
        return await oneCall(job, resolved, system, messages, parent, budget, schema);
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

  function applyOutcome(job: StoredJob, preview: Preview, questions?: ClarifyingQuestion[]) {
    job.preview = preview;
    job.previewId = preview.previewId;
    job.previewExpiresAt = preview.expiresAt;
    job.phase = 'previewing';
    const decision = repairDecision(preview.diagnostics);
    delete job.questions;
    if (decision === 'needs-info') {
      job.state = 'needsInfo';
      const clean = sanitizeQuestions(questions);
      if (clean.length) job.questions = clean;
    } else if (preview.applicable || decision === 'accept') job.state = 'pending';
    else {
      job.state = 'failed';
      job.error = {code: 'AUTHORING_INVALID', message: 'The draft still has validation issues.', retryable: false};
    }
    release(job);
  }

  function keepLast(job: StoredJob, questions?: ClarifyingQuestion[]) {
    if (job.preview) {
      applyOutcome(job, job.preview, questions);
      return;
    }
    fail(job, 'INVALID_AI_OUTPUT', 'The model did not return a flow draft.', false);
  }

  async function execute(job: StoredJob, resolved: ResolvedModel, prompt: string, draft: unknown, answers: ClarifyingAnswer[] | undefined, parent: AbortSignal, budget: ReturnType<typeof submissionBudget>, deadlineAt: number) {
    job.phase = 'context';
    const context = await deps.authoring.context({workspaceId: job.workspaceId, expectedRevision: job.baseRevision});
    if (job.state !== 'running') return;
    const workspace = await deps.readWorkspace(job.workspaceId);
    if (job.state !== 'running') return;
    const appId = appIdOf(workspace.yaml);
    if (!appId) { fail(job, 'APP_ID_MISMATCH', 'This workspace has no app id to author against.', false); return; }
    const contextId = record(context)?.contextId;
    if (typeof contextId !== 'string' || !contextId) { fail(job, 'AUTHORING_INVALID', 'The workspace could not be prepared for generation.', false); return; }
    const carriesSchema = resolved.provider.sendsJsonSchema === true;
    // response_format carries the schema, or the instructions do. Reserve whichever copy is not already in the prompt text.
    const schemaReserve = carriesSchema ? Buffer.byteLength(schemaAttachment(MODEL_SCHEMA)) : 0;
    const packed = packPrompt({
      prompt, appId, context: factsFrom(context), ...(draft !== undefined ? {draft} : {}),
      ...(answers?.length ? {answers} : {}),
      ...(carriesSchema ? {} : {schema: MODEL_SCHEMA}),
      extraBytes: schemaReserve,
    });
    if (packed.contextTrimmed) job.contextTrimmed = true;
    let round = 0;
    let previous = '';
    let note = '';
    let pendingQuestions: ClarifyingQuestion[] | undefined;
    while (job.state === 'running') {
      job.phase = round === 0 ? 'model' : 'repairing';
      const assembled = assembleCall({
        system: packed.system,
        user: packed.user,
        previous: round === 0 ? undefined : previous,
        repair: round === 0 ? undefined : note,
        extraBytes: schemaReserve,
      });
      if (!assembled.fits || budget.remaining() < 1) {
        if (round === 0 && !assembled.fits) { fail(job, 'PROMPT_TOO_LONG', 'The prompt does not fit the model budget.', false); return; }
        if (round === 0) { fail(job, 'TIMEOUT', 'The generation timed out.', true); return; }
        keepLast(job, pendingQuestions);
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
      const split = splitModelDraft(parsed.value);
      pendingQuestions = split.questions;
      const preview = await deps.authoring.preview({workspaceId: job.workspaceId, expectedRevision: job.baseRevision, contextId, draft: split.draft});
      if (job.state !== 'running') return;
      job.draft = split.draft;
      const decision = repairDecision(preview.diagnostics);
      if (decision === 'repair' && round < MAX_REPAIR_ROUNDS && budget.remaining() >= 1) {
        const repairAssembled = assembleCall({system: packed.system, user: packed.user, previous: result.text, repair: repairNote(preview.diagnostics), extraBytes: schemaReserve});
        if (!repairAssembled.fits) {
          applyOutcome(job, preview, pendingQuestions);
          return;
        }
        note = repairNote(preview.diagnostics);
        round++;
        continue;
      }
      applyOutcome(job, preview, pendingQuestions);
      return;
    }
  }

  function ask(job: StoredJob, intent: RouterIntent, question: ClarifyingQuestion) {
    if (job.state !== 'running') return;
    job.state = 'needsInfo';
    job.phase = 'context';
    job.intent = intent;
    job.questions = [{...question, options: [...question.options]}];
    delete job.draft;
    delete job.knowledgeDraft;
    delete job.diagramDraft;
    delete job.preview;
    delete job.previewId;
    delete job.previewExpiresAt;
    delete job.error;
    release(job);
  }

  function otherPending(workspaceId: string, kind: 'flow' | 'knowledge' | 'diagram', except: string) {
    for (const candidate of memory.values()) {
      if (candidate.id === except || candidate.workspaceId !== workspaceId) continue;
      if (candidate.state !== 'pending' && candidate.state !== 'needsInfo') continue;
      const candidateKind = candidate.kind ?? (candidate.draft !== undefined ? 'flow' as const : undefined);
      if (candidateKind && candidateKind !== kind) return candidate;
    }
  }

  function acceptKnowledge(job: StoredJob, draft: KnowledgeDraft, scenarioId?: string) {
    if (job.state !== 'running') return;
    delete job.questions;
    delete job.conflict;
    delete job.error;
    delete job.draft;
    job.kind = 'knowledge';
    job.intent = 'knowledge';
    job.knowledgeDraft = draft;
    job.state = 'pending';
    job.phase = 'validating';
    job.skill = skills.knowledgeUpdate.id;
    job.skillHash = skills.knowledgeUpdate.hash;
    if (scenarioId) job.scenarioId = scenarioId;
    release(job);
  }

  async function routeWithProvider(job: StoredJob, resolved: ResolvedModel, prompt: string, catalog: ScenarioCatalog, pendingKind: 'flow' | 'knowledge' | undefined, parent: AbortSignal) {
    job.phase = 'context';
    job.skill = skills.router.id;
    job.skillHash = skills.router.hash;
    const messages: Msg[] = [{role: 'user', content: routerUserMessage({
      request: prompt,
      pendingKind,
      scenarioId: catalog.current?.id,
      scenarioTitle: catalog.current?.title,
      visitTitles: catalog.current?.visitTitles ?? [],
      otherScenarios: catalog.scenarios.filter(item => item.id !== catalog.current?.id),
    })}];
    let used = false;
    const budget = {remaining: () => used ? 0 : 1, tryConsume() { if (used) return false; used = true; return true; }};
    const call = new AbortController();
    const onParent = () => call.abort();
    if (parent.aborted) call.abort();
    else parent.addEventListener('abort', onParent, {once: true});
    let text = '';
    try {
      for await (const event of resolved.provider.generate({system: skills.router.prompt, messages, schema: skills.router.schema, maxOutputTokens: 1_024, signal: call.signal, budget})) {
        if (job.state !== 'running') return 'stopped' as const;
        if (event.delta) text += event.delta;
        if (event.done?.text) text = event.done.text;
      }
    } catch (error) {
      if (job.state !== 'running' || isAbortError(error)) return 'stopped' as const;
      return {intent: 'unclear' as const};
    } finally {
      parent.removeEventListener('abort', onParent);
    }
    if (job.state !== 'running') return 'stopped' as const;
    return settleRouter({ok: true, text}, skills.router);
  }

  async function executeKnowledge(job: StoredJob, resolved: ResolvedModel, prompt: string, catalog: ScenarioCatalog, parent: AbortSignal, budget: ReturnType<typeof submissionBudget>, deadlineAt: number, base?: {context: NonNullable<ScenarioCatalog['current']>['context']; contextRevision: number}) {
    const current = catalog.current;
    if (!current) {
      job.requestText = prompt;
      ask(job, 'unclear', unclearQuestion());
      return;
    }
    const context = {...(base?.context ?? current.context)};
    const contextRevision = base?.contextRevision ?? current.contextRevision;
    job.kind = 'knowledge';
    job.intent = 'knowledge';
    job.phase = 'context';
    job.skill = skills.knowledgeUpdate.id;
    job.skillHash = skills.knowledgeUpdate.hash;
    job.scenarioId = current.id;
    job.requestText = prompt;
    job.baseContext = context;
    job.contextRevision = contextRevision;
    await deps.authoring.context({workspaceId: job.workspaceId, expectedRevision: job.baseRevision});
    if (job.state !== 'running') return;
    job.phase = 'model';
    const user = knowledgeUserMessage({request: prompt, current: {...current, context, contextRevision}});
    const result = await callWithRetries(job, resolved, skills.knowledgeUpdate.prompt, [{role: 'user', content: user}], parent, budget, deadlineAt, skills.knowledgeUpdate.schema);
    if (result === 'stopped' || job.state !== 'running') return;
    job.phase = 'validating';
    const proposed = proposeKnowledge({prompt, modelText: result.text, skill: skills.knowledgeUpdate, current: {...current, context, contextRevision}});
    if (!proposed.ok) {
      fail(job, 'INVALID_AI_OUTPUT', 'The model did not return a knowledge draft.', false);
      return;
    }
    if ('ask' in proposed.proposal) {
      if (proposed.proposal.conflict) job.conflict = proposed.proposal.conflict;
      else delete job.conflict;
      job.baseContext = proposed.proposal.baseContext;
      job.contextRevision = proposed.proposal.contextRevision;
      job.kind = 'knowledge';
      ask(job, 'knowledge', proposed.proposal.ask);
      job.kind = 'knowledge';
      job.scenarioId = current.id;
      return;
    }
    acceptKnowledge(job, proposed.proposal.draft, current.id);
  }

  function rememberDiagram(job: StoredJob, previous: StoredJob | undefined, source: 'image' | 'mermaid') {
    job.kind = 'diagram';
    job.intent = 'diagram';
    job.diagramSource = source;
    job.diagramStage = 'intake';
    job.skill = skills.diagram.id;
    job.skillHash = skills.diagram.hash;
    job.diagramRound = (previous?.diagramRound ?? 0) + 1;
    if (previous?.diagramText) job.diagramText = previous.diagramText;
    if (previous?.requestText) job.requestText = previous.requestText;
    if (!images.has(job.id) && previous && images.has(previous.id)) images.set(job.id, images.get(previous.id)!);
  }

  async function executeDiagram(job: StoredJob, resolved: ResolvedModel, source: 'image' | 'mermaid', caption: string, mermaid: string | undefined, answers: ClarifyingAnswer[] | undefined, note: string | undefined, parent: AbortSignal, budget: ReturnType<typeof submissionBudget>, deadlineAt: number) {
    if (source === 'image' && resolved.provider.readsImages === false) {
      fail(job, 'MODEL_CANT_READ_IMAGES', "This model can't read images.", false);
      return;
    }
    const image = source === 'image' ? images.get(job.id) : undefined;
    if (source === 'image' && !image) {
      fail(job, 'DIAGRAM_IMAGE_MISSING', 'The diagram image is no longer available. Attach it again.', false);
      return;
    }
    job.phase = 'model';
    const user = diagramUserMessage({caption, mermaid, answers, note});
    const message: Msg = {role: 'user', content: user, ...(image ? {image} : {})};
    const result = await callWithRetries(job, resolved, skills.diagram.prompt, [message], parent, budget, deadlineAt, skills.diagram.schema);
    if (result === 'stopped' || job.state !== 'running') return;
    job.phase = 'validating';
    const proposed = proposeDiagram(result.text, skills.diagram);
    if (!proposed.ok) {
      fail(job, 'INVALID_AI_OUTPUT', 'The model did not return a diagram.', false);
      return;
    }
    if (proposed.questions.length) {
      job.questions = proposed.questions;
      job.state = 'needsInfo';
      job.phase = 'context';
      delete job.diagramDraft;
      delete job.error;
      release(job);
      return;
    }
    if (!proposed.graph) {
      fail(job, 'INVALID_AI_OUTPUT', 'The model did not return a diagram.', false);
      return;
    }
    delete job.questions;
    delete job.error;
    delete job.draft;
    job.diagramDraft = proposed.graph;
    job.state = 'pending';
    job.phase = 'validating';
    release(job);
  }

  async function handleDiagram(job: StoredJob, resolved: ResolvedModel, request: {prompt: string; answers?: ClarifyingAnswer[]; image?: DiagramImage; authorPath?: string}, previous: StoredJob | undefined, catalog: ScenarioCatalog | undefined, parent: AbortSignal, budget: ReturnType<typeof submissionBudget>, deadlineAt: number, beginPipeline: () => boolean) {
    const scenarioId = catalog?.current?.id;
    let saved: StoredDiagram | null = null;
    if (scenarioId && deps.readDiagram) {
      try { saved = await deps.readDiagram(job.workspaceId, scenarioId); }
      catch { saved = null; }
    }
    if (job.state !== 'running') return true;
    const turn = nextDiagramTurn({
      prompt: request.prompt,
      hasImage: !!request.image || !!images.get(job.id) || !!(previous && images.has(previous.id)),
      authorPath: request.authorPath,
      answers: request.answers,
      scenarioId,
      saved,
      ...(previous && (previous.kind === 'diagram' || previous.intent === 'diagram' || previous.diagramDraft || previous.diagramStage) ? {previous: {
        stage: previous.diagramStage,
        round: previous.diagramRound ?? 0,
        source: previous.diagramSource,
        caption: previous.requestText ?? '',
        questions: previous.questions,
        pending: previous.state === 'pending' && !!previous.diagramDraft,
        miss: previous.diagramMiss,
      }} : {}),
    });
    if (turn.kind === 'router') return false;
    if (scenarioId) job.scenarioId = scenarioId;
    if (turn.kind === 'cancel') {
      job.state = 'cancelled';
      delete job.error;
      release(job);
      return true;
    }
    if (turn.kind === 'fail') {
      fail(job, turn.code, turn.message, false);
      return true;
    }
    if (turn.kind === 'ask') {
      ask(job, 'diagram', turn.question);
      job.kind = 'diagram';
      job.diagramStage = turn.stage;
      if (turn.miss) job.diagramMiss = true;
      if (previous?.diagramText) job.diagramText = previous.diagramText;
      else if (isMermaidFlow(request.prompt)) job.diagramText = request.prompt.trim();
      if (previous?.diagramSource) job.diagramSource = previous.diagramSource;
      if (previous?.requestText) job.requestText = previous.requestText;
      else if (request.prompt) job.requestText = request.prompt.slice(0, 4000);
      if (previous && images.has(previous.id)) images.set(job.id, images.get(previous.id)!);
      job.scenarioId = scenarioId;
      return true;
    }
    if (turn.kind === 'knowledge') {
      if (!catalog?.current) {
        fail(job, 'DIAGRAM_NO_SCENARIO', 'Open a scenario before reading a diagram.', false);
        return true;
      }
      if (!beginPipeline()) return true;
      await executeKnowledge(job, resolved, turn.prompt, catalog, parent, budget, deadlineAt);
      return true;
    }
    if (turn.kind === 'flow') {
      const blocker = otherPending(job.workspaceId, 'flow', job.id);
      if (blocker && blocker.kind !== 'diagram') {
        ask(job, 'unclear', finishDraftQuestion());
        return true;
      }
      job.intent = 'flow';
      job.kind = 'flow';
      job.skill = skills.router.id;
      job.skillHash = skills.router.hash;
      delete job.diagramDraft;
      if (!beginPipeline()) return true;
      await execute(job, resolved, pathPrompt(turn.path), undefined, undefined, parent, budget, deadlineAt);
      return true;
    }
    if (otherPending(job.workspaceId, 'diagram', job.id)) {
      ask(job, 'unclear', finishDraftQuestion());
      return true;
    }
    const source = turn.source;
    const caption = request.prompt || previous?.requestText || '';
    const mermaid = source === 'mermaid' && (isLongMermaid(request.prompt) || isMermaidFlow(request.prompt)) ? request.prompt : previous?.diagramText;
    rememberDiagram(job, previous, source);
    if (source === 'mermaid' && request.prompt && (isLongMermaid(request.prompt) || isMermaidFlow(request.prompt))) job.diagramText = request.prompt.trim();
    else if (previous?.diagramText) job.diagramText = previous.diagramText;
    if (caption) job.requestText = caption.slice(0, 4000);
    if (!beginPipeline()) return true;
    await executeDiagram(job, resolved, source, caption, mermaid, turn.answers, turn.note, parent, budget, deadlineAt);
    return true;
  }

  async function run(job: StoredJob, resolved: ResolvedModel, request: {prompt: string; answers?: ClarifyingAnswer[]; image?: DiagramImage; authorPath?: string}, draft: unknown, previous?: StoredJob) {
    const controller = new AbortController();
    runtimes.set(job.id, controller);
    const started = scheduler.now();
    const deadlineAt = started + timeouts.deadlineMs;
    const budget = submissionBudget(deadlineAt, () => scheduler.now());
    let pipeline = !deps.readCatalog;
    const releaseRemoval = resolved.bindRemoval?.(() => {
      if (fail(job, 'AI_NOT_CONFIGURED', 'The API key was removed.', false)) controller.abort();
    });
    const cancelJob = scheduler.schedule(timeouts.deadlineMs, () => {
      if (!pipeline) { controller.abort(); return; }
      if (fail(job, 'TIMEOUT', 'The generation timed out.', true)) controller.abort();
    });
    const beginPipeline = () => {
      pipeline = true;
      if (controller.signal.aborted && job.state === 'running') {
        fail(job, 'TIMEOUT', 'The generation timed out.', true);
        return false;
      }
      return job.state === 'running';
    };
    try {
      let catalog: ScenarioCatalog | undefined;
      if (deps.readCatalog) {
        try { catalog = await deps.readCatalog(job.workspaceId); }
        catch {
          if (job.state === 'running') fail(job, 'KNOWLEDGE_UNAVAILABLE', 'The scenario details could not be read.', true);
          return;
        }
      }
      if (job.state !== 'running') return;
      if (request.image) images.set(job.id, request.image);
      else if (previous && images.has(previous.id)) images.set(job.id, images.get(previous.id)!);
      if (await handleDiagram(job, resolved, request, previous, catalog, controller.signal, budget, deadlineAt, beginPipeline)) return;
      const answering = !!previous && !!request.answers?.length && previous.draft === undefined && (!!previous.questions?.length || !!previous.conflict);
      if (answering && previous) {
        const answer = request.answers?.[0]?.answer ?? '';
        const requestText = previous.requestText || request.prompt;
        const base = previous.baseContext ?? catalog?.current?.context;
        const contextRevision = previous.contextRevision ?? catalog?.current?.contextRevision ?? 0;
        const plan = base ? planAnswer({answer, requestText, base, contextRevision, conflict: previous.conflict}) : {kind: 'keep' as const};
        if (plan.kind === 'dismiss') {
          for (const candidate of memory.values()) {
            if (candidate.id === job.id || candidate.workspaceId !== job.workspaceId) continue;
            if (candidate.state !== 'pending' && candidate.state !== 'needsInfo') continue;
            if (!candidate.kind && candidate.draft === undefined && !candidate.knowledgeDraft) continue;
            candidate.state = 'cancelled';
            delete candidate.knowledgeDraft;
            delete candidate.error;
            release(candidate);
          }
          job.state = 'cancelled';
          delete job.error;
          release(job);
          return;
        }
        if (plan.kind === 'draft') {
          acceptKnowledge(job, plan.draft, previous.scenarioId ?? catalog?.current?.id);
          return;
        }
        if (plan.kind === 'flow') {
          if (!beginPipeline()) return;
          job.intent = 'flow';
          job.kind = 'flow';
          job.skill = skills.router.id;
          job.skillHash = skills.router.hash;
          if (previous.scenarioId ?? catalog?.current?.id) job.scenarioId = previous.scenarioId ?? catalog?.current?.id;
          await execute(job, resolved, plan.prompt, undefined, undefined, controller.signal, budget, deadlineAt);
          return;
        }
        if (plan.kind === 'knowledge' && catalog) {
          if (!beginPipeline()) return;
          await executeKnowledge(job, resolved, plan.prompt, catalog, controller.signal, budget, deadlineAt, base ? {context: base, contextRevision} : undefined);
          return;
        }
        ask(job, previous.intent === 'knowledge' ? 'knowledge' : 'unclear', previous.questions?.[0] ?? unclearQuestion());
        return;
      }
      if (previous?.knowledgeDraft && catalog?.current && !misroute(request.prompt)) {
        if (!beginPipeline()) return;
        const {baseContextRevision, ...context} = previous.knowledgeDraft;
        await executeKnowledge(job, resolved, request.prompt, catalog, controller.signal, budget, deadlineAt, {context, contextRevision: baseContextRevision});
        return;
      }
      if (deps.readCatalog && catalog && (!previous || !!misroute(request.prompt))) {
        job.requestText = request.prompt;
        if (catalog.current) {
          job.scenarioId = catalog.current.id;
          job.baseContext = {...catalog.current.context};
          job.contextRevision = catalog.current.contextRevision;
        }
        const other = namedOtherScenario(request.prompt, catalog);
        if (other && catalog.current && !misroute(request.prompt)) {
          job.skill = skills.router.id;
          job.skillHash = skills.router.hash;
          ask(job, 'unclear', otherScenarioQuestion(catalog.current.title, other.title));
          return;
        }
        const pendingKind = previous?.kind === 'flow' || previous?.kind === 'knowledge' ? previous.kind : previous?.knowledgeDraft ? 'knowledge' as const : previous?.draft !== undefined ? 'flow' as const : undefined;
        const routed = await routeWithProvider(job, resolved, request.prompt, catalog, pendingKind, controller.signal);
        if (job.state !== 'running') return;
        if (routed === 'stopped' || routed.intent === 'unclear') {
          ask(job, 'unclear', unclearQuestion());
          return;
        }
        const nextKind = routed.intent === 'knowledge' ? 'knowledge' as const : 'flow' as const;
        if (!previous && otherPending(job.workspaceId, nextKind, job.id)) {
          ask(job, 'unclear', finishDraftQuestion());
          return;
        }
        if (routed.intent === 'knowledge') {
          if (!beginPipeline()) return;
          await executeKnowledge(job, resolved, request.prompt, catalog, controller.signal, budget, deadlineAt);
          return;
        }
        job.intent = routed.intent;
        job.kind = 'flow';
        job.skill = skills.router.id;
        job.skillHash = skills.router.hash;
        if (routed.intent === 'mixed') job.remainder = request.prompt;
        if (!beginPipeline()) return;
        await execute(job, resolved, request.prompt, undefined, request.answers, controller.signal, budget, deadlineAt);
        const finished = job.state as StoredJob['state'];
        if (job.intent === 'mixed' && finished !== 'pending' && finished !== 'needsInfo') delete job.remainder;
        return;
      }
      if (!beginPipeline()) return;
      await execute(job, resolved, request.prompt, draft, request.answers, controller.signal, budget, deadlineAt);
    } catch (error) {
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
      let previous: StoredJob | undefined;
      if (request.previousJobId) {
        previous = await load(request.previousJobId);
        if (previous.workspaceId !== request.workspaceId) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Refine against a generation from this workspace.');
        const answering = !!request.answers?.length && previous.draft === undefined && (!!previous.questions?.length || !!previous.conflict);
        const reroute = !!deps.readCatalog && !!misroute(request.prompt);
        const knowledgeTurn = !!previous.knowledgeDraft && !!deps.readCatalog;
        const diagramTurn = previous.kind === 'diagram' || previous.intent === 'diagram' || previous.diagramDraft !== undefined || previous.diagramStage !== undefined;
        if (!answering && !reroute && !knowledgeTurn && !diagramTurn) {
          if (previous.draft === undefined) throw new AiHttpError(409, 'INVALID_ENVELOPE', 'That generation has no draft to refine.');
          draft = previous.draft;
        }
      }
      const now = deps.now();
      const job: StoredJob = {
        id: randomUUID(), workspaceId: request.workspaceId, baseRevision: request.expectedRevision, state: 'running', phase: 'context',
        provenance: 'ai', contractVersion: 1, createdAt: now.toISOString(), expiresAt: jobExpiry(now),
      };
      active.set(job.workspaceId, job.id);
      memory.set(job.id, job);
      if (request.image) images.set(job.id, request.image);
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
      const promise = run(job, resolved, request, draft, previous).catch(() => { if (job.state === 'running') fail(job, 'PROVIDER_UNAVAILABLE', 'Generation failed.', true); });
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
