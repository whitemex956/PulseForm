// Shared headless browser launcher for e2e/visual tests.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
export const EXECUTABLE = process.env.PF_CHROME ?? (process.env.PF_NODE_PATH ? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' : undefined);
export async function launch(extraArgs = []) {
  return pw.chromium.launch({
    executablePath: EXECUTABLE,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...extraArgs],
  });
}
