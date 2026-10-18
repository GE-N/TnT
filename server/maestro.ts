import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access,mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Maestro } from './scenarios.js';
import { InspectionCleanupError, type Inspector } from './picker.js';

const exec = promisify(execFile);
export type MaestroDependencies={spawn?:typeof spawn;kill?:typeof process.kill;schedule?:typeof setTimeout;unschedule?:typeof clearTimeout;pause?:typeof delay;environment?:()=>Promise<NodeJS.ProcessEnv>;file?:string};
export function createMaestro(dependencies:MaestroDependencies={}): Maestro & Inspector {
  const spawnProcess=dependencies.spawn??spawn;const kill=dependencies.kill??process.kill;const schedule=dependencies.schedule??setTimeout;const unschedule=dependencies.unschedule??clearTimeout;const pause=dependencies.pause??delay;
  const file = dependencies.file??process.env.MAESTRO_BIN ?? resolve('.tnt/tools/maestro/bin/maestro');
  async function environment():Promise<NodeJS.ProcessEnv> {
    if(dependencies.environment)return dependencies.environment();
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
    async run({ directory, flow, deviceId, signal, runtimeInputs,scriptEnv }) {
      const inputs = [...Object.entries(runtimeInputs ?? {}),...Object.entries(scriptEnv??{})].flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      return command(['--device', deviceId, 'test', '--no-ansi', '--format', 'JUNIT', '--output', resolve(directory, 'report.xml'), '--test-output-dir', resolve(directory, 'raw'), '--debug-output', resolve(directory,'raw'), ...inputs, flow], directory, signal);
    },
  };
  async function command(args: string[], directory: string, signal: AbortSignal, timeoutMs = 300_000) {
      const env = await environment();
      // Maestro also writes JVM user.home diagnostics; own both destinations per run.
      if(args.includes('test')){const home=resolve(directory,'.maestro-home');await mkdir(home,{recursive:true});env.HOME=home;Object.assign(env,{JAVA_TOOL_OPTIONS:'-Duser.home='+JSON.stringify(home)});}
      return new Promise<{ code: number | null; log: string; stdout: string; cleanup: import('./scenarios.js').Cleanup }>(resolveRun => {
        const child = spawnProcess(file, args, { cwd: directory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        let stdout = '';
        let timedOut = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let cleanupError = '';
        const append = (chunk: Buffer) => { log += chunk.toString(); if (log.length > 2_000_000) log = '[Earlier output omitted: 2 MB log limit]\n' + log.slice(-1_900_000); };
        child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000); append(chunk); }); child.stderr.on('data', append);
        function stop(force = false) {
          if (!child.pid) return;
          try { kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupError = String(error); }
        }
        function abort() { stop(); killTimer = schedule(() => stop(true), 2000); }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        const timeout = schedule(() => { timedOut = true; log += '\nMaestro exceeded its operation time limit.\n'; abort(); }, timeoutMs);
        child.on('error', error => { log += '\n' + error.message; });
        child.on('close', async code => {
          unschedule(timeout); if (killTimer) unschedule(killTimer);
          signal.removeEventListener('abort', abort);
          stop(true); // Also stop owned helper processes that outlived the CLI.
          let gone = !child.pid;
          for (let attempt = 0; child.pid && attempt < 40; attempt++) {
            try { kill(-child.pid, 0); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') gone = true;
              else cleanupError = String(error);
              break;
            }
            await pause(50);
          }
          const verified = gone && !cleanupError;
          resolveRun({ code: timedOut ? 124 : code, log, stdout, cleanup: { verified, detail: verified ? 'Owned CLI exited and process group disappearance verified. No mock instance allocated. App data was not restored.' : 'Owned process-group cleanup could not be verified; device ownership retained. ' + cleanupError } });
        });
      });
    }
}
