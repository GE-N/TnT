import type {Workspace} from '../scenarios.js';
import type {ScriptTrust} from '../run-script-contract.js';

export const COMPILER_VERSION = 'ai-flow-authoring-1';
export const CONTRACT_VERSION = 1 as const;
export const REQUEST_LIMIT = 256_000;
export const SCRIPT_BYTE_LIMIT = 64_000;
export const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
export const JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CANVAS_SCREEN_LIMIT = 40;
export const CANVAS_EDGE_LIMIT = 80;
export const VISIT_OPERATION_LIMIT = 30;

export type AuthoringProvenance = 'ai' | 'external';

export type ScreenSelector = {target: 'text' | 'id'; match: 'exact' | 'contains' | 'regex'; value: string};

export type DraftTarget =
  | {kind: 'context'; ref: string}
  | {kind: 'selector'; selector: ScreenSelector}
  | {kind: 'unresolved'; description: string};

export type DraftValue =
  | {kind: 'literal'; text: string}
  | {kind: 'parameter'; name: string}
  | {kind: 'unresolved'; description: string};

export type DraftDestination = {kind: 'stay'} | {kind: 'visit'; visitKey: string};

export type DraftOperation =
  | {key: string; kind: 'tap' | 'back'; target: DraftTarget; destination: DraftDestination}
  | {key: string; kind: 'input'; value: DraftValue}
  | {key: string; kind: 'checkVisible' | 'checkAbsent'; target: DraftTarget};

export type FlowDraft = {
  schemaVersion: 1;
  mode: 'createScenario';
  name: string;
  appId: string;
  parameters: {name: string; type: 'text' | 'number' | 'boolean'; required: boolean}[];
  execution: {
    setup: {kind: 'launchApp'} | {kind: 'context'; ref: string};
    handlerRefs: string[];
    mock: {kind: 'none'} | {kind: 'context'; ref: string};
  };
  screens: ({key: string; kind: 'create'; title: string} | {key: string; kind: 'existing'; screenId: string})[];
  visits: {key: string; screenKey: string; operations: DraftOperation[]}[];
  scripts: {
    key: string;
    label: string;
    language: 'maestro-javascript';
    source: string;
    placement: {kind: 'beforeOperation'; visitKey: string; operationKey: string} | {kind: 'scenarioEnd'};
    requires: {parameters: string[]; mockSession: boolean};
  }[];
  assumptions: {key: string; message: string; about: string[]; requiresConfirmation: boolean}[];
};

export type Diagnostic = {
  code: string;
  path: string;
  entityKey?: string;
  severity: 'error' | 'warning' | 'info';
  blocks: ('apply' | 'run')[];
  message: string;
  remedy: string;
};

export type EntityRef = {kind: 'scenario' | 'path' | 'screen' | 'visit' | 'operation' | 'script'; id: string};

export type TimelineEntry =
  | {kind: 'system'; label: string}
  | {kind: 'uiOperation'; visitKey: string; operationKey: string; ordinal: number}
  | {kind: 'runScript'; scriptKey: string; anchorOrdinal: number; atEnd: boolean; trust: 'required'};

export type Preview = {
  previewId: string;
  workspaceId: string;
  baseRevision: number;
  expiresAt: string;
  contractVersion: 1;
  compilerVersion: string;
  draftHash: string;
  applicable: boolean;
  authoringComplete: boolean;
  runReadiness: 'blocked' | 'requires-preflight';
  requiredAssumptionKeys: string[];
  diagnostics: Diagnostic[];
  changes: {created: EntityRef[]; reused: EntityRef[]; updated: EntityRef[]};
  identityMap: Record<string, EntityRef>;
  timeline: TimelineEntry[];
};

export type ApplyResult = {
  workspaceId: string;
  revision: number;
  scenarioId: string;
  pathId: string;
  identityMap: Record<string, EntityRef>;
  runReadiness: Preview['runReadiness'];
  diagnostics: Diagnostic[];
  authoring: AuthoringProvenance;
};

export type ContextTarget = {screenId: string; selector: ScreenSelector; role: 'tap' | 'check' | 'back'};

export type ContextSnapshot = {
  id: string;
  workspaceId: string;
  revision: number;
  expiresAt: number;
  digest: string;
  screenIds?: string[];
  appId: string;
  screens: {screenId: string; title: string}[];
  targets: Record<string, ContextTarget>;
  setups: Record<string, {file: string; parameters: Record<string, string>; parameterNames: string[]; digest: string}>;
  handlers: {ref: string; name: string}[];
  mocks: Record<string, {routeId: string; responseId: string}>;
  publicBody: Record<string, unknown>;
};

export type AuthoringDeps = {
  root: string;
  now?: () => Date;
  read: (id: string) => Promise<Workspace>;
  save: (content: Workspace, expectedRevision: number, beforePublish: (next: Workspace, previous?: Workspace) => Promise<void>) => Promise<Workspace>;
  register: (next: Workspace, previous: Workspace | undefined, origins: Record<string, 'imported'>) => Promise<void>;
  forget: (workspaceId: string, rowIds: readonly string[]) => Promise<void>;
  listTrust: (workspace: Pick<Workspace, 'id' | 'scenarios'>) => Promise<ScriptTrust[]>;
  busy: (workspaceId: string) => boolean;
  faults?: {afterPublish?: () => unknown};
};

export function clock(deps: {now?: () => Date}) {
  return deps.now?.() ?? new Date();
}

export function issue(code: string, path: string, severity: Diagnostic['severity'], blocks: Diagnostic['blocks'], message: string, remedy: string, entityKey?: string): Diagnostic {
  return {code, path, severity, blocks, message, remedy, ...(entityKey ? {entityKey} : {})};
}

export function blocksApply(diagnostics: readonly Diagnostic[]) {
  return diagnostics.some(item => item.blocks.includes('apply'));
}

export function runReadiness(diagnostics: readonly Diagnostic[]): Preview['runReadiness'] {
  const blockers = diagnostics.filter(item => item.blocks.includes('run'));
  if (blockers.length && blockers.some(item => item.code !== 'RUNTIME_INPUT_REQUIRED')) return 'blocked';
  return 'requires-preflight';
}
