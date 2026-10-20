import {useEffect, useId, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import type {CanvasGraph} from '../server/canvas.js';
import type {Diagnostic, DraftTarget, DraftValue, FlowDraft} from '../server/authoring/types.js';
import type {Workspace} from '../server/scenarios.js';
import type {DraftOverlay} from './canvas.js';
import {AI_POLL_MS, AiFlowRequestError, createAiFlowClient, PROMPT_CHAR_LIMIT, PROMPT_COUNTER_AT, type AiPublicConfig, type ApplyResponse, type GenerationPhase, type GenerationView, type ProviderId} from './ai-flow-client.js';
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
  acknowledged: string[];
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
  /** Provider and model sent with the in-flight or latest request. */
  requestProvider?: ProviderId;
  requestModel?: string;
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

function issueMarks(draft: FlowDraft, diagnostics: Diagnostic[] | undefined) {
  const marks = new Map<string, number[]>();
  let number = 0;
  for (const item of diagnostics ?? []) {
    if (!item.blocks.includes('apply') && item.severity !== 'error') continue;
    number += 1;
    const visit = /^\/visits\/(\d+)\//.exec(item.path);
    const key = visit ? draft.visits[Number(visit[1])]?.screenKey : undefined;
    if (!key) continue;
    const list = marks.get(key) ?? [];
    list.push(number);
    marks.set(key, list);
  }
  return marks;
}

/** Read-only overlay. New screens sit in free space. Existing screen coordinates are only used as edge anchors. */
export function draftOverlayFor(draft: FlowDraft, canvas: CanvasGraph | undefined, diagnostics?: Diagnostic[], dimmed = false): DraftOverlay {
  const marks = issueMarks(draft, diagnostics);
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
    return {key, title: declared && declared.kind === 'create' ? declared.title : key, x: spot.x, y: spot.y, ...(marks.get(key)?.length ? {marks: marks.get(key)} : {})};
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
  return {nodes, edges, anchors, ...(dimmed ? {dimmed: true} : {})};
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
    ...(view.inputTokens !== undefined ? {inputTokens: view.inputTokens} : {}),
    ...(view.outputTokens !== undefined ? {outputTokens: view.outputTokens} : {}),
    ...(view.cost !== undefined ? {cost: view.cost} : {}),
    ...(view.model ? {model: view.model} : {}),
    ...(view.upstreamProvider ? {upstreamProvider: view.upstreamProvider} : {}),
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

export function useAiDraft(input: Callbacks & {token: string; workspaceId: string; revision: number; running: boolean; canvas: CanvasGraph | undefined; contentKey: string; loadRevision: number; onOpenSettings?: () => void}) {
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
  const [chip, setChip] = useState<ProviderId>();
  const [requestModels, setRequestModels] = useState<Partial<Record<ProviderId, string>>>({});
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
  const chipRef = useRef(chip);
  chipRef.current = chip;
  const requestModelsRef = useRef(requestModels);
  requestModelsRef.current = requestModels;
  const memory = useRef(new Map<string, AiDraft>());
  const workspaceRef = useRef(input.workspaceId);
  const held = useRef(new Map<string, AiDraft>());
  const persistTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const acked = useRef(new Set<string>());
  const openSettingsRef = useRef(input.onOpenSettings);
  openSettingsRef.current = input.onOpenSettings;

  const reviewing = REVIEW.includes(draft.status) && !draft.refining;
  const showOverlay = !!draft.draft && (reviewing || !!draft.refining);
  const overlay = showOverlay && draft.draft ? draftOverlayFor(draft.draft, input.canvas, draft.diagnostics, !!draft.refining) : undefined;

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
    callbacks.current.rememberView({aiDraft: {
      jobId: draft.jobId,
      prompt: draft.prompt,
      ...(draft.previewId ? {previewId: draft.previewId} : {}),
      ...(draft.baseRevision !== undefined ? {baseRevision: draft.baseRevision} : {}),
    }});
  }, [draft.jobId, draft.prompt, draft.previewId, draft.baseRevision, draft.status, draft.workspaceId, input.workspaceId]);

  useEffect(() => {
    if (reviewing) setOpen(false);
  }, [reviewing]);

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
        const next = fromView(current, view, revisionRef.current);
        if (view.state !== 'running') {
          if (current.workspaceId) held.current.delete(current.workspaceId);
          return {...next, refining: false};
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
      const review = held.current.get(previousId);
      if (inflight && leaving.jobId) {
        jobGuard.current = undefined;
        void client.cancelGeneration(leaving.jobId);
      }
      const snapshot = review?.draft
        ? {...review, refining: false, phase: undefined, workspaceId: previousId}
        : leaving.draft && !inflight
          ? {...leaving, workspaceId: previousId}
          : (leaving.jobId || leaving.prompt)
            ? {...leaving, status: 'prompting' as const, jobId: inflight ? undefined : leaving.jobId, phase: undefined, refining: false, draft: inflight ? undefined : leaving.draft, workspaceId: previousId, notice: inflight ? 'Cancelled. Nothing was changed.' : leaving.notice}
            : undefined;
      if (review?.draft) held.current.delete(previousId);
      if (inflight) {
        const persisted = review?.draft && review.jobId
          ? {jobId: review.jobId, prompt: review.prompt, ...(review.previewId ? {previewId: review.previewId} : {}), ...(review.baseRevision !== undefined ? {baseRevision: review.baseRevision} : {})}
          : null;
        const write = () => void persistLeftWorkspace(previousId, persisted);
        write();
        persistTimers.current.push(setTimeout(write, 400));
      }
      if (snapshot && (snapshot.draft || snapshot.jobId || snapshot.prompt)) memory.current.set(previousId, snapshot);
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
    setDraft({status: 'generating', prompt: stored.prompt, jobId: stored.jobId, previewId: stored.previewId, baseRevision: stored.baseRevision, acknowledged: [], workspaceId: currentId});
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
        setDraft(current => current.jobId === stored.jobId ? fromView({...current, prompt: stored.prompt, acknowledged: [], workspaceId: currentId}, view, revision) : current);
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

  async function persistLeftWorkspace(workspaceId: string, aiDraft: {jobId: string; prompt: string; previewId?: string; baseRevision?: number} | null) {
    try {
      const detail = await callbacks.current.fetchWorkspace(workspaceId);
      const view = detail.view && typeof detail.view === 'object' ? detail.view : {format: 1};
      await callbacks.current.saveWorkspaceView(workspaceId, {...view, aiDraft});
    } catch { /* The in-memory snapshot still returns on switch back. */ }
  }

  function heldFor(workspaceId: string | undefined) {
    if (!workspaceId) return;
    const previous = held.current.get(workspaceId);
    if (!previous || (previous.workspaceId && previous.workspaceId !== workspaceId)) return;
    return previous;
  }

  function restoreHeld(text: string, error?: AiDraft['error'], notice?: string) {
    const workspaceId = draftRef.current.workspaceId || input.workspaceId;
    const previous = heldFor(workspaceId);
    if (!previous || previous.workspaceId !== input.workspaceId) return false;
    held.current.delete(workspaceId);
    jobGuard.current = previous.jobId;
    setDraft({...previous, prompt: text || previous.prompt, refining: false, error, notice});
    setOpen(!!error);
    return true;
  }

  async function generate(prompt = draftRef.current.prompt) {
    const text = prompt.trim();
    if (!text || text.length > PROMPT_CHAR_LIMIT || submitting) return;
    const refining = !!draftRef.current.refining;
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
      if (!restoreHeld(text, errorOf(error, 'AI settings could not be loaded.'))) setDraft(current => ({...current, status: 'failed', prompt: text, error: errorOf(error, 'AI settings could not be loaded.')}));
      setSubmitting(false);
      return;
    }
    const provider = chipRef.current ?? settings.selected;
    const entry = settings.providers[provider];
    const typed = requestModelsRef.current[provider];
    const model = (typeof typed === 'string' ? typed.trim() : '') || entry?.model || '';
    if (!entry?.configured || !model) {
      setDraft(current => ({...current, status: 'prompting', prompt: text, refining, error: {code: 'AI_NOT_CONFIGURED', message: 'Add an API key and model in AI settings. Your text is kept here.', retryable: false}}));
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
      if (!restoreHeld(text, failure)) setDraft(current => ({...current, status: 'failed', prompt: text, error: failure}));
      setSubmitting(false);
      return;
    }
    if (!saved?.id) {
      const failure = {code: 'SAVE_FAILED', message: 'Save the workspace before generating.', retryable: true};
      if (!restoreHeld(text, failure)) setDraft(current => ({...current, status: 'failed', prompt: text, error: failure}));
      setSubmitting(false);
      return;
    }
    const baseRevision = saved.metadata?.revision ?? 0;
    const previousJobId = refining ? heldFor(saved.id)?.jobId : undefined;
    try {
      const started = await client.startGeneration({
        workspaceId: saved.id,
        expectedRevision: baseRevision,
        expectedSettingsRevision: settings.settingsRevision,
        prompt: text,
        provider,
        model,
        ...(previousJobId ? {previousJobId} : {}),
      });
      jobGuard.current = started.id;
      setDraft(current => ({
        ...current,
        status: 'generating',
        prompt: text,
        jobId: started.id,
        workspaceId: saved?.id,
        baseRevision,
        phase: started.phase,
        acknowledged: refining ? current.acknowledged : [],
        refining,
        draft: refining ? current.draft : undefined,
        requestProvider: provider,
        requestModel: model,
        error: started.error,
        notice: undefined,
      }));
    } catch (error) {
      jobGuard.current = undefined;
      const failure = errorOf(error, 'Couldn’t generate.');
      if (!restoreHeld(text, failure)) setDraft(current => ({...current, status: 'failed', prompt: text, draft: current.draft, error: failure}));
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
    if (current.refining && heldFor(current.workspaceId || input.workspaceId)) {
      const kept = heldFor(current.workspaceId || input.workspaceId);
      const refineId = inflight && id && kept && id !== kept.jobId ? id : undefined;
      restoreHeld(prompt, undefined, 'Cancelled. Nothing was changed. Your previous draft is still on the canvas.');
      if (refineId) {
        try { await client.cancelGeneration(refineId); }
        catch { /* The previous draft is already back. A late result is ignored. */ }
      }
      return;
    }
    jobGuard.current = undefined;
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
    memory.current.delete(input.workspaceId);
    if (input.workspaceId) held.current.delete(input.workspaceId);
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
    held.current.set(workspaceId, {...current, workspaceId, refining: false});
    setDraft({...current, refining: true, prompt: '', error: undefined, notice: undefined});
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

  const reason = confirmReason(draft, input.running);
  const provider = chip ?? config?.selected ?? 'openrouter';
  const requestModel = requestModels[provider] ?? config?.providers?.[provider]?.model ?? '';
  return {
    draft, open, submitting, overlay, provenanceId, provenanceName, undoOffer, reason, token: input.token,
    config, provider, requestModel, setProvider: setChip,
    setRequestModel: (value: string) => setRequestModels(current => {
      const next = {...current, [provider]: value};
      requestModelsRef.current = next;
      return next;
    }),
    disclosure, continueDisclosure, dismissDisclosure,
    setPrompt: (prompt: string) => setDraft(current => ({...current, prompt})),
    openPanel, closePanel, generate, refresh, updateUnresolved, acknowledge, confirm, undoApply, cancel, discard, refine,
    openSettings: () => openSettingsRef.current?.(),
  };
}

export function confirmReason(draft: AiDraft, running: boolean) {
  if (!REVIEW.includes(draft.status) && draft.status !== 'failed') return undefined;
  if (draft.status === 'applying') return 'Confirm is unavailable while the draft is being added.';
  if (running) return 'Confirm is unavailable while a run is active.';
  if (draft.status === 'stale') return 'Confirm is unavailable because the workspace changed. Refresh the draft.';
  const missing = (draft.requiredAssumptionKeys ?? []).filter(key => !draft.acknowledged.includes(key));
  const unresolved = (draft.diagnostics ?? []).some(item => item.code === 'UNRESOLVED_TARGET' || item.code === 'UNRESOLVED_VALUE');
  const blocking = (draft.diagnostics ?? []).some(item => item.blocks.includes('apply'));
  const blocked = draft.applicable === false || unresolved || blocking;
  if (blocked && missing.length) return 'Confirm is unavailable until every item that needs info is filled and every assumption is acknowledged.';
  if (blocked) return 'Confirm is unavailable until every item that needs info is filled.';
  if (missing.length) return 'Confirm is unavailable until every assumption is acknowledged.';
  if (draft.status === 'failed' || !draft.previewId) return 'Confirm is unavailable until a draft is ready.';
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
  const sentProvider = draft.requestProvider ?? control.provider;
  const sentModel = draft.requestModel || control.requestModel || entry?.model;
  const configured = !control.config || (!!entry?.configured && !!(control.requestModel.trim() || entry?.model));
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
  return <div className="ai-flow" data-testid="ai-flow" data-ai-status={draft.status}>
    <p className="sr-only" aria-live="polite" data-testid="ai-live">{live}</p>
    {draft.status === 'stale' && <p className="ai-muted">The workspace changed since this draft was prepared.</p>}
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
        {generating && <p className="ai-status" aria-live="polite"><span className="ai-spinner" aria-hidden="true" /> {refining ? 'Refining…' : 'Generating flow…'} <span className="ai-muted" data-testid="ai-progress-model">{providerLabel(sentProvider, sentModel)}</span></p>}
        {!configured && <p className="ai-error" role="alert" data-testid="ai-error">✕ AI isn’t set up <span className="ai-muted">Add an API key and model in AI settings. Your text is kept here.</span></p>}
        {copy && <p id={errorId} className={neutral ? 'ai-muted' : 'ai-error'} role={neutral ? 'status' : 'alert'} data-testid={draft.error && !neutral ? 'ai-error' : 'ai-notice'}>{neutral ? '' : '✕ '}{copy}</p>}
        {draft.error?.code === 'CREDITS_REQUIRED' && <p><a href="https://openrouter.ai/settings/credits" target="_blank" rel="noreferrer">Open OpenRouter account</a></p>}
        {draft.error?.code === 'AUTH_FAILED' && <p><a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">Open OpenRouter keys</a></p>}
        <ProviderChip control={control} />
        <div className="ai-actions">
          {generating ? <button type="button" className="ai-text" data-testid="ai-cancel" onClick={() => void control.cancel()}>Cancel</button>
            : kind === 'retry' || kind === 'network' ? <button type="button" className="ai-text" data-testid="ai-retry" onClick={() => void control.generate()}>{kind === 'network' ? 'Retry · may send another request' : 'Retry'}</button>
            : kind === 'settings' || !configured ? <button type="button" className="ai-text" data-testid="ai-open-settings" onClick={() => control.openSettings()}>Open AI settings</button>
            : kind === 'refine' ? <button type="button" className="ai-text" data-testid="ai-refine" onClick={() => control.refine()}>Refine</button>
            : kind === 'refresh' ? <button type="button" className="ai-text" data-testid="ai-retry" onClick={() => void control.generate()}>Refresh and generate again</button>
            : <button type="button" className="ai-text" data-testid="ai-generate" disabled={!draft.prompt.trim() || busy || over || !configured} onClick={() => void control.generate()}>✦ Generate</button>}
        </div>
      </>}
    </section>}
    <button type="button" ref={buttonRef} className={'ai-launch' + (open ? ' is-open' : '')} data-testid="ai-flow-button" aria-label="Describe a flow" title="Describe a flow" aria-expanded={open} aria-busy={busy || undefined} onClick={() => open ? (generating ? undefined : control.closePanel()) : control.openPanel()}>
      <Sparkles />
      {REVIEW.includes(draft.status) && !refining && <span className="ai-launch-dot" data-testid="ai-flow-dot" aria-hidden="true" />}
    </button>
  </div>;
}

export function AiDraftBar({control}: {control: AiDraftControl}) {
  const {draft, reason} = control;
  const review = REVIEW.includes(draft.status) && !draft.refining;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const focused = useRef('');
  const screens = screenCount(draft.draft);
  const steps = stepCount(draft.draft);
  const meta = countPhrase(screens, 'screen', 'screens') + ' · ' + countPhrase(steps, 'step', 'steps') + ' · not run yet';
  const issues = (draft.diagnostics ?? []).filter(item => item.blocks.includes('apply') || item.severity === 'error');
  useEffect(() => {
    if (!review || !draft.previewId || focused.current === draft.previewId) return;
    focused.current = draft.previewId;
    confirmRef.current?.focus();
  }, [review, draft.previewId]);
  if (!review || !draft.draft) return null;
  const unresolved = issues.filter(item => item.code === 'UNRESOLVED_TARGET' || item.code === 'UNRESOLVED_VALUE');
  const assumptions = draft.draft.assumptions.filter(item => (draft.requiredAssumptionKeys ?? []).includes(item.key));
  const known = new Set(assumptions.map(item => item.key));
  const usage = usageLabel(draft);
  return <div className="ai-review" data-testid="ai-review">
    <p className="ai-ask">{issues.length ? issues.length + (issues.length === 1 ? ' issue' : ' issues') + ' to fix before applying' : 'Flow ready. Use this flow?'}</p>
    <p className="ai-meta" data-testid="ai-meta">{meta}</p>
    <div className="ai-actions">
      <button type="button" ref={confirmRef} className="ai-text ai-confirm" data-testid="ai-confirm" aria-disabled={reason ? true : undefined} aria-describedby={reason ? reasonId : undefined} onClick={() => { if (!reason) void control.confirm(); }}>✓ Apply</button>
      <button type="button" className="ai-text" data-testid="ai-refine" onClick={() => control.refine()}>Refine</button>
      {draft.status === 'stale' && <button type="button" className="ai-text" data-testid="ai-refresh" onClick={() => void control.refresh()}>Refresh</button>}
      <button type="button" className="ai-text ai-muted-button" data-testid="ai-discard" onClick={() => void control.discard()}>✕ Dismiss</button>
    </div>
    {draft.status === 'stale' && <p className="ai-muted">The workspace changed since this draft was prepared.</p>}
    {!!issues.length && <ol className="ai-issues">{issues.map((item, index) => <li key={item.path + item.code + index}><span className="ai-issue-no">{index + 1}</span> {item.message}</li>)}</ol>}
    {unresolved.map(item => <NeedsInfo key={item.path + item.code} item={item} onSubmit={value => void control.updateUnresolved(item.path, value)} />)}
    {assumptions.map(item => <label key={item.key} className="ai-check"><input type="checkbox" checked={draft.acknowledged.includes(item.key)} aria-label={item.message} onChange={event => control.acknowledge(item.key, event.target.checked)} />{item.message}</label>)}
    {(draft.requiredAssumptionKeys ?? []).filter(key => !known.has(key)).map(key => <label key={key} className="ai-check"><input type="checkbox" checked={draft.acknowledged.includes(key)} aria-label={key} onChange={event => control.acknowledge(key, event.target.checked)} />{key}</label>)}
    {reason && <p id={reasonId} className="ai-reason" data-testid="ai-confirm-reason">{reason}{issues.length ? ' Apply is off until these are fixed.' : ''}</p>}
    {draft.error && <p className="ai-error" role="alert">{errorCopy(draft.error.code, draft.error.message, draft.model)}</p>}
    {(usage || draft.model || draft.upstreamProvider) && <p className="ai-usage" data-testid="ai-usage">{usage}{draft.upstreamProvider || control.provider === 'openrouter' ? ' OpenRouter chooses the upstream provider.' : ''}{control.provider === 'openrouter' && <> <a href="https://openrouter.ai/settings/credits" target="_blank" rel="noreferrer">Open OpenRouter account</a></>}</p>}
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

function ProviderChip({control}: {control: AiDraftControl}) {
  const [openList, setOpenList] = useState(false);
  const label = providerLabel(control.provider, control.requestModel);
  return <div className="ai-chip-wrap">
    <button type="button" className="ai-text" data-testid="ai-provider-chip" aria-expanded={openList} onClick={() => setOpenList(value => !value)}>{label}</button>
    {openList && control.config && <ul className="ai-chip-list">
      {(['openrouter', 'openai-compatible'] as ProviderId[]).map(id => {
        const entry = control.config?.providers?.[id];
        const ready = !!entry?.configured && !!entry.model;
        return <li key={id}><button type="button" data-testid={'ai-chip-' + id} onClick={() => { control.setProvider(id); setOpenList(false); }}>{providerLabel(id, entry?.model)} <span className="ai-muted">{id === control.provider ? 'current' : ready ? 'recent' : 'not set up'}</span></button></li>;
      })}
    </ul>}
    <label className="ai-field">Model for the next request
      <input className="ai-request-model" aria-label="Model for the next request" data-testid="ai-request-model" value={control.requestModel} spellCheck={false} placeholder="vendor/model" onChange={event => control.setRequestModel(event.target.value)} />
    </label>
    <p className="ai-hint">Applies to the next request, not one already running. <button type="button" className="ai-text" data-testid="ai-open-settings" onClick={() => control.openSettings()}>AI settings</button></p>
  </div>;
}

function providerLabel(id: ProviderId, model?: string) {
  const name = id === 'openrouter' ? 'OpenRouter' : 'OpenAI-compatible';
  return model ? name + ' · ' + model : name;
}

function usageLabel(draft: AiDraft) {
  const parts: string[] = [];
  if (draft.inputTokens !== undefined || draft.outputTokens !== undefined) parts.push(((draft.inputTokens ?? 0) + (draft.outputTokens ?? 0)).toLocaleString('en-US') + ' tokens');
  if (draft.cost !== undefined) parts.push(draft.cost < 0.01 ? '$' + draft.cost.toFixed(4) : '$' + draft.cost.toFixed(3));
  if (draft.model) parts.push(draft.model);
  if (draft.upstreamProvider) parts.push(draft.upstreamProvider);
  return parts.join(' · ');
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

function Sparkles() {
  return <svg className="ai-spark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.2l1.15 4.05L17.2 8.4l-4.05 1.15L12 13.6l-1.15-4.05L6.8 8.4l4.05-1.15L12 3.2z"/><path d="M18 14.2l.55 1.85L20.4 16.6l-1.85.55L18 19l-.55-1.85L15.6 16.6l1.85-.55L18 14.2z"/></svg>;
}
