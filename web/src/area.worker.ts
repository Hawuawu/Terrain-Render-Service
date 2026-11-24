/// <reference lib="webworker" />
import { buildRange, quantise } from './mesher.ts';
import type { ChunkRequest, WorkerReply } from './shared.ts';

self.onmessage = (e: MessageEvent<ChunkRequest>) => {
  const req = e.data;
  try {
    const q = quantise(req, req.exaggeration);
    for (const range of req.ranges) {
      const mesh: WorkerReply = { type: 'chunk', id: req.id, ...buildRange(req, req.exaggeration, range, q) };
      self.postMessage(mesh, [mesh.positions.buffer, mesh.colors.buffer, mesh.grid.buffer, mesh.indices.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: req.id, message: String(err) } satisfies WorkerReply);
  }
};
