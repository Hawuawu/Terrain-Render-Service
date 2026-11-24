/// <reference lib="webworker" />
import { buildChunk, quantise } from './mesher.ts';
import type { ChunkRequest, WorkerReply } from './shared.ts';

self.onmessage = (e: MessageEvent<ChunkRequest>) => {
  const req = e.data;
  try {
    const q = quantise(req, req.exaggeration);
    for (const [ci, cj] of req.chunks) {
      const mesh: WorkerReply = { type: 'chunk', id: req.id, ...buildChunk(req, req.exaggeration, ci, cj, q) };
      self.postMessage(mesh, [mesh.positions.buffer, mesh.colors.buffer, mesh.grid.buffer, mesh.indices.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: req.id, message: String(err) } satisfies WorkerReply);
  }
};
