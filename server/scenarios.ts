import { mkdir, readFile, writeFile, realpath, readdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { XMLParser } from 'fast-xml-parser';
import type { createRunner } from './runner.js';

export type Workspace = { id: string; name: string; yaml: string };
export type Step = { id: string; command: string; expected?: unknown; status: 'unavailable' | 'passed' | 'failed' | 'skipped' };
export type Cleanup = { verified: boolean; detail: string };
export type Run = {
  id: string; deviceId: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'passed' | 'assertion-failed' | 'tool-error' | 'cancelled';
  snapshot: { id: string; workspaceId: string; name: string; yaml: string; steps: Step[]; toolVersions: { maestro: string; node: string }; runtimeInputPolicy: string; pickerReference?: { captureId: string; reviewId: string; capturedAt: string } };
  steps: Step[]; log: string; error?: string; expectedFailure?: unknown;
  cleanup: Cleanup; artifacts: string[]; mappingNote: string;
};
export type Maestro = {
  version(): Promise<string>;
  run(input: { directory: string; flow: string; deviceId: string; signal: AbortSignal; runtimeInputs?: Record<string, string> }): Promise<{ code: number | null; log: string; cleanup: Cleanup }>;
};
const validId = (id: string) => { if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid workspace/run identifier.'); return id; };

export function createScenarios(options: { root: string; runner: ReturnType<typeof createRunner>; maestro: Maestro }) {
  const pending = new Map<string, Promise<Run>>();
  const controllers = new Map<string, AbortController>();
  async function directory(kind: string, id: string) {
    const base = resolve(options.root, kind);
    await mkdir(base, { recursive: true });
    if (!(await realpath(base)).startsWith((await realpath(options.root)) + sep)) throw new Error('Workspace path escapes its root.');
    const path = join(base, validId(id));
    await mkdir(path, { recursive: true });
    if (!(await realpath(path)).startsWith((await realpath(base)) + sep)) throw new Error('Workspace path escapes its root.');
    return path;
  }
  const service = {
    async save(input: { id?: string; name: string; yaml: string }): Promise<Workspace> {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || typeof input.yaml !== 'string' || Buffer.byteLength(input.yaml) > 100_000) throw new Error('Provide a scenario name and YAML up to 100 KB.');
      const workspace = { id: input.id ? validId(input.id) : randomUUID(), name: input.name.trim(), yaml: input.yaml };
      await writeRecord(join(await directory('workspaces', workspace.id), 'workspace.json'), workspace);
      return workspace;
    },
    async workspace(id: string): Promise<Workspace> { return readRecord(await directory('workspaces', id), 'workspace.json'); },
    async start(input: { workspaceId: string; deviceId: string; runtimeInputs?: unknown; captureId?: string; pickerReviewId?: string }): Promise<Run> {
      const runtimeInputs = validateInputs(input.runtimeInputs);
      const confidential = Object.keys(runtimeInputs).length > 0;
      const workspace = await service.workspace(input.workspaceId);
      const { appId, steps } = validate(workspace.yaml);
      if ((input.captureId === undefined) !== (input.pickerReviewId === undefined)) throw new Error('Provide both capture and reviewed step identity.');
      const pickerReference = input.captureId ? options.runner.picker.assertReview(input.captureId, input.pickerReviewId!, workspace.yaml) : undefined;
      const release = await options.runner.acquireDevice(input.deviceId, input.captureId, input.pickerReviewId);
      try {
        const device = (await options.runner.devices()).find(device => device.id === input.deviceId);
        if (!device) throw new Error('Select an available, already-running simulator and refresh.');
        await options.runner.checkApp(device.id, appId);
        const version = await options.maestro.version();
        const id = randomUUID();
        const path = await directory('runs', id);
        const runtimeInputPolicy = confidential ? 'Confidential runtime inputs supplied: values are omitted; raw logs, evaluated metadata, and images are withheld. Temporary tool artifacts are deleted on cleanup. Historical snapshots cannot replay omitted inputs.' : 'No runtime inputs supplied. Keep secrets out of authored YAML. No inherited application environment is forwarded.';
        const snapshot = { id: createHash('sha256').update(JSON.stringify({ workspace, steps, version, device, runtimeInputPolicy, pickerReference, node: process.version })).digest('hex'), workspaceId: workspace.id, name: workspace.name, yaml: workspace.yaml, steps, toolVersions: { maestro: version, node: process.version }, runtimeInputPolicy, pickerReference };
        const run: Run = { id, deviceId: device.id, startedAt: new Date().toISOString(), status: 'running', snapshot, steps: structuredClone(steps), log: '', cleanup: { verified: false, detail: 'Pending' }, artifacts: [], mappingNote: 'Command outcomes will be mapped after execution; unsupported details remain unavailable.' };
        await writeFile(join(path, 'flow.yaml'), workspace.yaml);
        await writeFile(join(path, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
        await writeRecord(join(path, 'result.json'), run);
        const controller = new AbortController();
        controllers.set(id, controller);
        const done = (async () => {
          let privateDirectory: string | undefined;
          try {
            if (confidential) {
              const privateRoot = join(options.root, 'private');
              await mkdir(privateRoot, { recursive: true, mode: 0o700 });
              privateDirectory = await mkdtemp(join(privateRoot, id + '-'));
            }
            const executionDirectory = privateDirectory ?? path;
            const execution = await options.maestro.run({ directory: executionDirectory, flow: join(path, 'flow.yaml'), deviceId: device.id, signal: controller.signal, runtimeInputs });
            run.log = confidential ? 'Raw logs withheld because confidential runtime inputs were supplied.' : execution.log;
            run.cleanup = execution.cleanup;
            const files = await listFiles(executionDirectory);
            run.artifacts = confidential ? ['flow.yaml', 'snapshot.json'] : files.filter(file => file !== 'result.json');
            const commandFile = files.find(file => file.endsWith('commands.json'));
            const commands = commandFile ? JSON.parse(await readFile(join(executionDirectory, commandFile), 'utf8')) : [];
            mapResults(run, commands);
            let report: any;
            try { report = new XMLParser({ ignoreAttributes: false }).parse(await readFile(join(executionDirectory, 'report.xml'), 'utf8')); } catch { /* Missing report is a tool error, never a pass. */ }
            const suite = report?.testsuites?.testsuite;
            const failedAssertion = commands.find((entry: any) => entry.metadata?.status === 'FAILED' && entry.command?.assertConditionCommand);
            run.status = controller.signal.aborted ? 'cancelled' : execution.code === 0 && Number(suite?.['@_tests']) === 1 && Number(suite?.['@_failures']) === 0 ? 'passed' : failedAssertion ? 'assertion-failed' : 'tool-error';
            if (failedAssertion) { run.error = confidential ? 'Assertion failed. Evaluated detail withheld for confidential inputs.' : failedAssertion.metadata.error?.message; run.expectedFailure = confidential ? run.steps.find(step => step.status === 'failed')?.expected : failedAssertion.command.assertConditionCommand.condition; }
            else if (run.status === 'tool-error') run.error = 'Maestro did not report a successful scenario or a structured assertion failure. Inspect raw logs.';
          } catch (error) {
            run.status = controller.signal.aborted ? 'cancelled' : 'tool-error';
            run.error = confidential ? 'Tool execution failed. Detail withheld for confidential inputs.' : error instanceof Error ? error.message : 'Tool execution failed.';
            run.cleanup = { verified: false, detail: 'Tool adapter failed; cleanup could not be verified.' };
          } finally {
            if (privateDirectory) {
              try { await rm(privateDirectory, { recursive: true, force: true }); run.cleanup.detail += ' Confidential temporary artifacts removed.'; }
              catch { run.cleanup = { verified: false, detail: 'Confidential temporary artifact removal could not be verified.' }; }
            }
            run.finishedAt = new Date().toISOString();
            try { await writeRecord(join(path, 'result.json'), run); }
            finally { controllers.delete(id); if (run.cleanup.verified) await release(); }
          }
          return run;
        })();
        pending.set(id, done);
        void done.finally(() => pending.delete(id)).catch(() => {});
        return structuredClone(run);
      } catch (error) { await release(); throw error; }
    },
    async result(id: string): Promise<Run> { return readRecord(await directory('runs', id), 'result.json'); },
    async wait(id: string): Promise<Run> { return pending.get(id) ?? service.result(id); },
    async cancel(id: string) { const controller = controllers.get(validId(id)); if (!controller) throw new Error('Run is no longer active.'); controller.abort(); return service.wait(id); },
    async artifact(id: string, name: string) {
      const run = await service.result(id);
      if (!run.artifacts.includes(name)) throw new Error('Unknown run artifact.');
      const base = await directory('runs', id);
      const path = await realpath(resolve(base, name));
      if (!path.startsWith((await realpath(base)) + sep)) throw new Error('Artifact path escapes its run.');
      return readFile(path);
    },
  };
  return service;
}
async function readRecord(base: string, name: string) {
  const file = await realpath(join(base, name));
  if (!file.startsWith((await realpath(base)) + sep)) throw new Error('Record path escapes its workspace/run.');
  return JSON.parse(await readFile(file, 'utf8'));
}
async function writeRecord(file: string, value: unknown) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}
function validateInputs(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 20) throw new Error('Runtime inputs must be an object of at most 20 named strings.');
  const entries = Object.entries(value);
  if (entries.some(([key, input]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || key.startsWith('MAESTRO_') || typeof input !== 'string' || input.length > 4000 || input.includes('\0'))) throw new Error('Runtime inputs require uppercase variable names and string values up to 4000 characters; MAESTRO_ names are reserved.');
  return Object.fromEntries(entries);
}

function validate(yaml: string) {
  const documents = parseAllDocuments(yaml);
  if (documents.length !== 2 || documents.some(doc => doc.errors.length)) throw new Error('Invalid Maestro YAML: use an appId header, --- separator, and command list.');
  const config = documents[0].toJS();
  const commands = documents[1].toJS();
  rejectFileReferences(config);
  rejectFileReferences(commands);
  if (typeof config?.appId !== 'string' || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(config.appId) || !Array.isArray(commands) || !commands.length) throw new Error('Provide a literal installed appId and at least one Maestro command.');
  const steps: Step[] = commands.map((value, index) => {
    const command = typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value)[0] : undefined;
    if (!command) throw new Error('Each step must be a Maestro command.');
    return { id: `step-${index + 1}`, command, expected: command.startsWith('assert') ? value[command] : undefined, status: 'unavailable' };
  });
  return { appId: config.appId as string, steps };
}
function rejectFileReferences(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['file', 'runScript', 'addMedia', 'takeScreenshot', 'startRecording'].includes(key) || (key === 'runFlow' && typeof child === 'string')) throw new Error('External file references and authored artifact paths are unsupported in single-flow workspaces. Use inline commands.');
    rejectFileReferences(child);
  }
}
async function listFiles(base: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(base, prefix), { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? listFiles(base, prefix + entry.name + '/') : entry.isFile() ? [prefix + entry.name] : []))).flat();
}
function mapResults(run: Run, commands: any[]) {
  const keys: Record<string, string> = { launchApp: 'launchAppCommand', assertVisible: 'assertConditionCommand', assertNotVisible: 'assertConditionCommand', tapOn: 'tapOnElement', inputText: 'inputTextCommand' };
  const events = commands.filter(entry => entry.metadata?.depth === 0 && !entry.command?.defineVariablesCommand && !entry.command?.applyConfigurationCommand);
  if (events.length > run.steps.length || run.steps.some((step, index) => !keys[step.command] || (events[index] && !events[index].command?.[keys[step.command]]))) {
    run.mappingNote = 'Unsupported or ambiguous command mapping. Raw command metadata is available; step outcomes are unavailable.'; return;
  }
  run.steps.forEach((step, index) => { const status = events[index]?.metadata?.status; step.status = status === 'COMPLETED' ? 'passed' : status === 'FAILED' ? 'failed' : status === 'SKIPPED' ? 'skipped' : 'unavailable'; });
  run.mappingNote = 'Top-level commands mapped in execution order using Maestro 2.11 command metadata. Nested/unmapped details remain in raw artifacts.';
}
