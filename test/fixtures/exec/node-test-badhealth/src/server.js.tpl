'use strict';
// The dev deployment's app: listens on the manifest's port inside its container (the forwarder reaches it as app:3000).
const http = require('node:http');
const { route } = require('./handler');
const PORT = 3000;
http.createServer((req, res) => {
  const r = route(new URL(req.url, 'http://app').pathname);
  res.writeHead(r.status, { 'content-type': r.type });
  res.end(r.body);
}).listen(PORT, '0.0.0.0', () => { console.log(`node-test-app listening on ${PORT}`); });
