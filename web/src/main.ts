import './style.css';
import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector3,
  Vector2,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GlobeControls, type View } from './controls.ts';
import { Horizon } from './horizon.ts';
import { LOAD_M, type Origin, PatchField } from './patches.ts';
import { ReliefGlobe } from './relief.ts';
import { EARTH_RADIUS, geoToXyz, levelOf } from './shared.ts';

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
const minimap = el<HTMLDivElement>('minimap');

const HAZE = 0xb7c4cf;
const METRES_PER_DEGREE = (6_371_008.8 * Math.PI) / 180;
const MAX_AREA_LAT = 84;
const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
const snap = (v: number) => Math.round(v * 100) / 100;
/** The scene origin the service snaps (lat, lon) to: a 0.01° grid, so nearby visits share cached patches. */
const originAround = (lat: number, lon: number): Origin => ({
  lat: Math.max(-MAX_AREA_LAT, Math.min(MAX_AREA_LAT, snap(lat))),
  lon: snap(wrapLon(lon)) === 180 ? -180 : snap(wrapLon(lon)),
});
const toLocal = (o: Origin, lat: number, lon: number) =>
  new Vector3(wrapLon(lon - o.lon) * METRES_PER_DEGREE * Math.cos((o.lat * Math.PI) / 180), 0, -(lat - o.lat) * METRES_PER_DEGREE);
const toGeo = (o: Origin, p: Vector3) => ({
  lat: o.lat - p.z / METRES_PER_DEGREE,
  lon: wrapLon(o.lon + p.x / METRES_PER_DEGREE / Math.cos((o.lat * Math.PI) / 180)),
});
/** Re-centre the scene's flat frame once the viewer walks this far from its origin. */
const REORIGIN_M = 100_000;

const renderer = new WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.autoClear = false;
container.appendChild(renderer.domElement);

// Globe view.
const globeScene = new Scene();
// No scene.background: three.js would clear the colour buffer on every pass of the layered relief render.
renderer.setClearColor(0x02040a);
const globeCamera = new PerspectiveCamera(60, 1, 1, 1e8);
const meta = (await (await fetch('/relief/meta.json')).json()) as { max_zoom: number };
const globe = new ReliefGlobe(globeScene, meta.max_zoom);

function areaFromHash(): { lat: number; lon: number } | null {
  const m = /^#area=(-?[\d.]+),(-?[\d.]+)$/.exec(location.hash);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}
function viewFromHash(): View | null {
  const [lat, lon, alt, tilt, heading] = location.hash.slice(1).split(',').map(Number);
  const ok = (v: number) => Number.isFinite(v);
  return ok(lat) && ok(lon) && ok(alt) ? { lat, lon, alt, tilt: ok(tilt) ? tilt : 0, heading: ok(heading) ? heading : 0 } : null;
}
const controls = new GlobeControls(renderer.domElement, viewFromHash() ?? { lat: 30, lon: 10, alt: 18_000_000, tilt: 0, heading: 0 });

// Overview inset: the base relief level seen from far away, centred on the current place, with a marker on it.
const MINI_PX = 160;
const MINI_MARGIN = 12;
const MINI_SHOW_BELOW_ALT = 3_000_000;
const miniCamera = new PerspectiveCamera(30, 1, EARTH_RADIUS, EARTH_RADIUS * 10);
const miniScene = new Scene();
const marker = new Mesh(
  new SphereGeometry(EARTH_RADIUS * 0.035, 16, 8),
  new MeshBasicMaterial({ color: 0xff3b30, depthTest: false }),
);
miniScene.add(marker);

function renderMinimap(lat: number, lon: number): void {
  const w = container.clientWidth;
  const h = container.clientHeight;
  const x = w - MINI_PX - MINI_MARGIN;
  const y = h - MINI_PX - MINI_MARGIN;
  miniCamera.position.set(...geoToXyz(lon, lat, EARTH_RADIUS * 4.2));
  miniCamera.up.set(0, 0, 1);
  miniCamera.lookAt(0, 0, 0);
  miniCamera.updateMatrixWorld();
  marker.position.set(...geoToXyz(lon, lat, EARTH_RADIUS));
  renderer.setScissorTest(true);
  renderer.setScissor(x, y, MINI_PX, MINI_PX);
  renderer.setViewport(x, y, MINI_PX, MINI_PX);
  renderer.clear();
  globe.renderOverview(renderer, miniCamera);
  renderer.clearDepth();
  renderer.render(miniScene, miniCamera);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
}

// Voxel view: Lambert shading with VXLEngine-style block outlines (`grid` holds column/level coordinates, so
// lines fall where their fractional part crosses zero). Voxels end at the edge of the streamed patches, where the
// smooth far field takes over out to the horizon. Both bend down with the Earth's curve around the viewer.
const areaScene = new Scene();
areaScene.background = new Color(HAZE);
areaScene.fog = new Fog(HAZE, 20_000, 190_000);
const areaCamera = new PerspectiveCamera(55, 1, 5, 400_000);
const sun = new DirectionalLight(0xffffff, 2.0);
sun.position.set(-0.6, 1, -0.4);
areaScene.add(sun, new AmbientLight(0xffffff, 1.1));
const outline = { value: 1 };
const viewer = { value: new Vector2() };
/** Voxels are drawn up to this distance from the viewer and the far field beyond it, so neither hides the other. */
const VOXEL_REACH_M = LOAD_M * 0.95;
const CURVE = `
  vec4 curveWorld = modelMatrix * vec4(transformed, 1.0);
  vec2 curveD = curveWorld.xz - viewer;
  transformed.y -= dot(curveD, curveD) / ${(2 * EARTH_RADIUS).toFixed(1)};
  vGround = curveD;`;
function curved(
  shader: { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string },
  cut: string,
  vertex = '',
): void {
  shader.uniforms.viewer = viewer;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform vec2 viewer;\nvarying vec2 vGround;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>${CURVE}${vertex}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vGround;')
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\nif (${cut}) discard;`);
}
const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
material.onBeforeCompile = (shader) => {
  curved(shader, `length(vGround) > ${VOXEL_REACH_M.toFixed(1)}`);
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
      gl_FragColor.rgb *= 1.0 - 0.4 * outline * line;`,
    );
};
const farMaterial = new MeshLambertMaterial({ vertexColors: true });
// Far-field vertices inside the voxels' reach drop far down, so the triangles across the seam form a skirt that
// closes the gap under the voxels' cut edge; the fragments inside the reach are discarded.
farMaterial.onBeforeCompile = (shader) =>
  curved(shader, `length(vGround) < ${VOXEL_REACH_M.toFixed(1)}`, `\n  if (length(curveD) < ${VOXEL_REACH_M.toFixed(1)}) transformed.y -= 3000.0;`);
const voxels = new PatchField(material);
areaScene.add(voxels.group);
const horizon = new Horizon(
  farMaterial,
  (m) => areaScene.add(m),
  (m) => areaScene.remove(m),
);
/** How far the far field sits below real height, so the voxels win where the two overlap. */
const SINK_M = 60;
let travel = { x: 0, z: 0 };
const orbit = new OrbitControls(areaCamera, renderer.domElement);
orbit.enabled = false;
orbit.enableDamping = true;
orbit.minDistance = 150;
orbit.maxDistance = 60_000;
orbit.maxPolarAngle = 1.45;

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

/** Open the voxel view at (lat, lon): stream the patches around it and show it once the ground nearby is ready. */
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
  status.textContent = `Loading the ground around ${fmt(lat, lon)} …`;
  const origin = originAround(lat, lon);
  const at = toLocal(origin, lat, lon);
  horizon.clear();
  voxels.reset(origin, Number(exaggeration.value));
  while (job === opening && !(voxels.readyAround(at, 6_000) && performance.now() - start > 1300)) {
    voxels.update(at, { x: 0, z: 0 });
    horizon.update(origin, at, voxels.exaggeration, SINK_M);
    await sleep(50);
  }
  if (job !== opening) return;
  await veiled(() => {
    if (job !== opening) return;
    loadingArea = false;
    flight = null;
    mode = 'area';
    controls.enabled = false;
    orbit.enabled = true;
    const centre = voxels.heightAt(at.x, at.z) ?? 0;
    const y = levelOf(centre, Number(exaggeration.value), voxels.cell) * voxels.cell;
    orbit.target.set(at.x, y, at.z);
    areaCamera.position.set(at.x, y + 5500, at.z + 7500);
    orbit.update();
    areaTools.hidden = false;
    hint.textContent = 'Drag to orbit · right-drag or arrow keys to move · wheel to zoom out to the horizon · click a voxel for its height';
    readout.textContent = `${fmt(lat, lon)}: ${Math.round(centre)} m`;
    history.replaceState(null, '', `#area=${lat.toFixed(4)},${wrapLon(lon).toFixed(4)}`);
  });
}

/** Where the viewer stands, in degrees. */
function position(): { lat: number; lon: number } | null {
  return voxels.origin && toGeo(voxels.origin, orbit.target);
}

function closeArea(to?: View): void {
  const a = position();
  opening++;
  loadingArea = false;
  void veiled(() => {
    mode = 'globe';
    orbit.enabled = false;
    controls.enabled = true;
    if (to) controls.view = to;
    else if (a) controls.view = { lat: a.lat, lon: a.lon, alt: 120_000, tilt: 0, heading: 0 };
    controls.changed = true;
    areaTools.hidden = true;
    hint.textContent = globeHint;
    readout.textContent = 'Click a place to open a 20 × 20 km voxel view.';
    voxels.clear();
    horizon.clear();
    const v = controls.view;
    history.replaceState(null, '', `#${v.lat.toFixed(5)},${v.lon.toFixed(5)},${Math.round(v.alt)},0,0`);
  });
}
const globeHint = hint.textContent ?? '';

back.addEventListener('click', () => closeArea());
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (mode === 'area') closeArea();
  else if (loadingArea) {
    opening++;
    loadingArea = false;
    flight = null;
    voxels.clear();
    horizon.clear();
    status.textContent = 'Cancelled.';
    lastStatus = performance.now() + 2000;
  }
});
// Arrow keys move the view while held: they pan the globe, or walk across the voxel area (and on into the next one).
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
const held = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (!(e.key in ARROWS) || e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  held.add(e.key);
});
window.addEventListener('keyup', (e) => held.delete(e.key));
window.addEventListener('blur', () => held.clear());

function arrowInput(): [number, number] {
  let x = 0;
  let y = 0;
  for (const k of held) {
    x += ARROWS[k][0];
    y += ARROWS[k][1];
  }
  return [x, y];
}

let settling = false;
function walk(dt: number): void {
  const [ix, iy] = arrowInput();
  const o = voxels.origin;
  if (!o) return;
  if (!ix && !iy) {
    travel = { x: 0, z: 0 };
    if (settling) settling = Math.abs(followGround(orbit.target.clone(), voxels.cell, dt)) > 1;
    return;
  }
  settling = true;
  const f = orbit.target.clone().sub(areaCamera.position).setY(0).normalize();
  const right = new Vector3(-f.z, 0, f.x);
  const speed = Math.min(areaCamera.position.distanceTo(orbit.target), 15_000) * 0.6;
  const dir = f.multiplyScalar(iy).add(right.multiplyScalar(ix)).normalize();
  travel = { x: dir.x, z: dir.z };
  followGround(orbit.target.clone().addScaledVector(dir, speed * dt), voxels.cell, dt);
  if (Math.hypot(orbit.target.x, orbit.target.z) > REORIGIN_M) reorigin();
}

/** Move the scene's origin under the viewer, keeping the camera where it is relative to the ground. */
function reorigin(): void {
  const here = position();
  if (!here) return;
  const origin = originAround(here.lat, here.lon);
  const shift = toLocal(origin, here.lat, here.lon).sub(orbit.target.clone().setY(0));
  orbit.target.add(shift);
  areaCamera.position.add(shift);
  orbit.update();
  voxels.reset(origin, Number(exaggeration.value));
  horizon.clear();
}

/** Move the orbit target (and camera with it) to `next`, easing its height towards the ground; returns the remaining gap. */
function followGround(next: Vector3, cell: number, dt: number): number {
  const ground = levelOf(voxels.heightAt(next.x, next.z) ?? 0, Number(exaggeration.value), cell) * cell;
  next.y += (ground - next.y) * Math.min(1, dt * 3);
  areaCamera.position.add(next.clone().sub(orbit.target));
  orbit.target.copy(next);
  return ground - next.y;
}

exaggeration.addEventListener('change', () => {
  if (mode !== 'area' || !voxels.origin) return;
  const k = Number(exaggeration.value);
  horizon.build(k, SINK_M);
  void voxels.rebuild(k).then(() => {
    const ground = voxels.heightAt(orbit.target.x, orbit.target.z) ?? 0;
    const dy = levelOf(ground, k, voxels.cell) * voxels.cell - orbit.target.y;
    orbit.target.y += dy;
    areaCamera.position.y += dy;
    orbit.update();
  });
});
outlines.addEventListener('change', () => (outline.value = outlines.checked ? 1 : 0));
window.addEventListener('hashchange', () => {
  const area = areaFromHash();
  if (area) {
    const a = position();
    const near = a && Math.abs(a.lat - area.lat) < 1e-3 && Math.abs(wrapLon(a.lon - area.lon)) < 1e-3;
    if (mode !== 'area' || !near) void openArea(area.lat, area.lon);
    return;
  }
  const v = viewFromHash();
  if (!v) return;
  if (mode === 'area') closeArea(v);
  else {
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
  const o = voxels.origin;
  const inside = hit?.face ? hit.point.clone().addScaledVector(hit.face.normal, -0.01) : hit?.point;
  const h = inside && voxels.heightAt(inside.x, inside.z);
  if (!o || h == null) return;
  const { lat, lon } = toGeo(o, hit.point);
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

const startArea = areaFromHash();
if (startArea) void openArea(startArea.lat, startArea.lon);

let lastHash = 0;
let lastStatus = 0;
let lastFrame = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (mode === 'globe') {
    const [ix, iy] = arrowInput();
    if ((ix || iy) && !flight) controls.pan(-ix * 500 * dt, iy * 500 * dt);
    fly(now);
    controls.apply(globeCamera);
    const v = controls.view;
    globeCamera.near = Math.max(1, v.alt * 0.001);
    globeCamera.updateProjectionMatrix();
    globe.update(v, container.clientHeight);
    globe.render(renderer, globeCamera);
    minimap.hidden = v.alt > MINI_SHOW_BELOW_ALT;
    if (!minimap.hidden) renderMinimap(v.lat, v.lon);
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
    walk(dt);
    orbit.update();
    const o = voxels.origin;
    viewer.value.set(orbit.target.x, orbit.target.z);
    if (o) {
      voxels.update(orbit.target, travel);
      horizon.update(o, orbit.target, voxels.exaggeration, SINK_M);
    }
    renderer.clear();
    renderer.render(areaScene, areaCamera);
    const here = position();
    minimap.hidden = !here;
    if (here) renderMinimap(here.lat, here.lon);
    if (now - lastStatus > 250 && here && !loadingArea) {
      lastStatus = now;
      const s = voxels.stats;
      const loading = s.loading ? ` · loading ${s.loading} more` : '';
      status.textContent = `${s.shown} pieces of 5 × 5 km · ${voxels.cell.toFixed(0)} m voxels${loading} · horizon ${horizon.mesh ? 'shown' : 'loading'}`;
      if (now - lastHash > 1000) {
        lastHash = now;
        history.replaceState(null, '', `#area=${here.lat.toFixed(4)},${here.lon.toFixed(4)}`);
      }
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
