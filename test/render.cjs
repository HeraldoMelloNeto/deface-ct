// node test/render.cjs pasta CODE -> CODE_render.png (antes|depois em 0°, 35°, 80°)
const fs = require('fs');
const { PNG } = require('pngjs');
const E = require('../dist/engine.node.cjs');
const [dir, code] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(`${dir}/${code}_prev.json`));
const W = 300, H = 300, yaws = [0, 35, 80, -45];
const png = new PNG({ width: W * 2, height: H * yaws.length });
yaws.forEach((yaw, row) => {
  ['before', 'after'].forEach((k, col) => {
    const m = meta[k];
    const prev = { ...m, data: new Uint8Array(fs.readFileSync(`${dir}/${code}_${k}.u8`)) };
    const t0 = Date.now();
    const img = E.renderSurface(prev, { w: W, h: H, yaw, pitch: 0, bg: [18, 22, 30] });
    if (row === 0 && col === 0) console.log('render ms', Date.now() - t0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4, d = ((row * H + y) * W * 2 + col * W + x) * 4;
      png.data[d] = img[s]; png.data[d + 1] = img[s + 1]; png.data[d + 2] = img[s + 2]; png.data[d + 3] = 255;
    }
  });
});
fs.writeFileSync(`${dir}/${code}_render.png`, PNG.sync.write(png));
console.log(`${dir}/${code}_render.png`);
