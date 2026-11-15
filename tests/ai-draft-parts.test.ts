import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {GenerationView} from '../server/ai/store.js';
import type {FlowDraft} from '../server/authoring/types.js';
import {draftOverlayFor, type AiDraft} from '../src/ai-flow.js';
import {presentResult} from '../src/ai-intent-router.js';
import {persistedAiDraft, useUndoWindow, viewDraft} from '../src/ai-draft-persistence.js';
import {matchDiagramPath} from '../src/ai-diagram-draft.js';
import {CANT_READ_IMAGES} from '../src/diagram-intake.js';
import {UNDO_WINDOW_MS} from '../src/ai-versions.js';

function renders(draft: FlowDraft | undefined, canvas: Parameters<typeof draftOverlayFor>[1]) {
  if (!draft) return false;
  const overlay = draftOverlayFor(draft, canvas);
  return overlay.nodes.length > 0 || overlay.existing.length > 0;
}

function current(): AiDraft {
  return {status: 'generating', prompt: 'Pay the bill'};
}

function view(patch: Partial<GenerationView>): GenerationView {
  return {
    id: 'job-1', workspaceId: 'ws', state: 'pending', phase: 'model', provenance: 'ai', contractVersion: 1,
    expiresAt: '2026-12-01T00:00:00.000Z',
    ...patch,
  };
}

const drawable = {
  schemaVersion: 1, mode: 'createScenario', name: 'Pay', assumptions: [],
  screens: [{key: 'home', kind: 'create', title: 'Home'}],
  visits: [{key: 'v1', screenKey: 'home', operations: []}],
} as unknown as FlowDraft;

test('the intent router keeps knowledge, diagram, ask-back, and a drawable flow apart', () => {
  const knowledge = presentResult(current(), view({intent: 'knowledge', kind: 'knowledge', knowledgeDraft: {baseContextRevision: 3, purpose: 'Pay', expectedOutcome: 'Paid'} as GenerationView['knowledgeDraft']}), 4, undefined, renders);
  assert.equal(knowledge.status, 'pending');
  assert.equal(knowledge.knowledgeDraft?.purpose, 'Pay');
  assert.equal(knowledge.draft, undefined);
  assert.equal(knowledge.baseRevision, undefined);

  const diagram = presentResult(current(), view({intent: 'diagram', kind: 'diagram', diagramDraft: {mermaid: 'graph LR; A-->B', paths: []} as GenerationView['diagramDraft']}), 4, undefined, renders);
  assert.equal(diagram.status, 'pending');
  assert.equal(diagram.diagramDraft?.mermaid, 'graph LR; A-->B');
  assert.equal(diagram.knowledgeDraft, undefined);
  assert.equal(diagram.draft, undefined);

  const ask = presentResult(current(), view({state: 'needsInfo', intent: 'unclear', questions: [{key: 'who', text: 'Who pays?', options: []}] as GenerationView['questions']}), 4, undefined, renders);
  assert.equal(ask.status, 'needsInfo');
  assert.equal(ask.questions?.[0]?.key, 'who');
  assert.equal(ask.draft, undefined);

  const flow = presentResult(current(), view({draft: drawable}), 4, undefined, renders);
  assert.equal(flow.status, 'pending');
  assert.equal(flow.draft?.name, 'Pay');
  assert.equal(flow.knowledgeDraft, undefined);
  assert.equal(flow.diagramDraft, undefined);

  const unfit = presentResult(current(), view({draft: {...drawable, screens: [], visits: []}, preview: {applicable: false, diagnostics: [], requiredAssumptionKeys: [], baseRevision: 4, previewId: 'p', expiresAt: '2026-12-01T00:00:00.000Z'} as unknown as GenerationView['preview']}), 4, undefined, renders);
  assert.equal(unfit.status, 'failed');
  assert.equal(unfit.error?.code, 'AUTHORING_INVALID');

  const blind = presentResult(current(), view({state: 'failed', error: {code: 'MODEL_CANT_READ_IMAGES', message: CANT_READ_IMAGES, retryable: false}}), 4, undefined, renders);
  assert.equal(blind.status, 'failed');
  assert.equal(blind.attachmentError, CANT_READ_IMAGES);
});

test('persisted drafts keep the job, the prompt, and finite canvas points only', () => {
  assert.equal(persistedAiDraft(null), undefined);
  assert.equal(persistedAiDraft({aiDraft: {jobId: '', prompt: 'x'}}), undefined);
  const stored = persistedAiDraft({aiDraft: {jobId: 'job-1', prompt: 'Pay', previewId: 'p', baseRevision: 2, positions: {home: {x: 10, y: 20}, bad: {x: Number.NaN, y: 1}, far: {x: 9000, y: -4}}}});
  assert.deepEqual(stored, {jobId: 'job-1', prompt: 'Pay', previewId: 'p', baseRevision: 2, positions: {home: {x: 10, y: 20}, far: {x: 2400, y: 0}}});
  assert.deepEqual(viewDraft({status: 'pending', prompt: 'Pay', jobId: 'job-1', positions: {home: {x: 3, y: 4}}}), {jobId: 'job-1', prompt: 'Pay', positions: {home: {x: 3, y: 4}}});
  assert.equal(viewDraft({status: 'idle', prompt: 'Pay'}), null);
});

test('diagram path names match an id, a title, or the arrow labels', () => {
  const paths = [{id: 'pay', title: 'Pay the bill', labels: ['Home', 'Bill']}];
  assert.equal(matchDiagramPath(paths, 'pay'), 'pay');
  assert.equal(matchDiagramPath(paths, 'Pay the bill'), 'pay');
  assert.equal(matchDiagramPath(paths, 'Home → Bill'), 'pay');
  assert.equal(matchDiagramPath(paths, 'Home -> Bill'), 'pay');
  assert.equal(matchDiagramPath(paths, 'Something else'), undefined);
});

test('undo stays up for 10 seconds and a newer revision drops the offer', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(dom.window, key), configurable: true});
  }
  mock.timers.enable({apis: ['setTimeout']});
  const root = createRoot(dom.window.document.getElementById('root')!);
  const seen: string[] = [];
  function Probe({offer, revision}: {offer?: {receiptId: string; revision: number; workspaceId: string}; revision: number}) {
    const [undoOffer, setUndoOffer] = useState(offer);
    const [visible, setVisible] = useState(false);
    useUndoWindow(undoOffer, revision, setUndoOffer, setVisible);
    seen.push((visible ? 'up' : 'down') + ':' + (undoOffer ? 'offer' : 'none'));
    return null;
  }
  try {
    await act(async () => { root.render(createElement(Probe, {offer: {receiptId: 'r', revision: 1, workspaceId: 'ws'}, revision: 1})); });
    assert.equal(seen.at(-1), 'up:offer');
    await act(async () => { mock.timers.tick(UNDO_WINDOW_MS); });
    assert.equal(seen.at(-1), 'down:offer');
    await act(async () => { root.render(createElement(Probe, {offer: {receiptId: 'r', revision: 1, workspaceId: 'ws'}, revision: 2})); });
    assert.equal(seen.at(-1), 'down:none');
  } finally {
    mock.timers.reset();
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
