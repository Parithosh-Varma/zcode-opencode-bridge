'use strict';

// ZCode bridge hook.
//
// Loaded inside ZCode's agent process (the Electron helper that runs zcode.cjs).
// It captures the headers and body of the app's next model request, then exposes
// a local Anthropic-compatible bridge on 127.0.0.1:8788.
//
// Requests arriving at the bridge are forwarded with the app's captured headers
// and the first two blocks of the app's official system prompt. The ZCode
// gateway rejects third-party system prompts, so OpenCode's prompt is removed by
// the front proxy and this hook supplies the official identity prompt instead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const BASE = process.env.ZCODE_BRIDGE_DIR || path.join(os.homedir(), '.config', 'opencode', 'zcode-bridge');
const LOG_DIR = path.join(BASE, 'logs');
const DEBUG = process.env.ZCODE_DEBUG === '1';
const PORT = Number(process.env.ZCODE_BRIDGE_PORT || 8788);
const UPSTREAM = process.env.ZCODE_UPSTREAM_URL || 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages';
const MODEL_URL_RE = /anthropic\/v1\/messages/;

function log(entry) {
  if (!DEBUG) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, 'bridge.log'),
      JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n',
      { mode: 0o600 }
    );
  } catch (e) {
    // Logging must never break the bridge.
  }
}

function plainHeaders(h) {
  const out = {};
  if (!h) return out;
  const entries = typeof h.forEach === 'function' && !Array.isArray(h)
    ? (() => {
        const a = [];
        h.forEach((v, k) => a.push([k, v]));
        return a;
      })()
    : Array.isArray(h) ? h : Object.entries(h);
  for (const [k, v] of entries) out[String(k)] = String(v);
  return out;
}

const origFetch = globalThis.fetch;
let latestModelInit = null;
let latestModelHeaders = null;
let latestModelTemplate = null;

function isOfficialTemplate(tpl) {
  if (!tpl || !tpl.system) return false;
  const first = Array.isArray(tpl.system)
    ? (tpl.system[0] && tpl.system[0].text)
    : tpl.system;
  return typeof first === 'string' && first.indexOf('You are ZCode') !== -1;
}

if (origFetch && !origFetch.__zcodeBridgeHooked) {
  const wrappedFetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (MODEL_URL_RE.test(url)) {
        let tpl = null;
        if (init && typeof init.body === 'string') {
          try {
            tpl = JSON.parse(init.body);
          } catch (e) {
            tpl = null;
          }
        }
        // ZCode also makes auxiliary model requests (titles, summaries) with
        // different system prompts. Only capture the main coding-agent request;
        // otherwise the official prompt would be overwritten by a title prompt.
        if (isOfficialTemplate(tpl)) {
          latestModelInit = init || null;
          latestModelHeaders = plainHeaders((init && init.headers) || (input && input.headers) || {});
          latestModelTemplate = tpl;
          log({
            captured: true,
            url,
            systemBlocks: Array.isArray(tpl.system) ? tpl.system.length : undefined,
            headerCount: Object.keys(latestModelHeaders).length,
          });
        } else {
          log({ ignored: true, url, reason: 'not the official ZCode agent prompt' });
        }
      }
    } catch (e) {
      // Never interfere with the app's own request.
    }
    return origFetch.apply(this, arguments);
  };
  wrappedFetch.__zcodeBridgeHooked = true;
  globalThis.fetch = wrappedFetch;
}

function makeUpstreamBody(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return raw;
  }

  const tpl = latestModelTemplate;
  if (isOfficialTemplate(tpl)) {
    // The first two system blocks are ZCode's stable identity/safety prompt.
    // The remaining blocks contain ZCode's own tool instructions, which do not
    // apply to OpenCode's tool schemas. This subset is accepted by the gateway
    // and leaves OpenCode's tools untouched.
    if (tpl.system) {
      body.system = Array.isArray(tpl.system) && tpl.system.length > 2
        ? tpl.system.slice(0, 2)
        : tpl.system;
    }
    if (tpl.metadata) body.metadata = tpl.metadata;
    if (tpl.max_tokens && (!body.max_tokens || body.max_tokens > tpl.max_tokens)) {
      body.max_tokens = tpl.max_tokens;
    }
  }
  return JSON.stringify(body);
}

async function forward(raw) {
  if (!latestModelHeaders || !isOfficialTemplate(latestModelTemplate)) {
    const err = new Error(
      'ZCode bridge is not warmed up. Open ZCode, send one message in a task, then retry.'
    );
    err.code = 'BRIDGE_NOT_READY';
    throw err;
  }

  const headers = { ...latestModelHeaders };
  delete headers['content-length'];
  delete headers['Content-Length'];

  const init = { method: 'POST', headers, body: raw };
  if (latestModelInit && latestModelInit.dispatcher) {
    init.dispatcher = latestModelInit.dispatcher;
  }
  return origFetch(UPSTREAM, init);
}

function collect(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      hasTemplate: isOfficialTemplate(latestModelTemplate),
      hasHeaders: !!latestModelHeaders,
      systemBlocks: isOfficialTemplate(latestModelTemplate) && Array.isArray(latestModelTemplate.system)
        ? latestModelTemplate.system.length
        : undefined,
      pid: process.pid,
    }));
    return;
  }

  try {
    const raw = await collect(req);
    log({ request: { method: req.method, url: req.url, bytes: raw.length } });
    const upstreamBody = makeUpstreamBody(raw.toString('utf8'));
    const upstream = await forward(upstreamBody);

    const headers = {};
    upstream.headers.forEach((v, k) => {
      if (!/content-encoding|content-length|transfer-encoding|connection/i.test(k)) {
        headers[k] = v;
      }
    });
    res.writeHead(upstream.status, headers);

    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
    log({ upstreamStatus: upstream.status });
  } catch (e) {
    const notReady = e && e.code === 'BRIDGE_NOT_READY';
    log({ error: String((e && e.message) || e), notReady });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(notReady ? 503 : 502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: notReady ? 'bridge_not_ready' : 'bridge_error',
        message: String((e && e.message) || e),
      },
    }));
  }
});

server.on('error', (e) => log({ listenError: String((e && e.message) || e) }));
server.listen(PORT, '127.0.0.1', () => log({ listening: PORT, pid: process.pid }));
