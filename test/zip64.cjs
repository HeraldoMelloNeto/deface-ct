const fs = require('fs'); const E = require('../dist/engine.node.cjs');
(async () => {
  for (const force of [false, true]) {
    const chunks = [];
    const zw = new E.ZipWriter({ write: (u) => { chunks.push(Buffer.from(u)); } }, { forceZip64: force });
    for (let i = 0; i < 50; i++) await zw.addFile(`P/IM${i}.dcm`, new Uint8Array(10000 + i).fill(i));
    await zw.close();
    const buf = Buffer.concat(chunks);
    fs.writeFileSync(`out/zip64_${force}.zip`, buf);
    // releitura com o próprio leitor
    const src = E.bytesSource(new Uint8Array(buf));
    const ents = await E.listZip(src);
    const d = await E.readZipEntry(src, ents[7]);
    if (ents.length !== 50 || d.length !== 10007 || d[5] !== 7) throw new Error('falha releitura');
    console.log('zip64', force, 'ok', buf.length);
  }
})().catch((e) => { console.error(e); process.exit(1); });
