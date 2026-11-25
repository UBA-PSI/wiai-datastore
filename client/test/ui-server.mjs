// A real HTTP server around the in-memory fake of the datastore API (fake-server.mjs), for browser tests.
// It adds what the real deployment adds around the API: CORS headers (PROTOCOL.md 8.8) and static library files
// under /datastore/client/ (with CORS, so a file:// page can load them with SRI).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorld } from './fake-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIST = join(HERE, '..', 'test-results', 'bundle'); // the pinless test build (global-setup.mjs), not dist/

export async function startWorld(opts = {}) {
  let world = null;
  const web = http.createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag, Retry-After, WDS-Commit',
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, Object.assign({}, cors, {
          'access-control-allow-methods': 'GET, PUT, POST, DELETE',
          'access-control-allow-headers': 'Authorization, Content-Type, If-Match, If-None-Match, WDS-Commit', 'access-control-max-age': '600',
        }));
        res.end();
        return;
      }
      const lib = /^\/datastore\/client\/(wds-[0-9.]+\.js(?:\.sri)?)$/.exec(url.pathname);
      if (lib) {
        const file = join(DIST, lib[1]);
        if (!existsSync(file)) { res.writeHead(404, cors); res.end('not found'); return; }
        res.writeHead(200, Object.assign({}, cors, { 'content-type': 'text/javascript; charset=utf-8', 'cross-origin-resource-policy': 'cross-origin' }));
        res.end(readFileSync(file));
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const r = await world.server.fetch('http://127.0.0.1:' + port + req.url, { method: req.method, headers, body });
      const out = Buffer.from(await r.arrayBuffer());
      const h = Object.assign({}, cors);
      r.headers.forEach((v, k) => { h[k] = v; });
      h['access-control-expose-headers'] = cors['access-control-expose-headers'];
      res.writeHead(r.status, h);
      res.end(out);
    } catch (e) {
      res.writeHead(500, cors);
      res.end(String(e && e.stack || e));
    }
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const port = web.address().port;
  const service = 'http://127.0.0.1:' + port + '/datastore/';
  world = await makeWorld(Object.assign({}, opts, { server: Object.assign({ service }, opts.server || {}) }));
  return {
    world, port, service, scope: world.scope, pins: world.pins,
    close: () => new Promise((r) => { web.closeAllConnections && web.closeAllConnections(); web.close(() => r()); }),
  };
}
