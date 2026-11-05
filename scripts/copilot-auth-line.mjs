#!/usr/bin/env node
// Informational Copilot sign-in line for setup.sh.
// Prints login and auth type only. Never prints a token, env value, or status message.
// Never runs a login and never calls session.send / run.
import {pathToFileURL} from 'node:url';

const NOT_SIGNED_IN = 'Copilot: not signed in → run `copilot login`';
const SDK_MISSING = 'Copilot: SDK not installed';
const DEADLINE_MS = 8_000;

export function copilotAuthLine(auth) {
  if (!auth || auth.installed === false) return SDK_MISSING;
  if (auth.isAuthenticated !== true) return NOT_SIGNED_IN;
  const via = viaLabel(auth.authType);
  const login = safeLogin(auth.login);
  const viaText = via ? ` (via ${via})` : '';
  if (login) return `Copilot: signed in as ${login}${viaText}`;
  if (via) return `Copilot: signed in${viaText}`;
  return NOT_SIGNED_IN;
}

export function copilotAuthFailureLine(error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : '';
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /cannot find package '@github\/copilot-sdk'|cannot find module '@github\/copilot-sdk'/i.test(message)) {
    return SDK_MISSING;
  }
  return NOT_SIGNED_IN;
}

function viaLabel(authType) {
  if (authType === 'gh-cli') return 'gh';
  if (authType === 'user') return 'copilot';
  if (authType === 'env' || authType === 'token' || authType === 'api-key' || authType === 'hmac') return 'env';
  return '';
}

function safeLogin(login) {
  if (typeof login !== 'string') return '';
  if (/(?:gho_|ghu_|ghp_|github_pat_)/.test(login)) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)) return '';
  return login;
}

function formatArg() {
  const index = process.argv.indexOf('--format');
  if (index === -1) return;
  try {
    const parsed = JSON.parse(process.argv[index + 1] ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

async function stopClient(client) {
  await Promise.race([
    Promise.resolve(client.stop()).then(() => undefined, () => undefined),
    new Promise(resolve => { setTimeout(resolve, 1_000); }),
  ]);
}

async function main() {
  if (process.argv.includes('--format')) {
    console.log(copilotAuthLine(formatArg() ?? {}));
    return;
  }
  let finished = false;
  let client;
  const finish = line => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    console.log(line);
    process.exit(0);
  };
  const timer = setTimeout(() => {
    if (client && typeof client.forceStop === 'function') void Promise.resolve(client.forceStop()).catch(() => undefined);
    finish(NOT_SIGNED_IN);
  }, DEADLINE_MS);
  try {
    const sdk = await import('@github/copilot-sdk');
    client = new sdk.CopilotClient({logLevel: 'error', useLoggedInUser: true});
    await client.start();
    const auth = await client.getAuthStatus();
    const line = copilotAuthLine({isAuthenticated: auth.isAuthenticated === true, authType: auth.authType, login: auth.login});
    await stopClient(client);
    finish(line);
  } catch (error) {
    finish(copilotAuthFailureLine(error));
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
