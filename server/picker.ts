import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Device, Execute } from './runner.js';
import { parseDocument, parseAllDocuments, stringify, isSeq } from 'yaml';

export class InspectionCleanupError extends Error {}
export type Inspector = { version(): Promise<string>; hierarchy(deviceId: string): Promise<string> };
export type Bounds = { x: number; y: number; width: number; height: number };
export type Candidate = { id: string; parentId?: string; text: string; textLabels: string[]; identifier: string; bounds: Bounds; enabled: boolean };
export type Capture = { id: string; deviceId: string; deviceName: string; capturedAt: string; expiresAt: string; width: number; height: number; hierarchyAt: string; screenshotAt: string; toolVersion: string; candidates: Candidate[] };
type HierarchyNode = { attributes: Record<string, string>; children?: HierarchyNode[] };
export type StepDraft = { captureId: string; candidateId: string; selector: string; command: 'tap' | 'input' | 'visible' | 'not-visible'; inputText?: string; fallback?: 'identifier' | 'coordinates' };
type Selector = { text?: string; id?: string; index?: number; enabled?: boolean; childOf?: Selector; containsChild?: Selector; above?: Selector; below?: Selector; leftOf?: Selector; rightOf?: Selector; point?: string };
type Review = { draft: StepDraft; target: string; flowYaml: string };
type StoredCapture = { capture: Capture; png: Buffer; fingerprint: string; hierarchyFingerprint: string; reviews: Map<string, Review> };

export function createPicker(options: { artifactDirectory: string; execute: Execute; inspector?: Inspector; devices(): Promise<Device[]>; acquireDevice(id: string): Promise<() => Promise<void>> }) {
  const captures = new Map<string, StoredCapture>();
  function stored(id: string) {
    const record = captures.get(id);
    if (!record || Date.parse(record.capture.expiresAt) <= Date.now()) { captures.delete(id); throw new Error('Capture expired or unavailable. Refresh the screen.'); }
    return record;
  }
  async function sample(deviceId: string) {
    if (!options.inspector) throw new Error('Maestro inspection is unavailable. Install the verified integration.');
    const toolVersion = await options.inspector.version();
    const tree: HierarchyNode = JSON.parse(await options.inspector.hierarchy(deviceId));
    const hierarchyAt = new Date().toISOString();
    const directory = join(options.artifactDirectory, 'picker-' + randomUUID());
    await mkdir(directory, { recursive: true });
    try {
      const path = join(directory, 'screen.png');
      await options.execute('/usr/bin/xcrun', ['simctl', 'io', deviceId, 'screenshot', path]);
      const screenshotAt = new Date().toISOString();
      if (Date.parse(screenshotAt) - Date.parse(hierarchyAt) > 2000) throw new Error('Screenshot capture took too long after hierarchy capture. Refresh and retry.');
      const png = await readFile(path);
      if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Simulator returned an unsupported screenshot.');
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      const frame = bounds(tree.children?.[0]?.attributes?.bounds ?? '');
      if (!frame || !width || !height || Math.abs(width / height - frame.width / frame.height) > 0.02) throw new Error('Screenshot/hierarchy orientation or bounds do not agree. Refresh the screen.');
      const candidates: Candidate[] = [];
      function visit(node: HierarchyNode, parentId?: string) {
        if (candidates.length > 10_000) throw new Error('Hierarchy exceeds the supported element limit.');
        const id = 'element-' + candidates.length;
        const box = bounds(node.attributes.bounds);
        if (!box) { node.children?.forEach(child => visit(child, parentId)); return; }
        candidates.push({ id, parentId, text: node.attributes.accessibilityText || node.attributes.text || node.attributes.title || node.attributes.value || '', textLabels: [node.attributes.text, node.attributes.hintText, node.attributes.accessibilityText, node.attributes.error].filter((value): value is string => !!value), identifier: node.attributes['resource-id'] || '', enabled: node.attributes.enabled !== 'false', bounds: { x: (box.x - frame!.x) * width / frame!.width, y: (box.y - frame!.y) * height / frame!.height, width: box.width * width / frame!.width, height: box.height * height / frame!.height } });
        node.children?.forEach(child => visit(child, id));
      }
      visit(tree);
      return { png, width, height, candidates, hierarchyAt, screenshotAt, toolVersion, hierarchyFingerprint: createHash('sha256').update(JSON.stringify(tree)).digest('hex'), fingerprint: createHash('sha256').update(png).digest('hex') };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  function preview(input: StepDraft) {
    const { capture } = stored(input.captureId);
    const candidate = capture.candidates.find(candidate => candidate.id === input.candidateId);
    if (!candidate) throw new Error('Choose an element candidate from this capture.');
    if (!['tap', 'input', 'visible', 'not-visible'].includes(input.command)) throw new Error('Choose a supported command.');
    if (typeof input.selector !== 'string' || input.selector.length > 4000) throw new Error('Provide a selector up to 4 KB.');
    const doc = parseDocument(input.selector);
    if (doc.errors.length) throw new Error('Invalid selector YAML.');
    const selector = validateSelector(doc.toJS());
    if (uses(selector, 'id') && input.fallback !== 'identifier') throw new Error('Choose identifier targeting deliberately before using an id.');
    if (selector.point && (input.fallback !== 'coordinates' || !['tap', 'input'].includes(input.command))) throw new Error('Coordinates require deliberate choice and support tap/input only.');
    if (input.command === 'input' && (typeof input.inputText !== 'string' || !input.inputText || input.inputText.length > 4000 || input.inputText.includes('${'))) throw new Error('Provide non-secret literal input text up to 4000 characters. Runtime expressions belong in authored YAML.');
    const rawMatches = selectMatches(capture.candidates, selector, false, false);
    const maestroMatches = selectMatches(capture.candidates, selector);
    const matches = selector.index === undefined ? rawMatches : maestroMatches;
    const coordinate = !!selector.point;
    const point = selector.point?.split(',').map(value => parseFloat(value) / 100);
    const b = candidate.bounds;
    const pointInside = !!point && point[0] * capture.width >= b.x && point[0] * capture.width <= b.x + b.width && point[1] * capture.height >= b.y && point[1] * capture.height <= b.y + b.height;
    const canSave = coordinate ? pointInside : (rawMatches.length === 1 || selector.index !== undefined) && maestroMatches.length === 1 && maestroMatches[0].id === candidate.id;
    const compiled = compile(selector);
    const command = input.command === 'tap' || input.command === 'input' ? 'tapOn' : input.command === 'visible' ? 'assertVisible' : 'assertNotVisible';
    const steps = [{ [command]: compiled }, ...(input.command === 'input' ? [{ inputText: input.inputText }] : [])];
    return { canSave, matches: structuredClone(matches), maestroMatches: structuredClone(selectMatches(capture.candidates, selector, true, false)), stepsYaml: stringify(steps), steps, note: coordinate && !pointInside ? 'Coordinate point is outside the selected element. Review the point.' : coordinate ? 'Coordinate fallback depends on this screen size and layout. It cannot identify an unlabeled control semantically.' : matches.length > 1 ? 'Ambiguous selector: add a hierarchy constraint or deliberately choose an index. No target was selected automatically.' : !canSave ? 'Selector does not uniquely identify the selected candidate. Review its label/constraints.' : 'Unique capture match. Test with Maestro on the device before relying on this selector.' };
  }
  return {
    preview,
    assertReview(captureId: string, reviewId: string, yaml: string) {
      const record = stored(captureId);
      const review = record.reviews.get(reviewId);
      if (!review || review.flowYaml !== yaml) throw new Error('Reviewed step differs from executable YAML. Refresh and review it again.');
      return { captureId, reviewId, capturedAt: record.capture.capturedAt };
    },
    async assertFresh(captureId: string, deviceId: string, reviewId?: string) {
      const record = stored(captureId);
      if (record.capture.deviceId !== deviceId) throw new Error('Capture belongs to a different device. Refresh the screen.');
      if (!(await options.devices()).some(device => device.id === deviceId)) throw new Error('Captured device is no longer ready.');
      const current = await sample(deviceId);
      stored(captureId);
      const review = reviewId ? record.reviews.get(reviewId) : undefined;
      if (reviewId && !review) throw new Error('Reviewed selector is unavailable. Review it again.');
      if (review && review.draft.fallback !== 'coordinates') {
        const selector = validateSelector(parseDocument(review.draft.selector).toJS());
        const rawMatches = selectMatches(current.candidates, selector, false, false);
        const matches = selectMatches(current.candidates, selector);
        if (selector.index === undefined && rawMatches.length !== 1) throw new Error('Stale capture: selector became ambiguous. Refresh and review again.');
        if (matches.length !== 1 || targetIdentity(matches[0], current.candidates) !== review.target || current.width !== record.capture.width || current.height !== record.capture.height) throw new Error('Stale capture: selected target, bounds, ancestry, or selector constraints changed. Refresh and review again.');
      } else if (current.hierarchyFingerprint !== record.hierarchyFingerprint || current.fingerprint !== record.fingerprint) throw new Error('Stale capture: hierarchy or screenshot changed. Refresh and review the selector again.');
    },
    buildStep(input: StepDraft & { yaml: string }) {
      const reviewed = preview(input);
      if (!reviewed.canSave) throw new Error(reviewed.note);
      if (typeof input.yaml !== 'string' || Buffer.byteLength(input.yaml) > 100_000) throw new Error('Provide authored YAML up to 100 KB.');
      const docs = parseAllDocuments(input.yaml);
      if (docs.length !== 2 || docs.some(doc => doc.errors.length) || !isSeq(docs[1].contents)) throw new Error('Fix the workspace YAML before adding a step.');
      const appId = docs[0].get('appId');
      if (typeof appId !== 'string' || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(appId)) throw new Error('Provide a literal appId in the YAML header.');
      reviewed.steps.forEach(step => docs[1].add(step));
      docs[1].directives.docStart = true;
      const yaml = docs.map(doc => doc.toString()).join('');
      if (Buffer.byteLength(yaml) > 100_000) throw new Error('Adding this step exceeds the 100 KB workspace limit.');
      const flowYaml = stringify({ appId }) + '---\n' + reviewed.stepsYaml;
      const record = stored(input.captureId);
      if (record.reviews.size >= 16) record.reviews.delete(record.reviews.keys().next().value!);
      const reviewId = randomUUID();
      record.reviews.set(reviewId, { draft: structuredClone(input), flowYaml, target: targetIdentity(record.capture.candidates.find(node => node.id === input.candidateId)!, record.capture.candidates) });
      return { yaml, flowYaml, stepsYaml: reviewed.stepsYaml, reviewId };
    },
    async capture(input: { deviceId: string }): Promise<Capture> {
      const release = await options.acquireDevice(input.deviceId);
      let cleanupVerified = true;
      try {
        const device = (await options.devices()).find(device => device.id === input.deviceId);
        if (!device) throw new Error('Selected device is no longer ready. Refresh devices.');
        const sampled = await sample(device.id);
        const capture: Capture = { id: randomUUID(), deviceId: device.id, deviceName: device.name, capturedAt: sampled.screenshotAt, expiresAt: new Date(Date.now() + 120_000).toISOString(), width: sampled.width, height: sampled.height, candidates: sampled.candidates, hierarchyAt: sampled.hierarchyAt, screenshotAt: sampled.screenshotAt, toolVersion: sampled.toolVersion };
        for (const [id, record] of captures) if (Date.parse(record.capture.expiresAt) <= Date.now()) captures.delete(id);
        if (captures.size >= 8) captures.delete(captures.keys().next().value!);
        captures.set(capture.id, { capture, png: sampled.png, fingerprint: sampled.fingerprint, hierarchyFingerprint: sampled.hierarchyFingerprint, reviews: new Map() });
        return structuredClone(capture);
      } catch (error) { cleanupVerified = !(error instanceof InspectionCleanupError); throw error; }
      finally { if (cleanupVerified) await release(); }
    },
    candidates(input: { captureId: string; x: number; y: number }) {
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.x > 1 || input.y < 0 || input.y > 1) throw new Error('Click within the captured screen.');
      const { capture } = stored(input.captureId);
      const x = input.x * capture.width, y = input.y * capture.height;
      return structuredClone(capture.candidates.filter(({ bounds: b }) => x >= b.x && y >= b.y && x <= b.x + b.width && y <= b.y + b.height).sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height));
    },
    async screen(id: string) { return stored(id).png; },
  };
}
function bounds(value: string): Bounds | undefined {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value);
  if (!match) return;
  const [x, y, right, bottom] = match.slice(1).map(Number);
  if (right <= x || bottom <= y) return;
  return { x, y, width: right - x, height: bottom - y };
}

function validateSelector(value: unknown, depth = 0): Selector {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) throw new Error('Use a selector mapping, with constraints nested at most four levels.');
  const selector = value as Record<string, unknown>;
  const allowed = ['text', 'id', 'index', 'enabled', 'childOf', 'containsChild', 'above', 'below', 'leftOf', 'rightOf', 'point'];
  if (Object.keys(selector).some(key => !allowed.includes(key))) throw new Error('Unsupported selector field. Use literal text/id, index, enabled, or supported hierarchy/position constraints.');
  for (const key of ['text', 'id']) if (selector[key] !== undefined && (typeof selector[key] !== 'string' || !selector[key] || (selector[key] as string).length > 500 || (selector[key] as string).includes('${'))) throw new Error('Selector labels must be non-empty literal strings up to 500 characters.');
  if (depth > 0 && selector.index !== undefined) throw new Error('Index is supported on the top-level selector only.');
  if (selector.index !== undefined && (!Number.isInteger(selector.index) || Number(selector.index) < 0 || Number(selector.index) > 10_000)) throw new Error('Index must be a non-negative integer.');
  if (selector.enabled !== undefined && typeof selector.enabled !== 'boolean') throw new Error('enabled must be true or false.');
  for (const key of ['childOf', 'containsChild', 'above', 'below', 'leftOf', 'rightOf']) if (selector[key] !== undefined) validateSelector(selector[key], depth + 1);
  if (selector.point !== undefined) {
    if (Object.keys(selector).length !== 1 || typeof selector.point !== 'string' || !/^(\d+(?:\.\d+)?)%,\s*(\d+(?:\.\d+)?)%$/.test(selector.point) || selector.point.split(',').some(v => parseFloat(v) > 100)) throw new Error('Use point alone as percentages from 0% to 100%.');
  } else if (!selector.text && !selector.id) throw new Error('Include a literal text or id for each selector.');
  return selector as Selector;
}
function uses(selector: Selector, key: string): boolean { return Object.entries(selector).some(([name, value]) => name === key || (value && typeof value === 'object' && uses(value, key))); }
function compile(selector: Selector): Record<string, unknown> {
  return Object.fromEntries(Object.entries(selector).map(([key, value]) => [key, key === 'text' || key === 'id' ? '^' + String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' : typeof value === 'object' ? compile(value) : value]));
}
function selectMatches(nodes: Candidate[], selector: Selector, deepest = true, applyIndex = true): Candidate[] {
  if (selector.point) return [];
  const equal = (a: string, b: string) => a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US');
  const basic = nodes.filter(node => (selector.text === undefined || node.textLabels.some(text => equal(text, selector.text!) || equal(text.replaceAll('\n', ' '), selector.text!))) && (selector.id === undefined || equal(node.identifier, selector.id) || equal(node.identifier.split('/').at(-1)!, selector.id)) && (selector.enabled === undefined || node.enabled === selector.enabled));
  let matches = deepest ? basic.filter(node => !basic.some(other => isDescendant(other, node, nodes))) : basic;
  for (const key of ['childOf', 'containsChild', 'above', 'below', 'leftOf', 'rightOf'] as const) {
    const constraint = selector[key];
    if (!constraint) continue;
    const anchors = selectMatches(nodes, constraint);
    if (anchors.length !== 1) throw new Error('Selector constraint anchor must match one Maestro element. Review its literal label/constraints.');
    const anchor = anchors[0];
    matches = matches.filter(node => key === 'childOf' ? isDescendant(node, anchor, nodes) : key === 'containsChild' ? anchor.parentId === node.id : key === 'above' ? node.bounds.y < anchor.bounds.y : key === 'below' ? node.bounds.y > anchor.bounds.y : key === 'leftOf' ? node.bounds.x < anchor.bounds.x : node.bounds.x > anchor.bounds.x);
  }
  matches.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  return applyIndex && selector.index !== undefined ? matches[selector.index] ? [matches[selector.index]] : [] : matches;
}
function isDescendant(node: Candidate, ancestor: Candidate, nodes: Candidate[]): boolean {
  for (let parentId = node.parentId; parentId; parentId = nodes.find(parent => parent.id === parentId)?.parentId) if (parentId === ancestor.id) return true;
  return false;
}

function targetIdentity(node: Candidate, nodes: Candidate[]) {
  const chain: unknown[] = [];
  for (let current: Candidate | undefined = node; current; current = nodes.find(parent => parent.id === current!.parentId)) chain.push({ text: current.text, identifier: current.identifier, bounds: current.bounds, enabled: current.enabled });
  return JSON.stringify(chain);
}
