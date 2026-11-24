// VXLEngine-style voxel chunk mesher for a flat local area: quantise column heights into cube levels,
// greedy-merge equal top faces into rectangles and side walls into runs. x points east, y up, z south.
import { bandHeight, hypsometric, tintBand } from './palette.ts';
import { type AreaGrid, CHUNK, type ChunkMesh, MAX_MERGE, levelOf } from './shared.ts';

type Rgb = [number, number, number];

class MeshBuilder {
  positions: number[] = [];
  colors: number[] = [];
  grid: number[] = [];
  indices: number[] = [];

  /** Quad given counter-clockwise as seen from the side it faces; `g` are outline grid coordinates. */
  quad(p: number[][], color: Rgb, g: number[][]): void {
    const base = this.positions.length / 3;
    for (let k = 0; k < 4; k++) {
      this.positions.push(p[k][0], p[k][1], p[k][2]);
      this.colors.push(color[0], color[1], color[2]);
      this.grid.push(g[k][0], g[k][1]);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

const shade = (c: Rgb, f: number): Rgb => [c[0] * f, c[1] * f, c[2] * f];

/** Columns' levels, the level the area's outer walls drop to, and each column's colour. */
export function quantise(area: AreaGrid, exaggeration: number) {
  const { heights, n, cell } = area;
  const levels = new Int32Array(n * n);
  const bands = new Int32Array(n * n);
  let min = Infinity;
  for (let k = 0; k < levels.length; k++) {
    levels[k] = levelOf(heights[k], exaggeration, cell);
    bands[k] = tintBand(heights[k]);
    min = Math.min(min, levels[k]);
  }
  return { levels, bands, floor: Math.min(min, 0) - 2 };
}

// Each side: column-offset of the neighbour, and how to place the wall's two top corners.
const SIDES = [
  { di: 1, dj: 0 },
  { di: -1, dj: 0 },
  { di: 0, dj: 1 },
  { di: 0, dj: -1 },
] as const;

export function buildChunk(
  area: AreaGrid,
  exaggeration: number,
  ci: number,
  cj: number,
  q = quantise(area, exaggeration),
): Omit<ChunkMesh, 'type' | 'id'> {
  const { n, cell } = area;
  const { levels, bands, floor } = q;
  const i0 = ci * CHUNK;
  const j0 = cj * CHUNK;
  const i1 = Math.min(i0 + CHUNK, n);
  const j1 = Math.min(j0 + CHUNK, n);
  const at = (i: number, j: number) => j * n + i;
  const level = (i: number, j: number) => (i < 0 || j < 0 || i >= n || j >= n ? floor : levels[at(i, j)]);
  const X = (i: number) => (i - n / 2) * cell;
  const Z = (j: number) => (j - n / 2) * cell;
  const colour = (k: number): Rgb => {
    const c = hypsometric(bandHeight(bands[k]));
    return bands[k] >= 0 && levels[k] % 2 ? shade(c, 0.95) : c;
  };
  const m = new MeshBuilder();

  const done = new Uint8Array((i1 - i0) * (j1 - j0));
  const seen = (i: number, j: number) => done[(j - j0) * (i1 - i0) + (i - i0)];
  const same = (i: number, j: number, k: number) => !seen(i, j) && levels[at(i, j)] === levels[k] && bands[at(i, j)] === bands[k];
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      if (seen(i, j)) continue;
      const k = at(i, j);
      let w = 1;
      while (i + w < i1 && w < MAX_MERGE && same(i + w, j, k)) w++;
      let h = 1;
      grow: while (j + h < j1 && h < MAX_MERGE) {
        for (let u = 0; u < w; u++) if (!same(i + u, j + h, k)) break grow;
        h++;
      }
      for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) done[(j + v - j0) * (i1 - i0) + (i + u - i0)] = 1;
      const y = levels[k] * cell;
      m.quad(
        [
          [X(i), y, Z(j)],
          [X(i), y, Z(j + h)],
          [X(i + w), y, Z(j + h)],
          [X(i + w), y, Z(j)],
        ],
        colour(k),
        [
          [i, j],
          [i, j + h],
          [i + w, j + h],
          [i + w, j],
        ],
      );
    }
  }

  for (const s of SIDES) {
    // Walk along the side's edge direction, merging neighbouring columns with the same top and bottom.
    const alongI = s.di === 0;
    const outer = alongI ? [j0, j1] : [i0, i1];
    const inner = alongI ? [i0, i1] : [j0, j1];
    for (let a = outer[0]; a < outer[1]; a++) {
      let b = inner[0];
      while (b < inner[1]) {
        const ij = (t: number): [number, number] => (alongI ? [t, a] : [a, t]);
        const [i, j] = ij(b);
        const top = levels[at(i, j)];
        const bottom = level(i + s.di, j + s.dj);
        if (top <= bottom) {
          b++;
          continue;
        }
        let len = 1;
        while (b + len < inner[1] && len < MAX_MERGE) {
          const [ni, nj] = ij(b + len);
          if (levels[at(ni, nj)] !== top || level(ni + s.di, nj + s.dj) !== bottom) break;
          len++;
        }
        const yt = top * cell;
        const yb = bottom * cell;
        const c = shade(colour(at(i, j)), 0.82);
        if (s.di !== 0) {
          const x = X(s.di > 0 ? i + 1 : i);
          const [za, zb] = s.di > 0 ? [Z(j + len), Z(j)] : [Z(j), Z(j + len)];
          m.quad([[x, yb, za], [x, yb, zb], [x, yt, zb], [x, yt, za]], c, [[0, bottom], [len, bottom], [len, top], [0, top]].map(([u, v]) => [u + j, v]));
        } else {
          const z = Z(s.dj > 0 ? j + 1 : j);
          const [xa, xb] = s.dj > 0 ? [X(i), X(i + len)] : [X(i + len), X(i)];
          m.quad([[xa, yb, z], [xb, yb, z], [xb, yt, z], [xa, yt, z]], c, [[0, bottom], [len, bottom], [len, top], [0, top]].map(([u, v]) => [u + i, v]));
        }
        b += len;
      }
    }
  }

  return {
    positions: new Float32Array(m.positions),
    colors: new Uint8Array(m.colors),
    grid: new Float32Array(m.grid),
    indices: new Uint32Array(m.indices),
  };
}
