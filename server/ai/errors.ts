import {ProviderRequestError} from './providers/types.js';

/** HTTP error for the AI routes. The body never includes a key, prompt, or model response. */
export function redactSecrets(text: string, secrets: readonly string[]) {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization: [redacted]');
}

export class AiHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AiHttpError';
  }
  get body(): {error: string; code: string} {
    return {error: this.message, code: this.code};
  }
}

export type AppFailure = {code: string; message: string; retryable: boolean};

function numericEmbedded(code: number | string | undefined) {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  return;
}

/** Maps a provider failure onto an app code. Internal provider codes stay off the API. */
export function mapProviderFailure(error: ProviderRequestError): AppFailure {
  if (error.outputTooLarge) return {code: 'INVALID_AI_OUTPUT', message: 'The model output was too large.', retryable: false};
  if (error.reason === 'network') return {code: 'NETWORK_ERROR', message: 'The provider could not be reached.', retryable: true};
  if (error.code === 'PROVIDER_TIMEOUT') return {code: 'TIMEOUT', message: 'The generation timed out.', retryable: true};
  const lookup = error.reason === 'embedded' ? numericEmbedded(error.embeddedCode) : error.status;
  if (lookup === 401 || lookup === 403 || error.code === 'PROVIDER_AUTH') return {code: 'AUTH_FAILED', message: 'The API key was rejected.', retryable: false};
  if (lookup === 402) return {code: 'CREDITS_REQUIRED', message: 'The provider account needs credits.', retryable: false};
  if (lookup === 404 || error.embeddedCode === 'model_not_found') return {code: 'MODEL_UNAVAILABLE', message: 'The model is not available at this provider.', retryable: false};
  if (lookup === 429) return {code: 'RATE_LIMITED', message: 'The provider rate limit was reached.', retryable: true};
  if (lookup !== undefined && Number.isInteger(lookup) && lookup >= 400 && lookup < 500) return {code: 'UNSUPPORTED_REQUEST', message: 'The provider rejected the request.', retryable: false};
  if (error.reason === 'embedded' || error.reason === 'budget') return {code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: error.reason !== 'budget'};
  if (lookup !== undefined && lookup >= 400 && lookup < 500) return {code: 'UNSUPPORTED_REQUEST', message: 'The provider rejected the request.', retryable: false};
  if (error.code === 'PROVIDER_CONFIG') return {code: 'MODEL_UNAVAILABLE', message: 'The model is not available at this provider.', retryable: false};
  if (error.code === 'PROVIDER_REJECTED') return {code: 'UNSUPPORTED_REQUEST', message: 'The provider rejected the request.', retryable: false};
  return {code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: true};
}

/** Automatic retry is only an explicit HTTP 429 or 503. Embedded and transport failures stay put. */
export function canAutoRetry(error: ProviderRequestError) {
  if (error.outputTooLarge || error.reason === 'embedded' || error.reason === 'network' || error.reason === 'budget') return false;
  if (error.code === 'PROVIDER_TIMEOUT') return false;
  return error.status === 429 || error.status === 503;
}
