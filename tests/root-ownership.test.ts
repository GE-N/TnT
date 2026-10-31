import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireRootOwnership, RootOwnershipError, type ProcessLiveness, type RootGuard } from '../server/root-ownership.js';
import { createWorkspaceStore } from '../server/workspace-store.js';

const staleStart = 'Thu Jan  1 00:00:00 1970';

async function withRoot(work: (root: string) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), 'tnt-root-own-'));
  try { await work(join(parent, '.tnt')); }
  finally { await rm(parent, { recursive: true, force: true }); }
}

function lockPath(root: string) {
  return join(root, 'runner.lock');
}

async function lockText(root: string) {
  return readFile(lockPath(root), 'utf8');
}

/** Stand-in for a knowledge writer: sidecar save, recovery enqueue, and pointer switch all require the guard. */
function mutate(guard: RootGuard | undefined, root: string, kind: 'sidecar' | 'recovery' | 'pointer') {
  if (!guard) throw new Error(`Refusing to ${kind} without root ownership.`);
  guard.assertOwned();
  writeFileSync(join(root, `.${kind}.json`), kind);
}

function owner(pid: number, nonce = randomUUID(), host = hostname(), startedAt = staleStart) {
  return JSON.stringify({ host, pid, startedAt, nonce }) + '\n';
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  assert.equal(typeof child.pid, 'number');
  return child.pid as number;
}

test('exactly one of two same-time acquires owns the root, and the loser gets no guard', async () => {
  await withRoot(async root => {
    const [first, second] = await Promise.allSettled([acquireRootOwnership(root), acquireRootOwnership(root)]);
    const won = [first, second].filter(result => result.status === 'fulfilled');
    const lost = [first, second].filter(result => result.status === 'rejected');
    try {
      assert.equal(won.length, 1);
      assert.equal(lost.length, 1);
      assert.ok(lost[0].status === 'rejected');
      assert.ok(lost[0].reason instanceof RootOwnershipError);
      const guard = won[0].status === 'fulfilled' ? won[0].value.guard : undefined;
      mutate(guard, root, 'sidecar');
      mutate(guard, root, 'recovery');
      mutate(guard, root, 'pointer');
      assert.equal(await readFile(join(root, '.sidecar.json'), 'utf8'), 'sidecar');
      for (const kind of ['sidecar', 'recovery', 'pointer'] as const) {
        assert.throws(() => mutate(undefined, root, kind), new RegExp(`Refusing to ${kind} without root ownership`));
      }
      assert.equal((await readdir(root)).includes('.sidecar.json'), true);
    } finally {
      if (won[0]?.status === 'fulfilled') await won[0].value.release();
    }
  });
});

test('eight racers against a stale lock produce one owner and no leftover recovery file', async () => {
  await withRoot(async root => {
    const stalePid = 424242;
    const startedAt = 'Fri Oct 30 23:00:00 2026';
    const inspect = async (pid: number): Promise<ProcessLiveness> => {
      if (pid === process.pid) return { state: 'alive', startedAt };
      if (pid === stalePid) return { state: 'dead' };
      return { state: 'unknown', reason: 'unexpected pid' };
    };
    await mkdir(root, { recursive: true });
    await writeFile(lockPath(root), owner(stalePid));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireRootOwnership(root, {
      inspectProcess: inspect,
      identity: { startedAt },
    })));
    const won = results.filter(result => result.status === 'fulfilled');
    try {
      assert.equal(won.length, 1);
      assert.equal(results.filter(result => result.status === 'rejected').length, 7);
      for (const result of results) {
        if (result.status === 'rejected') assert.ok(result.reason instanceof RootOwnershipError);
      }
      const held = won[0].status === 'fulfilled' ? won[0].value : undefined;
      held?.guard.assertOwned();
      assert.throws(() => mutate(undefined, root, 'recovery'), /without root ownership/);
      assert.throws(() => mutate(undefined, root, 'pointer'), /without root ownership/);
      const names = await readdir(root);
      assert.equal(names.includes('runner.lock'), true);
      assert.equal(names.some(name => name.includes('recover') || name.includes('aside')), false);
      const record = JSON.parse(await lockText(root)) as { pid: number; nonce: string };
      assert.equal(record.pid, process.pid);
    } finally {
      if (won[0]?.status === 'fulfilled') await won[0].value.release();
    }
  });
});

test('a second acquire refuses a live owner and does not replace the lock', async () => {
  await withRoot(async root => {
    const held = await acquireRootOwnership(root);
    try {
      const before = await lockText(root);
      await assert.rejects(acquireRootOwnership(root), (error: unknown) => {
        assert.ok(error instanceof RootOwnershipError);
        assert.equal(error.code, 'live-owner');
        assert.match(error.message, new RegExp(`pid ${process.pid}`));
        assert.match(error.message, /Stop that runner/);
        return true;
      });
      assert.equal(await lockText(root), before);
      held.guard.assertOwned();
    } finally { await held.release(); }
  });
});

test('a dead owner is recovered, and a reused pid with a different start time is recovered', async () => {
  await withRoot(async root => {
    const first = await acquireRootOwnership(root);
    const original = JSON.parse(await lockText(root)) as { startedAt: string };
    await first.release();
    assert.throws(() => first.guard.assertOwned(), /no longer owns/);
    assert.throws(() => mutate(first.guard, root, 'pointer'), /no longer owns/);

    await mkdir(root, { recursive: true });
    await writeFile(lockPath(root), owner(await deadPid()));
    const recovered = await acquireRootOwnership(root);
    try {
      recovered.guard.assertOwned();
      const record = JSON.parse(await lockText(root)) as { pid: number; startedAt: string; nonce: string };
      assert.equal(record.pid, process.pid);
      assert.equal(record.startedAt, original.startedAt);
      assert.notEqual(record.startedAt, staleStart);
    } finally { await recovered.release(); }

    await writeFile(lockPath(root), owner(process.pid, randomUUID(), hostname(), staleStart));
    const reused = await acquireRootOwnership(root);
    try {
      const record = JSON.parse(await lockText(root)) as { pid: number; startedAt: string };
      assert.equal(record.pid, process.pid);
      assert.equal(record.startedAt, original.startedAt);
      reused.guard.assertOwned();
      mutate(reused.guard, root, 'sidecar');
    } finally { await reused.release(); }
  });
});

test('release drops the lock so a later acquire can own the root', async () => {
  await withRoot(async root => {
    const first = await acquireRootOwnership(root);
    const firstNonce = JSON.parse(await lockText(root)).nonce as string;
    await first.release();
    await first.release();
    await assert.rejects(access(lockPath(root)), { code: 'ENOENT' });
    assert.throws(() => first.guard.assertOwned(), /no longer owns/);
    const second = await acquireRootOwnership(root);
    try {
      const secondNonce = JSON.parse(await lockText(root)).nonce as string;
      assert.notEqual(secondNonce, firstNonce);
      second.guard.assertOwned();
      assert.throws(() => mutate(first.guard, root, 'sidecar'), /no longer owns/);
      mutate(second.guard, root, 'sidecar');
    } finally { await second.release(); }
  });
});

test('a replaced nonce means ownership was lost', async () => {
  await withRoot(async root => {
    const held = await acquireRootOwnership(root);
    try {
      const record = JSON.parse(await lockText(root)) as { host: string; pid: number; startedAt: string; nonce: string };
      await writeFile(lockPath(root), JSON.stringify({ ...record, nonce: randomUUID() }) + '\n');
      assert.throws(() => held.guard.assertOwned(), (error: unknown) => {
        assert.ok(error instanceof RootOwnershipError);
        assert.match((error as RootOwnershipError).message, /no longer owns/);
        return true;
      });
      assert.throws(() => mutate(held.guard, root, 'pointer'), /no longer owns/);
      assert.equal((await readdir(root)).includes('.pointer.json'), false);
    } finally { await held.release(); }
  });
});

test('partial, corrupt, other-host, and unreadable locks are not taken', async () => {
  await withRoot(async root => {
    await mkdir(root, { recursive: true });
    const cases = ['', '{', '{"host":"only"', owner(1).replace('"nonce":"', '"nonce":"not-a-uuid","x":"')];
    for (const partial of cases) {
      await writeFile(lockPath(root), partial);
      await assert.rejects(acquireRootOwnership(root), (error: unknown) => {
        assert.ok(error instanceof RootOwnershipError);
        assert.equal(error.code, 'uncertain-owner');
        assert.match(error.message, /incomplete or unreadable/);
        return true;
      });
      assert.equal(await lockText(root), partial);
    }

    const foreign = owner(await deadPid(), randomUUID(), 'other-host.example');
    await writeFile(lockPath(root), foreign);
    await assert.rejects(acquireRootOwnership(root), (error: unknown) => {
      assert.ok(error instanceof RootOwnershipError);
      assert.equal(error.code, 'uncertain-owner');
      assert.match(error.message, /other-host\.example/);
      assert.match(error.message, /will not take another machine's lock/);
      return true;
    });
    assert.equal(await lockText(root), foreign);

    const unknown = owner(99);
    await writeFile(lockPath(root), unknown);
    await assert.rejects(acquireRootOwnership(root, {
      identity: { startedAt: 'Fri Oct 30 23:00:01 2026' },
      inspectProcess: async () => ({ state: 'unknown', reason: 'ps failed' }),
    }), (error: unknown) => {
      assert.ok(error instanceof RootOwnershipError);
      assert.equal(error.code, 'uncertain-owner');
      assert.match(error.message, /Cannot tell whether pid 99/);
      return true;
    });
    assert.equal(await lockText(root), unknown);

    await rm(lockPath(root));
    await symlink(join(root, '..', 'outside-lock'), lockPath(root));
    await writeFile(join(root, '..', 'outside-lock'), 'keep');
    await assert.rejects(acquireRootOwnership(root), /incomplete or unreadable/);
    assert.equal(await readFile(join(root, '..', 'outside-lock'), 'utf8'), 'keep');
  });
});

test('a symlinked root and a non-directory root are refused', async () => {
  await withRoot(async root => {
    const parent = join(root, '..');
    const outside = join(parent, 'outside');
    const link = join(parent, 'linked-root');
    await mkdir(outside);
    await symlink(outside, link);
    await assert.rejects(acquireRootOwnership(link), /symlinked workspace root/);
    assert.deepEqual(await readdir(outside), []);
    const file = join(parent, 'not-a-directory');
    await writeFile(file, 'x');
    await assert.rejects(acquireRootOwnership(file), /must be a directory/);
  });
});

async function freePort() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function startServer(cwd: string, port: number, signal: AbortSignal) {
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../server/main.ts', import.meta.url).pathname, '--production'], {
    cwd, env: { ...process.env, PORT: String(port) }, signal, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitUntilListening(child: ChildProcess, output: () => { stdout: string; stderr: string }) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not listen\n' + JSON.stringify(output()))), 20_000);
    const onExit = () => {
      clearTimeout(timer);
      reject(new Error('Server exited before listening: ' + JSON.stringify(output())));
    };
    const onData = () => {
      if (!output().stdout.includes('TnT workbench:')) return;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve();
    };
    child.stdout!.on('data', onData);
    child.once('exit', onExit);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    onData();
  });
}

async function stopServer(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  await closed;
}

test('a second production server refuses the same root, sweeps nothing, and a restart can acquire after release', { timeout: 60_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tnt-root-server-'));
  const root = join(cwd, '.tnt');
  let first: ChildProcess | undefined;
  let third: ChildProcess | undefined;
  try {
    const primary = startServer(cwd, await freePort(), t.signal);
    first = primary.child;
    await waitUntilListening(first, primary.output);
    const late = join(root, 'runs', 'interrupted-late');
    await mkdir(late, { recursive: true });
    await writeFile(join(late, '.tnt-execution.yaml'), 'do-not-sweep');
    const before = await lockText(root);
    assert.match(before, new RegExp(`"pid":${first.pid}`));

    const loser = startServer(cwd, await freePort(), t.signal);
    const exited = once(loser.child, 'exit');
    const [code] = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Second server hung\n' + JSON.stringify(loser.output()))), 15_000)),
    ]) as [number | null];
    const loserOutput = loser.output();
    assert.notEqual(code, 0);
    assert.match(loserOutput.stderr, /Another TnT runner already owns this workspace root/);
    assert.match(loserOutput.stderr, new RegExp(`pid ${first.pid}`));
    assert.doesNotMatch(loserOutput.stdout, /TnT workbench:/);
    assert.equal(await lockText(root), before);
    assert.equal(await readFile(join(late, '.tnt-execution.yaml'), 'utf8'), 'do-not-sweep');

    await stopServer(first);
    first = undefined;
    await assert.rejects(access(lockPath(root)), { code: 'ENOENT' });

    const restarted = startServer(cwd, await freePort(), t.signal);
    third = restarted.child;
    await waitUntilListening(third, restarted.output);
    assert.match(await lockText(root), new RegExp(`"pid":${third.pid}`));
    // The new owner is allowed to sweep. The loser above was not.
    await assert.rejects(access(join(late, '.tnt-execution.yaml')), { code: 'ENOENT' });
  } finally {
    await stopServer(first);
    await stopServer(third);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('production knowledge uses the held root guard and the standalone renderer', { timeout: 60_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tnt-root-knowledge-'));
  const root = join(cwd, '.tnt');
  const store = createWorkspaceStore(root, workspace => workspace);
  const workspace = await store.save({ id: '', name: 'Guarded knowledge', yaml: 'appId: example.App\n---\n- launchApp\n', scenarios: [{ id: 'one', name: 'One', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: [] }] });
  let child: ChildProcess | undefined;
  try {
    const port = await freePort();
    const started = startServer(cwd, port, t.signal);
    child = started.child;
    await waitUntilListening(child, started.output);
    const base = `http://127.0.0.1:${port}`;
    const token = (await (await fetch(base + '/api/status')).json()).token as string;
    const path = `/api/knowledge/workspaces/${workspace.id}/scenarios/one/context`;
    const context = { purpose: 'Open the directory', expectedOutcome: 'Directory visible', rationale: 'Find a person', preconditions: '', exceptions: '', scope: '' };
    const save = (revision: number, purpose = context.purpose) => fetch(base + path, { method: 'PUT', headers: { origin: base, 'x-tnt-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ expectedContextRevision: revision, context: { ...context, purpose } }) });
    assert.equal((await save(0)).status, 200);
    const reader = base + `/knowledge/workspaces/${workspace.id}/`;
    let html = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      html = await (await fetch(reader)).text();
      if (html.includes('Up to date')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(html, /Up to date/);
    assert.match(html, /Why this flow exists/);
    assert.match(html, /Open the directory/);
    const sidecar = join(root, 'workspaces', workspace.id, 'knowledge', 'scenarios', 'one.json');
    const pointer = join(root, 'knowledge', 'current', `workspace-${workspace.id}.json`);
    const beforeContext = await readFile(sidecar, 'utf8');
    const beforePointer = await readFile(pointer, 'utf8');
    const lock = JSON.parse(await lockText(root));
    await writeFile(lockPath(root), JSON.stringify({ ...lock, nonce: randomUUID() }));
    const rejected = await save(1, 'Must not be written');
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).code, 'KNOWLEDGE_UNAVAILABLE');
    assert.equal(await readFile(sidecar, 'utf8'), beforeContext);
    assert.equal(await readFile(pointer, 'utf8'), beforePointer);
  } finally {
    await stopServer(child);
    await rm(cwd, { recursive: true, force: true });
  }
});
