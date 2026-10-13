import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workspace } from './scenarios.js';

export type WorkspaceMetadata = { createdAt: string; updatedAt: string; openedAt: string; revision: number };
export type WorkspaceSummary = WorkspaceMetadata & { id: string; name: string; screens: number; scenarios: number; hasDraft?: boolean };
export type WorkspaceLibrary = { items: WorkspaceSummary[]; unreadable: number };
export type DraftContent = { yaml?: unknown; flows?: unknown; canvas?: unknown; scenarios?: unknown; automation?: unknown; mock?: unknown };
export type WorkspaceDraft = { format: 1; workspaceId: string; baseRevision: number; draftRevision: number; savedAt: string; name: string; content: DraftContent; fields: Record<string, string> };
/** View records keep a schema version plus any keys this build does not understand. */
export type WorkspaceView = Record<string, unknown> & {
  format?: number;
  scenarioId?: string;
  scenarioName?: string;
  pathId?: string;
  canvas?: Record<string, unknown> & { zoom?: number; scrollLeft?: number; scrollTop?: number; selectedScreenId?: string };
  panels?: Record<string, unknown> & { advanced?: boolean };
  dismissedDraftRevision?: number;
  /** Highest draft revision issued for this workspace. A cleared draft must not be reissued at or below it. */
  allocatedDraftRevision?: number;
};
export type WorkspaceSession = { lastActiveId: string | null; updatedAt: string; unavailable?: boolean };
export type WorkspaceStoreFaults = {
  /** Awaited before a temp file is created. Tests hold this to queue a write. */
  beforeWrite?: () => Promise<void>;
  /** Return an error to reject the write before any temp file exists. */
  rejectWrite?: () => unknown;
  /** Return an error after the temp file is fsynced and before rename. */
  failBeforeRename?: () => unknown;
  /** Return an error for session or draft cleanup after workspace.json has been renamed. */
  failAfterCommit?: () => unknown;
};
export class WorkspaceConflict extends Error {
  constructor() {
    super('Another editor saved a newer revision. Current edits are retained. Save a copy to recover them, and keep the saved version intact.');
  }
}
export class DraftConflict extends Error {
  constructor() {
    super('This workspace was changed in another tab.');
  }
}
export class WorkspacePayloadTooLarge extends Error {
  constructor(message: string) {
    super(message);
  }
}
const recordLimit = 16_000_000;
const viewLimit = 64_000;
const queues = new Map<string, Promise<unknown>>();
const contentKeys = new Set(['yaml', 'flows', 'canvas', 'scenarios', 'automation', 'mock']);
const fieldKeyPattern = /^(yaml-command|canvas-authoring|checkpoint-draft|setup-parameters|yaml-form:\d+(?::[A-Za-z0-9._:%!~*'()-]{1,80})?|(?:screen-title|scenario-rename|action-parameters|scenario-inputs|scenario-setup|scenario-requirements):[A-Za-z0-9._:%!~*'()-]{1,100})$/;
const validId = (id: string) => {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid workspace identifier.');
  return id;
};
const toError = (value: unknown) => (value instanceof Error ? value : new Error(String(value)));

/** Test helper for the write hooks consumed by createWorkspaceStore. */
export function createWriteFaults() {
  let mode: 'ok' | 'queue' | 'reject' | 'fail-before-rename' | 'fail-after-commit' = 'ok';
  let waiting = 0;
  let releaseQueue: () => void = () => {};
  let queued = Promise.resolve();
  const listeners = new Set<() => void>();
  const faults: WorkspaceStoreFaults = {
    beforeWrite: async () => {
      if (mode !== 'queue') return;
      waiting++;
      for (const listener of listeners) listener();
      try {
        await queued;
      } finally {
        waiting--;
      }
    },
    rejectWrite: () => (mode === 'reject' ? new Error('Injected write rejection') : undefined),
    failBeforeRename: () => (mode === 'fail-before-rename' ? new Error('Injected failure before rename') : undefined),
    failAfterCommit: () => (mode === 'fail-after-commit' ? new Error('Injected failure after commit') : undefined)
  };
  return {
    faults,
    queue() {
      mode = 'queue';
      queued = new Promise(resolve => {
        releaseQueue = resolve;
      });
    },
    release() {
      const finish = releaseQueue;
      mode = 'ok';
      finish();
    },
    reject() {
      mode = 'reject';
    },
    failBeforeRename() {
      mode = 'fail-before-rename';
    },
    failAfterCommit() {
      mode = 'fail-after-commit';
    },
    pass() {
      mode = 'ok';
    },
    untilQueued(count = 1) {
      if (waiting >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error('Timed out waiting for a queued write.'));
        }, 2000);
        const listener = () => {
          if (waiting >= count) {
            clearTimeout(timer);
            listeners.delete(listener);
            resolve();
          }
        };
        listeners.add(listener);
      });
    }
  };
}

/** The existing local workspace records, with serialized atomic metadata/content writes. */
export function createWorkspaceStore(root: string, readContent: (value: Workspace) => Workspace, options?: { faults?: WorkspaceStoreFaults; now?: () => Date }) {
  const queueKey = resolve(root);
  const faults = options?.faults;
  const now = () => (options?.now ?? (() => new Date()))().toISOString();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = (queues.get(queueKey) ?? Promise.resolve()).then(operation);
    const settled = next.catch(() => {});
    queues.set(queueKey, settled);
    void settled.then(() => {
      if (queues.get(queueKey) === settled) queues.delete(queueKey);
    });
    return next;
  }
  async function base() {
    const path = resolve(root, 'workspaces');
    await mkdir(path, { recursive: true });
    if (!(await realpath(path)).startsWith((await realpath(root)) + sep)) throw new Error('Workspace path escapes its root.');
    return path;
  }
  async function workspaceDirectory(id: string, create = false) {
    const parent = await base();
    const directory = join(parent, validId(id));
    if (create) await mkdir(directory, { recursive: true });
    if (!(await realpath(directory)).startsWith((await realpath(parent)) + sep)) throw new Error('Workspace path escapes its root.');
    return directory;
  }
  async function contained(directory: string, name: string, create: boolean) {
    const path = join(directory, name);
    try {
      if (!(await realpath(path)).startsWith((await realpath(directory)) + sep)) throw new Error('Record path escapes its workspace.');
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return path;
  }
  async function file(id: string, create = false) {
    return contained(await workspaceDirectory(id, create), 'workspace.json', create);
  }
  async function writeJson(path: string, value: unknown, limit: number, tooLarge: string) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > limit) throw new WorkspacePayloadTooLarge(tooLarge);
    const rejected = faults?.rejectWrite?.();
    if (rejected) throw toError(rejected);
    if (faults?.beforeWrite) await faults.beforeWrite();
    const temporary = path + '.' + randomUUID() + '.tmp';
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, 'w', 0o600);
      await handle.writeFile(encoded);
      await handle.sync();
      await handle.close();
      handle = undefined;
      const failed = faults?.failBeforeRename?.();
      if (failed) throw toError(failed);
      await rename(temporary, path);
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true });
    }
    try {
      const dir = await open(dirname(path), 'r');
      try {
        await dir.sync();
      } catch {
        /* Directory fsync is best effort, including on macOS. */
      } finally {
        await dir.close();
      }
    } catch {
      /* Directory fsync is best effort. */
    }
  }
  async function readJson(path: string, limit: number) {
    const dates = await stat(path);
    if (dates.size > limit) throw new WorkspacePayloadTooLarge('Record exceeds the supported size.');
    return JSON.parse(await readFile(path, 'utf8'));
  }
  async function read(id: string): Promise<Workspace> {
    const path = await file(id);
    const dates = await stat(path);
    if (dates.size > recordLimit) throw new Error('Workspace record exceeds the supported size.');
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (!raw || raw.id !== id) throw new Error('Unreadable workspace identity.');
    if (raw.metadata?.revision !== undefined && (!Number.isSafeInteger(raw.metadata.revision) || raw.metadata.revision < 0)) throw new Error('Unreadable workspace revision.');
    const content = readContent(raw);
    const date = (value: unknown, fallback: string) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback);
    const metadata: WorkspaceMetadata = { createdAt: date(raw.metadata?.createdAt, dates.birthtime.toISOString()), updatedAt: date(raw.metadata?.updatedAt, dates.mtime.toISOString()), openedAt: date(raw.metadata?.openedAt, dates.birthtime.toISOString()), revision: Number.isSafeInteger(raw.metadata?.revision) && raw.metadata.revision >= 0 ? raw.metadata.revision : 0 };
    return { ...content, metadata };
  }
  async function write(value: Workspace) {
    const path = await file(value.id, true);
    await writeJson(path, { ...value, canvasDiagnostics: undefined }, recordLimit, 'Workspace record exceeds the supported size.');
    return value;
  }
  function assertFields(fields: unknown): Record<string, string> {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Draft fields must be an object of strings.');
    const entries = Object.entries(fields);
    for (const [key, value] of entries) {
      if (!fieldKeyPattern.test(key) || typeof value !== 'string') throw new Error('Unknown draft field.');
    }
    return Object.fromEntries(entries) as Record<string, string>;
  }
  function assertContent(content: unknown): DraftContent {
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('Draft content must be an object.');
    for (const key of Object.keys(content)) if (!contentKeys.has(key)) throw new Error('Unknown draft content.');
    return content as DraftContent;
  }
  function parseDraft(id: string, raw: unknown): WorkspaceDraft | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (value.format !== 1 || value.workspaceId !== id) return null;
    if (!Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0) return null;
    if (!Number.isSafeInteger(value.draftRevision) || (value.draftRevision as number) < 1) return null;
    if (typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt)) || typeof value.name !== 'string') return null;
    if (!value.content || typeof value.content !== 'object' || Array.isArray(value.content)) return null;
    if (!value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) return null;
    if (Object.entries(value.fields).some(([key, item]) => !fieldKeyPattern.test(key) || typeof item !== 'string')) return null;
    if (Object.keys(value.content).some(key => !contentKeys.has(key))) return null;
    return value as unknown as WorkspaceDraft;
  }
  async function readDraftOnce(id: string): Promise<{ draft: WorkspaceDraft | null; draftError?: string }> {
    const directory = await workspaceDirectory(id);
    const path = join(directory, 'draft.json');
    try {
      const located = await realpath(path);
      if (!located.startsWith((await realpath(directory)) + sep)) return { draft: null, draftError: 'A recovered draft could not be read.' };
      const parsed = parseDraft(id, await readJson(path, recordLimit));
      return parsed ? { draft: parsed } : { draft: null, draftError: 'A recovered draft could not be read.' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { draft: null };
      return { draft: null, draftError: 'A recovered draft could not be read.' };
    }
  }
  function positiveInt(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
  }
  function mergeView(existing: Record<string, unknown> | null, patch: Record<string, unknown>): WorkspaceView {
    const base = existing ?? {};
    const incomingFormat = typeof patch.format === 'number' && patch.format >= 1 ? patch.format : undefined;
    const existingFormat = typeof base.format === 'number' && base.format >= 1 ? base.format : undefined;
    const format = Math.max(incomingFormat ?? 1, existingFormat ?? 1);
    const canvas = patch.canvas && typeof patch.canvas === 'object' && !Array.isArray(patch.canvas) ? { ...(base.canvas && typeof base.canvas === 'object' && !Array.isArray(base.canvas) ? (base.canvas as Record<string, unknown>) : {}), ...(patch.canvas as Record<string, unknown>) } : base.canvas;
    const panels = patch.panels && typeof patch.panels === 'object' && !Array.isArray(patch.panels) ? { ...(base.panels && typeof base.panels === 'object' && !Array.isArray(base.panels) ? (base.panels as Record<string, unknown>) : {}), ...(patch.panels as Record<string, unknown>) } : base.panels;
    const allocated = Math.max(positiveInt(base.allocatedDraftRevision), positiveInt(patch.allocatedDraftRevision));
    return { ...base, ...patch, format, ...(canvas === undefined ? {} : { canvas }), ...(panels === undefined ? {} : { panels }), ...(allocated ? { allocatedDraftRevision: allocated } : {}) } as WorkspaceView;
  }
  async function readView(id: string): Promise<WorkspaceView | null> {
    try {
      const directory = await workspaceDirectory(id);
      const path = await contained(directory, 'view.json', false);
      const raw = await readJson(path, viewLimit);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      return raw as WorkspaceView;
    } catch {
      return null;
    }
  }
  async function sessionFile(create: boolean) {
    const basePath = resolve(root);
    await mkdir(basePath, { recursive: true });
    const path = join(basePath, 'session.json');
    try {
      if (!(await realpath(path)).startsWith((await realpath(basePath)) + sep)) throw new Error('Session path escapes its root.');
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return path;
  }
  async function readSession(): Promise<WorkspaceSession | null> {
    try {
      const raw = await readJson(await sessionFile(false), viewLimit);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const value = raw as Record<string, unknown>;
      if (value.lastActiveId !== null && typeof value.lastActiveId !== 'string') return null;
      if (typeof value.updatedAt !== 'string') return null;
      return { lastActiveId: (value.lastActiveId as string | null) ?? null, updatedAt: value.updatedAt, ...(value.unavailable === true ? { unavailable: true } : {}) };
    } catch {
      return null;
    }
  }
  async function writeSession(session: WorkspaceSession) {
    await writeJson(await sessionFile(true), { lastActiveId: session.lastActiveId, updatedAt: session.updatedAt, ...(session.unavailable ? { unavailable: true } : {}) }, viewLimit, 'Session record exceeds the supported size.');
  }
  async function draftInput(id: string, input: { baseRevision: number; expectedDraftRevision: number; name: string; content: unknown; fields: unknown }) {
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || !Number.isSafeInteger(input.expectedDraftRevision) || input.expectedDraftRevision < 0) throw new Error('Invalid draft revision.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120) throw new Error('Use a workspace title of 1–120 characters.');
    const workspace = await read(id);
    if (workspace.metadata!.revision !== input.baseRevision) throw new DraftConflict();
    const current = await readDraftOnce(id);
    if (current.draftError) throw new Error('A recovered draft could not be read. Discard it before saving a new draft.');
    if ((current.draft?.draftRevision ?? 0) !== input.expectedDraftRevision) throw new DraftConflict();
    const view = await readView(id);
    const draftRevision = Math.max(input.expectedDraftRevision + 1, positiveInt(view?.dismissedDraftRevision) + 1, positiveInt(view?.allocatedDraftRevision) + 1);
    if (!Number.isSafeInteger(draftRevision)) throw new Error('Invalid draft revision.');
    const draft: WorkspaceDraft = { format: 1, workspaceId: id, baseRevision: input.baseRevision, draftRevision, savedAt: now(), name: input.name.trim(), content: assertContent(input.content), fields: assertFields(input.fields) };
    return draft;
  }
  async function noteDraftRevision(id: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 1) return;
    const existing = await readView(id);
    if (positiveInt(existing?.allocatedDraftRevision) >= revision) return;
    const view = mergeView(existing, { allocatedDraftRevision: revision });
    const path = await contained(await workspaceDirectory(id, true), 'view.json', true);
    await writeJson(path, view, viewLimit, 'View preferences exceed the supported size.');
  }
  async function writeDraft(draft: WorkspaceDraft) {
    const path = await contained(await workspaceDirectory(draft.workspaceId, true), 'draft.json', true);
    await writeJson(path, draft, recordLimit, 'Draft exceeds the supported size.');
    return draft;
  }
  async function clearDraft(id: string, clearRevision: number, newRevision: number) {
    if (!Number.isSafeInteger(clearRevision) || clearRevision < 0) return false;
    const current = await readDraftOnce(id);
    if (!current.draft || current.draft.draftRevision !== clearRevision || current.draft.baseRevision > newRevision) return false;
    await noteDraftRevision(id, current.draft.draftRevision);
    await rm(await contained(await workspaceDirectory(id), 'draft.json', false), { force: true });
    return true;
  }
  return {
    read: (id: string) => serialize(() => read(id)),
    readDraft: (id: string) => serialize(() => readDraftOnce(id)),
    readView: (id: string) => serialize(() => readView(id)),
    bundle: (id: string) =>
      serialize(async () => {
        const workspace = await read(id);
        const draftState = await readDraftOnce(id);
        const view = await readView(id);
        return { ...workspace, draft: draftState.draft, draftError: draftState.draftError, view };
      }),
    importCopy: (content: Workspace) =>
      serialize(async () => {
        const stamp = now();
        const id = randomUUID();
        let written: Workspace;
        try {
          written = await write({ ...content, id, metadata: { createdAt: stamp, updatedAt: stamp, openedAt: stamp, revision: 1 } });
        } catch (error) {
          await rm(join(await base(), id), { recursive: true, force: true });
          throw error;
        }
        try {
          await writeSession({ lastActiveId: id, updatedAt: stamp });
        } catch (error) {
          console.error('Import committed; session update failed.', error);
        }
        return written;
      }),
    save: (content: Workspace, expectedRevision: number = 0, clearDraftRevision?: number) =>
      serialize(async () => {
        const previous = content.id ? await read(content.id) : undefined;
        if (previous && previous.metadata!.revision !== expectedRevision) throw new WorkspaceConflict();
        const stamp = now();
        const written = await write({ ...content, id: content.id || randomUUID(), metadata: { createdAt: previous?.metadata?.createdAt ?? stamp, updatedAt: stamp, openedAt: previous?.metadata?.openedAt ?? stamp, revision: (previous?.metadata?.revision ?? 0) + 1 } });
        let draftCleared = false;
        try {
          if (!previous || clearDraftRevision !== undefined) {
            const failed = faults?.failAfterCommit?.();
            if (failed) throw toError(failed);
          }
          if (!previous) await writeSession({ lastActiveId: written.id, updatedAt: stamp });
          if (clearDraftRevision !== undefined) draftCleared = await clearDraft(written.id, clearDraftRevision, written.metadata!.revision);
        } catch (error) {
          console.error('Workspace save committed; session or draft cleanup failed.', error);
          draftCleared = false;
        }
        return { ...written, draftCleared };
      }),
    saveDraft: (id: string, input: { baseRevision: number; expectedDraftRevision: number; name: string; content: unknown; fields: unknown }) =>
      serialize(async () => {
        const draft = await draftInput(id, input);
        await writeDraft(draft);
        try {
          await noteDraftRevision(id, draft.draftRevision);
        } catch (error) {
          console.error('Draft revision was saved; the revision watermark was not.', error);
        }
        return { draftRevision: draft.draftRevision, savedAt: draft.savedAt, draft };
      }),
    createWithDraft: (content: Workspace, input: { name: string; content: unknown; fields: unknown }) =>
      serialize(async () => {
        const stamp = now();
        const id = randomUUID();
        const draftContent = assertContent(input.content);
        const fields = assertFields(input.fields);
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120) throw new Error('Use a workspace title of 1–120 characters.');
        const written = await write({ ...content, id, metadata: { createdAt: stamp, updatedAt: stamp, openedAt: stamp, revision: 1 } });
        const draft: WorkspaceDraft = { format: 1, workspaceId: id, baseRevision: 1, draftRevision: 1, savedAt: stamp, name: input.name.trim(), content: draftContent, fields };
        try {
          await writeDraft(draft);
          await writeSession({ lastActiveId: id, updatedAt: stamp });
        } catch (error) {
          await rm(join(await base(), id), { recursive: true, force: true });
          throw error;
        }
        return { workspace: written, draft };
      }),
    discardDraft: (id: string, expectedDraftRevision: number) =>
      serialize(async () => {
        if (!Number.isSafeInteger(expectedDraftRevision) || expectedDraftRevision < 0) throw new Error('Invalid draft revision.');
        const current = await readDraftOnce(id);
        const path = join(await workspaceDirectory(id), 'draft.json');
        if (current.draftError) {
          if (expectedDraftRevision !== 0) throw new DraftConflict();
          await rm(path, { force: true });
          return { discarded: true };
        }
        if (!current.draft) throw new Error('No draft to discard.');
        if (current.draft.draftRevision !== expectedDraftRevision) throw new DraftConflict();
        await noteDraftRevision(id, current.draft.draftRevision);
        await rm(path, { force: true });
        return { discarded: true };
      }),
    saveView: (id: string, patch: unknown) =>
      serialize(async () => {
        await read(id);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('View preferences must be an object.');
        const existing = await readView(id);
        const view = mergeView(existing, patch as Record<string, unknown>);
        const path = await contained(await workspaceDirectory(id), 'view.json', true);
        await writeJson(path, view, viewLimit, 'View preferences exceed the supported size.');
        return view;
      }),
    session: () =>
      serialize(async () => {
        const current = await readSession();
        if (!current?.lastActiveId) return { lastActiveId: null, ...(current?.unavailable ? { unavailable: true } : {}) };
        try {
          await read(current.lastActiveId);
          return { lastActiveId: current.lastActiveId };
        } catch {
          await writeSession({ lastActiveId: null, updatedAt: now(), unavailable: true });
          return { lastActiveId: null, unavailable: true };
        }
      }),
    setSession: (id: string | null) =>
      serialize(async () => {
        if (id) await read(validId(id));
        const session = { lastActiveId: id, updatedAt: now() };
        await writeSession(session);
        return session;
      }),
    open: (id: string) =>
      serialize(async () => {
        const value = await read(id);
        const written = await write({ ...value, metadata: { ...value.metadata!, openedAt: now() } });
        try {
          const failed = faults?.failAfterCommit?.();
          if (failed) throw toError(failed);
          await writeSession({ lastActiveId: id, updatedAt: now() });
        } catch (error) {
          console.error('Workspace open committed; session update failed.', error);
        }
        const draftState = await readDraftOnce(id);
        return { ...written, draft: draftState.draft, draftError: draftState.draftError, view: await readView(id) };
      }),
    rename: (id: string, name: string, expectedRevision: number) =>
      serialize(async () => {
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw new Error('Use a workspace title of 1–120 characters.');
        const value = await read(id);
        if (value.metadata!.revision !== expectedRevision) throw new WorkspaceConflict();
        return write({ ...value, name: name.trim(), metadata: { ...value.metadata!, updatedAt: now(), revision: value.metadata!.revision + 1 } });
      }),
    list: (query = ''): Promise<WorkspaceLibrary> =>
      serialize(async () => {
        const items: WorkspaceSummary[] = [];
        let unreadable = 0;
        for (const entry of await readdir(await base(), { withFileTypes: true })) {
          if (!/^[0-9a-f-]{36}$/.test(entry.name)) continue;
          try {
            const value = await read(entry.name);
            if (!value.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())) continue;
            let hasDraft = false;
            try {
              const directory = await workspaceDirectory(entry.name);
              await contained(directory, 'draft.json', false);
              hasDraft = true;
            } catch {
              /* A missing or unreadable draft does not make the workspace unreadable. */
            }
            items.push({ id: value.id, name: value.name, ...value.metadata!, screens: value.canvas?.screens.length ?? 0, scenarios: value.scenarios?.length ?? 0, hasDraft });
          } catch {
            unreadable++;
          }
        }
        items.sort((a, b) => b.openedAt.localeCompare(a.openedAt) || a.id.localeCompare(b.id));
        return { items, unreadable };
      }),
    trash: (id: string) =>
      serialize(async () => {
        const parent = await base();
        const source = join(parent, validId(id));
        if (!(await realpath(source)).startsWith((await realpath(parent)) + sep)) throw new Error('Workspace path escapes its root.');
        const trashRoot = resolve(root, 'trash');
        await mkdir(trashRoot, { recursive: true });
        if (!(await realpath(trashRoot)).startsWith((await realpath(root)) + sep)) throw new Error('Trash path escapes its root.');
        await rename(source, join(trashRoot, validId(id)));
        const current = await readSession();
        if (current?.lastActiveId === id) await writeSession({ lastActiveId: null, updatedAt: now(), unavailable: true });
      }),
    restore: (id: string) =>
      serialize(async () => {
        const trashRoot = resolve(root, 'trash');
        const source = join(trashRoot, validId(id));
        if (!(await realpath(source)).startsWith((await realpath(trashRoot)) + sep)) throw new Error('Trash path escapes its root.');
        const parent = await base();
        const destination = join(parent, validId(id));
        await rename(source, destination);
      }),
    purge: (id: string) =>
      serialize(async () => {
        const trashRoot = resolve(root, 'trash');
        const target = join(trashRoot, validId(id));
        if (!(await realpath(target)).startsWith((await realpath(trashRoot)) + sep)) throw new Error('Trash path escapes its root.');
        await rm(target, { recursive: true, force: false });
      })
  };
}
