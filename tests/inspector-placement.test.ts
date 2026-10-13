import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectorGap,
  inspectorMargin,
  inspectorWidth,
  placeInspector,
  visibleBounds,
  type Rect,
} from "../src/inspector-placement.js";

const bounds: Rect = { left: 0, top: 0, width: 1200, height: 800 };
const size = { width: inspectorWidth, height: 400 };
const node = (left: number, top: number): Rect => ({
  left,
  top,
  width: 250,
  height: 200,
});
const right = (anchor: Rect) => anchor.left + anchor.width + inspectorGap;

test("the inspector opens to the right of its screen by default", () => {
  const anchor = node(100, 100);
  assert.deepEqual(placeInspector({ anchor, size, bounds }), {
    left: right(anchor),
    top: 100,
    maxHeight: 800 - inspectorMargin - 100,
    side: "right",
    clamped: false,
  });
});

test("the inspector flips left at the window edge", () => {
  const anchor = node(820, 100);
  const placement = placeInspector({ anchor, size, bounds });
  assert.equal(placement.side, "left");
  assert.equal(placement.left, 820 - inspectorGap - inspectorWidth);
  assert.ok(placement.left + inspectorWidth <= anchor.left);
});

test("the inspector flips left when the right side covers the next screen", () => {
  const anchor = node(400, 100);
  const next = node(700, 120);
  const placement = placeInspector({
    anchor,
    size,
    bounds,
    screens: [next],
  });
  assert.equal(placement.side, "left");
});

test("the inspector flips left when the right side covers an edge label", () => {
  const anchor = node(400, 100);
  const label: Rect = { left: 680, top: 300, width: 160, height: 48 };
  assert.equal(
    placeInspector({ anchor, size, bounds, labels: [label] }).side,
    "left",
  );
});

test("the inspector goes below when both sides are blocked", () => {
  const anchor = node(320, 40);
  const placement = placeInspector({
    anchor,
    size: { width: inspectorWidth, height: 300 },
    bounds: { left: 0, top: 0, width: 900, height: 800 },
    screens: [node(600, 40), node(20, 40)],
  });
  assert.equal(placement.side, "below");
  assert.equal(placement.top, 40 + 200 + inspectorGap);
  assert.equal(placement.left, 320);
});

test("the least covered side wins when every side covers something", () => {
  const anchor = node(320, 40);
  const placement = placeInspector({
    anchor,
    size: { width: inspectorWidth, height: 300 },
    bounds: { left: 0, top: 0, width: 900, height: 800 },
    screens: [
      node(600, 40),
      { left: 0, top: 40, width: 10, height: 10 },
      node(320, 260),
    ],
  });
  assert.equal(placement.side, "left");
  assert.equal(placement.clamped, false);
});

test("the inspector slides vertically to stay inside the window beside its screen", () => {
  const anchor = node(100, 700);
  const placement = placeInspector({ anchor, size, bounds });
  assert.equal(placement.side, "right");
  assert.equal(placement.top, 800 - inspectorMargin - 400);
});

for (const [name, anchor] of [
  ["left", node(-2000, 100)],
  ["right", node(4000, 100)],
  ["above", node(300, -3000)],
  ["below", node(300, 5000)],
] as const)
  test(`the inspector stays clamped inside the window when its screen is panned off-screen ${name}`, () => {
    const placement = placeInspector({ anchor, size, bounds });
    assert.ok(placement.left >= inspectorMargin, "left edge");
    assert.ok(
      placement.left + inspectorWidth <= 1200 - inspectorMargin,
      "right edge",
    );
    assert.ok(placement.top >= inspectorMargin, "top edge");
    assert.ok(placement.top + 400 <= 800 - inspectorMargin, "bottom edge");
  });

test("a tall inspector lines up with its screen's top and scrolls instead of growing past the window", () => {
  const placement = placeInspector({
    anchor: node(100, 100),
    size: { width: inspectorWidth, height: 3000 },
    bounds,
  });
  assert.equal(placement.top, 100);
  assert.equal(placement.maxHeight, 800 - inspectorMargin - 100);
});

test("the inspector is never wider than a narrow window", () => {
  const placement = placeInspector({
    anchor: node(10, 10),
    size,
    bounds: { left: 0, top: 0, width: 280, height: 600 },
  });
  assert.equal(placement.side, "below");
  assert.equal(placement.left, inspectorMargin);
});

for (const [name, top] of [
  ["above", -3000],
  ["below", 5000],
] as const)
  test(`with no side fitting, the fallback is clamped vertically when the screen is panned ${name}`, () => {
    // Too narrow for either side, and the screen is too far away for below.
    const narrow: Rect = { left: 100, top: 50, width: 400, height: 600 };
    const placement = placeInspector({
      anchor: node(150, top),
      size,
      bounds: narrow,
    });
    assert.equal(placement.clamped, true);
    assert.equal(placement.left, 100 + 400 - inspectorMargin - inspectorWidth);
    assert.equal(
      placement.top,
      top < 0 ? 50 + inspectorMargin : 50 + 600 - inspectorMargin - 400,
    );
  });

test("when no side is clean, covering a screen beats covering an edge label", () => {
  const anchor = node(320, 40);
  const placement = placeInspector({
    anchor,
    size: { width: inspectorWidth, height: 300 },
    bounds: { left: 0, top: 0, width: 900, height: 800 },
    screens: [node(20, 40)],
    labels: [{ left: 650, top: 100, width: 160, height: 48 }],
    highlighted: [{ left: 320, top: 300, width: 160, height: 48 }],
  });
  assert.equal(placement.side, "left");
});

test("any overlap with the highlighted edge rules a side out before labels and screens", () => {
  const anchor = node(400, 100);
  const placement = placeInspector({
    anchor,
    size,
    bounds,
    screens: [node(400, 330)],
    labels: [{ left: 20, top: 300, width: 160, height: 48 }],
    highlighted: [{ left: 700, top: 480, width: 8, height: 8 }],
  });
  assert.equal(placement.side, "below");
  assert.equal(placement.clamped, false);
});

test("the inspector-flip-left screenshot: the card avoids every edge label and lines up with Profile", () => {
  // Measured at 1440×1000 with the Home → Profile → Settings → Profile seed,
  // Profile selected on Visit 2, whose Profile → Settings edge is highlighted.
  const window = { width: 1440, height: 1000 };
  const placementBounds = visibleBounds(
    { left: 329, top: 617, width: 1062, height: 540 },
    window,
  );
  const profile: Rect = { left: 1090, top: 677, width: 250, height: 123 };
  const screens: Rect[] = [
    { left: 370, top: 677, width: 250, height: 123 },
    { left: 370, top: 1037, width: 250, height: 123 },
  ];
  const tapAvatar: Rect = { left: 775, top: 663, width: 160, height: 48 };
  const tapGear: Rect = { left: 775, top: 843, width: 160, height: 48 };
  const tapClose: Rect = { left: 775, top: 907, width: 160, height: 48 };
  const placement = placeInspector({
    anchor: profile,
    size: { width: inspectorWidth, height: 488 },
    bounds: placementBounds,
    screens,
    labels: [tapAvatar, tapClose],
    highlighted: [tapGear],
  });
  const card: Rect = {
    left: placement.left,
    top: placement.top,
    width: inspectorWidth,
    height: placement.maxHeight,
  };
  for (const label of [tapAvatar, tapGear, tapClose])
    assert.ok(
      card.left >= label.left + label.width ||
        card.top >= label.top + label.height ||
        card.top + card.height <= label.top,
      "card covers an edge label",
    );
  assert.deepEqual(placement, {
    left: 1391 - inspectorMargin - inspectorWidth,
    top: 677 + 123 + inspectorGap,
    maxHeight: 1000 - inspectorMargin - (677 + 123 + inspectorGap),
    side: "below",
    clamped: false,
  });
});

test("beside its screen, a card taller than the space below lines up with the screen's top and scrolls", () => {
  const placement = placeInspector({
    anchor: { left: 1090, top: 677, width: 250, height: 123 },
    size: { width: inspectorWidth, height: 488 },
    bounds: { left: 329, top: 617, width: 1062, height: 383 },
    screens: [{ left: 1090, top: 812, width: 250, height: 123 }],
  });
  assert.equal(placement.side, "left");
  assert.equal(placement.top, 677);
  assert.equal(placement.maxHeight, 1000 - inspectorMargin - 677);
});

test("bounds are the visible canvas, or the window when little canvas is visible", () => {
  const window = { width: 1200, height: 800 };
  assert.deepEqual(
    visibleBounds({ left: 300, top: 200, width: 1400, height: 580 }, window),
    { left: 300, top: 200, width: 900, height: 580 },
  );
  assert.deepEqual(
    visibleBounds({ left: 300, top: 760, width: 900, height: 580 }, window),
    { left: 0, top: 0, width: 1200, height: 800 },
  );
});
