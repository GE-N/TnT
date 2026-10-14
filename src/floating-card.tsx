import {useEffect,useRef,useState,type KeyboardEvent as ReactKeyboardEvent,type PointerEvent as ReactPointerEvent,type ReactNode} from 'react';

export type CardPosition={x:number;y:number};
export const floatingCardSize={width:440,height:480};
const keyboardStep=10;
const keyboardShiftStep=40;

/** Keeps a pop-out inside the window. A card taller or wider than the window sits at the origin. */
export function clampCard(position:CardPosition,viewport={width:window.innerWidth,height:window.innerHeight}):CardPosition{
  const maxX=Math.max(0,viewport.width-floatingCardSize.width);
  const maxY=Math.max(0,viewport.height-floatingCardSize.height);
  return {x:Math.min(Math.max(0,position.x),maxX),y:Math.min(Math.max(0,position.y),maxY)};
}

function isTextField(target:EventTarget|null){
  return target instanceof HTMLElement&&!!target.closest('input,textarea,select,[contenteditable="true"]');
}

export function FloatingCard({label,position,onPosition,opener,onClose,children}:{label:string;position?:CardPosition;onPosition?:(position:CardPosition)=>void;opener:HTMLElement|null;onClose:()=>void;children:ReactNode}){
  const fallback=label==='YAML'?{x:32,y:72}:{x:56,y:104};
  const [pos,setPos]=useState(()=>clampCard(position??fallback));
  const posRef=useRef(pos);
  const openerRef=useRef(opener);
  const handle=useRef<HTMLDivElement>(null);
  const drag=useRef<{x:number;y:number;clientX:number;clientY:number;moved:boolean}|undefined>(undefined);
  openerRef.current=opener;
  function commit(next:CardPosition){posRef.current=next;setPos(next);}
  function close(){openerRef.current?.focus();onClose();}
  useEffect(()=>{handle.current?.focus();},[]);
  useEffect(()=>{
    const snap=()=>{
      const next=clampCard(posRef.current);
      if(next.x===posRef.current.x&&next.y===posRef.current.y)return;
      commit(next);onPosition?.(next);
    };
    window.addEventListener('resize',snap);
    return()=>window.removeEventListener('resize',snap);
  },[onPosition]);
  function onPointerDown(event:ReactPointerEvent<HTMLDivElement>){
    if(event.button!==0)return;
    try{event.currentTarget.setPointerCapture(event.pointerId);}catch{/* Pointer capture is unavailable in some test renderers. */}
    drag.current={x:posRef.current.x,y:posRef.current.y,clientX:event.clientX,clientY:event.clientY,moved:false};
  }
  function onPointerMove(event:ReactPointerEvent<HTMLDivElement>){
    const current=drag.current;if(!current)return;
    current.moved=true;
    commit(clampCard({x:current.x+event.clientX-current.clientX,y:current.y+event.clientY-current.clientY}));
  }
  function onPointerUp(){
    const current=drag.current;drag.current=undefined;
    if(current?.moved)onPosition?.(posRef.current);
  }
  function onArrows(event:ReactKeyboardEvent){
    const vectors:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    const direction=vectors[event.key];if(!direction)return;
    event.preventDefault();
    const amount=event.shiftKey?keyboardShiftStep:keyboardStep;
    const next=clampCard({x:posRef.current.x+direction[0]*amount,y:posRef.current.y+direction[1]*amount});
    commit(next);onPosition?.(next);
  }
  return <div role="dialog" aria-label={label} className="floating-card" style={{left:pos.x,top:pos.y,width:floatingCardSize.width,height:floatingCardSize.height}} onKeyDown={event=>{
    if(event.key!=='Escape'||isTextField(event.target))return;
    event.preventDefault();event.stopPropagation();close();
  }}>
    <header className="floating-card-header">
      <div ref={handle} tabIndex={0} className="floating-card-handle" aria-label={'Move '+label} onKeyDown={onArrows} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>{label}</div>
      <button type="button" aria-label={'Close '+label} onClick={close}>✕</button>
    </header>
    <div className="floating-card-body">{children}</div>
  </div>;
}
