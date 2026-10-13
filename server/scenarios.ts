import {parsePackage,portableContent,packageReview,readOmittedValues,missingValues,type OmittedValue,type WorkspacePackage} from './workspace-package.js';
import {WorkspaceConflict,createWorkspaceStore,type WorkspaceMetadata,type WorkspaceStoreFaults} from './workspace-store.js';
import {createBatches} from './batches.js';
import {projectCanvasRoute} from './canvas-route.js';
import {refreshChecks,operationProblem} from '../shared/canvas-authoring.js';
import {readScenarios,selectScenario,validateFlowInputs,type ScenarioDefinition} from './scenario-definitions.js';
import {readAutomation,instrument,mapAutomation,metadataStatus,type Automation,type AutomationResult,type ExecutionItem} from './default-actions.js';
import { mkdir, readFile, writeFile, realpath, readdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { XMLParser } from 'fast-xml-parser';
import {readCanvas,referenceCatalog,inspectCanvas,selectedCanvasPath,mapCanvas,type CanvasGraph,type CanvasDiagnostic,type CanvasResult} from './canvas.js';
import { createMockSession, validateMock, type MockPlan, type MockResult } from './mockoon.js';
import type { createRunner } from './runner.js';

export type Workspace = { omittedValues?:OmittedValue[]; metadata?:WorkspaceMetadata; scenarios?:ScenarioDefinition[]; id: string; name: string; yaml: string; automation?:Automation; flows?: Record<string, string>; mock?: MockPlan; canvas?: CanvasGraph; canvasDiagnostics?: CanvasDiagnostic[] };
export type Step = { id: string; command: string; expected?: unknown; actual?:unknown; detail?:string; artifacts?:string[]; assertionStatus?:Step['status']; status: 'unavailable' | 'passed' | 'failed' | 'skipped' };
export type Cleanup = { verified: boolean; detail: string };
export type Run = {
  id: string; deviceId: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'passed' | 'path-failed' | 'assertion-failed' | 'tool-error' | 'setup-error' | 'handler-error' | 'cancelled';
  automation?:AutomationResult;
  mock?: MockResult; canvas?: CanvasResult;
  snapshot: { scenario?:ScenarioDefinition; resetApp?:boolean; authoredYaml?:string; automation?:Automation; executionYaml?:string; executionPlan?:ExecutionItem[]; canvas?: CanvasGraph; canvasPathId?: string; flows?: Record<string, string>; mock?: MockPlan; expectedPath?: { from: string; to: string }; id: string; workspaceId: string; name: string; yaml: string; steps: Step[]; toolVersions: { maestro: string; node: string; mockoon?: string }; runtimeInputPolicy: string; pickerReference?: { captureId: string; reviewId: string; capturedAt: string } };
  steps: Step[]; log: string; error?: string; expectedFailure?: unknown;
  cleanup: Cleanup; artifacts: string[]; mappingNote: string;
};
export type RunInput = { workspaceId: string; deviceId: string; runtimeInputs?: unknown; captureId?: string; pickerReviewId?: string; pathId?: string; scenarioId?:string; resetApp?:boolean };
export type Maestro = {
  version(): Promise<string>;
  run(input: { directory: string; flow: string; deviceId: string; signal: AbortSignal; runtimeInputs?: Record<string, string> }): Promise<{ code: number | null; log: string; cleanup: Cleanup }>;
};
const validId = (id: string) => { if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid workspace/run identifier.'); return id; };

export function createScenarios(options: { root: string; runner: ReturnType<typeof createRunner>; maestro: Maestro; faults?: WorkspaceStoreFaults; now?: () => Date }) {
  const activeWorkspaces=new Set<string>();
  const deleting=new Set<string>();
  const pending = new Map<string, Promise<Run>>();
  const controllers = new Map<string, AbortController>();
  async function directory(kind: string, id: string) {
    const base = resolve(options.root, kind);
    await mkdir(base, { recursive: true });
    if (!(await realpath(base)).startsWith((await realpath(options.root)) + sep)) throw new Error('Workspace path escapes its root.');
    const path = join(base, validId(id));
    await mkdir(path, { recursive: true });
    if (!(await realpath(path)).startsWith((await realpath(base)) + sep)) throw new Error('Workspace path escapes its root.');
    return path;
  }
  function authoredWorkspace(input: {id?:string;name:string;yaml:string;flows?:Record<string,string>;mock?:unknown;canvas?:unknown;automation?:unknown;scenarios?:unknown;omittedValues?:unknown},unresolved?:string[]):Workspace {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120 || typeof input.yaml !== 'string' || Buffer.byteLength(input.yaml) > 100_000) throw new Error('Provide a workspace title and YAML up to 100 KB.');
      const scenarios=readScenarios(input.scenarios);
      const flows = validateFlows(input.flows,unresolved);
      const mock = validateMock(input.mock);
      const rawCanvas=readCanvas(input.canvas);
      const canvas=rawCanvas?refreshChecks(rawCanvas,input.yaml):undefined;

      if (Buffer.byteLength(JSON.stringify({flows,mock,canvas,automation:input.automation,scenarios})) > 900_000) throw new Error('Combined reusable flows and mock environment exceed 900 KB.');
      const automation=readAutomation(input.automation,flows??{},input.yaml,unresolved);
      const canvasDiagnostics=canvas?inspectCanvas(canvas,input.yaml,flows,automation).diagnostics:undefined;
      return { omittedValues:readOmittedValues(input.omittedValues), scenarios, automation, flows, mock, canvas, canvasDiagnostics, id: input.id ? validId(input.id) : '', name: input.name.trim(), yaml: input.yaml };

  }
  const workspaceStore=createWorkspaceStore(options.root,input=>authoredWorkspace(input,[]),{faults:options.faults,now:options.now});
  const service = {
    async preview(input:{yaml:string;flows?:Record<string,string>;automation?:unknown;canvas?:unknown;mock?:unknown;scenarios?:unknown;scenarioId?:string;pathId?:string;runtimeInputs?:unknown;resetApp?:boolean}) {
      if(typeof input.yaml!=='string'||Buffer.byteLength(input.yaml)>100_000)throw new Error('Provide YAML up to 100 KB.');
      const flows=validateFlows(input.flows);
      if(input.resetApp!==undefined&&typeof input.resetApp!=='boolean')throw new Error('Reset app must be a boolean.');
      const configured=readAutomation(input.automation,flows??{},input.yaml);
      const selection=selectScenario({yaml:input.yaml,flows,automation:configured,canvas:readCanvas(input.canvas),mock:validateMock(input.mock),scenarios:readScenarios(input.scenarios)},input.scenarioId,validateInputs(input.runtimeInputs));
      let yaml=selection?.yaml??input.yaml;let automation=selection?.automation??configured;
      const rawCanvas=selection?.canvas??readCanvas(input.canvas);
      if(rawCanvas){const canvas=refreshChecks(rawCanvas,yaml);const pathId=selection?.scenario.pathId??input.pathId;const projection=projectCanvasRoute(canvas,yaml,flows??{},pathId,automation);yaml=projection.yaml;automation=projection.automation;selectedCanvasPath(projection.canvas,yaml,flows??{},pathId,automation);}
      const root=validate(yaml,flows);
      for(const flow of Object.values(flows??{}))if(validate(flow,flows).appId!==root.appId)throw new Error('Reusable flows must declare the same appId as the scenario.');
      const executionYaml=automation?instrument(yaml,automation,input.resetApp??false).yaml:yaml;
      validateFlowInputs(executionYaml,flows??{},selection?.inputs??validateInputs(input.runtimeInputs));
      return {authoredYaml:yaml,executionYaml};
    },
    async references(input: {yaml:string;flows?:Record<string,string>;canvas?:unknown;automation?:unknown}) {
      if(typeof input.yaml!=='string'||Buffer.byteLength(input.yaml)>100_000|| (input.flows!==undefined&&(!input.flows||typeof input.flows!=='object'||Array.isArray(input.flows)||Object.values(input.flows).some(value=>typeof value!=='string')))||Buffer.byteLength(JSON.stringify(input.flows??{}))>900_000)throw new Error('Provide bounded YAML and reusable flows.');
      const rawCanvas=readCanvas(input.canvas);
      const canvas=rawCanvas?refreshChecks(rawCanvas,input.yaml):undefined;
      let automation:Automation|undefined;let automationError:string|undefined;
      try{automation=readAutomation(input.automation,input.flows??{},input.yaml);}catch(error){automationError=error instanceof Error?error.message:'Repair default-action configuration.';}
      const catalog=canvas?inspectCanvas(canvas,input.yaml,input.flows,automation):referenceCatalog(input.yaml,input.flows,automation);
      if(automationError)catalog.diagnostics.push({ownerId:'automation',detail:automationError});
      return catalog;
    },
    async save(input: { clearDraft?:number; expectedRevision?:number; metadata?:WorkspaceMetadata; id?: string; name: string; yaml: string; flows?: Record<string,string>; mock?: unknown; canvas?: unknown; automation?:unknown; scenarios?:unknown; omittedValues?:unknown }): Promise<Workspace> {
      const revision=input.expectedRevision??input.metadata?.revision??0;
      if(!Number.isSafeInteger(revision)||revision<0)throw new Error('Invalid workspace revision.');
      if(input.clearDraft!==undefined&&(!Number.isSafeInteger(input.clearDraft)||input.clearDraft<0))throw new Error('Invalid draft revision.');
      return workspaceStore.save(authoredWorkspace(input),revision,input.clearDraft);
    },
    async workspace(id: string): Promise<Workspace> { return workspaceStore.read(id); },
    async workspaceDetail(id:string){return workspaceStore.bundle(id);},
    async openWorkspace(id:string){return workspaceStore.open(id);},
    async renameWorkspace(id:string,name:string,expectedRevision=0){if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new Error('Invalid workspace revision.');return workspaceStore.rename(id,name,expectedRevision);},
    async listWorkspaces(query=''){return workspaceStore.list(query);},
    async saveDraft(id:string,input:{baseRevision:number;expectedDraftRevision:number;name:string;content:unknown;fields:unknown}){return workspaceStore.saveDraft(id,input);},
    async createDraftWorkspace(input:{name:string;content:unknown;fields:unknown}){
      const shell=authoredWorkspace({name:input.name,yaml:'appId: com.example.HybridApp\n---\n- launchApp\n',flows:{},scenarios:[],canvas:{screens:[],edges:[],paths:[]}});
      return workspaceStore.createWithDraft(shell,input);
    },
    async discardDraft(id:string,expectedDraftRevision:number){return workspaceStore.discardDraft(id,expectedDraftRevision);},
    async saveView(id:string,view:unknown){return workspaceStore.saveView(id,view);},
    async session(){return workspaceStore.session();},
    async setSession(id:string|null){return workspaceStore.setSession(id);},
    async listTrash(){return workspaceStore.listTrash();},
    async trashWorkspace(id:string){if(deleting.has(id))throw new Error('This workspace is already moving to Trash. Wait and retry.');if(activeWorkspaces.has(id)||batches.activeWorkspaceId===id)throw new Error('Active execution blocks deletion of this workspace. Wait for execution and cleanup; no run was cancelled.');deleting.add(id);try{return await workspaceStore.trash(id);}finally{deleting.delete(id);}},
    async restoreWorkspace(id:string){return workspaceStore.restore(id);},
    async purgeWorkspace(id:string){return workspaceStore.purge(id);},
    async copyWorkspace(input:Parameters<typeof authoredWorkspace>[0]){
      const content=authoredWorkspace({...input,id:undefined});
      const incomplete=content.canvas?.screens.flatMap(screen=>screen.tests).find(test=>operationProblem(test));if(incomplete)throw new Error('Repair incomplete canvas content before copying. '+operationProblem(incomplete));
      validate(content.yaml,content.flows);
      for(const flow of Object.values(content.flows??{}))validate(flow,content.flows);
      return workspaceStore.save(content);
    },
    async exportWorkspace(input:{id:string;expectedRevision:number;includeValues?:boolean}){
      if(input.includeValues!==undefined&&typeof input.includeValues!=='boolean')throw new Error('Include values must be a boolean.');
      const workspace=await workspaceStore.read(input.id);
      if(workspace.metadata!.revision!==input.expectedRevision)throw new WorkspaceConflict();
      const incomplete=workspace.canvas?.screens.flatMap(screen=>screen.tests).find(test=>operationProblem(test));
      if(incomplete)throw new Error('Repair incomplete authored content before export. '+operationProblem(incomplete));
      validate(workspace.yaml,workspace.flows);
      const content=portableContent(workspace,input.includeValues===true);
      const pkg:WorkspacePackage={dependencies:packageReview(content,[]).dependencies,format:'tnt-workspace',version:1,source:{revision:workspace.metadata!.revision,savedAt:workspace.metadata!.updatedAt},workspace:content};
      if(Buffer.byteLength(JSON.stringify(pkg,null,2)+'\n')>1_100_000)throw new Error('Formatted workspace package exceeds 1.1 MB. Reduce embedded images or authored content.');
      const reviewed=await service.reviewWorkspacePackage({package:pkg});
      return {...reviewed,filename:(workspace.name.replace(/[^\p{L}\p{N}._-]+/gu,'-').slice(0,100)||'workspace')+'.tnt-workspace.json'};
    },
    async reviewWorkspacePackage(input:{package:unknown}){
      const pkg=parsePackage(input.package);
      const missing:string[]=[];
      const content=authoredWorkspace({...pkg.workspace,id:undefined},missing);
      validate(content.yaml,content.flows,[],new Set(),missing);
      if(!content.scenarios?.length)try{await service.preview(content);}catch(error){missing.push(error instanceof Error?error.message:'Repair missing YAML inputs.');}
      for(const scenario of content.scenarios??[])try{await service.preview({...content,scenarioId:scenario.id});}catch(error){missing.push(scenario.name+': '+(error instanceof Error?error.message:'Repair scenario.'));}
      const review=packageReview(content,[...missing,...(content.canvasDiagnostics??[]).map(item=>item.detail)]);
      return {package:{...pkg,dependencies:review.dependencies,workspace:portableContent(content,true)},review};
    },
    async importWorkspace(input:{package:unknown;name:string}){
      const reviewed=await service.reviewWorkspacePackage(input);
      return workspaceStore.importCopy(authoredWorkspace({...reviewed.package.workspace,name:input.name,id:undefined},[]));
    },
    async start(input: RunInput): Promise<Run> {
      if (batches.busy) throw new Error('A scenario batch is in progress. Wait for cleanup.');
      if(deleting.has(input.workspaceId))throw new Error('This workspace is moving to Trash. Retry after deletion finishes.');
      if(activeWorkspaces.has(input.workspaceId))throw new Error('Execution is in progress for this workspace. Wait for cleanup.');
      activeWorkspaces.add(input.workspaceId);
      try{
      const workspace = await service.workspace(input.workspaceId);
      if (batches.busy) throw new Error('A scenario batch is in progress. Wait for cleanup.');
      const run=await startWorkspace(input, workspace);
      void service.wait(run.id).finally(()=>activeWorkspaces.delete(input.workspaceId)).catch(()=>{});return run;
      }catch(error){activeWorkspaces.delete(input.workspaceId);throw error;}
    },
    async result(id: string): Promise<Run> { return readRecord(await directory('runs', id), 'result.json'); },
    async wait(id: string): Promise<Run> { return pending.get(id) ?? service.result(id); },
    async cancel(id: string) { const controller = controllers.get(validId(id)); if (!controller) throw new Error('Run is no longer active.'); controller.abort(); return service.wait(id); },
    async artifact(id: string, name: string) {
      const run = await service.result(id);
      if (!run.artifacts.includes(name)) throw new Error('Unknown run artifact.');
      const base = await directory('runs', id);
      const path = await realpath(resolve(base, name));
      if (!path.startsWith((await realpath(base)) + sep)) throw new Error('Artifact path escapes its run.');
      return readFile(path);
    },
  };
  async function startWorkspace(input: RunInput, authored: Workspace, signal?: AbortSignal): Promise<Run> {
      const runtimeInputs = validateInputs(input.runtimeInputs);
      const confidential = Object.keys(runtimeInputs).length > 0;
      if(input.resetApp!==undefined&&typeof input.resetApp!=='boolean')throw new Error('Reset app must be a boolean.');
      const selection=selectScenario(authored,input.scenarioId,runtimeInputs);
      const omitted=missingValues({...authored,automation:selection?.automation??authored.automation},{runtime:runtimeInputs,scenarioId:input.scenarioId});if(omitted.length)throw new Error('Repair imported workspace before execution. '+omitted.join(' '));
      let workspace=selection?{...authored,...selection,name:selection.scenario.name}:authored;
      const selectedPathId=selection?.scenario.pathId??input.pathId;
      const resetApp=input.resetApp??false;
      if(resetApp&&!workspace.automation&&!selection)throw new Error('Reset requires declared independent setup.');
      validateFlows(workspace.flows);
      validateMock(workspace.mock);
      const rawCanvas=readCanvas(workspace.canvas);
      let canvas=rawCanvas?refreshChecks(rawCanvas,workspace.yaml):undefined;

      let automation=readAutomation(workspace.automation,workspace.flows??{},workspace.yaml);
      if(canvas){const projection=projectCanvasRoute(canvas,workspace.yaml,workspace.flows??{},selectedPathId,automation);canvas=projection.canvas;workspace={...workspace,yaml:projection.yaml};automation=projection.automation;}
      const canvasPath=canvas?selectedCanvasPath(canvas,workspace.yaml,workspace.flows??{},selectedPathId,automation):undefined;
      const { appId, steps } = validate(workspace.yaml, workspace.flows);
      const derived=automation?instrument(workspace.yaml,automation,resetApp):undefined;
      validateFlowInputs(derived?.yaml??workspace.yaml,workspace.flows??{},selection?.inputs??runtimeInputs);
      for (const flow of Object.values(workspace.flows ?? {})) { if (validate(flow, workspace.flows).appId !== appId) throw new Error('Reusable flows must declare the same appId as the scenario.'); }
      if ((input.captureId === undefined) !== (input.pickerReviewId === undefined)) throw new Error('Provide both capture and reviewed step identity.');
      const pickerReference = input.captureId ? options.runner.picker.assertReview(input.captureId, input.pickerReviewId!, workspace.yaml) : undefined;
      const release = await options.runner.acquireDevice(input.deviceId, input.captureId, input.pickerReviewId);
      try {
        const device = (await options.runner.devices()).find(device => device.id === input.deviceId);
        if (!device) throw new Error('Select an available, already-running simulator and refresh.');
        await options.runner.checkApp(device.id, appId);
        const version = await options.maestro.version();
        if (signal?.aborted) throw new Error('Batch cancelled before execution.');
        const id = randomUUID();
        const path = await directory('runs', id);
        const runtimeInputPolicy = confidential ? 'Confidential runtime inputs supplied: values are omitted; raw logs, evaluated metadata, and images are withheld. Temporary tool artifacts are deleted on cleanup. Historical snapshots cannot replay omitted inputs.' : selection?'Saved non-confidential scenario inputs supplied; runtime values are scoped to this run. Keep secrets out of saved inputs/YAML. No inherited application environment is forwarded.':'No runtime inputs supplied. Keep secrets out of authored YAML. No inherited application environment is forwarded.';
        const snapshot = { scenario:selection?.scenario, resetApp, authoredYaml:selection||canvas?authored.yaml:undefined, automation, executionYaml:derived?.yaml, executionPlan:derived?.plan, canvas, canvasPathId: canvasPath?.id, flows: workspace.flows, mock: workspace.mock, expectedPath: workspace.mock ? { from: workspace.mock.fromScreen, to: workspace.mock.toScreen } : undefined, id: createHash('sha256').update(JSON.stringify({ workspace, derived, steps, version, device, scenarioId:selection?.scenario.id,resetApp,pathId:canvasPath?.id, runtimeInputPolicy, pickerReference, node: process.version })).digest('hex'), workspaceId: workspace.id, name: workspace.name, yaml: workspace.yaml, steps, toolVersions: { maestro: version, node: process.version, mockoon: workspace.mock ? '9.9.0' : undefined }, runtimeInputPolicy, pickerReference };
        const run: Run = { id, deviceId: device.id, startedAt: new Date().toISOString(), status: 'running', canvas:canvas&&canvasPath?mapCanvas(canvas,canvasPath.id,workspace.yaml,steps,true,automation?{definition:automation,flows:workspace.flows}:undefined):undefined, snapshot, steps: structuredClone(steps), log: '', cleanup: { verified: false, detail: 'Pending' }, artifacts: [], mappingNote: 'Command outcomes will be mapped after execution; unsupported details remain unavailable.' };
        await writeFile(join(path, 'flow.yaml'), workspace.yaml);
        if(derived)await writeFile(join(path,'.tnt-execution.yaml'),derived.yaml);
        await writeFile(join(path, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
        await writeRecord(join(path, 'result.json'), run);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, {once:true});
        if (signal?.aborted) controller.abort();
        controllers.set(id, controller);
        const done = (async () => {
          let privateDirectory: string | undefined;
          let mock: ReturnType<typeof createMockSession> | undefined;
          let phase: 'setup' | 'execution' = 'setup';
          run.cleanup = { verified: true, detail: 'No tool process allocated yet.' };
          try {
            if (confidential) {
              const privateRoot = join(options.root, 'private');
              await mkdir(privateRoot, { recursive: true, mode: 0o700 });
              privateDirectory = await mkdtemp(join(privateRoot, id + '-'));
            }
            const executionDirectory = privateDirectory ?? path;
            if (privateDirectory) {await writeFile(join(executionDirectory, 'flow.yaml'), workspace.yaml);if(derived)await writeFile(join(executionDirectory,'.tnt-execution.yaml'),derived.yaml);}
            for (const [name, yaml] of Object.entries(workspace.flows ?? {})) await writeFile(join(executionDirectory, name), yaml);
            if (workspace.mock) {
              mock = createMockSession(workspace.mock, executionDirectory);
              run.mock = mock.result;
              await mock.prepare(controller.signal);
              await writeRecord(join(path, 'result.json'), run);
            }
            if (controller.signal.aborted) throw new Error('Run cancelled before execution.');
            phase = 'execution';
            const execution = await options.maestro.run({ directory: executionDirectory, flow: join(executionDirectory, derived?'.tnt-execution.yaml':'flow.yaml'), deviceId: device.id, signal: controller.signal, runtimeInputs:selection?.inputs??runtimeInputs });
            run.log = confidential ? 'Raw logs withheld because confidential runtime inputs were supplied.' : execution.log;
            run.cleanup = execution.cleanup;
            const files = await listFiles(executionDirectory);
            run.artifacts = confidential ? ['flow.yaml', 'snapshot.json'] : files.filter(file => file !== 'result.json');
            const commandFile = files.find(file => file.endsWith('commands.json'));
            const commands = commandFile ? JSON.parse(await readFile(join(executionDirectory, commandFile), 'utf8')) : [];
            mapResults(run, commands,confidential);
            const automationMapping=automation&&derived?mapAutomation(automation,derived.plan,commands):undefined;
            run.automation=automationMapping?.result;
            let report: any;
            try { report = new XMLParser({ ignoreAttributes: false }).parse(await readFile(join(executionDirectory, 'report.xml'), 'utf8')); } catch { /* Missing report is a tool error, never a pass. */ }
            const suite = report?.testsuites?.testsuite;
            const failedAssertion = commands.find((entry: any) => entry.metadata?.status === 'FAILED' && entry.command?.assertConditionCommand);
            run.status = controller.signal.aborted ? 'cancelled' : execution.code === 0 && Number(suite?.['@_tests']) === 1 && Number(suite?.['@_failures']) === 0 ? 'passed' : failedAssertion ? 'assertion-failed' : 'tool-error';
            if(automationMapping?.failedPhase){run.status=controller.signal.aborted?'cancelled':automationMapping.failedPhase==='setup'?'setup-error':'handler-error';run.error=automationMapping.failedPhase==='setup'?'Independent setup failed; dependent authored steps did not run.':'Default action failed; dependent authored steps did not run.';}
            if (failedAssertion) { run.error = confidential ? 'Assertion failed. Evaluated detail withheld for confidential inputs.' : failedAssertion.metadata.error?.message; run.expectedFailure = confidential ? run.steps.find(step => step.status === 'failed')?.expected : failedAssertion.command.assertConditionCommand.condition; }
            else if (run.status === 'tool-error') run.error = 'Maestro did not report a successful scenario or a structured assertion failure. Inspect raw logs.';
          } catch (error) {
            run.status = controller.signal.aborted ? 'cancelled' : phase === 'setup' ? 'setup-error' : 'tool-error';
            run.error = confidential ? 'Tool execution failed. Detail withheld for confidential inputs.' : error instanceof Error ? error.message : 'Tool execution failed.';
            if (mock && phase === 'setup') mock.result.intent.status = 'failed';
            if (phase === 'execution') run.cleanup = { verified: false, detail: 'Tool adapter failed; cleanup could not be verified.' };
          } finally {
            if (mock) {
              await mock.evidence(confidential);
              const mockCleanup = await mock.cleanup();
              run.cleanup = { verified: run.cleanup.verified && mockCleanup.verified, detail: run.cleanup.detail + ' ' + mockCleanup.detail };
            }
            // Never expose the controller environment file through the artifact API.
            run.artifacts = run.artifacts.filter(name => name !== 'mock-environment.json');
            if (privateDirectory) {
              try { await rm(privateDirectory, { recursive: true, force: true }); run.cleanup.detail += ' Confidential temporary artifacts removed.'; }
              catch { run.cleanup = { verified: false, detail: 'Confidential temporary artifact removal could not be verified.' }; }
            }
            if(canvas&&canvasPath){
              run.canvas=mapCanvas(canvas,canvasPath.id,workspace.yaml,run.steps,false,automation?{definition:automation,result:run.automation,flows:workspace.flows}:undefined);
              if(run.status==='passed'&&(run.canvas.edges.some(edge=>canvasPath.edgeIds.includes(edge.id)&&edge.status!=='passed')||!!canvasPath.screenId&&run.canvas.screens.find(screen=>screen.id===canvasPath.screenId)?.status!=='passed')){run.status='path-failed';run.error='The selected scenario path was not verified: a required action or destination assertion did not report passed. No alternate route was followed.';}
            }
            run.finishedAt = new Date().toISOString();
            try { await writeRecord(join(path, 'result.json'), run); }
            finally { signal?.removeEventListener('abort', abort); controllers.delete(id); if (run.cleanup.verified) await release(); }
          }
          return run;
        })();
        pending.set(id, done);
        void done.finally(() => pending.delete(id)).catch(() => {});
        return structuredClone(run);
      } catch (error) { await release(); throw error; }
  }
  const batches = createBatches({
    workspace: async id=>{if(deleting.has(id))throw new Error('This workspace is moving to Trash. Retry after deletion finishes.');return service.workspace(id);}, preview: service.preview,
    start: startWorkspace, wait: service.wait, cancel: service.cancel,
    persist: async batch => writeRecord(join(await directory('batches', batch.id), 'result.json'), batch),
    read: async id => readRecord(await directory('batches', id), 'result.json'),
  });
  return {...service, startBatch: batches.start, batch: batches.result, waitBatch: batches.wait, cancelBatch: batches.cancel};
}
async function readRecord(base: string, name: string) {
  const file = await realpath(join(base, name));
  if (!file.startsWith((await realpath(base)) + sep)) throw new Error('Record path escapes its workspace/run.');
  return JSON.parse(await readFile(file, 'utf8'));
}
async function writeRecord(file: string, value: unknown) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}
function validateInputs(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 20) throw new Error('Runtime inputs must be an object of at most 20 named strings.');
  const entries = Object.entries(value);
  if (entries.some(([key, input]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || key.startsWith('MAESTRO_') || typeof input !== 'string' || input.length > 4000 || input.includes('\0'))) throw new Error('Runtime inputs require uppercase variable names and string values up to 4000 characters; MAESTRO_ names are reserved.');
  return Object.fromEntries(entries);
}

function validate(yaml: string, flows: Record<string,string> = {}, ancestors: string[] = [], verified = new Set<string>(),unresolved?:string[]) {
  const documents = parseAllDocuments(yaml);
  if (documents.length !== 2 || documents.some(doc => doc.errors.length)) throw new Error('Invalid Maestro YAML: use an appId header, --- separator, and command list.');
  const config = documents[0].toJS();
  const commands = documents[1].toJS();
  rejectFileReferences(config, flows, ancestors, verified,unresolved);
  rejectFileReferences(commands, flows, ancestors, verified,unresolved);
  if (typeof config?.appId !== 'string' || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(config.appId) || !Array.isArray(commands) || !commands.length) throw new Error('Provide a literal installed appId and at least one Maestro command.');
  const steps: Step[] = commands.map((value, index) => {
    const command = typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value)[0] : undefined;
    if (!command) throw new Error('Each step must be a Maestro command.');
    return { id: `step-${index + 1}`, command, expected: command.startsWith('assert') ? value[command] : undefined, status: 'unavailable' };
  });
  return { appId: config.appId as string, steps };
}
function validateFlows(value: unknown,unresolved?:string[]): Record<string,string> | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 20) throw new Error('Provide up to 20 reusable YAML flows.');
  const entries = Object.entries(value);
  if (entries.some(([name,yaml]) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}\.yaml$/.test(name) || name === 'flow.yaml' || typeof yaml !== 'string' || Buffer.byteLength(yaml) > 100_000)) throw new Error('Reusable flow names must be simple .yaml filenames, with content up to 100 KB.');
  const flows = Object.fromEntries(entries) as Record<string,string>;
  for (const [name,yaml] of entries) validate(yaml as string, flows, [name],new Set(),unresolved);
  return flows;
}
function rejectFileReferences(value: unknown, flows: Record<string,string>, ancestors: string[], verified: Set<string>,unresolved?:string[]) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['runScript', 'addMedia', 'takeScreenshot', 'startRecording'].includes(key)) throw new Error('External file references and authored artifact paths are unsupported.');
    if (key === 'runFlow' && (typeof child === 'string' || (child && typeof child === 'object' && 'file' in child))) {
      const name = typeof child === 'string' ? child : (child as {file: unknown}).file;
      if (typeof name !== 'string'||! /^[A-Za-z][A-Za-z0-9_-]{0,63}\.yaml$/.test(name)||name==='flow.yaml')throw new Error('External file references require a simple declared reusable YAML flow.');
      if(!Object.hasOwn(flows,name)){if(!unresolved)throw new Error('External file references require a declared reusable YAML flow.');unresolved.push('Missing reusable flow: '+name);if(typeof child==='object'){const {file,...other}=child as Record<string,unknown>;rejectFileReferences(other,flows,ancestors,verified,unresolved);}continue;}
      if (ancestors.includes(name) || ancestors.length >= 10) throw new Error('Recursive or excessively nested reusable flow reference.');
      if (!verified.has(name)) { validate(flows[name],flows,[...ancestors,name],verified,unresolved); verified.add(name); }
      if (typeof child === 'object') { const {file, ...other} = child as Record<string,unknown>; rejectFileReferences(other,flows,ancestors,verified,unresolved); }
      continue;
    }
    if (key === 'file') throw new Error('External file references are unsupported outside declared runFlow calls.');
    rejectFileReferences(child, flows, ancestors, verified,unresolved);
  }
}
async function listFiles(base: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(base, prefix), { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? listFiles(base, prefix + entry.name + '/') : entry.isFile() ? [prefix + entry.name] : []))).flat();
}
function mapResults(run: Run, commands: any[],confidential:boolean) {
  const keys: Record<string, string> = { launchApp: 'launchAppCommand', assertVisible: 'assertConditionCommand', assertNotVisible: 'assertConditionCommand', tapOn: 'tapOnElement', inputText: 'inputTextCommand', back: 'backPressCommand', evalScript: 'evalScriptCommand', runFlow: 'runFlowCommand' };
  if(run.snapshot.executionPlan){
    const events=commands.filter(entry=>entry.metadata?.depth===0&&!entry.command?.defineVariablesCommand&&!entry.command?.applyConfigurationCommand);
    if(events.length>run.snapshot.executionPlan.length||events.some((entry,index)=>!entry.command?.[run.snapshot.executionPlan![index].kind==='reset'?'launchAppCommand':'runFlowCommand'])){run.mappingNote='Ambiguous instrumented metadata; step outcomes are unavailable.';return;}
    let stopped=false;
    run.snapshot.executionPlan.forEach((item,position)=>{
      const entry=events[position];
      if(item.kind==='step'&&item.index!==undefined){const step=run.steps[item.index];mapStepEvidence(run,step,commands,entry,stopped,confidential);if(step.status==='failed'||step.assertionStatus==='failed')stopped=true;}
      if(entry?.metadata?.status==='FAILED')stopped=true;
    });
    run.mappingNote='Authored steps mapped through generated top-level wrappers; setup and handler metadata reported separately. No checkpoints run inside reusable flows.';return;
  }
  const events = commands.filter(entry => entry.metadata?.depth === 0 && !entry.command?.defineVariablesCommand && !entry.command?.applyConfigurationCommand);
  if (events.length > run.steps.length || run.steps.some((step, index) => !keys[step.command] || (events[index] && !events[index].command?.[keys[step.command]]))) {
    run.mappingNote = 'Unsupported or ambiguous command mapping. Raw command metadata is available; step outcomes are unavailable.'; return;
  }
  let stopped=false;
  run.steps.forEach((step, index) => {mapStepEvidence(run,step,commands,events[index],stopped,confidential);if(step.status==='failed'||step.assertionStatus==='failed')stopped=true;});
  run.mappingNote = 'Top-level commands mapped in execution order using Maestro 2.11 command metadata. Nested/unmapped details remain in raw artifacts.';
}

function mapStepEvidence(run:Run,step:Step,commands:any[],entry:any,stopped:boolean,confidential:boolean){
  step.status=stopped?'skipped':metadataStatus(entry?.metadata?.status);
  step.assertionStatus=stopped?'skipped':assertionProof(commands,entry);
  const start=commands.indexOf(entry);let end=start+1;
  while(start>=0&&end<commands.length&&commands[end].metadata?.depth>entry.metadata.depth)end++;
  const subtree=stopped||start<0?[]:commands.slice(start,end);
  const failed=subtree.find(item=>item.metadata?.status==='FAILED');
  step.detail=stopped?'Not executed after an earlier failure.':confidential?'Evaluated detail withheld for confidential inputs.':failed?.metadata?.error?.message??(entry?'Runner command reported '+String(entry.metadata?.status??'no status')+'.':'Command evidence unavailable.');
  if(!confidential&&!stopped)step.actual=failed?.metadata?.evaluatedCommand??entry?.metadata?.evaluatedCommand;
  step.artifacts=confidential?[]:run.artifacts.filter(name=>subtree.some(item=>Number.isInteger(item.metadata?.sequenceNumber)&&name.split('/').at(-1)?.startsWith('step-'+String(item.metadata.sequenceNumber+1).padStart(3,'0')+'-')));
}

// A successful subflow wrapper is execution evidence, not proof that its assertions ran.
function assertionProof(commands:any[],entry:any):Step['status'] {
  if(!entry)return 'unavailable';
  const declared=(command:any):string[]=>{
    if(command?.assertConditionCommand)return [JSON.stringify(command.assertConditionCommand)];
    const children=command?.runFlowCommand?.commands??command?.repeatCommand?.commands??[];
    return children.flatMap((child:any)=>declared(child));
  };
  const expected=declared(entry.command);
  if(!expected.length)return 'unavailable';
  const start=commands.indexOf(entry);let end=start+1;
  while(end<commands.length&&commands[end].metadata?.depth>entry.metadata.depth)end++;
  const subtree=commands.slice(start,end);
  const assertions=subtree.filter(command=>command.command?.assertConditionCommand);
  if(assertions.some(command=>command.metadata?.status==='FAILED'))return 'failed';
  if(subtree.some(command=>command.metadata?.status==='SKIPPED'&&declared(command.command).length))return 'skipped';
  const expectedCounts=new Map<string,number>();for(const key of expected)expectedCounts.set(key,(expectedCounts.get(key)??0)+1);
  for(const [key,count] of expectedCounts){
    const observed=assertions.filter(command=>JSON.stringify(command.command.assertConditionCommand)===key);
    if(observed.length<count||observed.some(command=>command.metadata?.status!=='COMPLETED'))return 'unavailable';
  }
  return 'passed';
}
