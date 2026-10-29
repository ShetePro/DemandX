/**
 * Stand-in LLM endpoint for the settings E2E suite.
 *
 * The settings page is exercised against a real Server Action → database →
 * adapter chain; only the network edge is fake. This server speaks the minimum
 * OpenAI-compatible surface the app uses:
 *
 *   GET  /v1/models             → two fixed models
 *   POST /v1/chat/completions   → a minimal "ok" completion
 *   GET  /__requests            → every request since the last reset (headers included)
 *   GET  /__reset               → clear that record
 *
 * Everything else answers 404. `STUB_PORT` overrides the default port so a
 * parallel checkout can run its own instance.
 */
import { createServer } from 'node:http';

const HOST = '127.0.0.1';
const PORT = Number(process.env.STUB_PORT ?? 4010);

const MODELS = ['stub-model-a', 'stub-model-b'];

/** What the app has sent since the last `/__reset`; assertions read this. */
let seen = [];

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function record(request, pathname, body) {
  // Node lowercases header names; the spec asserts on lowercase keys.
  seen.push({
    method: request.method,
    path: pathname,
    headers: { ...request.headers },
    body,
  });
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      if (raw.trim() === '') return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    request.on('error', () => resolve(null));
  });
}

const server = createServer(async (request, response) => {
  const method = request.method ?? 'GET';
  const { pathname } = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);

  if (method === 'GET' && pathname === '/__requests') {
    return sendJson(response, 200, seen);
  }

  if (method === 'GET' && pathname === '/__reset') {
    seen = [];
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/v1/models') {
    record(request, pathname, null);
    return sendJson(response, 200, {
      object: 'list',
      data: MODELS.map((id) => ({ id, object: 'model' })),
    });
  }

  if (method === 'POST' && pathname === '/v1/chat/completions') {
    const body = await readJsonBody(request);
    record(request, pathname, body);
    return sendJson(response, 200, {
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      model: 'stub-model-a',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
  }

  sendJson(response, 404, { error: { message: `no stub route for ${method} ${pathname}` } });
});

server.listen(PORT, HOST, () => {
  console.log(`stub provider listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
