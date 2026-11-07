import type {Run} from '../server/scenarios.js';
import type {Batch} from '../server/batches.js';
import type {CanvasTest} from '../server/canvas.js';
import {routeVisits, visitScreenId} from '../shared/canvas-authoring.js';
import {screenNodeSteps} from './canvas-node-steps.js';
import {evidenceScrubFailed, SCRUB_FAILED_TEXT} from './run-script.js';

export type ResultCheck = {status: string; text: string; cause: string};
export type ResultRow = {visitId: string; name: string; status: string; word: string; hint: string; checks: ResultCheck[]};
export type ResultModel = {
  title: string;
  scrub: boolean;
  confidential: boolean;
  running: boolean;
  status: string;
  statusText: string;
  cause: string;
  counts: string;
  rows: ResultRow[];
  thumbnail?: string;
  log: string;
};

const strip = (text: string) => text.replace(/^\d+\s*·\s*/, '');

export function formatDuration(startedAt?: string, finishedAt?: string, now = Date.now()) {
  if (!startedAt) return '';
  const end = finishedAt ? Date.parse(finishedAt) : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  if (!finishedAt && seconds <= 0) return '0 s';
  if (finishedAt && seconds <= 0) return '<1 s';
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function formatClock(iso?: string) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

function testsOf(run: Run) {
  return new Map((run.snapshot.canvas?.screens ?? []).flatMap(screen => screen.tests.map(test => [test.id, test] as const)));
}

function confidential(run: Run) {
  return /confidential inputs/i.test(run.snapshot.runtimeInputPolicy) || /withheld for confidential/i.test(run.error ?? '');
}

function causeFor(test: CanvasTest | undefined) {
  if (!test) return '';
  if (test.check) {
    const value = test.check.value;
    return test.check.visibility === 'absent' ? `“${value}” was still on screen.` : `“${value}” wasn't on screen.`;
  }
  if (test.tap) return `Couldn't find “${test.tap.value}” to tap.`;
  if (test.back) return "Couldn't go back.";
  if (test.input !== undefined) return "Couldn't type into the field.";
  return '';
}

function statusText(run: Run, failedAt: string) {
  switch (run.status) {
    case 'passed': return 'Checks passed';
    case 'running': return 'Running…';
    case 'cancelled': return 'Stopped';
    case 'setup-error': return 'Setup failed';
    case 'handler-error': return 'Default action failed';
    case 'script-error': return 'Script failed';
    case 'tool-error':
    case 'error': return "Couldn't finish";
    case 'assertion-failed':
    case 'path-failed': return failedAt ? `Failed at ${failedAt}` : 'Failed';
    default: return run.status;
  }
}

export function resultModel(run: Run, now = Date.now()): ResultModel {
  const scrub = evidenceScrubFailed(run);
  const title = run.snapshot.scenario?.name ?? run.snapshot.name;
  const hidden = confidential(run);
  const graph = run.snapshot.canvas;
  const path = graph?.paths.find(item => item.id === (run.canvas?.pathId ?? run.snapshot.canvasPathId));
  const tests = testsOf(run);
  const occurrences = run.canvas?.occurrences ?? [];
  const failed = occurrences.find(item => item.status === 'failed');
  const failedVisit = run.canvas?.visits?.find(item => item.id === failed?.visitId);
  const failedScreen = graph?.screens.find(screen => screen.id === failedVisit?.screenId)?.title ?? '';
  const plain = causeFor(tests.get(failed?.testId ?? ''));
  const cause = scrub
    ? SCRUB_FAILED_TEXT.replace(/^✕\s*/, '')
    : hidden
      ? 'Details are hidden because this run used confidential inputs.'
      : plain || (run.error && !/Runner command reported|COMPLETED|FAILED/.test(run.error) ? run.error : '') || (run.status === 'passed' || run.status === 'running' ? '' : 'See the run log for details.');
  const checks = occurrences.filter(item => tests.get(item.testId)?.check);
  const passedChecks = checks.filter(item => item.status === 'passed').length;
  const duration = formatDuration(run.startedAt, run.status === 'running' ? undefined : run.finishedAt, now);
  const counts = !scrub && !hidden && run.canvas && checks.length ? `${passedChecks} of ${checks.length} checks passed · ${duration}` : '';
  const rows: ResultRow[] = !graph || !path || scrub || run.status === 'running' ? [] : (run.canvas?.visits ?? []).map(visit => {
    const screen = graph.screens.find(item => item.id === visit.screenId);
    const own = occurrences.filter(item => item.visitId === visit.id);
    const failedCount = own.filter(item => item.status === 'failed').length;
    const labels = screen ? screenNodeSteps(graph, path, screen.id).filter(step => step.visit === (run.canvas?.visits ?? []).findIndex(item => item.id === visit.id)).map(step => strip(step.text)) : [];
    const word = visit.status === 'passed' ? 'Passed' : visit.status === 'failed' ? 'Failed' : 'Not run';
    const hint = visit.status === 'failed' ? `${failedCount} of ${own.length} failed` : visit.status === 'passed' ? `${own.length} steps` : 'Not run';
    return {
      visitId: visit.id,
      name: screen?.title ?? visit.screenId,
      status: visit.status,
      word,
      hint,
      checks: visit.status === 'failed' ? own.map((item, index) => ({status: item.status, text: labels[index] || tests.get(item.testId)?.label || 'Check', cause: item.status === 'failed' ? causeFor(tests.get(item.testId)) : ''})) : [],
    };
  });
  const runningNames = run.status === 'running' && graph && path ? routeVisits(graph, path).map((_, index) => graph.screens.find(screen => screen.id === visitScreenId(graph, path, index))?.title ?? '') : [];
  const runningRows: ResultRow[] = runningNames.map(name => ({visitId: name, name, status: '', word: '', hint: '', checks: []}));
  const step = run.steps.find(item => item.id === failed?.stepId);
  const png = step?.artifacts?.find(name => name.endsWith('.png')) ?? [...run.artifacts].reverse().find(name => name.endsWith('.png'));
  return {
    title,
    scrub,
    confidential: hidden,
    running: run.status === 'running',
    status: run.status,
    statusText: scrub ? "Couldn't finish" : statusText(run, failedScreen),
    cause,
    counts: run.status === 'running' ? '' : counts,
    rows: run.status === 'running' ? runningRows : rows,
    thumbnail: scrub || hidden || run.status === 'running' ? undefined : png,
    log: hidden ? '' : run.log,
  };
}

export function dotKind(run?: Run, batch?: Batch): '' | 'ok' | 'bad' | 'run' | 'warn' {
  const batchFirst = !!batch && (!run || batch.startedAt >= run.startedAt);
  if (batchFirst && batch) {
    if (batch.status === 'running' || batch.status === 'cancelling') return 'run';
    if (batch.entries.some(entry => /fail|error/.test(entry.status))) return 'bad';
    if (batch.entries.length && batch.entries.every(entry => entry.status === 'passed')) return 'ok';
    return '';
  }
  if (!run) return '';
  if (run.status === 'running') return 'run';
  if (run.status === 'passed') return 'ok';
  if (evidenceScrubFailed(run) || run.status === 'error' || run.status === 'tool-error') return 'warn';
  if (run.status === 'cancelled') return '';
  return 'bad';
}

export function failingVisitId(model: ResultModel) {
  return model.rows.find(row => row.status === 'failed')?.visitId;
}
