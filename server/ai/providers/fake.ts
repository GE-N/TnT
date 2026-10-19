import {ProviderRequestError, type FlowModelProvider, type Usage} from './types.js';

export type FakeResult =
  | {kind: 'ok'; text: string; usage?: Usage; deltas?: string[]}
  | {kind: 'fail'; error: ProviderRequestError}
  | {kind: 'delay'; ms: number; text: string}
  | {kind: 'gate'; text: string; onEnter?: () => void; open: Promise<void>};

export function createFakeProvider(handle: (input: {call: number; system: string; messages: {role: string; content: string}[]}) => FakeResult | Promise<FakeResult>): FlowModelProvider {
  let call = 0;
  return {
    id: 'fake',
    async check() { return {ok: true, model: 'fake'}; },
    async *generate(req) {
      const result = await handle({call: ++call, system: req.system, messages: req.messages});
      if (result.kind === 'fail') throw result.error;
      if (result.kind === 'delay') {
        await new Promise<void>(resolve => setTimeout(resolve, result.ms));
        yield {done: {text: result.text}};
        return;
      }
      if (result.kind === 'gate') {
        result.onEnter?.();
        await result.open;
        yield {done: {text: result.text}};
        return;
      }
      if (result.deltas) for (const delta of result.deltas) yield {delta};
      yield {done: {text: result.text, ...(result.usage ? {usage: result.usage} : {})}};
    },
  };
}
