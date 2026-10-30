/** Typed client for the scenario-knowledge read API. Slice 1 does not call the save endpoint. */

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

export class KnowledgeRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'KnowledgeRequestError';
  }
}

export function knowledgeReaderPath(workspaceId: string, scenarioId: string) {
  return `/knowledge/workspaces/${encodeURIComponent(workspaceId)}/#scenario-${encodeURIComponent(scenarioId)}`;
}

export function knowledgeClient(token: string, fetchImpl: typeof fetch = fetch) {
  async function send(path: string): Promise<unknown> {
    const response = await fetchImpl(path, {
      method: 'GET',
      headers: {'X-TnT-Token': token, 'Accept': 'application/json'},
    });
    let payload: unknown = {};
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      const body = payload && typeof payload === 'object' ? payload as {error?: unknown; code?: unknown} : {};
      const message = typeof body.error === 'string' ? body.error : 'Knowledge request failed.';
      throw new KnowledgeRequestError(message, response.status, typeof body.code === 'string' ? body.code : undefined);
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
  };
}
