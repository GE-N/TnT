import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EnvironmentSchemaNoFix, type Environment } from '@mockoon/commons';
import type { Cleanup } from './scenarios.js';

export type MockPlan = { environment: Environment; port: number; routeId: string; responseId: string; backendUrl: string; passthroughRouteIds: string[]; fromScreen: string; toScreen: string; failureSemantics: string };
export type MockResult = {
  intent: { status: 'pending' | 'acknowledged' | 'failed'; routeId: string; responseId: string; method: string; endpoint: string; httpStatus: number; failureSemantics: string; acknowledgedAt?: string };
  evidence: { status: 'unavailable' | 'captured'; detail: string; transactions: { method: string; path: string; statusCode: number; routeId?: string; responseId?: string; proxied: boolean; timestampMs: number }[] };
  cleanup: Cleanup;
};
export function validateMock(value: unknown): MockPlan | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object') throw new Error('Provide a Mockoon plan.');
  const plan = structuredClone(value) as MockPlan;
  const checked = EnvironmentSchemaNoFix.validate(plan.environment);
  if (checked.error) throw new Error('Import a valid Mockoon 9.9 environment JSON: ' + checked.error.message);
  if (!Number.isInteger(plan.port) || plan.port < 1024 || plan.port > 65535 || plan.port === 4317) throw new Error('Choose a dedicated mock port from 1024 to 65535, separate from the workbench.');
  const backend = new URL(plan.backendUrl);
  if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password || backend.hash || backend.search) throw new Error('Provide an HTTP(S) test-backend URL without credentials, query, or fragment.');
  if (isLoopback(backend.hostname) && Number(backend.port || 80) === plan.port) throw new Error('Backend fallback cannot point to the mock itself.');
  if (['fromScreen', 'toScreen', 'failureSemantics'].some(key => typeof plan[key as keyof MockPlan] !== 'string' || !(plan[key as keyof MockPlan] as string).trim() || (plan[key as keyof MockPlan] as string).length > 300)) throw new Error('Name the source screen, expected screen, and HTTP/body failure semantics.');
  const routes = plan.environment.routes;
  const route = routes.find(route => route.uuid === plan.routeId);
  if (!route || route.type !== 'http' || !route.responses.some(response => response.uuid === plan.responseId)) throw new Error('Select an existing HTTP route and preconfigured response.');
  if (!Array.isArray(plan.passthroughRouteIds) || plan.passthroughRouteIds.some(id => id === plan.routeId || !routes.some(route => route.uuid === id))) throw new Error('Passthrough routes must be existing routes other than the selected mock.');
  // Local file/TLS/callback integrations need their own explicit adapter; do not expose arbitrary files or issue callbacks from an import.
  if (plan.environment.tlsOptions.enabled || plan.environment.callbacks.length || routes.some(route => route.responses.some(response => response.filePath || response.callbacks.length))) throw new Error('This local adapter supports inline/data-bucket responses without TLS files or callbacks.');
  return plan;
}

function isLoopback(hostname: string) {
  const host=hostname.toLowerCase().replace(/\.$/,'');
  return host==='localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host==='0.0.0.0' || host==='[::1]' || host==='[::]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]+\]$/.test(host);
}

export function createMockSession(plan: MockPlan, directory: string): { result: MockResult; prepare(signal: AbortSignal): Promise<void>; evidence(confidential: boolean): Promise<void>; cleanup(): Promise<Cleanup> } {
  const route = plan.environment.routes.find(route => route.uuid === plan.routeId)!;
  const response = route.responses.find(response => response.uuid === plan.responseId)!;
  const result: MockResult = { intent: { status: 'pending', routeId: route.uuid, responseId: response.uuid, method: route.method, endpoint: route.endpoint, httpStatus: response.statusCode, failureSemantics: plan.failureSemantics }, evidence: { status: 'unavailable', detail: 'No observed requests captured.', transactions: [] }, cleanup: { verified: false, detail: 'Pending' } };
  const token = randomBytes(32).toString('hex');
  const baseline = { ...structuredClone(plan.environment), uuid: randomUUID(), name: 'TnT owned test copy', hostname: '127.0.0.1', port: plan.port, proxyMode: true, proxyHost: plan.backendUrl };
  const selected = structuredClone(baseline);
  selected.routes = selected.routes.filter(item => !plan.passthroughRouteIds.includes(item.uuid));
  const selectedRoute = selected.routes.find(item => item.uuid === plan.routeId)!;
  selectedRoute.responses = [{ ...structuredClone(response), default: true, rules: [] }];
  selectedRoute.responseMode = null;
  let child: ReturnType<typeof spawn> | undefined;
  let exited = false;
  let ready = false;
  let processError = '';
  const base = `http://127.0.0.1:${plan.port}/mockoon-admin`;
  async function admin(path: string, method = 'GET', body?: unknown) {
    const answer = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!answer.ok) throw new Error('Mockoon controller did not acknowledge ' + method + ' ' + path + ' (' + answer.status + ').');
    return answer;
  }
  async function stop(): Promise<boolean> {
    if (!child?.pid) return true;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
      for (let attempt = 0; attempt < 40; attempt++) {
        try { process.kill(-child.pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        await delay(50);
      }
    }
    return false;
  }
  return {
    result,
    async prepare(signal) {
      const version=JSON.parse(await readFile(resolve('node_modules/@mockoon/cli/package.json'),'utf8')).version;
      if(version!=='9.9.0') throw new Error('Use the pinned Mockoon CLI 9.9.0 for this adapter.');
      const file = resolve(directory, 'mock-environment.json');
      await writeFile(file, JSON.stringify(baseline), {mode:0o600});
      child = spawn(process.execPath, [resolve('node_modules/@mockoon/cli/bin/run.js'), 'start', '--data', file, '--hostname', '127.0.0.1', '--port', String(plan.port), '--disable-log-to-file', '--max-transaction-logs', '100', '--max-request-body-size', '1mb'], { detached:true, cwd:directory, env:{ PATH:process.env.PATH, HOME:directory, TMPDIR:process.env.TMPDIR, MOCKOON_ADMIN_API_TOKEN:token }, stdio:['ignore','ignore','ignore'] });
      child.on('error', error => { processError = error.message; }); child.on('exit', ()=>{exited=true;});
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (signal.aborted) throw new Error('Mock setup cancelled.');
          if (exited || processError) throw new Error('Owned Mockoon CLI exited during setup. Check the imported environment and dedicated port.');
          try { await admin('/logs'); ready=true; break; } catch { await delay(100); }
        }
        if (!ready) throw new Error('Owned Mockoon did not become ready within its startup deadline.');
        await admin('/state/purge','POST');
        await admin('/environment','PUT',selected);
        if (signal.aborted || exited) throw new Error('Mock setup stopped before the triggering action.');
        result.intent.status='acknowledged'; result.intent.acknowledgedAt=new Date().toISOString();
      } catch (error) { result.intent.status='failed'; throw error; }
    },
    async evidence(confidential) {
      if (!ready) { result.evidence.detail='Mock setup did not acknowledge an owned server; request evidence unavailable.'; return; }
      if (confidential) { result.evidence.detail='Request evidence withheld because confidential inputs were supplied.'; return; }
      try {
        const logs: any = await (await admin('/logs?limit=100')).json();
        if (!Array.isArray(logs)) throw new Error('Unexpected transaction format');
        // No body/query/header values are persisted. These are observed server transactions, not proof of the originating app.
        const observed=logs.filter(log=>!String(log.request.urlPath).startsWith('/mockoon-admin'));
        result.evidence.transactions=observed.map(log=>({method:String(log.request.method),path:String(log.request.route || log.request.urlPath).split('?')[0],statusCode:Number(log.response.statusCode),routeId:log.routeUUID,responseId:log.routeResponseUUID,proxied:log.proxied===true,timestampMs:Number(log.timestampMs)}));
        result.evidence.status=observed.length ? 'captured':'unavailable';
        result.evidence.detail=observed.length ? 'Observed at the owned Mockoon server; callers are not independently attributed to the app. Bodies, query values and headers omitted. Latest 100 transactions only.':'No requests observed at the owned Mockoon server.';
      } catch { result.evidence.detail='Mockoon transaction capture unavailable.'; }
    },
    async cleanup() {
      let restored = !ready;
      if (ready && !exited) { try { await admin('/environment','PUT',baseline); await admin('/state/purge','POST'); restored=true; } catch { restored=false; } }
      const stopped = await stop();
      // A verified stopped dedicated process destroys all its owned in-memory state, even if the admin API died first.
      result.cleanup={verified:stopped,detail: stopped ? (restored ? 'Owned environment restored/reset; Mockoon process group disappearance verified.' : 'Mockoon controller restoration unavailable; owned process group disappearance verified, destroying its isolated state.') : 'Mockoon process-group cleanup unverified; ownership retained.'};
      return result.cleanup;
    },
  };
}
