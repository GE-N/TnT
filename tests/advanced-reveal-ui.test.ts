import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement} from 'react';
import {Scenarios} from '../src/scenarios.js';
import {createRunner} from '../server/runner.js';
import {createScenarios} from '../server/scenarios.js';

const yaml = 'appId: com.example.HybridApp\n---\n- launchApp\n';
const scenario = {id: 'scenario-1', name: 'Scenario 1', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []};
const reference = {kind: 'step' as const, file: 'flow.yaml', index: 0, fingerprint: 'draft'};
const emptyCanvas = {screens: [], edges: [], paths: []};
const incompleteCanvas = {
  screens: [{id: 'home', title: 'Home', x: 0, y: 0, tests: [{id: 'check-home', label: 'Home ready', role: 'assertion' as const, reference, check: {visibility: 'visible' as const, target: 'text' as const, match: 'exact' as const, value: ''}}]}],
  edges: [],
  paths: [{id: 'path-1', scenarioId: 'scenario-1', name: 'Scenario 1', screenId: 'home', edgeIds: []}],
};

test('actions that need Advanced reveal it on demand and hide it when closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnt-advanced-reveal-'));
  const service = createScenarios({
    root: directory,
    runner: createRunner({artifactDirectory: directory, execute: async () => ({stdout: '', stderr: ''})}),
    maestro: {version: async () => '0', run: async () => ({code: 0, log: '', cleanup: {verified: true, detail: 'unused'}})},
  });
  const restored = await service.save({name: 'Restored advanced', yaml, scenarios: [scenario], canvas: emptyCanvas});
  await service.saveView(restored.id, {format: 1, panels: {advanced: true}});
  const omitted = await service.save({name: 'Omitted values', yaml, scenarios: [scenario], canvas: emptyCanvas, omittedValues: [{owner: 'scenario:scenario-1', name: 'PASSWORD'}]});
  const incomplete = await service.save({name: 'Incomplete step', yaml, scenarios: [scenario], canvas: incompleteCanvas});
  const flows = await service.save({name: 'Flow repair', yaml, scenarios: [scenario], canvas: emptyCanvas});
  let flowsRepair = false;
  const viewWrites: Array<Record<string, unknown>> = [];
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'HTMLElement', 'Event', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'] as const;
  const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  class ResizeObserver { observe() {} disconnect() {} }
  const pending: Promise<Response>[] = [];
  const request = async (path: string, init?: {body?: string}) => {
    try {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      const id = path.split('/')[3];
      if (path === '/api/session') return Response.json(await service.session());
      if (path === '/api/canvas/references') {
        if (flowsRepair) return Response.json({references: [], diagnostics: [{ownerId: 'flows', detail: 'Repair the reusable flows JSON.'}, {ownerId: 'yaml', detail: 'Repair the scenario YAML.'}, {ownerId: 'automation', detail: 'Repair default actions.'}]});
        return Response.json(await service.references(body));
      }
      if (path.startsWith('/api/scripts/trust')) return Response.json({scripts: []});
      if (path.endsWith('/draft') && !path.endsWith('/draft/discard')) return Response.json(await service.saveDraft(id, body));
      if (path.endsWith('/view')) { viewWrites.push(body); return Response.json(await service.saveView(id, body)); }
      if (/^\/api\/workspaces\/[0-9a-f-]{36}$/.test(path)) return Response.json(await service.workspaceDetail(id));
      return Response.json({error: 'unused'}, {status: 404});
    } catch (error) {
      return Response.json({error: error instanceof Error ? error.message : 'Request failed'}, {status: 400});
    }
  };
  const fetchImpl = (path: string, init?: {body?: string}) => { const response = request(path, init); pending.push(response); return response; };
  for (const key of keys) Object.defineProperty(globalThis, key, {value: key === 'fetch' ? fetchImpl : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'ResizeObserver' ? ResizeObserver : Reflect.get(dom.window, key), configurable: true});
  const {createRoot} = await import('react-dom/client');
  const document = dom.window.document;
  let root = createRoot(document.getElementById('root')!);
  const settle = async () => { do { await Promise.all(pending.splice(0)); await new Promise(resolve => setImmediate(resolve)); } while (pending.length); };
  const render = async () => { await act(async () => { root.render(createElement(Scenarios, {token: 'local', deviceId: '', bundleId: 'com.example.HybridApp', launchBusy: false, onRunning: () => {}, recoverSession: true})); }); };
  const reload = async (id: string) => {
    await service.setSession(id);
    await act(async () => { root.unmount(); });
    root = createRoot(document.getElementById('root')!);
    await render();
    for (let attempt = 0; attempt < 40; attempt++) {
      if (document.querySelector('.artifact-id')?.textContent?.includes(id)) return;
      await act(async () => { await settle(); });
    }
    assert.fail('workspace ' + id + ' did not load');
  };
  const until = async (read: () => boolean, description: string) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (read()) return;
      await act(async () => { await settle(); await new Promise(resolve => setTimeout(resolve, 40)); });
    }
    assert.fail('Timed out waiting for ' + description);
  };
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
  const advanced = () => document.querySelector<HTMLDetailsElement>('.workspace-advanced')!;
  const click = async (node: HTMLButtonElement) => {
    node.focus();
    await act(async () => { node.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  };
  const closeAdvanced = async () => {
    const summary = advanced().querySelector('summary');
    assert.ok(summary);
    await act(async () => { summary.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  };
  try {
    flowsRepair = false;
    await reload(restored.id);
    assert.equal(advanced().hidden, true);
    assert.equal(advanced().open, false);
    assert.equal(document.querySelector('.workspace-advanced[open]:not([hidden])'), null);
    assert.ok(document.querySelector('.scenario-sequence-bar'));
    const stored = await service.workspaceDetail(restored.id);
    assert.equal((stored.view as {panels?: {advanced?: boolean}}).panels?.advanced, true);

    await reload(omitted.id);
    assert.equal(advanced().hidden, true);
    assert.equal(advanced().open, false);
    const review = button('Review required values');
    assert.ok(review);
    assert.match(document.querySelector('.draft-banner')?.textContent ?? '', /PASSWORD/);
    assert.equal(document.querySelector('.go-to-issue'), null);
    viewWrites.length = 0;
    await click(review);
    assert.equal(advanced().hidden, false);
    assert.equal(advanced().open, true);
    const omittedField = document.getElementById('scenario-public-inputs');
    assert.ok(omittedField);
    assert.equal(document.activeElement, omittedField);
    assert.equal(omittedField.closest('[hidden]'), null);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    assert.equal(viewWrites.some(body => (body.panels as {advanced?: boolean} | undefined)?.advanced === true), false);
    await closeAdvanced();
    assert.equal(advanced().hidden, true);
    assert.equal(advanced().open, false);
    assert.ok(document.activeElement === review || document.activeElement === document.querySelector('[aria-label="Describe a flow"]'));
    assert.notEqual(document.activeElement, document.body);
    await reload(omitted.id);
    assert.equal(advanced().hidden, true);
    assert.equal(advanced().open, false);

    await reload(incomplete.id);
    const issue = button('Go to first issue');
    assert.ok(issue);
    assert.equal(advanced().hidden, true);
    await until(() => !!button('Repair Home ready'), 'step repair');
    await click(button('Repair Home ready')!);
    assert.equal(advanced().hidden, true);
    assert.equal(advanced().open, false);
    assert.notEqual(document.activeElement, document.body);
    assert.equal((document.activeElement as Element | null)?.closest('.workspace-advanced'), null);
    assert.ok((document.activeElement as Element | null)?.closest('.floating-inspector'), 'focused ' + ((document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? (document.activeElement as HTMLElement | null)?.className ?? document.activeElement?.nodeName));
    await click(issue);
    assert.equal(advanced().hidden, false);
    assert.equal(advanced().open, true);
    const issueTarget = document.querySelector<HTMLElement>('.yaml-value input, #reusable-flows, #scenario-public-inputs, .default-actions input, .default-actions select, #scenario-yaml');
    assert.equal(document.activeElement, issueTarget);
    assert.notEqual(document.activeElement, document.body);
    assert.equal(issueTarget?.closest('[hidden]'), null);

    flowsRepair = true;
    await reload(flows.id);
    await until(() => !!button('Repair flows') && !!button('Repair yaml') && !!button('Repair automation'), 'source repairs');
    assert.equal(advanced().hidden, true);
    await click(button('Repair flows')!);
    assert.equal(advanced().hidden, false);
    assert.equal(advanced().open, true);
    assert.equal(document.activeElement, document.getElementById('reusable-flows'));
    assert.equal(document.activeElement?.closest('[hidden]'), null);
    await closeAdvanced();
    assert.equal(advanced().hidden, true);
    await click(button('Repair yaml')!);
    assert.equal(advanced().hidden, false);
    assert.equal(document.activeElement, advanced().querySelector('[aria-label="YAML form and code editor"] button'));
    await click(button('Repair automation')!);
    assert.equal(advanced().hidden, false);
    assert.equal(document.activeElement, advanced().querySelector('.default-actions input, .default-actions select'));
    assert.notEqual(document.activeElement, document.body);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    await rm(directory, {recursive: true, force: true});
  }
});
