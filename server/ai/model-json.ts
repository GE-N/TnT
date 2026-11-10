import {AuthoringHttpError} from '../authoring/errors.js';
import {assertUniqueMembers} from '../authoring/schema.js';
import {RESPONSE_BYTE_LIMIT} from './providers/types.js';

/** Exactly one JSON document. One surrounding fence is tolerated; a fragment inside prose is not. */
export function unwrapModelText(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

export function parseModelObject(text: string): {ok: true; value: Record<string, unknown>} | {ok: false; code: 'OUTPUT_TOO_LARGE' | 'DUPLICATE_MEMBER' | 'INVALID_JSON'} {
  const source = unwrapModelText(text);
  if (Buffer.byteLength(source) > RESPONSE_BYTE_LIMIT) return {ok: false, code: 'OUTPUT_TOO_LARGE'};
  try { assertUniqueMembers(source); }
  catch (error) {
    if (error instanceof AuthoringHttpError && error.code === 'DUPLICATE_MEMBER') return {ok: false, code: 'DUPLICATE_MEMBER'};
    return {ok: false, code: 'INVALID_JSON'};
  }
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {ok: false, code: 'INVALID_JSON'};
    return {ok: true, value: value as Record<string, unknown>};
  } catch { return {ok: false, code: 'INVALID_JSON'}; }
}
