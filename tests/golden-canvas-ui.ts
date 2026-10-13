import {act,createElement,useState} from 'react';
import {JSDOM} from 'jsdom';
import {CanvasEditor} from '../src/canvas.js';
import type {CanvasGraph} from '../server/canvas.js';
import {workspaceCommand} from './workspace-ui-helpers.js';
import {captureState,withSeededIdsAsync,type GoldenFixture,type GoldenScript,type GoldenSnapshot} from './golden-canvas-runner.js';

const globalKeys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'] as const;

async function click(document:Document,label:string){
  if(label==='Open saved workspace'||label==='Save workspace')return workspaceCommand(document,label==='Save workspace'?'save':'open');
  await act(async()=>{
    const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>(item.getAttribute('aria-label')??item.textContent)===label);
    if(!button)throw new Error('Missing button '+label);
    if(button.disabled)throw new Error('Button is disabled: '+label);
    button.click();
  });
}

function installDom(dom:JSDOM){
  class ResizeObserver{observe(){}disconnect(){}}
  const descriptors=globalKeys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  for(const key of globalKeys){
    const value=key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key);
    Object.defineProperty(globalThis,key,{value,configurable:true});
  }
  return ()=>{
    for(const [key,descriptor] of descriptors){
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);
      else Reflect.deleteProperty(globalThis,key);
    }
  };
}

async function chooseDestination(document:Document,actionId:string,screenId:string){
  await act(async()=>{
    const row=document.querySelector<HTMLElement>(`[data-operation-id="${actionId}"]`);
    const select=row?.querySelector<HTMLSelectElement>('select[aria-label$=" destination"]');
    if(!select)throw new Error('Missing destination for '+actionId);
    Object.getOwnPropertyDescriptor(document.defaultView!.HTMLSelectElement.prototype,'value')!.set!.call(select,screenId);
    select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));
  });
}

async function confirmDeletion(document:Document){
  const dialog=document.querySelector('[role="alertdialog"]');
  if(!dialog)throw new Error('Deletion did not ask for confirmation.');
  await click(document,'Delete anyway');
}

async function perform(document:Document,script:GoldenScript,graph:()=>CanvasGraph){
  if(script.op==='connect'||script.op==='retarget'){
    if(!script.to)throw new Error(script.op+' requires a destination screen.');
    await chooseDestination(document,script.actionId,script.to);
  }else if(script.op==='clear-destination'){
    await chooseDestination(document,script.actionId,'');
    await confirmDeletion(document);
  }else if(script.op==='delete-step'){
    await act(async()=>{
      const button=document.querySelector<HTMLButtonElement>(`[data-operation-id="${script.actionId}"] button[aria-label^="Delete "]`);
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
  }else{
    await click(document,'Undo canvas deletion');
  }
  const error=document.querySelector('.notice.error[role="alert"]');
  if(error?.textContent)throw new Error(error.textContent);
}

export async function runUi(fixture:GoldenFixture):Promise<GoldenSnapshot>{
  return withSeededIdsAsync(async()=>{
    const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    const restore=installDom(dom);
    const {createRoot}=await import('react-dom/client');
    const root=createRoot(dom.window.document.getElementById('root')!);
    let graph=structuredClone(fixture.canvas);
    let yaml=fixture.yaml;
    function Host(){
      const [current,setCurrent]=useState(graph);
      const [source,setSource]=useState(yaml);
      graph=current;yaml=source;
      return createElement(CanvasEditor,{
        graph:current,
        onChange:next=>{if(next)setCurrent(next);},
        yaml:source,
        onYamlChange:setSource,
        catalog:[],
        diagnostics:[],
        pathId:fixture.pathId,
        onPathChange:()=>{},
        disabled:false,
        scenarioMode:fixture.scenarioMode,
        scenarioId:fixture.scenarioId,
        scenarios:fixture.scenarios,
      });
    }
    try{
      await act(async()=>root.render(createElement(Host)));
      const baseline=captureState({graph,yaml},fixture);
      const operations:GoldenSnapshot['operations']=[];
      for(const script of fixture.scripts){
        await perform(dom.window.document,script,()=>graph);
        operations.push({op:script.op,detail:script,result:captureState({graph,yaml},fixture)});
      }
      return {fixture:fixture.id,description:fixture.description,baseline,operations};
    }finally{
      await act(async()=>root.unmount());
      dom.window.close();
      restore();
    }
  });
}
