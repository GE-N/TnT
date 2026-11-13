import {randomUUID} from 'node:crypto';
import {chmod, mkdir, open, readdir, readFile, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {JOURNAL_TTL_MS, type Preview} from '../authoring/types.js';
import {contextFields, type ContextContent} from '../knowledge/types.js';
import type {DiagramPath, DiagramStage} from './diagram.js';
import {sanitizeQuestions, type ClarifyingQuestion} from './questions.js';

export type AiIntent = 'flow' | 'knowledge' | 'mixed' | 'unclear' | 'diagram';
export type JobKind = 'flow' | 'knowledge' | 'diagram';
export type DiagramDraft = {mermaid: string; paths: DiagramPath[]};
export type KnowledgeDraft = ContextContent & {baseContextRevision: number};
export type KnowledgeConflictNote = {field: typeof contextFields[number]; written: string; lastVisit?: string};

export type GenerationPhase = 'context' | 'model' | 'validating' | 'repairing' | 'previewing';
export type GenerationState = 'running' | 'pending' | 'needsInfo' | 'failed' | 'cancelled';
export type JobError = {code: string; message: string; retryable: boolean};
export type StoredJob = {
  id: string;
  workspaceId: string;
  baseRevision: number;
  state: GenerationState;
  phase: GenerationPhase;
  provenance: 'ai';
  contractVersion: 1;
  createdAt: string;
  expiresAt: string;
  draft?: unknown;
  previewId?: string;
  preview?: Preview;
  previewExpiresAt?: string;
  error?: JobError;
  inputTokens?: number;
  outputTokens?: number;
  /** USD, only when the provider response included it. */
  cost?: number;
  /** Model id the response reported. Absent when the response omitted it. */
  model?: string;
  /** Upstream provider the response reported. Absent when the response omitted it. */
  upstreamProvider?: string;
  contextTrimmed?: boolean;
  /** Sanitized clarifying questions. Present only when the job is needsInfo and the model asked something usable. */
  questions?: ClarifyingQuestion[];
  kind?: JobKind;
  intent?: AiIntent;
  knowledgeDraft?: KnowledgeDraft;
  skill?: string;
  skillHash?: string;
  /** Original request kept after a mixed flow draft, for the later knowledge confirmation. */
  remainder?: string;
  /** Server-only copy of the request. Omitted from GenerationView. */
  requestText?: string;
  scenarioId?: string;
  contextRevision?: number;
  baseContext?: ContextContent;
  conflict?: KnowledgeConflictNote;
  diagramDraft?: DiagramDraft;
  diagramSource?: 'image' | 'mermaid';
  diagramRound?: number;
  diagramStage?: DiagramStage;
  /** Pasted Mermaid, kept for a later reading. Not shown on the generation view. */
  diagramText?: string;
  diagramMiss?: boolean;
};
export type GenerationView = {
  id: string;
  workspaceId: string;
  state: GenerationState;
  phase: GenerationPhase;
  provenance: 'ai';
  contractVersion: 1;
  expiresAt: string;
  previewId?: string;
  preview?: Preview;
  previewExpiresAt?: string;
  /** Finished jobs only. The UI re-previews this draft without another model call. */
  draft?: unknown;
  error?: JobError;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  model?: string;
  upstreamProvider?: string;
  contextTrimmed?: boolean;
  questions?: ClarifyingQuestion[];
  intent?: AiIntent;
  kind?: JobKind;
  knowledgeDraft?: KnowledgeDraft;
  skill?: string;
  skillHash?: string;
  scenarioId?: string;
  /** Present when intent is mixed, so a later slice can ask to update the details. */
  remainder?: string;
  diagramDraft?: DiagramDraft;
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES = new Set<GenerationState>(['running', 'pending', 'needsInfo', 'failed', 'cancelled']);
const PHASES = new Set<GenerationPhase>(['context', 'model', 'validating', 'repairing', 'previewing']);
const FIELDS = ['id', 'workspaceId', 'baseRevision', 'state', 'phase', 'provenance', 'contractVersion', 'createdAt', 'expiresAt', 'draft', 'previewId', 'preview', 'previewExpiresAt', 'error', 'inputTokens', 'outputTokens', 'cost', 'model', 'upstreamProvider', 'contextTrimmed', 'questions', 'kind', 'intent', 'knowledgeDraft', 'skill', 'skillHash', 'remainder', 'requestText', 'scenarioId', 'contextRevision', 'baseContext', 'conflict', 'diagramDraft', 'diagramSource', 'diagramRound', 'diagramStage', 'diagramText', 'diagramMiss'] as const;
const INTENTS = new Set<AiIntent>(['flow', 'knowledge', 'mixed', 'unclear', 'diagram']);
const SCENARIO_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SKILL_ID = /^[a-z][a-z0-9-]*@[1-9][0-9]{0,2}$/;
const SKILL_HASH = /^[a-f0-9]{64}$/;

export function jobExpiry(now: Date) {
  return new Date(now.getTime() + JOURNAL_TTL_MS).toISOString();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorOf(value: unknown): JobError | undefined {
  const item = record(value);
  if (!item || typeof item.code !== 'string' || typeof item.message !== 'string' || typeof item.retryable !== 'boolean') return;
  return {code: item.code, message: item.message, retryable: item.retryable};
}

function finite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shortText(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001F\u007F]/.test(value) ? value : undefined;
}

function promptText(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4000 && !value.includes('\0') ? value : undefined;
}

function boundedContext(value: unknown): ContextContent | undefined {
  const item = record(value);
  if (!item || Object.keys(item).length !== contextFields.length || contextFields.some(field => !(field in item))) return;
  const context = {} as ContextContent;
  for (const field of contextFields) {
    const text = item[field];
    if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > 16000) return;
    context[field] = text;
  }
  return context;
}

function knowledgeDraftOf(value: unknown): KnowledgeDraft | undefined {
  const item = record(value);
  if (!item || Object.keys(item).length !== contextFields.length + 1) return;
  if (typeof item.baseContextRevision !== 'number' || !Number.isSafeInteger(item.baseContextRevision) || item.baseContextRevision < 0) return;
  const context = boundedContext(Object.fromEntries(contextFields.map(field => [field, item[field]])));
  if (!context) return;
  return {...context, baseContextRevision: item.baseContextRevision};
}

function conflictOf(value: unknown): KnowledgeConflictNote | undefined {
  const item = record(value);
  if (!item || typeof item.field !== 'string' || !contextFields.includes(item.field as typeof contextFields[number])) return;
  if (typeof item.written !== 'string' || item.written.includes('\0') || Buffer.byteLength(item.written) > 16000) return;
  const keys = ['field', 'written', ...(item.lastVisit === undefined ? [] : ['lastVisit'])];
  if (Object.keys(item).some(key => !keys.includes(key))) return;
  const lastVisit = item.lastVisit === undefined ? undefined : shortText(item.lastVisit);
  if (item.lastVisit !== undefined && !lastVisit) return;
  return {field: item.field as typeof contextFields[number], written: item.written, ...(lastVisit ? {lastVisit} : {})};
}

/** Copies the retention record and drops anything that is not a job field, including a key. */
export function sanitizeJob(value: unknown): StoredJob | undefined {
  const item = record(value);
  if (!item || typeof item.id !== 'string' || !ID.test(item.id)) return;
  if (typeof item.workspaceId !== 'string' || !ID.test(item.workspaceId)) return;
  if (typeof item.baseRevision !== 'number' || !Number.isSafeInteger(item.baseRevision) || item.baseRevision < 0) return;
  if (typeof item.state !== 'string' || !STATES.has(item.state as GenerationState)) return;
  if (typeof item.phase !== 'string' || !PHASES.has(item.phase as GenerationPhase)) return;
  if (item.provenance !== 'ai' || item.contractVersion !== 1) return;
  if (typeof item.createdAt !== 'string' || typeof item.expiresAt !== 'string') return;
  const previewId = typeof item.previewId === 'string' ? item.previewId : undefined;
  const previewExpiresAt = typeof item.previewExpiresAt === 'string' ? item.previewExpiresAt : undefined;
  const preview = record(item.preview) as Preview | undefined;
  const inputTokens = finite(item.inputTokens);
  const outputTokens = finite(item.outputTokens);
  const cost = finite(item.cost);
  const model = shortText(item.model);
  const upstreamProvider = shortText(item.upstreamProvider);
  const questions = sanitizeQuestions(item.questions);
  const kind = item.kind === 'flow' || item.kind === 'knowledge' || item.kind === 'diagram' ? item.kind : undefined;
  const intent = typeof item.intent === 'string' && INTENTS.has(item.intent as AiIntent) ? item.intent as AiIntent : undefined;
  const knowledgeDraft = knowledgeDraftOf(item.knowledgeDraft);
  const skill = typeof item.skill === 'string' && SKILL_ID.test(item.skill) ? item.skill : undefined;
  const skillHash = typeof item.skillHash === 'string' && SKILL_HASH.test(item.skillHash) ? item.skillHash : undefined;
  const remainder = promptText(item.remainder);
  const requestText = promptText(item.requestText);
  const scenarioId = typeof item.scenarioId === 'string' && SCENARIO_ID.test(item.scenarioId) ? item.scenarioId : undefined;
  const contextRevision = typeof item.contextRevision === 'number' && Number.isSafeInteger(item.contextRevision) && item.contextRevision >= 0 ? item.contextRevision : undefined;
  const baseContext = boundedContext(item.baseContext);
  const conflict = conflictOf(item.conflict);
  const diagramDraft = diagramDraftOf(item.diagramDraft);
  const diagramSource = item.diagramSource === 'image' || item.diagramSource === 'mermaid' ? item.diagramSource : undefined;
  const diagramRound = typeof item.diagramRound === 'number' && Number.isSafeInteger(item.diagramRound) && item.diagramRound >= 0 && item.diagramRound <= 20 ? item.diagramRound : undefined;
  const diagramStage = item.diagramStage === 'intake' || item.diagramStage === 'ask-create' || item.diagramStage === 'ask-path' ? item.diagramStage : undefined;
  const diagramText = typeof item.diagramText === 'string' && item.diagramText.length > 0 && item.diagramText.length <= 16_000 && !item.diagramText.includes('\0') ? item.diagramText : undefined;
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    baseRevision: item.baseRevision,
    state: item.state as GenerationState,
    phase: item.phase as GenerationPhase,
    provenance: 'ai',
    contractVersion: 1,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    ...(item.draft !== undefined ? {draft: item.draft} : {}),
    ...(previewId ? {previewId} : {}),
    ...(preview ? {preview} : {}),
    ...(previewExpiresAt ? {previewExpiresAt} : {}),
    ...(errorOf(item.error) ? {error: errorOf(item.error)} : {}),
    ...(inputTokens !== undefined ? {inputTokens} : {}),
    ...(outputTokens !== undefined ? {outputTokens} : {}),
    ...(cost !== undefined ? {cost} : {}),
    ...(model ? {model} : {}),
    ...(upstreamProvider ? {upstreamProvider} : {}),
    ...(item.contextTrimmed === true ? {contextTrimmed: true} : {}),
    ...(questions.length ? {questions} : {}),
    ...(kind ? {kind} : {}),
    ...(intent ? {intent} : {}),
    ...(knowledgeDraft ? {knowledgeDraft} : {}),
    ...(skill ? {skill} : {}),
    ...(skillHash ? {skillHash} : {}),
    ...(remainder ? {remainder} : {}),
    ...(requestText ? {requestText} : {}),
    ...(scenarioId ? {scenarioId} : {}),
    ...(contextRevision !== undefined ? {contextRevision} : {}),
    ...(baseContext ? {baseContext} : {}),
    ...(conflict ? {conflict} : {}),
    ...(diagramDraft ? {diagramDraft} : {}),
    ...(diagramSource ? {diagramSource} : {}),
    ...(diagramRound !== undefined ? {diagramRound} : {}),
    ...(diagramStage ? {diagramStage} : {}),
    ...(diagramText ? {diagramText} : {}),
    ...(item.diagramMiss === true ? {diagramMiss: true} : {}),
  };
}

function diagramDraftOf(value: unknown): DiagramDraft | undefined {
  const item = record(value);
  if (!item || typeof item.mermaid !== 'string' || item.mermaid.length > 16_000 || !Array.isArray(item.paths) || item.paths.length < 1 || item.paths.length > 12) return;
  const paths: DiagramDraft['paths'] = [];
  for (const path of item.paths) {
    const row = record(path);
    if (!row || typeof row.id !== 'string' || typeof row.title !== 'string' || !Array.isArray(row.labels)) return;
    const labels = row.labels.filter((label): label is string => typeof label === 'string' && label.length > 0 && label.length <= 200);
    if (!labels.length || labels.length !== row.labels.length) return;
    paths.push({id: row.id, title: row.title, labels});
  }
  return {mermaid: item.mermaid, paths};
}

export function createJobStore(root: string) {
  const directory = join(root, 'ai-jobs');
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>) {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }
  async function write(job: StoredJob) {
    const clean = sanitizeJob(job);
    if (!clean) return;
    await mkdir(directory, {recursive: true, mode: 0o700});
    await chmod(directory, 0o700);
    const target = join(directory, `${clean.id}.json`);
    const temporary = join(directory, `${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(clean));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await handle?.close();
      await rm(temporary, {force: true});
    }
  }
  async function read(id: string) {
    if (!ID.test(id)) return;
    try {
      const parsed = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')) as unknown;
      const job = sanitizeJob(parsed);
      if (!job) return;
      const raw = record(parsed);
      if (raw && Object.keys(raw).some(key => !FIELDS.includes(key as typeof FIELDS[number]))) await enqueue(() => write(job));
      return job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      return;
    }
  }
  return {
    save(job: StoredJob) { return enqueue(() => write(job)); },
    read,
    async list() {
      let names: string[] = [];
      try { names = await readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; return []; }
      const jobs: StoredJob[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const job = await read(name.slice(0, -'.json'.length));
        if (job) jobs.push(job);
      }
      return jobs;
    },
    async remove(id: string) {
      if (!ID.test(id)) return;
      await rm(join(directory, `${id}.json`), {force: true});
    },
  };
}

export function generationView(job: StoredJob, now: number): GenerationView {
  const previewFresh = !!job.preview && !!job.previewExpiresAt && Date.parse(job.previewExpiresAt) > now;
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    state: job.state,
    phase: job.phase,
    provenance: 'ai',
    contractVersion: 1,
    expiresAt: job.expiresAt,
    ...(job.previewId ? {previewId: job.previewId} : {}),
    ...(previewFresh ? {preview: job.preview, previewExpiresAt: job.previewExpiresAt} : {}),
    ...(job.state !== 'running' && job.draft !== undefined ? {draft: job.draft} : {}),
    ...(job.error ? {error: {code: job.error.code, message: job.error.message, retryable: job.error.retryable}} : {}),
    ...(job.inputTokens !== undefined ? {inputTokens: job.inputTokens} : {}),
    ...(job.outputTokens !== undefined ? {outputTokens: job.outputTokens} : {}),
    ...(job.cost !== undefined ? {cost: job.cost} : {}),
    ...(job.model ? {model: job.model} : {}),
    ...(job.upstreamProvider ? {upstreamProvider: job.upstreamProvider} : {}),
    ...(job.contextTrimmed ? {contextTrimmed: true} : {}),
    ...(job.questions?.length ? {questions: job.questions.map(question => ({...question, options: [...question.options]}))} : {}),
    ...(job.intent ? {intent: job.intent} : {}),
    ...(job.kind ? {kind: job.kind} : {}),
    ...(job.state === 'pending' && job.knowledgeDraft ? {knowledgeDraft: {...job.knowledgeDraft}} : {}),
    ...(job.skill ? {skill: job.skill} : {}),
    ...(job.skillHash ? {skillHash: job.skillHash} : {}),
    ...(job.scenarioId ? {scenarioId: job.scenarioId} : {}),
    ...(job.intent === 'mixed' && job.remainder ? {remainder: job.remainder} : {}),
    ...(job.state === 'pending' && job.diagramDraft ? {diagramDraft: {mermaid: job.diagramDraft.mermaid, paths: job.diagramDraft.paths.map(path => ({...path, labels: [...path.labels]}))}} : {}),
  };
}
