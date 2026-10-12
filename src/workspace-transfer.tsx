import {useEffect,useRef,useState,type DragEvent} from 'react';
import {runnerClient} from './runner-client.js';
import type {WorkspacePackage,PackageReview} from '../server/workspace-package.js';
export type PackageResult={package:WorkspacePackage;review:PackageReview;filename?:string};
export type ExportOptions={includeValues:boolean;savedOnly:boolean};
export function isFileDrag(event:DragEvent){return Array.from(event.dataTransfer.types).includes('Files');}
export function WorkspaceTransfer({mode,token,blocked,busy,initialFiles,onExport,onImport,onCancel}:{mode:'export'|'import';token:string;blocked:boolean;busy:boolean;initialFiles?:File[];onExport:(options:ExportOptions)=>Promise<PackageResult>;onImport:(pkg:WorkspacePackage,name:string)=>Promise<void>;onCancel:()=>void}){
 const [result,setResult]=useState<PackageResult>();const [filename,setFilename]=useState('');const [title,setTitle]=useState('');const [error,setError]=useState('');const [loading,setLoading]=useState(false);const [includeValues,setIncludeValues]=useState(false);const [savedOnly,setSavedOnly]=useState(blocked);const [dragging,setDragging]=useState(false);
 const picker=useRef<HTMLInputElement>(null);const generation=useRef(0);const committed=useRef(false);
 useEffect(()=>()=>{generation.current++;},[]);
 async function reviewExport(values:boolean,saved:boolean){
  const ticket=++generation.current;setResult(undefined);setLoading(true);setError('');
  try{const reviewed=await onExport({includeValues:values,savedOnly:saved});if(ticket===generation.current)setResult(reviewed);}
  catch(error){if(ticket===generation.current)setError(error instanceof Error?error.message:'Export failed.');}
  finally{if(ticket===generation.current)setLoading(false);}
 }
 async function reviewFiles(files:File[]){
  const ticket=++generation.current;setResult(undefined);setError('');setFilename('');
  if(files.length!==1){setLoading(false);setError('Choose or drop exactly one workspace JSON file.');return;}
  const file=files[0];setFilename(file.name);
  if(!file.name.toLowerCase().endsWith('.json')){setLoading(false);setError('Choose a TnT workspace .json file.');return;}
  if(file.size>1_100_000){setLoading(false);setError('Workspace package exceeds 1.1 MB.');return;}
  setLoading(true);
  try{
   const text=await new Promise<string>((resolve,reject)=>{const reader=new window.FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('File could not be read. Choose another file.'));reader.readAsText(file);});
   const reviewed:PackageResult=await runnerClient(token)('/api/workspaces/import/review',{package:text});
   if(ticket!==generation.current)return;
   setResult(reviewed);setTitle((reviewed.review.title.slice(0,111)+' imported').slice(0,120));
  }catch(error){if(ticket===generation.current)setError(error instanceof Error?error.message:'File could not be read. Choose another file.');}
  finally{if(ticket===generation.current)setLoading(false);}
 }
 useEffect(()=>{if(mode==='export')void reviewExport(false,blocked);else if(initialFiles)void reviewFiles(initialFiles);},[]);
 async function importCopy(){
  if(!result||committed.current)return;
  if(!title.trim()||title.trim().length>120){setError('Use a workspace title of 1–120 characters.');return;}
  committed.current=true;setLoading(true);setError('');
  try{await onImport(result.package,title.trim());}catch(error){setError(error instanceof Error?error.message:'Import failed. Current work is retained.');}finally{committed.current=false;setLoading(false);}
 }
 function download(){
  if(!result)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(result.package,null,2)+'\n'],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=result.filename??'workspace.tnt-workspace.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <div className="workspace-transfer">
  <p className="workspace-form-description">{mode==='import'?'Creates a new editable copy in this local runner store. Your existing workspaces are kept. Import does not run tests.':'Download an editable workspace package from an acknowledged saved revision.'}</p>
  {mode==='import'?<><input ref={picker} type="file" accept=".json,application/json" hidden aria-label="Choose workspace file" disabled={loading||busy} onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value='';void reviewFiles(files);}}/>
   <div className={'workspace-drop-target '+(dragging?'dragging':'')} onDragOver={event=>{if(isFileDrag(event)){event.preventDefault();event.dataTransfer.dropEffect='copy';setDragging(true);}}} onDragLeave={()=>setDragging(false)} onDrop={event=>{if(!isFileDrag(event))return;event.preventDefault();event.stopPropagation();setDragging(false);if(!loading&&!busy)void reviewFiles(Array.from(event.dataTransfer.files));}}>
    <p>{dragging?'Drop to import workspace':'Drop one TnT workspace JSON file here (up to 1.1 MB).'}</p><button disabled={loading||busy} onClick={()=>picker.current?.click()}>{filename?'Choose another file':'Choose file'}</button>
   </div></>:<>
   <label className="workspace-transfer-option"><input type="checkbox" checked={includeValues} disabled={loading||busy} onChange={event=>{setIncludeValues(event.target.checked);void reviewExport(event.target.checked,savedOnly);}}/>Include stored test input, setup and handler invocation values</label>
   <p className="workspace-form-description">Values are excluded by default; parameter names and contracts remain declared. Authored YAML and mock literals are included. Review them yourself before sharing; no automatic secret detection or safety certification is provided.</p>
   {(error||blocked||savedOnly)&&<button disabled={loading||busy} onClick={()=>{setSavedOnly(true);void reviewExport(includeValues,true);}}>Review last saved revision</button>}
  </>}
  {loading&&<p role="status">{committed.current?'Preserving current work and importing…':'Validating and reviewing…'}</p>}
  {result&&<>
   {mode==='import'&&<><p className="workspace-package-filename">File: {filename}</p><label htmlFor="workspace-import-title">Copy title</label><input id="workspace-import-title" aria-label="Import title" value={title} maxLength={120} disabled={loading||busy} onChange={event=>setTitle(event.target.value)}/></>}
   <p>Format: TnT workspace v{result.package.version} · Saved revision {result.package.source.revision} · {new Date(result.package.source.savedAt).toLocaleString()}</p>
   {mode==='export'&&savedOnly&&<p role="status">Only the identified saved revision is included. Current drafts and active run snapshots are unchanged.</p>}
   <p>Includes: {result.review.screens} shared screens, {result.review.connections} connections, {result.review.scenarios} ordered scenarios, YAML, {result.review.flows} reusable flows, {result.review.images} embedded PNG/JPEG reference images{result.review.automation?', setup and handlers':''}{result.review.mock?', mock definitions':''}.</p>
   <p>Excludes runtime values, runner tokens, ownership/session state, local machine paths, recovery drafts, personal view preferences and historical logs/screenshots/results.</p>
   <ul aria-label="Package dependencies">{result.review.dependencies.map(item=><li key={item}>{item}</li>)}</ul>
   {!!result.review.missing.length&&<div className="workspace-package-issues" role="status"><strong>Repair required before execution</strong><ul>{result.review.missing.map(item=><li key={item}>{item}</li>)}</ul></div>}
   <details><summary>Review package content</summary><pre>{JSON.stringify(result.package,null,2)}</pre></details>
  </>}
  {error&&<p className="workspace-feedback workspace-error" role="alert">{error}</p>}
  <div className="workspace-form-actions"><button disabled={committed.current} onClick={onCancel}>Cancel</button>{mode==='export'?<button className="workspace-primary" disabled={!result||loading||busy} onClick={download}>Export file</button>:<button className="workspace-primary" disabled={!result||loading||busy||blocked} onClick={()=>void importCopy()}>Import and open</button>}</div>
 </div>;
}
