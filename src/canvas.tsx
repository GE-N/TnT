import {connectVisitAction,connectionVisitActions,freezeVisitOperations,visitOperations,updateVisitOperations,privateVisitOperation,refreshChecks,writeChecks,backControl,canvasTestLabel,connectCanvasAction,appendCanvasConnection,edgeActions,routeVisits,visitChecks,visitScreenId,screenChecks,appendRouteTransition,isAuthored,type ScreenCheck} from '../shared/canvas-authoring.js';
import {useEffect,useId,useRef,useState,type ReactNode,type MouseEvent} from 'react';
import type {YAMLReference,CanvasGraph,CanvasTest,CanvasDiagnostic,CanvasResult,CatalogEntry,ScreenNode} from '../server/canvas.js';

export const emptyCanvas=():CanvasGraph=>({screens:[],edges:[],paths:[]});
const identity=()=>crypto.randomUUID();
function DeleteIcon(){return <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>;}
function draftNavigationAction():CanvasTest{return {id:identity(),label:'Tap action',role:'action',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'},tap:{target:'text',match:'exact',value:''}};}
function draftScreenCheck():CanvasTest{return {id:identity(),label:'Screen check',role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'},check:{visibility:'visible',target:'text',match:'exact',value:''}};}
function NodeTitle({title,onRename,onSelect}:{title:string;onRename:(title:string)=>void;onSelect?:()=>void}){
 const [draft,setDraft]=useState(title);
 useEffect(()=>setDraft(title),[title]);
 return <input className="screen-node-title" aria-label={'Screen title for '+title} title="Edit screen title · Enter to save · Escape to cancel" value={draft} maxLength={120} onFocus={onSelect} onChange={event=>setDraft(event.target.value)} onBlur={()=>{const next=draft.trim();if(next&&next!==title)onRename(next);setDraft(next||title);}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}if(event.key==='Escape'){event.preventDefault();setDraft(title);}}}/>;
}
function NodeInfo({screen,disabled,error,onImage,onRemove,onClose}:{screen:ScreenNode;disabled:boolean;error:string;onImage:(file?:File)=>void;onRemove:()=>void;onClose:()=>void}){
 const dialog=useRef<HTMLElement>(null);
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null;
  dialog.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
  return()=>{const node=Array.from(document.querySelectorAll<HTMLElement>('[data-screen-id]')).find(node=>node.dataset.screenId===screen.id);(node??(previous?.isConnected?previous:undefined))?.focus();};
 },[screen.id]);
 return <div className="node-info-backdrop" onPointerDown={event=>{if(event.target===event.currentTarget)onClose();}}><section ref={dialog} className="node-info-popup" role="dialog" aria-modal="true" aria-label={'Node info for '+screen.title} onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}
  if(event.key==='Tab'){
   const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'));
   const first=controls[0];const last=controls.at(-1);
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
 }}><div className="label-row"><h3>Node info · {screen.title}</h3><button className="text-button" onClick={onClose} aria-label="Close node info">Close</button></div>
 <label>Reference screenshot<input type="file" accept="image/png,image/jpeg" disabled={disabled} onChange={event=>onImage(event.target.files?.[0])}/></label>
 <p className="field-hint">Optional PNG or JPEG, up to 250 KB. Reference images describe a screen.</p>
 {screen.referenceScreenshot&&<><img className="node-info-reference" src={screen.referenceScreenshot} alt={'Reference for '+screen.title}/><button className="confirm" disabled={disabled} onClick={onRemove}>Remove reference image</button></>}
 {error&&<p className="notice error" role="alert">{error}</p>}
 </section></div>;
}
const referenceLabel=(reference:YAMLReference)=>reference.kind==='setup'?'Setup · '+reference.file:reference.kind==='handler'?`Handler ${reference.actionId} · before step ${(reference.index??0)+1} · ${reference.file}`:reference.kind==='flow'?reference.file:`step ${(reference.index??0)+1}`;
export function CanvasBoard({graph,pathId,result,onMove,onSelect,selected,renderChecks,onDelete,onRename,onAdd,onRun,onInfo,onAppend}: {onAppend?:(id:string)=>void;onInfo?:(id:string)=>void;graph:CanvasGraph;pathId?:string;result?:CanvasResult;onMove?:(id:string,x:number,y:number)=>void;onSelect?:(id:string)=>void;selected?:string;renderChecks?:(screenId:string)=>ReactNode;onDelete?:(id:string)=>void;onRename?:(id:string,title:string)=>void;onAdd?:(x:number,y:number)=>void;onRun?:()=>void}){
 const [zoom,setZoom]=useState(.85);
 const [contextMenu,setContextMenu]=useState<{left:number;top:number;x:number;y:number;screenId?:string}>();
 const menu=useRef<HTMLDivElement>(null);
 const contextTarget=useRef<HTMLElement|null>(null);
 useEffect(()=>{
  if(!contextMenu)return;
  menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  function dismiss(event:Event){if(event.type==='pointerdown'&&menu.current?.contains(event.target as Node))return;setContextMenu(undefined);}
  function escape(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();setContextMenu(undefined);contextTarget.current?.focus();}}
  document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape);window.addEventListener('resize',dismiss);window.addEventListener('scroll',dismiss,true);
  return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape);window.removeEventListener('resize',dismiss);window.removeEventListener('scroll',dismiss,true);};
 },[contextMenu]);
 function openMenu(event:MouseEvent<HTMLElement>,screenId?:string){
  if(screenId?!onDelete&&!onInfo&&!onAppend:!onAdd&&!onRun)return;
  event.preventDefault();event.stopPropagation();
  const bounds=surface.current!.getBoundingClientRect();
  const target=event.currentTarget.getBoundingClientRect();
  const left=event.clientX||target.left+20;const top=event.clientY||target.top+20;
  const menuHeight=20+40*(screenId?[onAppend,onInfo,onDelete]:[onAdd,onRun]).filter(Boolean).length;
  contextTarget.current=event.currentTarget;
  setContextMenu({screenId,left:Math.max(8,Math.min(window.innerWidth-188,left)),top:Math.max(8,Math.min(window.innerHeight-menuHeight,top)),x:Math.max(0,Math.min(2400,(left-bounds.left)/zoom)),y:Math.max(0,Math.min(1400,(top-bounds.top)/zoom))});
 }

 const surface=useRef<HTMLDivElement>(null);const [nodeHeights,setNodeHeights]=useState<Record<string,number>>({});
 useEffect(()=>{
  if(typeof ResizeObserver==='undefined')return;
  const observer=new ResizeObserver(entries=>{setNodeHeights(previous=>{const next={...previous};let changed=false;for(const entry of entries){const id=(entry.target as HTMLElement).dataset.screenId!;const height=entry.borderBoxSize[0]?.blockSize??entry.contentRect.height+2;if(next[id]!==height){next[id]=height;changed=true;}}return changed?next:previous;});});
  surface.current?.querySelectorAll('[data-screen-id]').forEach(element=>observer.observe(element));
  return()=>observer.disconnect();
 },[graph.screens]);
 const boardHeight=Math.max(1650,...graph.screens.map(screen=>screen.y+(nodeHeights[screen.id]??200)+120));const marker=useId().replaceAll(':','');
 const drag=useRef<{id:string;x:number;y:number;clientX:number;clientY:number}|undefined>(undefined);
 const route=graph.paths.find(path=>path.id===pathId);const visits=route?routeVisits(graph,route):[];const selectedEdges=new Set(route?.edgeIds??[]);
 const selectedScreens=new Set(graph.edges.filter(edge=>selectedEdges.has(edge.id)).flatMap(edge=>[edge.from,edge.to]));
 if(route?.screenId)selectedScreens.add(route.screenId);
 function color(status?:string){return status==='passed'?'#c7ed88':status==='failed'?'#ef9b88':status==='skipped'?'#d8bc75':'#a7c8ed';}
 return <div className="canvas-board-wrap"><div className="canvas-toolbar"><span>Drag screen headers · scroll to pan{onAdd&&' · Right-click for node options'}</span><button onClick={()=>setZoom(value=>Math.max(.4,value-.1))} aria-label="Zoom out">−</button><span>{Math.round(zoom*100)}%</span><button onClick={()=>setZoom(value=>Math.min(1.4,value+.1))} aria-label="Zoom in">+</button><button onClick={()=>setZoom(.85)}>Reset zoom</button></div>
 <div className="canvas-viewport" role="region" aria-label={result?'Executed screen canvas':'Screen test canvas'}><div style={{width:2700*zoom,height:boardHeight*zoom}}><div className="canvas-surface" tabIndex={onAdd||onRun?0:undefined} onContextMenu={event=>openMenu(event)} ref={surface} style={{height:boardHeight,transform:`scale(${zoom})`}}>
 <svg className="canvas-lines" width="2700" height={boardHeight} aria-label="Screen transitions"><defs><marker id={marker} viewBox="0 0 8 8" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" refX="7" refY="4" orient="auto"><path d="M1,1 L7,4 L1,7" fill="none" stroke="context-stroke" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></marker></defs>{graph.edges.map(edge=>{
 const from=graph.screens.find(screen=>screen.id===edge.from);const to=graph.screens.find(screen=>screen.id===edge.to);if(!from||!to)return null;
 const parallel=graph.edges.filter(item=>item.from===edge.from&&item.to===edge.to||item.from===edge.to&&item.to===edge.from);const offset=parallel.indexOf(edge)*64;const forward=to.x>=from.x;const start=[from.x+(forward?258:-8),from.y+58+offset];const end=[to.x+(forward?-8:258),to.y+58+offset];const middle=(start[0]+end[0])/2;const status=result?.edges.find(item=>item.id===edge.id)?.status;
 return <g key={edge.id} role="img" aria-label={'Connection '+from.title+' to '+to.title} className={selectedEdges.has(edge.id)?'selected-transition':'unselected-transition'}><path d={`M${start[0]},${start[1]} C${middle},${start[1]} ${middle},${end[1]} ${end[0]},${end[1]}`} stroke={selectedEdges.has(edge.id)?color(status):'#506257'} strokeWidth={selectedEdges.has(edge.id)?1.25:1} fill="none" markerEnd={`url(#${marker})`} strokeDasharray={selectedEdges.has(edge.id)?undefined:'6 5'}/><foreignObject x={middle-80} y={Math.max(4,(start[1]+end[1])/2-72)} width="160" height="48"><div className="transition-label">{edge.responseCondition}{selectedEdges.has(edge.id)&&<small>{status??'Visits '+route!.edgeIds.flatMap((id,index)=>id===edge.id?[index+1+' → '+(index+2)]:[]).join(', ')}</small>}</div></foreignObject></g>;
 })}</svg>
 {graph.screens.map(screen=>{const outcome=result?.screens.find(item=>item.id===screen.id)?.status;return <article key={screen.id} data-screen-id={screen.id} className={'screen-node '+(selectedScreens.has(screen.id)?'on-route ':'')+(selected===screen.id?'selected-screen':'')} style={{left:screen.x,top:screen.y,borderColor:selectedScreens.has(screen.id)?color(outcome):undefined}} aria-label={'Screen '+screen.title} tabIndex={onDelete||onInfo?0:undefined} onContextMenu={event=>openMenu(event,screen.id)}>
 <button className="screen-node-heading" aria-label={'Select screen '+screen.title} onClick={()=>onSelect?.(screen.id)} onPointerDown={event=>{if(!onMove||event.button!==0)return;event.currentTarget.setPointerCapture(event.pointerId);drag.current={id:screen.id,x:screen.x,y:screen.y,clientX:event.clientX,clientY:event.clientY};}} onPointerMove={event=>{const current=drag.current;if(!current||current.id!==screen.id)return;onMove?.(screen.id,Math.max(0,Math.min(2400,current.x+(event.clientX-current.clientX)/zoom)),Math.max(0,Math.min(1400,current.y+(event.clientY-current.clientY)/zoom)));}} onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}} onKeyDown={event=>{const vectors:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};const direction=vectors[event.key];if(!direction||!onMove)return;event.preventDefault();const amount=event.shiftKey?40:10;onMove(screen.id,Math.max(0,Math.min(2400,screen.x+direction[0]*amount)),Math.max(0,Math.min(1400,screen.y+direction[1]*amount)));}}><span className="screen-icon">▣</span><span><span className={onRename?'screen-title-placeholder':undefined}>{screen.title}</span><small>{screen.tests.length} {screen.tests.length===1?'step':'steps'}</small></span><span className="node-handle"/></button>
 {onRename&&<NodeTitle title={screen.title} onRename={title=>onRename(screen.id,title)} onSelect={()=>onSelect?.(screen.id)}/>}
 {screen.referenceScreenshot&&<img className="screen-reference" src={screen.referenceScreenshot} alt={'Reference for '+screen.title}/>}
 <div className="canvas-visit-numbers">{visits.map((visit,index)=>visitScreenId(graph,route!,index)===screen.id?<span key={visit.id}>Visit {index+1}</span>:null)}</div><div className="screen-test-list">{renderChecks?.(screen.id)}{screen.tests.filter(test=>!renderChecks||!isAuthored(test)).map(test=><div key={test.id} className="screen-test"><span>{canvasTestLabel(test)}<small>{test.role} · {result?(result.tests.find(item=>item.id===test.id)?.stepId?.replace(/^step-/, 'step ')??'See visit details'):referenceLabel(test.reference)}</small></span><span className={'outcome '+(result?.tests.find(item=>item.id===test.id)?.status??'unavailable')}>{result?.tests.find(item=>item.id===test.id)?.status??'linked'}</span></div>)}{!screen.tests.length&&!renderChecks&&<p>Add an action or check to this screen.</p>}</div>
 </article>;})}
 {!graph.screens.length&&<div className="canvas-empty"><h3>Build your screen map</h3><p>Add a screen and describe its checks. Screen titles are descriptive.</p></div>}
 </div></div></div>
 {contextMenu&&(contextMenu.screenId?onDelete||onInfo||onAppend:onAdd||onRun)&&<div ref={menu} className="canvas-context-menu" role="menu" aria-label={contextMenu.screenId?'Node menu':'Canvas menu'} style={{left:contextMenu.left,top:contextMenu.top}} onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));const index=items.indexOf(document.activeElement as HTMLButtonElement);
  const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
 }}>
 {contextMenu.screenId&&onAppend&&<button role="menuitem" aria-label={'Add '+graph.screens.find(screen=>screen.id===contextMenu.screenId)?.title+' to scenario sequence'} onClick={()=>{setContextMenu(undefined);onAppend(contextMenu.screenId!);}}>Add to sequence</button>}
 {contextMenu.screenId&&onInfo&&<button role="menuitem" onClick={()=>{setContextMenu(undefined);onInfo(contextMenu.screenId!);}}>Node info</button>}
 {(contextMenu.screenId?onDelete:onAdd)&&<button role="menuitem" disabled={!contextMenu.screenId&&graph.screens.length>=40} onClick={()=>{setContextMenu(undefined);if(contextMenu.screenId)onDelete?.(contextMenu.screenId);else onAdd?.(contextMenu.x,contextMenu.y);}}>{contextMenu.screenId?'Delete node':'Add node'}</button>}
 {!contextMenu.screenId&&onRun&&<button role="menuitem" onClick={()=>{setContextMenu(undefined);onRun();}}>Run scenario</button>}
 </div>}
 {result?.visits&&<section aria-label="Visit execution details"><h3>Visit execution details</h3>{result.visits.map((visit,index)=><details key={visit.id} open><summary>Visit {index+1} · {graph.screens.find(screen=>screen.id===visit.screenId)?.title??visit.screenId} · {visit.status}</summary>{result.occurrences?.filter(item=>item.visitId===visit.id).map(item=><p key={item.id}>{graph.screens.flatMap(screen=>screen.tests).find(test=>test.id===item.testId)?.label??item.testId} · {item.status}<small style={{display:'block'}}>{item.detail} {item.stepId}</small></p>)}</details>)}{result.transitions?.map((transition,index)=><p key={transition.id}>Transition {index+1} · {graph.edges.find(edge=>edge.id===transition.edgeId)?.responseCondition??transition.edgeId} · {transition.status}</p>)}</section>}
 </div>;
}

export function CanvasEditor({graph,onChange,catalog,diagnostics,pathId,onPathChange,disabled,yaml,onYamlChange,onRun,scenarioMode=false,scenarioId,scenarios=[]}:{scenarioId?:string;scenarios?:{id:string;name:string;pathId?:string}[];scenarioMode?:boolean;onRun?:()=>void;yaml?:string;onYamlChange?:(yaml:string)=>void;graph:CanvasGraph|undefined;onChange:(graph:CanvasGraph|undefined)=>void;catalog:CatalogEntry[];diagnostics:CanvasDiagnostic[];pathId:string;onPathChange:(id:string)=>void;disabled:boolean}){
 const [pending,setPending]=useState<{graph:CanvasGraph;source?:string;warnings:string[]}>();
 const [undo,setUndo]=useState<{graph:CanvasGraph;yaml?:string;after:CanvasGraph;afterYaml?:string}>();
 const [expandedRow,setExpandedRow]=useState('');
 const [nodeInfoId,setNodeInfoId]=useState('');
 let displayGraph=graph;try{if(graph&&yaml)displayGraph=refreshChecks(graph,yaml);}catch{ /* Retain graph while invalid YAML is repaired. */ }
 graph=displayGraph;
 if(graph&&scenarioMode&&scenarioId)graph={...graph,paths:graph.paths.map(path=>({...path,scenarioId:scenarios.find(item=>item.pathId===path.id)?.id??path.scenarioId}))};
 const [selected,setSelected]=useState('');const [selectedVisit,setSelectedVisit]=useState('');
 const [referenceIndex,setReferenceIndex]=useState('');const [testLabel,setTestLabel]=useState('');const [role,setRole]=useState<CanvasTest['role']>('test');
 const [repairTest,setRepairTest]=useState('');const [from,setFrom]=useState('');const [to,setTo]=useState('');const [action,setAction]=useState('');const [assertion,setAssertion]=useState('');const [condition,setCondition]=useState('');const [pathName,setPathName]=useState('');const [nextEdge,setNextEdge]=useState('');const [error,setError]=useState('');
 const infoScreen=graph?.screens.find(screen=>screen.id===nodeInfoId);
 const screen=graph?.screens.find(screen=>screen.id===selected);const path=graph?.paths.find(path=>path.id===pathId);
 const entry=catalog[Number(referenceIndex)];
 const apiId=useId();
 useEffect(()=>{setSelectedVisit('');setSelected('');},[pathId]);
 const currentGraph=useRef(graph);currentGraph.current=graph;
 const referenceVersion=catalog.map(entry=>entry.fingerprint).join(',');
 useEffect(()=>{setReferenceIndex('');},[referenceVersion]);
 function perform(update:()=>void){try{update();setError('');}catch(error){setError(error instanceof Error?error.message:'Canvas change failed.');}}
 function changeChecks(next:CanvasGraph,deletion=false){
  if(!graph||yaml===undefined||!onYamlChange)throw new Error('Open executable YAML before authoring checks.');
  if(next.screens.some(screen=>screen.tests.length>600)||next.edges.some(edge=>edgeActions(edge).length>600))throw new Error('This node has reached its stored step limit. Remove unused steps before adding more.');
  const nextYaml=writeChecks(yaml,graph,next);next=refreshChecks(next,nextYaml);
  if(deletion)setUndo({graph,yaml,after:next,afterYaml:nextYaml});
  onYamlChange(nextYaml);onChange(next);
 }
 function editOperation(testId:string,visitId:string|undefined,edit:(canvas:CanvasGraph,id:string)=>CanvasGraph){
  perform(()=>{const privateOperation=visitId?privateVisitOperation(graph!,pathId,visitId,testId):{graph:graph!,testId};if(privateOperation.graph.screens.some(screen=>screen.tests.length>600))throw new Error('This node has reached its stored step limit. Remove unused steps before copying more.');changeChecks(edit(privateOperation.graph,privateOperation.testId));});
 }
 function updateOperation(testId:string,visitId:string|undefined,edit:(test:CanvasTest)=>CanvasTest){editOperation(testId,visitId,(canvas,id)=>({...canvas,screens:canvas.screens.map(screen=>({...screen,tests:screen.tests.map(test=>test.id===id?edit(test):test)}))}));}
 function updateCheck(screenId:string,id:string,patch:Partial<ScreenCheck>,visitId?:string){updateOperation(id,visitId,test=>test.back?{...test,backSelector:{...backControl(test)!,...patch}}:test.tap?{...test,tap:{...test.tap,...patch}}:{...test,check:{...test.check!,...patch}});}
 function moveOperation(screenId:string,id:string,neighbor:string,visitId?:string){
  perform(()=>{if(visitId&&path){const next=freezeVisitOperations(graph!);const index=routeVisits(next,path).findIndex(visit=>visit.id===visitId);const ids=[...visitOperations(next,next.paths.find(item=>item.id===pathId)!,index)];const at=ids.indexOf(id);const other=ids.indexOf(neighbor);[ids[at],ids[other]]=[ids[other],ids[at]];changeChecks(updateVisitOperations(next,pathId,visitId,ids));}
  else{const node=graph!.screens.find(screen=>screen.id===screenId)!;const tests=[...node.tests];const at=tests.findIndex(item=>item.id===id);const other=tests.findIndex(item=>item.id===neighbor);[tests[at],tests[other]]=[tests[other],tests[at]];changeChecks({...graph!,screens:graph!.screens.map(screen=>screen.id===screenId?{...screen,tests}:screen)});}});
 }
 function addCheck(screenId:string,visitIndex?:number){
  let next=freezeVisitOperations(graph!);const test={...draftScreenCheck(),scenarioIds:scenarioMode&&scenarioId?[scenarioId]:undefined};
  next={...next,screens:next.screens.map(screen=>screen.id===screenId?{...screen,tests:[...screen.tests,test]}:screen)};
  if(visitIndex!==undefined&&path){const visit=routeVisits(graph!,path)[visitIndex];const current=next.paths.find(item=>item.id===pathId)!;const ids=[...visitOperations(next,current,visitIndex)];const at=ids.findIndex(id=>!next.screens.find(screen=>screen.id===screenId)!.tests.find(test=>test.id===id)?.check);ids.splice(at<0?ids.length:at,0,test.id);next=updateVisitOperations(next,pathId,visit.id,ids);setSelected(screenId);setSelectedVisit(visit.id);}
  changeChecks(next);setExpandedRow(test.id);
 }
 function deleteOperation(screenId:string,test:CanvasTest,visitId?:string,edgeId?:string){
  if(visitId&&path){const next=freezeVisitOperations(graph!);const current=next.paths.find(item=>item.id===pathId)!;const index=routeVisits(next,current).findIndex(visit=>visit.id===visitId);const detached=updateVisitOperations(next,pathId,visitId,visitOperations(next,current,index).filter(id=>id!==test.id));
   const retained=detached.paths.some(item=>routeVisits(detached,item).some((_visit,i)=>visitOperations(detached,item,i).includes(test.id)));
   warn(retained?detached:{...detached,screens:detached.screens.map(screen=>({...screen,tests:screen.tests.filter(item=>item.id!==test.id)})),edges:detached.edges.map(edge=>{const ids=edgeActions(edge).filter(id=>id!==test.id);return edgeActions(edge).includes(test.id)?{...edge,actionTestIds:ids,actionTestId:ids[0]??'pending:'+edge.id}:edge;})},[test.id],screenId,[(scenarios.find(item=>item.id===scenarioId)?.name??'Selected scenario')+' · Visit '+(index+1)]);return;
  }
  const disconnected=!edgeId&&isAuthored(test)&&!test.check?connectCanvasAction(graph!,screenId,test.id,'',pathId).graph:graph!;warn({...disconnected,screens:disconnected.screens.map(screen=>screen.id===screenId?{...screen,tests:screen.tests.filter(item=>item.id!==test.id)}:screen)},[test.id],screenId);
 }
 function warn(next:CanvasGraph,ids:string[],screenId:string,scope?:string[]){if(!graph)return;const warnings=[...graph.paths.filter(path=>path.screenId===screenId||path.edgeIds.some(id=>graph?.edges.some(edge=>edge.id===id&&(edge.from===screenId||edge.to===screenId||edgeActions(edge).some(id=>ids.includes(id))||ids.includes(edge.assertionTestId))))).map(path=>path.name),...graph.edges.filter(edge=>edge.from===screenId||edge.to===screenId||edgeActions(edge).some(id=>ids.includes(id))||ids.includes(edge.assertionTestId)).map(edge=>edge.responseCondition)];setPending({graph:next,source:yaml,warnings:scope??(warnings.length?warnings:['No existing route references; authored checks will be removed.'])});}
 function assignedScenarios(test:CanvasTest){
  if(test.scenarioIds!==undefined)return test.scenarioIds;
  if(test.check)return scenarios.map(item=>item.id);
  const edges=graph!.edges.filter(edge=>edgeActions(edge).includes(test.id));
  return scenarios.filter(item=>graph!.paths.find(path=>path.id===item.pathId)?.edgeIds.some(id=>edges.some(edge=>edge.id===id))).map(item=>item.id);
 }
 function visibleOperation(test:CanvasTest){return !scenarioMode||!scenarioId||assignedScenarios(test).includes(scenarioId);}
 function assignOperation(test:CanvasTest,id:string,include:boolean){
  const ids=assignedScenarios(test);const scenarioIds=include?[...new Set([...ids,id])]:ids.filter(item=>item!==id);
  const owner=scenarios.find(item=>item.id===id);
  const connections=graph!.edges.filter(edge=>edgeActions(edge).includes(test.id));
  let next={...graph!,screens:graph!.screens.map(screen=>({...screen,tests:screen.tests.map(item=>item.id===test.id?{...item,scenarioIds}:item)}))};
  if(include&&!test.check&&connections.length===1){const edge=connections[0];next={...next,paths:next.paths.map(path=>{const tail=visitScreenId(next,path,path.edgeIds.length);return path.id===owner?.pathId&&tail===edge.from&&!path.finished&&!path.edgeIds.includes(edge.id)?{...path,...appendRouteTransition(next,path,edge.id)}:path;})};}
  onChange(next);if(include&&id===scenarioId)setExpandedRow(test.id);
 }
 function setScenarioStart(screenId:string){
  if(!graph||!path||!scenarioId)return;
  const canvas=graph;
  let next:CanvasGraph['paths'][number]={...path,screenId,finished:false,edgeIds:[] as string[],visits:[{id:identity()}]};
  let tail=screenId;
  // Follow only an unambiguous continuation made from this scenario's shared actions.
  while(next.edgeIds.length<80){
   const connections=graph.edges.filter(edge=>edge.from===tail&&edgeActions(edge).some(id=>canvas.screens.find(screen=>screen.id===tail)?.tests.some(test=>test.id===id&&assignedScenarios(test).includes(scenarioId))));
   if(connections.length!==1||next.edgeIds.includes(connections[0].id))break;
   next={...next,...appendRouteTransition(graph,next,connections[0].id)};
   tail=connections[0].to;
  }
  const base=freezeVisitOperations(graph);onChange(freezeVisitOperations({...base,paths:base.paths.map(item=>item.id===pathId?next:item)}));
 }
 function appendConnection(edgeId:string){
  if(!graph||!path||!scenarioId)throw new Error('Select a scenario and choose its start first.');
  if(path.finished)throw new Error('Resume this sequence before adding a visit.');
  const edge=graph.edges.find(edge=>edge.id===edgeId);
  const tail=visitScreenId(graph,path,path.edgeIds.length);
  if(!edge||edge.from!==tail)throw new Error('Choose a connection from the current end '+(graph.screens.find(screen=>screen.id===tail)?.title??'screen')+'.');
  let next=freezeVisitOperations(graph);
  const current=next.paths.find(item=>item.id===pathId)!;const index=current.edgeIds.length;const visit=routeVisits(next,current)[index];
  const ids=connectionVisitActions(next,current,edge);next=updateVisitOperations(next,pathId,visit.id,[...new Set([...visitOperations(next,current,index),...ids])]);
  next={...next,screens:next.screens.map(screen=>({...screen,tests:screen.tests.map(test=>ids.includes(test.id)?{...test,scenarioIds:[...new Set([...assignedScenarios(test),scenarioId])]}:test)})),paths:next.paths.map(item=>item.id===pathId?appendRouteTransition(next,item,edgeId):item)};
  onChange(next);

  setSelected(edge.to);setSelectedVisit(routeVisits(next,next.paths.find(item=>item.id===pathId)!).at(-1)!.id);
 }
 function appendScreen(screenId:string){
  if(!graph||!path?.screenId)throw new Error('Choose this scenario’s start first.');
  const tail=visitScreenId(graph,path,path.edgeIds.length);
  const edges=graph.edges.filter(edge=>edge.from===tail&&edge.to===screenId);
  if(!edges.length)throw new Error('No connection from '+graph.screens.find(screen=>screen.id===tail)?.title+' to '+graph.screens.find(screen=>screen.id===screenId)?.title+'. Draw a connection first.');
  if(edges.length>1)throw new Error('Several connections reach this node. Choose the named connection at the current end.');
  appendConnection(edges[0].id);
 }
 function copyToVisit(screenId:string,test:CanvasTest,index:number){
  let next=freezeVisitOperations(graph!);const current=next.paths.find(item=>item.id===pathId)!;const visit=routeVisits(next,current)[index];const id=identity();
  const copy={...structuredClone(test),id,scenarioIds:scenarioId?[scenarioId]:undefined};next={...next,screens:next.screens.map(screen=>screen.id===screenId?{...screen,tests:[...screen.tests,copy]}:screen)};
  next=updateVisitOperations(next,pathId,visit.id,[...visitOperations(next,current,index),id]);
  const connections=next.edges.filter(edge=>edge.from===screenId&&edgeActions(edge).includes(test.id));
  if(!test.check&&connections.length===1){const edge=connections[0];next={...next,edges:next.edges.map(item=>item.id===edge.id?{...item,actionTestIds:[...edgeActions(item),id]}:item)};next=connectCanvasAction(next,screenId,id,edge.to,pathId).graph;}
  changeChecks(next);setExpandedRow(id);setSelectedVisit(visit.id);setSelected(screenId);
 }
 function membershipControl(test:CanvasTest){return <details className="operation-scenarios"><summary>Scenarios</summary>{scenarios.map(item=><label className="checkbox-label" key={item.id}><input type="checkbox" aria-label={'Use '+canvasTestLabel(test)+' in '+item.name} checked={assignedScenarios(test).includes(item.id)} onChange={event=>perform(()=>assignOperation(test,item.id,event.target.checked))}/>{item.name}</label>)}</details>;}
 function renderChecks(screenId:string,edgeId?:string,visitIndex?:number){const node=graph!.screens.find(screen=>screen.id===screenId);if(!node)return <p>Restore the missing source screen before editing its actions.</p>;const visit=visitIndex!==undefined&&path?routeVisits(graph!,path)[visitIndex]:undefined;const visitIds=visitIndex!==undefined&&path?visitOperations(graph!,path,visitIndex):undefined;const edge=graph!.edges.find(edge=>edge.id===edgeId);const operations=visitIds?visitIds.flatMap(id=>node.tests.filter(test=>test.id===id)):(scenarioMode?node.tests.filter(isAuthored):edge?edgeActions(edge).flatMap(id=>node.tests.filter(test=>test.id===id)):node.tests.filter(test=>isAuthored(test)&&!graph!.edges.some(edge=>edge.actionTestIds?.includes(test.id)))).filter(test=>visitIds!==undefined||visibleOperation(test));const checks=operations.filter(test=>test.check);const taps=operations.filter(test=>!test.check);return <fieldset className={edge?'canvas-checks canvas-navigation-actions':'canvas-checks'} disabled={disabled}>
 {scenarioMode&&!edge&&path?.screenId&&!path.finished&&(visitIndex===undefined||visitIndex===path.edgeIds.length)&&visitScreenId(graph!,path,path.edgeIds.length)===screenId&&graph!.edges.filter(edge=>edge.from===screenId).map(edge=><button key={edge.id} aria-label={'Append connection '+edge.responseCondition} onClick={()=>perform(()=>appendConnection(edge.id))}>Continue → {graph!.screens.find(screen=>screen.id===edge.to)?.title} · {edge.responseCondition}</button>)}{scenarioMode&&!edge&&(visitIndex===undefined||visitIndex===0)&&<button aria-label={'Use '+node.title+' as scenario start'} disabled={!path||path.screenId===screenId} onClick={()=>perform(()=>setScenarioStart(screenId))}>{path?.screenId===screenId?'Scenario start':'Use as scenario start'}</button>}
 {edge&&!scenarioMode&&<><legend>Actions to reach {graph!.screens.find(screen=>screen.id===edge.to)?.title??'Missing screen'}</legend><input aria-label={'Connection name '+edge.id} value={edge.responseCondition} maxLength={300} onChange={event=>onChange({...graph!,edges:graph!.edges.map(item=>item.id===edge.id?{...item,responseCondition:event.target.value}:item)})}/></>}
 {operations.map((test,index)=>{const selector=test.check??test.tap??backControl(test);const name=edge&&!scenarioMode?edge.responseCondition+' action '+(index+1):(!test.check?'Action '+(taps.indexOf(test)+1):'Check '+(checks.indexOf(test)+1));return <div key={test.id} className="canvas-operation" data-operation-id={test.id}>
 {test.check&&!test.check.value&&<p className="field-hint">Screen condition: choose what must be visible or absent when this screen is reached.</p>}
 <details open={expandedRow===test.id?true:undefined} className="canvas-check-row"><summary>{canvasTestLabel(test)}</summary>
 {!test.check&&(!edge||scenarioMode)&&<><p className="field-hint">Destination</p><select aria-label={`${name} destination`} value={graph!.edges.find(edge=>edge.from===screenId&&edgeActions(edge).includes(test.id))?.to??''} onChange={event=>perform(()=>{editOperation(test.id,visit?.id,(canvas,id)=>visit?connectVisitAction(canvas,pathId,visit.id,id,event.target.value):connectCanvasAction(canvas,screenId,id,event.target.value,pathId).graph);})}><option value="">Choose destination screen</option>{graph!.screens.map(screen=><option key={screen.id} value={screen.id}>{screen.title}</option>)}</select></>}
 {scenarioMode&&!test.check&&graph!.edges.filter(edge=>edge.from===screenId&&edgeActions(edge).includes(test.id)&&edgeActions(edge)[0]===test.id).map(edge=><input key={edge.id} aria-label={'Connection name '+edge.id} value={edge.responseCondition} maxLength={300} onChange={event=>onChange({...graph!,edges:graph!.edges.map(item=>item.id===edge.id?{...item,responseCondition:event.target.value}:item)})}/>)}
 {test.check&&<select aria-label={`${name} visibility`} value={test.check.visibility} onChange={event=>updateCheck(screenId,test.id,{visibility:event.target.value as ScreenCheck['visibility']},visit?.id)}><option value="visible">Visible</option><option value="absent">Absent</option></select>}
 {selector&&<><select aria-label={`${name} target`} value={selector.target} onChange={event=>updateCheck(screenId,test.id,{target:event.target.value as ScreenCheck['target']},visit?.id)}><option value="text">Text</option><option value="id">Element identifier</option></select>
 <input aria-label={`${name} selector`} value={selector.value} maxLength={4000} placeholder="Enter selector" onChange={event=>updateCheck(screenId,test.id,{value:event.target.value},visit?.id)}/>
 <select aria-label={`${name} matching`} value={selector.match} onChange={event=>updateCheck(screenId,test.id,{match:event.target.value as ScreenCheck['match']},visit?.id)}><option value="exact">Exact</option><option value="contains">Contains</option><option value="regex">Regex</option></select></>}
 {!test.check&&<select aria-label={`${name} type`} value={test.tap?'tap':test.input!==undefined?'input':'back'} onChange={event=>{const kind=event.target.value;updateOperation(test.id,visit?.id,item=>({...item,tap:kind==='tap'?{target:'text',match:'exact',value:''}:undefined,input:kind==='input'?'':undefined,back:kind==='back'?true:undefined,backSelector:kind==='back'?{target:'text',match:'exact',value:'Back'}:undefined}));}}><option value="tap">Tap</option><option value="input">Input text</option><option value="back">Back</option></select>}
 {test.input!==undefined&&<input aria-label={`${name} text`} value={test.input} maxLength={4000} onChange={event=>updateOperation(test.id,visit?.id,item=>({...item,input:event.target.value}))}/>}
 <button aria-label={`Move ${name.toLowerCase()} up`} disabled={index===0} onClick={()=>moveOperation(screenId,test.id,operations[index-1].id,visit?.id)}>↑</button>
 <button aria-label={`Move ${name.toLowerCase()} down`} disabled={index===operations.length-1} onClick={()=>moveOperation(screenId,test.id,operations[index+1].id,visit?.id)}>↓</button>
 {scenarioMode&&!visit&&scenarios.length>0&&membershipControl(test)}
 <button className="canvas-delete-operation" title="Delete" aria-label={`Delete ${name.toLowerCase()}`} onClick={()=>deleteOperation(screenId,test,visit?.id,edge?.id)}><DeleteIcon/></button>
 </details>
 </div>;})}
 {edge&&<button aria-label={'Add action to connection '+edge.responseCondition} disabled={operations.length>=30||node.tests.length>=600} onClick={()=>perform(()=>addAction(screenId,edge.id))}>Add action</button>}
 {!edge&&<>{!scenarioMode&&graph!.edges.filter(edge=>edge.from===screenId&&edge.actionTestIds!==undefined).map(edge=><div key={edge.id}>{renderChecks(screenId,edge.id)}</div>)}<button aria-label={'Add action to '+node.title} disabled={operations.length>=30||node.tests.length>=600} onClick={()=>perform(()=>addAction(screenId,undefined,visitIndex))}>Add action</button>
 <button aria-label={'Add check to '+node.title} disabled={operations.length>=30||node.tests.length>=600} onClick={()=>perform(()=>addCheck(screenId,visitIndex))}>Add check</button>
{visit&&node.tests.some(test=>isAuthored(test)&&!visitIds?.includes(test.id))&&<details className="unused-operations"><summary>Copy existing steps</summary>{node.tests.filter(test=>isAuthored(test)&&!visitIds?.includes(test.id)).map(test=><button key={test.id} aria-label={'Copy '+canvasTestLabel(test)+' to Visit '+(visitIndex!+1)} onClick={()=>perform(()=>copyToVisit(screenId,test,visitIndex!))}>{canvasTestLabel(test)}</button>)}</details>}
{scenarioMode&&!visit&&scenarioId&&node.tests.some(test=>isAuthored(test)&&!visibleOperation(test))&&<details className="unused-operations"><summary>Use existing actions/checks</summary>{node.tests.filter(test=>isAuthored(test)&&!visibleOperation(test)).map(test=><div key={test.id}><p>{canvasTestLabel(test)}</p>{membershipControl(test)}</div>)}</details>}
</>}
 </fieldset>;}
 function renderVisitSections(screenId:string){
  if(!scenarioMode||!path?.screenId)return renderChecks(screenId);
  const node=graph!.screens.find(screen=>screen.id===screenId)!;
  const visits=routeVisits(graph!,path).map((visit,index)=>({visit,index})).filter(({index})=>visitScreenId(graph!,path,index)===screenId);
  if(!visits.length)return <button className="visit-start-button" disabled={disabled} aria-label={'Use '+node.title+' as scenario start'} onClick={()=>perform(()=>setScenarioStart(screenId))}>Use as scenario start</button>;
  return visits.map(({visit,index})=><section key={visit.id} className={'canvas-visit-section '+(selectedVisit===visit.id?'selected-visit':'')} aria-label={'Visit '+(index+1)+' · '+node.title+' operations'} data-visit-id={visit.id}><button className="visit-section-heading" aria-pressed={selectedVisit===visit.id} onClick={()=>{setSelected(screenId);setSelectedVisit(visit.id);}}>Visit {index+1} · {node.title}<small>{scenarios.find(item=>item.id===scenarioId)?.name}</small></button>{visit.operationIds?.filter(id=>!node.tests.some(test=>test.id===id)).map(id=><div className="visit-step-repair" key={id}><p>This step belongs to the previous destination: {graph!.screens.flatMap(screen=>screen.tests).find(test=>test.id===id)?.label??'Missing step'}. Remove it or restore the destination.</p><button disabled={disabled} onClick={()=>perform(()=>changeChecks(updateVisitOperations(freezeVisitOperations(graph!),pathId,visit.id,visit.operationIds!.filter(item=>item!==id))))}>Remove from this visit</button></div>)}{renderChecks(screenId,undefined,index)}</section>);
 }
 function addScreen(title:string,x=60+(graph!.screens.length%7)*370,y=60+Math.floor(graph!.screens.length/7)*260){
  if(!title.trim())throw new Error('Name the screen.');
  if(graph!.screens.length>=40)throw new Error('This canvas supports up to 40 screens.');
  const id=identity();const initialPath=!scenarioMode&&graph!.screens.length===0?{id:identity(),name:title.trim()+' checks',screenId:id,edgeIds:[]}:undefined;
  onChange({...graph!,screens:[...graph!.screens,{id,title:title.trim(),x,y,tests:[]}],paths:initialPath?[...graph!.paths,initialPath]:graph!.paths});
  if(initialPath)onPathChange(initialPath.id);setSelected(id);
 }
 function deleteScreen(id:string){const node=graph!.screens.find(screen=>screen.id===id)!;warn({...graph!,screens:graph!.screens.filter(screen=>screen.id!==id)},node.tests.map(test=>test.id),id);}
 function addAction(screenId:string,edgeId?:string,visitIndex?:number){
  const node=graph!.screens.find(screen=>screen.id===screenId)!;
  const canvas=freezeVisitOperations(graph!);
  const outgoing=canvas.edges.filter(edge=>edge.from===screenId);
  const edge=canvas.edges.find(edge=>edge.id===edgeId)??(visitIndex!==undefined?canvas.edges.find(edge=>edge.id===path?.edgeIds[visitIndex]):scenarioMode&&outgoing.length===1?outgoing[0]:undefined);
  const test={...draftNavigationAction(),scenarioIds:scenarioMode&&scenarioId?[scenarioId]:undefined};
  const ids=edge?edgeActions(edge):[];const last=node.tests.findIndex(item=>item.id===ids.at(-1));
  const tests=[...node.tests];tests.splice(last<0?tests.length:last+1,0,test);
  let next={...canvas,screens:canvas.screens.map(screen=>screen.id===screenId?{...screen,tests}:screen),edges:canvas.edges.map(item=>item.id===edge?.id?{...item,actionTestId:ids.length?item.actionTestId:test.id,actionTestIds:[...ids,test.id]}:item)};
  if(visitIndex!==undefined&&path){const current=next.paths.find(item=>item.id===pathId)!;const visit=routeVisits(next,current)[visitIndex];next=updateVisitOperations(next,pathId,visit.id,[...visitOperations(next,current,visitIndex),test.id]);setSelectedVisit(visit.id);setSelected(screenId);}
  const connected=edge?connectCanvasAction(next,screenId,test.id,edge.to,pathId):{graph:next,pathId};
  changeChecks(connected.graph);onPathChange(connected.pathId);
  setExpandedRow(test.id);
 }
 function associate(){if(!graph||!screen||referenceIndex===''||!entry)throw new Error('Choose a screen and a current YAML reference.');const test={id:repairTest||identity(),label:testLabel.trim()||entry.label,role,reference:{kind:entry.kind,file:entry.file,index:entry.index,actionId:entry.actionId,fingerprint:entry.fingerprint}};onChange({...graph,screens:graph.screens.map(item=>item.id===screen.id?{...item,tests:repairTest?item.tests.map(existing=>existing.id===repairTest?test:existing):[...item.tests,test]}:item)});setRepairTest('');setTestLabel('');}
 async function image(screenId:string,file?:File){if(!graph||!file)return;try{if(!['image/png','image/jpeg'].includes(file.type)||file.size>250_000)throw new Error('Use a PNG/JPEG reference up to 250 KB.');const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('Reference image could not be read.'));reader.readAsDataURL(file);});const latest=currentGraph.current;if(!latest||!latest.screens.some(item=>item.id===screenId))return;onChange({...latest,screens:latest.screens.map(item=>item.id===screenId?{...item,referenceScreenshot:data}:item)});setError('');}catch(error){setError((error as Error).message);}}
 const selectedOperationIds=graph&&path?.screenId?new Set(routeVisits(graph,path).flatMap((_visit,index)=>visitOperations(graph!,path,index))):undefined;
 const boardGraph=graph&&scenarioMode&&scenarioId?{...graph,screens:graph.screens.map(screen=>({...screen,tests:screen.tests.filter(test=>!isAuthored(test)||(selectedOperationIds?selectedOperationIds.has(test.id):visibleOperation(test)))}))}:graph;
 const visibleDiagnostics=diagnostics.filter(item=>!scenarioMode||!scenarioId||['yaml','flows','automation',pathId].includes(item.ownerId)||graph?.screens.some(screen=>screen.id===item.ownerId||screen.tests.some(test=>test.id===item.ownerId&&visibleOperation(test)))||path?.edgeIds.includes(item.ownerId));
 return <section className="canvas-editor" aria-labelledby="canvas-heading"><div className="label-row"><div><h2 id="canvas-heading">Screen test canvas</h2><p className="field-hint">Add nodes on the canvas. Edit actions and checks inside each node. Right-click a node for info.</p></div>{!scenarioMode&&<button className="confirm" disabled={disabled} onClick={()=>{onChange(graph?undefined:emptyCanvas());onPathChange('');}}>{graph?'Disable canvas':'Create screen canvas'}</button>}</div>
 {graph&&<>
 {!scenarioMode&&<div className="canvas-route-bar"><label htmlFor={apiId+'-path'}>Scenario path</label><select id={apiId+'-path'} value={pathId} disabled={disabled} onChange={event=>onPathChange(event.target.value)}><option value="">Explicitly select a route</option>{graph.paths.map(path=><option key={path.id} value={path.id}>{path.name}</option>)}</select><span>{path?.edgeIds.length??0} selected transitions</span></div>}
 {scenarioMode&&path&&<section className="scenario-sequence-bar" aria-label="Sequence builder">
 <ol aria-label="Scenario sequence">{path.screenId&&routeVisits(graph,path).map((visit,index)=>{const id=visitScreenId(graph!,path,index);const title=graph!.screens.find(screen=>screen.id===id)?.title??'Missing screen';return <li key={visit.id}><button aria-label={'Visit '+(index+1)+' · '+title} aria-pressed={selectedVisit===visit.id} onClick={()=>{setSelected(id??'');setSelectedVisit(visit.id);}}>{index+1} · {title}</button></li>;})}</ol>
 <button disabled={disabled||!path.screenId} onClick={()=>onChange({...graph,paths:graph.paths.map(item=>item.id===pathId?{...item,finished:!item.finished}:item)})}>{path.finished?'Resume sequence':'Finish sequence'}</button><span>{path.finished?'Finished · finite end saved':'Choose the next connection at the current end'}</span>
 </section>}
 <CanvasBoard onAppend={scenarioMode&&path?.screenId&&!path.finished&&!disabled?id=>perform(()=>appendScreen(id)):undefined} graph={boardGraph!} pathId={pathId} selected={selected} onRun={disabled?undefined:onRun} onAdd={disabled?undefined:(x,y)=>perform(()=>addScreen('New screen',x,y))} onRename={disabled?undefined:(id,title)=>onChange({...graph,screens:graph.screens.map(screen=>screen.id===id?{...screen,title}:screen)})} onInfo={disabled?undefined:id=>{setNodeInfoId(id);setSelected(id);setError('');}} onDelete={disabled?undefined:deleteScreen} onSelect={id=>{setSelected(id);setSelectedVisit(path?routeVisits(graph,path).find((visit,index)=>visitScreenId(graph,path,index)===id)?.id??'':'');setRepairTest('');}} renderChecks={yaml!==undefined&&onYamlChange?renderVisitSections:undefined} onMove={disabled?undefined:(id,x,y)=>onChange({...graph,screens:graph.screens.map(screen=>screen.id===id?{...screen,x,y}:screen)})}/>
 {!scenarioMode&&<p className="field-hint">The selected route runs initial checks, ordered connection actions, then destination checks. Other branches are not selected automatically. Unassociated YAML commands remain in execution. Results map after the run; live per-step reporting remains unavailable. Declared setup and checkpoint-specific handler outcomes map after completion.</p>}
 {!scenarioMode&&<div className="canvas-inspectors"><fieldset disabled={disabled}><legend>Advanced YAML associations</legend>
 {!screen&&<p className="field-hint">Select a node on the canvas to edit its YAML associations.</p>}
 {screen&&<>

 <details open={!scenarioMode}><summary>Advanced associations</summary><label htmlFor={apiId+'-repair'}>Associated test to repair</label><select id={apiId+'-repair'} value={repairTest} onChange={event=>{setRepairTest(event.target.value);const test=screen.tests.find(test=>test.id===event.target.value);if(test){setTestLabel(test.label);setRole(test.role);}setReferenceIndex('');}}><option value="">Add a new association</option>{screen.tests.map(test=><option key={test.id} value={test.id}>{canvasTestLabel(test)}</option>)}</select>
 <label htmlFor={apiId+'-test-label'}>Test label</label><input id={apiId+'-test-label'} value={testLabel} onChange={event=>setTestLabel(event.target.value)} maxLength={120}/><label htmlFor={apiId+'-role'}>Test role</label><select id={apiId+'-role'} value={role} onChange={event=>setRole(event.target.value as CanvasTest['role'])}><option value="test">Test</option><option value="action">Triggering action</option><option value="assertion">Destination / shared assertion</option><option value="setup">Setup reference</option><option value="handler">Handler reference</option></select>
 <label htmlFor={apiId+'-yaml-reference'}>Executable YAML reference</label><select id={apiId+'-yaml-reference'} value={referenceIndex} onChange={event=>{setReferenceIndex(event.target.value);const chosen=catalog[Number(event.target.value)];if(chosen?.kind==='setup')setRole('setup');if(chosen?.kind==='handler')setRole('handler');}}><option value="">Choose an explicit command or reusable flow</option>{catalog.map((entry,index)=><option key={entry.kind+entry.file+(entry.index??'')+(entry.actionId??'')} value={index}>{entry.label}{entry.assertion?' · assertion':''}</option>)}</select>{referenceIndex!==''&&entry&&<pre>{entry.preview}</pre>}<button className="confirm" onClick={()=>perform(associate)}>{repairTest?'Explicitly relink test':'Associate test'}</button>
 <details><summary>Discover this screen’s reusable tests</summary>{screen.tests.map(test=><div key={test.id}><strong>{test.label}</strong><p>{test.role} · {referenceLabel(test.reference)}</p>{diagnostics.filter(item=>item.ownerId===test.id).map((item,index)=><p className="reference-error" key={index}>{item.detail}</p>)}</div>)}</details></details>
 </>}
 </fieldset>
 {!scenarioMode&&<><fieldset disabled={disabled}><legend>Connect expected screens</legend><label htmlFor={apiId+'-from'}>Source screen</label><select id={apiId+'-from'} value={from} onChange={event=>{setFrom(event.target.value);setAction('');}}><option value="">Choose source</option>{graph.screens.map(screen=><option key={screen.id} value={screen.id}>{screen.title}</option>)}</select><label htmlFor={apiId+'-action'}>Triggering YAML test</label><select id={apiId+'-action'} value={action} onChange={event=>setAction(event.target.value)}><option value="">Choose source test</option>{graph.screens.find(screen=>screen.id===from)?.tests.filter(test=>!test.check).map(test=><option key={test.id} value={test.id}>{canvasTestLabel(test)}</option>)}</select>
 <label htmlFor={apiId+'-to'}>Expected destination</label><select id={apiId+'-to'} value={to} onChange={event=>{setTo(event.target.value);setAssertion('');}}><option value="">Choose destination</option>{graph.screens.map(screen=><option key={screen.id} value={screen.id}>{screen.title}</option>)}</select><label htmlFor={apiId+'-assert'}>Destination assertion / reusable flow</label><select id={apiId+'-assert'} value={assertion} onChange={event=>setAssertion(event.target.value)}><option value="">Choose destination test</option>{graph.screens.find(screen=>screen.id===to)?.tests.filter(test=>!test.tap).map(test=><option key={test.id} value={test.id}>{canvasTestLabel(test)}</option>)}</select>
 <label htmlFor={apiId+'-condition'}>Response condition / transition explanation</label><input id={apiId+'-condition'} value={condition} onChange={event=>setCondition(event.target.value)} placeholder="Example: HTTP 500 → maintenance" maxLength={300}/><button className="confirm" onClick={()=>perform(()=>{if(!from||!to||!action||!assertion||!condition.trim())throw new Error('Choose both screens, tests and response condition.');onChange(appendCanvasConnection(graph,{id:identity(),from,to,actionTestId:action,assertionTestId:assertion,responseCondition:condition.trim()},pathId));})}>Connect screens</button>
 <ul className="canvas-edge-list">{graph.edges.map(edge=><li key={edge.id}>{graph.screens.find(screen=>screen.id===edge.from)?.title??'Missing screen'} → {graph.screens.find(screen=>screen.id===edge.to)?.title??'Missing screen'}<small>{edge.responseCondition}</small>{yaml!==undefined&&onYamlChange&&edge.actionTestIds===undefined&&renderChecks(edge.from,edge.id)}<button className="text-button" onClick={()=>{const ids=edgeActions(edge);warn({...graph,edges:graph.edges.filter(item=>item.id!==edge.id),screens:graph.screens.map(screen=>({...screen,tests:screen.tests.filter(test=>!ids.includes(test.id))}))},ids,edge.from);}}>Remove transition</button></li>)}</ul>
 </fieldset>
 <fieldset disabled={disabled}><legend>Choose an explicit route</legend><label htmlFor={apiId+'-path-name'}>New scenario path name</label><input id={apiId+'-path-name'} value={pathName} onChange={event=>setPathName(event.target.value)} maxLength={120}/><button className="confirm" onClick={()=>perform(()=>{if(!pathName.trim())throw new Error('Name the scenario path.');const id=identity();onChange({...graph,paths:[...graph.paths,{id,name:pathName.trim(),screenId:selected||undefined,edgeIds:[]}]});onPathChange(id);setPathName('');})}>Create path</button>
 {path&&<><label>Initial screen<select aria-label="Route initial screen" value={path.screenId??''} onChange={event=>onChange({...graph,paths:graph.paths.map(item=>item.id===path.id?{...item,screenId:event.target.value||undefined}:item)})}><option value="">Choose initial screen</option>{graph.screens.map(screen=><option key={screen.id} value={screen.id}>{screen.title}</option>)}</select></label><label htmlFor={apiId+'-next-edge'}>Next transition in selected path</label><select id={apiId+'-next-edge'} aria-label="Next transition" value={nextEdge} onChange={event=>setNextEdge(event.target.value)}><option value="">Choose a transition</option>{graph.edges.map(edge=><option key={edge.id} value={edge.id}>{graph.screens.find(screen=>screen.id===edge.from)?.title??'?'} → {graph.screens.find(screen=>screen.id===edge.to)?.title??'?'} · {edge.responseCondition}</option>)}</select><button className="confirm" onClick={()=>perform(()=>{if(!nextEdge)throw new Error('Choose the next transition.');onChange({...graph,paths:graph.paths.map(item=>item.id===path.id?{...item,...appendRouteTransition(graph,item,nextEdge)}:item)});setNextEdge('');})}>Append transition to path</button><ol>{path.edgeIds.map((id,index)=><li key={index}>{graph.edges.find(edge=>edge.id===id)?.responseCondition??'Missing transition'}<small>{edgeActions(graph.edges.find(edge=>edge.id===id)??{actionTestId:''}).map(id=>graph.screens.flatMap(screen=>screen.tests).find(test=>test.id===id)).map(test=>test?canvasTestLabel(test):'Missing action').join(' → ')}</small> <button className="text-button" onClick={()=>setPending({source:yaml,warnings:[path.name+' · visit '+(index+2)+' and its check selections'],graph:{...graph,paths:graph.paths.map(item=>item.id===path.id?{...item,edgeIds:item.edgeIds.filter((_id,i)=>i!==index),visits:routeVisits(graph,item).filter((_visit,i)=>i!==index+1)}:item)}})}>Remove from path</button></li>)}</ol></>}
 {path&&<div className="canvas-visits">{routeVisits(graph,path).map((visit,index)=>{
 const screenId=visitScreenId(graph,path,index);
 if(visit.operationIds!==undefined)return <fieldset key={visit.id}><legend>Visit {index+1} · {graph!.screens.find(screen=>screen.id===screenId)?.title??'Missing screen'}</legend><p>Edit this visit’s actions and checks in its node section using the contextual canvas.</p></fieldset>;
 const checks=screenChecks(graph,screenId);const selected=visitChecks(graph,path,index);
 function choose(checkIds?:string[]){onChange({...graph!,paths:graph!.paths.map(item=>item.id===path!.id?{...item,visits:routeVisits(graph!,item).map(entry=>entry.id===visit.id?{...entry,checkIds}:entry)}:item)});}
 return <fieldset key={visit.id} aria-label={'Visit '+(index+1)}><legend>Visit {index+1} · {graph!.screens.find(screen=>screen.id===screenId)?.title??'Missing screen'}</legend>
 <select aria-label={'Visit '+(index+1)+' checks'} value={visit.checkIds===undefined?'all':'subset'} onChange={event=>choose(event.target.value==='all'?undefined:selected)}><option value="all">All screen checks</option><option value="subset">Selected checks only</option></select>
 {visit.checkIds!==undefined&&<>{checks.map(test=><label key={test.id}><input type="checkbox" aria-label={'Visit '+(index+1)+' check '+(test.check?.value||test.label)} checked={selected.includes(test.id)} onChange={event=>choose(event.target.checked?[...selected,test.id]:selected.filter(id=>id!==test.id))}/>{canvasTestLabel(test)}</label>)}{selected.filter(id=>!checks.some(test=>test.id===id)).map(id=><p key={id} className="notice error">Missing check: {id} <button onClick={()=>choose(selected.filter(item=>item!==id))}>Remove stale selection</button></p>)}</>}
 </fieldset>;
 })}</div>}
 </fieldset></>}</div>}
 {visibleDiagnostics.length>0&&<div className="notice error" role="alert"><strong>{scenarioMode?'Before running':'References need review'}</strong>{visibleDiagnostics.map((diagnostic,index)=><p key={index}>{graph.screens.flatMap(screen=>screen.tests).find(test=>test.id===diagnostic.ownerId)?.label??graph.screens.find(screen=>screen.id===diagnostic.ownerId)?.title??graph.edges.find(edge=>edge.id===diagnostic.ownerId)?.responseCondition??graph.paths.find(path=>path.id===diagnostic.ownerId)?.name??(scenarioMode?'Scenario':diagnostic.ownerId)}: {diagnostic.detail}</p>)}</div>}
 {pending&&<div role="alertdialog" aria-label="Canvas reference warning" aria-modal="true" className="notice canvas-delete-dialog" onKeyDown={event=>{if(event.key==='Escape')setPending(undefined);}}><p>Deleting this content affects references: {pending.warnings.join(', ')}. Affected references require repair before running.</p><button autoFocus disabled={disabled||pending.source!==yaml} onClick={()=>perform(()=>{if(yaml!==undefined&&onYamlChange)changeChecks(pending.graph,true);else{setUndo({graph:graph!,after:pending.graph});onChange(pending.graph);}setPending(undefined);})}>Delete anyway</button><button onClick={()=>setPending(undefined)}>Cancel deletion</button></div>}
 {undo&&<button disabled={disabled||yaml!==undo.afterYaml||JSON.stringify(graph)!==JSON.stringify(undo.after)} onClick={()=>{if(undo.yaml!==undefined)onYamlChange?.(undo.yaml);onChange(undo.graph);setUndo(undefined);}}>Undo canvas deletion</button>}
 {infoScreen&&<NodeInfo screen={infoScreen} disabled={disabled} error={error} onImage={file=>void image(infoScreen.id,file)} onRemove={()=>onChange({...graph,screens:graph.screens.map(screen=>screen.id===infoScreen.id?{...screen,referenceScreenshot:undefined}:screen)})} onClose={()=>{setNodeInfoId('');setError('');}}/>}
 {error&&!infoScreen&&<div className="notice error" role="alert">{error}</div>}
 </>}
 </section>;
}
