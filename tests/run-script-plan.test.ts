import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {parseAllDocuments} from 'yaml';
import {buildRunPlan,checkScriptSyntax} from '../server/run-script-plan.js';
import {referenceCatalog} from '../server/canvas.js';
const yaml='appId: com.example.App\n---\n- launchApp\n- tapOn: Load\n- assertVisible: Home\n';
const anchor=(index:number)=>{const ref=referenceCatalog(yaml).references[index];return {index,fingerprint:ref.fingerprint};};
const row={id:'first',label:'First',beforeStep:anchor(1),source:'output.X = `ไทย ${"quote"}`; // trailing comment'};
const trust=[{rowId:row.id,origin:'local' as const,trusted:true,hash:''}];
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
test('pure plan preserves source bytes, order and wrapper newlines; no credentials',()=>{
 const input=freeze({yaml,scripts:[row],trust,mockAvailable:true});
 const result=buildRunPlan(input);assert.deepEqual(result,buildRunPlan(input));
 assert.deepEqual(result.blocked,[]);assert.deepEqual(result.executionItems.map(item=>item.kind),['step','runScript','step','step']);
 assert.ok(result.scriptFiles[0].content.includes('\n'+row.source+'\n} catch'));
 const output:any={};runInNewContext(result.scriptFiles[0].content,{output});assert.equal(output.X,'ไทย quote');
 const commands=parseAllDocuments(result.executionYaml)[1].toJS();assert.deepEqual(commands[1].runScript.env,{TNT_MOCK_URL:'${TNT_MOCK_URL}',TNT_MOCK_TOKEN:'${TNT_MOCK_TOKEN}'});
 assert.deepEqual(result.authoredStepMap,[{index:0,executionIndex:0},{index:1,executionIndex:2},{index:2,executionIndex:3}]);
});
test('breakout mutation guard compiles standalone without executing; valid braces still wrap',()=>{
 for(const source of ['} catch(e){} ; writeMarker(); try {','})','*/',"'unterminated",'`unterminated','/*']){
  assert.ok(checkScriptSyntax(source));
  const plan=buildRunPlan({yaml,scripts:[{...row,source}],trust});assert.equal(plan.blocked[0].kind,'syntax');assert.equal(plan.scriptFiles.length,0);
 }
 let invoked=false;assert.equal(checkScriptSyntax('writeMarker();'),undefined);assert.equal(invoked,false);
 const plan=buildRunPlan({yaml,scripts:[{...row,source:'if (true) { throw new Error("ผิด }") }'}],trust});
 assert.throws(()=>runInNewContext(plan.scriptFiles[0].content,{}),/TNT_SCRIPT_FAILED row=first ผิด }/);
 for(const source of ['const x = a?.b ?? 1','const f = () => `hi`','return 1'])assert.equal(checkScriptSyntax(source),undefined);
});
test('typed empty/stale/untrusted blocks and no-script plan; source never invoked',()=>{
 const plan=buildRunPlan({yaml,scripts:[{...row,source:' ',beforeStep:{...row.beforeStep,index:99}}]});
 assert.deepEqual(plan.blocked.map(item=>item.kind),['empty','stale-anchor','untrusted']);
 assert.equal(buildRunPlan({yaml}).executionYaml,yaml);
 const source='globalThis.marker = true';const plan2=buildRunPlan({yaml,scripts:[{...row,source}],trust});assert.equal((globalThis as any).marker,undefined);assert.ok(plan2.scriptFiles.length);
});
test('same-anchor scripts keep row order after checkpoint with fixed automation input',()=>{
 const automation={yaml:'appId: com.example.App\n---\n- launchApp\n- runFlow: {commands: []}\n- runFlow: {commands: []}\n- runFlow: {commands: []}\n',plan:[{kind:'reset' as const},{kind:'setup' as const},{kind:'checkpoint' as const,index:1},{kind:'step' as const,index:1}]};
 const second={...row,id:'second'};
 const input=freeze({yaml,scripts:[row,second],trust:[...trust,{...trust[0],rowId:'second'}],automation});
 const plan=buildRunPlan(input);assert.deepEqual(plan,buildRunPlan(input));assert.deepEqual(plan.executionItems.map(item=>item.kind),['reset','setup','checkpoint','runScript','runScript','step']);
 assert.deepEqual(plan.scriptFiles.map(file=>file.rowId),['first','second']);
 assert.doesNotMatch(plan.executionYaml,/TNT_MOCK/);
});
test('end anchors run last and become stale when a step is appended or the last step changes',()=>{
 const final={...row,id:'last',beforeStep:{index:3,fingerprint:anchor(2).fingerprint+':end'}};
 const inputs=freeze({yaml,scripts:[final,row],trust:[...trust,{...trust[0],rowId:'last'}]});
 const plan=buildRunPlan(inputs);assert.deepEqual(plan.blocked,[]);assert.deepEqual(plan.executionItems.map(item=>item.kind),['step','runScript','step','step','runScript']);
 for(const changed of [yaml+'- tapOn: Another\n',yaml.replace('Home','Changed'),yaml.replace('- tapOn: Load\n','')]){
  const stale=buildRunPlan({...inputs,yaml:changed});assert.ok(stale.blocked.some(item=>item.kind==='stale-anchor'&&item.rowId==='last'&&item.message==='Step changed · relink before running'));assert.deepEqual(stale.scriptFiles,[]);
 }
 for(const beforeStep of [{index:3,fingerprint:'end'},{index:1,fingerprint:final.beforeStep.fingerprint},{index:3,fingerprint:anchor(2).fingerprint}]){
  const stale=buildRunPlan({...inputs,scripts:[{...final,beforeStep}]});assert.equal(stale.blocked[0].kind,'stale-anchor');assert.deepEqual(stale.scriptFiles,[]);
 }
 assert.equal(referenceCatalog(yaml).references[1].fingerprint,row.beforeStep.fingerprint);assert.deepEqual(inputs.scripts.map(row=>row.id),['last','first']);
});
test('empty scenario end anchor is exactly index zero and end; adding its first step makes it stale',()=>{
 const empty='appId: com.example.App\n---\n[]\n';
 const final={...row,beforeStep:{index:0,fingerprint:'end'}};
 const plan=buildRunPlan({yaml:empty,scripts:[final],trust});assert.deepEqual(plan.blocked,[]);assert.equal(plan.scriptFiles.length,1);assert.deepEqual(plan.executionItems.map(item=>item.kind),['runScript']);
 const populated=buildRunPlan({yaml,scripts:[final],trust});assert.equal(populated.blocked[0].kind,'stale-anchor');assert.deepEqual(populated.scriptFiles,[]);
 const wrongIndex=buildRunPlan({yaml:empty,scripts:[{...final,beforeStep:{index:1,fingerprint:'end'}}],trust});assert.equal(wrongIndex.blocked[0].kind,'stale-anchor');
});
test('run plan stably sorts by index while saved rows, ties and other anchors stay unchanged',()=>{
 const rows=[{...row,id:'end',beforeStep:{index:3,fingerprint:anchor(2).fingerprint+':end'}},{...row,id:'later-a',beforeStep:anchor(2)},{...row,id:'early-a',beforeStep:anchor(0)},{...row,id:'later-b',beforeStep:anchor(2)},{...row,id:'early-b',beforeStep:anchor(0)}];
 const input=freeze({yaml,scripts:rows,trust:rows.map(row=>({...trust[0],rowId:row.id}))});
 const plan=buildRunPlan(input);assert.deepEqual(plan.blocked,[]);assert.deepEqual(plan.scriptFiles.map(file=>file.rowId),['early-a','early-b','later-a','later-b','end']);assert.deepEqual(plan,buildRunPlan(input));
 assert.deepEqual(input.scripts.map(row=>row.id),['end','later-a','early-a','later-b','early-b']);
 const reordered=buildRunPlan({...input,scripts:[rows[0],rows[1],rows[4],rows[3],rows[2]]});assert.deepEqual(reordered.scriptFiles.map(file=>file.rowId),['early-b','early-a','later-a','later-b','end']);
 assert.deepEqual(rows.map(row=>row.beforeStep),[{index:3,fingerprint:anchor(2).fingerprint+':end'},anchor(2),anchor(0),anchor(2),anchor(0)]);
});
