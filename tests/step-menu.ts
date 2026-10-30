import {flushSync} from 'react-dom';

/** Opens the portaled step ⋯ menu and returns the item. No-op when the label is not a step action. */
export function openStepMenuItem(document:Document,label:string,scope?:ParentNode):HTMLButtonElement|undefined{
  const move=/^Move (.+) (?:up|down)$/.exec(label);
  const del=/^Delete (.+)$/.exec(label);
  const name=move?.[1]??del?.[1];
  if(!name)return;
  const wanted=name.toLowerCase();
  const root=scope??document;
  const trigger=[...root.querySelectorAll<HTMLButtonElement>('.step-actions-trigger')].find(button=>{
    const title=(button.getAttribute('title')??'').replace(/ actions$/,'').toLowerCase();
    const aria=(button.getAttribute('aria-label')??'').toLowerCase();
    return title===wanted||aria===`script actions ${wanted}`;
  });
  if(!trigger)return;
  if(trigger.getAttribute('aria-expanded')!=='true')flushSync(()=>trigger.click());
  return [...document.querySelectorAll<HTMLButtonElement>('.step-actions-menu [role="menuitem"]')].find(button=>button.getAttribute('aria-label')===label);
}
