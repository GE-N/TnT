import {readdir} from 'node:fs/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {alwaysOwned,KnowledgeError,workspaceId} from '../types.js';
import {readSafe,safeDirectory} from '../files.js';
import type {KnowledgeService} from '../index.js';
import {KNOWLEDGE_CSP,KNOWLEDGE_CSP_HEADER} from './csp.js';
import {escapeHtml} from './escape.js';
import {applyLiveStatus,embeddedAsOf,embeddedWorkspaceTitle,indexDetail,renderLiveIndex,type ReaderLiveStatus} from './render.js';

const HEADERS={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':KNOWLEDGE_CSP_HEADER,'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};

function send(response:ServerResponse,status:number,body:string,extra:Record<string,string>={},head=false){
  response.writeHead(status,{...HEADERS,...extra});
  response.end(head?undefined:body);
}
function textPage(heading:string,message:string){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${KNOWLEDGE_CSP}"><title>${escapeHtml(heading)}</title></head><body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}
function hidden(error:unknown){
  return error instanceof KnowledgeError&&(error.status===404||(error.status===503&&/visibility/i.test(error.message)));
}
function decodeWorkspaceId(value:string){
  let decoded=value;
  if(value.includes('%')){try{decoded=decodeURIComponent(value);}catch{throw new KnowledgeError(400,'INVALID_KNOWLEDGE_INPUT','Invalid identifier encoding.');}}
  return workspaceId(decoded);
}
async function readWorkspaceHtml(directory:string,id:string){
  return readSafe(await safeDirectory(directory,['workspaces'],alwaysOwned),id+'.html');
}
async function publishedIds(root:string){
  try{
    const directory=await safeDirectory(root,['knowledge','current'],alwaysOwned);
    const ids:string[]=[];
    for(const name of await readdir(directory)){
      const match=/^workspace-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/.exec(name);
      if(match)ids.push(match[1]);
    }
    ids.sort();
    return ids;
  }catch{return [];}
}
async function workspacePage(knowledge:KnowledgeService,id:string){
  let pin;
  try{pin=await knowledge.pinCurrent(id);}
  catch(error){
    if(hidden(error))throw new KnowledgeError(404,'KNOWLEDGE_NOT_FOUND','This workspace is not available.');
    throw error;
  }
  try{
    const html=await readWorkspaceHtml(pin.directory,id);
    // A failed live check must not fall back to freshness stored in the generation.
    let live:ReaderLiveStatus|null=null;
    try{live=await knowledge.status(id);}
    catch(error){if(hidden(error))throw new KnowledgeError(404,'KNOWLEDGE_NOT_FOUND','This workspace is not available.');}
    return applyLiveStatus(html,live,new Date());
  }finally{pin.release();}
}
async function indexPage(knowledge:KnowledgeService,root:string){
  const entries:{href:string;titleHtml:string;detailHtml:string}[]=[];
  for(const id of await publishedIds(root)){
    try{
      const pin=await knowledge.pinCurrent(id);
      try{
        const html=await readWorkspaceHtml(pin.directory,id);
        let live:ReaderLiveStatus|null=null;
        try{live=await knowledge.status(id);}
        catch(error){if(hidden(error))continue;}
        entries.push({href:'/knowledge/workspaces/'+id+'/',titleHtml:embeddedWorkspaceTitle(html,id),detailHtml:indexDetail(live,embeddedAsOf(html))});
      }finally{pin.release();}
    }catch{/* Omit workspaces that are hidden, pending, or not safely readable. */}
  }
  return renderLiveIndex(entries);
}

/** Read-only runner routes. GET /knowledge/ is the live index; workspace pages recheck visibility and freshness. */
export async function handleKnowledgeReader(request:IncomingMessage,response:ServerResponse,url:URL,knowledge:KnowledgeService,root:string){
  const head=request.method==='HEAD';
  if(request.method!=='GET'&&!head)return send(response,405,textPage('Method not allowed','The knowledge reader is read-only.'),{Allow:'GET, HEAD'});
  try{
    if(url.pathname==='/knowledge'||url.pathname==='/knowledge/')return send(response,200,await indexPage(knowledge,root),{},head);
    const match=/^\/knowledge\/workspaces\/([^/]+)\/?$/.exec(url.pathname);
    if(!match)return send(response,404,textPage('Not found','Knowledge page not found.'),{},head);
    return send(response,200,await workspacePage(knowledge,decodeWorkspaceId(match[1])),{},head);
  }catch(error){
    if(error instanceof KnowledgeError){
      const status=error.status===404?404:error.status===400?400:error.status===413?413:503;
      const heading=status===404?'Not found':status===400?'Invalid request':'Unavailable';
      const message=status===404?'This workspace is not available.':status===400?'Invalid workspace identifier.':'Knowledge is not available right now.';
      return send(response,status,textPage(heading,message),{},head);
    }
    return send(response,503,textPage('Unavailable','Knowledge is not available right now.'),{},head);
  }
}
