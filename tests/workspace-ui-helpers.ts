import assert from 'node:assert/strict';
import {act} from 'react';
export async function workspaceCommand(document:Document,command:'save'|'open',settle:()=>Promise<void>=async()=>{}){
 async function waitFor<T>(read:()=>T|undefined,description:string):Promise<T>{
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){
   await act(async()=>{await new Promise(resolve=>setImmediate(resolve));await settle();});
   const result=read();if(result!==undefined)return result;
  }
  assert.fail('Timed out waiting for '+description+'. '+(document.querySelector('.workspace-management-surface')?.textContent??''));
 }
 async function press(button:HTMLButtonElement|undefined){assert.ok(button);await act(async()=>{button.click();await settle();});}
 if(command==='save'){
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await settle();});
  return;
 }else{
  if(!document.querySelector('[aria-label="Workspace manager"]'))await press(document.querySelector<HTMLButtonElement>('[aria-label="Manage workspace"]')??undefined);

  // Event-loop turns do not acknowledge filesystem/network work under load.
  await press(await waitFor(()=>document.querySelector<HTMLButtonElement>('.workspace-library button:not(:disabled)')??undefined,'the workspace library'));
  await waitFor(()=>document.querySelector('.workspace-management-surface')?undefined:true,'the workspace to finish opening');
 }
}
/** Step controls live in the floating inspector, which only exists for the selected screen. */
export function inspectorCard(document:Document){return document.querySelector<HTMLElement>('.floating-inspector');}
export async function inspectScreen(document:Document,screen:{id?:string;title?:string},visit?:{id?:string;number?:number}){
 const node=[...document.querySelectorAll<HTMLElement>('[data-screen-id]')].find(item=>screen.id?item.dataset.screenId===screen.id:item.getAttribute('aria-label')==='Screen '+screen.title);
 assert.ok(node,'Missing screen '+(screen.id??screen.title));
 if(!node.classList.contains('selected-screen')||!inspectorCard(document))await act(async()=>node.querySelector<HTMLButtonElement>('.screen-node-heading')!.click());
 const card=inspectorCard(document);assert.ok(card,'The inspector did not open for '+(screen.id??screen.title));
 if(visit){
  const section=[...card.querySelectorAll<HTMLElement>('[data-visit-id]')].find(item=>visit.id?item.dataset.visitId===visit.id:item.getAttribute('aria-label')?.startsWith('Visit '+visit.number+' · '));
  assert.ok(section,'Missing visit '+(visit.id??visit.number));
  const heading=section.querySelector<HTMLButtonElement>('.visit-section-heading')!;
  if(heading.getAttribute('aria-expanded')!=='true')await act(async()=>heading.click());
  return section;
 }
 return card;
}
/** Opens a screen's inspector (and visit) and returns the document, so existing selectors keep working. */
export async function inspected(document:Document,title:string,visit?:number){await inspectScreen(document,{title},visit===undefined?undefined:{number:visit});return document;}
/** Names the screen whose inspector holds a screen-specific button, such as "Add check to Home". */
export function inspectorOwner(label:string){return /^Use (.+) as scenario start$/.exec(label)?.[1]??/^Add (?:action|check) to (?!connection )(.+)$/.exec(label)?.[1];}
export function singleWorkspaceLibrary(workspace:{id:string;name:string}){return {items:[{id:workspace.id,name:workspace.name,createdAt:'2026-10-12T00:00:00.000Z',updatedAt:'2026-10-12T00:00:00.000Z',openedAt:'2026-10-12T00:00:00.000Z',screens:1,scenarios:1,revision:1}],unreadable:0};}
