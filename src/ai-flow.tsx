import {useEffect, useId, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import type {CanvasGraph} from '../server/canvas.js';
import type {Diagnostic, DraftOperation, DraftTarget, FlowDraft} from '../server/authoring/types.js';
import type {Workspace} from '../server/scenarios.js';
import type {DraftOverlay} from './canvas.js';
import type {DraftPositions} from './draft-placement.js';
import {AI_POLL_MS, ANSWER_CHAR_LIMIT, AiFlowRequestError, createAiFlowClient, PROMPT_CHAR_LIMIT, PROMPT_COUNTER_AT, type AiPublicConfig, type ApplyResponse, type GenerationPhase, type GenerationView, type ProviderId} from './ai-flow-client.js';
import {subscribeAiConfig} from './ai-settings.js';

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
  error?: {code: string; message: string; retryable: boolean};
  phase?: GenerationPhase;
  draft?: FlowDraft;
  workspaceId?: string;
  refining?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  model?: string;
  upstreamProvider?: string;
  notice?: string;
  /** Clarifying questions. Present only while this draft's job is needsInfo. */
  questions?: GenerationView['questions'];
  /** Job this in-flight refine continues. The visible draft stays the current one. */
  previousJobId?: string;
  /** Review status to put back when a refine fails or is cancelled. */
  restoreStatus?: AiDraftStatus;
  /** Canvas coordinates for pending create-screens. Survives reload with the draft; Apply does not read them. */
  positions?: DraftPositions;
};

export type PersistedAiDraft = {jobId: string; prompt: string; previewId?: string; baseRevision?: number; positions?: DraftPositions};

function readPositions(value: unknown): DraftPositions | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const positions: DraftPositions = {};
  for (const [key, point] of Object.entries(value)) {
    if (!key || !point || typeof point !== 'object' || Array.isArray(point)) continue;
    const x = (point as {x?: unknown}).x;
    const y = (point as {y?: unknown}).y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    positions[key] = {x: Math.max(0, Math.min(2400, x)), y: Math.max(0, Math.min(1400, y))};
  }
  return Object.keys(positions).length ? positions : undefined;
}

function viewDraft(draft: AiDraft): PersistedAiDraft | null {
  if (!draft.jobId) return null;
  const positions = readPositions(draft.positions);
  return {
    jobId: draft.jobId,
    prompt: draft.prompt,
    ...(draft.previewId ? {previewId: draft.previewId} : {}),
    ...(typeof draft.baseRevision === 'number' ? {baseRevision: draft.baseRevision} : {}),
    ...(positions ? {positions} : {}),
  };
}

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
  return {status: 'idle', prompt};
}

export function persistedAiDraft(view: Record<string, unknown> | null | undefined): PersistedAiDraft | undefined {
  const raw = view?.aiDraft;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const item = raw as Record<string, unknown>;
  if (typeof item.jobId !== 'string' || !item.jobId || typeof item.prompt !== 'string') return;
  const positions = readPositions(item.positions);
  return {
    jobId: item.jobId,
    prompt: item.prompt,
    ...(typeof item.previewId === 'string' ? {previewId: item.previewId} : {}),
    ...(typeof item.baseRevision === 'number' ? {baseRevision: item.baseRevision} : {}),
    ...(positions ? {positions} : {}),
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

function targetText(target: DraftTarget): string | undefined {
  if (target.kind === 'unresolved') return;
  if (target.kind === 'context') return target.ref.trim() || undefined;
  return target.selector.value.trim() || undefined;
}

function valueText(value: Extract<DraftOperation, {kind: 'input'}>['value']): string | undefined {
  if (value.kind === 'unresolved') return;
  if (value.kind === 'literal') return value.text.trim() || undefined;
  return value.name.trim() || undefined;
}

/** A step with no target is a plain action. Nothing marks it as missing or guessed. */
export function draftStepText(operation: DraftOperation, index: number, destinationTitle?: string) {
  const number = index + 1;
  if (operation.kind === 'tap' || operation.kind === 'back') {
    const name = operation.kind === 'back' ? 'Back' : 'Tap';
    if (!targetText(operation.target)) return number + ' · ' + name;
    if (operation.destination.kind === 'visit' && destinationTitle) return number + ' · Go to ' + destinationTitle;
    return number + ' · ' + name + ' ' + targetText(operation.target);
  }
  if (operation.kind === 'input') {
    const value = valueText(operation.value);
    return value ? number + ' · Input ' + value : number + ' · Input';
  }
  const value = targetText(operation.target);
  if (!value) return number + ' · Check';
  return number + ' · Check "' + value + '" ' + (operation.kind === 'checkAbsent' ? 'absent' : 'visible');
}

function stepSpecified(operation: DraftOperation) {
  if (operation.kind === 'input') return !!valueText(operation.value);
  return !!targetText(operation.target);
}

function screenTitle(draft: FlowDraft, canvas: CanvasGraph | undefined, key: string) {
  const screen = draft.screens.find(item => item.key === key);
  if (!screen) return key;
  if (screen.kind === 'create') return screen.title;
  return canvas?.screens.find(item => item.id === screen.screenId)?.title ?? key;
}

/**
 * Read-only overlay. Stored positions win. Otherwise new screens sit on the legacy grid
 * until the canvas measures the chrome-free viewport and calls placeDraft.
 * Existing screens stay where they are. Steps added to them are returned in `existing`
 * so the canvas can draw them on that node. New screens stay in the draft zone.
 * Steps are the generated operations, with no review marks.
 */
export function draftOverlayFor(draft: FlowDraft, canvas: CanvasGraph | undefined, positions?: DraftPositions): DraftOverlay {
  const existing = new Map((canvas?.screens ?? []).map(screen => [screen.id, screen]));
  const createOrder: string[] = [];
  for (const visit of draft.visits) {
    const screen = draft.screens.find(item => item.key === visit.screenKey);
    if (screen?.kind === 'create' && !createOrder.includes(screen.key)) createOrder.push(screen.key);
  }
  for (const screen of draft.screens) if (screen.kind === 'create' && !createOrder.includes(screen.key)) createOrder.push(screen.key);
  const spots = placeScreens((canvas?.screens ?? []).map(screen => ({x: screen.x, y: screen.y})), createOrder.length);
  const settled = createOrder.length > 0 && createOrder.every(key => {
    const point = positions?.[key];
    return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
  });
  const stepsFor = new Map<string, DraftOverlay['nodes'][number]['steps']>();
  for (const visit of draft.visits) {
    if (!visit || typeof visit.screenKey !== 'string' || !Array.isArray(visit.operations)) continue;
    const list = stepsFor.get(visit.screenKey) ?? [];
    for (const operation of visit.operations) {
      const linked = (operation.kind === 'tap' || operation.kind === 'back') && operation.destination.kind === 'visit' ? operation.destination.visitKey : undefined;
      const destination = linked ? screenTitle(draft, canvas, draft.visits.find(item => item.key === linked)?.screenKey ?? '') : undefined;
      list.push({text: draftStepText(operation, list.length, destination), specified: stepSpecified(operation)});
    }
    stepsFor.set(visit.screenKey, list);
  }
  const nodes = createOrder.map((key, index) => {
    const declared = draft.screens.find(screen => screen.key === key);
    const stored = positions?.[key];
    const spot = stored && Number.isFinite(stored.x) && Number.isFinite(stored.y) ? stored : (spots[index] ?? {x: 40 + (index % 8) * 280, y: 40 + Math.floor(index / 8) * 200});
    return {key, title: declared && declared.kind === 'create' ? declared.title : key, x: spot.x, y: spot.y, steps: stepsFor.get(key) ?? []};
  });
  const onExisting: DraftOverlay['existing'] = [];
  const anchors = draft.screens.flatMap(screen => {
    if (screen.kind !== 'existing') return [];
    const found = existing.get(screen.screenId);
    if (!found) return [];
    const steps = stepsFor.get(screen.key) ?? [];
    if (steps.length) onExisting.push({screenId: found.id, key: screen.key, steps});
    return [{key: screen.key, x: found.x, y: found.y}];
  });
  const known = new Set([...nodes.map(node => node.key), ...anchors.map(anchor => anchor.key)]);
  const edges: DraftOverlay['edges'] = [];
  for (let index = 0; index < draft.visits.length - 1; index++) {
    const fromVisit = draft.visits[index];
    const toVisit = draft.visits[index + 1];
    if (!fromVisit || !toVisit || !Array.isArray(fromVisit.operations) || !known.has(fromVisit.screenKey) || !known.has(toVisit.screenKey)) continue;
    const link = [...fromVisit.operations].reverse().find(operation => (operation.kind === 'tap' || operation.kind === 'back') && operation.destination.kind === 'visit' && operation.destination.visitKey === toVisit.key);
    const verb = !link ? screenTitle(draft, canvas, fromVisit.screenKey) : link.kind === 'back' ? 'Back' : 'Tap';
    edges.push({from: fromVisit.screenKey, to: toVisit.screenKey, label: verb + ' → ' + screenTitle(draft, canvas, toVisit.screenKey)});
  }
  return {nodes, edges, anchors, existing: onExisting, ...(settled ? {settled: true} : {})};
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
  else if (revisionStale || (current.status === 'stale' && !preview)) status = 'stale';
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

function overlayRenders(draft: FlowDraft | undefined, canvas: CanvasGraph | undefined) {
  if (!draft) return false;
  const overlay = draftOverlayFor(draft, canvas);
  return overlay.nodes.length > 0 || overlay.existing.length > 0;
}

/**
 * A review status closes the composer only when the canvas can draw the draft.
 * needsInfo with a non-applicable, non-rendering preview (INVALID_DRAFT) and
 * failed AUTHORING_INVALID / INVALID_AI_OUTPUT stay in the composer with the prompt.
 */
function presentResult(current: AiDraft, view: GenerationView, revision: number, canvas: CanvasGraph | undefined): AiDraft {
  const base = fromView(current, view, revision);
  const diagnostics = base.diagnostics?.length ? base.diagnostics : diagnosticsOn(view);
  const next = diagnostics.length ? {...base, diagnostics} : base;
  if (view.state === 'running' || view.state === 'cancelled') return next;
  if (view.state === 'failed') return {...next, status: 'failed'};
  if (next.status !== 'pending' && next.status !== 'needsInfo' && next.status !== 'stale') return next;
  if (overlayRenders(next.draft, canvas)) return next;
  const blocking = (next.diagnostics ?? []).some(item => item.blocks.includes('apply') || item.severity === 'error');
  if (!blocking && next.applicable !== false && view.state !== 'needsInfo') return next;
  return {
    ...next,
    status: 'failed',
    error: next.error ?? {code: 'AUTHORING_INVALID', message: 'The reply didn’t fit TnT’s format, even after one repair.', retryable: false},
  };
}

type Callbacks = {
  save: () => Promise<Workspace | undefined>;
  loadWorkspace: (workspace: LoadedWorkspace) => void;
  selectScenario: (id: string) => void;
  rememberView: (patch: Record<string, unknown>) => void;
  fetchWorkspace: (id: string) => Promise<LoadedWorkspace>;
  saveWorkspaceView: (id: string, view: Record<string, unknown>) => Promise<unknown>;
  readView: () => Record<string, unknown>;
};

const DISCLOSURE_KEY = 'tnt.ai.disclosure';

function disclosureToken(provider: ProviderId, baseUrl?: string) {
  return provider === 'openai-compatible' ? provider + '\n' + (baseUrl ?? '') : provider;
}

function readDisclosure() {
  try {
    const raw = sessionStorage.getItem(DISCLOSURE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return new Set<string>(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch { return new Set<string>(); }
}

function writeDisclosure(id: string) {
  const next = readDisclosure();
  next.add(id);
  try { sessionStorage.setItem(DISCLOSURE_KEY, JSON.stringify([...next])); } catch { /* The in-memory set still skips it for this page. */ }
}

export function useAiDraft(input: Callbacks & {token: string; workspaceId: string; revision: number; running: boolean; canvas: CanvasGraph | undefined; contentKey: string; loadRevision: number; onOpenSettings?: (returnTo?: HTMLElement) => void}) {
  const client = useMemo(() => createAiFlowClient(input.token), [input.token]);
  const callbacks = useRef<Callbacks>(input);
  callbacks.current = input;
  const [draft, setDraft] = useState<AiDraft>(emptyDraft);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [provenanceId, setProvenanceId] = useState('');
  const [provenanceName, setProvenanceName] = useState('');
  const [undoOffer, setUndoOffer] = useState<{receiptId: string; revision: number; workspaceId: string}>();
  const [config, setConfig] = useState<AiPublicConfig>();
  const [disclosure, setDisclosure] = useState<string | null>(null);
  const jobGuard = useRef<string | undefined>(undefined);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const revisionRef = useRef(input.revision);
  revisionRef.current = input.revision;
  const idempotency = useRef(new Map<string, string>());
  const hydrateToken = useRef(0);
  const provenanceBaseline = useRef<string | undefined>(undefined);
  const configRef = useRef(config);
  configRef.current = config;
  const canvasRef = useRef(input.canvas);
  canvasRef.current = input.canvas;
  const memory = useRef(new Map<string, AiDraft>());
  const workspaceRef = useRef(input.workspaceId);
  const pendingAnswers = useRef<{key: string; answer: string}[] | undefined>(undefined);
  /** Revision written by the current refine's own save. That bump must not mark the kept draft stale. */
  const ownSaveRevision = useRef<number | undefined>(undefined);
  const persistTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const acked = useRef(new Set<string>());
  const openSettingsRef = useRef(input.onOpenSettings);
  openSettingsRef.current = input.onOpenSettings;

  const reviewing = REVIEW.includes(draft.status) && !draft.refining;
  const showOverlay = !!draft.draft && overlayRenders(draft.draft, input.canvas) && (REVIEW.includes(draft.status) || !!draft.refining);
  const overlay = showOverlay && draft.draft ? draftOverlayFor(draft.draft, input.canvas, draft.positions) : undefined;
  const positionKey = JSON.stringify(draft.positions ?? null);

  useEffect(() => {
    let cancelled = false;
    void client.getConfig().then(next => { if (!cancelled && next?.providers?.openrouter && next.providers['openai-compatible']) { configRef.current = next; setConfig(next); } }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => subscribeAiConfig(next => { configRef.current = next; setConfig(next); }), []);

  useEffect(() => () => { for (const timer of persistTimers.current) clearTimeout(timer); }, []);

  useEffect(() => {
    if (!draft.jobId || draft.status === 'idle') return;
    if (draft.workspaceId && input.workspaceId && draft.workspaceId !== input.workspaceId) return;
    const persisted = viewDraft(draft);
    if (persisted) callbacks.current.rememberView({aiDraft: persisted});
  }, [draft.jobId, draft.prompt, draft.previewId, draft.baseRevision, draft.status, draft.workspaceId, input.workspaceId, positionKey]);

  useEffect(() => {
    if (reviewing && showOverlay) setOpen(false);
  }, [reviewing, showOverlay]);

  useEffect(() => {
    setDraft(current => {
      if (current.baseRevision === undefined) return current;
      if (input.revision === current.baseRevision) return current;
      if (ownSaveRevision.current !== undefined && input.revision === ownSaveRevision.current) return current;
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
      if (view.state === 'failed' && draftRef.current.refining && draftRef.current.draft && draftRef.current.restoreStatus && REVIEW.includes(draftRef.current.restoreStatus)) {
        setOpen(false);
        failRefine(draftRef.current.prompt, view.error ?? {code: 'REQUEST_FAILED', message: 'Couldn’t generate.', retryable: false});
        return;
      }
      setDraft(current => {
        if (current.jobId !== id) return current;
        if (current.status !== 'generating' && current.status !== 'stale') return current;
        const next = presentResult(current, view, revisionRef.current, canvasRef.current);
        if (view.state !== 'running') {
          if (next.baseRevision === revisionRef.current) ownSaveRevision.current = undefined;
          return {...next, refining: false, restoreStatus: undefined, previousJobId: undefined};
        }
        return next;
      });
    };
    void tick();
    const timer = setInterval(() => void tick(), AI_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [client, draft.jobId, draft.phase, draft.status]);

  useEffect(() => {
    const previousId = workspaceRef.current;
    const currentId = input.workspaceId;
    if (input.loadRevision === 0) { workspaceRef.current = currentId; return; }
    if (previousId && currentId && previousId !== currentId) {
      const leaving = draftRef.current;
      const inflight = leaving.status === 'generating' || (leaving.status === 'stale' && !!leaving.phase);
      const restoring = !!(leaving.refining && leaving.draft && leaving.previousJobId && leaving.restoreStatus && REVIEW.includes(leaving.restoreStatus));
      if (inflight && leaving.jobId && (!restoring || leaving.jobId !== leaving.previousJobId)) {
        jobGuard.current = undefined;
        void client.cancelGeneration(leaving.jobId);
      }
      pendingAnswers.current = undefined;
      const targetRevision = ownSaveRevision.current;
      const needsRetarget = restoring && !!leaving.draft && targetRevision !== undefined && leaving.baseRevision !== targetRevision;
      const snapshot = restoring
        ? {...leaving, status: needsRetarget ? 'stale' as const : leaving.restoreStatus!, jobId: leaving.previousJobId, refining: false, restoreStatus: undefined, previousJobId: undefined, phase: undefined, workspaceId: previousId, error: undefined, notice: undefined}
        : leaving.draft && !inflight
          ? {...leaving, workspaceId: previousId}
          : (leaving.jobId || leaving.prompt)
            ? {...leaving, status: 'prompting' as const, jobId: inflight ? undefined : leaving.jobId, phase: undefined, refining: false, restoreStatus: undefined, previousJobId: undefined, draft: inflight ? undefined : leaving.draft, workspaceId: previousId, notice: inflight ? 'Cancelled. Nothing was changed.' : leaving.notice}
            : undefined;
      if (inflight && !needsRetarget) {
        const persisted = restoring && snapshot?.jobId ? viewDraft(snapshot) : null;
        const write = () => void persistLeftWorkspace(previousId, persisted);
        write();
        persistTimers.current.push(setTimeout(write, 400));
      }
      if (snapshot && (snapshot.draft || snapshot.jobId || snapshot.prompt)) memory.current.set(previousId, snapshot);
      if (needsRetarget && snapshot && leaving.draft && leaving.previousJobId && leaving.restoreStatus && typeof targetRevision === 'number') {
        void retargetKeptDraft(snapshot, previousId, targetRevision, leaving.draft, leaving.previousJobId, leaving.restoreStatus);
      }
      ownSaveRevision.current = undefined;
      workspaceRef.current = currentId;
      const remembered = memory.current.get(currentId);
      if (remembered && (remembered.draft || remembered.jobId || remembered.prompt)) {
        jobGuard.current = remembered.jobId;
        setDraft(remembered);
        setOpen(remembered.status === 'prompting' || remembered.status === 'failed');
        return;
      }
    }
    workspaceRef.current = currentId;
    const stored = persistedAiDraft(callbacks.current.readView());
    const token = ++hydrateToken.current;
    if (!stored || !currentId) {
      jobGuard.current = undefined;
      setDraft(emptyDraft());
      setOpen(false);
      return;
    }
    let cancelled = false;
    jobGuard.current = stored.jobId;
    setDraft({status: 'generating', prompt: stored.prompt, jobId: stored.jobId, previewId: stored.previewId, baseRevision: stored.baseRevision, workspaceId: currentId, ...(stored.positions ? {positions: stored.positions} : {})});
    setOpen(true);
    void (async () => {
      try {
        const view = await client.getGeneration(stored.jobId);
        if (cancelled || hydrateToken.current !== token || jobGuard.current !== stored.jobId || view.id !== stored.jobId) return;
        const revision = revisionRef.current;
        if (!view.preview && isFlowDraft(view.draft) && view.state !== 'running' && view.state !== 'failed' && view.state !== 'cancelled') {
          await repreview(view.draft, revision, currentId, false);
          return;
        }
        setDraft(current => current.jobId === stored.jobId ? presentResult({...current, prompt: stored.prompt, workspaceId: currentId}, view, revision, canvasRef.current) : current);
      } catch (error) {
        if (cancelled || hydrateToken.current !== token || jobGuard.current !== stored.jobId) return;
        setDraft(current => current.jobId === stored.jobId ? {...current, status: 'failed', prompt: stored.prompt, error: errorOf(error, 'The draft could not be restored.')} : current);
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

  /** Re-previews a kept draft for a workspace the user has already left, so switch-back can Apply it. */
  async function retargetKeptDraft(base: AiDraft, workspaceId: string, revision: number, draft: FlowDraft, jobId: string, restoreStatus: AiDraftStatus) {
    try {
      const context = await client.createContext({workspaceId, expectedRevision: revision});
      const preview = await client.preview({workspaceId, expectedRevision: revision, contextId: context.contextId, draft});
      const ready: AiDraft = {
        ...base,
        status: preview.baseRevision === revision ? restoreStatus : 'stale',
        jobId,
        previewId: preview.previewId,
        baseRevision: preview.baseRevision,
        expiresAt: preview.expiresAt,
        applicable: preview.applicable,
        diagnostics: preview.diagnostics,
        requiredAssumptionKeys: preview.requiredAssumptionKeys,
        refining: false,
        restoreStatus: undefined,
        previousJobId: undefined,
        phase: undefined,
        workspaceId,
        error: undefined,
        notice: undefined,
      };
      memory.current.set(workspaceId, ready);
      if (workspaceRef.current === workspaceId && draftRef.current.jobId === jobId) setDraft(ready);
      const persisted = viewDraft(ready);
      if (persisted) void persistLeftWorkspace(workspaceId, persisted);
    } catch {
      const stale: AiDraft = {...base, status: 'stale', jobId, workspaceId, refining: false, restoreStatus: undefined, previousJobId: undefined, phase: undefined};
      memory.current.set(workspaceId, stale);
      if (workspaceRef.current === workspaceId && draftRef.current.jobId === jobId) setDraft(stale);
    }
  }

  async function persistLeftWorkspace(workspaceId: string, aiDraft: PersistedAiDraft | null) {
    try {
      const detail = await callbacks.current.fetchWorkspace(workspaceId);
      const view = detail.view && typeof detail.view === 'object' ? detail.view : {format: 1};
      await callbacks.current.saveWorkspaceView(workspaceId, {...view, aiDraft});
    } catch { /* The in-memory snapshot still returns on switch back. */ }
  }

  /**
   * Puts the kept draft back after a failed or cancelled refine.
   * The refine's save already moved the workspace, so the old preview is re-created at that revision
   * before Apply is enabled. Until that preview exists the draft is stale and Refresh is the way forward.
   */
  function failRefine(text: string, error?: AiDraft['error'], notice?: string) {
    const current = draftRef.current;
    if (!current.refining || !current.draft || !current.restoreStatus || !REVIEW.includes(current.restoreStatus)) return false;
    pendingAnswers.current = undefined;
    const jobId = current.previousJobId ?? current.jobId;
    const draft = current.draft;
    const restoreStatus = current.restoreStatus;
    const workspaceId = current.workspaceId || input.workspaceId;
    jobGuard.current = jobId;
    const target = ownSaveRevision.current ?? revisionRef.current;
    const mismatch = current.baseRevision !== target;
    setOpen(false);
    if (!mismatch || !workspaceId || !jobId) {
      if (ownSaveRevision.current === target) ownSaveRevision.current = undefined;
      setDraft({
        ...current,
        status: restoreStatus,
        jobId,
        prompt: text || current.prompt,
        refining: false,
        restoreStatus: undefined,
        previousJobId: undefined,
        phase: undefined,
        error,
        notice,
      });
      return true;
    }
    setDraft({
      ...current,
      status: 'stale',
      jobId,
      prompt: text || current.prompt,
      refining: false,
      restoreStatus: undefined,
      previousJobId: undefined,
      phase: undefined,
      error,
      notice,
    });
    void repreview(draft, target, workspaceId, false, {status: restoreStatus, error, notice, jobId});
    return true;
  }

  async function generate(prompt = draftRef.current.prompt) {
    const text = prompt.trim();
    if (!text || text.length > PROMPT_CHAR_LIMIT || submitting) return;
    const refining = !!draftRef.current.refining;
    const previousJobId = refining ? (draftRef.current.previousJobId ?? draftRef.current.jobId) : undefined;
    const restoreStatus = refining ? draftRef.current.restoreStatus : undefined;
    const answers = refining ? pendingAnswers.current : undefined;
    setSubmitting(true);
    setOpen(true);
    setDisclosure(null);
    setDraft(current => ({...current, status: refining ? current.status : 'prompting', prompt: text, error: undefined, notice: undefined}));
    let settings: AiPublicConfig;
    try {
      settings = await client.getConfig();
      if (!settings?.providers?.openrouter || !settings.providers['openai-compatible']) throw new AiFlowRequestError('AI settings could not be loaded.', 502, 'AI_NOT_CONFIGURED');
      configRef.current = settings;
      setConfig(settings);
    } catch (error) {
      if (!failRefine(text, errorOf(error, 'AI settings could not be loaded.'))) setDraft(current => ({...current, status: 'failed', prompt: text, error: errorOf(error, 'AI settings could not be loaded.')}));
      setSubmitting(false);
      return;
    }
    const provider = settings.selected;
    const entry = settings.providers[provider];
    const model = entry?.model?.trim() || '';
    if (!entry?.configured || !model) {
      const failure = {code: 'AI_NOT_CONFIGURED' as const, message: 'Add an API key and model in AI settings. Your text is kept here.', retryable: false};
      if (!failRefine(text, failure)) setDraft(current => ({...current, status: 'prompting', prompt: text, refining, error: failure}));
      setSubmitting(false);
      return;
    }
    const share = disclosureToken(provider, entry.baseUrl);
    if (!readDisclosure().has(share) && !acked.current.has(share)) {
      setDisclosure(share);
      setSubmitting(false);
      return;
    }
    let saved: Workspace | undefined;
    try { saved = await callbacks.current.save(); }
    catch (error) {
      const failure = {...errorOf(error, 'Save failed. The draft was not generated.'), retryable: true, code: 'SAVE_FAILED'};
      if (!failRefine(text, failure)) setDraft(current => ({...current, status: 'failed', prompt: text, error: failure}));
      setSubmitting(false);
      return;
    }
    if (!saved?.id) {
      const failure = {code: 'SAVE_FAILED', message: 'Save the workspace before generating.', retryable: true};
      if (!failRefine(text, failure)) setDraft(current => ({...current, status: 'failed', prompt: text, error: failure}));
      setSubmitting(false);
      return;
    }
    const baseRevision = saved.metadata?.revision ?? 0;
    if (refining) ownSaveRevision.current = baseRevision;
    try {
      const started = await client.startGeneration({
        workspaceId: saved.id,
        expectedRevision: baseRevision,
        expectedSettingsRevision: settings.settingsRevision,
        prompt: text,
        ...(previousJobId ? {previousJobId} : {}),
        ...(answers?.length ? {answers} : {}),
      });
      pendingAnswers.current = undefined;
      jobGuard.current = started.id;
      setDraft(current => ({
        ...current,
        status: 'generating',
        prompt: text,
        jobId: started.id,
        workspaceId: saved?.id,
        ...(refining ? {} : {baseRevision}),
        phase: started.phase,
        refining,
        ...(refining && previousJobId ? {previousJobId} : {previousJobId: undefined}),
        ...(refining && restoreStatus ? {restoreStatus} : {restoreStatus: undefined}),
        draft: refining ? current.draft : undefined,
        questions: refining ? current.questions : undefined,
        error: started.error,
        notice: undefined,
      }));
    } catch (error) {
      jobGuard.current = undefined;
      const failure = errorOf(error, 'Couldn’t generate.');
      if (!failRefine(text, failure)) setDraft(current => ({...current, status: 'failed', prompt: text, draft: current.draft, error: failure}));
    } finally { setSubmitting(false); }
  }

  function continueDisclosure() {
    if (!disclosure) return;
    writeDisclosure(disclosure);
    acked.current.add(disclosure);
    setDisclosure(null);
    void generate(draftRef.current.prompt);
  }

  function dismissDisclosure() {
    setDisclosure(null);
  }

  async function repreview(nextDraft: FlowDraft, revision: number, workspaceId: string, regenerate: boolean, restore?: {status: AiDraftStatus; error?: AiDraft['error']; notice?: string; jobId?: string}) {
    const watched = jobGuard.current;
    try {
      const context = await client.createContext({workspaceId, expectedRevision: revision});
      const preview = await client.preview({workspaceId, expectedRevision: revision, contextId: context.contextId, draft: nextDraft});
      if (jobGuard.current !== watched) return;
      if (!restore && regenerate && needsRegeneration(undefined, preview.diagnostics)) {
        await generate(draftRef.current.prompt);
        return;
      }
      const matched = preview.baseRevision === revision;
      if (matched && ownSaveRevision.current === revision) ownSaveRevision.current = undefined;
      setDraft(current => {
        if (watched && current.jobId !== watched && current.jobId !== restore?.jobId) return current;
        const status: AiDraftStatus = !matched ? 'stale' : restore?.status ?? (preview.applicable ? 'pending' : 'needsInfo');
        return {
          ...current,
          draft: nextDraft,
          status,
          ...(restore?.jobId ? {jobId: restore.jobId} : {}),
          previewId: preview.previewId,
          baseRevision: preview.baseRevision,
          expiresAt: preview.expiresAt,
          applicable: preview.applicable,
          diagnostics: preview.diagnostics,
          requiredAssumptionKeys: preview.requiredAssumptionKeys,
          phase: undefined,
          refining: false,
          restoreStatus: undefined,
          previousJobId: undefined,
          error: restore ? restore.error : undefined,
          notice: restore ? restore.notice : current.notice,
        };
      });
      if (restore) setOpen(false);
    } catch (error) {
      if (jobGuard.current !== watched) return;
      if (!restore && regenerate && error instanceof AiFlowRequestError && needsRegeneration(error.code, error.diagnostics)) {
        await generate(draftRef.current.prompt);
        return;
      }
      if (restore) {
        setDraft(current => {
          if (watched && current.jobId !== watched && current.jobId !== restore.jobId) return current;
          return {
            ...current,
            status: 'stale',
            ...(restore.jobId ? {jobId: restore.jobId} : {}),
            refining: false,
            restoreStatus: undefined,
            previousJobId: undefined,
            phase: undefined,
            error: restore.error ?? errorOf(error, 'The draft could not be previewed.'),
            notice: restore.notice,
          };
        });
        setOpen(false);
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

  /** Refines the draft that is already on the canvas. There is no second copy. */
  function beginRefine(text: string, answers?: {key: string; answer: string}[]) {
    const current = draftRef.current;
    const workspaceId = current.workspaceId || input.workspaceId;
    if (!current.draft || !current.jobId || !workspaceId || !REVIEW.includes(current.status)) return;
    pendingAnswers.current = answers?.length ? answers : undefined;
    const next: AiDraft = {
      ...current,
      refining: true,
      restoreStatus: current.status,
      previousJobId: current.jobId,
      prompt: text,
      error: undefined,
      notice: undefined,
      workspaceId,
    };
    draftRef.current = next;
    setDraft(next);
    void generate(text);
  }

  function ask(prompt: string) {
    const text = prompt.trim();
    if (!text || text.length > PROMPT_CHAR_LIMIT) return;
    beginRefine(text);
  }

  /** One question per request. The caller picks the question; a typed reply uses the first. */
  function answer(key: string, value: string) {
    const text = value.trim();
    if (!text || text.length > ANSWER_CHAR_LIMIT) return;
    if (!draftRef.current.questions?.some(item => item.key === key)) return;
    beginRefine(text, [{key, answer: text}]);
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
        acknowledgedAssumptionKeys: current.requiredAssumptionKeys ?? [],
      });
    } catch (error) {
      setDraft(existing => ({...existing, status: current.status === 'needsInfo' || current.applicable === false ? 'needsInfo' : 'pending', error: errorOf(error, 'The draft could not be confirmed.')}));
      return;
    }
    try {
      const detail = await callbacks.current.fetchWorkspace(applied.workspaceId);
      if (detail.view && typeof detail.view === 'object') detail.view = {...detail.view, aiDraft: null};
      jobGuard.current = undefined;
      memory.current.delete(applied.workspaceId);
      callbacks.current.loadWorkspace(detail);
      callbacks.current.selectScenario(applied.scenarioId);
      clearPersisted();
      setProvenanceName(current.draft?.name || 'this flow');
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
    const current = draftRef.current;
    const id = jobGuard.current ?? current.jobId;
    const prompt = current.prompt;
    const inflight = current.status === 'generating' || (current.status === 'stale' && !!current.phase);
    if (current.refining && current.draft && current.previousJobId && current.restoreStatus && REVIEW.includes(current.restoreStatus)) {
      const refineId = inflight && id && id !== current.previousJobId ? id : undefined;
      failRefine(prompt, undefined, 'Cancelled. Nothing was changed.');
      if (refineId) {
        try { await client.cancelGeneration(refineId); }
        catch { /* The draft is already back. A late result is ignored. */ }
      }
      return;
    }
    jobGuard.current = undefined;
    pendingAnswers.current = undefined;
    clearPersisted();
    setDraft({...emptyDraft(prompt), status: 'prompting', notice: 'Cancelled. Nothing was changed.'});
    setOpen(true);
    if (id && inflight) {
      try { await client.cancelGeneration(id); }
      catch { /* The panel is already back to the prompt. A late job result is ignored. */ }
    }
  }

  async function discard() {
    const current = draftRef.current;
    const id = jobGuard.current ?? current.jobId;
    const stillRunning = current.status === 'generating' || (current.status === 'stale' && !!current.phase);
    jobGuard.current = undefined;
    pendingAnswers.current = undefined;
    memory.current.delete(input.workspaceId);
    clearPersisted();
    setDraft(emptyDraft());
    setOpen(false);
    if (id && stillRunning) {
      try { await client.cancelGeneration(id); }
      catch { /* There is no delete route. Cancelling is best-effort; the preview expires on its own. */ }
    }
  }

  function refine() {
    const current = draftRef.current;
    const workspaceId = current.workspaceId || input.workspaceId;
    if (!current.draft || !current.jobId || !workspaceId) return;
    pendingAnswers.current = undefined;
    const next: AiDraft = {...current, refining: true, previousJobId: current.jobId, restoreStatus: current.status, prompt: '', error: undefined, notice: undefined, workspaceId};
    draftRef.current = next;
    setDraft(next);
    setOpen(true);
  }

  function openPanel() {
    setOpen(true);
    setDraft(current => current.status === 'idle' ? {...current, status: 'prompting'} : current);
  }

  function closePanel() {
    setOpen(false);
    setDisclosure(null);
    setDraft(current => current.status === 'prompting' && !current.refining ? {...current, status: 'idle'} : current);
  }

  function placeDraft(positions: DraftPositions) {
    setDraft(current => {
      const previous = current.positions ?? {};
      const keys = Object.keys(positions);
      if (keys.length && keys.every(key => previous[key]?.x === positions[key].x && previous[key]?.y === positions[key].y) && Object.keys(previous).length === keys.length) return current;
      return {...current, positions: {...positions}};
    });
  }

  function moveDraft(key: string, x: number, y: number) {
    setDraft(current => {
      const previous = current.positions?.[key];
      if (previous && previous.x === x && previous.y === y) return current;
      return {...current, positions: {...(current.positions ?? {}), [key]: {x, y}}};
    });
  }

  const reason = confirmReason(draft, input.running);
  const provider = config?.selected ?? 'openrouter';
  return {
    draft, open, submitting, overlay, provenanceId, provenanceName, undoOffer, reason, token: input.token,
    config, provider,
    disclosure, continueDisclosure, dismissDisclosure,
    setPrompt: (prompt: string) => setDraft(current => ({...current, prompt})),
    openPanel, closePanel, generate, refresh, ask, answer, confirm, undoApply, cancel, discard, refine,
    placeDraft, moveDraft,
    openSettings: (returnTo?: HTMLElement) => openSettingsRef.current?.(returnTo),
  };
}

export function confirmReason(draft: AiDraft, running: boolean) {
  if (!REVIEW.includes(draft.status) && draft.status !== 'failed') return undefined;
  if (draft.status === 'applying') return 'Apply is unavailable while the draft is being added.';
  if (running) return 'Apply is unavailable while a run is active.';
  if (draft.status === 'stale') return 'Apply is unavailable because the workspace changed. Refresh the draft.';
  if (draft.status === 'failed' || !draft.previewId) return 'Apply is unavailable until a draft is ready.';
  return undefined;
}

export type AiDraftControl = ReturnType<typeof useAiDraft>;

export function AiFlow({control}: {control: AiDraftControl}) {
  const {draft, open, submitting, provenanceId, provenanceName, undoOffer} = control;
  const generating = draft.status === 'generating' || submitting;
  const failed = draft.status === 'failed';
  const refining = !!draft.refining;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  const [live, setLive] = useState('');
  const count = draft.prompt.length;
  const over = count > PROMPT_CHAR_LIMIT;
  const entry = control.config?.providers?.[control.provider];
  const savedModel = entry?.model ?? '';
  const configured = !control.config || (!!entry?.configured && !!savedModel.trim());
  const busy = generating || draft.status === 'applying';
  const kind = retryKind(draft.error?.code);
  const neutral = draft.error?.code === 'CANCELLED' || draft.error?.code === 'INTERRUPTED' || (!draft.error && !!draft.notice);

  useEffect(() => {
    if (!open || generating || control.disclosure) return;
    fieldRef.current?.focus();
  }, [open, generating, control.disclosure, draft.status]);

  useEffect(() => {
    if (!generating) return;
    const label = refining ? 'Refining…' : (submitting && draft.status !== 'generating' ? 'Saving…' : PHASE_LABEL[draft.phase ?? 'model']);
    setLive(label);
  }, [generating, refining, submitting, draft.status, draft.phase]);

  useEffect(() => {
    if (draft.error && !neutral) setLive(errorCopy(draft.error.code, draft.error.message, draft.model));
  }, [draft.error, draft.model, neutral]);

  function onPanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    if (generating) { event.preventDefault(); event.stopPropagation(); void control.cancel(); return; }
    if (refining) { event.preventDefault(); event.stopPropagation(); void control.cancel(); return; }
    event.preventDefault();
    event.stopPropagation();
    control.closePanel();
    buttonRef.current?.focus();
  }

  function onFieldKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || control.disclosure) return;
    event.preventDefault();
    if (draft.prompt.trim() && !busy && !over && configured) void control.generate();
  }

  const copy = draft.error ? errorCopy(draft.error.code, draft.error.message, control.config?.providers?.[control.provider]?.model || draft.model) : draft.notice;
  const composerIssues = (draft.diagnostics ?? []).filter(item => item.blocks.includes('apply') || item.severity === 'error');
  return <div className="ai-flow" data-testid="ai-flow" data-ai-status={draft.status}>
    <p className="sr-only" aria-live="polite" data-testid="ai-live">{live}</p>
    {draft.status === 'stale' && <p className="ai-muted">The workspace changed since this draft was prepared. <button type="button" className="ai-text" data-testid="ai-refresh" onClick={() => void control.refresh()}>Refresh</button></p>}
    {provenanceId && <p className="ai-provenance" data-testid="ai-provenance">Applied as “{provenanceName || 'this flow'}” · not run yet{undoOffer && <> · <button type="button" data-testid="ai-undo" onClick={() => void control.undoApply()}>↶ Undo</button></>}</p>}
    {open && <section className={'ai-panel' + (failed && !neutral ? ' is-error' : '') + (generating ? ' is-busy' : '') + (over ? ' is-over' : '')} aria-label={refining ? 'Refine draft' : 'Describe a flow'} aria-busy={busy || undefined} onKeyDown={onPanelKeyDown}>
      <div className="ai-panel-bar">
        <h3 className="ai-draft-heading">{refining ? 'Refine draft' : 'Describe a flow'}</h3>
        <button type="button" className="ai-text" aria-label="Close" onClick={() => { if (!generating) { control.closePanel(); buttonRef.current?.focus(); } }}>✕</button>
      </div>
      {control.disclosure ? <><p className="ai-prompt-preview">{draft.prompt}</p><Disclosure control={control} /></> : <>
        <textarea ref={fieldRef} className="ai-prompt-field" aria-label="Flow description" placeholder="Describe the flow" value={draft.prompt} readOnly={generating} aria-invalid={over || (failed && !neutral) || undefined} aria-describedby={copy ? errorId : undefined} onChange={event => control.setPrompt(event.target.value)} onKeyDown={onFieldKeyDown} />
        <p className="ai-hint">Enter generates · Shift+Enter new line · Esc closes</p>
        {count >= PROMPT_COUNTER_AT && <p className={over ? 'ai-error' : 'ai-muted'} data-testid="ai-char-count">{over ? (count - PROMPT_CHAR_LIMIT) + ' characters over the limit. Shorten the text to generate. Nothing is trimmed for you.' : count.toLocaleString('en-US') + ' / ' + PROMPT_CHAR_LIMIT.toLocaleString('en-US')}</p>}
        {generating && <div className="ai-progress" role="progressbar" aria-valuetext={refining ? 'Refining…' : PHASE_LABEL[draft.phase ?? 'model']} aria-label={refining ? 'Refining draft' : 'Generating flow'} />}
        {generating && <p className="ai-status" aria-live="polite"><span className="ai-spinner" aria-hidden="true" /> {refining ? 'Refining…' : 'Generating flow…'} <span className="ai-muted" data-testid="ai-progress-model">{providerLabel(control.provider, savedModel || draft.model)}</span></p>}
        {!configured && <p className="ai-error" role="alert" data-testid="ai-error">✕ AI isn’t set up <span className="ai-muted">Add an API key and model in AI settings. Your text is kept here.</span></p>}
        {copy && <p id={errorId} className={neutral ? 'ai-muted' : 'ai-error'} role={neutral ? 'status' : 'alert'} data-testid={draft.error && !neutral ? 'ai-error' : 'ai-notice'}>{neutral ? '' : '✕ '}{copy}</p>}
        {failed && !!composerIssues.length && <ol className="ai-issues" data-testid="ai-composer-issues">{composerIssues.map((item, index) => <li key={item.path + item.code + index}><span className="ai-issue-no">{index + 1}</span> {item.message}</li>)}</ol>}
        {draft.error?.code === 'CREDITS_REQUIRED' && <p><a href="https://openrouter.ai/settings/credits" target="_blank" rel="noreferrer">Open OpenRouter account</a></p>}
        {draft.error?.code === 'AUTH_FAILED' && <p><a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">Open OpenRouter keys</a></p>}
        <SavedModelLine control={control} />
        <div className="ai-actions">
          {generating ? <button type="button" className="ai-text" data-testid="ai-cancel" onClick={() => void control.cancel()}>Cancel</button>
            : kind === 'retry' || kind === 'network' ? <button type="button" className="ai-text" data-testid="ai-retry" onClick={() => void control.generate()}>{kind === 'network' ? 'Retry · may send another request' : 'Retry'}</button>
            : kind === 'settings' || !configured ? <button type="button" className="ai-text" data-testid="ai-open-settings" onClick={event => control.openSettings(event.currentTarget)}>Open AI settings</button>
            : kind === 'refine' ? <button type="button" className="ai-text" data-testid="ai-refine" onClick={() => control.refine()}>Refine</button>
            : kind === 'refresh' ? <button type="button" className="ai-text" data-testid="ai-retry" onClick={() => void control.generate()}>Refresh and generate again</button>
            : <button type="button" className="ai-text" data-testid="ai-generate" disabled={!draft.prompt.trim() || busy || over || !configured} onClick={() => void control.generate()}>✦ Generate</button>}
        </div>
      </>}
    </section>}
    {REVIEW.includes(draft.status) && !refining && draft.draft ? <AiCapsule control={control} /> : <button type="button" ref={buttonRef} className={'ai-launch' + (open ? ' is-open' : '')} data-testid="ai-flow-button" aria-label="Describe a flow" title="Describe a flow" aria-expanded={open} aria-busy={busy || undefined} onClick={() => open ? (generating ? undefined : control.closePanel()) : control.openPanel()}>
      <Sparkles />
    </button>}
  </div>;
}

function AiCapsule({control}: {control: AiDraftControl}) {
  const {draft, reason} = control;
  const [text, setText] = useState('');
  const applyRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const focused = useRef('');
  const questions = (draft.questions ?? []).slice(0, 5);
  useEffect(() => {
    if (!draft.previewId || focused.current === draft.previewId) return;
    focused.current = draft.previewId;
    applyRef.current?.focus();
  }, [draft.previewId]);
  function submit() {
    const next = text.trim();
    if (!next) return;
    setText('');
    const question = questions[0];
    if (question && next.length <= ANSWER_CHAR_LIMIT) control.answer(question.key, next);
    else control.ask(next);
  }
  return <div className="ai-capsule-wrap">
    <form className={'ai-capsule' + (questions.length ? ' has-questions' : '')} data-testid="ai-capsule" onSubmit={event => { event.preventDefault(); submit(); }}>
      {!!questions.length && <div className="ai-questions" data-testid="ai-questions">
        {questions.map(question => <div key={question.key} className="ai-question" data-testid="ai-question" data-question-key={question.key}>
          <p className="ai-question-text">{question.text}</p>
          <div className="ai-question-options">
            {question.options.slice(0, 3).map((option, index) => <button type="button" key={question.key + ':' + index} className="ai-question-option" data-testid="ai-question-option" data-question-key={question.key} onClick={() => control.answer(question.key, option)}>{option}</button>)}
          </div>
        </div>)}
      </div>}
      <div className="ai-capsule-row">
        <Sparkles />
        <input className="ai-capsule-input" aria-label="Ask for changes" placeholder="Ask for changes" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key !== 'Enter') return; event.preventDefault(); submit(); }} />
        <button type="button" ref={applyRef} className="ai-capsule-apply" data-testid="ai-confirm" aria-disabled={reason ? true : undefined} aria-describedby={reason ? reasonId : undefined} onClick={() => { if (!reason) void control.confirm(); }}>✓ Apply</button>
        <button type="button" className="ai-capsule-dismiss" data-testid="ai-discard" aria-label="Dismiss draft" onClick={() => void control.discard()}>✕</button>
      </div>
    </form>
    {reason && <p id={reasonId} className="ai-reason" data-testid="ai-confirm-reason">{reason}</p>}
    {draft.error && <p className="ai-error" role="alert" data-testid="ai-capsule-error">{errorCopy(draft.error.code, draft.error.message, draft.model)}</p>}
  </div>;
}

function Disclosure({control}: {control: AiDraftControl}) {
  const name = control.provider === 'openrouter' ? 'OpenRouter' : 'the model provider';
  return <div className="ai-disclosure" data-testid="ai-disclosure">
    <p>Before your first generation</p>
    <div className="ai-disclosure-cols">
      <div><p>Sent to {name} and the model’s provider</p><ul><li>Your scenario text</li><li>Screen names, selectors and their metadata</li><li>TnT’s authoring schema</li><li>Script source you include</li></ul></div>
      <div><p>Not sent</p><ul><li>Screenshots or recordings</li><li>Runtime input values (names only)</li><li>Saved keys or other credentials</li><li>Other workspace files</li></ul></div>
    </div>
    <div className="ai-actions">
      <button type="button" className="ai-text" data-testid="ai-disclosure-not-now" onClick={() => control.dismissDisclosure()}>Not now</button>
      <button type="button" className="ai-text ai-confirm" data-testid="ai-disclosure-continue" onClick={() => control.continueDisclosure()}>Continue</button>
    </div>
  </div>;
}

function SavedModelLine({control}: {control: AiDraftControl}) {
  const model = control.config?.providers?.[control.provider]?.model;
  return <div className="ai-chip-wrap">
    <button type="button" className="ai-text" data-testid="ai-provider-chip" onClick={event => control.openSettings(event.currentTarget)}>{providerLabel(control.provider, model)}</button>
  </div>;
}

function providerLabel(id: ProviderId, model?: string) {
  const name = id === 'openrouter' ? 'OpenRouter' : 'OpenAI-compatible';
  return model ? name + ' · ' + model : name;
}

function retryKind(code: string | undefined) {
  if (code === 'SAVE_FAILED' || code === 'RATE_LIMITED' || code === 'PROVIDER_UNAVAILABLE') return 'retry' as const;
  if (code === 'NETWORK_ERROR' || code === 'TIMEOUT') return 'network' as const;
  if (code === 'AI_NOT_CONFIGURED' || code === 'AUTH_FAILED' || code === 'MODEL_UNAVAILABLE') return 'settings' as const;
  if (code === 'CREDITS_REQUIRED') return 'account' as const;
  if (code === 'INVALID_AI_OUTPUT' || code === 'AUTHORING_INVALID') return 'refine' as const;
  if (code === 'SETTINGS_CHANGED' || code === 'WORKSPACE_STALE') return 'refresh' as const;
  return 'none' as const;
}

function errorCopy(code: string | undefined, message: string, model?: string) {
  switch (code) {
    case 'AI_NOT_CONFIGURED': return 'Not set up. Add an API key in AI settings to generate. Your text is kept here.';
    case 'AUTH_FAILED': return /expired|revoked/i.test(message) ? 'Key rejected — it may be expired or revoked. Create a new key in your OpenRouter account, then replace it in AI settings.' : 'Key rejected. The provider didn’t accept the saved key. Check or replace it in AI settings; nothing was removed.';
    case 'CREDITS_REQUIRED': return 'Out of credits. The provider account needs credits for this model. Your text and draft are kept.';
    case 'MODEL_UNAVAILABLE': return 'Model unavailable. “' + (model || 'This model') + '” isn’t available. TnT won’t switch models for you.';
    case 'UNSUPPORTED_REQUEST': return 'The provider rejected the request. Shorten the input or pick a model.';
    case 'RATE_LIMITED': return 'Provider busy. Still unavailable after the automatic retry. Try again in a minute.';
    case 'PROVIDER_UNAVAILABLE': return 'Provider busy. Still unavailable after the automatic retry. Trying again may send another request.';
    case 'NETWORK_ERROR':
    case 'TIMEOUT': return 'No response. The connection dropped or 120 s passed. The request may still have been processed.';
    case 'INVALID_AI_OUTPUT':
    case 'AUTHORING_INVALID': return 'Couldn’t build a flow. The reply didn’t fit TnT’s format, even after one repair.';
    case 'SETTINGS_CHANGED': return 'AI settings changed. Settings changed after you started. Nothing was sent with the old settings.';
    case 'WORKSPACE_STALE': return 'Workspace changed. Screens changed since this request started, so the preview is out of date.';
    case 'CANCELLED': return 'Cancelled. Nothing was changed. Your previous draft is still on the canvas.';
    case 'INTERRUPTED': return 'Generation stopped because the workbench restarted. Your text is kept.';
    case 'CREDENTIAL_STORAGE_FAILED': return 'Secure storage isn’t available. Your typed key is kept.';
    case 'SAVE_FAILED': return message;
    default: return message;
  }
}

function Sparkles() {
  return <svg className="ai-spark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.2l1.15 4.05L17.2 8.4l-4.05 1.15L12 13.6l-1.15-4.05L6.8 8.4l4.05-1.15L12 3.2z"/><path d="M18 14.2l.55 1.85L20.4 16.6l-1.85.55L18 19l-.55-1.85L15.6 16.6l1.85-.55L18 14.2z"/></svg>;
}
