import { PerspectiveCamera, Vector3 } from 'three';
import { EARTH_RADIUS } from './shared.ts';

const DEG = Math.PI / 180;
const MIN_ALT = 15_000;
const MAX_ALT = 40_000_000;

export interface View {
  lat: number;
  lon: number;
  alt: number;
  tilt: number;
  heading: number;
}

/** Map-style globe camera for the relief view: drag pans, wheel zooms towards the ground, right-drag/shift-drag tilts and turns. */
export class GlobeControls {
  view: View;
  changed = true;
  /** Off while the voxel view owns the pointer. */
  enabled = true;

  constructor(
    readonly element: HTMLElement,
    initial: View,
  ) {
    this.view = { ...initial };
    let last: { x: number; y: number } | null = null;
    let rotate = false;
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    element.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      last = { x: e.clientX, y: e.clientY };
      rotate = e.button === 2 || e.shiftKey;
      element.setPointerCapture(e.pointerId);
    });
    element.addEventListener('pointerup', (e) => {
      if (!last) return;
      last = null;
      element.releasePointerCapture(e.pointerId);
    });
    element.addEventListener('pointermove', (e) => {
      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      if (rotate) this.rotate(dx, dy);
      else this.pan(dx, dy);
    });
    element.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.zoom(Math.exp(e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }

  pan(dx: number, dy: number): void {
    const v = this.view;
    const perPx = (v.alt / EARTH_RADIUS) * (2 * Math.tan(30 * DEG)) / this.element.clientHeight;
    const h = v.heading * DEG;
    const east = -dx * Math.cos(h) + dy * Math.sin(h);
    const north = dy * Math.cos(h) + dx * Math.sin(h);
    v.lat = Math.max(-89.9, Math.min(89.9, v.lat + (north * perPx) / DEG));
    v.lon += (east * perPx) / DEG / Math.max(Math.cos(v.lat * DEG), 0.01);
    v.lon = ((((v.lon + 180) % 360) + 360) % 360) - 180;
    this.changed = true;
  }

  rotate(dx: number, dy: number): void {
    this.view.heading = (this.view.heading + dx * 0.3) % 360;
    this.view.tilt = Math.max(0, Math.min(80, this.view.tilt + dy * 0.3));
    this.changed = true;
  }

  zoom(factor: number): void {
    this.view.alt = Math.max(MIN_ALT, Math.min(MAX_ALT, this.view.alt * factor));
    this.changed = true;
  }

  /** Place the camera `alt` metres from the ground point under (lat, lon), tilted and turned. */
  apply(camera: PerspectiveCamera): void {
    const { lat, lon, alt, tilt, heading } = this.view;
    const la = lat * DEG;
    const lo = lon * DEG;
    const up = new Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
    const east = new Vector3(-Math.sin(lo), Math.cos(lo), 0);
    const north = new Vector3().crossVectors(up, east);
    const h = heading * DEG;
    const t = tilt * DEG;
    const forward = north.clone().multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h));
    const target = up.clone().multiplyScalar(EARTH_RADIUS);
    camera.position
      .copy(target)
      .addScaledVector(up, alt * Math.cos(t))
      .addScaledVector(forward, -alt * Math.sin(t));
    camera.up.copy(forward).multiplyScalar(Math.cos(t)).addScaledVector(up, Math.sin(t));
    camera.lookAt(target);
    camera.updateMatrixWorld();
  }
}
