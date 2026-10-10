// K8 (test/nexus-exec-sandbox.test.cjs): run with `node -e` inside an APPROVED install container. Every destination is
// tried directly (the install must have no route out) and through the Nexus egress proxy (which must refuse each one).
// __PORT__ is the host test server's port (on the host's 127.0.0.1). One `name: result` line per probe.
const net = require('net');
const dns = require('dns');
const direct = (host, port) => new Promise((r) => {
  const s = net.connect({ host, port, timeout: 4000 }, () => { s.destroy(); r('connected'); });
  s.on('error', (e) => r(`fail ${e.code}`));
  s.on('timeout', () => { s.destroy(); r('fail timeout'); });
});
const viaProxy = (head) => new Promise((r) => {
  const s = net.connect({ host: 'nexus-egress-proxy', port: 3128, timeout: 8000 }, () => s.write(head));
  let b = '';
  s.on('data', (d) => { b += d; });
  s.on('close', () => r(`${b.split('\r\n')[0]} | ${(/X-Nexus-Egress: (\S+)/.exec(b) || [])[1] || '-'}`));
  s.on('error', (e) => r(`proxy error ${e.code}`));
  s.on('timeout', () => { s.destroy(); r('proxy timeout'); });
});
const P = __PORT__;
const o = (k, v) => console.log(`${k}: ${v}`);
(async () => {
  o('direct host.docker.internal', await direct('host.docker.internal', P));
  o('direct host address', await direct('192.168.65.254', P));
  o('direct metadata', await direct('169.254.169.254', 80));
  o('direct ten', await direct('10.0.0.1', 80));
  o('direct lan', await direct('192.168.1.1', 80));
  // A documentation address (never routed on the internet): "anywhere else" without touching the internet.
  o('direct elsewhere', await direct('203.0.113.10', 443));
  o('proxy host.docker.internal', await viaProxy(`CONNECT host.docker.internal:${P} HTTP/1.1\r\nHost: x\r\n\r\n`));
  o('proxy host address', await viaProxy(`CONNECT 192.168.65.254:${P} HTTP/1.1\r\n\r\n`));
  o('proxy metadata', await viaProxy('CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n'));
  o('proxy ten', await viaProxy('CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n'));
  o('proxy lan', await viaProxy('CONNECT 192.168.1.1:443 HTTP/1.1\r\n\r\n'));
  o('proxy loopback v6', await viaProxy('CONNECT [::1]:443 HTTP/1.1\r\n\r\n'));
  o('proxy localhost', await viaProxy('CONNECT localhost:443 HTTP/1.1\r\n\r\n'));
  o('proxy plain http', await viaProxy(`GET http://host.docker.internal:${P}/x?q=1 HTTP/1.1\r\nHost: host.docker.internal\r\n\r\n`));
  // Refused on the port before any name is resolved: nothing reaches the internet.
  o('proxy registry port 80', await viaProxy('CONNECT registry.npmjs.org:80 HTTP/1.1\r\n\r\n'));
  dns.lookup('host.docker.internal', (e, a) => { o('dns host.docker.internal', e ? `fail ${e.code}` : a); process.exit(0); });
})();
