// Tiny static server for dist/ used by tests.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wav': 'audio/wav', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json', '.mp4': 'video/mp4' };
export function serve(dir, port = 0) {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const p = normalize(join(dir, url === '/' ? 'index.html' : url));
      if (!p.startsWith(dir)) { res.writeHead(403).end(); return; }
      try {
        const body = await readFile(p);
        res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }).end(body);
      } catch { res.writeHead(404).end('not found'); }
    });
    srv.listen(port, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}
