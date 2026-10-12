import {createContext,useContext,useEffect,useId} from 'react';
export type DraftReport={pending:boolean;key?:string;value?:string};
export const WorkspaceDrafts=createContext<(id:string,report:DraftReport)=>void>(()=>{});
export const RecoveredFields=createContext<Record<string,string>>({});
/** Local form values are reported raw so a recovery draft can restore them. Confidential runtime inputs are not a field. */
export function useWorkspaceDraft(pending:boolean,fieldKey?:string,value?:string){
 const report=useContext(WorkspaceDrafts);const id=useId();
 useEffect(()=>{report(id,{pending,key:fieldKey,value:pending?value:undefined});return()=>report(id,{pending:false,key:fieldKey});},[report,id,pending,fieldKey,value]);
}
