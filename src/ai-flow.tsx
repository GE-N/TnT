import {useEffect, useId, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import type {CanvasGraph} from '../server/canvas.js';
import type {Diagnostic, DraftTarget, DraftValue, FlowDraft, Preview} from '../server/authoring/types.js';
import type {Workspace} from '../server/scenarios.js';
import type {DraftOverlay} from './canvas.js';
import {AI_POLL_MS, AiFlowRequestError, createAiFlowClient, type AiPublicConfig, type ApplyResponse, type GenerationPhase, type GenerationView} from './ai-flow-client.js';

export type AiDraftStatus = 'idle' | 'prompting' | 'generating' | 'pending' | 'needsInfo' | 'stale' | 'applying' | 'failed';

/** Client slice from SYSTEM-DESIGN §1. Only ids and the prompt are written into view state. */
export type AiDraft = {
  status: AiDraftStatus;
  prompt: string;
  jobId?: string;
  previewId?: string;
  baseRevision?: number;
  expiresAt?: string;
  applicable?: boolean;
  diagnostics?: Diagnostic[];
  requiredAssumptionKeys?: string[];
  acknowledged: string[];
  error?: {code: string; message: string; retryable: boolean};
  phase?: GenerationPhase;
  draft?: FlowDraft;
};

export type PersistedAiDraft = {jobId: string; prompt: string; previewId?: string; baseRevision?: number};

type LoadedWorkspace = Workspace & {view?: Record<string, unknown> | null};

const PHASE_LABEL: Record<GenerationPhase, string> = {
  context: 'Reading the workspace…',
  model: 'Writing the flow…',
  validating: 'Checking the draft…',
  repairing: 'Repairing the draft…',
  previewing: 'Preparing the preview…',
};

const REVIEW: AiDraftStatus[] = ['pending', 'needsInfo', 'stale', 'applying'];

function emptyDraft(prompt = ''): AiDraft {
  return {status: 'idle', prompt, acknowledged: []};
}

export function persistedAiDraft(view: Record<string, unknown> | null | undefined): PersistedAiDraft | undefined {
  const raw = view?.aiDraft;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const item = raw as Record<string, unknown>;
  if (typeof item.jobId !== 'string' || !item.jobId || typeof item.prompt !== 'string') return;
  return {
    jobId: item.jobId,
    prompt: item.prompt,
    ...(typeof item.previewId === 'string' ? {previewId: item.previewId} : {}),
    ...(typeof item.baseRevision === 'number' ? {baseRevision: item.baseRevision} : {}),
  };
}

function isFlowDraft(value: unknown): value is FlowDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as FlowDraft;
  return draft.schemaVersion === 1 && draft.mode === 'createScenario' && Array.isArray(draft.screens) && Array.isArray(draft.visits);
}

function placeScreens(existing: {x: number; y: number}[], count: number) {
  const width = 260;
  const height = 180;
  const occupied = existing.map(item => ({...item}));
  const placed: {x: number; y: number}[] = [];
  const hit = (x: number, y: number) => occupied.some(box => x < box.x + width && x + width > box.x && y < box.y + height && y + height > box.y);
  for (let y = 40; y <= 1400 && placed.length < count; y += height) {
    for (let x = 40; x <= 2400 && placed.length < count; x += width) {
      if (hit(x, y)) continue;
      const point = {x, y};
      placed.push(point);
      occupied.push(point);
    }
  }
  return placed;
}

/** Read-only overlay. New screens sit in free space. Existing screen coordinates are only used as edge anchors. */
export function draftOverlayFor(draft: FlowDraft, canvas: CanvasGraph | undefined): DraftOverlay {
  const existing = new Map((canvas?.screens ?? []).map(screen => [screen.id, screen]));
  const createOrder: string[] = [];
  for (const visit of draft.visits) {
    const screen = draft.screens.find(item => item.key === visit.screenKey);
    if (screen?.kind === 'create' && !createOrder.includes(screen.key)) createOrder.push(screen.key);
  }
  for (const screen of draft.screens) if (screen.kind === 'create' && !createOrder.includes(screen.key)) createOrder.push(screen.key);
  const spots = placeScreens((canvas?.screens ?? []).map(screen => ({x: screen.x, y: screen.y})), createOrder.length);
  const nodes = createOrder.map((key, index) => {
    const declared = draft.screens.find(screen => screen.key === key);
    const spot = spots[index] ?? {x: 40 + (index % 8) * 280, y: 40 + Math.floor(index / 8) * 200};
    return {key, title: declared && declared.kind === 'create' ? declared.title : key, x: spot.x, y: spot.y};
  });
  const anchors = draft.screens.flatMap(screen => {
    if (screen.kind !== 'existing') return [];
    const found = existing.get(screen.screenId);
    return found ? [{key: screen.key, x: found.x, y: found.y}] : [];
  });
  const known = new Set([...nodes.map(node => node.key), ...anchors.map(anchor => anchor.key)]);
  const titleOf = (key: string) => draft.screens.find(screen => screen.key === key)?.kind === 'create'
    ? (draft.screens.find(screen => screen.key === key) as {title: string}).title
    : (existing.get((draft.screens.find(screen => screen.key === key) as {screenId?: string} | undefined)?.screenId ?? '')?.title ?? key);
  const edges: DraftOverlay['edges'] = [];
  for (let index = 0; index < draft.visits.length - 1; index++) {
    const from = draft.visits[index].screenKey;
    const to = draft.visits[index + 1].screenKey;
    if (!known.has(from) || !known.has(to)) continue;
    edges.push({from, to, label: titleOf(from) + ' → ' + titleOf(to)});
  }
  return {nodes, edges, anchors};
}

export function fillUnresolved(draft: FlowDraft, path: string, next: DraftTarget | DraftValue): FlowDraft {
  const copy = structuredClone(draft);
  const match = /^\/visits\/(\d+)\/operations\/(\d+)\/(target|value)$/.exec(path);
  if (!match) return copy;
  const operation = copy.visits[Number(match[1])]?.operations[Number(match[2])];
  if (!operation) return copy;
  if (match[3] === 'target' && 'target' in operation) operation.target = next as DraftTarget;
  if (match[3] === 'value' && operation.kind === 'input') operation.value = next as DraftValue;
  return copy;
}

function needsRegeneration(code: string | undefined, diagnostics?: {code: string}[]) {
  if (code === 'REVISION_CONFLICT' || !!code?.startsWith('INVALID_')) return true;
  return !!diagnostics?.some(item => item.code === 'REVISION_CONFLICT' || item.code.startsWith('INVALID_'));
}

function errorOf(error: unknown, fallback: string): {code: string; message: string; retryable: boolean} {
  if (error instanceof AiFlowRequestError) return {code: error.code, message: error.message, retryable: error.status >= 500 || error.status === 409 || error.status === 429};
  return {code: 'REQUEST_FAILED', message: error instanceof Error ? error.message : fallback, retryable: true};
}

function fromView(current: AiDraft, view: GenerationView, revision: number): AiDraft {
  const draft = isFlowDraft(view.draft) ? view.draft : current.draft;
  const preview = view.preview;
  const baseRevision = preview?.baseRevision ?? current.baseRevision;
  const revisionStale = baseRevision !== undefined && revision !== baseRevision;
  const terminal = view.state !== 'running';
  let status: AiDraftStatus = current.status;
  if (view.state === 'running') status = revisionStale ? 'stale' : 'generating';
  else if (view.state === 'failed') status = 'failed';
  else if (view.state === 'cancelled') status = 'prompting';
  else if (revisionStale || current.status === 'stale') status = 'stale';
  else if (view.state === 'needsInfo' || (preview && !preview.applicable)) status = 'needsInfo';
  else status = 'pending';
  return {
    ...current,
    status,
    jobId: view.state === 'cancelled' ? undefined : view.id,
    phase: view.state === 'running' ? view.phase : undefined,
    ...(baseRevision !== undefined ? {baseRevision} : {}),
    ...(view.previewId || preview?.previewId ? {previewId: view.previewId ?? preview?.previewId} : {}),
    ...(preview ? {
      applicable: preview.applicable,
      diagnostics: preview.diagnostics,
      requiredAssumptionKeys: preview.requiredAssumptionKeys,
      expiresAt: preview.expiresAt,
      acknowledged: current.acknowledged.filter(key => preview.requiredAssumptionKeys.includes(key)),
    } : {}),
    ...(draft ? {draft} : {}),
    ...(view.error ? {error: view.error} : terminal && view.state !== 'failed' ? {error: undefined} : {}),
  };
}

function screenCount(draft: FlowDraft | undefined) {
  return draft?.screens.length ?? 0;
}

function stepCount(draft: FlowDraft | undefined) {
  return draft?.visits.reduce((sum, visit) => sum + visit.operations.length, 0) ?? 0;
}

function countPhrase(count: number, singular: string, plural: string) {
  return count + ' ' + (count === 1 ? singular : plural);
}

type Callbacks = {
  save: () => Promise<Workspace | undefined>;
  loadWorkspace: (workspace: LoadedWorkspace) => void;
  selectScenario: (id: string) => void;
  rememberView: (patch: Record<string, unknown>) => void;
  fetchWorkspace: (id: string) => Promise<LoadedWorkspace>;
  readView: () => Record<string, unknown>;
};

export function useAiDraft(input: Callbacks & {token: string; workspaceId: string; revision: number; running: boolean; canvas: CanvasGraph | undefined; contentKey: string; loadRevision: number}) {
  const client = useMemo(() => createAiFlowClient(input.token), [input.token]);
  const callbacks = useRef<Callbacks>(input);
  callbacks.current = input;
  const [draft, setDraft] = useState<AiDraft>(emptyDraft);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [provenanceId, setProvenanceId] = useState('');
  const [undoOffer, setUndoOffer] = useState<{receiptId: string; revision: number; workspaceId: string}>();
  const jobGuard = useRef<string | undefined>(undefined);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const revisionRef = useRef(input.revision);
  revisionRef.current = input.revision;
  const idempotency = useRef(new Map<string, string>());
  const hydrateToken = useRef(0);
  const provenanceBaseline = useRef<string | undefined>(undefined);

  const review = REVIEW.includes(draft.status);
  const overlay = draft.draft && review ? draftOverlayFor(draft.draft, input.canvas) : undefined;

  useEffect(() => {
    if (!draft.jobId || draft.status === 'idle') return;
    callbacks.current.rememberView({aiDraft: {
      jobId: draft.jobId,
      prompt: draft.prompt,
      ...(draft.previewId ? {previewId: draft.previewId} : {}),
      ...(draft.baseRevision !== undefined ? {baseRevision: draft.baseRevision} : {}),
    }});
  }, [draft.jobId, draft.prompt, draft.previewId, draft.baseRevision, draft.status]);

  useEffect(() => {
    setDraft(current => {
      if (current.baseRevision === undefined) return current;
      if (input.revision === current.baseRevision) return current;
      if (current.status !== 'generating' && current.status !== 'pending' && current.status !== 'needsInfo') return current;
      return {...current, status: 'stale'};
    });
  }, [input.revision]);

  useEffect(() => {
    const polling = draft.status === 'generating' || (draft.status === 'stale' && !!draft.phase);
    const id = draft.jobId;
    if (!polling || !id) return;
    let stopped = false;
    const tick = async () => {
      let view: GenerationView;
      try { view = await client.getGeneration(id); }
      catch { return; }
      if (stopped || jobGuard.current !== id || view.id !== id) return;
      setDraft(current => {
        if (current.jobId !== id) return current;
        if (current.status !== 'generating' && current.status !== 'stale') return current;
        return fromView(current, view, revisionRef.current);
      });
    };
    void tick();
    const timer = setInterval(() => void tick(), AI_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [client, draft.jobId, draft.phase, draft.status]);

  useEffect(() => {
    if (input.loadRevision === 0) return;
    const stored = persistedAiDraft(callbacks.current.readView());
    const token = ++hydrateToken.current;
    if (!stored || !input.workspaceId) {
      jobGuard.current = undefined;
      setDraft(emptyDraft());
      setOpen(false);
      return;
    }
    let cancelled = false;
    jobGuard.current = stored.jobId;
    setDraft({status: 'generating', prompt: stored.prompt, jobId: stored.jobId, previewId: stored.previewId, baseRevision: stored.baseRevision, acknowledged: []});
    setOpen(true);
    void (async () => {
      try {
        const view = await client.getGeneration(stored.jobId);
        if (cancelled || hydrateToken.current !== token || jobGuard.current !== stored.jobId || view.id !== stored.jobId) return;
        const revision = revisionRef.current;
        if (!view.preview && isFlowDraft(view.draft) && view.state !== 'running' && view.state !== 'failed' && view.state !== 'cancelled') {
          await repreview(view.draft, revision, input.workspaceId, false);
          return;
        }
        setDraft(current => current.jobId === stored.jobId ? fromView({...current, prompt: stored.prompt, acknowledged: []}, view, revision) : current);
      } catch (error) {
        if (cancelled || hydrateToken.current !== token || jobGuard.current !== stored.jobId) return;
        setDraft(current => current.jobId === stored.jobId ? {...current, status: 'failed', error: errorOf(error, 'The draft could not be restored.')} : current);
      }
    })();
    return () => { cancelled = true; };
  }, [client, input.loadRevision, input.workspaceId]);

  useEffect(() => {
    if (!provenanceId) { provenanceBaseline.current = undefined; return; }
    if (provenanceBaseline.current === undefined) { provenanceBaseline.current = input.contentKey; return; }
    if (input.contentKey !== provenanceBaseline.current) {
      provenanceBaseline.current = undefined;
      setProvenanceId('');
      setUndoOffer(undefined);
    }
  }, [input.contentKey, provenanceId]);

  useEffect(() => {
    setUndoOffer(current => current && input.revision !== current.revision ? undefined : current);
  }, [input.revision]);

  function clearPersisted() {
    callbacks.current.rememberView({aiDraft: null});
  }

  async function generate(prompt = draft.prompt) {
    const text = prompt.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setOpen(true);
    setSettings(false);
    setDraft(current => ({...current, status: 'prompting', prompt: text, error: undefined}));
    let saved: Workspace | undefined;
    try { saved = await callbacks.current.save(); }
    catch (error) {
      setDraft(current => ({...current, status: 'failed', prompt: text, error: {...errorOf(error, 'Save failed. The draft was not generated.'), retryable: true, code: 'SAVE_FAILED'}}));
      setSubmitting(false);
      return;
    }
    if (!saved?.id) {
      setDraft(current => ({...current, status: 'failed', prompt: text, error: {code: 'SAVE_FAILED', message: 'Save the workspace before generating.', retryable: true}}));
      setSubmitting(false);
      return;
    }
    const baseRevision = saved.metadata?.revision ?? 0;
    try {
      const started = await client.startGeneration({workspaceId: saved.id, expectedRevision: baseRevision, prompt: text});
      jobGuard.current = started.id;
      setDraft({status: 'generating', prompt: text, jobId: started.id, baseRevision, phase: started.phase, acknowledged: [], ...(started.error ? {error: started.error} : {})});
    } catch (error) {
      jobGuard.current = undefined;
      setDraft(current => ({...current, status: 'failed', prompt: text, jobId: undefined, error: errorOf(error, 'Couldn’t generate.')}));
    } finally { setSubmitting(false); }
  }

  async function repreview(nextDraft: FlowDraft, revision: number, workspaceId: string, regenerate: boolean) {
    const watched = jobGuard.current;
    try {
      const context = await client.createContext({workspaceId, expectedRevision: revision});
      const preview = await client.preview({workspaceId, expectedRevision: revision, contextId: context.contextId, draft: nextDraft});
      if (jobGuard.current !== watched) return;
      if (regenerate && needsRegeneration(undefined, preview.diagnostics)) {
        await generate(draftRef.current.prompt);
        return;
      }
      setDraft(current => {
        if (watched && current.jobId !== watched) return current;
        return {
          ...current,
          draft: nextDraft,
          status: preview.baseRevision !== revision ? 'stale' : preview.applicable ? 'pending' : 'needsInfo',
          previewId: preview.previewId,
          baseRevision: preview.baseRevision,
          expiresAt: preview.expiresAt,
          applicable: preview.applicable,
          diagnostics: preview.diagnostics,
          requiredAssumptionKeys: preview.requiredAssumptionKeys,
          acknowledged: current.acknowledged.filter(key => preview.requiredAssumptionKeys.includes(key)),
          phase: undefined,
          error: undefined,
        };
      });
    } catch (error) {
      if (jobGuard.current !== watched) return;
      if (regenerate && error instanceof AiFlowRequestError && needsRegeneration(error.code, error.diagnostics)) {
        await generate(draftRef.current.prompt);
        return;
      }
      setDraft(current => watched && current.jobId !== watched ? current : {...current, error: errorOf(error, 'The draft could not be previewed.')});
    }
  }

  async function refresh() {
    const current = draftRef.current;
    const workspaceId = input.workspaceId;
    if (!current.draft || !workspaceId) return;
    await repreview(current.draft, revisionRef.current, workspaceId, true);
  }

  async function updateUnresolved(path: string, next: DraftTarget | DraftValue) {
    const current = draftRef.current;
    if (!current.draft || !input.workspaceId) return;
    const patched = fillUnresolved(current.draft, path, next);
    setDraft(existing => ({...existing, draft: patched}));
    await repreview(patched, current.baseRevision ?? revisionRef.current, input.workspaceId, false);
  }

  function acknowledge(key: string, on: boolean) {
    setDraft(current => ({...current, acknowledged: on ? [...new Set([...current.acknowledged, key])] : current.acknowledged.filter(item => item !== key)}));
  }

  async function confirm() {
    const current = draftRef.current;
    if (confirmReason(current, input.running) || !current.previewId || current.baseRevision === undefined || !input.workspaceId) return;
    const previewId = current.previewId;
    let key = idempotency.current.get(previewId);
    if (!key) { key = crypto.randomUUID(); idempotency.current.set(previewId, key); }
    setDraft(existing => ({...existing, status: 'applying', error: undefined}));
    let applied: ApplyResponse;
    try {
      applied = await client.apply({
        workspaceId: input.workspaceId,
        expectedRevision: current.baseRevision,
        previewId,
        idempotencyKey: key,
        acknowledgedAssumptionKeys: current.acknowledged,
      });
    } catch (error) {
      setDraft(existing => ({...existing, status: current.applicable === false ? 'needsInfo' : 'pending', error: errorOf(error, 'The draft could not be confirmed.')}));
      return;
    }
    try {
      const detail = await callbacks.current.fetchWorkspace(applied.workspaceId);
      if (detail.view && typeof detail.view === 'object') detail.view = {...detail.view, aiDraft: null};
      jobGuard.current = undefined;
      callbacks.current.loadWorkspace(detail);
      callbacks.current.selectScenario(applied.scenarioId);
      clearPersisted();
      setDraft(emptyDraft());
      setOpen(false);
      setProvenanceId(applied.scenarioId);
      if (applied.receiptId) setUndoOffer({receiptId: applied.receiptId, revision: applied.revision, workspaceId: applied.workspaceId});
    } catch (error) {
      setDraft(existing => ({...existing, status: 'failed', error: errorOf(error, 'The workspace could not be reloaded after confirm.')}));
    }
  }

  async function undoApply() {
    const offer = undoOffer;
    if (!offer) return;
    try {
      await client.undo({workspaceId: offer.workspaceId, expectedRevision: offer.revision, receiptId: offer.receiptId});
      const detail = await callbacks.current.fetchWorkspace(offer.workspaceId);
      callbacks.current.loadWorkspace(detail);
      setUndoOffer(undefined);
      setProvenanceId('');
    } catch (error) {
      setDraft(current => ({...current, error: errorOf(error, 'Undo failed.')}));
      setOpen(true);
    }
  }

  async function cancel() {
    const id = jobGuard.current ?? draftRef.current.jobId;
    const prompt = draftRef.current.prompt;
    jobGuard.current = undefined;
    clearPersisted();
    setDraft({...emptyDraft(prompt), status: 'prompting'});
    setOpen(true);
    if (id) {
      try { await client.cancelGeneration(id); }
      catch { /* The panel is already back to the prompt. A late job result is ignored. */ }
    }
  }

  async function discard() {
    const current = draftRef.current;
    const id = jobGuard.current ?? current.jobId;
    const stillRunning = current.status === 'generating' || (current.status === 'stale' && !!current.phase);
    jobGuard.current = undefined;
    clearPersisted();
    setDraft(emptyDraft());
    setOpen(false);
    setSettings(false);
    if (id && stillRunning) {
      try { await client.cancelGeneration(id); }
      catch { /* There is no delete route. Cancelling is best-effort; the preview expires on its own. */ }
    }
  }

  function openPanel() {
    setSettings(false);
    setOpen(true);
    setDraft(current => current.status === 'idle' ? {...current, status: 'prompting'} : current);
  }

  function closePanel() {
    setSettings(false);
    setOpen(false);
    setDraft(current => current.status === 'prompting' ? {...current, status: 'idle'} : current);
  }

  const reason = confirmReason(draft, input.running);
  return {
    draft, open, settings, submitting, overlay, provenanceId, undoOffer, reason, token: input.token,
    setSettings, setPrompt: (prompt: string) => setDraft(current => ({...current, prompt})),
    openPanel, closePanel, generate, refresh, updateUnresolved, acknowledge, confirm, undoApply, cancel, discard,
  };
}

export function confirmReason(draft: AiDraft, running: boolean) {
  if (!REVIEW.includes(draft.status) && draft.status !== 'failed') return undefined;
  if (draft.status === 'applying') return 'Confirm is unavailable while the draft is being added.';
  if (running) return 'Confirm is unavailable while a run is active.';
  if (draft.status === 'stale') return 'Confirm is unavailable because the workspace changed. Refresh the draft.';
  const missing = (draft.requiredAssumptionKeys ?? []).filter(key => !draft.acknowledged.includes(key));
  const unresolved = (draft.diagnostics ?? []).some(item => item.code === 'UNRESOLVED_TARGET' || item.code === 'UNRESOLVED_VALUE');
  const blocked = draft.applicable === false || unresolved;
  if (blocked && missing.length) return 'Confirm is unavailable until every item that needs info is filled and every assumption is acknowledged.';
  if (blocked) return 'Confirm is unavailable until every item that needs info is filled.';
  if (missing.length) return 'Confirm is unavailable until every assumption is acknowledged.';
  if (draft.status === 'failed' || !draft.previewId) return 'Confirm is unavailable until a draft is ready.';
  return undefined;
}

export type AiDraftControl = ReturnType<typeof useAiDraft>;

export function AiFlow({control}: {control: AiDraftControl}) {
  const {draft, open, settings, submitting, provenanceId, undoOffer} = control;
  const review = REVIEW.includes(draft.status);
  const generating = draft.status === 'generating';
  const failed = draft.status === 'failed';
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const focusedPreview = useRef('');
  const errorId = useId();
  const reasonId = useId();
  const screens = screenCount(draft.draft);
  const steps = stepCount(draft.draft);
  const meta = countPhrase(screens, 'screen', 'screens') + ' · ' + countPhrase(steps, 'step', 'steps') + ' · not run yet';
  const [live, setLive] = useState('');
  const waiting = draft.status === 'pending' || draft.status === 'needsInfo' || draft.status === 'stale';
  const busy = generating || submitting || draft.status === 'applying';

  useEffect(() => {
    if (!open || settings || generating || review || failed) return;
    fieldRef.current?.focus();
  }, [open, settings, generating, review, failed, draft.status]);

  useEffect(() => {
    if (!open || !failed) return;
    retryRef.current?.focus();
  }, [open, failed, draft.error?.message]);

  useEffect(() => {
    if (!open || !review || !draft.previewId || focusedPreview.current === draft.previewId) return;
    focusedPreview.current = draft.previewId;
    confirmRef.current?.focus();
    setLive('Draft ready, ' + screens + ' screens, not run yet');
  }, [open, review, draft.previewId, screens]);

  useEffect(() => {
    if (!generating) return;
    setLive(PHASE_LABEL[draft.phase ?? 'model']);
  }, [generating, draft.phase]);

  function onPanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    if (generating) { event.preventDefault(); event.stopPropagation(); void control.cancel(); return; }
    if (review) { event.preventDefault(); event.stopPropagation(); return; }
    event.preventDefault();
    event.stopPropagation();
    control.closePanel();
    buttonRef.current?.focus();
  }

  function onFieldKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (draft.prompt.trim() && !busy) void control.generate();
  }

  return <div className="ai-flow" data-testid="ai-flow" data-ai-status={draft.status}>
    <p className="sr-only" aria-live="polite" data-testid="ai-live">{live}</p>
    {provenanceId && <p className="ai-provenance" data-testid="ai-provenance">Added from a description · just now{undoOffer && <> · <button type="button" data-testid="ai-undo" onClick={() => void control.undoApply()}>Undo</button></>}</p>}
    {open && <section className={'ai-panel' + (failed ? ' is-error' : '') + (generating || submitting ? ' is-busy' : '')} aria-label="Describe a flow" aria-busy={busy || undefined} onKeyDown={onPanelKeyDown}>
      {settings ? <Settings token={control.token} onBack={() => control.setSettings(false)} /> : review ? <Review control={control} meta={meta} reasonId={reasonId} confirmRef={confirmRef} /> : <>
        <div className="ai-panel-bar"><button type="button" className="ai-text" onClick={() => control.setSettings(true)}>Provider settings</button><button type="button" className="ai-text" aria-label="Close" onClick={() => { control.closePanel(); buttonRef.current?.focus(); }}>✕</button></div>
        <textarea ref={fieldRef} className="ai-prompt-field" aria-label="Flow description" placeholder="Describe the flow" value={draft.prompt} readOnly={generating || submitting} aria-invalid={failed || undefined} aria-describedby={failed ? errorId : undefined} maxLength={2000} onChange={event => control.setPrompt(event.target.value)} onKeyDown={onFieldKeyDown} />
        {(generating || submitting) && <div className="ai-progress" role="progressbar" aria-valuetext={submitting && !generating ? 'Saving…' : PHASE_LABEL[draft.phase ?? 'model']} aria-label="Generating flow" />}
        {generating && <p className="ai-status" aria-live="polite"><span className="ai-spinner" aria-hidden="true" /> Generating flow… <span className="ai-muted">{PHASE_LABEL[draft.phase ?? 'model']}</span></p>}
        {submitting && !generating && <p className="ai-status" aria-live="polite"><span className="ai-spinner" aria-hidden="true" /> Saving…</p>}
        {failed && draft.error && <p id={errorId} className="ai-error" role="alert" data-testid="ai-error">✕ Couldn’t generate <span className="ai-muted">{draft.error.message}</span></p>}
        <div className="ai-actions">
          {generating ? <button type="button" className="ai-text" data-testid="ai-cancel" onClick={() => void control.cancel()}>Cancel</button>
            : failed ? <button type="button" ref={retryRef} className="ai-text" data-testid="ai-retry" onClick={() => void control.generate()}>↻ Retry</button>
            : <button type="button" className="ai-text" data-testid="ai-generate" disabled={!draft.prompt.trim() || submitting} onClick={() => void control.generate()}>✦ Generate</button>}
        </div>
      </>}
    </section>}
    <button type="button" ref={buttonRef} className={'ai-launch' + (open ? ' is-open' : '')} data-testid="ai-flow-button" aria-label="Describe a flow" title="Describe a flow" aria-expanded={open} aria-busy={busy || undefined} onClick={() => open ? (generating ? undefined : control.closePanel()) : control.openPanel()}>
      <Sparkles />
      {waiting && <span className="ai-launch-dot" data-testid="ai-flow-dot" aria-hidden="true" />}
    </button>
  </div>;
}

function Review({control, meta, reasonId, confirmRef}: {control: AiDraftControl; meta: string; reasonId: string; confirmRef: {current: HTMLButtonElement | null}}) {
  const {draft, reason} = control;
  const unresolved = (draft.diagnostics ?? []).filter(item => item.code === 'UNRESOLVED_TARGET' || item.code === 'UNRESOLVED_VALUE');
  const others = (draft.diagnostics ?? []).filter(item => item.blocks.includes('apply') && item.code !== 'UNRESOLVED_TARGET' && item.code !== 'UNRESOLVED_VALUE');
  const assumptions = draft.draft?.assumptions.filter(item => (draft.requiredAssumptionKeys ?? []).includes(item.key)) ?? [];
  const known = new Set(assumptions.map(item => item.key));
  return <>
    <div className="ai-panel-bar"><h3 className="ai-draft-heading">✦ Draft · from AI</h3><button type="button" className="ai-text" onClick={() => control.setSettings(true)}>Provider settings</button></div>
    <p className="ai-meta" data-testid="ai-meta">{meta}</p>
    {draft.status === 'stale' && <p className="ai-muted">The workspace changed since this draft was prepared.</p>}
    {unresolved.map(item => <NeedsInfo key={item.path + item.code} item={item} onSubmit={value => void control.updateUnresolved(item.path, value)} />)}
    {others.map(item => <p key={item.path + item.code} className="ai-muted">{item.message}</p>)}
    {assumptions.map(item => <label key={item.key} className="ai-check"><input type="checkbox" checked={draft.acknowledged.includes(item.key)} aria-label={item.message} onChange={event => control.acknowledge(item.key, event.target.checked)} />{item.message}</label>)}
    {(draft.requiredAssumptionKeys ?? []).filter(key => !known.has(key)).map(key => <label key={key} className="ai-check"><input type="checkbox" checked={draft.acknowledged.includes(key)} aria-label={key} onChange={event => control.acknowledge(key, event.target.checked)} />{key}</label>)}
    {draft.error && <p className="ai-error" role="alert">✕ {draft.error.message}</p>}
    {reason && <p id={reasonId} className="ai-reason" data-testid="ai-confirm-reason">{reason}</p>}
    <div className="ai-actions">
      <button type="button" ref={confirmRef} className="ai-text ai-confirm" data-testid="ai-confirm" aria-disabled={reason ? true : undefined} aria-describedby={reason ? reasonId : undefined} onClick={() => { if (!reason) void control.confirm(); }}>✓ Confirm</button>
      {draft.status === 'stale' && <button type="button" className="ai-text" data-testid="ai-refresh" onClick={() => void control.refresh()}>Refresh</button>}
      <button type="button" className="ai-text ai-muted-button" data-testid="ai-discard" onClick={() => void control.discard()}>✕ Discard</button>
    </div>
  </>;
}

function NeedsInfo({item, onSubmit}: {item: Diagnostic; onSubmit: (value: DraftTarget | DraftValue) => void}) {
  const [target, setTarget] = useState<'text' | 'id'>('text');
  const [match, setMatch] = useState<'exact' | 'contains' | 'regex'>('exact');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<'literal' | 'parameter'>('literal');
  const label = item.entityKey || item.path;
  return <form className="ai-needs" aria-label={'Needs info for ' + label} onSubmit={event => {
    event.preventDefault();
    if (!value.trim()) return;
    if (item.code === 'UNRESOLVED_VALUE') onSubmit(kind === 'literal' ? {kind: 'literal', text: value.trim()} : {kind: 'parameter', name: value.trim()});
    else onSubmit({kind: 'selector', selector: {target, match, value: value.trim()}});
  }}>
    <p>Needs info · {item.message}</p>
    {item.code === 'UNRESOLVED_VALUE' ? <>
      <label>Value kind<select aria-label={'Needs info value kind for ' + label} value={kind} onChange={event => setKind(event.target.value as 'literal' | 'parameter')}><option value="literal">Literal</option><option value="parameter">Parameter</option></select></label>
      <label>Value<input aria-label={'Needs info value for ' + label} value={value} onChange={event => setValue(event.target.value)} /></label>
    </> : <>
      <label>Target<select aria-label={'Needs info target for ' + label} value={target} onChange={event => setTarget(event.target.value as 'text' | 'id')}><option value="text">Text</option><option value="id">Id</option></select></label>
      <label>Match<select aria-label={'Needs info match for ' + label} value={match} onChange={event => setMatch(event.target.value as 'exact' | 'contains' | 'regex')}><option value="exact">Exact</option><option value="contains">Contains</option><option value="regex">Regex</option></select></label>
      <label>Selector<input aria-label={'Needs info selector for ' + label} value={value} onChange={event => setValue(event.target.value)} /></label>
    </>}
    <button type="submit" className="ai-text">Update</button>
  </form>;
}

function Settings({token, onBack}: {token: string; onBack: () => void}) {
  const client = useMemo(() => createAiFlowClient(token), [token]);
  const [config, setConfig] = useState<AiPublicConfig>({provider: 'openai-compatible', model: '', baseUrl: 'https://api.openai.com/v1', hasKey: false});
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void client.getConfig().then(next => {
      if (cancelled) return;
      setConfig({provider: 'openai-compatible', model: next.model, baseUrl: next.baseUrl, hasKey: next.hasKey});
      setModel(next.model);
      setBaseUrl(next.baseUrl);
    }).catch(error => { if (!cancelled) setFailure(error instanceof Error ? error.message : 'Provider settings could not be loaded.'); });
    return () => { cancelled = true; };
  }, [client]);
  async function save(thenCheck: boolean) {
    setBusy(true); setFailure(''); setNotice('');
    try {
      const body = {provider: 'openai-compatible' as const, model: model.trim(), baseUrl: baseUrl.trim(), ...(apiKey ? {apiKey} : {})};
      const next = await client.putConfig(body);
      setConfig({provider: 'openai-compatible', model: next.model, baseUrl: next.baseUrl, hasKey: next.hasKey});
      setModel(next.model); setBaseUrl(next.baseUrl); setApiKey('');
      if (!thenCheck) { setNotice('Saved.'); setBusy(false); return; }
      const result = await client.checkConfig();
      setNotice(result.ok ? 'Connection ok' + (result.model ? ' · ' + result.model : '') + '.' : (result.error || 'Connection failed.'));
      if (!result.ok) setFailure(result.error || 'Connection failed.');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Provider settings could not be saved.');
    } finally { setBusy(false); }
  }
  return <>
    <h3 className="ai-draft-heading">Provider settings</h3>
    <p>OpenAI-compatible</p>
    <p className="ai-muted">Sent to the provider: prompt, screen titles, selectors, parameter names.</p>
    <label>Model<input aria-label="Model" value={model} maxLength={200} onChange={event => setModel(event.target.value)} /></label>
    <label>Base URL<input aria-label="Base URL" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label>
    <label>API key<input aria-label="API key" data-testid="ai-api-key" type="password" autoComplete="off" value={apiKey} placeholder={config.hasKey ? 'Write a new key' : 'Write a key'} onChange={event => setApiKey(event.target.value)} /></label>
    <p className="ai-muted" data-testid="ai-has-key">{config.hasKey ? 'A key is saved.' : 'No key saved.'}</p>
    {failure && <p className="ai-error" role="alert">{failure}</p>}
    {notice && !failure && <p role="status">{notice}</p>}
    <div className="ai-actions">
      <button type="button" className="ai-text" disabled={busy} onClick={() => void save(false)}>Save</button>
      <button type="button" className="ai-text" data-testid="ai-test-connection" disabled={busy} aria-busy={busy || undefined} onClick={() => void save(true)}>Test connection</button>
      <button type="button" className="ai-text" onClick={onBack}>Back</button>
    </div>
  </>;
}

function Sparkles() {
  return <svg className="ai-spark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.2l1.15 4.05L17.2 8.4l-4.05 1.15L12 13.6l-1.15-4.05L6.8 8.4l4.05-1.15L12 3.2z"/><path d="M18 14.2l.55 1.85L20.4 16.6l-1.85.55L18 19l-.55-1.85L15.6 16.6l1.85-.55L18 14.2z"/></svg>;
}
