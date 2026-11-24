/// <reference lib="webworker" />
import { build } from './mesher.ts';
import { COLUMNS as N, type MeshRequest, type WorkerReply } from './shared.ts';

self.onmessage = async (e: MessageEvent<MeshRequest>) => {
  const req = e.data;
  let reply: WorkerReply;
  try {
    const r = await fetch(`/voxels/${req.z}/${req.x}/${req.y}.bin`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const heights = new Int16Array(await r.arrayBuffer());
    if (heights.length !== N * N) throw new Error(`expected ${N * N} columns, got ${heights.length}`);
    reply = build(req, heights);
  } catch (err) {
    reply = { type: 'error', id: req.id, message: String(err) };
  }
  if (reply.type === 'mesh') {
    const { positions, normals, colors, grid, indices } = reply;
    self.postMessage(reply, [positions.buffer, normals.buffer, colors.buffer, grid.buffer, indices.buffer]);
  } else {
    self.postMessage(reply);
  }
};
