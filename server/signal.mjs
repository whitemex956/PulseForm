#!/usr/bin/env node
/**
 * PulseForm local session server (no dependencies).
 *
 *  - Serves the built app (dist/) so phones and TVs on the same network can open it.
 *  - Brokers pairing and WebRTC signalling. After pairing, devices talk directly
 *    over a WebRTC data channel; this server only relays if that fails.
 *  - Never receives audio. Only analysis numbers and control messages pass
 *    through, and only when the direct link is unavailable.
 *
 * Security model:
 *  - Hosts get a secret token. Guests join with a 6-digit code shown on the host
 *    (proves they can see the host's screen), or via discovery, which requires
 *    the host to approve the request on screen.
 *  - Codes expire after 5 minutes and lock after 10 wrong attempts per session.
 *  - Join attempts are rate-limited per IP.
 *  - All API calls (except create/discover/join) require a bearer token.
 *
 * Usage: node server/signal.mjs [--port 5173] [--cert cert.pem --key key.pem]
 */
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]] : a), []));
const PORT = Number(args.port ?? process.env.PORT ?? 5173);
const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', String(args.dist ?? 'dist')));
const CODE_TTL = 5 * 60_000;
const SESSION_IDLE = 12 * 3600_000;
const GONE_AFTER = 30_000;

/** @type {Map<string, any>} */
const sessions = new Map();
/** token -> { sessionId, peerId } */
const tokens = new Map();
const joinAttempts = new Map(); // ip -> timestamps

const id = (n = 16) => randomBytes(n).toString('hex');
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const now = () => Date.now();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 256_000) throw new Error('too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function auth(req, url) {
  const h = req.headers.authorization ?? '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') ?? '';
  const rec = tokens.get(t);
  if (!rec) return null;
  const s = sessions.get(rec.sessionId);
  if (!s) return null;
  s.lastActive = now();
  return { ...rec, session: s, token: t };
}

function deliver(session, peerId, msg) {
  const p = session.peers.get(peerId);
  if (!p) return false;
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  if (p.stream) p.stream.write(line);
  else p.queue.push(line);
  if (p.queue.length > 500) p.queue.splice(0, p.queue.length - 500);
  return true;
}

function broadcast(session, msg, except) {
  for (const pid of session.peers.keys()) if (pid !== except) deliver(session, pid, msg);
}

function publicPeers(session) {
  return [...session.peers.values()].filter((p) => p.approved).map((p) => ({ peerId: p.peerId, role: p.role, device: p.device, online: !!p.stream }));
}

function rateLimited(ip) {
  const list = (joinAttempts.get(ip) ?? []).filter((t) => now() - t < 60_000);
  list.push(now());
  joinAttempts.set(ip, list);
  return list.length > 12;
}

function codeMatches(a, b) {
  const x = Buffer.from(String(a).padEnd(6)), y = Buffer.from(String(b).padEnd(6));
  return x.length === y.length && timingSafeEqual(x, y);
}

const api = {
  /** Host creates a session. */
  'POST /api/session': async (req, res) => {
    const body = await readJson(req);
    const sessionId = id(8);
    const hostId = 'host';
    const token = id();
    const s = {
      sessionId,
      name: String(body.name ?? 'PulseForm').slice(0, 40),
      code: newCode(),
      codeAt: now(),
      wrong: 0,
      lastActive: now(),
      peers: new Map(),
    };
    s.peers.set(hostId, { peerId: hostId, role: 'host', device: String(body.device ?? 'desktop').slice(0, 30), approved: true, stream: null, queue: [], seen: now(), token });
    sessions.set(sessionId, s);
    tokens.set(token, { sessionId, peerId: hostId });
    json(res, 200, { sessionId, peerId: hostId, token, code: s.code, codeExpiresAt: s.codeAt + CODE_TTL, name: s.name });
  },

  /** Host gets a fresh code. */
  'POST /api/code': async (req, res, url) => {
    const a = auth(req, url);
    if (!a || a.peerId !== 'host') return json(res, 401, { error: 'unauthorized' });
    a.session.code = newCode();
    a.session.codeAt = now();
    a.session.wrong = 0;
    json(res, 200, { code: a.session.code, codeExpiresAt: a.session.codeAt + CODE_TTL });
  },

  /** Discovery: sessions on this server (names only, never codes). */
  'GET /api/sessions': async (_req, res) => {
    json(res, 200, { sessions: [...sessions.values()].filter((s) => s.peers.get('host')?.stream).map((s) => ({ sessionId: s.sessionId, name: s.name })) });
  },

  /** Guest joins with a code (auto-approved) or by session id (needs host approval). */
  'POST /api/join': async (req, res) => {
    const ip = req.socket.remoteAddress ?? '?';
    if (rateLimited(ip)) return json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
    const body = await readJson(req);
    const role = ['remote', 'display', 'viewer'].includes(body.role) ? body.role : 'remote';
    const device = String(body.device ?? 'device').slice(0, 30);
    let s = null;
    let approved = false;
    if (body.code) {
      for (const cand of sessions.values()) {
        if (now() - cand.codeAt < CODE_TTL && cand.wrong < 10 && codeMatches(cand.code, body.code)) {
          s = cand;
          approved = true;
          break;
        }
      }
      if (!s) {
        return json(res, 404, { error: 'That code didn’t match. Check the code on your desktop and try again.' });
      }
    } else if (body.sessionId && sessions.has(body.sessionId)) {
      s = sessions.get(body.sessionId);
    } else return json(res, 400, { error: 'Enter the 6-digit code shown on your desktop.' });

    const peerId = `${role}-${id(4)}`;
    const token = id();
    s.peers.set(peerId, { peerId, role, device, approved, stream: null, queue: [], seen: now(), token });
    tokens.set(token, { sessionId: s.sessionId, peerId });
    if (approved) broadcast(s, { type: 'peer-joined', peer: { peerId, role, device } }, peerId);
    else deliver(s, 'host', { type: 'join-request', peer: { peerId, role, device } });
    json(res, 200, { sessionId: s.sessionId, peerId, token, approved, name: s.name, peers: publicPeers(s) });
  },

  /** Host approves or rejects a discovery join. */
  'POST /api/approve': async (req, res, url) => {
    const a = auth(req, url);
    if (!a || a.peerId !== 'host') return json(res, 401, { error: 'unauthorized' });
    const body = await readJson(req);
    const p = a.session.peers.get(body.peerId);
    if (!p) return json(res, 404, { error: 'unknown peer' });
    if (body.allow) {
      p.approved = true;
      deliver(a.session, p.peerId, { type: 'approved', name: a.session.name });
      broadcast(a.session, { type: 'peer-joined', peer: { peerId: p.peerId, role: p.role, device: p.device } }, p.peerId);
    } else {
      deliver(a.session, p.peerId, { type: 'rejected' });
      a.session.peers.delete(p.peerId);
      tokens.delete(p.token);
    }
    json(res, 200, { ok: true });
  },

  /** Relay a message to a peer (WebRTC signalling, or data fallback). */
  'POST /api/send': async (req, res, url) => {
    const a = auth(req, url);
    if (!a) return json(res, 401, { error: 'unauthorized' });
    const me = a.session.peers.get(a.peerId);
    if (!me?.approved) return json(res, 403, { error: 'waiting for approval' });
    const body = await readJson(req);
    const target = a.session.peers.get(body.to);
    if (!target?.approved) return json(res, 404, { error: 'peer not connected' });
    deliver(a.session, body.to, { type: 'msg', from: a.peerId, data: body.data });
    json(res, 200, { ok: true });
  },

  'POST /api/leave': async (req, res, url) => {
    const a = auth(req, url);
    if (!a) return json(res, 200, { ok: true });
    a.session.peers.get(a.peerId)?.stream?.end();
    a.session.peers.delete(a.peerId);
    tokens.delete(a.token);
    if (a.peerId === 'host') {
      broadcast(a.session, { type: 'session-ended' });
      for (const p of a.session.peers.values()) tokens.delete(p.token);
      sessions.delete(a.session.sessionId);
    } else broadcast(a.session, { type: 'peer-left', peerId: a.peerId });
    json(res, 200, { ok: true });
  },

  /** Server-Sent Events stream for one participant. */
  'GET /api/events': async (req, res, url) => {
    const a = auth(req, url);
    if (!a) return json(res, 401, { error: 'Session not found. Pair again.' });
    const p = a.session.peers.get(a.peerId);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 1500\n\n`);
    if (p.stream) p.stream.end();
    p.stream = res;
    p.seen = now();
    res.write(`data: ${JSON.stringify({ type: 'hello', peerId: a.peerId, approved: p.approved, name: a.session.name, peers: publicPeers(a.session) })}\n\n`);
    for (const line of p.queue.splice(0)) res.write(line);
    if (p.approved) broadcast(a.session, { type: 'peer-online', peerId: a.peerId, role: p.role, device: p.device }, a.peerId);
    const beat = setInterval(() => res.write(`: hb ${now()}\n\n`), 15_000);
    req.on('close', () => {
      clearInterval(beat);
      if (p.stream === res) {
        p.stream = null;
        p.seen = now();
        if (sessions.has(a.session.sessionId) && p.approved) broadcast(a.session, { type: 'peer-offline', peerId: a.peerId }, a.peerId);
      }
    });
  },

  /** Clock reference for coarse sync before the data channel is up. */
  'GET /api/time': async (_req, res) => json(res, 200, { t: now() }),

  /** LAN addresses so the host can build a QR code phones can reach. */
  'GET /api/addresses': async (req, res) => {
    const out = [];
    for (const list of Object.values(networkInterfaces())) for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    json(res, 200, { addresses: out, port: PORT, secure: !!server.cert, host: req.headers.host });
  },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json' };

async function handler(req, res) {
  const url = new URL(req.url ?? '/', 'http://x');
  const key = `${req.method} ${url.pathname}`;
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  try {
    if (api[key]) return await api[key](req, res, url);
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' });
    const p = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!p.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
    let body;
    let file = p;
    try {
      body = await readFile(file);
    } catch {
      file = join(ROOT, 'index.html');
      body = await readFile(file);
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=60' });
    res.end(body);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) });
  }
}

let server;
if (args.cert && args.key) {
  server = createHttps({ cert: readFileSync(args.cert), key: readFileSync(args.key) }, handler);
  server.cert = true;
} else server = createHttp(handler);

// expire idle sessions and long-gone peers
setInterval(() => {
  for (const s of sessions.values()) {
    if (now() - s.lastActive > SESSION_IDLE) {
      for (const p of s.peers.values()) tokens.delete(p.token);
      sessions.delete(s.sessionId);
      continue;
    }
    for (const p of s.peers.values()) {
      if (p.peerId !== 'host' && !p.stream && now() - p.seen > GONE_AFTER * 20) {
        s.peers.delete(p.peerId);
        tokens.delete(p.token);
        broadcast(s, { type: 'peer-left', peerId: p.peerId });
      }
    }
  }
}, 10_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  const addrs = [];
  for (const list of Object.values(networkInterfaces())) for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal) addrs.push(n.address);
  const scheme = server.cert ? 'https' : 'http';
  console.log(`PulseForm session server on ${scheme}://localhost:${PORT}`);
  for (const a of addrs) console.log(`  on your network: ${scheme}://${a}:${PORT}`);
  if (!server.cert) console.log('  Note: iPhone microphone needs https. Remote control and display work over http.');
});

export { server, sessions };
