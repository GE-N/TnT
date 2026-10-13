import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const exec=promisify(execFile);
const root=fileURLToPath(new URL('..',import.meta.url));

test('the canvas authoring contract diff against the task base is empty',async()=>{
  const {stdout,stderr}=await exec('bash',['scripts/check-canvas-contract.sh'],{cwd:root});
  assert.equal(stdout,'');
  assert.equal(stderr,'');
});
