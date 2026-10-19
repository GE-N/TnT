import type {ApplyResult, Diagnostic, Preview} from '../server/authoring/types.js';
import type {AiPublicConfig} from '../server/ai/config.js';
import type {GenerationPhase, GenerationState, GenerationView, JobError} from '../server/ai/store.js';

export type {AiPublicConfig, ApplyResult, Diagnostic, GenerationPhase, GenerationState, GenerationView, JobError, Preview};

export const AI_POLL_MS = 500;

export class AiFlowRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly diagnostics?: Diagnostic[]) {
    super(message);
    this.name = 'AiFlowRequestError';
  }
}

export type GenerationRequest = {workspaceId: string; expectedRevision: number; prompt: string};
export type ContextRequest = {workspaceId: string; expectedRevision: number; screenIds?: string[]};
export type AuthoringContext = {contextId: string; workspaceId: string; revision: number; expiresAt: string};
export type PreviewRequest = {workspaceId: string; expectedRevision: number; contextId: string; draft: unknown};
export type ApplyRequest = {workspaceId: string; expectedRevision: number; previewId: string; idempotencyKey: string; acknowledgedAssumptionKeys: string[]};
export type ApplyResponse = ApplyResult & {receiptId?: string};
export type UndoRequest = {workspaceId: string; expectedRevision: number; receiptId: string};
export type UndoResponse = {workspaceId: string; revision: number; receiptId: string; scenarioId: string; undone: true};
export type ConfigInput = {provider: 'openai-compatible'; model: string; baseUrl: string; apiKey?: string};
export type ConnectionCheck = {ok: boolean; model?: string; error?: string};

/** Same-origin runner calls. The session token is a header, never part of the URL. */
export function createAiFlowClient(token: string) {
  return {
    startGeneration: (body: GenerationRequest) => request<GenerationView>(token, 'POST', '/api/ai/generations', body),
    getGeneration: (id: string) => request<GenerationView>(token, 'GET', '/api/ai/generations/' + encodeURIComponent(id)),
    cancelGeneration: (id: string) => request<GenerationView>(token, 'POST', '/api/ai/generations/' + encodeURIComponent(id) + '/cancel', {}),
    getConfig: () => request<AiPublicConfig>(token, 'GET', '/api/ai/config'),
    putConfig: (body: ConfigInput) => request<AiPublicConfig>(token, 'PUT', '/api/ai/config', body),
    checkConfig: () => request<ConnectionCheck>(token, 'POST', '/api/ai/config/check', {}),
    /** Preview requires a contextId. Refresh creates one at the saved revision, then posts the stored draft. */
    createContext: (body: ContextRequest) => request<AuthoringContext>(token, 'POST', '/api/authoring/context', body),
    preview: (body: PreviewRequest) => request<Preview>(token, 'POST', '/api/authoring/preview', body),
    apply: (body: ApplyRequest) => request<ApplyResponse>(token, 'POST', '/api/authoring/apply', body),
    undo: (body: UndoRequest) => request<UndoResponse>(token, 'POST', '/api/authoring/undo', body),
    readFlow: (scenarioId: string, workspaceId: string) => request<unknown>(token, 'GET', '/api/authoring/flows/' + encodeURIComponent(scenarioId) + '?workspaceId=' + encodeURIComponent(workspaceId)),
  };
}

export type AiFlowClient = ReturnType<typeof createAiFlowClient>;

async function request<T>(token: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {'X-TnT-Token': token, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const record = payload && typeof payload === 'object' ? payload as {error?: unknown; code?: unknown; diagnostics?: Diagnostic[]} : undefined;
    const message = typeof record?.error === 'string' ? record.error : 'The AI flow request failed.';
    const code = typeof record?.code === 'string' ? record.code : 'REQUEST_FAILED';
    throw new AiFlowRequestError(message, response.status, code, record?.diagnostics);
  }
  return payload as T;
}
