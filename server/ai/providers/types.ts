export type Usage = {inputTokens?: number; outputTokens?: number; cost?: number};

export type Msg = {role: 'user' | 'assistant'; content: string};

export type ProviderErrorCode = 'PROVIDER_AUTH' | 'PROVIDER_CONFIG' | 'PROVIDER_REJECTED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT';

/** Why a provider failure must not be posted again. The job maps these at the API boundary. */
export type ProviderFailureReason = 'network' | 'embedded' | 'budget';

/** One submission may make this many upstream POSTs, including fallbacks, retries, and repair. */
export const MAX_UPSTREAM_POSTS = 2;
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
  generate(req: {
    system: string;
    messages: Msg[];
    schema: object;
    maxOutputTokens: number;
    signal: AbortSignal;
    budget?: UpstreamBudget;
  }): AsyncIterable<{delta?: string; done?: ModelDone}>;
  check(): Promise<{ok: boolean; model?: string; error?: string}>;
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
