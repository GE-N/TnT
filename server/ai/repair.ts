import type {Diagnostic} from '../authoring/types.js';

/** One repair call per submission. It counts against the two-post budget. */
export const MAX_REPAIR_ROUNDS = 1;

/** Facts the user must supply. Another model round cannot discover them. */
const MISSING_FACT = new Set(['UNRESOLVED_TARGET', 'UNRESOLVED_VALUE']);

export function repairDecision(diagnostics: readonly Pick<Diagnostic, 'code' | 'severity'>[]): 'accept' | 'repair' | 'needs-info' {
  const errors = diagnostics.filter(item => item.severity === 'error');
  if (!errors.length) return 'accept';
  if (errors.every(item => MISSING_FACT.has(item.code))) return 'needs-info';
  return 'repair';
}

/** Codes and paths only, so a diagnostic message cannot carry a secret back to the model. */
export function repairNote(diagnostics: readonly Pick<Diagnostic, 'code' | 'path' | 'severity'>[]) {
  const lines = diagnostics.filter(item => item.severity === 'error').slice(0, 12).map(item => `- ${item.code} ${item.path}`.trimEnd());
  return [
    'The draft failed validation. Return only one corrected JSON object for the same request.',
    'Do not invent workspace facts. If an element or a value is unknown, use kind "unresolved".',
    'Stop when the only remaining problems are unresolved targets or values.',
    ...lines,
  ].join('\n');
}
