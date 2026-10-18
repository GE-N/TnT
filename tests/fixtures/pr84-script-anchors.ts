// Anchor helpers copied verbatim from PR #84 src/run-script.ts at
// f56001e5422a97b47eff17a28dc01d6d490d6709, pinned to test UI/server parity.
// Only import paths are adjusted; update this fixture when the UI helper changes.
import type {CanvasGraph} from "../../server/canvas.js";
import type {ScriptAnchor} from "../../server/run-script-contract.js";
import {routeVisits,visitOperations,visitScreenId} from "../../shared/canvas-authoring.js";

export type OrderedStep={id:string;visitId:string;visitIndex:number;globalIndex:number;fingerprint:string};

export function orderedScenarioSteps(graph:CanvasGraph,pathId:string):OrderedStep[]{
  const path=graph.paths.find(item=>item.id===pathId);
  if(!path?.screenId)return [];
  const steps:OrderedStep[]=[];
  routeVisits(graph,path).forEach((visit,visitIndex)=>{
    const screen=graph.screens.find(item=>item.id===visitScreenId(graph,path,visitIndex));
    for(const id of visitOperations(graph,path,visitIndex)){
      const test=screen?.tests.find(item=>item.id===id);
      steps.push({id,visitId:visit.id,visitIndex,globalIndex:steps.length,fingerprint:test?.reference.fingerprint??''});
    }
  });
  return steps;
}


/** Checkpoint fingerprint of the last authored step, plus the end suffix. An empty step list is "end". */
export function endAnchorFingerprint(lastFingerprint?:string){
  return lastFingerprint?lastFingerprint+':end':'end';
}

/** True when the stored anchor still names the current step list. End anchors do not slide forward. */
export function anchorMatches(anchor:ScriptAnchor,steps:OrderedStep[]){
  if(!steps.length)return anchor.index===0&&anchor.fingerprint==='end';
  if(anchor.index===steps.length)return anchor.fingerprint===endAnchorFingerprint(steps[steps.length-1].fingerprint);
  const step=steps[anchor.index];
  return !!step&&anchor.fingerprint===step.fingerprint;
}


/** Anchor before the next authored step, or after the last step when this visit is the end. */
export function anchorForNewScript(steps:OrderedStep[],visitIndex:number):ScriptAnchor{
  const index=steps.filter(step=>step.visitIndex<=visitIndex).length;
  if(index>=steps.length)return {index:steps.length,fingerprint:endAnchorFingerprint(steps.at(-1)?.fingerprint)};
  return {index,fingerprint:steps[index].fingerprint};
}
