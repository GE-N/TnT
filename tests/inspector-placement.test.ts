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
    maxHeight: 800 - 2 * inspectorMargin,
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
    obstacles: [next],
  });
  assert.equal(placement.side, "left");
});

test("the inspector flips left when the right side covers an edge label", () => {
  const anchor = node(400, 100);
  const label: Rect = { left: 680, top: 300, width: 160, height: 48 };
  assert.equal(
    placeInspector({ anchor, size, bounds, obstacles: [label] }).side,
    "left",
  );
});

test("the inspector goes below when both sides are blocked", () => {
  const anchor = node(320, 40);
  const placement = placeInspector({
    anchor,
    size: { width: inspectorWidth, height: 300 },
    bounds: { left: 0, top: 0, width: 900, height: 800 },
    obstacles: [node(600, 40), node(20, 40)],
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
    obstacles: [
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

test("a tall inspector scrolls inside the window instead of growing past it", () => {
  const placement = placeInspector({
    anchor: node(100, 100),
    size: { width: inspectorWidth, height: 3000 },
    bounds,
  });
  assert.equal(placement.maxHeight, 800 - 2 * inspectorMargin);
  assert.equal(placement.top, inspectorMargin);
});

test("the inspector is never wider than a narrow window", () => {
  const placement = placeInspector({
    anchor: node(10, 10),
    size,
    bounds: { left: 0, top: 0, width: 280, height: 600 },
  });
  assert.equal(placement.clamped, true);
  assert.equal(placement.left, inspectorMargin);
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
