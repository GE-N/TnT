import {AiHttpError} from './errors.js';

/**
 * Clarifying questions sit beside a flow draft. They are an AI-side extension:
 * the v1 contract schema is not modified, and `questions` is stripped before
 * `authoring.preview`.
 *
 * Model response (also the job / GET /api/ai/generations field, only while needsInfo):
 *   questions: [{ key, about?, text, options }]
 *   - at most 5
 *   - key: 1..64, about: optional 1..64 operation key, text: 1..200
 *   - options: 2 or 3 strings, each 1..80
 *   - control characters are turned into spaces; bad entries are dropped
 *
 * The schema sent to the model requires `questions` (use [] when nothing is unclear)
 * and requires `about` ("" when the question is not about one operation) so a
 * strict json_schema response_format accepts it. Stored questions omit an empty about.
 *
 * Answering is a refine of the same draft (`previousJobId` required when answers
 * is non-empty). POST /api/ai/generations accepts:
 *   answers?: [{ key, answer }]
 *   - at most 5, key 1..64, answer 1..200, distinct keys
 *   - validated up front (400 INVALID_ENVELOPE); counted in the 128 KiB prompt budget
 *   - placed in the refine prompt as data, next to the previous draft
 */
export const QUESTION_LIMIT = 5;
export const QUESTION_KEY_LIMIT = 64;
export const QUESTION_TEXT_LIMIT = 200;
export const OPTION_LIMIT = 80;
export const ANSWER_TEXT_LIMIT = 200;

const CONTROL = /[\u0000-\u001F\u007F]/g;

export type ClarifyingQuestion = {key: string; about?: string; text: string; options: string[]};
export type ClarifyingAnswer = {key: string; answer: string};

export function modelDraftSchema(contract: object): object {
  const schema = structuredClone(contract) as {properties?: Record<string, unknown>; required?: string[]};
  schema.properties = {
    ...schema.properties,
    questions: {
      type: 'array',
      maxItems: QUESTION_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: {type: 'string', minLength: 1, maxLength: QUESTION_KEY_LIMIT},
          about: {type: 'string', maxLength: QUESTION_KEY_LIMIT},
          text: {type: 'string', minLength: 1, maxLength: QUESTION_TEXT_LIMIT},
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 3,
            items: {type: 'string', minLength: 1, maxLength: OPTION_LIMIT},
          },
        },
        required: ['key', 'about', 'text', 'options'],
      },
    },
  };
  const required = new Set(schema.required ?? []);
  required.add('questions');
  schema.required = [...required];
  return schema;
}

function plain(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const text = value.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
  return text || undefined;
}

function clean(value: unknown, max: number): string | undefined {
  const text = plain(value);
  if (!text) return;
  return text.length > max ? text.slice(0, max).trim() : text;
}

/** Drops malformed entries. Never throws. */
export function sanitizeQuestions(value: unknown): ClarifyingQuestion[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const questions: ClarifyingQuestion[] = [];
  for (const item of value) {
    if (questions.length >= QUESTION_LIMIT) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const key = clean(record.key, QUESTION_KEY_LIMIT);
    const text = clean(record.text, QUESTION_TEXT_LIMIT);
    if (!key || !text || seen.has(key) || !Array.isArray(record.options)) continue;
    const options = record.options.map(option => clean(option, OPTION_LIMIT)).filter((option): option is string => !!option).slice(0, 3);
    if (options.length < 2) continue;
    const about = clean(record.about, QUESTION_KEY_LIMIT);
    seen.add(key);
    questions.push({key, ...(about ? {about} : {}), text, options});
  }
  return questions;
}

/** Separates the AI extension from the contract draft. */
export function splitModelDraft(value: unknown): {draft: unknown; questions: ClarifyingQuestion[]} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {draft: value, questions: []};
  const record = {...value as Record<string, unknown>};
  const questions = sanitizeQuestions(record.questions);
  delete record.questions;
  return {draft: record, questions};
}

/** User answers. Invalid input is a 400, unlike model questions. */
export function assertAnswers(value: unknown): ClarifyingAnswer[] {
  if (!Array.isArray(value) || value.length > QUESTION_LIMIT) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Provide at most 5 answers.');
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Each answer needs a key and an answer.');
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some(key => key !== 'key' && key !== 'answer')) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Each answer needs a key and an answer.');
    const key = plain(record.key);
    const answer = plain(record.answer);
    if (!key || !answer || key.length > QUESTION_KEY_LIMIT || answer.length > ANSWER_TEXT_LIMIT || seen.has(key)) throw new AiHttpError(400, 'INVALID_ENVELOPE', 'Each answer needs a distinct key and a short answer.');
    seen.add(key);
    return {key, answer};
  });
}
