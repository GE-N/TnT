import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {CanvasBoard} from '../src/canvas.js';
import {Scenarios} from '../src/scenarios.js';
import type {CanvasGraph,CanvasResult} from '../server/canvas.js';

const graph:CanvasGraph={screens:[{id:'home',title:'Home',x:40,y:40,referenceScreenshot:'data:image/png;base64,YQ==',tests:[{id:'check',label:'Visible Home',role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'stored'}}]}],edges:[],paths:[]};
test('screen cards retain only stored capture, title and nonidle symbolic outcome',()=>{
 const idle=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph}))).window.document;
 const card=idle.querySelector('[data-screen-id="home"]')!;
 assert.equal(card.querySelector('img')?.getAttribute('src'),graph.screens[0].referenceScreenshot);
 assert.match(card.textContent!,/Home/);
 assert.match(card.textContent!,/✓ Captured/);
 assert.equal(card.querySelector('.node-outcome'),null);
 assert.doesNotMatch(card.textContent!,/Visible Home|linked|Not run|Partly run|1 step/);
 const result:CanvasResult={pathId:'',note:'',screens:[{id:'home',status:'passed'}],tests:[],edges:[]};
 const completed=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph,result}))).window.document;
 assert.equal(completed.querySelector('.node-outcome')?.textContent,'✓ passed');
 const empty=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph:{...graph,screens:[{...graph.screens[0],referenceScreenshot:undefined}]}}))).window.document;
 assert.match(empty.querySelector('[data-screen-id]')!.textContent!,/No capture yet/);
 assert.equal(empty.querySelector('img'),null);
});
test('offline simulator status stays in the toolbar and Run exposes the disabled reason',()=>{
 const document=new JSDOM(renderToStaticMarkup(createElement(Scenarios,{token:'',deviceId:'',bundleId:'',launchBusy:false,onRunning:()=>{}}))).window.document;
 const toolbar=document.querySelector('[aria-label="Scenario run controls"]')!;
 assert.match(toolbar.textContent!,/○ Simulator not connected/);
 const run=toolbar.querySelector('button')!;
 assert.ok(run.hasAttribute('disabled'));
 assert.equal(run.getAttribute('aria-label'),'Run scenario — Simulator not connected');
 assert.equal(document.querySelectorAll('[role="status"]').length,2);
 assert.equal(document.querySelector('.picker'),null);
});
