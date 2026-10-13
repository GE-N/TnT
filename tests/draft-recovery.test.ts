import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createScenarios } from '../server/scenarios.js';
import { createRunner } from '../server/runner.js';
import { DraftConflict, WorkspacePayloadTooLarge, createWriteFaults } from '../server/workspace-store.js';

const yaml = 'appId: com.example.App\n---\n- launchApp\n';
const deviceId = 'E5C92F6E-40DC-493C-93B4-469E67193736';
const draftBody = (base: number, expected: number, contentYaml = yaml, fields: Record<string, string> = {}) => ({ baseRevision: base, expectedDraftRevision: expected, name: 'Drafted', content: { yaml: contentYaml, flows: {}, canvas: { screens: [], edges: [], paths: [] }, scenarios: [], automation: undefined, mock: undefined }, fields });

async function fixture(extra?: { faults?: ReturnType<typeof createWriteFaults>['faults']; now?: () => Date; maestro?: { version: () => Promise<string>; run: (input: { directory: string; flow: string }) => Promise<{ code: number | null; log: string; cleanup: { verified: boolean; detail: string } }> } }) {
  const root = await mkdtemp(join(tmpdir(), 'tnt-draft-'));
  const service = createScenarios({
    root,
    faults: extra?.faults,
    now: extra?.now,
    runner: createRunner({
      artifactDirectory: root,
      execute: async () => {
        throw new Error('Must not execute');
      }
    }),
    maestro: extra?.maestro ?? {
      version: async () => '',
      run: async () => {
        throw new Error('Must not execute');
      }
    }
  });
  return { root, service, close: () => rm(root, { recursive: true, force: true }) };
}
async function tempFiles(root: string) {
  const found: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.includes('.tmp')) found.push(path);
    }
  }
  await walk(root);
  return found;
}

test('a restarted store reopens an incomplete draft beside the last valid workspace', async () => {
  const { root, service, close } = await fixture();
  try {
    const saved = await service.save({ name: 'Durable', yaml });
    const incomplete = 'appId: com.example.App\n---\n- tapOn: *missing\n';
    const draft = await service.saveDraft(saved.id, draftBody(saved.metadata!.revision, 0, incomplete, { 'yaml-command': 'unapplied', 'scenario-inputs:alpha': '{"PAGE":"Home"}' }));
    assert.equal(draft.draftRevision, 1);
    assert.equal((await service.workspace(saved.id)).yaml, yaml);
    const reopened = createScenarios({
      root,
      runner: createRunner({
        artifactDirectory: root,
        execute: async () => {
          throw new Error('Must not execute');
        }
      }),
      maestro: {
        version: async () => '',
        run: async () => {
          throw new Error('Must not execute');
        }
      }
    });
    const detail = await reopened.workspaceDetail(saved.id);
    assert.equal(detail.draft?.content.yaml, incomplete);
    assert.equal(detail.draft?.fields['yaml-command'], 'unapplied');
    assert.equal(detail.yaml, yaml);
    assert.equal((await reopened.listWorkspaces()).items[0].hasDraft, true);
  } finally {
    await close();
  }
});

test('a write that fails before rename leaves the previous draft, view, and session in place', async () => {
  const faults = createWriteFaults();
  const { root, service, close } = await fixture({ faults: faults.faults });
  try {
    const saved = await service.save({ name: 'Atomic', yaml });
    await service.saveDraft(saved.id, draftBody(1, 0));
    await service.saveView(saved.id, { scenarioId: 'kept', format: 1 });
    await service.setSession(saved.id);
    const before = await readFile(join(root, 'workspaces', saved.id, 'draft.json'), 'utf8');
    faults.failBeforeRename();
    await assert.rejects(service.saveDraft(saved.id, draftBody(1, 1, 'appId: com.example.App\n---\n- tapOn: Next\n')), /before rename/);
    await assert.rejects(service.saveView(saved.id, { scenarioId: 'lost' }), /before rename/);
    await assert.rejects(service.setSession(null), /before rename/);
    assert.equal(await readFile(join(root, 'workspaces', saved.id, 'draft.json'), 'utf8'), before);
    assert.equal(JSON.parse(await readFile(join(root, 'workspaces', saved.id, 'view.json'), 'utf8')).scenarioId, 'kept');
    assert.equal(JSON.parse(await readFile(join(root, 'session.json'), 'utf8')).lastActiveId, saved.id);
    assert.deepEqual(await tempFiles(root), [], 'no *.tmp file remains after a write fails before rename');
  } finally {
    faults.pass();
    await close();
  }
});

test('stale draft revisions conflict and a parallel pair cannot silently drop either write', async () => {
  const { service, close } = await fixture();
  try {
    const saved = await service.save({ name: 'Shared', yaml });
    const pair = await Promise.allSettled([service.saveDraft(saved.id, draftBody(1, 0, yaml, { 'yaml-command': 'one' })), service.saveDraft(saved.id, draftBody(1, 0, yaml, { 'yaml-command': 'two' }))]);
    assert.equal(pair.filter(item => item.status === 'fulfilled').length, 1);
    assert.ok(pair.some(item => item.status === 'rejected' && item.reason instanceof DraftConflict));
    const kept = (await service.workspaceDetail(saved.id)).draft!;
    assert.equal(kept.draftRevision, 1);
    assert.ok(kept.fields['yaml-command'] === 'one' || kept.fields['yaml-command'] === 'two');
    await assert.rejects(service.saveDraft(saved.id, draftBody(0, 1)), DraftConflict);
    await service.save({ ...saved, name: 'Newer saved' });
    await assert.rejects(service.saveDraft(saved.id, draftBody(1, 1)), DraftConflict);
    assert.equal((await service.workspaceDetail(saved.id)).draft?.draftRevision, 1);
  } finally {
    await close();
  }
});

test('a valid save clears only the draft revision it was given', async () => {
  const faults = createWriteFaults();
  const { service, close } = await fixture({ faults: faults.faults });
  try {
    const saved = await service.save({ name: 'Clearing', yaml });
    let expected = 0;
    for (let revision = 1; revision <= 5; revision++) {
      await service.saveDraft(saved.id, draftBody(1, expected));
      expected = revision;
    }
    faults.queue();
    const newer = service.saveDraft(saved.id, draftBody(1, 5, 'appId: com.example.App\n---\n- tapOn: Newer\n'));
    await faults.untilQueued();
    const saving = service.save({ ...saved, yaml, clearDraft: 5 });
    faults.release();
    await newer;
    await saving;
    const detail = await service.workspaceDetail(saved.id);
    assert.equal(detail.draft?.draftRevision, 6);
    assert.match(String(detail.draft?.content.yaml), /Newer/);
    await service.save({ ...detail, clearDraft: 6 });
    assert.equal((await service.workspaceDetail(saved.id)).draft, null);
  } finally {
    faults.pass();
    await close();
  }
});

test('a draft created after Keep saved version is numbered above the dismissed revision, even after the file was cleared', async () => {
  const { service, close } = await fixture();
  try {
    const saved = await service.save({ name: 'Dismissed', yaml });
    const first = await service.saveDraft(saved.id, draftBody(1, 0, 'appId: com.example.App\n---\n- tapOn: *missing\n'));
    assert.equal(first.draftRevision, 1);
    await service.saveView(saved.id, { dismissedDraftRevision: 1 });
    const newer = await service.saveDraft(saved.id, draftBody(1, 1, 'appId: com.example.App\n---\n- tapOn: *later\n'));
    assert.equal(newer.draftRevision, 2);
    const cleared = await service.save({ ...saved, clearDraft: newer.draftRevision });
    assert.equal((await service.workspaceDetail(saved.id)).draft, null);
    const recreated = await service.saveDraft(saved.id, draftBody(cleared.metadata!.revision, 0, 'appId: com.example.App\n---\n- tapOn: *after-clear\n'));
    assert.equal(recreated.draftRevision, 3);
    const detail = await service.workspaceDetail(saved.id);
    assert.equal(detail.view?.dismissedDraftRevision, 1);
    assert.equal(detail.view?.allocatedDraftRevision, 3);
    assert.ok(detail.draft!.draftRevision > (detail.view?.dismissedDraftRevision ?? 0));
    const rewind = (await service.saveView(saved.id, { allocatedDraftRevision: 1, scenarioId: 'kept' })) as { allocatedDraftRevision?: number; dismissedDraftRevision?: number; scenarioId?: string };
    assert.equal(rewind.allocatedDraftRevision, 3);
    assert.equal(rewind.dismissedDraftRevision, 1);
    assert.equal(rewind.scenarioId, 'kept');
    await assert.rejects(service.saveDraft(saved.id, draftBody(cleared.metadata!.revision, 0)), DraftConflict);
  } finally {
    await close();
  }
});

test('unknown draft fields and confidential sentinels are rejected before any record is written', async () => {
  const { root, service, close } = await fixture();
  try {
    const saved = await service.save({ name: 'Allowlist', yaml });
    await assert.rejects(service.saveDraft(saved.id, { ...draftBody(1, 0), fields: { password: 'super-secret-sentinel' } }), /Unknown draft field/);
    await assert.rejects(service.saveDraft(saved.id, { ...draftBody(1, 0), fields: { running: 'RUNNING_SENTINEL' } }), /Unknown draft field/);
    const tree: string[] = [];
    async function walk(directory: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else tree.push(await readFile(path, 'utf8'));
      }
    }
    await walk(root);
    assert.ok(tree.every(file => !file.includes('super-secret-sentinel') && !file.includes('RUNNING_SENTINEL')));
  } finally {
    await close();
  }
});

test('execution reads workspace.json while a newer invalid draft is present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tnt-draft-run-'));
  let executed = '';
  try {
    const service = createScenarios({
      root,
      runner: createRunner({ artifactDirectory: root, execute: async (_file, args) => ({ stdout: args.includes('list') ? JSON.stringify({ devices: { iOS: [{ udid: deviceId, name: 'iPhone', state: 'Booted', isAvailable: true }] } }) : '/app', stderr: '' }) }),
      maestro: {
        version: async () => '2.11.0',
        run: async ({ flow }) => {
          executed = await readFile(flow, 'utf8');
          return { code: 0, log: 'Fixture', cleanup: { verified: true, detail: 'Fixture process exited' } };
        }
      }
    });
    const saved = await service.save({ name: 'Runnable', yaml });
    const before = await readFile(join(root, 'workspaces', saved.id, 'workspace.json'));
    await service.saveDraft(saved.id, draftBody(1, 0, 'appId: com.example.App\n---\n- tapOn: *missing\n'));
    assert.deepEqual(await readFile(join(root, 'workspaces', saved.id, 'workspace.json')), before);
    const run = await service.wait((await service.start({ workspaceId: saved.id, deviceId })).id);
    assert.equal(run.snapshot.yaml, yaml);
    assert.match(executed, /launchApp/);
    assert.doesNotMatch(executed, /missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unreadable draft stays beside a readable workspace until an explicit discard', async () => {
  const { root, service, close } = await fixture();
  try {
    const saved = await service.save({ name: 'Readable', yaml });
    await writeFile(join(root, 'workspaces', saved.id, 'draft.json'), '{');
    const detail = await service.workspaceDetail(saved.id);
    assert.equal(detail.draft, null);
    assert.match(detail.draftError ?? '', /could not be read/);
    assert.equal(detail.yaml, yaml);
    await assert.rejects(service.saveDraft(saved.id, draftBody(1, 0)), /Discard it/);
    await service.discardDraft(saved.id, 0);
    assert.equal((await service.workspaceDetail(saved.id)).draftError, undefined);
  } finally {
    await close();
  }
});

test('drafts do not expire when the store clock jumps', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const { service, close } = await fixture({ now: () => now });
  try {
    const saved = await service.save({ name: 'Kept', yaml });
    const draft = await service.saveDraft(saved.id, draftBody(1, 0));
    now = new Date('2027-06-01T00:00:00.000Z');
    const detail = await service.workspaceDetail(saved.id);
    assert.equal(detail.draft?.savedAt, draft.savedAt);
    assert.equal(detail.draft?.draftRevision, 1);
  } finally {
    await close();
  }
});

test('trash, restore, and purge move draft.json and view.json with the workspace directory', async () => {
  const { root, service, close } = await fixture();
  try {
    const saved = await service.save({ name: 'Movable', yaml });
    await service.saveDraft(saved.id, draftBody(1, 0));
    await service.saveView(saved.id, { scenarioId: 'alpha' });
    await service.setSession(saved.id);
    await service.trashWorkspace(saved.id);
    assert.equal(await readFile(join(root, 'trash', saved.id, 'draft.json'), 'utf8').then(value => JSON.parse(value).draftRevision), 1);
    const afterTrash = (await service.session()) as { lastActiveId: string | null; unavailable?: boolean };
    assert.equal(afterTrash.unavailable, true);
    assert.equal(afterTrash.lastActiveId, null);
    await service.restoreWorkspace(saved.id);
    assert.equal((await service.workspaceDetail(saved.id)).view?.scenarioId, 'alpha');
    await service.trashWorkspace(saved.id);
    await service.purgeWorkspace(saved.id);
    await assert.rejects(readFile(join(root, 'trash', saved.id, 'draft.json')));
  } finally {
    await close();
  }
});

test('copying a workspace leaves its draft and view on the original identity', async () => {
  const { root, service, close } = await fixture();
  try {
    const saved = await service.save({ name: 'Original', yaml });
    await service.saveDraft(saved.id, draftBody(1, 0, 'appId: com.example.App\n---\n- tapOn: *missing\n', { 'yaml-command': 'kept' }));
    await service.saveView(saved.id, { scenarioId: 'alpha', zoomHint: 1 });
    const copy = await service.copyWorkspace({ ...saved, name: 'Original copy' });
    assert.equal((await service.workspace(copy.id)).yaml, yaml);
    await assert.rejects(readFile(join(root, 'workspaces', copy.id, 'draft.json')));
    await assert.rejects(readFile(join(root, 'workspaces', copy.id, 'view.json')));
    assert.equal((await service.workspaceDetail(saved.id)).draft?.fields['yaml-command'], 'kept');
  } finally {
    await close();
  }
});

test('view.json keeps its schema version and unknown keys across partial writes', async () => {
  const { root, service, close } = await fixture();
  try {
    const saved = await service.save({ name: 'View', yaml });
    const first = (await service.saveView(saved.id, { format: 1, futurePanel: { x: 4, open: true }, panels: { advanced: true, dock: 'left' }, canvas: { zoom: 1.1, extra: true } })) as Record<string, any>;
    assert.equal(first.format, 1);
    assert.equal(first.futurePanel.x, 4);
    const second = (await service.saveView(saved.id, { panels: { advanced: false }, canvas: { scrollLeft: 12 } })) as Record<string, any>;
    assert.equal(second.format, 1);
    assert.equal(second.futurePanel.open, true);
    assert.equal(second.panels.dock, 'left');
    assert.equal(second.panels.advanced, false);
    assert.equal(second.canvas.zoom, 1.1);
    assert.equal(second.canvas.extra, true);
    assert.equal(second.canvas.scrollLeft, 12);
    await writeFile(join(root, 'workspaces', saved.id, 'view.json'), JSON.stringify({ format: 2, floating: { open: true, x: 3 }, panels: { advanced: true } }));
    const third = (await service.saveView(saved.id, { scenarioId: 'later', panels: { advanced: false } })) as Record<string, any>;
    assert.equal(third.format, 2);
    assert.deepEqual(third.floating, { open: true, x: 3 });
    assert.equal(third.panels.advanced, false);
    assert.equal(third.scenarioId, 'later');
    await writeFile(join(root, 'workspaces', saved.id, 'view.json'), '{');
    assert.equal((await service.workspaceDetail(saved.id)).view, null);
    assert.equal((await service.workspace(saved.id)).name, 'View');
  } finally {
    await close();
  }
});

test('draft and view HTTP routes report conflict and size limits without treating the workspace as missing', async () => {
  const { root, service, close } = await fixture();
  const { createApiHandler } = await import('../server/http.js');
  const runner = createRunner({ artifactDirectory: root, execute: async () => ({ stdout: '{"devices":{}}', stderr: '' }) });
  const server = createServer(createApiHandler(runner, root, undefined, service));
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    const saved = await service.save({ name: 'HTTP draft', yaml });
    const { token } = await (await fetch(base + '/api/status')).json();
    const headers = { 'X-TnT-Token': token, 'Content-Type': 'application/json', Origin: base };
    const created = await fetch(base + '/api/workspaces/' + saved.id + '/draft', { method: 'POST', headers, body: JSON.stringify(draftBody(1, 0)) });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).draftRevision, 1);
    const stale = await fetch(base + '/api/workspaces/' + saved.id + '/draft', { method: 'POST', headers, body: JSON.stringify(draftBody(1, 0)) });
    assert.equal(stale.status, 409);
    const huge = await fetch(base + '/api/workspaces/' + saved.id + '/draft', { method: 'POST', headers, body: JSON.stringify({ ...draftBody(1, 1), fields: { 'yaml-command': 'x'.repeat(16_000_100) } }) });
    assert.equal(huge.status, 413);
    const view = await fetch(base + '/api/workspaces/' + saved.id + '/view', { method: 'POST', headers, body: JSON.stringify({ format: 1, futurePanel: { open: true } }) });
    assert.equal(view.status, 200);
    assert.equal((await view.json()).futurePanel.open, true);
    const session = await fetch(base + '/api/session', { headers });
    assert.equal((await session.json()).lastActiveId, saved.id);
    assert.equal((await service.workspace(saved.id)).yaml, yaml);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    await close();
  }
});

test('a post-rename session or draft failure still reports the committed save', async () => {
  const faults = createWriteFaults();
  const { service, close } = await fixture({ faults: faults.faults });
  try {
    faults.failAfterCommit();
    const created = await service.save({ name: 'Created', yaml });
    assert.equal((created as { draftCleared?: boolean }).draftCleared, false);
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    faults.pass();
    assert.equal((await service.listWorkspaces()).items.length, 1);
    const retried = await service.save({ ...created, name: 'Created again' });
    assert.equal(retried.id, created.id);
    assert.equal(retried.metadata!.revision, 2);
    assert.equal((await service.listWorkspaces()).items.length, 1);
    const draft = await service.saveDraft(created.id, draftBody(retried.metadata!.revision, 0));
    faults.failAfterCommit();
    const committed = await service.save({ ...retried, name: 'Committed', clearDraft: draft.draftRevision });
    assert.equal((committed as { draftCleared?: boolean }).draftCleared, false);
    assert.equal(committed.metadata!.revision, retried.metadata!.revision + 1);
    assert.equal((await service.workspaceDetail(created.id)).draft?.draftRevision, draft.draftRevision);
    faults.pass();
    const again = await service.save({ ...committed, name: 'Retried' });
    assert.equal(again.id, created.id);
    assert.equal(again.metadata!.revision, committed.metadata!.revision + 1);
    assert.equal((await service.listWorkspaces()).items.length, 1);
  } finally {
    faults.pass();
    await close();
  }
});

test('a session failure after openedAt commits still opens the workspace', async () => {
  const faults = createWriteFaults();
  let tick = 0;
  const { service, close } = await fixture({ faults: faults.faults, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
  try {
    const saved = await service.save({ name: 'Opened', yaml });
    await service.setSession(null);
    faults.failAfterCommit();
    const opened = await service.openWorkspace(saved.id);
    assert.equal(opened.id, saved.id);
    assert.equal(opened.name, 'Opened');
    assert.notEqual(opened.metadata!.openedAt, saved.metadata!.openedAt);
    assert.equal((await service.session()).lastActiveId, null);
    faults.pass();
    const again = await service.openWorkspace(saved.id);
    assert.equal(again.id, saved.id);
    assert.equal((await service.session()).lastActiveId, saved.id);
  } finally {
    faults.pass();
    await close();
  }
});

test('creating the first draft validates before leaving an empty workspace directory', async () => {
  const { service, close } = await fixture();
  try {
    await assert.rejects(service.createDraftWorkspace({ name: 'Broken', content: { yaml: 'appId: com.example.App\n---\n- launchApp\n', extra: true }, fields: {} }), /Unknown draft content/);
    assert.equal((await service.listWorkspaces()).items.length, 0);
    assert.equal((await service.listWorkspaces()).unreadable, 0);
    const created = await service.createDraftWorkspace({ name: 'First', content: { yaml: 'not: yaml\n---\n' }, fields: { 'yaml-command': 'pending' } });
    assert.equal(created.workspace.metadata?.revision, 1);
    assert.equal(created.draft.draftRevision, 1);
    assert.equal(created.workspace.yaml, 'appId: com.example.HybridApp\n---\n- launchApp\n');
    assert.equal(created.draft.content.yaml, 'not: yaml\n---\n');
    assert.equal((await service.session()).lastActiveId, created.workspace.id);
  } finally {
    await close();
  }
});
