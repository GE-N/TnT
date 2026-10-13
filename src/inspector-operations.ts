import type {CanvasGraph,CanvasTest} from '../server/canvas.js';
import {edgeActions,freezeVisitOperations,routeVisits,updateVisitOperations,visitOperations,visitScreenId} from '../shared/canvas-authoring.js';

/** Append without inheriting a destination; workspace storage order stays unchanged. */
export function appendVisitStep(graph:CanvasGraph,pathId:string,visitId:string,test:CanvasTest):CanvasGraph{
 const next=freezeVisitOperations(graph);const path=next.paths.find(item=>item.id===pathId);
 const index=path?routeVisits(next,path).findIndex(visit=>visit.id===visitId):-1;
 if(!path||index<0)throw new Error('Select a visit before adding a step.');
 const screenId=visitScreenId(next,path,index);const screen=next.screens.find(item=>item.id===screenId);
 if(!screen)throw new Error('Restore the missing screen before adding a step.');
 if(screen.tests.length>=600)throw new Error('This node has reached its stored step limit.');
 if(next.screens.flatMap(item=>item.tests).some(item=>item.id===test.id))throw new Error('Step identity must be unique.');
 return updateVisitOperations({...next,screens:next.screens.map(item=>item.id===screenId?{...item,tests:[...item.tests,test]}:item)},pathId,visitId,[...visitOperations(next,path,index),test.id]);
}

/** The last preceding navigation names the screen on which this step will run. */
export function navigationHint(graph:CanvasGraph,pathId:string,visitId:string,testId:string):{destination:string;firstActionId:string}|undefined{
 const path=graph.paths.find(item=>item.id===pathId);if(!path)return;
 const index=routeVisits(graph,path).findIndex(visit=>visit.id===visitId);if(index<0)return;
 const from=visitScreenId(graph,path,index);const ids=visitOperations(graph,path,index);const at=ids.indexOf(testId);if(at<0)return;
 if(graph.edges.some(edge=>edge.from===from&&edge.to!==from&&edgeActions(edge).includes(testId)))return;
 let hint:ReturnType<typeof navigationHint>;
 for(const id of ids.slice(0,at)){
  const edge=graph.edges.find(edge=>edge.from===from&&edge.to!==from&&edgeActions(edge).includes(id));
  if(edge)hint={firstActionId:hint?.firstActionId??id,destination:graph.screens.find(screen=>screen.id===edge.to)?.title??'Missing screen'};
 }
 return hint;
}

/** Move across every preceding navigating action in a single graph change. */
export function moveAboveNavigation(graph:CanvasGraph,pathId:string,visitId:string,testId:string):CanvasGraph{
 const hint=navigationHint(graph,pathId,visitId,testId);if(!hint)return graph;
 const next=freezeVisitOperations(graph);const path=next.paths.find(item=>item.id===pathId)!;const index=routeVisits(next,path).findIndex(visit=>visit.id===visitId);
 const ids=visitOperations(next,path,index).filter(id=>id!==testId);ids.splice(ids.indexOf(hint.firstActionId),0,testId);
 return updateVisitOperations(next,pathId,visitId,ids);
}
