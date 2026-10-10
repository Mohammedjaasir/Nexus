'use strict';
// The app's routes as a pure function (the tests call it without a network).
function route(path) {
  if (path === '/health') return { status: 200, type: 'application/json', body: JSON.stringify({ ok: true }) };
  if (path === '/') return { status: 200, type: 'text/html', body: '<!doctype html><title>node-test-app</title><p>hello from node-test-app</p>' };
  return { status: 404, type: 'text/plain', body: 'not found' };
}
module.exports = { route };
