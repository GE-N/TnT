import type {CanvasGraph,CanvasResult} from '../server/canvas.js';
import {routeVisits,visitOperations,visitScreenId} from '../shared/canvas-authoring.js';
import type {Run} from '../server/scenarios.js';

export type InspectorStepTone='running'|'passed'|'failed';
export type InspectorStepStatus={tone:InspectorStepTone;detail?:string};
export type InspectorRunView={
 activeVisitId?:string;
 activeEdgeId?:string;
 currentStepId?:string;
 visitStatus:(visitId:string)=>InspectorStepStatus|undefined;
 stepStatus:(visitId:string,testId:string)=>InspectorStepStatus|undefined;
};
/** Canvas only needs status + mapped canvas outcomes — not logs, artifacts, or the full snapshot. */
export type InspectorRunFeed={status:Run['status'];canvas?:CanvasResult};

const runningLabel={tone:'running' as const};
const passedLabel={tone:'passed' as const};

function visitEdgeId(graph:CanvasGraph,pathId:string,visitIndex:number){
 const path=graph.paths.find(item=>item.id===pathId);
 if(!path)return;
 return path.edgeIds[visitIndex]??path.edgeIds[visitIndex-1];
}

/** Derive inspector run feedback from the current run snapshot. Live Maestro progress is unavailable, so a running scenario highlights the first route step. */
export function inspectorRunView(graph:CanvasGraph|undefined,pathId:string|undefined,run:InspectorRunFeed|undefined):InspectorRunView|undefined{
 if(!graph||!pathId||!run?.canvas||run.canvas.pathId!==pathId)return;
 if(run.status==='cancelled')return;
 const path=graph.paths.find(item=>item.id===pathId);
 if(!path?.screenId)return;
 const result:CanvasResult=run.canvas;
 const visits=routeVisits(graph,path);
 const ordered=visits.flatMap((visit,index)=>{
  const ids=visitOperations(graph,path,index);
  return ids.map(testId=>({visitId:visit.id,testId,visitIndex:index}));
 });

 if(run.status==='running'){
  const current=ordered[0];
  const activeVisitId=current?.visitId??visits[0]?.id;
  return {
   activeVisitId,
   activeEdgeId:activeVisitId===undefined?undefined:visitEdgeId(graph,pathId,current?.visitIndex??0),
   currentStepId:current?.testId,
   visitStatus:visitId=>visitId===activeVisitId?runningLabel:undefined,
   stepStatus:(visitId,testId)=>visitId===activeVisitId&&testId===current?.testId?runningLabel:undefined,
  };
 }

 const failedOccurrence=result.occurrences?.find(item=>item.status==='failed');
 const failedVisit=result.visits?.find(item=>item.status==='failed');
 const failedTest=result.tests.find(item=>item.status==='failed');
 const failedFromTest=failedTest&&ordered.find(item=>item.testId===failedTest.id);
 const activeVisitId=failedOccurrence?.visitId??failedVisit?.id??failedFromTest?.visitId;
 const activeIndex=visits.findIndex(visit=>visit.id===activeVisitId);
 const showPassed=run.status==='passed'||!!failedOccurrence||!!failedVisit||!!failedFromTest;

 if(!showPassed&&!activeVisitId)return;

 return {
  activeVisitId,
  activeEdgeId:activeVisitId&&activeIndex>=0?visitEdgeId(graph,pathId,activeIndex):undefined,
  visitStatus:visitId=>{
   if(visitId===activeVisitId)return {tone:'failed',detail:failedOccurrence?.detail??(failedFromTest&&failedFromTest.visitId===visitId?failedTest?.detail:undefined)};
   if(!showPassed)return;
   const visit=result.visits?.find(item=>item.id===visitId);
   if(visit?.status==='passed')return passedLabel;
   if(!result.visits){
    const index=visits.findIndex(item=>item.id===visitId);
    const screenId=visitScreenId(graph,path,index);
    if(result.screens.find(item=>item.id===screenId)?.status==='passed')return passedLabel;
   }
  },
  stepStatus:(visitId,testId)=>{
   const occurrence=result.occurrences?.find(item=>item.visitId===visitId&&item.testId===testId);
   if(occurrence?.status==='failed')return {tone:'failed',detail:occurrence.detail};
   if(occurrence?.status==='passed')return passedLabel;
   if(failedFromTest&&failedFromTest.visitId===visitId&&failedFromTest.testId===testId)return {tone:'failed',detail:failedTest?.detail};
   if(!showPassed)return;
   const test=result.tests.find(item=>item.id===testId);
   if(test?.status==='passed')return passedLabel;
   if(test?.status==='failed')return {tone:'failed',detail:test.detail};
  },
 };
}

export function runStatusLabel(status:InspectorStepTone){
 return status==='running'?'Running':status==='passed'?'✓ Passed':'✕ Failed';
}
