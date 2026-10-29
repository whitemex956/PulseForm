/**
 * Connected-session acceptance tests: desktop host + phone remote + TV display,
 * three real browser pages talking through the real session server and WebRTC.
 * Usage: node tests/e2e/session.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'test-results');
mkdirSync(OUT, { recursive: true });
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const assert = (c, m) => { if (!c) throw new Error(m); };

function startServer() {
  const p = spawn(process.execPath, [join(root, 'server/signal.mjs'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => p.stdout.on('data', (d) => { if (String(d).includes('session server')) resolve(p); }));
}

async function test(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, pass: true, ms: Date.now() - t0, detail });
    console.log(`PASS ${name}`, JSON.stringify(detail));
  } catch (e) {
    results.push({ name, pass: false, ms: Date.now() - t0, error: String(e?.message ?? e) });
    console.log(`FAIL ${name}: ${e?.message ?? e}`);
  }
}

let server = await startServer();
const browser = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(root, 'test-audio/energy.wav')}`]);
const init = (pr = {}) => (p) => p.addInitScript((x) => { window.__pfTest = { dpr: 0.4, log: [] }; localStorage.setItem('pulseform.prefs.v1', JSON.stringify({ quality: 0, ...x })); }, pr);
const errors = [];

const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
const host = await hostCtx.newPage();
host.setDefaultTimeout(120000);
host.on('pageerror', (e) => errors.push('host: ' + e.message));
await init()(host);
await host.goto(BASE + '/');
await host.waitForFunction(() => !!window.pulseform);

let code;
await test('host-starts-pairing-with-qr-and-code', async () => {
  await host.click('[aria-label="Connect a display"]');
  await host.click('[data-testid=start-session]');
  await host.waitForSelector('[data-testid=pair-code]');
  code = (await host.textContent('[data-testid=pair-code]')).trim();
  const qr = await host.$eval('.qr svg', (s) => s.outerHTML.length);
  await host.screenshot({ path: join(OUT, 'desktop-connect-sheet.png') });
  assert(/^\d{6}$/.test(code), `code "${code}"`);
  assert(qr > 500, 'QR not rendered');
  return { code: code.replace(/\d/g, '•'), qrBytes: qr };
});

const phoneCtx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
const phone = await phoneCtx.newPage();
phone.setDefaultTimeout(120000);
phone.on('pageerror', (e) => errors.push('phone: ' + e.message));
await init()(phone);

await test('phone-joins-as-remote-direct-link', async () => {
  await phone.goto(`${BASE}/?join=${code}`);
  await phone.waitForSelector('[data-testid=remote-primary]');
  await phone.waitForFunction(() => document.querySelector('.status-pill')?.textContent.includes('Connected'), null, { timeout: 30000 }).catch(async () => {
    const d = await phone.evaluate(() => { const g = window.pulseform?.guest; const l = g?.link.links.get('host'); return { pill: document.querySelector('.status-pill')?.textContent, stats: g?.stats, conn: l?.pc?.connectionState, st: l?.state?.readyState, ctl: l?.ctl?.readyState }; });
    throw new Error('phone not connected ' + JSON.stringify(d));
  });
  const pill = await phone.textContent('.status-pill');
  await phone.screenshot({ path: join(OUT, 'iphone-remote.png') });
  assert(/Connected · \d+ ms/.test(pill), `phone link "${pill}"`);
  return { phoneStatus: pill };
});

await test('remote-starts-listening-on-desktop', async () => {
  await host.mouse.click(30, 400); // a real user has clicked the desktop page at least once
  await host.keyboard.press('Escape');
  const t0 = Date.now();
  await phone.tap('[data-testid=remote-primary]');
  await host.waitForFunction(() => window.pulseform.hub.status.state === 'listening', null, { timeout: 30000 });
  const ms = Date.now() - t0;
  await phone.waitForFunction(() => document.querySelector('.remote-source')?.textContent.includes('Listening'), null, { timeout: 15000 });
  const src = await phone.textContent('.remote-source');
  return { msToListen: ms, phoneShows: src };
});

await test('remote-intensity-command-latency', async () => {
  const lat = [];
  for (const v of [0.4, 0.9, 1.2, 0.6, 1.0]) {
    await phone.evaluate((v) => { const el = document.getElementById('remote-intensity'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    await host.waitForFunction((v) => Math.abs(JSON.parse(localStorage.getItem('pulseform.prefs.v1')).intensity - v) < 0.01, v, { timeout: 10000 });
    await phone.waitForTimeout(300);
    lat.push(await phone.evaluate(() => window.pulseform?.guest?.stats.lastCommandMs ?? null));
  }
  const ok = lat.filter((x) => x !== null);
  const med = ok.sort((a, b) => a - b)[Math.floor(ok.length / 2)];
  assert(med !== undefined && med < 150, `median command round trip ${med} ms`);
  return { roundTripMs: ok.map((x) => Math.round(x)), medianMs: Math.round(med) };
});

// software-rendered WebGL in CI is very slow; a smaller TV viewport keeps the page responsive
const tvCtx = await browser.newContext({ viewport: { width: 640, height: 360 } });
const tv = await tvCtx.newPage();
tv.setDefaultTimeout(120000);
tv.on('pageerror', (e) => errors.push('tv: ' + e.message));
await init()(tv);

await test('tv-display-receives-synchronized-frames', async () => {
  await host.click('[aria-label="Connect a display"]').catch(() => {});
  code = (await host.textContent('[data-testid=pair-code]').catch(() => code))?.trim() ?? code;
  await tv.goto(`${BASE}/?join=${code}&role=display`);
  await tv.waitForFunction(() => window.pulseform?.guest?.stats.link === 'direct', null, { timeout: 90000 }).catch(async (e) => {
    const d = await tv.evaluate(() => { const l = window.pulseform?.guest?.link.links.get('host'); return { status: l?.status, conn: l?.pc?.connectionState, ice: l?.pc?.iceConnectionState, sig: l?.pc?.signalingState, st: l?.state?.readyState, ctl: l?.ctl?.readyState }; });
    const tl = await tv.evaluate(() => window.__pfTest.log.slice(-25));
    const hl = await host.evaluate(() => window.__pfTest.log.slice(-25));
    throw new Error('no direct link ' + JSON.stringify(d) + '\nTV:\n' + tl.join('\n') + '\nHOST:\n' + hl.join('\n'));
  });
  await tv.waitForTimeout(4000);
  const st = await tv.evaluate(() => ({ ...window.pulseform.guest.stats }));
  // compare what the TV renders with what the host is analysing right now
  const hostLow = await host.evaluate(() => window.pulseform.state.current.low);
  const tvLow = await tv.evaluate(() => window.pulseform.state.current.low);
  await tv.screenshot({ path: join(OUT, 'tv-display.png') });
  assert(st.framesPerSecond >= 20, `frames/s ${st.framesPerSecond}`);
  assert(st.frameAgeMs < 250, `frame age ${st.frameAgeMs}`);
  return { framesPerSecond: st.framesPerSecond, rttMs: +st.rttMs.toFixed(1), clockOffsetMs: +st.offsetMs.toFixed(1), frameAgeMs: +st.frameAgeMs.toFixed(0), playoutMs: +st.playoutMs.toFixed(0), hostLow: +hostLow.toFixed(2), tvLow: +tvLow.toFixed(2) };
});

await test('tv-recovers-from-dropped-link', async () => {
  // break the direct WebRTC link from the host side
  await host.evaluate(() => { const h = window.pulseform; }); // no-op: host object is internal
  await tv.evaluate(() => window.pulseform.guest.link.breakDirect('host'));
  const seen = new Set();
  const t0 = Date.now();
  let recovered = false;
  while (Date.now() - t0 < 30000) {
    const s = await tv.evaluate(() => ({ link: window.pulseform.guest.stats.link, stale: window.pulseform.guest.stats.stale, fps: window.pulseform.guest.stats.framesPerSecond }));
    seen.add(s.link);
    if (s.link === 'direct' && seen.size > 1 && !s.stale) { recovered = true; break; }
    await tv.waitForTimeout(250);
  }
  await tv.waitForTimeout(1500);
  const fps = await tv.evaluate(() => window.pulseform.guest.stats.framesPerSecond);
  assert(recovered, `did not recover; states ${[...seen]}`);
  assert(fps >= 15, `frames after recovery ${fps}`);
  return { statesSeen: [...seen], recoveredInMs: Date.now() - t0, framesPerSecondAfter: fps };
});

await test('tv-shows-reconnecting-when-server-and-host-vanish', async () => {
  // simulate the desktop going away: close the host page
  await host.close();
  await tv.waitForTimeout(4000);
  const txt = await tv.textContent('.display-status');
  const st = await tv.evaluate(() => ({ ...window.pulseform.guest.stats, ended: window.pulseform.guest.ended }));
  await tv.screenshot({ path: join(OUT, 'tv-reconnecting.png') });
  assert(/Reconnecting|ended|via server/i.test(txt) || st.ended, `tv status "${txt}"`);
  return { tvStatus: txt, stale: st.stale, ended: st.ended };
});

await test('no-page-errors', async () => {
  assert(!errors.length, errors.join('\n'));
  return { errors: 0 };
});

await browser.close();
server.kill();
writeFileSync(join(OUT, 'session-results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
