import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../server/runner.js';

const deviceId = 'E5C92F6E-40DC-493C-93B4-469E67193736';
const devices = JSON.stringify({ devices: { iOS: [{ udid: deviceId, name: 'iPhone 15', state: 'Booted', isAvailable: true }] } });

/**
 * OpenStep plist text to JSON. The runner asks plutil to convert simctl listapps
 * output. These tests answer that call themselves so the app-list assertions do
 * not depend on /usr/bin/plutil, which is absent on Linux and flaky when the
 * real binary races the temp file.
 */
function plistTextToJson(text: string) {
  let index = 0;
  const skip = () => { while (text[index] === ' ' || text[index] === '\n' || text[index] === '\t' || text[index] === '\r') index += 1; };
  const parseString = () => {
    index += 1;
    let value = '';
    while (index < text.length && text[index] !== '"') {
      if (text[index] === '\\') { index += 1; value += text[index] ?? ''; }
      else value += text[index];
      index += 1;
    }
    index += 1;
    return value;
  };
  const parseBare = () => {
    const start = index;
    while (index < text.length && !' \t\n\r;}'.includes(text[index])) index += 1;
    return text.slice(start, index);
  };
  const parseValue = (): unknown => {
    skip();
    if (text[index] === '{') return parseDict();
    if (text[index] === '"') return parseString();
    return parseBare();
  };
  const parseDict = () => {
    index += 1;
    const result: Record<string, unknown> = {};
    while (index < text.length) {
      skip();
      if (text[index] === '}') { index += 1; return result; }
      const key = text[index] === '"' ? parseString() : parseBare();
      skip();
      if (text[index] === '=') index += 1;
      result[key] = parseValue();
      skip();
      if (text[index] === ';') index += 1;
    }
    return result;
  };
  return JSON.stringify(parseValue());
}

function simulatorExecute(listApps: string) {
  return async (file: string, args: string[]) => {
    if (args.includes('list')) return { stdout: devices, stderr: '' };
    if (args.includes('listapps')) return { stdout: listApps, stderr: '' };
    if (file.endsWith('/plutil')) {
      const source = args.at(-1);
      assert.ok(source, 'plutil source path');
      return { stdout: plistTextToJson(await readFile(source, 'utf8')), stderr: '' };
    }
    throw new Error(`Unexpected simulator command ${file} ${args.join(' ')}`);
  };
}

test('installed apps retain their simulator identity, readable names and simulator-provided classification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnt-app-list-test-'));
  try {
    const runner = createRunner({ artifactDirectory: directory, execute: simulatorExecute('{ "com.apple.Previews" = { ApplicationType = User; CFBundleName = "Preview Test"; }; "com.apple.Preferences" = { ApplicationType = System; CFBundleDisplayName = Settings; }; "org.example.Unnamed" = { ApplicationType = User; }; }') });
    assert.deepEqual(await runner.apps(deviceId), { deviceId, apps: [
      { bundleId: 'org.example.Unnamed', name: 'org.example.Unnamed', type: 'user' },
      { bundleId: 'com.apple.Previews', name: 'Preview Test', type: 'user' },
      { bundleId: 'com.apple.Preferences', name: 'Settings', type: 'system' },
    ] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('app discovery rejects invalid or unavailable simulators before reading their installed apps', async () => {
  const runner = createRunner({ artifactDirectory: tmpdir(), execute: async (_file,args) => {
    if(args.includes('list')) return {stdout:devices,stderr:''};
    throw new Error('Unexpected app discovery for an unavailable device');
  } });
  await assert.rejects(runner.apps('booted; anything'),/valid simulator identifier/);
  await assert.rejects(runner.apps('F5C92F6E-40DC-493C-93B4-469E67193736'),/already-running simulator/);
});

test('the installed-app API requires a runner session and exposes no simulator container paths', async () => {
  const {createServer}=await import('node:http');
  const {createApiHandler}=await import('../server/http.js');
  const runner=createRunner({artifactDirectory:tmpdir(),execute:simulatorExecute('{ "com.example.App" = { ApplicationType = User; CFBundleDisplayName = Example; Path = "/private/app/container"; }; }')});
  const server=createServer(createApiHandler(runner,tmpdir()));
  try {
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const base='http://127.0.0.1:'+address.port;
    const path=base+'/api/devices/'+deviceId+'/apps';
    assert.equal((await fetch(path)).status,403);
    const session=await (await fetch(base+'/api/status')).json();
    assert.equal((await fetch(path,{headers:{'X-TnT-Token':session.token,Origin:'https://foreign.example'}})).status,403);
    const result=await fetch(path,{headers:{'X-TnT-Token':session.token}});
    assert.equal(result.status,200);
    assert.deepEqual(await result.json(),{deviceId,apps:[{bundleId:'com.example.App',name:'Example',type:'user'}]});
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
