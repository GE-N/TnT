import {parseAllDocuments} from 'yaml';
import {checkProblem} from '../../shared/canvas-authoring.js';
import {checkScriptSyntax} from '../run-script-plan.js';
import {RESERVED_INPUTS} from '../script-validation.js';
import type {Workspace} from '../scenarios.js';
import {scriptByteDiagnostics} from './schema.js';
import {CANVAS_EDGE_LIMIT, CANVAS_SCREEN_LIMIT, VISIT_OPERATION_LIMIT, type ContextSnapshot, type Diagnostic, type DraftOperation, type DraftTarget, type FlowDraft, issue} from './types.js';

const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PARAMETER = /^[A-Z][A-Z0-9_]{0,63}$/;
const EXPRESSION = /\$\{[^}]*\}/;
const APP_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function workspaceAppId(yaml: string) {
  try {
    const value = parseAllDocuments(yaml)[0]?.toJS() as {appId?: unknown} | undefined;
    return typeof value?.appId === 'string' ? value.appId : undefined;
  } catch { return undefined; }
}

function selectorProblem(selector: {target: 'text' | 'id'; match: 'exact' | 'contains' | 'regex'; value: string}) {
  if (EXPRESSION.test(selector.value)) return 'Selector literals cannot contain ${...} expressions.';
  return checkProblem(selector);
}

export function validateDraft(draft: FlowDraft, workspace: Workspace, context: ContextSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [...scriptByteDiagnostics(draft)];
  const seen = new Map<string, string>();
  function claim(key: string, path: string, entityKey?: string) {
    if (!KEY.test(key)) diagnostics.push(issue('INVALID_DRAFT', path, 'error', ['apply', 'run'], 'Keys must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$.', 'Rename the key to a short letter-led identifier.', entityKey));
    else if (seen.has(key)) diagnostics.push(issue('DUPLICATE_KEY', path, 'error', ['apply', 'run'], `Key '${key}' is already used by ${seen.get(key)}.`, 'Use a distinct key for every screen, visit, operation, script and assumption.', key));
    else seen.set(key, path);
  }
  draft.screens.forEach((screen, index) => claim(screen.key, `/screens/${index}/key`, screen.key));
  draft.visits.forEach((visit, index) => claim(visit.key, `/visits/${index}/key`, visit.key));
  draft.visits.forEach((visit, visitIndex) => visit.operations.forEach((operation, operationIndex) => claim(operation.key, `/visits/${visitIndex}/operations/${operationIndex}/key`, operation.key)));
  draft.scripts.forEach((script, index) => claim(script.key, `/scripts/${index}/key`, script.key));
  draft.assumptions.forEach((assumption, index) => claim(assumption.key, `/assumptions/${index}/key`, assumption.key));

  const name = draft.name.trim();
  if (!name || name.length > 120) diagnostics.push(issue('INVALID_DRAFT', '/name', 'error', ['apply', 'run'], 'Scenario title must be a trimmed nonempty name up to 120 characters.', 'Trim the scenario title.'));
  const appId = workspaceAppId(workspace.yaml);
  if (!appId || !APP_ID.test(draft.appId) || draft.appId !== appId) diagnostics.push(issue('APP_ID_MISMATCH', '/appId', 'error', ['apply', 'run'], 'appId must be the workspace app id.', 'Use the app id already declared on this workspace.'));

  const parameterNames = new Set<string>();
  draft.parameters.forEach((parameter, index) => {
    const path = `/parameters/${index}/name`;
    if (parameterNames.has(parameter.name)) diagnostics.push(issue('DUPLICATE_KEY', path, 'error', ['apply', 'run'], `Parameter ${parameter.name} is declared twice.`, 'Declare each parameter once.', parameter.name));
    parameterNames.add(parameter.name);
    if ((RESERVED_INPUTS as readonly string[]).includes(parameter.name) || parameter.name.startsWith('MAESTRO_')) {
      diagnostics.push(issue('RESERVED_PARAMETER', path, 'error', ['apply', 'run'], `${parameter.name} is reserved and cannot be a scenario parameter.`, 'Rename the parameter. TnT injects TNT_MOCK_URL and TNT_MOCK_TOKEN itself.', parameter.name));
    }
    if (parameter.required) diagnostics.push(issue('RUNTIME_INPUT_REQUIRED', path, 'warning', ['run'], `${parameter.name} must be supplied before a run.`, 'Enter the value in the existing run controls. Authoring does not store it.', parameter.name));
  });

  const known = new Set<string>([...draft.screens.map(screen => screen.key), ...draft.visits.map(visit => visit.key), ...draft.visits.flatMap(visit => visit.operations.map(operation => operation.key)), ...draft.scripts.map(script => script.key)]);
  draft.assumptions.forEach((assumption, index) => assumption.about.forEach((key, aboutIndex) => {
    if (!known.has(key)) diagnostics.push(issue('UNKNOWN_ABOUT', `/assumptions/${index}/about/${aboutIndex}`, 'error', ['apply', 'run'], `Assumption '${assumption.key}' refers to unknown key '${key}'.`, 'Point about at a screen, visit, operation or script in this draft.', assumption.key));
  }));

  const screenByKey = new Map(draft.screens.map(screen => [screen.key, screen]));
  const visited = new Set(draft.visits.map(visit => visit.screenKey));
  draft.screens.forEach((screen, index) => {
    if (!visited.has(screen.key)) diagnostics.push(issue('SCREEN_NOT_VISITED', `/screens/${index}`, 'error', ['apply', 'run'], `Screen '${screen.key}' is never visited.`, 'Add a visit for this screen or remove the declaration.', screen.key));
  });
  const existingIds = new Set<string>();
  draft.screens.forEach((screen, index) => {
    if (screen.kind !== 'existing') return;
    if (existingIds.has(screen.screenId)) diagnostics.push(issue('DUPLICATE_SCREEN', `/screens/${index}/screenId`, 'error', ['apply', 'run'], `Existing screen ${screen.screenId} is declared more than once.`, 'Declare an existing screen once and reuse its key for later visits.', screen.key));
    existingIds.add(screen.screenId);
    if (!workspace.canvas?.screens.some(item => item.id === screen.screenId)) diagnostics.push(issue('UNKNOWN_SCREEN', `/screens/${index}/screenId`, 'error', ['apply', 'run'], `Existing screen ${screen.screenId} is not in this workspace.`, 'Choose a screen id from the authoring context.', screen.key));
  });

  const operationCount = draft.visits.reduce((sum, visit) => sum + visit.operations.length, 0);
  const transitions = Math.max(0, draft.visits.length - 1);
  if (operationCount > 100) diagnostics.push(issue('CAPACITY_EXCEEDED', '/visits', 'error', ['apply', 'run'], 'A draft can contain at most 100 UI operations.', 'Split the journey.'));
  if (transitions > 80) diagnostics.push(issue('CAPACITY_EXCEEDED', '/visits', 'error', ['apply', 'run'], 'A draft can contain at most 80 transitions.', 'Shorten the route.'));
  const newScreens = draft.screens.filter(screen => screen.kind === 'create').length;
  const existingScreens = workspace.canvas?.screens.length ?? 0;
  const existingEdges = workspace.canvas?.edges.length ?? 0;
  if (existingScreens + newScreens > CANVAS_SCREEN_LIMIT) diagnostics.push(issue('CAPACITY_EXCEEDED', '/screens', 'error', ['apply', 'run'], `This canvas stores at most ${CANVAS_SCREEN_LIMIT} screens.`, 'Reuse an existing screen or remove one before authoring.'));
  if (existingEdges + transitions > CANVAS_EDGE_LIMIT) diagnostics.push(issue('CAPACITY_EXCEEDED', '/visits', 'error', ['apply', 'run'], `This canvas stores at most ${CANVAS_EDGE_LIMIT} transitions.`, 'Remove an existing connection or shorten the route.'));

  const visitKeys = new Set(draft.visits.map(visit => visit.key));
  draft.visits.forEach((visit, visitIndex) => {
    const screen = screenByKey.get(visit.screenKey);
    if (!screen) diagnostics.push(issue('UNKNOWN_SCREEN', `/visits/${visitIndex}/screenKey`, 'error', ['apply', 'run'], `Visit '${visit.key}' references unknown screen '${visit.screenKey}'.`, 'Declare the screen or correct screenKey.', visit.key));
    if (visit.operations.length > VISIT_OPERATION_LIMIT) diagnostics.push(issue('CAPACITY_EXCEEDED', `/visits/${visitIndex}/operations`, 'error', ['apply', 'run'], `A visit stores at most ${VISIT_OPERATION_LIMIT} operations.`, 'Move later operations into the next visit.', visit.key));
    const final = visitIndex === draft.visits.length - 1;
    const nextKey = draft.visits[visitIndex + 1]?.key;
    const navigations: {operation: Extract<DraftOperation, {kind: 'tap' | 'back'}>; index: number}[] = [];
    visit.operations.forEach((operation, operationIndex) => {
      const base = `/visits/${visitIndex}/operations/${operationIndex}`;
      if (operation.kind === 'tap' || operation.kind === 'back') {
        navigations.push({operation, index: operationIndex});
        checkTarget(operation.target, screen, `${base}/target`, operation.key);
        const destination = operation.destination;
        if (destination.kind === 'visit' && !visitKeys.has(destination.visitKey)) diagnostics.push(issue('INVALID_TRANSITION', `${base}/destination`, 'error', ['apply', 'run'], `Visit '${destination.visitKey}' is not in this draft.`, 'Point the transition at the next visit.', operation.key));
      } else if (operation.kind === 'input') {
        const value = operation.value;
        if (value.kind === 'literal' && EXPRESSION.test(value.text)) diagnostics.push(issue('INVALID_LITERAL', `${base}/value`, 'error', ['apply', 'run'], 'Input literals cannot contain ${...} expressions.', 'Use a parameter reference for placeholders.', operation.key));
        if (value.kind === 'parameter' && !parameterNames.has(value.name)) diagnostics.push(issue('MISSING_PARAMETER_DECLARATION', `${base}/value`, 'error', ['apply', 'run'], `Input uses undeclared parameter ${value.name}.`, 'Declare the parameter on the draft.', operation.key));
        if (value.kind === 'unresolved') diagnostics.push(issue('UNRESOLVED_VALUE', `${base}/value`, 'error', ['run'], 'This input needs a value.', 'Apply keeps the step. Enter a literal or a declared parameter before running.', operation.key));
      } else checkTarget(operation.target, screen, `${base}/target`, operation.key);
    });
    if (!final) {
      const last = visit.operations.length - 1;
      const forward = navigations.filter(item => item.operation.destination.kind === 'visit');
      const valid = forward.length === 1 && forward[0].index === last && forward[0].operation.destination.kind === 'visit' && forward[0].operation.destination.visitKey === nextKey;
      if (!valid) diagnostics.push(issue('INVALID_TRANSITION', `/visits/${visitIndex}`, 'error', ['apply', 'run'], 'Navigation does not lead to the next visit.', 'Make the last tap or Back of this visit the only transition, and point it at the next visit.', visit.key));
      for (const item of navigations) if (item.index !== last && item.operation.destination.kind !== 'stay') diagnostics.push(issue('INVALID_TRANSITION', `/visits/${visitIndex}/operations/${item.index}/destination`, 'error', ['apply', 'run'], 'Earlier tap/back operations must stay on this visit.', 'Set destination to stay. Only the last operation of a non-final visit navigates.', item.operation.key));
    } else if (navigations.some(item => item.operation.destination.kind === 'visit')) {
      diagnostics.push(issue('INVALID_TRANSITION', `/visits/${visitIndex}`, 'error', ['apply', 'run'], 'The final visit cannot navigate to another visit.', 'Use stay for tap and Back on the final visit.', visit.key));
    } else if (!visit.operations.length) {
      diagnostics.push(issue('DESTINATION_UNVERIFIED', `/visits/${visitIndex}`, 'warning', [], 'The final visit has no operations, so its destination is unverified.', 'Add a check on the final visit, or keep the warning if this visit only hosts scripts.', visit.key));
    }
  });

  if (!draft.visits.some(visit => visit.operations.some(operation => operation.kind === 'checkVisible' || operation.kind === 'checkAbsent'))) {
    diagnostics.push(issue('NO_UI_ASSERTIONS', '/visits', 'warning', [], 'This flow has no UI checks.', 'Add a visibility check if the journey should assert what the user sees. Passing commands alone do not establish that.'));
  }
  if (!operationCount && !draft.scripts.length) diagnostics.push(issue('EMPTY_FLOW', '/visits', 'error', ['apply', 'run'], 'An empty draft is not applicable.', 'Add an operation or a script. A script-only flow needs one screen, one visit and a scenarioEnd script.'));

  const setup = draft.execution.setup;
  const handlers = draft.execution.handlerRefs;
  if (new Set(handlers).size !== handlers.length) diagnostics.push(issue('DUPLICATE_KEY', '/execution/handlerRefs', 'error', ['apply', 'run'], 'Handler references must be unique.', 'List each handler once.'));
  if (handlers.length && setup.kind !== 'context') diagnostics.push(issue('SHARED_EXECUTION_CONFLICT', '/execution', 'error', ['apply', 'run'], 'Handlers require the existing context setup. launchApp would change shared behavior.', 'Select the context setup that already binds those handlers.'));
  if (setup.kind === 'launchApp' && workspace.automation) diagnostics.push(issue('SHARED_EXECUTION_CONFLICT', '/execution/setup', 'error', ['apply', 'run'], 'This workspace already has shared setup. launchApp cannot replace it.', 'Select the context setup, or author a workspace that does not declare shared setup.'));
  if (setup.kind === 'context' && !context.setups[setup.ref]) diagnostics.push(issue('UNKNOWN_CONTEXT_TARGET', '/execution/setup', 'error', ['apply', 'run'], `Setup reference ${setup.ref} is not in this context snapshot.`, 'Refresh the authoring context and choose an offered setup.'));
  for (const handler of handlers) if (!context.handlers.some(item => item.ref === handler)) diagnostics.push(issue('UNKNOWN_CONTEXT_TARGET', '/execution/handlerRefs', 'error', ['apply', 'run'], `Handler ${handler} is not in this context snapshot.`, 'Choose a handler id from the authoring context.'));
  const mock = draft.execution.mock;
  if (mock.kind === 'context' && !context.mocks[mock.ref]) diagnostics.push(issue('UNKNOWN_CONTEXT_TARGET', '/execution/mock', 'error', ['apply', 'run'], `Mock reference ${mock.ref} is not in this context snapshot.`, 'Choose an offered mock or set mock to none.'));

  const operations = new Map<string, {visitKey: string}>();
  for (const visit of draft.visits) for (const operation of visit.operations) operations.set(`${visit.key}\0${operation.key}`, {visitKey: visit.key});
  draft.scripts.forEach((script, index) => {
    const path = `/scripts/${index}`;
    if (script.placement.kind === 'beforeOperation') {
      const anchor = operations.get(`${script.placement.visitKey}\0${script.placement.operationKey}`);
      if (!anchor) diagnostics.push(issue('UNKNOWN_SCRIPT_ANCHOR', `${path}/placement`, 'error', ['apply', 'run'], 'Script points at an operation that is not in that visit.', 'Anchor the script before an operation in the same visit, or use scenarioEnd.', script.key));
    }
    if (!script.source.trim()) diagnostics.push(issue('EMPTY_SCRIPT', `${path}/source`, 'error', ['apply', 'run'], 'Script source is empty.', 'Add JavaScript or remove the script. Empty source is not stored.', script.key));
    else {
      const syntax = checkScriptSyntax(script.source);
      if (syntax) diagnostics.push(issue('SCRIPT_SYNTAX', `${path}/source`, 'error', ['apply', 'run'], syntax.message, 'Fix the JavaScript syntax. This check does not prove Maestro runtime compatibility.', script.key));
      diagnostics.push(issue('SCRIPT_TRUST_REQUIRED', path, 'warning', ['run'], 'Script needs trust before it can run.', 'Review the source and trust it in the existing script trust UI. Applying a flow does not grant trust.', script.key));
    }
    script.requires.parameters.forEach((name, parameterIndex) => {
      if (!parameterNames.has(name)) diagnostics.push(issue('MISSING_PARAMETER_DECLARATION', `${path}/requires/parameters/${parameterIndex}`, 'error', ['apply', 'run'], `Script requires undeclared parameter ${name}.`, 'Declare the parameter on the draft.', script.key));
    });
    const mockSelected = mock.kind === 'context' && Boolean(context.mocks[mock.ref]);
    if (script.requires.mockSession && !mockSelected) {
      diagnostics.push(issue('MOCK_REQUIRED', `${path}/requires`, 'error', ['apply', 'run'], 'Script declares a mock session but none is selected.', 'Select a mock from the authoring context.', script.key));
    }
  });
  return diagnostics;

  function checkTarget(target: DraftTarget, screen: FlowDraft['screens'][number] | undefined, path: string, entityKey: string) {
    if (target.kind === 'unresolved') {
      diagnostics.push(issue('UNRESOLVED_TARGET', path, 'error', ['run'], 'This operation needs an element.', 'Apply keeps the step without a target. Choose a context target or an explicit text/id selector before running.', entityKey));
      return;
    }
    if (target.kind === 'selector') {
      const problem = selectorProblem(target.selector);
      if (problem) diagnostics.push(issue('INVALID_SELECTOR', path, 'error', ['apply', 'run'], problem, 'Use text or id with exact, contains or a valid regex, and no ${...} literal.', entityKey));
      diagnostics.push(issue('UNVERIFIED_SELECTOR', path, 'warning', [], 'This explicit selector has not been inspected.', 'Run the picker later if you need an observed element. Authoring will not mark this selector inspected.', entityKey));
      return;
    }
    const resolved = context.targets[target.ref];
    if (!resolved) {
      diagnostics.push(issue('UNKNOWN_CONTEXT_TARGET', path, 'error', ['apply', 'run'], `Target ${target.ref} is not in this context snapshot.`, 'Refresh the authoring context. Target refs are version-bound.', entityKey));
      return;
    }
    const owner = screen?.kind === 'existing' ? screen.screenId : undefined;
    if (!owner || resolved.screenId !== owner) diagnostics.push(issue('CONTEXT_SCREEN_MISMATCH', path, 'error', ['apply', 'run'], `Target ${target.ref} does not belong to this visit's screen.`, 'Use a target from the owning screen, or an explicit selector on a new screen.', entityKey));
  }
}
