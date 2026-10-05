import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Maestro } from './scenarios.js';
import { InspectionCleanupError, type Inspector } from './picker.js';

const exec = promisify(execFile);
export function createMaestro(): Maestro & Inspector {
  const file = process.env.MAESTRO_BIN ?? resolve('.tnt/tools/maestro/bin/maestro');
  async function environment() {
    let java = process.env.JAVA_HOME;
    try { if (!java) throw new Error(); await access(resolve(java, 'bin/java')); }
    catch { java = (await exec('/usr/libexec/java_home', ['-v', '17'])).stdout.trim(); }
    return { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, JAVA_HOME: java,
      MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true' };
  }
  return {
    async version() {
      try {
        const { stdout } = await exec(file, ['--version'], { env: await environment(), timeout: 30_000 });
        const version = stdout.trim();
        if (version !== '2.11.0') throw new Error('This adapter was verified with Maestro 2.11.0; use that version before running.');
        return version;
      } catch (error) { throw new Error('Maestro unavailable: install 2.11.0, set MAESTRO_BIN if needed, and ensure Java 17+. ' + (error instanceof Error ? error.message : '')); }
    },
    async hierarchy(deviceId) {
      const result = await command(['--device', deviceId, 'hierarchy', '--no-ansi'], resolve('.tnt'), new AbortController().signal, 30_000);
      if (!result.cleanup.verified) throw new InspectionCleanupError(result.cleanup.detail);
      if (result.code !== 0) throw new Error('Maestro hierarchy failed: ' + result.log.slice(-2000));
      return result.stdout;
    },
    async run({ directory, flow, deviceId, signal, runtimeInputs }) {
      const inputs = Object.entries(runtimeInputs ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      return command(['--device', deviceId, 'test', '--no-ansi', '--format', 'JUNIT', '--output', resolve(directory, 'report.xml'), '--test-output-dir', resolve(directory, 'raw'), ...inputs, flow], directory, signal);
    },
  };
  async function command(args: string[], directory: string, signal: AbortSignal, timeoutMs = 300_000) {
      const env = await environment();
      return new Promise<{ code: number | null; log: string; stdout: string; cleanup: import('./scenarios.js').Cleanup }>(resolveRun => {
        const child = spawn(file, args, { cwd: directory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        let stdout = '';
        let timedOut = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let cleanupError = '';
        const append = (chunk: Buffer) => { log += chunk.toString(); if (log.length > 2_000_000) log = '[Earlier output omitted: 2 MB log limit]\n' + log.slice(-1_900_000); };
        child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000); append(chunk); }); child.stderr.on('data', append);
        function stop(force = false) {
          if (!child.pid) return;
          try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupError = String(error); }
        }
        function abort() { stop(); killTimer = setTimeout(() => stop(true), 2000); }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        const timeout = setTimeout(() => { timedOut = true; log += '\nMaestro exceeded its operation time limit.\n'; abort(); }, timeoutMs);
        child.on('error', error => { log += '\n' + error.message; });
        child.on('close', async code => {
          clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
          signal.removeEventListener('abort', abort);
          stop(true); // Also stop owned helper processes that outlived the CLI.
          let gone = !child.pid;
          for (let attempt = 0; child.pid && attempt < 40; attempt++) {
            try { process.kill(-child.pid, 0); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') gone = true;
              else cleanupError = String(error);
              break;
            }
            await delay(50);
          }
          const verified = gone && !cleanupError;
          resolveRun({ code: timedOut ? 124 : code, log, stdout, cleanup: { verified, detail: verified ? 'Owned CLI exited and process group disappearance verified. No mock instance allocated. App data was not restored.' : 'Owned process-group cleanup could not be verified; device ownership retained. ' + cleanupError } });
        });
      });
    }
}
