import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,test} from 'node:test';
import {act,createElement} from 'react';
import {JSDOM} from 'jsdom';
import type {CanvasGraph,CanvasTest} from '../server/canvas.js';
import {writeChecks} from '../shared/canvas-authoring.js';
import {inspectScreen,workspaceCommand} from './workspace-ui-helpers.js';

const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch','navigator'] as const;

function step(kind:'tap'|'check'):CanvasTest{
  if(kind==='tap')return {id:'tap-gear',label:'Gear',role:'action',reference,scenarioIds:['scenario-a'],tap:{target:'text',match:'contains',value:'Gear'}};
  return {id:'see-ready',label:'Ready',role:'assertion',reference,scenarioIds:['scenario-a'],check:{visibility:'visible',target:'text',match:'exact',value:'Ready'}};
}

function graphFor(testStep:CanvasTest):CanvasGraph{
  return {screens:[{id:'home',title:'Home',x:40,y:40,tests:[testStep]}],edges:[],paths:[{id:'route',name:'Main',scenarioId:'scenario-a',screenId:'home',edgeIds:[],visits:[{id:'visit-home',operationIds:[testStep.id]}]}]};
}

const candidate={id:'element-1',text:'Gear',textLabels:['Gear'],identifier:'gear.button',bounds:{x:0,y:0,width:40,height:20},enabled:true};
const capture={id:'00000000-0000-4000-8000-000000000001',deviceId,deviceName:'Phone',capturedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+120_000).toISOString(),width:100,height:200,candidates:[],hierarchyAt:new Date().toISOString(),screenshotAt:new Date().toISOString(),toolVersion:'test'};

async function openWorkspace(kind:'tap'|'check'){
  const testStep=step(kind);
  const canvas=graphFor(testStep);
  const yaml=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas);
  const directory=await mkdtemp(join(tmpdir(),'tnt-match-by-'));
  const {createScenarios}=await import('../server/scenarios.js');
  const {createRunner}=await import('../server/runner.js');
  const service=createScenarios({root:directory,runner:createRunner({artifactDirectory:directory,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=>'2.11.0',run:async()=>({code:0,log:'',cleanup:{verified:true,detail:'Fixture exited'}})}});
  const workspace=await service.save({name:kind+'-match',yaml,canvas,flows:{},scenarios:[{id:'scenario-a',name:'Main',pathId:'route',authoring:'canvas',steps:[],inputs:{},parameters:{},enabledHandlerIds:[]}]});
  await service.saveView(workspace.id,{format:1,pathId:'route',scenarioId:'scenario-a'});
  const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/'});
  const window=dom.window;
  const document=window.document;
  const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  class ResizeObserver{observe(){}disconnect(){}}
  const pending:Promise<Response>[]=[];
  let viewport={width:1200,height:800};
  const request=async(path:string,options?:{body?:string})=>{
    const body=options?.body?JSON.parse(options.body):undefined;
    const id=path.split('/')[3];
    try{
      if(path==='/api/picker/captures/'+capture.id+'/screen')return new Response(new Blob(['png'],{type:'image/png'}));
      const result=path==='/api/workspaces'?await service.save(body):path.startsWith('/api/workspaces?q=')?await service.listWorkspaces():path==='/api/session'?await service.session():path.endsWith('/open')?await service.openWorkspace(id):path.endsWith('/view')?await service.saveView(id,body):path.endsWith('/draft')?await service.saveDraft(id,body):path==='/api/canvas/references'?await service.references(body):/^\/api\/workspaces\/[0-9a-f-]{36}$/.test(path)?await service.workspaceDetail(id):path==='/api/picker/captures'?capture:path==='/api/picker/candidates'?[candidate]:path==='/api/picker/preview'?{canSave:true,matches:[candidate],maestroMatches:[candidate],stepsYaml:'- tapOn:\n    id: gear.button\n',note:'Unique capture match.'}:{ok:true};
      return Response.json(result??{ok:true});
    }catch(error){return Response.json({error:error instanceof Error?error.message:'Failed'},{status:400});}
  };
  const fetch=(path:string,options?:{body?:string})=>{const result=request(path,options);pending.push(result);return result;};
  for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetch:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:key==='navigator'?window.navigator:Reflect.get(window,key),configurable:true});
  Object.assign(URL,{createObjectURL:()=>'blob:capture',revokeObjectURL:()=>{}});
  Object.defineProperty(window,'innerWidth',{configurable:true,get:()=>viewport.width});
  Object.defineProperty(window,'innerHeight',{configurable:true,get:()=>viewport.height});
  const {createRoot}=await import('react-dom/client');
  const {Scenarios}=await import('../src/scenarios.js');
  let root=createRoot(document.getElementById('root')!);
  const settle=async()=>{do{await Promise.all(pending.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pending.length);};
  const report=console.error;
  console.error=(...args:unknown[])=>{if(args.map(String).join(' ').includes('not wrapped in act'))return;report.apply(console,args);};
  const scenarioProps=(recoverSession:boolean)=>({token:'test' as const,deviceId,bundleId:'com.example.App',launchBusy:false,onRunning:()=>{},recoverSession});
  async function render(recoverSession=false){
    await act(async()=>root.render(createElement(Scenarios,scenarioProps(recoverSession))));
    await settle();
  }
  async function remount(){
    await act(async()=>root.unmount());
    root=createRoot(document.getElementById('root')!);
    await render(true);
  }
  await render();
  await workspaceCommand(document,'open',settle);
  await inspectScreen(document,{id:'home'},{id:'visit-home'});
  async function published(previousRevision=0){
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
      await settle();
      if(document.querySelector('.workspace-save-status')?.getAttribute('aria-label')!=='Saved locally')continue;
      const saved=await service.workspace(workspace.id);
      if((saved.metadata?.revision??0)>previousRevision)return saved;
    }
    throw new Error('The workspace did not save. '+document.querySelector('.workspace-save-status')?.getAttribute('aria-label'));
  }
  function row(){const summary=document.querySelector('.visit-step-summary[aria-expanded="true"]');assert.ok(summary);return summary.closest('.visit-step') as HTMLElement;}
  async function edit(){
    const summary=document.querySelector<HTMLButtonElement>('.visit-step-summary')!;
    if(summary.getAttribute('aria-expanded')!=='true')await act(async()=>summary.click());
    return row();
  }
  async function choose(value:'text'|'id'){
    const radio=row().querySelector<HTMLInputElement>(`input[type=radio][value="${value}"]`);
    assert.ok(radio);await act(async()=>radio.click());
  }
  async function fill(value:string){
    const input=row().querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  }
  async function done(){const button=[...row().querySelectorAll('button')].find(item=>item.textContent==='Done');assert.ok(button);await act(async()=>button.click());}
  function card(label:string){return [...document.querySelectorAll<HTMLElement>(`[role="dialog"][aria-label="${label}"]`)].find(item=>!item.hidden)??null;}
  function origin(label:string){return {x:parseFloat(card(label)!.style.left),y:parseFloat(card(label)!.style.top)};}
  async function press(target:Element,key:string,shiftKey=false){await act(async()=>target.dispatchEvent(new window.KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true})));}
  async function drag(handle:Element,dx:number,dy:number){
    await act(async()=>{
      handle.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:0,clientY:0,button:0,pointerId:1}));
      handle.dispatchEvent(new window.PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:dx,clientY:dy,button:0,pointerId:1}));
      handle.dispatchEvent(new window.PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:dx,clientY:dy,button:0,pointerId:1}));
    });
  }
  return {document,window,service,workspace,directory,viewport,edit,choose,fill,done,row,card,origin,press,drag,published,render,remount,settle,async view(){return JSON.parse(await readFile(join(directory,'workspaces',workspace.id,'view.json'),'utf8')) as {cards?:{picker?:{x:number;y:number};yaml?:{x:number;y:number}}};},async close(){console.error=report;await act(async()=>root.unmount());window.close();for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await rm(directory,{recursive:true,force:true});}};
}

describe('match by, pick from screen and pop-out cards',{concurrency:1},()=>{
  test('tapOn keeps each Match by value until Done and round-trips text and id without changing match',async()=>{
    const page=await openWorkspace('tap');
    try{
      const editing=await page.edit();
      const group=editing.querySelector('[role="radiogroup"]');
      assert.equal(group?.getAttribute('aria-label'),'Match by');
      assert.equal(editing.querySelector('select[aria-label$=" target"]'),null);
      assert.equal((editing.querySelector('input[type=radio][value=text]') as HTMLInputElement).checked,true);
      assert.equal(editing.querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!.value,'Gear');
      assert.equal((editing.querySelector('select[aria-label$=" matching"]') as HTMLSelectElement).value,'contains');
      assert.equal(editing.querySelector('button.pick-from-screen'),null);
      await page.choose('id');
      assert.equal(page.row().querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!.value,'');
      await page.fill('gear.button');
      await page.choose('text');
      assert.equal(page.row().querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!.value,'Gear');
      assert.equal((page.row().querySelector('select[aria-label$=" matching"]') as HTMLSelectElement).value,'contains');
      await page.choose('id');
      assert.equal(page.row().querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!.value,'gear.button');
      await page.choose('text');
      const before=await page.service.workspace(page.workspace.id);
      assert.equal(before.canvas?.screens[0].tests[0].tap?.target,'text');
      assert.equal(before.canvas?.screens[0].tests[0].tap?.match,'contains');
      await page.done();
      const textSaved=await page.published();
      assert.deepEqual(textSaved.canvas?.screens[0].tests[0].tap,{target:'text',match:'contains',value:'Gear'});
      assert.match(textSaved.yaml,/tnt-match:contains/);
      assert.match(textSaved.yaml,/tapOn:[\s\S]*text:.*Gear/);
      assert.doesNotMatch(textSaved.yaml,/id:/);
      await page.edit();
      await page.choose('id');
      assert.equal(page.row().querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!.value,'');
      await page.fill('gear.button');
      assert.equal((page.row().querySelector('select[aria-label$=" matching"]') as HTMLSelectElement).value,'contains');
      await page.done();
      const saved=await page.published(textSaved.metadata?.revision??0);
      assert.deepEqual(saved.canvas?.screens[0].tests[0].tap,{target:'id',match:'contains',value:'gear.button'});
      assert.match(saved.yaml,/tnt-match:contains/);
      assert.match(saved.yaml,/tapOn:[\s\S]*id:.*gear/);
      assert.doesNotMatch(saved.yaml,/text:/);
    }finally{await page.close();}
  });

  test('a check uses the same Match by control and round-trips to Maestro text and id YAML',async()=>{
    const page=await openWorkspace('check');
    try{
      await page.edit();
      assert.equal((page.row().querySelector('input[type=radio][value=text]') as HTMLInputElement).checked,true);
      assert.equal((page.row().querySelector('select[aria-label$=" matching"]') as HTMLSelectElement).value,'exact');
      await page.choose('id');
      await page.fill('banner.id');
      await page.choose('text');
      assert.equal(page.row().querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!.value,'Ready');
      assert.equal((page.row().querySelector('select[aria-label$=" matching"]') as HTMLSelectElement).value,'exact');
      await page.choose('id');
      assert.equal(page.row().querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!.value,'banner.id');
      await page.choose('text');
      await page.done();
      const textSaved=await page.published();
      assert.deepEqual(textSaved.canvas?.screens[0].tests[0].check,{visibility:'visible',target:'text',match:'exact',value:'Ready'});
      assert.match(textSaved.yaml,/assertVisible:[\s\S]*text:.*Ready/);
      assert.match(textSaved.yaml,/tnt-match:exact/);
      assert.doesNotMatch(textSaved.yaml,/id:/);
      await page.edit();
      await page.choose('id');
      assert.equal(page.row().querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!.value,'');
      await page.fill('banner.id');
      assert.equal((page.row().querySelector('select[aria-label$=" matching"]') as HTMLSelectElement).value,'exact');
      await page.done();
      const saved=await page.published(textSaved.metadata?.revision??0);
      assert.deepEqual(saved.canvas?.screens[0].tests[0].check,{visibility:'visible',target:'id',match:'exact',value:'banner.id'});
      assert.match(saved.yaml,/assertVisible:[\s\S]*id:.*banner/);
      assert.match(saved.yaml,/tnt-match:exact/);
      assert.doesNotMatch(saved.yaml,/text:/);
    }finally{await page.close();}
  });

  test('Pick from screen lives in the Element field, fills the id, and shows the capture only on demand',async()=>{
    const page=await openWorkspace('tap');
    try{
      const section=page.document.querySelector('[data-visit-id="visit-home"]')!;
      await act(async()=>section.querySelector<HTMLButtonElement>('.add-visit-step')!.click());
      await act(async()=>[...page.document.querySelectorAll<HTMLButtonElement>('[role=option]')].find(item=>item.textContent==='Tap')!.click());
      assert.equal(page.document.querySelector('.floating-inspector img'),null);
      assert.equal(page.card('Pick from screen'),null);
      await act(async()=>[...page.row().querySelectorAll('button')].find(item=>item.textContent==='Cancel')!.click());
      const editing=await page.edit();
      assert.equal(page.document.querySelector('.floating-inspector img'),null);
      assert.equal([...page.document.querySelectorAll('.floating-inspector button')].some(button=>(button.getAttribute('aria-label')??button.textContent)==='Picker'),false);
      await page.choose('id');
      const pick=page.row().querySelector<HTMLButtonElement>('button.pick-from-screen')!;
      assert.equal(pick.closest('.element-field')?.querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!=null,true);
      assert.match(pick.title,/element/);
      assert.match(pick.title,/id/);
      await act(async()=>pick.click());
      const popped=page.card('Pick from screen')!;
      assert.ok(popped);
      assert.equal(popped.querySelector('img'),null);
      assert.equal(page.document.querySelector('.floating-inspector img'),null);
      await act(async()=>[...popped.querySelectorAll('button')].find(item=>item.textContent==='Refresh screen')!.click());
      const captureDeadline=Date.now()+8000;
      while(!popped.querySelector('img')&&Date.now()<captureDeadline){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});await page.settle();}
      assert.ok(popped.querySelector('img'),popped.querySelector('[role="alert"]')?.textContent??'Refresh did not show a capture.');
      assert.equal(page.document.querySelector('.floating-inspector img'),null);
      await act(async()=>popped.querySelector('img')!.dispatchEvent(new page.window.MouseEvent('click',{bubbles:true,clientX:10,clientY:10})));
      await page.settle();
      await act(async()=>popped.querySelector<HTMLInputElement>('input[name="picked-element"]')!.click());
      await act(async()=>[...popped.querySelectorAll('button')].find(item=>item.textContent==='Preview selector')!.click());
      await page.settle();
      await act(async()=>[...popped.querySelectorAll('button')].find(item=>item.textContent==='Use selector for check')!.click());
      const pickNotice=popped.querySelector('[role="alert"]');
      assert.match(pickNotice?.textContent??'',/no element id/);
      assert.match(pickNotice?.textContent??'',/targeted identifier/);
      assert.ok(page.card('Pick from screen'));
      assert.equal(page.row().querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!.value,'');
      const selectorField=popped.querySelector<HTMLTextAreaElement>('#picked-selector')!;
      selectorField.focus();
      await page.press(selectorField,'Escape');
      assert.ok(page.card('Pick from screen'));
      assert.equal(page.row().querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!.value,'');
      await act(async()=>[...popped.querySelectorAll('button')].find(item=>item.textContent==='Choose targeted identifier')!.click());
      await act(async()=>[...popped.querySelectorAll('button')].find(item=>item.textContent==='Preview selector')!.click());
      await page.settle();
      await act(async()=>[...popped.querySelectorAll('button')].find(item=>item.textContent==='Use selector for check')!.click());
      assert.equal(page.card('Pick from screen'),null);
      assert.equal(page.row().querySelector<HTMLInputElement>('input[aria-label$=" selector"]')!.value,'gear.button');
      assert.equal((page.row().querySelector('select[aria-label$=" matching"]') as HTMLSelectElement).value,'contains');
      assert.equal(page.document.activeElement,page.row().querySelector('button.pick-from-screen'));
    }finally{await page.close();}
  });

  test('YAML and Pick from screen cards drag, move from the keyboard, snap, persist and return focus',async()=>{
    const page=await openWorkspace('tap');
    try{
      await page.edit();
      await page.choose('id');
      const pick=page.row().querySelector<HTMLButtonElement>('button.pick-from-screen')!;
      await act(async()=>pick.click());
      const handle=page.card('Pick from screen')!.querySelector<HTMLElement>('[aria-label="Move Pick from screen"]')!;
      const start=page.origin('Pick from screen');
      await page.press(handle,'ArrowRight');
      await page.press(handle,'ArrowDown',true);
      assert.deepEqual(page.origin('Pick from screen'),{x:start.x+10,y:start.y+40});
      await page.drag(handle,-500,-500);
      assert.deepEqual(page.origin('Pick from screen'),{x:0,y:0});
      page.viewport.width=400;
      await act(async()=>page.window.dispatchEvent(new page.window.Event('resize')));
      assert.equal(page.origin('Pick from screen').x,0);
      await page.press(handle,'Escape');
      assert.equal(page.card('Pick from screen'),null);
      assert.equal(page.document.activeElement,pick);
      page.viewport.width=1200;
      await act(async()=>page.window.dispatchEvent(new page.window.Event('resize')));
      const opener=page.document.querySelector<HTMLButtonElement>('[aria-label="Open YAML"]')!;
      await act(async()=>opener.click());
      const yaml=page.card('YAML')!;
      assert.ok(yaml.querySelector('[aria-label="YAML form and code editor"]'));
      assert.equal(yaml.querySelector('textarea')!.id,'yaml-card');
      const yamlHandle=yaml.querySelector<HTMLElement>('[aria-label="Move YAML"]')!;
      const yamlStart=page.origin('YAML');
      const field=yaml.querySelector('textarea')!;
      field.focus();
      await page.press(field,'ArrowRight');
      await page.press(field,'Escape');
      assert.equal(page.card('YAML')!=null,true);
      assert.deepEqual(page.origin('YAML'),yamlStart);
      await page.press(yamlHandle,'ArrowLeft');
      assert.equal(page.origin('YAML').x,Math.max(0,yamlStart.x-10));
      const beforeSnap=page.origin('YAML');
      page.viewport.width=beforeSnap.x+parseFloat(yaml.style.width)-5;
      await act(async()=>page.window.dispatchEvent(new page.window.Event('resize')));
      const snapped=page.origin('YAML');
      assert.equal(snapped.x+parseFloat(yaml.style.width)<=page.viewport.width,true);
      await page.press(yamlHandle,'ArrowRight');
      assert.equal(page.origin('YAML').x,snapped.x);
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,400));});
      await page.settle();
      const view=await page.view();
      assert.deepEqual(view.cards?.picker,{x:0,y:0});
      assert.deepEqual(view.cards?.yaml,snapped);
      await act(async()=>page.document.querySelector<HTMLButtonElement>('[aria-label="Close YAML"]')!.click());
      assert.equal(page.document.activeElement,opener);
      await page.remount();
      await page.settle();
      const deadline=Date.now()+8000;
      while(!page.document.querySelector('[data-screen-id="home"]')&&Date.now()<deadline){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});await page.settle();}
      await inspectScreen(page.document,{id:'home'},{id:'visit-home'});
      await act(async()=>page.document.querySelector<HTMLButtonElement>('[aria-label="Open YAML"]')!.click());
      assert.deepEqual(page.origin('YAML'),snapped);
      const restored=page.card('YAML')!;
      assert.equal(page.document.querySelectorAll('#form-command').length,1);
      assert.equal(restored.querySelector('#form-command'),null);
      assert.ok(restored.querySelector('#yaml-card-form-command'));
      const beforeDelete=await page.service.workspace(page.workspace.id);
      await act(async()=>[...restored.querySelectorAll('button')].find(item=>item.textContent==='Command forms')!.click());
      await act(async()=>restored.querySelector<HTMLButtonElement>('[aria-label="Delete step 1"]')!.click());
      const warning=restored.querySelector('[aria-label="Step reference warning"]');
      if(warning)await act(async()=>[...warning.querySelectorAll('button')].find(item=>item.textContent==='Delete anyway')!.click());
      const deleted=await page.published(beforeDelete.metadata?.revision??0);
      assert.match(deleted.canvas?.screens[0].tests[0].reference.fingerprint??'',/^deleted:/);
    }finally{await page.close();}
  });

  test('YAML card keeps unapplied command and step drafts through close, reopen, and recovery',async()=>{
    const page=await openWorkspace('tap');
    const typeInto=async(input:HTMLInputElement,value:string)=>{await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});};
    try{
      const opener=page.document.querySelector<HTMLButtonElement>('[aria-label="Open YAML"]')!;
      await act(async()=>opener.click());
      const yaml=page.card('YAML')!;
      await act(async()=>[...yaml.querySelectorAll('button')].find(item=>item.textContent==='Command forms')!.click());
      await act(async()=>yaml.querySelector<HTMLButtonElement>('[aria-label="Details step 2"]')!.click());
      const command=yaml.querySelector<HTMLInputElement>('#yaml-card-form-value')!;
      const step=yaml.querySelector<HTMLInputElement>('.yaml-value input')!;
      assert.ok(command);assert.ok(step);
      await typeInto(command,'New command');
      await typeInto(step,'Gear pending');
      const deadline=Date.now()+8000;
      let fields:Record<string,string>={};
      while(Date.now()<deadline){
        await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
        await page.settle();
        fields=(await page.service.workspaceDetail(page.workspace.id)).draft?.fields??{};
        if(fields['yaml-command']==='New command'&&fields['yaml-form:1:text']==='Gear pending')break;
      }
      assert.equal(fields['yaml-command'],'New command');
      assert.equal(fields['yaml-form:1:text'],'Gear pending');
      assert.equal(Object.keys(fields).some(key=>key.startsWith('yaml-card-')),false);
      await act(async()=>yaml.querySelector<HTMLButtonElement>('[aria-label="Close YAML"]')!.click());
      assert.equal(page.card('YAML'),null);
      assert.equal(page.document.activeElement,opener);
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,400));});
      await page.settle();
      const kept=(await page.service.workspaceDetail(page.workspace.id)).draft?.fields??{};
      assert.equal(kept['yaml-command'],'New command');
      await act(async()=>opener.click());
      const reopened=page.card('YAML')!;
      assert.equal(reopened.querySelector<HTMLInputElement>('#yaml-card-form-value')!.value,'New command');
      assert.equal(reopened.querySelector<HTMLInputElement>('.yaml-value input')!.value,'Gear pending');
      await page.remount();
      await page.settle();
      const restoredDeadline=Date.now()+8000;
      while(!page.document.querySelector('[data-screen-id="home"]')&&Date.now()<restoredDeadline){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});await page.settle();}
      const restore=[...page.document.querySelectorAll('button')].find(item=>item.textContent==='Restore draft');
      assert.ok(restore);
      await act(async()=>restore.click());
      const afterRestore=Date.now()+8000;
      while(!page.document.querySelector('[data-screen-id="home"]')&&Date.now()<afterRestore){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});await page.settle();}
      await inspectScreen(page.document,{id:'home'},{id:'visit-home'});
      await act(async()=>page.document.querySelector<HTMLButtonElement>('[aria-label="Open YAML"]')!.click());
      const recovered=page.card('YAML')!;
      await act(async()=>[...recovered.querySelectorAll('button')].find(item=>item.textContent==='Command forms')!.click());
      await act(async()=>recovered.querySelector<HTMLButtonElement>('[aria-label="Details step 2"]')!.click());
      assert.equal(recovered.querySelector<HTMLInputElement>('#yaml-card-form-value')!.value,'New command');
      assert.equal(recovered.querySelector<HTMLInputElement>('.yaml-value input')!.value,'Gear pending');
      const advanced=await showAdvanced(page.document);
      assert.equal(advanced.querySelector<HTMLInputElement>('#form-value')!.value,'New command');
      await act(async()=>advanced.querySelector<HTMLButtonElement>('[aria-label="Details step 2"]')!.click());
      assert.equal(advanced.querySelector<HTMLInputElement>('.yaml-value input')!.value,'Gear pending');
      await act(async()=>[...advanced.querySelectorAll('button')].find(item=>item.textContent==='Reset step 2 text draft')!.click());
      assert.equal(advanced.querySelector('[aria-label="Reset step 2 text draft"]'),null);
      assert.equal(recovered.querySelector('[aria-label="Reset step 2 text draft"]'),null);
      assert.equal(recovered.querySelector<HTMLInputElement>('.yaml-value input')!.value,'.*Gear.*');
      const beforeAppend=await page.service.workspace(page.workspace.id);
      await act(async()=>[...recovered.querySelectorAll('button')].find(item=>item.textContent==='Append command')!.click());
      assert.equal(recovered.querySelector<HTMLInputElement>('#yaml-card-form-value')!.value,'');
      assert.equal(advanced.querySelector<HTMLInputElement>('#form-value')!.value,'');
      assert.match(page.document.querySelector<HTMLTextAreaElement>('#scenario-yaml')!.value,/tapOn: "New command"/);
      const saved=await page.published(beforeAppend.metadata?.revision??0);
      assert.match(saved.yaml,/tapOn: "New command"/);
      assert.equal((await page.service.workspaceDetail(page.workspace.id)).draft?.fields['yaml-command'],undefined);
      assert.equal((await page.service.workspaceDetail(page.workspace.id)).draft?.fields['yaml-form:1:text'],undefined);
      assert.equal(page.document.querySelector('.workspace-save-status')?.getAttribute('aria-label'),'Saved locally');
    }finally{await page.close();}
  });

  test('a recovered step draft applies in both YAML editors and then saves',async()=>{
    const page=await openWorkspace('tap');
    const typeInto=async(input:HTMLInputElement,value:string)=>{await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});};
    try{
      await act(async()=>page.document.querySelector<HTMLButtonElement>('[aria-label="Open YAML"]')!.click());
      const yaml=page.card('YAML')!;
      await act(async()=>[...yaml.querySelectorAll('button')].find(item=>item.textContent==='Command forms')!.click());
      await act(async()=>yaml.querySelector<HTMLButtonElement>('[aria-label="Details step 2"]')!.click());
      await typeInto(yaml.querySelector<HTMLInputElement>('.yaml-value input')!,'Gear pending');
      const deadline=Date.now()+8000;
      let stored='';
      while(Date.now()<deadline){
        await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
        await page.settle();
        stored=(await page.service.workspaceDetail(page.workspace.id)).draft?.fields['yaml-form:1:text']??'';
        if(stored==='Gear pending')break;
      }
      assert.equal(stored,'Gear pending');
      await page.remount();
      await page.settle();
      const restoredDeadline=Date.now()+8000;
      while(!page.document.querySelector('[data-screen-id="home"]')&&Date.now()<restoredDeadline){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});await page.settle();}
      await act(async()=>[...page.document.querySelectorAll('button')].find(item=>item.textContent==='Restore draft')!.click());
      const afterRestore=Date.now()+8000;
      while(!page.document.querySelector('[data-screen-id="home"]')&&Date.now()<afterRestore){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});await page.settle();}
      await inspectScreen(page.document,{id:'home'},{id:'visit-home'});
      await act(async()=>page.document.querySelector<HTMLButtonElement>('[aria-label="Open YAML"]')!.click());
      const card=page.card('YAML')!;
      await act(async()=>[...card.querySelectorAll('button')].find(item=>item.textContent==='Command forms')!.click());
      await act(async()=>card.querySelector<HTMLButtonElement>('[aria-label="Details step 2"]')!.click());
      const advanced=await showAdvanced(page.document);
      await act(async()=>advanced.querySelector<HTMLButtonElement>('[aria-label="Details step 2"]')!.click());
      assert.equal(card.querySelector<HTMLInputElement>('.yaml-value input')!.value,'Gear pending');
      assert.equal(advanced.querySelector<HTMLInputElement>('.yaml-value input')!.value,'Gear pending');
      const beforeApply=await page.service.workspace(page.workspace.id);
      await act(async()=>card.querySelector<HTMLButtonElement>('[aria-label="Apply step 2 text"]')!.click());
      assert.equal(card.querySelector('[aria-label="Reset step 2 text draft"]'),null);
      assert.equal(advanced.querySelector('[aria-label="Reset step 2 text draft"]'),null);
      assert.equal(card.querySelector<HTMLInputElement>('.yaml-value input')!.value,'Gear pending');
      assert.equal(advanced.querySelector<HTMLInputElement>('.yaml-value input')!.value,'Gear pending');
      assert.match(page.document.querySelector<HTMLTextAreaElement>('#scenario-yaml')!.value,/Gear pending/);
      await page.published(beforeApply.metadata?.revision??0);
      assert.equal((await page.service.workspaceDetail(page.workspace.id)).draft?.fields['yaml-form:1:text'],undefined);
      assert.equal(page.document.querySelector('.workspace-save-status')?.getAttribute('aria-label'),'Saved locally');
    }finally{await page.close();}
  });

  test('the YAML card and Advanced editor share one pending command',async()=>{
    const page=await openWorkspace('tap');
    const typeInto=async(input:HTMLInputElement,value:string)=>{await act(async()=>{Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new page.window.Event('input',{bubbles:true}));});};
    try{
      await act(async()=>page.document.querySelector<HTMLButtonElement>('[aria-label="Open YAML"]')!.click());
      const card=page.card('YAML')!;
      await act(async()=>[...card.querySelectorAll('button')].find(item=>item.textContent==='Command forms')!.click());
      await typeInto(card.querySelector<HTMLInputElement>('#yaml-card-form-value')!,'card pending');
      const advanced=await showAdvanced(page.document);
      assert.equal(advanced.querySelector<HTMLInputElement>('#form-value')!.value,'card pending');
      await typeInto(advanced.querySelector<HTMLInputElement>('#form-value')!,'advanced pending');
      assert.equal(card.querySelector<HTMLInputElement>('#yaml-card-form-value')!.value,'advanced pending');
      const deadline=Date.now()+8000;
      let stored='';
      while(Date.now()<deadline){
        await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
        await page.settle();
        stored=(await page.service.workspaceDetail(page.workspace.id)).draft?.fields['yaml-command']??'';
        if(stored==='advanced pending')break;
      }
      assert.equal(stored,'advanced pending');
      await page.remount();
      await page.settle();
      const restoredDeadline=Date.now()+8000;
      while(!page.document.querySelector('[data-screen-id="home"]')&&Date.now()<restoredDeadline){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});await page.settle();}
      await act(async()=>[...page.document.querySelectorAll('button')].find(item=>item.textContent==='Restore draft')!.click());
      const afterRestore=Date.now()+8000;
      while(!page.document.querySelector('[data-screen-id="home"]')&&Date.now()<afterRestore){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});await page.settle();}
      await inspectScreen(page.document,{id:'home'},{id:'visit-home'});
      await act(async()=>page.document.querySelector<HTMLButtonElement>('[aria-label="Open YAML"]')!.click());
      const restoredCard=page.card('YAML')!;
      await act(async()=>[...restoredCard.querySelectorAll('button')].find(item=>item.textContent==='Command forms')!.click());
      const restoredAdvanced=await showAdvanced(page.document);
      assert.equal(restoredCard.querySelector<HTMLInputElement>('#yaml-card-form-value')!.value,'advanced pending');
      assert.equal(restoredAdvanced.querySelector<HTMLInputElement>('#form-value')!.value,'advanced pending');
    }finally{await page.close();}
  });
});

async function showAdvanced(document:Document){
  const summary=[...document.querySelectorAll('summary')].find(item=>item.textContent?.startsWith('Advanced mode'));
  assert.ok(summary);
  const details=summary.closest('details');
  if(details&&!details.open)await act(async()=>summary.click());
  const editor=[...document.querySelectorAll('section[aria-label="YAML form and code editor"]')].find(section=>section.querySelector('#scenario-yaml'));
  assert.ok(editor);
  const forms=[...editor.querySelectorAll('button')].find(item=>item.textContent==='Command forms');
  assert.ok(forms);
  if(forms.getAttribute('aria-pressed')!=='true')await act(async()=>forms.click());
  return editor;
}
