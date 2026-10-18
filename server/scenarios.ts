import {protectRunEvidence,verifyEvidence,redact,removeRunEvidence,assertEvidenceRoot} from './run-script-evidence.js';
import {mapScriptResults} from './run-script-results.js';
import {EVIDENCE_SCRUB_FAILED,type ScriptRunResults} from './run-script-contract.js';
import type {EvidenceScrubber} from './run-script-evidence.js';
import {homedir} from 'node:os';
import {createScriptTrustStore,workspaceScripts} from './script-trust-store.js';
import {buildRunPlan,scriptExecutionYaml,canvasScriptAnchors,draftAnchorBlocks} from './run-script-plan.js';
import {ScriptBlocked} from './script-validation.js';
import {assertReservedInputs,assertAuthoredVariables,assertAutomationVariables} from './script-validation.js';
import {parsePackage,portableContent,packageReview,readOmittedValues,missingValues,type OmittedValue,type WorkspacePackage} from './workspace-package.js';
import {WorkspaceConflict,createWorkspaceStore,type WorkspaceMetadata,type WorkspaceStoreFaults} from './workspace-store.js';
import {createBatches} from './batches.js';
import {projectCanvasRoute} from './canvas-route.js';
import {refreshChecks,operationProblem,routeVisits} from '../shared/canvas-authoring.js';
import {readScenarios,selectScenario,validateFlowInputs,type ScenarioDefinition} from './scenario-definitions.js';
import {readAutomation,instrument,mapAutomation,metadataStatus,type Automation,type AutomationResult,type ExecutionItem} from './default-actions.js';
import { mkdir, readFile, writeFile, realpath, lstat, readdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { XMLParser } from 'fast-xml-parser';
import {readCanvas,referenceCatalog,inspectCanvas,selectedCanvasPath,mapCanvas,type CanvasGraph,type CanvasDiagnostic,type CanvasResult} from './canvas.js';
import { createMockSession, validateMock, type MockPlan, type MockResult } from './mockoon.js';
import type { createRunner } from './runner.js';

export type Workspace = { omittedValues?:OmittedValue[]; metadata?:WorkspaceMetadata; scenarios?:ScenarioDefinition[]; id: string; name: string; yaml: string; automation?:Automation; flows?: Record<string, string>; mock?: MockPlan; canvas?: CanvasGraph; canvasDiagnostics?: CanvasDiagnostic[] };
export type Step = { id: string; command: string; expected?: unknown; actual?:unknown; detail?:string; artifacts?:string[]; assertionStatus?:Step['status']; status: 'unavailable' | 'passed' | 'failed' | 'skipped' | 'not-run' };
export type Cleanup = { verified: boolean; detail: string };
export type Run = Partial<ScriptRunResults> & {
  id: string; deviceId: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'passed' | 'path-failed' | 'assertion-failed' | 'tool-error' | 'setup-error' | 'handler-error' | 'cancelled' | 'script-error' | 'error';
  automation?:AutomationResult;
  mock?: MockResult; canvas?: CanvasResult;
  snapshot: { scenario?:ScenarioDefinition; resetApp?:boolean; authoredYaml?:string; automation?:Automation; executionYaml?:string; executionPlan?:ExecutionItem[]; canvas?: CanvasGraph; canvasPathId?: string; flows?: Record<string, string>; mock?: MockPlan; expectedPath?: { from: string; to: string }; id: string; workspaceId: string; name: string; yaml: string; steps: Step[]; toolVersions: { maestro: string; node: string; mockoon?: string }; runtimeInputPolicy: string; pickerReference?: { captureId: string; reviewId: string; capturedAt: string } };
  steps: Step[]; log: string; error?: string; expectedFailure?: unknown;
  cleanup: Cleanup; artifacts: string[]; mappingNote: string;
};
export type RunInput = { workspaceId: string; deviceId: string; runtimeInputs?: unknown; captureId?: string; pickerReviewId?: string; pathId?: string; scenarioId?:string; resetApp?:boolean };
export type Maestro = {
  version(): Promise<string>;
  run(input: { directory: string; flow: string; deviceId: string; signal: AbortSignal; runtimeInputs?: Record<string, string>; scriptEnv?:Record<string,string>; scriptRun?:boolean }): Promise<{ code: number | null; log: string; stdout?:string; cleanup: Cleanup }>;
};
const validId = (id: string) => { if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid workspace/run identifier.'); return id; };

export function createScenarios(options: { root: string; runner: ReturnType<typeof createRunner>; maestro: Maestro; faults?: WorkspaceStoreFaults; now?: () => Date; trustDirectory?:string; trustFaults?:{beforeList?:()=>Promise<void>}; createMockSession?:typeof createMockSession; scrubber?:EvidenceScrubber; noteProcess?:(pid:number)=>Promise<void>|void; afterDuplicateRead?:()=>Promise<void>; afterTrustRead?:()=>Promise<void> }) {
  const trustStore=createScriptTrustStore(options.trustDirectory??join(homedir(),'Library','Application Support','TnT','script-trust'),options.trustFaults);
  const activeWorkspaces=new Set<string>();
  const deleting=new Set<string>();
  const pending = new Map<string, Promise<Run>>();
  const controllers = new Map<string, AbortController>();
  async function directory(kind: string, id: string) {
    const base = resolve(options.root, kind);
    await mkdir(base, { recursive: true });
    if((await lstat(base)).isSymbolicLink())throw new Error('Workspace path escapes its root.');
    if (!(await realpath(base)).startsWith((await realpath(options.root)) + sep)) throw new Error('Workspace path escapes its root.');
    const path = join(base, validId(id));
    await mkdir(path, { recursive: true });
    if((await lstat(path)).isSymbolicLink())throw new Error('Workspace path escapes its root.');
    if (!(await realpath(path)).startsWith((await realpath(base)) + sep)) throw new Error('Workspace path escapes its root.');
    return realpath(path);
  }
  function authoredWorkspace(input: {id?:string;name:string;yaml:string;flows?:Record<string,string>;mock?:unknown;canvas?:unknown;automation?:unknown;scenarios?:unknown;omittedValues?:unknown},unresolved?:string[]):Workspace {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120 || typeof input.yaml !== 'string' || Buffer.byteLength(input.yaml) > 100_000) throw new Error('Provide a workspace title and YAML up to 100 KB.');
      assertAuthoredVariables(input.yaml);
      assertAutomationVariables(input.automation);
      assertAutomationVariables(input.scenarios);
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
  async function closeScriptUndo(workspace:Workspace,id:string){
    try{await trustStore.closeScenario(workspace,id);}
    catch{/* Retain provenance on cleanup failure; navigation remains usable and script trust still fails closed. */}
  }
  const workspaceStore=createWorkspaceStore(options.root,input=>authoredWorkspace(input,[]),{faults:options.faults,now:options.now,beforePublish:(next,previous)=>trustStore.register(next,previous),onScenarioClosed:closeScriptUndo});
  const service = {
    async scriptTrust(id:string){const workspace=await workspaceStore.read(id);return {scripts:await trustStore.list(workspace),...sourceContext(workspace)};},
    async trustScript(input:{workspace:string;rowId:string;hash:string}){
      if(!input||Object.keys(input).some(key=>!['workspace','rowId','hash'].includes(key))||typeof input.rowId!=='string'||typeof input.hash!=='string')throw new Error('Trust exactly one script by workspace, rowId and current source hash.');
      return workspaceStore.withWorkspace(input.workspace,async workspace=>({trust:await trustStore.approve(workspace,input.rowId,input.hash),...sourceContext(workspace)}));
    },
    async preview(input:{yaml:string;flows?:Record<string,string>;automation?:unknown;canvas?:unknown;mock?:unknown;scenarios?:unknown;scenarioId?:string;pathId?:string;runtimeInputs?:unknown;resetApp?:boolean}) {
      if(typeof input.yaml!=='string'||Buffer.byteLength(input.yaml)>100_000)throw new Error('Provide YAML up to 100 KB.');
      const flows=validateFlows(input.flows);
      if(input.resetApp!==undefined&&typeof input.resetApp!=='boolean')throw new Error('Reset app must be a boolean.');
      assertAuthoredVariables(input.yaml);assertAutomationVariables(input.automation);assertAutomationVariables(input.scenarios);
      const configured=readAutomation(input.automation,flows??{},input.yaml);
      const selection=selectScenario({yaml:input.yaml,flows,automation:configured,canvas:readCanvas(input.canvas),mock:validateMock(input.mock),scenarios:readScenarios(input.scenarios)},input.scenarioId,validateInputs(input.runtimeInputs));
      let yaml=selection?.yaml??input.yaml;let automation=selection?.automation??configured;
      const rawCanvas=selection?.canvas??readCanvas(input.canvas);
      if(rawCanvas){const canvas=refreshChecks(rawCanvas,yaml);const pathId=selection?.scenario.pathId??input.pathId;const draftBlocked=draftAnchorBlocks(selection?.scenario.scripts,canvas,pathId);if(draftBlocked.length)throw new ScriptBlocked(draftBlocked);const projection=projectCanvasRoute(canvas,yaml,flows??{},pathId,automation);yaml=projection.yaml;automation=projection.automation;selectedCanvasPath(projection.canvas,yaml,flows??{},pathId,automation);}
      const root=validate(yaml,flows,[],new Set(),undefined,!!selection?.scenario.scripts?.length);
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
    async duplicateScenario(input:{workspaceId:string;scenarioId:string;expectedRevision:number}){
      const assertIdle=()=>{if(activeWorkspaces.has(input.workspaceId)||batches.activeWorkspaceId===input.workspaceId)throw new Error('Active execution blocks duplication in this workspace. Wait for execution and cleanup; no run was cancelled.');};
      assertIdle();
      const workspace=await workspaceStore.read(input.workspaceId);
      assertIdle();
      await options.afterDuplicateRead?.();
      if(workspace.metadata!.revision!==input.expectedRevision)throw new WorkspaceConflict();
      const source=workspace.scenarios?.find(scenario=>scenario.id===input.scenarioId);
      if(!source)throw new Error('Unknown scenario.');
      const id='scenario-'+randomUUID();const name=(source.name+' copy').slice(0,120);
      const original=workspace.canvas?.paths.find(path=>path.id===source.pathId);
      const pathId=original?'sequence-'+randomUUID():undefined;
      const copy={...structuredClone(source),id,name,pathId,scripts:source.scripts?.map(row=>({...structuredClone(row),id:'script-'+randomUUID()}))};
      const sourceTrust=await trustStore.list(workspace);
      const origins=Object.fromEntries(copy.scripts?.map((row,index)=>[row.id,sourceTrust.find(trust=>trust.rowId===source.scripts![index].id)?.origin??'imported'])??[]);
      assertIdle();
      await options.afterTrustRead?.();
      const canvas=workspace.canvas&&structuredClone(workspace.canvas);
      if(canvas){
        for(const screen of canvas.screens)for(const test of screen.tests)if(test.scenarioIds?.includes(source.id))test.scenarioIds.push(id);
        if(original)canvas.paths.push({...structuredClone(original),id:pathId!,scenarioId:id,name,visits:routeVisits(workspace.canvas!,original).map(visit=>({...structuredClone(visit),id:randomUUID()}))});
      }
      return workspaceStore.save(authoredWorkspace({...workspace,canvas,scenarios:[...workspace.scenarios!,copy]}),input.expectedRevision,undefined,(next,previous)=>trustStore.register(next,previous,origins));
    },
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
    async copyWorkspace(input:Parameters<typeof authoredWorkspace>[0]&{sourceWorkspaceId?:string}){
      const content=authoredWorkspace({...input,id:undefined});
      const incomplete=content.canvas?.screens.flatMap(screen=>screen.tests).find(test=>operationProblem(test));if(incomplete)throw new Error('Repair incomplete canvas content before copying. '+operationProblem(incomplete));
      validate(content.yaml,content.flows,[],new Set(),undefined,workspaceScripts(content).length>0);
      for(const flow of Object.values(content.flows??{}))validate(flow,content.flows);
      const sourceId=input.sourceWorkspaceId??input.id;
      let source:Workspace|undefined;
      if(sourceId)try{source=await workspaceStore.read(sourceId);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const sourceTrust=source?await trustStore.list(source):[];
      const origins=Object.fromEntries(workspaceScripts(content).map(row=>{const trust=sourceTrust.find(item=>item.rowId===row.id);const original=source&&workspaceScripts(source).find(item=>item.id===row.id);return [row.id,trust?.origin==='local'&&original?.source===row.source?'local' as const:'imported' as const];}));
      return workspaceStore.importCopy(content,next=>trustStore.register(next,undefined,origins),source?{kind:'copy',name:source.name}:undefined);
    },
    async exportWorkspace(input:{id:string;expectedRevision:number;includeValues?:boolean}){
      if(input.includeValues!==undefined&&typeof input.includeValues!=='boolean')throw new Error('Include values must be a boolean.');
      const workspace=await workspaceStore.read(input.id);
      if(workspace.metadata!.revision!==input.expectedRevision)throw new WorkspaceConflict();
      const incomplete=workspace.canvas?.screens.flatMap(screen=>screen.tests).find(test=>operationProblem(test));
      if(incomplete)throw new Error('Repair incomplete authored content before export. '+operationProblem(incomplete));
      validate(workspace.yaml,workspace.flows,[],new Set(),undefined,workspaceScripts(workspace).length>0);
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
      validate(content.yaml,content.flows,[],new Set(),missing,workspaceScripts(content).length>0);
      if(!content.scenarios?.length)try{await service.preview(content);}catch(error){missing.push(error instanceof Error?error.message:'Repair missing YAML inputs.');}
      for(const scenario of content.scenarios??[])try{await service.preview({...content,scenarioId:scenario.id});}catch(error){missing.push(scenario.name+': '+(error instanceof Error?error.message:'Repair scenario.'));}
      const review=packageReview(content,[...missing,...(content.canvasDiagnostics??[]).map(item=>item.detail??`${item.code}:${item.actionId}`)]);
      return {package:{...pkg,dependencies:review.dependencies,workspace:portableContent(content,true)},review};
    },
    async importWorkspace(input:{package:unknown;name:string;filename?:string}){
      const reviewed=await service.reviewWorkspacePackage(input);
      return workspaceStore.importCopy(authoredWorkspace({...reviewed.package.workspace,name:input.name,id:undefined},[]),next=>trustStore.register(next,undefined,Object.fromEntries(workspaceScripts(next).map(row=>[row.id,'imported' as const]))),{kind:'import',name:reviewed.package.workspace.name,filename:input.filename??null});
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
      assertAuthoredVariables(authored.yaml);assertAutomationVariables(authored.automation);assertAutomationVariables(authored.scenarios);
      const scriptTrust=await trustStore.list({id:authored.id,scenarios:authored.scenarios?.filter(scenario=>scenario.id===input.scenarioId)});
      const selection=selectScenario(authored,input.scenarioId,runtimeInputs,scriptTrust);
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
      const draftBlocked=draftAnchorBlocks(selection?.scenario.scripts,canvas,selectedPathId);
      if(draftBlocked.length)throw new ScriptBlocked(draftBlocked);
      if(canvas){const projection=projectCanvasRoute(canvas,workspace.yaml,workspace.flows??{},selectedPathId,automation);canvas=projection.canvas;workspace={...workspace,yaml:projection.yaml};automation=projection.automation;}
      const canvasPath=canvas?selectedCanvasPath(canvas,workspace.yaml,workspace.flows??{},selectedPathId,automation):undefined;
      const { appId, steps } = validate(workspace.yaml, workspace.flows,[],new Set(),undefined,!!selection?.scenario.scripts?.length);
      const derived=automation?instrument(workspace.yaml,automation,resetApp):undefined;
      validateFlowInputs(derived?.yaml??workspace.yaml,workspace.flows??{},selection?.inputs??runtimeInputs);
      for (const flow of Object.values(workspace.flows ?? {})) { if (validate(flow, workspace.flows).appId !== appId) throw new Error('Reusable flows must declare the same appId as the scenario.'); }
      if ((input.captureId === undefined) !== (input.pickerReviewId === undefined)) throw new Error('Provide both capture and reviewed step identity.');
      // PR B anchors count canvas operations, excluding synthetic/unassociated commands such as launchApp.
      const anchorSteps=selection?.scenario.authoring==='canvas'?canvasScriptAnchors(canvas?.execution):undefined;
      const scriptPlan=buildRunPlan({yaml:workspace.yaml,flows:workspace.flows,scripts:selection?.scenario.scripts,trust:scriptTrust,anchorSteps,automation:derived,mockAvailable:!!workspace.mock});
      if(scriptPlan.blocked.length)throw new ScriptBlocked(scriptPlan.blocked);
      if(scriptPlan.scriptFiles.length)validateFlowInputs(scriptPlan.executionYaml,workspace.flows??{},selection?.inputs??runtimeInputs,[],true);
      const hasScripts=scriptPlan.scriptFiles.length>0;
      // Keep protected evidence mappers on projected commands, but publish only authored operations.
      const authoredSteps=(projected:Step[])=>anchorSteps?anchorSteps.map((ref,index)=>({...projected[ref.index],id:'step-'+(index+1)})):projected;
      const authoredCanvas=(result:CanvasResult|undefined)=>{
        if(hasScripts&&anchorSteps&&result){
          const stepIds=new Map(anchorSteps.map((ref,index)=>['step-'+(ref.index+1),'step-'+(index+1)]));
          for(const item of [...result.tests,...result.occurrences??[]])if(item.stepId)item.stepId=stepIds.get(item.stepId);
        }
        return result;
      };
      const startMock=!!workspace.mock&&(!selection||!!selection.scenario.mockResponseId||hasScripts);
      const executionYaml=hasScripts?scriptPlan.executionYaml:derived?.yaml;
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
        const snapshot = { scenario:selection?.scenario, resetApp, authoredYaml:selection||canvas?authored.yaml:undefined, automation, executionYaml, executionPlan:derived?.plan, canvas, canvasPathId: canvasPath?.id, flows: workspace.flows, mock: workspace.mock, expectedPath: workspace.mock ? { from: workspace.mock.fromScreen, to: workspace.mock.toScreen } : undefined, id: createHash('sha256').update(JSON.stringify({ workspace, derived, steps, version, device, scenarioId:selection?.scenario.id,resetApp,pathId:canvasPath?.id, runtimeInputPolicy, pickerReference, node: process.version })).digest('hex'), workspaceId: workspace.id, name: workspace.name, yaml: workspace.yaml, steps, toolVersions: { maestro: version, node: process.version, mockoon: workspace.mock ? '9.9.0' : undefined }, runtimeInputPolicy, pickerReference };
        if(hasScripts)snapshot.steps=authoredSteps(steps);
        const run: Run = { id, deviceId: device.id, startedAt: new Date().toISOString(), status: 'running', canvas:authoredCanvas(canvas&&canvasPath?mapCanvas(canvas,canvasPath.id,workspace.yaml,steps,true,automation?{definition:automation,flows:workspace.flows}:undefined):undefined), snapshot, steps: structuredClone(snapshot.steps), log: '', cleanup: { verified: false, detail: 'Pending' }, artifacts: [], mappingNote: 'Command outcomes will be mapped after execution; unsupported details remain unavailable.' };
        if(hasScripts){run.scriptSteps=Object.fromEntries(scriptPlan.scriptFiles.map(file=>[file.rowId,{kind:'runScript',rowId:file.rowId,status:'not-run'}]));run.executionOrder=scriptPlan.executionOrder;}
        await writeFile(join(path, 'flow.yaml'), workspace.yaml);
        if(executionYaml)await writeFile(join(path,'.tnt-execution.yaml'),executionYaml,{mode:0o600});
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
          let token:string|undefined;
          let execution:Awaited<ReturnType<Maestro['run']>>|undefined;
          let phase: 'setup' | 'execution' = 'setup';
          run.cleanup = { verified: true, detail: 'No tool process allocated yet.' };
          const scriptPaths:string[]=[];
          let mappedProjected=false;
          try {
            if (confidential) {
              const privateRoot = join(options.root, 'private');
              await mkdir(privateRoot, { recursive: true, mode: 0o700 });
              privateDirectory = await realpath(await mkdtemp(join(privateRoot, id + '-')));
            }
            const executionDirectory = privateDirectory ?? path;
            if (privateDirectory) {await writeFile(join(executionDirectory, 'flow.yaml'), workspace.yaml);if(executionYaml)await writeFile(join(executionDirectory,'.tnt-execution.yaml'),executionYaml,{mode:0o600});}
            for (const [name, yaml] of Object.entries(workspace.flows ?? {})) await writeFile(join(executionDirectory, name), yaml);
            for(const file of scriptPlan.scriptFiles){const name=join(executionDirectory,file.name);scriptPaths.push(name);await writeFile(name,file.content,{mode:0o600});}
            let scriptEnv:Record<string,string>|undefined;
            if (startMock&&workspace.mock) {
              mock = (options.createMockSession??createMockSession)(workspace.mock, executionDirectory,{overrideResponse:selection?!!selection.scenario.mockResponseId:true,...options.noteProcess?{noteProcess:options.noteProcess}:{}});
              const access=mock.scriptAccess();token=access.token;
              if(hasScripts)scriptEnv={TNT_MOCK_URL:access.url,TNT_MOCK_TOKEN:access.token};
              run.mock = mock.result;
              await mock.prepare(controller.signal);
            }
            if (controller.signal.aborted) throw new Error('Run cancelled before execution.');
            if(scriptEnv)await writeFile(join(executionDirectory,'.tnt-execution.yaml'),scriptExecutionYaml(scriptPlan,scriptEnv),{mode:0o600});
            phase = 'execution';
            execution = await options.maestro.run({ directory: executionDirectory, flow: join(executionDirectory, executionYaml?'.tnt-execution.yaml':'flow.yaml'), deviceId: device.id, signal: controller.signal, runtimeInputs:selection?.inputs??runtimeInputs,scriptRun:hasScripts,...(scriptEnv?{scriptEnv}:{}) });
            run.log = confidential ? 'Raw logs withheld because confidential runtime inputs were supplied.' : execution.log;
            run.cleanup = execution.cleanup;
          } catch (error) {
            run.status = controller.signal.aborted ? 'cancelled' : phase === 'setup' ? 'setup-error' : 'tool-error';
            run.error = confidential ? 'Tool execution failed. Detail withheld for confidential inputs.' : error instanceof Error ? error.message : 'Tool execution failed.';
            if (mock && phase === 'setup') mock.result.intent.status = 'failed';
            if (phase === 'execution') run.cleanup = { verified: false, detail: 'Tool adapter failed; cleanup could not be verified.' };
          } finally {
            // Stop all writers first. Capture and cleanup exceptions must not bypass the scrub.
            if (mock) {
              try{await mock.evidence(confidential);}catch{run.status='tool-error';run.error='Mock evidence capture failed.';}
              try{const cleaned=await mock.cleanup();run.cleanup={verified:run.cleanup.verified&&cleaned.verified,detail:run.cleanup.detail+' '+cleaned.detail};}
              catch{run.cleanup={verified:false,detail:'Mock cleanup could not be verified; device ownership retained.'};run.status='tool-error';run.error='Mock cleanup failed.';}
            }
            const directories=privateDirectory?[path,privateDirectory]:[path];
            try{
              const protection=await protectRunEvidence({directories,token,value:{run,execution},scriptFiles:scriptPaths},options.scrubber);
              if(!protection.ok){
                // Reconstruct from known-safe data only; the injected scrubber and tool errors are untrusted.
                const safe:Run={id,deviceId:device.id,startedAt:run.startedAt,finishedAt:new Date().toISOString(),status:'error',error:EVIDENCE_SCRUB_FAILED,
                  snapshot:{id:'evidence-removed',workspaceId:authored.id,name:'Evidence removed',yaml:'',steps:[],toolVersions:{maestro:version,node:process.version},runtimeInputPolicy:'Evidence scrub failed'},
                  steps:[],log:'',artifacts:[],mappingNote:'Evidence removed to protect the token.',cleanup:{verified:run.cleanup.verified&&protection.removed,detail:protection.removed?'Unsafe evidence removed.':'Evidence removal could not be verified; ownership retained.'}};
                Object.keys(run).forEach(key=>delete (run as any)[key]);Object.assign(run,safe);
                // Include identifiers in the independent check too; no partially safe record is written.
                await verifyEvidence({directories:[],token,value:run});
              }else{
                Object.assign(run,protection.value.run);execution=protection.value.execution;
                if(!run.cleanup.verified){run.artifacts=[];if(run.status==='running')run.status='tool-error';run.error??='Owned-process cleanup is unverified; device reuse blocked.';}
                else if(execution){
                  const executionDirectory=privateDirectory??path;
                  const allFiles=await listFiles(executionDirectory);
                  const files=allFiles.filter(file=>isRunArtifact(file,workspace.flows));
                  run.artifacts=confidential?['flow.yaml','snapshot.json']:files.filter(file=>file!=='result.json'&&file!=='mock-environment.json');
                  // Maestro 2.11 emits a per-flow commands JSON under its debug output directory.
                  const commandFile=allFiles.find(file=>/(?:^|\/)commands(?:-[^/]*)?\.json$/.test(file));
                  const commands=commandFile?JSON.parse(await readFile(join(executionDirectory,commandFile),'utf8')):[];
                  const scripts=hasScripts?mapScriptResults(scriptPlan,commands,run.log,confidential):undefined;
                  const authoredCommands=scripts?.commands??commands;
                  run.steps=structuredClone(steps);
                  mappedProjected=true;
                  mapResults(run,authoredCommands,confidential);
                  if(scripts){run.scriptSteps=scripts.scriptSteps;for(const index of scripts.notRunIndexes){run.steps[index].status='not-run';run.steps[index].assertionStatus='not-run';run.steps[index].detail='Not executed after an earlier failure.';delete run.steps[index].actual;}}
                  const automationMapping=automation&&derived?mapAutomation(automation,derived.plan,authoredCommands):undefined;
                  run.automation=automationMapping?.result;
                  let report:any;
                  try{report=new XMLParser({ignoreAttributes:false}).parse(await readFile(join(executionDirectory,'report.xml'),'utf8'));}catch{/* Missing report never passes. */}
                  const suite=report?.testsuites?.testsuite;
                  const failedAssertion=commands.find((entry:any)=>entry.metadata?.status==='FAILED'&&entry.command?.assertConditionCommand);
                  // Preserve earlier cleanup/capture failures instead of overwriting them with a passing report.
                  if(run.status==='running'){
                    run.status=controller.signal.aborted?'cancelled':execution.code===124?'tool-error':scripts?.failure!==undefined?'script-error':execution.code===0&&Number(suite?.['@_tests'])===1&&Number(suite?.['@_failures'])===0&&!scripts?.ambiguous&&(!scripts||Object.values(scripts.scriptSteps).every(item=>item.status==='passed'))?'passed':failedAssertion?'assertion-failed':'tool-error';
                    if(scripts?.failure!==undefined)run.error=scripts.failure;
                    if(automationMapping?.failedPhase){run.status=controller.signal.aborted?'cancelled':automationMapping.failedPhase==='setup'?'setup-error':'handler-error';run.error=automationMapping.failedPhase==='setup'?'Independent setup failed; dependent authored steps did not run.':'Default action failed; dependent authored steps did not run.';}
                    if(failedAssertion&&run.status==='assertion-failed'){run.error=confidential?'Assertion failed. Evaluated detail withheld for confidential inputs.':failedAssertion.metadata.error?.message;run.expectedFailure=confidential?run.steps.find(step=>step.status==='failed')?.expected:failedAssertion.command.assertConditionCommand.condition;}
                    else if(run.status==='tool-error')run.error=execution.code===124?'Run stopped at 300s cap':scripts?.toolFailure??'Maestro did not report a successful scenario or a structured assertion failure. Inspect raw logs.';
                  }
                }
                if(canvas&&canvasPath){
                  run.canvas=mapCanvas(canvas,canvasPath.id,workspace.yaml,run.steps,false,automation?{definition:automation,result:run.automation,flows:workspace.flows}:undefined);
                  if(run.status==='passed'&&(run.canvas.edges.some(edge=>canvasPath.edgeIds.includes(edge.id)&&edge.status!=='passed')||!!canvasPath.screenId&&run.canvas.screens.find(screen=>screen.id===canvasPath.screenId)?.status!=='passed')){run.status='path-failed';run.error='The selected scenario path was not verified: a required action or destination assertion did not report passed. No alternate route was followed.';}
                }
                if(hasScripts){
                  if(mappedProjected)run.steps=authoredSteps(run.steps);
                  if(mappedProjected)run.canvas=authoredCanvas(run.canvas);
                }
                await verifyEvidence({directories:[],token,value:run});
              }
            }catch{
              run.status='error';run.error=EVIDENCE_SCRUB_FAILED;run.log='';run.artifacts=[];run.steps=[];delete run.mock;delete run.canvas;delete run.automation;delete run.scriptSteps;delete run.expectedFailure;
              run.snapshot={id:'evidence-removed',workspaceId:authored.id,name:'Evidence removed',yaml:'',steps:[],toolVersions:{maestro:version,node:process.version},runtimeInputPolicy:'Evidence scrub failed'};
              const removed=await removeRunEvidence(directories);
              if(!removed)run.cleanup={verified:false,detail:'Unsafe evidence removal unverified; ownership retained.'};
              run.cleanup.detail=redact(run.cleanup.detail,token);
            }finally{
              if(privateDirectory)try{if(!await removeRunEvidence([privateDirectory]))throw new Error('Private root changed.');await rm(privateDirectory,{recursive:true,force:true});run.cleanup.detail+=' Confidential temporary artifacts removed.';}catch{run.cleanup={verified:false,detail:'Confidential temporary artifact removal could not be verified.'};run.artifacts=[];}
              run.finishedAt=new Date().toISOString();
              try{await verifyEvidence({directories:[],token,value:run});await assertEvidenceRoot(path);await writeRecord(join(path,'result.json'),run);}
              finally{signal?.removeEventListener('abort',abort);controllers.delete(id);if(run.cleanup.verified)await release();}
            }
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
function sourceContext(workspace:Workspace){return workspace.metadata?.sourceWorkspace?{sourceWorkspace:workspace.metadata.sourceWorkspace}:{};}
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
  assertReservedInputs(value);
  const entries = Object.entries(value);
  if (entries.some(([key, input]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || key.startsWith('MAESTRO_') || typeof input !== 'string' || input.length > 4000 || input.includes('\0'))) throw new Error('Runtime inputs require uppercase variable names and string values up to 4000 characters; MAESTRO_ names are reserved.');
  return Object.fromEntries(entries);
}

function validate(yaml: string, flows: Record<string,string> = {}, ancestors: string[] = [], verified = new Set<string>(),unresolved?:string[],allowEmpty=false) {
  assertAuthoredVariables(yaml);
  const documents = parseAllDocuments(yaml);
  if (documents.length !== 2 || documents.some(doc => doc.errors.length)) throw new Error('Invalid Maestro YAML: use an appId header, --- separator, and command list.');
  const config = documents[0].toJS();
  const commands = documents[1].toJS();
  rejectFileReferences(config, flows, ancestors, verified,unresolved);
  rejectFileReferences(commands, flows, ancestors, verified,unresolved);
  if (typeof config?.appId !== 'string' || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(config.appId) || !Array.isArray(commands) || (!commands.length&&!allowEmpty)) throw new Error('Provide a literal installed appId and at least one Maestro command.');
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
  assertReservedInputs(value);
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
function isRunArtifact(file:string,flows:Record<string,string>={}){
  // Maestro nests generated-flow evidence under the known .tnt-execution directory.
  // Its .maestro history, homes, downloads and other hidden trees are never evidence.
  if(file!=='.tnt-execution.yaml'&&file.split('/').some(part=>part.startsWith('.')&&!(file.startsWith('raw/')&&part==='.tnt-execution')))return false;
  if(['flow.yaml','snapshot.json','report.xml','maestro.log','.tnt-execution.yaml',...Object.keys(flows)].includes(file))return true;
  if(/^commands(?:-[^/]*)?\.json$/.test(file))return true;
  if(/^(?:step-|screenshot|failure|screen)[^/]*\.png$/.test(file.split('/').at(-1)!))return !file.includes('/')||file.startsWith('raw/');
  return file.startsWith('raw/')&&/^(?:commands(?:-[^/]*)?\.json|maestro\.log|report\.xml)$/.test(file.split('/').at(-1)!);
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
