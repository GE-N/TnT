import {act,createElement} from 'react';
import {JSDOM} from 'jsdom';
import type {CanvasGraph} from '../server/canvas.js';
import {workspaceCommand} from './workspace-ui-helpers.js';
import {captureState,withSeededIdsAsync,type GoldenFixture,type GoldenScript,type GoldenSnapshot} from './golden-canvas-runner.js';

const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
const globalKeys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch','navigator'] as const;

function editorFailure(document:Document){
  return [...document.querySelectorAll('.canvas-editor .notice.error')].map(node=>node.textContent?.trim()??'').find(text=>text&&!text.includes('Before running')&&!text.includes('References need review'));
}

async function click(document:Document,label:string){
  await act(async()=>{
    const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>(item.getAttribute('aria-label')??item.textContent)===label);
    if(!button)throw new Error('Missing button '+label);
    if(button.disabled)throw new Error('Button is disabled: '+label);
    button.click();
  });
}

async function chooseDestination(document:Document,actionId:string,screenId:string,visitId?:string){
  await act(async()=>{
    const scope=visitId?document.querySelector<HTMLElement>(`[data-visit-id="${visitId}"]`):document;
    const row=scope?.querySelector<HTMLElement>(`[data-operation-id="${actionId}"]`);
    const select=row?.querySelector<HTMLSelectElement>('select[aria-label$=" destination"]');
    if(!select)throw new Error('Missing destination for '+actionId);
    Object.getOwnPropertyDescriptor(document.defaultView!.HTMLSelectElement.prototype,'value')!.set!.call(select,screenId);
    select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));
  });
}

async function confirmDeletion(document:Document){
  if(!document.querySelector('[role="alertdialog"]'))throw new Error('Deletion did not ask for confirmation.');
  await click(document,'Delete anyway');
}

async function editSelector(document:Document,actionId:string,value:string,visitId?:string){
  await act(async()=>{
    const scope=visitId?document.querySelector<HTMLElement>(`[data-visit-id="${visitId}"]`):document;
    const input=scope?.querySelector<HTMLInputElement>(`[data-operation-id="${actionId}"] input[aria-label$=" selector"], [data-operation-id="${actionId}"] input[aria-label$=" text"]`);
    if(!input)throw new Error('Missing selector for '+actionId);
    const prototype=input.tagName==='TEXTAREA'?document.defaultView!.HTMLTextAreaElement.prototype:document.defaultView!.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);
    input.dispatchEvent(new document.defaultView!.Event('input',{bubbles:true}));
  });
}

async function perform(document:Document,script:GoldenScript,graph:()=>CanvasGraph){
  if(script.op==='edit')await editSelector(document,script.actionId,script.value,script.visitId);
  else if(script.op==='connect'||script.op==='retarget'){
    if(!script.to)throw new Error(script.op+' requires a destination screen.');
    await chooseDestination(document,script.actionId,script.to,script.visitId);
  }else if(script.op==='clear-destination'){
    await chooseDestination(document,script.actionId,'',script.visitId);
    await confirmDeletion(document);
  }else if(script.op==='delete-step'){
    await act(async()=>{
      const scope=script.visitId?document.querySelector(`[data-visit-id="${script.visitId}"]`):document;
      const button=scope?.querySelector<HTMLButtonElement>(`[data-operation-id="${script.actionId}"] button[aria-label^="Delete "]`);
      if(!button)throw new Error('Missing delete control for '+script.actionId);
      button.click();
    });
    await confirmDeletion(document);
  }else if(script.op==='delete-connection'){
    const edge=graph().edges.find(item=>item.id===script.edgeId);
    if(!edge)throw new Error('Missing connection '+script.edgeId);
    await act(async()=>{
      const item=[...document.querySelectorAll<HTMLLIElement>('.canvas-edge-list li')].find(node=>node.textContent?.includes(edge.responseCondition));
      const button=[...item?.querySelectorAll<HTMLButtonElement>('button')??[]].find(node=>node.textContent==='Remove transition');
      if(!button)throw new Error('Missing Remove transition for '+edge.responseCondition);
      button.click();
    });
    await confirmDeletion(document);
  }else if(script.op==='delete-screen'){
    await act(async()=>{
      const node=document.querySelector<HTMLElement>(`[data-screen-id="${script.screenId}"]`);
      if(!node)throw new Error('Missing screen '+script.screenId);
      node.dispatchEvent(new document.defaultView!.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:80}));
    });
    await click(document,'Delete node');
    await confirmDeletion(document);
  }else await click(document,'Undo canvas deletion');
  const failure=editorFailure(document);
  if(failure)throw new Error(failure);
}

function installDom(dom:JSDOM){
  class ResizeObserver{observe(){}disconnect(){}}
  const descriptors=globalKeys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  const pending:Promise<Response>[]=[];
  return {pending,restore(){
    for(const [key,descriptor] of descriptors){
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);
      else Reflect.deleteProperty(globalThis,key);
    }
  },define(fetch:(path:string,options?:{body?:string})=>Promise<Response>){
    for(const key of globalKeys){
      const value=key==='fetch'?fetch:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:key==='navigator'?dom.window.navigator:Reflect.get(dom.window,key);
      Object.defineProperty(globalThis,key,{value,configurable:true});
    }
  }};
}

export async function runUi(fixture:GoldenFixture):Promise<GoldenSnapshot>{
  return withSeededIdsAsync(async()=>{
    const {mkdtemp,rm}=await import('node:fs/promises');
    const {join}=await import('node:path');
    const {tmpdir}=await import('node:os');
    const {createScenarios}=await import('../server/scenarios.js');
    const {createRunner}=await import('../server/runner.js');
    const directory=await mkdtemp(join(tmpdir(),'tnt-golden-ui-'));
    const service=createScenarios({root:directory,runner:createRunner({artifactDirectory:directory,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=>'2.11.0',run:async()=>({code:0,log:'',cleanup:{verified:true,detail:'Fixture exited'}})}});
    const scenarios=fixture.scenarioMode?fixture.scenarios.map(item=>({id:item.id,name:item.name,pathId:item.pathId??fixture.pathId,authoring:'canvas' as const,steps:[],inputs:{},parameters:{},enabledHandlerIds:[]})): [];
    const workspace=await service.save({name:fixture.id,yaml:fixture.yaml,canvas:structuredClone(fixture.canvas),flows:fixture.flows??{},automation:fixture.automation,scenarios});
    await service.saveView(workspace.id,{format:1,pathId:fixture.pathId,scenarioId:fixture.scenarioId??''});
    const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/'});
    const document=dom.window.document;
    const installed=installDom(dom);
    let latest:{yaml:string;canvas:CanvasGraph}|undefined;
    const request=async(path:string,options?:{body?:string})=>{
      try{
        const body=options?.body?JSON.parse(options.body):undefined;
        if(path==='/api/canvas/references'&&body?.canvas&&typeof body.yaml==='string')latest={yaml:body.yaml,canvas:body.canvas};
        const result=path==='/api/workspaces'?await service.save(body):path.startsWith('/api/workspaces?q=')?await service.listWorkspaces():path.endsWith('/open')?await service.openWorkspace(path.split('/')[3]):path==='/api/canvas/references'?await service.references(body):path.startsWith('/api/workspaces/')&&path.endsWith('/view')?await service.saveView(path.split('/')[3],body):path.startsWith('/api/workspaces/')?await service.workspace(path.split('/')[3]):{ok:true};
        return Response.json(result??{ok:true});
      }catch(error){return Response.json({error:error instanceof Error?error.message:'Failed'},{status:400});}
    };
    const fetch=(path:string,options?:{body?:string})=>{const result=request(path,options);installed.pending.push(result);return result;};
    installed.define(fetch);
    const {createRoot}=await import('react-dom/client');
    const {Scenarios}=await import('../src/scenarios.js');
    const root=createRoot(document.getElementById('root')!);
    const settle=async()=>{do{await Promise.all(installed.pending.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(installed.pending.length);};
    const published=async()=>{
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,400));});
      await settle();
      if(!latest)throw new Error('The workspace page did not publish its canvas.');
      return latest;
    };
    try{
      await act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId,bundleId:'com.example.App',launchBusy:false,onRunning:()=>{}})));
      await workspaceCommand(document,'open',settle);
      let current=await published();
      const baseline=captureState({graph:current.canvas,yaml:current.yaml},fixture);
      const operations:GoldenSnapshot['operations']=[];
      for(const script of fixture.scripts){
        latest=undefined;
        await perform(document,script,()=>current.canvas);
        current=await published();
        operations.push({op:script.op,detail:script,result:captureState({graph:current.canvas,yaml:current.yaml},fixture)});
      }
      return {fixture:fixture.id,description:fixture.description,baseline,operations};
    }finally{
      await act(async()=>root.unmount());
      dom.window.close();
      installed.restore();
      await rm(directory,{recursive:true,force:true});
    }
  });
}
