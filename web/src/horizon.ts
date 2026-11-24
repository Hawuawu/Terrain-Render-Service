// The far field: one coarse smooth terrain sheet, 400 km across around the viewer, that fills the view from
// the edge of the voxels out to the horizon. Like the voxels it is bent down with the Earth's curve in the shader.
import { BufferAttribute, Mesh, type Material, PlaneGeometry, type Vector3 } from 'three';
import { hypsometric } from './palette.ts';
import type { Origin } from './patches.ts';
import { lowest } from './shared.ts';

export const FAR_STEP_M = 50_000;

interface Field {
  i: number;
  j: number;
  heights: Int16Array;
  n: number;
  cell: number;
}

/** Samples (about 1.6 km each) around a vertex whose lowest height it takes under the voxels. */
const LOW_RADIUS = 2;

export class Horizon {
  mesh: Mesh | null = null;
  private field: Field | null = null;
  private loading = '';
  private generation = 0;

  constructor(
    private readonly material: Material,
    private readonly add: (m: Mesh) => void,
    private readonly remove: (m: Mesh) => void,
  ) {}

  /** Load the far field centred nearest to `at` when the viewer has moved into another 50 km cell. */
  update(origin: Origin, at: Vector3, exaggeration: number, sink: number): void {
    const i = Math.round(at.x / FAR_STEP_M);
    const j = Math.round(at.z / FAR_STEP_M);
    const key = `${origin.lat},${origin.lon},${i},${j}`;
    if (this.loading || (this.field?.i === i && this.field.j === j)) return;
    this.loading = key;
    const gen = this.generation;
    void fetch(`/voxels/far.bin?lat=${origin.lat}&lon=${origin.lon}&i=${i}&j=${j}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const n = Number(r.headers.get('x-samples'));
        const heights = new Int16Array(await r.arrayBuffer());
        if (gen !== this.generation || heights.length !== n * n) return;
        this.field = { i, j, heights, n, cell: Number(r.headers.get('x-cell-m')) };
        this.build(exaggeration, sink);
      })
      .catch(() => {
        // The far field is decoration: leave the old one (or none) and try again on the next cell.
        if (gen === this.generation) this.field = { i, j, heights: new Int16Array(0), n: 0, cell: 0 };
      })
      .finally(() => {
        if (gen === this.generation) this.loading = '';
      });
  }

  /** (Re)build the sheet at `exaggeration`, lowered by `sink` metres so voxels win where both overlap. */
  build(exaggeration: number, sink: number): void {
    const f = this.field;
    if (!f?.n) return;
    const size = (f.n - 1) * f.cell;
    const g = new PlaneGeometry(size, size, f.n - 1, f.n - 1);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute('position');
    const colors = new Uint8Array(f.n * f.n * 3);
    for (let k = 0; k < f.n * f.n; k++) {
      const h = f.heights[k];
      pos.setY(k, Math.max(h, 0) * exaggeration - sink);
      colors.set(hypsometric(h), k * 3);
    }
    g.setAttribute('color', new BufferAttribute(colors, 3, true));
    g.setAttribute('low', new BufferAttribute(lowest(pos.array as Float32Array, f.n, LOW_RADIUS), 1));
    g.computeVertexNormals();
    const mesh = new Mesh(g, this.material);
    mesh.position.set(f.i * FAR_STEP_M, 0, f.j * FAR_STEP_M);
    mesh.renderOrder = -1;
    this.clearMesh();
    this.mesh = mesh;
    this.add(mesh);
  }

  clear(): void {
    this.generation++;
    this.loading = '';
    this.field = null;
    this.clearMesh();
  }

  private clearMesh(): void {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.remove(this.mesh);
    this.mesh = null;
  }
}
