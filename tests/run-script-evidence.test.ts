import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {protectRunEvidence,tokenForms,verifyEvidence} from '../server/run-script-evidence.js';
const token='secret +/ไทย?=';
test('recursive JSON keys/evaluatedCommand/errors, logs and binary scan; visible redaction and script deletion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-scrub-'));try{
  await mkdir(join(root,'raw','nested'),{recursive:true});const leak=tokenForms(token).join(' ');
  await writeFile(join(root,'raw','nested','commands-1.json'),JSON.stringify({[token]:{command:{env:leak},metadata:{error:{message:'ผิด '+leak},evaluatedCommand:leak}}}));
  await writeFile(join(root,'maestro.log'),leak);const script=join(root,'.tnt-script-0001.js');await writeFile(script,'// generated');
  const input={directories:[root],token,value:{log:leak,stdout:leak,error:'ไทย '+leak},scriptFiles:[script]};
  const result=await protectRunEvidence(input);assert.equal(result.ok,true);await verifyEvidence(input);
  assert.match(await readFile(join(root,'maestro.log'),'utf8'),/\[redacted\]/);assert.equal((await readdir(root)).includes('.tnt-script-0001.js'),false);
  const json=JSON.parse(await readFile(join(root,'raw','nested','commands-1.json'),'utf8'));assert.match(json['[redacted]'].metadata.error.message,/ผิด \[redacted\]/);
 }finally{await rm(root,{recursive:true,force:true});}
});
for(const mode of ['throw','leftover','binary','malformed-json','symlink'] as const)test('fails closed: '+mode,async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-scrub-fail-'));const outside=await mkdtemp(join(tmpdir(),'tnt-scrub-outside-'));try{
  await writeFile(join(root,'commands.json'),mode==='malformed-json'?'{broken':JSON.stringify({token}));
  const script=join(root,'.tnt-script-0001.js');await writeFile(script,'// generated');
  await writeFile(join(outside,'keep'),'untouched '+token);
  if(mode==='binary')await writeFile(join(root,'binary.png'),Buffer.concat([Buffer.from([255,0]),Buffer.from(token)]));
  if(mode==='symlink')await symlink(join(outside,'keep'),join(root,'link'));
  const result=await protectRunEvidence({directories:[root],token,value:{log:token},scriptFiles:[script]},mode==='throw'?async()=>{throw new Error(token);}:mode==='leftover'?async()=>{}:undefined);
  assert.deepEqual(result,{ok:false,removed:true});assert.deepEqual(await readdir(root),[]);assert.equal(await readFile(join(outside,'keep'),'utf8'),'untouched '+token);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('no-mock runs take the same scrub path and remove generated files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-scrub-nomock-'));try{const script=join(root,'.tnt-script-0001.js');await writeFile(script,'output.X=1');const result=await protectRunEvidence({directories:[root],value:{log:'hello'},scriptFiles:[script]});assert.equal(result.ok,true);assert.deepEqual(await readdir(root),[]);}finally{await rm(root,{recursive:true,force:true});}
});
