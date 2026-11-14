export type Usage = {inputTokens?: number; outputTokens?: number; cost?: number};

export type Msg = {role: 'user' | 'assistant'; content: string; image?: {mimeType: 'image/png' | 'image/jpeg'; data: string}};

export type ProviderErrorCode = 'PROVIDER_AUTH' | 'PROVIDER_CONFIG' | 'PROVIDER_REJECTED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT';

/** Why a provider failure must not be posted again. The job maps these at the API boundary. */
export type ProviderFailureReason = 'network' | 'embedded' | 'budget';

/**
 * Upstream POST budget for one submission.
 *
 * MAX_ATTEMPT_POSTS is 2. That covers the first model call plus one provider
 * fallback (json_schema or stream_options) or one automatic retry. Fallbacks
 * and retries share this number.
 *
 * MAX_REPAIR_POSTS is 2. JSON repair has this budget of its own, so a fallback
 * on the first call does not spend it. A repair call may use one fallback.
 *
 * MAX_UPSTREAM_POSTS is 4. That is the hard ceiling: attempt posts plus repair
 * posts never exceed it.
 */
export const MAX_ATTEMPT_POSTS = 2;
export const MAX_REPAIR_POSTS = 2;
export const MAX_UPSTREAM_POSTS = MAX_ATTEMPT_POSTS + MAX_REPAIR_POSTS;
export const RESPONSE_BYTE_LIMIT = 256 * 1024;

export type UpstreamBudget = {
  remaining(): number;
  tryConsume(): boolean;
};

export type ModelDone = {
  text: string;
  usage?: Usage;
  /** Model id the response itself reported. Absent when the response omitted it. */
  model?: string;
  /** Upstream provider the response itself reported. Absent when the response omitted it. */
  upstreamProvider?: string;
};

/** A provider only moves bytes. The job owns prompts, validation, repair, and retries. */
export interface FlowModelProvider {
  id: string;
  /** True when generate() sends `schema` as response_format json_schema. Otherwise the job puts the schema in the instructions. */
  sendsJsonSchema?: boolean;
  /** False when this provider must not be given an image. Copilot decides per model inside generate(). */
  readsImages?: boolean;
  generate(req: {
    system: string;
    messages: Msg[];
    schema: object;
    maxOutputTokens: number;
    signal: AbortSignal;
    budget?: UpstreamBudget;
  }): AsyncIterable<{delta?: string; done?: ModelDone}>;
  check(): Promise<{ok: boolean; model?: string; error?: string; login?: string}>;
}

export class ProviderRequestError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly embeddedCode?: number | string;
  readonly reason?: ProviderFailureReason;
  readonly outputTooLarge?: boolean;
  constructor(input: {code: ProviderErrorCode; message: string; retryable: boolean; retryAfterMs?: number; status?: number; embeddedCode?: number | string; reason?: ProviderFailureReason; outputTooLarge?: boolean}) {
    super(input.message);
    this.name = 'ProviderRequestError';
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
    this.status = input.status;
    this.embeddedCode = input.embeddedCode;
    this.reason = input.reason;
    this.outputTooLarge = input.outputTooLarge;
  }
}

export function isAbortError(error: unknown) {
  return !!error && typeof error === 'object' && 'name' in error && (error as {name?: string}).name === 'AbortError';
}

export function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}
