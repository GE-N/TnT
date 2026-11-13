/** Client-side checks for one diagram export. The server repeats the magic-byte check. */

export const NOT_A_PNG_OR_JPEG = "This file isn't a PNG or JPEG export.";
export const IMAGE_TOO_LARGE = 'This image is too large.';
export const CANT_READ_IMAGES = "This model can't read images.";
export const CREATE_SCENARIO_PROMPT = 'Create a scenario from this diagram?';
/** Same cap as the server. Image bytes, not the base64 length and not the text budget. */
export const DIAGRAM_IMAGE_BYTE_LIMIT = 2_000_000;

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];

export type DiagramAttachment = {name: string; mimeType: 'image/png' | 'image/jpeg'; data: string};

export function plainDiagramError(code: string | undefined, message: string): string | undefined {
  if (code === 'MODEL_CANT_READ_IMAGES' || message === CANT_READ_IMAGES) return CANT_READ_IMAGES;
  if (code === 'DIAGRAM_FORMAT' || message === NOT_A_PNG_OR_JPEG) return NOT_A_PNG_OR_JPEG;
  if (code === 'DIAGRAM_TOO_LARGE' || message === IMAGE_TOO_LARGE) return IMAGE_TOO_LARGE;
  return undefined;
}

export function attachmentFromBytes(name: string, mime: string, bytes: Uint8Array): DiagramAttachment | {error: string} {
  if (bytes.length > DIAGRAM_IMAGE_BYTE_LIMIT) return {error: IMAGE_TOO_LARGE};
  const png = bytes.length >= PNG.length && PNG.every((byte, index) => bytes[index] === byte);
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (!png && !jpeg) return {error: NOT_A_PNG_OR_JPEG};
  const mimeType = png ? 'image/png' : 'image/jpeg';
  const declared = mime === 'image/jpg' ? 'image/jpeg' : mime;
  if (declared && declared !== 'application/octet-stream' && declared !== mimeType) return {error: NOT_A_PNG_OR_JPEG};
  const title = name.trim() || (mimeType === 'image/jpeg' ? 'diagram.jpg' : 'diagram.png');
  return {name: title, mimeType, data: bytesToBase64(bytes)};
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

export type FlowNode = {id: string; label: string};
export type FlowEdge = {from: string; to: string; label: string};
export type DiagramChain = {
  nodes: FlowNode[];
  arrows: string[];
  branches: {at: number; label: string; chain: DiagramChain}[];
};

const SHAPES: [string, string][] = [['([', '])'], ['[[', ']]'], ['[(', ')]'], ['[', ']'], ['{', '}'], ['(', ')']];

function unwrap(text: string) {
  const trimmed = text.trim();
  const fence = /^```(?:mermaid)?\s*([\s\S]*?)```$/i.exec(trimmed);
  return (fence ? fence[1] : trimmed).replace(/\r\n/g, '\n').trim();
}

function skipSpace(text: string, index: number) {
  while (index < text.length && /[ \t]/.test(text[index] ?? '')) index += 1;
  return index;
}

function readNode(text: string, index: number): {node: FlowNode; index: number} | undefined {
  const id = /^[A-Za-z][A-Za-z0-9_]*/.exec(text.slice(index));
  if (!id) return;
  let cursor = index + id[0].length;
  for (const [open, close] of SHAPES) {
    if (!text.startsWith(open, cursor)) continue;
    const end = text.indexOf(close, cursor + open.length);
    if (end < 0) return;
    const label = text.slice(cursor + open.length, end).trim().replace(/^["']|["']$/g, '').trim();
    return {node: {id: id[0], label: label || id[0]}, index: end + close.length};
  }
  return {node: {id: id[0], label: id[0]}, index: cursor};
}

function readEdge(text: string, index: number): {label: string; index: number} | undefined {
  const cursor = skipSpace(text, index);
  const mark = /^(?:-->|---|-\.->)/.exec(text.slice(cursor));
  if (!mark) return;
  let next = cursor + mark[0].length;
  let label = '';
  if (text[next] === '|') {
    const end = text.indexOf('|', next + 1);
    if (end < 0) return;
    label = text.slice(next + 1, end).trim();
    next = end + 1;
  }
  return {label, index: next};
}

/** Flowchart subset only. Anything else stays source text. No network. */
export function parseFlowchart(source: string): {nodes: FlowNode[]; edges: FlowEdge[]} | undefined {
  const text = unwrap(source);
  const lines = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('%%'));
  if (!/^(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\s*$/i.test(lines[0] ?? '')) return;
  const nodes = new Map<string, string>();
  const edges: FlowEdge[] = [];
  const remember = (node: FlowNode) => {
    const existing = nodes.get(node.id);
    if (!existing || (existing === node.id && node.label !== node.id)) nodes.set(node.id, node.label);
  };
  for (const line of lines.slice(1)) {
    for (const statement of line.split(';').map(part => part.trim()).filter(Boolean)) {
      if (/^(?:style|classDef|class|linkStyle|click)\b/.test(statement)) continue;
      const first = readNode(statement, 0);
      if (!first) return;
      remember(first.node);
      let index = first.index;
      let previous = first.node.id;
      for (;;) {
        const edge = readEdge(statement, index);
        if (!edge) break;
        const next = readNode(statement, skipSpace(statement, edge.index));
        if (!next) return;
        remember(next.node);
        edges.push({from: previous, to: next.node.id, label: edge.label});
        previous = next.node.id;
        index = next.index;
      }
      if (skipSpace(statement, index) !== statement.length) return;
    }
  }
  if (!nodes.size || !edges.length) return;
  return {nodes: [...nodes].map(([id, label]) => ({id, label})), edges};
}

/** Primary chain left to right. Extra arrows drop onto the next row, under their source. */
export function layoutFlowchart(source: string): DiagramChain | undefined {
  const parsed = parseFlowchart(source);
  if (!parsed) return;
  const byId = new Map(parsed.nodes.map(node => [node.id, node]));
  const outgoing = new Map<string, number[]>();
  parsed.edges.forEach((edge, index) => {
    const list = outgoing.get(edge.from) ?? [];
    list.push(index);
    outgoing.set(edge.from, list);
  });
  const incoming = new Set(parsed.edges.map(edge => edge.to));
  const start = parsed.nodes.find(node => !incoming.has(node.id)) ?? parsed.nodes[0];
  if (!start) return;
  const used = new Set<number>();
  const chainFrom = (id: string): DiagramChain => {
    const nodes: FlowNode[] = [];
    const arrows: string[] = [];
    const branches: DiagramChain['branches'] = [];
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const node = byId.get(current);
      if (!node) break;
      nodes.push(node);
      const options = (outgoing.get(current) ?? []).filter(index => !used.has(index));
      if (!options.length) break;
      const primary = options[0]!;
      used.add(primary);
      const edge = parsed.edges[primary]!;
      arrows.push(edge.label);
      for (const extra of options.slice(1)) {
        used.add(extra);
        const branch = parsed.edges[extra]!;
        branches.push({at: nodes.length - 1, label: branch.label, chain: chainFrom(branch.to)});
      }
      current = edge.to;
    }
    return {nodes, arrows, branches};
  };
  const chain = chainFrom(start.id);
  return chain.nodes.length ? chain : undefined;
}
