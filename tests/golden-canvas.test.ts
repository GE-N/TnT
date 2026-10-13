import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {describe,test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {buildGoldenFixtures} from './golden-canvas-fixtures.js';
import {runUi} from './golden-canvas-ui.js';
import {normalizeSnapshot,runPure,snapshotText,type GoldenFixture} from './golden-canvas-runner.js';

const root=dirname(fileURLToPath(import.meta.url));
const fixtureDirectory=join(root,'fixtures/golden');
const snapshotDirectory=join(fixtureDirectory,'snapshots');
const update=process.env.GOLDEN_UPDATE==='1';

function difference(actual:string,expected:string){
  const left=actual.split('\n');const right=expected.split('\n');
  const lines:string[]=[];
  for(let index=0;index<Math.max(left.length,right.length)&&lines.length<30;index++){
    if(left[index]!==right[index])lines.push(`${index+1}\n- ${right[index]??''}\n+ ${left[index]??''}`);
  }
  return lines.join('\n');
}

function writeIfNeeded(path:string,contents:string){
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,contents);
}

describe('golden canvas routes',{concurrency:1},()=>{
  for(const fixture of buildGoldenFixtures()){
    test(fixture.id+' matches the committed before/after snapshot',async()=>{
      assert.equal(JSON.stringify(fixture.scripts).includes('add-check'),false,fixture.id+' must not script add-check placement');
      const pure=runPure(fixture);
      assert.deepEqual(runPure(fixture),pure,fixture.id+' changed between two pure runs');
      const ui=await runUi(fixture);
      const expected=snapshotText(pure);
      const actual=snapshotText(ui);
      assert.equal(actual,expected,fixture.id+' UI runner diverged from the pure runner\n'+difference(actual,expected));
      assert.equal(snapshotText(await runUi(fixture)),expected,fixture.id+' changed between two UI runs');
      const fixturePath=join(fixtureDirectory,fixture.id+'.json');
      const snapshotPath=join(snapshotDirectory,fixture.id+'.json');
      const fixtureText=normalizeSnapshot(fixture satisfies GoldenFixture);
      if(update){writeIfNeeded(fixturePath,fixtureText);writeIfNeeded(snapshotPath,expected);return;}
      assert.equal(readFileSync(fixturePath,'utf8'),fixtureText,fixture.id+' fixture drifted from the recipe. Regenerate with GOLDEN_UPDATE=1.');
      assert.equal(readFileSync(snapshotPath,'utf8'),expected,fixture.id+' snapshot drifted. Regenerate with GOLDEN_UPDATE=1.\n'+difference(expected,readFileSync(snapshotPath,'utf8')));
    });
  }
});
