// The detail view: one 20 x 20 km square of voxel columns around a clicked point, meshed in
// parallel workers and faded into fog towards its edge.
import { BufferAttribute, BufferGeometry, Group, type Material, Mesh } from 'three';
import { type AreaGrid, CHUNK, type ChunkRequest, type WorkerReply } from './shared.ts';

const WORKERS = Math.min(navigator.hardwareConcurrency || 4, 4);

export interface AreaInfo extends AreaGrid {
  lat: number;
  lon: number;
}

export async function fetchArea(lat: number, lon: number): Promise<AreaInfo> {
  const r = await fetch(`/voxels/area.bin?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const n = Number(r.headers.get('x-area-columns'));
  const heights = new Int16Array(await r.arrayBuffer());
  if (heights.length !== n * n) throw new Error(`expected ${n * n} columns, got ${heights.length}`);
  return {
    heights,
    n,
    cell: Number(r.headers.get('x-area-cell-m')),
    lat: Number(r.headers.get('x-area-lat')),
    lon: Number(r.headers.get('x-area-lon')),
  };
}

export class VoxelArea {
  readonly group = new Group();
  area: AreaInfo | null = null;
  private readonly material: Material;
  private readonly workers: Worker[];
  private job = 0;

  constructor(material: Material) {
    this.material = material;
    this.workers = Array.from({ length: WORKERS }, () => new Worker(new URL('./area.worker.ts', import.meta.url), { type: 'module' }));
  }

  /** Mesh `area` at `exaggeration`; resolves once every chunk is in the scene. */
  build(area: AreaInfo, exaggeration: number): Promise<void> {
    const id = ++this.job;
    this.area = area;
    const chunksPerSide = Math.ceil(area.n / CHUNK);
    const all: [number, number][] = [];
    for (let cj = 0; cj < chunksPerSide; cj++) for (let ci = 0; ci < chunksPerSide; ci++) all.push([ci, cj]);
    const meshes: Mesh[] = [];
    return new Promise((resolve, reject) => {
      let pending = all.length;
      this.workers.forEach((w, k) => {
        w.onmessage = (e: MessageEvent<WorkerReply>) => {
          const r = e.data;
          if (r.id !== id) return;
          if (r.type === 'error') {
            reject(new Error(r.message));
            return;
          }
          const g = new BufferGeometry();
          g.setAttribute('position', new BufferAttribute(r.positions, 3));
          g.setAttribute('color', new BufferAttribute(r.colors, 3, true));
          g.setAttribute('grid', new BufferAttribute(r.grid, 2));
          g.setIndex(new BufferAttribute(r.indices, 1));
          g.computeBoundingSphere();
          meshes.push(new Mesh(g, this.material));
          if (--pending === 0) {
            this.clear();
            this.group.add(...meshes);
            resolve();
          }
        };
        const req: ChunkRequest = { id, exaggeration, heights: area.heights, n: area.n, cell: area.cell, chunks: all.filter((_, i) => i % WORKERS === k) };
        w.postMessage(req);
      });
    });
  }

  /** Real height in metres of the column under local scene coordinates (x east, z south). */
  heightAt(x: number, z: number): number | null {
    const a = this.area;
    if (!a) return null;
    const i = Math.floor(x / a.cell + a.n / 2);
    const j = Math.floor(z / a.cell + a.n / 2);
    return i < 0 || j < 0 || i >= a.n || j >= a.n ? null : a.heights[j * a.n + i];
  }

  clear(): void {
    for (const m of this.group.children as Mesh[]) m.geometry.dispose();
    this.group.clear();
  }
}
