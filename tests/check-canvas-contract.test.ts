import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/check-canvas-contract.sh',import.meta.url));
const exceptions='scripts/canvas-contract-exceptions';
const lines=(label:string)=>Array.from({length:20},(_,i)=>`export const ${label}${i}=${i};`).join('\n')+'\n';
const edit=(text:string,line:number,value:string)=>text.split('\n').map((item,i)=>i===line?value:item).join('\n');

function env(extra:Record<string,string>={}){
 const base:Record<string,string>={};
 for(const [key,value] of Object.entries(process.env))if(value!==undefined&&key!=='CI'&&key!=='GITHUB_REF'&&!key.startsWith('GIT_'))base[key]=value;
 return {...base,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Contract Test',GIT_AUTHOR_EMAIL:'contract@example.com',GIT_COMMITTER_NAME:'Contract Test',GIT_COMMITTER_EMAIL:'contract@example.com',...extra};
}

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'tnt-contract-'));
 const git=(...args:string[])=>{const result=spawnSync('git',args,{cwd:root,env:env(),encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;};
 const write=(path:string,text:string)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);};
 const commit=(message:string)=>{git('add','-A');git('commit','-q','-m',message);};
 const run=(extra:Record<string,string>={})=>spawnSync('bash',[script,base],{cwd:root,env:env(extra),encoding:'utf8'});
 git('init','-q','-b','feature');
 write('shared/a.ts',lines('a'));write('server/canvas.ts',lines('canvas'));write('server/default-actions.ts',lines('action'));write(`${exceptions}/.gitkeep`,'');
 commit('base');
 const base=git('rev-parse','HEAD').trim();
 const diff=(...paths:string[])=>git('-c','core.quotePath=false','diff','--no-color','--full-index',base,'HEAD','--',...paths);
 return {root,git,write,commit,run,diff,close:()=>rmSync(root,{recursive:true,force:true})};
}

// a.patch (shared/) sorts before b.patch (server/) by filename, but git emits server/ before shared/.
function splitAcrossTwoPatches(){
 const f=fixture();
 f.write('shared/a.ts',edit(lines('a'),2,'export const a2=200;'));
 f.write('server/canvas.ts',edit(lines('canvas'),5,'export const canvas5=500;'));
 f.commit('feature');
 f.write(`${exceptions}/a.patch`,f.diff('shared'));
 f.write(`${exceptions}/b.patch`,f.diff('server/canvas.ts'));
 f.commit('exceptions');
 return f;
}

test('split exception patches pass whatever order their filenames sort in',()=>{
 const f=splitAcrossTwoPatches();try{
  let result=f.run();
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/canvas contract check passed \(2 exception patches\)/);
  renameSync(join(f.root,exceptions,'a.patch'),join(f.root,exceptions,'z.patch'));f.commit('rename');
  result=f.run();
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/canvas contract check passed \(2 exception patches\)/);
 }finally{f.close();}
});

test('two exception patches on the same file fail and name the file',()=>{
 const f=fixture();try{
  f.write('shared/a.ts',edit(edit(lines('a'),2,'export const a2=200;'),17,'export const a17=1700;'));
  f.commit('feature');
  const full=f.diff('shared');
  const hunk=full.indexOf('\n@@')+1,second=full.indexOf('\n@@',hunk)+1;
  assert.ok(hunk>0&&second>hunk,'expected two hunks');
  f.write(`${exceptions}/1-first.patch`,full.slice(0,second));
  f.write(`${exceptions}/2-second.patch`,full.slice(0,hunk)+full.slice(second));
  f.commit('exceptions');
  const result=f.run();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/more than one exception patch touches shared\/a\.ts/);
  assert.match(result.stderr,/1-first\.patch/);assert.match(result.stderr,/2-second\.patch/);
 }finally{f.close();}
});

test('a clean pass prints the pass message, with and without CI=1',()=>{
 const f=splitAcrossTwoPatches();try{
  for(const extra of [{},{CI:'1'}] as Record<string,string>[]){
   const result=f.run(extra);
   assert.equal(result.status,0,result.stderr);
   assert.match(result.stdout,/^canvas contract check passed \(2 exception patches\)$/m);
  }
  const empty=fixture();try{
   const result=empty.run({CI:'1'});
   assert.equal(result.status,0,result.stderr);
   assert.match(result.stdout,/canvas contract check passed \(0 exception patches\)/);
  }finally{empty.close();}
 }finally{f.close();}
});

test('a stale patch fails',()=>{
 const f=splitAcrossTwoPatches();try{
  f.write('shared/a.ts',edit(edit(lines('a'),2,'export const a2=200;'),3,'export const a3=300;'));f.commit('later change');
  const result=f.run();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/shared\/a\.ts: the diff differs from its exception patch/);
 }finally{f.close();}
});

test('an uncommitted edit to a protected file fails',()=>{
 const f=splitAcrossTwoPatches();try{
  f.write('server/canvas.ts',edit(edit(lines('canvas'),5,'export const canvas5=500;'),9,'export const canvas9=900;'));
  const result=f.run();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/uncommitted edits in protected canvas files/);
 }finally{f.close();}
});

test('a committed protected edit with no exception patch fails',()=>{
 const f=splitAcrossTwoPatches();try{
  f.write('server/default-actions.ts',edit(lines('action'),1,'export const action1=100;'));f.commit('unpatched');
  const result=f.run();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/server\/default-actions\.ts: changed but not in any exception patch/);
 }finally{f.close();}
});

test('a patch that differs from the real diff only in whitespace fails',()=>{
 const f=splitAcrossTwoPatches();try{
  const file=join(f.root,exceptions,'a.patch');
  const original=readFileSync(file,'utf8');
  const mutated=original.replace('+export const a2=200;','+export  const a2=200;');
  assert.notEqual(mutated,original);
  writeFileSync(file,mutated);
  f.commit('whitespace');
  const result=f.run();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/shared\/a\.ts: the diff differs from its exception patch/);
 }finally{f.close();}
});

test('a patch section for a file the diff does not change fails',()=>{
 const f=splitAcrossTwoPatches();try{
  f.write(`${exceptions}/ghost.patch`,[
   'diff --git a/server/ghost.ts b/server/ghost.ts',
   'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
   '--- a/server/ghost.ts',
   '+++ b/server/ghost.ts',
   '@@ -0,0 +1 @@',
   '+export const ghost=1;',
   ''
  ].join('\n'));
  f.commit('ghost');
  const result=f.run();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/server\/ghost\.ts: in an exception patch but not in the diff/);
 }finally{f.close();}
});

test('text before the first diff --git in a patch exits 1',()=>{
 const f=splitAcrossTwoPatches();try{
  const file=join(f.root,exceptions,'a.patch');
  writeFileSync(file,'Subject: junk\n'+readFileSync(file,'utf8'));
  f.commit('preamble');
  const result=f.run();
  assert.equal(result.status,1);
  assert.match(result.stderr,/text before the first "diff --git" line/);
 }finally{f.close();}
});

test('a non-ASCII path passes with a matching exception patch',()=>{
 const f=fixture();try{
  f.write('shared/é.ts',edit(lines('e'),2,'export const e2=200;'));
  f.commit('feature');
  f.write(`${exceptions}/e.patch`,f.diff('shared/é.ts'));
  f.commit('exceptions');
  const result=f.run();
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/canvas contract check passed \(1 exception patch\)/);
 }finally{f.close();}
});

test('a path with a space passes with a matching exception patch',()=>{
 const f=fixture();try{
  f.write('shared/foo bar.ts',edit(lines('s'),2,'export const s2=200;'));
  f.commit('feature');
  f.write(`${exceptions}/s.patch`,f.diff('shared/foo bar.ts'));
  f.commit('exceptions');
  const result=f.run();
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/canvas contract check passed \(1 exception patch\)/);
 }finally{f.close();}
});

test('a path with a tab, double quote, or backslash fails and names the file',()=>{
 for(const path of ['shared/tab\there.ts','shared/quote"here.ts','shared/back\\slash.ts']){
  const f=fixture();try{
   f.write(path,edit(lines('q'),2,'export const q2=200;'));
   f.commit('feature');
   f.write(`${exceptions}/q.patch`,f.diff(path));
   f.commit('exceptions');
   const result=f.run();
   assert.notEqual(result.status,0,path+' '+result.stderr);
   assert.match(result.stderr,/quoted path /);
   assert.ok(result.stderr.includes(path),result.stderr);
   assert.doesNotMatch(result.stderr,/the diff differs from its exception patch/);
   assert.doesNotMatch(result.stderr,/changed but not in any exception patch/);
  }finally{f.close();}
 }
});

test('a quoted path in the real diff with no exception patch fails and names the file',()=>{
 for(const path of ['shared/tab\there.ts','shared/quote"here.ts']){
  const f=fixture();try{
   f.write(path,edit(lines('q'),2,'export const q2=200;'));
   f.commit('feature');
   const result=f.run();
   assert.notEqual(result.status,0,path+' '+result.stderr);
   assert.match(result.stderr,/quoted path /);
   assert.match(result.stderr,/cannot be recorded as an exception/);
   assert.ok(result.stderr.includes(path),result.stderr);
  }finally{f.close();}
 }
});
