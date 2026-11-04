import {RESPONSE_BYTE_LIMIT, ProviderRequestError, type FlowModelProvider, type Msg, type Usage} from './types.js';
import {COPILOT_NOT_INSTALLED, type CopilotErrorKind, type CopilotRuntime} from './copilot-runtime.js';

/** Repair sends user/assistant/user. The SDK takes one prompt, so tag every turn. */
export function flattenCopilotMessages(messages: Msg[]) {
  if (messages.length <= 1) return messages[0]?.content ?? '';
  return messages.map(message => `<${message.role}>\n${message.content}\n</${message.role}>`).join('\n\n') + '\n\nAnswer the last <user> message.';
}

function failure(kind: CopilotErrorKind, message: string) {
  if (kind === 'not-signed-in') return new ProviderRequestError({code: 'PROVIDER_REJECTED', message, retryable: false, embeddedCode: 'not-signed-in', reason: 'embedded'});
  if (kind === 'policy-off') return new ProviderRequestError({code: 'PROVIDER_REJECTED', message, retryable: false, embeddedCode: 'policy-off', reason: 'embedded'});
  if (kind === 'no-seat') return new ProviderRequestError({code: 'PROVIDER_REJECTED', message, retryable: false, embeddedCode: 'no-seat', reason: 'embedded'});
  if (kind === 'model-unavailable') return new ProviderRequestError({code: 'PROVIDER_CONFIG', message: 'The model is not available at this provider.', retryable: false});
  if (kind === 'rate-limit') return new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The provider rate limit was reached.', retryable: true, status: 429});
  return new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The provider could not be reached.', retryable: true, reason: 'network'});
}

function outputTooLarge() {
  return new ProviderRequestError({code: 'PROVIDER_REJECTED', message: 'The model output was too large.', retryable: false, outputTooLarge: true});
}

export function createCopilotSdkProvider(options: {runtime: CopilotRuntime; model: string}): FlowModelProvider {
  const requested = options.model || 'auto';
  return {
    id: 'copilot',
    sendsJsonSchema: false,
    async check() {
      const status = await options.runtime.authStatus();
      if (!status.signedIn) {
        if (status.message === COPILOT_NOT_INSTALLED) return {ok: false, error: COPILOT_NOT_INSTALLED};
        if (status.message?.includes('Unset GH_TOKEN')) return {ok: false, error: status.message};
        return {ok: false, error: 'Not signed in'};
      }
      return {ok: true, model: requested, ...(status.login ? {login: status.login} : {})};
    },
    async *generate(req) {
      if (req.budget && !req.budget.tryConsume()) throw new ProviderRequestError({code: 'PROVIDER_REJECTED', message: 'The generation request budget is exhausted.', retryable: false, reason: 'budget'});
      const prompt = flattenCopilotMessages(req.messages);
      let bytes = 0;
      let text = '';
      const chunks: string[] = [];
      let usage: {model: string; inputTokens: number; outputTokens: number; nanoAiu?: number} | undefined;
      for await (const event of options.runtime.run({system: req.system, prompt, model: requested, signal: req.signal})) {
        if (event.type === 'delta') {
          bytes += Buffer.byteLength(event.text);
          if (bytes > RESPONSE_BYTE_LIMIT) throw outputTooLarge();
          chunks.push(event.text);
          continue;
        }
        if (event.type === 'usage') { usage = event; continue; }
        if (event.type === 'error') throw failure(event.kind, event.message);
        text = event.text;
      }
      if (req.signal.aborted) return;
      const answered = usage?.model || '';
      if (requested !== 'auto' && answered && answered !== requested) throw failure('model-unavailable', answered);
      const body = text || chunks.join('');
      if (Buffer.byteLength(body) > RESPONSE_BYTE_LIMIT) throw outputTooLarge();
      for (const chunk of chunks) yield {delta: chunk};
      const cost = usage?.nanoAiu !== undefined ? usage.nanoAiu / 1e9 : undefined;
      const reported: Usage = {
        ...(usage ? {inputTokens: usage.inputTokens, outputTokens: usage.outputTokens} : {}),
        ...(cost !== undefined ? {cost} : {}),
      };
      yield {
        done: {
          text: body,
          ...(usage || cost !== undefined ? {usage: reported} : {}),
          ...(answered ? {model: answered} : {}),
          upstreamProvider: 'github-copilot',
        },
      };
    },
  };
}
