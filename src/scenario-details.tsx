import {useEffect,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';

export type ScenarioDetailsProps={
 open?:boolean;
 onClose?:()=>void;
 anchor?:RefObject<HTMLElement|null>;
 id?:string;
 children?:ReactNode;
};

/** Scenario details shell. Position is measured into style so a resize never remounts the panel or moves focus. */
export function ScenarioDetails({open=false,onClose,anchor,id,children}:ScenarioDetailsProps){
 const panel=useRef<HTMLDivElement>(null);
 const [box,setBox]=useState<{top:number;right:number}>();
 useLayoutEffect(()=>{
  const bar=anchor?.current;
  if(!open||!bar)return;
  const measure=()=>{
   const rect=bar.getBoundingClientRect();
   const top=rect.bottom+8;
   const right=Math.max(0,window.innerWidth-rect.right);
   setBox(current=>current&&current.top===top&&current.right===right?current:{top,right});
  };
  measure();
  const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(measure);
  observer?.observe(bar);
  window.addEventListener('resize',measure);
  return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
 },[open,anchor]);
 useLayoutEffect(()=>{
  if(!open)return;
  panel.current?.querySelector<HTMLElement>('[aria-label="Search scenarios"]')?.focus();
 },[open]);
 useEffect(()=>{
  if(!open)return;
  function onKey(event:KeyboardEvent){
   if(event.key!=='Escape'||event.defaultPrevented)return;
   const target=event.target as Node|null;
   const element=target&&typeof target.nodeType==='number'?(target.nodeType===1?target as Element:target.parentElement):null;
   if(element?.closest('.scenario-context-menu,[aria-label="Rename scenario"]'))return;
   event.preventDefault();
   onClose?.();
  }
  function onPointer(event:PointerEvent){
   const target=event.target;
   if(!target||typeof (target as Node).nodeType!=='number')return;
   const node=target as Node;
   if(panel.current?.contains(node))return;
   const trigger=anchor?.current?.querySelector('[data-testid="scenario-bar-trigger"]');
   if(trigger?.contains(node))return;
   const element=node.nodeType===1?node as Element:node.parentElement;
   if(element?.closest('.scenario-context-menu'))return;
   onClose?.();
  }
  document.addEventListener('keydown',onKey);
  document.addEventListener('pointerdown',onPointer);
  return()=>{document.removeEventListener('keydown',onKey);document.removeEventListener('pointerdown',onPointer);};
 },[open,onClose,anchor]);
 if(!open)return null;
 const top=box?.top??0;
 return <div ref={panel} id={id} role="dialog" aria-label="Scenario details" data-testid="scenario-panel" className="scenario-details-panel" style={{top,right:box?.right??0,maxHeight:`calc(100dvh - ${top+24}px)`}}>{children}</div>;
}
