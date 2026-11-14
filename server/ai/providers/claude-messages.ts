import {CANT_READ_IMAGES} from '../errors.js';
import {ProviderRequestError, type Msg, type Usage} from './types.js';

type ClaudeBlock =
  | {type: 'text'; text: string}
  | {type: 'image'; source: {type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string}};

export type ClaudeMessageRequest = {
  model: string;
  max_tokens: number;
  system: string;
  messages: {role: 'user' | 'assistant'; content: string | ClaudeBlock[]}[];
};

/** Anthropic Messages API body. Config still rejects provider id "anthropic"; this is the recorded contract only. */
export function claudeMessageRequest(input: {model: string; system: string; messages: Msg[]; maxTokens: number}): ClaudeMessageRequest {
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: input.messages.map(message => ({
      role: message.role,
      content: message.image
        ? [
            {type: 'text', text: message.content},
            {type: 'image', source: {type: 'base64', media_type: message.image.mimeType, data: message.image.data}},
          ]
        : message.content,
    })),
  };
}

export function parseClaudeMessage(payload: unknown): {text: string; model?: string; usage?: Usage} {
  if (!payload || typeof payload !== 'object') throw new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: false, reason: 'embedded'});
  const record = payload as {type?: unknown; error?: unknown; content?: unknown; model?: unknown; usage?: unknown};
  if (record.type === 'error' || record.error) throw mapClaudeError(200, payload);
  const blocks = Array.isArray(record.content) ? record.content : [];
  const text = blocks.filter((block): block is {type: 'text'; text: string} => !!block && typeof block === 'object' && (block as {type?: unknown}).type === 'text' && typeof (block as {text?: unknown}).text === 'string').map(block => block.text).join('');
  const usageRecord = record.usage && typeof record.usage === 'object' ? record.usage as {input_tokens?: unknown; output_tokens?: unknown} : undefined;
  const inputTokens = typeof usageRecord?.input_tokens === 'number' ? usageRecord.input_tokens : undefined;
  const outputTokens = typeof usageRecord?.output_tokens === 'number' ? usageRecord.output_tokens : undefined;
  const usage = inputTokens !== undefined || outputTokens !== undefined ? {...(inputTokens !== undefined ? {inputTokens} : {}), ...(outputTokens !== undefined ? {outputTokens} : {})} : undefined;
  const model = typeof record.model === 'string' && record.model ? record.model : undefined;
  return {text, ...(model ? {model} : {}), ...(usage ? {usage} : {})};
}

export function mapClaudeError(status: number, payload: unknown) {
  const error = payload && typeof payload === 'object' && 'error' in payload ? (payload as {error?: unknown}).error : undefined;
  const type = error && typeof error === 'object' && 'type' in error ? String((error as {type?: unknown}).type) : '';
  const message = error && typeof error === 'object' && 'message' in error && typeof (error as {message?: unknown}).message === 'string' ? (error as {message: string}).message.toLowerCase() : '';
  if (type === 'authentication_error' || status === 401 || status === 403) return new ProviderRequestError({code: 'PROVIDER_AUTH', message: 'The model provider rejected the API key.', retryable: false, status: status === 200 ? 401 : status});
  if ((message.includes('image') || message.includes('vision')) && (message.includes('not support') || message.includes('does not') || message.includes('cannot'))) {
    return new ProviderRequestError({code: 'PROVIDER_REJECTED', message: CANT_READ_IMAGES, retryable: false, status, embeddedCode: 'no-vision'});
  }
  if (type === 'rate_limit_error' || status === 429) return new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: true, status: 429});
  if (status === 402 || type === 'billing_error') return new ProviderRequestError({code: 'PROVIDER_REJECTED', message: 'The provider account needs credits.', retryable: false, status: 402, embeddedCode: 402});
  if (status >= 500 || type === 'overloaded_error' || type === 'api_error') return new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: true, status});
  return new ProviderRequestError({code: 'PROVIDER_REJECTED', message: 'The model provider rejected the request.', retryable: false, status});
}
