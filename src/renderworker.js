// Worker de renderização 3D: mantém os volumes reduzidos e devolve imagens sob demanda
import { renderSurface } from './render.js';

const vols = new Map();
self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'set') { vols.set(m.key, m.prev); self.postMessage({ type: 'set-ok', key: m.key }); return; }
  if (m.type === 'drop') { vols.delete(m.key); return; }
  if (m.type === 'render') {
    const prev = vols.get(m.key);
    if (!prev) { self.postMessage({ type: 'image', key: m.key, seq: m.seq, missing: true }); return; }
    const img = renderSurface(prev, { w: m.w, h: m.h, yaw: m.yaw, pitch: m.pitch, bg: m.bg, bgAlpha: m.bgAlpha ?? 255, tint: m.tint });
    self.postMessage({ type: 'image', key: m.key, seq: m.seq, w: m.w, h: m.h, data: img }, [img.buffer]);
  }
};
