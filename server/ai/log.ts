/** Metadata allowlist. Callers cannot smuggle a prompt, response, or key into the line. */
export type AiLogEvent = {
  provider: string;
  model: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  contractVersion: number;
  diagnosticCodes: string[];
  outcome: string;
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
  if (event.inputTokens !== undefined) line.inputTokens = event.inputTokens;
  if (event.outputTokens !== undefined) line.outputTokens = event.outputTokens;
  return JSON.stringify(line);
}
