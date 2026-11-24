export const EARTH_RADIUS = 6_371_008.8;
/** Columns per mesh chunk edge: an area of 512 x 512 columns is meshed as 8 x 8 chunks in parallel. */
export const CHUNK = 64;
/** Greedy top faces stop at this many columns per side; the scene is flat, so this only bounds face size. */
export const MAX_MERGE = 32;

export interface AreaGrid {
  /** Column heights in metres, row 0 at the north edge. */
  heights: Int16Array;
  /** Columns per edge. */
  n: number;
  /** Edge of one column in metres. */
  cell: number;
}

/** Column range `[i0, j0, i1, j1)` of a grid. */
export type Range = [number, number, number, number];

export interface ChunkRequest extends AreaGrid {
  id: number;
  exaggeration: number;
  ranges: Range[];
}

export interface ChunkMesh {
  type: 'chunk';
  id: number;
  positions: Float32Array;
  colors: Uint8Array;
  grid: Float32Array;
  indices: Uint32Array;
}

export interface ChunkError {
  type: 'error';
  id: number;
  message: string;
}

export type WorkerReply = ChunkMesh | ChunkError;

const DEG = Math.PI / 180;

/** Earth-centred coordinates (metres, z towards the north pole) on a sphere of radius `r`. */
export function geoToXyz(lon: number, lat: number, r: number): [number, number, number] {
  const cl = Math.cos(lat * DEG);
  return [r * cl * Math.cos(lon * DEG), r * cl * Math.sin(lon * DEG), r * Math.sin(lat * DEG)];
}

export function xyzToGeo(x: number, y: number, z: number): { lon: number; lat: number } {
  return { lon: Math.atan2(y, x) / DEG, lat: Math.asin(z / Math.hypot(x, y, z)) / DEG };
}

/** Latitude of a fractional Web Mercator row `y` at zoom `z` (row 0 at the north edge). */
export function mercatorLat(z: number, y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / DEG;
}

/** Fractional Web Mercator tile coordinates of a point at zoom `z`. */
export function mercatorTile(z: number, lon: number, lat: number): { x: number; y: number } {
  const l = Math.max(-85.0511, Math.min(85.0511, lat)) * DEG;
  const n = 2 ** z;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2) * n };
}

/** Voxel level of a column: sea is flattened to level 0, land rounds to whole cubes of edge `cell`. */
export function levelOf(h: number, exaggeration: number, cell: number): number {
  return Math.round((Math.max(h, 0) * exaggeration) / cell);
}
