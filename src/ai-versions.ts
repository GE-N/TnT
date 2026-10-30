import type {DraftOperation, DraftTarget, FlowDraft} from '../server/authoring/types.js';

/** How long the capsule shows ↶ Undo after Apply. Versions replaces it once the window ends, when history exists. */
export const UNDO_WINDOW_MS = 10_000;

export type CapsuleMode = 'draft' | 'undo' | 'versions' | 'idle';

/**
 * One capsule control at a time. A pre-Apply draft wins, then the live Undo window,
 * then quiet Versions when this flow already has history.
 */
export function capsuleMode(input: {draftOpen: boolean; undoVisible: boolean; versionCount: number}): CapsuleMode {
  if (input.draftOpen) return 'draft';
  if (input.undoVisible) return 'undo';
  if (input.versionCount >= 1) return 'versions';
  return 'idle';
}

/** Newest entry of each flow is last and is Now. Oldest drop first. */
export const VERSION_CAP = 20;

/** Keep the serialized `aiVersions` object under the view.json limit (64,000 bytes). */
export const VERSION_BYTE_BUDGET = 48_000;

export const AI_VERSIONS_KEY = 'aiVersions';

export type VersionPoint = {x: number; y: number};

export type VersionProjection = {
  screens: {key: string; title: string; x: number; y: number; steps: string[]}[];
  edges: {from: string; to: string; label: string}[];
};

export type FlowVersion = {
  id: string;
  title: string;
  createdAt: string;
  draft: FlowDraft;
  placements: Record<string, VersionPoint>;
  projection: VersionProjection;
};

export type AiVersionsState = {
  format: 1;
  flows: Record<string, FlowVersion[]>;
  current?: string;
};

/** What the canvas draws while a past row is selected. Nothing here is written. */
export type VersionCanvasPreview = {
  breadcrumb: string;
  viewingLabel: string;
  projection: VersionProjection;
};

type SnapshotScreen = {id: string; title: string; x: number; y: number};

type SnapshotGraph = {
  screens: SnapshotScreen[];
  edges: {id: string; from: string; to: string}[];
  paths: {id: string; scenarioId?: string; screenId?: string; edgeIds: string[]}[];
};

const emptyState = (): AiVersionsState => ({format: 1, flows: {}});

function isPoint(value: unknown): value is VersionPoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as VersionPoint;
  return typeof point.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isDraft(value: unknown): value is FlowDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as FlowDraft;
  return draft.schemaVersion === 1 && draft.mode === 'createScenario' && Array.isArray(draft.screens) && Array.isArray(draft.visits);
}

function isProjection(value: unknown): value is VersionProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const projection = value as VersionProjection;
  if (!Array.isArray(projection.screens) || !Array.isArray(projection.edges)) return false;
  return projection.screens.every(screen => screen && typeof screen.key === 'string' && typeof screen.title === 'string' && typeof screen.x === 'number' && typeof screen.y === 'number' && Array.isArray(screen.steps))
    && projection.edges.every(edge => edge && typeof edge.from === 'string' && typeof edge.to === 'string' && typeof edge.label === 'string');
}

function readVersion(value: unknown): FlowVersion | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Partial<FlowVersion>;
  if (typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || typeof item.createdAt !== 'string' || !isDraft(item.draft) || !isProjection(item.projection)) return;
  const placements: Record<string, VersionPoint> = {};
  if (item.placements && typeof item.placements === 'object' && !Array.isArray(item.placements)) {
    for (const [key, point] of Object.entries(item.placements)) if (isPoint(point)) placements[key] = {x: point.x, y: point.y};
  }
  return {id: item.id, title: item.title, createdAt: item.createdAt, draft: item.draft, placements, projection: item.projection};
}

export function readAiVersions(view: unknown): AiVersionsState {
  if (!view || typeof view !== 'object' || Array.isArray(view)) return emptyState();
  const raw = (view as Record<string, unknown>)[AI_VERSIONS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
  const record = raw as {format?: unknown; current?: unknown; flows?: unknown};
  if (record.format !== 1 || !record.flows || typeof record.flows !== 'object' || Array.isArray(record.flows)) return emptyState();
  const flows: Record<string, FlowVersion[]> = {};
  for (const [flowId, list] of Object.entries(record.flows)) {
    if (!flowId || !Array.isArray(list)) continue;
    const versions = list.map(readVersion).filter((item): item is FlowVersion => !!item);
    if (versions.length) flows[flowId] = versions;
  }
  const current = typeof record.current === 'string' && flows[record.current] ? record.current : undefined;
  return current ? {format: 1, flows, current} : {format: 1, flows};
}

function encodedSize(state: AiVersionsState) {
  return new TextEncoder().encode(JSON.stringify(state)).length;
}

function countVersions(state: AiVersionsState) {
  return Object.values(state.flows).reduce((sum, list) => sum + list.length, 0);
}

function newestFlowId(flows: Record<string, FlowVersion[]>) {
  let bestId = '';
  let bestAt = '';
  for (const [flowId, list] of Object.entries(flows)) {
    const createdAt = list[list.length - 1]?.createdAt ?? '';
    if (!bestId || createdAt >= bestAt) { bestId = flowId; bestAt = createdAt; }
  }
  return bestId;
}

function settle(flows: Record<string, FlowVersion[]>, current?: string): AiVersionsState {
  const nextFlows: Record<string, FlowVersion[]> = {};
  for (const [flowId, list] of Object.entries(flows)) if (list.length) nextFlows[flowId] = list;
  const kept = current && nextFlows[current] ? current : newestFlowId(nextFlows);
  return kept ? {format: 1, flows: nextFlows, current: kept} : {format: 1, flows: nextFlows};
}

function dropOldest(state: AiVersionsState): AiVersionsState {
  let oldestId = '';
  let oldestIndex = -1;
  let oldestAt = '';
  for (const [flowId, list] of Object.entries(state.flows)) {
    list.forEach((version, index) => {
      if (oldestIndex < 0 || version.createdAt < oldestAt) {
        oldestId = flowId;
        oldestIndex = index;
        oldestAt = version.createdAt;
      }
    });
  }
  if (!oldestId || oldestIndex < 0) return state;
  const flows = {...state.flows, [oldestId]: state.flows[oldestId].filter((_, index) => index !== oldestIndex)};
  return settle(flows, state.current);
}

function capAndTrim(state: AiVersionsState): AiVersionsState {
  const flows: Record<string, FlowVersion[]> = {};
  for (const [flowId, list] of Object.entries(state.flows)) {
    const capped = list.slice(-VERSION_CAP);
    if (capped.length) flows[flowId] = capped;
  }
  let next = settle(flows, state.current);
  while (countVersions(next) > VERSION_CAP) next = dropOldest(next);
  while (encodedSize(next) > VERSION_BYTE_BUDGET && countVersions(next) > 1) next = dropOldest(next);
  return next;
}

export function withPushedVersion(state: AiVersionsState, flowId: string, version: FlowVersion): AiVersionsState {
  if (!flowId) return state;
  const list = [...(state.flows[flowId] ?? []), version];
  return capAndTrim({format: 1, flows: {...state.flows, [flowId]: list}, current: flowId});
}

export function withPoppedVersion(state: AiVersionsState, flowId: string): AiVersionsState {
  const list = state.flows[flowId];
  if (!list?.length) return state;
  return capAndTrim(settle({...state.flows, [flowId]: list.slice(0, -1)}, state.current === flowId && list.length === 1 ? undefined : state.current));
}

/**
 * Stack half of Figma Restore: checkpoint Now, then mark the chosen past entry as the new Now.
 * The sheet writes the workspace; this only describes the stack shape.
 */
export function withRestoredVersion(state: AiVersionsState, versionId: string, createdAt: string, nextId: () => string): AiVersionsState {
  const flowId = state.current;
  if (!flowId) return state;
  const list = state.flows[flowId] ?? [];
  const chosen = list.find(item => item.id === versionId);
  const now = list[list.length - 1];
  if (!chosen || !now || chosen.id === now.id) return state;
  const checkpoint: FlowVersion = {...structuredClone(now), id: nextId(), createdAt};
  const marked: FlowVersion = {...structuredClone(chosen), id: nextId(), createdAt};
  return withPushedVersion(withPushedVersion(state, flowId, checkpoint), flowId, marked);
}

function targetText(target: DraftTarget) {
  if (target.kind === 'unresolved') return;
  if (target.kind === 'context') return target.ref.trim() || undefined;
  return target.selector.value.trim() || undefined;
}

function valueText(value: Extract<DraftOperation, {kind: 'input'}>['value']) {
  if (value.kind === 'unresolved') return;
  if (value.kind === 'literal') return value.text.trim() || undefined;
  return value.name.trim() || undefined;
}

function stepLabel(operation: DraftOperation, index: number, destinationTitle?: string) {
  const number = index + 1;
  if (operation.kind === 'tap' || operation.kind === 'back') {
    const name = operation.kind === 'back' ? 'Back' : 'Tap';
    if (!targetText(operation.target)) return number + ' · ' + name;
    if (operation.destination.kind === 'visit' && destinationTitle) return number + ' · Go to ' + destinationTitle;
    return number + ' · ' + name + ' ' + targetText(operation.target);
  }
  if (operation.kind === 'input') {
    const value = valueText(operation.value);
    return value ? number + ' · Input ' + value : number + ' · Input';
  }
  const value = targetText(operation.target);
  if (!value) return number + ' · Check';
  return number + ' · Check "' + value + '" ' + (operation.kind === 'checkAbsent' ? 'absent' : 'visible');
}

function screenTitle(draft: FlowDraft, screens: SnapshotScreen[], key: string) {
  const screen = draft.screens.find(item => item.key === key);
  if (!screen) return key;
  if (screen.kind === 'create') return screen.title;
  return screens.find(item => item.id === screen.screenId)?.title ?? key;
}

function screenPoint(draft: FlowDraft, screens: SnapshotScreen[], placements: Record<string, VersionPoint>, key: string, index: number): VersionPoint {
  const screen = draft.screens.find(item => item.key === key);
  if (screen?.kind === 'existing') {
    const found = screens.find(item => item.id === screen.screenId);
    if (found) return {x: found.x, y: found.y};
  }
  const placed = placements[key];
  if (placed) return {x: placed.x, y: placed.y};
  return {x: 40 + (index % 8) * 280, y: 40 + Math.floor(index / 8) * 200};
}

export function projectionFor(draft: FlowDraft, placements: Record<string, VersionPoint>, screens: SnapshotScreen[]): VersionProjection {
  const order: string[] = [];
  for (const visit of draft.visits) if (visit?.screenKey && !order.includes(visit.screenKey)) order.push(visit.screenKey);
  for (const screen of draft.screens) if (!order.includes(screen.key)) order.push(screen.key);
  const stepsFor = new Map<string, string[]>();
  for (const visit of draft.visits) {
    if (!visit || typeof visit.screenKey !== 'string' || !Array.isArray(visit.operations)) continue;
    const list = stepsFor.get(visit.screenKey) ?? [];
    for (const operation of visit.operations) {
      const linked = (operation.kind === 'tap' || operation.kind === 'back') && operation.destination.kind === 'visit' ? operation.destination.visitKey : undefined;
      const destination = linked ? screenTitle(draft, screens, draft.visits.find(item => item.key === linked)?.screenKey ?? '') : undefined;
      list.push(stepLabel(operation, list.length, destination));
    }
    stepsFor.set(visit.screenKey, list);
  }
  const projected = order.map((key, index) => ({
    key,
    title: screenTitle(draft, screens, key),
    ...screenPoint(draft, screens, placements, key, index),
    steps: stepsFor.get(key) ?? [],
  }));
  const known = new Set(projected.map(screen => screen.key));
  const edges: VersionProjection['edges'] = [];
  for (let index = 0; index < draft.visits.length - 1; index++) {
    const fromVisit = draft.visits[index];
    const toVisit = draft.visits[index + 1];
    if (!fromVisit || !toVisit || !known.has(fromVisit.screenKey) || !known.has(toVisit.screenKey)) continue;
    const link = Array.isArray(fromVisit.operations) ? [...fromVisit.operations].reverse().find(operation => (operation.kind === 'tap' || operation.kind === 'back') && operation.destination.kind === 'visit' && operation.destination.visitKey === toVisit.key) : undefined;
    const verb = !link ? screenTitle(draft, screens, fromVisit.screenKey) : link.kind === 'back' ? 'Back' : 'Tap';
    edges.push({from: fromVisit.screenKey, to: toVisit.screenKey, label: verb + ' → ' + screenTitle(draft, screens, toVisit.screenKey)});
  }
  return {screens: projected, edges};
}

/**
 * Draft and placements exactly as Apply sent them, made restorable on their own.
 * An existing screen used only by this flow becomes a create screen (its title and position).
 * A screen shared with another scenario stays existing.
 */
export function selfContainedSnapshot(input: {
  draft: FlowDraft;
  placements?: Record<string, VersionPoint>;
  screens: SnapshotScreen[];
  sharedScreenIds: ReadonlySet<string>;
}): {draft: FlowDraft; placements: Record<string, VersionPoint>} {
  const draft = structuredClone(input.draft);
  const placements: Record<string, VersionPoint> = {};
  for (const [key, point] of Object.entries(input.placements ?? {})) {
    if (isPoint(point)) placements[key] = {x: point.x, y: point.y};
  }
  draft.screens = draft.screens.map(screen => {
    if (screen.kind !== 'existing') return screen;
    if (input.sharedScreenIds.has(screen.screenId)) return screen;
    const found = input.screens.find(item => item.id === screen.screenId);
    if (!found) return screen;
    placements[screen.key] = {x: found.x, y: found.y};
    return {key: screen.key, kind: 'create' as const, title: found.title};
  });
  return {draft, placements};
}

/** Screen ids visited by any scenario other than this flow. */
export function sharedScreenIds(graph: SnapshotGraph | undefined, flowScenarioId: string, scenarios?: {id: string; pathId?: string}[]) {
  const ids = new Set<string>();
  if (!graph) return ids;
  const otherPaths = new Set((scenarios ?? []).filter(item => item.id !== flowScenarioId && item.pathId).map(item => item.pathId!));
  for (const path of graph.paths) {
    const other = (path.scenarioId && path.scenarioId !== flowScenarioId) || (!path.scenarioId && otherPaths.has(path.id));
    if (!other) continue;
    if (path.screenId) ids.add(path.screenId);
    for (const edgeId of path.edgeIds) {
      const edge = graph.edges.find(item => item.id === edgeId);
      if (!edge) continue;
      ids.add(edge.from);
      ids.add(edge.to);
    }
  }
  return ids;
}

export function makeVersion(input: {
  id: string;
  createdAt: string;
  draft: FlowDraft;
  placements?: Record<string, VersionPoint>;
  screens: SnapshotScreen[];
  sharedScreenIds: ReadonlySet<string>;
}): FlowVersion {
  const contained = selfContainedSnapshot(input);
  return {
    id: input.id,
    title: contained.draft.name.trim() || 'Untitled flow',
    createdAt: input.createdAt,
    draft: contained.draft,
    placements: contained.placements,
    projection: projectionFor(contained.draft, contained.placements, input.screens),
  };
}

export function relativeVersionTime(createdAt: string, now = Date.now()) {
  const then = Date.parse(createdAt);
  if (!Number.isFinite(then)) return 'Earlier';
  const delta = Math.max(0, now - then);
  const minute = 60_000;
  if (delta < minute) return 'Just now';
  if (delta < 60 * minute) return Math.max(1, Math.floor(delta / minute)) + ' min ago';
  const thenDate = new Date(then);
  const nowDate = new Date(now);
  if (thenDate.toDateString() === nowDate.toDateString()) return 'Earlier today';
  const yesterday = new Date(nowDate);
  yesterday.setDate(nowDate.getDate() - 1);
  if (thenDate.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return 'Earlier';
}
