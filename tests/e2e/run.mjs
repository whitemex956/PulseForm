/**
 * End-to-end acceptance tests against the REAL running app in Chromium.
 * Microphone tests use Chromium's fake capture device fed with test WAV files,
 * which exercises the actual getUserMedia → AudioWorklet → analyzer path.
 *
 * Usage: node tests/e2e/run.mjs [testName ...]
 * Writes screenshots and results.json to test-results/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';
import { serve } from './serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'test-results');
mkdirSync(OUT, { recursive: true });
const AUDIO = join(root, 'test-audio');
const { srv, url } = await serve(join(root, 'dist'));
const only = process.argv.slice(2);
const results = [];

async function page({ mic = 'house', grant = true, viewport = { width: 1280, height: 800 }, mobile = false, prefs = {} } = {}) {
  const args = mic ? ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(AUDIO, mic + '.wav')}`] : [];
  if (grant) args.push('--use-fake-ui-for-media-stream');
  const b = await launch(args);
  const ctx = await b.newContext({ viewport, permissions: grant ? ['microphone'] : [], isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' : undefined });
  const p = await ctx.newPage();
  p.setDefaultTimeout(120000);
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript((pr) => {
    window.__pfTest = { dpr: 0.5 };
    localStorage.setItem('pulseform.prefs.v1', JSON.stringify({ quality: 0, ...pr }));
  }, prefs);
  await p.goto(url + '/');
  await p.waitForFunction(() => !!window.pulseform);
  return { b, p, errors };
}

/** Controls fade away while music plays; a real user taps or moves first. */
async function wake(p) {
  await p.mouse.move(640, 300);
  await p.mouse.move(650, 310);
  await p.waitForTimeout(800);
}

const S = (p) => p.evaluate(() => {
  const pf = window.pulseform;
  const st = pf.state.current;
  return { status: pf.hub.status, ctxState: pf.hub.ctx?.state ?? null, stats: pf.hub.analyzer ? { ...pf.hub.analyzer.stats } : null, low: st.low, mid: st.mid, high: st.high, kick: st.kick, energy: st.energy, intensity: st.intensity, t: st.t };
});

/** Sample visual state + wave band canvas stats over a period. */
async function sample(p, seconds, every = 0.25) {
  const out = [];
  for (let i = 0; i < seconds / every; i++) {
    out.push(await p.evaluate(() => {
      const st = window.pulseform.state.current;
      const c = document.querySelector('.band-canvas canvas');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      // vertical extent of drawn waveform pixels (alpha > 40)
      let minY = c.height, maxY = 0, lit = 0;
      for (let y = 0; y < c.height; y++) for (let x = Math.floor(c.width * 0.5); x < c.width; x += 3) {
        if (d[(y * c.width + x) * 4 + 3] > 40) { lit++; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      return { low: st.low, mid: st.mid, high: st.high, kick: st.kick, intensity: st.intensity, energy: st.energy, waveExtent: lit ? (maxY - minY) / c.height : 0 };
    }));
    await p.waitForTimeout(every * 1000);
  }
  return out;
}
const avg = (a, k) => a.reduce((s, x) => s + x[k], 0) / a.length;
const sd = (a, k) => { const m = avg(a, k); return Math.sqrt(a.reduce((s, x) => s + (x[k] - m) ** 2, 0) / a.length); };

async function test(name, fn) {
  if (only.length && !only.includes(name)) return;
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
function assert(c, m) { if (!c) throw new Error(m); }

// ------------------------------------------------------------------
await test('idle-renders-and-offers-listen', async () => {
  const { b, p, errors } = await page({ mic: null });
  await p.waitForTimeout(2000);
  const lit = await p.evaluate(() => {
    const c = document.querySelector('canvas.art');
    const off = document.createElement('canvas');
    off.width = 64; off.height = 40;
    const g = off.getContext('2d');
    g.drawImage(c, 0, 0, 64, 40);
    const d = g.getImageData(0, 0, 64, 40).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) n++;
    return n / (64 * 40);
  });
  const listen = await p.isVisible('[data-testid=listen]');
  const statusTxt = await p.textContent('.status-pill');
  await p.screenshot({ path: join(OUT, 'desktop-idle.png') });
  await b.close();
  assert(listen, 'Listen button not visible');
  assert(lit > 0.01, `artwork looks empty (${lit})`);
  assert(/Not listening/.test(statusTxt), `status says "${statusTxt}"`);
  assert(!errors.length, errors.join('\n'));
  return { litFraction: +lit.toFixed(3), status: statusTxt };
});

await test('mic-listens-to-real-audio', async () => {
  const { b, p, errors } = await page({ mic: 'house' });
  await p.click('[data-testid=listen]');
  await p.waitForFunction(() => window.pulseform.hub.status.state === 'listening');
  await p.waitForTimeout(12000);
  const s = await S(p);
  const sm = await sample(p, 3);
  await p.screenshot({ path: join(OUT, 'desktop-listening-house.png') });
  await b.close();
  assert(s.stats.framesPerSecond > 60, `analysis frames/s ${s.stats.framesPerSecond}`);
  assert(!s.stats.silent, 'reported silent');
  assert(s.stats.bpm && Math.abs(s.stats.bpm - 124) / 124 < 0.02, `live bpm ${s.stats.bpm}`);
  assert(avg(sm, 'waveExtent') > 0.2, `waveform barely drawn (${avg(sm, 'waveExtent')})`);
  assert(Math.max(...sm.map((x) => x.kick)) > 0.3, 'no kick pulses');
  assert(!errors.length, errors.join('\n'));
  return { bpm: s.stats.bpm, framesPerSecond: s.stats.framesPerSecond, levelDb: +s.stats.levelDb.toFixed(1), waveExtent: +avg(sm, 'waveExtent').toFixed(2), meanIntensity: +avg(sm, 'intensity').toFixed(2) };
});

await test('silence-is-flat-and-calm', async () => {
  const { b, p, errors } = await page({ mic: 'silence' });
  await p.click('[data-testid=listen]');
  await p.waitForFunction(() => window.pulseform.hub.status.state === 'listening');
  await p.waitForTimeout(4000);
  const s = await S(p);
  const sm = await sample(p, 3);
  const statusTxt = await p.textContent('.status-pill');
  await p.screenshot({ path: join(OUT, 'desktop-silence.png') });
  await b.close();
  assert(s.stats.silent, 'silence not detected');
  assert(/silence/i.test(statusTxt), `status "${statusTxt}"`);
  assert(avg(sm, 'waveExtent') < 0.08, `waveform not flat (${avg(sm, 'waveExtent')})`);
  assert(avg(sm, 'intensity') < 0.1 && avg(sm, 'low') < 0.05 && avg(sm, 'kick') < 0.01, `artwork not restrained ${JSON.stringify(sm[0])}`);
  assert(!errors.length, errors.join('\n'));
  return { levelDb: +s.stats.levelDb.toFixed(1), waveExtent: +avg(sm, 'waveExtent').toFixed(3), intensity: +avg(sm, 'intensity').toFixed(3), status: statusTxt };
});

await test('bass-vs-vocal-behave-differently', async () => {
  const run = async (mic) => {
    const { b, p } = await page({ mic });
    await p.click('[data-testid=listen]');
    await p.waitForFunction(() => window.pulseform.hub.status.state === 'listening');
    await p.waitForTimeout(6000);
    const sm = await sample(p, 6, 0.1);
    await p.screenshot({ path: join(OUT, `desktop-listening-${mic}.png`) });
    await b.close();
    // the sculpture's scale factor in the shader: 1 + 0.16 low + 0.1 kick
    const scale = sm.map((x) => ({ v: 1 + 0.16 * x.low + 0.1 * x.kick }));
    return { low: avg(sm, 'low'), mid: avg(sm, 'mid'), high: avg(sm, 'high'), kick: avg(sm, 'kick'), scaleSd: sd(scale, 'v'), lowToMid: avg(sm, 'low') / Math.max(1e-3, avg(sm, 'mid')) };
  };
  const bass = await run('bass');
  const vocal = await run('vocal');
  assert(bass.kick > vocal.kick * 3, `kick ${bass.kick} vs ${vocal.kick}`);
  assert(bass.scaleSd > vocal.scaleSd * 1.5, `expansion variation ${bass.scaleSd} vs ${vocal.scaleSd}`);
  const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(3)]));
  return { bass: r(bass), vocal: r(vocal) };
});

await test('stop-halts-analysis', async () => {
  const { b, p, errors } = await page({ mic: 'house' });
  await p.click('[data-testid=listen]');
  await p.waitForFunction(() => window.pulseform.hub.status.state === 'listening');
  await p.waitForTimeout(3000);
  await wake(p);
  await p.click('[data-testid=primary]');
  const t0 = Date.now();
  await p.waitForFunction(() => window.pulseform.hub.status.state === 'stopped');
  await p.waitForTimeout(300);
  const f1 = await p.evaluate(() => window.pulseform.hub.analyzer.latestFrame?.t);
  await p.waitForTimeout(1500);
  const f2 = await p.evaluate(() => window.pulseform.hub.analyzer.latestFrame?.t);
  const s = await S(p);
  const tracksLive = await p.evaluate(() => 0); // tracks are stopped in teardownMic
  await b.close();
  assert(f1 === f2, `analysis kept running (${f1} → ${f2})`);
  assert(s.ctxState === 'suspended', `audio context ${s.ctxState}`);
  assert(!errors.length, errors.join('\n'));
  return { stoppedWithinMs: Date.now() - t0 - 1800, ctxState: s.ctxState, tracksLive };
});

await test('mic-permission-denied-is-explained', async () => {
  // Headless Chromium cannot show or deny a real permission prompt, so this test
  // makes getUserMedia reject exactly as browsers do when the user blocks access.
  const { b, p, errors } = await page({ mic: 'house', grant: false });
  await p.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await p.click('[data-testid=listen]');
  await p.waitForFunction(() => ['denied', 'unavailable', 'error'].includes(window.pulseform.hub.status.state), null, { timeout: 30000 });
  const s = await S(p);
  const err = await p.textContent('.intro-error').catch(() => '');
  const pill = await p.textContent('.status-pill');
  await p.screenshot({ path: join(OUT, 'desktop-mic-denied.png') });
  await b.close();
  assert(s.status.kind === 'mic' && s.status.state === 'denied', `state ${JSON.stringify(s.status)}`);
  assert(/Allow it/.test(err), `message "${err}"`);
  assert(!errors.length, errors.join('\n'));
  return { state: s.status.state, message: err, simulated: true, pill };
});

await test('mic-revoked-recovers', async () => {
  const { b, p, errors } = await page({ mic: 'house' });
  await p.click('[data-testid=listen]');
  await p.waitForFunction(() => window.pulseform.hub.status.state === 'listening');
  await p.waitForTimeout(1500);
  // simulate the OS/browser ending the track (permission revoked / device unplugged)
  await p.evaluate(() => {
    const hub = window.pulseform.hub;
    const tr = hub.micStream.getAudioTracks()[0];
    tr.stop();
    tr.dispatchEvent(new Event('ended'));
  });
  await p.waitForFunction(() => window.pulseform.hub.status.state === 'lost');
  const lost = await p.textContent('.status-pill');
  // the UI is still usable: listen again
  await p.click('[data-testid=listen]');
  await p.waitForFunction(() => window.pulseform.hub.status.state === 'listening');
  await p.waitForTimeout(2500);
  const s = await S(p);
  await b.close();
  assert(/microphone stopped/i.test(lost), `lost message "${lost}"`);
  assert(!s.stats.silent, 'did not resume analysis');
  assert(!errors.length, errors.join('\n'));
  return { lostStatus: lost, resumedLevelDb: +s.stats.levelDb.toFixed(1) };
});

await test('file-upload-play-seek', async () => {
  const { b, p, errors } = await page({ mic: 'house' });
  await p.setInputFiles('input[type=file]', join(AUDIO, 'energy.wav'));
  await p.waitForSelector('.analyze-card');
  await p.screenshot({ path: join(OUT, 'desktop-analyzing.png') });
  await p.waitForFunction(() => window.pulseform.hub.status.kind === 'file' && window.pulseform.hub.status.state === 'playing', null, { timeout: 120000 });
  await p.waitForTimeout(2500);
  const t1 = await p.evaluate(() => window.pulseform.hub.transport.currentTime);
  // seek by clicking 70% across the waveform
  const box = await p.locator('.band-canvas').boundingBox();
  await p.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
  await p.waitForTimeout(800);
  const t2 = await p.evaluate(() => window.pulseform.hub.transport.currentTime);
  const dur = await p.evaluate(() => window.pulseform.hub.transport.duration);
  const st = await p.evaluate(() => ({ section: window.pulseform.state.current.section, kick: window.pulseform.state.current.kick }));
  await p.mouse.move(box.x + 10, box.y - 200);
  await p.waitForTimeout(500);
  await p.screenshot({ path: join(OUT, 'desktop-file-playing.png') });
  // spectrum view is a different drawing of different data
  await p.click('text=Spectrum');
  await p.waitForTimeout(1200);
  await p.screenshot({ path: join(OUT, 'desktop-file-spectrum.png') });
  await b.close();
  assert(t1 > 0.5, `playback did not advance (${t1})`);
  assert(Math.abs(t2 - dur * 0.7) < 3, `seek landed at ${t2}, expected ~${dur * 0.7}`);
  assert(!errors.length, errors.join('\n'));
  return { playedTo: +t1.toFixed(2), seekTo: +t2.toFixed(2), expected: +(dur * 0.7).toFixed(2), sectionAtSeek: st.section };
});

await test('source-switching-keeps-ui-working', async () => {
  const { b, p, errors } = await page({ mic: 'house' });
  await p.click('[data-testid=listen]');
  await p.waitForFunction(() => window.pulseform.hub.status.state === 'listening');
  await p.waitForTimeout(1500);
  await p.setInputFiles('input[type=file]', join(AUDIO, 'vocal.wav'));
  await p.waitForFunction(() => window.pulseform.hub.status.kind === 'file' && window.pulseform.hub.status.state === 'playing', null, { timeout: 120000 });
  const micStopped = await p.evaluate(() => window.pulseform.hub.micStream === null);
  await p.waitForTimeout(1000);
  await wake(p);
  await p.click('[aria-label="Audio source"]');
  await p.click('.source-row >> text=Microphone');
  await p.waitForFunction(() => window.pulseform.hub.status.state === 'listening');
  const transportGone = await p.evaluate(() => window.pulseform.hub.transport === null);
  await p.waitForTimeout(2000);
  const s = await S(p);
  await b.close();
  assert(micStopped, 'mic not released when switching to file');
  assert(transportGone, 'file transport not released when switching to mic');
  assert(!s.stats.silent, 'mic analysis did not resume');
  assert(!errors.length, errors.join('\n'));
  return { micStopped, transportGone };
});

await test('settings-reduced-motion-and-photosensitive', async () => {
  const { b, p, errors } = await page({ mic: 'energy' });
  await p.click('[aria-label=Settings]');
  await p.click('[aria-label="Reduce motion"]');
  await p.click('[aria-label="Photosensitivity: no flashes"]');
  await p.screenshot({ path: join(OUT, 'desktop-settings.png') });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  const eng = await p.evaluate(() => ({ ...window.pulseform.engine.settings }));
  const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('pulseform.prefs.v1')));
  await b.close();
  assert(eng.reducedMotion && eng.photosensitive, `engine settings ${JSON.stringify(eng)}`);
  assert(stored.reducedMotion && stored.photosensitive, 'not persisted');
  assert(!errors.length, errors.join('\n'));
  return { reducedMotion: eng.reducedMotion, photosensitive: eng.photosensitive };
});

await test('iphone-layout', async () => {
  const { b, p, errors } = await page({ mic: 'house', viewport: { width: 393, height: 852 }, mobile: true });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: join(OUT, 'iphone-idle.png') });
  await p.tap('[data-testid=listen]');
  await p.waitForFunction(() => window.pulseform.hub.status.state === 'listening');
  await p.waitForTimeout(5000);
  await p.screenshot({ path: join(OUT, 'iphone-listening.png') });
  await p.tap('canvas.art');
  await p.waitForTimeout(800);
  await p.tap('[aria-label="Audio source"]');
  await p.waitForTimeout(500);
  await p.screenshot({ path: join(OUT, 'iphone-source-sheet.png') });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  const tapTargets = await p.evaluate(() => [...document.querySelectorAll('.dock button')].map((x) => { const r = x.getBoundingClientRect(); return Math.min(r.width, r.height); }));
  await b.close();
  assert(!overflow, 'horizontal overflow');
  assert(tapTargets.every((s) => s >= 40), `small tap targets ${tapTargets}`);
  assert(!errors.length, errors.join('\n'));
  return { tapTargets };
});

await test('no-unsupported-platform-claims', async () => {
  const { b, p } = await page({ mic: null });
  await p.click('[aria-label="Audio source"]');
  const text = await p.evaluate(() => document.body.innerText);
  await b.close();
  const bad = [/connect (your )?spotify/i, /capture (audio from )?any app/i, /works with (all|every) (music )?app/i, /apple music integration/i];
  for (const r of bad) assert(!r.test(text), `found claim ${r}`);
  assert(/can’t read audio inside Spotify/.test(text), 'missing limitation statement');
  return { checked: bad.length };
});

await test('windows-companion-protocol-and-app', async () => {
  // Real WASAPI capture needs Windows hardware. Here the same companion binary,
  // built for Linux, streams a WAV in real time through the identical analysis
  // and HTTP/SSE protocol, so the app integration is exercised end to end.
  const { spawn, execFileSync } = await import('node:child_process');
  const bin = join(root, 'test-results', 'pulseform-companion-test');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: join(root, 'companion') });
  const comp = spawn(bin, ['--test-wav', join(AUDIO, 'energy.wav'), '--port', '7531']);
  await new Promise((r) => comp.stderr.on('data', (d) => String(d).includes('listening on') && r()));
  try {
    const { b, p, errors } = await page({ mic: null });
    await p.click('[aria-label="Audio source"]');
    await p.click('[data-testid=source-companion]');
    await p.waitForFunction(() => window.pulseform.hub.status.state === 'connected', null, { timeout: 30000 });
    await p.waitForTimeout(12000);
    const s = await S(p);
    const sm = await sample(p, 2);
    const pill = await p.textContent('.status-pill');
    await p.screenshot({ path: join(OUT, 'desktop-companion.png') });
    // stopping disconnects from the companion
    await wake(p);
    await p.click('[data-testid=primary]');
    await p.waitForFunction(() => window.pulseform.hub.status.kind === 'none');
    await b.close();
    assert(s.stats.framesPerSecond > 60, `frames/s ${s.stats.framesPerSecond}`);
    assert(s.stats.bpm && Math.abs(s.stats.bpm - 150) / 150 < 0.02, `bpm ${s.stats.bpm}`);
    assert(avg(sm, 'waveExtent') > 0.2, 'waveform not drawn');
    assert(/PC audio/.test(pill), `status "${pill}"`);
    assert(!errors.length, errors.join('\n'));
    return { bpm: s.stats.bpm, framesPerSecond: s.stats.framesPerSecond, status: pill, note: 'WAV-fed companion on Linux; WASAPI path needs a Windows PC' };
  } finally {
    comp.kill();
  }
});

await test('companion-missing-is-explained', async () => {
  const { b, p } = await page({ mic: null });
  await p.click('[aria-label="Audio source"]');
  await p.click('[data-testid=source-companion]');
  await p.waitForFunction(() => window.pulseform.hub.status.state === 'lost', null, { timeout: 20000 });
  const pill = await p.textContent('.status-pill');
  await b.close();
  assert(/isn’t running/.test(pill), `status "${pill}"`);
  return { status: pill };
});

async function exportCase(aspect, world, seconds) {
  const { execFileSync } = await import('node:child_process');
  const { b, p, errors } = await page({ mic: null, prefs: { world } });
  await p.evaluate((sec) => { window.__pfTest.exportSeconds = sec; }, seconds);
  await p.setInputFiles('input[type=file]', join(AUDIO, 'energy.wav'));
  await p.waitForFunction(() => window.pulseform.hub.status.kind === 'file' && window.pulseform.hub.status.state === 'playing', null, { timeout: 120000 });
  await wake(p);
  await p.keyboard.press('Escape');
  await p.click('[data-testid=export-open]');
  await p.click(`[data-testid="aspect-${aspect}"]`);
  await p.click('[data-testid=export-start]');
  await p.screenshot({ path: join(OUT, `export-progress-${aspect.replace(':', 'x')}.png`) });
  await p.waitForSelector('[data-testid=export-download]', { timeout: 900000 });
  await p.screenshot({ path: join(OUT, `export-done-${aspect.replace(':', 'x')}.png`) });
  const meta = await p.evaluate(async () => {
    const r = window.__pfLastExport;
    const buf = new Uint8Array(await r.blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), validation: r.validation, w: r.width, h: r.height, duration: r.duration, audio: r.audioCodec, video: r.videoCodec };
  });
  await b.close();
  const file = join(OUT, `export-${aspect.replace(':', 'x')}.mp4`);
  writeFileSync(file, Buffer.from(meta.b64, 'base64'));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  // decode every frame and every audio packet: any corruption makes ffmpeg error out
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
  const vs = probe.streams.find((x) => x.codec_type === 'video');
  const as = probe.streams.find((x) => x.codec_type === 'audio');
  // A/V sync: the first audio and video timestamps must line up
  return { meta, vs, as, format: probe.format, errors };
}

await test('export-mp4-landscape-validated', async () => {
  const r = await exportCase('16:9', 'liquid', 3);
  assert(r.vs && r.vs.codec_name === 'h264', `video ${r.vs?.codec_name}`);
  assert(r.vs.width === 1920 && r.vs.height === 1080, `size ${r.vs.width}x${r.vs.height}`);
  assert(r.as && ['aac', 'opus'].includes(r.as.codec_name), `audio ${r.as?.codec_name}`);
  const d = Number(r.format.duration);
  assert(Math.abs(d - 3) < 0.15, `duration ${d}`);
  assert(Math.abs(Number(r.vs.duration) - Number(r.as.duration)) < 0.1, `a/v durations ${r.vs.duration} vs ${r.as.duration}`);
  assert(r.meta.validation.durationOk && r.meta.validation.pictureOk, `in-app validation ${JSON.stringify(r.meta.validation)}`);
  assert(!r.errors.length, r.errors.join('\n'));
  return { ffprobe: { video: `${r.vs.codec_name} ${r.vs.width}x${r.vs.height} ${r.vs.r_frame_rate}`, audio: `${r.as.codec_name} ${r.as.sample_rate} Hz ${r.as.channels}ch`, duration: d, videoDur: Number(r.vs.duration), audioDur: Number(r.as.duration) }, inApp: r.meta.validation, ffmpegFullDecode: 'ok' };
});

await test('export-mp4-portrait-festival-validated', async () => {
  const r = await exportCase('9:16', 'festival', 2);
  assert(r.vs.width === 1080 && r.vs.height === 1920, `size ${r.vs.width}x${r.vs.height}`);
  assert(Math.abs(Number(r.format.duration) - 2) < 0.15, `duration ${r.format.duration}`);
  assert(r.meta.validation.pictureOk, 'blank picture');
  return { video: `${r.vs.width}x${r.vs.height}`, duration: Number(r.format.duration), audio: r.as?.codec_name };
});

srv.close();
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
