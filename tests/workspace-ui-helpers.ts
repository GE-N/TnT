import assert from 'node:assert/strict';
import {act} from 'react';
export async function workspaceCommand(document:Document,command:'save'|'open',settle:()=>Promise<void>=async()=>{}){
 async function press(button:HTMLButtonElement|undefined){assert.ok(button);await act(async()=>{button.click();await settle();});}
 if(command==='save'){
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await settle();});
  return;
 }else{
  if(!document.querySelector('[aria-label="Workspace manager"]'))await press(document.querySelector<HTMLButtonElement>('[aria-label="Manage workspace"]')??undefined);

  await act(async()=>{await settle();});
  await press(document.querySelector<HTMLButtonElement>('.workspace-library button')??undefined);
  for(let attempt=0;attempt<8;attempt++)await act(async()=>{await new Promise(resolve=>setImmediate(resolve));await settle();});
  if(document.querySelector('[aria-label="Workspace manager"]')?.textContent?.includes('Save changes'))await press([...document.querySelectorAll<HTMLButtonElement>('[aria-label="Workspace manager"] button')].find(button=>button.textContent==='Save and continue'));
 }
}
export function singleWorkspaceLibrary(workspace:{id:string;name:string}){return {items:[{id:workspace.id,name:workspace.name,createdAt:'2026-10-12T00:00:00.000Z',updatedAt:'2026-10-12T00:00:00.000Z',openedAt:'2026-10-12T00:00:00.000Z',screens:1,scenarios:1,revision:1}],unreadable:0};}
