import {mkdir} from 'node:fs/promises';
import {onServerShutdown} from '../../shutdown-hooks.js';
import {RESPONSE_BYTE_LIMIT} from './types.js';

/** Spike and DESIGN §3.1 names. Shorter mock names are not used. */
export type CopilotErrorKind = 'not-signed-in' | 'policy-off' | 'no-seat' | 'model-unavailable' | 'rate-limit' | 'network';

export type CopilotAuth = {
  signedIn: boolean;
  login?: string;
  via?: 'copilot-login' | 'gh-cli' | 'env';
  message?: string;
};

export type CopilotModel = {id: string; name: string; enabled: boolean};

export type CopilotRunEvent =
  | {type: 'delta'; text: string}
  | {type: 'usage'; model: string; inputTokens: number; outputTokens: number; nanoAiu?: number}
  | {type: 'error'; kind: CopilotErrorKind; message: string}
  | {type: 'done'; text: string};

export type CopilotRuntime = {
  authStatus(): Promise<CopilotAuth>;
  models(): Promise<CopilotModel[]>;
  run(input: {system: string; prompt: string; model: string; signal: AbortSignal}): AsyncIterable<CopilotRunEvent>;
};

export const COPILOT_NOT_INSTALLED = "Copilot isn't installed";
export const COPILOT_IDLE_MS = 10 * 60 * 1000;
export const COPILOT_STOP_GRACE_MS = 5_000;

const NOT_SIGNED_IN = "Copilot isn't signed in.";
const PAT_HINT = "Copilot isn't signed in. Unset GH_TOKEN or GITHUB_TOKEN if it is a classic personal access token.";
const POLICY_OFF = 'Copilot is off for this account.';
const NO_SEAT = 'This account has no Copilot license.';
const SECRET = /\b(?:gho_|ghu_|ghp_|github_pat_)[A-Za-z0-9_]+/g;

export function redactCopilotText(text: string) {
  return text.replace(SECRET, '[redacted]');
}

function patHint(message: string) {
  return /GH_TOKEN|GITHUB_TOKEN|\bghp_|classic personal access token/i.test(message);
}

/** Maps a runtime status or session.error onto a DESIGN §3.1 kind. */
export function classifyCopilotFailure(input: {message?: string; statusCode?: number; errorType?: string; missingPackage?: boolean}): {kind: CopilotErrorKind; message: string} {
  const raw = input.message ?? '';
  if (input.missingPackage || raw === COPILOT_NOT_INSTALLED) return {kind: 'not-signed-in', message: COPILOT_NOT_INSTALLED};
  const text = raw.toLowerCase();
  const type = (input.errorType ?? '').toLowerCase();
  const status = input.statusCode;
  let kind: CopilotErrorKind | undefined;
  if (text.includes('not licensed to use copilot') || text.includes('no subscription')) kind = 'no-seat';
  else if (text.includes('access denied by policy settings') || text.includes('not authorized to use this copilot feature') || type === 'policy') kind = 'policy-off';
  else if (status === 401 || type === 'authentication' || text.includes('no authentication information') || text.includes('not authenticated') || text.includes('bad credentials') || patHint(raw)) kind = 'not-signed-in';
  else if (status === 429 || type === 'rate_limit' || type === 'quota' || text.includes('rate limit') || text.includes('quota exhausted') || text.includes('too many requests')) kind = 'rate-limit';
  else if (/model/.test(text) && /not available|unavailable/.test(text)) kind = 'model-unavailable';
  else if (type === 'network' || /enotfound|econnrefused|econnreset|etimedout|certificate|getaddrinfo|\bproxy\b/.test(text)) kind = 'network';
  if (!kind) kind = 'network';
  if (kind === 'not-signed-in') return {kind, message: patHint(raw) ? PAT_HINT : NOT_SIGNED_IN};
  if (kind === 'policy-off') return {kind, message: POLICY_OFF};
  if (kind === 'no-seat') return {kind, message: NO_SEAT};
  return {kind, message: redactCopilotText(raw).slice(0, 300) || 'Copilot failed.'};
}

type SdkAuth = {isAuthenticated?: boolean; authType?: string; login?: string; statusMessage?: string};
type SdkModel = {id?: string; name?: string; policy?: {state?: string}};
type SdkSession = {
  on(handler: (event: unknown) => void): void;
  send(options: {prompt: string}): Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
};
type SdkClient = {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  forceStop(): Promise<void>;
  getAuthStatus(): Promise<SdkAuth>;
  listModels(): Promise<SdkModel[]>;
  createSession(config: CopilotSessionConfig): Promise<SdkSession>;
};
type CopilotSdkModule = {CopilotClient: new (options: CopilotClientOptions) => SdkClient};

export type CopilotClientOptions = {
  mode: 'empty';
  baseDirectory: string;
  useLoggedInUser: true;
  logLevel: 'error';
};

export type CopilotSessionConfig = {
  streaming: true;
  availableTools: string[];
  disabledMcpServers: string[];
  systemMessage: {mode: 'replace'; content: string};
  onPermissionRequest: () => {kind: 'denied-by-rules'; rules: []};
  model?: string;
};

/** Session options the spike proved. Model is omitted for auto so the SDK is not asked to pin it. */
export function copilotSessionConfig(input: {system: string; model: string}): CopilotSessionConfig {
  const config: CopilotSessionConfig = {
    streaming: true,
    availableTools: [],
    disabledMcpServers: ['github-mcp-server'],
    systemMessage: {mode: 'replace', content: input.system},
    onPermissionRequest: () => ({kind: 'denied-by-rules', rules: []}),
  };
  if (input.model !== 'auto') config.model = input.model;
  return config;
}

export function copilotClientOptions(baseDirectory: string): CopilotClientOptions {
  return {mode: 'empty', baseDirectory, useLoggedInUser: true, logLevel: 'error'};
}

type UsageState = {text: string};

function numberOf(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Maps one SDK event. Field names match the recorded streams: deltaContent, copilotUsage.totalNanoAiu, quotaSnapshots. */
export function mapCopilotSdkEvent(event: unknown, state: UsageState): CopilotRunEvent | undefined {
  if (!event || typeof event !== 'object' || !('type' in event)) return;
  const record = event as {type?: unknown; data?: unknown};
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
  if (record.type === 'assistant.message_delta') {
    const text = typeof data.deltaContent === 'string' ? data.deltaContent : '';
    if (!text) return;
    state.text += text;
    return {type: 'delta', text};
  }
  if (record.type === 'assistant.usage') {
    const copilotUsage = data.copilotUsage && typeof data.copilotUsage === 'object' ? data.copilotUsage as {totalNanoAiu?: unknown} : undefined;
    // quotaSnapshots is part of the recorded usage shape. Billing uses totalNanoAiu only.
    void data.quotaSnapshots;
    const model = typeof data.model === 'string' ? data.model : '';
    const nano = numberOf(copilotUsage?.totalNanoAiu);
    return {
      type: 'usage',
      model,
      inputTokens: numberOf(data.inputTokens) ?? 0,
      outputTokens: numberOf(data.outputTokens) ?? 0,
      ...(nano !== undefined ? {nanoAiu: nano} : {}),
    };
  }
  if (record.type === 'session.error') {
    const statusCode = numberOf(data.statusCode);
    const errorType = typeof data.errorType === 'string' ? data.errorType : undefined;
    const message = typeof data.message === 'string' ? data.message : '';
    const classified = classifyCopilotFailure({message, statusCode, errorType});
    return {type: 'error', kind: classified.kind, message: classified.message};
  }
  if (record.type === 'session.idle') return {type: 'done', text: state.text};
  return;
}

function viaOf(authType: string | undefined): CopilotAuth['via'] {
  if (authType === 'gh-cli') return 'gh-cli';
  if (authType === 'user') return 'copilot-login';
  if (authType === 'env' || authType === 'token' || authType === 'api-key' || authType === 'hmac') return 'env';
  return;
}

function missingModule(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? (error as {code?: unknown}).code : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  const message = error instanceof Error ? error.message : '';
  return /cannot find package '@github\/copilot-sdk'|cannot find module '@github\/copilot-sdk'/i.test(message);
}

function delay(ms: number) {
  return new Promise<void>(resolve => { setTimeout(resolve, ms); });
}

async function finishWithin(work: Promise<void>, force: () => Promise<void>, graceMs: number) {
  let finished = false;
  const tracked = work.then(() => { finished = true; }, () => { finished = true; });
  await Promise.race([tracked, delay(graceMs)]);
  if (!finished) await force().catch(() => undefined);
}

async function defaultLoadSdk(): Promise<CopilotSdkModule> {
  return await import('@github/copilot-sdk') as unknown as CopilotSdkModule;
}

export type SdkCopilotRuntime = CopilotRuntime & {stop(): Promise<void>};

export function createSdkCopilotRuntime(options: {
  baseDirectory: string;
  loadSdk?: () => Promise<CopilotSdkModule>;
  idleMs?: number;
  stopGraceMs?: number;
}): SdkCopilotRuntime {
  const loadSdk = options.loadSdk ?? defaultLoadSdk;
  const idleMs = options.idleMs ?? COPILOT_IDLE_MS;
  const stopGraceMs = options.stopGraceMs ?? COPILOT_STOP_GRACE_MS;
  let client: SdkClient | undefined;
  let starting: Promise<SdkClient> | undefined;
  let missing = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function clearIdle() {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function touch() {
    clearIdle();
    idleTimer = setTimeout(() => { void stop(); }, idleMs);
    idleTimer.unref?.();
  }

  async function ensure() {
    if (missing) throw Object.assign(new Error(COPILOT_NOT_INSTALLED), {code: 'ERR_MODULE_NOT_FOUND'});
    if (client) { touch(); return client; }
    if (!starting) {
      starting = (async () => {
        let sdk: CopilotSdkModule;
        try { sdk = await loadSdk(); }
        catch (error) {
          if (missingModule(error)) { missing = true; throw error; }
          throw error;
        }
        await mkdir(options.baseDirectory, {recursive: true});
        const created = new sdk.CopilotClient(copilotClientOptions(options.baseDirectory));
        await created.start();
        client = created;
        touch();
        return created;
      })().finally(() => { starting = undefined; });
    }
    return starting;
  }

  async function stop() {
    clearIdle();
    const current = client;
    client = undefined;
    if (!current) return;
    await finishWithin(current.stop().then(() => undefined, () => undefined), () => current.forceStop(), stopGraceMs);
  }

  async function force(current: SdkClient) {
    if (client === current) client = undefined;
    clearIdle();
    await current.forceStop();
  }

  async function halt(session: SdkSession, current: SdkClient) {
    await finishWithin((async () => {
      try { await session.abort(); }
      catch { /* The session may already be gone. */ }
      try { await session.disconnect(); }
      catch { /* Disconnect is best-effort after abort. */ }
    })(), () => force(current), stopGraceMs);
  }

  return {
    stop,
    async authStatus() {
      try {
        const current = await ensure();
        const auth = await current.getAuthStatus();
        const login = typeof auth.login === 'string' && auth.login ? auth.login : undefined;
        const via = viaOf(typeof auth.authType === 'string' ? auth.authType : undefined);
        if (!auth.isAuthenticated) {
          const classified = classifyCopilotFailure({message: typeof auth.statusMessage === 'string' ? auth.statusMessage : ''});
          const message = classified.kind === 'not-signed-in' ? classified.message : 'Not signed in';
          return {signedIn: false, ...(login ? {login} : {}), ...(via ? {via} : {}), message};
        }
        return {signedIn: true, ...(login ? {login} : {}), ...(via ? {via} : {})};
      } catch (error) {
        if (missing || missingModule(error)) return {signedIn: false, message: COPILOT_NOT_INSTALLED};
        const message = error instanceof Error ? error.message : 'Copilot failed to start.';
        return {signedIn: false, message: redactCopilotText(message).slice(0, 300)};
      }
    },
    async models() {
      const current = await ensure();
      const listed = await current.listModels();
      return listed.flatMap(item => {
        if (!item || typeof item.id !== 'string' || !item.id || item.policy?.state === 'disabled') return [];
        return [{id: item.id, name: typeof item.name === 'string' && item.name ? item.name : item.id, enabled: true}];
      });
    },
    async *run(input) {
      // Already aborted: do not start the client or open a session.
      if (input.signal.aborted) return;
      let current: SdkClient;
      try { current = await ensure(); }
      catch (error) {
        if (missing || missingModule(error)) {
          yield {type: 'error', kind: 'not-signed-in', message: COPILOT_NOT_INSTALLED};
          return;
        }
        const message = error instanceof Error ? error.message : 'Copilot failed to start.';
        const classified = classifyCopilotFailure({message});
        yield {type: 'error', kind: classified.kind === 'network' ? 'network' : classified.kind, message: classified.message};
        return;
      }
      const session = await current.createSession(copilotSessionConfig({system: input.system, model: input.model}));
      const state: UsageState = {text: ''};
      const queue: CopilotRunEvent[] = [];
      let finished = false;
      let wake: (() => void) | undefined;
      let halting: Promise<void> | undefined;
      let thrown: unknown;
      const haltOnce = () => { halting ??= halt(session, current); return halting; };
      session.on(event => {
        const mapped = mapCopilotSdkEvent(event, state);
        if (!mapped) return;
        queue.push(mapped);
        if (mapped.type === 'error' || mapped.type === 'done') finished = true;
        wake?.();
      });
      const onAbort = () => { void haltOnce().finally(() => { finished = true; wake?.(); }); };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, {once: true});
      try {
        if (!input.signal.aborted) await session.send({prompt: input.prompt});
        while (!finished || queue.length) {
          if (input.signal.aborted && !queue.length) break;
          if (queue.length) { yield queue.shift()!; continue; }
          await new Promise<void>(resolve => { wake = resolve; });
          wake = undefined;
        }
      } catch (error) {
        thrown = error;
      } finally {
        input.signal.removeEventListener('abort', onAbort);
        if (input.signal.aborted) await haltOnce();
        else await finishWithin(session.disconnect().then(() => undefined, () => undefined), () => force(current), stopGraceMs);
      }
      if (thrown && !input.signal.aborted) {
        const message = thrown instanceof Error ? thrown.message : 'Copilot failed.';
        const classified = classifyCopilotFailure({message});
        yield {type: 'error', kind: classified.kind, message: classified.message};
      }
    },
  };
}

export type FakeCopilotScript =
  | 'authError'
  | 'policyError'
  | 'noSeat'
  | 'rateLimited'
  | 'hang'
  | 'tooLarge'
  | 'modelSubstituted'
  | {kind: 'ok'; text: string; deltas?: string[]; model?: string; inputTokens?: number; outputTokens?: number; nanoAiu?: number}
  | {kind: 'fenced'; json: string; model?: string; nanoAiu?: number; inputTokens?: number; outputTokens?: number}
  | {kind: 'prose'; json: string}
  | {kind: 'invalidDraft'; text: string}
  | {kind: 'modelSubstituted'; text: string; model: string; nanoAiu?: number};

export type FakeCopilotRuntime = CopilotRuntime & {
  prompts: {system: string; prompt: string; model: string}[];
  /** True while a hang script has not been aborted. */
  leaked: boolean;
};

const SCRIPT_ERRORS: Record<string, {kind: CopilotErrorKind; message: string}> = {
  authError: {kind: 'not-signed-in', message: 'No authentication information'},
  policyError: {kind: 'policy-off', message: 'Access denied by policy settings'},
  noSeat: {kind: 'no-seat', message: 'not licensed to use Copilot'},
  rateLimited: {kind: 'rate-limit', message: '429'},
};

export function createFakeCopilotRuntime(script: FakeCopilotScript | ((call: number, input: {system: string; prompt: string; model: string}) => FakeCopilotScript), auth: CopilotAuth = {signedIn: true, login: 'octocat', via: 'gh-cli'}, models: CopilotModel[] = [{id: 'auto', name: 'Auto', enabled: true}]): FakeCopilotRuntime {
  const prompts: FakeCopilotRuntime['prompts'] = [];
  let call = 0;
  const runtime: FakeCopilotRuntime = {
    prompts,
    leaked: false,
    async authStatus() { return auth; },
    async models() { return models; },
    async *run(input) {
      call += 1;
      prompts.push({system: input.system, prompt: input.prompt, model: input.model});
      const step = typeof script === 'function' ? script(call, {system: input.system, prompt: input.prompt, model: input.model}) : script;
      if (input.signal.aborted) return;
      if (step === 'hang') {
        runtime.leaked = true;
        await new Promise<void>(resolve => {
          if (input.signal.aborted) { resolve(); return; }
          input.signal.addEventListener('abort', () => resolve(), {once: true});
        });
        runtime.leaked = false;
        return;
      }
      if (typeof step === 'string' && step in SCRIPT_ERRORS) {
        const known = SCRIPT_ERRORS[step];
        const classified = classifyCopilotFailure({message: known.message, statusCode: step === 'rateLimited' ? 429 : undefined});
        yield {type: 'error', kind: known.kind, message: classified.message};
        return;
      }
      if (step === 'tooLarge') {
        yield {type: 'delta', text: 'x'.repeat(RESPONSE_BYTE_LIMIT + 1)};
        return;
      }
      if (step === 'modelSubstituted') {
        const text = '{}';
        yield {type: 'delta', text};
        yield {type: 'usage', model: 'gpt-6-luna', inputTokens: 3, outputTokens: 1, nanoAiu: 1_000_000};
        yield {type: 'done', text};
        return;
      }
      if (typeof step === 'string') return;
      if (step.kind === 'modelSubstituted') {
        yield {type: 'delta', text: step.text};
        yield {type: 'usage', model: step.model, inputTokens: 3, outputTokens: 1, ...(step.nanoAiu !== undefined ? {nanoAiu: step.nanoAiu} : {})};
        yield {type: 'done', text: step.text};
        return;
      }
      let text = '';
      let model = 'gpt-6-luna';
      let inputTokens = 10;
      let outputTokens = 4;
      let nanoAiu = 1_700_000;
      if (step.kind === 'ok') {
        text = step.text;
        model = step.model ?? model;
        inputTokens = step.inputTokens ?? inputTokens;
        outputTokens = step.outputTokens ?? outputTokens;
        nanoAiu = step.nanoAiu ?? nanoAiu;
        for (const delta of step.deltas ?? [text]) yield {type: 'delta', text: delta};
      } else if (step.kind === 'fenced') {
        text = '```json\n' + step.json + '\n```';
        model = step.model ?? model;
        inputTokens = step.inputTokens ?? inputTokens;
        outputTokens = step.outputTokens ?? outputTokens;
        nanoAiu = step.nanoAiu ?? nanoAiu;
        yield {type: 'delta', text};
      } else if (step.kind === 'prose') {
        text = 'Here is the draft:\n' + step.json;
        yield {type: 'delta', text};
      } else {
        text = step.text;
        yield {type: 'delta', text};
      }
      yield {type: 'usage', model, inputTokens, outputTokens, nanoAiu};
      yield {type: 'done', text};
    },
  };
  return runtime;
}

let shared: SdkCopilotRuntime | undefined;
let sharedDirectory: string | undefined;
let shutdownBound = false;

/** One client per process. Started on first Copilot use, stopped after 10 idle minutes and on server shutdown. */
export function sharedCopilotRuntime(baseDirectory: string) {
  if (!shared || sharedDirectory !== baseDirectory) {
    const previous = shared;
    sharedDirectory = baseDirectory;
    shared = createSdkCopilotRuntime({baseDirectory});
    if (!shutdownBound) {
      shutdownBound = true;
      onServerShutdown(() => shared?.stop() ?? Promise.resolve());
    }
    if (previous) void previous.stop();
  }
  return shared;
}
