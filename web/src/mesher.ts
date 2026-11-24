// Port of VXLEngine's voxelChunk: quantise column heights into cube levels, greedy-merge equal
// top faces into rectangles and side walls into runs, then bend the result onto the globe.
import { bandHeight, hypsometric, tintBand } from './palette.ts';
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
  // Tile-edge walls reach below sea level (the lowest possible surface), so no neighbour, at any zoom, leaves a gap.
  const base = Math.min(min, 0) - 1;
  const level = (i: number, j: number) => (i < 0 || j < 0 || i >= N || j >= N ? base : levels[j * N + i]);
  const lon = (i: number) => b.west + i * cell;
  const lat = (j: number) => b.north - j * cell;
  const SEAM_DROP = 0.45;
  const radius = (lv: number) => EARTH_RADIUS + lv * voxel;
  const tint = (i: number, j: number, shade = 1): Vec =>
    hypsometric(heights[j * N + i]).map((c) => c * shade) as Vec;
  // Top faces only merge within one tint band, so coastlines and height bands survive flat merges.
  const band = (i: number, j: number) => tintBand(heights[j * N + i]);
  const same = (i: number, j: number, lv: number, b: number) => level(i, j) === lv && band(i, j) === b;
  const mid = geoToXyz((b.west + b.east) / 2, (b.south + b.north) / 2, EARTH_RADIUS);
  const out = new MeshBuilder(mid);

  // rect[k] is 1 + the index of the merged top face covering column k (0 = not yet covered).
  const used = new Int32Array(N * N);
  const spans: [number, number, number, number][] = [[0, 0, 0, 0]];
  let rects = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (used[j * N + i]) continue;
      rects++;
      const lv = level(i, j);
      const b = band(i, j);
      let w = 1;
      while (w < MAX_MERGE && i + w < N && !used[j * N + i + w] && same(i + w, j, lv, b)) w++;
      let h = 1;
      grow: while (h < MAX_MERGE && j + h < N) {
        for (let k = 0; k < w; k++) if (used[(j + h) * N + i + k] || !same(i + k, j + h, lv, b)) break grow;
        h++;
      }
      for (let jj = j; jj < j + h; jj++) used.fill(rects, jj * N + i, jj * N + i + w);
      spans.push([i, i + w, j, j + h]);
      const r = radius(lv);
      const corners: Vec[] = [
        geoToXyz(lon(i), lat(j + h), r),
        geoToXyz(lon(i + w), lat(j + h), r),
        geoToXyz(lon(i + w), lat(j), r),
        geoToXyz(lon(i), lat(j), r),
      ];
      const radial = corners.map((c) => c.map((v) => v / r) as Vec);
      out.quad(corners, hypsometric(bandHeight(b)), [[i, j + h], [i + w, j + h], [i + w, j], [i, j]], radial);
    }
  }

  // Side walls: one quad per run of columns sharing the same (level, neighbour level) pair.
  // Where two merged faces of one level meet with different edge vertices (a T-junction), their edges
  // follow different chords of the sphere; a seam wall under the edge hides that crack. Its top stays
  // below the longest chord's sag (under 0.4 voxel at MAX_MERGE 8), so it never pokes through the surface.
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < N && j < N;
  const seam = (i: number, j: number, ni: number, nj: number) => {
    if (!inside(ni, nj) || level(ni, nj) !== level(i, j)) return false;
    const [a, b] = [spans[used[j * N + i]], spans[used[nj * N + ni]]];
    // Across a column edge the faces' row spans must match, across a row edge their column spans.
    return ni !== i ? a[2] !== b[2] || a[3] !== b[3] : a[0] !== b[0] || a[1] !== b[1];
  };
  const bottom = (i: number, j: number, ni: number, nj: number): number | null => {
    const lv = level(i, j);
    const nl = level(ni, nj);
    if (lv > nl) return nl;
    return seam(i, j, ni, nj) ? lv - 1 : null;
  };
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
        const nl = bottom(ci, cj, ci + d.nb[0], cj + d.nb[1]);
        if (nl === null) {
          a++;
          continue;
        }
        const seamAt = (i: number, j: number) => level(i + d.nb[0], j + d.nb[1]) === lv;
        const isSeam = seamAt(ci, cj);
        let len = 1;
        while (len < MAX_MERGE && a + len < N) {
          const [ni, nj] = d.col(s, a + len);
          if (level(ni, nj) !== lv || bottom(ni, nj, ni + d.nb[0], nj + d.nb[1]) !== nl || seamAt(ni, nj) !== isSeam) break;
          len++;
        }
        const aL = d.flip ? a + len : a;
        const aR = d.flip ? a : a + len;
        const [lx, ly] = d.edge(s, aL);
        const [rx, ry] = d.edge(s, aR);
        const top = isSeam ? lv - SEAM_DROP : lv;
        const lo = radius(nl);
        const hi = radius(top);
        out.quad(
          [geoToXyz(lx, ly, lo), geoToXyz(rx, ry, lo), geoToXyz(rx, ry, hi), geoToXyz(lx, ly, hi)],
          tint(ci, cj, 0.8),
          [[aL, nl], [aR, nl], [aR, top], [aL, top]],
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

