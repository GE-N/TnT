import {randomUUID} from 'node:crypto';
import type {Workspace} from '../scenarios.js';
import {compileDraft} from './compile.js';
import {readWorkspace, type createContextStore} from './context.js';
import {authoringError} from './errors.js';
import {digest} from './hash.js';
import {assertEnvelope, draftSchemaResult, requireRevision, requireString, requireWorkspaceId} from './schema.js';
import {COMPILER_VERSION, CONTRACT_VERSION, SNAPSHOT_TTL_MS, clock, issue, type AuthoringDeps, type Preview} from './types.js';

export type StoredPreview = {
  id: string;
  workspaceId: string;
  baseRevision: number;
  compilerVersion: string;
  contextDigest: string;
  expiresAt: number;
  draftHash: string;
  preview: Preview;
  proposed?: Workspace;
  scriptIds: string[];
};

export function createPreviewStore(now: () => Date) {
  const previews = new Map<string, StoredPreview>();
  return {
    put(preview: StoredPreview) { previews.set(preview.id, preview); },
    get(id: string) {
      const preview = previews.get(id);
      if (!preview) return {state: 'missing' as const};
      if (preview.expiresAt <= now().getTime()) { previews.delete(id); return {state: 'expired' as const}; }
      return {state: 'ok' as const, preview};
    },
  };
}

function blank(workspaceId: string, revision: number, draftHash: string, diagnostics: Preview['diagnostics'], now: Date, assumptions: string[] = []): Preview {
  return {
    previewId: randomUUID(), workspaceId, baseRevision: revision, expiresAt: new Date(now.getTime() + SNAPSHOT_TTL_MS).toISOString(),
    contractVersion: CONTRACT_VERSION, compilerVersion: COMPILER_VERSION, draftHash, applicable: false, authoringComplete: false,
    runReadiness: 'blocked', requiredAssumptionKeys: assumptions, diagnostics, changes: {created: [], reused: [], updated: []}, identityMap: {}, timeline: [],
  };
}

export async function createPreview(deps: AuthoringDeps, contexts: ReturnType<typeof createContextStore>, previews: ReturnType<typeof createPreviewStore>, input: unknown, topKeys?: string[]) {
  const body = assertEnvelope(input, topKeys, ['workspaceId', 'expectedRevision', 'contextId', 'draft']);
  const workspaceId = requireWorkspaceId(body.workspaceId);
  const expectedRevision = requireRevision(body.expectedRevision);
  const contextId = requireString(body.contextId, 'a contextId');
  if (!body.draft || typeof body.draft !== 'object' || Array.isArray(body.draft)) throw authoringError(400, 'INVALID_ENVELOPE', 'Provide a draft object.');
  if ('schemaVersion' in body.draft && (body.draft as {schemaVersion?: unknown}).schemaVersion !== 1) throw authoringError(400, 'UNSUPPORTED_CONTRACT', 'Unsupported contract version.');
  const context = await contexts.require(contextId, workspaceId, expectedRevision);
  const workspace = await readWorkspace(deps, workspaceId);
  const now = clock(deps);
  const draftHash = digest(body.draft);
  const schema = draftSchemaResult(body.draft);
  const diagnostics = schema.ok ? [] : schema.diagnostics;
  const translation = schema.ok ? compileDraft(workspace, schema.draft, context) : undefined;
  const preview: Preview = translation ? {
    previewId: randomUUID(), workspaceId, baseRevision: expectedRevision, expiresAt: new Date(now.getTime() + SNAPSHOT_TTL_MS).toISOString(),
    contractVersion: CONTRACT_VERSION, compilerVersion: COMPILER_VERSION, draftHash, applicable: translation.applicable, authoringComplete: translation.authoringComplete,
    runReadiness: translation.runReadiness, requiredAssumptionKeys: translation.requiredAssumptionKeys, diagnostics: translation.diagnostics,
    changes: translation.changes, identityMap: translation.identityMap, timeline: translation.timeline,
  } : blank(workspaceId, expectedRevision, draftHash, diagnostics.length ? diagnostics : [issue('INVALID_DRAFT', '', 'error', ['apply', 'run'], 'Draft does not match the v1 schema.', 'Correct the draft so it matches the v1 flow schema.')], now);
  previews.put({
    id: preview.previewId, workspaceId, baseRevision: expectedRevision, compilerVersion: COMPILER_VERSION, contextDigest: context.digest,
    expiresAt: now.getTime() + SNAPSHOT_TTL_MS, draftHash, preview, scriptIds: translation?.scriptIds ?? [],
    ...(translation?.proposed ? {proposed: translation.proposed} : {}),
  });
  return preview;
}
