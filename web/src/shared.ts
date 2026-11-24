export const COLUMNS = 64;
/** Greedy runs stop at this many columns so merged faces still follow the globe's curvature. */
export const MAX_MERGE = 8;
export const EARTH_RADIUS = 6_371_008.8;
export const MAX_RELIEF = 9_000;

export interface MeshRequest {
  id: number;
  z: number;
  x: number;
  y: number;
  exaggeration: number;
}

export interface MeshResult {
  type: 'mesh';
  id: number;
  center: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  grid: Float32Array;
  indices: Uint32Array;
}

export interface MeshError {
  type: 'error';
  id: number;
  message: string;
}

export type WorkerReply = MeshResult | MeshError;

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Geographic TMS pyramid: two tiles at zoom 0, y counted from the south. */
export function tileBounds(z: number, x: number, y: number): Bounds {
  const size = 180 / 2 ** z;
  const west = -180 + x * size;
  const south = -90 + y * size;
  return { west, south, east: west + size, north: south + size };
}

/** Edge of one voxel at zoom `z`: the north-south extent of a column, so blocks are cubes. */
export function voxelSize(z: number): number {
  return (EARTH_RADIUS * Math.PI) / 2 ** z / COLUMNS;
}

const DEG = Math.PI / 180;

/** Earth-centred coordinates (metres, z towards the north pole) on a sphere of radius `r`. */
export function geoToXyz(lon: number, lat: number, r: number): [number, number, number] {
  const cl = Math.cos(lat * DEG);
  return [r * cl * Math.cos(lon * DEG), r * cl * Math.sin(lon * DEG), r * Math.sin(lat * DEG)];
}

export function xyzToGeo(x: number, y: number, z: number): { lon: number; lat: number } {
  return { lon: Math.atan2(y, x) / DEG, lat: Math.asin(z / Math.hypot(x, y, z)) / DEG };
}
