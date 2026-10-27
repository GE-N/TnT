import {spawn} from 'node:child_process';
import {AiHttpError} from './errors.js';

const ACCOUNT = 'tnt';
/** `security -i` reads at most 4095 characters before the newline. Stay under that. */
const MAX_COMMAND_BYTES = 4_000;

export type SecretStore = {
  get(service: string): Promise<string | undefined>;
  set(service: string, value: string): Promise<void>;
  delete(service: string): Promise<void>;
  available?(): Promise<boolean>;
};

export type SecurityRequest = {
  args: string[];
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type SecurityResult = {code: number | null; stdout: string; stderr: string};

export type SecuritySpawn = (request: SecurityRequest) => Promise<SecurityResult>;

/** Quote one argument for `security -i`'s splitter (`\'` and `\\` inside single quotes). */
export function quoteSecurityArg(value: string) {
  return `'${value.replace(/[\\']/g, character => `\\${character}`)}'`;
}

export function sanitizedSecurityEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = {...source};
  delete env.TNT_AI_API_KEY;
  return env;
}

function defaultSecuritySpawn(request: SecurityRequest): Promise<SecurityResult> {
  return new Promise(resolve => {
    const child = spawn('security', request.args, {env: request.env, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: SecurityResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({code: null, stdout: '', stderr: ''});
    }, request.timeoutMs ?? 5_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', () => finish({code: null, stdout: '', stderr: ''}));
    child.on('close', code => finish({code, stdout, stderr}));
    child.stdin.on('error', () => undefined);
    if (request.input) child.stdin.write(request.input);
    child.stdin.end();
  });
}

export function createKeychainStore(spawnImpl: SecuritySpawn = defaultSecuritySpawn): SecretStore {
  const account = ACCOUNT;
  let availability: Promise<boolean> | undefined;
  const env = () => sanitizedSecurityEnv();

  return {
    available() {
      if (process.platform !== 'darwin') return Promise.resolve(false);
      availability ??= spawnImpl({args: ['list-keychains'], env: env(), timeoutMs: 5_000}).then(result => result.code === 0, () => false);
      return availability;
    },
    async get(service) {
      try {
        const result = await spawnImpl({args: ['find-generic-password', '-s', service, '-a', account, '-w'], env: env(), timeoutMs: 5_000});
        if (result.code !== 0) return undefined;
        const value = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
        return value || undefined;
      } catch { return undefined; }
    },
    async set(service, value) {
      // One command on stdin. `security -i` keeps the password out of argv and the environment.
      const line = `add-generic-password -s ${quoteSecurityArg(service)} -a ${quoteSecurityArg(account)} -w ${quoteSecurityArg(value)} -U\n`;
      if (Buffer.byteLength(line) > MAX_COMMAND_BYTES) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide an API key.');
      const result = await spawnImpl({args: ['-i'], input: line, env: env(), timeoutMs: 5_000});
      if (result.code !== 0) throw new AiHttpError(500, 'CREDENTIAL_STORAGE_FAILED', 'The API key could not be saved to the Keychain.');
    },
    async delete(service) {
      await spawnImpl({args: ['delete-generic-password', '-s', service, '-a', account], env: env(), timeoutMs: 5_000}).catch(() => undefined);
    },
  };
}
