import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, test} from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {createAi} from '../server/ai/index.js';
import {packPrompt} from '../server/ai/prompt.js';
import {createFakeProvider} from '../server/ai/providers/fake.js';
import type {FlowModelProvider} from '../server/ai/providers/types.js';
import {loadBundledSkills, loadSkill} from '../server/ai/skills.js';
import {authoringFixture, exampleDraft, proofYaml} from './authoring-helpers.js';

const FLOW_HASH = '1057aac4c3d9b258b541168b9009aa3f54506bda3e83cda0a0113ee044cfa191';

type CheckSpec = {value: string};
type ScreenSpec = {screenId: string; title: string; checks?: CheckSpec[]; checkCount?: number; checkValue?: string};
type WorkspaceSpec = {appId: string; screens: ScreenSpec[]};
type ModelOutput = {text?: string; draft?: unknown; schemaValid?: boolean};
type QuestionExpect = {key: string; about?: string; optionCount: number; options?: string[]};
type FlowCase = {
  id: string;
  request: string;
  workspace: WorkspaceSpec;
  outputs: ModelOutput[];
  refine?: {request: string; answers: {key: string; answer: string}[]; outputs: ModelOutput[]};
  expect: {
    state: 'pending' | 'needsInfo' | 'failed';
    applicable?: boolean;
    compiled?: boolean;
    errorCode?: string;
    retryable?: boolean;
    diagnostic?: string;
    contextTrimmed?: boolean;
    calls?: number;
    preview?: boolean;
    repairIncludes?: string;
    userIncludes?: string[];
    userExcludes?: string[];
    reusedScreenId?: string;
    questions?: QuestionExpect[];
    absentQuestionKeys?: string[];
    scriptPlacements?: {beforeOperation: string; scenarioEnd: string};
  };
};

const golden = JSON.parse(readFileSync(new URL('./fixtures/flow-prompt-golden.json', import.meta.url), 'utf8')) as {system: string; systemWithSchema: string; schema: string};
const cases = JSON.parse(readFileSync(new URL('../server/ai/skills/flow/v1/fixtures/cases.json', import.meta.url), 'utf8')) as FlowCase[];
const emptyContext = {screens: [], targets: [], setups: [], handlers: [], mocks: [], omissions: []};

function memorySecrets() {
  const values = new Map<string, string>();
  return {values, async get(service: string) { return values.get(service); }, async set(service: string, value: string) { values.set(service, value); }, async delete(service: string) { values.delete(service); }};
}

function outputText(output: ModelOutput) {
  if (typeof output.text === 'string') return output.text;
  return JSON.stringify(output.draft);
}

async function settle<T extends {state: string}>(ai: {get(id: string): Promise<T>}, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await ai.get(id);
    if (job.state !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('generation did not finish');
}

function canvasFrom(workspace: WorkspaceSpec) {
  const screens = workspace.screens.map((screen, index) => {
    const checks = screen.checks ?? Array.from({length: screen.checkCount ?? 0}, () => ({value: screen.checkValue ?? 'Home'}));
    return {
      id: screen.screenId,
      title: screen.title,
      x: index * 40,
      y: 0,
      tests: checks.map((check, checkIndex) => ({
        id: `${screen.screenId}-check-${checkIndex}`,
        label: `Check ${checkIndex}`,
        role: 'assertion' as const,
        reference: {kind: 'step' as const, file: 'flow.yaml', index: checkIndex, fingerprint: 'draft'},
        check: {visibility: 'visible' as const, target: 'text' as const, match: 'exact' as const, value: check.value},
      })),
    };
  });
  return {screens, edges: [], paths: []};
}

test('flow@1 is the bundled authoring skill and its hash covers the raw files', () => {
  const skill = loadSkill('flow');
  const bundled = loadBundledSkills();
  assert.equal(skill.id, 'flow@1');
  assert.equal(skill.name, 'flow');
  assert.equal(skill.version, 1);
  assert.equal(skill.hash, FLOW_HASH);
  assert.equal(bundled.flow.hash, FLOW_HASH);
  assert.equal(skill.prompt, golden.system);
  assert.equal(JSON.stringify(skill.schema), golden.schema);
});

test('packPrompt system text and the flow schema match the pre-move golden', () => {
  const skill = loadSkill('flow');
  const bare = packPrompt({prompt: 'Open the home screen', appId: 'com.example.TnTProof', context: emptyContext});
  const withSchema = packPrompt({prompt: 'Open the home screen', appId: 'com.example.TnTProof', context: emptyContext, schema: skill.schema});
  assert.equal(bare.system, golden.system);
  assert.equal(withSchema.system, golden.systemWithSchema);
  assert.equal(JSON.stringify(skill.schema), golden.schema);
  assert.equal(withSchema.system.startsWith(golden.system), true);
  assert.equal(withSchema.system.includes(golden.schema), true);
});

test('a flow job sends the golden system string and schema', async () => {
  const seen: {system: string; schema: string; sendsJsonSchema: boolean}[] = [];
  async function run(sendsJsonSchema: boolean) {
    const f = await authoringFixture();
    const inner = createFakeProvider(() => ({kind: 'ok', text: JSON.stringify(exampleDraft)}));
    const provider: FlowModelProvider = {
      id: 'fake',
      readsImages: true,
      ...(sendsJsonSchema ? {sendsJsonSchema: true} : {}),
      check: () => inner.check(),
      generate(req) {
        seen.push({system: req.system, schema: JSON.stringify(req.schema), sendsJsonSchema});
        return inner.generate(req);
      },
    };
    const ai = createAi({
      root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(), log: () => {}, provider,
    });
    try {
      const started = await ai.start({workspaceId: f.workspace.id, expectedRevision: f.workspace.metadata!.revision, prompt: 'Open details and return home'});
      const job = await settle(ai, started.id);
      assert.equal(job.state, 'pending');
      assert.equal(job.skill, 'flow@1');
      assert.equal(job.skillHash, FLOW_HASH);
    } finally {
      await ai.idle();
      await f.cleanup();
    }
  }
  await run(false);
  await run(true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].system, golden.systemWithSchema);
  assert.equal(seen[0].schema, golden.schema);
  assert.equal(seen[1].system, golden.system);
  assert.equal(seen[1].schema, golden.schema);
  assert.equal(seen[1].system.includes(golden.schema), false);
});

describe('flow authoring eval', {concurrency: 1}, () => {
  const validate = new Ajv2020({strict: true, allErrors: true}).compile(loadSkill('flow').schema);

  test('the fixture lists 10 to 15 offline cases', () => {
    assert.ok(cases.length >= 10 && cases.length <= 15, `expected 10 to 15 cases, found ${cases.length}`);
    assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  });

  for (const item of cases) {
    test(item.id, async () => {
      for (const output of [...item.outputs, ...(item.refine?.outputs ?? [])]) {
        if (output.draft === undefined) continue;
        assert.equal(validate(output.draft), output.schemaValid === true, `${item.id} schemaValid ${output.schemaValid} ${JSON.stringify(validate.errors)}`);
      }
      const seen: {system: string; messages: {role: string; content: string}[]}[] = [];
      let script = item.outputs;
      let cursor = 0;
      const f = await authoringFixture();
      let workspace = f.workspace;
      if (item.workspace.screens.length) {
        assert.equal(item.workspace.appId, 'com.example.TnTProof');
        workspace = await f.service.save({
          id: workspace.id,
          name: workspace.name,
          yaml: proofYaml,
          flows: {},
          scenarios: [],
          canvas: canvasFrom(item.workspace),
          expectedRevision: workspace.metadata!.revision,
        });
      }
      const ai = createAi({
        root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(), log: () => {},
        provider: createFakeProvider(({system, messages}) => {
          const output = script[cursor];
          cursor += 1;
          if (!output) throw new Error(`${item.id} ran out of canned outputs`);
          seen.push({system, messages});
          return {kind: 'ok', text: outputText(output)};
        }),
      });
      try {
        const first = await settle(ai, (await ai.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: item.request})).id);
        assert.equal(cursor, item.outputs.length, item.id);
        let job = first;
        if (item.refine) {
          assert.equal(first.state, 'needsInfo', item.id);
          script = item.refine.outputs;
          cursor = 0;
          seen.length = 0;
          job = await settle(ai, (await ai.start({
            workspaceId: workspace.id,
            expectedRevision: workspace.metadata!.revision,
            prompt: item.refine.request,
            previousJobId: first.id,
            answers: item.refine.answers,
          })).id);
          assert.equal(cursor, item.refine.outputs.length, item.id);
        }
        const expect = item.expect;
        assert.equal(job.state, expect.state, item.id);
        assert.equal(job.skill, 'flow@1', item.id);
        assert.equal(job.skillHash, FLOW_HASH, item.id);
        if (expect.calls !== undefined) assert.equal(seen.length, expect.calls, item.id);
        if (expect.errorCode) {
          assert.equal(job.error?.code, expect.errorCode, item.id);
          assert.equal(job.error?.retryable, expect.retryable ?? false, item.id);
          assert.equal(typeof job.error?.message, 'string', item.id);
        } else assert.equal(job.error, undefined, item.id);
        if (expect.preview !== undefined) assert.equal(job.preview !== undefined, expect.preview, item.id);
        if (expect.applicable !== undefined) assert.equal(job.preview?.applicable, expect.applicable, item.id);
        if (expect.compiled) {
          assert.ok(job.preview?.timeline.some(entry => entry.kind === 'uiOperation'), item.id);
          assert.ok(job.preview?.changes.created.some(entry => entry.kind === 'scenario'), item.id);
        }
        if (expect.diagnostic) assert.equal(job.preview?.diagnostics.some(entry => entry.code === expect.diagnostic), true, item.id);
        if (expect.contextTrimmed !== undefined) assert.equal(job.contextTrimmed === true, expect.contextTrimmed, item.id);
        if (expect.reusedScreenId) assert.equal(job.preview?.changes.reused.some(entry => entry.kind === 'screen' && entry.id === expect.reusedScreenId), true, item.id);
        if (expect.questions) {
          assert.equal(job.questions?.length, expect.questions.length, item.id);
          expect.questions.forEach((question, index) => {
            const actual = job.questions?.[index];
            assert.equal(actual?.key, question.key, item.id);
            assert.equal(actual?.about, question.about, item.id);
            assert.equal(actual?.options.length, question.optionCount, item.id);
            assert.ok((actual?.options.length ?? 0) >= 2 && (actual?.options.length ?? 0) <= 3, item.id);
            if (question.options) assert.deepEqual(actual?.options, question.options, item.id);
          });
        }
        for (const key of expect.absentQuestionKeys ?? []) assert.equal(job.questions?.some(question => question.key === key), false, `${item.id} ${key}`);
        if (expect.scriptPlacements) {
          const scripts = job.preview?.timeline.filter(entry => entry.kind === 'runScript') ?? [];
          assert.equal(scripts.some(entry => entry.kind === 'runScript' && !entry.atEnd && entry.scriptKey === expect.scriptPlacements?.beforeOperation), true, item.id);
          assert.equal(scripts.some(entry => entry.kind === 'runScript' && entry.atEnd && entry.scriptKey === expect.scriptPlacements?.scenarioEnd), true, item.id);
        }
        const joined = seen.flatMap(call => call.messages.map(message => message.content)).join('\n');
        for (const text of expect.userIncludes ?? []) assert.equal(joined.includes(text), true, `${item.id} missing ${text}`);
        for (const text of expect.userExcludes ?? []) assert.equal(joined.includes(text), false, `${item.id} leaked ${text}`);
        if (expect.repairIncludes) assert.equal(joined.includes(expect.repairIncludes), true, item.id);
        for (const call of seen) {
          assert.equal(call.system, golden.systemWithSchema, item.id);
          assert.equal(call.system.startsWith(golden.system), true, item.id);
        }
      } finally {
        await ai.idle();
        await f.cleanup();
      }
    });
  }
});
