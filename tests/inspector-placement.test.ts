import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectorGap,
  inspectorMargin,
  inspectorWidth,
  placeInspector,
  placeScriptEditor,
  scriptEditorGap,
  scriptEditorWidth,
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

test("the script editor sits beside the inspector without covering it", () => {
  const inspector = { left: 820, top: 120, width: inspectorWidth, height: 400 };
  const placed = placeScriptEditor(inspector, {
    width: bounds.width,
    height: bounds.height,
  });
  assert.equal(placed.left + scriptEditorWidth + scriptEditorGap, inspector.left);
  assert.ok(placed.left >= inspectorMargin);
  const onLeft = { left: 40, top: 100, width: inspectorWidth, height: 400 };
  const rightSide = placeScriptEditor(onLeft, {
    width: bounds.width,
    height: bounds.height,
  });
  assert.equal(rightSide.left, onLeft.left + inspectorWidth + scriptEditorGap);
});

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

test("the inspector-flip-left layout: the card flips left only because the highlighted edge blocks the right and a label blocks below", () => {
  // The flip-left seed (Home → Profile → Settings → Profile, Visit 2 selected,
  // Profile → Settings highlighted) at 1440×1000, page scrolled so the canvas
  // is fully visible, with Profile moved so each rule blocks a different side.
  const placementBounds = visibleBounds(
    { left: 329, top: 217, width: 1062, height: 540 },
    { width: 1440, height: 1000 },
  );
  const profile: Rect = { left: 700, top: 277, width: 250, height: 123 };
  const home: Rect = { left: 370, top: 277, width: 250, height: 123 };
  const tapGear: Rect = { left: 1000, top: 450, width: 160, height: 48 };
  const tapAvatar: Rect = { left: 760, top: 600, width: 160, height: 48 };
  assert.deepEqual(
    placeInspector({
      anchor: profile,
      size: { width: inspectorWidth, height: 488 },
      bounds: placementBounds,
      screens: [home],
      labels: [tapAvatar],
      highlighted: [tapGear],
    }),
    {
      left: 700 - inspectorGap - inspectorWidth,
      top: 277,
      maxHeight: 217 + 540 - inspectorMargin - 277,
      side: "left",
      clamped: false,
    },
  );
});

test("a card flipped to a clear left side lines up with its screen's top", () => {
  const anchor = node(700, 300);
  const placement = placeInspector({
    anchor,
    size: { width: inspectorWidth, height: 300 },
    bounds,
    labels: [{ left: 1000, top: 350, width: 160, height: 48 }],
    screens: [node(700, 560)],
  });
  assert.equal(placement.side, "left");
  assert.equal(placement.clamped, false);
  assert.equal(placement.top, anchor.top);
});

test("ties go right, then left, then below", () =>
  assert.equal(
    placeInspector({
      anchor: node(150, -3000),
      size,
      bounds: { left: 100, top: 50, width: 400, height: 600 },
    }).side,
    "right",
  ));

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
