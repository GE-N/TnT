import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access,mkdtemp,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import {tmpdir} from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { Maestro } from './scenarios.js';
import { InspectionCleanupError, type Inspector } from './picker.js';

const exec = promisify(execFile);
export type MaestroDependencies={spawn?:typeof spawn;kill?:typeof process.kill;schedule?:typeof setTimeout;unschedule?:typeof clearTimeout;pause?:typeof delay;environment?:()=>Promise<NodeJS.ProcessEnv>;file?:string;prepareProcess?:()=>Promise<void>|void;cancelProcess?:()=>Promise<void>|void;noteProcess?:(pid:number)=>Promise<void>|void};
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
    async run({ directory, flow, deviceId, signal, runtimeInputs,scriptEnv,scriptRun }) {
      const inputs = Object.entries(runtimeInputs ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      const scripts=scriptRun??!!scriptEnv;
      return command(['--device', deviceId, 'test', '--no-ansi', '--format', 'JUNIT', '--output', resolve(directory, 'report.xml'), '--test-output-dir', resolve(directory, 'raw'), ...(scripts?['--debug-output', resolve(directory,'raw')]:[]), ...inputs, flow], directory, signal,300_000,scripts);
    },
  };
  async function command(args: string[], directory: string, signal: AbortSignal, timeoutMs = 300_000,scriptRun=false) {
      const env = {...await environment()};
      const home=scriptRun?await mkdtemp(join(tmpdir(),'tnt-maestro-home-')):undefined;
      if(home){env.HOME=home;env.JAVA_TOOL_OPTIONS=[env.JAVA_TOOL_OPTIONS,'-Duser.home='+JSON.stringify(home)].filter(Boolean).join(' ');}
      let result: { code: number | null; log: string; stdout: string; cleanup: import('./scenarios.js').Cleanup }|undefined;
      if(dependencies.prepareProcess)await dependencies.prepareProcess();
      let child:ReturnType<typeof spawnProcess>;
      try{child=spawnProcess(file, args, { cwd: directory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });}
      catch(error){await dependencies.cancelProcess?.();throw error;}
      const output=child.stdout;const errors=child.stderr;
      if(!child.pid||!output||!errors)await dependencies.cancelProcess?.();
      if(!output||!errors)throw new Error('Maestro did not expose output pipes.');
      const recording=child.pid&&dependencies.noteProcess?Promise.resolve(dependencies.noteProcess(child.pid)).catch(()=>{}):undefined;
      try{return result=await new Promise<{ code: number | null; log: string; stdout: string; cleanup: import('./scenarios.js').Cleanup }>(resolveRun => {
        let log = '';
        let stdout = '';
        let timedOut = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let cleanupError = '';
        const append = (chunk: Buffer) => { log += chunk.toString(); if (log.length > 2_000_000) log = '[Earlier output omitted: 2 MB log limit]\n' + log.slice(-1_900_000); };
        output.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000); append(chunk); }); errors.on('data', append);
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
          await recording;
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
      });}finally{if(home)try{await rm(home,{recursive:true,force:true});}catch(error){if(result)result.cleanup={verified:false,detail:'Temporary Maestro HOME removal could not be verified; ownership retained.'};else throw error;}}
    }
}
