import {parseAllDocuments} from 'yaml';
import {isAuthored, routeVisits, visitOperations, visitScreenId} from '../../shared/canvas-authoring.js';
import {projectCanvasRoute} from '../canvas-route.js';
import type {CanvasGraph, CanvasTest} from '../canvas.js';
import {canvasOperationFingerprints} from '../run-script-plan.js';
import {scriptHash} from '../script-trust-store.js';
import {readWorkspace} from './context.js';
import {authoringError} from './errors.js';
import {requireWorkspaceId} from './schema.js';
import {CONTRACT_VERSION, issue, type AuthoringDeps, type Diagnostic} from './types.js';

function appIdOf(yaml: string) {
  try {
    const value = parseAllDocuments(yaml)[0]?.toJS() as {appId?: unknown} | undefined;
    return typeof value?.appId === 'string' ? value.appId : '';
  } catch { return ''; }
}

function commandOf(test: CanvasTest) {
  if (test.check) return test.check.visibility === 'visible' ? 'checkVisible' : 'checkAbsent';
  if (test.back) return 'back';
  if (test.tap) return 'tap';
  if (test.input !== undefined) return 'input';
  return 'legacy';
}

function ordered(graph: CanvasGraph, pathId: string) {
  const path = graph.paths.find(item => item.id === pathId);
  if (!path?.screenId) return [];
  const steps: {id: string; visitId: string; fingerprint: string; test: CanvasTest}[] = [];
  routeVisits(graph, path).forEach((visit, index) => {
    const screen = graph.screens.find(item => item.id === visitScreenId(graph, path, index));
    for (const id of visitOperations(graph, path, index)) {
      const test = screen?.tests.find(item => item.id === id);
      if (!test || test.role === 'setup' || test.role === 'handler' || test.reference.kind !== 'step') continue;
      steps.push({id, visitId: visit.id, fingerprint: test.reference.fingerprint, test});
    }
  });
  return steps;
}

function anchorMatches(anchor: {index: number; fingerprint: string}, steps: {fingerprint: string}[]) {
  if (!steps.length) return anchor.index === 0 && anchor.fingerprint === 'end';
  if (anchor.index === steps.length) return anchor.fingerprint === steps[steps.length - 1].fingerprint + ':end';
  return steps[anchor.index]?.fingerprint === anchor.fingerprint;
}

export async function readFlow(deps: AuthoringDeps, input: {workspaceId?: string; scenarioId: string}) {
  const workspaceId = requireWorkspaceId(input.workspaceId);
  const workspace = await readWorkspace(deps, workspaceId);
  const scenario = workspace.scenarios?.find(item => item.id === input.scenarioId);
  if (!scenario) throw authoringError(404, 'UNKNOWN_SCENARIO', 'Unknown scenario.');
  const trust = await deps.listTrust(workspace);
  const unsupported = new Set<string>();
  if (scenario.authoring !== 'canvas') unsupported.add('not-canvas-authored');
  const graph = workspace.canvas;
  const path = graph?.paths.find(item => item.id === scenario.pathId);
  if (!graph || !path) unsupported.add('missing-canvas-path');
  if (path && routeVisits(graph!, path).some(visit => visit.operationIds === undefined)) unsupported.add('implicit-visit-order');
  const steps = graph && scenario.pathId ? ordered(graph, scenario.pathId) : [];
  if (steps.some(step => !isAuthored(step.test) || commandOf(step.test) === 'legacy')) unsupported.add('legacy-operation');
  if (graph && path) {
    try {
      const projection = projectCanvasRoute(structuredClone(graph), workspace.yaml, workspace.flows ?? {}, path.id, workspace.automation);
      const commands = parseAllDocuments(projection.yaml)[1].toJS() as unknown[];
      const covered = new Set((projection.canvas.execution?.occurrences ?? []).map(item => item.reference.index).filter((index): index is number => typeof index === 'number'));
      const stray = commands.some((command, index) => !covered.has(index) && commandName(command) !== 'launchApp');
      if (stray) unsupported.add('unassociated-yaml');
    } catch { unsupported.add('projection-failed'); }
  }
  const fingerprints = graph && scenario.pathId ? canvasOperationFingerprints(graph, scenario.pathId) : [];
  const diagnostics: Diagnostic[] = [];
  const scripts = (scenario.scripts ?? []).map(row => {
    const hash = scriptHash(row.source);
    const approval = trust.find(item => item.rowId === row.id && item.hash === hash);
    const current = approval ?? {rowId: row.id, origin: 'imported' as const, trusted: false, hash};
    if (!current.trusted) diagnostics.push(issue('SCRIPT_TRUST_REQUIRED', '', 'warning', ['run'], 'Script needs trust before it can run.', 'Review the saved source and trust it in the existing script trust UI.', row.id));
    if (!anchorMatches(row.beforeStep, fingerprints.map(fingerprint => ({fingerprint})))) diagnostics.push(issue('STALE_ANCHOR', '', 'warning', ['run'], 'Script anchor no longer matches the authored steps.', 'Relink the script. End anchors do not slide forward.', row.id));
    return {id: row.id, label: row.label, source: row.source, anchor: row.beforeStep, trust: {origin: current.origin, trusted: current.trusted, hash: current.hash}};
  });
  for (const [name, rule] of Object.entries(scenario.parameters)) if (rule.required && !scenario.inputs[name]?.trim()) diagnostics.push(issue('RUNTIME_INPUT_REQUIRED', '', 'warning', ['run'], `${name} must be supplied before a run.`, 'Enter the value in the existing run controls.', name));
  return {
    contractVersion: CONTRACT_VERSION,
    workspaceId,
    scenarioId: scenario.id,
    revision: workspace.metadata?.revision ?? 0,
    summary: {name: scenario.name, appId: appIdOf(workspace.yaml), visits: path ? routeVisits(graph!, path).length : 0, operations: steps.length, scripts: scripts.length},
    operations: steps.map((step, ordinal) => ({ordinal, visitId: step.visitId, operationId: step.id, label: step.test.label, command: commandOf(step.test)})),
    scripts,
    diagnostics,
    editableAsV1: unsupported.size === 0,
    unsupportedFeatures: [...unsupported],
  };
}

function commandName(value: unknown) {
  return typeof value === 'string' ? value : value && typeof value === 'object' ? Object.keys(value)[0] ?? '' : '';
}
