import './style.css';
import {
  AmbientLight,
  Color,
  DirectionalLight,
  MeshLambertMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
} from 'three';
import { GlobeControls, type View } from './controls.ts';
import { xyzToGeo } from './shared.ts';
import { VoxelGlobe } from './tiles.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const container = el<HTMLDivElement>('globe');
const exaggeration = el<HTMLInputElement>('exaggeration');
const outlines = el<HTMLInputElement>('outlines');
const readout = el<HTMLParagraphElement>('readout');
const status = el<HTMLParagraphElement>('status');

const renderer = new WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x02040a);
const camera = new PerspectiveCamera(60, 1, 1, 1e8);
const sun = new DirectionalLight(0xffffff, 2.2);
scene.add(sun, sun.target, new AmbientLight(0xffffff, 0.9));

// Lambert shading with VXLEngine-style block outlines: `grid` holds column/level coordinates,
// so lines fall where their fractional part crosses zero and fade once blocks shrink below a pixel.
const outline = { value: 1 };
const material = new MeshLambertMaterial({ vertexColors: true });
material.onBeforeCompile = (shader) => {
  shader.uniforms.outline = outline;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 grid;\nvarying vec2 vGrid;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrid = grid;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float outline;\nvarying vec2 vGrid;')
    .replace(
      '#include <opaque_fragment>',
      `#include <opaque_fragment>
      vec2 fw = max(fwidth(vGrid), vec2(1e-4));
      vec2 d = abs(fract(vGrid - 0.5) - 0.5) / fw;
      float line = (1.0 - min(min(d.x, d.y), 1.0)) * (1.0 - smoothstep(0.15, 0.45, max(fw.x, fw.y)));
      gl_FragColor.rgb *= 1.0 - 0.45 * outline * line;`,
    );
};

function viewFromHash(): View {
  const [lat, lon, alt, tilt, heading] = location.hash.slice(1).split(',').map(Number);
  const ok = (v: number) => Number.isFinite(v);
  return ok(lat) && ok(lon) && ok(alt)
    ? { lat, lon, alt, tilt: ok(tilt) ? tilt : 0, heading: ok(heading) ? heading : 0 }
    : { lat: 30, lon: 10, alt: 18_000_000, tilt: 0, heading: 0 };
}

const controls = new GlobeControls(renderer.domElement, viewFromHash());
const meta = (await (await fetch('/voxels/meta.json')).json()) as { max_zoom: number };
const globe = new VoxelGlobe(scene, material, Number(exaggeration.value), meta.max_zoom);

exaggeration.addEventListener('change', () => globe.setExaggeration(Number(exaggeration.value)));
outlines.addEventListener('change', () => (outline.value = outlines.checked ? 1 : 0));
window.addEventListener('hashchange', () => {
  controls.view = viewFromHash();
  controls.changed = true;
});

function resize(): void {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const raycaster = new Raycaster();
let down: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(globe.meshes(), false)[0];
  if (hit) void pick(hit.point.x, hit.point.y, hit.point.z);
});

async function pick(x: number, y: number, z: number): Promise<void> {
  const { lat, lon } = xyzToGeo(x, y, z);
  readout.textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}° …`;
  const r = await fetch(`/api/elevation?lat=${lat}&lon=${lon}`);
  if (!r.ok) {
    readout.textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°: elevation unavailable (HTTP ${r.status})`;
    return;
  }
  const body = (await r.json()) as { elevation_m: number };
  readout.textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°: ${Math.round(body.elevation_m)} m`;
}

// The ground comes from the DEM, not from the shown meshes: those change with LOD, which depends on the
// camera height, which would feed back into the ground and make the LOD oscillate.
let groundMetres = 0;
let groundKey = '';
let groundTimer = 0;
function updateGround(v: View): void {
  const key = `${v.lat.toFixed(5)},${v.lon.toFixed(5)}`;
  if (key === groundKey) return;
  groundKey = key;
  clearTimeout(groundTimer);
  groundTimer = window.setTimeout(async () => {
    const r = await fetch(`/api/elevation?lat=${v.lat.toFixed(5)}&lon=${v.lon.toFixed(5)}`).catch(() => null);
    if (!r?.ok || key !== groundKey) return;
    groundMetres = Math.max(0, ((await r.json()) as { elevation_m: number }).elevation_m);
  }, 300);
}

let lastHash = 0;
let lastStatus = 0;
function frame(now: number): void {
  updateGround(controls.view);
  controls.ground = groundMetres * globe.exaggeration;
  controls.apply(camera);
  const v = controls.view;
  camera.near = Math.max(0.5, v.alt * 0.001);
  camera.updateProjectionMatrix();
  sun.position.copy(camera.position).addScaledVector(camera.up, v.alt * 0.8);
  sun.target.position.set(0, 0, 0);
  globe.update(camera, container.clientHeight);
  renderer.render(scene, camera);
  if (controls.changed && now - lastHash > 500) {
    controls.changed = false;
    lastHash = now;
    const hash = [v.lat.toFixed(5), v.lon.toFixed(5), Math.round(v.alt), Math.round(v.tilt), Math.round(v.heading)];
    history.replaceState(null, '', `#${hash.join(',')}`);
  }
  if (now - lastStatus > 250) {
    lastStatus = now;
    const s = globe.stats;
    const alt = v.alt >= 10_000 ? `${(v.alt / 1000).toFixed(0)} km` : `${Math.round(v.alt)} m`;
    status.textContent = `alt ${alt} · zoom ${s.deepest} · ${s.shown} tiles shown, ${s.loading} loading`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
