import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRunner } from '../server/runner.js';

const deviceId = 'E5C92F6E-40DC-493C-93B4-469E67193736';
const devices = JSON.stringify({ devices: { iOS: [{ udid: deviceId, name: 'iPhone 15', state: 'Booted', isAvailable: true }] } });
const exec = promisify(execFile);

test('installed apps retain their simulator identity, readable names and simulator-provided classification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnt-app-list-test-'));
  try {
    const runner = createRunner({ artifactDirectory: directory, execute: async (file, args) => {
      if (args.includes('list')) return { stdout: devices, stderr: '' };
      if (args.includes('listapps')) return { stdout: '{ "com.apple.Previews" = { ApplicationType = User; CFBundleName = "Preview Test"; }; "com.apple.Preferences" = { ApplicationType = System; CFBundleDisplayName = Settings; }; "org.example.Unnamed" = { ApplicationType = User; }; }', stderr: '' };
      return exec(file, args);
    } });
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
  const runner=createRunner({artifactDirectory:tmpdir(),execute:async(file,args)=>{
    if(args.includes('list')) return {stdout:devices,stderr:''};
    if(args.includes('listapps')) return {stdout:'{ "com.example.App" = { ApplicationType = User; CFBundleDisplayName = Example; Path = "/private/app/container"; }; }',stderr:''};
    return exec(file,args);
  }});
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
