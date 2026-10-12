import {createContext,useContext,useEffect,useId} from 'react';
export const WorkspaceDrafts=createContext<(id:string,pending:boolean)=>void>(()=>{});
/** Local form values must be applied or cancelled before saving or replacing their owner. */
export function useWorkspaceDraft(pending:boolean){
 const report=useContext(WorkspaceDrafts);const id=useId();
 useEffect(()=>{report(id,pending);return()=>report(id,false);},[report,id,pending]);
}
