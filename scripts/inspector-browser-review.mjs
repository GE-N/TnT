#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const evidence=resolve(root,'docs/evidence');
const port=43151;
await mkdir(evidence,{recursive:true});

const viteBin=resolve(root,'node_modules/vite/bin/vite.js');
const vite=spawn(process.execPath,[viteBin,'--host','127.0.0.1','--port',String(port),'--strictPort'],{
 cwd:root,stdio:['ignore','pipe','pipe'],
});
let ready=false;
vite.stdout.on('data',chunk=>{if(String(chunk).includes('Local:'))ready=true;});
vite.stderr.on('data',chunk=>process.stderr.write(chunk));
for(let i=0;i<80&&!ready;i++)await new Promise(r=>setTimeout(r,250));
if(!ready){vite.kill();throw new Error('Vite failed to start');}

const browser=await puppeteer.launch({
 executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',
 headless:true,
 args:['--no-sandbox','--disable-gpu','--hide-scrollbars'],
 defaultViewport:null,
});

const measureScript=()=>{
 const parseColor=value=>{
  const match=String(value).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if(!match)return null;
  return {r:+match[1],g:+match[2],b:+match[3],a:match[4]===undefined?1:+match[4]};
 };
 const channel=c=>{const s=c/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4);};
 const luminance=({r,g,b})=>0.2126*channel(r)+0.7152*channel(g)+0.0722*channel(b);
 const contrast=(fg,bg)=>{
  if(!fg||!bg||fg.a===0)return null;
  const L1=luminance(fg);const L2=luminance(bg);
  const lighter=Math.max(L1,L2);const darker=Math.min(L1,L2);
  return Math.round(((lighter+0.05)/(darker+0.05))*100)/100;
 };
 const resolvedBackground=el=>{
  let node=el;
  while(node&&node!==document.documentElement){
   const bg=parseColor(getComputedStyle(node).backgroundColor);
   if(bg&&bg.a>0)return bg;
   node=node.parentElement;
  }
  return parseColor(getComputedStyle(document.body).backgroundColor)||{r:255,g:255,b:255,a:1};
 };
 const sizeOf=el=>{
  if(!el)return null;
  const box=el.getBoundingClientRect();
  return {w:Math.round(box.width),h:Math.round(box.height)};
 };
 const hex=color=>'#'+[color.r,color.g,color.b].map(value=>Math.round(value).toString(16).padStart(2,'0')).join('');
 const sampleContrast=(el,label)=>{
  if(!el)return null;
  const fg=parseColor(getComputedStyle(el).color);
  const bg=resolvedBackground(el);
  if(!fg||!bg)return null;
  return {label,foreground:hex(fg),background:hex(bg),ratio:contrast(fg,bg)};
 };
 const inspector=document.querySelector('.floating-inspector');
 if(!inspector)return {error:'missing inspector'};
 const visible=selector=>[...inspector.querySelectorAll(selector)].find(element=>element.getBoundingClientRect().height>=44)||null;
 const close=visible('.floating-inspector-close');
 const summary=visible('.visit-step-summary');
 const add=visible('.add-visit-step');
 const yaml=visible('.visit-yaml-link');
 const pick=visible('.pick-from-screen');
 const destination=visible('[aria-label$=" destination"]');
 const done=[...inspector.querySelectorAll('.visit-inline-fields:not([hidden]) button')].find(button=>button.textContent==='Done'&&button.getBoundingClientRect().height>=44);
 const matchBy=visible('.match-by label');
 const remove=visible('.visit-step-delete');
 const styles=getComputedStyle(document.documentElement);
 const active=document.activeElement;
 const contrasts=[
  sampleContrast(add,'primary Add step'),
  sampleContrast(inspector.querySelector('.visit-step-failed .visit-step-summary')||inspector.querySelector('.visit-step-error'),'danger on failed step'),
  sampleContrast(inspector.querySelector('.inspector-draft-notice'),'warning draft notice'),
 ].filter(Boolean);
 return {
  side:inspector.dataset.inspectorSide??null,
  clamped:inspector.dataset.inspectorClamped==='true',
  inspectorWidth:Math.round(inspector.getBoundingClientRect().width),
  viewport:{width:window.innerWidth,height:window.innerHeight},
  left:Math.round(inspector.getBoundingClientRect().left),
  top:Math.round(inspector.getBoundingClientRect().top),
  targets:{
   close:sizeOf(close),
   summary:sizeOf(summary),
   addStep:sizeOf(add),
   yaml:sizeOf(yaml),
   pick:sizeOf(pick),
   destination:sizeOf(destination),
   done:sizeOf(done),
   matchBy:sizeOf(matchBy),
   delete:sizeOf(remove),
  },
  primary:styles.getPropertyValue('--inspector-primary').trim(),
  danger:styles.getPropertyValue('--danger').trim(),
  dangerSurface:styles.getPropertyValue('--danger-surface').trim(),
  warning:styles.getPropertyValue('--warning').trim(),
  warningSurface:styles.getPropertyValue('--warning-surface').trim(),
  contrasts,
  focusOutline:active&&inspector.contains(active)?getComputedStyle(active).outline:'',
  focused:active&&active!==document.body?(active.getAttribute('aria-label')||(active.textContent||'').replace(/\s+/g,' ').trim().slice(0,80)||active.tagName):'body',
  tabStops:inspector.querySelectorAll('.visit-step-summary[tabindex="0"]').length,
 };
};

const shots=[
 {name:'inspector-a11y-1440x900',width:1440,height:900,zoom:0.85,screen:'home',edit:false},
 {name:'inspector-a11y-1280x800',width:1280,height:800,zoom:0.85,screen:'home',edit:false},
 {name:'inspector-a11y-flip-below',width:1280,height:800,zoom:1.15,screen:'settings',edit:false},
 {name:'inspector-a11y-zoom-fixed',width:1440,height:900,zoom:0.5,screen:'profile',edit:false},
 {name:'inspector-a11y-contrast-targets',width:1440,height:900,zoom:0.85,screen:'home',edit:true,failed:true,draft:true,keyboard:false},
];

async function focused(page){
 return page.evaluate(()=>{
  const element=document.activeElement;
  if(!element||element===document.body)return {label:'body',className:''};
  const label=element.getAttribute('aria-label')||(element.textContent??'').replace(/\s+/g,' ').trim().slice(0,80)||element.tagName;
  return {label,className:typeof element.className==='string'?element.className:''};
 });
}
async function tabUntil(page,ready,max=40){
 const seen=[];
 for(let step=0;step<max;step++){
  const info=await focused(page);
  seen.push(info.label);
  if(ready(info))return seen;
  await page.keyboard.press('Tab');
 }
 throw new Error('Tab did not reach a target: '+seen.join(' | '));
}
async function openScreen(page,title){
 await tabUntil(page,info=>info.label==='Screen '+title);
 await page.keyboard.press('Enter');
 await page.waitForFunction(name=>document.querySelector('.floating-inspector h3')?.textContent===name,{},title);
}

const results=[];
const keyboardLog=[];

try{
 for(const shot of shots){
  const page=await browser.newPage();
  await page.setViewport({width:shot.width,height:shot.height,deviceScaleFactor:1});
  const url=`http://127.0.0.1:${port}/scripts/inspector-review.html?zoom=${shot.zoom}&screen=${shot.screen}&edit=${shot.edit?1:0}&failed=${shot.failed?1:0}&draft=${shot.draft?1:0}`;
  await page.goto(url,{waitUntil:'networkidle0',timeout:60_000});
  await page.waitForSelector('.floating-inspector',{timeout:15_000});
  await new Promise(r=>setTimeout(r,700));
  if(shot.edit){
   await page.waitForSelector('.visit-inline-fields:not([hidden]) .pick-from-screen, .visit-inline-fields:not([hidden]) [aria-label$=" destination"]',{timeout:5_000}).catch(()=>{});
   await page.evaluate(()=>{const menu=document.querySelector('.visit-step-actions');if(menu)menu.open=true;});
  }else{
   const title={home:'Home',profile:'Profile',settings:'Settings'}[shot.screen]??'Home';
   await openScreen(page,title);
   await tabUntil(page,info=>info.className.includes('visit-step-summary'),8);
  }
  const metrics=await page.evaluate(measureScript);
  const file=resolve(evidence,shot.name+'.png');
  await page.screenshot({path:file,fullPage:false});
  results.push({...shot,file:'evidence/'+shot.name+'.png',...metrics});
  console.log(shot.name,metrics);
  await page.close();
 }

 // Real clamp: narrow+short viewport, pan Home to bottom-center so every ideal side moves.
 {
  const page=await browser.newPage();
  await page.setViewport({width:420,height:520,deviceScaleFactor:1});
  await page.goto(`http://127.0.0.1:${port}/scripts/inspector-review.html?zoom=0.85&screen=home&clamp=1`,{waitUntil:'networkidle0',timeout:60_000});
  await page.waitForSelector('.floating-inspector',{timeout:15_000});
  await new Promise(r=>setTimeout(r,900));
  let metrics=await page.evaluate(measureScript);
  if(!metrics.clamped){
   await page.evaluate(async()=>{
    const viewport=document.querySelector('.canvas-viewport');
    const node=document.querySelector('[data-screen-id="home"]');
    if(!viewport||!node)return;
    const vr=viewport.getBoundingClientRect();
    const nr=node.getBoundingClientRect();
    viewport.scrollLeft+=(nr.left+nr.width/2)-(vr.left+vr.width/2);
    viewport.scrollTop+=nr.bottom-(vr.bottom-20);
    window.dispatchEvent(new Event('resize'));
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   });
   await new Promise(r=>setTimeout(r,700));
   metrics=await page.evaluate(measureScript);
  }
  const file=resolve(evidence,'inspector-a11y-clamped.png');
  await page.screenshot({path:file,fullPage:false});
  results.push({name:'inspector-a11y-clamped',width:420,height:520,zoom:0.85,screen:'home',edit:false,clamp:true,file:'evidence/inspector-a11y-clamped.png',...metrics});
  console.log('inspector-a11y-clamped',metrics);
  await page.close();
 }

 // Keyboard-only create → link → reorder → delete. No element.focus() and no scripted clicks.
 {
  const page=await browser.newPage();
  await page.setViewport({width:1440,height:900,deviceScaleFactor:1});
  await page.goto(`http://127.0.0.1:${port}/scripts/inspector-review.html?zoom=0.85&screen=home`,{waitUntil:'networkidle0',timeout:60_000});
  await page.waitForSelector('.floating-inspector',{timeout:15_000});
  await new Promise(r=>setTimeout(r,500));
  const note=async(step,extra={})=>{const info=await focused(page);keyboardLog.push({step,...info,...extra});console.log('keyboard',step,info.label,extra);};
  const shiftTab=async()=>{await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');};
 const ids=()=>page.evaluate(()=>[...document.querySelectorAll('.floating-inspector .visit-step')].map(item=>item.getAttribute('data-operation-id')));
 await openScreen(page,'Home');
 const initialIds=await ids();
  await tabUntil(page,info=>info.className.includes('visit-step-summary'),8);
  const stopsBefore=await page.evaluate(()=>document.querySelectorAll('.floating-inspector .visit-step-summary[tabindex="0"]').length);
  if(stopsBefore!==1)throw new Error('Expected one list tab stop, got '+stopsBefore);
  await note('step list',{stops:stopsBefore});
  await page.keyboard.press('ArrowDown');
  await note('arrow down');
  await page.keyboard.press('ArrowUp');
  await note('arrow up');
  await page.keyboard.press('End');
  await note('end');
  await page.keyboard.press('Home');
  await tabUntil(page,info=>info.className.includes('add-visit-step')||info.label.includes('Add step'),6);
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('.add-step-dialog input')===document.activeElement);
  await note('add step dialog');
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>{
   const field=document.querySelector('.floating-inspector .visit-inline-fields:not([hidden]) input[aria-label$=" selector"]');
   return !!field&&document.activeElement===field;
  });
  await note('created step');
  await shiftTab();
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.floating-inspector .visit-inline-fields:not([hidden]) .pick-from-screen');
  await page.keyboard.press('Tab');
  await page.waitForFunction(()=>{
   const field=document.querySelector('.floating-inspector .visit-inline-fields:not([hidden]) input[aria-label$=" selector"]');
   return !!field&&document.activeElement===field;
  });
  await page.keyboard.type('created-id');
  const order=[];
  for(let step=0;step<12;step++){
   order.push((await focused(page)).label);
   if(order.at(-1)?.includes('Pick from screen'))break;
   await page.keyboard.press('Tab');
  }
  const destinationAt=order.findIndex(label=>label.endsWith('destination'));
  const pickAt=order.findIndex(label=>label.includes('Pick from screen'));
  const visual=await page.evaluate(()=>{
   const fields=document.querySelector('.floating-inspector .visit-inline-fields:not([hidden])');
   const pick=fields?.querySelector('.pick-from-screen')?.getBoundingClientRect();
   const destination=fields?.querySelector('[aria-label$=" destination"]')?.getBoundingClientRect();
   const selector=fields?.querySelector('[aria-label$=" selector"]')?.getBoundingClientRect();
   if(!pick||!destination||!selector)return null;
   return {pickTop:Math.round(pick.top),destinationTop:Math.round(destination.top),selectorTop:Math.round(selector.top),pickBesideSelector:Math.abs(pick.top-(selector.top+selector.height))<80};
  });
  keyboardLog.push({step:'tab order',order,destinationBeforePick:destinationAt>=0&&pickAt>destinationAt,visual});
  if(destinationAt<0||pickAt<=destinationAt)throw new Error('Destination did not precede Pick: '+order.join(' | '));
  if(!visual?.pickBesideSelector||!(visual.pickTop<visual.destinationTop))throw new Error('Pick is not packed with the element field above Destination: '+JSON.stringify(visual));
  for(let step=0;step<6&&!(await focused(page)).label.endsWith('destination');step++)await shiftTab();
  const destinationValue=()=>page.evaluate(()=>{
   const active=document.activeElement;
   return active&&active.tagName==='SELECT'&&(active.getAttribute('aria-label')??'').endsWith(' destination')?active.value:'';
  });
  if(!(await focused(page)).label.endsWith('destination'))throw new Error('Destination select was not focused: '+(await focused(page)).label);
  const before=await destinationValue();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await new Promise(r=>setTimeout(r,100));
  const after=await destinationValue();
  keyboardLog.push({step:'link',before,after,changed:before!==after&&after.length>0});
  if(!after||before===after)throw new Error('Destination did not change from the keyboard ('+before+' -> '+after+')');
  await tabUntil(page,info=>info.label==='Done',8);
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>{
   const active=document.activeElement;
   return !!active&&active.classList.contains('visit-step-summary')&&active.getAttribute('aria-expanded')==='false';
  });
 await note('committed step');
 const committedIds=await ids();
 const created=committedIds.filter(id=>id&&!initialIds.includes(id));
 if(created.length!==1)throw new Error('Expected one created step, got '+created.join(','));
 const linkedText=await page.evaluate(id=>document.querySelector(`[data-operation-id="${id}"] .visit-step-summary`)?.textContent?.replace(/\s+/g,' ').trim()??'',created[0]);
 if(!linkedText.includes('Profile'))throw new Error('Created step did not show destination Profile: '+linkedText);
 keyboardLog.push({step:'linked step',id:created[0],text:linkedText,orderedIds:committedIds});
 const beforeOrder=await ids();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await tabUntil(page,info=>info.label.startsWith('Move ')&&info.label.endsWith(' up'),6);
  await page.keyboard.press('Enter');
  try{
   await page.waitForFunction(previous=>JSON.stringify([...document.querySelectorAll('.floating-inspector .visit-step')].map(item=>item.getAttribute('data-operation-id')))!==previous,{timeout:4000},JSON.stringify(beforeOrder));
  }catch(error){
   throw new Error('Reorder did not change step ids. before='+beforeOrder.join(' | ')+' after='+(await ids()).join(' | ')+' focus='+(await focused(page)).label+' '+(error instanceof Error?error.message:''));
  }
  const afterOrder=await ids();
  keyboardLog.push({step:'reorder',beforeOrder,afterOrder,changed:true});
  for(let step=0;step<8&&!(await focused(page)).className.includes('visit-step-summary');step++)await shiftTab();
  if(!(await focused(page)).className.includes('visit-step-summary')){
   for(let step=0;step<8&&!(await focused(page)).className.includes('visit-step-summary');step++)await page.keyboard.press('Tab');
  }
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await tabUntil(page,info=>info.label.startsWith('Delete '),6);
  const deleted=(await focused(page)).label;
  const countBeforeDelete=(await page.evaluate(()=>document.querySelectorAll('.floating-inspector .visit-step-summary').length));
  await page.keyboard.press('Enter');
  await page.waitForFunction(previous=>{
   const summaries=[...document.querySelectorAll('.floating-inspector .visit-step-summary')];
   return summaries.length===previous-1&&summaries.filter(item=>item.tabIndex===0).length===1;
  },{},countBeforeDelete);
  const afterDelete=await page.evaluate(()=>{
   const summaries=[...document.querySelectorAll('.floating-inspector .visit-step-summary')];
   return {count:summaries.length,stops:summaries.filter(item=>item.tabIndex===0).length,labels:summaries.map(item=>item.getAttribute('aria-label'))};
  });
  const remaining=await ids();
 if(remaining.includes('avatar'))throw new Error('Deleted row avatar is still in the list');
 if(!remaining.includes(created[0]))throw new Error('Created step disappeared during delete');
 const focusImmediately=await focused(page);
 let focusAfter=focusImmediately;
 if(!focusAfter.className.includes('visit-step-summary')){
  for(let step=0;step<6&&!(await focused(page)).className.includes('visit-step-summary');step++)await shiftTab();
  if(!(await focused(page)).className.includes('visit-step-summary')){
   for(let step=0;step<8&&!(await focused(page)).className.includes('visit-step-summary');step++)await page.keyboard.press('Tab');
  }
 }
 focusAfter=await focused(page);
 if(!focusAfter.className.includes('visit-step-summary'))throw new Error('Focus could not return to the surviving list stop from '+focusAfter.label);
 const stopCount=await page.evaluate(()=>document.querySelectorAll('.floating-inspector .visit-step-summary[tabindex="0"]').length);
 if(stopCount!==1)throw new Error('Expected one list tab stop after returning focus, got '+stopCount);
 keyboardLog.push({step:'delete',target:deleted,afterDelete,remaining,focusImmediately:focusImmediately.label,focusAfter:focusAfter.label,stops:stopCount});
  const afterMetrics=await page.evaluate(measureScript);
  const file=resolve(evidence,'inspector-a11y-keyboard-journey.png');
  await page.screenshot({path:file,fullPage:false});
  results.push({name:'inspector-a11y-keyboard-journey',width:1440,height:900,zoom:0.85,screen:'home',edit:false,file:'evidence/inspector-a11y-keyboard-journey.png',...afterMetrics,keyboard:keyboardLog});
  await page.close();
 }
}finally{
 await browser.close();
 vite.kill('SIGTERM');
}

await writeFile(resolve(evidence,'inspector-a11y-metrics.json'),JSON.stringify({shots:results,keyboard:keyboardLog},null,2));
console.log('Wrote',results.length,'screenshots and metrics');
const clamped=results.find(item=>item.name==='inspector-a11y-clamped');
if(!clamped?.clamped){
 console.warn('WARNING: clamped shot did not record data-inspector-clamped=true; docs must not claim a full clamp pass.');
}
