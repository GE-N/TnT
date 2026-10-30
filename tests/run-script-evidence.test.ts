import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {protectRunEvidence,tokenForms,verifyEvidence,defaultEvidenceScrubber} from '../server/run-script-evidence.js';
const token='secret +/ไทย?=';
test('recursive JSON keys/evaluatedCommand/errors, logs and binary scan; visible redaction and script deletion',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tnt-scrub-')));try{
  await mkdir(join(root,'raw','nested'),{recursive:true});const leak=tokenForms(token).join(' ');
  await writeFile(join(root,'raw','nested','commands-1.json'),JSON.stringify({[token]:{command:{env:leak},metadata:{error:{message:'ผิด '+leak},evaluatedCommand:leak}}}));
  await writeFile(join(root,'maestro.log'),leak);const script=join(root,'.tnt-script-0001.js');await writeFile(script,'// generated');
  const input={directories:[root],token,value:{log:leak,stdout:leak,error:'ไทย '+leak},scriptFiles:[script]};
  const result=await protectRunEvidence(input);assert.equal(result.ok,true);await verifyEvidence(input);
  assert.match(await readFile(join(root,'maestro.log'),'utf8'),/\[redacted\]/);assert.equal((await readdir(root)).includes('.tnt-script-0001.js'),false);
  const json=JSON.parse(await readFile(join(root,'raw','nested','commands-1.json'),'utf8'));assert.match(json['[redacted]'].metadata.error.message,/ผิด \[redacted\]/);
 }finally{await rm(root,{recursive:true,force:true});}
});
for(const mode of ['throw','scrub-then-throw','leftover','binary','malformed-json','symlink'] as const)test('fails closed: '+mode,async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tnt-scrub-fail-')));const outside=await realpath(await mkdtemp(join(tmpdir(),'tnt-scrub-outside-')));try{
  await writeFile(join(root,'commands.json'),mode==='malformed-json'?'{broken':JSON.stringify({token}));
  const script=join(root,'.tnt-script-0001.js');await writeFile(script,'// generated');
  await writeFile(join(outside,'keep'),'untouched '+token);
  if(mode==='binary')await writeFile(join(root,'binary.png'),Buffer.concat([Buffer.from([255,0]),Buffer.from(token)]));
  if(mode==='symlink')await symlink(join(outside,'keep'),join(root,'link'));
  const result=await protectRunEvidence({directories:[root],token,value:{log:token},scriptFiles:[script]},mode==='throw'?async()=>{throw new Error(token);}:mode==='scrub-then-throw'?async input=>{await defaultEvidenceScrubber(input);throw new Error('Failure after fully scrubbing');}:mode==='leftover'?async()=>{}:undefined);
  assert.deepEqual(result,{ok:false,removed:true});assert.deepEqual(await readdir(root),[]);assert.equal(await readFile(join(outside,'keep'),'utf8'),'untouched '+token);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('independent URL-encoded fixture requires actual redaction, without production tokenForms',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tnt-scrub-url-')));try{
  const secret='url credential +/ไทย?=';const encoded=encodeURIComponent(secret);
  assert.notEqual(encoded,secret);await writeFile(join(root,'commands.json'),JSON.stringify({metadata:{error:{message:encoded},evaluatedCommand:encoded}}));await writeFile(join(root,'maestro.log'),encoded);
  const input={directories:[root],token:secret,value:{log:encoded},scriptFiles:[]};
  const result=await protectRunEvidence(input);assert.equal(result.ok,true);
  assert.equal(input.value.log,'[redacted]');assert.equal(await readFile(join(root,'maestro.log'),'utf8'),'[redacted]');
  const parsed=JSON.parse(await readFile(join(root,'commands.json'),'utf8'));assert.equal(parsed.metadata.error.message,'[redacted]');assert.equal(parsed.metadata.evaluatedCommand,'[redacted]');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('no-mock runs take the same scrub path and remove generated files',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tnt-scrub-nomock-')));try{const script=join(root,'.tnt-script-0001.js');await writeFile(script,'output.X=1');const result=await protectRunEvidence({directories:[root],value:{log:'hello'},scriptFiles:[script]});assert.equal(result.ok,true);assert.deepEqual(await readdir(root),[]);}finally{await rm(root,{recursive:true,force:true});}
});
test('independent parsed JSON scan catches escaped token values and keys left by a no-op scrubber',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tnt-scrub-escaped-')));try{
  const escaped='secret"\\escape';await writeFile(join(root,'commands.json'),JSON.stringify({[escaped]:{message:escaped}}));
  const result=await protectRunEvidence({directories:[root],token:escaped,value:{log:'safe'},scriptFiles:[]},async()=>{});assert.deepEqual(result,{ok:false,removed:true});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('changed root or ancestor symlinks never cause deletion outside the captured run',async()=>{
 for(const ancestor of [false,true]){
  const parent=await realpath(await mkdtemp(join(tmpdir(),'tnt-scrub-root-')));const outside=await realpath(await mkdtemp(join(tmpdir(),'tnt-scrub-target-')));
  const root=ancestor?join(parent,'run'):parent;const target=ancestor?join(outside,'run'):outside;
  try{
   if(ancestor)await mkdir(target);await writeFile(join(target,'keep'),'untouched '+token);
   await rm(parent,{recursive:true});await symlink(outside,parent);
   const result=await protectRunEvidence({directories:[root],token,value:{log:token},scriptFiles:[]});assert.deepEqual(result,{ok:false,removed:false});assert.equal(await readFile(join(target,'keep'),'utf8'),'untouched '+token);
  }finally{await rm(parent,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
 }
});
for(const offset of [0,1,2])test('base64 scrub and independent scan cover token alignment '+offset+' in a longer blob',async()=>{
 const secret='a1b2c3d4'.repeat(8);
 const prefix=Buffer.from([0xe9,0x52].slice(0,offset));const blob=Buffer.concat([prefix,Buffer.from(secret),Buffer.from('suffix')]).toString('base64');
 assert.equal(blob.includes(Buffer.from(secret).toString('base64')),false,'Fixture must require an embedded-token pattern');
 for(const noop of [false,true]){
  const root=await realpath(await mkdtemp(join(tmpdir(),'tnt-base64-offset-')));try{
   await writeFile(join(root,'commands.json'),JSON.stringify({[blob]:{metadata:{evaluatedCommand:blob,error:{message:'Bad '+blob}}}}));await writeFile(join(root,'maestro.log'),blob);
   const input={directories:[root],token:secret,value:{log:blob},scriptFiles:[]};const result=await protectRunEvidence(input,noop?async()=>{}:undefined);
   if(noop){assert.deepEqual(result,{ok:false,removed:true});assert.deepEqual(await readdir(root),[]);}
   else {assert.equal(result.ok,true);assert.match(input.value.log,/\[redacted\]/);assert.match(await readFile(join(root,'maestro.log'),'utf8'),/\[redacted\]/);const json=JSON.parse(await readFile(join(root,'commands.json'),'utf8'));const key=Object.keys(json)[0];assert.match(key,/\[redacted\]/);assert.match(json[key].metadata.error.message,/Bad .*\[redacted\]/);await verifyEvidence(input);}
  }finally{await rm(root,{recursive:true,force:true});}
 }
});
