import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkspaceStore} from '../server/workspace-store.js';
import {createRunner} from '../server/runner.js';
import {createScenarios} from '../server/scenarios.js';
import {createApiHandler} from '../server/http.js';
import {createKnowledgeService,KnowledgeError,type ContextContent,type KnowledgeService} from '../server/knowledge/index.js';
import {referenceCatalog} from '../server/canvas.js';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';
import {renderKnowledgeHtml} from '../server/knowledge/html/index.js';

const content:ContextContent={purpose:'<script>alert(1)</script><a href="javascript:alert(1)">x</a>"><img src=x onerror=alert(1)>',expectedOutcome:'Contacts are visible',rationale:'Find the person',preconditions:'Signed in',exceptions:'Empty directory',scope:'Display only'};
const yaml='appId: com.example.App\n---\n- launchApp\n- tapOn: Continue\n- assertVisible: Directory\n';
function definition(source=yaml):ScenarioDefinition{
  return {id:'directory',name:'Directory',steps:referenceCatalog(source).references.filter(ref=>ref.kind==='step').map(({kind,file,index,fingerprint})=>({kind,file,index,fingerprint})),inputs:{},parameters:{},enabledHandlerIds:[]};
}
function statusBlock(html:string){return /<div id="knowledge-status">([\s\S]*?)<\/div>/.exec(html)?.[1]??'';}
async function generationFile(root:string,id:string){
  const pointer=JSON.parse(await readFile(join(root,'knowledge','current','workspace-'+id+'.json'),'utf8')) as {generationId:string};
  const directory=join(root,'knowledge','generations','workspace-'+id,pointer.generationId);
  return {pointer,html:await readFile(join(directory,'index.html'),'utf8'),directory};
}
async function fixture(knowledgeOverride?:(knowledge:KnowledgeService)=>KnowledgeService){
  const root=await mkdtemp(join(tmpdir(),'tnt-knowledge-reader-http-'));
  const store=createWorkspaceStore(root,workspace=>workspace);
  const workspace=await store.save({id:'',name:'Knowledge reader',yaml,scenarios:[definition()]});
  const knowledge=createKnowledgeService({root,store,renderHtml:renderKnowledgeHtml,queue:{enqueue(){}},reconcileIntervalMs:0});
  const runner=createRunner({artifactDirectory:join(root,'launches'),execute:async()=>({stdout:JSON.stringify({devices:{}}),stderr:''})});
  const server=createServer(createApiHandler(runner,join(root,'launches'),undefined,undefined,undefined,knowledgeOverride?.(knowledge)??knowledge));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('No server');
  const base='http://127.0.0.1:'+address.port;
  const page='/knowledge/workspaces/'+workspace.id+'/';
  return {root,store,workspace,knowledge,base,page,async close(){knowledge.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(root,{recursive:true,force:true});}};
}

test('live reader rechecks freshness and the generation file stays an As-of snapshot',async()=>{
  const f=await fixture();
  try{
    await f.knowledge.saveContext(f.workspace.id,'directory',{expectedContextRevision:0,context:content});
    await f.knowledge.publish(f.workspace.id);
    const live=await fetch(f.base+f.page);assert.equal(live.status,200);assert.equal(live.headers.get('cache-control'),'no-store');assert.equal(live.headers.get('x-content-type-options'),'nosniff');
    const csp=live.headers.get('content-security-policy')??'';assert.match(csp,/default-src 'none'/);assert.match(csp,/script-src 'none'/);assert.match(csp,/sandbox/);
    const body=await live.text();
    assert.match(body,/Up to date/);assert.match(body,/checked live/);assert.match(body,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.match(body,/Purpose/);assert.match(body,/Why this flow exists/);assert.match(body,/Tap text · Continue/);
    assert.doesNotMatch(body,/<script/i);assert.doesNotMatch(body,/<img/i);assert.doesNotMatch(body,/href="javascript:/i);assert.doesNotMatch(body,/can't check freshness/);
    const hrefs=[...body.matchAll(/\shref\s*=\s*"([^"]*)"/g)].map(match=>match[1]);
    assert.ok(hrefs.every(href=>href==='#scenario-directory'||href==='/knowledge/workspaces/'+f.workspace.id+'/'));
    const file=await generationFile(f.root,f.workspace.id);
    assert.match(statusBlock(file.html),/As of .+ \(UTC\+7\)/);assert.doesNotMatch(file.html,/Up to date|Needs review|checked live/);
    const index=await fetch(f.base+'/knowledge/');assert.equal(index.status,200);const indexBody=await index.text();
    assert.match(indexBody,new RegExp('href="/knowledge/workspaces/'+f.workspace.id+'/"'));assert.match(indexBody,/Up to date/);
    const head=await fetch(f.base+f.page,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    const changed=yaml.replace('Continue','Next');
    await f.store.save({...f.workspace,yaml:changed,scenarios:[definition(changed)]},f.workspace.metadata?.revision??1);
    const review=await (await fetch(f.base+f.page)).text();
    assert.match(review,/Needs review/);assert.match(review,/The saved flow changed after this context was reviewed/);assert.match(review,/intent-needs-review/);assert.match(review,/publication-stale/);
    assert.match(review,/role="dialog"/);assert.doesNotMatch(review,/Up to date/);assert.match(review,/Tap text · Continue/);assert.doesNotMatch(review,/Tap text · Next/);
    const before=await readFile(join(file.directory,'index.html'));
    for(const method of ['POST','PUT','PATCH','DELETE']){
      const rejected=await fetch(f.base+f.page,{method});assert.equal(rejected.status,405);assert.match(rejected.headers.get('allow')??'',/GET/);
    }
    assert.deepEqual(await readFile(join(file.directory,'index.html')),before);
    const secret='TOP-SECRET-MARKER';await writeFile(join(f.root,'secret.txt'),secret);
    for(const path of [
      '/knowledge/workspaces/../'+f.workspace.id+'/',
      '/knowledge/workspaces/'+f.workspace.id+'/../../secret.txt',
      '/knowledge/workspaces/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/knowledge/workspaces/'+encodeURIComponent('../'+f.workspace.id)+'/',
      '/knowledge/workspaces/'+f.workspace.id+'/workspaces/'+f.workspace.id+'.html',
      '/knowledge/%2e%2e/secret.txt',
    ]){
      const response=await fetch(f.base+path);assert.ok([400,404,405].includes(response.status),path+' returned '+response.status);assert.doesNotMatch(await response.text(),/TOP-SECRET-MARKER/);
    }
    const bad=await fetch(f.base+'/knowledge/workspaces/not-a-uuid/');const badBody=await bad.text();assert.equal(bad.status,400);assert.match(badBody,/Invalid workspace identifier/);assert.doesNotMatch(badBody,/not-a-uuid/);
    await f.store.save({...f.workspace,yaml:changed,scenarios:[]},(f.workspace.metadata?.revision??1)+1);
    assert.equal((await fetch(f.base+f.page)).status,404);
    await f.store.trash(f.workspace.id);
    assert.equal((await fetch(f.base+f.page)).status,404);
    assert.doesNotMatch(await (await fetch(f.base+'/knowledge/')).text(),new RegExp(f.workspace.id));
  }finally{await f.close();}
});

test('a failed live check shows generation time and does not reuse cached freshness',async()=>{
  const f=await fixture(knowledge=>({...knowledge,async status(){throw new KnowledgeError(503,'KNOWLEDGE_UNAVAILABLE','status failed');}}));
  try{
    await f.knowledge.saveContext(f.workspace.id,'directory',{expectedContextRevision:0,context:{...content,purpose:'Open directory'}});
    await f.knowledge.publish(f.workspace.id);
    assert.equal((await f.knowledge.status(f.workspace.id)).freshness,'up-to-date');
    const response=await fetch(f.base+f.page);assert.equal(response.status,200);
    const body=await response.text();
    assert.match(statusBlock(body),/As of .+ \(UTC\+7\)/);assert.match(body,/can't check freshness/);assert.doesNotMatch(body,/Up to date|Needs review|checked live/);
  }finally{await f.close();}
});

test('the runner hook publishes reader HTML and serves it without an injected service',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tnt-knowledge-reader-hook-'));
  const runner=createRunner({artifactDirectory:join(root,'launches'),execute:async()=>({stdout:JSON.stringify({devices:{}}),stderr:''})});
  const scenarios=createScenarios({root,runner,maestro:{version:async()=>'2.11.0',run:async()=>{throw new Error('Reader hook must not execute');}}});
  const server=createServer(createApiHandler(runner,join(root,'launches'),undefined,scenarios));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('No server');
  const base='http://127.0.0.1:'+address.port;
  try{
    const workspace=await scenarios.save({id:'',name:'Hooked reader',yaml,scenarios:[definition()]});
    const token=(await (await fetch(base+'/api/status')).json()).token as string;
    const save=await fetch(base+'/api/knowledge/workspaces/'+workspace.id+'/scenarios/directory/context',{method:'PUT',headers:{origin:base,'x-tnt-token':token,'content-type':'application/json'},body:JSON.stringify({expectedContextRevision:0,context:{...content,purpose:'Open directory'}})});
    assert.equal(save.status,200);
    const page=base+'/knowledge/workspaces/'+workspace.id+'/';
    let body='';
    for(let attempt=0;attempt<80;attempt++){
      const response=await fetch(page);body=await response.text();if(response.status===200&&body.includes('Up to date'))break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.match(body,/Up to date/);assert.match(body,/Open directory/);assert.doesNotMatch(body,/<script/i);
    const file=await generationFile(root,workspace.id);
    assert.match(statusBlock(file.html),/As of .+ \(UTC\+7\)/);assert.doesNotMatch(file.html,/Up to date/);
    const rows=(await readFile(join(file.directory,'index.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {generationId:string});
    assert.ok(rows.every(row=>row.generationId===file.pointer.generationId));
  }finally{
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await rm(root,{recursive:true,force:true});
  }
});
