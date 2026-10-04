import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../server/runner.js';
import { createServer, request } from 'node:http';
import { createApiHandler } from '../server/http.js';

const deviceId = 'E5C92F6E-40DC-493C-93B4-469E67193736';

test('a user can discover a prepared simulator through the runner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnt-test-'));
  try {
    const runner = createRunner({ artifactDirectory: directory, execute: async () => ({
      stdout: JSON.stringify({ devices: { 'iOS-17-0': [
        { udid: deviceId, name: 'iPhone 15', state: 'Booted', isAvailable: true },
        { udid: 'unready', name: 'iPhone 16', state: 'Shutdown', isAvailable: true },
      ] } }), stderr: '',
    }) });
    assert.deepEqual(await runner.devices(), [{ id: deviceId, name: 'iPhone 15', runtime: 'iOS-17-0' }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('launch evidence stays unconfirmed until the user verifies the captured app screen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnt-test-'));
  try {
    const runner = createRunner({ artifactDirectory: directory, captureDelayMs: 0, execute: async (_file, args) => {
      if (args.includes('list')) return { stdout: JSON.stringify({ devices: { iOS: [{ udid: deviceId, name: 'iPhone 15', state: 'Booted', isAvailable: true }] } }), stderr: '' };
      if (args.includes('get_app_container')) return { stdout: '/installed/App.app', stderr: '' };
      if (args.includes('screenshot')) { await writeFile(args.at(-1)!, 'fixture screen'); return { stdout: '', stderr: 'Screenshot saved' }; }
      return { stdout: 'com.example.HybridApp: 1234', stderr: '' };
    } });
    const result = await runner.launch({ deviceId, bundleId: 'com.example.HybridApp' });
    assert.equal(result.status, 'awaiting-confirmation');
    assert.equal(result.bundleId, 'com.example.HybridApp');
    assert.match(result.log, /com.example.HybridApp: 1234/);
    assert.equal(await readFile(join(directory, result.id, 'screen.png'), 'utf8'), 'fixture screen');
    assert.equal((await runner.confirm(result.id)).status, 'confirmed');
    assert.equal((await runner.result(result.id)).status, 'confirmed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid bundle identifiers cannot reach simulator commands', async () => {
  const runner = createRunner({ artifactDirectory: tmpdir(), execute: async () => { throw new Error('Unexpected tool invocation'); } });
  await assert.rejects(runner.launch({ deviceId, bundleId: 'com.example.App; touch /tmp/injected' }), /valid bundle identifier/i);
});

test('missing apps produce a retained failure that cannot be confirmed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnt-test-'));
  try {
    const runner = createRunner({ artifactDirectory: directory, execute: async (_file, args) => {
      if (args.includes('list')) return { stdout: JSON.stringify({ devices: { iOS: [{ udid: deviceId, name: 'iPhone 15', state: 'Booted', isAvailable: true }] } }), stderr: '' };
      throw new Error('App is not installed on this simulator.');
    } });
    const result = await runner.launch({ deviceId, bundleId: 'com.example.Missing' });
    assert.equal(result.status, 'failed');
    assert.match((await runner.result(result.id)).log, /not installed/);
    await assert.rejects(runner.confirm(result.id), /no screen awaiting confirmation/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the local HTTP boundary rejects foreign origins and untrusted launch requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnt-http-'));
  const runner = createRunner({ artifactDirectory: directory, execute: async () => ({ stdout: '{"devices":{}}', stderr: '' }) });
  const server = createServer(createApiHandler(runner, directory));
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    const status = await (await fetch(base + '/api/status')).json();
    assert.equal(status.ready, true);
    assert.deepEqual(status.devices, []);
    const foreign = await fetch(base + '/api/launches', { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json', 'X-TnT-Token': status.token }, body: '{}' });
    assert.equal(foreign.status, 403);
    const noToken = await fetch(base + '/api/launches', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noToken.status, 403);
    const invalid = await fetch(base + '/api/launches', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-TnT-Token': status.token }, body: '{"deviceId":"invalid","bundleId":"bad;command"}' });
    assert.equal(invalid.status, 400);
    const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const call = request({ hostname: '127.0.0.1', port: address.port, path: 'http://[', timeout: 1000 }, response => { response.resume(); resolve(response.statusCode); });
      call.on('error', reject);
      call.on('timeout', () => call.destroy(new Error('Malformed request crashed or stalled the runner.')));
      call.end();
    });
    assert.equal(malformedStatus, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
