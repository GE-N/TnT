import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {describe,test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {buildGoldenFixtures} from './golden-canvas-fixtures.js';
import {runUi} from './golden-canvas-ui.js';
import {normalizeSnapshot,runPure,snapshotText,type GoldenFixture,type GoldenSnapshot} from './golden-canvas-runner.js';

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

function assertOpenedLiteralBack(pure:GoldenSnapshot,ui:GoldenSnapshot){
  const opened=ui.baseline.routes[0];
  const openedYaml='executionYaml' in opened?opened.executionYaml:undefined;
  if(typeof openedYaml!=='string')assert.fail('The opened literal-back route did not project.');
  assert.match(openedYaml,/text: "\^Back\$"/);
  assert.match(ui.baseline.workspaceYaml,/(?:^|\n)- back(?:\n|$)/);
  assert.notEqual(snapshotText(ui),snapshotText(pure));
}

function assertMutations(pure:GoldenSnapshot){
  const after=pure.operations.at(-1)?.result;
  if(pure.fixture==='shared-step'&&after){
    assert.deepEqual(after.visits.filter(visit=>visit.pathId==='path-b'),pure.baseline.visits.filter(visit=>visit.pathId==='path-b'),'scenario B visits changed');
    assert.deepEqual(after.routes.find(route=>route.pathId==='path-b'),pure.baseline.routes.find(route=>route.pathId==='path-b'),'scenario B route changed');
    assert.equal(after.workspaceYaml.includes('# tnt-check:shared-tap'),true);
  }
  if(pure.fixture==='repeated-visit'&&after){
    assert.equal(after.visits.find(visit=>visit.visitId==='visit-1')?.operationIds.includes('home-ready'),true);
    assert.equal(after.visits.find(visit=>visit.visitId==='visit-3')?.operationIds.includes('home-ready'),false);
  }
  if(pure.fixture==='legacy-visits'&&after){
    assert.equal(after.visits.every(visit=>visit.storedOperationIds===null),true);
    assert.equal(after.routes.every(route=>'executionYaml' in route),true);
  }
  if(pure.fixture==='multi-action-edge'){
    const retarget=pure.operations.find(item=>item.op==='retarget');
    assert.ok(retarget);
    assert.equal(retarget.result.routes.every(route=>'executionYaml' in route),true);
  }
  if(pure.fixture==='text-tap'||pure.fixture==='id-tap'){
    const retarget=pure.operations.find(item=>item.op==='retarget');
    assert.equal(retarget?.result.canvas.edges.find(edge=>edge.id==='open')?.to,'more');
  }
  if(pure.fixture==='id-tap'){
    const edited=pure.operations.find(item=>item.op==='edit')?.result.workspaceYaml??'';
    assert.match(edited,/id: \^gear\\\.button\\\.primary\$/);
  }
  if(pure.fixture==='literal-back'){
    const route=pure.baseline.routes[0];
    const projected='executionYaml' in route?route.executionYaml:undefined;
    if(typeof projected!=='string')assert.fail('The literal-back route did not project.');
    assert.match(projected,/id: "\^nav\\\\\.back\$"/);
    assert.match(pure.baseline.workspaceYaml,/(?:^|\n)- back(?:\n|$)/);
  }
  if(pure.fixture==='unfrozen-visits'&&after){
    assert.equal(pure.baseline.visits.every(visit=>visit.storedOperationIds===null),true);
    assert.equal(after.visits.every(visit=>Array.isArray(visit.storedOperationIds)),true);
  }
  if(pure.fixture==='back'){
    const edited=pure.operations.find(item=>item.op==='edit')?.result.workspaceYaml??'';
    assert.match(edited,/tnt-back/);
    assert.match(edited,/id: \^nav\\\.back\\\.button\$/);
  }
  const steps=(state:GoldenSnapshot['baseline'])=>{
    const route=state.routes[0];
    if(!('steps' in route))assert.fail(pure.fixture+' route did not project: '+('error' in route?route.error:'no steps'));
    return route.steps.map(step=>[step.testId,step.edgeId]);
  };
  if(pure.fixture==='same-screen-steps'){
    assert.deepEqual(steps(pure.baseline),[['home-ready',null],['show-error',null],['type-name',null],['open-detail','go'],['detail-ready',null]]);
    assert.deepEqual(steps(after!),steps(pure.baseline));
  }
  if(pure.fixture==='stays-on-screen'){
    const cleared=pure.operations.find(item=>item.op==='clear-destination')!.result;
    assert.deepEqual(cleared.canvas.paths[0].edgeIds,[]);
    assert.equal(cleared.canvas.screens.find(screen=>screen.id==='home')?.tests.includes('open-detail'),true);
    assert.deepEqual(steps(cleared),[['home-ready',null],['open-detail',null]]);
  }
  if(pure.fixture==='check-after-navigation'){
    assert.deepEqual(steps(pure.baseline),[['open-detail','go'],['detail-title',null],['detail-ready',null]]);
    assert.deepEqual(steps(after!),steps(pure.baseline));
  }
  if(pure.fixture==='same-screen-last-visit'){
    assert.deepEqual(steps(pure.baseline),[['home-ready',null],['open-detail','go'],['detail-ready',null],['dismiss',null],['detail-dismissed',null]]);
    assert.deepEqual(steps(after!),steps(pure.baseline));
  }
  if(pure.fixture==='retarget-frozen-visit'){
    assert.deepEqual(after!.canvas.edges,[{id:'go',from:'home',to:'more',actionTestId:'open-detail',actionTestIds:['open-detail']}]);
    assert.deepEqual(steps(after!),[['home-ready',null],['show-error',null],['open-detail','go']]);
  }
  if(pure.fixture==='retarget-same-screen')assert.deepEqual(after,pure.baseline);
  if(pure.fixture==='default-actions'&&after){
    const baseline=pure.baseline.routes[0];
    const edited=after.routes[0];
    assert.equal('checkpoints' in edited&&'checkpoints' in baseline&&JSON.stringify(edited.checkpoints)===JSON.stringify(baseline.checkpoints),true);
  }
}

describe('golden canvas routes',{concurrency:1},()=>{
  for(const fixture of buildGoldenFixtures()){
    test(fixture.id+' matches the committed before/after snapshot',async()=>{
      assert.equal(JSON.stringify(fixture.scripts).includes('add-check'),false,fixture.id+' must not script add-check placement');
      const pure=runPure(fixture);
      assert.deepEqual(runPure(fixture),pure,fixture.id+' changed between two pure runs');
      assertMutations(pure);
      const ui=await runUi(fixture);
      const expected=snapshotText(pure);
      if(fixture.id==='literal-back'){
        // refreshChecks drops an id backSelector beside a literal `- back`, and open always refreshes.
        // The pure snapshot locks the conversion at canvas-route.ts. The page locks the opened graph.
        assertOpenedLiteralBack(pure,ui);
        assert.equal(snapshotText(await runUi(fixture)),snapshotText(ui),fixture.id+' changed between two UI runs');
      }else{
        const actual=snapshotText(ui);
        assert.equal(actual,expected,fixture.id+' UI runner diverged from the pure runner\n'+difference(actual,expected));
        assert.equal(snapshotText(await runUi(fixture)),expected,fixture.id+' changed between two UI runs');
      }
      const fixturePath=join(fixtureDirectory,fixture.id+'.json');
      const snapshotPath=join(snapshotDirectory,fixture.id+'.json');
      const fixtureText=normalizeSnapshot(fixture satisfies GoldenFixture);
      if(update){writeIfNeeded(fixturePath,fixtureText);writeIfNeeded(snapshotPath,expected);return;}
      assert.equal(readFileSync(fixturePath,'utf8'),fixtureText,fixture.id+' fixture drifted from the recipe. Regenerate with GOLDEN_UPDATE=1.');
      assert.equal(readFileSync(snapshotPath,'utf8'),expected,fixture.id+' snapshot drifted. Regenerate with GOLDEN_UPDATE=1.\n'+difference(expected,readFileSync(snapshotPath,'utf8')));
    });
  }
});
