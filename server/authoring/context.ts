import {createHash, randomUUID} from 'node:crypto';
import {parseAllDocuments} from 'yaml';
import type {ScreenSelector} from '../../shared/canvas-authoring.js';
import {isAuthored} from '../../shared/canvas-authoring.js';
import type {Workspace} from '../scenarios.js';
import {authoringError} from './errors.js';
import {digest} from './hash.js';
import {CANVAS_EDGE_LIMIT, CANVAS_SCREEN_LIMIT, COMPILER_VERSION, CONTRACT_VERSION, clock, type AuthoringDeps, type ContextSnapshot} from './types.js';

const SELECTOR = new Set(['text', 'id']);
const MATCH = new Set(['exact', 'contains', 'regex']);

function appIdOf(yaml: string) {
  try {
    const value = parseAllDocuments(yaml)[0]?.toJS() as {appId?: unknown} | undefined;
    return typeof value?.appId === 'string' ? value.appId : '';
  } catch { return ''; }
}

function simpleSelector(value: unknown): ScreenSelector | undefined {
  if (!value || typeof value !== 'object') return;
  const selector = value as ScreenSelector;
  if (!SELECTOR.has(selector.target) || !MATCH.has(selector.match) || typeof selector.value !== 'string' || !selector.value) return;
  return {target: selector.target, match: selector.match, value: selector.value};
}

export function buildContext(workspace: Workspace, screenIds: string[] | undefined, now: Date): ContextSnapshot {
  const canvas = workspace.canvas;
  const allowed = screenIds ? new Set(screenIds) : undefined;
  const omissions: {kind: string; reason: string; screenId?: string}[] = [];
  const screens = (canvas?.screens ?? []).filter(screen => {
    if (allowed && !allowed.has(screen.id)) {
      omissions.push({kind: 'screen', reason: 'filtered', screenId: screen.id});
      return false;
    }
    return true;
  }).map(screen => ({screenId: screen.id, title: screen.title}));
  if (allowed) for (const id of allowed) if (!(canvas?.screens ?? []).some(screen => screen.id === id)) omissions.push({kind: 'screen', reason: 'unknown-screen', screenId: id});

  const targets: ContextSnapshot['targets'] = {};
  let targetCount = 0;
  for (const screen of canvas?.screens ?? []) {
    if (allowed && !allowed.has(screen.id)) continue;
    for (const test of screen.tests) {
      if (test.role === 'setup' || test.role === 'handler') continue;
      const back = test.back ? simpleSelector(test.backSelector ?? {target: 'text', match: 'exact', value: 'Back'}) : undefined;
      const selector = simpleSelector(test.check ?? test.tap ?? back);
      if (!isAuthored(test) || !selector) {
        if (isAuthored(test) || test.reference) omissions.push({kind: 'target', reason: test.check || test.tap || test.back ? 'complex-selector' : 'unsupported-command', screenId: screen.id});
        continue;
      }
      const role = test.check ? 'check' as const : test.back ? 'back' as const : 'tap' as const;
      targets[`target-${++targetCount}`] = {screenId: screen.id, selector, role};
    }
  }

  const setups: ContextSnapshot['setups'] = {};
  const setup = workspace.automation?.setup;
  const setupFlow = setup ? workspace.flows?.[setup.file] : undefined;
  if (setup && setupFlow && !Object.keys(setup.parameters).some(name => name === 'TNT_MOCK_URL' || name === 'TNT_MOCK_TOKEN' || name.startsWith('MAESTRO_'))) {
    const parameterNames = Object.keys(setup.parameters).sort();
    const digestValue = createHash('sha256').update(JSON.stringify({file: setup.file, parameterNames, flow: setupFlow})).digest('hex');
    setups['setup-1'] = {file: setup.file, parameters: {...setup.parameters}, parameterNames, digest: digestValue};
    if (parameterNames.length) omissions.push({kind: 'setup', reason: 'parameter-values-omitted'});
  } else if (workspace.automation) omissions.push({kind: 'setup', reason: 'invalid-static-bindings'});

  const handlers = (workspace.automation?.actions ?? []).map(action => ({ref: action.id, name: action.name}));
  const mocks: ContextSnapshot['mocks'] = {};
  if (workspace.mock) {
    const route = workspace.mock.environment?.routes?.find(item => item.uuid === workspace.mock!.routeId);
    const responses = route?.responses ?? [];
    if (route && responses.length) {
      responses.forEach((response, index) => { mocks[`mock-${index + 1}`] = {routeId: route.uuid, responseId: response.uuid}; });
      omissions.push({kind: 'mock', reason: 'secret-values-omitted'});
    } else omissions.push({kind: 'mock', reason: 'invalid-static-bindings'});
  }

  const appId = appIdOf(workspace.yaml);
  const existingScreens = canvas?.screens.length ?? 0;
  const existingEdges = canvas?.edges.length ?? 0;
  const body = {
    screens,
    targets: Object.entries(targets).map(([ref, target]) => ({ref, screenId: target.screenId, role: target.role, selector: target.selector})),
    executionOptions: {
      setups: Object.entries(setups).map(([ref, item]) => ({ref, file: item.file, parameterNames: item.parameterNames, digest: item.digest})),
      handlers,
      mocks: Object.entries(mocks).map(([ref, item]) => ({ref, routeId: item.routeId, responseId: item.responseId})),
    },
    omissions,
    capabilities: {
      contractVersion: CONTRACT_VERSION,
      compilerVersion: COMPILER_VERSION,
      modes: ['createScenario'],
      coordinates: false,
      selector: {targets: ['text', 'id'], matches: ['exact', 'contains', 'regex']},
      scriptLanguages: ['maestro-javascript'],
      limits: {screens: 80, visits: 81, transitions: 80, operations: 100, operationsPerVisit: 30, scripts: 100, parameters: 20, scriptBytes: 64_000, draftBytes: 256_000, canvasScreens: CANVAS_SCREEN_LIMIT, canvasTransitions: CANVAS_EDGE_LIMIT},
      available: {screens: Math.max(0, CANVAS_SCREEN_LIMIT - existingScreens), transitions: Math.max(0, CANVAS_EDGE_LIMIT - existingEdges)},
    },
  };
  const fingerprint = digest({revision: workspace.metadata?.revision ?? 0, appId, screenIds: screenIds ?? null, screens: body.screens, targets: body.targets, setups: body.executionOptions.setups, handlers, mocks: body.executionOptions.mocks});
  return {
    id: randomUUID(), workspaceId: workspace.id, revision: workspace.metadata?.revision ?? 0, expiresAt: now.getTime() + 30 * 60 * 1000, digest: fingerprint, screenIds, appId,
    screens, targets, setups, handlers, mocks, publicBody: body,
  };
}

export function createContextStore(deps: AuthoringDeps) {
  const snapshots = new Map<string, ContextSnapshot>();
  function sweep() {
    const now = clock(deps).getTime();
    for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= now) snapshots.delete(id);
  }
  return {
    async create(input: {workspaceId: string; expectedRevision: number; screenIds?: string[]}) {
      sweep();
      const workspace = await readWorkspace(deps, input.workspaceId);
      if ((workspace.metadata?.revision ?? 0) !== input.expectedRevision) throw authoringError(409, 'REVISION_CONFLICT', 'The workspace revision does not match expectedRevision.');
      const snapshot = buildContext(workspace, input.screenIds, clock(deps));
      snapshots.set(snapshot.id, snapshot);
      return publicContext(snapshot);
    },
    async require(id: string, workspaceId: string, expectedRevision: number) {
      const snapshot = snapshots.get(id);
      const now = clock(deps).getTime();
      for (const [key, item] of snapshots) if (item.expiresAt <= now) snapshots.delete(key);
      if (!snapshot || snapshot.workspaceId !== workspaceId) throw authoringError(404, 'UNKNOWN_CONTEXT', 'Unknown authoring context.');
      if (snapshot.expiresAt <= now) throw authoringError(410, 'CONTEXT_EXPIRED', 'The authoring context expired.');
      const workspace = await readWorkspace(deps, workspaceId);
      if ((workspace.metadata?.revision ?? 0) !== expectedRevision) throw authoringError(409, 'REVISION_CONFLICT', 'The workspace revision does not match expectedRevision.');
      if (snapshot.revision !== expectedRevision) throw authoringError(409, 'CONTEXT_CHANGED', 'The authoring context was taken at a different revision.');
      const fresh = buildContext(workspace, snapshot.screenIds, clock(deps));
      if (fresh.digest !== snapshot.digest) throw authoringError(409, 'CONTEXT_CHANGED', 'The saved workspace no longer matches this context snapshot.');
      return snapshot;
    },
  };
}

export function publicContext(snapshot: ContextSnapshot) {
  return {
    contextId: snapshot.id,
    workspaceId: snapshot.workspaceId,
    revision: snapshot.revision,
    expiresAt: new Date(snapshot.expiresAt).toISOString(),
    contractVersion: CONTRACT_VERSION,
    ...snapshot.publicBody,
  };
}

export async function readWorkspace(deps: AuthoringDeps, id: string) {
  try { return await deps.read(id); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || (error instanceof Error && /unreadable workspace|Invalid workspace/i.test(error.message))) throw authoringError(404, 'UNKNOWN_WORKSPACE', 'Unknown workspace.');
    throw error;
  }
}
