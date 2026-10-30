import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

/**
 * Exclusive ownership of one canonical `.tnt` root.
 *
 * The ownership token is `runner.lock`, created exclusively (O_EXCL). It holds
 * host, pid, process start time (`ps -o lstart=` under LC_ALL=C), and a nonce.
 * A live owner is the same host plus a running pid whose start time still
 * matches. That comparison is what makes PID reuse visible.
 * A stale owner (pid gone, or the same pid with a different start time) is
 * replaced only while this process holds `runner.lock.recover`: rename the
 * lock aside, re-read it, and retry O_EXCL only if the nonce is still the
 * stale one. A partial, unreadable, symlinked, or other-host lock is refused.
 */

const LOCK_NAME = 'runner.lock';
const RECOVER_NAME = 'runner.lock.recover';
const startTime = /^[A-Za-z]{3} [A-Za-z]{3} [ 0-9]\d [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/;
const safeNonce = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exec = promisify(execFile);

export type RootOwnershipErrorCode = 'live-owner' | 'uncertain-owner';

export class RootOwnershipError extends Error {
  readonly code: RootOwnershipErrorCode;
  constructor(message: string, code: RootOwnershipErrorCode) {
    super(message);
    this.name = 'RootOwnershipError';
    this.code = code;
  }
}

export interface RootGuard {
  /** Throws when this process no longer holds the lock it acquired. */
  assertOwned(): void;
}

export interface AcquiredRootOwnership {
  guard: RootGuard;
  release(): Promise<void>;
}

export type ProcessLiveness =
  | { state: 'dead' }
  | { state: 'alive'; startedAt: string }
  | { state: 'unknown'; reason: string };

export interface AcquireRootOwnershipOptions {
  /** Overrides for tests. A missing start time is read from the owner pid. */
  identity?: { host?: string; pid?: number; startedAt?: string; nonce?: string };
  /** Defaults to `ps`. Return `unknown` when liveness cannot be proved. */
  inspectProcess?: (pid: number) => ProcessLiveness | Promise<ProcessLiveness>;
  /**
   * Release the lock on process exit and on SIGINT, SIGTERM, and SIGHUP.
   * The server sets this. Tests leave it off so a signal cannot exit the runner.
   */
  bindProcessLifecycle?: boolean;
}

interface OwnerRecord {
  host: string;
  pid: number;
  startedAt: string;
  nonce: string;
}

type Inspect = (pid: number) => ProcessLiveness | Promise<ProcessLiveness>;
type ReadResult = { status: 'missing' } | { status: 'bad' } | { status: 'ok'; owner: OwnerRecord };
type StaleReason = 'dead' | 'reused' | 'live' | 'uncertain' | 'other-host';
type Decision =
  | { action: 'missing' }
  | { action: 'stale'; owner: OwnerRecord }
  | { action: 'refuse'; code: RootOwnershipErrorCode; message: string };

function errno(error: unknown): string | number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

function serialize(owner: OwnerRecord): string {
  return JSON.stringify({ host: owner.host, pid: owner.pid, startedAt: owner.startedAt, nonce: owner.nonce }) + '\n';
}

function parseOwner(raw: string): OwnerRecord | null {
  if (raw.length === 0 || raw.length > 4096) return null;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { host?: unknown; pid?: unknown; startedAt?: unknown; nonce?: unknown };
  if (typeof record.host !== 'string' || record.host.length === 0 || record.host.length > 255 || /[\r\n]/.test(record.host)) return null;
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) return null;
  if (typeof record.startedAt !== 'string' || record.startedAt.length === 0 || record.startedAt.length > 80 || /[\r\n]/.test(record.startedAt)) return null;
  if (typeof record.nonce !== 'string' || !safeNonce.test(record.nonce)) return null;
  return { host: record.host, pid: record.pid, startedAt: record.startedAt, nonce: record.nonce };
}

async function inspectProcessDefault(pid: number): Promise<ProcessLiveness> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown', reason: 'invalid pid' };
  try {
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    const startedAt = String(stdout ?? '').trim();
    if (!startTime.test(startedAt)) return { state: 'unknown', reason: 'unreadable process start time' };
    return { state: 'alive', startedAt };
  } catch (error) {
    const code = errno(error);
    if (code === 1 || code === '1') return { state: 'dead' };
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function prepareRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || root.length === 0) throw new Error('Workspace root path is required.');
  const directory = resolve(root);
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) throw new RootOwnershipError(`Refusing to lock a symlinked workspace root (${directory}).`, 'uncertain-owner');
    if (!stat.isDirectory()) throw new RootOwnershipError(`Workspace root must be a directory (${directory}).`, 'uncertain-owner');
  } catch (error) {
    if (error instanceof RootOwnershipError) throw error;
    if (errno(error) !== 'ENOENT') throw error;
  }
  await mkdir(directory, { recursive: true });
  return directory;
}

async function identityOf(options: AcquireRootOwnershipOptions | undefined, inspect: Inspect): Promise<OwnerRecord> {
  const pid = options?.identity?.pid ?? process.pid;
  let startedAt = options?.identity?.startedAt;
  if (!startedAt) {
    const self = await inspect(pid);
    if (self.state !== 'alive') throw new Error('Cannot read this process start time, so root ownership cannot be acquired.');
    startedAt = self.startedAt;
  }
  const nonce = options?.identity?.nonce ?? randomUUID();
  if (!safeNonce.test(nonce)) throw new Error('Root owner nonce must be a UUID.');
  const host = options?.identity?.host ?? hostname();
  if (!host) throw new Error('Cannot read this machine\'s hostname.');
  return { host, pid, startedAt, nonce };
}

async function syncDirectory(directory: string) {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch { /* Some filesystems reject directory fsync. The file fsync still happened. */ }
  finally { await handle?.close().catch(() => undefined); }
}

/** Exclusive create. Readers may observe a short empty file and must treat that as unreadable. */
async function tryCreate(directory: string, path: string, owner: OwnerRecord): Promise<boolean> {
  let handle: FileHandle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (errno(error) === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(serialize(owner));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await syncDirectory(directory);
  return true;
}

async function readOwnerFile(path: string): Promise<ReadResult> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return { status: 'bad' };
    const raw = await readFile(path, 'utf8');
    const owner = parseOwner(raw);
    return owner ? { status: 'ok', owner } : { status: 'bad' };
  } catch (error) {
    if (errno(error) === 'ENOENT') return { status: 'missing' };
    return { status: 'bad' };
  }
}

async function staleReason(owner: OwnerRecord, inspect: Inspect, host: string): Promise<StaleReason> {
  if (owner.host !== host) return 'other-host';
  let result: ProcessLiveness;
  try { result = await inspect(owner.pid); }
  catch { return 'uncertain'; }
  if (!result || result.state === 'unknown') return 'uncertain';
  if (result.state === 'dead') return 'dead';
  if (result.startedAt !== owner.startedAt) return 'reused';
  return 'live';
}

function refuse(message: string, code: RootOwnershipErrorCode): Decision {
  return { action: 'refuse', code, message };
}

async function classify(lock: string, directory: string, me: OwnerRecord, inspect: Inspect): Promise<Decision> {
  let current = await readOwnerFile(lock);
  // A publisher's O_EXCL file can be read before its write lands. One re-read
  // distinguishes that from a lock that is actually incomplete.
  if (current.status === 'bad') current = await readOwnerFile(lock);
  if (current.status === 'missing') return { action: 'missing' };
  if (current.status === 'bad') {
    return refuse(`The runner lock at ${lock} is incomplete or unreadable. Refusing to take it. If no TnT runner is using ${directory}, stop any leftover process and remove the lock file.`, 'uncertain-owner');
  }
  const owner = current.owner;
  const why = await staleReason(owner, inspect, me.host);
  if (why === 'other-host') {
    return refuse(`A runner on ${owner.host} owns ${directory}. This process is on ${me.host} and will not take another machine's lock.`, 'uncertain-owner');
  }
  if (why === 'uncertain') {
    return refuse(`Cannot tell whether pid ${owner.pid} on ${owner.host} still owns ${directory}. Refusing to take the lock.`, 'uncertain-owner');
  }
  if (why === 'live') {
    return refuse(`Another TnT runner already owns this workspace root (${owner.host}, pid ${owner.pid}). Stop that runner before starting another.`, 'live-owner');
  }
  return { action: 'stale', owner };
}

/** Put `aside` back at `path` without overwriting a lock someone else published. */
async function restoreAside(aside: string, path: string) {
  try { await link(aside, path); }
  catch (error) {
    if (errno(error) === 'EEXIST') return;
    throw error;
  }
  await rm(aside, { force: true });
}

/**
 * Remove `path` only when its nonce still matches. Rename is the commit:
 * a concurrent publisher can only create a new lock after the name is gone,
 * and a nonce mismatch puts the moved file back.
 */
async function consumeIfNonce(directory: string, path: string, nonce: string): Promise<boolean> {
  const aside = join(directory, `.runner.lock.aside-${randomUUID()}`);
  try { await rename(path, aside); }
  catch (error) {
    if (errno(error) === 'ENOENT') return false;
    throw error;
  }
  const moved = await readOwnerFile(aside);
  if (moved.status !== 'ok' || moved.owner.nonce !== nonce) {
    await restoreAside(aside, path);
    return false;
  }
  await rm(aside, { force: true });
  return true;
}

function consumeIfNonceSync(directory: string, path: string, nonce: string) {
  const aside = join(directory, `.runner.lock.aside-${randomUUID()}`);
  try { renameSync(path, aside); }
  catch (error) {
    if (errno(error) !== 'ENOENT') { /* The process is exiting; the next start recovers a dead owner. */ }
    return;
  }
  let removeAside = true;
  try {
    const moved = parseOwner(readFileSync(aside, 'utf8'));
    if (!moved || moved.nonce !== nonce) {
      try { linkSync(aside, path); }
      catch (error) { if (errno(error) === 'EEXIST') removeAside = false; }
    }
  } catch {
    try { linkSync(aside, path); }
    catch { removeAside = false; }
  }
  if (removeAside) {
    try { unlinkSync(aside); }
    catch { /* The exit handler cannot report this. A leftover aside is not the ownership token. */ }
  }
}

async function waitOrClearRecover(directory: string, recover: string, me: OwnerRecord, inspect: Inspect) {
  const current = await readOwnerFile(recover);
  if (current.status === 'missing') return;
  if (current.status !== 'ok') {
    throw new RootOwnershipError(`The recovery lock at ${recover} is incomplete or unreadable. Refusing to take the workspace root.`, 'uncertain-owner');
  }
  const why = await staleReason(current.owner, inspect, me.host);
  if (why === 'other-host') {
    throw new RootOwnershipError(`A runner on ${current.owner.host} is recovering ${directory}. This process is on ${me.host} and will not take that lock.`, 'uncertain-owner');
  }
  if (why === 'uncertain') {
    throw new RootOwnershipError(`Cannot tell whether pid ${current.owner.pid} on ${current.owner.host} is recovering ${directory}. Refusing to take the lock.`, 'uncertain-owner');
  }
  if (why === 'live') {
    await delay(20);
    return;
  }
  await consumeIfNonce(directory, recover, current.owner.nonce);
}

async function takeover(directory: string, lock: string, expected: OwnerRecord, me: OwnerRecord, inspect: Inspect): Promise<'acquired' | 'retry'> {
  const recover = join(directory, RECOVER_NAME);
  if (!(await tryCreate(directory, recover, me))) {
    await waitOrClearRecover(directory, recover, me, inspect);
    return 'retry';
  }
  try {
    const current = await readOwnerFile(lock);
    if (current.status === 'missing') return (await tryCreate(directory, lock, me)) ? 'acquired' : 'retry';
    if (current.status !== 'ok' || current.owner.nonce !== expected.nonce) return 'retry';
    const why = await staleReason(current.owner, inspect, me.host);
    if (why !== 'dead' && why !== 'reused') return 'retry';
    if (!(await consumeIfNonce(directory, lock, expected.nonce))) return 'retry';
    if (await tryCreate(directory, lock, me)) {
      const detail = why === 'reused' ? 'has a different start time' : 'is not running';
      console.error(`Recovered a stale runner lock at ${lock} (previous pid ${expected.pid} ${detail}).`);
      return 'acquired';
    }
    return 'retry';
  } finally {
    await consumeIfNonce(directory, recover, me.nonce);
  }
}

function bindProcessLifecycle(directory: string, lock: string, nonce: string, release: () => Promise<void>) {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    const code = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
    release().catch(() => undefined).finally(() => process.exit(code));
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGHUP', () => stop('SIGHUP'));
  process.on('exit', () => consumeIfNonceSync(directory, lock, nonce));
}

function own(directory: string, lock: string, me: OwnerRecord, options: AcquireRootOwnershipOptions | undefined): AcquiredRootOwnership {
  let released = false;
  const lost = 'This runner no longer owns the workspace root, so it will not write sidecars, recover runs, or switch pointers.';
  const release = async () => {
    if (released) return;
    released = true;
    await consumeIfNonce(directory, lock, me.nonce);
  };
  const guard: RootGuard = {
    assertOwned() {
      if (released) throw new RootOwnershipError(lost, 'uncertain-owner');
      let owner: OwnerRecord | null = null;
      try { owner = parseOwner(readFileSync(lock, 'utf8')); }
      catch { throw new RootOwnershipError(lost, 'uncertain-owner'); }
      if (!owner || owner.nonce !== me.nonce) throw new RootOwnershipError(lost, 'uncertain-owner');
    },
  };
  if (options?.bindProcessLifecycle) bindProcessLifecycle(directory, lock, me.nonce, release);
  return { guard, release };
}

export async function acquireRootOwnership(root: string, options?: AcquireRootOwnershipOptions): Promise<AcquiredRootOwnership> {
  const directory = await prepareRoot(root);
  const inspect = options?.inspectProcess ?? inspectProcessDefault;
  const me = await identityOf(options, inspect);
  const lock = join(directory, LOCK_NAME);
  for (let attempt = 0; attempt < 25; attempt++) {
    if (await tryCreate(directory, lock, me)) return own(directory, lock, me, options);
    const decision = await classify(lock, directory, me, inspect);
    if (decision.action === 'refuse') throw new RootOwnershipError(decision.message, decision.code);
    if (decision.action === 'missing') continue;
    if (await takeover(directory, lock, decision.owner, me, inspect) === 'acquired') return own(directory, lock, me, options);
  }
  throw new RootOwnershipError(`Could not acquire ${directory} because the runner lock kept changing. Refusing to start.`, 'uncertain-owner');
}
