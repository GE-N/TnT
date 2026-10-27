import {randomUUID} from 'node:crypto';
import {WorkspaceConflict} from '../workspace-store.js';
import type {Workspace} from '../scenarios.js';
import {readWorkspace} from './context.js';
import {authoringError} from './errors.js';
import {contentHash, createJournal, journalExpiry, journalNow, persistable, receiptFrom, replacesExistingScenario, type JournalEntry} from './journal.js';
import {createPreviewStore, type StoredPreview} from './preview.js';
import {assertEnvelope, requireRevision, requireString, requireWorkspaceId} from './schema.js';
import {COMPILER_VERSION, issue, type ApplyResult, type AuthoringDeps, type AuthoringProvenance, type Diagnostic} from './types.js';

const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * AI and external script rows are registered as imported before the workspace is published.
 *
 * createScenarios wires the workspace store with
 * `beforePublish: (next, previous) => trustStore.register(next, previous)`.
 * That default marks a new row `local`, and local rows are trusted without review.
 * workspaceStore.save uses `beforePublish ?? options.beforePublish`, so passing this callback
 * replaces the default for this write. Every created row must be in `intended` and is passed
 * with origin `imported`. A missing id throws before register, so the default local path cannot run.
 */
export async function registerImportedScripts(deps: AuthoringDeps, next: Workspace, previous: Workspace | undefined, intended: ReadonlySet<string>) {
  const previousIds = new Set((previous?.scenarios ?? []).flatMap(scenario => (scenario.scripts ?? []).map(row => row.id)));
  const created = (next.scenarios ?? []).flatMap(scenario => scenario.scripts ?? []).filter(row => !previousIds.has(row.id));
  const origins: Record<string, 'imported'> = {};
  for (const row of created) {
    if (!intended.has(row.id)) throw authoringError(409, 'TRUST_ORIGIN_REQUIRED', 'Refusing to publish an authoring script without an explicit imported origin.');
    origins[row.id] = 'imported';
  }
  for (const id of intended) if (!created.some(row => row.id === id)) throw authoringError(409, 'TRUST_ORIGIN_REQUIRED', 'Refusing to publish because an authoring script was missing from the workspace.');
  await deps.register(next, previous, origins);
}

function assumptionKeys(value: unknown) {
  if (!Array.isArray(value) || value.length > 50 || value.some(item => typeof item !== 'string' || !KEY.test(item))) throw authoringError(400, 'INVALID_ENVELOPE', 'Provide acknowledgedAssumptionKeys.');
  return value as string[];
}

function idempotencyKey(value: unknown) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || /[\u0000-\u001F\u007F]/.test(value)) throw authoringError(400, 'INVALID_ENVELOPE', 'Provide an idempotencyKey.');
  return value;
}

async function saveWorkspace(deps: AuthoringDeps, content: Workspace, expectedRevision: number, beforePublish: (next: Workspace, previous?: Workspace) => Promise<void>) {
  try { return await deps.save(content, expectedRevision, beforePublish); }
  catch (error) {
    if (error instanceof WorkspaceConflict) throw authoringError(409, 'REVISION_CONFLICT', 'The workspace revision does not match expectedRevision.');
    throw error;
  }
}

export async function applyFlow(deps: AuthoringDeps, previews: ReturnType<typeof createPreviewStore>, journal: ReturnType<typeof createJournal>, ready: Promise<void>, input: unknown, topKeys: string[] | undefined, options?: {clientId?: string; authoring?: AuthoringProvenance}) {
  await ready;
  const body = assertEnvelope(input, topKeys, ['workspaceId', 'expectedRevision', 'previewId', 'idempotencyKey', 'acknowledgedAssumptionKeys']);
  const workspaceId = requireWorkspaceId(body.workspaceId);
  const expectedRevision = requireRevision(body.expectedRevision);
  const previewId = requireString(body.previewId, 'a previewId');
  const key = idempotencyKey(body.idempotencyKey);
  const acknowledged = assumptionKeys(body.acknowledgedAssumptionKeys);
  const clientId = options?.clientId ?? 'workbench';
  const authoring = options?.authoring ?? 'external';
  const hash = contentHash({workspaceId, expectedRevision, previewId, idempotencyKey: key, acknowledgedAssumptionKeys: acknowledged, authoring});
  const existing = await journal.find(clientId, workspaceId, key);
  if (existing) return resume(deps, journal, existing, hash);

  if (deps.busy(workspaceId)) throw authoringError(409, 'WORKSPACE_BUSY', 'A run is active for this workspace.');
  const current = await readWorkspace(deps, workspaceId);
  if (deps.busy(workspaceId)) throw authoringError(409, 'WORKSPACE_BUSY', 'A run is active for this workspace.');
  if ((current.metadata?.revision ?? 0) !== expectedRevision) throw authoringError(409, 'REVISION_CONFLICT', 'The workspace revision does not match expectedRevision.');
  const loaded = previews.get(previewId);
  if (loaded.state === 'expired') throw authoringError(410, 'PREVIEW_EXPIRED', 'The authoring preview expired.');
  if (loaded.state === 'missing' || loaded.preview.workspaceId !== workspaceId) throw authoringError(404, 'UNKNOWN_PREVIEW', 'Unknown authoring preview.');
  const stored = loaded.preview;
  if (stored.baseRevision !== expectedRevision || stored.compilerVersion !== COMPILER_VERSION) throw authoringError(409, 'PREVIEW_STALE', 'The preview was created for a different revision or compiler version.');
  const claimed = await journal.findByPreview(previewId);
  if (claimed && !(claimed.clientId === clientId && claimed.idempotencyKey === key)) throw authoringError(409, 'PREVIEW_STALE', 'This preview was already applied.');
  const diagnostics = applyDiagnostics(stored, acknowledged);
  if (diagnostics.length) throw authoringError(422, 'APPLY_REJECTED', 'The draft cannot be applied.', diagnostics);
  if (!stored.proposed) throw authoringError(422, 'APPLY_REJECTED', 'The draft cannot be applied.', stored.preview.diagnostics.filter(item => item.blocks.includes('apply')));

  const createdScenario = stored.replaceScenarioId
    ? stored.proposed.scenarios?.find(item => item.id === stored.replaceScenarioId)
    : stored.proposed.scenarios?.find(item => !(current.scenarios ?? []).some(existing => existing.id === item.id));
  if (!createdScenario?.pathId) throw authoringError(422, 'APPLY_REJECTED', 'The preview is missing its scenario.', stored.preview.diagnostics);
  const now = journalNow(deps);
  const entry: JournalEntry = {
    format: 1, id: randomUUID(), status: 'intent', clientId, workspaceId, idempotencyKey: key, contentHash: hash, previewId,
    compilerVersion: COMPILER_VERSION, authoring, createdAt: now.toISOString(), expiresAt: journalExpiry(now),
    intended: {scenarioId: createdScenario.id, pathId: createdScenario.pathId, scriptIds: stored.scriptIds, identityMap: stored.preview.identityMap, runReadiness: stored.preview.runReadiness, diagnostics: stored.preview.diagnostics},
    reverse: {preRevision: expectedRevision, snapshot: persistable(current)},
    proposed: persistable(stored.proposed),
  };
  await journal.save(entry);
  return publish(deps, journal, entry, stored.proposed, new Set(stored.scriptIds));
}

function applyDiagnostics(stored: StoredPreview, acknowledged: readonly string[]) {
  const diagnostics: Diagnostic[] = stored.preview.applicable ? [] : stored.preview.diagnostics.filter(item => item.blocks.includes('apply'));
  const required = new Set(stored.preview.requiredAssumptionKeys);
  const given = new Set(acknowledged);
  for (const key of stored.preview.requiredAssumptionKeys) if (!given.has(key)) diagnostics.push(issue('ASSUMPTION_UNACKNOWLEDGED', '/assumptions', 'error', ['apply'], `Assumption '${key}' must be acknowledged.`, 'Acknowledge the assumption. This confirms the interpretation only and does not trust scripts.', key));
  for (const key of given) if (!required.has(key)) diagnostics.push(issue('ASSUMPTION_UNACKNOWLEDGED', '/assumptions', 'error', ['apply'], `Assumption '${key}' is not one of the required acknowledgements.`, 'Acknowledge only the assumptions listed on the preview.', key));
  return diagnostics;
}

async function resume(deps: AuthoringDeps, journal: ReturnType<typeof createJournal>, entry: JournalEntry, hash: string): Promise<ApplyResult> {
  if (entry.status === 'expired') throw authoringError(409, 'IDEMPOTENCY_EXPIRED', 'This idempotency key expired after a recorded application and cannot be reused.');
  if (entry.contentHash !== hash) throw authoringError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with different content.');
  if ((entry.status === 'committed' || entry.status === 'undone') && entry.receipt) return entry.receipt;
  if (entry.publishedRevision && entry.receipt) {
    const committed = {...entry, status: 'committed' as const};
    await journal.save(committed);
    return entry.receipt;
  }
  if (!entry.proposed || !entry.intended.scenarioId) throw authoringError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key has an unfinished application that cannot be resumed.');
  const workspace = await readWorkspace(deps, entry.workspaceId);
  // Create can treat a new id on the workspace as publication. Replace reuses an id that was already there, so only a recorded revision or receipt counts.
  const replacing = replacesExistingScenario(entry);
  if (!replacing && workspace.scenarios?.some(scenario => scenario.id === entry.intended.scenarioId)) {
    const revision = workspace.metadata?.revision ?? entry.publishedRevision ?? 0;
    const receipt = entry.receipt ?? receiptFrom(entry, revision);
    await journal.save({...entry, status: 'committed', publishedRevision: revision, receipt});
    return receipt;
  }
  if (replacing && (entry.publishedRevision !== undefined || entry.receipt)) {
    const revision = entry.publishedRevision ?? workspace.metadata?.revision ?? 0;
    const receipt = entry.receipt ?? receiptFrom(entry, revision);
    await journal.save({...entry, status: 'committed', publishedRevision: revision, receipt});
    return receipt;
  }
  return publish(deps, journal, entry, {...entry.proposed, id: entry.workspaceId} as Workspace, new Set(entry.intended.scriptIds));
}

function scriptIdsOf(scenarios: {scripts?: {id: string}[]}[] | undefined) {
  return new Set((scenarios ?? []).flatMap(scenario => (scenario.scripts ?? []).map(row => row.id)));
}

async function publish(deps: AuthoringDeps, journal: ReturnType<typeof createJournal>, entry: JournalEntry, proposed: Workspace, scriptIds: ReadonlySet<string>) {
  if (entry.reverse?.preRevision === undefined) throw authoringError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key has an unfinished application that cannot be resumed.');
  const written = await saveWorkspace(deps, proposed, entry.reverse.preRevision, (next, previous) => registerImportedScripts(deps, next, previous, scriptIds));
  const receipt = receiptFrom(entry, written.metadata?.revision ?? 0);
  const published: JournalEntry = {...entry, publishedRevision: written.metadata?.revision, receipt};
  await journal.save(published);
  const fault = deps.faults?.afterPublish?.();
  if (fault) throw fault instanceof Error ? fault : new Error(String(fault));
  await journal.save({...published, status: 'committed'});
  return receipt;
}

export async function undoFlow(deps: AuthoringDeps, journal: ReturnType<typeof createJournal>, ready: Promise<void>, input: unknown, topKeys?: string[]) {
  await ready;
  const body = assertEnvelope(input, topKeys, ['workspaceId', 'expectedRevision', 'receiptId']);
  const workspaceId = requireWorkspaceId(body.workspaceId);
  const expectedRevision = requireRevision(body.expectedRevision);
  const receiptId = requireString(body.receiptId, 'a receiptId');
  const entry = await journal.read(receiptId);
  if (!entry || entry.workspaceId !== workspaceId) throw authoringError(404, 'UNKNOWN_RECEIPT', 'Unknown authoring receipt.');
  if (entry.status === 'expired') throw authoringError(409, 'IDEMPOTENCY_EXPIRED', 'This authoring receipt expired and can no longer be undone.');
  if (entry.status === 'undone') throw authoringError(409, 'UNDO_CONFLICT', 'This authoring apply was already undone.');
  if (entry.status !== 'committed' || !entry.reverse || !entry.publishedRevision) throw authoringError(409, 'UNDO_CONFLICT', 'This authoring apply cannot be undone.');
  if (deps.busy(workspaceId)) throw authoringError(409, 'WORKSPACE_BUSY', 'A run is active for this workspace.');
  const current = await readWorkspace(deps, workspaceId);
  if ((current.metadata?.revision ?? 0) !== expectedRevision) throw authoringError(409, 'REVISION_CONFLICT', 'The workspace revision does not match expectedRevision.');
  if ((current.metadata?.revision ?? 0) !== entry.publishedRevision) throw authoringError(409, 'UNDO_CONFLICT', 'Later edits sit on top of this apply. Undo is only available while the workspace is still at the apply revision.');
  const restored = await saveWorkspace(deps, {...entry.reverse.snapshot, id: workspaceId} as Workspace, expectedRevision, async (next, previous) => {
    const present = scriptIdsOf(next.scenarios);
    const prior = scriptIdsOf(entry.reverse?.snapshot.scenarios);
    const replacing = replacesExistingScenario(entry);
    for (const id of entry.intended.scriptIds) {
      if (!present.has(id)) continue;
      if (!replacing || !prior.has(id)) throw authoringError(409, 'TRUST_ORIGIN_REQUIRED', 'Undo tried to keep an authoring script.');
    }
    await deps.register(next, previous, {});
    await deps.forget(workspaceId, entry.intended.scriptIds.filter(id => !present.has(id)));
  });
  await journal.save({...entry, status: 'undone'});
  return {workspaceId, revision: restored.metadata?.revision ?? 0, receiptId, scenarioId: entry.intended.scenarioId, undone: true as const};
}
