import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../server/runner.js';
import { createScenarios } from '../server/scenarios.js';
import { parseAllDocuments } from 'yaml';
import { InspectionCleanupError } from '../server/picker.js';

const deviceId = 'E5C92F6E-40DC-493C-93B4-469E67193736';
const node = (text: string, bounds: string, children: unknown[] = []) => ({ attributes: { accessibilityText: text, 'resource-id': '', bounds }, children });
const hierarchy = JSON.stringify(node('', '[0,0][0,0]', [node('App', '[0,0][393,852]', [node('Settings', '[341,58][377,93]', [node('Settings', '[341,58][377,93]')]), node('Home', '[16,97][110,146]')]), node('18:00', '[48,19][94,39]')]));
// A PNG header with independently known 3x dimensions is enough for the tool-boundary fixture.
const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(1179, 16); png.writeUInt32BE(2556, 20);
async function fixture(toolHierarchy = hierarchy, inspectionFailure?: Error) {
  const root = await mkdtemp(join(tmpdir(), 'tnt-picker-'));
  let currentHierarchy = toolHierarchy;
  const runner = createRunner({ artifactDirectory: root, inspector: { version: async () => '2.11.0', hierarchy: async () => { if (inspectionFailure) throw inspectionFailure; return currentHierarchy; } }, execute: async (_file, args) => {
    if (args.includes('screenshot')) await writeFile(args.at(-1)!, png);
    return { stdout: args.includes('list') ? JSON.stringify({ devices: { iOS: [{ udid: deviceId, name: 'iPhone', state: 'Booted', isAvailable: true }] } }) : '', stderr: '' };
  } });
  return { runner, root, changeScreen: () => { currentHierarchy = hierarchy.replaceAll('Home', 'Changed'); }, changeClock: () => { currentHierarchy = hierarchy.replace('18:00', '18:01'); } };
}
test('a screenshot click uses normalized bounds and exposes overlapping candidates without choosing one', async () => {
  const { runner, root } = await fixture();
  try {
    const capture = await runner.picker.capture({ deviceId });
    assert.equal(capture.width, 1179); assert.equal(capture.height, 2556);
    const candidates = runner.picker.candidates({ captureId: capture.id, x: 359 / 393, y: 75 / 852 });
    assert.equal(candidates.filter(candidate => candidate.text === 'Settings').length, 2);
    assert.deepEqual(candidates.find(candidate => candidate.text === 'Settings')?.bounds, { x: 1023, y: 174, width: 108, height: 105 });
    assert.deepEqual(await runner.picker.screen(capture.id), png);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reviewed selectors require explicit duplicate disambiguation and generate executable steps without changing authored commands', async () => {
  const { runner, root } = await fixture();
  try {
    const capture = await runner.picker.capture({ deviceId });
    const candidate = capture.candidates.filter(candidate => candidate.text === 'Settings').at(-1)!;
    const draft = { captureId: capture.id, candidateId: candidate.id, command: 'tap' as const, selector: 'text: Settings\n' };
    const ambiguous = runner.picker.preview(draft);
    assert.equal(ambiguous.canSave, false);
    assert.equal(ambiguous.matches.length, 2);
    assert.throws(() => runner.picker.buildStep({ ...draft, yaml: 'appId: com.example.App\n---\n- launchApp\n' }), /ambiguous/i);
    const explicit = runner.picker.buildStep({ ...draft, selector: 'text: Settings\nindex: 0\n', yaml: 'appId: com.example.App\n---\n# Keep authored comment\n- launchApp\n' });
    assert.equal(parseAllDocuments(explicit.yaml).length, 2);
    assert.match(explicit.yaml, /Keep authored comment/);
    assert.match(explicit.yaml, /launchApp/);
    assert.match(explicit.yaml, /text: \^Settings\$/);
    assert.match(explicit.flowYaml, /tapOn:/);
    assert.doesNotMatch(explicit.flowYaml, /launchApp/);
    const home = capture.candidates.find(candidate => candidate.text === 'Home')!;
    const input = runner.picker.preview({ captureId: capture.id, candidateId: home.id, command: 'input', selector: 'text: Home', inputText: 'hello' });
    assert.match(input.stepsYaml, /tapOn:/); assert.match(input.stepsYaml, /inputText: hello/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a captured step cannot acquire execution ownership after device or UI identity changes', async () => {
  const { runner, root, changeScreen } = await fixture();
  try {
    const capture = await runner.picker.capture({ deviceId });
    await assert.rejects(runner.acquireDevice('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', capture.id), /device/i);
    changeScreen();
    await assert.rejects(runner.acquireDevice(deviceId, capture.id), /stale/i);
    const release = await runner.acquireDevice(deviceId);
    await release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('identifier and coordinate fallbacks require deliberate choice and assertions remain semantic', async () => {
  const { runner, root } = await fixture();
  try {
    const capture = await runner.picker.capture({ deviceId });
    const candidate = capture.candidates.find(candidate => candidate.text === 'Home')!;
    const draft = { captureId: capture.id, candidateId: candidate.id, command: 'tap' as const, selector: 'point: "16%, 14%"' };
    assert.throws(() => runner.picker.preview(draft), /deliberate/i);
    assert.equal(runner.picker.preview({ ...draft, fallback: 'coordinates' }).canSave, true);
    assert.throws(() => runner.picker.preview({ ...draft, fallback: 'coordinates', command: 'visible' }), /tap\/input/i);
    assert.throws(() => runner.picker.preview({ ...draft, selector: 'id: Home' }), /identifier targeting/i);
    assert.throws(() => runner.picker.preview({ ...draft, selector: 'text: Home\nunsupported: true' }), /Unsupported/i);
    assert.throws(() => runner.picker.preview({ ...draft, selector: 'text: ${PASSWORD}' }), /literal/i);
    assert.match(runner.picker.preview({ ...draft, command: 'not-visible', selector: 'text: Home' }).stepsYaml, /assertNotVisible:/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a reviewed fallback cannot move its point outside the chosen element', async () => {
  const { runner, root } = await fixture();
  try {
    const capture = await runner.picker.capture({ deviceId });
    const candidate = capture.candidates.find(candidate => candidate.text === 'Home')!;
    const preview = runner.picker.preview({ captureId: capture.id, candidateId: candidate.id, command: 'tap', selector: 'point: "90%, 90%"', fallback: 'coordinates' });
    assert.equal(preview.canSave, false);
    assert.match(preview.note, /outside/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('expired captures cannot be reviewed or used for execution', async t => {
  const { runner, root } = await fixture();
  try {
    const capture = await runner.picker.capture({ deviceId });
    const candidate = capture.candidates.find(candidate => candidate.text === 'Home')!;
    t.mock.method(Date, 'now', () => Date.parse(capture.expiresAt) + 1);
    assert.throws(() => runner.picker.preview({ captureId: capture.id, candidateId: candidate.id, command: 'tap', selector: 'text: Home' }), /expired/i);
    await assert.rejects(runner.acquireDevice(deviceId, capture.id), /expired/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a reviewed text target stays usable across unrelated status changes but rejects changes to its own identity', async () => {
  const { runner, root, changeClock, changeScreen } = await fixture();
  try {
    const capture = await runner.picker.capture({ deviceId });
    const candidate = capture.candidates.find(candidate => candidate.text === 'Home')!;
    const built = runner.picker.buildStep({ captureId: capture.id, candidateId: candidate.id, command: 'visible', selector: 'text: Home', yaml: 'appId: com.example.App\n---\n- launchApp\n' });
    changeClock();
    const release = await runner.acquireDevice(deviceId, capture.id, built.reviewId);
    await release();
    changeScreen();
    await assert.rejects(runner.acquireDevice(deviceId, capture.id, built.reviewId), /stale/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a picked execution cannot substitute another flow for its reviewed YAML', async () => {
  const { runner, root } = await fixture();
  try {
    const capture = await runner.picker.capture({ deviceId });
    const candidate = capture.candidates.find(candidate => candidate.text === 'Home')!;
    const step = runner.picker.buildStep({ captureId: capture.id, candidateId: candidate.id, command: 'visible', selector: 'text: Home', yaml: 'appId: com.example.App\n---\n- launchApp\n' });
    const scenarios = createScenarios({ root, runner, maestro: { version: async () => { throw new Error('Must not execute'); }, run: async () => { throw new Error('Must not execute'); } } });
    const workspace = await scenarios.save({ name: 'Changed after review', yaml: step.flowYaml.replace('Home', 'Other') });
    await assert.rejects(scenarios.start({ workspaceId: workspace.id, deviceId, captureId: capture.id, pickerReviewId: step.reviewId }), /differs from executable YAML/i);
    const release = await runner.acquireDevice(deviceId); await release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('duplicate indices follow Maestro screen order rather than hierarchy traversal order', async () => {
  const tree = JSON.stringify(node('', '[0,0][0,0]', [node('App', '[0,0][393,852]', [node('Buy', '[20,300][100,340]'), node('buy', '[20,100][100,140]')])]));
  const { runner, root } = await fixture(tree);
  try {
    const capture = await runner.picker.capture({ deviceId });
    const upper = capture.candidates.find(candidate => candidate.text === 'buy')!;
    const draft = { captureId: capture.id, candidateId: upper.id, command: 'tap' as const, selector: 'text: Buy' };
    const ambiguous = runner.picker.preview(draft);
    assert.equal(ambiguous.canSave, false); assert.equal(ambiguous.matches.length, 2);
    assert.equal(runner.picker.preview({ ...draft, selector: 'text: Buy\nindex: 0' }).canSave, true);
    assert.equal(runner.picker.preview({ ...draft, selector: 'text: Buy\nindex: 1' }).canSave, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unverified hierarchy cleanup retains device ownership for manual recovery', async () => {
  const { runner, root } = await fixture(hierarchy, new InspectionCleanupError('Owned hierarchy helper cleanup could not be verified.'));
  try {
    await assert.rejects(runner.picker.capture({ deviceId }), /cleanup could not be verified/i);
    await assert.rejects(runner.acquireDevice(deviceId), /in progress/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
