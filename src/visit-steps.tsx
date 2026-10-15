import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {parseDocument} from 'yaml';
import type {CanvasGraph,CanvasTest} from '../server/canvas.js';
import {backControl,edgeActions,routeVisits,visitOperations} from '../shared/canvas-authoring.js';
import {FloatingCard,type CardPosition} from './floating-card.js';
import {isCommittableSelector,navigationHint,stepRowLabel} from './inspector-operations.js';
import {Picker} from './picker.js';

export type PickerSession={token:string;deviceId:string;disabled:boolean;onBusy:(busy:boolean)=>void};

function pickedId(selector:string){
 const doc=parseDocument(selector);
 if(doc.errors.length)return;
 const value=doc.toJS();
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const id=(value as {id?:unknown}).id;
 return typeof id==='string'&&id.trim()?id:undefined;
}

const NEW_SCREEN='__new_screen__';
const choices=[{group:'Actions',label:'Tap',command:'tapOn'},{group:'Actions',label:'Input text',command:'inputText'},{group:'Actions',label:'Back',command:'back'},{group:'Checks',label:'assertVisible',command:'assertVisible'},{group:'Checks',label:'assertNotVisible',command:'assertNotVisible'}];
export function AddStepMenu({disabled,onAdd}:{disabled:boolean;onAdd:(command:string)=>void}){
 const [open,setOpen]=useState(false);const [query,setQuery]=useState('');const [active,setActive]=useState(0);const trigger=useRef<HTMLButtonElement>(null);const input=useRef<HTMLInputElement>(null);const cancel=useRef<HTMLButtonElement>(null);const id=useId();
 const filtered=choices.filter(item=>(item.label+' '+item.command).toLowerCase().includes(query.toLowerCase()));
 useEffect(()=>{if(open)input.current?.focus();},[open]);
 function close(){setOpen(false);trigger.current?.focus();}
 return <><button ref={trigger} className="add-visit-step" disabled={disabled} onClick={()=>{setQuery('');setActive(0);setOpen(true);}}>+ Add step</button>{open&&<div role="dialog" aria-label="Add step" aria-modal="true" className="add-step-dialog" onKeyDown={event=>{
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
 if(event.key==='Tab'){event.preventDefault();if(document.activeElement===input.current)cancel.current?.focus();else input.current?.focus();}
 if(event.target!==input.current)return;
 if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(index=>filtered.length?(index+(event.key==='ArrowDown'?1:-1)+filtered.length)%filtered.length:0);}
 if(event.key==='Enter'){event.preventDefault();if(filtered[active]){close();onAdd(filtered[active].command);}}
 }}><label>Find a step<input ref={input} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={id} aria-activedescendant={filtered[active]?id+'-'+active:undefined} value={query} onChange={event=>{setQuery(event.target.value);setActive(0);}}/></label><div role="listbox" id={id} aria-label="Step commands">{['Actions','Checks'].map(group=>filtered.some(item=>item.group===group)&&<div role="group" aria-label={group} key={group}><strong>{group}</strong>{filtered.map((item,index)=>item.group===group&&<button type="button" role="option" id={id+'-'+index} aria-selected={active===index} tabIndex={-1} key={item.command} onClick={()=>{close();onAdd(item.command);}}>{item.label}</button>)}</div>)}{!filtered.length&&<p>No matching steps</p>}</div><button ref={cancel} onClick={close}>Cancel</button></div>}</>;
}

export function VisitStep({graph,pathId,visitId,test,index,name,screenId,last,isNew,moveDisabled,editing,onEdit,onClose,onSave,onDestinationChange,onCreateDestination,onMoveAbove,onMove,onDelete,onDiscard,onDragStart,onDragOver,onDrop,onDragEnd,onDragLeave,dropPosition,picker,sourceYaml,cardPosition,onCardPosition}:{graph:CanvasGraph;pathId:string;visitId:string;test:CanvasTest;index:number;name:string;screenId:string;last:boolean;isNew:boolean;moveDisabled:boolean;editing:boolean;onEdit:()=>void;onClose:()=>void;onSave:(test:CanvasTest,to:string,connectionName?:string,newScreenTitle?:string)=>void;onDestinationChange:(to:string)=>void;onCreateDestination:(title:string)=>void;onMoveAbove:()=>void;onMove:(direction:number)=>void;onDelete:()=>void;onDiscard:()=>void;onDragStart:()=>void;onDragOver:(after:boolean)=>boolean;onDrop:(after:boolean)=>void;onDragEnd:()=>void;onDragLeave:()=>void;dropPosition?:'before'|'after';picker?:PickerSession;sourceYaml?:string;cardPosition?:CardPosition;onCardPosition?:(position:CardPosition)=>void}){
 const [draft,setDraft]=useState(test);const row=useRef<HTMLDivElement>(null);const summary=useRef<HTMLButtonElement>(null);const cancelled=useRef(false);const wasEditing=useRef(false);const [invalid,setInvalid]=useState(false);const errorId=useId();const matchName=useId();
 const [kept,setKept]=useState<{text:string;id:string}>({text:'',id:''});const [pickerOpen,setPickerOpen]=useState(false);const pickerOpenRef=useRef(false);const pickButton=useRef<HTMLButtonElement>(null);const restorePickFocus=useRef(false);const [pickNotice,setPickNotice]=useState('');
 const edge=graph.edges.find(edge=>edge.from===screenId&&edgeActions(edge).includes(test.id));const destination=edge?.to??'';
 const [to,setTo]=useState(destination);const [connectionName,setConnectionName]=useState(edge?.responseCondition);
 const [creating,setCreating]=useState(false);const [newTitle,setNewTitle]=useState('');const titleField=useRef<HTMLInputElement>(null);
 const testKey=JSON.stringify(test);
 useEffect(()=>{
  if(!editing){wasEditing.current=false;setCreating(false);return;}
  const opening=!wasEditing.current;wasEditing.current=true;setDraft(structuredClone(test));setInvalid(false);cancelled.current=false;
  if(opening){setTo(destination);setConnectionName(edge?.responseCondition);setCreating(false);setNewTitle('');const current=test.check??test.tap??backControl(test);setKept({text:current?.target==='text'?current.value:'',id:current?.target==='id'?current.value:''});pickerOpenRef.current=false;setPickerOpen(false);setPickNotice('');const inputs=Array.from(row.current?.querySelectorAll<HTMLInputElement>('input:not([type=radio])')??[]);(inputs.find(input=>!input.value)??inputs[0]??row.current?.querySelector<HTMLElement>('select'))?.focus();}
 },[editing,testKey]);
 useEffect(()=>{if(!editing||isNew)return;setTo(destination);setConnectionName(edge?.responseCondition);},[editing,isNew,destination,edge?.responseCondition]);
 useEffect(()=>{if(creating)titleField.current?.focus();},[creating]);
 const selector=draft.check??draft.tap??backControl(draft);
 const screenTitle=graph.screens.find(screen=>screen.id===screenId)?.title??'Missing screen';
 const destinationTitle=destination?(graph.screens.find(screen=>screen.id===destination)?.title??'Missing screen'):undefined;
 const label=stepRowLabel(test,index+1,destinationTitle,screenTitle);
 const command=label.split(' ')[1];const remainder=label.slice(String(index+1).length+command.length+2);
 const hint=navigationHint(graph,pathId,visitId,test.id);const path=graph.paths.find(item=>item.id===pathId)!;const visitIndex=routeVisits(graph,path).findIndex(visit=>visit.id===visitId);const ids=visitOperations(graph,path,visitIndex);const at=ids.indexOf(test.id);
 const showHint=hint&&(at===0||!navigationHint(graph,pathId,visitId,ids[at-1]));
 const selectValue=creating?NEW_SCREEN:(isNew?to:destination);
 function cancel(){cancelled.current=true;if(isNew){onDiscard();onClose();return;}onClose();summary.current?.focus();}
 function save(restoreFocus=true){
  if(cancelled.current)return;
  if(creating&&!isNew){
   const title=newTitle.trim();
   if(title)onCreateDestination(title);
   setCreating(false);setNewTitle('');onClose();if(restoreFocus)summary.current?.focus();return;
  }
  if(selector&&!isCommittableSelector(selector.value)){setInvalid(true);return;}
  onSave(draft,creating?'':to,connectionName,creating?newTitle:undefined);onClose();if(restoreFocus)summary.current?.focus();
 }
 function patchSelector(patch:Record<string,string>){if(patch.value!==undefined)setInvalid(false);setDraft(item=>item.check?{...item,check:{...item.check,...patch}}:item.tap?{...item,tap:{...item.tap,...patch}}:{...item,backSelector:{...backControl(item)!,...patch}});}
 function switchTarget(target:'text'|'id'){if(!selector||selector.target===target)return;const next={...kept,[selector.target]:selector.value};setKept(next);patchSelector({target,value:next[target]});}
 function openPicker(){if(!picker)return;setPickNotice('');pickerOpenRef.current=true;setPickerOpen(true);}
 function applyPick(value:string){
  const id=pickedId(value);
  if(!id){setPickNotice('This selector has no element id. Choose targeted identifier, then use the selector again.');return;}
  setPickNotice('');setKept(current=>({...current,id}));patchSelector({target:'id',value:id});restorePickFocus.current=true;pickerOpenRef.current=false;setPickerOpen(false);
 }
 function chooseDestination(value:string){
  if(value===NEW_SCREEN){setCreating(true);setNewTitle('');return;}
  setCreating(false);setNewTitle('');
  if(isNew){setTo(value);return;}
  onDestinationChange(value);
 }
 function commitNewScreen(){
  const title=newTitle.trim();
  if(!title)return;
  if(isNew){save(true);return;}
  onCreateDestination(title);setCreating(false);setNewTitle('');
 }
 useEffect(()=>{if(pickerOpen||!restorePickFocus.current)return;restorePickFocus.current=false;pickButton.current?.focus();},[pickerOpen]);
 return <div ref={row} className="canvas-operation visit-step" data-operation-id={test.id} data-drop-position={dropPosition} onDragOver={event=>{const rect=event.currentTarget.getBoundingClientRect();if(onDragOver(event.clientY>=rect.top+rect.height/2)){event.preventDefault();event.dataTransfer.dropEffect='move';}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))onDragLeave();}} onDrop={event=>{event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();onDrop(event.clientY>=rect.top+rect.height/2);}} onKeyDown={event=>{if(!editing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(creating){setCreating(false);setNewTitle('');return;}cancel();}if(event.key==='Enter'&&event.target instanceof window.HTMLInputElement&&event.target.type!=='radio'){if(event.target===titleField.current){event.preventDefault();commitNewScreen();return;}event.preventDefault();save();}}} onBlur={event=>{if(pickerOpenRef.current)return;const next=event.relatedTarget as Element|null;if(document.querySelector('[role=alertdialog]')||(next&&(event.currentTarget.contains(next)||next.closest?.('[role=alertdialog]'))))return;if(editing&&!cancelled.current)save(false);}}>
 <button className="visit-step-drag" aria-label={'Drag step '+(index+1)} title="Drag to reorder within this visit" disabled={moveDisabled||editing} draggable={!moveDisabled&&!editing} onDragStart={event=>{if(moveDisabled||editing){event.preventDefault();return;}event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',test.id);onDragStart();}} onDragEnd={onDragEnd}>⠿</button>
 <button ref={summary} aria-label={'Edit '+name} className="visit-step-summary" onClick={onEdit} aria-expanded={editing}><span>{index+1}</span> <span className="step-command">{command}</span> <span>{remainder}</span></button>
 {<div hidden={!editing} className="visit-inline-fields"><strong>{stepRowLabel(draft,index+1).split(' ')[1]}</strong>{edge&&edgeActions(edge)[0]===test.id&&<details className="connection-name"><summary>Connection name</summary><input aria-label={'Connection name '+edge.id} value={connectionName??''} maxLength={300} onChange={event=>setConnectionName(event.target.value)}/></details>}{selector&&<><div role="radiogroup" aria-label="Match by" className="match-by"><label><input type="radio" name={matchName} value="text" checked={selector.target==='text'} onChange={()=>switchTarget('text')}/>Text</label><label><input type="radio" name={matchName} value="id" checked={selector.target==='id'} onChange={()=>switchTarget('id')}/>Element</label></div><div className="element-field"><input aria-label={name+' selector'} aria-invalid={invalid?true:undefined} aria-describedby={invalid?errorId:undefined} placeholder={selector.target==='id'?'Enter element id':'Enter text'} maxLength={4000} value={selector.value} onChange={event=>{patchSelector({value:event.target.value});setKept(current=>({...current,[selector.target]:event.target.value}));}}/>{selector.target==='id'&&<button ref={pickButton} type="button" className="pick-from-screen" title="Choose an element from the stored capture instead of typing its id." onClick={openPicker}>Pick from screen</button>}</div>{invalid&&<p id={errorId} className="visit-selector-error" role="alert">{draft.tap||draft.back?'✕ Enter an element to tap.':'✕ Enter text to look for.'}</p>}<select aria-label={name+' matching'} value={selector.match} onChange={event=>patchSelector({match:event.target.value})}><option value="exact">Exact</option><option value="contains">Contains</option><option value="regex">Regex</option></select></>}{draft.check&&<select aria-label={name+' visibility'} value={draft.check.visibility} onChange={event=>patchSelector({visibility:event.target.value})}><option value="visible">Visible</option><option value="absent">Absent</option></select>}{draft.input!==undefined&&<input aria-label={name+' text'} value={draft.input} maxLength={4000} onChange={event=>setDraft({...draft,input:event.target.value})}/>}{!draft.check&&<><select aria-label={name+' type'} value={draft.tap?'tap':draft.input!==undefined?'input':'back'} onChange={event=>{const kind=event.target.value;setKept({text:kind==='back'?'Back':'',id:''});setDraft({...draft,tap:kind==='tap'?{target:'text',match:'exact',value:''}:undefined,input:kind==='input'?'':undefined,back:kind==='back'?true:undefined,backSelector:kind==='back'?{target:'text',match:'exact',value:'Back'}:undefined});}}><option value="tap">Tap</option><option value="input">Input text</option><option value="back">Back</option></select><label>Destination<select aria-label={name+' destination'} value={selectValue} onChange={event=>chooseDestination(event.target.value)}><option value="">Stays on this screen</option>{graph.screens.map(screen=><option key={screen.id} value={screen.id}>{screen.title}</option>)}<option value={NEW_SCREEN}>+ New screen…</option></select></label>{creating&&<input ref={titleField} aria-label="New screen title" placeholder="Screen title" maxLength={120} value={newTitle} onChange={event=>setNewTitle(event.target.value)}/>}</>}<button onClick={()=>save()}>Done</button><button onPointerDown={()=>{cancelled.current=true;}} onClick={cancel}>Cancel</button></div>}
 {showHint&&<div className="navigation-hint"><p title={'⚠ This step runs after navigation, on '+hint.destination}>⚠ This step runs after navigation, on {hint.destination}</p><button disabled={moveDisabled} onClick={onMoveAbove}>↑ Move above actions</button></div>}
 <details className="visit-step-actions"><summary aria-label="Step actions" title={name+' actions'}>⋯</summary><button disabled={moveDisabled||index===0} aria-label={'Move '+name.toLowerCase()+' up'} onClick={event=>{event.currentTarget.closest('details')!.open=false;onMove(-1);}}>↑ Move up</button><button disabled={moveDisabled||last} aria-label={'Move '+name.toLowerCase()+' down'} onClick={event=>{event.currentTarget.closest('details')!.open=false;onMove(1);}}>↓ Move down</button><button className="visit-step-delete" aria-label={'Delete '+name.toLowerCase()} onClick={onDelete}><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg> Delete</button></details>
 {pickerOpen&&picker&&selector&&createPortal(<FloatingCard label="Pick from screen" position={cardPosition} onPosition={onCardPosition} opener={pickButton.current} onClose={()=>{pickerOpenRef.current=false;setPickerOpen(false);}}>{pickNotice&&<p className="notice error" role="alert">{pickNotice}</p>}<Picker token={picker.token} deviceId={picker.deviceId} yaml={sourceYaml??''} disabled={picker.disabled} onBusy={picker.onBusy} onSave={async()=>{}} onExecute={async()=>{}} onCheckSelector={applyPick}/></FloatingCard>,document.body)}
 </div>;
}
