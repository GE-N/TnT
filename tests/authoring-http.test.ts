import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createApiHandler} from '../server/http.js';
import {createRunner} from '../server/runner.js';
import {authoringFixture, exampleDraft, proofYaml} from './authoring-helpers.js';
import {REQUEST_LIMIT} from '../server/authoring/types.js';

const forbidden = new Set(['token', 'secret', 'apiKey', 'password', 'backendUrl', 'TNT_MOCK_TOKEN', 'TNT_MOCK_URL']);

function assertNoSecrets(value: unknown) {
  const seen = JSON.stringify(value);
  assert.equal(seen.includes('backendUrl'), false);
  assert.equal(seen.includes('TNT_MOCK_TOKEN'), false);
  assert.equal(seen.includes('TNT_MOCK_URL'), false);
  walk(value);
}

function walk(value: unknown) {
  if (Array.isArray(value)) { for (const item of value) walk(item); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, key);
    walk(child);
  }
}

async function httpFixture(now?: () => Date) {
  const mockEnvironment = JSON.parse(await readFile(new URL('./fixtures/mockoon.json', import.meta.url), 'utf8')) as {routes: {uuid: string; responses: {uuid: string}[]}[]};
  const f = await authoringFixture({now, yaml: proofYaml});
  const mocked = await f.service.save({
    id: f.workspace.id, name: 'Authoring', expectedRevision: f.workspace.metadata!.revision, yaml: proofYaml, flows: {}, canvas: {screens: [], edges: [], paths: []}, scenarios: [],
    mock: {environment: mockEnvironment, port: 19841, routeId: mockEnvironment.routes[0].uuid, responseId: mockEnvironment.routes[0].responses[0].uuid, backendUrl: 'http://127.0.0.1:4321', passthroughRouteIds: [], fromScreen: 'Home', toScreen: 'Home', failureSemantics: 'Fixture HTTP'},
  });
  const runner = createRunner({artifactDirectory: f.root, execute: async () => { throw new Error('HTTP authoring tests must not execute.'); }});
  const server = createServer(createApiHandler(runner, f.root, undefined, f.service));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  const token = ((await (await fetch(base + '/api/status')).json()) as {token: string}).token;
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method: body === undefined && !path.startsWith('/api/authoring/flows/') ? 'GET' : path.startsWith('/api/authoring/flows/') && body === undefined ? 'GET' : 'POST',
    headers: {'content-type': 'application/json', origin: base, ...headers},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return {f, workspace: mocked, base, token, request, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }};
}

test('authoring routes enforce the session token and contract status codes without leaking secrets', async () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const h = await httpFixture(() => new Date(clock));
  try {
    const anonymous = await h.request('/api/authoring/context', {workspaceId: h.workspace.id, expectedRevision: h.workspace.metadata!.revision});
    assert.equal(anonymous.status, 403);
    const headers = {'x-tnt-token': h.token};
    const duplicate = await h.request('/api/authoring/context', `{"workspaceId":"${h.workspace.id}","workspaceId":"${h.workspace.id}"}`, headers);
    assert.equal(duplicate.status, 400);
    assert.equal((await duplicate.json()).code, 'DUPLICATE_MEMBER');
    const missing = await h.request('/api/authoring/context', {workspaceId: '00000000-0000-4000-8000-000000000000', expectedRevision: 1}, headers);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'UNKNOWN_WORKSPACE');
    const conflict = await h.request('/api/authoring/context', {workspaceId: h.workspace.id, expectedRevision: 0}, headers);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'REVISION_CONFLICT');
    const contextResponse = await h.request('/api/authoring/context', {workspaceId: h.workspace.id, expectedRevision: h.workspace.metadata!.revision}, headers);
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();
    assertNoSecrets(context);
    assert.equal(context.contractVersion, 1);
    const malformed = await h.request('/api/authoring/preview', '{', headers);
    assert.equal(malformed.status, 400);
    const unknownField = await h.request('/api/authoring/preview', {workspaceId: h.workspace.id, expectedRevision: h.workspace.metadata!.revision, contextId: context.contextId, draft: exampleDraft, extra: true}, headers);
    assert.equal(unknownField.status, 400);
    assert.equal((await unknownField.json()).code, 'INVALID_ENVELOPE');
    const invalidDraft = structuredClone(exampleDraft) as {extra?: boolean};
    invalidDraft.extra = true;
    const previewResponse = await h.request('/api/authoring/preview', {workspaceId: h.workspace.id, expectedRevision: h.workspace.metadata!.revision, contextId: context.contextId, draft: invalidDraft}, headers);
    assert.equal(previewResponse.status, 200);
    const invalid = await previewResponse.json();
    assertNoSecrets(invalid);
    assert.equal(invalid.applicable, false);
    assert.equal(invalid.diagnostics.some((item: {code: string}) => item.code === 'INVALID_DRAFT'), true);
    const oversize = await h.request('/api/authoring/preview', JSON.stringify({pad: 'x'.repeat(REQUEST_LIMIT)}), headers);
    assert.equal(oversize.status, 413);
    assert.equal((await oversize.json()).code, 'REQUEST_TOO_LARGE');
    const rejected = await h.request('/api/authoring/apply', {workspaceId: h.workspace.id, expectedRevision: h.workspace.metadata!.revision, previewId: invalid.previewId, idempotencyKey: 'bad', acknowledgedAssumptionKeys: []}, headers);
    assert.equal(rejected.status, 422);
    const rejectedBody = await rejected.json();
    assertNoSecrets(rejectedBody);
    assert.equal(rejectedBody.diagnostics.some((item: {code: string}) => item.code === 'INVALID_DRAFT'), true);
    const goodResponse = await h.request('/api/authoring/preview', {workspaceId: h.workspace.id, expectedRevision: h.workspace.metadata!.revision, contextId: context.contextId, draft: exampleDraft}, headers);
    assert.equal(goodResponse.status, 200);
    const good = await goodResponse.json();
    assertNoSecrets(good);
    assert.equal(good.applicable, true);
    const appliedResponse = await h.request('/api/authoring/apply', {workspaceId: h.workspace.id, expectedRevision: h.workspace.metadata!.revision, previewId: good.previewId, idempotencyKey: 'http', acknowledgedAssumptionKeys: []}, headers);
    assert.equal(appliedResponse.status, 200);
    const applied = await appliedResponse.json();
    assertNoSecrets(applied);
    assert.equal(applied.authoring, 'external');
    const readResponse = await h.request(`/api/authoring/flows/${applied.scenarioId}?workspaceId=${h.workspace.id}`, undefined, headers);
    assert.equal(readResponse.status, 200);
    const read = await readResponse.json();
    assertNoSecrets(read);
    assert.equal(read.editableAsV1, true);
    assert.equal(read.scripts.length, 3);
    assert.equal(read.scripts.every((row: {trust: {trusted: boolean}}) => row.trust.trusted === false), true);
    assert.equal(read.operations.map((item: {ordinal: number}) => item.ordinal).join(','), '0,1,2,3,4');
    const unknownScenario = await h.request(`/api/authoring/flows/missing?workspaceId=${h.workspace.id}`, undefined, headers);
    assert.equal(unknownScenario.status, 404);
    const undoResponse = await h.request('/api/authoring/undo', {workspaceId: h.workspace.id, expectedRevision: applied.revision, receiptId: '00000000-0000-4000-8000-000000000099'}, headers);
    assert.equal(undoResponse.status, 404);
    const {readdir} = await import('node:fs/promises');
    const {join} = await import('node:path');
    const receiptId = (await readdir(join(h.f.root, '.tnt', 'authoring-journal'))).find(name => name.endsWith('.json'))!.replace(/\.json$/, '');
    const undone = await h.request('/api/authoring/undo', {workspaceId: h.workspace.id, expectedRevision: applied.revision, receiptId}, headers);
    assert.equal(undone.status, 200);
    const undoneBody = await undone.json();
    assertNoSecrets(undoneBody);
    clock += 31 * 60 * 1000;
    const expiredContext = await h.request('/api/authoring/preview', {workspaceId: h.workspace.id, expectedRevision: undoneBody.revision, contextId: context.contextId, draft: exampleDraft}, headers);
    assert.equal(expiredContext.status, 410);
    assert.equal((await expiredContext.json()).code, 'CONTEXT_EXPIRED');
    const expiredPreview = await h.request('/api/authoring/apply', {workspaceId: h.workspace.id, expectedRevision: undoneBody.revision, previewId: good.previewId, idempotencyKey: 'later', acknowledgedAssumptionKeys: []}, headers);
    assert.equal(expiredPreview.status, 410);
    assert.equal((await expiredPreview.json()).code, 'PREVIEW_EXPIRED');
  } finally { await h.close(); }
});
