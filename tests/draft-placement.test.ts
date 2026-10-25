import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  AI_CAPSULE_FOOTPRINT,
  AI_CHROME_PAD,
  AI_LAUNCH_FOOTPRINT,
  DRAFT_NODE_HEIGHT,
  DRAFT_NODE_WIDTH,
  anchoredFootprint,
  canvasReservedBox,
  placementForDraft,
  reservedAiChrome,
  type Box,
} from '../src/draft-placement.js';

const viewport: Box = {left: 0, top: 0, right: 1280, bottom: 800};

function overlaps(point: {x: number; y: number}, box: Box) {
  return point.x < box.right && point.x + DRAFT_NODE_WIDTH > box.left && point.y < box.bottom && point.y + DRAFT_NODE_HEIGHT > box.top;
}

test('reserved AI chrome is the union of the launch control and the capsule plus a 16px pad', () => {
  const reserved = reservedAiChrome(viewport);
  const launch = anchoredFootprint(viewport, AI_LAUNCH_FOOTPRINT);
  const capsule = anchoredFootprint(viewport, AI_CAPSULE_FOOTPRINT);
  assert.ok(reserved.left <= Math.min(launch.left, capsule.left) - AI_CHROME_PAD + 0.01);
  assert.ok(reserved.top <= Math.min(launch.top, capsule.top) - AI_CHROME_PAD + 0.01);
  assert.ok(reserved.right >= Math.max(launch.right, capsule.right) + AI_CHROME_PAD - 0.01);
  assert.ok(reserved.bottom >= Math.max(launch.bottom, capsule.bottom) + AI_CHROME_PAD - 0.01);
  assert.equal(AI_CHROME_PAD, 16);
  assert.ok(launch.right <= capsule.right && launch.bottom <= capsule.bottom);
  assert.ok(reserved.left <= launch.left - AI_CHROME_PAD + 0.01);
  assert.ok(reserved.top <= launch.top - AI_CHROME_PAD + 0.01);

  const measuredLaunch = reservedAiChrome(viewport, [launch]);
  assert.ok(measuredLaunch.left <= capsule.left - AI_CHROME_PAD + 0.01);
  assert.ok(measuredLaunch.right >= capsule.right + AI_CHROME_PAD - 0.01);

  const measuredCapsule = reservedAiChrome(viewport, [capsule]);
  assert.ok(measuredCapsule.left <= launch.left - AI_CHROME_PAD + 0.01);
  assert.ok(measuredCapsule.bottom >= launch.bottom + AI_CHROME_PAD - 0.01);

  const bigger = {left: 100, top: 100, right: 900, bottom: 700};
  const grown = reservedAiChrome(viewport, [bigger]);
  assert.ok(grown.left <= bigger.left - AI_CHROME_PAD);
  assert.ok(grown.top <= bigger.top - AI_CHROME_PAD);
  assert.ok(grown.right >= bigger.right + AI_CHROME_PAD);
  assert.ok(grown.bottom >= bigger.bottom + AI_CHROME_PAD);
});

test('the packer never places a draft on the reserved AI control', () => {
  const existing = [{x: 40, y: 40}];
  const before = existing.map(point => ({...point}));
  const reserved = reservedAiChrome(viewport);
  const placed = placementForDraft({
    existing,
    count: 16,
    zoom: 1,
    viewport: {width: 1280, height: 800, scrollLeft: 0, scrollTop: 0},
    insets: {top: 12, right: 12, bottom: 12, left: 12},
    reserved: [reserved],
    origin: {left: 0, top: 0},
  });
  assert.deepEqual(existing, before);
  assert.ok(placed.positions.length > 0);
  const canvas = canvasReservedBox(reserved, {left: 0, top: 0}, placed.scrollLeft, placed.scrollTop, 1);
  for (const point of placed.positions) assert.equal(overlaps(point, canvas), false, JSON.stringify(point));
  const naive = {x: 792, y: 624};
  assert.equal(overlaps(naive, canvasReservedBox(reserved, {left: 0, top: 0}, 0, 0, 1)), true);
  assert.equal(placed.positions.some(point => point.x === naive.x && point.y === naive.y && placed.scrollLeft === 0 && placed.scrollTop === 0), false);
});

test('a reserved rectangle blocks the cell the packer would otherwise use', () => {
  const first = {left: 12, top: 84, right: 12 + DRAFT_NODE_WIDTH, bottom: 84 + DRAFT_NODE_HEIGHT};
  const placed = placementForDraft({
    existing: [],
    count: 1,
    zoom: 1,
    viewport: {width: 1280, height: 800, scrollLeft: 0, scrollTop: 0},
    insets: {top: 12, right: 12, bottom: 12, left: 12},
    reserved: [first],
    origin: {left: 0, top: 0},
  });
  assert.equal(placed.positions.length, 1);
  const canvas = canvasReservedBox(first, {left: 0, top: 0}, placed.scrollLeft, placed.scrollTop, 1);
  assert.equal(overlaps(placed.positions[0]!, canvas), false);
});
