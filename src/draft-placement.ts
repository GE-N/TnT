/** Canvas footprint used to keep a new draft off existing screens. Visual cards are 250px wide. */
export const DRAFT_NODE_WIDTH = 260;
export const DRAFT_NODE_HEIGHT = 180;
/** Screen pixels reserved above the new screens for the review bar. */
export const DRAFT_REVIEW_BAR = 72;
/** Empty margin around the floating AI control so a new screen never sits under it. */
export const AI_CHROME_PAD = 16;
/**
 * At-rest "Describe a flow" control.
 * Anchored like `.ai-flow` (right 24px, bottom 80px). The width covers the label at 14px
 * with 16px of horizontal padding; the height is the 44px hit target.
 */
export const AI_LAUNCH_FOOTPRINT = {width: 240, height: 44, right: 24, bottom: 80};
/**
 * Capsule that replaces the launch control during review.
 * `.ai-capsule-wrap` is at most 520px wide (`100vw - 48px`) and at least 56px tall, same corner.
 */
export const AI_CAPSULE_FOOTPRINT = {width: 520, height: 56, right: 24, bottom: 80};

export type AnchoredFootprint = {width: number; height: number; right: number; bottom: number};

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

function overlapsBox(x: number, y: number, box: Box) {
  return x < box.right && x + DRAFT_NODE_WIDTH > box.left && y < box.bottom && y + DRAFT_NODE_HEIGHT > box.top;
}

/** Place a fixed bottom-right control into viewport coordinates. */
export function anchoredFootprint(viewport: Box, footprint: AnchoredFootprint): Box {
  const right = viewport.right - footprint.right;
  const bottom = viewport.bottom - footprint.bottom;
  const width = Math.min(footprint.width, Math.max(0, viewport.right - viewport.left - footprint.right * 2));
  const height = Math.min(footprint.height, Math.max(0, bottom - viewport.top));
  return {left: right - width, top: bottom - height, right, bottom};
}

function unionBox(boxes: Box[]): Box | undefined {
  const present = boxes.filter(box => box.right > box.left && box.bottom > box.top);
  if (!present.length) return undefined;
  return {
    left: Math.min(...present.map(box => box.left)),
    top: Math.min(...present.map(box => box.top)),
    right: Math.max(...present.map(box => box.right)),
    bottom: Math.max(...present.map(box => box.bottom)),
  };
}

/**
 * Screen-space rectangle the packer must keep clear.
 * The capsule replaces the launch control during review, and the control comes back after Apply,
 * so both footprints are reserved even when only one is on screen. `measured` widens that union
 * when the mounted control is larger than the known footprint.
 */
export function reservedAiChrome(viewport: Box, measured: Box[] = [], pad = AI_CHROME_PAD): Box {
  const union = unionBox([
    anchoredFootprint(viewport, AI_LAUNCH_FOOTPRINT),
    anchoredFootprint(viewport, AI_CAPSULE_FOOTPRINT),
    ...measured,
  ]) ?? {left: viewport.left, top: viewport.top, right: viewport.left, bottom: viewport.top};
  return {left: union.left - pad, top: union.top - pad, right: union.right + pad, bottom: union.bottom + pad};
}

/** Map a screen-space rectangle into canvas coordinates at a scroll position. */
export function canvasReservedBox(box: Box, origin: {left: number; top: number}, scrollLeft: number, scrollTop: number, zoom: number): Box {
  const z = zoom > 0 ? zoom : 1;
  return {
    left: (box.left - origin.left + scrollLeft) / z,
    top: (box.top - origin.top + scrollTop) / z,
    right: (box.right - origin.left + scrollLeft) / z,
    bottom: (box.bottom - origin.top + scrollTop) / z,
  };
}

function pack(existing: DraftPoint[], count: number, bounds: Box, originY: number, blockedRects: Box[] = []): DraftPoint[] {
  const placed: DraftPoint[] = [];
  if (count <= 0) return placed;
  if (!(bounds.right - bounds.left >= DRAFT_NODE_WIDTH) || !(bounds.bottom - originY >= DRAFT_NODE_HEIGHT)) return placed;
  const blocked = (x: number, y: number) => existing.some(box => overlaps(x, y, box)) || placed.some(box => overlaps(x, y, box)) || blockedRects.some(box => overlapsBox(x, y, box));
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
  /** Fixed screen-space rectangles, such as the floating AI control. Avoided at every scroll position. */
  reserved?: Box[];
  /** Screen position of the canvas viewport. Defaults to the window origin. */
  origin?: {left: number; top: number};
}): {positions: DraftPoint[]; scrollLeft: number; scrollTop: number} {
  const zoom = input.zoom > 0 ? input.zoom : 1;
  const header = (input.headerScreen ?? DRAFT_REVIEW_BAR) / zoom;
  const origin = input.origin ?? {left: 0, top: 0};
  const reserved = input.reserved ?? [];
  const blockedAt = (scrollLeft: number, scrollTop: number) => reserved.map(box => canvasReservedBox(box, origin, scrollLeft, scrollTop, zoom));
  const free: Box = {
    left: (input.viewport.scrollLeft + input.insets.left) / zoom,
    top: (input.viewport.scrollTop + input.insets.top) / zoom,
    right: (input.viewport.scrollLeft + input.viewport.width - input.insets.right) / zoom,
    bottom: (input.viewport.scrollTop + input.viewport.height - input.insets.bottom) / zoom,
  };
  const stay = {scrollLeft: input.viewport.scrollLeft, scrollTop: input.viewport.scrollTop};
  if (input.count <= 0) return {positions: [], ...stay};
  const visible = pack(input.existing, input.count, free, free.top + header, blockedAt(stay.scrollLeft, stay.scrollTop));
  if (visible.length === input.count) return {positions: visible, ...stay};

  const safeWidth = Math.max(DRAFT_NODE_WIDTH, free.right - free.left);
  const safeHeight = Math.max(header + DRAFT_NODE_HEIGHT, free.bottom - free.top);
  let best: {positions: DraftPoint[]; scrollLeft: number; scrollTop: number; distance: number} | undefined;
  for (let top = 24; top <= 1500 - safeHeight; top += DRAFT_NODE_HEIGHT) {
    for (let left = 24; left <= 2400 - Math.min(safeWidth, DRAFT_NODE_WIDTH); left += DRAFT_NODE_WIDTH) {
      const window: Box = {left, top, right: left + safeWidth, bottom: top + safeHeight};
      const scrollLeft = Math.max(0, left * zoom - input.insets.left);
      const scrollTop = Math.max(0, top * zoom - input.insets.top);
      const positions = pack(input.existing, input.count, window, top + header, blockedAt(scrollLeft, scrollTop));
      if (positions.length < input.count) continue;
      const distance = Math.abs(left - free.left) + Math.abs(top - free.top);
      if (best && distance >= best.distance) continue;
      best = {
        positions,
        scrollLeft,
        scrollTop,
        distance,
      };
    }
  }
  if (best) return {positions: best.positions, scrollLeft: best.scrollLeft, scrollTop: best.scrollTop};

  const row = pack(input.existing, input.count, {left: Math.max(24, free.left), top: free.top, right: 2400, bottom: free.top + header + DRAFT_NODE_HEIGHT}, free.top + header, blockedAt(stay.scrollLeft, stay.scrollTop));
  return {positions: row, ...stay};
}

export function sameInsets(left: Insets, right: Insets) {
  return near(left.top, right.top) && near(left.right, right.right) && near(left.bottom, right.bottom) && near(left.left, right.left);
}
