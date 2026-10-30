import type {CanvasGraph,CanvasTest} from '../server/canvas.js';
import type {DraftOperation,DraftTarget} from '../server/authoring/types.js';
import {edgeActions,routeVisits,visitOperations,visitScreenId} from '../shared/canvas-authoring.js';
import {draftStepText} from './ai-flow.js';

const MASK='••••••';
const GO_TARGET='\u200b';

export function edgeLabelBox(start:{x:number;y:number},end:{x:number;y:number}){
 const width=Math.min(220,Math.max(80,Math.abs(end.x-start.x)-16));
 return {x:(start.x+end.x)/2-width/2,y:Math.max(4,(start.y+end.y)/2-72),width,height:48};
}

function maskedInput(value:string){
 const text=value.trim();
 if(!text)return;
 if(text.includes('${')||text.includes('[redacted]')||/^[•*]+$/.test(text))return MASK;
 return text;
}

function selectorTarget(value:string|undefined,navigates:boolean):DraftTarget{
 const text=value?.trim();
 if(text)return {kind:'selector',selector:{target:'text',match:'exact',value:text}};
 if(navigates)return {kind:'selector',selector:{target:'text',match:'exact',value:GO_TARGET}};
 return {kind:'unresolved',description:''};
}

function stepOf(graph:CanvasGraph,screenId:string,test:CanvasTest){
 if(test.check){
  const value=test.check.value.trim();
  return {operation:{key:test.id,kind:test.check.visibility==='absent'?'checkAbsent':'checkVisible',target:selectorTarget(value,false)} as DraftOperation,destinationTitle:undefined,specified:!!value};
 }
 if(test.input!==undefined){
  const value=maskedInput(test.input);
  return {operation:{key:test.id,kind:'input',value:value?{kind:'literal',text:value}:{kind:'unresolved',description:''}} as DraftOperation,destinationTitle:undefined,specified:!!value};
 }
 if(!test.tap&&!test.back)return;
 const raw=(test.tap?.value??test.backSelector?.value??'').trim();
 const edge=graph.edges.find(item=>item.from===screenId&&item.to!==screenId&&edgeActions(item).includes(test.id));
 const destinationTitle=edge?graph.screens.find(screen=>screen.id===edge.to)?.title:undefined;
 const navigates=!!destinationTitle;
 return {operation:{key:test.id,kind:test.back&&!test.tap?'back':'tap',target:selectorTarget(raw,navigates),destination:navigates?{kind:'visit',visitKey:edge!.to}:{kind:'stay'}} as DraftOperation,destinationTitle:navigates?destinationTitle:undefined,specified:!!raw};
}

export function screenNodeSteps(graph:CanvasGraph,route:CanvasGraph['paths'][number]|undefined,screenId:string){
 if(!route)return [];
 const screen=graph.screens.find(item=>item.id===screenId);
 if(!screen)return [];
 const steps:{text:string;specified:boolean;visit:number}[]=[];
 routeVisits(graph,route).forEach((_visit,index)=>{
  if(visitScreenId(graph,route,index)!==screenId)return;
  for(const id of visitOperations(graph,route,index)){
   const test=screen.tests.find(item=>item.id===id);
   const mapped=test&&stepOf(graph,screenId,test);
   if(!mapped)continue;
   steps.push({text:draftStepText(mapped.operation,steps.length,mapped.destinationTitle),specified:mapped.specified,visit:index});
  }
 });
 return steps;
}
