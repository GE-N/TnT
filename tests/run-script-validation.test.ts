import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readScenarios,namedInputs,validateFlowInputs} from '../server/scenario-definitions.js';
import {assertAuthoredVariables,assertAutomationVariables,ScriptBlocked} from '../server/script-validation.js';
import {portableContent,parsePackage} from '../server/workspace-package.js';
const row={id:'script-one',label:'Thai',source:'output.X = "ไทย"',beforeStep:{index:0,fingerprint:'a'.repeat(64)}};
const scenario={id:'one',name:'One',steps:[],inputs:{},parameters:{},enabledHandlerIds:[],scripts:[row]};
test('script rows round-trip through schema and portable allowlist without trust',()=>{
 const scenarios=readScenarios([scenario])!;
 assert.deepEqual(scenarios[0].scripts,[row]);
 const content=portableContent({id:'',name:'Scripts',yaml:'appId: com.example.App\n---\n- launchApp\n',scenarios},true);
 assert.deepEqual(content.scenarios![0].scripts,[row]);
 const pkg={format:'tnt-workspace',version:1,source:{revision:1,savedAt:new Date().toISOString()},dependencies:[],workspace:content};
 assert.deepEqual(parsePackage(pkg).workspace.scenarios![0].scripts,[row]);
 assert.throws(()=>parsePackage({...pkg,workspace:{...content,scenarios:[{...scenario,scripts:[{...row,trusted:true}]}]}}),/Unsupported|Unknown|Unexpected/i);
});
test('malformed rows and workspace-wide duplicate IDs reject; editable drafts survive',()=>{
 for(const patch of [{id:'../escape'},{beforeStep:{index:-1,fingerprint:'a'.repeat(64)}},{source:12},{label:null}])assert.throws(()=>readScenarios([{...scenario,scripts:[{...row,...patch}]}]),/Script rows/);
 assert.throws(()=>readScenarios([scenario,{...scenario,id:'two'}]),/unique/);
 for(const source of ['', '   ', '} catch(e){}'])assert.equal(readScenarios([{...scenario,scripts:[{...row,source}]}])![0].scripts![0].source,source);
});
test('reserved names reject authored scopes, expressions and nested flows',()=>{
 for(const name of ['TNT_MOCK_URL','TNT_MOCK_TOKEN']){
  assert.throws(()=>namedInputs({[name]:'shadow'}),ScriptBlocked);
  assert.throws(()=>assertAuthoredVariables(`appId: com.example.App\n---\n- evalScript: \${${name} + ""}\n`),/Reserved TnT variable/);
  assert.throws(()=>assertAuthoredVariables(`appId: com.example.App\n---\n- runFlow:\n    env:\n      ${name}: shadow\n    commands: []`),/reserved by TnT/);
  assert.throws(()=>assertAutomationVariables({setup:{parameters:{[name]:'shadow'}}}),/reserved by TnT/);
  const flows={'nested.yaml':`appId: com.example.App\n---\n- evalScript: \${${name}}\n`};
  assert.throws(()=>validateFlowInputs('appId: com.example.App\n---\n- runFlow: nested.yaml',flows,{}),/Reserved TnT variable/);
 }
});
test('end anchor schema and portability preserve last-step suffix and the empty-scenario sentinel',()=>{
 for(const beforeStep of [{index:3,fingerprint:'a'.repeat(64)+':end'},{index:0,fingerprint:'end'}]){
  const scenarios=readScenarios([{...scenario,scripts:[{...row,beforeStep}]}])!;
  const content=portableContent({id:'',name:'End script',yaml:'appId: com.example.App\n---\n- launchApp\n',scenarios},true);
  const pkg={format:'tnt-workspace',version:1,source:{revision:1,savedAt:new Date().toISOString()},dependencies:[],workspace:content};
  assert.deepEqual(parsePackage(pkg).workspace.scenarios![0].scripts![0].beforeStep,beforeStep);
 }
 for(const fingerprint of ['a'.repeat(63)+':end','a'.repeat(64)+':end:end','end:extra'])assert.throws(()=>readScenarios([{...scenario,scripts:[{...row,beforeStep:{index:3,fingerprint}}]}]),/Script rows/);
});
