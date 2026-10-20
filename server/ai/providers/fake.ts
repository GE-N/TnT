import {ProviderRequestError, type FlowModelProvider, type Usage} from './types.js';

export type FakeResult =
  | {kind: 'ok'; text: string; usage?: Usage; deltas?: string[]; model?: string; upstreamProvider?: string}
  | {kind: 'fail'; error: ProviderRequestError}
  | {kind: 'delay'; ms: number; text: string}
  | {kind: 'gate'; text: string; onEnter?: () => void; open: Promise<void>};

export function createFakeProvider(handle: (input: {call: number; system: string; messages: {role: string; content: string}[]}) => FakeResult | Promise<FakeResult>): FlowModelProvider {
  let call = 0;
  return {
    id: 'fake',
    async check() { return {ok: true, model: 'fake'}; },
    async *generate(req) {
      if (req.budget && !req.budget.tryConsume()) throw new ProviderRequestError({code: 'PROVIDER_REJECTED', message: 'The generation request budget is exhausted.', retryable: false, reason: 'budget'});
      const result = await handle({call: ++call, system: req.system, messages: req.messages});
      if (result.kind === 'fail') throw result.error;
      if (result.kind === 'delay') {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, result.ms);
          const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('The operation was aborted.'), {name: 'AbortError'})); };
          if (req.signal.aborted) { onAbort(); return; }
          req.signal.addEventListener('abort', onAbort, {once: true});
        });
        if (req.signal.aborted) throw Object.assign(new Error('The operation was aborted.'), {name: 'AbortError'});
        yield {done: {text: result.text}};
        return;
      }
      if (result.kind === 'gate') {
        result.onEnter?.();
        await result.open;
        if (req.signal.aborted) throw Object.assign(new Error('The operation was aborted.'), {name: 'AbortError'});
        yield {done: {text: result.text}};
        return;
      }
      if (result.deltas) for (const delta of result.deltas) yield {delta};
      yield {done: {text: result.text, ...(result.usage ? {usage: result.usage} : {}), ...(result.model ? {model: result.model} : {}), ...(result.upstreamProvider ? {upstreamProvider: result.upstreamProvider} : {})}};
    },
  };
}
