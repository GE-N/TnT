import {RecoveredFields,useWorkspaceDraft} from './workspace-drafts.js';
import {createPortal} from 'react-dom';
import {useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';

export type ScenarioSaveState={status:'idle'|'saving'|'saved'|'failed';message?:string;retry:()=>void};
export type ScenarioDeletedRow={id:string;index:number;name:string;restore:()=>void};
type Props={
 children?:ReactNode;
 items:ScenarioDefinition[];
 selected:string;
 disabled:boolean;
 canRun:boolean;
 runBlockedReason?:string;
 running?:boolean;
 runningId?:string;
 onStop?:()=>void;
 onSelect:(id:string)=>void;
 onCreate:()=>void;
 onRun:(id:string)=>void;
 onRunAll:()=>void;
 onRename:(name:string,id:string)=>void;
 onRenameDropped?:(id:string)=>void;
 onDuplicate:(id:string)=>void;
 onDelete:(id:string)=>void;
 onToggleSkip:(id:string)=>void;
 stepCounts?:Record<string,number>;
 saveState?:ScenarioSaveState;
 deleted?:ScenarioDeletedRow;
 onDismissDeleted?:()=>void;
};

const renameInvalid='✕ Use a name of 1–120 characters';

export function ScenarioSidebar({items,selected,disabled,canRun,runBlockedReason,running=false,runningId,onStop,onSelect,onCreate,onRun,onRunAll,onRename,onRenameDropped,onDuplicate,onDelete,onToggleSkip,stepCounts={},saveState,deleted,onDismissDeleted}:Props){
 const [search,setSearch]=useState('');
 const [menu,setMenu]=useState<{id:string;x:number;y:number}>();
 const [roving,setRoving]=useState<string>();
 const [statusRow,setStatusRow]=useState<string>();
 const recovered=useContext(RecoveredFields);
 const recoveredRename=Object.entries(recovered).find(([key])=>key.startsWith('scenario-rename:'));
 const [rename,setRename]=useState<{id:string;name:string}|undefined>(recoveredRename?{id:recoveredRename[0].slice('scenario-rename:'.length),name:recoveredRename[1]}:undefined);
 const [error,setError]=useState('');
 useWorkspaceDraft(!!rename,rename?`scenario-rename:${rename.id}`:undefined,rename?.name);
 const menuRef=useRef<HTMLDivElement>(null);
 const trigger=useRef<HTMLElement|null>(null);
 const renameRef=useRef<HTMLInputElement>(null);
 const undoRef=useRef<HTMLButtonElement>(null);
 const selectButtons=useRef(new Map<string,HTMLButtonElement>());
 const returnFocus=useRef<string|undefined>(undefined);
 const renameLive=useRef(rename);
 const onDropped=useRef(onRenameDropped);
 renameLive.current=rename;
 onDropped.current=onRenameDropped;
 const runLock=running||!!runningId;
 const blockActivate=disabled;
 const freezeSelect=disabled&&!runLock;
 const matches=items.filter(item=>item.id===runningId||item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
 const included=items.filter(item=>!item.skipInRunAll).length;
 const rovingId=roving&&matches.some(item=>item.id===roving)?roving:matches.some(item=>item.id===selected)?selected:matches[0]?.id;
 const target=items.find(item=>item.id===menu?.id);
 function closeMenu(){setMenu(undefined);trigger.current?.focus();}
 function openMenu(id:string,element:HTMLElement,x?:number,y?:number){
  trigger.current=element;const rect=element.getBoundingClientRect();
  setMenu({id,x:Math.max(8,Math.min(x??rect.left,window.innerWidth-220)),y:Math.max(8,Math.min(y??rect.bottom,window.innerHeight-240))});
 }
 function dropRename(){
  const pending=renameLive.current;if(!pending)return;
  returnFocus.current=pending.id;setRename(undefined);setError('');
  onDropped.current?.(pending.id);
 }
 function commitRename(){
  const pending=renameLive.current;if(!pending)return;
  const name=pending.name.trim();
  if(!name||name.length>120){setError(renameInvalid);return;}
  onRename(name,pending.id);returnFocus.current=pending.id;setRename(undefined);setError('');setStatusRow(pending.id);
  onDropped.current?.(pending.id);
 }
 function moveFocus(id:string,key:string){
  const ids=matches.map(item=>item.id);
  const index=Math.max(0,ids.indexOf(id));
  const next=key==='Home'?0:key==='End'?ids.length-1:key==='ArrowDown'?Math.min(ids.length-1,index+1):Math.max(0,index-1);
  const targetId=ids[next];
  if(!targetId)return;
  setRoving(targetId);selectButtons.current.get(targetId)?.focus();
 }
 function meta(item:ScenarioDefinition){
  const count=stepCounts[item.id]??0;
  const parts:string[]=[];
  if(item.id===selected)parts.push('● Current');
  parts.push(count===1?'1 step':count+' steps');
  parts.push(item.skipInRunAll?'⊘ Skipped in Run All':'in Run All');
  return parts;
 }
 useEffect(()=>()=>{const pending=renameLive.current;if(pending)onDropped.current?.(pending.id);},[]);
 useEffect(()=>{
  if(!rename)return;
  const outside=(event:PointerEvent)=>{
   const node=event.target;if(node instanceof Node&&renameRef.current?.contains(node))return;
   dropRename();
  };
  document.addEventListener('pointerdown',outside);
  return()=>document.removeEventListener('pointerdown',outside);
 },[rename?.id]);
 useEffect(()=>{
  if(!menu)return;
  menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  const outside=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node))setMenu(undefined);};
  const dismiss=()=>setMenu(undefined);
  document.addEventListener('pointerdown',outside);window.addEventListener('resize',dismiss);window.addEventListener('scroll',dismiss,true);
  return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',dismiss);window.removeEventListener('scroll',dismiss,true);};
 },[menu]);
 useEffect(()=>{if(disabled)setMenu(undefined);},[disabled]);
 useEffect(()=>{if(deleted)undoRef.current?.focus();},[deleted?.id]);
 useEffect(()=>{
  if(rename)renameRef.current?.focus();
  else if(returnFocus.current){if(trigger.current?.isConnected)trigger.current.focus();else selectButtons.current.get(returnFocus.current)?.focus();returnFocus.current=undefined;}
 },[rename?.id]);
 const entries:(ScenarioDefinition|{deleted:ScenarioDeletedRow})[]=[];
 let undoPlaced=false;
 const visible=new Set(matches.map(item=>item.id));
 items.forEach((item,index)=>{
  if(deleted&&deleted.index===index){entries.push({deleted});undoPlaced=true;}
  if(visible.has(item.id))entries.push(item);
 });
 if(deleted&&!undoPlaced)entries.push({deleted});
 return <aside className="scenario-sidebar" aria-label="Scenarios">
  <div className="sidebar-heading"><h3>Scenarios <span>({items.length})</span></h3></div>
  {runLock&&<p className="scenario-running-note" role="status">◷ Running — actions unavailable · Stop the run to edit</p>}
  <div className="sidebar-search">
   <input data-testid="scenario-search" aria-label="Search scenarios" type="search" placeholder="Search names" value={search} onChange={event=>setSearch(event.target.value)}/>
   <button type="button" data-testid="scenario-add" className={'scenario-add'+(items.length?'':' scenario-add-empty')} aria-label="New scenario" disabled={disabled} onClick={onCreate}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>{items.length?'New':'New scenario'}</button>
  </div>
  {search&&<button type="button" className="text-button" onClick={()=>setSearch('')}>Clear search</button>}
  <div className="scenario-list" aria-label="Scenario list">
   {!items.length&&<p>No scenarios yet. Create a new scenario to begin.</p>}
   {!!items.length&&!entries.length&&<p>No scenarios match your search.</p>}
   {entries.map(entry=>{
    if('deleted' in entry){
     const row=entry.deleted;
     return <p className="scenario-undo" role="status" key={'deleted-'+row.id}>“{row.name}” deleted · ↶ <button type="button" ref={undoRef} disabled={disabled} onClick={()=>{row.restore();onDismissDeleted?.();}}>Undo</button></p>;
    }
    const item=entry;
    const current=selected===item.id;
    const renaming=rename?.id===item.id;
    const stopping=runningId===item.id;
    const blocked=!stopping&&(disabled||!canRun);
    const runLabel=current?(blocked&&runBlockedReason?'Run scenario — '+runBlockedReason:'Run scenario'):'Run '+item.name;
    const showSave=statusRow===item.id&&saveState&&saveState.status!=='idle';
    return <div className="scenario-row" data-testid="scenario-row" data-scenario-id={item.id} key={item.id} onContextMenu={event=>{event.preventDefault();if(!disabled)openMenu(item.id,event.currentTarget.querySelector<HTMLButtonElement>('.scenario-select')??event.currentTarget,event.clientX,event.clientY);}} onKeyDown={event=>{const tag=(event.target as {tagName?:string}|null)?.tagName;if(tag==='INPUT'||tag==='TEXTAREA')return;if(!disabled&&(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)){event.preventDefault();openMenu(item.id,event.currentTarget.querySelector<HTMLButtonElement>('.scenario-select')??event.currentTarget);}}}>
     {renaming?<div className="scenario-rename"><input ref={renameRef} className="scenario-rename-input" aria-label="Rename scenario" aria-invalid={error?true:undefined} value={rename.name} disabled={disabled} onChange={event=>{setRename({id:item.id,name:event.target.value});setError('');}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commitRename();}if(event.key==='Escape'){event.preventDefault();dropRename();}}}/><p className="scenario-rename-hint">Enter saves · Esc cancels</p>{error&&<p className="scenario-rename-error" role="alert">{error}</p>}</div>:<>
      <button type="button" className={'scenario-select'+(item.skipInRunAll?' scenario-skipped':'')} ref={node=>{if(node)selectButtons.current.set(item.id,node);else selectButtons.current.delete(item.id);}} title={item.name} aria-label={item.name} aria-current={current?'true':undefined} aria-disabled={blockActivate&&!freezeSelect?true:undefined} aria-haspopup="menu" aria-expanded={menu?.id===item.id} aria-keyshortcuts="Shift+F10" disabled={freezeSelect} tabIndex={item.id===rovingId?0:-1} onFocus={()=>setRoving(item.id)} onClick={()=>{if(blockActivate)return;onSelect(item.id);}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();if(!blockActivate)onSelect(item.id);return;}if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();moveFocus(item.id,event.key);}}}>{item.name}</button>
      <div className="scenario-row-copy"><span className="scenario-row-meta">{meta(item).join(' · ')}{stopping&&<> · <b className="scenario-row-running">◷ Running</b></>}</span>{showSave&&<span className={'scenario-row-save scenario-row-save-'+saveState.status} role="status">{saveState.status==='saving'?'Saving…':saveState.status==='saved'?'✓ Saved locally':<>✕ Couldn't save · <button type="button" onClick={()=>saveState.retry()}>↻ Retry</button></>}</span>}</div>
     </>}
     {!renaming&&<div className="scenario-row-actions">{stopping?<button type="button" className="scenario-row-stop" data-testid="scenario-row-action-stop" aria-label="Stop scenario" onClick={()=>onStop?.()}>■ Stop</button>:<button type="button" className="scenario-row-icon" data-testid="scenario-row-action-run" aria-label={runLabel} title={runBlockedReason||'Run scenario'} disabled={disabled||!canRun} onClick={()=>onRun(item.id)}>▶</button>}<button type="button" className="scenario-row-icon scenario-row-menu" data-testid="scenario-row-menu" aria-label={'More actions for '+item.name} aria-haspopup="menu" aria-expanded={menu?.id===item.id} disabled={disabled} onClick={event=>{event.stopPropagation();openMenu(item.id,event.currentTarget);}}>⋯</button></div>}
    </div>;
   })}
  </div>
  {!!items.length&&<div className="sidebar-run"><p aria-label="Run All inclusion" aria-live="polite">{included} included · {items.length-included} skipped</p><button type="button" className="primary" disabled={disabled||!canRun||!included} title={(disabled||!canRun||!included)&&(runBlockedReason||!included&&'No scenarios included')||'Run all'} aria-label={(disabled||!canRun)&&runBlockedReason?'Run all — '+runBlockedReason:'Run all'} onClick={onRunAll}>Run all</button></div>}
  {target&&menu&&createPortal(<div className="scenario-context-menu" ref={menuRef} role="menu" aria-label={'Actions for '+target.name} style={{left:menu.x,top:menu.y}} onKeyDown={event=>{
   const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
   if(event.key==='Escape'||event.key==='Tab'){if(event.key==='Escape')event.preventDefault();closeMenu();}
   if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}
  }}>
   <button type="button" role="menuitem" data-testid="scenario-row-action-run" disabled={disabled||!canRun} onClick={()=>{closeMenu();onRun(target.id);}}>Run scenario</button>
   <button type="button" role="menuitem" data-testid="scenario-row-action-rename" disabled={disabled} onClick={()=>{closeMenu();setRename({id:target.id,name:target.name});setError('');}}>Rename</button>
   <button type="button" role="menuitem" data-testid="scenario-row-action-duplicate" disabled={disabled} onClick={()=>{closeMenu();onDuplicate(target.id);}}>Duplicate</button>
   <button type="button" role="menuitemcheckbox" data-testid="scenario-row-action-skip" aria-checked={!!target.skipInRunAll} disabled={disabled} onClick={()=>{closeMenu();onToggleSkip(target.id);}}>Skip in Run All</button>
   <hr role="separator"/><button type="button" role="menuitem" className="scenario-menu-delete" data-testid="scenario-row-action-delete" disabled={disabled} onClick={()=>{closeMenu();onDelete(target.id);}}>Delete</button>
  </div>,document.body)}
 </aside>;
}
