// Smooth relief globe: Web Mercator relief tiles (elevation tint + hillshade, rendered and cached by the
// service) draped on sphere patches. Coarser levels are drawn first and finer ones over them, so a
// region keeps its parent imagery until the sharper tile arrives.
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  type Ray,
  SRGBColorSpace,
  SphereGeometry,
  type Texture,
  TextureLoader,
  type WebGLRenderer,
  type Scene,
} from 'three';
import type { View } from './controls.ts';
import { EARTH_RADIUS, geoToXyz, mercatorLat, mercatorTile, xyzToGeo } from './shared.ts';

const BASE_ZOOM = 2;
const FALLBACK_LEVELS = 3;
const MAX_TILES_PER_LEVEL = 96;
const MAX_LOADING = 8;
const MAX_CACHED = 400;
const DEG = Math.PI / 180;

interface Tile {
  z: number;
  mesh: Mesh;
  ready: boolean;
  used: number;
}

function patch(z: number, x: number, y: number): { geometry: BufferGeometry; centre: [number, number, number] } {
  // About 1 degree per segment, so a patch sags at most ~100 m below the sphere.
  const seg = Math.max(8, Math.min(96, Math.ceil(360 / 2 ** z)));
  const n = 2 ** z;
  const lonAt = (u: number) => ((x + u) / n) * 360 - 180;
  const centre = geoToXyz(lonAt(0.5), mercatorLat(z, y + 0.5), EARTH_RADIUS);
  const pos = new Float32Array((seg + 1) ** 2 * 3);
  const uv = new Float32Array((seg + 1) ** 2 * 2);
  for (let r = 0; r <= seg; r++) {
    const lat = mercatorLat(z, y + r / seg);
    for (let c = 0; c <= seg; c++) {
      const p = geoToXyz(lonAt(c / seg), lat, EARTH_RADIUS);
      const k = r * (seg + 1) + c;
      pos.set([p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]], 3 * k);
      uv.set([c / seg, 1 - r / seg], 2 * k);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < seg; r++) {
    for (let c = 0; c < seg; c++) {
      const a = r * (seg + 1) + c;
      const b = a + seg + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return { geometry, centre };
}

/** Tile keys at zoom `z` covering the ground visible from `view`, or null if there would be too many. */
function cover(view: View, z: number): [number, number][] | null {
  const n = 2 ** z;
  if (z <= BASE_ZOOM) return Array.from({ length: n * n }, (_, k) => [k % n, Math.floor(k / n)]);
  const horizon = Math.acos(EARTH_RADIUS / (EARTH_RADIUS + view.alt));
  const radius = Math.min(horizon, (view.alt / EARTH_RADIUS) * (1.3 + 3 * Math.sin(view.tilt * DEG))) / DEG;
  const north = Math.min(85.05, view.lat + radius);
  const south = Math.max(-85.05, view.lat - radius);
  const widest = Math.cos(Math.min(Math.max(Math.abs(north), Math.abs(south)), 85) * DEG);
  const half = Math.min(180, radius / widest);
  const ys = [mercatorTile(z, 0, north).y, mercatorTile(z, 0, south).y].map(Math.floor);
  const x0 = Math.floor(mercatorTile(z, view.lon - half, 0).x);
  const x1 = half >= 180 ? x0 + n - 1 : Math.floor(mercatorTile(z, view.lon + half, 0).x);
  const count = (x1 - x0 + 1) * (ys[1] - ys[0] + 1);
  if (count > MAX_TILES_PER_LEVEL) return null;
  const out: [number, number][] = [];
  for (let y = Math.max(0, ys[0]); y <= Math.min(n - 1, ys[1]); y++) {
    for (let x = x0; x <= x1; x++) out.push([((x % n) + n) % n, y]);
  }
  return out;
}

export class ReliefGlobe {
  readonly scene: Scene;
  readonly group = new Group();
  stats = { zoom: 0, shown: 0, loading: 0 };
  private readonly tiles = new Map<string, Tile>();
  private readonly loader = new TextureLoader();
  private readonly maxZoom: number;
  private frame = 0;
  private levels: { z: number; keys: string[] }[] = [];

  constructor(scene: Scene, maxZoom: number) {
    this.scene = scene;
    this.maxZoom = maxZoom;
    const polar = new Mesh(new SphereGeometry(EARTH_RADIUS * 0.99, 64, 32), new MeshBasicMaterial({ color: 0x1d2b40 }));
    polar.rotation.x = Math.PI / 2;
    this.group.add(polar);
    scene.add(this.group);
  }

  /** Zoom whose texels are about one screen pixel at the view centre. */
  targetZoom(view: View, screenHeight: number): number {
    const metresPerPixel = (view.alt * 2 * Math.tan(30 * DEG)) / screenHeight;
    const texel = (2 * Math.PI * EARTH_RADIUS * Math.cos(view.lat * DEG)) / 256;
    return Math.max(BASE_ZOOM, Math.min(this.maxZoom, Math.round(Math.log2(texel / metresPerPixel))));
  }

  update(view: View, screenHeight: number): void {
    this.frame++;
    let zoom = this.targetZoom(view, screenHeight);
    let keys = cover(view, zoom);
    while (!keys && zoom > BASE_ZOOM) keys = cover(view, --zoom);
    this.levels = [{ z: BASE_ZOOM, keys: this.request(BASE_ZOOM, cover(view, BASE_ZOOM) ?? []) }];
    // Also fetch two levels up, so a fast zoom always has coarser imagery to show while the target loads.
    const fallback = zoom - 2;
    for (let z = Math.max(BASE_ZOOM + 1, zoom - FALLBACK_LEVELS); z < zoom; z++) {
      const tiles = cover(view, z) ?? [];
      this.levels.push({ z, keys: z === fallback ? this.request(z, tiles) : tiles.map(([x, y]) => `${z}/${x}/${y}`) });
    }
    if (zoom > BASE_ZOOM) this.levels.push({ z: zoom, keys: this.request(zoom, keys ?? []) });
    for (const level of this.levels) for (const k of level.keys) {
      const t = this.tiles.get(k);
      if (t) t.used = this.frame;
    }
    this.evict();
    let loading = 0;
    for (const t of this.tiles.values()) if (!t.ready) loading++;
    this.stats = { zoom, shown: this.levels.reduce((s, l) => s + l.keys.filter((k) => this.tiles.get(k)?.ready).length, 0), loading };
  }

  /** Draw coarse levels first; each finer level is drawn over them after clearing depth. */
  render(renderer: WebGLRenderer, camera: PerspectiveCamera): void {
    const all = [...this.tiles.values()];
    renderer.clear();
    this.group.children[0].visible = true;
    for (const level of this.levels) {
      for (const t of all) t.mesh.visible = false;
      for (const k of level.keys) {
        const t = this.tiles.get(k);
        if (t?.ready) t.mesh.visible = true;
      }
      renderer.render(this.scene, camera);
      renderer.clearDepth();
      this.group.children[0].visible = false;
    }
  }

  /** Geographic point where `ray` meets the sphere, if it does. */
  pick(ray: Ray): { lat: number; lon: number } | null {
    const o = ray.origin;
    const d = ray.direction;
    const b = o.dot(d);
    const c = o.lengthSq() - EARTH_RADIUS ** 2;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    const p = o.clone().addScaledVector(d, t);
    return xyzToGeo(p.x, p.y, p.z);
  }

  private request(z: number, keys: [number, number][]): string[] {
    let loading = 0;
    for (const t of this.tiles.values()) if (!t.ready) loading++;
    return keys.map(([x, y]) => {
      const key = `${z}/${x}/${y}`;
      if (!this.tiles.has(key) && loading < MAX_LOADING) {
        loading++;
        const { geometry, centre } = patch(z, x, y);
        const material = new MeshBasicMaterial();
        const mesh = new Mesh(geometry, material);
        mesh.position.set(...centre);
        mesh.visible = false;
        const tile: Tile = { z, mesh, ready: false, used: this.frame };
        this.tiles.set(key, tile);
        this.group.add(mesh);
        this.loader.load(
          `/relief/${key}.png`,
          (tex: Texture) => {
            tex.colorSpace = SRGBColorSpace;
            tex.anisotropy = 4;
            material.map = tex;
            material.needsUpdate = true;
            tile.ready = true;
          },
          undefined,
          () => this.drop(key),
        );
      }
      return key;
    });
  }

  private drop(key: string): void {
    const t = this.tiles.get(key);
    if (!t) return;
    this.tiles.delete(key);
    this.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    const m = t.mesh.material as MeshBasicMaterial;
    m.map?.dispose();
    m.dispose();
  }

  private evict(): void {
    if (this.tiles.size <= MAX_CACHED) return;
    const stale = [...this.tiles.entries()]
      .filter(([, t]) => t.ready && t.used < this.frame && t.z > BASE_ZOOM)
      .sort((a, b) => a[1].used - b[1].used);
    for (const [key] of stale.slice(0, this.tiles.size - MAX_CACHED)) this.drop(key);
  }
}
