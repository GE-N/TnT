export type Rect = { left: number; top: number; width: number; height: number };
export type InspectorSide = "right" | "left" | "below";
export type InspectorPlacement = {
  left: number;
  top: number;
  maxHeight: number;
  side: InspectorSide;
  /** True when the chosen side had to be pushed inside the bounds. */
  clamped: boolean;
};

export const inspectorWidth = 300;
export const inspectorGap = 12;
export const inspectorMargin = 8;
export const inspectorMinHeight = 160;
const sides: InspectorSide[] = ["right", "left", "below"];

function overlap(a: Rect, b: Rect) {
  const width =
    Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height =
    Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function covered(rect: Rect, obstacles: Rect[]) {
  return obstacles.reduce(
    (total, obstacle) => total + overlap(rect, obstacle),
    0,
  );
}

/**
 * Places the floating inspector beside its screen: right by default, then left,
 * then below. The first side that stays inside `bounds` and covers nothing
 * wins. Otherwise every side is clamped into `bounds` and scored: covering the
 * anchor or the highlighted edge (`highlighted`) is worst, then other edge
 * labels, then other screens, and the lowest score wins. The card's top lines
 * up with the anchor's top and the card scrolls, unless that would leave less
 * than `inspectorMinHeight` visible; then it slides up until it fits.
 */
export function placeInspector({
  anchor,
  size,
  bounds,
  screens = [],
  labels = [],
  highlighted = [],
}: {
  anchor: Rect;
  size: { width: number; height: number };
  bounds: Rect;
  screens?: Rect[];
  labels?: Rect[];
  highlighted?: Rect[];
}): InspectorPlacement {
  const minLeft = bounds.left + inspectorMargin;
  const minTop = bounds.top + inspectorMargin;
  const bottom = bounds.top + bounds.height - inspectorMargin;
  const width = Math.min(
    size.width,
    Math.max(0, bounds.width - 2 * inspectorMargin),
  );
  const height = Math.min(size.height, Math.max(0, bottom - minTop));
  const visible = Math.min(height, inspectorMinHeight);
  const maxLeft = Math.max(
    minLeft,
    bounds.left + bounds.width - inspectorMargin - width,
  );
  const placeTop = (top: number) =>
    top <= bottom - visible
      ? Math.max(minTop, top)
      : clamp(top, minTop, Math.max(minTop, bottom - height));
  const candidates = sides.map((side, order) => {
    const idealLeft =
      side === "right"
        ? anchor.left + anchor.width + inspectorGap
        : side === "left"
          ? anchor.left - inspectorGap - width
          : anchor.left;
    const idealTop =
      side === "below" ? anchor.top + anchor.height + inspectorGap : anchor.top;
    const left = clamp(idealLeft, minLeft, maxLeft);
    const top = placeTop(idealTop);
    const moved = side === "below" ? top !== idealTop : left !== idealLeft;
    const rect = {
      left,
      top,
      width,
      height: Math.min(height, bottom - top),
    };
    const score = [
      covered(rect, [anchor, ...highlighted]),
      covered(rect, labels),
      covered(rect, screens),
    ];
    return { side, order, left, top, moved, score };
  });
  const chosen =
    candidates.find(
      (candidate) =>
        !candidate.moved && candidate.score.every((area) => area === 0),
    ) ??
    [...candidates].sort(
      (a, b) =>
        a.score[0] - b.score[0] ||
        a.score[1] - b.score[1] ||
        a.score[2] - b.score[2] ||
        Number(a.moved) - Number(b.moved) ||
        a.order - b.order,
    )[0];
  // Already clamped by the per-side clamp; kept as a guard.
  const top = clamp(chosen.top, minTop, Math.max(minTop, bottom - visible));
  return {
    left: chosen.left,
    top,
    maxHeight: Math.max(0, bottom - top),
    side: chosen.side,
    clamped: chosen.moved,
  };
}

export const scriptEditorWidth = 360;
export const scriptEditorGap = 12;

/** Puts the script editor on a free side of the inspector so the two cards do not overlap. */
export function placeScriptEditor(
  inspector: Rect,
  viewport: { width: number; height: number },
  size: { width: number; height: number } = {
    width: scriptEditorWidth,
    height: 480,
  },
): { left: number; top: number } {
  const margin = inspectorMargin;
  const leftOf = inspector.left - scriptEditorGap - size.width;
  const rightOf = inspector.left + inspector.width + scriptEditorGap;
  const fits = (left: number) =>
    left >= margin && left + size.width <= viewport.width - margin;
  const beside =
    fits(leftOf) &&
    (inspector.left + inspector.width / 2 >= viewport.width / 2 ||
      !fits(rightOf))
      ? leftOf
      : fits(rightOf)
        ? rightOf
        : fits(leftOf)
          ? leftOf
          : undefined;
  const topFor = (top: number) =>
    clamp(
      top,
      margin,
      Math.max(margin, viewport.height - margin - Math.min(size.height, 160)),
    );
  if (beside !== undefined)
    return { left: Math.round(beside), top: Math.round(topFor(inspector.top)) };
  const below = inspector.top + inspector.height + scriptEditorGap;
  const above = inspector.top - scriptEditorGap - Math.min(size.height, 320);
  const top =
    below + 160 <= viewport.height - margin
      ? below
      : above >= margin
        ? above
        : topFor(inspector.top);
  const left = clamp(
    inspector.left,
    margin,
    Math.max(margin, viewport.width - margin - size.width),
  );
  return { left: Math.round(left), top: Math.round(top) };
}

export function visibleBounds(
  viewport: Rect,
  window: { width: number; height: number },
): Rect {
  const left = Math.max(0, viewport.left);
  const top = Math.max(0, viewport.top);
  const right = Math.min(window.width, viewport.left + viewport.width);
  const bottom = Math.min(window.height, viewport.top + viewport.height);
  const usable =
    right - left >= inspectorWidth + 2 * inspectorMargin &&
    bottom - top >= inspectorMinHeight;
  return usable
    ? { left, top, width: right - left, height: bottom - top }
    : { left: 0, top: 0, width: window.width, height: window.height };
}
