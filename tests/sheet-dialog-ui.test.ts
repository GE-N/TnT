import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement, useState, type ReactNode} from 'react';
import {Sheet} from '../src/sheet.js';
import {closePanel, openPanel, resetSidePanels, useSidePanels} from '../src/side-panels.js';

async function withDom(body: (window: Window, root: {render: (node: ReactNode) => void; unmount: () => void}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {url: 'http://127.0.0.1:4319/'});
  const window = dom.window;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const keys = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Node', 'Element', 'Event', 'KeyboardEvent', 'PointerEvent', 'MouseEvent', 'MutationObserver', 'ResizeObserver', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'];
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
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
}

function key(view: Window, target: Element, name: string, extras: {shiftKey?: boolean} = {}) {
  const KeyEvent = (view as unknown as {KeyboardEvent: typeof KeyboardEvent}).KeyboardEvent;
  return act(async () => {
    target.dispatchEvent(new KeyEvent('keydown', {key: name, bubbles: true, cancelable: true, shiftKey: !!extras.shiftKey}));
  });
}

function focusedId(document: Document) {
  const active = document.activeElement;
  return active instanceof document.defaultView!.HTMLElement ? active.getAttribute('data-testid') : active?.nodeName ?? null;
}

test('a sheet is a modal dialog, traps Tab, closes on Escape, and returns focus', async () => {
  await withDom(async (window, root) => {
    function Host() {
      const [open, setOpen] = useState(false);
      return createElement('div', null,
        createElement('button', {type: 'button', 'data-testid': 'trigger', onClick: () => setOpen(true)}, 'Open'),
        createElement('button', {type: 'button', 'data-testid': 'outside'}, 'Outside'),
        open ? createElement(Sheet, {titleId: 'sheet-title', testId: 'demo-sheet', side: 'info', onClose: () => setOpen(false)},
          createElement('h2', {id: 'sheet-title'}, 'Scenario details'),
          createElement('button', {type: 'button', 'data-testid': 'first'}, 'First'),
          createElement('button', {type: 'button', 'data-testid': 'last'}, 'Last'),
        ) : null,
      );
    }
    await act(async () => { root.render(createElement(Host)); });
    const trigger = window.document.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
    await act(async () => { trigger.focus(); trigger.click(); });
    const sheet = window.document.querySelector<HTMLElement>('[data-testid="demo-sheet"]')!;
    assert.equal(sheet.getAttribute('role'), 'dialog');
    assert.equal(sheet.getAttribute('aria-modal'), 'true');
    assert.equal(sheet.getAttribute('aria-labelledby'), 'sheet-title');
    assert.equal(window.document.getElementById('sheet-title')?.textContent, 'Scenario details');
    assert.equal(sheet.getAttribute('data-side-sheet'), 'info');
    assert.ok(sheet === window.document.activeElement || sheet.contains(window.document.activeElement));
    const first = window.document.querySelector<HTMLButtonElement>('[data-testid="first"]')!;
    const last = window.document.querySelector<HTMLButtonElement>('[data-testid="last"]')!;
    last.focus();
    await key(window, last, 'Tab');
    assert.equal(window.document.activeElement, first, 'Tab wraps to the first control');
    await key(window, first, 'Tab', {shiftKey: true});
    assert.equal(window.document.activeElement, last, 'Shift+Tab wraps to the last control');
    await key(window, sheet, 'Escape');
    assert.equal(window.document.querySelector('[data-testid="demo-sheet"]'), null);
    assert.equal(focusedId(window.document), 'trigger', 'focus returns to the trigger');
  });
});

test('Escape inside a nested layer does not close the sheet', async () => {
  await withDom(async (window, root) => {
    let closed = 0;
    function Host() {
      const [layer, setLayer] = useState(true);
      return createElement(Sheet, {
        titleId: 'nested-title',
        testId: 'nested-sheet',
        side: 'results',
        onClose: () => { closed += 1; },
        onEscape: () => {
          if (!layer) return false;
          setLayer(false);
          return true;
        },
      }, createElement('h2', {id: 'nested-title'}, 'Results'), layer ? createElement('button', {type: 'button', 'data-testid': 'layer'}, 'Layer') : null);
    }
    await act(async () => { root.render(createElement(Host)); });
    const sheet = window.document.querySelector<HTMLElement>('[data-testid="nested-sheet"]')!;
    await key(window, sheet, 'Escape');
    assert.equal(closed, 0);
    assert.equal(window.document.querySelector('[data-testid="layer"]'), null);
    assert.ok(window.document.querySelector('[data-testid="nested-sheet"]'));
    await key(window, window.document.querySelector('[data-testid="nested-sheet"]')!, 'Escape');
    assert.equal(closed, 1);
  });
});

test('only one right-hand panel is open at a time', async () => {
  resetSidePanels();
  await withDom(async (window, root) => {
    function Host() {
      const panels = useSidePanels();
      return createElement('div', null,
        createElement('button', {type: 'button', 'data-testid': 'open-info', onClick: () => panels.openPanel('info')}, 'Info'),
        createElement('button', {type: 'button', 'data-testid': 'open-versions', onClick: () => panels.openPanel('versions')}, 'Versions'),
        createElement('button', {type: 'button', 'data-testid': 'open-results', onClick: () => panels.openPanel('results')}, 'Results'),
        createElement('button', {type: 'button', 'data-testid': 'open-settings', onClick: () => panels.openPanel('settings')}, 'Settings'),
        panels.open === 'info' ? createElement(Sheet, {titleId: 'info-title', testId: 'info-sheet', side: 'info', onClose: () => panels.closePanel('info')}, createElement('h2', {id: 'info-title'}, 'Info')) : null,
        panels.open === 'versions' ? createElement(Sheet, {titleId: 'versions-title', testId: 'versions-sheet', side: 'versions', onClose: () => panels.closePanel('versions')}, createElement('h2', {id: 'versions-title'}, 'Versions')) : null,
        panels.open === 'results' ? createElement(Sheet, {titleId: 'results-title', testId: 'results-sheet', side: 'results', onClose: () => panels.closePanel('results')}, createElement('h2', {id: 'results-title'}, 'Results')) : null,
        panels.open === 'settings' ? createElement(Sheet, {titleId: 'settings-title', testId: 'settings-sheet', side: 'settings', onClose: () => panels.closePanel('settings')}, createElement('h2', {id: 'settings-title'}, 'Settings')) : null,
      );
    }
    await act(async () => { root.render(createElement(Host)); });
    const click = (id: string) => act(async () => { window.document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click(); });
    await click('open-info');
    assert.deepEqual([...window.document.querySelectorAll('[data-side-sheet]')].map(node => node.getAttribute('data-side-sheet')), ['info']);
    await click('open-versions');
    assert.deepEqual([...window.document.querySelectorAll('[data-side-sheet]')].map(node => node.getAttribute('data-side-sheet')), ['versions']);
    await click('open-results');
    assert.deepEqual([...window.document.querySelectorAll('[data-side-sheet]')].map(node => node.getAttribute('data-side-sheet')), ['results']);
    await click('open-settings');
    assert.equal(window.document.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(window.document.querySelector('[data-side-sheet]')?.getAttribute('data-side-sheet'), 'settings');
    assert.equal(window.document.querySelector('[data-side-sheet]')?.getAttribute('aria-labelledby'), 'settings-title');
    await act(async () => { openPanel('info'); });
    assert.deepEqual([...window.document.querySelectorAll('[data-side-sheet]')].map(node => node.getAttribute('data-side-sheet')), ['info']);
    await act(async () => { closePanel('info'); });
  });
  resetSidePanels();
});

test('info, Versions, Results, and Settings sheets share the dialog contract', async () => {
  await withDom(async (window, root) => {
    const fetchImpl: typeof fetch = async url => {
      const path = String(url);
      if (path.includes('/api/ai/config')) {
        return new Response(JSON.stringify({
          settingsRevision: 1, selected: 'openrouter',
          providers: {
            openrouter: {model: '', configured: false, credentialRevision: 0, storageAvailable: true},
            'openai-compatible': {model: '', baseUrl: 'https://api.openai.com/v1', configured: false, credentialRevision: 0, storageAvailable: true},
            copilot: {model: 'auto'},
          },
        }), {status: 200, headers: {'Content-Type': 'application/json'}});
      }
      return new Response(JSON.stringify({
        workspaceId: '11111111-1111-4111-8111-111111111111', scenarioId: 'main', title: 'Guest checkout',
        context: {schemaVersion: 1, workspaceId: '11111111-1111-4111-8111-111111111111', scenarioId: 'main', contextRevision: 1, updatedAt: '2026-10-30T00:00:00.000Z', reviewedAgainstSourceHash: 'ab', purpose: 'Pay', expectedOutcome: 'Paid', rationale: 'Because', preconditions: '', exceptions: '', scope: ''},
        sourceDescriptor: {projectionVersion: 1, workspaceRevision: 1, sourceHash: 'ab'},
        flow: {steps: [], visits: [], diagnostics: []},
        evidence: {status: null, runId: null, finishedAt: null, label: 'No runs yet', notice: ''},
        freshness: 'up-to-date', publicationFreshness: 'current', intentFreshness: 'reviewed',
        generationId: null, generatedAt: null, publicationError: null, readerUrl: '/knowledge',
      }), {status: 200, headers: {'Content-Type': 'application/json'}});
    };
    globalThis.fetch = fetchImpl;
    const {KnowledgeScenarioControl} = await import('../src/knowledge-sheet.js');
    const {VersionsSheet} = await import('../src/ai-versions-sheet.js');
    const {AiSettings} = await import('../src/ai-settings.js');
    const {ResultsSheet} = await import('../src/results-sheet.js');
    let resultsClosed = 0;
    function Host({which}: {which: 'info' | 'versions' | 'settings' | 'results'}) {
      if (which === 'info') return createElement(KnowledgeScenarioControl, {token: 'tok', workspaceId: '11111111-1111-4111-8111-111111111111', scenarioId: 'main', scenarioName: 'Guest checkout'});
      if (which === 'versions') return createElement(VersionsSheet, {versions: [{id: 'now', title: 'Guest checkout', createdAt: new Date().toISOString(), draft: {schemaVersion: 1, mode: 'createScenario', name: 'Guest checkout', assumptions: [], screens: [], visits: []}, placements: {}, projection: {screens: [], edges: []}}], nowId: 'now', selectedId: 'now', onSelect() {}, onClose() {}, onKeepCurrent() {}, onRestore() {}} as never);
      if (which === 'settings') return createElement(AiSettings, {token: 'tok', focusNonce: 1, onCloseCard() {}});
      return createElement(ResultsSheet, {token: 'test', reports: [], mode: 'run', scenariosOpen: false, canRun: true, running: false, focusLog: false, fallbackTitle: 'Guest checkout', definitions: [], onClose: () => { resultsClosed += 1; }, onRun() {}, onStop() {}, onOpenRun() {}, onFocusLogDone() {}});
    }
    function labelled(sheet: Element) {
      const id = sheet.getAttribute('aria-labelledby');
      assert.equal(sheet.getAttribute('role'), 'dialog');
      assert.equal(sheet.getAttribute('aria-modal'), 'true');
      assert.ok(id);
      assert.ok(window.document.getElementById(id!)?.textContent);
    }
    await act(async () => { root.render(createElement(Host, {which: 'info'})); });
    const infoTrigger = window.document.querySelector<HTMLButtonElement>('[data-testid="knowledge-info-button"]')!;
    await act(async () => { infoTrigger.focus(); infoTrigger.click(); });
    const info = window.document.querySelector('[data-testid="knowledge-sheet"]')!;
    labelled(info);
    assert.equal(info.getAttribute('data-side-sheet'), 'info');
    await key(window, info, 'Escape');
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]'), null);
    assert.equal(focusedId(window.document), 'knowledge-info-button');

    await act(async () => { root.render(createElement(Host, {which: 'versions'})); });
    const versions = window.document.querySelector('[data-testid="ai-versions-sheet"]')!;
    labelled(versions);
    assert.equal(window.document.getElementById(versions.getAttribute('aria-labelledby')!)?.textContent, 'Versions');
    assert.equal(focusedId(window.document), 'ai-version-option');

    await act(async () => { root.render(createElement(Host, {which: 'settings'})); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    const settings = window.document.querySelector('[data-testid="ai-settings"]')!;
    labelled(settings);
    assert.equal(window.document.getElementById(settings.getAttribute('aria-labelledby')!)?.textContent, 'Settings');
    assert.equal(settings.getAttribute('aria-label'), null);

    await act(async () => { root.render(createElement(Host, {which: 'results'})); });
    const results = window.document.querySelector('[data-testid="results-sheet"]')!;
    labelled(results);
    assert.equal(window.document.getElementById(results.getAttribute('aria-labelledby')!)?.textContent, 'Guest checkout');
    await key(window, results, 'Escape');
    assert.equal(resultsClosed, 1);
  });
});

test('Results Escape closes the run picker before the sheet', async () => {
  await withDom(async (window, root) => {
    const {ResultsSheet} = await import('../src/results-sheet.js');
    let closed = 0;
    const run = {
      id: '11111111-1111-1111-1111-111111111111', deviceId: 'device', startedAt: '2026-11-07T02:00:00.000Z', finishedAt: '2026-11-07T02:00:04.000Z', status: 'passed',
      mappingNote: 'mapped', log: 'log', artifacts: [], cleanup: {verified: true, detail: 'clean'}, steps: [],
      snapshot: {id: 'snap', workspaceId: 'ws', name: 'Guest checkout', yaml: 'appId: example\n', steps: [], toolVersions: {maestro: '2', node: '22'}, runtimeInputPolicy: 'No runtime inputs supplied.', scenario: {id: 'scenario-guest', name: 'Guest checkout', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}},
    };
    await act(async () => {
      root.render(createElement(ResultsSheet, {
        token: 'test', run: run as never, reports: [run as never], mode: 'run', scenariosOpen: false, canRun: true, running: false, focusLog: false,
        definitions: [{id: 'scenario-guest', name: 'Guest checkout'}], onClose: () => { closed += 1; }, onRun() {}, onStop() {}, onOpenRun() {}, onFocusLogDone() {},
      }));
    });
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="results-run-picker"]')!.click(); });
    assert.ok(window.document.querySelector('[aria-label="Scenario reports"]'));
    await key(window, window.document.querySelector('[data-testid="results-sheet"]')!, 'Escape');
    assert.equal(window.document.querySelector('[aria-label="Scenario reports"]'), null);
    assert.equal(closed, 0);
    assert.ok(window.document.querySelector('[data-testid="results-sheet"]'));
    await key(window, window.document.querySelector('[data-testid="results-sheet"]')!, 'Escape');
    assert.equal(closed, 1);
  });
});
