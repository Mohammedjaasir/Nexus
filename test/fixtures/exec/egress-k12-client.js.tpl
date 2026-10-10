// K12 (test/nexus-exec-sandbox.test.cjs): run with `node -e` inside an install container planned as main plans it, while
// the proxy carries a TEST-ONLY allow-list (a pinned entry to a local test server; a name Docker resolves to a private
// address). Real TLS ClientHellos (node's own client, captured on the container's loopback) are sent through the tunnel.
// __IP__ is the test server's address on the job's outbound bridge. One `name: result` line per probe.
const net = require('net');
const tls = require('tls');
const direct = (host, port) => new Promise((r) => {
  const s = net.connect({ host, port, timeout: 4000 }, () => { s.destroy(); r('connected'); });
  s.on('error', (e) => r(`fail ${e.code}`));
  s.on('timeout', () => { s.destroy(); r('fail timeout'); });
});
const hello = (name) => new Promise((r) => {
  const srv = net.createServer((s) => s.once('data', (d) => { r(d); s.destroy(); srv.close(); }));
  srv.listen(0, '127.0.0.1', () => {
    const t = tls.connect({ host: '127.0.0.1', port: srv.address().port, servername: name, rejectUnauthorized: false });
    t.on('error', () => {});
  });
});
const tunnel = (target, sni) => new Promise(async (r) => {
  const h = await hello(sni);
  const s = net.connect({ host: 'nexus-egress-proxy', port: 3128 });
  let b = Buffer.alloc(0); let sent = false;
  s.on('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  s.on('data', (d) => {
    b = Buffer.concat([b, d]);
    if (!sent && b.includes('\r\n\r\n')) { sent = true; if (/^HTTP\/1\.1 200/.test(b.toString())) s.write(h); }
  });
  // The proxy's answer, then whatever the server sent through the tunnel: `<status line> / <payload>`.
  s.on('close', () => r(b.toString('latin1').split('\r\n\r\n').map((x) => x.trim()).filter(Boolean).join(' / ')));
  s.on('error', (e) => r(`error ${e.code}`));
  setTimeout(() => s.destroy(), 10000);
});
const o = (k, v) => console.log(`${k}: ${v}`);
(async () => {
  o('allowed', await tunnel('nexus-test-registry.invalid:8443', 'nexus-test-registry.invalid'));
  o('private', await tunnel('nexus-k12-private.invalid:8443', 'nexus-k12-private.invalid'));
  o('sni', await tunnel('nexus-test-registry.invalid:8443', 'evil.example'));
  o('bypass address', await direct('__IP__', 8443));
  o('bypass name', await direct('nexus-k12-private.invalid', 8443));
  process.exit(0);
})();
