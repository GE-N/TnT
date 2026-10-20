import {openScenarioPanel} from './workspace-ui-helpers.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act, createElement} from 'react';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Scenarios} from '../src/scenarios.js';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
import type {FlowDraft, Preview} from '../server/authoring/types.js';
import type {GenerationView} from '../server/ai/store.js';

const SECRET = 'sk-test-secret-value';

test('AI flow authoring UI', async t => {
  await t.test('prompt, generating, and confirm yield a scenario that edits, saves, and reopens', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.status() === 'generating', 'generating');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'pending overlay');
      assert.equal(h.document.querySelector('[data-testid="ai-meta"]')?.textContent, '3 screens · 3 steps · not run yet');
      assert.ok(h.document.querySelector('[data-testid="ai-flow-dot"]'));
      assert.equal(h.document.querySelector('[data-draft-screen][data-screen-id]'), null);
      await h.until(() => h.confirmEnabled(), 'confirm');
      await h.click('[data-testid="ai-confirm"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-provenance"]'), 'provenance');
      assert.match(h.document.querySelector('[data-testid="ai-provenance"]')!.textContent ?? '', /Applied as/);
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]'), null);
      const workspace = await h.saved();
      assert.equal(workspace.scenarios?.some(item => item.name === 'Pay a bill' && item.authoring === 'canvas'), true);
      await h.fill('Screen title for Home', 'Home desk');
      await act(async () => h.document.querySelector('[aria-label="Screen title for Home"]')!.dispatchEvent(new h.dom.window.FocusEvent('focusout', {bubbles: true})));
      await h.until(async () => (await h.saved()).canvas?.screens.some(screen => screen.title === 'Home desk') === true, 'saved title');
      await h.remount();
      await h.until(() => !!h.document.querySelector('[aria-label="Screen title for Home desk"]'), 'reopened title');
      await openScenarioPanel(h.document, act);
      assert.ok([...h.document.querySelectorAll('button')].some(button => button.textContent === 'Pay a bill'));
      assert.equal(h.ai.generations, 1);
    } finally { await h.cleanup(); }
  });

  await t.test('confirm stays disabled while a target is unresolved or an assumption is unacknowledged', async () => {
    const h = await harness('needs');
    try {
      await h.render();
      await h.generate('Pay a bill that still needs a target');
      await h.until(() => /needs info/.test(h.reason()), 'unresolved reason');
      assert.equal(h.document.querySelector('[data-testid="ai-confirm"]')?.getAttribute('aria-disabled'), 'true');
      assert.match(h.reason(), /assumption is acknowledged/);
      await h.fill('Needs info selector for open', 'Bills');
      await h.clickText('Update');
      await h.until(() => h.reason() === 'Confirm is unavailable until every assumption is acknowledged.', 'ack reason');
      assert.equal(h.ai.generations, 1);
      assert.ok(h.ai.previews >= 1);
      await h.click('[aria-label="Paid means the confirmation screen."]');
      await h.until(() => h.confirmEnabled(), 'acks complete');
      assert.equal(h.document.querySelector('[data-testid="ai-confirm-reason"]'), null);
    } finally { await h.cleanup(); }
  });

  await t.test('one undo after confirm restores the pre-apply workspace', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'overlay');
      const before = h.documentOf(await h.saved());
      await h.until(() => h.confirmEnabled(), 'confirm');
      await h.click('[data-testid="ai-confirm"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-undo"]'), 'undo');
      assert.notEqual(h.documentOf(await h.saved()), before);
      await h.click('[data-testid="ai-undo"]');
      await h.until(async () => h.documentOf(await h.saved()) === before, 'restored');
      assert.equal((await h.saved()).scenarios?.length ?? 0, 0);
      assert.equal(h.ai.undos, 1);
    } finally { await h.cleanup(); }
  });

  await t.test('discard leaves the workspace byte-identical', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'overlay');
      const before = JSON.stringify(await h.saved());
      await h.click('[data-testid="ai-discard"]');
      await h.until(() => h.status() === 'idle', 'idle');
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]'), null);
      assert.equal(JSON.stringify(await h.saved()), before);
      assert.equal(h.ai.cancels, 0);
    } finally { await h.cleanup(); }
  });

  await t.test('reload keeps a pending draft and re-previews an expired preview', async () => {
    const h = await harness('expired');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'overlay');
      assert.equal(h.ai.previews, 0);
      await h.until(async () => {
        const detail = await h.service.workspaceDetail(h.workspaceId);
        const stored = detail.view && typeof detail.view === 'object' ? (detail.view as {aiDraft?: {jobId?: string}}).aiDraft : undefined;
        return !!stored?.jobId;
      }, 'persisted job');
      assert.equal(h.ai.generations, 1);
      await h.remount();
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'reloaded overlay');
      assert.equal(h.ai.generations, 1);
      assert.equal(h.ai.previews, 1);
      assert.equal(h.status(), 'pending');
    } finally { await h.cleanup(); }
  });

  await t.test('editing during generation marks the draft stale and refresh re-previews', async () => {
    const h = await harness('hold');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.status() === 'generating', 'generating');
      await h.until(() => h.ai.inflight > 0, 'poll');
      await h.addNode();
      await h.until(() => /workspace changed/.test(h.document.body.textContent ?? ''), 'stale');
      const placed = h.positions();
      assert.ok(placed);
      await h.until(() => h.ai.inflight > 0, 'stale poll');
      h.ai.release();
      await h.until(() => h.status() === 'stale' && !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'stale draft');
      assert.equal(h.ai.generations, 1);
      const previews = h.ai.previews;
      await h.click('[data-testid="ai-refresh"]');
      await h.until(() => h.status() === 'pending', 'refreshed');
      assert.equal(h.ai.generations, 1);
      assert.equal(h.ai.previews, previews + 1);
      assert.equal(h.positions(), placed);
      assert.ok(h.document.querySelector('[data-testid="ai-draft-chip"]'));
    } finally { await h.cleanup(); }
  });

  await t.test('a late job result is ignored after cancel', async () => {
    const h = await harness('hold');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.status() === 'generating', 'generating');
      await h.until(() => h.ai.inflight > 0, 'poll');
      await h.click('[data-testid="ai-cancel"]');
      await h.until(() => h.status() === 'prompting', 'prompt restored');
      h.ai.release();
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]'), null);
      assert.equal(h.status(), 'prompting');
      assert.equal((h.document.querySelector('[aria-label="Flow description"]') as HTMLTextAreaElement).value, 'Pay the electric bill');
      assert.equal(h.ai.generations, 1);
      assert.equal(h.ai.cancels, 1);
    } finally { await h.cleanup(); }
  });

  await t.test('confirm is blocked while a run is active', async () => {
    const h = await harness('ready', {deviceId: 'E5C92F6E-40DC-493C-93B4-469E67193736'});
    try {
      await h.render();
      await openScenarioPanel(h.document, act);
      await h.click('[aria-label="New scenario"]');
      await h.until(() => !!h.document.querySelector('[aria-label="Run scenario"]'), 'runnable scenario');
      await h.click('[aria-label="Run scenario"]');
      await h.until(() => h.document.querySelector('.result-tag')?.textContent === 'running', 'running');
      await h.generate('Pay the electric bill');
      await h.until(() => /run is active/.test(h.reason()), 'run block');
      assert.equal(h.document.querySelector('[data-testid="ai-confirm"]')?.getAttribute('aria-disabled'), 'true');
      await h.click('[data-testid="ai-confirm"]');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
      assert.equal(h.ai.applies, 0);
    } finally { await h.cleanup(); }
  });

  await t.test('provider settings never show a saved key', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.click('.workspace-advanced > summary');
      await h.until(() => h.document.querySelector('[data-testid="ai-has-key"]')?.textContent?.startsWith('API key saved') === true, 'has key');
      const key = h.document.querySelector('[data-testid="ai-api-key"]') as HTMLInputElement;
      assert.equal(key.value, '');
      assert.equal(key.type, 'password');
      assert.equal(h.document.body.innerHTML.includes(SECRET), false);
      const settings = h.document.querySelector('[data-testid="ai-settings"]')?.textContent ?? '';
      assert.match(settings, /OpenRouter/);
      assert.match(settings, /OpenAI-compatible/);
      assert.doesNotMatch(h.document.body.textContent ?? '', /ollama|lm studio/i);
    } finally { await h.cleanup(); }
  });

  await t.test('a failed save does not start a generation', async () => {
    const h = await harness('ready', {failSave: true});
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-error"]'), 'save error');
      assert.match(h.document.querySelector('[data-testid="ai-error"]')!.textContent ?? '', /workspace was changed/);
      assert.equal(h.ai.generations, 0);
      assert.ok(h.document.querySelector('[data-testid="ai-retry"]'));
    } finally { await h.cleanup(); }
  });

  // Pre-fix (2f67ffe ProviderSettings.save(thenCheck)): Test connection called save(true),
  // which PUT /api/ai/config and then setApiKey(''). The typed key disappeared and a save was sent.
  await t.test('typing a key and testing the connection does not save or clear it', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.click('.workspace-advanced > summary');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-api-key"]'), 'key field');
      await h.fill('API key', 'sk-typed-key');
      h.ai.holdNextTest();
      await h.click('[data-testid="ai-test-connection"]');
      await h.until(() => /Testing connection/.test(h.document.body.textContent ?? ''), 'testing');
      const field = () => h.document.querySelector('[data-testid="ai-api-key"]') as HTMLInputElement;
      assert.equal(field().value, 'sk-typed-key');
      assert.equal(h.ai.puts.length, 0);
      await h.fill('API key', 'sk-typed-key-edited');
      h.ai.releaseTest();
      await h.until(() => !/Testing connection/.test(h.document.body.textContent ?? ''), 'test finished');
      assert.equal(field().value, 'sk-typed-key-edited');
      assert.equal(h.ai.puts.length, 0);
      assert.doesNotMatch(h.document.querySelector('[data-testid="ai-settings"]')?.textContent ?? '', /Connected to OpenRouter/);
      assert.equal(JSON.stringify(h.ai.tests[0]).includes('sk-typed-key-edited'), false);
      assert.equal((h.ai.tests[0] as {source?: string}).source, 'replacement');
    } finally { await h.cleanup(); }
  });

  await t.test('a failed save keeps the typed key and never sends an empty apiKey', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.click('.workspace-advanced > summary');
      await h.until(() => h.document.querySelector('[data-testid="ai-save"]')?.hasAttribute('disabled') === false, 'save ready');
      await h.click('[data-testid="ai-save"]');
      await h.until(() => h.ai.puts.length === 1, 'keep save');
      assert.equal((h.ai.puts[0] as {credential?: {action?: string; apiKey?: string}}).credential?.action, 'keep');
      assert.equal(JSON.stringify(h.ai.puts[0]).includes('apiKey'), false);
      h.ai.failNextPut();
      await h.fill('API key', 'sk-keep-me');
      await h.click('[data-testid="ai-save"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-save-error"]'), 'save failed');
      assert.equal((h.document.querySelector('[data-testid="ai-api-key"]') as HTMLInputElement).value, 'sk-keep-me');
      const sent = h.ai.puts[1] as {credential?: {action?: string; apiKey?: string}};
      assert.equal(sent.credential?.action, 'replace');
      assert.equal(sent.credential?.apiKey, 'sk-keep-me');
    } finally { await h.cleanup(); }
  });

  await t.test('a pending draft survives a workspace switch and back', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'overlay');
      const origin = h.workspaceId;
      await h.service.save({name: 'Other workspace', yaml: 'appId: com.example.HybridApp\n---\n- launchApp\n'});
      await h.click('[aria-label="Manage workspace"]');
      await h.clickText('View all workspaces');
      await h.until(() => !!h.document.querySelector('button[aria-label^="Open Other workspace"]'), 'library');
      await h.click('button[aria-label^="Open Other workspace"]');
      await h.until(() => (h.document.body.textContent ?? '').includes('Other workspace') && h.document.querySelector('[data-testid="ai-draft-chip"]') === null, 'switched away');
      assert.equal(h.ai.cancels, 0);
      await h.click('[aria-label="Manage workspace"]');
      await h.clickText('View all workspaces');
      await h.until(() => !!h.document.querySelector('button[aria-label^="Open Untitled workspace"]'), 'origin listed');
      await h.click('button[aria-label^="Open Untitled workspace"]');
      await h.until(() => (h.document.body.textContent ?? '').includes('Untitled workspace') && h.workspaceId === origin && !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'draft returned');
      assert.equal(h.document.querySelector('[data-testid="ai-confirm"]')?.getAttribute('aria-disabled') ?? null, null);
    } finally { await h.cleanup(); }
  });

  await t.test('the composer chip provider and model are sent with the next request only', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.click('[data-testid="ai-flow-button"]');
      await h.fill('Flow description', 'Pay the electric bill');
      await h.click('[data-testid="ai-provider-chip"]');
      await h.click('[data-testid="ai-chip-openai-compatible"]');
      await h.fill('Model for the next request', 'gpt-next');
      h.ai.holdNextJob();
      await h.click('[data-testid="ai-generate"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-disclosure-continue"]') || h.status() === 'generating', 'disclosure or start');
      if (h.document.querySelector('[data-testid="ai-disclosure-continue"]')) await h.click('[data-testid="ai-disclosure-continue"]');
      await h.until(() => h.status() === 'generating', 'generating with the chip');
      assert.match(h.document.querySelector('[data-testid="ai-progress-model"]')?.textContent ?? '', /OpenAI-compatible · gpt-next/);
      const sent = h.ai.generationBodies[0] as {provider?: string; model?: string};
      assert.equal(sent.provider, 'openai-compatible');
      assert.equal(sent.model, 'gpt-next');
      assert.equal(h.ai.puts.length, 0);
      h.ai.release();
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'draft ready');
      assert.match(h.document.querySelector('[data-testid="ai-usage"]')?.textContent ?? '', /gpt-next/);
    } finally { await h.cleanup(); }
  });

  await t.test('saving a key then generating uses the new settings without a reload', async () => {
    const h = await harness('ready', {unconfigured: true});
    try {
      await h.render();
      await h.click('.workspace-advanced > summary');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-api-key"]'), 'key field');
      await h.fill('Model', 'vendor/model');
      await h.fill('API key', 'sk-fresh-key');
      await h.click('[data-testid="ai-save"]');
      await h.until(() => /API key saved/.test(h.document.querySelector('[data-testid="ai-has-key"]')?.textContent ?? ''), 'key saved');
      await h.click('[data-testid="ai-flow-button"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-generate"]'), 'generate enabled');
      await h.fill('Flow description', 'Pay the electric bill');
      await h.click('[data-testid="ai-generate"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-disclosure-continue"]') || h.ai.generations === 1, 'disclosure or start');
      if (h.document.querySelector('[data-testid="ai-disclosure-continue"]')) await h.click('[data-testid="ai-disclosure-continue"]');
      await h.until(() => h.ai.generations === 1, 'generation started');
      assert.equal((h.ai.generationBodies.at(-1) as {expectedSettingsRevision?: number}).expectedSettingsRevision, 1);
    } finally { await h.cleanup(); }
  });

  await t.test('refresh after settings changed sends the new revision', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      h.ai.rejectNextGeneration();
      await h.generate('Pay the electric bill');
      await h.until(() => /Refresh and generate again/.test(h.document.body.textContent ?? ''), 'refresh offered');
      const first = h.ai.generationBodies[0] as {expectedSettingsRevision?: number};
      await h.click('[data-testid="ai-retry"]');
      await h.until(() => h.ai.generationBodies.length >= 2, 'retried');
      const second = h.ai.generationBodies[1] as {expectedSettingsRevision?: number};
      assert.equal(second.expectedSettingsRevision, (first.expectedSettingsRevision ?? 0) + 1);
      await h.until(() => h.ai.generations === 1, 'generation started');
    } finally { await h.cleanup(); }
  });

  await t.test('switching workspace during refine keeps the previous draft and ignores the late result', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'overlay');
      const origin = h.workspaceId;
      await h.click('[data-testid="ai-refine"]');
      await h.fill('Flow description', 'Add a receipt');
      h.ai.holdNextJob();
      await h.click('[data-testid="ai-generate"]');
      await h.until(() => h.status() === 'generating', 'refining');
      await h.service.save({name: 'Other workspace', yaml: 'appId: com.example.HybridApp\n---\n- launchApp\n'});
      await h.click('[aria-label="Manage workspace"]');
      await h.clickText('View all workspaces');
      await h.until(() => !!h.document.querySelector('button[aria-label^="Open Other workspace"]'), 'library');
      await h.click('button[aria-label^="Open Other workspace"]');
      await h.until(() => (h.document.body.textContent ?? '').includes('Other workspace') && h.document.querySelector('[data-testid="ai-draft-chip"]') === null, 'switched away');
      assert.equal(h.ai.cancels, 1);
      await h.click('[aria-label="Manage workspace"]');
      await h.clickText('View all workspaces');
      await h.until(() => !!h.document.querySelector('button[aria-label^="Open Untitled workspace"]'), 'origin listed');
      await h.click('button[aria-label^="Open Untitled workspace"]');
      await h.until(() => (h.document.body.textContent ?? '').includes('Untitled workspace') && h.workspaceId === origin && !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'draft returned');
      assert.equal(h.status(), 'pending');
      assert.equal(h.document.querySelector('[data-testid="ai-confirm"]')?.getAttribute('aria-disabled') ?? null, null);
      h.ai.release();
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
      assert.equal(h.status(), 'pending');
      assert.equal(h.document.body.textContent?.includes('Late refine'), false);
      assert.ok(h.document.querySelector('[data-testid="ai-draft-chip"]'));
    } finally { await h.cleanup(); }
  });
});

type Mode = 'ready' | 'hold' | 'expired' | 'needs';
type Job = {id: string; workspaceId: string; baseRevision: number; state: 'running' | 'pending' | 'needsInfo' | 'cancelled'; phase: GenerationView['phase']; draft?: FlowDraft; preview?: Preview; model?: string; upstreamProvider?: string};
type ScenarioService = ReturnType<typeof createScenarios>;

async function harness(mode: Mode, options: {deviceId?: string; failSave?: boolean; unconfigured?: boolean} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tnt-ai-flow-ui-'));
  const service = createScenarios({
    root: directory,
    trustDirectory: join(directory, 'trust'),
    runner: createRunner({artifactDirectory: directory, execute: async () => ({stdout: '', stderr: ''})}),
    maestro: {version: async () => '0', run: async () => ({code: 0, log: '', cleanup: {verified: true, detail: 'ok'}})},
  });
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'];
  const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  class ResizeObserver { observe() {} disconnect() {} }
  const ai = createFake(mode, service, options);
  let workspaceId = '';
  const runs = new Map<string, unknown>();
  const fetchImpl = async (path: string, init?: {method?: string; body?: string}) => {
    const url = new URL(path, 'http://tnt.local');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    try {
      if (method === 'GET' && url.pathname === '/api/workspaces') return Response.json(await service.listWorkspaces(url.searchParams.get('q') ?? ''));
      const opened = /^\/api\/workspaces\/([0-9a-f-]{36})\/open$/.exec(url.pathname);
      if (method === 'POST' && opened) return Response.json(await service.openWorkspace(opened[1]));
      if (url.pathname.startsWith('/api/ai/') || url.pathname.startsWith('/api/authoring/')) {
        const result = await ai.route(method, url.pathname + url.search, body);
        if (method === 'POST' && url.pathname === '/api/ai/generations' && body && typeof body.workspaceId === 'string') workspaceId = body.workspaceId;
        return Response.json(result.body, {status: result.status});
      }
      if (method === 'POST' && url.pathname === '/api/workspaces') {
        if (options.failSave) return Response.json({error: 'The workspace was changed.', code: 'REVISION_CONFLICT'}, {status: 409});
        const saved = await service.save(body as never);
        workspaceId = saved.id;
        return Response.json(saved);
      }
      if (method === 'GET' && url.pathname === '/api/session') return Response.json(await service.session());
      if (method === 'POST' && url.pathname === '/api/canvas/references') return Response.json(await service.references(body as never));
      if (method === 'GET' && url.pathname === '/api/scripts/trust') return Response.json({scripts: []});
      if (method === 'POST' && url.pathname === '/api/runs') {
        const id = '11111111-1111-4111-8111-111111111111';
        const run = runningRun(id, String(body?.workspaceId ?? ''), String(body?.deviceId ?? ''));
        runs.set(id, run);
        return Response.json(run, {status: 202});
      }
      const run = /^\/api\/runs\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (method === 'GET' && run) return Response.json(runs.get(run[1]) ?? {error: 'Missing run.'}, {status: runs.has(run[1]) ? 200 : 404});
      const workspace = /^\/api\/workspaces\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (method === 'GET' && workspace) return Response.json(await service.workspaceDetail(workspace[1]));
      const view = /^\/api\/workspaces\/([0-9a-f-]{36})\/view$/.exec(url.pathname);
      if (method === 'POST' && view) return Response.json(await service.saveView(view[1], body));
      return Response.json({error: 'Unknown ' + method + ' ' + url.pathname}, {status: 404});
    } catch (error) {
      return Response.json({error: error instanceof Error ? error.message : 'Request failed.'}, {status: 400});
    }
  };
  for (const key of keys) Object.defineProperty(globalThis, key, {value: key === 'fetch' ? fetchImpl : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'ResizeObserver' ? ResizeObserver : Reflect.get(dom.window, key), configurable: true});
  const {createRoot} = await import('react-dom/client');
  const document = dom.window.document;
  let root = createRoot(document.getElementById('root')!);
  const render = (recover = false) => act(async () => { root.render(createElement(Scenarios, {token: 'local', deviceId: options.deviceId ?? '', bundleId: 'com.example.HybridApp', launchBusy: false, onRunning: () => {}, recoverSession: recover})); });
  const click = async (selector: string) => act(async () => { const node = document.querySelector<HTMLElement>(selector); assert.ok(node, selector); node.click(); });
  const clickText = async (text: string) => act(async () => { const node = [...document.querySelectorAll('button')].find(button => button.textContent === text); assert.ok(node, text); node.click(); });
  const fill = async (label: string, value: string) => act(async () => {
    const node = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
    assert.ok(node, label);
    const proto = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
  });
  const until = async (read: () => boolean | Promise<boolean>, label: string) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await read()) return;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    }
    assert.fail(label + ' — status ' + (document.querySelector('[data-testid="ai-flow"]')?.getAttribute('data-ai-status') ?? 'missing') + ' — ' + (document.body.textContent ?? '').slice(0, 400));
  };
  return {
    dom, document, service, ai,
    get workspaceId() { return workspaceId; },
    status: () => document.querySelector('[data-testid="ai-flow"]')?.getAttribute('data-ai-status') ?? '',
    reason: () => document.querySelector('[data-testid="ai-confirm-reason"]')?.textContent ?? '',
    confirmEnabled: () => { const button = document.querySelector('[data-testid="ai-confirm"]'); return !!button && button.getAttribute('aria-disabled') !== 'true'; },
    positions: () => [...document.querySelectorAll<HTMLElement>('[data-screen-id]')].map(node => node.dataset.screenId + ':' + node.style.left + ':' + node.style.top).join('|'),
    saved: () => service.workspace(workspaceId),
    documentOf: (workspace: {name: string; yaml: string; flows?: unknown; scenarios?: unknown; canvas?: unknown; automation?: unknown; mock?: unknown}) => JSON.stringify({name: workspace.name, yaml: workspace.yaml, flows: workspace.flows ?? {}, scenarios: workspace.scenarios ?? [], canvas: workspace.canvas ?? null, automation: workspace.automation ?? null, mock: workspace.mock ?? null}),
    render, click, clickText, fill, until,
    generate: async (prompt: string) => {
      await click('[data-testid="ai-flow-button"]');
      await fill('Flow description', prompt);
      await click('[data-testid="ai-generate"]');
      for (let attempt = 0; attempt < 20; attempt++) {
        if (document.querySelector('[data-testid="ai-disclosure-continue"]')) {
          await click('[data-testid="ai-disclosure-continue"]');
          return;
        }
        const status = document.querySelector('[data-testid="ai-flow"]')?.getAttribute('data-ai-status');
        if (status === 'generating' || status === 'failed' || document.querySelector('[data-testid="ai-error"]')) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
      }
    },
    addNode: async () => {
      await act(async () => document.querySelector('.canvas-surface')!.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 120, clientY: 120})));
      await clickText('Add node');
    },
    remount: async () => {
      await act(async () => root.unmount());
      root = createRoot(document.getElementById('root')!);
      await render(true);
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
      await rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
    },
  };
}

type FakeConfig = {
  settingsRevision: number;
  selected: 'openrouter' | 'openai-compatible';
  providers: Record<'openrouter' | 'openai-compatible', {model: string; baseUrl?: string; configured: boolean; keySource?: 'keychain' | 'session'; credentialRevision: number; storageAvailable: boolean}>;
};

function unconfiguredConfig(): FakeConfig {
  return {
    settingsRevision: 0,
    selected: 'openrouter',
    providers: {
      openrouter: {model: '', configured: false, credentialRevision: 0, storageAvailable: true},
      'openai-compatible': {model: '', baseUrl: 'https://api.openai.com/v1', configured: false, credentialRevision: 0, storageAvailable: true},
    },
  };
}

function applyPut(config: FakeConfig, body: Record<string, unknown> | undefined) {
  const id = body?.provider === 'openai-compatible' ? 'openai-compatible' : 'openrouter';
  const entry = config.providers[id];
  if (typeof body?.model === 'string') entry.model = body.model;
  if (typeof body?.baseUrl === 'string' && id === 'openai-compatible') entry.baseUrl = body.baseUrl;
  if (body?.selected === 'openrouter' || body?.selected === 'openai-compatible') config.selected = body.selected;
  const credential = body?.credential as {action?: string; apiKey?: string; storage?: string} | undefined;
  if (credential?.action === 'replace' && credential.apiKey) {
    entry.configured = true;
    entry.keySource = credential.storage === 'session' ? 'session' : 'keychain';
    entry.credentialRevision += 1;
  } else if (credential?.action === 'remove') {
    entry.configured = false;
    entry.keySource = undefined;
  }
  config.settingsRevision += 1;
  return structuredClone(config);
}

function savedConfig(): FakeConfig {
  return {
    settingsRevision: 2,
    selected: 'openrouter' as const,
    providers: {
      openrouter: {model: 'vendor/model', configured: true, keySource: 'keychain' as const, credentialRevision: 1, storageAvailable: true},
      'openai-compatible': {model: 'gpt-test', baseUrl: 'https://api.openai.com/v1', configured: true, keySource: 'keychain' as const, credentialRevision: 1, storageAvailable: true},
    },
  };
}

function createFake(mode: Mode, service: ScenarioService, options: {unconfigured?: boolean} = {}) {
  const jobs = new Map<string, Job>();
  const applied = new Map<string, unknown>();
  const snapshots = new Map<string, Awaited<ReturnType<ScenarioService['workspace']>>>();
  const waiters: Array<() => void> = [];
  const testWaiters: Array<() => void> = [];
  const puts: unknown[] = [];
  const tests: unknown[] = [];
  const generationBodies: unknown[] = [];
  const heldJobs = new Set<string>();
  let config: FakeConfig = options.unconfigured ? unconfiguredConfig() : savedConfig();
  let released = false;
  let holdTest = false;
  let holdNext = false;
  let failPut = false;
  let rejectGeneration = false;
  const counts = {generations: 0, previews: 0, applies: 0, cancels: 0, undos: 0, inflight: 0};
  return {
    get generations() { return counts.generations; },
    get previews() { return counts.previews; },
    get applies() { return counts.applies; },
    get cancels() { return counts.cancels; },
    get undos() { return counts.undos; },
    get inflight() { return counts.inflight; },
    get puts() { return puts; },
    get tests() { return tests; },
    get generationBodies() { return generationBodies; },
    holdNextTest() { holdTest = true; },
    holdNextJob() { holdNext = true; },
    rejectNextGeneration() { rejectGeneration = true; },
    releaseTest() { holdTest = false; for (const resolve of testWaiters.splice(0)) resolve(); },
    failNextPut() { failPut = true; },
    release() {
      released = true;
      for (const job of jobs.values()) {
        if (heldJobs.has(job.id) && job.state === 'running') job.draft = lateDraft();
        finish(job, mode);
      }
      for (const resolve of waiters.splice(0)) resolve();
    },
    async route(method: string, pathname: string, body?: Record<string, unknown>) {
      const path = pathname.split('?')[0];
      if (method === 'GET' && path === '/api/ai/config') return {status: 200, body: structuredClone(config)};
      if (method === 'GET' && path === '/api/ai/models') return {status: 200, body: {provider: 'openrouter', models: [{id: 'vendor/model'}, {id: 'openai/gpt-test'}]}};
      if (method === 'PUT' && path === '/api/ai/config') {
        puts.push(body);
        if (failPut) { failPut = false; return {status: 500, body: {error: 'The settings service did not answer.', code: 'REQUEST_FAILED'}}; }
        return {status: 200, body: applyPut(config, body)};
      }
      if (method === 'POST' && path === '/api/ai/config/test') {
        tests.push(body);
        if (holdTest) await new Promise<void>(resolve => testWaiters.push(resolve));
        return {status: 200, body: {testId: body?.testId, ok: true, message: "Connected to OpenRouter. The model hasn't been tested yet."}};
      }
      if (method === 'POST' && path === '/api/ai/generations') {
        generationBodies.push(structuredClone(body));
        if (rejectGeneration) {
          rejectGeneration = false;
          config = {...config, settingsRevision: config.settingsRevision + 1};
          return {status: 409, body: {error: 'Settings changed in another session. Refresh and try again.', code: 'SETTINGS_CHANGED'}};
        }
        counts.generations++;
        const job: Job = {id: crypto.randomUUID(), workspaceId: String(body?.workspaceId), baseRevision: Number(body?.expectedRevision), state: 'running', phase: 'model', draft: mode === 'needs' ? needsDraft() : happyDraft(), ...(typeof body?.model === 'string' ? {model: body.model} : {}), ...(body?.provider === 'openrouter' ? {upstreamProvider: 'openrouter-upstream'} : {})};
        if (holdNext) { heldJobs.add(job.id); holdNext = false; }
        jobs.set(job.id, job);
        return {status: 202, body: viewOf(job, mode)};
      }
      const generation = /^\/api\/ai\/generations\/([^/]+)(?:\/(cancel))?$/.exec(path);
      if (generation && method === 'GET') {
        const job = jobs.get(generation[1]);
        if (!job) return {status: 404, body: {error: 'Missing job.', code: 'NOT_FOUND'}};
        counts.inflight++;
        try {
          const parked = mode === 'hold' || heldJobs.has(job.id);
          if (parked && job.state === 'running' && !released) await new Promise<void>(resolve => waiters.push(resolve));
          const view = viewOf(job, mode);
          if (!parked && job.state === 'running') finish(job, mode);
          return {status: 200, body: view};
        } finally { counts.inflight--; }
      }
      if (generation && method === 'POST' && generation[2] === 'cancel') {
        counts.cancels++;
        const job = jobs.get(generation[1]);
        if (job) job.state = 'cancelled';
        return {status: 200, body: job ? viewOf(job, mode) : {error: 'Missing job.', code: 'NOT_FOUND'}};
      }
      if (method === 'POST' && path === '/api/authoring/context') return {status: 200, body: {contextId: crypto.randomUUID(), workspaceId: body?.workspaceId, revision: body?.expectedRevision, expiresAt: new Date(Date.now() + 60_000).toISOString()}};
      if (method === 'POST' && path === '/api/authoring/preview') {
        counts.previews++;
        return {status: 200, body: previewFor(String(body?.workspaceId), Number(body?.expectedRevision), body?.draft as FlowDraft)};
      }
      if (method === 'POST' && path === '/api/authoring/apply') return {status: 200, body: await applyDraft(service, counts, applied, snapshots, body ?? {})};
      if (method === 'POST' && path === '/api/authoring/undo') return {status: 200, body: await undoDraft(service, counts, snapshots, body ?? {})};
      return {status: 404, body: {error: 'Unknown authoring route.', code: 'NOT_FOUND'}};
    },
  };
}

async function applyDraft(service: ScenarioService, counts: {applies: number}, applied: Map<string, unknown>, snapshots: Map<string, Awaited<ReturnType<ScenarioService['workspace']>>>, body: Record<string, unknown>) {
  counts.applies++;
  const key = String(body.idempotencyKey);
  const existing = applied.get(key);
  if (existing) return existing;
  const current = await service.workspace(String(body.workspaceId));
  const stamp = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const scenarioId = 'scenario' + stamp;
  const pathId = 'path' + stamp;
  const screenId = 'screen' + stamp;
  snapshots.set('pending:' + key, structuredClone(current));
  const saved = await service.save({
    id: current.id, name: current.name, yaml: current.yaml, flows: current.flows, mock: current.mock, automation: current.automation,
    canvas: {screens: [...(current.canvas?.screens ?? []), {id: screenId, title: 'Home', x: 40, y: 40, tests: []}], edges: [...(current.canvas?.edges ?? [])], paths: [...(current.canvas?.paths ?? []), {id: pathId, name: 'Pay a bill', screenId, scenarioId, edgeIds: []}]},
    scenarios: [...(current.scenarios ?? []), {id: scenarioId, name: 'Pay a bill', authoring: 'canvas' as const, pathId, steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}],
    expectedRevision: Number(body.expectedRevision),
  });
  const receiptId = crypto.randomUUID();
  snapshots.set(receiptId, snapshots.get('pending:' + key)!);
  const result = {workspaceId: saved.id, revision: saved.metadata?.revision ?? 0, scenarioId, pathId, identityMap: {}, runReadiness: 'requires-preflight' as const, diagnostics: [], authoring: 'external' as const, receiptId};
  applied.set(key, result);
  return result;
}

async function undoDraft(service: ScenarioService, counts: {undos: number}, snapshots: Map<string, Awaited<ReturnType<ScenarioService['workspace']>>>, body: Record<string, unknown>) {
  const snapshot = snapshots.get(String(body.receiptId));
  if (!snapshot) throw new Error('Missing undo receipt.');
  const saved = await service.save({
    id: snapshot.id, name: snapshot.name, yaml: snapshot.yaml, flows: snapshot.flows, mock: snapshot.mock, automation: snapshot.automation,
    canvas: snapshot.canvas, scenarios: snapshot.scenarios, expectedRevision: Number(body.expectedRevision),
  });
  counts.undos++;
  return {workspaceId: saved.id, revision: saved.metadata?.revision ?? 0, receiptId: String(body.receiptId), scenarioId: snapshot.scenarios?.[0]?.id ?? '', undone: true as const};
}

function happyDraft(): FlowDraft {
  const tap = (key: string, value: string, visitKey: string): FlowDraft['visits'][number]['operations'][number] => ({key, kind: 'tap', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value}}, destination: {kind: 'visit', visitKey}});
  return {
    schemaVersion: 1, mode: 'createScenario', name: 'Pay a bill', appId: 'com.example.HybridApp', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens: [{key: 'home', kind: 'create', title: 'Home'}, {key: 'bills', kind: 'create', title: 'Bills'}, {key: 'done', kind: 'create', title: 'Done'}],
    visits: [
      {key: 'v1', screenKey: 'home', operations: [tap('open', 'Bills', 'v2')]},
      {key: 'v2', screenKey: 'bills', operations: [tap('pay', 'Pay', 'v3')]},
      {key: 'v3', screenKey: 'done', operations: [{key: 'see', kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Done'}}}]},
    ],
    scripts: [], assumptions: [],
  };
}

function needsDraft(): FlowDraft {
  return {
    schemaVersion: 1, mode: 'createScenario', name: 'Pay a bill', appId: 'com.example.HybridApp', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens: [{key: 'home', kind: 'create', title: 'Home'}],
    visits: [{key: 'v1', screenKey: 'home', operations: [{key: 'open', kind: 'tap', target: {kind: 'unresolved', description: 'the bills button'}, destination: {kind: 'stay'}}]}],
    scripts: [],
    assumptions: [{key: 'paid', message: 'Paid means the confirmation screen.', about: ['open'], requiresConfirmation: true}],
  };
}

function diagnose(draft: FlowDraft) {
  const diagnostics: Preview['diagnostics'] = [];
  draft.visits.forEach((visit, visitIndex) => visit.operations.forEach((operation, operationIndex) => {
    if ('target' in operation && operation.target.kind === 'unresolved') diagnostics.push({code: 'UNRESOLVED_TARGET', path: `/visits/${visitIndex}/operations/${operationIndex}/target`, entityKey: operation.key, severity: 'error', blocks: ['apply'], message: 'Choose a target for ' + operation.key + '.', remedy: 'Fill the selector.'});
  }));
  return {applicable: diagnostics.length === 0, diagnostics, requiredAssumptionKeys: draft.assumptions.filter(item => item.requiresConfirmation).map(item => item.key)};
}

function previewFor(workspaceId: string, revision: number, draft: FlowDraft): Preview {
  const diagnosed = diagnose(draft);
  return {
    previewId: crypto.randomUUID(), workspaceId, baseRevision: revision, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    contractVersion: 1, compilerVersion: 'test', draftHash: 'hash', applicable: diagnosed.applicable, authoringComplete: diagnosed.applicable,
    runReadiness: 'requires-preflight', requiredAssumptionKeys: diagnosed.requiredAssumptionKeys, diagnostics: diagnosed.diagnostics,
    changes: {created: [], reused: [], updated: []}, identityMap: {}, timeline: [],
  };
}

function finish(job: Job, mode: Mode) {
  if (job.state !== 'running') return;
  job.draft = job.draft ?? (mode === 'needs' ? needsDraft() : happyDraft());
  const diagnosed = diagnose(job.draft);
  job.state = diagnosed.applicable ? 'pending' : 'needsInfo';
  job.preview = previewFor(job.workspaceId, job.baseRevision, job.draft);
}

function viewOf(job: Job, mode: Mode): GenerationView {
  const finished = job.state !== 'running';
  return {
    id: job.id, workspaceId: job.workspaceId, state: job.state, phase: job.phase, provenance: 'ai', contractVersion: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...(job.model ? {model: job.model} : {}),
    ...(job.upstreamProvider ? {upstreamProvider: job.upstreamProvider} : {}),
    ...(finished && mode !== 'expired' && job.preview ? {previewId: job.preview.previewId, preview: job.preview} : {}),
    ...(finished && job.draft ? {draft: job.draft} : {}),
  };
}

function lateDraft(): FlowDraft {
  return {
    schemaVersion: 1, mode: 'createScenario', name: 'Late refine', appId: 'com.example.HybridApp', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens: [{key: 'late', kind: 'create', title: 'Late refine'}],
    visits: [{key: 'v1', screenKey: 'late', operations: [{key: 'see', kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Late refine'}}}]}],
    scripts: [], assumptions: [],
  };
}

function runningRun(id: string, workspaceId: string, deviceId: string) {
  return {
    id, deviceId, startedAt: '2026-10-20T00:00:00.000Z', status: 'running',
    snapshot: {id: 'snap', workspaceId, name: 'Untitled workspace', yaml: 'appId: com.example.HybridApp\n---\n- launchApp\n', steps: [], toolVersions: {maestro: '0', node: '22'}, runtimeInputPolicy: 'none'},
    steps: [], log: '', cleanup: {verified: false, detail: 'pending'}, artifacts: [], mappingNote: '',
  };
}
