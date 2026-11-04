import type {Run} from '../scenarios.js';

export interface RootGuard { assertOwned(): void }
export const alwaysOwned:RootGuard={assertOwned(){}};
export type ContextContent={purpose:string;expectedOutcome:string;rationale:string;preconditions:string;exceptions:string;scope:string};
export type ScenarioContext=ContextContent & {schemaVersion:1;workspaceId:string;scenarioId:string;contextRevision:number;updatedAt:string|null;reviewedAgainstSourceHash:string|null};
export type SourceDescriptor={projectionVersion:1;workspaceRevision:number;sourceHash:string};
export type Freshness='up-to-date'|'updating'|'needs-review';
export type PublicationFreshness='current'|'publication-stale';
export type IntentFreshness='reviewed'|'intent-needs-review';
export type FlowStep={number:number;text:string;visitId?:string;testId?:string};
export type FlowFacts={steps:FlowStep[];visits:{number:number;id:string;screenId:string;title:string;steps:FlowStep[]}[];diagnostics:string[]};
export type Evidence={status:Run['status']|null;runId:string|null;finishedAt:string|null;label:string;notice:string};
export type ScenarioDetail={workspaceId:string;scenarioId:string;title:string;context:ScenarioContext;sourceDescriptor:SourceDescriptor;flow:FlowFacts;evidence:Evidence;freshness:Freshness;publicationFreshness:PublicationFreshness;intentFreshness:IntentFreshness;generationId:string|null;generatedAt:string|null;publicationError:string|null;readerUrl:string};
export type GenerationInput={generationId:string;scopeId:string;workspaceId:string;workspaceTitle:string;generatedAt:string;scenarios:ScenarioDetail[]};
export type IndexSection={documentId:string;sectionId:string;generationId:string;workspaceId:string;scenarioId:string;title:string;section:string;text:string;tags:string[];language:'und';sourceDescriptor:SourceDescriptor;contextRevision:number;generatedAt:string;kind:'authored-context'|'derived-flow-facts'|'observation';publicationFreshness:PublicationFreshness;intentFreshness:IntentFreshness;sourceReferences:string[];htmlLocation:string};
export type Manifest={formatVersion:1;generationId:string;scopeId:string;workspaceId:string;generatedAt:string;sources:{scenarioId:string;sourceDescriptor:SourceDescriptor;contextRevision:number}[];documents:{documentId:string;path:string;sha256:string}[];artifacts:{path:string;sha256:string}[]};
export type Pointer={formatVersion:1;scopeId:string;generationId:string;previousGenerationId:string|null;generatedAt:string;inputHash:string};
export type FaultStage='after-source-commit'|'after-descriptor-capture'|'artifact-write'|'before-generation-complete'|'before-validation'|'after-validation'|'before-final-check'|'after-final-check'|'before-pointer-rename'|'after-pointer-rename';
export type KnowledgeFaults={hit?:(stage:FaultStage,detail:{workspaceId:string;generationId?:string;path?:string})=>void|Promise<void>};
export type IndexingQueue={enqueue:(scopeId:string,job:()=>Promise<void>)=>void|Promise<void>};
export class KnowledgeError extends Error {
 constructor(public status:number,public code:string,message:string){super(message);}
}
export class ContextRevisionConflict extends KnowledgeError {
 constructor(public context:ScenarioContext){super(409,'CONTEXT_REVISION_CONFLICT','Context was changed in another editor.');}
 get currentContextRevision(){return this.context.contextRevision;}
}
export const contextFields=['purpose','expectedOutcome','rationale','preconditions','exceptions','scope'] as const;
export function workspaceId(id:string){if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw new KnowledgeError(400,'INVALID_KNOWLEDGE_INPUT','Invalid workspace identifier.');return id;}
export function scenarioId(id:string){if(typeof id!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))throw new KnowledgeError(400,'INVALID_KNOWLEDGE_INPUT','Invalid scenario identifier.');return id;}
export function scopeId(id:string){return 'workspace-'+workspaceId(id);}
export function emptyContext(workspace:string,scenario:string):ScenarioContext{return {schemaVersion:1,workspaceId:workspace,scenarioId:scenario,contextRevision:0,updatedAt:null,reviewedAgainstSourceHash:null,purpose:'',expectedOutcome:'',rationale:'',preconditions:'',exceptions:'',scope:''};}
export function validateContent(value:unknown):ContextContent{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==contextFields.length||Object.keys(value).some(key=>!contextFields.includes(key as typeof contextFields[number])))throw new KnowledgeError(400,'INVALID_KNOWLEDGE_INPUT','Provide the six scenario context fields.');
 for(const key of contextFields){const field=(value as Record<string,unknown>)[key];if(typeof field!=='string'||field.includes('\0'))throw new KnowledgeError(400,'INVALID_KNOWLEDGE_INPUT','Context fields must be plain strings without NUL.');if(Buffer.byteLength(field)>16000)throw new KnowledgeError(413,'KNOWLEDGE_TOO_LARGE','Context fields support at most 16000 UTF-8 bytes.');}
 return Object.fromEntries(contextFields.map(key=>[key,(value as ContextContent)[key]])) as ContextContent;
}
export function validateSave(value:unknown):{expectedContextRevision:number;context:ContextContent}{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!('expectedContextRevision' in value)||!('context' in value)||!Number.isSafeInteger(value.expectedContextRevision)||(value.expectedContextRevision as number)<0)throw new KnowledgeError(400,'INVALID_KNOWLEDGE_INPUT','Provide context and a nonnegative expectedContextRevision.');
 return {expectedContextRevision:value.expectedContextRevision as number,context:validateContent(value.context)};
}
