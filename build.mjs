// Gera index.html autocontido (motor e renderizador como Web Workers embutidos)
import * as esbuild from 'esbuild';
import fs from 'node:fs';

const common = { bundle: true, format: 'iife', target: ['chrome100', 'edge100', 'firefox100', 'safari15'], minify: true, legalComments: 'none', loader: { '.wasm': 'binary' }, logLevel: 'warning', write: false, external: ['fs', 'path', 'module', 'url', 'worker_threads'] };
const build = async (entry) => (await esbuild.build({ ...common, entryPoints: [entry] })).outputFiles[0].text;
const [engine, render, app] = await Promise.all([build('src/worker.js'), build('src/renderworker.js'), build('src/app.js')]);
const safe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
let html = fs.readFileSync('src/app.html', 'utf8');
html = html.replace('<!--WORKERS-->', () => `<script type="text/plain" id="wk-engine">${safe(engine)}</script>\n<script type="text/plain" id="wk-render">${safe(render)}</script>`);
html = html.replace('<!--APP-->', () => `<script>${safe(app)}</script>`);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);
fs.copyFileSync('dist/index.html', 'index.html');
console.log('index.html', (html.length / 1024).toFixed(0), 'KB');
