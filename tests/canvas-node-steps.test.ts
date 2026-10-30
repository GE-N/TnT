import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {act,createElement,useState} from 'react';
import {RecoveredFields,WorkspaceDrafts,type DraftReport} from '../src/workspace-drafts.js';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import type {CanvasGraph,CanvasTest} from '../server/canvas.js';
import {CanvasBoard} from '../src/canvas.js';
import {edgeLabelBox,screenNodeSteps} from '../src/canvas-node-steps.js';

const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'stored'};
const step=(id:string,extra:Partial<CanvasTest>):CanvasTest=>({id,label:id,role:extra.check?'assertion':'action',reference,...extra});
const graph:CanvasGraph={
 screens:[
  {id:'login',title:'Login',x:40,y:40,referenceScreenshot:'data:image/png;base64,YQ==',tests:[
   step('help',{tap:{target:'text',match:'exact',value:'Help'}}),
   step('empty-tap',{tap:{target:'text',match:'exact',value:'  '}}),
   step('email',{input:'user@gmail.com'}),
   step('blank',{input:'   '}),
   step('secret',{input:'${PASSWORD}'}),
   step('redacted',{input:'p@ss [redacted] word'}),
   step('stars',{input:'****'}),
   step('back',{back:true}),
   step('close',{back:true,backSelector:{target:'text',match:'exact',value:'Close'}}),
   step('sign-in',{tap:{target:'text',match:'exact',value:'Sign in'}}),
   step('leave',{back:true,backSelector:{target:'id',match:'exact',value:'nav.back'}}),
   step('system-back',{back:true}),
   step('welcome',{check:{visibility:'visible',target:'text',match:'exact',value:'Welcome'}}),
   step('error',{check:{visibility:'absent',target:'text',match:'exact',value:'Error'}}),
   step('empty-check',{check:{visibility:'visible',target:'text',match:'exact',value:''}}),
   step('setup',{role:'setup'}),
   step('again',{input:'again'}),
  ]},
  {id:'home',title:'Home',x:400,y:40,tests:[step('home-check',{check:{visibility:'visible',target:'text',match:'exact',value:'Home'}})]},
  {id:'profile',title:'Profile',x:760,y:40,tests:[]},
  {id:'settings',title:'Settings',x:40,y:320,tests:[]},
  {id:'about',title:'About',x:400,y:320,tests:[]},
 ],
 edges:[
  {id:'signin',from:'login',to:'home',actionTestId:'sign-in',actionTestIds:['sign-in'],assertionTestId:'home-check',responseCondition:'Sign in when the form is valid and the account exists'},
  {id:'leave',from:'login',to:'profile',actionTestId:'leave',actionTestIds:['leave'],assertionTestId:'pending:leave',responseCondition:'Back'},
  {id:'system',from:'login',to:'settings',actionTestId:'system-back',actionTestIds:['system-back'],assertionTestId:'pending:system',responseCondition:'System back'},
  {id:'return',from:'home',to:'login',actionTestId:'home-check',actionTestIds:['home-check'],assertionTestId:'pending:return',responseCondition:'Back to login'},
 ],
 paths:[{id:'main',name:'Sign in',screenId:'login',scenarioId:'sign-in',edgeIds:['signin','return'],visits:[
  {id:'v1',operationIds:['help','empty-tap','email','blank','secret','redacted','stars','back','close','sign-in','leave','system-back','welcome','error','empty-check','setup']},
  {id:'v2',operationIds:['home-check']},
  {id:'v3',operationIds:['again']},
 ]}],
};
const route=graph.paths[0];

test('node steps use draft wording for every kind and keep secrets masked',()=>{
 const steps=screenNodeSteps(graph,route,'login');
 assert.deepEqual(steps.map(item=>item.text),[
  '1 · Tap Help',
  '2 · Tap',
  '3 · Input user@gmail.com',
  '4 · Input',
  '5 · Input ••••••',
  '6 · Input ••••••',
  '7 · Input ••••••',
  '8 · Back',
  '9 · Back Close',
  '10 · Go to Home',
  '11 · Go to Profile',
  '12 · Go to Settings',
  '13 · Check "Welcome" visible',
  '14 · Check "Error" absent',
  '15 · Check',
  '16 · Input again',
 ]);
 assert.deepEqual(steps.map(item=>item.specified),[true,false,true,false,true,true,true,false,true,true,true,false,true,true,false,true]);
 assert.equal(steps.some(item=>item.text.includes('PASSWORD')||item.text.includes('[redacted]')||item.text.includes('****')||item.text.includes('p@ss')),false);
 assert.equal(steps.some(item=>item.text.includes('setup')||item.text.includes('Setup')),false);
});

test('a screen visited twice lists every visit in order with continuous numbers',()=>{
 const steps=screenNodeSteps(graph,route,'login');
 assert.equal(steps[0].text,'1 · Tap Help');
 assert.equal(steps.at(-1)!.text,'16 · Input again');
 assert.deepEqual(steps.map(item=>item.visit),[...Array(15).fill(0),2]);
 assert.deepEqual(screenNodeSteps(graph,route,'home').map(item=>item.visit),[1]);
 assert.deepEqual(screenNodeSteps(graph,route,'home').map(item=>item.text),['1 · Check "Home" visible']);
 assert.deepEqual(screenNodeSteps(graph,route,'about'),[]);
 assert.deepEqual(screenNodeSteps(graph,undefined,'login'),[]);
 const quiet={...graph,paths:[{...route,visits:[{id:'v1',operationIds:[]},{id:'v2',operationIds:[]}]}]};
 assert.deepEqual(screenNodeSteps(quiet,quiet.paths[0],'login'),[]);
});

test('edge label width clamps to the span and stays centred above the curve',()=>{
 const box=(start:number,end:number,y=100)=>edgeLabelBox({x:start,y},{x:end,y});
 const short=box(0,40);
 assert.equal(short.width,80);
 assert.equal(short.x,(0+40)/2-40);
 const long=box(0,400);
 assert.equal(long.width,220);
 assert.equal(long.x,200-110);
 const mid=box(10,146);
 assert.equal(mid.width,120);
 assert.equal(mid.x,(10+146)/2-60);
 assert.equal(box(200,40).width,box(40,200).width);
 assert.equal(box(0,100,10).y,4);
 assert.equal(box(0,100,100).y,28);
 assert.equal(box(0,100).height,48);
});

test('a selected scenario draws steps on the solid card, with the capture when there is one',()=>{
 const document=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph,pathId:'main'}))).window.document;
 assert.doesNotMatch(document.body.textContent!,/No capture yet/);
 assert.equal(document.querySelector('.screen-capture-label'),null);
 const login=document.querySelector('[data-screen-id="login"]')!;
 assert.match(login.className,/screen-node/);
 assert.equal(login.className.includes('has-ai-draft-steps'),false);
 assert.equal(login.className.includes('ai-draft-node'),false);
 assert.equal(login.querySelector('img')?.getAttribute('src'),graph.screens[0].referenceScreenshot);
 assert.deepEqual([...login.querySelectorAll('.screen-node-steps li')].map(item=>item.textContent),['1 · Tap Help','2 · Tap','3 · Input user@gmail.com','4 · Input','5 · Input ••••••','6 · Input ••••••','7 · Input ••••••','8 · Back','9 · Back Close','10 · Go to Home','11 · Go to Profile','12 · Go to Settings','13 · Check "Welcome" visible','14 · Check "Error" absent','15 · Check','16 · Input again']);
 assert.equal(login.querySelector('.screen-node-steps li:nth-child(3)')!.className,'is-specified');
 assert.equal(login.querySelector('.screen-node-steps li:nth-child(4)')!.className,'');
 assert.equal(login.querySelectorAll('.starts-visit').length,1);
 assert.equal(login.querySelector('.starts-visit')!.textContent,'16 · Input again');
 assert.equal(login.querySelector('.starts-visit')!.className,'is-specified starts-visit');
 assert.doesNotMatch(login.textContent!,/PASSWORD|\[redacted\]|\*\*\*\*/);
 const home=document.querySelector('[data-screen-id="home"]')!;
 assert.equal(home.querySelector('img'),null);
 assert.deepEqual([...home.querySelectorAll('.screen-node-steps li')].map(item=>item.textContent),['1 · Check "Home" visible']);
 assert.equal(home.querySelectorAll('.starts-visit').length,0);
 const about=document.querySelector('[data-screen-id="about"]')!;
 assert.equal(about.querySelector('.screen-node-steps'),null);
 assert.equal(about.querySelector('.screen-capture-label'),null);
 assert.doesNotMatch(about.textContent!,/No capture yet/);
 const idle=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph}))).window.document;
 assert.equal(idle.querySelector('.screen-node-steps'),null);
 assert.doesNotMatch(idle.body.textContent!,/No capture yet/);
 const drafted=renderToStaticMarkup(createElement(CanvasBoard,{graph,pathId:'main',draftOverlay:{nodes:[],edges:[],anchors:[],existing:[{screenId:'login',key:'extra',steps:[{text:'9 · Tap Extra',specified:true}]}]}}));
 assert.ok(drafted.indexOf('screen-node-steps')<drafted.indexOf('ai-draft-existing-steps'));
 assert.match(drafted,/9 · Tap Extra/);
 const label=document.querySelector('.transition-label')!;
 assert.equal(label.querySelector('span')?.textContent,'Sign in when the form is valid and the account exists');
 assert.match(label.querySelector('small')!.textContent!,/Visits 1 → 2/);
 const box=edgeLabelBox({x:40+258,y:40+58},{x:400-8,y:40+58});
 const object=document.querySelector('foreignObject')!;
 assert.equal(object.getAttribute('width'),String(box.width));
 assert.equal(object.getAttribute('x'),String(box.x));
 assert.equal(object.getAttribute('y'),String(box.y));
 assert.equal(object.getAttribute('height'),String(box.height));
});

test('edge labels are boxless 11px text and the version-preview pill stays boxed',()=>{
 const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
 const label=css.match(/\.transition-label\{[^}]*\}/)![0];
 assert.match(label,/font:11px\/1\.35 system-ui/);
 assert.match(label,/overflow:hidden/);
 assert.match(label,/background:transparent/);
 assert.match(label,/border:0/);
 assert.doesNotMatch(label,/overflow:auto|max-height|background:var\(--surface\)|border:1px|border-radius:5px/);
 assert.match(css,/\.transition-label>span\{[^}]*-webkit-line-clamp:2/);
 assert.match(css,/\.transition-label small\{[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/);
 assert.match(css,/\.workbench \.transition-label,\.workbench \.transition-label small\{font-size:calc\(11px \/ var\(--canvas-zoom,1\)\)/);
 assert.equal(css.includes('.highlighted-transition .transition-label{border'),false);
 assert.match(css,/\.highlighted-transition \.transition-label,\.highlighted-transition \.transition-label small\{color:var\(--inspector-selected-text\)\}/);
 const draft=css.match(/(?:^|\n)\.ai-draft-edge\{[^}]*\}/)![0];
 assert.match(draft,/font-size:11px/);
 assert.match(draft,/-webkit-line-clamp:2/);
 assert.match(draft,/color:#5f6368/);
 assert.match(draft,/background:transparent/);
 assert.doesNotMatch(draft,/background:#fff|border-radius:999px|box-shadow:0 0 0/);
 assert.match(css,/\.screen-node-steps li\{[^}]*font-size:13px/);
 assert.match(css,/\.screen-node-steps li\.starts-visit\{[^}]*margin-top:8px;padding-top:6px;border-top:1px solid var\(--border\)/);
 assert.match(css,/\.screen-node-steps li\.is-specified\{color:#0a63d1\}/);
 assert.doesNotMatch(css,/\.screen-node-title\{[^}]*(?:dashed|border-bottom)/);
 assert.equal(css.includes('screen-title-placeholder'),false);
 assert.match(css,/\.screen-node\{[^}]*z-index:3/);
 assert.equal(css.includes('screen-capture-label'),false);
 const source=readFileSync(new URL('../src/canvas.tsx',import.meta.url),'utf8');
 assert.equal(source.includes('NodeTitle'),false);
 assert.equal(source.includes('screen-title-placeholder'),false);
 assert.match(source,/width="180" height="36"><div className="ai-version-edge">/);
});

test('a visit with no mapped steps adds no divider',()=>{
 const mini:CanvasGraph={
  screens:[{id:'a',title:'A',x:0,y:0,tests:[
   step('t1',{check:{visibility:'visible',target:'text',match:'exact',value:'One'}}),
   step('setup-only',{role:'setup'}),
   step('t2',{check:{visibility:'visible',target:'text',match:'exact',value:'Two'}}),
  ]}],
  edges:[
   {id:'e1',from:'a',to:'a',actionTestId:'t1',actionTestIds:['t1'],assertionTestId:'t1',responseCondition:'Again'},
   {id:'e2',from:'a',to:'a',actionTestId:'t2',actionTestIds:['t2'],assertionTestId:'t2',responseCondition:'Return'},
  ],
  paths:[{id:'p',name:'Loop',screenId:'a',edgeIds:['e1','e2'],visits:[
   {id:'v1',operationIds:['t1']},
   {id:'v2',operationIds:['setup-only']},
   {id:'v3',operationIds:['t2']},
  ]}],
 };
 const steps=screenNodeSteps(mini,mini.paths[0],'a');
 assert.deepEqual(steps.map(item=>item.text),['1 · Check "One" visible','2 · Check "Two" visible']);
 assert.deepEqual(steps.map(item=>item.visit),[0,2]);
 const document=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph:mini,pathId:'p'}))).window.document;
 const items=[...document.querySelectorAll('.screen-node-steps li')];
 assert.equal(items.filter(item=>item.classList.contains('starts-visit')).length,1);
 assert.equal(items[0].classList.contains('starts-visit'),false);
 assert.equal(items[1].textContent,'2 · Check "Two" visible');
 assert.equal(items[1].classList.contains('starts-visit'),true);
});

test('rename is a menu action and the header title drags or selects',async()=>{
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','KeyboardEvent','PointerEvent','ResizeObserver','MutationObserver','IS_REACT_ACT_ENVIRONMENT'];
 const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');
 const root=createRoot(dom.window.document.getElementById('root')!);
 const initial:CanvasGraph={screens:[{id:'login',title:'Login',x:40,y:40,tests:[]}],edges:[],paths:[]};
 const selected:string[]=[];const renamed:string[]=[];const moved:Array<[string,number,number]>=[];
 function Host(){
  const [graph,setGraph]=useState(initial);
  const [current,setCurrent]=useState('');
  return createElement(CanvasBoard,{graph,selected:current,initialView:{zoom:1},onSelect:(id:string)=>{selected.push(id);setCurrent(id);},onCloseInspector:()=>setCurrent(''),renderInspector:()=>createElement('p',null,'Inspector open'),onRename:(id:string,title:string)=>{renamed.push(title);setGraph(value=>({...value,screens:value.screens.map(screen=>screen.id===id?{...screen,title}:screen)}));},onMove:(id:string,x:number,y:number)=>{moved.push([id,x,y]);setGraph(value=>({...value,screens:value.screens.map(screen=>screen.id===id?{...screen,x,y}:screen)}));},onDelete:()=>{},onInfo:()=>{},onAppend:()=>{}});
 }
 const document=dom.window.document;
 const pointer=(target:Element,type:string,x:number,y:number)=>target.dispatchEvent(new dom.window.PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,pointerId:1}));
 const typeTitle=async(label:string,value:string)=>act(async()=>{const input=document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;assert.ok(input,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Host)));
  assert.equal(document.querySelector('[aria-label^="Screen title for "]'),null);
  const titleText=()=>document.querySelector('.screen-node-heading > span:nth-child(2)')!;
  await act(async()=>titleText().dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));
  assert.deepEqual(selected,['login']);
  assert.ok(document.querySelector('.floating-inspector'));
  await act(async()=>{pointer(titleText(),'pointerdown',0,0);pointer(titleText(),'pointermove',10,0);pointer(titleText(),'pointerup',10,0);});
  assert.deepEqual(moved,[['login',50,40]]);
  const node=document.querySelector('[data-screen-id="login"]')!;
  await act(async()=>node.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:40})));
  assert.deepEqual([...document.querySelectorAll('[role=menuitem]')].map(item=>item.textContent),['Add to sequence','Rename','Node info','Delete node']);
  await act(async()=>document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  const heading=document.querySelector<HTMLButtonElement>('.screen-node-heading')!;
  heading.focus();
  await act(async()=>heading.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true})));
  assert.equal(document.activeElement?.textContent,'Add to sequence');
  await act(async()=>document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));
  assert.equal(document.activeElement?.textContent,'Rename');
  await act(async()=>(document.activeElement as HTMLButtonElement).click());
  const input=document.querySelector('[aria-label="Screen title for Login"]') as HTMLInputElement;
  assert.equal(document.activeElement,input);
  assert.equal(input.selectionStart,0);
  assert.equal(input.selectionEnd,input.value.length);
  await typeTitle('Screen title for Login','Lobby');
  await act(async()=>document.querySelector('[aria-label="Screen title for Login"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
  assert.deepEqual(renamed,['Lobby']);
  assert.equal(document.querySelector('[aria-label="Screen title for Lobby"]'),null);
  assert.equal(document.activeElement,document.querySelector('.screen-node-heading'));
  assert.notEqual(document.activeElement,document.body);
  assert.ok(document.querySelector('.floating-inspector'));
  await act(async()=>node.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:40})));
  await act(async()=>{const rename=[...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(button=>button.textContent==='Rename');assert.ok(rename);rename.click();});
  await typeTitle('Screen title for Lobby','Nope');
  await act(async()=>document.querySelector('[aria-label="Screen title for Lobby"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.deepEqual(renamed,['Lobby']);
  assert.equal(document.querySelector('[aria-label^="Screen title for "]'),null);
  assert.equal(document.activeElement,document.querySelector('.screen-node-heading'));
  assert.ok(document.querySelector('.floating-inspector'));
  await act(async()=>node.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:40})));
  await act(async()=>{const rename=[...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(button=>button.textContent==='Rename');assert.ok(rename);rename.click();});
  await typeTitle('Screen title for Lobby','Desk');
  await act(async()=>document.querySelector('[aria-label="Screen title for Lobby"]')!.dispatchEvent(new dom.window.FocusEvent('focusout',{bubbles:true})));
  assert.deepEqual(renamed,['Lobby','Desk']);
  assert.equal(document.activeElement,document.querySelector('.screen-node-heading'));
  await act(async()=>document.querySelector('[data-screen-id="login"]')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:40})));
  await act(async()=>{const rename=[...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(button=>button.textContent==='Rename');assert.ok(rename);rename.click();});
  await typeTitle('Screen title for Desk','   ');
  await act(async()=>document.querySelector('[aria-label="Screen title for Desk"]')!.dispatchEvent(new dom.window.FocusEvent('focusout',{bubbles:true})));
  assert.deepEqual(renamed,['Lobby','Desk']);
  assert.equal(document.querySelector('[aria-label^="Screen title for "]'),null);
  assert.equal(document.activeElement,document.querySelector('.screen-node-heading'));
  await act(async()=>document.querySelector('[data-screen-id="login"]')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:40})));
  await act(async()=>{const rename=[...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(button=>button.textContent==='Rename');assert.ok(rename);rename.click();});
  const editing=document.querySelector('.screen-node-title')!;
  const moves=moved.length;
  await act(async()=>{pointer(editing,'pointerdown',0,0);pointer(editing,'pointermove',30,12);pointer(editing,'pointerup',30,12);});
  assert.equal(moved.length,moves);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('a recovered screen title reopens the rename field',async()=>{
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];
 const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');
 const root=createRoot(dom.window.document.getElementById('root')!);
 const reports:DraftReport[]=[];
 const fields={'screen-title:login':'Recovered login'};
 function Host(){return createElement(WorkspaceDrafts.Provider,{value:(_id:string,report:DraftReport)=>{reports.push(report);}},createElement(RecoveredFields.Provider,{value:fields},createElement(CanvasBoard,{graph,onRename:()=>{},onDelete:()=>{}})));}
 try{
  await act(async()=>root.render(createElement(Host)));
  const input=dom.window.document.querySelector('[aria-label="Screen title for Login"]') as HTMLInputElement;
  assert.ok(input);
  assert.equal(input.value,'Recovered login');
  assert.equal(input.selectionStart,0);
  assert.equal(input.selectionEnd,'Recovered login'.length);
  assert.equal(dom.window.document.activeElement,input);
  assert.ok(reports.some(report=>report.pending&&report.key==='screen-title:login'&&report.value==='Recovered login'));
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
