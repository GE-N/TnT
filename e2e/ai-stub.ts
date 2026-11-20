import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {SecretStore} from '../server/ai/config.js';
import {createFakeProvider} from '../server/ai/providers/fake.js';
import {COPILOT_NOT_INSTALLED, createFakeCopilotRuntime} from '../server/ai/providers/copilot-runtime.js';

/**
 * Deterministic stand-in for the production AI wiring.
 * Reuses createFakeProvider for flow generation and createFakeCopilotRuntime for status.
 * The saved config selects Copilot so the existing composer treats the provider as ready
 * without an API key. Generation never calls that runtime.
 */
export async function createE2eAiOverrides(root: string) {
  await writeFile(join(root, 'ai-config.json'), JSON.stringify({
    settingsRevision: 1,
    selected: 'copilot',
    providers: {
      openrouter: {model: '', credentialRevision: 0},
      'openai-compatible': {model: '', baseUrl: 'https://api.openai.com/v1', credentialRevision: 0},
      copilot: {model: 'auto'},
    },
  }));
  return {
    dev: false,
    env: {} as NodeJS.ProcessEnv,
    secrets: memorySecrets(),
    copilotRuntime: createFakeCopilotRuntime(
      {kind: 'ok', text: '{"intent":"flow"}'},
      {signedIn: false, message: COPILOT_NOT_INSTALLED},
    ),
    provider: createFakeProvider(({system, messages}) => {
      if (system.startsWith('You route')) return {kind: 'ok', text: JSON.stringify({intent: 'flow'})};
      return {kind: 'ok', text: JSON.stringify(guestCheckout(workspaceAppId(messages)))};
    }),
  };
}

function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  return {
    async get(service) { return values.get(service); },
    async set(service, value) { values.set(service, value); },
    async delete(service) { values.delete(service); },
    async available() { return false; },
  };
}

function workspaceAppId(messages: {content: string}[]) {
  for (const message of messages) {
    const match = /(?:^|\n)appId: ([A-Za-z0-9._-]+)/.exec(message.content);
    if (match?.[1]) return match[1];
  }
  return 'com.example.HybridApp';
}

function guestCheckout(appId: string) {
  return {
    schemaVersion: 1,
    mode: 'createScenario',
    name: 'Guest checkout',
    appId,
    parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens: [
      {key: 'home', kind: 'create', title: 'Home'},
      {key: 'details', kind: 'create', title: 'Details'},
    ],
    visits: [
      {
        key: 'homeVisit',
        screenKey: 'home',
        operations: [
          {key: 'seeHome', kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'id', match: 'exact', value: 'home-title'}}},
          {key: 'openDetails', kind: 'tap', target: {kind: 'selector', selector: {target: 'id', match: 'exact', value: 'open-details'}}, destination: {kind: 'visit', visitKey: 'detailsVisit'}},
        ],
      },
      {
        key: 'detailsVisit',
        screenKey: 'details',
        operations: [
          {key: 'seeDetails', kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'id', match: 'exact', value: 'details-title'}}},
        ],
      },
    ],
    scripts: [],
    assumptions: [],
    questions: [],
  };
}
