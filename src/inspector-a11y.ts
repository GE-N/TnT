/** True when a single-key shortcut must not run (text fields, selects, YAML editor). */
export function isEditableTarget(target:EventTarget|null){
 if(!target||typeof (target as {closest?:unknown}).closest!=='function')return false;
 return !!(target as Element).closest('input,textarea,select,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"],.yaml-editor,[aria-label="YAML form and code editor"]');
}

const tabSelector='button,input,select,textarea,summary,a[href],[tabindex]';

function isInspectorTabStop(element:HTMLElement){
 if(element.tabIndex<0)return false;
 if(element.closest('[hidden]'))return false;
 if(element.closest('fieldset:disabled'))return false;
 if((element as HTMLButtonElement).disabled||element.getAttribute('aria-disabled')==='true')return false;
 const details=element.closest('details');
 if(details&&!details.open&&element.tagName!=='SUMMARY')return false;
 if(element.tagName==='INPUT'&&(element as HTMLInputElement).type==='radio'&&(element as HTMLInputElement).name){
  const name=(element as HTMLInputElement).name;
  const group=Array.from(element.ownerDocument.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(item=>item.name===name&&item.closest('.floating-inspector')===element.closest('.floating-inspector'));
  const chosen=group.find(item=>item.checked)??group[0];
  if(element!==chosen)return false;
 }
 return true;
}

function tabStops(root:HTMLElement,reorderPick:boolean){
 const stops=Array.from(root.querySelectorAll<HTMLElement>(tabSelector)).filter(isInspectorTabStop);
 if(!reorderPick)return stops;
 const pick=stops.find(element=>element.classList.contains('pick-from-screen'));
 const destination=stops.find(element=>(element.getAttribute('aria-label')??'').endsWith(' destination'));
 if(!pick||!destination)return stops;
 const ordered=stops.filter(element=>element!==pick);
 let insert=ordered.indexOf(destination)+1;
 if(ordered[insert]?.getAttribute('aria-label')==='New screen title')insert++;
 ordered.splice(insert,0,pick);
 return ordered;
}

/** DOM tab order, with Pick from screen placed after Destination so it can stay inside the Element field. */
export function inspectorTabStops(root:HTMLElement){
 return tabStops(root,true);
}

/** Moves focus when Pick would otherwise land before Destination. Native Tab handles every other stop, including leaving the inspector. */
export function moveInspectorTab(event:{key:string;shiftKey:boolean;target:EventTarget|null;preventDefault():void;stopPropagation():void},root:HTMLElement){
 if(event.key!=='Tab')return false;
 const current=event.target&&typeof (event.target as Element).closest==='function'?event.target as Element:null;
 if(!current||!root.contains(current))return false;
 const natural=tabStops(root,false);
 const desired=tabStops(root,true);
 const index=desired.findIndex(stop=>stop===current||stop.contains(current));
 if(index<0)return false;
 const next=desired[index+(event.shiftKey?-1:1)];
 const naturalIndex=natural.findIndex(stop=>stop===current||stop.contains(current));
 const naturalNext=natural[naturalIndex+(event.shiftKey?-1:1)];
 if(!next||next===naturalNext)return false;
 event.preventDefault();
 event.stopPropagation();
 next.focus();
 return true;
}
