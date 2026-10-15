import {createElement,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CanvasEditor} from '../src/canvas.js';
import {refreshChecks,writeChecks} from '../shared/canvas-authoring.js';
import type {CanvasGraph,CanvasTest} from '../server/canvas.js';
import '../src/style.css';

const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
const tap=(id:string,value:string):CanvasTest=>({id,label:value,role:'action',reference,tap:{target:'text',match:'exact',value}});
const check=(id:string,value:string):CanvasTest=>({id,label:value,role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value}});
const canvas:CanvasGraph={
 screens:[
  {id:'home',title:'Home',x:40,y:80,tests:[check('home-ready','Home'),tap('avatar','Avatar'),tap('gear-open','Open settings')]},
  {id:'profile',title:'Profile',x:420,y:80,tests:[check('profile-ready','Profile'),tap('back-home','Back')]},
  {id:'settings',title:'Settings',x:800,y:80,tests:[check('settings-ready','Settings')]},
 ],
 edges:[
  {id:'home-profile',from:'home',to:'profile',actionTestId:'avatar',assertionTestId:'profile-ready',responseCondition:'tap Avatar'},
  {id:'profile-settings',from:'profile',to:'settings',actionTestId:'back-home',assertionTestId:'settings-ready',responseCondition:'Open settings'},
 ],
 paths:[{id:'route',name:'Main',scenarioId:'main',screenId:'home',edgeIds:['home-profile','profile-settings'],visits:[{id:'v1'},{id:'v2'},{id:'v3'}]}],
};
const yaml=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas);
const params=new URLSearchParams(location.search);
const zoom=Number(params.get('zoom')||'0.85');
const screen=params.get('screen')||'home';
const edit=params.get('edit')==='1';
const focus=params.get('focus')==='1';

function Host(){
 const [graph,setGraph]=useState(()=>refreshChecks(canvas,yaml));
 const [source,setSource]=useState(yaml);
 const initialView=useMemo(()=>({zoom,scrollLeft:0,scrollTop:0,selectedScreenId:screen,selectedVisitId:screen==='home'?'v1':screen==='profile'?'v2':'v3'}),[]);
 return createElement('div',{className:'workbench'},createElement(CanvasEditor,{
  graph,onChange:next=>setGraph(next??graph),yaml:source,onYamlChange:setSource,catalog:[],diagnostics:[],
  pathId:'route',onPathChange:()=>{},disabled:false,scenarioMode:true,scenarioId:'main',
  scenarios:[{id:'main',name:'Main',pathId:'route'}],initialView,
 }));
}

const root=createRoot(document.getElementById('root')!);
root.render(createElement(Host));

requestAnimationFrame(()=>requestAnimationFrame(()=>{
 const card=document.querySelector<HTMLElement>('.floating-inspector');
 if(edit){
  const row=card?.querySelector<HTMLElement>('[data-operation-id="avatar"]')??card?.querySelector<HTMLElement>('.visit-step');
  row?.querySelector<HTMLButtonElement>('.visit-step-summary')?.click();
  requestAnimationFrame(()=>row?.querySelector<HTMLInputElement>('input[type=radio][value=id]')?.click());
 }
 if(focus){
  const target=card?.querySelector<HTMLElement>('.visit-step-summary')??card?.querySelector<HTMLElement>('.visit-section-heading');
  target?.focus();
 }
 const measure=()=>{
  const inspector=document.querySelector<HTMLElement>('.floating-inspector');
  if(!inspector)return;
  const close=inspector.querySelector<HTMLElement>('.floating-inspector-close');
  const summary=inspector.querySelector<HTMLElement>('.visit-step-summary');
  const styles=getComputedStyle(document.documentElement);
  const payload={
   side:inspector.dataset.inspectorSide??null,
   clamped:inspector.dataset.inspectorClamped==='true',
   width:Math.round(inspector.getBoundingClientRect().width),
   left:Math.round(inspector.getBoundingClientRect().left),
   top:Math.round(inspector.getBoundingClientRect().top),
   close:close?{w:Math.round(close.getBoundingClientRect().width),h:Math.round(close.getBoundingClientRect().height)}:null,
   summary:summary?{w:Math.round(summary.getBoundingClientRect().width),h:Math.round(summary.getBoundingClientRect().height)}:null,
   primary:styles.getPropertyValue('--inspector-primary').trim(),
   danger:styles.getPropertyValue('--danger').trim(),
   dangerSurface:styles.getPropertyValue('--danger-surface').trim(),
   warning:styles.getPropertyValue('--warning').trim(),
   warningSurface:styles.getPropertyValue('--warning-surface').trim(),
   focusOutline:summary?getComputedStyle(summary).outline:'',
   viewport:{width:window.innerWidth,height:window.innerHeight},
  };
  document.title='INSPECTOR_METRICS:'+JSON.stringify(payload);
 };
 setTimeout(measure,400);
}));
