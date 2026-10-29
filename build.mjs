// Build with esbuild. `node build.mjs --serve` runs a dev server on :5173.
// PF_NODE_PATH lets the build resolve packages from a shared folder when
// node_modules is not installed (used in the restricted build environment).
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const extra = process.env.PF_NODE_PATH ? process.env.PF_NODE_PATH.split(':') : [];
const require = createRequire(import.meta.url);
let esbuild;
try { esbuild = require('esbuild'); } catch { esbuild = require(join(extra[0] ?? '', 'esbuild')); }

const serve = process.argv.includes('--serve');
const out = join(root, 'dist');
mkdirSync(out, { recursive: true });
cpSync(join(root, 'public'), out, { recursive: true });
writeFileSync(join(out, 'index.html'), readFileSync(join(root, 'index.html'), 'utf8'));

const common = {
  bundle: true,
  sourcemap: true,
  target: ['es2022', 'safari16'],
  nodePaths: extra,
  define: { 'process.env.NODE_ENV': serve ? '"development"' : '"production"' },
  minify: !serve,
  logLevel: 'info',
  jsx: 'automatic',
};

const builds = [
  { ...common, entryPoints: { app: join(root, 'src/main.tsx') }, outdir: out, format: 'esm', loader: { '.css': 'css' } },
  { ...common, entryPoints: { 'live.worklet': join(root, 'src/audio/live.worklet.ts') }, outdir: out, format: 'iife' },
  { ...common, entryPoints: { 'analysis.worker': join(root, 'src/audio/analysis.worker.ts') }, outdir: out, format: 'iife' },
];
if (process.env.PF_LAB) {
  builds.push({ ...common, entryPoints: { lab: join(root, 'src/lab/lab.ts') }, outdir: out, format: 'esm' });
  cpSync(join(root, 'test-audio'), join(out, 'test-audio'), { recursive: true });
}

if (serve) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  const { port } = await ctxs[0].serve({ servedir: out, port: Number(process.env.PORT ?? 5173), host: '0.0.0.0' });
  console.log(`PulseForm dev server: http://localhost:${port}`);
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
