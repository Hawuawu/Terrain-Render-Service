import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChunk, buildRange, quantise } from './mesher.ts';
import { CHUNK, levelOf, lowest, mercatorLat, mercatorTile } from './shared.ts';

type Vec = [number, number, number];
const N = CHUNK;
const CELL = 40;

function triangles(heights: Int16Array, n = N) {
  const m = buildChunk({ heights, n, cell: CELL }, 1, 0, 0);
  const p = (k: number): Vec => [m.positions[3 * k], m.positions[3 * k + 1], m.positions[3 * k + 2]];
  const out: { centroid: Vec; normal: Vec }[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [p(m.indices[t]), p(m.indices[t + 1]), p(m.indices[t + 2])];
    const u: Vec = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Vec = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr: Vec = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...cr);
    out.push({ centroid: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], normal: [cr[0] / l, cr[1] / l, cr[2] / l] });
  }
  return { m, tris: out };
}

const ups = (tris: { normal: Vec }[]) => tris.filter((t) => t.normal[1] > 0.99);

test('a flat land chunk merges into 32-column top faces plus outer walls', () => {
  const { tris } = triangles(new Int16Array(N * N).fill(400));
  assert.equal(ups(tris).length, 2 * (N / 32) ** 2);
  assert.ok(tris.every((t) => t.normal[1] > 0.99 || Math.abs(t.normal[1]) < 1e-6));
});

test('a raised column gets four outward walls of its own height', () => {
  const h = new Int16Array(N * N).fill(0);
  h[10 * N + 10] = 3 * CELL;
  const { tris } = triangles(h);
  const walls = tris.filter((t) => Math.abs(t.normal[1]) < 1e-6 && t.centroid[1] > 0);
  assert.equal(walls.length, 8);
  const cx = (10.5 - N / 2) * CELL;
  const cz = (10.5 - N / 2) * CELL;
  for (const w of walls) {
    const out = (w.centroid[0] - cx) * w.normal[0] + (w.centroid[2] - cz) * w.normal[2];
    assert.ok(out > 0, 'wall faces away from the column');
    assert.ok(w.centroid[1] <= 3 * CELL);
  }
});

test('walls between chunks use the neighbouring chunk, so chunk borders inside the area have none', () => {
  const n = 2 * N;
  const flat = new Int16Array(n * n).fill(200);
  const { tris } = triangles(flat, n);
  assert.ok(!tris.some((w) => w.normal[0] > 0.99 || w.normal[2] > 0.99), 'no east or south walls inside the area');
  assert.ok(tris.some((w) => w.normal[0] < -0.99) && tris.some((w) => w.normal[2] < -0.99));
});

test('a patch meshes only its inner columns, and a matching border leaves its edges without walls', () => {
  const n = 18;
  const heights = new Int16Array(n * n).fill(200);
  const m = buildRange({ heights, n, cell: CELL }, 1, [1, 1, n - 1, n - 1]);
  const ys = new Set<number>();
  for (let k = 0; k < m.positions.length; k += 3) {
    assert.ok(Math.abs(m.positions[k]) <= ((n - 2) / 2) * CELL + 1e-6);
    assert.ok(Math.abs(m.positions[k + 2]) <= ((n - 2) / 2) * CELL + 1e-6);
    ys.add(m.positions[k + 1]);
  }
  assert.deepEqual([...ys], [levelOf(200, 1, CELL) * CELL]);
});

test('sea flattens to level 0 and coastlines stop merges', () => {
  assert.equal(levelOf(-300, 2, CELL), 0);
  assert.equal(levelOf(70, 1, CELL), 2);
  const h = new Int16Array(N * N).fill(-5);
  for (let j = 0; j < N; j++) h[j * N] = 1;
  const { levels, bands } = quantise({ heights: h, n: N, cell: CELL }, 1);
  assert.equal(levels[0], levels[1]);
  assert.notEqual(bands[0], bands[1]);
  assert.ok(ups(triangles(h).tris).length > 2 * (N / 32) ** 2);
});

test('mercator helpers round-trip', () => {
  const t = mercatorTile(5, 6.86, 45.83);
  assert.ok(Math.abs(mercatorLat(5, t.y) - 45.83) < 1e-9);
  assert.equal(mercatorLat(0, 0.5), 0);
});

test('lowest takes the minimum height within the radius', () => {
  const n = 5;
  const pos = new Float32Array(n * n * 3);
  for (let k = 0; k < n * n; k++) pos[k * 3 + 1] = 100 + k;
  pos[(2 * n + 2) * 3 + 1] = -5;
  const low = lowest(pos, n, 1);
  assert.equal(low[0], 100);
  assert.equal(low[n + 1], -5);
  assert.equal(low[4 * n + 4], 118);
});
