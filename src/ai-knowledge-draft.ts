import {useState, type Dispatch, type SetStateAction} from 'react';
import {knowledgeFailureSentence, KnowledgeRequestError, type ScenarioContext} from './knowledge-client.js';
import type {AiDraft} from './ai-flow.js';
import type {UndoOffer} from './ai-draft-persistence.js';

type KnowledgeApi = {
  apply: (workspaceId: string, scenarioId: string, body: {jobId: string; expectedContextRevision: number; idempotencyKey: string}) => Promise<{detail?: {context?: {contextRevision?: number}}; receipt?: {receiptId?: string}}>;
  undo: (workspaceId: string, scenarioId: string, body: {receiptId: string; expectedContextRevision: number}) => Promise<unknown>;
};

export type KnowledgeHost = {
  running: boolean;
  workspaceId: string;
  knowledge: KnowledgeApi;
  draftRef: {current: AiDraft};
  revisionRef: {current: number};
  idempotency: {current: Map<string, string>};
  jobGuard: {current: string | undefined};
  memory: {current: Map<string, AiDraft>};
  clearPersisted: () => void;
  setDraft: Dispatch<SetStateAction<AiDraft>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setUndoOffer: Dispatch<SetStateAction<UndoOffer | undefined>>;
  setUndoVisible: Dispatch<SetStateAction<boolean>>;
  emptyDraft: () => AiDraft;
};

/** Knowledge review state. Apply and Undo stay on the Ask AI capsule; the sheet only paints the draft. */
export function useKnowledgeDraft(hostRef: {readonly current: KnowledgeHost | null}) {
  const [knowledgeNotice, setKnowledgeNotice] = useState('');
  const [knowledgePulse, setKnowledgePulse] = useState(0);
  const [knowledgeFreshness, setKnowledgeFreshness] = useState<'updating' | null>(null);
  const [knowledgeServerContext, setKnowledgeServerContext] = useState<ScenarioContext | null>(null);

  async function confirmKnowledge() {
    const host = hostRef.current;
    if (!host) return;
    const current = host.draftRef.current;
    const draft = current.knowledgeDraft;
    const scenarioId = current.scenarioId;
    if (!draft || !current.jobId || !scenarioId || !host.workspaceId || current.knowledgeHeld || current.status === 'applying') return;
    if (host.running) return;
    const workspaceId = host.workspaceId;
    setKnowledgeNotice('');
    host.setDraft(existing => ({...existing, status: 'applying', error: undefined}));
    let key = host.idempotency.current.get('knowledge:' + current.jobId);
    if (!key) { key = crypto.randomUUID(); host.idempotency.current.set('knowledge:' + current.jobId, key); }
    try {
      const applied = await host.knowledge.apply(workspaceId, scenarioId, {
        jobId: current.jobId,
        expectedContextRevision: draft.baseContextRevision,
        idempotencyKey: key,
      });
      if (host.draftRef.current.jobId !== current.jobId) return;
      host.jobGuard.current = undefined;
      host.memory.current.delete(workspaceId);
      host.clearPersisted();
      host.setDraft(host.emptyDraft());
      host.setOpen(false);
      setKnowledgeFreshness('updating');
      setKnowledgePulse(value => value + 1);
      const revision = applied.detail?.context?.contextRevision;
      if (applied.receipt?.receiptId && typeof revision === 'number') {
        host.setUndoOffer({
          receiptId: applied.receipt.receiptId,
          revision: host.revisionRef.current,
          workspaceId,
          knowledge: {scenarioId, contextRevision: revision},
        });
      }
    } catch (error) {
      if (host.draftRef.current.jobId !== current.jobId) return;
      const code = error instanceof KnowledgeRequestError ? error.code : undefined;
      const sentence = knowledgeFailureSentence(code) ?? 'Scenario details aren\'t available right now. Nothing was changed.';
      if (code === 'CONTEXT_REVISION_CONFLICT' && error instanceof KnowledgeRequestError && error.context && error.currentContextRevision !== undefined) {
        const revision = error.currentContextRevision;
        host.setDraft(existing => ({
          ...existing,
          status: 'pending',
          knowledgeHeld: true,
          knowledgeDraft: existing.knowledgeDraft ? {...existing.knowledgeDraft, baseContextRevision: revision} : existing.knowledgeDraft,
        }));
        setKnowledgeNotice(sentence);
        setKnowledgeServerContext(error.context);
        return;
      }
      host.setDraft(existing => ({...existing, status: 'pending'}));
      setKnowledgeNotice(sentence);
    }
  }

  function acknowledgeKnowledgeServer() {
    const host = hostRef.current;
    if (!host) return;
    setKnowledgeServerContext(null);
    host.setDraft(current => current.knowledgeHeld ? {...current, knowledgeHeld: false} : current);
  }

  async function undoKnowledge(offer: UndoOffer) {
    const host = hostRef.current;
    if (!host || !offer.knowledge) return;
    try {
      await host.knowledge.undo(offer.workspaceId, offer.knowledge.scenarioId, {
        receiptId: offer.receiptId,
        expectedContextRevision: offer.knowledge.contextRevision,
      });
      host.setUndoOffer(undefined);
      host.setUndoVisible(false);
      setKnowledgeNotice('');
      setKnowledgeFreshness('updating');
      setKnowledgePulse(value => value + 1);
    } catch (error) {
      const code = error instanceof KnowledgeRequestError ? error.code : undefined;
      setKnowledgeNotice(knowledgeFailureSentence(code) ?? 'Scenario details aren\'t available right now. Nothing was changed.');
    }
  }

  return {
    knowledgeNotice, setKnowledgeNotice, knowledgePulse, setKnowledgePulse, knowledgeFreshness, setKnowledgeFreshness, knowledgeServerContext, setKnowledgeServerContext,
    confirmKnowledge, acknowledgeKnowledgeServer, undoKnowledge,
  };
}
