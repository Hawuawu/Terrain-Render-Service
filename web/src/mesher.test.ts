import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from './mesher.ts';
import { COLUMNS as N, EARTH_RADIUS, MAX_MERGE, geoToXyz, tileBounds, voxelSize } from './shared.ts';

type Vec = [number, number, number];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec): Vec => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

function triangles(heights: Int16Array, z = 10, x = 1100, y = 770) {
  const m = build({ id: 1, z, x, y, exaggeration: 1 }, heights);
  const p = (k: number): Vec => [
    m.positions[3 * k] + m.center[0],
    m.positions[3 * k + 1] + m.center[1],
    m.positions[3 * k + 2] + m.center[2],
  ];
  const out: { centroid: Vec; normal: Vec; top: boolean }[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [p(m.indices[t]), p(m.indices[t + 1]), p(m.indices[t + 2])];
    const centroid: Vec = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const normal = unit(cross(sub(b, a), sub(c, a)));
    out.push({ centroid, normal, top: dot(normal, unit(centroid)) > 0.9 });
  }
  return { m, tris: out };
}

test('flat tile merges top faces up to MAX_MERGE and faces outwards', () => {
  const { tris } = triangles(new Int16Array(N * N));
  const tops = tris.filter((t) => t.top);
  assert.equal(tops.length, 2 * (N / MAX_MERGE) ** 2);
  for (const t of tops) assert.ok(dot(t.normal, unit(t.centroid)) > 0.99);
});

test('walls of a raised column face away from it, tile skirts face away from the tile', () => {
  const heights = new Int16Array(N * N);
  heights[10 * N + 20] = 1000;
  const z = 10;
  const { m, tris } = triangles(heights, z);
  const b = tileBounds(z, 1100, 770);
  const cell = (b.east - b.west) / N;
  const column = geoToXyz(b.west + 20.5 * cell, b.north - 10.5 * cell, EARTH_RADIUS);
  const near = voxelSize(z) * 2;
  const walls = tris.filter((t) => !t.top);
  const columnWalls = walls.filter((t) => Math.hypot(...sub(t.centroid, column)) < near * 2);
  assert.equal(columnWalls.length, 8);
  for (const t of columnWalls) assert.ok(dot(t.normal, sub(t.centroid, column)) > 0);
  const skirts = walls.filter((t) => !columnWalls.includes(t));
  assert.equal(skirts.length, 2 * 4 * (N / MAX_MERGE));
  for (const t of skirts) assert.ok(dot(t.normal, sub(t.centroid, m.center)) > 0);
});

test('levels quantise exaggerated height into cubes and flatten the sea', () => {
  const heights = new Int16Array(N * N).fill(-3000);
  heights[0] = Math.round(voxelSize(10) * 2.4);
  const { m } = triangles(heights);
  let maxR = 0;
  let minR = Infinity;
  for (let k = 0; k < m.positions.length; k += 3) {
    const r = Math.hypot(m.positions[k] + m.center[0], m.positions[k + 1] + m.center[1], m.positions[k + 2] + m.center[2]);
    maxR = Math.max(maxR, r);
    minR = Math.min(minR, r);
  }
  assert.ok(Math.abs(maxR - (EARTH_RADIUS + 2 * voxelSize(10))) < 1);
  assert.ok(Math.abs(minR - (EARTH_RADIUS - voxelSize(10))) < 1);
});
