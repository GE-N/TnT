import {createPortal} from 'react-dom';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';

type Props={children?:ReactNode;items:ScenarioDefinition[];selected:string;disabled:boolean;canRun:boolean;onSelect:(id:string)=>void;onCreate:()=>void;onRun:(id:string)=>void;onRunAll:()=>void;onRename:(name:string,id:string)=>void;onDuplicate:(id:string)=>void;onDelete:(id:string)=>void};
export function ScenarioSidebar({children,items,selected,disabled,canRun,onSelect,onCreate,onRun,onRunAll,onRename,onDuplicate,onDelete}:Props){
 const [search,setSearch]=useState('');
 const [menu,setMenu]=useState<{id:string;x:number;y:number}>();
 const [rename,setRename]=useState<{id:string;name:string}>();
 const [error,setError]=useState('');
 const menuRef=useRef<HTMLDivElement>(null);
 const trigger=useRef<HTMLElement|null>(null);
 const renameRef=useRef<HTMLInputElement>(null);
 const selectButtons=useRef(new Map<string,HTMLButtonElement>());
 const returnFocus=useRef<string|undefined>(undefined);
 const matches=items.filter(item=>item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
 const target=items.find(item=>item.id===menu?.id);
 function closeMenu(){setMenu(undefined);trigger.current?.focus();}
 function openMenu(id:string,element:HTMLElement,x?:number,y?:number){
  trigger.current=element;const rect=element.getBoundingClientRect();
  setMenu({id,x:Math.max(8,Math.min(x??rect.left,window.innerWidth-220)),y:Math.max(8,Math.min(y??rect.bottom,window.innerHeight-210))});
 }
 useEffect(()=>{
  if(!menu)return;
  menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  const outside=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node))setMenu(undefined);};
  const dismiss=()=>setMenu(undefined);
  document.addEventListener('pointerdown',outside);window.addEventListener('resize',dismiss);window.addEventListener('scroll',dismiss,true);
  return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',dismiss);window.removeEventListener('scroll',dismiss,true);};
 },[menu]);
 useEffect(()=>{if(disabled)setMenu(undefined);},[disabled]);
 useEffect(()=>{
  if(rename){renameRef.current?.focus();renameRef.current?.select();}
  else if(returnFocus.current){if(trigger.current?.isConnected)trigger.current.focus();else selectButtons.current.get(returnFocus.current)?.focus();returnFocus.current=undefined;}
 },[rename?.id]);
 function commitRename(){
  if(!rename)return;const name=rename.name.trim();
  if(!name||name.length>120){setError('Use a nonempty scenario name of at most 120 characters.');return;}
  onRename(name,rename.id);returnFocus.current=rename.id;setRename(undefined);setError('');
 }
 return <aside className="scenario-sidebar" aria-label="Scenarios">
  <div className="sidebar-heading"><h3>Scenarios <span>({items.length})</span></h3><button className="confirm" aria-label="New scenario" title="New scenario" disabled={disabled} onClick={onCreate}>+</button></div>
  <div className="sidebar-search"><input aria-label="Search scenarios" type="search" placeholder="Search names" value={search} onChange={event=>setSearch(event.target.value)}/>{search&&<button className="text-button" onClick={()=>setSearch('')}>Clear search</button>}</div>
  <div className="scenario-list" aria-label="Scenario list">
   {!items.length?<p>No scenarios yet. Create a new scenario to begin.</p>:!matches.length?<p>No scenarios match your search.</p>:matches.map(item=><div className="scenario-row" key={item.id} onContextMenu={event=>{event.preventDefault();if(!disabled)openMenu(item.id,event.currentTarget.querySelector<HTMLButtonElement>('.scenario-select')??event.currentTarget,event.clientX,event.clientY);}} onKeyDown={event=>{if(!disabled&&(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)){event.preventDefault();openMenu(item.id,event.currentTarget.querySelector<HTMLButtonElement>('.scenario-select')??event.currentTarget);}}}>
    {rename?.id===item.id?<input ref={renameRef} aria-label="Rename scenario" value={rename.name} maxLength={120} disabled={disabled} onChange={event=>{setRename({...rename,name:event.target.value});setError('');}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commitRename();}if(event.key==='Escape'){event.preventDefault();returnFocus.current=rename.id;setRename(undefined);setError('');}}}/>:<button className="scenario-select" ref={node=>{if(node)selectButtons.current.set(item.id,node);else selectButtons.current.delete(item.id);}} title={item.name} aria-pressed={selected===item.id} aria-haspopup="menu" aria-expanded={menu?.id===item.id} aria-keyshortcuts="Shift+F10" disabled={disabled} onClick={()=>onSelect(item.id)}>{item.name}</button>}
    <div className="scenario-row-actions"><button className="confirm" aria-label={'Run '+item.name} title="Run scenario" disabled={disabled||!canRun} onClick={()=>onRun(item.id)}>▶</button></div>
   </div>)}
  </div>
  {error&&<p role="alert">{error}</p>}
  <div className="sidebar-run"><button className="primary" disabled={disabled||!canRun||!items.length} onClick={onRunAll}>Run all</button>{children}</div>
  {target&&menu&&createPortal(<div className="scenario-context-menu" ref={menuRef} role="menu" aria-label={'Actions for '+target.name} style={{left:menu.x,top:menu.y}} onKeyDown={event=>{
   const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
   if(event.key==='Escape'||event.key==='Tab'){if(event.key==='Escape')event.preventDefault();closeMenu();}
   if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}
  }}>
   <button role="menuitem" disabled={disabled||!canRun} onClick={()=>{closeMenu();onRun(target.id);}}>Run scenario</button>
   <button role="menuitem" disabled={disabled} onClick={()=>{closeMenu();setRename({id:target.id,name:target.name});setError('');}}>Rename</button>
   <button role="menuitem" disabled={disabled} onClick={()=>{closeMenu();onDuplicate(target.id);}}>Duplicate</button>
   <hr role="separator"/><button role="menuitem" disabled={disabled} onClick={()=>{closeMenu();onDelete(target.id);}}>Delete</button>
  </div>,document.body)}
 </aside>;
}
