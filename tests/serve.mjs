// Minimal static server: `npm start` then open http://<your-computer-ip>:8000 on your phone.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
export function serve(port = 8000) {
  const srv = http.createServer(async (req, res) => {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';
    if (p.includes('..') || p.startsWith('node_modules')) { res.writeHead(403).end(); return; }
    try { const body = await readFile(join(root, p)); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404).end('not found'); }
  });
  return new Promise(r => srv.listen(port, '0.0.0.0', () => r(srv)));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = +process.env.PORT || 8000;
  serve(port).then(() => console.log(`StreamLine on http://localhost:${port}`));
}
