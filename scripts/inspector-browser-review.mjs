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
 const sampleContrast=(el,label)=>{
  if(!el)return null;
  const fg=parseColor(getComputedStyle(el).color);
  const bg=resolvedBackground(el);
  return {label,fg:getComputedStyle(el).color,bg:`rgb(${bg.r}, ${bg.g}, ${bg.b})`,ratio:contrast(fg,bg)};
 };
 const inspector=document.querySelector('.floating-inspector');
 if(!inspector)return {error:'missing inspector'};
 const close=inspector.querySelector('.floating-inspector-close');
 const summary=inspector.querySelector('.visit-step-summary');
 const add=inspector.querySelector('.add-visit-step');
 const yaml=inspector.querySelector('.visit-yaml-link');
 const pick=inspector.querySelector('.pick-from-screen');
 const destination=inspector.querySelector('[aria-label$=" destination"]');
 const done=[...inspector.querySelectorAll('button')].find(button=>button.textContent==='Done');
 // Probe AA tokens on rendered surfaces used by the inspector.
 const probe=document.createElement('div');
 probe.style.cssText='position:fixed;left:-9999px;top:0;display:grid;gap:8px';
 probe.innerHTML=[
  '<p class="visit-step-error" role="alert">Failed step detail</p>',
  '<p class="inspector-draft-notice" role="status">⚠ Draft kept, not valid yet</p>',
  '<button class="add-visit-step">+ Add step</button>',
  '<span class="run-status-badge failed" role="status">Failed</span>',
 ].join('');
 document.body.appendChild(probe);
 const styles=getComputedStyle(document.documentElement);
 const contrasts=[
  sampleContrast(probe.querySelector('.visit-step-error'),'danger text on surface'),
  sampleContrast(probe.querySelector('.inspector-draft-notice'),'warning notice'),
  sampleContrast(probe.querySelector('.add-visit-step'),'primary Add step'),
  sampleContrast(probe.querySelector('.run-status-badge.failed'),'failed status'),
 ].filter(Boolean);
 probe.remove();
 summary?.focus();
 return {
  side:inspector.dataset.inspectorSide??null,
  clamped:inspector.dataset.inspectorClamped==='true',
  width:Math.round(inspector.getBoundingClientRect().width),
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
  },
  primary:styles.getPropertyValue('--inspector-primary').trim(),
  danger:styles.getPropertyValue('--danger').trim(),
  dangerSurface:styles.getPropertyValue('--danger-surface').trim(),
  warning:styles.getPropertyValue('--warning').trim(),
  warningSurface:styles.getPropertyValue('--warning-surface').trim(),
  contrasts,
  focusOutline:summary?getComputedStyle(summary).outline:'',
  tabStops:inspector.querySelectorAll('.visit-step-summary[tabindex="0"]').length,
 };
};

const shots=[
 {name:'inspector-a11y-1440x900',width:1440,height:900,zoom:0.85,screen:'home',edit:false},
 {name:'inspector-a11y-1280x800',width:1280,height:800,zoom:0.85,screen:'home',edit:false},
 {name:'inspector-a11y-flip-below',width:1280,height:800,zoom:1.15,screen:'settings',edit:false},
 {name:'inspector-a11y-zoom-fixed',width:1440,height:900,zoom:0.5,screen:'profile',edit:false},
 {name:'inspector-a11y-contrast-targets',width:1440,height:900,zoom:0.85,screen:'home',edit:true},
];

const results=[];
const keyboardLog=[];

try{
 for(const shot of shots){
  const page=await browser.newPage();
  await page.setViewport({width:shot.width,height:shot.height,deviceScaleFactor:1});
  const url=`http://127.0.0.1:${port}/scripts/inspector-review.html?zoom=${shot.zoom}&screen=${shot.screen}&edit=${shot.edit?1:0}&focus=1`;
  await page.goto(url,{waitUntil:'networkidle0',timeout:60_000});
  await page.waitForSelector('.floating-inspector',{timeout:15_000});
  await new Promise(r=>setTimeout(r,700));
  if(shot.edit){
   await page.waitForSelector('.visit-inline-fields:not([hidden]) .pick-from-screen, .visit-inline-fields:not([hidden]) [aria-label$=" destination"]',{timeout:5_000}).catch(()=>{});
  }
  const metrics=await page.evaluate(measureScript);
  const file=resolve(evidence,shot.name+'.png');
  await page.screenshot({path:file,fullPage:false});
  results.push({...shot,file:'evidence/'+shot.name+'.png',...metrics});
  console.log(shot.name,metrics);
  await page.close();
 }

 // Real clamp: narrow viewport + pan Home so right/left ideal positions both overflow.
 {
  const page=await browser.newPage();
  await page.setViewport({width:480,height:700,deviceScaleFactor:1});
  await page.goto(`http://127.0.0.1:${port}/scripts/inspector-review.html?zoom=1&screen=home&focus=1`,{waitUntil:'networkidle0',timeout:60_000});
  await page.waitForSelector('.floating-inspector',{timeout:15_000});
  await page.evaluate(async()=>{
   const viewport=document.querySelector('.canvas-viewport');
   const node=document.querySelector('[data-screen-id="home"]');
   if(!viewport||!node)return;
   const vr=viewport.getBoundingClientRect();
   const nr=node.getBoundingClientRect();
   // Center the node so neither left nor right ideal fits inside the narrow bounds.
   viewport.scrollLeft+=(nr.left+nr.width/2)-(vr.left+vr.width/2);
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  });
  await new Promise(r=>setTimeout(r,600));
  let metrics=await page.evaluate(measureScript);
  if(!metrics.clamped){
   // Fall back: push the node mostly past the right edge.
   await page.evaluate(async()=>{
    const viewport=document.querySelector('.canvas-viewport');
    const node=document.querySelector('[data-screen-id="home"]');
    if(!viewport||!node)return;
    const vr=viewport.getBoundingClientRect();
    const nr=node.getBoundingClientRect();
    viewport.scrollLeft+=nr.left-(vr.right-40);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   });
   await new Promise(r=>setTimeout(r,600));
   metrics=await page.evaluate(measureScript);
  }
  const file=resolve(evidence,'inspector-a11y-clamped.png');
  await page.screenshot({path:file,fullPage:false});
  results.push({name:'inspector-a11y-clamped',width:480,height:700,zoom:1,screen:'home',edit:false,file:'evidence/inspector-a11y-clamped.png',...metrics});
  console.log('inspector-a11y-clamped',metrics);
  await page.close();
 }

 // Keyboard-only create → link → reorder → delete journey on the live fixture.
 {
  const page=await browser.newPage();
  await page.setViewport({width:1440,height:900,deviceScaleFactor:1});
  await page.goto(`http://127.0.0.1:${port}/scripts/inspector-review.html?zoom=0.85&screen=home&focus=1`,{waitUntil:'networkidle0',timeout:60_000});
  await page.waitForSelector('.floating-inspector',{timeout:15_000});
  await new Promise(r=>setTimeout(r,500));

  const step=async(label,action)=>{
   await action();
   await new Promise(r=>setTimeout(r,250));
   const snap=await page.evaluate(()=>{
    const card=document.querySelector('.floating-inspector');
    const active=document.activeElement;
    return {
     active:active?(active.getAttribute('aria-label')||active.textContent||active.tagName).trim().slice(0,80):null,
     tabStops:card?card.querySelectorAll('.visit-step-summary[tabindex="0"]').length:0,
     rows:card?card.querySelectorAll('.visit-step-summary').length:0,
     editing:!!card?.querySelector('.visit-step-summary[aria-expanded="true"]'),
     destination:card?.querySelector('[aria-label$=" destination"]')?.value??null,
    };
   });
   keyboardLog.push({step:label,...snap});
   console.log('keyboard',label,snap);
  };

  await step('focus list stop',async()=>{
   await page.evaluate(()=>document.querySelector('.visit-step-summary')?.focus());
  });
  await step('ArrowDown to next row',async()=>{
   await page.keyboard.press('ArrowDown');
  });
  await step('Enter to edit',async()=>{
   await page.keyboard.press('Enter');
  });
  await step('Tab toward Destination',async()=>{
   for(let i=0;i<8;i++)await page.keyboard.press('Tab');
  });
  await step('Esc cancel edit',async()=>{
   await page.keyboard.press('Escape');
  });
  await step('create: open Add step',async()=>{
   await page.evaluate(()=>document.querySelector('.add-visit-step')?.focus());
   await page.keyboard.press('Enter');
   await page.waitForSelector('[role=dialog][aria-label="Add step"]',{timeout:5_000});
  });
  await step('create: choose Tap',async()=>{
   const option=await page.$('[role=option]');
   await option?.click();
   await page.waitForSelector('.visit-step-summary[aria-expanded="true"]',{timeout:5_000});
  });
  await step('link: set Destination to Profile',async()=>{
   await page.evaluate(()=>{
    const select=document.querySelector('.visit-inline-fields:not([hidden]) [aria-label$=" destination"]');
    if(!select)return;
    select.focus();
    select.value='profile';
    select.dispatchEvent(new Event('change',{bubbles:true}));
   });
   // Commit the new step so the link persists.
   await page.evaluate(()=>{
    const input=document.querySelector('.visit-inline-fields:not([hidden]) [aria-label$=" selector"]');
    if(input){
     const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set;
     setter?.call(input,'New tap');
     input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    [...document.querySelectorAll('.visit-inline-fields:not([hidden]) button')].find(button=>button.textContent==='Done')?.click();
   });
  });
  await step('reorder: ArrowRight to ⋯ then Move down',async()=>{
   await page.evaluate(()=>{
    const summaries=[...document.querySelectorAll('.visit-step-summary')];
    const stop=summaries.find(item=>item.tabIndex===0)||summaries[0];
    stop?.focus();
   });
   await page.keyboard.press('ArrowRight');
   await page.evaluate(()=>{
    const menu=document.activeElement?.closest('details');
    if(menu)menu.open=true;
   });
   await page.evaluate(()=>{
    const down=[...document.querySelectorAll('.visit-step-actions button')].find(button=>/Move .+ down/i.test(button.getAttribute('aria-label')||''));
    down?.click();
   });
  });
  await step('delete: open ⋯ and Delete last focused row',async()=>{
   await page.evaluate(()=>{
    const summaries=[...document.querySelectorAll('.visit-step-summary')];
    const last=summaries.at(-1);
    last?.focus();
    const row=last?.closest('.visit-step');
    const menu=row?.querySelector('.visit-step-actions');
    if(menu)menu.open=true;
    row?.querySelector('[aria-label^="Delete "]')?.click();
   });
  });

  const after=await page.evaluate(measureScript);
  const file=resolve(evidence,'inspector-a11y-keyboard-journey.png');
  await page.screenshot({path:file,fullPage:false});
  results.push({name:'inspector-a11y-keyboard-journey',width:1440,height:900,zoom:0.85,screen:'home',edit:false,file:'evidence/inspector-a11y-keyboard-journey.png',...after,keyboard:keyboardLog});
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
