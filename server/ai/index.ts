import {createAiConfig, type AiPublicConfig, type AiTestResult, type SecretStore} from './config.js';
import {createJobs, realScheduler, type Scheduler, type Timeouts} from './job.js';
import type {AiModelInfo, ProviderId} from './probe.js';
import type {FlowModelProvider} from './providers/types.js';
import {createJobStore, type GenerationView} from './store.js';
import type {Preview} from '../authoring/types.js';

export type {GenerationView};

export type AiService = {
  ready: Promise<void>;
  idle(): Promise<void>;
  start(input: unknown): Promise<GenerationView>;
  get(id: string): Promise<GenerationView>;
  cancel(id: string): Promise<GenerationView>;
  getConfig(): Promise<AiPublicConfig>;
  putConfig(input: unknown): Promise<AiPublicConfig>;
  testConnection(input: unknown): Promise<AiTestResult>;
  listModels(provider: string | null): Promise<{provider: ProviderId; models: AiModelInfo[]}>;
};

export function createAi(deps: {
  root: string;
  authoring: {context(input: unknown, topKeys?: string[]): Promise<unknown>; preview(input: unknown, topKeys?: string[]): Promise<Preview>};
  readWorkspace: (id: string) => Promise<{yaml: string}>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  dev?: boolean;
  secrets?: SecretStore;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  provider?: FlowModelProvider;
  scheduler?: Scheduler;
  timeouts?: Partial<Timeouts>;
}): AiService {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => { console.info(line); });
  const config = createAiConfig({root: deps.root, env: deps.env, dev: deps.dev, secrets: deps.secrets, fetch: deps.fetch, log, now: () => now().getTime()});
  const jobs = createJobs({
    authoring: deps.authoring,
    readWorkspace: deps.readWorkspace,
    store: createJobStore(deps.root),
    now, log, scheduler: deps.scheduler ?? realScheduler(), timeouts: deps.timeouts,
    settingsRevision: () => config.settingsRevision(),
    resolveProvider: () => deps.provider
      ? Promise.resolve({provider: deps.provider, model: deps.provider.id, providerId: deps.provider.id})
      : config.connect(),
  });
  return {
    ready: jobs.ready,
    idle: () => jobs.idle(),
    start: input => jobs.start(input),
    get: id => jobs.get(id),
    cancel: id => jobs.cancel(id),
    getConfig: () => config.get(),
    putConfig: input => config.put(input),
    testConnection: input => config.testConnection(input),
    listModels: provider => config.listModels(provider),
  };
}
