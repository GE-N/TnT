import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/app.js';

const first = 'E5C92F6E-40DC-493C-93B4-469E67193736';
const second = 'F5C92F6E-40DC-493C-93B4-469E67193736';
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const app = (bundleId: string, name: string, type = 'user') => ({ bundleId, name, type });
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(done => { resolve = done; }); return { promise, resolve }; }
async function ui(fetcher: typeof fetch, remembered?:{deviceId:string;bundleId:string}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const restore = ['window','document','HTMLElement','Event','MouseEvent','localStorage','IS_REACT_ACT_ENVIRONMENT','fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of ['window','document','HTMLElement','Event','MouseEvent','localStorage']) Object.defineProperty(globalThis, key, { value: Reflect.get(dom.window,key), configurable: true });
  Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{ value:true, configurable:true });
  Object.defineProperty(globalThis,'fetch',{ value:fetcher, configurable:true });
  if(remembered){dom.window.localStorage.setItem('tnt-device',remembered.deviceId);dom.window.localStorage.setItem('tnt-app',JSON.stringify(remembered));}
  const root = createRoot(dom.window.document.getElementById('root')!);
  await act(async () => { root.render(createElement(App)); });
  const document = dom.window.document;
  const button = (label:string) => { const element = [...document.querySelectorAll('button')].find(button=>button.textContent?.includes(label)); assert.ok(element, label); return element; };
  const select = async (id:string,value:string) => { await act(async () => { const element=document.getElementById(id) as HTMLSelectElement; assert.ok(element); element.value=value; element.dispatchEvent(new dom.window.Event('change',{bubbles:true})); }); };
  return { document, button, select, click:async(label:string)=>act(async()=>{button(label).click();}), close:async()=>{ await act(async()=>{root.unmount();}); dom.window.close(); for(const [key,descriptor] of restore) { if(descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); } } };
}
const status = () => response({ ready:true,token:'session',devices:[{id:first,name:'iPhone 15',runtime:'iOS'},{id:second,name:'iPhone 16',runtime:'iOS'}] });

test('a delayed previous simulator response cannot replace the current app list or launch selection', async () => {
  const old = deferred(); const launches: unknown[] = [];
  const view = await ui(async (url, options) => {
    if(url==='/api/status') return status();
    if(String(url).includes(first+'/apps')) return old.promise; // Deliberately ignore abort, as an already-delivered response can do.
    if(String(url).includes(second+'/apps')) return response({deviceId:second,apps:[app('com.example.New','New app'),app('com.apple.Preferences','Settings','system')]});
    if(url==='/api/launches') { launches.push(JSON.parse(String(options?.body))); return response({status:'awaiting-confirmation',deviceName:'iPhone 16',bundleId:'com.example.New',startedAt:new Date().toISOString()}); }
    return response({references:[],diagnostics:[]});
  });
  try {
    assert.match(view.document.body.textContent!,/Loading installed apps/);
    await view.select('device',second);
    await view.select('installed-app','com.example.New');
    await act(async()=>{old.resolve(response({deviceId:first,apps:[app('com.example.Old','Old app')]}));});
    const picker=view.document.getElementById('installed-app') as HTMLSelectElement;
    assert.equal(picker.value,'com.example.New');
    assert.equal(picker.querySelector('option[value="com.example.Old"]'),null);
    assert.deepEqual([...picker.querySelectorAll('optgroup')].map(group=>group.label),['User-installed apps','System apps']);
    await view.click('Launch app');
    assert.deepEqual(launches,[{deviceId:second,bundleId:'com.example.New'}]);
    await view.select('device',first);
    assert.equal((view.document.getElementById('installed-app') as HTMLSelectElement).value,'');
    assert.equal(view.button('Launch app').disabled,true);
  } finally { await view.close(); }
});

test('refresh recovers a failed list load and clears an app removed from the simulator', async () => {
  let load = 0;
  const view = await ui(async url => {
    if(url==='/api/status') return status();
    if(String(url).endsWith('/apps')) {
      load++;
      if(load===1) return response({error:'Simulator disconnected'},400);
      return response({deviceId:first,apps:load===2?[app('com.example.App','Example')]:[]});
    }
    return response({references:[],diagnostics:[]});
  });
  try {
    assert.match(view.document.body.textContent!,/Simulator disconnected/);
    assert.equal(view.button('Launch app').disabled,true);
    await view.click('Refresh apps');
    await view.select('installed-app','com.example.App');
    assert.equal(view.button('Launch app').disabled,false);
    await view.click('Refresh apps');
    assert.match(view.document.body.textContent!,/No installed apps found/);
    assert.equal(view.button('Launch app').disabled,true);
    await view.click('Enter bundle ID manually');
    assert.ok(view.document.getElementById('bundle'));
    assert.equal(view.document.getElementById('installed-app'),null);
    await view.click('Choose from installed apps');
    assert.ok(view.document.getElementById('installed-app'));
    assert.equal(view.document.getElementById('bundle'),null);
  } finally { await view.close(); }
});

test('launch waits for a refreshed picker selection to be validated while manual entry remains available', async () => {
  const refresh = deferred(); let load = 0;
  const view = await ui(async url => {
    if(url==='/api/status') return status();
    if(String(url).endsWith('/apps')) return ++load===1?response({deviceId:first,apps:[app('com.example.App','Example')]}):refresh.promise;
    return response({references:[],diagnostics:[]});
  });
  try {
    await view.select('installed-app','com.example.App');
    assert.equal(view.button('Launch app').disabled,false);
    await view.click('Refresh apps');
    assert.match(view.document.body.textContent!,/Loading installed apps/);
    assert.equal(view.button('Launch app').disabled,true);
    await view.click('Enter bundle ID manually');
    assert.equal((view.document.getElementById('bundle') as HTMLInputElement).disabled,false);
    await view.click('Choose from installed apps');
    assert.equal(view.button('Launch app').disabled,true);
    await act(async()=>{refresh.resolve(response({deviceId:first,apps:[app('com.example.App','Example')]}));});
    await view.select('installed-app','com.example.App');
    assert.equal(view.button('Launch app').disabled,false);
  } finally { await view.close(); }
});


test('a remembered app survives cold startup and becomes runnable only after inventory revalidation',async()=>{
 const connection=deferred();const inventory=deferred();
 const remembered={deviceId:second,bundleId:'com.example.App'};
 const view=await ui(async url=>{
  if(url==='/api/status')return connection.promise;
  if(String(url).endsWith('/apps'))return inventory.promise;
  return response({references:[],diagnostics:[]});
 },remembered);
 try{
  assert.equal(JSON.parse(localStorage.getItem('tnt-app')!).bundleId,'com.example.App');
  assert.equal(view.button('Launch app').disabled,true);
  await act(async()=>connection.resolve(status()));
  assert.equal((view.document.getElementById('device') as HTMLSelectElement).value,second);
  assert.equal(view.button('Launch app').disabled,true);
  await act(async()=>inventory.resolve(response({deviceId:second,apps:[app('com.example.App','Remembered app')]})));
  assert.equal((view.document.getElementById('installed-app') as HTMLSelectElement).value,'com.example.App');
  assert.equal(view.button('Launch app').disabled,false);
 }finally{await view.close();}
});
