import {useEffect,useRef,useState} from 'react';
import {canvasTestLabel} from '../shared/canvas-authoring.js';
import type {Run} from '../server/scenarios.js';
import {CanvasBoard,type CanvasInspection} from './canvas.js';

export function ExecutedCanvas({run,onArtifact}:{run:Run;onArtifact:(name:string)=>void}){
 const [selection,setSelection]=useState<CanvasInspection>();
 const evidence=useRef<HTMLElement>(null);
 useEffect(()=>{if(selection){evidence.current?.focus();evidence.current?.scrollIntoView?.({block:'nearest'});}},[selection]);
 const graph=run.snapshot.canvas;const result=run.canvas;
 if(!graph||!result)return null;
 const transition=selection?.kind==='transition'?graph.execution?.transitions.find(item=>item.id===selection.id):undefined;
 const occurrences=result.occurrences?.filter(item=>selection?.kind==='occurrence'?item.id===selection.id:selection?.kind==='visit'?item.visitId===selection.id:transition?item.visitId===transition.visitId&&item.edgeId===transition.edgeId||item.visitId===transition.destinationVisitId&&!item.edgeId:false)??[];
 const visit=result.visits?.find(item=>item.id===selection?.id);
 const transitionResult=result.transitions?.find(item=>item.id===selection?.id);
 return <details open><summary>Executed canvas · {graph.paths.find(path=>path.id===result.pathId)?.name}</summary>
  <p>Immutable scenario snapshot · {run.snapshot.scenario?.name??run.snapshot.name} · {run.startedAt}</p><p>{result.note}</p>
  <CanvasBoard graph={graph} pathId={result.pathId} result={result} onInspect={setSelection}/>
  {selection&&<section ref={evidence} tabIndex={-1} aria-label="Execution evidence" className="execution-evidence">
   <h3>{selection.kind==='visit'?'Visit':selection.kind==='transition'?'Connection occurrence':'Action/check occurrence'} evidence · {visit?.status??transitionResult?.status??occurrences[0]?.status??'unavailable'}</h3>
   <p>Scenario: {run.snapshot.scenario?.name??run.snapshot.name} · Run: {run.id}</p>
   {!occurrences.length&&<p>No action/check evidence for this item. Inspect the executed commands below.</p>}
   {occurrences.map(item=>{
    const test=graph.screens.flatMap(screen=>screen.tests).find(test=>test.id===item.testId);
    const step=run.steps.find(step=>step.id===item.stepId);
    const screenshots=step?.artifacts?.filter(name=>name.endsWith('.png'))??[];
    return <article key={item.id}>
     <h4>{test?canvasTestLabel(test):item.testId} · {item.status}</h4><p>Occurrence: {item.id} · {item.stepId??'No mapped command'}</p>
     <strong>Expected</strong><pre>{JSON.stringify(step?.expected??test?.check??test?.tap??test?.backSelector??test?.input??test?.reference??'Expected conditions unavailable',null,2)}</pre>
     <strong>Actual result</strong><p>{item.detail}</p><pre>{step?.actual?JSON.stringify(step.actual,null,2):'Evaluated command evidence unavailable or withheld.'}</pre>
     {screenshots.length?screenshots.map(name=><button className="text-button" key={name} onClick={()=>onArtifact(name)}>Inspect screenshot · {name}</button>):<p>Screenshot evidence unavailable or withheld for this occurrence.</p>}
     {step?.artifacts?.filter(name=>!name.endsWith('.png')).map(name=><button className="text-button" key={name} onClick={()=>onArtifact(name)}>Inspect evidence · {name}</button>)}
    </article>;
   })}
   <details open><summary>Run log · shared run evidence</summary><pre>{run.log||'Log evidence unavailable.'}</pre></details>
  </section>}
  {result.tests.map(test=><p key={test.id}>{(()=>{const authored=graph.screens.flatMap(screen=>screen.tests).find(item=>item.id===test.id);return authored?canvasTestLabel(authored):test.id;})()}: {test.status} · {test.detail}</p>)}
 </details>;
}
