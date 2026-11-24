import {
  BufferAttribute,
  BufferGeometry,
  Frustum,
  Material,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
} from 'three';
import {
  EARTH_RADIUS,
  MAX_RELIEF,
  type MeshRequest,
  type WorkerReply,
  geoToXyz,
  tileBounds,
  voxelSize,
} from './shared.ts';

const MAX_IN_FLIGHT = 8;
const MAX_READY = 700;
const RETRY_MS = 5000;

interface Tile {
  z: number;
  x: number;
  y: number;
  center: Vector3;
  dir: Vector3;
  radius: number;
  angle: number;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  mesh?: Mesh;
  used: number;
  retryAt: number;
  children?: Tile[];
}

export interface TileStats {
  ready: number;
  loading: number;
  shown: number;
  deepest: number;
}

/** Quadtree LOD over the geographic pyramid: refine while a voxel covers more than `pixelsPerVoxel`. */
export class VoxelGlobe {
  readonly roots: Tile[];
  private readonly workers: Worker[];
  private readonly pending = new Map<number, Tile>();
  private readonly ready = new Set<Tile>();
  private shown: Tile[] = [];
  private wanted: Tile[] = [];
  private nextId = 1;
  private frame = 0;
  private generation = 0;
  private readonly frustum = new Frustum();
  private readonly sphere = new Sphere();
  exaggeration: number;
  stats: TileStats = { ready: 0, loading: 0, shown: 0, deepest: 0 };

  constructor(
    private readonly scene: Scene,
    private readonly material: Material,
    exaggeration: number,
    private readonly maxZoom = 14,
    private readonly pixelsPerVoxel = 5,
  ) {
    this.exaggeration = exaggeration;
    this.roots = [this.tile(0, 0, 0), this.tile(0, 1, 0)];
    const count = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    this.workers = Array.from({ length: count }, () => {
      const w = new Worker(new URL('./voxel.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerReply>) => this.receive(e.data);
      return w;
    });
  }

  meshes(): Mesh[] {
    return this.shown.flatMap((t) => (t.mesh ? [t.mesh] : []));
  }

  setExaggeration(value: number): void {
    this.exaggeration = value;
    this.generation++;
    for (const t of this.ready) this.dispose(t);
    for (const t of this.pending.values()) t.state = 'idle';
    this.pending.clear();
  }

  update(camera: PerspectiveCamera, viewportHeight: number): void {
    this.frame++;
    for (const t of this.shown) if (t.mesh) t.mesh.visible = false;
    this.shown = [];
    this.wanted = [];
    this.frustum.setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const pxScale = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    for (const root of this.roots) this.select(root, camera.position, pxScale);
    for (const t of this.shown) t.mesh!.visible = true;
    this.schedule(camera.position);
    this.evict();
    this.stats = {
      ready: this.ready.size,
      loading: this.pending.size,
      shown: this.shown.length,
      deepest: this.shown.reduce((m, t) => Math.max(m, t.z), 0),
    };
  }

  private tile(z: number, x: number, y: number): Tile {
    const b = tileBounds(z, x, y);
    const center = new Vector3(...geoToXyz((b.west + b.east) / 2, (b.south + b.north) / 2, EARTH_RADIUS));
    let radius = 0;
    for (const lon of [b.west, (b.west + b.east) / 2, b.east])
      for (const lat of [b.south, (b.south + b.north) / 2, b.north])
        radius = Math.max(radius, center.distanceTo(new Vector3(...geoToXyz(lon, lat, EARTH_RADIUS))));
    const angle = 2 * Math.asin(Math.min(1, radius / (2 * EARTH_RADIUS)));
    return { z, x, y, center, dir: center.clone().normalize(), radius, angle, state: 'idle', used: 0, retryAt: 0 };
  }

  private children(t: Tile): Tile[] {
    t.children ??= [0, 1].flatMap((dy) => [0, 1].map((dx) => this.tile(t.z + 1, 2 * t.x + dx, 2 * t.y + dy)));
    return t.children;
  }

  private visible(t: Tile, eye: Vector3): boolean {
    const relief = MAX_RELIEF * this.exaggeration + voxelSize(t.z);
    this.sphere.set(t.center, t.radius + relief);
    if (!this.frustum.intersectsSphere(this.sphere)) return false;
    const d = eye.length();
    const horizon = Math.acos(Math.min(1, EARTH_RADIUS / d)) + Math.acos(EARTH_RADIUS / (EARTH_RADIUS + relief));
    const off = Math.acos(Math.max(-1, Math.min(1, eye.dot(t.dir) / d)));
    return off - t.angle <= horizon;
  }

  private refine(t: Tile, eye: Vector3, pxScale: number): boolean {
    if (t.z >= this.maxZoom) return false;
    const dist = Math.max(eye.distanceTo(t.center) - t.radius, 1);
    return (voxelSize(t.z) * pxScale) / dist > this.pixelsPerVoxel;
  }

  private select(t: Tile, eye: Vector3, pxScale: number): void {
    if (!this.visible(t, eye)) return;
    t.used = this.frame;
    if (this.refine(t, eye, pxScale)) {
      const kids = this.children(t).filter((k) => this.visible(k, eye));
      for (const k of kids) {
        k.used = this.frame;
        if (k.state !== 'ready') this.want(k);
      }
      if (kids.every((k) => k.state === 'ready')) {
        for (const k of kids) this.select(k, eye, pxScale);
        return;
      }
    }
    if (t.state === 'ready') this.shown.push(t);
    else this.want(t);
  }

  private want(t: Tile): void {
    if (t.state === 'idle' || (t.state === 'failed' && performance.now() > t.retryAt)) this.wanted.push(t);
  }

  private schedule(eye: Vector3): void {
    this.wanted.sort((a, b) => a.z - b.z || eye.distanceToSquared(a.center) - eye.distanceToSquared(b.center));
    for (const t of this.wanted) {
      if (this.pending.size >= MAX_IN_FLIGHT) break;
      const req: MeshRequest = { id: this.nextId++, z: t.z, x: t.x, y: t.y, exaggeration: this.exaggeration };
      t.state = 'loading';
      this.pending.set(req.id, t);
      this.workers[req.id % this.workers.length].postMessage(req);
    }
  }

  private receive(reply: WorkerReply): void {
    const t = this.pending.get(reply.id);
    if (!t) return;
    this.pending.delete(reply.id);
    if (reply.type === 'error') {
      console.warn(`voxel tile ${t.z}/${t.x}/${t.y}: ${reply.message}`);
      t.state = 'failed';
      t.retryAt = performance.now() + RETRY_MS;
      return;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(reply.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(reply.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(reply.colors, 3, true));
    geometry.setAttribute('grid', new BufferAttribute(reply.grid, 2));
    geometry.setIndex(new BufferAttribute(reply.indices, 1));
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, this.material);
    mesh.position.set(...reply.center);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.userData.tile = `${t.z}/${t.x}/${t.y}`;
    this.scene.add(mesh);
    t.mesh = mesh;
    t.state = 'ready';
    this.ready.add(t);
  }

  private dispose(t: Tile): void {
    if (t.mesh) {
      this.scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh = undefined;
    }
    t.state = 'idle';
    this.ready.delete(t);
  }

  private evict(): void {
    if (this.ready.size <= MAX_READY) return;
    const stale = [...this.ready].filter((t) => t.used < this.frame && t.z > 0).sort((a, b) => a.used - b.used);
    for (const t of stale.slice(0, this.ready.size - MAX_READY)) this.dispose(t);
  }
}
