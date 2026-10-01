/**
 * Ollama Model Provider integration service.
 *
 * Provides health checks, dynamic model discovery, connection testing,
 * and OpenAI-compatible endpoint resolution for local Ollama instances.
 */

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_OPENAI_URL = 'http://127.0.0.1:11434/v1';

export interface OllamaModelInfo {
  name: string;
  model: string;
  size: number;
  digest: string;
  modified_at: string;
}

export interface OllamaStatusResult {
  running: boolean;
  version?: string;
  error?: string;
}

export interface OllamaModelsResult {
  ok: boolean;
  models: OllamaModelInfo[];
  error?: string;
}

export interface OllamaTestResult {
  ok: boolean;
  latencyMs?: number;
  response?: string;
  error?: string;
  tokens?: {
    prompt_eval_count?: number;
    eval_count?: number;
  };
}

function normalizeOllamaHost(host?: string): string {
  const raw = (host || DEFAULT_OLLAMA_HOST).trim();
  // Strip trailing slashes and /v1 if user passed the OpenAI url
  return raw.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
}

/**
 * Health check: verify if Ollama server is running and fetch its version.
 */
export async function checkOllamaStatus(host?: string): Promise<OllamaStatusResult> {
  const base = normalizeOllamaHost(host);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${base}/api/version`, {
      method: 'GET',
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      return {
        running: false,
        error: `Ollama returned HTTP ${res.status} ${res.statusText}`
      };
    }

    const data = (await res.json()) as { version?: string };
    return {
      running: true,
      version: data.version || 'unknown'
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[DIAGNOSTIC: ollama.ts] checkOllamaStatus failed for', base, 'Error:', err);
    return {
      running: false,
      error: message.includes('abort')
        ? 'Connection timed out (is Ollama running?)'
        : `Cannot connect to Ollama at ${base} (${message})`
    };
  }
}

/**
 * Dynamic model discovery: lists all locally installed models from /api/tags.
 */
export async function listOllamaModels(host?: string): Promise<OllamaModelsResult> {
  const base = normalizeOllamaHost(host);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${base}/api/tags`, {
      method: 'GET',
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      return {
        ok: false,
        models: [],
        error: `Failed to fetch models: HTTP ${res.status}`
      };
    }

    const data = (await res.json()) as { models?: OllamaModelInfo[] };
    const models = Array.isArray(data.models) ? data.models : [];
    return {
      ok: true,
      models
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      models: [],
      error: `Failed to list models: ${message}`
    };
  }
}

/**
 * Connection test: sends a lightweight non-streaming prompt to verify inference and measure latency.
 */
export async function testOllamaConnection(
  model: string,
  host?: string
): Promise<OllamaTestResult> {
  const base = normalizeOllamaHost(host);
  const targetModel = model.replace(/^local\//i, '').replace(/^ollama\//i, '').trim();

  if (!targetModel) {
    return { ok: false, error: 'No model specified for test' };
  }

  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: targetModel,
        prompt: 'Say "Ollama ready" in two words.',
        stream: false
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    const latencyMs = Date.now() - startTime;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        latencyMs,
        error: `Inference failed (HTTP ${res.status}): ${body || res.statusText}`
      };
    }

    const data = (await res.json()) as {
      response?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    return {
      ok: true,
      latencyMs,
      response: data.response?.trim(),
      tokens: {
        prompt_eval_count: data.prompt_eval_count,
        eval_count: data.eval_count
      }
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      latencyMs,
      error: message.includes('abort') ? 'Inference request timed out' : message
    };
  }
}

import http from 'node:http';
import { resolve } from 'node:path';

const PLACEHOLDER_PREFIX_RE = /^([a-zA-Z]:)?[/\\\\]*(?:path[/\\\\]+to[/\\\\]+(?:current[/\\\\]+)?(?:project[/\\\\]+|workspace[/\\\\]+)?|current[/\\\\]+project[/\\\\]+|(?:project|workspace)[/\\\\]+|path[/\\\\]+to[/\\\\]+)/i;
const EMBEDDED_PLACEHOLDER_RE = /[/\\\\]+path[/\\\\]+to[/\\\\]+(?:current[/\\\\]+)?(?:project|workspace)?[/\\\\]+/i;

export function resolveOllamaWorkspacePath(raw: string, workspace: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return raw;
  let p = raw.trim().replace(/^["']|["']$/g, '');

  // 1. If it has a placeholder prefix (e.g. /path/to/current/project/foo, /workspace/foo, /project/foo, /path/to/foo)
  if (PLACEHOLDER_PREFIX_RE.test(p)) {
    const rel = p.replace(PLACEHOLDER_PREFIX_RE, '');
    return resolve(workspace, rel);
  }

  // 2. Embedded placeholder (/something/path/to/current/project/foo)
  if (EMBEDDED_PLACEHOLDER_RE.test(p)) {
    const parts = p.split(EMBEDDED_PLACEHOLDER_RE);
    const rel = parts[parts.length - 1];
    return resolve(workspace, rel);
  }

  // 3. Legitimate Windows absolute path (e.g. C:\Users\pc\Downloads\foo.txt or C:/Users/pc/Downloads/foo.txt)
  if (/^[a-zA-Z]:[/\\]/.test(p)) {
    return p;
  }

  // 4. POSIX-style root path (e.g. /ollama_final_test.txt, /sub/file.txt, \ollama_final_test.txt)
  // Strip leading slash(es) and resolve relative to workspace
  if (/^[/\\]+/.test(p)) {
    const rel = p.replace(/^[/\\]+/, '');
    return resolve(workspace, rel);
  }

  // 5. Relative path (e.g. ollama_final_test.txt, ./ollama_final_test.txt, sub/file.txt)
  if (workspace) {
    return resolve(workspace, p);
  }

  return p;
}

export function rewriteOllamaJsonArgs(jsonStr: string, workspace: string): string {
  try {
    const args = JSON.parse(jsonStr) as Record<string, unknown>;
    if (!args || typeof args !== 'object') return jsonStr;
    let modified = false;
    for (const key of Object.keys(args)) {
      const val = args[key];
      if (typeof val === 'string') {
        if (/^(?:filePath|path|file_path|filename|file|targetFile|target_file|destination|source|dir|directory)$/i.test(key)) {
          const original = val;
          const rewritten = resolveOllamaWorkspacePath(val, workspace);
          console.log('[OllamaBridge] TOOL EXECUTION');
          console.log(`workspace:\n${workspace}\n`);
          console.log(`original:\n ${original}\n`);
          console.log(`resolved:\n${rewritten}\n`);
          args[key] = rewritten;
          modified = true;
        } else if (PLACEHOLDER_PREFIX_RE.test(val) || EMBEDDED_PLACEHOLDER_RE.test(val) || /^[/\\]+[^/\\]/.test(val)) {
          const original = val;
          const rewritten = resolveOllamaWorkspacePath(val, workspace);
          console.log('[OllamaBridge] TOOL EXECUTION');
          console.log(`workspace:\n${workspace}\n`);
          console.log(`original:\n ${original}\n`);
          console.log(`resolved:\n${rewritten}\n`);
          args[key] = rewritten;
          modified = true;
        }
      }
    }
    return modified ? JSON.stringify(args) : jsonStr;
  } catch {
    return jsonStr;
  }
}

export interface OllamaBridgeInstance {
  port: number;
  close: () => void;
}

export async function startOllamaBridge(
  workspace: string,
  upstreamHost?: string
): Promise<OllamaBridgeInstance> {
  const rawBase = (upstreamHost || DEFAULT_OLLAMA_HOST).trim().replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
  const base = rawBase.replace('localhost', '127.0.0.1');
  const upstreamUrl = new URL(base);

  const server = http.createServer((req, res) => {
    const targetPath = req.url || '/';
    const reqChunks: Buffer[] = [];

    console.log('[OllamaBridge] REQUEST');
    console.log(`method:\n${req.method}`);
    console.log(`url:\n${req.url}`);
    console.log(`upstream:\nhttp://${upstreamUrl.hostname}:${upstreamUrl.port || 11434}${targetPath}\n`);

    req.on('data', (chunk: Buffer) => reqChunks.push(chunk));
    req.on('end', () => {
      const reqBody = Buffer.concat(reqChunks);

      // Sanitize headers: strip host, force identity encoding so SSE/JSON is uncompressed
      const fwdHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
      delete fwdHeaders.host;
      delete fwdHeaders['accept-encoding'];
      fwdHeaders['accept-encoding'] = 'identity';
      if (reqBody.length > 0) {
        fwdHeaders['content-length'] = String(reqBody.length);
      }

      const upstreamReq = http.request(
        {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || 11434,
          path: targetPath,
          method: req.method,
          headers: fwdHeaders
        },
        (upstreamRes) => {
          console.log('[OllamaBridge] UPSTREAM RESPONSE');
          console.log(`status:\n${upstreamRes.statusCode}`);
          console.log(`content-type:\n${upstreamRes.headers['content-type']}\n`);

          const isStreaming = (upstreamRes.headers['content-type'] || '').includes('text/event-stream');

          if (!isStreaming) {
            const resChunks: Buffer[] = [];
            upstreamRes.on('data', (chunk: Buffer) => resChunks.push(chunk));
            upstreamRes.on('end', () => {
              const bodyStr = Buffer.concat(resChunks).toString('utf8');
              try {
                const data = JSON.parse(bodyStr) as {
                  choices?: Array<{
                    message?: {
                      tool_calls?: Array<{
                        function?: {
                          name?: string;
                          arguments?: string;
                        };
                      }>;
                    };
                  }>;
                };
                if (data.choices && Array.isArray(data.choices)) {
                  for (const choice of data.choices) {
                    if (choice.message?.tool_calls) {
                      for (const tc of choice.message.tool_calls) {
                        if (tc.function?.arguments) {
                          tc.function.arguments = rewriteOllamaJsonArgs(tc.function.arguments, workspace);
                        }
                      }
                    }
                  }
                }
                const modifiedBody = JSON.stringify(data);
                const headers = {
                  ...upstreamRes.headers,
                  'content-length': Buffer.byteLength(modifiedBody)
                };
                res.writeHead(upstreamRes.statusCode || 200, headers);
                res.end(modifiedBody);
              } catch {
                res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
                res.end(bodyStr);
              }
            });
          } else {
            // SSE streaming mode: buffer tool_call chunks and rewrite accumulated arguments
            res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
            let sseBuffer = '';
            const rawLines: string[] = [];

            upstreamRes.on('data', (chunk: Buffer) => {
              sseBuffer += chunk.toString('utf8');
              const lines = sseBuffer.split('\n');
              sseBuffer = lines.pop() || '';
              for (const l of lines) {
                if (l.trim()) rawLines.push(l);
              }
            });

            upstreamRes.on('end', () => {
              if (sseBuffer.trim()) rawLines.push(sseBuffer.trim());

              let hasToolCalls = false;
              const toolCallAccumulators = new Map<number, { id: string; type: string; name: string; arguments: string }>();
              let baseChunk: Record<string, unknown> | null = null;
              const nonToolLines: string[] = [];

              for (const line of rawLines) {
                if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
                  try {
                    const data = JSON.parse(line.slice(6)) as {
                      choices?: Array<{
                        delta?: {
                          role?: string;
                          content?: string | null;
                          tool_calls?: Array<{
                            index?: number;
                            id?: string;
                            type?: string;
                            function?: {
                              name?: string;
                              arguments?: string;
                            };
                          }>;
                        };
                      }>;
                    };
                    if (data.choices && Array.isArray(data.choices)) {
                      for (const choice of data.choices) {
                        if (choice.delta?.tool_calls) {
                          hasToolCalls = true;
                          if (!baseChunk) baseChunk = data as Record<string, unknown>;
                          for (const tc of choice.delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!toolCallAccumulators.has(idx)) {
                              toolCallAccumulators.set(idx, {
                                id: tc.id || `call_${idx}`,
                                type: tc.type || 'function',
                                name: tc.function?.name || '',
                                arguments: ''
                              });
                            }
                            const entry = toolCallAccumulators.get(idx)!;
                            if (tc.id) entry.id = tc.id;
                            if (tc.function?.name) entry.name = tc.function.name;
                            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
                          }
                        } else {
                          nonToolLines.push(line);
                        }
                      }
                    }
                  } catch {
                    nonToolLines.push(line);
                  }
                } else if (line.trim() !== 'data: [DONE]') {
                  nonToolLines.push(line);
                }
              }

              if (hasToolCalls && baseChunk) {
                // 1. Initial declaration chunk with tool call id + name
                const initialToolCalls = [];
                for (const [idx, tc] of toolCallAccumulators.entries()) {
                  initialToolCalls.push({
                    index: idx,
                    id: tc.id,
                    type: tc.type,
                    function: { name: tc.name, arguments: '' }
                  });
                }
                const chunk1 = {
                  ...baseChunk,
                  choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: initialToolCalls }, finish_reason: null }]
                };
                res.write(`data: ${JSON.stringify(chunk1)}\n\n`);

                // 2. Rewritten JSON arguments chunk
                const argToolCalls = [];
                for (const [idx, tc] of toolCallAccumulators.entries()) {
                  const rewrittenArgs = rewriteOllamaJsonArgs(tc.arguments, workspace);
                  argToolCalls.push({
                    index: idx,
                    function: { arguments: rewrittenArgs }
                  });
                }
                const chunk2 = {
                  ...baseChunk,
                  choices: [{ index: 0, delta: { tool_calls: argToolCalls }, finish_reason: null }]
                };
                res.write(`data: ${JSON.stringify(chunk2)}\n\n`);

                // 3. Finish chunk
                const chunk3 = {
                  ...baseChunk,
                  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                };
                res.write(`data: ${JSON.stringify(chunk3)}\n\n`);
                res.write('data: [DONE]\n\n');
              } else {
                for (const l of rawLines) {
                  res.write(`${l}\n\n`);
                }
                if (!rawLines.some(l => l.trim() === 'data: [DONE]')) {
                  res.write('data: [DONE]\n\n');
                }
              }

              res.end();
            });
          }
        }
      );

      upstreamReq.on('error', (err) => {
        console.log('[OllamaBridge] ERROR');
        console.log(`message:\n${err.message}`);
        console.log(`stack:\n${err.stack}\n`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });

      upstreamReq.write(reqBody);
      upstreamReq.end();
    });
  });

  return new Promise<{ port: number; close: () => void }>((resolvePromise, rejectPromise) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolvePromise({
        port,
        close: () => {
          try {
            server.close();
          } catch {
            // best-effort
          }
        }
      });
    });
    server.on('error', rejectPromise);
  });
}
