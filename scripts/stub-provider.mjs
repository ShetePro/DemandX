/**
 * Stand-in LLM endpoint for the E2E suites.
 *
 * Pages are exercised against a real Server Action → database → adapter chain;
 * only the network edge is fake. This server speaks the minimum
 * OpenAI-compatible surface the app uses:
 *
 *   GET  /v1/models             → two fixed models
 *   POST /v1/chat/completions   → a minimal "ok" completion, or an SSE stream
 *                                 when the body asks for `stream: true`
 *   GET  /__requests            → every request since the last reset (headers included)
 *   GET  /__reset               → clear that record
 *
 * Everything else answers 404. `STUB_PORT` overrides the default port so a
 * parallel checkout can run its own instance.
 */
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const HOST = '127.0.0.1';
const PORT = Number(process.env.STUB_PORT ?? 4010);

const MODELS = ['stub-model-a', 'stub-model-b'];

/**
 * Pause between the two content chunks so the browser really renders two
 * increments; without it the whole answer can land in one paint and a
 * "streaming" assertion would only prove the text exists.
 */
const STREAM_CHUNK_DELAY_MS = 900;

/** Data frames of the streamed answer; `[e12]` is what the UI turns into a chip. */
const STREAM_CONTENT = ['先看证据：', '付费信号只有 1 条有价格页 [e12]。'];

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

/** One OpenAI-compatible `chat.completion.chunk` frame. */
function chatChunk(delta, finishReason, usage) {
  const payload = {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'stub-model-a',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage !== undefined) payload.usage = usage;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * The streaming answer: a role frame, two content increments (with a pause
 * between them), a finish frame carrying usage, then the `[DONE]` sentinel.
 * Content chunks are the only thing the UI shows, so the pause is between them.
 */
async function sendChatStream(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const write = (frame) => {
    if (response.destroyed || response.writableEnded) return false;
    response.write(frame);
    return true;
  };

  if (!write(chatChunk({ role: 'assistant' }, null))) return;

  for (const [index, content] of STREAM_CONTENT.entries()) {
    if (!write(chatChunk({ content }, null))) return;
    if (index < STREAM_CONTENT.length - 1) await delay(STREAM_CHUNK_DELAY_MS);
  }

  const finished = write(
    chatChunk({}, 'stop', { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 }),
  );
  if (!finished) return;

  write('data: [DONE]\n\n');
  response.end();
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
    if (body !== null && typeof body === 'object' && body.stream === true) {
      return sendChatStream(response);
    }
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
