import {randomUUID} from 'node:crypto';
import {parseAllDocuments} from 'yaml';
import {authoredChecks, backControl, checkLabel, isAuthored, tapLabel, writeChecks} from '../../shared/canvas-authoring.js';
import {projectCanvasRoute} from '../canvas-route.js';
import {referenceCatalog, type CanvasGraph, type CanvasTest} from '../canvas.js';
import {selectScenario} from '../scenario-definitions.js';
import {buildRunPlan, canvasOperationFingerprints, canvasScriptAnchors} from '../run-script-plan.js';
import type {Workspace} from '../scenarios.js';
import type {ScenarioDefinition} from '../scenario-definitions.js';
import {validateDraft} from './validate.js';
import {blocksApply, issue, runReadiness, type ContextSnapshot, type Diagnostic, type DraftOperation, type EntityRef, type FlowDraft, type Preview, type TimelineEntry} from './types.js';

const emptyGraph: CanvasGraph = {screens: [], edges: [], paths: []};

export type Translation = {
  diagnostics: Diagnostic[];
  applicable: boolean;
  authoringComplete: boolean;
  runReadiness: Preview['runReadiness'];
  requiredAssumptionKeys: string[];
  changes: Preview['changes'];
  identityMap: Record<string, EntityRef>;
  timeline: TimelineEntry[];
  proposed?: Workspace;
  scriptIds: string[];
};

function unresolvedAuthoring(diagnostics: readonly Diagnostic[]) {
  return diagnostics.some(item => item.severity === 'error' && (item.code === 'UNRESOLVED_TARGET' || item.code === 'UNRESOLVED_VALUE'));
}

function finish(draft: FlowDraft, diagnostics: Diagnostic[], extra: Partial<Translation> = {}): Translation {
  const applicable = !blocksApply(diagnostics);
  return {
    diagnostics,
    applicable,
    authoringComplete: applicable && !unresolvedAuthoring(diagnostics),
    runReadiness: runReadiness(diagnostics),
    requiredAssumptionKeys: draft.assumptions.filter(item => item.requiresConfirmation).map(item => item.key),
    changes: extra.changes ?? {created: [], reused: [], updated: []},
    identityMap: extra.identityMap ?? {},
    timeline: extra.timeline ?? symbolicTimeline(draft),
    scriptIds: extra.scriptIds ?? [],
    ...(applicable && extra.proposed ? {proposed: extra.proposed} : {}),
  };
}

function symbolicTimeline(draft: FlowDraft): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  if (draft.execution.setup.kind === 'launchApp') timeline.push({kind: 'system', label: 'Launch app'});
  else timeline.push({kind: 'system', label: 'Setup'});
  for (const handler of draft.execution.handlerRefs) timeline.push({kind: 'system', label: `Handler · ${handler}`});
  let ordinal = 0;
  for (const visit of draft.visits) for (const operation of visit.operations) {
    for (const script of draft.scripts) if (script.placement.kind === 'beforeOperation' && script.placement.visitKey === visit.key && script.placement.operationKey === operation.key) {
      timeline.push({kind: 'runScript', scriptKey: script.key, anchorOrdinal: ordinal, atEnd: false, trust: 'required'});
    }
    timeline.push({kind: 'uiOperation', visitKey: visit.key, operationKey: operation.key, ordinal});
    ordinal++;
  }
  for (const script of draft.scripts) if (script.placement.kind === 'scenarioEnd') timeline.push({kind: 'runScript', scriptKey: script.key, anchorOrdinal: ordinal, atEnd: true, trust: 'required'});
  return timeline;
}

function commandName(value: unknown) {
  return typeof value === 'string' ? value : value && typeof value === 'object' ? Object.keys(value)[0] ?? '' : '';
}

function placeScreens(existing: {x: number; y: number}[], count: number) {
  const width = 260;
  const height = 180;
  const occupied = existing.map(item => ({...item}));
  const placed: {x: number; y: number}[] = [];
  const hit = (x: number, y: number) => occupied.some(box => x < box.x + width && x + width > box.x && y < box.y + height && y + height > box.y);
  for (let y = 40; y <= 1400 && placed.length < count; y += height) {
    for (let x = 40; x <= 2400 && placed.length < count; x += width) {
      if (hit(x, y)) continue;
      const point = {x, y};
      placed.push(point);
      occupied.push(point);
    }
  }
  return placed;
}

export function compileDraft(workspace: Workspace, draft: FlowDraft, context: ContextSnapshot): Translation {
  const diagnostics = validateDraft(draft, workspace, context);
  if (blocksApply(diagnostics)) return finish(draft, diagnostics);
  try { return materialize(workspace, draft, context, diagnostics); }
  catch (error) {
    diagnostics.push(issue('PROJECTION_FAILED', '', 'error', ['apply', 'run'], error instanceof Error ? error.message : 'The draft could not be projected.', 'Repair the draft and preview again.'));
    return finish(draft, diagnostics);
  }
}

function materialize(workspace: Workspace, draft: FlowDraft, context: ContextSnapshot, diagnostics: Diagnostic[]): Translation {
  const scenarioId = 'scenario-' + randomUUID();
  const pathId = 'path-' + randomUUID();
  const screenIds = new Map(draft.screens.map(screen => [screen.key, screen.kind === 'existing' ? screen.screenId : 'screen-' + randomUUID()]));
  const visitIds = new Map(draft.visits.map(visit => [visit.key, randomUUID()]));
  const operationIds = new Map<string, string>();
  for (const visit of draft.visits) for (const operation of visit.operations) operationIds.set(operation.key, 'op-' + randomUUID());
  const scriptIds = new Map(draft.scripts.map(script => [script.key, 'script-' + randomUUID()]));
  const canvas: CanvasGraph = structuredClone(workspace.canvas ?? emptyGraph);
  delete canvas.execution;
  const createOrder: string[] = [];
  for (const visit of draft.visits) {
    const screen = draft.screens.find(item => item.key === visit.screenKey);
    if (screen?.kind === 'create' && !createOrder.includes(screen.key)) createOrder.push(screen.key);
  }
  const spots = placeScreens(canvas.screens.map(screen => ({x: screen.x, y: screen.y})), createOrder.length);
  if (spots.length < createOrder.length) {
    diagnostics.push(issue('CAPACITY_EXCEEDED', '/screens', 'error', ['apply', 'run'], 'There is no free canvas space for the new screens.', 'Move existing screens or remove one. Authoring does not move existing nodes.'));
    return finish(draft, diagnostics);
  }
  createOrder.forEach((key, index) => {
    const declared = draft.screens.find(screen => screen.key === key);
    canvas.screens.push({id: screenIds.get(key)!, title: declared && declared.kind === 'create' ? declared.title.trim() : key, x: spots[index].x, y: spots[index].y, tests: []});
  });

  const tests: CanvasTest[] = [];
  const operationOrder: {visitKey: string; operationKey: string; testId: string; ordinal: number}[] = [];
  let ordinal = 0;
  for (const visit of draft.visits) {
    const screen = canvas.screens.find(item => item.id === screenIds.get(visit.screenKey));
    if (!screen) throw new Error(`Missing screen for visit ${visit.key}.`);
    for (const operation of visit.operations) {
      const testId = operationIds.get(operation.key)!;
      const test = canvasTest(operation, testId, scenarioId, context);
      screen.tests.push(test);
      tests.push(test);
      operationOrder.push({visitKey: visit.key, operationKey: operation.key, testId, ordinal});
      ordinal++;
    }
  }
  const edgeIds: string[] = [];
  for (let index = 0; index < draft.visits.length - 1; index++) {
    const visit = draft.visits[index];
    const next = draft.visits[index + 1];
    const navigating = visit.operations[visit.operations.length - 1];
    if (!navigating || (navigating.kind !== 'tap' && navigating.kind !== 'back')) throw new Error('Missing navigating operation.');
    const edgeId = 'edge-' + randomUUID();
    edgeIds.push(edgeId);
    const from = screenIds.get(visit.screenKey)!;
    const to = screenIds.get(next.screenKey)!;
    const fromTitle = canvas.screens.find(screen => screen.id === from)?.title ?? visit.screenKey;
    const toTitle = canvas.screens.find(screen => screen.id === to)?.title ?? next.screenKey;
    canvas.edges.push({id: edgeId, from, to, actionTestId: operationIds.get(navigating.key)!, actionTestIds: [operationIds.get(navigating.key)!], assertionTestId: 'pending:' + edgeId, responseCondition: `${fromTitle} → ${toTitle}`.slice(0, 300)});
  }
  canvas.paths.push({
    id: pathId, name: draft.name.trim().slice(0, 120), scenarioId, screenId: screenIds.get(draft.visits[0].screenKey), edgeIds,
    visits: draft.visits.map(visit => ({id: visitIds.get(visit.key)!, operationIds: visit.operations.map(operation => operationIds.get(operation.key)!)}))
  });

  let yaml = workspace.yaml;
  if (tests.length) yaml = writeChecks(yaml, emptyGraph, {screens: [{id: 'authoring-new', title: 'Authoring', x: 0, y: 0, tests}], edges: [], paths: []});
  const catalog = referenceCatalog(yaml, workspace.flows ?? {}).references;
  const created = new Set(tests.map(test => test.id));
  for (const mark of authoredChecks(yaml)) {
    if (!mark.id || !created.has(mark.id)) continue;
    const test = tests.find(item => item.id === mark.id);
    const reference = catalog.find(entry => entry.kind === 'step' && entry.index === mark.index);
    if (!test || !reference) throw new Error('Authored command is missing a fingerprint.');
    test.reference = {kind: 'step', file: 'flow.yaml', index: mark.index, fingerprint: reference.fingerprint};
  }
  // An empty selector or input is kept for later editing. writeChecks skips it, so its fingerprint stays `draft`.
  // A real selector that was not emitted still fails here.
  const deferred = new Set(tests.filter(test => test.reference.fingerprint === 'draft' && unwrittenEmpty(test)).map(test => test.id));
  if (tests.some(test => test.reference.fingerprint === 'draft' && !deferred.has(test.id))) throw new Error('An operation was not written into the scenario YAML.');
  if (Buffer.byteLength(yaml) > 100_000) {
    diagnostics.push(issue('CAPACITY_EXCEEDED', '', 'error', ['apply', 'run'], 'The resulting scenario YAML exceeds 100 KB.', 'Shorten the draft. Source and steps are not truncated.'));
    return finish(draft, diagnostics, identity(draft, scenarioId, pathId, screenIds, visitIds, operationIds, scriptIds));
  }

  const setup = draft.execution.setup.kind === 'context' ? context.setups[draft.execution.setup.ref] : undefined;
  const mock = draft.execution.mock.kind === 'context' ? context.mocks[draft.execution.mock.ref] : undefined;
  const scenario: ScenarioDefinition = {
    id: scenarioId, name: draft.name.trim(), authoring: 'canvas', pathId, steps: [], inputs: {},
    parameters: Object.fromEntries(draft.parameters.map(parameter => [parameter.name, {type: parameter.type, required: parameter.required}])),
    enabledHandlerIds: [...draft.execution.handlerRefs],
    ...(setup ? {setup: {file: setup.file, parameters: {...setup.parameters}}} : {}),
    ...(mock ? {mockResponseId: mock.responseId} : {}),
  };
  const {metadata, canvasDiagnostics, ...rest} = workspace;
  void metadata; void canvasDiagnostics;
  const proposed: Workspace = {...structuredClone(rest), id: workspace.id, yaml, canvas, scenarios: [...(rest.scenarios ?? []), scenario]};
  const runtime = Object.fromEntries(Object.entries(scenario.parameters).map(([name, rule]) => [name, rule.type === 'number' ? '0' : rule.type === 'boolean' ? 'true' : 'preview']));
  const selection = selectScenario(structuredClone(proposed), scenarioId, runtime, []);
  if (!selection?.canvas || !selection.scenario.pathId) throw new Error('The draft scenario could not be selected.');
  // Plain steps are not executable commands. Project the route without them; the saved canvas still holds them.
  const projecting = deferred.size ? graphForProjection(selection.canvas, deferred) : selection.canvas;
  const projection = projectCanvasRoute(projecting, selection.yaml, proposed.flows ?? {}, selection.scenario.pathId, selection.automation);
  const anchorSteps = canvasScriptAnchors(projection.canvas.execution) ?? [];
  const projectedIds = projection.canvas.execution?.occurrences.filter(item => item.reference.kind === 'step').map(item => item.testId) ?? [];
  if (deferred.size === 0) {
    if (projectedIds.join('\0') !== operationOrder.map(item => item.testId).join('\0') || anchorSteps.length !== operationOrder.length) throw new Error('Projected operation order does not match the draft.');
    const authoredFingerprints = canvasOperationFingerprints(canvas, pathId);
    if (authoredFingerprints.length !== anchorSteps.length || authoredFingerprints.some((fingerprint, index) => fingerprint !== anchorSteps[index]?.fingerprint)) throw new Error('Projected anchor fingerprints do not match the authored operations.');
  } else {
    const path = projecting.paths.find(item => item.id === selection.scenario.pathId);
    const onPath = new Set(path?.visits?.flatMap(visit => visit.operationIds ?? []) ?? []);
    const expected = operationOrder.filter(item => onPath.has(item.testId));
    if (projectedIds.join('\0') !== expected.map(item => item.testId).join('\0')) throw new Error('Projected operation order does not match the draft.');
    if (anchorSteps.length !== expected.length || anchorSteps.some((step, index) => step.fingerprint !== tests.find(item => item.id === expected[index].testId)?.reference.fingerprint)) throw new Error('Projected anchor fingerprints do not match the authored operations.');
  }

  const ordinalOf = new Map(operationOrder.map(item => [`${item.visitKey}\0${item.operationKey}`, item.ordinal]));
  const scriptAnchors = deferred.size
    ? operationOrder.map(item => {
      const test = tests.find(entry => entry.id === item.testId)!;
      return {index: test.reference.index ?? item.ordinal, fingerprint: test.reference.fingerprint};
    })
    : anchorSteps;
  const endFingerprint = scriptAnchors.length ? scriptAnchors[scriptAnchors.length - 1].fingerprint + ':end' : 'end';
  scenario.scripts = draft.scripts.map(script => {
    const beforeStep = script.placement.kind === 'scenarioEnd'
      ? {index: scriptAnchors.length, fingerprint: endFingerprint}
      : {index: ordinalOf.get(`${script.placement.visitKey}\0${script.placement.operationKey}`)!, fingerprint: scriptAnchors[ordinalOf.get(`${script.placement.visitKey}\0${script.placement.operationKey}`)!].fingerprint};
    return {id: scriptIds.get(script.key)!, label: script.label, source: script.source, beforeStep};
  });
  if (!scenario.scripts.length) delete scenario.scripts;
  const planYaml = deferred.size ? selection.yaml : projection.yaml;
  const blocked = buildRunPlan({yaml: planYaml, flows: proposed.flows, scripts: scenario.scripts, trust: [], anchorSteps: scriptAnchors}).blocked.filter(item => item.kind !== 'untrusted' && !(deferred.size > 0 && item.kind === 'draft-anchor'));
  if (blocked.length) throw new Error(blocked.map(item => `${item.kind}: ${item.message}`).join('; '));

  const retainedSource = deferred.size ? selection.yaml : projection.yaml;
  const commands = parseAllDocuments(retainedSource)[1].toJS() as unknown[];
  const covered = new Set<number>();
  if (deferred.size) {
    for (const test of tests) if (test.reference.fingerprint !== 'draft' && typeof test.reference.index === 'number') covered.add(test.reference.index);
  } else {
    for (const index of (projection.canvas.execution?.occurrences ?? []).map(item => item.reference.index)) if (typeof index === 'number') covered.add(index);
  }
  const retained: string[] = [];
  commands.forEach((command, index) => {
    if (covered.has(index)) return;
    const name = commandName(command);
    if (name !== 'launchApp') retained.push(name || 'command');
  });
  if (retained.length) diagnostics.push(issue('UNSUPPORTED_SHARED_YAML', '', 'error', ['apply', 'run'], `Selected projection would retain undeclared executable work: ${retained.join(', ')}.`, 'Authoring cannot isolate this scenario from existing YAML. Remove or link that YAML before applying.'));
  const timeline = timelineFrom(draft, operationOrder, setup?.file, retained);
  const mapped = identity(draft, scenarioId, pathId, screenIds, visitIds, operationIds, scriptIds);
  if (Buffer.byteLength(JSON.stringify({flows: proposed.flows, mock: proposed.mock, canvas, automation: proposed.automation, scenarios: proposed.scenarios})) > 900_000) {
    diagnostics.push(issue('CAPACITY_EXCEEDED', '', 'error', ['apply', 'run'], 'The resulting workspace exceeds the 900 KB authoring limit.', 'Reduce screenshots or reusable flows before applying.'));
  }
  return finish(draft, diagnostics, {...mapped, timeline, proposed, scriptIds: [...scriptIds.values()]});
}

function canvasTest(operation: DraftOperation, id: string, scenarioId: string, context: ContextSnapshot): CanvasTest {
  const reference = {kind: 'step' as const, file: 'flow.yaml', index: 0, fingerprint: 'draft'};
  const base = {id, scenarioIds: [scenarioId], reference};
  if (operation.kind === 'input') {
    if (operation.value.kind === 'unresolved') return {...base, role: 'action', label: 'Input', input: ''};
    const text = operation.value.kind === 'literal' ? operation.value.text : `\${${operation.value.name}}`;
    return {...base, role: 'action', label: `Input text · ${text}`, input: text};
  }
  if (operation.target.kind === 'unresolved') {
    const empty = {target: 'text' as const, match: 'exact' as const, value: ''};
    if (operation.kind === 'checkVisible' || operation.kind === 'checkAbsent') {
      return {...base, role: 'assertion' as const, label: 'Check', check: {...empty, visibility: operation.kind === 'checkVisible' ? 'visible' as const : 'absent' as const}};
    }
    if (operation.kind === 'back') return {...base, role: 'action' as const, label: 'Back', back: true, backSelector: {...empty}};
    return {...base, role: 'action' as const, label: 'Tap', tap: {...empty}};
  }
  const selector = operation.target.kind === 'selector' ? operation.target.selector : context.targets[operation.target.ref].selector;
  if (!selector) throw new Error(`Missing selector for ${operation.key}.`);
  if (operation.kind === 'checkVisible' || operation.kind === 'checkAbsent') {
    const check = {...selector, visibility: operation.kind === 'checkVisible' ? 'visible' as const : 'absent' as const};
    return {...base, role: 'assertion', label: checkLabel(check), check};
  }
  if (operation.kind === 'back') return {...base, role: 'action', label: 'Back', back: true, backSelector: {...selector}};
  return {...base, role: 'action', label: tapLabel(selector), tap: {...selector}};
}

function unwrittenEmpty(test: CanvasTest) {
  if (!isAuthored(test) || test.input === '') return true;
  const selector = test.check ?? test.tap ?? backControl(test);
  return selector !== undefined && selector.value.trim() === '';
}

/** Drops steps writeChecks could not emit, and any transition that depends on one, so the existing route projection can run. */
function graphForProjection(source: CanvasGraph, deferred: ReadonlySet<string>): CanvasGraph {
  const graph = structuredClone(source);
  for (const screen of graph.screens) screen.tests = screen.tests.filter(test => !deferred.has(test.id));
  for (const path of graph.paths) {
    for (const visit of path.visits ?? []) {
      if (visit.operationIds) visit.operationIds = visit.operationIds.filter(id => !deferred.has(id));
    }
    const kept: string[] = [];
    let from = path.screenId;
    for (const edgeId of path.edgeIds) {
      const edge = graph.edges.find(item => item.id === edgeId);
      const actions = edge ? (edge.actionTestIds ?? [edge.actionTestId]) : [];
      const present = actions.every(id => graph.screens.some(screen => screen.tests.some(test => test.id === id)));
      if (!edge || (from !== undefined && edge.from !== from) || actions.some(id => deferred.has(id)) || !present) break;
      kept.push(edgeId);
      from = edge.to;
    }
    path.edgeIds = kept;
    if (path.visits && path.visits.length > kept.length + 1) path.visits = path.visits.slice(0, kept.length + 1);
  }
  return graph;
}

function timelineFrom(draft: FlowDraft, operations: {visitKey: string; operationKey: string; ordinal: number}[], setupFile: string | undefined, retained: string[]): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  if (draft.execution.setup.kind === 'launchApp') timeline.push({kind: 'system', label: 'Launch app'});
  if (setupFile) timeline.push({kind: 'system', label: `Setup · ${setupFile}`});
  for (const handler of draft.execution.handlerRefs) timeline.push({kind: 'system', label: `Handler · ${handler}`});
  for (const name of retained) timeline.push({kind: 'system', label: `Unassociated · ${name}`});
  for (const operation of operations) {
    for (const script of draft.scripts) if (script.placement.kind === 'beforeOperation' && script.placement.visitKey === operation.visitKey && script.placement.operationKey === operation.operationKey) {
      timeline.push({kind: 'runScript', scriptKey: script.key, anchorOrdinal: operation.ordinal, atEnd: false, trust: 'required'});
    }
    timeline.push({kind: 'uiOperation', visitKey: operation.visitKey, operationKey: operation.operationKey, ordinal: operation.ordinal});
  }
  const end = operations.length;
  for (const script of draft.scripts) if (script.placement.kind === 'scenarioEnd') timeline.push({kind: 'runScript', scriptKey: script.key, anchorOrdinal: end, atEnd: true, trust: 'required'});
  return timeline;
}

function identity(draft: FlowDraft, scenarioId: string, pathId: string, screenIds: Map<string, string>, visitIds: Map<string, string>, operationIds: Map<string, string>, scriptIds: Map<string, string>): Pick<Translation, 'changes' | 'identityMap'> {
  const identityMap: Record<string, EntityRef> = {};
  const created: EntityRef[] = [{kind: 'scenario', id: scenarioId}, {kind: 'path', id: pathId}];
  const reused: EntityRef[] = [];
  for (const screen of draft.screens) {
    const id = screenIds.get(screen.key)!;
    identityMap[screen.key] = {kind: 'screen', id};
    if (screen.kind === 'create') created.push({kind: 'screen', id});
    else reused.push({kind: 'screen', id});
  }
  for (const visit of draft.visits) {
    const id = visitIds.get(visit.key)!;
    identityMap[visit.key] = {kind: 'visit', id};
    created.push({kind: 'visit', id});
    for (const operation of visit.operations) {
      const operationId = operationIds.get(operation.key)!;
      identityMap[operation.key] = {kind: 'operation', id: operationId};
      created.push({kind: 'operation', id: operationId});
    }
  }
  for (const script of draft.scripts) {
    const id = scriptIds.get(script.key)!;
    identityMap[script.key] = {kind: 'script', id};
    created.push({kind: 'script', id});
  }
  return {identityMap, changes: {created, reused, updated: []}};
}
