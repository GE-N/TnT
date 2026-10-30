import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act,createElement,useState,type ReactNode} from 'react';
import type {CanvasGraph} from '../server/canvas.js';
import {knowledgeClient,KnowledgeRequestError,knowledgeReaderPath,type Freshness,type ScenarioDetail} from '../src/knowledge-client.js';
import {flowStepText,KNOWLEDGE_BELOW_SCENARIOS_GAP,KNOWLEDGE_SHEET_TOP,knowledgeSheetTop,type SidePanelKind,type SidePanels} from '../src/knowledge-sheet.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const css = readFileSync(new URL('../src/knowledge.css', import.meta.url), 'utf8');

function detail(freshness: Freshness, extras?: Partial<ScenarioDetail>): ScenarioDetail {
  return {
    workspaceId,
    scenarioId: 'main',
    title: 'Home — Coordinator',
    context: {
      schemaVersion: 1, workspaceId, scenarioId: 'main', contextRevision: 2,
      updatedAt: '2026-10-30T00:00:00.000Z', reviewedAgainstSourceHash: 'ab'.repeat(32),
      purpose: 'Open the coordinator directory from Home.',
      expectedOutcome: 'Coordinator names and contact details appear.',
      rationale: 'Help users find the responsible contact.',
      preconditions: 'Signed in\nDirectory loaded',
      exceptions: 'Empty directory',
      scope: '',
    },
    sourceDescriptor: {projectionVersion: 1, workspaceRevision: 1, sourceHash: 'ab'.repeat(32)},
    flow: {steps: [{number: 1, text: '1 · Tap text · Continue', testId: 'go'}], visits: [], diagnostics: []},
    evidence: {status: null, runId: null, finishedAt: null, label: 'No runs yet', notice: 'Run results do not establish authored expected outcomes.'},
    freshness,
    publicationFreshness: freshness === 'up-to-date' ? 'current' : 'publication-stale',
    intentFreshness: freshness === 'needs-review' ? 'intent-needs-review' : 'reviewed',
    generationId: null, generatedAt: null, publicationError: null,
    readerUrl: `/knowledge/workspaces/${workspaceId}/#scenario-main`,
    ...extras,
  };
}

test('knowledge client reads context and status and does not save', async () => {
  const calls: {url: string; method: string}[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({url: String(url), method: init?.method ?? 'GET'});
    if (String(url).endsWith('/status')) return new Response(JSON.stringify({workspaceId, scopeId: 'workspace-' + workspaceId, generationId: null, generatedAt: null, publicationFreshness: 'publication-stale', freshness: 'updating', publicationError: null, scenarios: []}), {status: 200});
    if (String(url).includes('/missing/')) return new Response(JSON.stringify({code: 'KNOWLEDGE_NOT_FOUND', error: 'Missing scenario.'}), {status: 404});
    return new Response(JSON.stringify(detail('up-to-date')), {status: 200});
  };
  const client = knowledgeClient('session-token', fetchImpl);
  assert.equal('saveContext' in client, false);
  const read = await client.readContext(workspaceId, 'main');
  assert.equal(read.context.purpose, 'Open the coordinator directory from Home.');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `/api/knowledge/workspaces/${workspaceId}/scenarios/main/context`);
  const status = await client.status(workspaceId);
  assert.equal(status.freshness, 'updating');
  assert.equal(calls[1].url, `/api/knowledge/workspaces/${workspaceId}/status`);
  await assert.rejects(() => client.readContext(workspaceId, 'missing'), (error: unknown) => error instanceof KnowledgeRequestError && error.status === 404 && error.code === 'KNOWLEDGE_NOT_FOUND');
  assert.equal(knowledgeReaderPath(workspaceId, 'main'), `/knowledge/workspaces/${workspaceId}/#scenario-main`);
  assert.equal(flowStepText({number: 2, text: 'Tap text · Back'}), '2 · Tap text · Back');
  assert.equal(knowledgeSheetTop(false, 480), KNOWLEDGE_SHEET_TOP);
  assert.equal(knowledgeSheetTop(true, 480), 480 + KNOWLEDGE_BELOW_SCENARIOS_GAP);
  assert.equal(knowledgeSheetTop(true, 0), KNOWLEDGE_SHEET_TOP);
});

test('info sheet stylesheet keeps the trigger geometry and the docked sheet', () => {
  assert.match(css, /\.knowledge-info-button\{[^}]*width:44px;height:44px/);
  assert.match(css, /\.knowledge-info-button\{[^}]*margin:0/);
  assert.match(css, /\.knowledge-sheet\{[^}]*right:24px;top:96px;bottom:152px/);
  assert.match(css, /\.knowledge-sheet\{[^}]*width:300px/);
  assert.match(css, /\.knowledge-info-button:focus-visible\{[^}]*outline:none/);
  assert.match(css, /\.knowledge-info-button\{[^}]*border:0/);
  assert.match(css, /\.knowledge-reader\{[^}]*border:0/);
  assert.match(css, /\.knowledge-section\{[^}]*border:0/);
});

async function withDom(body: (window: Window, root: {render: (node: ReactNode) => void; unmount: () => void}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {url: 'http://127.0.0.1:4319/'});
  const window = dom.window;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const keys = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'KeyboardEvent', 'PointerEvent', 'MouseEvent', 'MutationObserver', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT', 'navigator'];
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'ResizeObserver' ? ResizeObserver : Reflect.get(window, key), configurable: true});
  }
  const {createRoot} = await import('react-dom/client');
  const root = createRoot(window.document.getElementById('root')!);
  try {
    await body(window as unknown as Window, root);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    window.close();
  }
}

function installFetch(payload: ScenarioDetail | ((url: string) => ScenarioDetail)) {
  const fetchImpl: typeof fetch = async url => new Response(JSON.stringify(typeof payload === 'function' ? payload(String(url)) : payload), {status: 200, headers: {'Content-Type': 'application/json'}});
  globalThis.fetch = fetchImpl;
}

test('info button is icon-only, in the trigger row, and the sheet is read-only', async () => {
  await withDom(async (window, root) => {
    installFetch(detail('up-to-date'));
    const {KnowledgeScenarioControl} = await import('../src/knowledge-sheet.js');
    function Host({scenarioId}: {scenarioId?: string}) {
      return createElement('section', {className: 'scenario-sequence-bar'},
        createElement(KnowledgeScenarioControl, {token: 'tok', workspaceId, scenarioId, scenarioName: 'Home — Coordinator'}),
        createElement('button', {type: 'button', className: 'scenario-bar-trigger', 'data-testid': 'scenario-bar-trigger', 'aria-label': 'Scenarios', title: 'Scenarios'}, 'Scenarios'),
      );
    }
    await act(async () => { root.render(createElement(Host, {})); });
    assert.equal(window.document.querySelector('[data-testid="knowledge-info-button"]'), null);
    await act(async () => { root.render(createElement(Host, {scenarioId: 'main'})); });
    const bar = window.document.querySelector('.scenario-sequence-bar')!;
    const info = bar.querySelector<HTMLButtonElement>('[data-testid="knowledge-info-button"]')!;
    const trigger = bar.querySelector<HTMLButtonElement>('[data-testid="scenario-bar-trigger"]')!;
    assert.ok(info);
    assert.equal(info.nextElementSibling, trigger);
    assert.equal(trigger.parentElement, bar);
    assert.equal(bar.lastElementChild, trigger);
    assert.equal(info.getAttribute('title'), 'Scenario details');
    assert.equal(info.getAttribute('aria-label'), 'Scenario details');
    assert.equal(info.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
    assert.equal(info.textContent?.trim(), '');
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]'), null);
    await act(async () => { trigger.click(); });
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]'), null);
    await act(async () => { info.click(); });
    await act(async () => { await Promise.resolve(); });
    const sheet = window.document.querySelector<HTMLElement>('[data-testid="knowledge-sheet"]')!;
    assert.ok(sheet);
    assert.equal(sheet.style.top, '96px');
    assert.equal(info.getAttribute('aria-expanded'), 'true');
    assert.equal(sheet.querySelector('input,textarea'), null);
    assert.equal(sheet.textContent?.includes('Edit'), false);
    assert.equal(sheet.textContent?.includes('Save'), false);
    assert.equal(sheet.textContent?.includes('Cancel'), false);
    assert.match(sheet.querySelector('[data-testid="knowledge-status"]')!.textContent ?? '', /Up to date/);
    assert.equal(sheet.querySelector('[data-testid="knowledge-purpose"]')!.textContent, 'Open the coordinator directory from Home.');
    assert.equal(sheet.querySelector('[data-testid="knowledge-outcome"]')!.textContent, 'Coordinator names and contact details appear.');
    for (const id of ['why', 'preconditions', 'flow', 'exceptions', 'evidence']) {
      assert.equal(sheet.querySelector(`[data-testid="knowledge-section-${id}"]`)!.getAttribute('aria-expanded'), 'false');
    }
    assert.equal(sheet.querySelector('[data-testid="knowledge-section-body"]'), null);
    await act(async () => { sheet.querySelector<HTMLButtonElement>('[data-testid="knowledge-section-why"]')!.click(); });
    assert.equal(sheet.querySelectorAll('[data-testid="knowledge-section-body"]').length, 1);
    assert.match(sheet.querySelector('[data-testid="knowledge-section-body"]')!.textContent ?? '', /Help users find the responsible contact/);
    await act(async () => { sheet.querySelector<HTMLButtonElement>('[data-testid="knowledge-section-flow"]')!.click(); });
    assert.equal(sheet.querySelectorAll('[data-testid="knowledge-section-body"]').length, 1);
    assert.equal(sheet.querySelector('[data-testid="knowledge-section-why"]')!.getAttribute('aria-expanded'), 'false');
    assert.equal(sheet.querySelector('[data-testid="knowledge-flow-step"]')!.textContent, '1 · Tap text · Continue');
    await act(async () => { sheet.querySelector<HTMLButtonElement>('[data-testid="knowledge-section-evidence"]')!.click(); });
    assert.equal(sheet.querySelector('[data-testid="knowledge-evidence"]')!.textContent, 'No runs yet');
    await act(async () => { sheet.querySelector<HTMLButtonElement>('[data-testid="knowledge-section-evidence"]')!.click(); });
    assert.equal(sheet.querySelector('[data-testid="knowledge-section-body"]'), null);
    const reader = sheet.querySelector<HTMLAnchorElement>('[data-testid="knowledge-reader"]')!;
    assert.equal(reader.textContent, 'Open knowledge reader ↗');
    assert.equal(reader.getAttribute('href'), `/knowledge/workspaces/${workspaceId}/#scenario-main`);
    assert.equal(reader.target, '_blank');
    assert.match(reader.rel, /noopener/);
    await act(async () => { info.click(); });
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]'), null);
    await act(async () => { info.click(); });
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]'), null);
  });
});

test('status line follows freshness', async () => {
  await withDom(async (window, root) => {
    const {KnowledgeScenarioControl} = await import('../src/knowledge-sheet.js');
    for (const [freshness, label] of [['updating', 'Updating'], ['needs-review', 'Needs review']] as const) {
      installFetch(detail(freshness));
      await act(async () => { root.render(createElement(KnowledgeScenarioControl, {token: 'tok', workspaceId, scenarioId: 'main', scenarioName: 'Home'})); });
      await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="knowledge-info-button"]')!.click(); });
      await act(async () => { await Promise.resolve(); });
      assert.match(window.document.querySelector('[data-testid="knowledge-status"]')!.textContent ?? '', new RegExp(label));
      await act(async () => { window.document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    }
  });
});

test('one panel: opening info replaces Versions and Node details, and a node closes info', async () => {
  await withDom(async (window, root) => {
    installFetch(detail('up-to-date'));
    const {KnowledgeScenarioControl} = await import('../src/knowledge-sheet.js');
    function Host() {
      const [open, setOpen] = useState<SidePanelKind | null>('versions');
      const panels: SidePanels = {
        open,
        openPanel(kind) { setOpen(kind); },
        closePanel(kind) { setOpen(current => current === kind ? null : current); },
      };
      return createElement('div', null,
        open === 'versions' ? createElement('div', {'data-testid': 'versions-sheet'}) : null,
        open === 'nodeDetails' ? createElement('aside', {'data-testid': 'node-details', className: 'floating-inspector'}) : null,
        createElement(KnowledgeScenarioControl, {token: 'tok', workspaceId, scenarioId: 'main', scenarioName: 'Home', panels}),
        createElement('button', {type: 'button', 'data-testid': 'select-node', onClick: () => panels.openPanel('nodeDetails')}, 'Select'),
      );
    }
    await act(async () => { root.render(createElement(Host)); });
    assert.ok(window.document.querySelector('[data-testid="versions-sheet"]'));
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]'), null);
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="knowledge-info-button"]')!.click(); });
    assert.equal(window.document.querySelector('[data-testid="versions-sheet"]'), null);
    assert.equal(window.document.querySelector('[data-testid="node-details"]'), null);
    assert.ok(window.document.querySelector('[data-testid="knowledge-sheet"]'));
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="select-node"]')!.click(); });
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]'), null);
    assert.ok(window.document.querySelector('[data-testid="node-details"]'));
  });
});

test('an open Scenarios panel drops the sheet top below it', async () => {
  await withDom(async (window, root) => {
    installFetch(detail('needs-review'));
    const prototype = Object.getPrototypeOf(window.document.createElement('div')) as HTMLElement;
    const original = prototype.getBoundingClientRect;
    prototype.getBoundingClientRect = function () {
      if (this.getAttribute('data-testid') === 'scenario-panel') return {x: 0, y: 80, left: 900, top: 80, right: 1340, bottom: 480, width: 440, height: 400, toJSON() { return {}; }} as DOMRect;
      return original.call(this);
    };
    const {KnowledgeScenarioControl} = await import('../src/knowledge-sheet.js');
    function Host() {
      const [scenariosOpen, setScenariosOpen] = useState(true);
      return createElement('div', null,
        createElement('div', {'data-testid': 'scenario-panel', className: 'scenario-details-panel'}),
        createElement('button', {type: 'button', 'data-testid': 'close-scenarios', onClick: () => setScenariosOpen(false)}),
        createElement(KnowledgeScenarioControl, {token: 'tok', workspaceId, scenarioId: 'main', scenarioName: 'Home', scenariosOpen}),
      );
    }
    await act(async () => { root.render(createElement(Host)); });
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="knowledge-info-button"]')!.click(); });
    const sheet = () => window.document.querySelector<HTMLElement>('[data-testid="knowledge-sheet"]')!;
    assert.equal(sheet().style.top, `${480 + KNOWLEDGE_BELOW_SCENARIOS_GAP}px`);
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="close-scenarios"]')!.click(); });
    assert.equal(sheet().style.top, '96px');
    prototype.getBoundingClientRect = original;
  });
});

test('sequence bar mount keeps the Scenarios trigger last and a node closes info', async () => {
  const graph: CanvasGraph = {
    screens: [{id: 'home', title: 'Home', x: 40, y: 40, tests: []}],
    edges: [],
    paths: [{id: 'route', name: 'Main', scenarioId: 'main', screenId: 'home', edgeIds: []}],
  };
  await withDom(async (window, root) => {
    installFetch(detail('up-to-date'));
    const {resetSidePanels} = await import('../src/side-panels.js');
    resetSidePanels();
    const {CanvasEditor} = await import('../src/canvas.js');
    let dismissed = 0;
    await act(async () => {
      root.render(createElement(CanvasEditor, {
        graph, onChange: () => {}, yaml: 'appId: app\n---\n- launchApp\n', onYamlChange: () => {}, catalog: [], diagnostics: [],
        pathId: 'route', onPathChange: () => {}, disabled: false, scenarioMode: true, scenarioId: 'main',
        scenarios: [{id: 'main', name: 'Home — Coordinator', pathId: 'route'}],
        knowledge: {token: 'tok', workspaceId, onDismissVersions: () => { dismissed += 1; }},
      }));
    });
    const bar = window.document.querySelector('.scenario-sequence-bar')!;
    const info = bar.querySelector<HTMLButtonElement>('[data-testid="knowledge-info-button"]')!;
    const trigger = bar.querySelector<HTMLButtonElement>('[data-testid="scenario-bar-trigger"]')!;
    assert.equal(info.nextElementSibling, trigger);
    assert.equal(bar.lastElementChild, trigger);
    assert.equal(window.document.querySelectorAll('.screen-node').length, 1);
    await act(async () => { info.click(); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(dismissed, 1);
    assert.ok(window.document.querySelector('[data-testid="knowledge-sheet"]'));
    assert.equal(window.document.querySelector('.floating-inspector'), null);
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[aria-label="Select screen Home"]')!.click(); });
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]'), null);
    assert.ok(window.document.querySelector('.floating-inspector'));
    await act(async () => { info.click(); });
    assert.equal(dismissed, 2);
    assert.equal(window.document.querySelector('.floating-inspector'), null);
    assert.ok(window.document.querySelector('[data-testid="knowledge-sheet"]'));
  });
});
