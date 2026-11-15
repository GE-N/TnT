import {useRef, type Dispatch, type SetStateAction} from 'react';
import {CREATE_SCENARIO_PROMPT} from './diagram-intake.js';
import {knowledgeFailureSentence, KnowledgeRequestError} from './knowledge-client.js';
import type {AiDraft} from './ai-flow.js';
import type {UndoOffer} from './ai-draft-persistence.js';

export type DiagramPath = {id: string; title: string; labels: string[]};

type DiagramApi = {
  readContext: (workspaceId: string, scenarioId: string) => Promise<{context: {contextRevision: number}}>;
  applyDiagram: (workspaceId: string, scenarioId: string, body: {jobId: string; expectedContextRevision: number; idempotencyKey: string}) => Promise<{detail?: {context?: {contextRevision?: number}}; receipt?: {receiptId?: string}}>;
};

export type DiagramHost = {
  running: boolean;
  workspaceId: string;
  knowledge: DiagramApi;
  draftRef: {current: AiDraft};
  revisionRef: {current: number};
  idempotency: {current: Map<string, string>};
  jobGuard: {current: string | undefined};
  memory: {current: Map<string, AiDraft>};
  clearPersisted: () => void;
  setDraft: Dispatch<SetStateAction<AiDraft>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setUndoOffer: Dispatch<SetStateAction<UndoOffer | undefined>>;
  setKnowledgeNotice: (notice: string) => void;
  setKnowledgePulse: Dispatch<SetStateAction<number>>;
  emptyDraft: () => AiDraft;
  generate: (prompt?: string, options?: {quiet?: boolean}) => void | Promise<void>;
};

/** The named path, matched by id, title, or the arrow labels the reader saw. */
export function matchDiagramPath(paths: DiagramPath[], named: string) {
  return paths.find(item => item.id === named || item.title === named || item.labels.join(' → ') === named || item.labels.join(' -> ') === named)?.id;
}

/** Diagram reading held beside Ask AI. One universal field: confirming a diagram can ask to create a scenario. */
export function useDiagramIntake(hostRef: {readonly current: DiagramHost | null}) {
  const paths = useRef<DiagramPath[]>([]);
  /** Bumped to drop a scheduled "create a scenario?" ask. */
  const askToken = useRef(0);

  function rememberPaths(next: DiagramPath[]) {
    paths.current = next.map(path => ({id: path.id, title: path.title, labels: [...path.labels]}));
  }

  function scheduleScenarioAsk() {
    const host = hostRef.current;
    if (!host) return;
    const token = ++askToken.current;
    setTimeout(() => {
      if (askToken.current !== token) return;
      const current = host.draftRef.current;
      if (current.jobId || current.prompt.trim() || current.draft || current.diagramDraft || current.questions?.length) return;
      void host.generate(CREATE_SCENARIO_PROMPT, {quiet: true});
    }, 400);
  }

  async function confirmDiagram() {
    const host = hostRef.current;
    if (!host) return;
    const current = host.draftRef.current;
    const graph = current.diagramDraft;
    const scenarioId = current.scenarioId;
    if (!graph || !current.jobId || !scenarioId || !host.workspaceId || current.status === 'applying') return;
    if (host.running) return;
    const workspaceId = host.workspaceId;
    const jobId = current.jobId;
    host.setDraft(existing => ({...existing, status: 'applying', error: undefined}));
    let key = host.idempotency.current.get('diagram:' + jobId);
    if (!key) { key = crypto.randomUUID(); host.idempotency.current.set('diagram:' + jobId, key); }
    try {
      const detail = await host.knowledge.readContext(workspaceId, scenarioId);
      const applied = await host.knowledge.applyDiagram(workspaceId, scenarioId, {
        jobId,
        expectedContextRevision: detail.context.contextRevision,
        idempotencyKey: key,
      });
      if (host.draftRef.current.jobId !== jobId) return;
      rememberPaths(graph.paths);
      host.jobGuard.current = undefined;
      host.memory.current.delete(workspaceId);
      host.clearPersisted();
      host.setDraft(host.emptyDraft());
      host.setOpen(false);
      host.setKnowledgePulse(value => value + 1);
      const revision = applied.detail?.context?.contextRevision;
      if (applied.receipt?.receiptId && typeof revision === 'number') {
        host.setUndoOffer({
          receiptId: applied.receipt.receiptId,
          revision: host.revisionRef.current,
          workspaceId,
          knowledge: {scenarioId, contextRevision: revision},
        });
      }
      scheduleScenarioAsk();
    } catch (error) {
      if (host.draftRef.current.jobId !== jobId) return;
      const code = error instanceof KnowledgeRequestError ? error.code : undefined;
      host.setDraft(existing => ({...existing, status: 'pending'}));
      host.setKnowledgeNotice(knowledgeFailureSentence(code) ?? 'Scenario details aren\'t available right now. Nothing was changed.');
    }
  }

  return {paths, askToken, rememberPaths, scheduleScenarioAsk, confirmDiagram};
}
