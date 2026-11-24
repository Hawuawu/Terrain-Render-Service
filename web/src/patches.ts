// The voxel view streams square patches of columns around the viewer: nearest (and ahead) first, dropping
// ones that fall far behind. Each patch carries a one-column border so walls match across patch seams.
import { BufferAttribute, BufferGeometry, Group, type Material, Mesh, type Vector3 } from 'three';
import type { ChunkRequest, WorkerReply } from './shared.ts';

const WORKERS = Math.min(navigator.hardwareConcurrency || 4, 4);
const IN_FLIGHT = 6;
export const PATCH_M = 5_000;
/** Patches whose nearest point is within `LOAD_M` of the viewer load; beyond `DROP_M` they are dropped. */
export const LOAD_M = 13_000;
const DROP_M = 17_000;
/** The service serves patches whose centre lies within ±84.1° latitude. */
const MAX_PATCH_LAT = 84.1;
const METRES_PER_DEGREE = (6_371_008.8 * Math.PI) / 180;

export interface Origin {
  lat: number;
  lon: number;
}

interface Patch {
  i: number;
  j: number;
  heights?: Int16Array;
  n?: number;
  cell?: number;
  mesh?: Mesh;
  failed?: boolean;
}

export class PatchField {
  readonly group = new Group();
  origin: Origin | null = null;
  exaggeration = 2;
  private readonly patches = new Map<string, Patch>();
  private readonly workers: Worker[];
  private readonly pending = new Map<number, (r: WorkerReply) => void>();
  private loading = 0;
  private job = 0;
  private next = 0;
  private generation = 0;

  constructor(private readonly material: Material) {
    this.workers = Array.from({ length: WORKERS }, () => new Worker(new URL('./area.worker.ts', import.meta.url), { type: 'module' }));
    for (const w of this.workers) w.onmessage = (e: MessageEvent<WorkerReply>) => this.pending.get(e.data.id)?.(e.data);
  }

  get stats() {
    let shown = 0;
    for (const p of this.patches.values()) if (p.mesh) shown++;
    return { shown, loading: this.loading };
  }

  reset(origin: Origin, exaggeration: number): void {
    this.clear();
    this.origin = origin;
    this.exaggeration = exaggeration;
  }

  /** Request missing patches around `at`, preferring the direction of travel `dir` (unit x/z or zero). */
  update(at: Vector3, dir: { x: number; z: number }): void {
    const o = this.origin;
    if (!o) return;
    const reach = Math.ceil(LOAD_M / PATCH_M) + 1;
    const ci = Math.round(at.x / PATCH_M);
    const cj = Math.round(at.z / PATCH_M);
    const wanted: { i: number; j: number; score: number }[] = [];
    for (let j = cj - reach; j <= cj + reach; j++) {
      for (let i = ci - reach; i <= ci + reach; i++) {
        const d = this.distance(i, j, at);
        if (d > LOAD_M || this.patches.has(`${i},${j}`)) continue;
        if (Math.abs(o.lat - (j * PATCH_M) / METRES_PER_DEGREE) > MAX_PATCH_LAT) continue;
        const ahead = (i * PATCH_M - at.x) * dir.x + (j * PATCH_M - at.z) * dir.z;
        wanted.push({ i, j, score: d - 0.5 * ahead });
      }
    }
    wanted.sort((a, b) => a.score - b.score);
    for (const w of wanted) {
      if (this.loading >= IN_FLIGHT) break;
      void this.load(o, w.i, w.j);
    }
    for (const [k, p] of this.patches) {
      if (this.distance(p.i, p.j, at) > DROP_M && (p.mesh || p.failed)) {
        p.mesh?.geometry.dispose();
        if (p.mesh) this.group.remove(p.mesh);
        this.patches.delete(k);
      }
    }
  }

  /** True once every patch within `radius` of `at` is shown (or could not be loaded). */
  readyAround(at: Vector3, radius: number): boolean {
    const r = Math.ceil(radius / PATCH_M) + 1;
    const ci = Math.round(at.x / PATCH_M);
    const cj = Math.round(at.z / PATCH_M);
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        const p = this.patches.get(`${i},${j}`);
        if (this.distance(i, j, at) <= radius && !p?.mesh && !p?.failed) return false;
      }
    }
    return true;
  }

  /** Re-mesh every loaded patch, e.g. at a new exaggeration. */
  rebuild(exaggeration: number): Promise<void> {
    this.exaggeration = exaggeration;
    return Promise.all([...this.patches.values()].filter((p) => p.heights).map((p) => this.mesh(p, this.generation))).then(() => undefined);
  }

  /** Real height in metres of the column under local scene coordinates (x east, z south). */
  heightAt(x: number, z: number): number | null {
    const i = Math.round(x / PATCH_M);
    const j = Math.round(z / PATCH_M);
    const p = this.patches.get(`${i},${j}`);
    if (!p?.heights || !p.n || !p.cell) return null;
    const inner = p.n - 2;
    const u = Math.floor((x - i * PATCH_M) / p.cell + inner / 2) + 1;
    const v = Math.floor((z - j * PATCH_M) / p.cell + inner / 2) + 1;
    return u < 1 || v < 1 || u > inner || v > inner ? null : p.heights[v * p.n + u];
  }

  get cell(): number {
    for (const p of this.patches.values()) if (p.cell) return p.cell;
    return PATCH_M / 128;
  }

  clear(): void {
    this.generation++;
    for (const p of this.patches.values()) p.mesh?.geometry.dispose();
    this.patches.clear();
    this.group.clear();
    this.loading = 0;
    this.origin = null;
  }

  private distance(i: number, j: number, at: Vector3): number {
    const dx = Math.max(Math.abs(i * PATCH_M - at.x) - PATCH_M / 2, 0);
    const dz = Math.max(Math.abs(j * PATCH_M - at.z) - PATCH_M / 2, 0);
    return Math.hypot(dx, dz);
  }

  private async load(o: Origin, i: number, j: number): Promise<void> {
    const gen = this.generation;
    const p: Patch = { i, j };
    this.patches.set(`${i},${j}`, p);
    this.loading++;
    try {
      const r = await fetch(`/voxels/patch.bin?lat=${o.lat}&lon=${o.lon}&i=${i}&j=${j}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const n = Number(r.headers.get('x-samples'));
      const heights = new Int16Array(await r.arrayBuffer());
      if (heights.length !== n * n) throw new Error(`expected ${n * n} samples`);
      if (gen !== this.generation) return;
      Object.assign(p, { heights, n, cell: Number(r.headers.get('x-cell-m')) });
      await this.mesh(p, gen);
    } catch {
      p.failed = true;
    } finally {
      if (gen === this.generation) this.loading--;
    }
  }

  private mesh(p: Patch, gen: number): Promise<void> {
    const { heights, n, cell } = p;
    if (!heights || !n || !cell) return Promise.resolve();
    const id = ++this.job;
    const worker = this.workers[this.next++ % this.workers.length];
    return new Promise((resolve) => {
      this.pending.set(id, (r) => {
        this.pending.delete(id);
        if (r.type === 'chunk' && gen === this.generation && this.patches.get(`${p.i},${p.j}`) === p) {
          const g = new BufferGeometry();
          g.setAttribute('position', new BufferAttribute(r.positions, 3));
          g.setAttribute('color', new BufferAttribute(r.colors, 3, true));
          g.setAttribute('grid', new BufferAttribute(r.grid, 2));
          g.setIndex(new BufferAttribute(r.indices, 1));
          g.computeBoundingSphere();
          const mesh = new Mesh(g, this.material);
          mesh.position.set(p.i * PATCH_M, 0, p.j * PATCH_M);
          mesh.updateMatrixWorld();
          if (p.mesh) {
            p.mesh.geometry.dispose();
            this.group.remove(p.mesh);
          }
          p.mesh = mesh;
          this.group.add(mesh);
        }
        resolve();
      });
      const req: ChunkRequest = { id, exaggeration: this.exaggeration, heights, n, cell, ranges: [[1, 1, n - 1, n - 1]] };
      worker.postMessage(req);
    });
  }
}
