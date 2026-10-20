import {applyFlow, undoFlow} from './apply.js';
import {createContextStore} from './context.js';
import {authoringError} from './errors.js';
import {createJournal, journalNow, reconcileJournal} from './journal.js';
import {createPreview, createPreviewStore} from './preview.js';
import {readFlow} from './read-back.js';
import {assertEnvelope, requireRevision, requireString, requireWorkspaceId} from './schema.js';
import {COMPILER_VERSION, type AuthoringDeps, type AuthoringProvenance} from './types.js';

export {COMPILER_VERSION};
export type {AuthoringDeps, AuthoringProvenance, ApplyResult, Diagnostic, FlowDraft, Preview} from './types.js';

export function createAuthoring(deps: AuthoringDeps) {
  const faults = deps.faults ?? {};
  const bound = {...deps, faults};
  const journal = createJournal(bound.root, () => journalNow(bound));
  const ready = reconcileJournal(journal, bound);
  const contexts = createContextStore(bound);
  const previews = createPreviewStore(() => journalNow(bound));
  return {
    faults,
    context(input: unknown, topKeys?: string[]) { return contexts.create(contextInput(input, topKeys)); },
    preview(input: unknown, topKeys?: string[]) { return createPreview(bound, contexts, previews, input, topKeys); },
    apply(input: unknown, topKeys?: string[], options?: {clientId?: string; authoring?: AuthoringProvenance}) {
      return applyFlow(bound, previews, journal, ready, input, topKeys, options);
    },
    undo(input: unknown, topKeys?: string[]) { return undoFlow(bound, journal, ready, input, topKeys); },
    async readBack(scenarioId: string, workspaceId: unknown) {
      return readFlow(bound, {scenarioId: requireString(scenarioId, 'a scenarioId'), workspaceId: requireWorkspaceId(workspaceId)});
    },
  };
}

function contextInput(input: unknown, topKeys?: string[]) {
  const body = assertEnvelope(input, topKeys, ['workspaceId', 'expectedRevision', 'screenIds']);
  if (body.screenIds !== undefined && (!Array.isArray(body.screenIds) || body.screenIds.length > 80 || body.screenIds.some(id => typeof id !== 'string' || !id || id.length > 200))) {
    throw authoringError(400, 'INVALID_ENVELOPE', 'Provide screenIds as a list of screen ids.');
  }
  return {workspaceId: requireWorkspaceId(body.workspaceId), expectedRevision: requireRevision(body.expectedRevision), ...(body.screenIds ? {screenIds: body.screenIds as string[]} : {})};
}
