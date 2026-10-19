import {randomUUID} from 'node:crypto';
import {chmod, mkdir, open, readdir, readFile, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {Workspace} from '../scenarios.js';
import {digest} from './hash.js';
import {JOURNAL_TTL_MS, clock, type ApplyResult, type AuthoringDeps, type AuthoringProvenance, type Diagnostic, type EntityRef, type Preview} from './types.js';

const FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

export type PersistedWorkspace = Omit<Workspace, 'metadata' | 'canvasDiagnostics'>;

export type JournalEntry = {
  format: 1;
  id: string;
  status: 'intent' | 'committed' | 'undone' | 'expired';
  clientId: string;
  workspaceId: string;
  idempotencyKey: string;
  contentHash: string;
  previewId: string;
  compilerVersion: string;
  authoring: AuthoringProvenance;
  createdAt: string;
  expiresAt: string;
  intended: {
    scenarioId: string;
    pathId: string;
    scriptIds: string[];
    identityMap: Record<string, EntityRef>;
    runReadiness: Preview['runReadiness'];
    diagnostics: Diagnostic[];
  };
  reverse?: {preRevision: number; snapshot: PersistedWorkspace};
  proposed?: PersistedWorkspace;
  publishedRevision?: number;
  receipt?: ApplyResult;
};

export function persistable(workspace: Workspace): PersistedWorkspace {
  const {metadata, canvasDiagnostics, ...content} = workspace;
  void metadata;
  void canvasDiagnostics;
  return structuredClone(content);
}

export function contentHash(value: {workspaceId: string; expectedRevision: number; previewId: string; idempotencyKey: string; acknowledgedAssumptionKeys: readonly string[]; authoring: AuthoringProvenance}) {
  return digest(value);
}

export function createJournal(root: string, now: () => Date) {
  const directory = join(root, '.tnt', 'authoring-journal');
  async function write(entry: JournalEntry) {
    await mkdir(directory, {recursive: true, mode: 0o700});
    await chmod(directory, 0o700);
    const target = join(directory, `${entry.id}.json`);
    const temporary = join(directory, `${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(entry));
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
  function view(entry: JournalEntry): JournalEntry {
    if (Date.parse(entry.expiresAt) > now().getTime()) return entry;
    return {...entry, status: 'expired', proposed: undefined, reverse: undefined};
  }
  async function readAll() {
    let names: string[] = [];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const entries: JournalEntry[] = [];
    for (const name of names) {
      if (!FILE.test(name)) continue;
      const parsed = JSON.parse(await readFile(join(directory, name), 'utf8')) as JournalEntry;
      if (!parsed || parsed.format !== 1 || parsed.id + '.json' !== name) throw new Error('Authoring journal is unreadable.');
      entries.push(parsed);
    }
    return entries;
  }
  return {
    directory,
    async save(entry: JournalEntry) { await write(entry); },
    async read(id: string) {
      const found = (await readAll()).find(entry => entry.id === id);
      return found ? view(found) : undefined;
    },
    async find(clientId: string, workspaceId: string, idempotencyKey: string) {
      const found = (await readAll()).find(entry => entry.clientId === clientId && entry.workspaceId === workspaceId && entry.idempotencyKey === idempotencyKey);
      return found ? view(found) : undefined;
    },
    async findByPreview(previewId: string) {
      const found = (await readAll()).find(entry => entry.previewId === previewId && entry.status !== 'expired');
      return found ? view(found) : undefined;
    },
    async all() { return (await readAll()).map(view); },
  };
}

export async function reconcileJournal(journal: ReturnType<typeof createJournal>, deps: AuthoringDeps) {
  for (const entry of await journal.all()) {
    if (entry.status !== 'intent') continue;
    let workspace: Workspace | undefined;
    try { workspace = await deps.read(entry.workspaceId); } catch { continue; }
    const published = Boolean(entry.publishedRevision || workspace.scenarios?.some(scenario => scenario.id === entry.intended.scenarioId));
    if (!published) continue;
    const revision = entry.publishedRevision ?? workspace.metadata?.revision ?? 0;
    const stored: JournalEntry = {...entry, status: 'committed', publishedRevision: revision, receipt: entry.receipt ?? receiptFrom(entry, revision)};
    await journal.save(stored);
  }
}

export function receiptFrom(entry: JournalEntry, revision: number): ApplyResult {
  return {
    workspaceId: entry.workspaceId,
    revision,
    scenarioId: entry.intended.scenarioId,
    pathId: entry.intended.pathId,
    identityMap: entry.intended.identityMap,
    runReadiness: entry.intended.runReadiness,
    diagnostics: entry.intended.diagnostics,
    authoring: entry.authoring,
  };
}

export function journalExpiry(now: Date) {
  return new Date(now.getTime() + JOURNAL_TTL_MS).toISOString();
}

export function journalNow(deps: AuthoringDeps) {
  return clock(deps);
}
