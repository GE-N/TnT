import {contextFields, type ContextContent} from '../knowledge/types.js';
import type {ScenarioCatalog} from './router.js';

type WorkspaceShape = {scenarios?: {id: string; name: string}[]};
type DetailShape = {view?: {scenarioId?: string} | null};
type ReadShape = {
  title: string;
  context: ContextContent & {contextRevision: number};
  flow: {visits: {title: string}[]; steps: {text: string}[]};
};

/** Current scenario from the saved view, otherwise the first saved scenario, via the knowledge read model. */
export function createScenarioCatalog(deps: {
  workspace(id: string): Promise<WorkspaceShape>;
  detail(id: string): Promise<DetailShape>;
  readContext(workspaceId: string, scenarioId: string): Promise<ReadShape>;
}) {
  return async (workspaceId: string): Promise<ScenarioCatalog> => {
    const workspace = await deps.workspace(workspaceId);
    const detail = await deps.detail(workspaceId);
    const scenarios = (workspace.scenarios ?? []).map(item => ({id: item.id, title: item.name}));
    const preferred = detail.view?.scenarioId;
    const currentId = preferred && scenarios.some(item => item.id === preferred) ? preferred : scenarios[0]?.id;
    if (!currentId) return {scenarios};
    const read = await deps.readContext(workspaceId, currentId);
    const context = Object.fromEntries(contextFields.map(field => [field, read.context[field]])) as ContextContent;
    return {
      scenarios,
      current: {
        id: currentId,
        title: read.title,
        visitTitles: read.flow.visits.map(visit => visit.title),
        steps: read.flow.steps.map(step => ({text: step.text})),
        context,
        contextRevision: read.context.contextRevision,
      },
    };
  };
}
