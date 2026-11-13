import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement, type ReactNode} from 'react';
import {attachmentFromBytes, CANT_READ_IMAGES, IMAGE_TOO_LARGE, layoutFlowchart, NOT_A_PNG_OR_JPEG} from '../src/diagram-intake.js';
import type {FlowDraft, Preview} from '../server/authoring/types.js';
import type {GenerationView} from '../server/ai/store.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const MERMAID = [
  'flowchart TD',
  '  Cart[Cart] --> Payment[Payment]',
  '  Payment -->|Paid| Placed[Order placed]',
  '  Payment -->|Failed| Failed[Payment failed]',
  '  Failed --> Again[Cart]',
].join('\n');
const PATHS = [
  {id: 'path-1', title: 'Cart → Payment → Order placed', labels: ['Cart', 'Payment', 'Order placed']},
  {id: 'path-2', title: 'Cart → Payment → Cart', labels: ['Cart', 'Payment', 'Cart']},
];

test('a flowchart lays out the main row and drops extra arrows underneath', () => {
  const chain = layoutFlowchart(MERMAID);
  assert.ok(chain);
  assert.deepEqual(chain.nodes.map(node => node.label), ['Cart', 'Payment', 'Order placed']);
  assert.deepEqual(chain.arrows, ['', 'Paid']);
  assert.equal(chain.branches.length, 1);
  assert.equal(chain.branches[0]?.label, 'Failed');
  assert.equal(chain.branches[0]?.at, 1);
  assert.deepEqual(chain.branches[0]?.chain.nodes.map(node => node.label), ['Payment failed', 'Cart']);
  assert.equal(layoutFlowchart('sequenceDiagram\n  A->>B: Hi'), undefined);
});

test('only PNG and JPEG bytes become an attachment', () => {
  const png = attachmentFromBytes('checkout.flow.png', 'image/png', Buffer.from(PNG_B64, 'base64'));
  assert.equal('error' in png, false);
  if ('error' in png) return;
  assert.equal(png.name, 'checkout.flow.png');
  assert.equal(png.mimeType, 'image/png');
  const jpeg = attachmentFromBytes('shot.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal('error' in jpeg, false);
  const gif = attachmentFromBytes('board.gif', 'image/gif', Buffer.from('GIF89a'));
  assert.deepEqual(gif, {error: NOT_A_PNG_OR_JPEG});
  const mismatched = attachmentFromBytes('photo.jpg', 'image/jpeg', Buffer.from(PNG_B64, 'base64'));
  assert.deepEqual(mismatched, {error: NOT_A_PNG_OR_JPEG});
  const huge = Buffer.concat([Buffer.from(PNG_B64, 'base64').subarray(0, 8), Buffer.alloc(2_000_001)]);
  assert.deepEqual(attachmentFromBytes('big.png', 'image/png', huge), {error: IMAGE_TOO_LARGE});
});

const flowDraft: FlowDraft = {
  schemaVersion: 1, mode: 'createScenario', name: 'Payment fails, back to Cart', appId: 'com.example.Shop', parameters: [],
  execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
  screens: [
    {key: 'cart', kind: 'create', title: 'Cart'},
    {key: 'pay', kind: 'create', title: 'Payment'},
    {key: 'cart2', kind: 'create', title: 'Cart'},
  ],
  visits: [
    {key: 'v1', screenKey: 'cart', operations: [{key: 'go', kind: 'tap', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Checkout'}}, destination: {kind: 'visit', visitKey: 'v2'}}]},
    {key: 'v2', screenKey: 'pay', operations: [{key: 'fail', kind: 'tap', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Pay with the saved card'}}, destination: {kind: 'visit', visitKey: 'v3'}}]},
    {key: 'v3', screenKey: 'cart2', operations: [{key: 'see', kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'See the cart again'}}}]},
  ],
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

type Script = 'question' | 'mermaid' | 'blind' | 'create' | 'path' | 'flow';

function detail(rationale = 'Keep why') {
  return {
    workspaceId, scenarioId: 'guest', title: 'Checkout',
    context: {
      schemaVersion: 1, workspaceId, scenarioId: 'guest', contextRevision: 4,
      updatedAt: '2026-11-12T00:00:00.000Z', reviewedAgainstSourceHash: null,
      purpose: 'Pay for the items in the cart.', expectedOutcome: 'The order is placed, or payment failure returns to the cart.',
      rationale, preconditions: '', exceptions: '', scope: '',
    },
    sourceDescriptor: {projectionVersion: 1, workspaceRevision: 3, sourceHash: 'ab'.repeat(32)},
    flow: {steps: [{number: 1, text: '1 · Open the cart'}, {number: 2, text: '2 · Enter the card'}, {number: 3, text: '3 · See the order number'}], visits: [], diagnostics: []},
    evidence: {status: null, runId: null, finishedAt: null, label: 'No runs yet', notice: ''},
    freshness: 'up-to-date', publicationFreshness: 'current', intentFreshness: 'reviewed',
    generationId: null, generatedAt: null, publicationError: null, readerUrl: '/knowledge/workspaces/' + workspaceId + '/#scenario-guest',
  };
}

test('paste and drop of a PNG attach it on the Ask AI field', async () => {
  await withDom(async window => {
    const config = {
      settingsRevision: 1, selected: 'openrouter',
      providers: {
        openrouter: {model: 'vendor/model', configured: true, credentialRevision: 1, storageAvailable: true},
        'openai-compatible': {model: '', configured: false, credentialRevision: 0, storageAvailable: true},
        copilot: {model: 'auto'},
      },
    };
    globalThis.fetch = async (input) => {
      const url = new URL(String(input), 'http://127.0.0.1:4317/');
      if (url.pathname === '/api/ai/config') return Response.json(config);
      return Response.json({error: 'nope'}, {status: 404});
    };
    const {AiFlow, useAiDraft} = await import('../src/ai-flow.js');
    const workspace = {id: workspaceId, name: 'Shop', metadata: {revision: 1}, canvas: {screens: [], edges: [], paths: []}, scenarios: [], view: {format: 1}};
    function Host() {
      const ai = useAiDraft({
        token: 'tok', workspaceId, revision: 1, running: false, canvas: undefined, scenarios: [], contentKey: 'x', loadRevision: 1,
        readView: () => ({format: 1}), save: async () => workspace as never, loadWorkspace: () => {}, selectScenario: () => {},
        rememberView: () => {}, fetchWorkspace: async () => workspace as never, saveWorkspaceView: async () => ({}),
      });
      return createElement(AiFlow, {control: ai});
    }
    const root = (await import('react-dom/client')).createRoot(window.document.getElementById('root')!);
    await act(async () => { root.render(createElement(Host)); });
    const until = async (read: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        if (read()) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      }
      assert.fail(label);
    };
    await until(() => !!window.document.querySelector('[data-testid="ai-flow-field"]'), 'field');
    const file = new File([Buffer.from(PNG_B64, 'base64')], 'image.png', {type: 'image/png'});
    const field = window.document.querySelector<HTMLTextAreaElement>('[data-testid="ai-flow-field"]')!;
    const paste = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(paste, 'clipboardData', {value: {items: [{type: 'image/png', getAsFile: () => file}], files: [file]}});
    await act(async () => { field.dispatchEvent(paste); });
    await until(() => window.document.querySelector('[data-testid="ai-diagram-chip"]')?.textContent?.includes('Pasted image.png') === true, 'pasted chip');
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-diagram-remove"]')!.click(); });
    const dropped = new File([Buffer.from(PNG_B64, 'base64')], 'checkout.flow.png', {type: 'image/png'});
    const drop = new Event('drop', {bubbles: true, cancelable: true});
    Object.defineProperty(drop, 'dataTransfer', {value: {types: ['Files'], files: [dropped]}});
    await act(async () => { window.document.querySelector('.ai-composer')!.dispatchEvent(drop); });
    await until(() => window.document.querySelector('[data-testid="ai-diagram-chip"]')?.textContent?.includes('checkout.flow.png') === true, 'dropped chip');
    assert.equal(window.document.querySelectorAll('[aria-label="Ask AI"]').length, 1);
    await act(async () => { root.unmount(); });
  });
});

test('diagram intake uses the one Ask AI field from chip through one named path', async () => {
  await withDom(async window => {
    const world: {script: Script; hold: boolean; generations: Record<string, unknown>[]; diagramApplies: number} = {
      script: 'question', hold: true, generations: [], diagramApplies: 0,
    };
    const jobs = new Map<string, {script: Script; done: boolean}>();
    let jobCount = 0;
    const config = {
      settingsRevision: 2, selected: 'copilot',
      providers: {
        openrouter: {model: 'vendor/model', configured: true, credentialRevision: 1, storageAvailable: true},
        'openai-compatible': {model: 'gpt-test', configured: true, credentialRevision: 1, storageAvailable: true},
        copilot: {model: 'gpt-4.1'},
      },
    };
    const workspace = {id: workspaceId, name: 'Shop', metadata: {revision: 3}, canvas: {screens: [], edges: [], paths: []}, scenarios: [{id: 'guest', name: 'Checkout'}], view: {format: 1, scenarioId: 'guest'}};
    function finalView(id: string, script: Script): GenerationView {
      const base = {id, workspaceId, phase: 'validating' as const, provenance: 'ai' as const, contractVersion: 1 as const, expiresAt: new Date(Date.now() + 60_000).toISOString(), scenarioId: 'guest'};
      if (script === 'question') return {...base, state: 'needsInfo', intent: 'diagram', kind: 'diagram', questions: [{key: 'arrow', text: 'After Payment fails, does it go back to Cart or show an error?', options: ['Back to Cart', 'Show an error']}]};
      if (script === 'mermaid') return {...base, state: 'pending', intent: 'diagram', kind: 'diagram', skill: 'diagram@1', skillHash: 'ab'.repeat(32), diagramDraft: {mermaid: MERMAID, paths: PATHS}};
      if (script === 'blind') return {...base, state: 'failed', intent: 'diagram', kind: 'diagram', error: {code: 'MODEL_CANT_READ_IMAGES', message: CANT_READ_IMAGES, retryable: false}};
      if (script === 'create') return {...base, state: 'needsInfo', intent: 'diagram', kind: 'diagram', questions: [{key: 'create-scenario', text: 'Create a scenario from this diagram?', options: ['Yes', 'Not now']}]};
      if (script === 'path') return {...base, state: 'needsInfo', intent: 'diagram', kind: 'diagram', questions: [{key: 'which-path', text: 'Name the one path to author.', options: ['The path I named', 'Not now']}]};
      const ready = preview(3);
      return {...base, state: 'pending', intent: 'flow', kind: 'flow', draft: flowDraft, preview: ready, previewId: ready.previewId};
    }
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), 'http://127.0.0.1:4317/');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (url.pathname === '/api/ai/config') return Response.json(config);
      if (method === 'POST' && url.pathname === '/api/workspaces') return Response.json(workspace);
      if (method === 'GET' && url.pathname === '/api/workspaces/' + workspaceId) return Response.json(workspace);
      if (method === 'POST' && url.pathname === '/api/workspaces/' + workspaceId + '/view') return Response.json({ok: true});
      if (method === 'POST' && url.pathname === '/api/ai/generations') {
        world.generations.push(body ?? {});
        jobCount += 1;
        const id = 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(jobCount).padStart(12, '0');
        jobs.set(id, {script: world.script, done: !world.hold});
        return Response.json({id, workspaceId, state: 'running', phase: 'model', provenance: 'ai', contractVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString()}, {status: 202});
      }
      const job = /^\/api\/ai\/generations\/([^/]+)$/.exec(url.pathname);
      if (method === 'GET' && job) {
        const stored = jobs.get(job[1]);
        if (!stored || !stored.done) return Response.json({id: job[1], workspaceId, state: 'running', phase: 'model', provenance: 'ai', contractVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString()});
        return Response.json(finalView(job[1], stored.script));
      }
      if (method === 'POST' && url.pathname.endsWith('/cancel')) return Response.json({id: 'cancelled', workspaceId, state: 'cancelled', phase: 'model', provenance: 'ai', contractVersion: 1, expiresAt: new Date().toISOString()});
      if (url.pathname.endsWith('/context')) return Response.json(detail());
      if (method === 'POST' && url.pathname.endsWith('/diagram')) {
        world.diagramApplies += 1;
        return Response.json({detail: detail(), receipt: {receiptId: '55555555-5555-4555-8555-555555555555'}, followUp: {key: 'create-scenario', text: 'Create a scenario from this diagram?', options: ['Yes', 'Not now']}});
      }
      if (url.pathname.endsWith('/undo')) return Response.json(detail());
      return Response.json({error: 'Unknown ' + method + ' ' + url.pathname}, {status: 404});
    };
    const {AiFlow, useAiDraft} = await import('../src/ai-flow.js');
    const {KnowledgeScenarioControl} = await import('../src/knowledge-sheet.js');
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
        createElement(KnowledgeScenarioControl, {token: 'tok', workspaceId, scenarioId: 'guest', scenarioName: 'Checkout', pulse: ai.knowledgePulse}),
        createElement(AiFlow, {control: ai}),
        createElement('div', {'data-testid': 'overlay-probe'}, ai.overlay?.nodes.map(node => createElement('span', {key: node.key, 'data-testid': 'overlay-node'}, node.title))),
      );
    }
    const root = (await import('react-dom/client')).createRoot(window.document.getElementById('root')!);
    await act(async () => { root.render(createElement(Host)); });
    const until = async (read: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (read()) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
      }
      assert.fail(label + ' — ' + (window.document.body.textContent ?? '').slice(0, 500));
    };
    const ask = () => window.document.querySelector<HTMLTextAreaElement | HTMLInputElement>('[aria-label="Ask AI"]');
    const fill = async (value: string) => act(async () => {
      const node = ask();
      assert.ok(node, 'ask field');
      const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
      node.dispatchEvent(new Event('input', {bubbles: true}));
    });
    const attach = async (name: string, type: string, bytes: Uint8Array) => {
      const input = window.document.querySelector<HTMLInputElement>('[data-testid="ai-diagram-file"]');
      assert.ok(input, 'file input');
      const file = new File([Buffer.from(bytes)], name, {type});
      Object.defineProperty(input, 'files', {configurable: true, value: [file]});
      await act(async () => { input.dispatchEvent(new Event('change', {bubbles: true})); });
    };

    await until(() => !!window.document.querySelector('[data-testid="ai-clip"]'), 'paperclip');
    assert.equal(window.document.querySelectorAll('[aria-label="Ask AI"]').length, 1);
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-chip"]'), null);
    const composer = window.document.querySelector<HTMLElement>('.ai-composer')!;
    const drag = (type: string) => {
      const event = new Event(type, {bubbles: true, cancelable: true});
      Object.defineProperty(event, 'dataTransfer', {value: {types: ['Files'], files: [], dropEffect: 'none'}});
      composer.dispatchEvent(event);
    };
    await act(async () => { drag('dragenter'); drag('dragover'); });
    const dropping = window.document.querySelector<HTMLTextAreaElement>('[data-testid="ai-flow-field"]')!;
    assert.equal(dropping.placeholder, 'Drop a PNG or JPEG');
    assert.ok(dropping.closest('.ai-flow-field')!.classList.contains('is-drop'));
    await act(async () => { drag('dragleave'); });
    assert.equal(window.document.querySelector<HTMLTextAreaElement>('[data-testid="ai-flow-field"]')!.placeholder, 'Ask AI');

    await attach('notes.txt', 'text/plain', Buffer.from('hello'));
    await until(() => window.document.querySelector('[data-testid="ai-diagram-error"]')?.textContent === NOT_A_PNG_OR_JPEG, 'bad file');
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-chip"]'), null);
    await fill('Read this checkout diagram');
    assert.equal(ask()?.value, 'Read this checkout diagram');
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-error"]')?.textContent, NOT_A_PNG_OR_JPEG);

    await attach('checkout.flow.png', 'image/png', Buffer.from(PNG_B64, 'base64'));
    await until(() => window.document.querySelector('[data-testid="ai-diagram-chip"]')?.textContent?.includes('checkout.flow.png') === true, 'png chip');
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-error"]'), null);
    assert.equal(ask()?.value, 'Read this checkout diagram');
    assert.ok(window.document.querySelector('[data-testid="ai-clip"]'));
    assert.equal(JSON.stringify(viewState).includes(PNG_B64), false);
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-diagram-remove"]')!.click(); });
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-chip"]'), null);
    assert.equal(ask()?.value, 'Read this checkout diagram');
    await attach('checkout.flow.png', 'image/png', Buffer.from(PNG_B64, 'base64'));
    await until(() => !!window.document.querySelector('[data-testid="ai-diagram-chip"]'), 'chip again');

    await act(async () => { window.document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click(); });
    await until(() => !!window.document.querySelector('[data-testid="ai-disclosure-diagram"]'), 'disclosure sentence');
    assert.equal(window.document.querySelector('[data-testid="ai-disclosure-diagram"]')?.textContent, 'This diagram image is sent to the selected AI provider. Screenshots and recordings are not.');
    assert.match(window.document.querySelector('[data-testid="ai-disclosure"]')?.textContent ?? '', /Screenshots or recordings/);
    assert.equal(world.generations.length, 0);
    assert.ok(window.document.querySelector('[data-testid="ai-diagram-chip"]'));
    assert.equal(ask()?.value, 'Read this checkout diagram');
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-disclosure-not-now"]')!.click(); });
    assert.equal(window.document.querySelector('[data-testid="ai-disclosure"]'), null);
    assert.equal(ask()?.value, 'Read this checkout diagram');
    assert.ok(window.document.querySelector('[data-testid="ai-diagram-chip"]'));

    world.script = 'question';
    world.hold = true;
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click(); });
    await until(() => !!window.document.querySelector('[data-testid="ai-disclosure-continue"]'), 'disclosure again');
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-disclosure-continue"]')!.click(); });
    await until(() => window.document.querySelector('[data-testid="ai-flow"]')?.getAttribute('data-ai-status') === 'generating', 'running');
    const running = window.document.querySelector<HTMLTextAreaElement>('[data-testid="ai-flow-field"]')!;
    assert.equal(running.value, 'Read this checkout diagram');
    assert.ok(running.closest('.ai-flow-field')!.classList.contains('is-generating'));
    assert.equal(window.document.querySelector('[data-testid="ai-cancel"]')?.getAttribute('aria-label'), 'Stop');
    assert.equal(window.document.querySelector('[data-testid="ai-clip"]'), null);
    assert.ok(window.document.querySelector('[data-testid="ai-diagram-chip"]')?.textContent?.includes('checkout.flow.png'));
    assert.equal(window.document.querySelector('[data-testid="ai-flow-field"]')?.parentElement?.textContent?.includes('Generating'), false);
    assert.equal(world.generations.length, 1);
    const sent = world.generations[0] as {prompt?: string; image?: {mimeType?: string; data?: string}};
    assert.equal(sent.prompt, 'Read this checkout diagram');
    assert.equal(sent.image?.mimeType, 'image/png');
    assert.equal(sent.image?.data, PNG_B64);
    assert.equal(sent.prompt?.includes(PNG_B64), false);

    for (const job of jobs.values()) job.done = true;
    await until(() => window.document.querySelector('[data-testid="ai-question"]')?.textContent?.includes('After Payment fails') === true, 'ask-back');
    assert.deepEqual([...window.document.querySelectorAll('[data-testid="ai-question-option"]')].map(node => node.textContent), ['Back to Cart', 'Show an error']);
    assert.equal(window.document.querySelector('[data-testid="ai-confirm"]'), null);
    assert.equal(window.document.querySelector('[data-testid="ai-discard"]')?.getAttribute('aria-label'), 'Dismiss draft');
    assert.equal(window.document.querySelectorAll('[aria-label="Ask AI"]').length, 1);
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-card"]'), null);

    world.script = 'mermaid';
    world.hold = false;
    await act(async () => { [...window.document.querySelectorAll('button')].find(button => button.textContent === 'Back to Cart')!.click(); });
    await until(() => !!window.document.querySelector('[data-testid="ai-diagram-card"]'), 'mermaid card');
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-card"]')?.closest('[data-testid="ai-flow"]'), window.document.querySelector('[data-testid="ai-flow"]'));
    assert.equal(window.document.querySelector('[data-side-sheet]'), null);
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-source"]'), null);
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-source-toggle"]')?.getAttribute('aria-expanded'), 'false');
    assert.match(window.document.querySelector('[data-testid="ai-diagram-source-toggle"]')?.textContent ?? '', /Mermaid/);
    assert.deepEqual([...window.document.querySelectorAll('[data-testid="ai-diagram-node"]')].map(node => node.textContent), ['Cart', 'Payment', 'Order placed', 'Payment failed', 'Cart']);
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-diagram-source-toggle"]')!.click(); });
    assert.match(window.document.querySelector('[data-testid="ai-diagram-source"]')?.textContent ?? '', /flowchart TD/);
    assert.equal(window.document.querySelector('[data-testid="ai-confirm"]')?.textContent, '✓ Apply');
    assert.equal(window.document.querySelector('[data-testid="ai-discard"]')?.getAttribute('aria-label'), 'Dismiss draft');
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]'), null);
    const refine = world.generations.at(-1) as {image?: unknown; previousJobId?: string};
    assert.equal(refine.image, undefined);
    assert.ok(refine.previousJobId);

    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="knowledge-info-button"]')!.click(); });
    await until(() => window.document.querySelector('[data-testid="knowledge-purpose"]')?.textContent === 'Pay for the items in the cart.', 'info sheet');
    const why = window.document.querySelector('[data-testid="knowledge-section-why"]');
    await act(async () => { why?.dispatchEvent(new MouseEvent('click', {bubbles: true})); });
    await until(() => window.document.querySelector('[data-testid="knowledge-section-body"]')?.textContent === 'Keep why', 'why text');
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]')?.textContent?.includes('flowchart'), false);
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]')?.textContent?.includes('Mermaid'), false);
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-card"]')?.closest('[data-testid="knowledge-sheet"]'), null);

    world.script = 'create';
    world.hold = false;
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-confirm"]')!.click(); });
    await until(() => world.diagramApplies === 1, 'diagram apply');
    await until(() => !!window.document.querySelector('[data-testid="ai-undo"]'), 'undo');
    assert.equal(window.document.querySelector('[data-testid="knowledge-section-body"]')?.textContent, 'Keep why');
    assert.equal(window.document.querySelector('[data-testid="knowledge-sheet"]')?.textContent?.includes('flowchart'), false);
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-card"]'), null);
    await until(() => window.document.querySelector('[data-testid="ai-question"]')?.textContent?.includes('Create a scenario from this diagram?') === true, 'create scenario');
    assert.deepEqual([...window.document.querySelectorAll('[data-testid="ai-question-option"]')].map(node => node.textContent), ['Yes', 'Not now']);
    assert.equal(window.document.querySelector('[data-testid="ai-confirm"]'), null);
    assert.equal(window.document.querySelector('[data-testid="ai-discard"]'), null);
    const createCall = world.generations.at(-1) as {prompt?: string; image?: unknown; previousJobId?: string};
    assert.equal(createCall.prompt, 'Create a scenario from this diagram?');
    assert.equal(createCall.image, undefined);
    assert.equal(createCall.previousJobId, undefined);

    world.script = 'path';
    await act(async () => { [...window.document.querySelectorAll('button')].find(button => button.textContent === 'Yes')!.click(); });
    await until(() => window.document.querySelector('[data-testid="ai-question"]')?.textContent?.includes('Name the one path to author.') === true, 'name a path');
    assert.deepEqual([...window.document.querySelectorAll('[data-testid="ai-question-option"]')].map(node => node.textContent), ['The path I named', 'Not now']);
    assert.equal(window.document.querySelector('[data-testid="ai-question"]')?.textContent?.includes('Order placed'), false);
    assert.equal(window.document.querySelectorAll('[aria-label="Ask AI"]').length, 1);
    await fill('Cart → Payment → Cart');
    assert.equal(ask()?.value, 'Cart → Payment → Cart');
    world.script = 'flow';
    await act(async () => { [...window.document.querySelectorAll('button')].find(button => button.textContent === 'The path I named')!.click(); });
    await until(() => window.document.querySelectorAll('[data-testid="overlay-node"]').length === 3, 'flow draft');
    assert.deepEqual([...window.document.querySelectorAll('[data-testid="overlay-node"]')].map(node => node.textContent), ['Cart', 'Payment', 'Cart']);
    assert.equal(window.document.querySelector('[data-testid="ai-confirm"]')?.textContent, '✓ Apply');
    assert.equal(window.document.querySelector('[data-testid="ai-discard"]')?.getAttribute('aria-label'), 'Dismiss draft');
    assert.equal(window.document.querySelector('[data-testid="ai-diagram-card"]'), null);
    const authored = world.generations.at(-1) as {authorPath?: string; image?: unknown; answers?: {answer: string}[]};
    assert.equal(authored.authorPath, 'path-2');
    assert.equal(authored.answers?.[0]?.answer, 'Cart → Payment → Cart');
    assert.equal(authored.image, undefined);
    assert.equal(window.document.querySelector('[data-testid="knowledge-section-body"]')?.textContent, 'Keep why');
    await act(async () => { root.unmount(); });
  });
});

test('a model that cannot read images keeps the chip and the prompt', async () => {
  await withDom(async window => {
    const jobs = new Map<string, {done: boolean}>();
    const config = {
      settingsRevision: 2, selected: 'openrouter',
      providers: {
        openrouter: {model: 'vendor/model', configured: true, credentialRevision: 1, storageAvailable: true},
        'openai-compatible': {model: '', configured: false, credentialRevision: 0, storageAvailable: true},
        copilot: {model: 'auto'},
      },
    };
    const workspace = {id: workspaceId, name: 'Shop', metadata: {revision: 3}, canvas: {screens: [], edges: [], paths: []}, scenarios: [{id: 'guest', name: 'Checkout'}], view: {format: 1}};
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), 'http://127.0.0.1:4317/');
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/ai/config') return Response.json(config);
      if (method === 'POST' && url.pathname === '/api/workspaces') return Response.json(workspace);
      if (method === 'POST' && url.pathname === '/api/workspaces/' + workspaceId + '/view') return Response.json({ok: true});
      if (method === 'POST' && url.pathname === '/api/ai/generations') {
        const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        jobs.set(id, {done: true});
        return Response.json({id, workspaceId, state: 'running', phase: 'model', provenance: 'ai', contractVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString()}, {status: 202});
      }
      const job = /^\/api\/ai\/generations\/([^/]+)$/.exec(url.pathname);
      if (job) return Response.json({id: job[1], workspaceId, state: 'failed', phase: 'model', provenance: 'ai', contractVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), error: {code: 'MODEL_CANT_READ_IMAGES', message: CANT_READ_IMAGES, retryable: false}});
      return Response.json({error: 'nope'}, {status: 404});
    };
    const {AiFlow, useAiDraft} = await import('../src/ai-flow.js');
    function Host() {
      const ai = useAiDraft({
        token: 'tok', workspaceId, revision: 3, running: false, canvas: undefined,
        scenarios: [{id: 'guest'}], contentKey: 'guest', loadRevision: 1,
        readView: () => ({format: 1}), save: async () => workspace as never, loadWorkspace: () => {}, selectScenario: () => {},
        rememberView: () => {}, fetchWorkspace: async () => workspace as never, saveWorkspaceView: async () => ({}),
      });
      return createElement(AiFlow, {control: ai});
    }
    const root = (await import('react-dom/client')).createRoot(window.document.getElementById('root')!);
    await act(async () => { root.render(createElement(Host)); });
    const until = async (read: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (read()) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
      }
      assert.fail(label);
    };
    await until(() => !!window.document.querySelector('[data-testid="ai-diagram-file"]'), 'file input');
    const input = window.document.querySelector<HTMLInputElement>('[data-testid="ai-diagram-file"]')!;
    const file = new File([Buffer.from(PNG_B64, 'base64')], 'checkout.flow.png', {type: 'image/png'});
    Object.defineProperty(input, 'files', {configurable: true, value: [file]});
    await act(async () => { input.dispatchEvent(new Event('change', {bubbles: true})); });
    const field = window.document.querySelector<HTMLTextAreaElement>('[data-testid="ai-flow-field"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Read this checkout diagram');
      field.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click(); });
    await until(() => !!window.document.querySelector('[data-testid="ai-disclosure-continue"]'), 'disclosure');
    assert.equal(window.document.querySelector('[data-testid="ai-disclosure-diagram"]')?.textContent?.includes('selected AI provider'), true);
    await act(async () => { window.document.querySelector<HTMLButtonElement>('[data-testid="ai-disclosure-continue"]')!.click(); });
    await until(() => window.document.querySelector('[data-testid="ai-diagram-error"]')?.textContent === CANT_READ_IMAGES, 'vision error');
    assert.ok(window.document.querySelector('[data-testid="ai-diagram-chip"]')?.textContent?.includes('checkout.flow.png'));
    assert.equal(window.document.querySelector<HTMLTextAreaElement>('[data-testid="ai-flow-field"]')?.value, 'Read this checkout diagram');
    assert.equal(window.document.querySelector('[data-testid="ai-error"]'), null);
    assert.equal(window.document.querySelector('[data-testid="ai-confirm"]'), null);
    await act(async () => { root.unmount(); });
  });
});

test('an unclear path name asks back in the Ask AI capsule and one pick is sent', async () => {
  await withDom(async window => {
    const bodies: Record<string, unknown>[] = [];
    let jobCount = 0;
    const config = {
      settingsRevision: 1, selected: 'copilot',
      providers: {
        openrouter: {model: 'vendor/model', configured: true, credentialRevision: 1, storageAvailable: true},
        'openai-compatible': {model: '', configured: false, credentialRevision: 0, storageAvailable: true},
        copilot: {model: 'gpt-4.1'},
      },
    };
    const workspace = {id: workspaceId, name: 'Shop', metadata: {revision: 3}, canvas: {screens: [], edges: [], paths: []}, scenarios: [{id: 'guest', name: 'Checkout'}], view: {format: 1}};
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), 'http://127.0.0.1:4317/');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (url.pathname === '/api/ai/config') return Response.json(config);
      if (method === 'POST' && url.pathname === '/api/workspaces') return Response.json(workspace);
      if (method === 'POST' && url.pathname === '/api/workspaces/' + workspaceId + '/view') return Response.json({ok: true});
      if (method === 'POST' && url.pathname === '/api/ai/generations') {
        bodies.push(body ?? {});
        jobCount += 1;
        const id = jobCount === 1 ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        const view = jobCount === 1
          ? {id, workspaceId, state: 'needsInfo', phase: 'context', provenance: 'ai', contractVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), intent: 'diagram', kind: 'diagram', scenarioId: 'guest', questions: [{key: 'which-path', text: 'Did you mean: Checkout, Checkout with coupon?', options: ['Checkout', 'Checkout with coupon', 'Not now']}]}
          : {id, workspaceId, state: 'running', phase: 'model', provenance: 'ai', contractVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString()};
        return Response.json(jobCount === 1 ? {...view, state: 'running', phase: 'model', questions: undefined} : view, {status: 202});
      }
      const job = /^\/api\/ai\/generations\/([^/]+)$/.exec(url.pathname);
      if (job) {
        if (job[1].startsWith('cccccccc')) return Response.json({id: job[1], workspaceId, state: 'needsInfo', phase: 'context', provenance: 'ai', contractVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), intent: 'diagram', kind: 'diagram', scenarioId: 'guest', questions: [{key: 'which-path', text: 'Did you mean: Checkout, Checkout with coupon?', options: ['Checkout', 'Checkout with coupon', 'Not now']}]});
        return Response.json({id: job[1], workspaceId, state: 'running', phase: 'model', provenance: 'ai', contractVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString()});
      }
      return Response.json({error: 'nope'}, {status: 404});
    };
    const {AiFlow, useAiDraft} = await import('../src/ai-flow.js');
    function Host() {
      const ai = useAiDraft({
        token: 'tok', workspaceId, revision: 3, running: false, canvas: undefined, scenarios: [{id: 'guest'}], contentKey: 'guest', loadRevision: 1,
        readView: () => ({format: 1}), save: async () => workspace as never, loadWorkspace: () => {}, selectScenario: () => {},
        rememberView: () => {}, fetchWorkspace: async () => workspace as never, saveWorkspaceView: async () => ({}),
      });
      return createElement(AiFlow, {control: ai});
    }
    const root = (await import('react-dom/client')).createRoot(window.document.getElementById('root')!);
    await act(async () => { root.render(createElement(Host)); });
    const until = async (read: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        if (read()) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
      }
      assert.fail(label + ' — ' + (window.document.body.textContent ?? '').slice(0, 300));
    };
    await until(() => !!window.document.querySelector('[data-testid="ai-flow-field"]'), 'field');
    const field = window.document.querySelector<HTMLTextAreaElement>('[data-testid="ai-flow-field"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'check');
      field.dispatchEvent(new Event('input', {bubbles: true}));
      field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    });
    await until(() => !!window.document.querySelector('[data-testid="ai-disclosure-continue"]') || !!window.document.querySelector('[data-testid="ai-question"]'), 'disclosure or question');
    const disclose = window.document.querySelector<HTMLButtonElement>('[data-testid="ai-disclosure-continue"]');
    if (disclose) await act(async () => { disclose.click(); });
    await until(() => window.document.querySelector('[data-testid="ai-question"]')?.textContent?.includes('Did you mean: Checkout, Checkout with coupon?') === true, 'ask-back');
    assert.deepEqual([...window.document.querySelectorAll('[data-testid="ai-question-option"]')].map(node => node.textContent), ['Checkout', 'Checkout with coupon', 'Not now']);
    assert.equal(window.document.querySelector('[data-testid="ai-confirm"]'), null);
    assert.equal(window.document.querySelectorAll('[aria-label="Ask AI"]').length, 1);
    await act(async () => { [...window.document.querySelectorAll('button')].find(button => button.textContent === 'Checkout')!.click(); });
    await until(() => bodies.length >= 2, 'one path chosen');
    const chosen = bodies[1] as {answers?: {answer: string}[]; authorPath?: string};
    assert.deepEqual(chosen.answers, [{key: 'which-path', answer: 'Checkout'}]);
    assert.equal(JSON.stringify(chosen).includes('Checkout with coupon'), false);
    await act(async () => { root.unmount(); });
  });
});

async function withDom(body: (window: Window) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {url: 'http://127.0.0.1:4317/'});
  const window = dom.window;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const keys = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'KeyboardEvent', 'MouseEvent', 'DragEvent', 'DataTransfer', 'File', 'MutationObserver', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT', 'navigator', 'sessionStorage', 'fetch'];
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'ResizeObserver' ? ResizeObserver : Reflect.get(window, key), configurable: true});
  }
  try { await body(window as unknown as Window); }
  finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    window.close();
  }
}
