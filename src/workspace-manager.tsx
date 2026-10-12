import {useEffect,useRef,useState,type ReactNode} from 'react';
import {runnerClient} from './runner-client.js';
import type {Workspace} from '../server/scenarios.js';
import type {WorkspaceLibrary} from '../server/workspace-store.js';

type Action={kind:'open';id:string}|{kind:'new'|'copy';name:string}|{kind:'rename';name:string};
type IconName='document'|'search'|'chevron'|'arrow'|'copy'|'save'|'plus'|'close'|'check'|'more';
function WorkspaceIcon({name}:{name:IconName}){
 const paths:Record<IconName,ReactNode>={
  document:<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></>,
  search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
  chevron:<path d="m8 10 4 4 4-4"/>,arrow:<path d="m9 6 6 6-6 6"/>,
  copy:<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/></>,
  save:<><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/></>,
  more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  plus:<path d="M12 5v14M5 12h14"/>,close:<path d="m6 6 12 12M6 18 18 6"/>,check:<path d="m5 12 4 4L19 6"/>,
 };
 return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function workspaceDate(value:string){
 const date=new Date(value);const today=new Date();const yesterday=new Date(today);yesterday.setDate(today.getDate()-1);
 return date.toDateString()===today.toDateString()?'Today':date.toDateString()===yesterday.toDateString()?'Yesterday':date.toLocaleDateString(undefined,{month:'short',day:'numeric',...(date.getFullYear()!==today.getFullYear()?{year:'numeric' as const}:{})});
}
export function WorkspaceManager({token,id,name,status,busy,blocked,dirty,onAction,onSave,recovery}:{token:string;id:string;name:string;status:string;busy:boolean;blocked:boolean;dirty:boolean;onAction:(action:Action,saved?:Workspace)=>Promise<void>;onSave:()=>Promise<Workspace>;recovery:boolean}){
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
  const input=surface.current?.querySelector<HTMLInputElement>('input');(input??surface.current?.querySelector<HTMLButtonElement>('button'))?.focus();if(panel==='rename'||panel==='new'||panel==='copy')input?.select();
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
  if(dirty&&(action.kind==='new'||action.kind==='open'))setPending(action);else void perform(action,dirty&&action.kind==='copy'&&!recovery);
 }
 const items=library?.items??[];
 const formPanel=panel==='rename'||panel==='new'||panel==='copy';
 const heading=pending?'Save your changes':panel==='library'?'All workspaces':panel==='rename'?'Rename workspace':panel==='new'?'New workspace':panel==='copy'?'Save a copy':name;
 const startRename=()=>{setTitle(name);setPanel('rename');};
 const startNew=()=>{setTitle('Untitled workspace');setPanel('new');};
 const startCopy=()=>{setTitle((name.slice(0,115)+' copy').slice(0,120));setPanel('copy');};
 return <div className="workspace-manager">
  <button ref={trigger} className="workspace-title" aria-label="Manage workspace" aria-expanded={!!panel} title={name} onClick={()=>{if(panel)close();else{setQuery('');setPanel('compact');}}}>
   <WorkspaceIcon name="document"/><span className="workspace-identity"><strong>{name}</strong><span role="status">{status}</span></span><WorkspaceIcon name="chevron"/>
  </button>
  {panel&&<><div className={'workspace-management-backdrop '+(panel==='library'||formPanel||pending?'dimmed':'')} onPointerDown={()=>{if(panel==='compact'&&!pending)close();}}/><div ref={surface} role="dialog" aria-modal="true" aria-label={panel==='library'?'All workspaces':'Workspace manager'} className={'workspace-management-surface '+(panel==='library'?'expanded':'compact')} onKeyDown={event=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(pending){setPending(undefined);setError('');}else close();}
   if(event.key==='Tab'){const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'));const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  }}>
   <header className="workspace-manager-heading"><div className="workspace-identity"><h3 title={heading}>{heading}</h3>{!formPanel&&!pending&&<small>{panel==='library'?'Saved on this computer':'Current workspace'}</small>}</div>
    {!formPanel&&!pending&&panel==='compact'&&<button className="workspace-rename" aria-label="Rename workspace" disabled={busy||blocked} onClick={startRename}>Rename</button>}
    <button className="workspace-close" aria-label="Close workspace manager" onClick={close}><WorkspaceIcon name="close"/></button>
   </header>
   {blocked&&<p className="workspace-feedback" role="status">Active execution: browse available; switching waits for cleanup.</p>}
   {pending?<><p className="workspace-form-description">Save changes to “{name}” before continuing?</p><div className="workspace-form-actions"><button disabled={busy} onClick={()=>{setPending(undefined);setError('');}}>Cancel</button><button className="workspace-primary" disabled={busy} onClick={()=>void perform(pending,true)}>Save and continue</button></div></>:formPanel?<form onSubmit={event=>{event.preventDefault();const value=title.trim();if(!value||value.length>120){setError('Use a title of 1–120 characters.');return;}choose({kind:panel,name:value});}}>
    <label htmlFor="workspace-title-input">{panel==='rename'?'Workspace title':panel==='copy'?'Copy title':'New workspace title'}</label><input id="workspace-title-input" value={title} maxLength={120} onChange={event=>setTitle(event.target.value)}/>
    {panel==='copy'&&<p className="workspace-form-description">An independent editable copy. Runtime inputs and previous run results stay with the original session.</p>}
    <div className="workspace-form-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button className="workspace-primary" disabled={busy||blocked}>{panel==='rename'?'Done':panel==='copy'?'Create copy':'Create workspace'}</button></div>
   </form>:<>
    <label className="sr-only" htmlFor="workspace-search">Find workspace</label><div className="workspace-search"><WorkspaceIcon name="search"/><input id="workspace-search" type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search workspaces"/></div>
    <div className="workspace-section-label">{query?'Search results':panel==='library'?'Your workspaces':'Recently opened'}</div>
    <div className="workspace-library-scroll">
    {loading?<p className="workspace-feedback" role="status">Loading workspaces…</p>:<>
     {!error&&!items.length&&<p className="workspace-feedback">{query?'No matching workspaces. Try another name.':'No saved workspaces yet. Create work and save it here.'}</p>}
     <ul className="workspace-library">{(panel==='compact'&&!query?items.slice(0,5):items).map(item=>{
      const duplicate=items.some(other=>other.id!==item.id&&other.name===item.name);
      const dates='Created '+new Date(item.createdAt).toLocaleString()+' · Saved '+new Date(item.updatedAt).toLocaleString();
      return <li key={item.id} className={duplicate?'workspace-duplicate':undefined}><button aria-current={item.id===id?'true':undefined} title={dates} disabled={busy||blocked} aria-label={'Open '+item.name+' · '+item.createdAt+' · '+item.screens+' screens · '+item.scenarios+' scenarios'} onClick={()=>choose({kind:'open',id:item.id})}>
       <WorkspaceIcon name="document"/><span className="workspace-row-content"><strong>{item.name}</strong><small>{item.scenarios} {item.scenarios===1?'scenario':'scenarios'}{panel==='library'&&' · '+item.screens+' screens'} · {item.id===id?'Current':'Saved '+workspaceDate(item.updatedAt)}</small>{duplicate&&<small className="workspace-row-date">Created {new Date(item.createdAt).toLocaleString()}</small>}</span>{item.id===id&&<WorkspaceIcon name="check"/>}
      </button>{duplicate&&<details className="workspace-row-details"><summary aria-label={'Diagnostic details for '+item.name} title="Workspace details"><WorkspaceIcon name="more"/></summary><div><small>Created {new Date(item.createdAt).toISOString()}</small><small>Workspace ID: {item.id}</small></div></details>}</li>;
     })}</ul>
     {!!library?.unreadable&&<p className="workspace-feedback" role="alert">{library.unreadable} unreadable workspace record(s). Other work is available. Repair the local record and retry.</p>}
    </>}
    </div>
    {panel==='compact'&&<button className="workspace-view-all" onClick={()=>setPanel('library')}><span>View all workspaces</span><WorkspaceIcon name="arrow"/></button>}
    <div className="workspace-commands">
     {panel==='library'&&<button className="workspace-command" disabled={busy||blocked} onClick={startRename}><WorkspaceIcon name="document"/><span>Rename workspace</span></button>}
     <button className="workspace-command" disabled={busy||blocked} onClick={startCopy}><WorkspaceIcon name="copy"/><span>Save a copy</span></button>
    </div>
    <footer className="workspace-manager-footer"><button className="workspace-command" disabled={busy||blocked} onClick={startNew}><WorkspaceIcon name="plus"/><span>New workspace</span></button><small>On this computer · Autosave</small></footer>
   </>}
   {error&&<p className="workspace-feedback workspace-error" role="alert">{error} {(panel==='compact'||panel==='library')&&<button disabled={busy} onClick={()=>setRetry(value=>value+1)}>Retry library</button>}</p>}
  </div></>}
 </div>;
}
export type WorkspaceAction=Action;
