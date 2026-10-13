export type Rect = { left: number; top: number; width: number; height: number };
export type InspectorSide = "right" | "left" | "below";
export type InspectorPlacement = {
  left: number;
  top: number;
  maxHeight: number;
  side: InspectorSide;
  /** True when no side fit and the card was pushed inside the bounds instead. */
  clamped: boolean;
};

export const inspectorWidth = 300;
export const inspectorGap = 12;
export const inspectorMargin = 8;
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

/**
 * Places the floating inspector beside its screen: right by default, then left,
 * then below. A side is skipped when the card would leave `bounds` or cover an
 * obstacle (another screen or an edge label). The result always stays inside
 * `bounds`, including when the anchor itself has been panned out of view.
 */
export function placeInspector({
  anchor,
  size,
  bounds,
  obstacles = [],
}: {
  anchor: Rect;
  size: { width: number; height: number };
  bounds: Rect;
  obstacles?: Rect[];
}): InspectorPlacement {
  const minLeft = bounds.left + inspectorMargin;
  const minTop = bounds.top + inspectorMargin;
  const maxHeight = Math.max(0, bounds.height - 2 * inspectorMargin);
  const width = Math.min(
    size.width,
    Math.max(0, bounds.width - 2 * inspectorMargin),
  );
  const height = Math.min(size.height, maxHeight);
  const maxLeft = bounds.left + bounds.width - inspectorMargin - width;
  const maxTop = bounds.top + bounds.height - inspectorMargin - height;
  const candidates = sides.map((side) => {
    const left =
      side === "right"
        ? anchor.left + anchor.width + inspectorGap
        : side === "left"
          ? anchor.left - inspectorGap - width
          : clamp(anchor.left, minLeft, maxLeft);
    const top =
      side === "below"
        ? anchor.top + anchor.height + inspectorGap
        : clamp(anchor.top, minTop, maxTop);
    const fits =
      left >= minLeft && left <= maxLeft && top >= minTop && top <= maxTop;
    const rect = { left, top, width, height };
    const covered = [anchor, ...obstacles].reduce(
      (total, obstacle) => total + overlap(rect, obstacle),
      0,
    );
    return { side, left, top, fits, covered };
  });
  const fitting = candidates.filter((candidate) => candidate.fits);
  const chosen =
    fitting.find((candidate) => candidate.covered === 0) ??
    [...fitting].sort((a, b) => a.covered - b.covered)[0];
  if (chosen)
    return {
      left: chosen.left,
      top: chosen.top,
      maxHeight,
      side: chosen.side,
      clamped: false,
    };
  const fallback = candidates[0];
  return {
    left: clamp(fallback.left, minLeft, Math.max(minLeft, maxLeft)),
    top: clamp(fallback.top, minTop, Math.max(minTop, maxTop)),
    maxHeight,
    side: "right",
    clamped: true,
  };
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
    right - left >= inspectorWidth + 2 * inspectorMargin && bottom - top >= 160;
  return usable
    ? { left, top, width: right - left, height: bottom - top }
    : { left: 0, top: 0, width: window.width, height: window.height };
}
