import {randomUUID} from 'node:crypto';
import type {Workspace} from '../scenarios.js';
import {compileDraft} from './compile.js';
import {readWorkspace, type createContextStore} from './context.js';
import {authoringError} from './errors.js';
import {digest} from './hash.js';
import {assertEnvelope, draftSchemaResult, requireRevision, requireString, requireWorkspaceId} from './schema.js';
import {COMPILER_VERSION, CONTRACT_VERSION, SNAPSHOT_TTL_MS, clock, issue, type AuthoringDeps, type Preview} from './types.js';

export type ScreenPlacement = {x: number; y: number};

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
  /** Normalized create-screen coordinates. Omitted when the request has none, so the stored record matches the previous shape. */
  placements?: Record<string, ScreenPlacement>;
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
  const body = assertEnvelope(input, topKeys, ['workspaceId', 'expectedRevision', 'contextId', 'draft', 'placements']);
  const workspaceId = requireWorkspaceId(body.workspaceId);
  const expectedRevision = requireRevision(body.expectedRevision);
  const contextId = requireString(body.contextId, 'a contextId');
  if (!body.draft || typeof body.draft !== 'object' || Array.isArray(body.draft)) throw authoringError(400, 'INVALID_ENVELOPE', 'Provide a draft object.');
  if ('schemaVersion' in body.draft && (body.draft as {schemaVersion?: unknown}).schemaVersion !== 1) throw authoringError(400, 'UNSUPPORTED_CONTRACT', 'Unsupported contract version.');
  const placements = readPlacements(body.placements, body.draft);
  const context = await contexts.require(contextId, workspaceId, expectedRevision);
  const workspace = await readWorkspace(deps, workspaceId);
  const now = clock(deps);
  const draftHash = previewDigest(body.draft, placements);
  const schema = draftSchemaResult(body.draft);
  const diagnostics = schema.ok ? [] : schema.diagnostics;
  const translation = schema.ok ? compileDraft(workspace, schema.draft, context, placements) : undefined;
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
    ...(placements ? {placements} : {}),
  });
  return preview;
}

const PLACEMENT_X_MAX = 2400;
const PLACEMENT_Y_MAX = 1400;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createScreenKeys(draft: unknown) {
  const keys = new Set<string>();
  let count = 0;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return {keys, count};
  const screens = (draft as {screens?: unknown}).screens;
  if (!Array.isArray(screens)) return {keys, count};
  for (const screen of screens) {
    if (!screen || typeof screen !== 'object' || Array.isArray(screen)) continue;
    const item = screen as {key?: unknown; kind?: unknown};
    if (item.kind !== 'create') continue;
    count++;
    if (typeof item.key === 'string') keys.add(item.key);
  }
  return {keys, count};
}

function roundClamp(value: number, max: number) {
  return Math.min(max, Math.max(0, Math.round(value)));
}

/** Accepts only create-screen keys. Coordinates are rounded, then clamped to the workbench canvas. */
function readPlacements(value: unknown, draft: unknown): Record<string, ScreenPlacement> | undefined {
  if (value === undefined) return undefined;
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length) throw authoringError(400, 'INVALID_ENVELOPE', 'Provide placements as an object of screen points.');
  const names = Object.getOwnPropertyNames(value);
  const {keys, count} = createScreenKeys(draft);
  if (names.length > count) throw authoringError(400, 'INVALID_ENVELOPE', 'Provide at most one placement per new screen.');
  const placements: Record<string, ScreenPlacement> = {};
  for (const key of names) {
    if (!keys.has(key)) throw authoringError(400, 'INVALID_ENVELOPE', 'Placement keys must be new screens in this draft.');
    const point = value[key];
    if (!plainRecord(point) || Object.getOwnPropertySymbols(point).length) throw authoringError(400, 'INVALID_ENVELOPE', 'A placement point has only x and y.');
    const pointNames = Object.getOwnPropertyNames(point);
    if (pointNames.length !== 2 || !pointNames.includes('x') || !pointNames.includes('y')) throw authoringError(400, 'INVALID_ENVELOPE', 'A placement point has only x and y.');
    const {x, y} = point;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw authoringError(400, 'INVALID_ENVELOPE', 'Placement coordinates must be finite numbers.');
    placements[key] = {x: roundClamp(x, PLACEMENT_X_MAX), y: roundClamp(y, PLACEMENT_Y_MAX)};
  }
  return names.length ? placements : undefined;
}

function previewDigest(draft: unknown, placements: Record<string, ScreenPlacement> | undefined) {
  return placements ? digest({draft, placements}) : digest(draft);
}
