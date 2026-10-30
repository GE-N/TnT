import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkspaceStore} from '../server/workspace-store.js';
import {createKnowledgeService,type ContextContent,type GenerationInput} from '../server/knowledge/index.js';
import {referenceCatalog} from '../server/canvas.js';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';
import {applyLiveStatus,escapeHtml,formatClock,formatGenerationTime,renderKnowledgeHtml} from '../server/knowledge/html/index.js';

const content:ContextContent={purpose:'Open directory',expectedOutcome:'Contacts are visible',rationale:'Find the responsible person',preconditions:'Signed in',exceptions:'Empty directory',scope:'Display only'};
const yaml='appId: com.example.App\n---\n- launchApp\n- tapOn: Continue\n- assertVisible: Directory\n';
const workspaceId='22222222-2222-2222-2222-222222222222';
function definition(source=yaml,name='Directory',id='directory'):ScenarioDefinition{
  return {id,name,steps:referenceCatalog(source).references.filter(ref=>ref.kind==='step').map(({kind,file,index,fingerprint})=>({kind,file,index,fingerprint})),inputs:{},parameters:{},enabledHandlerIds:[]};
}
function statusBlock(html:string){return /<div id="knowledge-status">([\s\S]*?)<\/div>/.exec(html)?.[1]??'';}
const hostile=[
  '<script>alert("authored")</script>','<a href="javascript:alert(1)">link</a>','"><img src=x onerror=alert(1)>','&#60;script&#62;','</style><script>alert(1)</script>',
  '<!--knowledge-status-->Up to date<!--/knowledge-status-->','java\tscript:alert(1)','\u202eoverride','\uFF1Cscript\uFF1E','<svg onload=alert(1)>','<iframe src="javascript:alert(1)">','<scr\nipt>alert(1)</script>','<img src=x onerror=alert(1)>',
].join('\n');

test('generation time is UTC+7 and controls cannot become markup',()=>{
  assert.equal(formatGenerationTime('2026-10-30T00:42:00.000Z'),'30 Oct 2026, 07:42');
  assert.equal(formatClock('2026-10-30T01:14:00.000Z'),'08:14');
  assert.equal(escapeHtml('a<b>&"\''), 'a&lt;b&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml('\u202e<script>'),'U+202E&lt;script&gt;');
  assert.equal(escapeHtml('&#60;script&#62;'),'&amp;#60;script&amp;#62;');
  assert.doesNotMatch(escapeHtml('\0<img>'),/<img/);
});

test('rendered generation files are offline readers with inert text and no live freshness',()=>{
  const input:GenerationInput={generationId:'11111111-1111-1111-1111-111111111111',scopeId:'workspace-'+workspaceId,workspaceId,workspaceTitle:'<!--knowledge-status-->Up to date<!--/knowledge-status-->',generatedAt:'2026-10-30T00:42:00.000Z',scenarios:[{
    workspaceId,scenarioId:'directory',title:'"><img src=x onerror=alert(1)>',context:{schemaVersion:1,workspaceId,scenarioId:'directory',contextRevision:2,updatedAt:'2026-10-30T00:42:00.000Z',reviewedAgainstSourceHash:'a'.repeat(64),purpose:hostile,expectedOutcome:hostile,rationale:hostile,preconditions:hostile,exceptions:hostile,scope:hostile},
    sourceDescriptor:{projectionVersion:1,workspaceRevision:1,sourceHash:'b'.repeat(64)},flow:{steps:[{number:1,text:'1 · Tap text · <script>alert(1)</script>'}],visits:[{number:1,id:'visit',screenId:'home',title:'<script>Home</script>',steps:[]}],diagnostics:['<script>missing</script>']},
    evidence:{status:null,runId:null,finishedAt:null,label:'No runs yet',notice:'Run results do not establish authored expected outcomes.'},freshness:'up-to-date',publicationFreshness:'current',intentFreshness:'reviewed',generationId:null,generatedAt:null,publicationError:null,readerUrl:'/knowledge/workspaces/'+workspaceId+'/#scenario-directory',
  }]};
  const files=renderKnowledgeHtml(input);
  assert.equal(files['index.html'],files['workspaces/'+workspaceId+'.html']);
  const html=files['index.html'];
  assert.match(statusBlock(html),/As of 30 Oct 2026, 07:42 \(UTC\+7\)/);
  assert.doesNotMatch(statusBlock(html),/Up to date|Needs review|checked live/);
  assert.match(html,/Why this flow exists/);assert.match(html,/Preconditions/);assert.match(html,/Expected outcome/);assert.match(html,/summary>Flow/);assert.match(html,/Exceptions/);assert.match(html,/Evidence/);
  assert.match(html,/1 · Tap text · &lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.match(html,/id="scenario-directory"/);assert.match(html,/Same generation as the LLM text index/);
  assert.match(html,/Run results do not establish authored expected outcomes/);
  assert.doesNotMatch(html,/<script/i);assert.doesNotMatch(html,/<img/i);assert.doesNotMatch(html,/<svg/i);assert.doesNotMatch(html,/<iframe/i);assert.doesNotMatch(html,/<link/i);assert.doesNotMatch(html,/<base/i);
  assert.equal([...html.matchAll(/<style/g)].length,1);
  const hrefs=[...html.matchAll(/\shref\s*=\s*"([^"]*)"/g)].map(match=>match[1]);
  assert.deepEqual(hrefs,['#scenario-directory']);
  assert.doesNotMatch(html,/<[^>]*\son[a-z]+\s*=/i);assert.match(html,/javascript:alert\(1\)/);assert.doesNotMatch(html,/href\s*=\s*"javascript:/i);assert.doesNotMatch(html,/\u202e/);
  assert.match(html,/&amp;#60;script&amp;#62;/);assert.match(html,/U\+202E/);assert.match(html,/&lt;!--knowledge-status--&gt;/);
  const checked=new Date('2026-10-30T01:14:00.000Z');
  const live=applyLiveStatus(html,{freshness:'up-to-date',publicationFreshness:'current',publicationError:null,generatedAt:input.generatedAt,scenarios:[{scenarioId:'directory',freshness:'up-to-date',publicationFreshness:'current',intentFreshness:'reviewed'}]},checked);
  assert.match(statusBlock(live),/Up to date/);assert.match(live,/checked live 08:14/);assert.doesNotMatch(live,/can't check freshness/);
  const review=applyLiveStatus(html,{freshness:'needs-review',publicationFreshness:'publication-stale',publicationError:'<script>nope</script>',generatedAt:input.generatedAt,scenarios:[{scenarioId:'directory',freshness:'needs-review',publicationFreshness:'publication-stale',intentFreshness:'intent-needs-review'}]},checked);
  assert.match(review,/The saved flow changed after this context was reviewed/);assert.match(review,/intent-needs-review/);assert.match(review,/&lt;script&gt;nope&lt;\/script&gt;/);assert.match(review,/class="flag">Needs review/);
  assert.doesNotMatch(review,/<script/i);assert.equal(applyLiveStatus(html,null),html);
});

test('a publication stores HTML and the text index for the same generation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tnt-knowledge-reader-'));
  const store=createWorkspaceStore(root,workspace=>workspace);
  const workspace=await store.save({id:'',name:'Knowledge reader',yaml,scenarios:[definition()]});
  const service=createKnowledgeService({root,store,renderHtml:renderKnowledgeHtml,queue:{enqueue(){}},reconcileIntervalMs:0});
  try{
    await service.saveContext(workspace.id,'directory',{expectedContextRevision:0,context:content});
    const published=await service.publish(workspace.id);assert.equal(published.published,true);
    const pointer=JSON.parse(await readFile(join(root,'knowledge','current','workspace-'+workspace.id+'.json'),'utf8')) as {generationId:string;generatedAt:string};
    const directory=join(root,'knowledge','generations','workspace-'+workspace.id,pointer.generationId);
    const [html,workspaceHtml,text,jsonl,manifestText]=await Promise.all(['index.html','workspaces/'+workspace.id+'.html','documents/directory.txt','index.jsonl','manifest.json'].map(name=>readFile(join(directory,name),'utf8')));
    assert.equal(html,workspaceHtml);
    assert.match(statusBlock(html),new RegExp('As of '+formatGenerationTime(pointer.generatedAt).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+' \\(UTC\\+7\\)'));
    assert.doesNotMatch(html,/Up to date|Needs review|checked live/);
    assert.match(html,/Open directory/);assert.match(html,/Tap text · Continue/);assert.match(html,/Why this flow exists/);assert.match(html,new RegExp('content="'+pointer.generationId+'"'));
    const manifest=JSON.parse(manifestText) as {generationId:string;documents:{path:string}[];artifacts:{path:string}[]};
    assert.equal(manifest.generationId,pointer.generationId);
    for(const path of ['index.html','workspaces/'+workspace.id+'.html','index.jsonl','documents/directory.txt'])assert.ok(manifest.artifacts.some(item=>item.path===path));
    assert.ok(text.includes('Open directory'));assert.ok(text.includes('Tap text · Continue'));
    const rows=jsonl.trim().split('\n').map(line=>JSON.parse(line) as {generationId:string;section:string;text:string;htmlLocation:string;scenarioId:string});
    const purpose=rows.find(row=>row.section==='purpose'&&row.scenarioId==='directory');
    assert.ok(purpose);assert.equal(purpose.text,content.purpose);assert.equal(purpose.generationId,pointer.generationId);assert.equal(purpose.htmlLocation,'workspaces/'+workspace.id+'.html#scenario-directory');
    assert.ok(rows.some(row=>row.section==='flow'&&row.generationId===pointer.generationId&&row.text.includes('Tap text · Continue')));
    assert.match(html,/id="scenario-directory"/);
  }finally{service.close();await rm(root,{recursive:true,force:true});}
});
