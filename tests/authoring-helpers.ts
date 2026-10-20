import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createRunner} from '../server/runner.js';
import {createScenarios, type Maestro} from '../server/scenarios.js';
import type {WorkspaceStoreFaults} from '../server/workspace-store.js';
import {deviceId} from './run-script-helpers.js';

export const exampleDraft = JSON.parse(readFileSync(new URL('../docs/contracts/ai-flow-v1/repeated-visits-with-scripts.json', import.meta.url), 'utf8'));
export const proofYaml = 'appId: com.example.TnTProof\n---\n- launchApp\n';

export async function authoringFixture(options: {faults?: WorkspaceStoreFaults; run?: Maestro['run']; yaml?: string; now?: () => Date} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tnt-authoring-'));
  const runner = createRunner({artifactDirectory: root, execute: async (_file, args) => ({stdout: args.includes('list') ? JSON.stringify({devices: {iOS: [{udid: deviceId, name: 'iPhone', state: 'Booted', isAvailable: true}]}}) : '/installed/app', stderr: ''})});
  const service = createScenarios({
    root, trustDirectory: join(root, 'trust'), now: options.now, faults: options.faults, runner,
    maestro: {version: async () => '2.11.0', run: options.run ?? (async () => { throw new Error('Authoring tests must not execute Maestro.'); })},
  });
  const workspace = await service.save({name: 'Authoring', yaml: options.yaml ?? proofYaml, flows: {}, scenarios: [], canvas: {screens: [], edges: [], paths: []}});
  return {root, service, workspace, cleanup: () => rm(root, {recursive: true, force: true})};
}

export function contentOf(workspace: {metadata?: unknown; canvasDiagnostics?: unknown; [key: string]: unknown}) {
  const {metadata, canvasDiagnostics, ...content} = workspace;
  void metadata; void canvasDiagnostics;
  return content;
}
