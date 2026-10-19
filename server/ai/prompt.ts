import {AiHttpError} from './errors.js';

export const PROMPT_CHAR_LIMIT = 4000;
export const USER_PROMPT_CHAR_LIMIT = 2000;

const SYSTEM_PROMPT = [
  'You author one TnT flow draft for contract v1. Return only a JSON object, with no markdown.',
  'Required shape: schemaVersion 1, mode "createScenario", name, appId, parameters, execution, screens, visits, scripts, assumptions.',
  'Use the supplied appId exactly. Reuse an existing screen id from the context, or create a screen.',
  'Keys are letter-led, unique, and at most 64 characters.',
  'Each non-final visit ends with one tap or back whose destination is the next visit. Earlier tap and back destinations stay. The final visit does not navigate away.',
  'A target is a context ref from the context, an explicit text or id selector, or an unresolved description. Use unresolved when a fact is missing. Never invent context refs, coordinates, secrets, trust, or script paths.',
  'An input value is a literal, a declared parameter, or unresolved. Literals cannot contain ${...}.',
  'Scripts are maestro-javascript. Place them beforeOperation or at scenarioEnd. Do not claim trust.',
  'Assumptions record interpretation choices. If the request cannot be represented, return the closest draft and say what is missing.',
].join(' ');

export type PromptSelector = {target: string; match: string; value: string};
export type PromptContext = {
  screens: {screenId: string; title: string}[];
  targets: {ref: string; screenId: string; role: string; selector: PromptSelector}[];
  setups: {ref: string; file: string; parameterNames: string[]}[];
  handlers: {ref: string; name: string}[];
  mocks: {ref: string}[];
  omissions: {kind: string; reason: string}[];
  availableScreens?: number;
  availableTransitions?: number;
};

export function assertUserPrompt(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new AiHttpError(400, 'PROMPT_REQUIRED', 'Provide a prompt.');
  const prompt = value.trim();
  if (prompt.includes('\0')) throw new AiHttpError(400, 'PROMPT_REQUIRED', 'Provide a prompt.');
  if (prompt.length > USER_PROMPT_CHAR_LIMIT) throw new AiHttpError(400, 'PROMPT_TOO_LONG', `The prompt exceeds ${USER_PROMPT_CHAR_LIMIT} characters.`);
  return prompt;
}

function clip(value: string, max: number) {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function screenLine(screen: PromptContext['screens'][number]) {
  return `- ${clip(screen.screenId, 80)} ${clip(screen.title, 80)}`.trimEnd();
}

function targetLine(target: PromptContext['targets'][number]) {
  const selector = target.selector;
  return `- ${clip(target.ref, 80)} ${clip(target.screenId, 80)} ${clip(target.role, 20)} ${clip(selector.target, 20)}:${clip(selector.match, 20)}:${clip(selector.value, 80)}`;
}

function contextLines(context: PromptContext, screens: number, targets: number) {
  const lines = [
    `screens ${context.screens.length}:`,
    ...context.screens.slice(0, screens).map(screenLine),
    `targets ${context.targets.length}:`,
    ...context.targets.slice(0, targets).map(targetLine),
  ];
  if (targets < context.targets.length) lines.push(`targets omitted: ${context.targets.length - targets}`);
  if (screens < context.screens.length) lines.push(`screens omitted: ${context.screens.length - screens}`);
  const setups = context.setups.slice(0, 8).map(item => `${clip(item.ref, 40)} ${clip(item.file, 40)} [${item.parameterNames.slice(0, 8).map(name => clip(name, 40)).join(', ')}]`);
  const handlers = context.handlers.slice(0, 8).map(item => `${clip(item.ref, 40)} ${clip(item.name, 40)}`);
  const mocks = context.mocks.slice(0, 8).map(item => clip(item.ref, 40));
  if (setups.length) lines.push(`setups: ${setups.join('; ')}`);
  if (handlers.length) lines.push(`handlers: ${handlers.join('; ')}`);
  if (mocks.length) lines.push(`mocks: ${mocks.join('; ')}`);
  if (context.availableScreens !== undefined || context.availableTransitions !== undefined) {
    lines.push(`available screens ${context.availableScreens ?? 0}, transitions ${context.availableTransitions ?? 0}`);
  }
  const omissions = context.omissions.slice(0, 8).map(item => `${clip(item.kind, 40)}:${clip(item.reason, 60)}`);
  if (omissions.length) lines.push(`omissions: ${omissions.join('; ')}`);
  return lines;
}

export function packPrompt(input: {prompt: string; appId: string; context: PromptContext}) {
  const system = SYSTEM_PROMPT;
  const request = `Request:\n${input.prompt}`;
  const header = `Context contract v1\nappId: ${clip(input.appId, 255)}`;
  let screens = input.context.screens.length;
  let targets = input.context.targets.length;
  const budget = PROMPT_CHAR_LIMIT - system.length;
  let user = '';
  while (screens >= 0 && targets >= 0) {
    user = `${request}\n\n${header}\n${contextLines(input.context, screens, targets).join('\n')}`;
    if (user.length <= budget) break;
    if (targets > 0) targets = Math.floor(targets / 2);
    else if (screens > 0) screens = Math.floor(screens / 2);
    else break;
  }
  if (system.length + user.length > PROMPT_CHAR_LIMIT) {
    user = user.slice(0, Math.max(0, budget));
  }
  if (system.length + user.length > PROMPT_CHAR_LIMIT) throw new AiHttpError(400, 'PROMPT_TOO_LONG', 'The prompt does not fit the model budget.');
  return {system, user};
}

export function assembleCall(input: {system: string; user: string; previous?: string; repair?: string}) {
  const budget = PROMPT_CHAR_LIMIT - input.system.length;
  if (!input.repair) {
    const user = input.user.length <= budget ? input.user : input.user.slice(0, budget);
    return [{role: 'user' as const, content: user}];
  }
  let repair = input.repair.slice(0, 900);
  let previous = input.previous ?? '';
  let user = input.user;
  const fit = () => repair.length + previous.length + user.length <= budget;
  if (!fit()) previous = previous.slice(0, 600);
  while (!fit() && previous.length > 0) previous = previous.slice(0, Math.floor(previous.length / 2));
  while (!fit() && user.length > 0) user = user.slice(0, Math.max(0, user.length - 200));
  while (!fit() && repair.length > 0) repair = repair.slice(0, Math.max(0, repair.length - 100));
  const messages: {role: 'user' | 'assistant'; content: string}[] = [{role: 'user', content: user}];
  if (previous) messages.push({role: 'assistant', content: previous});
  messages.push({role: 'user', content: repair});
  return messages;
}
