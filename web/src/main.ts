// CesiumWidget (engine only) instead of Viewer: Viewer's Knockout UI needs eval, which our CSP forbids.
import {
  buildModuleUrl,
  Cartographic,
  CesiumTerrainProvider,
  CesiumWidget,
  ImageryLayer,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  TileMapServiceImageryProvider,
} from '@cesium/engine';
import '@cesium/engine/Source/Widget/CesiumWidget.css';

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const viewer = new CesiumWidget('globe', {
  baseLayer: ImageryLayer.fromProviderAsync(
    TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII')),
  ),
  terrainProvider: await CesiumTerrainProvider.fromUrl('/terrain/', { requestVertexNormals: true }),
});
viewer.scene.globe.enableLighting = true;
viewer.scene.verticalExaggeration = 1.5;

const osm = viewer.imageryLayers.addImageryProvider(new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }));
byId<HTMLInputElement>('osm').addEventListener('change', (e) => {
  osm.show = (e.target as HTMLInputElement).checked;
});
byId<HTMLInputElement>('exaggeration').addEventListener('input', (e) => {
  viewer.scene.verticalExaggeration = Number((e.target as HTMLInputElement).value);
});

const readout = byId<HTMLParagraphElement>('readout');
viewer.screenSpaceEventHandler.setInputAction(async ({ position }: ScreenSpaceEventHandler.PositionedEvent) => {
  const picked = viewer.scene.pickPosition(position) ?? viewer.camera.pickEllipsoid(position);
  if (!picked) return;
  const c = Cartographic.fromCartesian(picked);
  const lat = CesiumMath.toDegrees(c.latitude);
  const lon = CesiumMath.toDegrees(c.longitude);
  readout.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}: …`;
  const res = await fetch(`/api/elevation?lat=${lat}&lon=${lon}`);
  const { elevation_m } = (await res.json()) as { elevation_m: number };
  readout.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}: ${Math.round(elevation_m)} m`;
}, ScreenSpaceEventType.LEFT_CLICK);
