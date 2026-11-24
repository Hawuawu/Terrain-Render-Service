// Port of VXLEngine's voxelChunk: quantise column heights into cube levels, greedy-merge equal
// top faces into rectangles and side walls into runs, then bend the result onto the globe.
import { hypsometric } from './palette.ts';
import {
  COLUMNS as N,
  EARTH_RADIUS,
  MAX_MERGE,
  type MeshRequest,
  type MeshResult,
  geoToXyz,
  tileBounds,
  voxelSize,
} from './shared.ts';

type Vec = [number, number, number];

function sub(a: Vec, b: Vec): Vec {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function unitCross(a: Vec, b: Vec): Vec {
  const c: Vec = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const l = Math.hypot(...c) || 1;
  return [c[0] / l, c[1] / l, c[2] / l];
}

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  grid: number[] = [];
  indices: number[] = [];

  readonly center: Vec;

  constructor(center: Vec) {
    this.center = center;
  }

  /** Quad given counter-clockwise as seen from outside; `n` overrides the face normal per vertex. */
  quad(p: Vec[], color: Vec, g: [number, number][], n?: Vec[]): void {
    const base = this.positions.length / 3;
    const flat = unitCross(sub(p[1], p[0]), sub(p[2], p[0]));
    for (let k = 0; k < 4; k++) {
      this.positions.push(p[k][0] - this.center[0], p[k][1] - this.center[1], p[k][2] - this.center[2]);
      this.normals.push(...(n ? n[k] : flat));
      this.colors.push(color[0], color[1], color[2]);
      this.grid.push(g[k][0], g[k][1]);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

export function build(req: MeshRequest, heights: Int16Array): MeshResult {
  const b = tileBounds(req.z, req.x, req.y);
  const cell = (b.east - b.west) / N;
  const voxel = voxelSize(req.z);
  const levels = new Int32Array(N * N);
  let min = Infinity;
  for (let k = 0; k < levels.length; k++) {
    levels[k] = Math.round((Math.max(heights[k], 0) * req.exaggeration) / voxel);
    min = Math.min(min, levels[k]);
  }
  const base = min - 1;
  const level = (i: number, j: number) => (i < 0 || j < 0 || i >= N || j >= N ? base : levels[j * N + i]);
  const lon = (i: number) => b.west + i * cell;
  const lat = (j: number) => b.north - j * cell;
  const radius = (lv: number) => EARTH_RADIUS + lv * voxel;
  const tint = (i: number, j: number, shade = 1): Vec =>
    hypsometric(heights[j * N + i]).map((c) => c * shade) as Vec;
  const mid = geoToXyz((b.west + b.east) / 2, (b.south + b.north) / 2, EARTH_RADIUS);
  const out = new MeshBuilder(mid);

  const used = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (used[j * N + i]) continue;
      const lv = level(i, j);
      let w = 1;
      while (w < MAX_MERGE && i + w < N && !used[j * N + i + w] && level(i + w, j) === lv) w++;
      let h = 1;
      grow: while (h < MAX_MERGE && j + h < N) {
        for (let k = 0; k < w; k++) if (used[(j + h) * N + i + k] || level(i + k, j + h) !== lv) break grow;
        h++;
      }
      for (let jj = j; jj < j + h; jj++) used.fill(1, jj * N + i, jj * N + i + w);
      const r = radius(lv);
      const corners: Vec[] = [
        geoToXyz(lon(i), lat(j + h), r),
        geoToXyz(lon(i + w), lat(j + h), r),
        geoToXyz(lon(i + w), lat(j), r),
        geoToXyz(lon(i), lat(j), r),
      ];
      const radial = corners.map((c) => c.map((v) => v / r) as Vec);
      out.quad(corners, tint(i, j), [[i, j + h], [i + w, j + h], [i + w, j], [i, j]], radial);
    }
  }

  // Side walls: one quad per run of columns sharing the same (level, neighbour level) pair.
  // For each face direction, `col` maps (row s, position a along the edge) to a column, `edge`
  // gives the edge point at position a, and `flip` says the left end (seen from outside) is a+len.
  type Dir = {
    col: (s: number, a: number) => [number, number];
    nb: [number, number];
    edge: (s: number, a: number) => [number, number];
    flip: boolean;
  };
  const dirs: Dir[] = [
    { col: (s, a) => [s, a], nb: [1, 0], edge: (s, a) => [lon(s + 1), lat(a)], flip: true },
    { col: (s, a) => [s, a], nb: [-1, 0], edge: (s, a) => [lon(s), lat(a)], flip: false },
    { col: (s, a) => [a, s], nb: [0, -1], edge: (s, a) => [lon(a), lat(s)], flip: true },
    { col: (s, a) => [a, s], nb: [0, 1], edge: (s, a) => [lon(a), lat(s + 1)], flip: false },
  ];
  for (const d of dirs) {
    for (let s = 0; s < N; s++) {
      let a = 0;
      while (a < N) {
        const [ci, cj] = d.col(s, a);
        const lv = level(ci, cj);
        const nl = level(ci + d.nb[0], cj + d.nb[1]);
        if (lv <= nl) {
          a++;
          continue;
        }
        let len = 1;
        while (len < MAX_MERGE && a + len < N) {
          const [ni, nj] = d.col(s, a + len);
          if (level(ni, nj) !== lv || level(ni + d.nb[0], nj + d.nb[1]) !== nl) break;
          len++;
        }
        const aL = d.flip ? a + len : a;
        const aR = d.flip ? a : a + len;
        const [lx, ly] = d.edge(s, aL);
        const [rx, ry] = d.edge(s, aR);
        const lo = radius(nl);
        const hi = radius(lv);
        out.quad(
          [geoToXyz(lx, ly, lo), geoToXyz(rx, ry, lo), geoToXyz(rx, ry, hi), geoToXyz(lx, ly, hi)],
          tint(ci, cj, 0.8),
          [[aL, nl], [aR, nl], [aR, lv], [aL, lv]],
        );
        a += len;
      }
    }
  }

  return {
    type: 'mesh',
    id: req.id,
    center: mid,
    positions: new Float32Array(out.positions),
    normals: new Float32Array(out.normals),
    colors: new Uint8Array(out.colors),
    grid: new Float32Array(out.grid),
    indices: new Uint32Array(out.indices),
  };
}

