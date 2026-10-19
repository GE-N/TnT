import {randomUUID} from 'node:crypto';
import {chmod, mkdir, open, readdir, readFile, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {JOURNAL_TTL_MS, type Preview} from '../authoring/types.js';

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
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES = new Set<GenerationState>(['running', 'pending', 'needsInfo', 'failed', 'cancelled']);
const PHASES = new Set<GenerationPhase>(['context', 'model', 'validating', 'repairing', 'previewing']);
const FIELDS = ['id', 'workspaceId', 'baseRevision', 'state', 'phase', 'provenance', 'contractVersion', 'createdAt', 'expiresAt', 'draft', 'previewId', 'preview', 'previewExpiresAt', 'error'] as const;

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
  };
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
  };
}
