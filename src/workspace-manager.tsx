import {WorkspaceTransfer,isFileDrag,type ExportOptions,type PackageResult} from './workspace-transfer.js';
import type {WorkspacePackage} from '../server/workspace-package.js';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {runnerClient} from './runner-client.js';
import type {Workspace} from '../server/scenarios.js';
import type {WorkspaceLibrary} from '../server/workspace-store.js';

type Action={kind:'trash';id:string;name:string}|{kind:'restore';id:string}|{kind:'import';name:string;package:WorkspacePackage;filename?:string}|{kind:'open';id:string}|{kind:'new'|'copy';name:string}|{kind:'rename';name:string};
type IconName='document'|'search'|'chevron'|'arrow'|'copy'|'save'|'plus'|'close'|'check'|'more'|'warning';
function WorkspaceIcon({name}:{name:IconName}){
 const paths:Record<IconName,ReactNode>={
  document:<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></>,
  search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
  chevron:<path d="m8 10 4 4 4-4"/>,arrow:<path d="m9 6 6 6-6 6"/>,
  copy:<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/></>,
  save:<><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/></>,
  more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  plus:<path d="M12 5v14M5 12h14"/>,close:<path d="m6 6 12 12M6 18 18 6"/>,check:<path d="m5 12 4 4L19 6"/>,
  warning:<><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5"/><path d="M12 17h.01"/></>,
 };
 return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function workspaceDate(value:string){
 const date=new Date(value);const today=new Date();const yesterday=new Date(today);yesterday.setDate(today.getDate()-1);
 return date.toDateString()===today.toDateString()?'Today':date.toDateString()===yesterday.toDateString()?'Yesterday':date.toLocaleDateString(undefined,{month:'short',day:'numeric',...(date.getFullYear()!==today.getFullYear()?{year:'numeric' as const}:{})});
}
export function WorkspaceManager({token,id,name,status,statusNote,busy,blocked,dirty,onAction,onSave,onPrepare,recovery,notice,openSignal,onExport,empty=false,imported=false,onRecover,recoveryOpen=false}:{token:string;id:string;name:string;status:string;statusNote?:string;busy:boolean;blocked:boolean;dirty:boolean;onAction:(action:Action,saved?:Workspace,options?:{discard?:boolean})=>Promise<void>;onSave:()=>Promise<Workspace>;onPrepare:(action:Action)=>Promise<Workspace|undefined>;recovery:boolean;notice?:string;openSignal?:number;onExport:(options:ExportOptions)=>Promise<PackageResult>;empty?:boolean;imported?:boolean;onRecover?:(button:HTMLButtonElement)=>void;recoveryOpen?:boolean}){
 const [panel,setPanel]=useState<'compact'|'library'|'rename'|'new'|'copy'|'export'|'import'|'trash'|'delete'>();
 const [droppedFiles,setDroppedFiles]=useState<File[]|undefined>();const [fileDrag,setFileDrag]=useState(false);
 const [deleteTarget,setDeleteTarget]=useState<{id:string;name:string}>();
 const [undo,setUndo]=useState<{id:string;name:string;reopen:boolean}>();const [working,setWorking]=useState(false);
 const [actionError,setActionError]=useState('');const [reopenTarget,setReopenTarget]=useState<string>();
 const [query,setQuery]=useState('');const [title,setTitle]=useState('');
 const [library,setLibrary]=useState<WorkspaceLibrary>();const [error,setError]=useState('');const [loading,setLoading]=useState(false);
 const [switchFailure,setSwitchFailure]=useState<Action>();const [confirmDiscard,setConfirmDiscard]=useState(false);const [retry,setRetry]=useState(0);
 const deleteOrigin=useRef<{panel:'compact'|'library';label:string}|undefined>(undefined);const returnDeleteFocus=useRef(false);
 const trigger=useRef<HTMLButtonElement>(null);const surface=useRef<HTMLDivElement>(null);const switchOpener=useRef<HTMLElement|null>(null);const failurePhase=useRef<'closed'|'failure'|'confirm'>('closed');
 const titleBox=useRef<HTMLDivElement>(null);const recoveryGap=useRef<HTMLSpanElement>(null);const recoveryHost=useRef<HTMLSpanElement>(null);
 const close=()=>{switchOpener.current=null;setPanel(undefined);setDroppedFiles(undefined);setSwitchFailure(undefined);setConfirmDiscard(false);setError('');setActionError('');trigger.current?.focus();};
 useLayoutEffect(()=>{
  const gap=recoveryGap.current,host=recoveryHost.current,box=titleBox.current;
  if(!onRecover||!gap||!host||!box)return;
  const place=()=>{const boxRect=box.getBoundingClientRect();const gapRect=gap.getBoundingClientRect();host.style.left=`${gapRect.left-boxRect.left}px`;host.style.top=`${gapRect.top-boxRect.top+(gapRect.height-host.offsetHeight)/2}px`;};
  place();
  const observer=new ResizeObserver(place);observer.observe(box);window.addEventListener('resize',place);
  return()=>{observer.disconnect();window.removeEventListener('resize',place);};
 },[onRecover,status,name,recoveryOpen]);
 useEffect(()=>{if(openSignal){setQuery('');setPanel('compact');}},[openSignal]);
 useEffect(()=>{
  if(panel!=='compact'&&panel!=='library'&&panel!=='trash')return;
  let active=true;setLoading(true);setError('');
  if(!token){setError('Connect to the local runner to browse saved work.');setLoading(false);return;}
  runnerClient(token)(panel==='trash'?'/api/workspaces/trash':'/api/workspaces?q='+encodeURIComponent(query)).then(value=>{if(active)setLibrary(value);}).catch(error=>{if(active){setLibrary(undefined);setError('The local workspace store is unavailable. '+error.message);}}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[panel,query,token,status,retry]);
 useEffect(()=>{
  if(!panel){failurePhase.current='closed';return;}
  if(switchFailure){
    const actions=surface.current?.querySelector('.workspace-form-actions');
    const labeled=(label:string)=>[...actions?.querySelectorAll<HTMLButtonElement>('button')??[]].find(button=>button.textContent?.trim()===label);
    if(confirmDiscard){if(failurePhase.current!=='confirm'){failurePhase.current='confirm';labeled('Cancel')?.focus();}}
    else if(failurePhase.current==='confirm'){failurePhase.current='failure';labeled('Discard changes and switch')?.focus();}
    else if(failurePhase.current!=='failure'){failurePhase.current='failure';actions?.querySelector<HTMLButtonElement>('.workspace-primary')?.focus();}
  }else if(switchOpener.current){failurePhase.current='closed';const opener=switchOpener.current;switchOpener.current=null;const label=(opener.textContent??'').trim();const restored=label?[...surface.current?.querySelectorAll<HTMLButtonElement>('button')??[]].find(button=>button.textContent?.trim()===label):undefined;(restored??(opener.isConnected?opener:undefined)??surface.current?.querySelector<HTMLButtonElement>('.workspace-primary')??trigger.current)?.focus();}
  else if(panel==='delete'){surface.current?.querySelector<HTMLButtonElement>('.workspace-form-actions button')?.focus();}
  else{failurePhase.current='closed';const input=surface.current?.querySelector<HTMLInputElement>('input:not([type=file])');(input??surface.current?.querySelector<HTMLButtonElement>('button'))?.focus();if(panel==='rename'||panel==='new'||panel==='copy')input?.select();}
  const measure=()=>surface.current?.style.setProperty('--workspace-space',Math.max(160,window.innerHeight-(trigger.current?.getBoundingClientRect().bottom??0)-16)+'px');measure();window.addEventListener('resize',measure);

  function outside(event:PointerEvent){if(!switchFailure&&panel==='compact'&&!surface.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))close();}
  document.addEventListener('pointerdown',outside);return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',measure);};
 },[panel,switchFailure,confirmDiscard]);
 useEffect(()=>{
  if(!returnDeleteFocus.current||loading||!panel)return;
  const label=deleteOrigin.current?.label;
  const opener=[...surface.current?.querySelectorAll<HTMLButtonElement>('button')??[]].find(button=>(button.getAttribute('aria-label')??button.textContent?.trim())===label);
  if(opener){opener.focus();returnDeleteFocus.current=false;}
 },[panel,loading,library]);
 function cancelDelete(){setDeleteTarget(undefined);setPanel(deleteOrigin.current?.panel??'library');setError('');setActionError('');returnDeleteFocus.current=true;}
 async function perform(action:Action,saveFirst=false){
  setError('');
  try{const saved=saveFirst?await onSave():undefined;await onAction(action,saved);close();}catch(error){setError(error instanceof Error?error.message:'Workspace action failed. Current work is retained.');}
 }
 async function choose(action:Action){
  if(blocked){setError('Wait for active execution and cleanup before switching workspaces.');return;}
  if(action.kind==='rename'){await perform(action);return;}
  setError('');setConfirmDiscard(false);
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
  try{const saved=await onPrepare(action);await onAction(action,saved);close();}
  catch(error){if(!switchOpener.current)switchOpener.current=opener instanceof HTMLButtonElement?opener:null;setSwitchFailure(action);setError(error instanceof Error?error.message:'');}
 }
 async function retrySwitch(){
  if(!switchFailure)return;setError('');
  try{const saved=await onPrepare(switchFailure);await onAction(switchFailure,saved);close();}
  catch(error){setError(error instanceof Error?error.message:'');}
 }
 async function discardSwitch(){
  if(!switchFailure)return;setError('');
  try{await onAction(switchFailure,undefined,{discard:true});close();}
  catch(error){setError(error instanceof Error?error.message:'Workspace action failed. Current work is retained.');}
 }
 async function moveToTrash(){
  if(!deleteTarget)return;setWorking(true);setError('');setActionError('');
  try{
   if(deleteTarget.id===id)await onPrepare({kind:'trash',...deleteTarget});
   await onAction({kind:'trash',...deleteTarget});
   setUndo({...deleteTarget,reopen:deleteTarget.id===id});setDeleteTarget(undefined);setQuery('');setPanel('library');setRetry(value=>value+1);
  }catch(error){setActionError((error instanceof Error?error.message:'Deletion failed.')+' Current work is retained. Retry Move to Trash.');}
  finally{setWorking(false);}
 }
 async function reopen(id:string){
  setWorking(true);setActionError('');
  try{await onAction({kind:'open',id});setReopenTarget(undefined);close();}
  catch(error){setPanel('library');setReopenTarget(id);setActionError('The workspace was restored, but could not be opened. '+(error instanceof Error?error.message:'')+' Retry Open.');}
  finally{setWorking(false);}
 }
 async function restore(target:{id:string;reopen?:boolean}){
  setWorking(true);setError('');setActionError('');
  try{
   await onAction({kind:'restore',id:target.id});
   if(undo?.id===target.id)setUndo(undefined);setRetry(value=>value+1);
  }catch(error){setPanel('trash');setActionError((error instanceof Error?error.message:'Restore failed.')+' The Trash entry is retained. Retry Restore.');setWorking(false);return;}
  setWorking(false);
  if(target.reopen&&empty)await reopen(target.id);
 }
 const startDelete=(target:{id:string;name:string},opener:HTMLButtonElement)=>{deleteOrigin.current={panel:panel==='compact'?'compact':'library',label:opener?.getAttribute('aria-label')??opener?.textContent?.trim()??''};setDeleteTarget(target);setError('');setActionError('');setPanel('delete');};
 const items=library?.items??[];
 const formPanel=panel==='rename'||panel==='new'||panel==='copy';
 const transferPanel=panel==='export'||panel==='import';
 const heading=panel==='delete'?'Delete workspace':panel==='trash'?'Trash':transferPanel?(panel==='export'?'Export workspace':'Import workspace'):switchFailure?(confirmDiscard?'Discard changes':"Couldn't save"):panel==='library'?'All workspaces':panel==='rename'?'Rename workspace':panel==='new'?'New workspace':panel==='copy'?'Save a copy':name;
 const paused=status.startsWith('Unsaved changes');
 const statusTone=status.startsWith("Couldn't save")?'danger':paused||status.startsWith('Draft kept')?'warning':status==='Saved locally'?'success':'muted';
 const statusIcon=status.startsWith("Couldn't save")?'×':paused?'‖':status.startsWith('Draft kept')?'!':status==='Saved locally'?'✓':'…';
 const startRename=()=>{setTitle(name);setPanel('rename');};
 const startNew=()=>{setTitle('Untitled workspace');setPanel('new');};
 const startCopy=()=>{setTitle((name.slice(0,115)+' copy').slice(0,120));setPanel('copy');};
 return <div className="workspace-manager">
  {undo&&<div className="workspace-trash-notice" role="status"><span>Moved “{undo.name}” to Trash.</span><button disabled={busy||blocked||working} aria-label={'Undo deletion of '+undo.name} onClick={()=>void restore(undo)}>Undo</button></div>}
  <div ref={titleBox} className="workspace-title">
   <button ref={trigger} className="workspace-title-open" aria-label="Manage workspace" disabled={working} aria-expanded={!!panel} title={name} onClick={()=>{if(panel)close();else{setQuery('');setPanel('compact');}}}>
    <WorkspaceIcon name="document"/><span className="workspace-identity"><strong>{name}</strong>{imported&&<span className="workspace-imported">↓ Imported workspace</span>}<span className={'workspace-save-status '+statusTone} role={statusTone==='danger'?'alert':'status'} aria-live={statusTone==='danger'?'assertive':'polite'} aria-label={status} title={statusNote||status} {...(statusNote?{'aria-description':statusNote}:{})}><span className="workspace-save-icon" aria-hidden="true">{statusIcon}</span><span className="workspace-save-text">{status}</span>{onRecover&&<span ref={recoveryGap} className="workspace-draft-warning-gap" aria-hidden="true"/>}</span></span><WorkspaceIcon name="chevron"/>
   </button>
   {onRecover&&<span ref={recoveryHost} className="workspace-draft-warning-host"><button type="button" className="workspace-draft-warning" aria-label="Recovered draft" aria-haspopup="dialog" aria-expanded={recoveryOpen} title="Recovered draft" onClick={event=>{event.stopPropagation();onRecover(event.currentTarget);}}><WorkspaceIcon name="warning"/></button></span>}
  </div>
  {panel&&<><div className={'workspace-management-backdrop '+(panel==='library'||panel==='trash'||panel==='delete'||formPanel||transferPanel||switchFailure?'dimmed':'')} onPointerDown={()=>{if(panel==='compact'&&!switchFailure)close();}}/><div ref={surface} role="dialog" aria-modal="true" aria-label={panel==='library'?'All workspaces':'Workspace manager'} className={'workspace-management-surface '+(panel==='library'||panel==='trash'||transferPanel?'expanded':'compact')} onDragOver={event=>{if(panel==='library'&&isFileDrag(event)){event.preventDefault();event.dataTransfer.dropEffect='copy';setFileDrag(true);}}} onDragLeave={()=>setFileDrag(false)} onDrop={event=>{if(panel==='library'&&isFileDrag(event)){event.preventDefault();setFileDrag(false);setDroppedFiles(Array.from(event.dataTransfer.files));setPanel('import');}}} onKeyDown={event=>{
   if(event.key==='Escape'){if(busy||working)return;event.preventDefault();event.stopPropagation();if(confirmDiscard){setConfirmDiscard(false);setError('');}else if(switchFailure){setSwitchFailure(undefined);setError('');}else if(panel==='delete'){cancelDelete();}else close();}
   if(event.key==='Tab'){const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type=file]),summary'));const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  }}>
   <header className="workspace-manager-heading"><div className="workspace-identity"><h3 title={heading}>{heading}</h3>{!formPanel&&!transferPanel&&!switchFailure&&<small>{panel==='library'?'Saved on this computer':panel==='delete'?'Selected workspace':panel==='trash'?'On this computer':'Current workspace'}</small>}</div>
    {!formPanel&&!transferPanel&&!switchFailure&&panel==='compact'&&<button className="workspace-rename" aria-label="Rename workspace" disabled={busy||blocked||empty} onClick={startRename}>Rename</button>}
    <button className="workspace-close" aria-label="Close workspace manager" disabled={busy||working} onClick={close}><WorkspaceIcon name="close"/></button>
   </header>
   {blocked&&<p className="workspace-feedback" role="status">Active execution: browse available; switching waits for cleanup.</p>}
   {notice&&!switchFailure&&<p className="workspace-feedback" role="status">{notice}</p>}
   {fileDrag&&<p className="workspace-drop-target dragging" role="status">Drop to import workspace</p>}
   {panel==='delete'?<><p className="workspace-form-description">Move “{deleteTarget?.name}” to Trash? It can be restored on this computer.</p><p className="workspace-form-description">Workspace ID: {deleteTarget?.id}</p><div className="workspace-form-actions"><button disabled={busy||working} onClick={cancelDelete}>Cancel</button><button className="workspace-danger" disabled={busy||blocked||working} onClick={()=>void moveToTrash()}>{working?'Moving…':'Move to Trash'}</button></div></>:panel==='trash'?<><p className="workspace-form-description">Recoverable workspaces on this computer. Restore keeps your current editor open.</p><div className="workspace-library-scroll">{loading?<p role="status">Loading Trash…</p>:<><ul className="workspace-library">{items.map(item=><li key={item.id}><span className="workspace-row-content"><strong>{item.name}</strong><small>{item.scenarios} scenarios · {item.screens} screens</small><small>Workspace ID: {item.id}</small></span><button disabled={busy||working} aria-label={'Restore '+item.name+' · '+item.id} onClick={()=>void restore({id:item.id})}>Restore</button></li>)}</ul>{!items.length&&!error&&<p>Trash is empty.</p>}{!!library?.unreadable&&<p role="alert">{library.unreadable} unreadable Trash record(s). Repair the local record and retry.</p>}</>}</div><button onClick={()=>{setError('');setPanel('library');}}>View all workspaces</button></>:transferPanel?<WorkspaceTransfer mode={panel} token={token} blocked={blocked} busy={busy} initialFiles={droppedFiles} onExport={onExport} onImport={async(pkg,name,filename)=>{const action:Action={kind:'import',package:pkg,name,filename};const saved=await onPrepare(action);await onAction(action,saved);close();}} onCancel={close}/>:switchFailure?<><p className="workspace-form-description">{confirmDiscard?`Discard unsaved changes to “${name}” and switch? This can't be undone.`:"Couldn't save your changes before switching."}</p><div className="workspace-form-actions">{confirmDiscard?<><button className="workspace-danger" disabled={busy} onClick={()=>void discardSwitch()}>Discard</button><button disabled={busy} onClick={()=>setConfirmDiscard(false)}>Cancel</button></>:<><button className="workspace-danger" disabled={busy} onClick={()=>setConfirmDiscard(true)}>Discard changes and switch</button><button disabled={busy} onClick={()=>{setSwitchFailure(undefined);setError('');}}>Cancel</button><button className="workspace-primary" disabled={busy} onClick={()=>void retrySwitch()}>Retry</button></>}</div></>:formPanel?<form onSubmit={event=>{event.preventDefault();const value=title.trim();if(!value||value.length>120){setError('Use a title of 1–120 characters.');return;}void choose({kind:panel,name:value});}}>
    <label htmlFor="workspace-title-input">{panel==='rename'?'Workspace title':panel==='copy'?'Copy title':'New workspace title'}</label><input id="workspace-title-input" value={title} maxLength={120} onChange={event=>setTitle(event.target.value)}/>
    {panel==='copy'&&<p className="workspace-form-description">An independent editable copy. Runtime inputs and previous run results stay with the original session.</p>}
    <div className="workspace-form-actions"><button type="button" disabled={busy||working} onClick={close}>Cancel</button><button className="workspace-primary" disabled={busy||blocked} onClick={event=>{switchOpener.current=event.currentTarget;}}>{panel==='rename'?'Done':panel==='copy'?'Create copy':'Create workspace'}</button></div>
   </form>:<>
    <label className="sr-only" htmlFor="workspace-search">Find workspace</label><div className="workspace-search"><WorkspaceIcon name="search"/><input id="workspace-search" type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search workspaces"/></div>
    <div className="workspace-section-label">{query?'Search results':panel==='library'?'Your workspaces':'Recently opened'}</div>
    <div className="workspace-library-scroll">
    {loading?<p className="workspace-feedback" role="status">Loading workspaces…</p>:<>
     {!error&&!items.length&&<p className="workspace-feedback">{query?'No matching workspaces. Try another name.':'No saved workspaces yet. Create work and save it here.'}</p>}
     <ul className="workspace-library">{(panel==='compact'&&!query?items.slice(0,5):items).map(item=>{
      const duplicate=items.some(other=>other.id!==item.id&&other.name===item.name);
      const dates='Created '+new Date(item.createdAt).toLocaleString()+' · Saved '+new Date(item.updatedAt).toLocaleString();
      return <li key={item.id} className={duplicate?'workspace-duplicate':undefined}><button aria-current={item.id===id?'true':undefined} title={dates} disabled={busy||blocked} aria-label={'Open '+item.name+' · '+item.createdAt+' · '+item.screens+' screens · '+item.scenarios+' scenarios'} onClick={event=>{switchOpener.current=event.currentTarget;void choose({kind:'open',id:item.id});}}>
       <WorkspaceIcon name="document"/><span className="workspace-row-content"><strong>{item.name}</strong><small>{item.scenarios} {item.scenarios===1?'scenario':'scenarios'}{panel==='library'&&' · '+item.screens+' screens'} · {item.id===id?'Current':'Saved '+workspaceDate(item.updatedAt)}</small>{duplicate&&<small className="workspace-row-date">Created {new Date(item.createdAt).toLocaleString()}</small>}</span>{item.id===id&&<WorkspaceIcon name="check"/>}
      </button>{panel==='library'&&<button className="workspace-row-delete workspace-danger" disabled={busy||working||(blocked&&item.id===id)} aria-label={'Delete '+item.name+' · '+item.id} onClick={event=>startDelete(item,event.currentTarget)}>Delete</button>}{duplicate&&<details className="workspace-row-details"><summary aria-label={'Diagnostic details for '+item.name} title="Workspace details"><WorkspaceIcon name="more"/></summary><div><small>Created {new Date(item.createdAt).toISOString()}</small><small>Workspace ID: {item.id}</small></div></details>}</li>;
     })}</ul>
     {!!library?.unreadable&&<p className="workspace-feedback" role="alert">{library.unreadable} unreadable workspace record(s). Other work is available. Repair the local record and retry.</p>}
    </>}
    </div>
    {panel==='compact'&&<button className="workspace-view-all" onClick={()=>setPanel('library')}><span>View all workspaces</span><WorkspaceIcon name="arrow"/></button>}
    <div className="workspace-commands">
     <button className="workspace-command" disabled={busy||!token||empty} onClick={()=>setPanel('export')}><WorkspaceIcon name="save"/><span>Export workspace…</span></button>
     <button className="workspace-command" disabled={busy||!token} onClick={()=>{setDroppedFiles(undefined);setPanel('import');}}><WorkspaceIcon name="document"/><span>Import workspace…</span></button>
     {panel==='library'&&<button className="workspace-command" disabled={busy||blocked||empty} onClick={startRename}><WorkspaceIcon name="document"/><span>Rename workspace</span></button>}
     <button className="workspace-command" disabled={busy||blocked||empty} onClick={startCopy}><WorkspaceIcon name="copy"/><span>Save a copy</span></button>
    </div>
    <div className="workspace-trash-commands">{id&&<button className="workspace-command workspace-danger" disabled={busy||blocked||working} onClick={event=>startDelete({id,name},event.currentTarget)}>Delete workspace</button>}<button className="workspace-command" disabled={working} onClick={()=>{setError('');setPanel('trash');}}>Trash</button></div>
    <footer className="workspace-manager-footer"><button className="workspace-command" disabled={busy||blocked} onClick={startNew}><WorkspaceIcon name="plus"/><span>New workspace</span></button><small>On this computer · Autosave</small></footer>
   </>}
   {actionError&&<p className="workspace-feedback workspace-error" role="alert">{actionError}{reopenTarget&&<button disabled={busy||working} onClick={()=>void reopen(reopenTarget)}>Retry Open</button>}</p>}
   {error&&<p className="workspace-feedback workspace-error" role="alert">{error} {(panel==='compact'||panel==='library'||panel==='trash')&&<button disabled={busy} onClick={()=>setRetry(value=>value+1)}>Retry library</button>}</p>}
  </div></>}
 </div>;
}
export type WorkspaceAction=Action;
