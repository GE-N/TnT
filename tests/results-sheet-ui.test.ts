import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement} from 'react';
import type {Run} from '../server/scenarios.js';
import {ResultsSheet} from '../src/results-sheet.js';

function run(patch: Partial<Run> = {}): Run {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    deviceId: 'device',
    startedAt: '2026-11-07T02:00:00.000Z',
    finishedAt: '2026-11-07T02:00:04.000Z',
    status: 'passed',
    mappingNote: 'mapped',
    log: 'ordinary log',
    artifacts: ['flow.yaml', 'screenshot-failure.png'],
    cleanup: {verified: true, detail: 'clean'},
    steps: [{id: 's1', command: 'launchApp', status: 'passed'}],
    snapshot: {
      id: 'snap', workspaceId: 'ws', name: 'Guest checkout', yaml: 'appId: example\n---\n- launchApp\n', steps: [],
      toolVersions: {maestro: '2.11.0', node: '22'}, runtimeInputPolicy: 'No runtime inputs supplied.',
      scenario: {id: 'scenario-guest', name: 'Guest checkout', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []},
      canvas: {screens: [{id: 'home', title: 'Home', x: 0, y: 0, tests: [{id: 'check', label: 'Home', role: 'assertion', reference: {kind: 'step', file: 'flow.yaml', fingerprint: 'draft'}, check: {visibility: 'visible', target: 'text', match: 'exact', value: 'Welcome'}}]}], edges: [], paths: [{id: 'route', name: 'Guest', screenId: 'home', edgeIds: []}]},
    },
    canvas: {pathId: 'route', note: '', tests: [{id: 'check', status: 'passed', detail: 'Welcome'}], screens: [], edges: [], visits: [{id: 'v1', screenId: 'home', status: 'passed', checkIds: ['check']}], occurrences: [{id: 'o1', visitId: 'v1', testId: 'check', status: 'passed', detail: 'Welcome'}]},
    ...patch,
  } as Run;
}

async function render(props: Record<string, unknown>) {
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'HTMLElement', 'Node', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys) Object.defineProperty(globalThis, key, {value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(dom.window, key), configurable: true});
  Object.defineProperty(globalThis, 'fetch', {value: async () => new Response('', {status: 404}), configurable: true});
  const {createRoot} = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  await act(async () => { root.render(createElement(ResultsSheet, {token: 'test', reports: [], mode: 'run', scenariosOpen: false, canRun: true, running: false, focusLog: false, definitions: [{id: 'scenario-guest', name: 'Guest checkout'}], onClose() {}, onRun() {}, onStop() {}, onOpenRun() {}, onFocusLogDone() {}, ...props} as never)); });
  return {document: dom.window.document, cleanup: async () => { await act(async () => root.unmount()); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } dom.window.close(); }};
}

test('visible results redact run-derived text and keep artifact actions', async () => {
  const marker = 'launch [redacted] app';
  const opened: string[] = [];
  const {document, cleanup} = await render({run: run({
    log: 'log [redacted] tail',
    artifacts: [marker, 'notes.txt'],
    steps: [{id: 's1', command: marker, status: 'passed', detail: 'detail [redacted]'}],
    snapshot: {...run().snapshot, name: 'Name [redacted]', executionYaml: 'yaml [redacted]', scenario: {...run().snapshot.scenario!, name: 'Name [redacted]'}},
  }), onArtifact: (name: string) => opened.push(name)});
  try {
    assert.ok(document.querySelectorAll('[data-testid="redacted-chip"]').length >= 2);
    const files = document.querySelector<HTMLDetailsElement>('[data-testid="results-files"]')!;
    files.open = true;
    const buttons = [...files.querySelectorAll<HTMLButtonElement>('[data-testid="results-artifact"]')];
    assert.equal(buttons.length, 2);
    assert.equal(buttons.every(button => !button.disabled), true);
    buttons[1].click();
    assert.deepEqual(opened, ['notes.txt']);
    const commands = document.querySelector<HTMLDetailsElement>('[data-testid="results-commands"]')!;
    commands.open = true;
    assert.match(commands.textContent!, /\[redacted\]/);
    assert.match(document.querySelector('[data-testid="results-title"]')!.textContent!, /\[redacted\]/);
  } finally { await cleanup(); }
});

test('confidential and scrub runs withhold images, logs, and run-again', async () => {
  const secret = 'FAKE-SECRET-VALUE';
  const confidential = await render({run: run({
    log: secret,
    artifacts: ['screenshot-failure.png', 'flow.yaml'],
    snapshot: {...run().snapshot, runtimeInputPolicy: 'Confidential runtime inputs supplied: values are omitted; raw logs, evaluated metadata, and images are withheld.'},
  })});
  try {
    assert.equal(confidential.document.body.textContent!.includes(secret), false);
    assert.equal(confidential.document.querySelector('img'), null);
    const files = confidential.document.querySelector<HTMLDetailsElement>('[data-testid="results-files"]')!;
    files.open = true;
    const png = [...files.querySelectorAll<HTMLButtonElement>('[data-testid="results-artifact"]')].find(button => button.textContent === 'screenshot-failure.png');
    assert.equal(png?.disabled, true);
    assert.match(files.textContent!, /withheld for confidential inputs/);
  } finally { await confidential.cleanup(); }

  const scrubbed = await render({run: run({status: 'error', error: 'Evidence scrub failed', log: secret, artifacts: [], steps: [], canvas: undefined, snapshot: {...run().snapshot, id: 'evidence-removed', name: 'Evidence removed', runtimeInputPolicy: 'Evidence scrub failed'}})});
  try {
    assert.equal(scrubbed.document.querySelector('[data-testid="results-scrub-failed"]')?.getAttribute('role'), 'alert');
    assert.equal(scrubbed.document.body.textContent!.includes(secret), false);
    assert.equal((scrubbed.document.querySelector('[data-testid="results-run-again"]') as HTMLButtonElement).disabled, true);
    assert.match(scrubbed.document.body.textContent!, /Files withheld/);
  } finally { await scrubbed.cleanup(); }
});

test('files stay disabled while a run is in progress and batch drill-down can return', async () => {
  let back = 0;
  const running = await render({running: true, run: run({status: 'running', finishedAt: undefined, log: '', artifacts: ['flow.yaml'], steps: []})});
  try {
    const files = running.document.querySelector<HTMLDetailsElement>('[data-testid="results-files"]')!;
    files.open = true;
    assert.equal((files.querySelector('[data-testid="results-artifact"]') as HTMLButtonElement).disabled, true);
    assert.ok(running.document.querySelector('[data-testid="results-stop"]'));
  } finally { await running.cleanup(); }

  const drilled = await render({showBack: true, onBackToBatch: () => { back += 1; }, run: run(), batch: {id: 'batch', workspaceId: 'ws', deviceId: 'device', startedAt: '2026-11-07T02:00:00.000Z', status: 'completed', entries: [], snapshot: {resetApp: false, runtimeInputPolicy: 'none'}}});
  try {
    const button = drilled.document.querySelector<HTMLButtonElement>('[data-testid="results-back-batch"]')!;
    assert.equal(button.textContent, '‹ Back to batch');
    button.click();
    assert.equal(back, 1);
  } finally { await drilled.cleanup(); }
});

test('the failed sheet opens only the failed step and hides evidence until Technical details is opened', async () => {
  const base = run({status: 'assertion-failed'});
  const failed = run({status: 'assertion-failed', canvas: {...base.canvas!, visits: [{id: 'v1', screenId: 'home', status: 'passed', checkIds: ['check']}, {id: 'v2', screenId: 'home', status: 'failed', checkIds: ['check']}], occurrences: [{id: 'o1', visitId: 'v1', testId: 'check', status: 'passed', detail: 'Welcome'}, {id: 'o2', visitId: 'v2', testId: 'check', status: 'failed', detail: 'missing'}]}});
  const {document, cleanup} = await render({run: failed});
  try {
    const steps = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="results-step"]')];
    assert.deepEqual(steps().map(step => step.getAttribute('aria-expanded')), ['false', 'true']);
    assert.equal((document.querySelector('[data-testid="results-technical"]') as HTMLDetailsElement).open, false);
    assert.equal(document.querySelector('[aria-label="Execution evidence"]'), null);
    assert.equal(document.body.textContent!.includes('Expected'), false);
    assert.ok(document.querySelector('[data-testid="results-step-check"]'));
    await act(async () => { steps()[1].click(); });
    assert.equal(steps()[1].getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('[data-testid="results-step-check"]'), null);
    await act(async () => { steps()[1].click(); });
    assert.equal(steps()[1].getAttribute('aria-expanded'), 'true');
    const tech = document.querySelector<HTMLDetailsElement>('[data-testid="results-technical"]')!;
    await act(async () => { tech.querySelector('summary')!.click(); });
    assert.equal(tech.open, true);
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Inspect visit 2"]')!.click(); });
    assert.match(document.querySelector('[aria-label="Execution evidence"]')!.textContent!, /Expected/);
    const log = document.querySelector<HTMLButtonElement>('[data-testid="results-open-log"]')!;
    await act(async () => { log.click(); });
    assert.equal((document.querySelector('[data-testid="results-log"]') as HTMLDetailsElement).open, true);
    assert.equal(document.activeElement, document.querySelector('[data-testid="results-log"] summary'));
  } finally { await cleanup(); }
});

test('a tool-error run shows the plain finish state and an enabled Run again', async () => {
  let ran = 0;
  const {document, cleanup} = await render({run: run({status: 'tool-error', error: 'Maestro exited 2', log: 'tool fixture'}), onRun: () => { ran += 1; }});
  try {
    assert.equal(document.querySelector('[data-testid="results-status"]')!.textContent, "Couldn't finish");
    const again = document.querySelector<HTMLButtonElement>('[data-testid="results-run-again"]')!;
    assert.equal(again.disabled, false);
    assert.equal(again.hidden, false);
    await act(async () => { again.click(); });
    assert.equal(ran, 1);
  } finally { await cleanup(); }
});
