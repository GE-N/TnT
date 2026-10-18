import {missingValues} from '../shared/workspace-values.js';
import {WorkspaceManager,type WorkspaceAction} from './workspace-manager.js';
import {RecoveredFields,WorkspaceDrafts,type DraftReport} from './workspace-drafts.js';
import {ScenarioSidebar} from './scenario-sidebar.js';
import type {Batch} from '../server/batches.js';
import {canvasTestLabel,operationProblem} from '../shared/canvas-authoring.js';
import {ExecutedCanvas} from './executed-canvas.js';
import {ScenarioLibrary} from './scenario-library.js';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';
import {DefaultActions} from './default-actions.js';
import type {Automation} from '../server/default-actions.js';
import {canvasAfterDeletion,restoreDeletionReferences} from './yaml-forms.js';
import {YamlDraftProvider,YamlEditor} from './yaml-editor.js';
import { runnerClient,RunnerRequestError } from './runner-client.js';
import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Run, Workspace } from '../server/scenarios.js';
import type {WorkspaceDraft} from '../server/workspace-store.js';
import {CanvasEditor,emptyCanvas} from './canvas.js';
import type {CanvasGraph,CanvasDiagnostic,CatalogEntry} from '../server/canvas.js';
import { MockSetup } from './mock-setup.js';
import type { MockPlan } from '../server/mockoon.js';
import { parseAllDocuments } from 'yaml';
import {approveScriptTrust,pullScriptTrust} from './run-script-client.js';
import {batchReasonLabel,batchSummary,batchWithScriptBlocks,blocksFor,evidenceScrubFailed,moveScript,newScriptId,orderedScenarioSteps,readScriptRun,recordsFor,reservedPlacements,runHitCap,scenarioShowsMockVariables,untrustedCount,type BatchLine} from './run-script.js';
import type {RunScriptModel} from './run-script-ui.js';
import {RedactedText} from './run-script-ui.js';
import type {ScriptBlockReason,ScriptRow,ScriptTrust} from '../server/run-script-contract.js';

export function Scenarios({ token, deviceId, bundleId, launchBusy, onRunning, recoverSession=false, simulatorConnected=!!deviceId&&!!token }: { token: string; deviceId: string; bundleId: string; launchBusy: boolean; onRunning: (running: boolean) => void; recoverSession?: boolean; simulatorConnected?: boolean }) {
  simulatorConnected=simulatorConnected&&!!deviceId&&!!token;
  const [definitions,setDefinitions]=useState<ScenarioDefinition[]>([]);
  const [scenarioId,setScenarioId]=useState('');
  const [deletedScenario,setDeletedScenario]=useState<{name:string;restore:()=>void}>();
  const [definitionError,setDefinitionError]=useState('');
  const [resetApp,setResetApp]=useState(false);
  const selectedScenario=definitions.find(item=>item.id===scenarioId);
  const [name, setName] = useState('Untitled workspace');
  const [yaml, setYaml] = useState('appId: com.example.HybridApp\n---\n- launchApp\n');
  const [loadedMock,setLoadedMock]=useState<MockPlan>();
  const [loadRevision,setLoadRevision]=useState(0);
  const [canvas,setCanvas]=useState<CanvasGraph|undefined>(emptyCanvas);
  const [pathId,setPathId]=useState('');
  const [legacyCanvas,setLegacyCanvas]=useState(false);
  const [catalog,setCatalog]=useState<CatalogEntry[]>([]);
  const [canvasDiagnostics,setCanvasDiagnostics]=useState<CanvasDiagnostic[]>([]);
  const [mock,setMock]=useState<MockPlan>();
  const [mockError,setMockError]=useState('');
  const [flows,setFlows]=useState('{}');
  const [automation,setAutomation]=useState<Automation>();
  const [automationError,setAutomationError]=useState('');
  const [preview,setPreview]=useState<{source:string;yaml:string}>();
  const [expectedPage,setExpectedPage]=useState('');
  const setMockPlan=useCallback((plan:MockPlan|undefined,error:string)=>{setMock(plan);setMockError(error);},[]);
  const [noWorkspace,setNoWorkspace]=useState(false);
  const [scriptTrust,setScriptTrust]=useState<ScriptTrust[]>([]);
  const [scriptSourceName,setScriptSourceName]=useState('');
  const [revealBlocks,setRevealBlocks]=useState(false);
  const [reservedVisible,setReservedVisible]=useState(false);
  const [workspaceId, setWorkspaceId] = useState('');
  const [inputs, setInputs] = useState('');
  const [sourceRepair,setSourceRepair]=useState<{ownerId:string}>();
  const advanced=useRef<HTMLDetailsElement>(null);
  const [run, setRun] = useState<Run>();
  const [batch,setBatch]=useState<Batch>();
  const [reports,setReports]=useState<Run[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [error, setError] = useState('');
  const [runError,setRunError]=useState('');
  const [artifact, setArtifact] = useState<{ name: string; text?: string; image?: string }>();
  const artifactSequence = useRef(0);
  const batchRunning=batch?.status==='running'||batch?.status==='cancelling';
  const running = run?.status === 'running'||batchRunning;
  useEffect(() => { onRunning(running || submitting || pickerBusy); }, [running, submitting, pickerBusy, onRunning]);
  const [acknowledged,setAcknowledged]=useState('');
  const [saveFailed,setSaveFailed]=useState(false);
  const [saving,setSaving]=useState(false);
  const [saveProblem,setSaveProblem]=useState('');
  const [conflict,setConflict]=useState(false);const conflictRef=useRef(false);conflictRef.current=conflict;
  const [retrySave,setRetrySave]=useState(0);
  const persistence=useRef({id:'',revision:0,draftRevision:0,epoch:0});
  const saveQueue=useRef<Promise<unknown>>(Promise.resolve());
  const failedKey=useRef('');
  const failedDraftKey=useRef('');
  const lastValid=useRef<Workspace|undefined>(undefined);
  const viewRef=useRef<Record<string,unknown>>({format:1});
  const draftRecord=useRef<WorkspaceDraft|null>(null);
  const latestDraftKey=useRef('');
  const warnOnLeaveRef=useRef(false);
  const fieldsRef=useRef(new Map<string,DraftReport>());
  const sessionOnce=useRef(false);
  const [drafts,setDrafts]=useState<string[]>([]);
  const [fieldEpoch,setFieldEpoch]=useState(0);
  const [viewTick,setViewTick]=useState(0);
  const [recoveredFields,setRecoveredFields]=useState<Record<string,string>>({});
  const [draftSavedAt,setDraftSavedAt]=useState('');
  const [draftBase,setDraftBase]=useState(0);
  const [draftRevisionShown,setDraftRevisionShown]=useState(0);
  const [dismissedDraft,setDismissedDraft]=useState(0);
  const [savedRevision,setSavedRevision]=useState(0);
  useEffect(()=>{
    if(!workspaceId||!token){setScriptTrust([]);return;}
    let cancelled=false;
    pullScriptTrust(workspaceId,token).then(list=>{if(!cancelled)setScriptTrust(list);}).catch(()=>{if(!cancelled)setScriptTrust([]);});
    return ()=>{cancelled=true;};
  },[workspaceId,token,savedRevision]);
  const [draftError,setDraftError]=useState('');
  const [draftFailed,setDraftFailed]=useState(false);
  const [draftSaving,setDraftSaving]=useState(false);
  const [acknowledgedDraftKey,setAcknowledgedDraftKey]=useState('');
  const [scenarioNotice,setScenarioNotice]=useState('');
  const [conflictBar,setConflictBar]=useState(false);
  const [chooserNotice,setChooserNotice]=useState('');
  const [chooserSignal,setChooserSignal]=useState(0);
  const [confirmCorrupt,setConfirmCorrupt]=useState(false);
  const discardDraftButton=useRef<HTMLButtonElement>(null);
  const corruptCancelButton=useRef<HTMLButtonElement>(null);
  const corruptConfirmOpen=useRef(false);
  useEffect(()=>{if(confirmCorrupt)corruptCancelButton.current?.focus();else if(corruptConfirmOpen.current)discardDraftButton.current?.focus();corruptConfirmOpen.current=confirmCorrupt;},[confirmCorrupt,draftError]);
  const reportDraft=useCallback((id:string,report:DraftReport)=>{
    const previous=fieldsRef.current.get(id);
    const same=!!previous&&previous.pending===report.pending&&previous.key===report.key&&previous.value===report.value;
    if(!report.pending&&!previous)return;
    if(report.pending){if(!same)fieldsRef.current.delete(id);fieldsRef.current.set(id,report);}else fieldsRef.current.delete(id);
    setDrafts(current=>report.pending?(current.includes(id)?current:[...current,id]):current.filter(item=>item!==id));
    if(!same)setFieldEpoch(value=>value+1);
  },[]);
  const contentKey=(value:{name:string;yaml:string;flows?:unknown;mock?:unknown;canvas?:unknown;automation?:unknown;scenarios?:unknown})=>JSON.stringify({name:value.name,yaml:value.yaml,flows:value.flows??{},mock:value.mock,canvas:value.canvas,automation:value.automation,scenarios:value.scenarios??[]});
  let parsedFlows:unknown;try{parsedFlows=JSON.parse(flows);}catch{parsedFlows=flows;}
  const authoredContent={name,yaml,flows:parsedFlows,mock,canvas,automation,scenarios:definitions};
  const reviewedContent=(overrides:Partial<Pick<Workspace,'name'|'yaml'>>={})=>({...authoredContent,omittedValues:lastValid.current?.omittedValues,flows:JSON.parse(flows),...overrides});
  const currentKey=contentKey(authoredContent);
  const initialKey=useRef(currentKey);
  const latestKey=useRef(currentKey);latestKey.current=currentKey;
  const yamlDocuments=parseAllDocuments(yaml);
  let invalidSource=true;
  try{invalidSource=yamlDocuments.length!==2||yamlDocuments.some(doc=>doc.errors.length)||!Array.isArray(yamlDocuments[1]?.toJS())||typeof parsedFlows!=='object'||parsedFlows===null||Array.isArray(parsedFlows)||Object.values(parsedFlows).some(value=>typeof value!=='string');}catch{/* Unresolved aliases and other raw drafts stay in the editor. */}
  const incompleteCanvas=!!canvas?.screens.some(screen=>screen.tests.some(test=>operationProblem(test)));
  const pendingDraft=!!(drafts.length||definitionError||mockError||automationError||expectedPage||invalidSource||incompleteCanvas);
  const dirty=pendingDraft||currentKey!==(acknowledged||initialKey.current);
  const draftFields:Record<string,string>={};
  for(const report of fieldsRef.current.values())if(report.pending&&report.key&&typeof report.value==='string')draftFields[report.key]=report.value;
  const draftContent={yaml,flows,canvas,scenarios:definitions,automation,mock};
  const draftKey=JSON.stringify({name,content:draftContent,fields:draftFields});
  latestDraftKey.current=draftKey;
  const baseline=acknowledged||initialKey.current;
  const failedSnapshot=(!pendingDraft&&failedKey.current===currentKey&&currentKey!==baseline)||(pendingDraft&&failedDraftKey.current===draftKey&&acknowledgedDraftKey!==draftKey);
  const blockedFailure=saveFailed||draftFailed||conflict||failedSnapshot;
  const draftAcked=pendingDraft&&acknowledgedDraftKey===draftKey;
  const persistedClean=!pendingDraft&&currentKey===baseline;
  const willAutosave=!!token&&!conflict&&!submitting&&!pickerBusy&&!saveFailed&&!draftFailed&&!failedSnapshot&&(pendingDraft?!draftAcked:currentKey!==baseline);
  const autosavePaused=(!token||pickerBusy)&&!blockedFailure&&!draftAcked&&!persistedClean;
  const pauseNote=autosavePaused?!token?'Changes are kept in this tab. Leaving the site warns you. Autosave resumes automatically when a runner connects.':'while the picker is open':undefined;
  const draftInvalid=pendingDraft;
  const persistenceStatus=blockedFailure?"Couldn't save.":draftAcked?'Draft kept, not valid yet.':saving||draftSaving||willAutosave||(submitting&&!persistedClean)?'Saving…':persistedClean&&workspaceId?'Saved locally':persistedClean?'Not saved yet':autosavePaused?'Unsaved changes · Autosave paused':'Not saved yet';
  const runBlockedReason=!simulatorConnected?'Simulator not connected':draftInvalid?'Draft kept, not valid yet':pickerBusy?'Picker is open':undefined;
  warnOnLeaveRef.current=!persistedClean&&!draftAcked;
  const showRecovery=draftRevisionShown>0&&draftRevisionShown>dismissedDraft&&!draftError;
  const staleDraft=showRecovery&&draftBase<savedRevision;
  const [recoveryOpen,setRecoveryOpen]=useState(false);
  const recoveryButtonRef=useRef<HTMLButtonElement|null>(null);
  const recoveryNoteRef=useRef<HTMLDivElement|null>(null);
  useEffect(()=>{if(!showRecovery)setRecoveryOpen(false);},[showRecovery]);
  useEffect(()=>{
    if(!recoveryOpen)return;
    const close=(event:Event)=>{const target=event.target;if(!(target instanceof Node)||recoveryNoteRef.current?.contains(target)||recoveryButtonRef.current?.contains(target))return;setRecoveryOpen(false);};
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')setRecoveryOpen(false);};
    document.addEventListener('pointerdown',close);
    document.addEventListener('keydown',onKey);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',onKey);};
  },[recoveryOpen]);
  const recoveryBox=recoveryOpen&&recoveryButtonRef.current?.isConnected?recoveryButtonRef.current.getBoundingClientRect():null;
  const storedCanvas=viewRef.current.canvas;
  const initialCanvasView=storedCanvas&&typeof storedCanvas==='object'&&!Array.isArray(storedCanvas)?storedCanvas as {zoom?:number;scrollLeft?:number;scrollTop?:number;selectedScreenId?:string;selectedVisitId?:string}:undefined;
  const storedCards=viewRef.current.cards;
  const cardPositions=storedCards&&typeof storedCards==='object'&&!Array.isArray(storedCards)?storedCards as {picker?:{x:number;y:number};yaml?:{x:number;y:number}}:undefined;
  useEffect(()=>{
    if(noWorkspace||!token||conflict||submitting||pickerBusy)return;
    if(pendingDraft){
      if(failedDraftKey.current===draftKey||acknowledgedDraftKey===draftKey)return;
      const timer=setTimeout(()=>{void persistDraft().catch(()=>{});},300);
      return()=>clearTimeout(timer);
    }
    if(currentKey===(acknowledged||initialKey.current)||failedKey.current===currentKey)return;
    const timer=setTimeout(()=>{void save().catch(()=>{});},300);
    return()=>clearTimeout(timer);
  },[noWorkspace,currentKey,acknowledged,pendingDraft,draftKey,acknowledgedDraftKey,conflict,token,submitting,pickerBusy,retrySave,fieldEpoch]);
  useEffect(()=>{const guard=(event:BeforeUnloadEvent)=>{if(!warnOnLeaveRef.current)return;event.preventDefault();event.returnValue='Unsaved changes';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[]);
  useEffect(()=>{
    if(!recoverSession||!token||sessionOnce.current)return;
    sessionOnce.current=true;
    const unavailable=()=>{setChooserNotice("That workspace isn't available anymore.");setChooserSignal(value=>value+1);};
    void api('/api/session').then(async(session:{lastActiveId?:string|null;unavailable?:boolean})=>{
      if(!session?.lastActiveId){if(session?.unavailable){setNoWorkspace(true);unavailable();}return;}
      loadWorkspace(await api('/api/workspaces/'+session.lastActiveId));
    }).catch(()=>unavailable());
  },[recoverSession,token]);
  useEffect(()=>{
    if(!viewTick||!token||!persistence.current.id)return;
    const epoch=persistence.current.epoch;const id=persistence.current.id;
    const timer=setTimeout(()=>{void api('/api/workspaces/'+id+'/view',viewRef.current).then(saved=>{if(epoch===persistence.current.epoch&&persistence.current.id===id&&saved&&typeof saved==='object'&&!Array.isArray(saved))viewRef.current=saved;}).catch(()=>{});},300);
    return()=>clearTimeout(timer);
  },[viewTick,token]);
  const headers = { 'X-TnT-Token': token, 'Content-Type': 'application/json' };
  const api = runnerClient(token);
  useEffect(()=>{
    if(!sourceRepair)return;
    if(advanced.current)advanced.current.open=true;
    const target=sourceRepair.ownerId==='flows'||sourceRepair.ownerId.endsWith('.yaml')?document.getElementById('reusable-flows'):sourceRepair.ownerId==='automation'?advanced.current?.querySelector<HTMLElement>('.default-actions input,.default-actions select'):advanced.current?.querySelector<HTMLElement>('[aria-label="YAML form and code editor"] button');
    target?.scrollIntoView?.({block:'nearest'});target?.focus();
  },[sourceRepair]);
  useEffect(()=>{
    if(run)setReports(current=>current.some(item=>item.id===run.id)?current.map(item=>item.id===run.id?run:item):[...current,run]);
  },[run]);
  useEffect(()=>{artifactSequence.current++;setArtifact(undefined);},[run?.id]);
  useEffect(()=>{
    if(!token)return;let stopped=false;
    const timer=setTimeout(()=>{
      try {
        const parsedFlows=JSON.parse(flows);
        void runnerClient(token)('/api/canvas/references',{yaml,flows:parsedFlows,canvas,automation}).then(value=>{if(!stopped){setCatalog(value.references);setCanvasDiagnostics(value.diagnostics);}}).catch(error=>{if(!stopped){setCatalog([]);setCanvasDiagnostics([{ownerId:'yaml',detail:error.message}]);}});
      }catch{setCatalog([]);setCanvasDiagnostics([{ownerId:'flows',detail:'Repair the reusable flows JSON.'}]);}
    },250);
    return()=>{stopped=true;clearTimeout(timer);};
  },[yaml,flows,canvas,automation,token]);
  useEffect(() => {
    if (run?.status !== 'running') return;
    let stopped = false;
    const timer = setInterval(() => {
      void api('/api/runs/' + run.id).then(result => { if (!stopped) setRun(result); }).catch(error => { if (!stopped) setError(String(error.message)); });
    }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [run?.id, running, token]);
  useEffect(() => () => { if (artifact?.image) URL.revokeObjectURL(artifact.image); }, [artifact?.image]);
  async function receiveBatch(next:Batch){
    setBatch(next);
    const records:Run[]=await Promise.all(next.entries.filter(entry=>entry.runId).map(entry=>api('/api/runs/'+entry.runId)));
    setReports(current=>[...current.filter(item=>!records.some(record=>record.id===item.id)),...records]);
    setRun(current=>records.find(item=>item.id===current?.id)??current);
  }
  useEffect(()=>{
    if(!batchRunning||!batch)return;
    let stopped=false;
    const timer=setInterval(()=>{void api('/api/batches/'+batch.id).then(next=>{if(!stopped)return receiveBatch(next);}).catch(error=>{if(!stopped)setError(error.message);});},1000);
    return()=>{stopped=true;clearInterval(timer);};
  },[batch?.id,batchRunning,token]);
  function scriptBlockMap(){
    const map=new Map<string,ScriptBlockReason>();
    for(const item of definitions){
      if(item.skipInRunAll)continue;
      const reasons=blocksFor(recordsFor(item.id,item.scripts,scriptTrust),canvas&&item.pathId?orderedScenarioSteps(canvas,item.pathId):[],scriptTrust);
      const reason=reasons.find(entry=>entry.kind==='untrusted')??reasons[0];
      if(reason)map.set(item.id,reason);
    }
    return map;
  }
  async function runAll(){
    if(running||submitting||pickerBusy||launchBusy||!definitions.some(item=>!item.skipInRunAll))return;
    setSubmitting(true);setRunError('');
    try{
      const workspace=await save();
      if(!workspace)return;
      const included=workspace.scenarios?.filter(item=>!item.skipInRunAll).map(item=>item.id)??[];
      if(!included.length)throw new Error('No scenarios are included in Run All.');
      const blocked=scriptBlockMap();
      if(blocked.size)setRevealBlocks(true);
      const scenarioIds=included.filter(id=>!blocked.has(id));
      if(!scenarioIds.length){
        setBatch({id:'script-blocks',workspaceId:workspace.id,deviceId,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),status:'completed',entries:[],snapshot:{workspace,resetApp,runtimeInputPolicy:'Saved inputs only; no additional reset or server-session guarantee.'}});
        return;
      }
      await receiveBatch(await api('/api/batches',{workspaceId:workspace.id,deviceId,scenarioIds,resetApp,runtimeInputs:inputs.trim()?JSON.parse(inputs):undefined}));
      setInputs('');
    }catch(error){setRunError(error instanceof Error?error.message:'Batch request failed.');}
    finally{setSubmitting(false);}
  }
  async function cancelBatch(){
    try{await receiveBatch(await api('/api/batches/'+batch?.id+'/cancel',{}));}
    catch(error){setError(error instanceof Error?error.message:'Batch cancellation failed.');}
  }
  async function openReport(id:string){
    try{setRun(await api('/api/runs/'+id));}
    catch(error){setError(error instanceof Error?error.message:'Report unavailable.');}
  }
  function renameScenario(value:string,id=scenarioId){
    const target=definitions.find(item=>item.id===id);
    setDefinitions(current=>current.map(item=>item.id===id?{...item,name:value}:item));
    if(target?.authoring==='canvas')setCanvas(current=>current&&({...current,paths:current.paths.map(path=>path.id===target.pathId?{...path,name:value}:path)}));
  }
  async function duplicateScenario(targetId=scenarioId){
    if(!definitions.some(item=>item.id===targetId))return;
    setSubmitting(true);setError('');
    try{
      const saved=await save(targetId);
      if(!saved?.id)return;
      const previous=new Set((saved.scenarios??[]).map(item=>item.id));
      const workspace:Workspace=await api('/api/scenarios/duplicate',{workspaceId:saved.id,scenarioId:targetId,expectedRevision:saved.metadata?.revision??0});
      const created=workspace.scenarios?.find(item=>!previous.has(item.id));
      loadWorkspace(workspace);
      if(created)selectScenario(created.id);
    }catch(error){setError(error instanceof Error?error.message:'Scenario could not be duplicated.');}
    finally{setSubmitting(false);}
  }
  function deleteScenario(targetId=scenarioId){
    const target=definitions.find(item=>item.id===targetId);if(!target)return;
    const position=definitions.indexOf(target);
    const path=canvas?.paths.find(path=>path.id===target.pathId);
    const pathPosition=path?canvas!.paths.indexOf(path):-1;
    const removedPath=path&&!definitions.some(item=>item.id!==targetId&&item.pathId===path.id)?structuredClone(path):undefined;
    const memberships=canvas?.screens.flatMap(screen=>screen.tests.filter(test=>test.scenarioIds?.includes(targetId)).map(test=>({screenId:screen.id,testId:test.id,position:test.scenarioIds!.indexOf(targetId)})))??[];
    setDefinitions(current=>current.filter(item=>item.id!==targetId));
    setCanvas(current=>current&&({...current,screens:current.screens.map(screen=>({...screen,tests:screen.tests.map(test=>test.scenarioIds?{...test,scenarioIds:test.scenarioIds.filter(id=>id!==targetId)}:test)})),paths:current.paths.filter(path=>path.id!==removedPath?.id)}));
    if(scenarioId===targetId){setScenarioId(definitions.find(item=>item.id!==targetId)?.id??'');setInputs('');}
    // Restoration only merges the references removed by this command.
    const restore=()=>{
      setScenarioId(current=>current||targetId);
      setDefinitions(current=>{if(current.some(item=>item.id===targetId))return current;const next=[...current];next.splice(position,0,structuredClone(target));return next;});
      setCanvas(current=>{
        if(!current)return current;
        const paths=[...current.paths];if(removedPath&&!paths.some(path=>path.id===removedPath.id))paths.splice(pathPosition,0,removedPath);
        return {...current,paths,screens:current.screens.map(screen=>({...screen,tests:screen.tests.map(test=>{
          const membership=memberships.find(item=>item.screenId===screen.id&&item.testId===test.id);
          if(!membership||!test.scenarioIds||test.scenarioIds.includes(targetId))return test;
          const ids=[...test.scenarioIds];ids.splice(membership.position,0,targetId);return {...test,scenarioIds:ids};
        })}))};
      });
    };
    setDeletedScenario({name:target.name,restore});
  }
  function loadWorkspace(workspace:Workspace&{draft?:WorkspaceDraft|null;draftError?:string;view?:Record<string,unknown>|null}){
    setNoWorkspace(false);
    try{setScriptSourceName(workspace.id?sessionStorage.getItem('tnt-script-source:'+workspace.id)??'':'');}catch{setScriptSourceName('');}
    persistence.current={id:workspace.id,revision:workspace.metadata?.revision??0,draftRevision:workspace.draft?.draftRevision??0,epoch:persistence.current.epoch+1};
    failedKey.current='';failedDraftKey.current='';setSaveProblem('');setConflict(false);setConflictBar(false);setSaveFailed(false);setDraftFailed(false);
    const view=workspace.view&&typeof workspace.view==='object'&&!Array.isArray(workspace.view)?workspace.view:{format:1};
    viewRef.current=view;
    const scenarios=workspace.scenarios??[];
    const savedScenario=typeof view.scenarioId==='string'?scenarios.find(item=>item.id===view.scenarioId):undefined;
    const missingName=typeof view.scenarioName==='string'&&view.scenarioName?view.scenarioName:typeof view.scenarioId==='string'?view.scenarioId:'';
    if(savedScenario){setScenarioId(savedScenario.id);setScenarioNotice('');}
    else if(scenarios[0]&&missingName){setScenarioId(scenarios[0].id);setScenarioNotice(`Scenario '${missingName}' was deleted, showing '${scenarios[0].name}'.`);}
    else{setScenarioId(scenarios[0]?.id??'');setScenarioNotice('');}
    const savedPath=typeof view.pathId==='string'&&workspace.canvas?.paths.some(path=>path.id===view.pathId)?view.pathId:'';
    setPathId(savedPath);
    setLegacyCanvas(!scenarios.some(item=>item.authoring==='canvas'));setDefinitions(scenarios);setDefinitionError('');setResetApp(false);
    setDeletedScenario(undefined);setBatch(undefined);setWorkspaceId(workspace.id);setName(workspace.name);setYaml(workspace.yaml);setFlows(JSON.stringify(workspace.flows??{},null,2));
    setAutomation(workspace.automation);setAutomationError('');setPreview(undefined);setCanvas(workspace.canvas);setLoadedMock(workspace.mock);setMock(workspace.mock);setMockError('');setLoadRevision(value=>value+1);
    artifactSequence.current++;setReports([]);setRun(undefined);setArtifact(undefined);setInputs('');setExpectedPage('');setDrafts([]);fieldsRef.current.clear();
    setAcknowledged(contentKey(workspace));setSourceRepair(undefined);
    setDraftError(workspace.draftError??'');setDraftSavedAt(workspace.draft?.savedAt??'');setDraftBase(workspace.draft?.baseRevision??0);setDraftRevisionShown(workspace.draft?.draftRevision??0);
    setDismissedDraft(typeof view.dismissedDraftRevision==='number'?view.dismissedDraftRevision:0);setSavedRevision(workspace.metadata?.revision??0);
    setRecoveredFields({});setAcknowledgedDraftKey('');setConfirmCorrupt(false);draftRecord.current=workspace.draft??null;
    if(workspace.id)lastValid.current=workspace;
  }
  function requireAppliedDrafts(){const documents=parseAllDocuments(yaml);if(documents.length!==2||documents.some(doc=>doc.errors.length)||!Array.isArray(documents[1].toJS()))throw new Error('Repair incomplete YAML before saving, copying or switching workspaces. Your code is retained.');if(pendingDraft)throw new Error('Apply or cancel incomplete authoring drafts before saving, copying or switching workspaces. Your draft is retained in the editor.');}
  async function prepareSwitch(action:WorkspaceAction){
    if(running||submitting||pickerBusy||launchBusy)throw new Error('Wait for execution and cleanup before managing the workspace.');
    if(action.kind==='restore'||(action.kind==='trash'&&action.id!==workspaceId)||action.kind==='rename'||(action.kind==='copy'&&conflict&&!pendingDraft)||(!pendingDraft&&!dirty))return;
    setSubmitting(true);
    try{if(pendingDraft){await persistDraft();return lastValid.current;}const saved=await save(scenarioId,true);if(!saved)throw new Error('Reserved TnT variable');return saved;}
    finally{setSubmitting(false);}
  }
  function copyRequest(source:object,name:string){
    const id='id' in source&&typeof source.id==='string'?source.id:'';
    const sourceWorkspaceId=id||persistence.current.id||workspaceId;
    return {...source,id:undefined,name,...(sourceWorkspaceId?{sourceWorkspaceId}:{})};
  }
  async function workspaceAction(action:WorkspaceAction,saved?:Workspace,options?:{discard?:boolean}){
    if((running||launchBusy)&&action.kind==='trash'&&action.id===workspaceId)throw new Error('Wait for execution and cleanup before deleting this workspace.');
    if(submitting||pickerBusy||((running||launchBusy)&&action.kind!=='restore'&&action.kind!=='trash'))throw new Error('Wait for execution and cleanup before managing the workspace.');
    setSubmitting(true);setError('');
    const requestKey=latestKey.current;
    const receive=(workspace:Workspace&{draft?:WorkspaceDraft|null;draftError?:string;view?:Record<string,unknown>|null})=>{if(!options?.discard&&latestKey.current!==requestKey&&(!saved||latestKey.current!==contentKey(saved)))throw new Error('Newer edits are still unsaved. Current work is retained; retry the workspace action after saving.');loadWorkspace(workspace);};
    try{
      if(action.kind==='trash'){
        await saveQueue.current;
        await api('/api/workspaces/'+action.id+'/trash',{});
        if(action.id===workspaceId){loadWorkspace({id:'',name:'Choose a workspace',yaml:'appId: com.example.HybridApp\n---\n- launchApp\n',flows:{},scenarios:[],canvas:emptyCanvas()});lastValid.current=undefined;setNoWorkspace(true);setChooserNotice('Choose a saved workspace or create a new one.');}
      }
      else if(action.kind==='restore'){
        await api('/api/workspaces/'+action.id+'/restore',{});
      }
      else if(action.kind==='open')receive(await api('/api/workspaces/'+action.id+'/open',{}));
      else if(action.kind==='import'){const imported=await api('/api/workspaces/import',{package:action.package,name:action.name});const sourceName=action.package&&typeof action.package==='object'&&action.package.workspace&&typeof action.package.workspace==='object'&&typeof action.package.workspace.name==='string'?action.package.workspace.name:'';if(imported?.id)rememberScriptSource(imported.id,sourceName);receive(imported);if(reservedPlacements({yaml:imported.yaml??'',flows:JSON.stringify(imported.flows??{}),scenarios:imported.scenarios??[],runtimeText:''}).length)setReservedVisible(true);}
      else if(action.kind==='new')loadWorkspace({id:'',name:action.name,yaml:'appId: com.example.HybridApp\n---\n- launchApp\n',flows:{},scenarios:[],canvas:emptyCanvas()});
      else if(action.kind==='rename')setName(action.name);
      else{
        const source=options?.discard?(lastValid.current??reviewedContent({name:action.name})):saved?{...saved,name:action.name}:reviewedContent({name:action.name});
        {const copied=await api('/api/workspaces/copy',copyRequest(source,action.name));if(copied?.id)rememberScriptSource(copied.id,('name' in source&&typeof source.name==='string'?source.name:name));receive(copied);}
      }
    }finally{setSubmitting(false);}
  }
  async function manualSave(){setSubmitting(true);setError('');try{const workspace=await save(scenarioId,true);if(!workspace)throw new Error('Reserved TnT variable');return workspace;}catch(error){if(error instanceof Error&&error.message==='Reserved TnT variable')throw error;setSaveFailed(true);setError(error instanceof Error?error.message:'Save failed. Current work is retained.');throw error;}finally{setSubmitting(false);}}
  async function save(targetId=scenarioId,requireCurrent=false,pickedYaml?:string) {
    requireAppliedDrafts();
    const savingKey=pickedYaml===undefined?latestKey.current:contentKey({...authoredContent,yaml:pickedYaml});
    const reserved=reservedPlacements({yaml:pickedYaml??yaml,flows,scenarios:definitions,runtimeText:inputs});
    if(reserved.length){setReservedVisible(true);failedKey.current=savingKey;return;}
    setReservedVisible(false);
    const target=definitions.find(item=>item.id===targetId);
    if(definitionError)throw new Error(definitionError);
    if(mockError) throw new Error(mockError);
    if(automationError)throw new Error(automationError);
    let source=pickedYaml??yaml;
    if(pickedYaml===undefined&&target?.authoring==='canvas'&&bundleId){const docs=parseAllDocuments(yaml);if(docs.length===2&&!docs.some(doc=>doc.errors.length)){docs[0].set('appId',bundleId);source=docs[0].toString()+'---\n'+docs[1].toString({directives:false});}}
    const content=reviewedContent({yaml:source});
    const epoch=persistence.current.epoch;
    const clearDraft=persistence.current.draftRevision||undefined;
    const operation=saveQueue.current.then(async()=>{
      if(epoch!==persistence.current.epoch)throw new Error('Workspace changed before saving.');
      setSaving(true);
      try{
        const workspace:Workspace & {draftCleared?:boolean}=await api('/api/workspaces',{...content,id:persistence.current.id||undefined,expectedRevision:persistence.current.revision,clearDraft});
        if(epoch!==persistence.current.epoch)return workspace;
        const hasNewEdits=latestKey.current!==savingKey;
        const draftCleared=workspace.draftCleared===true;
        persistence.current={id:workspace.id,revision:workspace.metadata?.revision??0,draftRevision:draftCleared?0:persistence.current.draftRevision,epoch};
        setWorkspaceId(workspace.id);setAcknowledged(contentKey(workspace));setSaveFailed(false);setDraftFailed(false);setSaveProblem('');setConflict(false);failedKey.current='';failedDraftKey.current='';
        lastValid.current=workspace;setSavedRevision(workspace.metadata?.revision??0);
        if(draftCleared){setAcknowledgedDraftKey('');setRecoveredFields({});setDraftRevisionShown(0);setDraftSavedAt('');draftRecord.current=null;}
        if(!hasNewEdits){setYaml(workspace.yaml);setCanvas(workspace.canvas);setDefinitions(workspace.scenarios??[]);setAutomation(workspace.automation);setMock(workspace.mock);setFlows(JSON.stringify(workspace.flows??{},null,2));}
        return workspace;
      }catch(error){
        if(epoch===persistence.current.epoch){const message=error instanceof Error?error.message:'Local save failed.';failedKey.current=savingKey;setSaveFailed(true);setSaveProblem(message);const conflicted=error instanceof RunnerRequestError&&error.status===409;setConflict(conflicted);if(conflicted)setConflictBar(true);}
        throw error;
      }finally{setSaving(false);}
    });
    saveQueue.current=operation.catch(()=>{});
    const workspace=await operation;
    if(requireCurrent&&latestKey.current!==savingKey&&latestKey.current!==contentKey(workspace))throw new Error('Newer edits are still unsaved. Review them and retry before continuing.');
    return workspace;
  }
  async function persistDraft(){
    const key=latestDraftKey.current;const epoch=persistence.current.epoch;const fields={...draftFields};const content={...draftContent};const draftName=name;
    const operation=saveQueue.current.then(async()=>{
      if(epoch!==persistence.current.epoch)throw new Error('Workspace changed before saving.');
      setDraftSaving(true);
      try{
        if(!persistence.current.id){
          const created=await api('/api/workspaces/draft',{name:draftName,content,fields});
          if(!created?.draft||!Number.isInteger(created.draft.draftRevision))throw new Error('Draft was not acknowledged.');
          if(epoch!==persistence.current.epoch)return created;
          persistence.current={id:created.workspace.id,revision:created.workspace.metadata?.revision??1,draftRevision:created.draft.draftRevision,epoch};
          setWorkspaceId(created.workspace.id);lastValid.current=created.workspace;setSavedRevision(created.workspace.metadata?.revision??1);
          if(latestDraftKey.current===key){setAcknowledgedDraftKey(key);setDraftFailed(false);failedDraftKey.current='';failedKey.current='';if(!conflictRef.current){setSaveFailed(false);setSaveProblem('');}setDraftSavedAt(created.draft.savedAt);setDraftBase(created.draft.baseRevision);setDraftRevisionShown(created.draft.draftRevision);draftRecord.current=created.draft;}
          return created;
        }
        const result=await api('/api/workspaces/'+persistence.current.id+'/draft',{baseRevision:persistence.current.revision,expectedDraftRevision:persistence.current.draftRevision,name:draftName,content,fields});
        if(!Number.isInteger(result?.draftRevision))throw new Error('Draft was not acknowledged.');
        if(epoch!==persistence.current.epoch)return result;
        persistence.current={...persistence.current,draftRevision:result.draftRevision};
        if(latestDraftKey.current===key){
          setAcknowledgedDraftKey(key);setDraftFailed(false);failedDraftKey.current='';failedKey.current='';if(!conflictRef.current){setSaveFailed(false);setSaveProblem('');}
          setDraftSavedAt(result.savedAt);setDraftBase(persistence.current.revision);setDraftRevisionShown(result.draftRevision);
          draftRecord.current=result.draft??{format:1,workspaceId:persistence.current.id,baseRevision:persistence.current.revision,draftRevision:result.draftRevision,savedAt:result.savedAt,name:draftName,content,fields};
        }
        return result;
      }catch(error){
        if(epoch===persistence.current.epoch){const message=error instanceof Error?error.message:'Local save failed.';failedDraftKey.current=key;setDraftFailed(true);setSaveProblem(message);const conflicted=error instanceof RunnerRequestError&&error.status===409;setConflict(conflicted);if(conflicted)setConflictBar(true);}
        throw error;
      }finally{setDraftSaving(false);}
    });
    saveQueue.current=operation.catch(()=>{});
    return operation;
  }
  function rememberView(patch:Record<string,unknown>){
    const current=viewRef.current;
    const canvas=patch.canvas&&typeof patch.canvas==='object'&&!Array.isArray(patch.canvas)?{...(current.canvas&&typeof current.canvas==='object'&&!Array.isArray(current.canvas)?current.canvas as Record<string,unknown>:{}),...patch.canvas as Record<string,unknown>}:current.canvas;
    const panels=patch.panels&&typeof patch.panels==='object'&&!Array.isArray(patch.panels)?{...(current.panels&&typeof current.panels==='object'&&!Array.isArray(current.panels)?current.panels as Record<string,unknown>:{}),...patch.panels as Record<string,unknown>}:current.panels;
    const cards=patch.cards&&typeof patch.cards==='object'&&!Array.isArray(patch.cards)?{...(current.cards&&typeof current.cards==='object'&&!Array.isArray(current.cards)?current.cards as Record<string,unknown>:{}),...patch.cards as Record<string,unknown>}:current.cards;
    const incomingFormat=typeof patch.format==='number'&&patch.format>=1?patch.format:1;
    const existingFormat=typeof current.format==='number'&&current.format>=1?current.format:1;
    viewRef.current={...current,...patch,format:Math.max(incomingFormat,existingFormat),...(canvas===undefined?{}:{canvas}),...(panels===undefined?{}:{panels}),...(cards===undefined?{}:{cards})};
    if(typeof patch.dismissedDraftRevision==='number')setDismissedDraft(patch.dismissedDraftRevision);
    setViewTick(value=>value+1);
  }
  function yamlDeletionWarnings(index:number){return [...definitions.filter(item=>item.steps.some(ref=>ref.index!>=index)).map(item=>'Scenario · '+item.name),...(canvas?.screens.flatMap(screen=>screen.tests.filter(test=>test.reference.kind==='flow'||(test.reference.file==='flow.yaml'&&(test.reference.index??-1)>=index)).map(test=>screen.title+' · '+test.label))??[]),...(automation?.checkpoints.filter(checkpoint=>checkpoint.beforeStep>=index).map(checkpoint=>'Default-action checkpoint before step '+(checkpoint.beforeStep+1))??[])];}
  function deleteYamlStep(next:string,index:number){
    const previous=canvas;const changed=canvasAfterDeletion(canvas,index);
    const previousDefinitions=definitions;
    const changedDefinitions=definitions.map(item=>({...item,steps:item.steps.map(ref=>ref.index!>=index?{...ref,fingerprint:'deleted:'+ref.fingerprint.slice(-56)}:ref)}));
    setDefinitions(changedDefinitions);
    const previousAutomation=automation;
    const changedAutomation=automation?{...automation,checkpoints:automation.checkpoints.map(checkpoint=>checkpoint.beforeStep>=index?{...checkpoint,fingerprint:'deleted:'+checkpoint.fingerprint.slice(-56)}:checkpoint)}:undefined;
    setYaml(next);setCanvas(changed);setAutomation(changedAutomation);
    return ()=>{setDefinitions(current=>current.map(item=>{const previous=previousDefinitions.find(previous=>previous.id===item.id);const changed=changedDefinitions.find(changed=>changed.id===item.id);return previous&&changed?{...item,steps:item.steps.map(ref=>{const match=changed.steps.find(step=>step.index===ref.index&&step.fingerprint===ref.fingerprint);const original=previous.steps.find(step=>step.index===ref.index);return match&&original?original:ref;})}:item;}));setCanvas(current=>restoreDeletionReferences(current,previous,changed));setAutomation(current=>current&&previousAutomation&&changedAutomation?{...current,checkpoints:current.checkpoints.map(checkpoint=>{
      const changed=changedAutomation.checkpoints.find(item=>item.beforeStep===checkpoint.beforeStep&&item.fingerprint===checkpoint.fingerprint);
      const previous=previousAutomation.checkpoints.find(item=>item.beforeStep===checkpoint.beforeStep);
      return changed&&previous?{...checkpoint,fingerprint:previous.fingerprint}:checkpoint;
    })}:current);};
  }
  function rememberScriptSource(id:string,sourceName:string){if(!id||!sourceName)return;try{sessionStorage.setItem('tnt-script-source:'+id,sourceName);}catch{/* The name is a label, not trust. */ }setScriptSourceName(sourceName);}
  function selectScenario(id:string){
    setScenarioId(id);setInputs('');
    const item=definitions.find(entry=>entry.id===id);
    setPathId(item?.pathId??'');
    rememberView({scenarioId:id,scenarioName:item?.name??'',pathId:item?.pathId??''});
  }
  function restoreDraft(draft:WorkspaceDraft){
    const content=draft.content??{};
    const flowsValue=typeof content.flows==='string'?content.flows:JSON.stringify(content.flows??{},null,2);
    setName(draft.name);if(typeof content.yaml==='string')setYaml(content.yaml);setFlows(flowsValue);
    if(content.canvas&&typeof content.canvas==='object')setCanvas(content.canvas as CanvasGraph);
    if(Array.isArray(content.scenarios))setDefinitions(content.scenarios as ScenarioDefinition[]);
    if(content.automation&&typeof content.automation==='object')setAutomation(content.automation as Automation);
    if(content.mock&&typeof content.mock==='object'){setMock(content.mock as MockPlan);setLoadedMock(content.mock as MockPlan);}
    setRecoveredFields({...draft.fields});setLoadRevision(value=>value+1);draftRecord.current=draft;
    setAcknowledgedDraftKey(JSON.stringify({name:draft.name,content:{yaml:typeof content.yaml==='string'?content.yaml:yaml,flows:flowsValue,canvas:content.canvas,scenarios:content.scenarios,automation:content.automation,mock:content.mock},fields:draft.fields??{}}));
    setDismissedDraft(draft.draftRevision);
  }
  async function keepSaved(){
    const revision=draftRevisionShown;
    viewRef.current={...viewRef.current,dismissedDraftRevision:revision};setDismissedDraft(revision);
    if(!persistence.current.id)return;
    try{const saved=await api('/api/workspaces/'+persistence.current.id+'/view',viewRef.current);if(saved&&typeof saved==='object'&&!Array.isArray(saved))viewRef.current=saved;}catch{/* A view write is not a document save. */}
  }
  async function copyWithDraft(){
    const base=lastValid.current;if(!base?.id)throw new Error('Save a valid version before restoring the draft as a copy.');
    const copyName=(base.name.slice(0,115)+' copy').slice(0,120);
    const copy:Workspace=await api('/api/workspaces/copy',copyRequest(base,copyName));if(copy?.id)rememberScriptSource(copy.id,base.name);
    const draft=draftRecord.current;
    const written=await api('/api/workspaces/'+copy.id+'/draft',{baseRevision:copy.metadata?.revision??1,expectedDraftRevision:0,name:draft?.name??name,content:draft?.content??draftContent,fields:draft?.fields??draftFields});
    const detail=await api('/api/workspaces/'+copy.id);
    loadWorkspace(detail);
    if(written?.draft)restoreDraft(written.draft);
    setConflict(false);setConflictBar(false);
  }
  async function copyConflict(){
    const copyName=(name.slice(0,115)+' copy').slice(0,120);
    {const copied=await api('/api/workspaces/copy',copyRequest(reviewedContent({name:copyName}),copyName));if(copied?.id)rememberScriptSource(copied.id,name);loadWorkspace(copied);}
    setConflict(false);setConflictBar(false);setSaveFailed(false);setSaveProblem('');
  }
  async function loadLatest(){
    if(!persistence.current.id)return;
    loadWorkspace(await api('/api/workspaces/'+persistence.current.id));
    setConflict(false);setConflictBar(false);setSaveFailed(false);setSaveProblem('');
  }
  async function discardCorrupt(){
    if(!persistence.current.id)return;
    await api('/api/workspaces/'+persistence.current.id+'/draft/discard',{expectedDraftRevision:0});
    setDraftError('');setConfirmCorrupt(false);setDraftRevisionShown(0);setDraftSavedAt('');draftRecord.current=null;persistence.current={...persistence.current,draftRevision:0};
  }
  function goToFirstIssue(){
    const details=advanced.current;if(details)details.open=true;
    const yamlField=document.getElementById('scenario-yaml') as HTMLTextAreaElement|null;
    const target=invalidSource?yamlField:document.querySelector<HTMLElement>('.yaml-value input, #reusable-flows, #scenario-public-inputs, .default-actions input, .default-actions select, #scenario-yaml');
    target?.focus();
  }

  async function submit(execute: boolean,targetId=scenarioId) {
    if(submitting||pickerBusy||(execute&&(running||launchBusy)))return;
    if (execute) {
      setRunError('');
      if(!token){setRunError('Connect to the runner before running a scenario.');return;}
      if(!deviceId){setRunError('Select a device before running a scenario.');return;}
      const targetPath=definitions.find(item=>item.id===targetId)?.pathId??pathId;
      const rows=recordsFor(targetId,definitions.find(item=>item.id===targetId)?.scripts,scriptTrust);
      const reasons=blocksFor(rows,canvas?orderedScenarioSteps(canvas,targetPath):[],scriptTrust);
      if(reasons.length){setRevealBlocks(true);return;}
      artifactSequence.current++; setArtifact(undefined);
    }
    setError(''); setSubmitting(true);
    try {
      const workspace = await save(targetId);
      if(!workspace)return;
      if (execute) {
        const runtimeInputs = inputs.trim() ? JSON.parse(inputs) : undefined;
        setArtifact(undefined);
        const next = await api('/api/runs', { workspaceId: workspace.id, deviceId, runtimeInputs, pathId:canvas?pathId:undefined,scenarioId:definitions.length?targetId:undefined,resetApp });
        artifactSequence.current++;
        setArtifact(undefined);
        setRun(next);
        setInputs('');
      }
    } catch (error) {
      if(execute&&error instanceof RunnerRequestError&&Array.isArray(error.blocked)&&error.blocked.length){setRevealBlocks(true);return;}
      const message=error instanceof Error ? error.message : 'Scenario request failed.';
      if(message==='Reserved TnT variable')return;
      if(execute)setRunError(message);else {setError(message);setSaveFailed(true);}
    }
    finally { setSubmitting(false); }
  }
  async function savePicked(yaml:string){setYaml(yaml);await save(scenarioId,false,yaml);}
  async function executePicked(flowYaml: string, captureId: string, pickerReviewId: string) {
    artifactSequence.current++; setArtifact(undefined); setError('');
    const workspace: Workspace = await api('/api/workspaces', { name: 'Picked step — ' + name.slice(0, 100), yaml: flowYaml });
    const next = await api('/api/runs', { workspaceId: workspace.id, deviceId, captureId, pickerReviewId });
    artifactSequence.current++; setArtifact(undefined); setRun(next);
  }
  async function cancel() {
    setError('');
    try { setRun(await api('/api/runs/' + run?.id + '/cancel', {})); }
    catch (error) { setError(error instanceof Error ? error.message : 'Cancellation failed.'); }
  }
  async function inspect(name: string) {
    const sequence = ++artifactSequence.current;
    const id = run?.id;
    try {
      const response = await fetch('/api/runs/' + id + '/artifact?name=' + encodeURIComponent(name), { headers });
      if (!response.ok) throw new Error('Artifact unavailable.');
      if (name.endsWith('.png')) {
        const blob = await response.blob();
        if (sequence === artifactSequence.current) setArtifact({ name, image: URL.createObjectURL(blob) });
      } else {
        const text = await response.text();
        if (sequence === artifactSequence.current) setArtifact({ name, text });
      }
    } catch (error) { if (sequence === artifactSequence.current) setError(error instanceof Error ? error.message : 'Artifact unavailable.'); }
  }
  function addAssertion() {
    try {
      if(!expectedPage.trim()) throw new Error('Enter the expected page text.');
      const docs=parseAllDocuments(yaml);
      if(docs.length!==2 || docs.some(doc=>doc.errors.length) || !Array.isArray(docs[1].toJS())) throw new Error('Repair the scenario YAML before adding a reusable assertion.');
      const appId=docs[0].toJS().appId;
      const nextFlows=JSON.parse(flows);
      nextFlows['maintenance.yaml']='appId: '+JSON.stringify(appId)+'\n---\n- assertVisible: ${EXPECTED_PAGE}\n';
      docs[1].add({runFlow:{file:'maintenance.yaml',env:{EXPECTED_PAGE:'^'+expectedPage.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'}}});
      setFlows(JSON.stringify(nextFlows,null,2));setYaml(docs[0].toString()+docs[1].toString());setError('');
    } catch(error){setError(error instanceof Error?error.message:'Cannot add assertion.');}
  }
  const scriptRows=recordsFor(scenarioId,selectedScenario?.scripts,scriptTrust);
  const scriptTrustCount=untrustedCount(scriptRows,scriptTrust);
  const placements=reservedVisible?reservedPlacements({yaml,flows,scenarios:definitions,runtimeText:inputs}):[];
  const inputReserved=placements.find(item=>item.target==='scenario-input'||item.target==='parameters');
  const runtimeReserved=placements.find(item=>item.target==='runtime');
  const flowReserved=placements.find(item=>item.target==='flows');
  const scriptRun=run?readScriptRun(run):{scriptSteps:{},executionOrder:[]};
  const currentResults=Object.values(scriptRun.scriptSteps);
  const runIsCurrent=!!run&&(run.snapshot.scenario?.id===scenarioId||!run.snapshot.scenario);
  function patchScripts(id:string,update:(rows:ScriptRow[])=>ScriptRow[]){setDefinitions(current=>current.map(item=>item.id===id?{...item,scripts:update(item.scripts??[])}:item));}
  const runScripts:RunScriptModel|undefined=scenarioId?{scenarioId,rows:scriptRows,trust:scriptTrust,results:runIsCurrent?currentResults:[],executionOrder:runIsCurrent?scriptRun.executionOrder:[],hasMock:scenarioShowsMockVariables(!!mock,selectedScenario?.mockResponseId,scriptRows,scriptTrust),revealBlocks,running:!!runIsCurrent&&run?.status==='running',passedRun:!!runIsCurrent&&run?.status==='passed',timedOut:runIsCurrent&&runHitCap(run),scrubFailed:runIsCurrent&&evidenceScrubFailed(run),failedAtScript:runIsCurrent&&currentResults.some(item=>item.status==='script-error'&&scriptRows.some(row=>row.id===item.rowId)),trustBlockCount:scriptTrustCount,workspaceName:scriptSourceName,onAdd:anchor=>{const id=newScriptId();patchScripts(scenarioId,rows=>[...rows,{id,beforeStep:anchor,label:'Run script',source:''}]);return id;},onUpdate:(rowId,patch)=>patchScripts(scenarioId,rows=>rows.map(row=>row.id===rowId?{...row,...patch}:row)),onMove:(rowId,direction,stepCount,fingerprintAt)=>patchScripts(scenarioId,rows=>{const next=moveScript(recordsFor(scenarioId,rows,scriptTrust),rowId,direction,stepCount,fingerprintAt);return next?next.map(({id,label,source,beforeStep})=>({id,label,source,beforeStep})):rows;}),onDelete:rowId=>patchScripts(scenarioId,rows=>rows.filter(row=>row.id!==rowId)),onReplace:rows=>patchScripts(scenarioId,()=>rows),onTrust:async rowId=>{const row=scriptRows.find(item=>item.id===rowId);if(!row||!workspaceId)throw new Error('Script trust was not saved.');const saved=await approveScriptTrust({workspace:workspaceId,rowId,hash:row.hash,token});setScriptTrust(current=>[...current.filter(item=>item.rowId!==saved.rowId),saved]);},onStop:()=>void cancel(),onRunAgain:()=>void submit(true),onOpenLog:()=>{const reports=document.querySelector('.report-tools');if(reports instanceof HTMLDetailsElement)reports.open=true;document.getElementById('run-log')?.querySelector('summary')?.focus();}}:undefined;
  const batchLines=batch?batchWithScriptBlocks(definitions.filter(item=>!item.skipInRunAll).map(item=>item.id),batch.entries as BatchLine[],scriptBlockMap(),new Map(definitions.map(item=>[item.id,item.name]))):undefined;
  const recoveryNote=showRecovery&&recoveryOpen&&<div ref={recoveryNoteRef} className="recovery-note" role="dialog" aria-label="Recovered draft" data-recovery-for="workspace" style={recoveryBox?{top:Math.max(8,Math.min(recoveryBox.bottom+6,window.innerHeight-8)),left:Math.max(8,Math.min(recoveryBox.left,window.innerWidth-288))}:undefined}><p>Unsaved changes from <time dateTime={draftSavedAt}>{draftSavedAt?new Date(draftSavedAt).toLocaleString():'earlier'}</time> were recovered.{staleDraft?' Based on an older version.':''}</p><div className="recovery-note-actions">{staleDraft?<button type="button" className="primary" onClick={()=>void copyWithDraft()}>Restore as a copy</button>:<button type="button" className="primary" onClick={()=>draftRecord.current&&restoreDraft(draftRecord.current)}>Restore draft</button>}<button type="button" onClick={()=>void keepSaved()}>Keep saved version</button></div></div>;
  return <WorkspaceDrafts.Provider value={reportDraft}><RecoveredFields.Provider value={recoveredFields}><YamlDraftProvider resetToken={loadRevision} yaml={yaml}><section className="panel scenario-panel" aria-labelledby="scenario-heading">
    <div className="panel-heading"><span className="section-number">03</span><div><h2 id="scenario-heading">Scenario workspace</h2><p>Design scenarios on the shared canvas. Connect a simulator when ready to run.</p></div></div>
    {!!lastValid.current?.omittedValues?.length&&missingValues({...lastValid.current,scenarios:definitions,automation}).length>0&&<aside className="draft-banner" role="status"><p>Imported values need repair before execution: {missingValues({...lastValid.current,scenarios:definitions,automation}).join(' ')}</p><button onClick={()=>{if(advanced.current)advanced.current.open=true;}}>Review required values</button></aside>}
    <div className="canvas-workspace"><details className="scenario-controls"><summary>Scenarios</summary>{!noWorkspace&&<ScenarioSidebar items={definitions} selected={scenarioId} disabled={running||submitting||pickerBusy||launchBusy} canRun={simulatorConnected&&!draftInvalid} runBlockedReason={runBlockedReason}  runningId={run?.status==='running'&&!batchRunning?run.snapshot.scenario?.id:undefined} onStop={()=>void cancel()} onSelect={selectScenario} onCreate={()=>{setLegacyCanvas(false);const id='scenario-'+crypto.randomUUID().slice(0,8);const path='sequence-'+crypto.randomUUID();setDefinitions(current=>[...current,{id,name:'Scenario '+(current.length+1),authoring:'canvas',steps:[],pathId:path,inputs:{},parameters:{},setup:automation?.setup,enabledHandlerIds:automation?.actions.filter(action=>action.enabled).map(action=>action.id)??[]}]);setCanvas(current=>({...current??emptyCanvas(),paths:[...current?.paths??[],{id:path,scenarioId:id,name:'Scenario '+(definitions.length+1),edgeIds:[]}]}));setScenarioId(id);rememberView({scenarioId:id,scenarioName:'Scenario '+(definitions.length+1),pathId:path});}} onRun={id=>void submit(true,id)} onRunAll={()=>void runAll()} onRename={renameScenario} onDuplicate={duplicateScenario} onDelete={deleteScenario} onToggleSkip={id=>setDefinitions(current=>current.map(item=>item.id===id?{...item,skipInRunAll:!item.skipInRunAll}:item))} key={'sidebar-'+loadRevision}>{run?.status==='running'&&!batchRunning&&!run.snapshot.scenario?.id&&<button className="confirm scenario-stop" aria-label="Stop scenario" onClick={()=>void cancel()}>Stop</button>}{batchRunning&&<button className="confirm" onClick={()=>void cancelBatch()}>Cancel batch</button>}</ScenarioSidebar>}</details><div className="workspace-canvas"><WorkspaceManager imported={scriptTrust.some(item=>item.origin==='imported')} empty={noWorkspace} token={token} id={workspaceId} name={name} status={persistenceStatus} statusNote={pauseNote} dirty={dirty} busy={submitting||pickerBusy} blocked={running||launchBusy||pickerBusy} onAction={workspaceAction} onSave={manualSave} onPrepare={prepareSwitch} onExport={async({includeValues,savedOnly})=>{
      let source=lastValid.current;
      if(!savedOnly&&!running&&!launchBusy){source=await manualSave();}
      if(!source?.id)throw new Error('Save valid authored work before exporting. Repair incomplete drafts first.');
      return api('/api/workspaces/export',{id:source.id,expectedRevision:source.metadata?.revision??0,includeValues});
    }} recovery={conflict} notice={chooserNotice} openSignal={chooserSignal} onRecover={showRecovery?(button)=>{recoveryButtonRef.current=button;setRecoveryOpen(open=>!open);}:undefined} recoveryOpen={recoveryOpen}/>
    {noWorkspace?<div className="empty-state"><h3>No workspace open</h3><p>Open a saved workspace, create new work, or restore from Trash.</p></div>:<>
    {pendingDraft&&<button type="button" className="confirm go-to-issue" onClick={goToFirstIssue}>Go to first issue</button>}
    <p className="field-hint" hidden>Drafts are kept on this computer's runner store (.tnt), excluding confidential runtime inputs.</p>
    {draftError&&<div className="draft-banner danger" role="alert"><p>A recovered draft couldn't be read.</p>{confirmCorrupt?<><p>Discard the unreadable draft? This can't be undone.</p><button type="button" className="workspace-danger" onClick={()=>void discardCorrupt()}>Discard</button><button type="button" ref={corruptCancelButton} onClick={()=>setConfirmCorrupt(false)}>Cancel</button></>:<button type="button" ref={discardDraftButton} onClick={()=>setConfirmCorrupt(true)}>Discard draft</button>}</div>}
    {recoveryNote&&createPortal(recoveryNote,document.body)}
    {conflictBar&&<div className="draft-banner conflict-bar" role="status"><p>This workspace was changed in another tab.</p><button type="button" className="primary" onClick={()=>void loadLatest()}>Load latest</button><button type="button" onClick={()=>void (pendingDraft?copyWithDraft():copyConflict())}>Restore as a copy</button></div>}
    <CanvasEditor yamlDeletionWarnings={yamlDeletionWarnings} onYamlDelete={deleteYamlStep} initialView={initialCanvasView} cards={cardPositions} onCardPosition={(card,position)=>rememberView({cards:{[card]:position}})} picker={{token,deviceId,disabled:running||submitting||launchBusy,onBusy:setPickerBusy}} onViewChange={next=>rememberView({canvas:next})} onRepairSource={ownerId=>setSourceRepair({ownerId})} scenarios={definitions} scenarioId={scenarioId} scenarioMode={!legacyCanvas} onRun={simulatorConnected&&!draftInvalid?()=>void submit(true):undefined} key={'canvas-'+loadRevision} yaml={yaml} onYamlChange={setYaml} graph={canvas} onChange={setCanvas} catalog={catalog} diagnostics={canvasDiagnostics} pathId={selectedScenario?.pathId??pathId} onPathChange={id=>{setPathId(id);if(selectedScenario)setDefinitions(current=>current.map(item=>item.id===scenarioId?{...item,pathId:id}:item));rememberView({pathId:id});}} disabled={submitting||pickerBusy||launchBusy} run={run?.snapshot.workspaceId===workspaceId?{status:run.status,canvas:run.canvas}:undefined} draftInvalid={draftInvalid} runScripts={runScripts} reservedLines={placements.filter(item=>item.target==='yaml'&&item.line).map(item=>item.line!)}/>
    </>}
    </div></div>
    {!noWorkspace&&<>

    <details ref={advanced} className="workspace-advanced" onToggle={event=>rememberView({panels:{advanced:(event.currentTarget as HTMLDetailsElement).open}})}><summary>Advanced mode · legacy authoring and settings</summary><button className="confirm" onClick={()=>{setLegacyCanvas(value=>!value);if(advanced.current)advanced.current.open=false;}}>{legacyCanvas?'Return to contextual canvas':'Show legacy canvas controls'}</button>
    <ScenarioLibrary key={'scenarios-'+loadRevision} items={definitions} onChange={setDefinitions} selected={scenarioId} onSelect={selectScenario} catalog={catalog} files={(()=>{try{return Object.keys(JSON.parse(flows));}catch{return [];}})()} canvas={canvas} automation={automation} mock={mock} disabled={running||submitting||pickerBusy||launchBusy} onError={setDefinitionError} inputAlert={inputReserved?{message:inputReserved.reason.message,testId:inputReserved.reason.kind==='reserved-input'?'reserved-input-error':'reserved-variable-error'}:undefined}/>
    <MockSetup key={loadRevision} initialPlan={loadedMock} disabled={running||submitting||pickerBusy} onChange={setMockPlan}/>
    <div className="scenario-editor">
      <label htmlFor="expected-page">Expected page text for reusable assertion</label><input id="expected-page" value={expectedPage} onChange={event=>setExpectedPage(event.target.value)} disabled={running||submitting||pickerBusy}/><button className="confirm" disabled={running||submitting||pickerBusy} onClick={addAssertion}>Append reusable assertion</button>
      <label htmlFor="reusable-flows">Reusable YAML flows (JSON filename → YAML)</label><textarea id="reusable-flows" value={flows} onChange={event=>setFlows(event.target.value)} disabled={running||submitting||pickerBusy} spellCheck={false} aria-invalid={flowReserved?true:undefined}/>{flowReserved&&<p className="script-inline-error" data-testid="reserved-variable-error" role="alert">✕ {flowReserved.reason.message}{flowReserved.line?' · line '+flowReserved.line:''}</p>}
      <div className="label-row"><span>Executable flow</span><button className="text-button" disabled={!bundleId || pickerBusy || submitting} onClick={() => setYaml(`appId: ${bundleId}\n---\n- launchApp\n- assertVisible: Home\n`)}>Use launch app ID</button></div>
      <DefaultActions key={'automation-'+loadRevision} value={automation} onChange={setAutomation} catalog={catalog} files={(()=>{try{return Object.keys(JSON.parse(flows));}catch{return [];}})()} disabled={pickerBusy||submitting} onError={setAutomationError}/>
      {(automation||selectedScenario||canvas)&&<><button type="button" className="confirm" disabled={pickerBusy||submitting||!!automationError} onClick={async()=>{const found=reservedPlacements({yaml,flows,scenarios:definitions,runtimeText:inputs});if(found.length){setReservedVisible(true);return;}try{const source=JSON.stringify({yaml,flows,automation,definitions,scenarioId,resetApp,inputs,canvas,pathId});const result=await api('/api/automation/preview',{yaml,flows:JSON.parse(flows),automation,canvas,mock,pathId,scenarios:definitions,scenarioId:definitions.length?scenarioId:undefined,resetApp,runtimeInputs:inputs.trim()?JSON.parse(inputs):undefined});setPreview({source,yaml:result.executionYaml});setError('');}catch(error){setError(error instanceof Error?error.message:'Cannot preview execution.');}}}>Preview execution YAML</button>{preview&&<details open><summary>Derived execution preview{preview.source!==JSON.stringify({yaml,flows,automation,definitions,scenarioId,resetApp,inputs,canvas,pathId})?' · outdated, refresh before running':''}</summary><pre className="execution-yaml">{preview.yaml}</pre></details>}</>}
      <YamlEditor key={loadRevision} yaml={yaml} onChange={setYaml} disabled={pickerBusy||submitting} deletionWarnings={yamlDeletionWarnings} onDelete={deleteYamlStep} reservedLines={placements.filter(item=>item.target==='yaml'&&item.line).map(item=>item.line!)}/>

      <p className="field-hint">Reusable files declared above are snapshotted with the scenario; other external files and custom artifact paths are unsupported. Edits during a run apply to the next run.</p>
      <label className="checkbox-label"><input type="checkbox" checked={resetApp} disabled={running||submitting||pickerBusy||!selectedScenario} onChange={event=>setResetApp(event.target.checked)}/>Reset app data before setup (default: No)</label><p className="field-hint">No preserves app data and relaunches before declared setup. Setup must establish required app/session state. Reset clears app data; it does not clear the simulator Keychain or server-side sessions.</p>
      <label htmlFor="runtime-inputs">Confidential runtime inputs (optional JSON)</label><input id="runtime-inputs" type="password" value={inputs} aria-invalid={runtimeReserved?true:undefined} onChange={event => setInputs(event.target.value)} autoComplete="off" placeholder={'{"PASSWORD":"value"}'} />{runtimeReserved&&<p className="script-inline-error" data-testid={runtimeReserved.reason.kind==='reserved-input'?'reserved-input-error':'reserved-variable-error'} role="alert">✕ {runtimeReserved.reason.message}</p>}
      <p className="field-hint">Use uppercase names and reference them as ${'{NAME}'} in YAML. Values are never saved. Runs with inputs withhold raw logs and images. Keep secrets out of authored YAML.</p>
    </div></details>
      {error && <div role="alert" className="notice error">{error}</div>}

    <details className="report-tools"><summary>Reports &amp; evidence</summary>      {batch&&batch.workspaceId===workspaceId&&<section aria-label="Batch report" aria-live="polite"><h3>Batch · {batch.status}</h3><p>Saved order · separate reports · {batch.snapshot.resetApp?'Declared app reset':'No additional app reset'}</p>{(batchLines??batch.entries).map(entry=>{const summary=batchSummary(entry);return <div key={entry.scenarioId} className={summary.tone==='trust'?'batch-script-untrusted':summary.tone==='failed'?'batch-script-failed':undefined} data-testid={summary.testId}><p>{entry.name} · {summary.statusText}</p>{summary.reason&&<p>{batchReasonLabel(summary)}</p>}{entry.runId&&<button className="confirm" onClick={()=>void openReport(entry.runId!)}>Open report for {entry.name}</button>}</div>;})}</section>}    {reports.some(item=>item.snapshot.workspaceId===workspaceId)&&<nav aria-label="Scenario reports"><p>Reports from this workspace session · selecting a scenario leaves the inspected report open.</p>{reports.filter(item=>item.snapshot.workspaceId===workspaceId).map((item,index)=><button className="confirm" key={item.id} disabled={submitting} aria-pressed={run?.id===item.id} onClick={()=>setRun(item)}>{item.snapshot.scenario?.name??item.snapshot.name} · {item.status} · Run {index+1}</button>)}</nav>}<div className="scenario-result" aria-live="polite">
      {workspaceId && <details><summary>Workspace diagnostic details</summary><p className="artifact-id">Workspace: {workspaceId}</p></details>}
      {!run ? <div className="empty-state"><h3>Your scenario result</h3><p>Run a saved flow on the selected simulator to see its real outcome and artifacts.</p></div> : <>
        {run.snapshot.expectedPath && <div className="expected-path"><span>{run.snapshot.expectedPath.from}</span><span>→</span><span>Expected: {run.snapshot.expectedPath.to} · {run.status}</span></div>}
        {run.mock && <div className="mock-evidence"><h3>Mock intent: {run.mock.intent.status}</h3><p>{run.mock.intent.method.toUpperCase()} /{run.mock.intent.endpoint} · HTTP {run.mock.intent.httpStatus}</p><p>{run.mock.intent.failureSemantics}</p><h3>Observed requests: {run.mock.evidence.status}</h3><p className="field-hint">{run.mock.evidence.detail}</p>{run.mock.evidence.transactions.map((transaction,index)=><p key={index}>{transaction.method.toUpperCase()} {transaction.path} → {transaction.statusCode} {transaction.proxied?'(forwarded)':'(mocked)'}</p>)}<p>Mock cleanup: {run.mock.cleanup.detail}</p></div>}
        <div className="label-row"><h3>{run.snapshot.name}</h3><span className={'result-tag ' + run.status}>{run.status}</span></div>
        {run.error && <div className="notice error"><RedactedText text={run.error}/></div>}
        <p>Cleanup ({run.status==='running' ? 'pending' : run.cleanup.verified ? 'verified' : 'failed'}): {run.cleanup.detail}</p>
        {run.automation&&<details open><summary>Setup and default action outcomes</summary><p>Setup: {run.automation.setup.status}</p>{run.automation.actions.map(action=><p key={action.id+':'+action.beforeStep}>{action.name} · before step {action.beforeStep+1}: {action.status} · {action.detail}</p>)}</details>}
        {run.snapshot.executionYaml&&<details><summary>Derived execution YAML</summary><pre className="execution-yaml">{run.snapshot.executionYaml}</pre></details>}
        <ExecutedCanvas key={run.id} run={run} onArtifact={name=>void inspect(name)}/>
        <p className="field-hint">{run.mappingNote}</p>
        <ol className="step-results">{run.steps.map(step => {const evidence=typeof step.detail==='string'&&step.detail?step.detail:typeof step.actual==='string'?step.actual:'';return <li key={step.id}><code>{step.command}</code><span className={'outcome '+step.status}>{step.status}</span>{evidence&&<span className="step-evidence"><RedactedText text={evidence}/></span>}</li>;})}</ol>
        {run.expectedFailure && <details open><summary>Failed expected assertion</summary><pre>{JSON.stringify(run.expectedFailure, null, 2)}</pre></details>}
        <details><summary>Executed snapshot &amp; versions</summary><p className="artifact-id">Run: {run.id}<br />Snapshot: {run.snapshot.id}<br />Maestro: {run.snapshot.toolVersions.maestro} · Node: {run.snapshot.toolVersions.node}</p><pre>{run.snapshot.yaml}</pre>{Object.entries(run.snapshot.flows??{}).map(([name,yaml])=><div key={name}><h4>{name}</h4><pre>{yaml}</pre></div>)}<p>{run.snapshot.scenario&&<>Scenario: {run.snapshot.scenario.name} · Reset app: {run.snapshot.resetApp?'Yes':'No'} · Declared setup: {run.snapshot.scenario.setup?.file??'Ordinary app launch'}</>}</p><p>{run.snapshot.runtimeInputPolicy}</p></details>
        <details id="run-log" open={run.status !== 'passed'}><summary>Raw runner log</summary><pre>{run.log?<RedactedText text={run.log}/>:'Waiting for Maestro to finish…'}</pre></details>
        <div className="artifact-list">{run.artifacts.map(name => <button className="text-button" key={name} disabled={submitting || run.status==='running'} onClick={() => void inspect(name)}>{name}</button>)}</div>
        {artifact && <div className="artifact-view"><p className="artifact-id">{artifact.name}</p>{artifact.image ? <img className="device-screen" src={artifact.image} alt="Captured failure screen" /> : <pre>{artifact.text}</pre>}</div>}
      </>}
    </div>
    </details>
    {scenarioNotice&&<div className="scenario-delete-notice" role="status"><span>{scenarioNotice}</span><button className="text-button" onClick={()=>setScenarioNotice('')}>Dismiss</button></div>}
    {deletedScenario&&<div className="scenario-delete-notice" role="status"><span>Deleted {deletedScenario.name}</span><button className="confirm" disabled={running||submitting||pickerBusy||launchBusy} onClick={()=>{deletedScenario.restore();setDeletedScenario(undefined);}}>Undo</button><button className="text-button" onClick={()=>setDeletedScenario(undefined)}>Dismiss</button></div>}
    {saveProblem&&!conflict&&<div className="notice error" role="alert"><p>{saveProblem}</p><button className="save-retry" onClick={()=>{failedKey.current='';failedDraftKey.current='';setSaveFailed(false);setDraftFailed(false);setRetrySave(value=>value+1);}}>Retry</button></div>}
    {runError&&<div className="run-error-toast" role="alert"><button className="text-button" aria-label="Dismiss run error" onClick={()=>setRunError('')}>×</button><strong>Cannot run scenario</strong><p>{runError}</p></div>}
    </>}
  </section></YamlDraftProvider></RecoveredFields.Provider></WorkspaceDrafts.Provider>;
}
