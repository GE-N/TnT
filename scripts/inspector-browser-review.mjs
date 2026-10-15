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

const shots=[
 {name:'inspector-a11y-1440x900',width:1440,height:900,zoom:0.85,screen:'home',edit:false},
 {name:'inspector-a11y-1280x800',width:1280,height:800,zoom:0.85,screen:'home',edit:false},
 {name:'inspector-a11y-flip-clamped',width:1280,height:800,zoom:1.15,screen:'settings',edit:false},
 {name:'inspector-a11y-zoom-fixed',width:1440,height:900,zoom:0.5,screen:'profile',edit:false},
 {name:'inspector-a11y-contrast-targets',width:1440,height:900,zoom:0.85,screen:'home',edit:true},
];

const results=[];
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
  const metrics=await page.evaluate(()=>{
   const inspector=document.querySelector('.floating-inspector');
   if(!inspector)return {error:'missing inspector'};
   const close=inspector.querySelector('.floating-inspector-close');
   const summary=inspector.querySelector('.visit-step-summary');
   const styles=getComputedStyle(document.documentElement);
   summary?.focus();
   return {
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
   };
  });
  const file=resolve(evidence,shot.name+'.png');
  await page.screenshot({path:file,fullPage:false});
  results.push({...shot,file:'evidence/'+shot.name+'.png',...metrics});
  console.log(shot.name,metrics);
  await page.close();
 }
}finally{
 await browser.close();
 vite.kill('SIGTERM');
}

await writeFile(resolve(evidence,'inspector-a11y-metrics.json'),JSON.stringify(results,null,2));
console.log('Wrote',results.length,'screenshots and metrics');
