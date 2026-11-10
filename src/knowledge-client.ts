/** Typed client for the scenario-knowledge read API and the AI apply/undo path. There is no manual save. */

export type Freshness = 'up-to-date' | 'updating' | 'needs-review';
export type PublicationFreshness = 'current' | 'publication-stale';
export type IntentFreshness = 'reviewed' | 'intent-needs-review';

export type ContextContent = {
  purpose: string;
  expectedOutcome: string;
  rationale: string;
  preconditions: string;
  exceptions: string;
  scope: string;
};

export type ScenarioContext = ContextContent & {
  schemaVersion: 1;
  workspaceId: string;
  scenarioId: string;
  contextRevision: number;
  updatedAt: string | null;
  reviewedAgainstSourceHash: string | null;
};

export type FlowStep = {number: number; text: string; visitId?: string; testId?: string};

export type ScenarioDetail = {
  workspaceId: string;
  scenarioId: string;
  title: string;
  context: ScenarioContext;
  sourceDescriptor: {projectionVersion: 1; workspaceRevision: number; sourceHash: string};
  flow: {
    steps: FlowStep[];
    visits: {number: number; id: string; screenId: string; title: string; steps: FlowStep[]}[];
    diagnostics: string[];
  };
  evidence: {status: string | null; runId: string | null; finishedAt: string | null; label: string; notice: string};
  freshness: Freshness;
  publicationFreshness: PublicationFreshness;
  intentFreshness: IntentFreshness;
  generationId: string | null;
  generatedAt: string | null;
  publicationError: string | null;
  readerUrl: string;
};

export type WorkspaceKnowledgeStatus = {
  workspaceId: string;
  scopeId: string;
  generationId: string | null;
  generatedAt: string | null;
  publicationFreshness: PublicationFreshness;
  freshness: Freshness;
  publicationError: string | null;
  scenarios: {scenarioId: string; freshness: Freshness; publicationFreshness: PublicationFreshness; intentFreshness: IntentFreshness}[];
};

export type KnowledgeReceiptRef = {receiptId: string};
export type KnowledgeApplyResult = {detail: ScenarioDetail; receipt: KnowledgeReceiptRef};
export type KnowledgeApplyBody = {jobId: string; expectedContextRevision: number; idempotencyKey: string};
export type KnowledgeUndoBody = {receiptId: string; expectedContextRevision: number};

export class KnowledgeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly currentContextRevision?: number,
    readonly context?: ScenarioContext,
  ) {
    super(message);
    this.name = 'KnowledgeRequestError';
  }
}

/** One sentence for the two knowledge failures the capsule shows. The code stays off the screen. */
export function knowledgeFailureSentence(code: string | undefined): string | undefined {
  if (code === 'KNOWLEDGE_UNAVAILABLE') return 'Scenario details aren\'t available right now. Nothing was changed.';
  if (code === 'CONTEXT_REVISION_CONFLICT') return 'These details changed somewhere else. Nothing was applied.';
  return undefined;
}

export function knowledgeReaderPath(workspaceId: string, scenarioId: string) {
  return `/knowledge/workspaces/${encodeURIComponent(workspaceId)}/#scenario-${encodeURIComponent(scenarioId)}`;
}

function scenarioContext(value: unknown): ScenarioContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as ScenarioContext;
  if (item.schemaVersion !== 1 || typeof item.contextRevision !== 'number') return;
  if (typeof item.purpose !== 'string' || typeof item.expectedOutcome !== 'string' || typeof item.rationale !== 'string') return;
  return item;
}

export function knowledgeClient(token: string, fetchImpl: typeof fetch = fetch) {
  async function send(path: string, init?: {method?: 'GET' | 'POST'; body?: unknown}): Promise<unknown> {
    const response = await fetchImpl(path, {
      method: init?.method ?? 'GET',
      headers: {
        'X-TnT-Token': token,
        'Accept': 'application/json',
        ...(init?.body !== undefined ? {'Content-Type': 'application/json'} : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    let payload: unknown = {};
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      const body = payload && typeof payload === 'object' ? payload as {error?: unknown; code?: unknown; currentContextRevision?: unknown; context?: unknown} : {};
      const message = typeof body.error === 'string' ? body.error : 'Knowledge request failed.';
      const revision = typeof body.currentContextRevision === 'number' ? body.currentContextRevision : undefined;
      throw new KnowledgeRequestError(message, response.status, typeof body.code === 'string' ? body.code : undefined, revision, scenarioContext(body.context));
    }
    return payload;
  }

  return {
    readContext(workspaceId: string, scenarioId: string) {
      return send(`/api/knowledge/workspaces/${encodeURIComponent(workspaceId)}/scenarios/${encodeURIComponent(scenarioId)}/context`) as Promise<ScenarioDetail>;
    },
    status(workspaceId: string) {
      return send(`/api/knowledge/workspaces/${encodeURIComponent(workspaceId)}/status`) as Promise<WorkspaceKnowledgeStatus>;
    },
    apply(workspaceId: string, scenarioId: string, body: KnowledgeApplyBody) {
      return send(`/api/knowledge/workspaces/${encodeURIComponent(workspaceId)}/scenarios/${encodeURIComponent(scenarioId)}/apply`, {method: 'POST', body}) as Promise<KnowledgeApplyResult>;
    },
    undo(workspaceId: string, scenarioId: string, body: KnowledgeUndoBody) {
      return send(`/api/knowledge/workspaces/${encodeURIComponent(workspaceId)}/scenarios/${encodeURIComponent(scenarioId)}/undo`, {method: 'POST', body}) as Promise<ScenarioDetail>;
    },
  };
}
