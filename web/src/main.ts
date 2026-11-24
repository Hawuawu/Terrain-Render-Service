import './style.css';
import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  MeshLambertMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { type AreaInfo, VoxelArea, fetchArea } from './area.ts';
import { GlobeControls, type View } from './controls.ts';
import { ReliefGlobe } from './relief.ts';
import { levelOf } from './shared.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const container = el<HTMLDivElement>('globe');
const exaggeration = el<HTMLInputElement>('exaggeration');
const outlines = el<HTMLInputElement>('outlines');
const back = el<HTMLButtonElement>('back');
const areaTools = el<HTMLDivElement>('area-tools');
const hint = el<HTMLParagraphElement>('hint');
const readout = el<HTMLParagraphElement>('readout');
const status = el<HTMLParagraphElement>('status');
const veil = el<HTMLDivElement>('veil');

const HAZE = 0xb7c4cf;
const METRES_PER_DEGREE = (6_371_008.8 * Math.PI) / 180;
const MAX_AREA_LAT = 84;
const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

const renderer = new WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.autoClear = false;
container.appendChild(renderer.domElement);

// Globe view.
const globeScene = new Scene();
globeScene.background = new Color(0x02040a);
const globeCamera = new PerspectiveCamera(60, 1, 1, 1e8);
const meta = (await (await fetch('/relief/meta.json')).json()) as { max_zoom: number; area_size_m: number };
const globe = new ReliefGlobe(globeScene, meta.max_zoom);

function viewFromHash(): View | null {
  const [lat, lon, alt, tilt, heading] = location.hash.slice(1).split(',').map(Number);
  const ok = (v: number) => Number.isFinite(v);
  return ok(lat) && ok(lon) && ok(alt) ? { lat, lon, alt, tilt: ok(tilt) ? tilt : 0, heading: ok(heading) ? heading : 0 } : null;
}
const controls = new GlobeControls(renderer.domElement, viewFromHash() ?? { lat: 30, lon: 10, alt: 18_000_000, tilt: 0, heading: 0 });

// Voxel view: Lambert shading with VXLEngine-style block outlines (`grid` holds column/level coordinates, so
// lines fall where their fractional part crosses zero) and a radial fade into the fog towards the area's edge.
const areaScene = new Scene();
areaScene.background = new Color(HAZE);
areaScene.fog = new Fog(HAZE, meta.area_size_m * 0.35, meta.area_size_m * 1.1);
const areaCamera = new PerspectiveCamera(55, 1, 5, meta.area_size_m * 3);
const sun = new DirectionalLight(0xffffff, 2.0);
sun.position.set(-0.6, 1, -0.4);
areaScene.add(sun, new AmbientLight(0xffffff, 1.1));
const outline = { value: 1 };
const fade = { value: [meta.area_size_m * 0.3, meta.area_size_m * 0.5] };
const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
material.onBeforeCompile = (shader) => {
  shader.uniforms.outline = outline;
  shader.uniforms.fade = { value: new Vector2(...fade.value) };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 grid;\nvarying vec2 vGrid;\nvarying vec2 vGround;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrid = grid;\nvGround = position.xz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float outline;\nuniform vec2 fade;\nvarying vec2 vGrid;\nvarying vec2 vGround;')
    .replace(
      '#include <opaque_fragment>',
      `#include <opaque_fragment>
      vec2 fw = max(fwidth(vGrid), vec2(1e-4));
      vec2 d = abs(fract(vGrid - 0.5) - 0.5) / fw;
      float line = (1.0 - min(min(d.x, d.y), 1.0)) * (1.0 - smoothstep(0.15, 0.45, max(fw.x, fw.y)));
      gl_FragColor.rgb *= 1.0 - 0.4 * outline * line;`,
    )
    .replace(
      '#include <fog_fragment>',
      `#include <fog_fragment>
      float edge = smoothstep(fade.x, fade.y, length(vGround));
      if (edge > 0.995) discard;
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, edge);`,
    );
};
const voxels = new VoxelArea(material);
areaScene.add(voxels.group);
const orbit = new OrbitControls(areaCamera, renderer.domElement);
orbit.enabled = false;
orbit.enableDamping = true;
orbit.minDistance = 150;
orbit.maxDistance = meta.area_size_m * 0.9;
orbit.maxPolarAngle = 1.45;
orbit.addEventListener('change', () => {
  const lim = meta.area_size_m * 0.4;
  orbit.target.x = Math.max(-lim, Math.min(lim, orbit.target.x));
  orbit.target.z = Math.max(-lim, Math.min(lim, orbit.target.z));
});

let mode: 'globe' | 'area' = 'globe';
let flight: { from: View; to: View; start: number } | null = null;
let opening = 0;
let loadingArea = false;

function resize(): void {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h);
  for (const c of [globeCamera, areaCamera]) {
    c.aspect = w / h;
    c.updateProjectionMatrix();
  }
}
window.addEventListener('resize', resize);
resize();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function veiled(change: () => void): Promise<void> {
  veil.classList.add('on');
  await sleep(450);
  change();
  veil.classList.remove('on');
}

const fmt = (lat: number, lon: number) => `${lat.toFixed(4)}°, ${wrapLon(lon).toFixed(4)}°`;

async function openArea(lat: number, lon: number): Promise<void> {
  if (Math.abs(lat) > MAX_AREA_LAT) {
    readout.textContent = `${fmt(lat, lon)}: the voxel view covers latitudes up to ±${MAX_AREA_LAT}°.`;
    return;
  }
  const job = ++opening;
  loadingArea = true;
  const v = controls.view;
  const start = performance.now();
  flight = { from: { ...v }, to: { lat, lon, alt: Math.min(v.alt, 60_000), tilt: 0, heading: 0 }, start };
  status.textContent = `Loading 20 × 20 km around ${fmt(lat, lon)} …`;
  let area: AreaInfo;
  try {
    area = await fetchArea(lat, lon);
    await voxels.build(area, Number(exaggeration.value));
    await sleep(Math.max(0, 1300 - (performance.now() - start)));
  } catch (err) {
    if (job === opening) {
      loadingArea = false;
      status.textContent = `Could not load the area: ${String(err)}`;
    }
    return;
  }
  if (job !== opening) return;
  await veiled(() => {
    if (job !== opening) return;
    loadingArea = false;
    mode = 'area';
    controls.enabled = false;
    orbit.enabled = true;
    const centre = voxels.heightAt(0, 0) ?? 0;
    const y = levelOf(centre, Number(exaggeration.value), area.cell) * area.cell;
    orbit.target.set(0, y, 0);
    areaCamera.position.set(0, y + 5500, 7500);
    orbit.update();
    areaTools.hidden = false;
    hint.textContent = 'Drag to orbit · right-drag to pan · wheel to zoom · click a voxel for its height';
    readout.textContent = `Centre ${fmt(area.lat, area.lon)}: ${Math.round(centre)} m`;
    history.replaceState(null, '', `#area=${area.lat},${area.lon}`);
  });
}

function closeArea(): void {
  const a = voxels.area;
  opening++;
  loadingArea = false;
  void veiled(() => {
    mode = 'globe';
    orbit.enabled = false;
    controls.enabled = true;
    if (a) controls.view = { lat: a.lat, lon: a.lon, alt: 120_000, tilt: 0, heading: 0 };
    controls.changed = true;
    areaTools.hidden = true;
    hint.textContent = globeHint;
    readout.textContent = 'Click a place to open a 20 × 20 km voxel view.';
    voxels.clear();
    const v = controls.view;
    history.replaceState(null, '', `#${v.lat.toFixed(5)},${v.lon.toFixed(5)},${Math.round(v.alt)},0,0`);
  });
}
const globeHint = hint.textContent ?? '';

back.addEventListener('click', closeArea);
window.addEventListener('keydown', (e) => e.key === 'Escape' && mode === 'area' && closeArea());
exaggeration.addEventListener('change', () => {
  if (mode === 'area' && voxels.area) void voxels.build(voxels.area, Number(exaggeration.value));
});
outlines.addEventListener('change', () => (outline.value = outlines.checked ? 1 : 0));
window.addEventListener('hashchange', () => {
  const v = viewFromHash();
  if (v && mode === 'globe') {
    controls.view = v;
    controls.changed = true;
  }
});

const raycaster = new Raycaster();
let down: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  if (mode === 'globe') {
    raycaster.setFromCamera(ndc, globeCamera);
    const hit = globe.pick(raycaster.ray);
    if (hit) void openArea(hit.lat, hit.lon);
    return;
  }
  raycaster.setFromCamera(ndc, areaCamera);
  const hit = raycaster.intersectObjects(voxels.group.children, false)[0];
  const a = voxels.area;
  const h = hit && voxels.heightAt(hit.point.x, hit.point.z);
  if (!a || h == null) return;
  const lat = a.lat - hit.point.z / METRES_PER_DEGREE;
  const lon = a.lon + hit.point.x / METRES_PER_DEGREE / Math.cos((a.lat * Math.PI) / 180);
  readout.textContent = `${fmt(lat, lon)}: ${Math.round(h)} m`;
});

function fly(now: number): void {
  if (!flight) return;
  const t = Math.min(1, (now - flight.start) / 1300);
  const s = t * t * (3 - 2 * t);
  const { from, to } = flight;
  const dLon = ((((to.lon - from.lon) % 360) + 540) % 360) - 180;
  controls.view = {
    lat: from.lat + (to.lat - from.lat) * s,
    lon: from.lon + dLon * s,
    alt: from.alt * (to.alt / from.alt) ** s,
    tilt: from.tilt + (to.tilt - from.tilt) * s,
    heading: from.heading * (1 - s),
  };
  controls.changed = true;
  if (t >= 1) flight = null;
}

const areaHash = /^#area=(-?[\d.]+),(-?[\d.]+)$/.exec(location.hash);
if (areaHash) void openArea(Number(areaHash[1]), Number(areaHash[2]));

let lastHash = 0;
let lastStatus = 0;
function frame(now: number): void {
  if (mode === 'globe') {
    fly(now);
    controls.apply(globeCamera);
    const v = controls.view;
    globeCamera.near = Math.max(1, v.alt * 0.001);
    globeCamera.updateProjectionMatrix();
    globe.update(v, container.clientHeight);
    globe.render(renderer, globeCamera);
    if (controls.changed && !flight && now - lastHash > 500 && !loadingArea) {
      controls.changed = false;
      lastHash = now;
      const hash = [v.lat.toFixed(5), v.lon.toFixed(5), Math.round(v.alt), Math.round(v.tilt), Math.round(v.heading)];
      history.replaceState(null, '', `#${hash.join(',')}`);
    }
    if (now - lastStatus > 250 && !flight) {
      lastStatus = now;
      const s = globe.stats;
      const alt = v.alt >= 10_000 ? `${(v.alt / 1000).toFixed(0)} km` : `${Math.round(v.alt)} m`;
      status.textContent = `alt ${alt} · zoom ${s.zoom} · ${s.shown} tiles shown, ${s.loading} loading`;
    }
  } else {
    orbit.update();
    renderer.clear();
    renderer.render(areaScene, areaCamera);
    if (now - lastStatus > 250 && voxels.area) {
      lastStatus = now;
      const a = voxels.area;
      status.textContent = `${((a.n * a.cell) / 1000).toFixed(0)} × ${((a.n * a.cell) / 1000).toFixed(0)} km · ${a.cell.toFixed(0)} m voxels · ${voxels.group.children.length} chunks`;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
