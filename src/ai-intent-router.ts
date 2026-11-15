import type {CanvasGraph} from '../server/canvas.js';
import type {Diagnostic, FlowDraft} from '../server/authoring/types.js';
import type {GenerationView} from './ai-flow-client.js';
import type {AiDraft, AiDraftStatus} from './ai-flow.js';
import {CANT_READ_IMAGES, plainDiagramError} from './diagram-intake.js';

export function isFlowDraft(value: unknown): value is FlowDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as FlowDraft;
  return draft.schemaVersion === 1 && draft.mode === 'createScenario' && Array.isArray(draft.screens) && Array.isArray(draft.visits);
}

function fromView(current: AiDraft, view: GenerationView, revision: number): AiDraft {
  const draft = isFlowDraft(view.draft) ? view.draft : current.draft;
  const preview = view.preview;
  const baseRevision = preview?.baseRevision ?? current.baseRevision;
  const revisionStale = baseRevision !== undefined && revision !== baseRevision;
  const terminal = view.state !== 'running';
  const incomingPreviewId = view.previewId ?? preview?.previewId;
  const previewReplaced = !!incomingPreviewId && incomingPreviewId !== current.previewId;
  let status: AiDraftStatus = current.status;
  if (view.state === 'running') status = revisionStale ? 'stale' : 'generating';
  else if (view.state === 'failed') status = 'failed';
  else if (view.state === 'cancelled') status = 'prompting';
  else if (revisionStale || (current.status === 'stale' && !preview)) status = 'stale';
  else if (view.state === 'needsInfo' || (preview && !preview.applicable)) status = 'needsInfo';
  else status = 'pending';
  return {
    ...current,
    status,
    jobId: view.state === 'cancelled' ? undefined : view.id,
    phase: view.state === 'running' ? view.phase : undefined,
    ...(baseRevision !== undefined ? {baseRevision} : {}),
    ...(incomingPreviewId ? {previewId: incomingPreviewId} : {}),
    ...(previewReplaced ? {previewedPlacements: undefined, previewedReplaceId: undefined} : {}),
    ...(preview ? {
      applicable: preview.applicable,
      diagnostics: preview.diagnostics,
      requiredAssumptionKeys: preview.requiredAssumptionKeys,
      expiresAt: preview.expiresAt,
    } : {}),
    ...(draft ? {draft} : {}),
    ...(view.inputTokens !== undefined ? {inputTokens: view.inputTokens} : {}),
    ...(view.outputTokens !== undefined ? {outputTokens: view.outputTokens} : {}),
    ...(view.cost !== undefined ? {cost: view.cost} : {}),
    ...(view.model ? {model: view.model} : {}),
    ...(view.upstreamProvider ? {upstreamProvider: view.upstreamProvider} : {}),
    ...(view.error ? {error: view.error} : terminal && view.state !== 'failed' ? {error: undefined} : {}),
    questions: view.state === 'running' ? current.questions : (view.state === 'needsInfo' && view.questions?.length ? view.questions : undefined),
  };
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (!value || typeof value !== 'object') return false;
  const item = value as Diagnostic;
  return typeof item.code === 'string' && typeof item.path === 'string' && typeof item.message === 'string' && Array.isArray(item.blocks) && (item.severity === 'error' || item.severity === 'warning' || item.severity === 'info');
}

/** Diagnostics may sit on the preview or, for a failed job, directly on the generation. */
function diagnosticsOn(view: GenerationView) {
  const extra = (view as GenerationView & {diagnostics?: unknown}).diagnostics;
  return Array.isArray(extra) ? extra.filter(isDiagnostic) : [];
}

function isAskBack(view: GenerationView) {
  if (view.state !== 'needsInfo' || !view.questions?.length) return false;
  if (isFlowDraft(view.draft) || view.preview) return false;
  if (view.intent === 'diagram' || view.kind === 'diagram') return !view.diagramDraft;
  return view.intent === 'knowledge' || view.intent === 'unclear' || view.intent === 'mixed' || view.kind === 'knowledge';
}

function diagramReady(view: GenerationView) {
  return view.state === 'pending' && !!view.diagramDraft && (view.intent === 'diagram' || view.kind === 'diagram');
}

function knowledgeReady(view: GenerationView) {
  return view.state === 'pending' && !!view.knowledgeDraft && (view.intent === 'knowledge' || view.kind === 'knowledge');
}

function withIntent(next: AiDraft, view: GenerationView): AiDraft {
  return {
    ...next,
    ...(view.intent ? {intent: view.intent} : {}),
    ...(view.kind ? {kind: view.kind} : {}),
    ...(view.scenarioId ? {scenarioId: view.scenarioId} : {}),
    remainder: view.intent === 'mixed' ? view.remainder : undefined,
  };
}

/**
 * A review status closes the composer only when the canvas can draw the draft.
 * needsInfo with a non-applicable, non-rendering preview (INVALID_DRAFT) and
 * failed AUTHORING_INVALID / INVALID_AI_OUTPUT stay in the composer with the prompt.
 * A knowledge draft and an ask-back with no flow draft stay in the capsule instead.
 */
export function presentResult(current: AiDraft, view: GenerationView, revision: number, canvas: CanvasGraph | undefined, renders: (draft: FlowDraft | undefined, canvas: CanvasGraph | undefined) => boolean): AiDraft {
  if (diagramReady(view)) {
    const base = fromView({...current, baseRevision: undefined}, view, revision);
    return {
      ...withIntent(base, view),
      status: 'pending',
      diagramDraft: view.diagramDraft,
      draft: undefined,
      knowledgeDraft: undefined,
      questions: undefined,
      previewId: undefined,
      applicable: undefined,
      error: undefined,
      phase: undefined,
      attachment: undefined,
      attachmentError: undefined,
      quiet: undefined,
      knowledgeHeld: false,
      baseRevision: undefined,
    };
  }
  if (knowledgeReady(view)) {
    const base = fromView({...current, baseRevision: undefined}, view, revision);
    return {
      ...withIntent(base, view),
      status: 'pending',
      knowledgeDraft: view.knowledgeDraft,
      draft: undefined,
      previewId: undefined,
      applicable: undefined,
      questions: undefined,
      error: undefined,
      phase: undefined,
      knowledgeHeld: false,
      baseRevision: undefined,
    };
  }
  if (isAskBack(view)) {
    const base = fromView({...current, baseRevision: undefined}, view, revision);
    return {
      ...withIntent(base, view),
      status: 'needsInfo',
      knowledgeDraft: undefined,
      draft: undefined,
      previewId: undefined,
      applicable: undefined,
      questions: view.questions,
      error: undefined,
      phase: undefined,
      attachment: undefined,
      attachmentError: undefined,
      diagramDraft: undefined,
      quiet: undefined,
      knowledgeHeld: false,
      baseRevision: undefined,
    };
  }
  const base = fromView(current, view, revision);
  const diagnostics = base.diagnostics?.length ? base.diagnostics : diagnosticsOn(view);
  const next = withIntent(diagnostics.length ? {...base, diagnostics} : base, view);
  if (view.state === 'running' || view.state === 'cancelled') return {...next, knowledgeDraft: undefined};
  if (view.state === 'failed') {
    const line = plainDiagramError(view.error?.code, view.error?.message ?? '');
    if (line === CANT_READ_IMAGES) return {...next, status: 'failed', knowledgeDraft: undefined, attachmentError: line, quiet: undefined};
    if (line) return {...next, status: 'prompting', knowledgeDraft: undefined, attachment: undefined, attachmentError: line, error: undefined, quiet: undefined};
    return {...next, status: 'failed', knowledgeDraft: undefined, quiet: undefined};
  }
  if (next.status !== 'pending' && next.status !== 'needsInfo' && next.status !== 'stale') return next;
  if (renders(next.draft, canvas)) return {...next, knowledgeDraft: undefined, diagramDraft: undefined};
  const blocking = (next.diagnostics ?? []).some(item => item.blocks.includes('apply') || item.severity === 'error');
  if (!blocking && next.applicable !== false && view.state !== 'needsInfo') return {...next, knowledgeDraft: undefined};
  return {
    ...next,
    status: 'failed',
    knowledgeDraft: undefined,
    error: next.error ?? {code: 'AUTHORING_INVALID', message: 'The reply didn’t fit TnT’s format, even after one repair.', retryable: false},
  };
}
