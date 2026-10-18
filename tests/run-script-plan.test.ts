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
function freeze(value:any){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
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
