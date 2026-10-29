import {useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent as ReactKeyboardEvent,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

export type StepMenuItem={label:ReactNode;ariaLabel:string;disabled?:boolean;className?:string;onSelect:()=>void};

let current:string|null=null;
const listeners=new Set<(id:string|null)=>void>();
function setCurrent(id:string|null){current=id;for(const listener of listeners)listener(id);}
function subscribe(listener:(id:string|null)=>void){listeners.add(listener);return()=>listeners.delete(listener);}

function placeMenu(trigger:HTMLElement,menu:HTMLElement){
  const rect=trigger.getBoundingClientRect();
  const width=menu.offsetWidth;
  const height=menu.offsetHeight;
  const below=window.innerHeight-rect.bottom;
  const above=rect.top;
  let top=rect.bottom;
  if(height>below&&above>below)top=Math.max(8,rect.top-height);
  let left=rect.right-width;
  if(left<8)left=8;
  if(left+width>window.innerWidth-8)left=Math.max(8,window.innerWidth-8-width);
  menu.style.top=top+'px';
  menu.style.left=left+'px';
}

export function StepActionsMenu({label,title,className,items}:{label:string;title?:string;className?:string;items:StepMenuItem[]}){
  const id=useId();
  const triggerRef=useRef<HTMLButtonElement>(null);
  const menuRef=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    const unsubscribe=subscribe(next=>setOpen(next===id));
    return()=>{unsubscribe();if(current===id)setCurrent(null);};
  },[id]);
  const keyed=useRef(false);
  function close(restore:boolean){
    if(current===id)setCurrent(null);
    if(restore)triggerRef.current?.focus({preventScroll:true});
  }
  function toggle(){if(current===id)close(false);else setCurrent(id);}
  useLayoutEffect(()=>{
    if(!open||!triggerRef.current||!menuRef.current)return;
    placeMenu(triggerRef.current,menuRef.current);
    menuRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({preventScroll:true});
  },[open]);
  useEffect(()=>{
    if(!open)return;
    const menu=menuRef.current;
    const trigger=triggerRef.current;
    function outside(event:Event){
      const target=event.target as Node|null;
      if(target&&(menu?.contains(target)||trigger?.contains(target)))return;
      close(false);
    }
    function onScroll(event:Event){if(menu?.contains(event.target as Node))return;close(false);}
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('scroll',onScroll,true);
    window.addEventListener('resize',outside);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('scroll',onScroll,true);window.removeEventListener('resize',outside);};
  },[open]);
  function onMenuKey(event:ReactKeyboardEvent<HTMLDivElement>){
    const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
    if(event.key==='Tab'){close(false);return;}
    if(!buttons.length||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length;
    buttons[next]?.focus({preventScroll:true});
  }
  return <div className={'visit-step-actions'+(className?' '+className:'')}>
    <button ref={triggerRef} type="button" className="step-actions-trigger" aria-label={label} title={title} aria-haspopup="menu" aria-expanded={open} onClick={()=>{if(keyed.current){keyed.current=false;return;}toggle();}} onKeyDown={event=>{if(event.key!=='Enter'&&event.key!==' ')return;event.preventDefault();event.stopPropagation();keyed.current=true;toggle();queueMicrotask(()=>{keyed.current=false;});}}>⋯</button>
    {open&&createPortal(<div ref={menuRef} role="menu" aria-label={label} className="step-actions-menu" onKeyDown={onMenuKey} onMouseDown={event=>event.preventDefault()}>{items.map(item=><button type="button" role="menuitem" key={item.ariaLabel} className={item.className} aria-label={item.ariaLabel} disabled={item.disabled||undefined} tabIndex={-1} onClick={()=>{close(false);item.onSelect();}}>{item.label}</button>)}</div>,document.body)}
  </div>;
}
