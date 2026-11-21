import {expect, test as base, type APIRequestContext, type Page} from '@playwright/test';
import {spawn, type ChildProcess} from 'node:child_process';
import {access, mkdtemp, rm, symlink} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

const yaml = 'appId: com.example.HybridApp\n---\n- launchApp\n';

type Screen = {id: string; title: string; x: number; y: number; tests: []};
type Edge = {id: string; from: string; to: string; actionTestId: string; assertionTestId: string; responseCondition: string};

export const test = base.extend<{workbench: string}>({
  workbench: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'tnt-e2e-'));
    await access(join(repo, 'dist', 'index.html'));
    await symlink(join(repo, 'dist'), join(dir, 'dist'));
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {...process.env, PORT: String(port), TNT_E2E_STUB: '1'};
    delete env.TNT_LIVE_COPILOT;
    delete env.TNT_PROVIDER_SMOKE_KEY;
    delete env.TNT_AI_API_KEY;
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(repo, 'server/main.ts'), '--production'], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk.toString(); });
    child.stderr?.on('data', chunk => { output += chunk.toString(); });
    try {
      await waitForReady(child, () => output);
      await use(`http://127.0.0.1:${port}`);
    } finally {
      await stop(child);
      await rm(dir, {recursive: true, force: true});
    }
  },
});

export {expect};

export async function openApp(page: Page, url: string) {
  const status = page.waitForResponse(response => response.url().includes('/api/status') && response.ok());
  await page.goto(url);
  await status;
  await expect(page.locator('.canvas-viewport')).toBeVisible();
}

export async function askGuestCheckout(page: Page) {
  const field = page.getByTestId('ai-flow-field');
  await field.fill('Add a Home screen that taps Open details and opens the Details screen');
  await field.press('Enter');
  await expect(page.getByTestId('ai-disclosure-continue')).toBeVisible();
  await page.getByTestId('ai-disclosure-continue').click();
  await expect(page.getByTestId('ai-flow')).toHaveAttribute('data-ai-status', 'pending');
  await page.getByTestId('ai-confirm').click();
  await expect(page.getByRole('article', {name: 'Screen Home'})).toBeVisible();
  await expect(page.getByRole('article', {name: 'Screen Details'})).toBeVisible();
  await expect(page.getByRole('img', {name: 'Connection Home to Details'})).toBeVisible();
  await expect(page.getByTestId('sequence-scenario-name')).toHaveText('Guest checkout');
}

export async function seedWorkspace(request: APIRequestContext, base: string, input: {name: string; screens: Screen[]; edges: Edge[]; paths: {id: string; name: string; scenarioId: string; screenId: string; edgeIds: string[]}[]; scenarios: {id: string; name: string; pathId: string}[]}) {
  const status = await request.get(base + '/api/status');
  expect(status.ok()).toBeTruthy();
  const {token} = await status.json() as {token: string};
  const headers = {Origin: base, 'X-TnT-Token': token};
  const saved = await request.post(base + '/api/workspaces', {
    headers,
    data: {
      name: input.name,
      yaml,
      flows: {},
      canvas: {screens: input.screens, edges: input.edges, paths: input.paths},
      scenarios: input.scenarios.map(item => ({
        id: item.id,
        name: item.name,
        authoring: 'canvas',
        pathId: item.pathId,
        steps: [],
        inputs: {},
        parameters: {},
        enabledHandlerIds: [],
      })),
    },
  });
  if (!saved.ok()) throw new Error(`Could not save the workspace (${saved.status()}): ${await saved.text()}`);
  const workspace = await saved.json() as {id: string};
  const view = await request.post(`${base}/api/workspaces/${workspace.id}/view`, {
    headers,
    data: {format: 1, canvas: {zoom: 0.5, scrollLeft: 0, scrollTop: 0}},
  });
  if (!view.ok()) throw new Error(`Could not save the canvas view (${view.status()}): ${await view.text()}`);
}

function screen(id: string, title: string, x: number, y: number): Screen {
  return {id, title, x, y, tests: []};
}

function edge(id: string, from: string, to: string, responseCondition: string): Edge {
  return {id, from, to, actionTestId: id + '-action', assertionTestId: id + '-check', responseCondition};
}

export function edgeRegressionWorkspace() {
  return {
    name: 'Edge regression',
    screens: [screen('home', 'Home', 40, 40), screen('details', 'Details', 520, 40), screen('only', 'Only for dropped', 520, 360)],
    edges: [edge('shared-edge', 'home', 'details', 'Shared'), edge('exclusive-edge', 'home', 'only', 'Only this path')],
    paths: [
      {id: 'path-shared', name: 'Shared path', scenarioId: 'shared', screenId: 'home', edgeIds: ['shared-edge']},
      {id: 'path-dropped', name: 'Dropped path', scenarioId: 'dropped', screenId: 'home', edgeIds: ['shared-edge', 'exclusive-edge']},
    ],
    scenarios: [
      {id: 'shared', name: 'Shared path', pathId: 'path-shared'},
      {id: 'dropped', name: 'Only for dropped', pathId: 'path-dropped'},
    ],
  };
}

export function unusedConnectionsWorkspace() {
  return {
    name: 'Unused connections',
    screens: [screen('home', 'Home', 40, 40), screen('details', 'Details', 520, 40), screen('profile', 'Profile', 40, 360)],
    edges: [edge('kept-edge', 'home', 'details', 'Open details'), edge('leftover-edge', 'home', 'profile', 'Open profile')],
    paths: [
      {id: 'path-kept', name: 'Kept path', scenarioId: 'kept', screenId: 'home', edgeIds: ['kept-edge']},
    ],
    scenarios: [
      {id: 'kept', name: 'Kept path', pathId: 'path-kept'},
    ],
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a port.');
  const {port} = address;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForReady(child: ChildProcess, output: () => string) {
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The production server did not listen.\n' + output())), 20_000);
    const watch = () => {
      if (output().includes('TnT workbench:')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', watch);
    child.stderr?.on('data', watch);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`The production server exited (${code}) before listening.\n` + output()));
    });
    watch();
  });
  await ready;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
}
