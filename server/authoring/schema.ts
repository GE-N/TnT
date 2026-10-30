import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import Ajv2020, {type ErrorObject} from 'ajv/dist/2020.js';
import {authoringError} from './errors.js';
import {SCRIPT_BYTE_LIMIT, REQUEST_LIMIT, type Diagnostic, type FlowDraft, issue} from './types.js';

const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/contracts/ai-flow-v1/flow-draft.schema.json', import.meta.url)), 'utf8'));
const ajv = new Ajv2020({strict: true, allErrors: true});
const validate = ajv.compile(schema);

function pointerToken(value: string) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function schemaDiagnostics(errors: ErrorObject[] | null | undefined): Diagnostic[] {
  const relevant = (errors ?? []).filter(error => error.keyword !== 'oneOf' && error.keyword !== 'anyOf');
  const chosen = relevant.length ? relevant : errors ?? [];
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const error of chosen) {
    let path = error.instancePath || '';
    let message = error.message ?? 'Draft does not match the v1 schema.';
    if (error.keyword === 'additionalProperties' && typeof error.params.additionalProperty === 'string') {
      const name = error.params.additionalProperty;
      path = `${path}/${pointerToken(name)}`;
      message = name === 'x' || name === 'y' || name === 'point' || name === 'coordinates'
        ? 'Coordinates are not accepted in v1.'
        : `Unknown property '${name}'.`;
    }
    const key = `${path}\0${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(issue('INVALID_DRAFT', path, 'error', ['apply', 'run'], message, 'Correct the draft so it matches the v1 flow schema.'));
  }
  return diagnostics;
}

export function draftSchemaResult(draft: unknown): {ok: true; draft: FlowDraft} | {ok: false; diagnostics: Diagnostic[]} {
  if (validate(draft)) return {ok: true, draft: draft as FlowDraft};
  return {ok: false, diagnostics: schemaDiagnostics(validate.errors)};
}

/** UTF-8 byte cap on each script source. Schema maxLength counts characters. */
export function scriptByteDiagnostics(draft: unknown): Diagnostic[] {
  if (!draft || typeof draft !== 'object' || !('scripts' in draft) || !Array.isArray(draft.scripts)) return [];
  const diagnostics: Diagnostic[] = [];
  draft.scripts.forEach((script, index) => {
    if (!script || typeof script !== 'object' || !('source' in script) || typeof script.source !== 'string') return;
    if (Buffer.byteLength(script.source) > SCRIPT_BYTE_LIMIT) {
      diagnostics.push(issue('INVALID_DRAFT', `/scripts/${index}/source`, 'error', ['apply', 'run'], `Script source exceeds ${SCRIPT_BYTE_LIMIT} UTF-8 bytes.`, 'Shorten the script. Source is never truncated.'));
    }
  });
  return diagnostics;
}

/**
 * Reject duplicate JSON members before Ajv. JSON.parse keeps the last one,
 * which would hide a conflicting field.
 */
export function assertUniqueMembers(text: string): string[] {
  const source = text;
  let index = 0;
  const malformed = () => authoringError(400, 'MALFORMED_JSON', 'Malformed JSON.');
  const duplicate = () => authoringError(400, 'DUPLICATE_MEMBER', 'Duplicate JSON member names are rejected.');
  const topKeys: string[] = [];
  function skipSpace() { while (index < source.length && /\s/.test(source[index])) index++; }
  function parseString() {
    if (source[index] !== '"') throw malformed();
    const start = index;
    index++;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index] === '"') { index++; return JSON.parse(source.slice(start, index)) as string; }
      index++;
    }
    throw malformed();
  }
  function parseValue(top: boolean) {
    skipSpace();
    const char = source[index];
    if (char === '{') return parseObject(top);
    if (char === '[') return parseArray();
    if (char === '"') { parseString(); return; }
    if (char === 't' || char === 'f' || char === 'n') {
      const word = char === 't' ? 'true' : char === 'f' ? 'false' : 'null';
      if (source.slice(index, index + word.length) !== word) throw malformed();
      index += word.length;
      return;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const start = index;
      if (source[index] === '-') index++;
      while (index < source.length && /[0-9.eE+-]/.test(source[index])) index++;
      if (start === index) throw malformed();
      return;
    }
    throw malformed();
  }
  function parseObject(top: boolean) {
    index++;
    const keys = new Set<string>();
    skipSpace();
    if (source[index] === '}') { index++; return; }
    while (index < source.length) {
      skipSpace();
      const key = parseString();
      if (keys.has(key)) throw duplicate();
      keys.add(key);
      if (top) topKeys.push(key);
      skipSpace();
      if (source[index] !== ':') throw malformed();
      index++;
      parseValue(false);
      skipSpace();
      if (source[index] === ',') { index++; continue; }
      if (source[index] === '}') { index++; return; }
      throw malformed();
    }
    throw malformed();
  }
  function parseArray() {
    index++;
    skipSpace();
    if (source[index] === ']') { index++; return; }
    while (index < source.length) {
      parseValue(false);
      skipSpace();
      if (source[index] === ',') { index++; continue; }
      if (source[index] === ']') { index++; return; }
      throw malformed();
    }
    throw malformed();
  }
  parseValue(true);
  skipSpace();
  if (index !== source.length) throw malformed();
  return topKeys;
}

export function decodeAuthoringJson(text: string): {value: unknown; topKeys: string[]} {
  if (Buffer.byteLength(text) > REQUEST_LIMIT) throw authoringError(413, 'REQUEST_TOO_LARGE', `Authoring request exceeds ${REQUEST_LIMIT} bytes.`);
  let topKeys: string[];
  try { topKeys = assertUniqueMembers(text); }
  catch (error) {
    if (error instanceof SyntaxError) throw authoringError(400, 'MALFORMED_JSON', 'Malformed JSON.');
    throw error;
  }
  try { return {value: JSON.parse(text) as unknown, topKeys}; }
  catch { throw authoringError(400, 'MALFORMED_JSON', 'Malformed JSON.'); }
}

export function assertEnvelope(value: unknown, topKeys: string[] | undefined, allowed: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw authoringError(400, 'INVALID_ENVELOPE', 'Authoring requests must be a JSON object.');
  const keys = topKeys ?? Object.keys(value as object);
  if (keys.some(key => !allowed.includes(key))) throw authoringError(400, 'INVALID_ENVELOPE', 'Unknown authoring request field.');
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, name: string) {
  if (typeof value !== 'string' || !value) throw authoringError(400, 'INVALID_ENVELOPE', `Provide ${name}.`);
  return value;
}

export function requireRevision(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw authoringError(400, 'INVALID_ENVELOPE', 'Provide an expectedRevision.');
  return value;
}

export function requireWorkspaceId(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw authoringError(400, 'INVALID_ENVELOPE', 'Provide a workspaceId.');
  return value;
}
