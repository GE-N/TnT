import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement, type ReactNode} from 'react';
import type {FlowDraft, Preview} from '../server/authoring/types.js';
import type {GenerationView} from '../server/ai/store.js';
import {readFileSync} from 'node:fs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const css = readFileSync(new URL('../src/knowledge.css', import.meta.url), 'utf8');

const flowDraft: FlowDraft = {
  schemaVersion: 1, mode: 'createScenario', name: 'Guest checkout', appId: 'com.example.Shop', parameters: [],
  execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
  screens: [{key: 'product', kind: 'create', title: 'Product'}],
  visits: [{key: 'v1', screenKey: 'product', operations: [{key: 'note', kind: 'tap', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Note'}}, destination: {kind: 'stay'}}]}],
  scripts: [], assumptions: [],
};

function preview(revision: number): Preview {
  return {
    previewId: '33333333-3333-4333-8333-333333333333', workspaceId, baseRevision: revision,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), contractVersion: 1, compilerVersion: 'test',
    draftHash: 'hash', applicable: true, authoringComplete: true, runReadiness: 'requires-preflight',
    requiredAssumptionKeys: [], diagnostics: [], changes: {created: [], reused: [], updated: []}, identityMap: {}, timeline: [],
  };
}

type Mode = 'running' | 'knowledge' | 'ask' | 'mixed';

function knowledgeDraft(revision = 4) {
  return {
    purpose: 'Let a guest buy with no account.',
    expectedOutcome: 'The shopper reaches Cart.',
    rationale: 'First-time buyers skip account setup.',
    preconditions: 'The shop is open.',
    exceptions: '',
    scope: '',
    baseContextRevision: revision,
  };
}

function detail(revision = 4, freshness: 'up-to-date' | 'updating' = 'up-to-date') {
  return {
    workspaceId, scenarioId: 'guest', title: 'Guest checkout',
    context: {
      schemaVersion: 1, workspaceId, scenarioId: 'guest', contextRevision: revision,
      updatedAt: '2026-11-10T00:00:00.000Z', reviewedAgainstSourceHash: 'ab'.repeat(32),
      purpose: 'Buy as a member.', expectedOutcome: 'The shopper reaches the register.',
      rationale: 'First-time buyers skip account setup.', preconditions: 'The shop is open.', exceptions: '', scope: '',
    },
    sourceDescriptor: {projectionVersion: 1, workspaceRevision: 3, sourceHash: 'ab'.repeat(32)},
    flow: {steps: [{number: 1, text: '1 · Open the shop'}], visits: [], diagnostics: []},
    evidence: {status: null, runId: null, finishedAt: null, label: 'No runs yet', notice: ''},
    freshness, publicationFreshness: freshness === 'up-to-date' ? 'current' : 'publication-stale',
    intentFreshness: 'reviewed', generationId: null, generatedAt: null, publicationError: null,
    readerUrl: `/knowledge/workspaces/${workspaceId}/#scenario-guest`,
  };
}

test('draft tint uses the gutter and does not move the text column', () => {
  assert.match(css, /\.knowledge-field\.is-draft\{[^}]*margin-left:-16px;margin-right:-16px;padding:8px 16px/);
  assert.match(css, /\.knowledge-field\.is-draft\{[^}]*background:rgba\(10,132,255,\.08\)/);
  assert.match(css, /\.knowledge-field\.is-draft::before\{[^}]*width:2px;background:#0a84ff/);
});

async function withDom(body: (window: Window, root: {render: (node: ReactNode) => void; unmount: () => void}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {url: 'http://127.0.0.1:4317/'});
  const window = dom.window;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const keys = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'KeyboardEvent', 'PointerEvent', 'MouseEvent', 'MutationObserver', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT', 'navigator', 'sessionStorage'];
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'ResizeObserver' ? ResizeObserver : Reflect.get(window, key), configurable: true});
  }
  const {createRoot} = await import('react-dom/client');
  const root = createRoot(window.document.getElementById('root')!);
  try { await body(window as unknown as Window, root); }
  finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    window.close();
  }
}

test('knowledge review uses the Ask AI capsule, the info sheet, and a 10s undo', async () => {
  await withDom(async (window, root) => {
    const world: {mode: Mode; released: boolean; apply: 'ok' | 'down' | 'conflict'; applies: {expectedContextRevision: number}[]; reads: number; loaded: number; holdRead: boolean} = {
      mode: 'running', released: false, apply: 'ok', applies: [], reads: 0, loaded: 0, holdRead: false,
    };
    let releaseRead = () => {};
    const config = {
      settingsRevision: 1, selected: 'openrouter',
      providers: {
        openrouter: {model: 'openai/gpt-test', configured: true, credentialRevision: 1, storageAvailable: true},
        'openai-compatible': {model: '', configured: false, credentialRevision: 0, storageAvailable: true},
        copilot: {model: 'auto'},
      },
    };
    const workspace = {id: workspaceId, name: 'Shop', metadata: {revision: 3}, canvas: {screens: [], edges: [], paths: []}, scenarios: [{id: 'guest', name: 'Guest checkout'}], view: {format: 1}};
    function view(state: GenerationView['state']): GenerationView {
      const base = {id: jobId, workspaceId, state, phase: state === 'running' ? 'context' as const : 'validating' as const, provenance: 'ai' as const, contractVersion: 1 as const, expiresAt: new Date(Date.now() + 60_000).toISOString()};
      if (world.mode === 'ask') return {...base, state: 'needsInfo', intent: 'knowledge', kind: 'knowledge', scenarioId: 'guest', questions: [{key: 'outcome', text: 'The flow ends at Cart, but this says it ends at the order confirmation.', options: ['Match the flow (ends at Cart)', 'Save as written', 'Update the flow instead']}]};
      if (world.mode === 'mixed') return {...base, state: 'pending', intent: 'mixed', kind: 'flow', scenarioId: 'guest', remainder: 'Add a note for the seller and let a guest buy with no account.', draft: flowDraft, preview: preview(3), previewId: preview(3).previewId};
      if (world.mode === 'knowledge' && state !== 'running') return {...base, state: 'pending', intent: 'knowledge', kind: 'knowledge', scenarioId: 'guest', knowledgeDraft: knowledgeDraft()};
      return base;
    }
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), 'http://127.0.0.1:4317/');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (url.pathname === '/api/ai/config') return Response.json(config);
      if (method === 'POST' && url.pathname === '/api/workspaces') return Response.json(workspace);
      if (method === 'GET' && url.pathname === '/api/workspaces/' + workspaceId) return Response.json(workspace);
      if (method === 'POST' && url.pathname === '/api/workspaces/' + workspaceId + '/view') return Response.json({ok: true});
      if (method === 'POST' && url.pathname === '/api/ai/generations') return Response.json(view('running'), {status: 202});
      if (method === 'GET' && url.pathname === '/api/ai/generations/' + jobId) return Response.json(view(world.released || world.mode !== 'running' ? 'pending' : 'running'));
      if (method === 'POST' && url.pathname === '/api/authoring/apply') return Response.json({workspaceId, revision: 4, scenarioId: 'guest', receiptId: '44444444-4444-4444-8444-444444444444'});
      if (url.pathname.includes('/context')) {
        world.reads += 1;
        if (world.holdRead) await new Promise<void>(resolve => { releaseRead = resolve; });
        world.loaded += 1;
        return Response.json(detail(world.applies.length ? 5 : 4, world.applies.length ? 'updating' : 'up-to-date'));
      }
      if (url.pathname.endsWith('/apply')) {
        world.applies.push({expectedContextRevision: Number(body?.expectedContextRevision)});
        if (world.apply === 'down') return Response.json({code: 'KNOWLEDGE_UNAVAILABLE', error: 'Knowledge service is unavailable.'}, {status: 503});
        if (world.apply === 'conflict') {
          world.apply = 'ok';
          const server = detail(7);
          return Response.json({code: 'CONTEXT_REVISION_CONFLICT', error: 'Context was changed in another editor.', currentContextRevision: 7, context: server.context}, {status: 409});
        }
        return Response.json({detail: detail(5, 'updating'), receipt: {receiptId: '55555555-5555-4555-8555-555555555555'}});
      }
      if (url.pathname.endsWith('/undo')) return Response.json(detail(4));
      return Response.json({error: 'Unknown ' + method + ' ' + url.pathname}, {status: 404});
    };
    const {AiFlow, useAiDraft} = await import('../src/ai-flow.js');
    const {KnowledgeScenarioControl} = await import('../src/knowledge-sheet.js');
    const {resetSidePanels} = await import('../src/side-panels.js');
    resetSidePanels();
    let viewState: Record<string, unknown> = {format: 1};
    function Host() {
      const ai = useAiDraft({
        token: 'tok', workspaceId, revision: 3, running: false, canvas: undefined,
        scenarios: [{id: 'guest', authoring: 'canvas', pathId: 'route'}], contentKey: 'guest', loadRevision: 1,
        readView: () => viewState, save: async () => workspace as never, loadWorkspace: () => {}, selectScenario: () => {},
        rememberView: patch => { viewState = {...viewState, ...patch}; },
        fetchWorkspace: async () => workspace as never, saveWorkspaceView: async () => ({}),
      });
      return createElement('div', {className: 'workbench'},
        createElement(KnowledgeScenarioControl, {
          token: 'tok', workspaceId, scenarioId: 'guest', scenarioName: 'Guest checkout',
          offer: ai.knowledgeOffer, pulse: ai.knowledgePulse, freshnessHint: ai.knowledgeFreshness,
          serverContext: ai.knowledgeServerContext, onServerContextShown: ai.acknowledgeKnowledgeServer,
        }),
        createElement(AiFlow, {control: ai}),
      );
    }
    await act(async () => { root.render(createElement(Host)); });
    const until = async (read: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        if (read()) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      }
      assert.fail(label + ' — ' + (window.document.body.textContent ?? '').slice(0, 500));
    };
    const fill = async (value: string) => act(async () => {
      const node = window.document.querySelector<HTMLTextAreaElement>('[data-testid="ai-flow-field"]');
      assert.ok(node, 'ask field');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value);
      node.dispatchEvent(new Event('input', {bubbles: true}));
    });
    const send = async (value: string) => {
      await fill(value);
      const field = window.document.querySelector<HTMLTextAreaElement>('[data-testid="ai-flow-field"]')!;
      await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true})); });
      for (let attempt = 0; attempt < 10; attempt++) {
        const button = window.document.querySelector<HTMLButtonElement>('[data-testid="ai-disclosure-continue"]');
        if (button) { await act(async () => { button.click(); }); return; }
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      }
    };

    world.mode = 'running';
    await send('update purpose: Let a guest buy with no account.');
    await until(() => window.document.querySelector('[data-testid="ai-flow"]')?.getAttribute('data-ai-status') === 'generating', 'generating');
    const field = window.document.querySelector<HTMLTextAreaElement>('[data-testid="ai-flow-field"]')!;
    assert.equal(field.value, 'update purpose: Let a guest buy with no account.');
    assert.ok(field.closest('.ai-flow-field')!.classList.contains('is-generating'));
    assert.equal(window.document.querySelector('[data-testid="ai-cancel"]')?.getAttribute('aria-label'), 'Stop');
    assert.equal(window.document.body.textContent?.includes('Generating…'), false);
    assert.equal(window.document.querySelector('.ai-panel'), null);
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]'), null);

    world.mode = 'knowledge';
    world.released = true;
    await until(() => !!window.document.querySelector('[data-testid="ai-confirm"]'), 'knowledge apply');
    const sheet = () => window.document.querySelector<HTMLElement>('[data-testid="knowledge-sheet"]');
    await until(() => sheet()?.querySelector('[data-testid="knowledge-purpose"]')?.textContent === 'Let a guest buy with no account.', 'draft text');
    assert.ok(sheet()!.querySelector('[data-testid="knowledge-field-purpose"]')!.classList.contains('is-draft'));
    assert.ok(sheet()!.querySelector('[data-testid="knowledge-field-outcome"]')!.classList.contains('is-draft'));
    assert.equal(sheet()!.querySelector('[data-testid="knowledge-section-why"]')!.getAttribute('aria-expanded'), 'false');
    assert.equal(window.document.querySelector('[data-testid="ai-discard"]')?.getAttribute('aria-label'), 'Dismiss draft');
    assert.equal(window.document.querySelector('[data-testid="ai-versions"]'), null);
    const info = window.document.querySelector<HTMLButtonElement>('[data-testid="knowledge-info-button"]')!;
    assert.equal(info.textContent?.trim(), '');
    await act(async () => { sheet()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    assert.equal(sheet(), null);
    assert.ok(window.document.querySelector('[data-testid="ai-confirm"]'), 'apply stays on the capsule');
    assert.equal(window.document.querySelector('[data-testid="results-sheet"],[data-testid="ai-settings"],[data-testid="ai-versions-sheet"]'), null);
    await act(async () => { info.click(); });
    await until(() => !!sheet()?.querySelector('.is-draft'), 'tint returns from the info button');

    world.apply = 'down';
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-confirm"]')!.click(); });
    await until(() => window.document.querySelector('[data-testid="ai-knowledge-note"]')?.textContent === 'Scenario details aren\'t available right now. Nothing was changed.', 'unavailable sentence');
    assert.equal(window.document.querySelector('[data-testid="ai-knowledge-note"]')!.textContent!.includes('KNOWLEDGE_UNAVAILABLE'), false);
    assert.ok(sheet()!.querySelector('.is-draft'));
    assert.ok(window.document.querySelector('[data-testid="ai-confirm"]'));

    world.apply = 'conflict';
    world.holdRead = true;
    const readsBeforeConflict = world.reads;
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-confirm"]')!.click(); });
    await until(() => window.document.querySelector('[data-testid="ai-knowledge-note"]')?.textContent === 'These details changed somewhere else. Nothing was applied.', 'conflict sentence');
    assert.equal(window.document.querySelector('[data-testid="ai-knowledge-note"]')!.textContent!.includes('CONTEXT_REVISION_CONFLICT'), false);
    await until(() => world.reads > readsBeforeConflict, 'reload started');
    const appliesAtConflict = world.applies.length;
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-confirm"]')!.click(); });
    assert.equal(world.applies.length, appliesAtConflict, 'apply waits for the server copy');
    const loadedBeforeRelease = world.loaded;
    world.holdRead = false;
    releaseRead();
    await until(() => world.loaded > loadedBeforeRelease, 'server copy loaded');
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-confirm"]')!.click(); });
    await until(() => world.applies.at(-1)?.expectedContextRevision === 7, 'apply uses the server revision');
    await until(() => sheet()?.querySelector('[data-testid="knowledge-status"]')?.textContent?.includes('Updating') === true, 'updating');
    assert.equal(sheet()!.querySelector('.is-draft'), null);
    await until(() => !!window.document.querySelector('[data-testid="ai-undo"]'), 'undo on the capsule');
    assert.equal(window.document.querySelector('[data-testid="ai-versions"]'), null);
    assert.equal(window.document.querySelector('[data-testid="ai-confirm"]'), null);
    await act(async () => { sheet()?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click(); });
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-undo"]')!.click(); });
    await until(() => !!window.document.querySelector('[data-testid="ai-flow-field"]'), 'field after undo');

    world.mode = 'ask';
    world.released = true;
    await send('The flow ends at the order confirmation.');
    await until(() => window.document.querySelector('.ai-question-text')?.textContent === 'The flow ends at Cart, but this says it ends at the order confirmation.', 'ask-back');
    assert.equal(window.document.querySelector('[data-testid="ai-confirm"]'), null);
    assert.deepEqual([...window.document.querySelectorAll('[data-testid="ai-question-option"]')].map(node => node.textContent), ['Match the flow (ends at Cart)', 'Save as written', 'Update the flow instead']);
    const openBefore = !!sheet();
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-discard"]')!.click(); });
    assert.equal(!!sheet(), openBefore);
    assert.equal(window.document.querySelector('[data-testid="ai-question"]'), null);

    world.mode = 'mixed';
    world.released = true;
    await act(async () => { sheet()?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click(); });
    await send('Add a note for the seller and let a guest buy with no account.');
    await until(() => !!window.document.querySelector('[data-testid="ai-confirm"]'), 'mixed flow draft');
    assert.equal(sheet(), null, 'a flow draft does not open the info sheet');
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-confirm"]')!.click(); });
    await until(() => window.document.querySelector('.ai-question-text')?.textContent === 'Update the purpose too?', 'mixed follow-up');
    assert.deepEqual([...window.document.querySelectorAll('[data-testid="ai-question-option"]')].map(node => node.textContent), ['Update details', 'Skip']);
    assert.ok(window.document.querySelector('[data-testid="ai-undo"]'));
    assert.equal(window.document.querySelector('[data-testid="ai-confirm"]'), null);
    await act(async () => { [...window.document.querySelectorAll('button')].find(button => button.textContent === 'Skip')!.click(); });
    assert.equal(window.document.querySelector('[data-testid="ai-question"]'), null);
    assert.ok(window.document.querySelector('[data-testid="ai-undo"]'));
  });
});
