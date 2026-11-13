import {readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicWrite, readSafe, safeDirectory} from './files.js';
import {validateContent, KnowledgeError, type ContextContent, type RootGuard} from './types.js';

/** The workbench hides Undo after 10 seconds. The server does not enforce that. */
export const UNDO_CLIENT_WINDOW_MS = 10_000;
/** Receipts older than this may be deleted on the next apply or undo. */
export const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{7,199}$/;
const HASH = /^[a-f0-9]{64}$/;
const SKILL = 'knowledge-update@1';
const DIAGRAM_SKILL = 'diagram@1';
const RECEIPT_KEYS = ['receiptId', 'workspaceId', 'scenarioId', 'jobId', 'idempotencyKey', 'createdAt', 'origin', 'skill', 'skillHash', 'previousSidecar'] as const;

export type KnowledgeReceipt = {
  receiptId: string;
  workspaceId: string;
  scenarioId: string;
  jobId: string;
  idempotencyKey: string;
  createdAt: string;
  origin: 'ai';
  skill: typeof SKILL | typeof DIAGRAM_SKILL;
  skillHash: string;
  /** Exact sidecar file bytes, or null when the scenario had no sidecar. */
  previousSidecar: string | null;
  /** Present only for a diagram apply. Null when the scenario had no diagram file. */
  previousDiagram?: string | null;
};

export type ApplyDraftRequest = {
  jobId: string;
  expectedContextRevision: number;
  idempotencyKey: string;
  context: ContextContent;
  skill: string;
  skillHash: string;
};

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function validateApplyRequest(value: unknown): ApplyDraftRequest {
  const body = record(value);
  if (!body || Object.keys(body).length !== 6 || !('jobId' in body) || !('expectedContextRevision' in body) || !('idempotencyKey' in body) || !('context' in body) || !('skill' in body) || !('skillHash' in body)) {
    throw new KnowledgeError(400, 'INVALID_KNOWLEDGE_INPUT', 'Provide jobId, expectedContextRevision, and idempotencyKey.');
  }
  if (typeof body.jobId !== 'string' || !UUID.test(body.jobId)) throw new KnowledgeError(400, 'INVALID_KNOWLEDGE_INPUT', 'Provide the knowledge draft.');
  if (!Number.isSafeInteger(body.expectedContextRevision) || (body.expectedContextRevision as number) < 0) throw new KnowledgeError(400, 'INVALID_KNOWLEDGE_INPUT', 'Provide a nonnegative expectedContextRevision.');
  if (typeof body.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) throw new KnowledgeError(400, 'INVALID_KNOWLEDGE_INPUT', 'Provide an idempotency key.');
  if (body.skill !== SKILL || typeof body.skillHash !== 'string' || !HASH.test(body.skillHash)) throw new KnowledgeError(400, 'INVALID_KNOWLEDGE_INPUT', 'That draft has no knowledge skill.');
  return {
    jobId: body.jobId,
    expectedContextRevision: body.expectedContextRevision as number,
    idempotencyKey: body.idempotencyKey,
    context: validateContent(body.context),
    skill: SKILL,
    skillHash: body.skillHash,
  };
}

export function validateUndoRequest(value: unknown): {receiptId: string; expectedContextRevision: number} {
  const body = record(value);
  if (!body || Object.keys(body).length !== 2 || !('receiptId' in body) || !('expectedContextRevision' in body)) throw new KnowledgeError(400, 'INVALID_KNOWLEDGE_INPUT', 'Provide receiptId and expectedContextRevision.');
  if (typeof body.receiptId !== 'string' || !UUID.test(body.receiptId)) throw new KnowledgeError(400, 'INVALID_KNOWLEDGE_INPUT', 'Provide the receipt.');
  if (!Number.isSafeInteger(body.expectedContextRevision) || (body.expectedContextRevision as number) < 0) throw new KnowledgeError(400, 'INVALID_KNOWLEDGE_INPUT', 'Provide a nonnegative expectedContextRevision.');
  return {receiptId: body.receiptId, expectedContextRevision: body.expectedContextRevision as number};
}

function diagramBytes(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 200_000) return undefined;
  return value;
}

export function parseReceipt(value: unknown, workspaceId: string, scenarioId: string): KnowledgeReceipt | undefined {
  const body = record(value);
  if (!body) return;
  const keys = Object.keys(body);
  const knowledge = keys.length === RECEIPT_KEYS.length && RECEIPT_KEYS.every(key => key in body);
  const diagram = keys.length === RECEIPT_KEYS.length + 1 && RECEIPT_KEYS.every(key => key in body) && 'previousDiagram' in body;
  if (!knowledge && !diagram) return;
  if (typeof body.receiptId !== 'string' || !UUID.test(body.receiptId)) return;
  if (body.workspaceId !== workspaceId || body.scenarioId !== scenarioId) return;
  if (typeof body.jobId !== 'string' || !UUID.test(body.jobId)) return;
  if (typeof body.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) return;
  if (typeof body.createdAt !== 'string' || !Number.isFinite(Date.parse(body.createdAt))) return;
  if (body.origin !== 'ai' || typeof body.skillHash !== 'string' || !HASH.test(body.skillHash)) return;
  if (knowledge && body.skill !== SKILL) return;
  if (diagram && body.skill !== DIAGRAM_SKILL) return;
  if (body.previousSidecar !== null && (typeof body.previousSidecar !== 'string' || Buffer.byteLength(body.previousSidecar) > 650_000)) return;
  if (!diagram) return body as KnowledgeReceipt;
  const previousDiagram = diagramBytes(body.previousDiagram);
  if (previousDiagram === undefined) return;
  return {...body, previousDiagram} as KnowledgeReceipt;
}

async function folder(workspaceDirectory: string, guard: RootGuard, create = false) {
  try { return await safeDirectory(workspaceDirectory, ['knowledge', 'receipts'], guard, create); }
  catch (error) { if (missing(error) && !create) return; throw error; }
}

export async function pruneReceipts(workspaceDirectory: string, nowMs: number, guard: RootGuard) {
  const directory = await folder(workspaceDirectory, guard);
  if (!directory) return;
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    let createdAt = Number.NaN;
    try {
      const body = record(JSON.parse(await readSafe(directory, name)));
      createdAt = body && typeof body.createdAt === 'string' ? Date.parse(body.createdAt) : Number.NaN;
    } catch (error) { if (missing(error)) continue; throw error; }
    if (!Number.isFinite(createdAt) || nowMs - createdAt <= RECEIPT_RETENTION_MS) continue;
    guard.assertOwned();
    await rm(join(directory, name), {force: true});
  }
}

export async function findReceipt(workspaceDirectory: string, workspaceId: string, scenarioId: string, idempotencyKey: string, guard: RootGuard) {
  const directory = await folder(workspaceDirectory, guard);
  if (!directory) return;
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = parseReceipt(JSON.parse(await readSafe(directory, name)), workspaceId, scenarioId);
      if (parsed?.idempotencyKey === idempotencyKey) return parsed;
    } catch (error) { if (missing(error)) continue; throw error; }
  }
}

export async function readReceipt(workspaceDirectory: string, workspaceId: string, scenarioId: string, receiptId: string, guard: RootGuard) {
  const directory = await folder(workspaceDirectory, guard);
  if (!directory || !UUID.test(receiptId)) return;
  try { return parseReceipt(JSON.parse(await readSafe(directory, `${receiptId}.json`)), workspaceId, scenarioId); }
  catch (error) { if (missing(error)) return; throw error; }
}

export function newDiagramReceipt(input: {workspaceId: string; scenarioId: string; jobId: string; idempotencyKey: string; createdAt: string; skillHash: string; previousSidecar: string | null; previousDiagram: string | null}): KnowledgeReceipt {
  return {
    receiptId: randomUUID(),
    workspaceId: input.workspaceId,
    scenarioId: input.scenarioId,
    jobId: input.jobId,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,
    origin: 'ai',
    skill: DIAGRAM_SKILL,
    skillHash: input.skillHash,
    previousSidecar: input.previousSidecar,
    previousDiagram: input.previousDiagram,
  };
}

export function newReceipt(input: ApplyDraftRequest & {workspaceId: string; scenarioId: string; createdAt: string; previousSidecar: string | null}): KnowledgeReceipt {
  return {
    receiptId: randomUUID(),
    workspaceId: input.workspaceId,
    scenarioId: input.scenarioId,
    jobId: input.jobId,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,
    origin: 'ai',
    skill: SKILL,
    skillHash: input.skillHash,
    previousSidecar: input.previousSidecar,
  };
}

export async function writeReceipt(workspaceDirectory: string, receipt: KnowledgeReceipt, guard: RootGuard) {
  const directory = await folder(workspaceDirectory, guard, true);
  if (!directory) throw new KnowledgeError(503, 'KNOWLEDGE_UNAVAILABLE', 'Knowledge receipts are unavailable.');
  await atomicWrite(directory, `${receipt.receiptId}.json`, JSON.stringify(receipt) + '\n', guard);
}
