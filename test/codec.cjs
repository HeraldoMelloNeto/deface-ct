const fs = require('fs'); const E = require('../dist/engine.node.cjs');
(async () => {
  for (const f of process.argv.slice(2)) {
    const ds = E.parseDicom(new Uint8Array(fs.readFileSync(f)));
    const pixelEl = E.findEl(ds.elements, E.TAG.PixelData);
    const rows = E.getUS(ds, E.TAG.Rows), cols = E.getUS(ds, E.TAG.Columns);
    const ba = E.getUS(ds, E.TAG.BitsAllocated), bs = E.getUS(ds, E.TAG.BitsStored), signed = E.getUS(ds, E.TAG.PixelRepresentation) === 1;
    const px = await E.decodePixels({ pixelEl, ts: ds.ts }, { rows, cols, bitsAllocated: ba, bitsStored: bs, signed });
    fs.writeFileSync(f.split('/').pop() + '.i32', Buffer.from(px.buffer));
    console.log(f.split('/').pop(), ds.ts, rows, cols, px.length);
  }
})().catch((e) => { console.error(e); process.exit(1); });
