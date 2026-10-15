const fs = require('fs'); const E = require('../dist/engine.node.cjs');
(async () => {
  const src = E.bytesSource(new Uint8Array(fs.readFileSync(process.argv[2])));
  let t = Date.now(); const T = (m) => { const n = Date.now(); console.log(m, n - t, 'ms'); t = n; };
  const scan = await E.scanZip(src); T('scan');
  let last = '';
  await E.processStudy(src, scan.studies[0], { code: 'X', folder: 'X' }, {
    progress: (st, f) => { if (st !== last) { T('-> ' + st); last = st; } },
    file: async () => {},
  });
  T('end');
})();
