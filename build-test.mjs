import * as esbuild from 'esbuild';
await esbuild.build({ entryPoints: ['test/engine-entry.js'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/engine.node.cjs', loader: { '.wasm': 'binary' }, logLevel: 'warning', target: ['node18'] });
