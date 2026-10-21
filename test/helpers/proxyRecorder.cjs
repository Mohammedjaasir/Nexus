'use strict';
// A loopback HTTP proxy that refuses everything and records what was asked (B2b Task 0).
// It listens on 127.0.0.1 only. It never resolves a name, never opens an outbound socket and never
// forwards a byte, so nothing that reaches it can leave the machine.
//
//   CONNECT host:port          -> recorded in `connects`, answered 403, socket closed
//   GET http://host/... (etc.) -> recorded in `requests`, answered 403
//
// mode 'deny-all' and mode 'recorder' behave the same (both refuse and record); the mode is kept so
// a caller's intent reads in its logs.
const http = require('node:http');

function splitHostPort(target) {
  const m = /^\[?([^\]]*?)\]?:(\d+)$/.exec(String(target ?? ''));
  return m ? { host: m[1].toLowerCase(), port: Number(m[2]) } : { host: String(target ?? '').toLowerCase(), port: null };
}

/** start({ mode }) -> Promise<{ url, port, mode, connects, requests, hosts(), stop() }> */
function start(opts = {}) {
  const mode = opts.mode === 'recorder' ? 'recorder' : 'deny-all';
  const connects = [];
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let host = null;
    try { host = new URL(req.url).host.toLowerCase(); } catch { host = String(req.headers.host ?? '').toLowerCase() || null; }
    requests.push({ method: req.method, url: req.url, host, at: Date.now() });
    res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
    res.end('refused by the recording proxy\n');
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('connect', (req, socket) => {
    connects.push({ target: req.url, ...splitHostPort(req.url), at: Date.now() });
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch {} });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        mode,
        connects,
        requests,
        /** Distinct `host:port` strings asked for, by CONNECT or by absolute-URI request. */
        hosts: () => [...new Set([...connects.map((c) => `${c.host}:${c.port}`), ...requests.filter((r) => r.host).map((r) => r.host)])],
        stop: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); })
      });
    });
  });
}

module.exports = { start, splitHostPort };
