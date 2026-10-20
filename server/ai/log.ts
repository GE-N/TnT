/** Metadata allowlist. Callers cannot smuggle a prompt, response, or key into the line. */
export type AiLogEvent = {
  provider: string;
  model: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  contractVersion: number;
  diagnosticCodes: string[];
  outcome: string;
  requestId?: string;
  upstreamProvider?: string;
  callCount?: number;
};

export function formatAiLog(event: AiLogEvent) {
  const line: Record<string, unknown> = {
    source: 'tnt.ai',
    provider: event.provider,
    model: event.model,
    durationMs: event.durationMs,
    contractVersion: event.contractVersion,
    diagnosticCodes: event.diagnosticCodes,
    outcome: event.outcome,
  };
  if (event.requestId !== undefined) line.requestId = event.requestId;
  if (event.upstreamProvider !== undefined) line.upstreamProvider = event.upstreamProvider;
  if (event.callCount !== undefined) line.callCount = event.callCount;
  if (event.inputTokens !== undefined) line.inputTokens = event.inputTokens;
  if (event.outputTokens !== undefined) line.outputTokens = event.outputTokens;
  if (event.cost !== undefined) line.cost = event.cost;
  return JSON.stringify(line);
}
