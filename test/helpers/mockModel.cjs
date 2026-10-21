'use strict';
// A loopback mock of a Messages-style model API, for the agent harness (B2b Task 0).
// It listens on 127.0.0.1 only, over plain HTTP, and never forwards anything anywhere.
//
// Every request is recorded whole: { method, path, headers, body (parsed JSON or null), raw, at }.
// The body keeps the system prompt, the tool list and the messages exactly as the client sent them.
//
// POST <anything>/messages answers from the script:
//   script: (body, step) => Block[] | { content: Block[], stopReason?: string }
//   where step = the number of assistant messages already in body.messages (stateless, so a client
//   retry gets the same answer), and a Block is { type: 'text', text } or
//   { type: 'tool_use', name, input } (an id is added). Returning null ends the turn with 'done'.
// Requests that carry no tools (side calls such as titles or quota checks) get a short text reply
// unless `sideScript(body)` says otherwise. stream: true gets server-sent events; otherwise JSON.
// POST <anything>/count_tokens answers { input_tokens }. Anything else gets 404 and is recorded.
const http = require('node:http');

let seq = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36).padStart(4, '0')}`;

function normalize(answer) {
  if (answer == null) return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' };
  const content = (Array.isArray(answer) ? answer : answer.content).map((b) =>
    b.type === 'tool_use' ? { type: 'tool_use', id: b.id ?? nextId('toolu'), name: b.name, input: b.input ?? {} } : { type: 'text', text: String(b.text ?? '') });
  const stopReason = (!Array.isArray(answer) && answer.stopReason) || (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  return { content, stopReason };
}

function assistantSteps(body) {
  return Array.isArray(body?.messages) ? body.messages.filter((m) => m && m.role === 'assistant').length : 0;
}

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

function reply(res, body, answer, usage) {
  const id = nextId('msg');
  const model = typeof body?.model === 'string' ? body.model : 'mock-model';
  const { content, stopReason } = answer;
  const u = { input_tokens: usage.input, output_tokens: usage.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!body?.stream) {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': nextId('req') });
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content, stop_reason: stopReason, stop_sequence: null, usage: u }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': nextId('req') });
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...u, output_tokens: 1 } } });
  content.forEach((b, index) => {
    if (b.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/**
 * start({ script?, sideScript?, usage? }) -> Promise<{ url, port, requests, messageRequests(), toolRequests(), setScript(fn), stop() }>
 * `url` is the base URL to give the client (http://127.0.0.1:<port>).
 */
function start(opts = {}) {
  let script = opts.script ?? (() => null);
  const sideScript = opts.sideScript ?? (() => [{ type: 'text', text: 'ok' }]);
  const usage = { input: 12, output: 7, ...(opts.usage ?? {}) };
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const path = (req.url ?? '').split('?')[0];
      requests.push({ method: req.method, path, headers: { ...req.headers }, body, raw, at: Date.now() });
      if (req.method === 'POST' && /\/count_tokens$/.test(path)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
        return;
      }
      if (req.method === 'POST' && /\/messages$/.test(path) && body) {
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
        let answer;
        try { answer = normalize(hasTools ? script(body, assistantSteps(body)) : sideScript(body)); } catch (e) {
          answer = normalize([{ type: 'text', text: `mock script error: ${e.message}` }]);
        }
        reply(res, body, answer, usage);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock: no such route' } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        /** Requests to the messages route, in order. */
        messageRequests: () => requests.filter((r) => r.method === 'POST' && /\/messages$/.test(r.path) && r.body),
        /** Messages requests that carried a tool list (the agent loop, not side calls). */
        toolRequests: () => requests.filter((r) => r.method === 'POST' && /\/messages$/.test(r.path) && Array.isArray(r.body?.tools) && r.body.tools.length > 0),
        setScript: (fn) => { script = fn; },
        stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); })
      });
    });
  });
}

/** The system prompt of a recorded body as one string (string or block-array form). */
function systemText(body) {
  const s = body?.system;
  if (typeof s === 'string') return s;
  if (Array.isArray(s)) return s.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  return '';
}

/** The tool names of a recorded body. */
function toolNames(body) { return Array.isArray(body?.tools) ? body.tools.map((t) => t?.name).filter(Boolean) : []; }

/** Every tool_result block in a recorded body: { toolUseId, isError, text }. */
function toolResults(body) {
  const out = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type !== 'tool_result') continue;
      const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text ?? '').join('\n') : '';
      out.push({ toolUseId: b.tool_use_id, isError: b.is_error === true, text });
    }
  }
  return out;
}

module.exports = { start, systemText, toolNames, toolResults };
