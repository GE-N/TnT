export type Usage = {inputTokens?: number; outputTokens?: number};

export type Msg = {role: 'user' | 'assistant'; content: string};

export type ProviderErrorCode = 'PROVIDER_AUTH' | 'PROVIDER_CONFIG' | 'PROVIDER_REJECTED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT';

/** A provider only moves bytes. The job owns prompts, validation, repair, and retries. */
export interface FlowModelProvider {
  id: string;
  generate(req: {
    system: string;
    messages: Msg[];
    schema: object;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<{delta?: string; done?: {text: string; usage?: Usage}}>;
  check(): Promise<{ok: boolean; model?: string; error?: string}>;
}

export class ProviderRequestError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  constructor(input: {code: ProviderErrorCode; message: string; retryable: boolean; retryAfterMs?: number; status?: number}) {
    super(input.message);
    this.name = 'ProviderRequestError';
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
    this.status = input.status;
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
