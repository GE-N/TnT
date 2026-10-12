import {useEffect,useRef,useState} from 'react';
import {runnerClient} from './runner-client.js';
import type {Workspace} from '../server/scenarios.js';
import type {WorkspaceLibrary} from '../server/workspace-store.js';

type Action={kind:'open';id:string}|{kind:'new'|'copy';name:string}|{kind:'rename';name:string};
export function WorkspaceManager({token,id,name,status,busy,blocked,dirty,onAction,onSave}:{token:string;id:string;name:string;status:string;busy:boolean;blocked:boolean;dirty:boolean;onAction:(action:Action,saved?:Workspace)=>Promise<void>;onSave:()=>Promise<Workspace>}){
 const [panel,setPanel]=useState<'compact'|'library'|'rename'|'new'|'copy'>();
 const [query,setQuery]=useState('');const [title,setTitle]=useState('');
 const [library,setLibrary]=useState<WorkspaceLibrary>();const [error,setError]=useState('');const [loading,setLoading]=useState(false);
 const [pending,setPending]=useState<Action>();const [retry,setRetry]=useState(0);
 const trigger=useRef<HTMLButtonElement>(null);const surface=useRef<HTMLDivElement>(null);
 const close=()=>{setPanel(undefined);setPending(undefined);setError('');trigger.current?.focus();};
 useEffect(()=>{
  if(panel!=='compact'&&panel!=='library')return;
  let active=true;setLoading(true);setError('');
  if(!token){setError('Connect to the local runner to browse saved work.');setLoading(false);return;}
  runnerClient(token)('/api/workspaces?q='+encodeURIComponent(query)).then(value=>{if(active)setLibrary(value);}).catch(error=>{if(active){setLibrary(undefined);setError('The local workspace store is unavailable. '+error.message);}}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[panel,query,token,status,retry]);
 useEffect(()=>{
  if(!panel)return;
  surface.current?.querySelector<HTMLElement>('input,button')?.focus();
  const measure=()=>surface.current?.style.setProperty('--workspace-space',Math.max(160,window.innerHeight-(trigger.current?.getBoundingClientRect().bottom??0)-16)+'px');measure();window.addEventListener('resize',measure);

  function outside(event:PointerEvent){if(!pending&&panel==='compact'&&!surface.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))close();}
  document.addEventListener('pointerdown',outside);return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',measure);};
 },[panel,pending]);
 async function perform(action:Action,saveFirst=false){
  setError('');
  try{const saved=saveFirst?await onSave():undefined;await onAction(action,saved);close();}catch(error){setError(error instanceof Error?error.message:'Workspace action failed. Current work is retained.');}
 }
 function choose(action:Action){
  if(blocked){setError('Wait for active execution and cleanup before switching workspaces.');return;}
  if(dirty&&(action.kind==='new'||action.kind==='open'))setPending(action);else void perform(action,dirty&&action.kind==='copy');
 }
 const items=library?.items??[];
 return <div className="workspace-manager">
  <button ref={trigger} className="workspace-title" aria-label="Manage workspace" aria-expanded={!!panel} title={name} onClick={()=>{if(panel)close();else{setQuery('');setPanel('compact');}}}><strong>{name} ▾</strong><span role="status">{status}</span></button>
  {panel&&<><div className="workspace-management-backdrop" onPointerDown={()=>{if(panel==='compact'&&!pending)close();}}/><div ref={surface} role="dialog" aria-modal="true" aria-label={panel==='library'?'All workspaces':'Workspace manager'} className={'workspace-management-surface '+(panel==='compact'?'compact':'expanded')} onKeyDown={event=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(pending){setPending(undefined);setError('');}else close();}
   if(event.key==='Tab'){const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'));const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  }}>
   <div className="label-row"><h3>{panel==='library'?'All workspaces':'Workspace'}</h3><button aria-label="Close workspace manager" onClick={close}>×</button></div>
   <p className="field-hint">Saved in this local runner’s store. Save manually before leaving.</p>
   {blocked&&<p role="status">Active execution: browse available; switching waits for cleanup.</p>}
   {pending?<><p>Save changes to “{name}” before continuing?</p><button disabled={busy} onClick={()=>void perform(pending,true)}>Save and continue</button><button disabled={busy} onClick={()=>{setPending(undefined);setError('');}}>Cancel</button></>:panel==='rename'||panel==='new'||panel==='copy'?<form onSubmit={event=>{event.preventDefault();const value=title.trim();if(!value||value.length>120){setError('Use a title of 1–120 characters.');return;}choose({kind:panel,name:value});}}>
    <label htmlFor="workspace-title-input">{panel==='rename'?'Workspace title':panel==='copy'?'Copy title':'New workspace title'}</label><input id="workspace-title-input" value={title} maxLength={120} onChange={event=>setTitle(event.target.value)}/>
    {panel==='copy'&&<p>Copy the reviewed authored content. Runtime inputs and previous run results stay with their original session.</p>}
    <button disabled={busy||blocked}>{panel==='rename'?'Done':panel==='copy'?'Create copy':'Create workspace'}</button><button type="button" disabled={busy} onClick={close}>Cancel</button>
   </form>:<>
    <div className="workspace-commands"><button disabled={busy||blocked} onClick={()=>{setTitle(name);setPanel('rename');}}>Rename workspace</button><button disabled={busy||blocked} onClick={()=>{setTitle('Untitled workspace');setPanel('new');}}>New workspace</button><button disabled={busy||blocked} onClick={()=>{setTitle((name.slice(0,115)+' copy').slice(0,120));setPanel('copy');}}>Save a copy</button><button disabled={busy||!token} onClick={()=>void onSave().catch(error=>setError(error.message))}>Save workspace</button></div>
    <label htmlFor="workspace-search">Find workspace</label><input id="workspace-search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search all saved work by name"/>
    {loading?<p role="status">Loading workspaces…</p>:<>
     {!error&&!items.length&&<p>{query?'No matching workspaces. Try another name.':'No saved workspaces yet. Create work and save it here.'}</p>}
     <ul className="workspace-library">{(panel==='compact'&&!query?items.slice(0,5):items).map(item=><li key={item.id}><button disabled={busy||blocked} aria-label={'Open '+item.name+' · '+item.createdAt+' · '+item.screens+' screens · '+item.scenarios+' scenarios'} onClick={()=>choose({kind:'open',id:item.id})}><strong>{item.name}{item.id===id?' · Current':''}</strong><small>Created {new Date(item.createdAt).toLocaleString()} · Saved {new Date(item.updatedAt).toLocaleString()} · {item.screens} screens · {item.scenarios} scenarios</small></button><details><summary>Diagnostic details for {item.name}</summary><p>Workspace ID: {item.id}</p></details></li>)}</ul>
     {!!library?.unreadable&&<p role="alert">{library.unreadable} unreadable workspace record(s). Other work is available. Repair the local record and retry.</p>}
    </>}
    {panel==='compact'&&<button onClick={()=>setPanel('library')}>View all workspaces</button>}

   </>}
   {error&&<p role="alert">{error} {(panel==='compact'||panel==='library')&&<button disabled={busy} onClick={()=>setRetry(value=>value+1)}>Retry library</button>}</p>}
  </div></>}
 </div>;
}
export type WorkspaceAction=Action;
