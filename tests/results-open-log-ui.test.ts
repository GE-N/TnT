import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement, useState} from 'react';
import type {CanvasGraph} from '../server/canvas.js';
import type {Run} from '../server/scenarios.js';
import type {ScriptStepResult} from '../server/run-script-contract.js';
import {recordsFor} from '../src/run-script.js';
import {resetSidePanels, useSidePanels, openPanel} from '../src/side-panels.js';

const fingerprint = 'ab'.repeat(32);
const reference = {kind: 'step' as const, file: 'flow.yaml', index: 0, fingerprint};
const graph: CanvasGraph = {
  screens: [{id: 'home', title: 'Home', x: 0, y: 0, tests: [{id: 'ready', label: 'Home', role: 'assertion', reference, check: {visibility: 'visible', target: 'text', match: 'exact', value: 'Home'}}]}],
  edges: [],
  paths: [{id: 'route', name: 'Main', scenarioId: 'main', screenId: 'home', edgeIds: [], visits: [{id: 'v1', operationIds: ['ready']}]}],
};

function finishedRun(): Run {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    deviceId: 'device',
    startedAt: '2026-11-07T02:00:00.000Z',
    finishedAt: '2026-11-07T02:00:02.000Z',
    status: 'passed',
    mappingNote: 'mapped',
    log: 'script finished\nexample marker [redacted]',
    artifacts: [],
    cleanup: {verified: true, detail: 'clean'},
    steps: [{id: 's1', command: 'assertVisible', status: 'passed'}],
    scriptSteps: {s1: {kind: 'runScript', rowId: 's1', status: 'passed'}},
    executionOrder: [{kind: 'runScript', rowId: 's1'}, {kind: 'step', index: 0}],
    snapshot: {
      id: 'snap', workspaceId: 'ws', name: 'Checkout', yaml: 'appId: app\n---\n- assertVisible: Home\n', steps: [],
      toolVersions: {maestro: '2.11.0', node: '22'}, runtimeInputPolicy: 'No runtime inputs supplied.',
      scenario: {id: 'main', name: 'Checkout', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []},
      canvas: graph,
    },
  } as Run;
}

test('the canvas Open run log entry opens that run and focuses the runner log', async () => {
  const dom = new JSDOM('<div id="root"></div>', {url: 'http://localhost/'});
  const previous = new Map<string, PropertyDescriptor | undefined>();
  class ResizeObserver { observe() {} disconnect() {} }
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'KeyboardEvent', 'PointerEvent', 'MutationObserver', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'ResizeObserver' ? ResizeObserver : Reflect.get(dom.window, key), configurable: true});
  }
  const {createRoot} = await import('react-dom/client');
  const {CanvasEditor} = await import('../src/canvas.js');
  const {ResultsSheet} = await import('../src/results-sheet.js');
  const run = finishedRun();
  const result: ScriptStepResult = {kind: 'runScript', rowId: 's1', status: 'passed'};
  resetSidePanels();
  function Host() {
    const panels = useSidePanels();
    const [focusLog, setFocusLog] = useState(false);
    const rows = recordsFor('main', [{id: 's1', beforeStep: {index: 0, fingerprint}, label: 'Pay', source: 'true;'}], []);
    const runScripts = {
      scenarioId: 'main', rows, trust: [], results: [result], executionOrder: run.executionOrder ?? [],
      hasMock: false, revealBlocks: false, running: false, passedRun: true, timedOut: false, scrubFailed: false,
      failedAtScript: false, trustBlockCount: 0,
      onAdd: () => 'unused', onUpdate: () => {}, onMove: () => {}, onDelete: () => {}, onReplace: () => {}, onTrust: async () => {},
      onOpenLog: () => { setFocusLog(true); openPanel('results'); },
    };
    return createElement('div', null,
      createElement(CanvasEditor, {graph, onChange: () => {}, yaml: 'appId: app\n---\n- assertVisible: Home\n', onYamlChange: () => {}, catalog: [], diagnostics: [], pathId: 'route', onPathChange: () => {}, disabled: false, scenarioMode: true, scenarioId: 'main', scenarios: [{id: 'main', name: 'Checkout', pathId: 'route'}], initialView: {selectedScreenId: 'home', selectedVisitId: 'v1'}, onRun: () => {}, run, runScripts}),
      panels.open === 'results' ? createElement(ResultsSheet, {token: 'test', run, reports: [run], mode: 'run', scenariosOpen: false, canRun: true, running: false, focusLog, definitions: [{id: 'main', name: 'Checkout'}], onClose: () => {}, onRun: () => {}, onStop: () => {}, onOpenRun: () => {}, onFocusLogDone: () => setFocusLog(false)}) : null,
    );
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => { root.render(createElement(Host)); });
    const document = dom.window.document;
    const row = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Run script · Pay before step 1');
    assert.ok(row, 'finished script row is on the canvas visit');
    await act(async () => { row.click(); });
    const openLog = [...document.querySelectorAll('button')].find(button => button.textContent === 'Open run log');
    assert.ok(openLog, 'canvas script result offers Open run log');
    assert.equal(document.querySelector('[data-testid="results-sheet"]'), null);
    await act(async () => { openLog.click(); });
    const sheet = document.querySelector('[data-testid="results-sheet"]');
    assert.ok(sheet, 'Open run log opens the Results sheet');
    assert.equal(document.querySelector('[data-testid="results-title"]')!.textContent, 'Checkout');
    assert.equal(document.querySelector('[data-testid="results-status"]')!.getAttribute('data-status'), 'passed');
    assert.equal((document.querySelector('[data-testid="results-technical"]') as HTMLDetailsElement).open, true);
    assert.equal((document.querySelector('[data-testid="results-log"]') as HTMLDetailsElement).open, true);
    assert.equal(document.activeElement, document.querySelector('[data-testid="results-log"] summary'));
    assert.match(document.querySelector('[data-testid="results-log"]')!.textContent!, /script finished/);
  } finally {
    await act(async () => root.unmount());
    resetSidePanels();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
