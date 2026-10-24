#!/usr/bin/env node

// Front proxy for OpenCode -> ZCode bridge.
//
// OpenCode always sends its own system prompt. The ZCode gateway rejects any
// system prompt that is not the official ZCode one, so this proxy removes the
// system field and adds a short note to the first user message. The in-agent
// bridge then inserts the official ZCode identity prompt.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LISTEN = Number(process.env.ZCODE_FRONT_PORT || 8789);
const UPSTREAM = process.env.ZCODE_BRIDGE_URL || 'http://127.0.0.1:8788';
const BASE = process.env.ZCODE_BRIDGE_DIR || path.join(os.homedir(), '.config', 'opencode', 'zcode-bridge');
const LOG_DIR = path.join(BASE, 'logs');
const DEBUG = process.env.ZCODE_DEBUG === '1';

function log(entry) {
  if (!DEBUG) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, 'front.log'),
      JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n',
      { mode: 0o600 }
    );
  } catch (e) {
    // Logging must never break the proxy.
  }
}

function transform(body) {
  delete body.system;

  const note = "Use the tools provided to complete the user's request. Be concise.";
  if (!Array.isArray(body.messages)) body.messages = [];
  if (body.messages.length === 0) {
    body.messages.push({ role: 'user', content: note });
    return body;
  }

  const first = body.messages[0];
  if (first && first.role === 'user') {
    if (typeof first.content === 'string') {
      first.content = note + '\n\n' + first.content;
    } else if (Array.isArray(first.content)) {
      first.content.unshift({ type: 'text', text: note });
    } else {
      first.content = note;
    }
  } else {
    body.messages.unshift({ role: 'user', content: note });
  }
  return body;
}

function collect(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function bridgeStatus() {
  try {
    const r = await fetch(UPSTREAM + '/health', { signal: AbortSignal.timeout(1000) });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    return { ok: !!(j.hasTemplate && j.hasHeaders), ...j };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    const bridge = await bridgeStatus();
    res.writeHead(bridge.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: bridge.ok,
      front: { pid: process.pid, listen: LISTEN, upstream: UPSTREAM },
      bridge,
    }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { type: 'not_found', message: 'Only POST /messages is supported.' },
    }));
    return;
  }

  try {
    const raw = await collect(req);
    let parsed = null;
    let out = raw;

    if (raw.length) {
      try {
        parsed = JSON.parse(raw.toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          transform(parsed);
          out = Buffer.from(JSON.stringify(parsed));
        }
      } catch (e) {
        // Non-JSON bodies are passed through unchanged.
      }
    }

    const bridge = await bridgeStatus();
    if (!bridge.ok) {
      log({ method: req.method, url: req.url, notReady: true, bridge });
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          type: 'bridge_not_ready',
          message: 'Open ZCode and send one message in a task to warm up the bridge, then retry.',
        },
      }));
      return;
    }

    log({
      method: req.method,
      url: req.url,
      model: parsed && parsed.model,
      stream: parsed && parsed.stream,
      inLen: raw.length,
      outLen: out.length,
      tools: parsed && Array.isArray(parsed.tools) ? parsed.tools.length : undefined,
    });

    const upstream = await fetch(UPSTREAM + req.url, {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] || 'application/json' },
      body: out,
    });

    const headers = {};
    upstream.headers.forEach((v, k) => {
      if (!/connection|keep-alive|transfer-encoding|content-length/i.test(k)) {
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
    log({ error: String((e && e.stack) || e) });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { type: 'front_proxy_error', message: String((e && e.message) || e) },
    }));
  }
});

server.on('error', (e) => log({ listenError: String((e && e.message) || e) }));
server.listen(LISTEN, '127.0.0.1', () => {
  log({ listening: LISTEN, pid: process.pid, upstream: UPSTREAM });
});
