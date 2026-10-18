// Run script v1 contract (GE-N/TnT #10). Type-only. Owned by PR A.
export type ScriptAnchor = { index: number; fingerprint: string };
export type ScriptRow = { id: string; beforeStep: ScriptAnchor; label: string; source: string };
// Scenario definition gains:  scripts?: ScriptRow[]

export type ScriptOrigin = 'local' | 'imported';
export type ScriptTrust = { rowId: string; origin: ScriptOrigin; trusted: boolean; hash: string };

export type ScriptBlockReason =
  | { kind: 'empty'; rowId: string; message: 'Script is empty · add code or delete the row' }
  | { kind: 'stale-anchor'; rowId: string; message: 'Step changed · relink before running' }
  | { kind: 'syntax'; rowId: string; message: string; line?: number; column?: number }
  | { kind: 'untrusted'; rowId: string; message: 'Script needs trust' }
  | { kind: 'reserved-variable'; message: 'Reserved TnT variable'; line?: number }
  | { kind: 'reserved-input'; input: 'TNT_MOCK_URL' | 'TNT_MOCK_TOKEN'; message: 'TNT_MOCK_URL and TNT_MOCK_TOKEN are reserved by TnT.' };

// Step results: existing statuses plus 'script-error' and 'not-run'.
export type ScriptStepResult = { kind: 'runScript'; rowId: string; status: 'passed' | 'script-error' | 'not-run'; message?: string };

// Result placement agreed in SPEC §8: references only; authored step indexes stay stable.
export type ScriptExecutionReference = { kind: 'step'; index: number } | { kind: 'runScript'; rowId: string };
export type ScriptRunResults = { scriptSteps: Record<string, ScriptStepResult>; executionOrder: ScriptExecutionReference[] };

// Run-level error when the scrub fails closed.
export const EVIDENCE_SCRUB_FAILED = 'Evidence scrub failed';
export const REDACTED = '[redacted]';

// HTTP API (paths follow server/http.ts conventions):
// GET  /api/scripts/trust?workspace=<id>       -> { scripts: ScriptTrust[] }
// POST /api/scripts/trust { workspace, rowId, hash } -> { trust: ScriptTrust }   // hash must match current source, else 409
// POST /api/runs (existing) -> may return 422 { blocked: ScriptBlockReason[] } before launch
// Batch (POST /api/batches, existing): an untrusted scenario's result = failed with reason 'Script needs trust'; the batch continues.
