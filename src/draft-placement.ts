/** Canvas footprint used to keep a new draft off existing screens. Visual cards are 250px wide. */
export const DRAFT_NODE_WIDTH = 260;
export const DRAFT_NODE_HEIGHT = 180;
/** Screen pixels reserved above the new screens for the review bar. */
export const DRAFT_REVIEW_BAR = 72;

export type DraftPoint = {x: number; y: number};
export type DraftPositions = Record<string, DraftPoint>;
export type Box = {left: number; top: number; right: number; bottom: number};
export type Insets = {top: number; right: number; bottom: number; left: number};

const near = (left: number, right: number) => Math.abs(left - right) < 0.5;

export function edgeInsets(viewport: Box, obstacles: Box[], margin = 12): Insets {
  let top = margin;
  let right = margin;
  let bottom = margin;
  let left = margin;
  const height = viewport.bottom - viewport.top;
  const width = viewport.right - viewport.left;
  if (!(height > 80) || !(width > 80)) return {top, right, bottom, left};
  const expanded = obstacles
    .filter(raw => raw.right - raw.left >= 8 && raw.bottom - raw.top >= 8)
    .map(raw => ({left: raw.left - 8, top: raw.top - 8, right: raw.right + 8, bottom: raw.bottom + 8}))
    .filter(rect => rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right);
  for (const rect of expanded) {
    if (rect.top < viewport.top + height * 0.45) top = Math.max(top, rect.bottom - viewport.top + margin);
    if (rect.bottom > viewport.bottom - height * 0.45) bottom = Math.max(bottom, viewport.bottom - rect.top + margin);
  }
  const midY = viewport.top + height / 2;
  for (const rect of expanded) {
    const reachesMiddle = rect.bottom > viewport.top + top && rect.top < midY;
    if (!reachesMiddle) continue;
    if (rect.left < viewport.left + width * 0.5) left = Math.max(left, rect.right - viewport.left + margin);
    if (rect.right > viewport.right - width * 0.5) right = Math.max(right, viewport.right - rect.left + margin);
  }
  if (top + bottom > height - 120) {
    top = Math.min(top, Math.max(margin, height * 0.34));
    bottom = Math.min(bottom, Math.max(margin, height * 0.28));
  }
  if (left + right > width - 280) {
    left = Math.min(left, Math.max(margin, width * 0.28));
    right = Math.min(right, Math.max(margin, width * 0.22));
  }
  return {top, right, bottom, left};
}

function overlaps(x: number, y: number, box: DraftPoint) {
  return x < box.x + DRAFT_NODE_WIDTH && x + DRAFT_NODE_WIDTH > box.x && y < box.y + DRAFT_NODE_HEIGHT && y + DRAFT_NODE_HEIGHT > box.y;
}

function pack(existing: DraftPoint[], count: number, bounds: Box, originY: number): DraftPoint[] {
  const placed: DraftPoint[] = [];
  if (count <= 0) return placed;
  if (!(bounds.right - bounds.left >= DRAFT_NODE_WIDTH) || !(bounds.bottom - originY >= DRAFT_NODE_HEIGHT)) return placed;
  const blocked = (x: number, y: number) => existing.some(box => overlaps(x, y, box)) || placed.some(box => overlaps(x, y, box));
  for (let y = originY; y <= bounds.bottom - DRAFT_NODE_HEIGHT + 0.5 && placed.length < count; y += DRAFT_NODE_HEIGHT) {
    for (let x = bounds.left; x <= bounds.right - DRAFT_NODE_WIDTH + 0.5 && placed.length < count; x += DRAFT_NODE_WIDTH) {
      if (blocked(x, y)) continue;
      placed.push({x: Math.round(x), y: Math.round(y)});
    }
  }
  return placed;
}

export type DraftViewport = {width: number; height: number; scrollLeft: number; scrollTop: number};

/**
 * Put `count` new screens in the chrome-free viewport when they fit.
 * Otherwise find a free block on the canvas and pan so that block sits in the chrome-free area.
 * Existing screens are never moved.
 */
export function placementForDraft(input: {
  existing: DraftPoint[];
  count: number;
  zoom: number;
  viewport: DraftViewport;
  insets: Insets;
  headerScreen?: number;
}): {positions: DraftPoint[]; scrollLeft: number; scrollTop: number} {
  const zoom = input.zoom > 0 ? input.zoom : 1;
  const header = (input.headerScreen ?? DRAFT_REVIEW_BAR) / zoom;
  const free: Box = {
    left: (input.viewport.scrollLeft + input.insets.left) / zoom,
    top: (input.viewport.scrollTop + input.insets.top) / zoom,
    right: (input.viewport.scrollLeft + input.viewport.width - input.insets.right) / zoom,
    bottom: (input.viewport.scrollTop + input.viewport.height - input.insets.bottom) / zoom,
  };
  const stay = {scrollLeft: input.viewport.scrollLeft, scrollTop: input.viewport.scrollTop};
  if (input.count <= 0) return {positions: [], ...stay};
  const visible = pack(input.existing, input.count, free, free.top + header);
  if (visible.length === input.count) return {positions: visible, ...stay};

  const safeWidth = Math.max(DRAFT_NODE_WIDTH, free.right - free.left);
  const safeHeight = Math.max(header + DRAFT_NODE_HEIGHT, free.bottom - free.top);
  let best: {positions: DraftPoint[]; scrollLeft: number; scrollTop: number; distance: number} | undefined;
  for (let top = 24; top <= 1500 - safeHeight; top += DRAFT_NODE_HEIGHT) {
    for (let left = 24; left <= 2400 - Math.min(safeWidth, DRAFT_NODE_WIDTH); left += DRAFT_NODE_WIDTH) {
      const window: Box = {left, top, right: left + safeWidth, bottom: top + safeHeight};
      const positions = pack(input.existing, input.count, window, top + header);
      if (positions.length < input.count) continue;
      const distance = Math.abs(left - free.left) + Math.abs(top - free.top);
      if (best && distance >= best.distance) continue;
      best = {
        positions,
        scrollLeft: Math.max(0, left * zoom - input.insets.left),
        scrollTop: Math.max(0, top * zoom - input.insets.top),
        distance,
      };
    }
  }
  if (best) return {positions: best.positions, scrollLeft: best.scrollLeft, scrollTop: best.scrollTop};

  const row = pack(input.existing, input.count, {left: Math.max(24, free.left), top: free.top, right: 2400, bottom: free.top + header + DRAFT_NODE_HEIGHT}, free.top + header);
  return {positions: row, ...stay};
}

export function sameInsets(left: Insets, right: Insets) {
  return near(left.top, right.top) && near(left.right, right.right) && near(left.bottom, right.bottom) && near(left.left, right.left);
}
