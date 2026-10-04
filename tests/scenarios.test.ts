import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../server/runner.js';
import { createScenarios } from '../server/scenarios.js';

const deviceId = 'E5C92F6E-40DC-493C-93B4-469E67193736';
const yaml = 'appId: com.example.HybridApp\n---\n- launchApp\n- assertVisible: Home\n';
test('an authored scenario executes an immutable version and exposes mapped results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tnt-scenario-'));
  try {
    const runner = createRunner({ artifactDirectory: join(root, 'launches'), execute: async (_file, args) => ({ stdout: args.includes('list') ? JSON.stringify({ devices: { iOS: [{ udid: deviceId, name: 'iPhone', state: 'Booted', isAvailable: true }] } }) : '/installed/app', stderr: '' }) });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const scenarios = createScenarios({ root, runner, maestro: {
      version: async () => '2.11.0',
      run: async ({ directory }) => {
        await gate;
        await writeFile(join(directory, 'report.xml'), '<testsuites><testsuite tests="1" failures="0"><testcase status="SUCCESS"/></testsuite></testsuites>');
        await writeFile(join(directory, 'commands.json'), JSON.stringify([
          { command: { launchAppCommand: {} }, metadata: { status: 'COMPLETED', depth: 0 } },
          { command: { assertConditionCommand: { condition: { visible: { textRegex: 'Home' } } } }, metadata: { status: 'COMPLETED', depth: 0 } },
        ]));
        return { code: 0, log: 'Flow passed', cleanup: { verified: true, detail: 'Owned process exited.' } };
      },
    } });
    const workspace = await scenarios.save({ name: 'Home', yaml });
    const run = await scenarios.start({ workspaceId: workspace.id, deviceId });
    await scenarios.save({ id: workspace.id, name: 'Edited', yaml: yaml.replace('Home', 'Changed') });
    finish();
    const result = await scenarios.wait(run.id);
    assert.equal(result.status, 'passed');
    assert.equal(result.snapshot.yaml, yaml);
    assert.equal(result.snapshot.name, 'Home');
    assert.deepEqual(result.steps.map(step => step.status), ['passed', 'passed']);
    assert.equal((await scenarios.result(run.id)).snapshot.id, run.snapshot.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed expected assertion retains its evidence while tool failures remain distinct', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tnt-failure-'));
  try {
    const runner = createRunner({ artifactDirectory: root, execute: async (_file, args) => ({ stdout: args.includes('list') ? JSON.stringify({ devices: { iOS: [{ udid: deviceId, name: 'iPhone', state: 'Booted', isAvailable: true }] } }) : '/installed/app', stderr: '' }) });
    const scenarios = createScenarios({ root, runner, maestro: { version: async () => '2.11.0', run: async ({ directory }) => {
      await writeFile(join(directory, 'report.xml'), '<testsuites><testsuite tests="1" failures="1"><testcase status="ERROR"><failure>Home absent</failure></testcase></testsuite></testsuites>');
      await writeFile(join(directory, 'commands.json'), JSON.stringify([
        { command: { launchAppCommand: {} }, metadata: { status: 'COMPLETED', depth: 0 } },
        { command: { assertConditionCommand: { condition: { visible: { textRegex: 'Home' } } } }, metadata: { status: 'FAILED', depth: 0, error: { message: 'Home absent' } } },
      ]));
      await writeFile(join(directory, 'failure.png'), 'fixture screenshot');
      return { code: 1, log: 'Home absent', cleanup: { verified: true, detail: 'Owned process exited.' } };
    } } });
    const workspace = await scenarios.save({ name: 'Home', yaml });
    const run = await scenarios.start({ workspaceId: workspace.id, deviceId });
    const result = await scenarios.wait(run.id);
    assert.equal(result.status, 'assertion-failed');
    assert.deepEqual(result.expectedFailure, { visible: { textRegex: 'Home' } });
    assert.equal(result.steps[1].status, 'failed');
    assert.equal((await scenarios.artifact(run.id, 'failure.png')).toString(), 'fixture screenshot');
    await assert.rejects(scenarios.artifact(run.id, '../workspace.json'), /Unknown/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation holds device ownership through cleanup and prevents app-launch overlap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tnt-cancel-'));
  try {
    const runner = createRunner({ artifactDirectory: root, captureDelayMs: 0, execute: async (_file, args) => ({ stdout: args.includes('list') ? JSON.stringify({ devices: { iOS: [{ udid: deviceId, name: 'iPhone', state: 'Booted', isAvailable: true }] } }) : '/installed/app', stderr: '' }) });
    let clean!: () => void;
    const cleanupGate = new Promise<void>(resolve => { clean = resolve; });
    let cancelled!: () => void;
    const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
    const scenarios = createScenarios({ root, runner, maestro: { version: async () => '2.11.0', run: async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }));
      await cleanupGate;
      return { code: null, log: 'Stopped', cleanup: { verified: true, detail: 'Owned process group stopped.' } };
    } } });
    const workspace = await scenarios.save({ name: 'Home', yaml });
    const run = await scenarios.start({ workspaceId: workspace.id, deviceId });
    const cancelling = scenarios.cancel(run.id);
    await cancellation;
    await assert.rejects(scenarios.start({ workspaceId: workspace.id, deviceId }), /in progress/);
    await assert.rejects(runner.launch({ deviceId, bundleId: 'com.example.HybridApp' }), /in progress/);
    clean();
    const result = await cancelling;
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.cleanup, { verified: true, detail: 'Owned process group stopped.' });
    const release = await runner.acquireDevice(deviceId);
    await release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('two runner instances cannot own the shared simulator at the same time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tnt-owner-'));
  try {
    const options = { artifactDirectory: root, execute: async () => ({ stdout: '', stderr: '' }) };
    const first = createRunner(options);
    const second = createRunner(options);
    const release = await first.acquireDevice(deviceId);
    await assert.rejects(async () => second.acquireDevice(deviceId), /in progress/);
    await release();
    const releaseSecond = await second.acquireDevice(deviceId);
    await releaseSecond();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsafe workspace references are rejected before tool execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tnt-validation-'));
  try {
    const runner = createRunner({ artifactDirectory: root, execute: async () => { throw new Error('Tool must not execute'); } });
    const scenarios = createScenarios({ root, runner, maestro: { version: async () => { throw new Error('Tool must not execute'); }, run: async () => { throw new Error('Tool must not execute'); } } });
    const workspace = await scenarios.save({ name: 'Unsafe flow', yaml: 'appId: com.example.App\n---\n- runFlow: ../../private.yaml\n' });
    await assert.rejects(scenarios.start({ workspaceId: workspace.id, deviceId }), /file references/i);
    await assert.rejects(scenarios.workspace('../../outside'), /identifier/);
    await symlink(tmpdir(), join(root, 'workspaces', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
    await assert.rejects(scenarios.workspace('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), /escapes/);
    await rm(join(root, 'workspaces', workspace.id, 'workspace.json'));
    const outside = join(root, 'outside.json');
    await writeFile(outside, JSON.stringify({ id: workspace.id, name: 'Outside', yaml }));
    await symlink(outside, join(root, 'workspaces', workspace.id, 'workspace.json'));
    await assert.rejects(scenarios.workspace(workspace.id), /escapes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime secrets and their captured visual output are never persisted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tnt-secret-'));
  try {
    const runner = createRunner({ artifactDirectory: root, execute: async (_file, args) => ({ stdout: args.includes('list') ? JSON.stringify({ devices: { iOS: [{ udid: deviceId, name: 'iPhone', state: 'Booted', isAvailable: true }] } }) : '/app', stderr: '' }) });
    const scenarios = createScenarios({ root, runner, maestro: { version: async () => '2.11.0', run: async ({ directory, runtimeInputs }) => {
      assert.equal(runtimeInputs?.PASSWORD, 'never-persist-this');
      await writeFile(join(directory, 'report.xml'), '<testsuites><testsuite tests="1" failures="0"/></testsuites>');
      await writeFile(join(directory, 'commands.json'), '[]');
      await writeFile(join(directory, 'screen.png'), 'visual secret');
      return { code: 0, log: 'never-persist-this', cleanup: { verified: true, detail: 'Owned process exited.' } };
    } } });
    const workspace = await scenarios.save({ name: 'Home', yaml });
    const run = await scenarios.start({ workspaceId: workspace.id, deviceId, runtimeInputs: { PASSWORD: 'never-persist-this' } });
    const result = await scenarios.wait(run.id);
    assert.equal(result.status, 'passed');
    assert.doesNotMatch(JSON.stringify(await scenarios.result(run.id)), /never-persist-this|visual secret/);
    assert.equal(result.artifacts.some(name => name.endsWith('.png') || name.endsWith('commands.json')), false);
    assert.match(result.log, /withheld/i);
    for (const name of result.artifacts) assert.doesNotMatch((await scenarios.artifact(run.id, name)).toString(), /never-persist-this/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unverified process cleanup retains ownership even when its message sounds successful', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tnt-unclean-'));
  try {
    const runner = createRunner({ artifactDirectory: root, execute: async (_file, args) => ({ stdout: args.includes('list') ? JSON.stringify({ devices: { iOS: [{ udid: deviceId, name: 'iPhone', state: 'Booted', isAvailable: true }] } }) : '/app', stderr: '' }) });
    const scenarios = createScenarios({ root, runner, maestro: { version: async () => '2.11.0', run: async () => ({ code: 1, log: 'Driver error', cleanup: { verified: false, detail: 'CLI exited; helper still present.' } }) } });
    const workspace = await scenarios.save({ name: 'Home', yaml });
    const result = await scenarios.wait((await scenarios.start({ workspaceId: workspace.id, deviceId })).id);
    assert.equal(result.cleanup.verified, false);
    await assert.rejects(async () => runner.acquireDevice(deviceId), /in progress/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
