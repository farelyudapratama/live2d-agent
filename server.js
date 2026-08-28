/**
 * server.js — Lightweight local HTTP server for Live2D Agent
 * No dependencies — pure Node.js
 *
 * FIX: decode URI (%E7%A5%9E... -> 神宫白子) so Live2D model files with
 * CJK characters load correctly. Previously the raw %-encoded path caused
 * a directory listing / 404 instead of serving the real .moc3 / .png.
 */
// Detach stdin so background/non-tty launches don't fail with "stdin is not a tty".
try { if (process.stdin && process.stdin.unref) process.stdin.unref(); } catch (e) {}
try { if (process.stdin && process.stdin.destroy) process.stdin.destroy(); } catch (e) {}

const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const url  = require('url');
const { execSync } = require('child_process');

// Detach from stdin so the server survives headless/background launch
// (node otherwise exits with "stdin is not a tty" when no TTY is attached).
if (process.stdin && process.stdin.unref) { try { process.stdin.unref(); } catch (e) {} }

// Default stays 8310 so nothing changes for normal use; the env override exists
// so a second instance can be started on a free port for testing without
// disturbing an already-running server.
const PORT = Number(process.env.PORT) || 8310;
const ROOT = __dirname;

// ── 9router-style connection store ─────────────────────────────
// config.json shape: { activeId, connections: [ {id,name,provider,baseUrl,apiKey,model,systemPrompt,temperature,maxTokens,testStatus,lastError,rateLimitedUntil} ] }
// Runtime overrides (set from web UI, no file edit needed) live here.
let runtimeConfig = null;

// ── Auto-generate a default config.json when the file is missing ──
// Keeps the app self-contained: a fresh clone (without config.json, which is
// gitignored) still gets a complete, valid config with the default tts/events/
// camera blocks, so nothing breaks and the UI can persist connections later.
const DEFAULT_CONFIG = {
  activeId: null,
  connections: [],
  tts: { endpoint: '' },
  events: {
    idleSpeak: true,
    idleMs: 1800000,
    idleRepeatMs: 1800000,
    awaySpeak: true,
    returnSpeak: true,
    awayHiddenMs: 10000,
  },
  camera: {
    enabled: false,
    fps: 0.4,
    presenceThreshold: 0.4,
    device: 'webgpu',
    model: 'Xenova/facial_emotions_image_detection',
  },
  // Global motion amplitude boost. OFF by default — karakter gerak normal.
  // Set enabled:true dan gain>1 (mis. 1.5) untuk bikin gerak lebih dramatis.
  // gain<1 membuat gerak lebih kalem. Nilai melewati rentang model akan
  // di-clamp oleh runtime (tetap aman, nggak rusak rig).
  motion: {
    enabled: false,
    gain: 1.5,
  },
};
function ensureConfig() {
  const file = path.join(ROOT, 'config.json');
  if (fs.existsSync(file)) return;
  try {
    fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    console.log('  (config.json tidak ditemukan — membuat default baru)');
  } catch (e) {
    console.warn('  [warn] gagal membuat config.json default:', e.message);
  }
}

function loadConfig() {
  try {
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return Object.assign({}, base, runtimeConfig || {});
  } catch (e) {
    return Object.assign({}, runtimeConfig || { connections: [], activeId: null });
  }
}
function getConnections() {
  const cfg = loadConfig();
  return Array.isArray(cfg.connections) ? cfg.connections : [];
}
function getActiveConnection() {
  const conns = getConnections();
  if (!conns.length) return null;
  const cfg = loadConfig();
  return conns.find(c => c.id === cfg.activeId) || conns[0];
}
// ── Atomic JSON write ──────────────────────────────────────────
// Node has no file locking, and these files get written from several request
// handlers that can overlap (persistConnections runs on EVERY llm call; sheets
// are written by inspect, by ai-classify, and soon by the sheet editor's Save).
// A plain writeFileSync truncates first, so two overlapping writers — or a crash
// mid-write — can leave a half-written file. For config.json that means losing
// the user's API keys; for a sheet it means an unparseable sheet on next load.
//
// Writing to a unique temp file and renaming fixes the torn-file case: rename is
// atomic on both NTFS and POSIX, so a reader sees either the old file or the new
// one, never a partial. It does NOT serialize concurrent writers (last rename
// wins) — acceptable here because every writer writes a complete document.
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now() + '.tmp');
  const text = JSON.stringify(obj, null, 2);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);   // atomic replace
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
    throw e;
  }
}

// Per-path write queue. writeJsonAtomic() prevents torn files but not lost
// updates: with two overlapping POSTs for the same sheet, both read-modify-write
// races still end with "last rename wins". Chaining writes per path makes them
// apply in arrival order, so a Save that lands during an AI-classify write is
// applied after it instead of vanishing.
const _writeQueues = new Map();
function queueJsonWrite(file, obj) {
  const prev = _writeQueues.get(file) || Promise.resolve();
  // Run after the previous write for this path regardless of whether it
  // succeeded — one failed write must not block later ones.
  const done = prev.then(() => writeJsonAtomic(file, obj), () => writeJsonAtomic(file, obj));
  // The chain we store must never reject, or every subsequent .then would be
  // skipped. Track the tail with a marker so the map entry is removed only when
  // this write is the last one queued (prevents unbounded growth).
  const tail = done.catch(() => {});
  _writeQueues.set(file, tail);
  tail.then(() => { if (_writeQueues.get(file) === tail) _writeQueues.delete(file); });
  return done;   // callers see the real success/failure
}

function persistConnections(conns, activeId) {
  // Pertahankan blok lain (tts/events/camera) dari config yang ada, jangan timpa.
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (e) {}
  const data = Object.assign({}, prev, {
    activeId: activeId || (conns[0] && conns[0].id) || null,
    connections: conns,
  });
  // PENTING: cache hanya bagian yang endpoint ini benar-benar miliki.
  // Sebelumnya seluruh objek `data` disimpan, dan karena loadConfig() menaruh
  // runtimeConfig DI ATAS file, satu kali menyimpan connection dari UI akan
  // membekukan blok events/camera pada nilai saat itu — edit manual di
  // config.json diabaikan diam-diam sampai server di-restart.
  runtimeConfig = { activeId: data.activeId, connections: data.connections };
  try { writeJsonAtomic(path.join(ROOT, 'config.json'), data); } catch (e) {
    console.warn('[config] gagal menyimpan config.json:', e.message);
  }
}
function maskKey(k) {
  if (!k || k.startsWith('MASUKKAN')) return k || '';
  return k.slice(0, 6) + '••••••••' + k.slice(-4);
}

// ── Error classification (copied from 9router errorConfig) ──────
const ERROR_RULES = [
  { text: 'no credentials',             cooldownMs: 120000 },
  { text: 'request not allowed',        cooldownMs: 5000 },
  { text: 'improperly formed request',  cooldownMs: 120000 },
  { text: 'rate limit',                backoff: true },
  { text: 'too many requests',         backoff: true },
  { text: 'quota exceeded',            backoff: true },
  { text: 'capacity',                  backoff: true },
  { text: 'overloaded',                backoff: true },
  { status: 401, cooldownMs: 120000 },
  { status: 402, cooldownMs: 120000 },
  { status: 403, cooldownMs: 120000 },
  { status: 404, cooldownMs: 120000 },
  { status: 429, backoff: true },
];
function classifyError(status, errorText) {
  const lower = (errorText || '').toLowerCase();
  for (const rule of ERROR_RULES) {
    if (rule.text && lower.includes(rule.text)) return { shouldFallback: true, cooldownMs: rule.cooldownMs || 30000 };
    if (rule.status && rule.status === status)   return { shouldFallback: true, cooldownMs: rule.cooldownMs || 30000 };
  }
  return { shouldFallback: true, cooldownMs: 30000 };
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.moc3': 'application/octet-stream',
  '.physics3.json': 'application/json; charset=utf-8',
  '.model3.json':   'application/json; charset=utf-8',
  '.exp3.json':     'application/json; charset=utf-8',
  '.cdi3.json':     'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
};

const JSON_HEAD = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };

// Strip a UTF-8 BOM before JSON.parse. Cubism Editor and several Windows tools
// write model3.json with a BOM, and JSON.parse() throws on it — which would make
// a perfectly valid manifest look like it declares no expressions at all.
function stripBom(s) {
  return (typeof s === 'string' && s.charCodeAt(0) === 0xFEFF) ? s.slice(1) : s;
}

function safeJoin(root, reqPath) {
  // Decode %-encoding (handles CJK), then prevent traversal.
  const decoded = decodeURIComponent(reqPath.split('?')[0]);
  const normalized = path
    .normalize(decoded)
    .replace(/^(\.\.[\/\\])+/, '');
  const full = path.join(root, normalized);
  // Ensure the resolved path stays inside ROOT (no symlink escape).
  if (!full.startsWith(root)) return null;
  return full;
}

// ── LLM provider proxy (no external deps) ───────────────────────
// Supports: openai-compatible | gemini | groq | openai | anthropic | mock
// `conn` is a single 9router-style connection object.

// Hard limits for every outbound LLM call. Applied in httpsPostJson() so all
// providers and all endpoints inherit them.
const LLM_TIMEOUT_MS = 60000;              // no answer in 60s → fail, don't hang
const MAX_LLM_RESPONSE_BYTES = 2 * 1024 * 1024;   // 2MB cap on provider replies

// The only role names the system understands. Single source of truth: used both
// to build the classify-params prompt AND to validate what comes back, so the
// LLM can never invent a role that no writer knows how to apply.
const KNOWN_ROLES = [
  'angleX', 'angleY', 'angleZ', 'eyeBallX', 'eyeBallY', 'eyeLOpen', 'eyeROpen',
  'eyeLSmile', 'eyeRSmile', 'eyeForm', 'mouthOpenY', 'mouthForm', 'mouthOpenX',
  'bodyAngleX', 'bodyAngleY', 'bodyAngleZ', 'breath', 'browLForm', 'browRForm',
  'browLY', 'browRY', 'browLAngle', 'browRAngle', 'blush',
];
function callLLM(conn, messages, clientSystem) {
  const provider = (conn.provider || 'openai-compatible').toLowerCase();
  // Bersihkan key dari karakter tersembunyi (newline, tab, zero-width, BOM, ctrl).
  const apiKey = String(conn.apiKey == null ? '' : conn.apiKey).replace(/[\u0000-\u001F\u007F\u00A0\u200B\u200C\u200D\uFEFF]+/g, '').trim();
  const model = conn.model || defaultModel(provider);
  const temp = conn.temperature != null ? conn.temperature : 0.8;
  const maxT = conn.maxTokens || 2048;  // support long detailed responses
  // Merge connection's systemPrompt with client-provided system context
  const sys = [conn.systemPrompt, clientSystem].filter(Boolean).join('\n\n');

  if (provider === 'openai-compatible' || provider === 'groq' || provider === 'openai') {
    // Router-style: any OpenAI-compatible endpoint.
    let base;
    if (provider === 'openai-compatible') {
      base = (conn.baseUrl || '').replace(/\/+$/, '');
      if (!base) return Promise.reject(new Error('baseUrl belum diisi untuk openai-compatible'));
    } else if (provider === 'groq') {
      base = 'https://api.groq.com/openai/v1';
    } else {
      base = 'https://api.openai.com/v1';
    }
    const endpoint = base + '/chat/completions';
    const body = JSON.stringify({
      model,
      messages: buildChatMessages(messages, sys),
      temperature: temp,
      max_tokens: maxT,
    });
    const authz = 'Bearer ' + apiKey;
    return httpsPostJson(endpoint, body, { Authorization: authz }).then(r => {
      const t = r?.choices?.[0]?.message?.content || '';
      if (!t) throw new Error((provider) + ' kosong: ' + JSON.stringify(r).slice(0, 200));
      return t.trim();
    });
  }

  if (provider === 'mock') {
    // Local stub — no network/key needed. Useful for UI testing.
    const last = (messages.filter(m => m.role === 'user').pop() || {}).content || '';
    const reply = `Halo! Kamu bilang: "${last}". (Mode mock — isi apiKey di config.json untuk LLM sungguhan.)`;
    return new Promise(res => setTimeout(() => res(reply), 300));
  }

  if (provider === 'gemini') {
    // Google Generative Language API
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const contents = toGeminiContents(messages, sys);
    const body = JSON.stringify({
      systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
      contents,
      generationConfig: { temperature: temp, maxOutputTokens: maxT, candidateCount: 1 },
    });
    return httpsPostJson(url, body).then(r => {
      const t = r?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      if (!t) throw new Error('Gemini kosong: ' + JSON.stringify(r).slice(0, 200));
      return t.trim();
    });
  }

  if (provider === 'anthropic') {
    const body = JSON.stringify({
      model,
      system: sys || undefined,
      messages: messages.filter(m => m.role !== 'system'),
      max_tokens: Math.min(maxT, 4096),
      temperature: temp,
    });
    return httpsPostJson('https://api.anthropic.com/v1/messages', body, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }).then(r => {
      const t = (r?.content || []).map(p => p.text || '').join('');
      if (!t) throw new Error('Anthropic kosong: ' + JSON.stringify(r).slice(0, 200));
      return t.trim();
    });
  }

  return Promise.reject(new Error('provider tidak dikenal: ' + provider));
}

function defaultModel(p) {
  return ({ gemini: 'gemini-2.0-flash', groq: 'llama-3.3-70b-versatile', openai: 'gpt-4o-mini', anthropic: 'claude-3-5-haiku-latest' })[p] || '';
}

function buildChatMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'system') continue;
    out.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
  }
  return out;
}

function toGeminiContents(messages, system) {
  // Gemini doesn't take system in messages; we put it in systemInstruction.
  return messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }));
}

function httpsPostJson(urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = Buffer.from(body);
    const h = Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': data.length,
    }, headers);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: h }, (resp) => {
      let buf = '';
      // Cap the provider response too: a hostile/broken endpoint streaming an
      // endless body would otherwise grow this string until the process dies.
      let tooBig = false;
      resp.on('data', d => {
        if (tooBig) return;
        buf += d;
        if (buf.length > MAX_LLM_RESPONSE_BYTES) {
          tooBig = true;
          resp.destroy();
          reject(new Error('respon LLM terlalu besar (>' + Math.round(MAX_LLM_RESPONSE_BYTES / 1024) + 'KB)'));
        }
      });
      resp.on('end', () => {
        if (tooBig) return;
        let json;
        try { json = JSON.parse(buf); } catch (e) { return reject(new Error('respon bukan JSON: ' + buf.slice(0, 200))); }
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          const e = new Error('HTTP ' + resp.statusCode + ': ' + (json?.error?.message || buf.slice(0, 200)));
          e.statusCode = resp.statusCode;
          return reject(e);
        }
        resolve(json);
      });
    });
    // Without this, a provider that accepts the socket but never answers would
    // hang the request forever: the browser's fetch never settles, and the UI
    // that awaits it (chat, inspect, sheet analysis) freezes with no error.
    req.setTimeout(LLM_TIMEOUT_MS, () => {
      req.destroy(new Error('timeout: LLM tidak merespon dalam ' + Math.round(LLM_TIMEOUT_MS / 1000) + 's'));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Shared LLM caller with automatic connection fallback ────────────
// Extracted verbatim from the inline tryNext() that used to live inside the
// POST /api/chat handler, so that EVERY endpoint needing an LLM (chat,
// classify-params, animate-text, and the sheet-analysis endpoint added later)
// shares one retry/cooldown policy instead of each growing its own copy.
//
// Behaviour is intentionally identical to the old inline version:
//   - try the active connection first, then the others in config order
//   - skip any connection still inside its rate-limit cooldown
//   - on a fallback-worthy error, stamp rateLimitedUntil and move to the next
//   - on the last connection (or a non-fallback error), give up
//
// Resolves { reply, used, conn }. Rejects with an Error carrying `httpStatus`
// (400 when no connection is configured at all, 502 otherwise) and `kind`, so
// each caller can shape its own HTTP response without duplicating the policy.
function llmWithFallback(messages, clientSystem) {
  return new Promise((resolve, reject) => {
    const conns = getConnections();
    if (!conns.length) {
      const e = new Error('Belum ada connection. Buka panel ⚙️ AI Connections.');
      e.httpStatus = 400; e.kind = 'no-connections';
      return reject(e);
    }
    const active = getActiveConnection();
    // order: active first, then the rest
    const order = [active, ...conns.filter(c => c !== active)].filter(Boolean);

    let idx = 0;
    (function tryNext() {
      if (idx >= order.length) {
        const e = new Error('Semua connection gagal (cek panel ⚙️ AI Connections).');
        e.httpStatus = 502; e.kind = 'all-failed';
        return reject(e);
      }
      const conn = order[idx++];
      // skip connections in cooldown (rate-limited)
      if (conn.rateLimitedUntil && new Date(conn.rateLimitedUntil).getTime() > Date.now()) {
        return tryNext();
      }
      callLLM(conn, messages, clientSystem).then(reply => {
        // mark success
        conn.testStatus = 'success'; conn.lastError = ''; conn.rateLimitedUntil = null;
        persistConnections(conns);
        resolve({ reply, used: conn.id, conn });
      }).catch(err => {
        const status = err.statusCode || 0;
        const cls = classifyError(status, err.message);
        conn.testStatus = 'error'; conn.lastError = err.message;
        if (cls.shouldFallback) conn.rateLimitedUntil = new Date(Date.now() + (cls.cooldownMs || 30000)).toISOString();
        persistConnections(conns);
        if (cls.shouldFallback && idx < order.length) {
          tryNext();   // auto-fallback to next connection
        } else {
          const e = new Error('LLM error [' + (conn.name || conn.id) + ']: ' + err.message);
          e.httpStatus = 502; e.kind = 'llm-error'; e.conn = conn;
          reject(e);
        }
      });
    })();
  });
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];   // declared up-front; model endpoints below use it (reassigned for '/' → '/index.html')
  // ── Agent brain proxy: POST /api/chat { messages:[{role,content}] } ──
  // 9router-style: uses the ACTIVE connection; on rate-limit/quota/error it
  // automatically falls back to the next connection (like 3-tier fallback).
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/chat') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      let payload;
      try { payload = JSON.parse(body); } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'body JSON rusak' })); return;
      }
      const messages = payload.messages || [];
      // Client may send extra system context (e.g. capability profile).
      // Merge with the connection's systemPrompt so the LLM gets both.
      const clientSystem = payload.system || '';
      // Retry/cooldown policy now lives in llmWithFallback() (shared with the
      // model endpoints). Response shape is unchanged: { reply, used } on
      // success, { error } with the same status codes on failure.
      llmWithFallback(messages, clientSystem).then(({ reply, used }) => {
        res.writeHead(200); res.end(JSON.stringify({ reply, used }));
      }).catch(err => {
        res.writeHead(err.httpStatus || 502);
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    return;
  }

  // ── POST /api/tts → proxy TTS ke Colab (Gradio 4), balikin audio ──
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/tts') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body || '{}');
        if (!text) { res.writeHead(400); res.end('no text'); return; }
        const cfg = loadConfig();
        const gradio = (cfg.tts && cfg.tts.endpoint) || '';
        if (!gradio) { res.writeHead(400); res.end('tts endpoint belum diisi'); return; }
        const base = gradio.replace(/\/$/, '');
        const r1 = await fetch(base + '/gradio_api/call/generate_api', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: [text] }),
        });
        if (!r1.ok) throw new Error('gradio call HTTP ' + r1.status);
        const ev = (await r1.json()).event_id;
        const r2 = await fetch(base + '/gradio_api/call/generate_api/' + ev);
        const sse = await r2.text();
        let audioUrl = null;
        const lines = sse.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const ln = lines[i].trim();
          if (ln.startsWith('data:')) {
            const j = JSON.parse(ln.slice(5).trim());
            const fd = Array.isArray(j) ? j[0] : j;
            audioUrl = fd && (fd.url || (fd.path ? base + '/gradio_api/file' + fd.path : null));
            break;
          }
        }
        if (!audioUrl) throw new Error('no audio url from gradio');
        if (!/^https?:/.test(audioUrl)) audioUrl = base + audioUrl;
        const audioResp = await fetch(audioUrl);
        const buf = Buffer.from(await audioResp.arrayBuffer());
        res.writeHead(200, { 'Content-Type': audioResp.headers.get('content-type') || 'audio/wav' });
        res.end(buf);
      } catch (e) {
        res.writeHead(502); res.end('TTS error: ' + e.message);
      }
    });
    return;
  }

  if (req.method === 'OPTIONS') {  // CORS preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204); res.end();
    return;
  }

  // Pure merge used by persistEvents(): returns a NEW config object with the
  // ambient-event block replaced by `incoming` (unknown keys dropped, existing
  // blocks preserved). Extracted as a pure function so it can be unit-tested
  // without touching disk (test-fase4-behaviour.js).
  const KNOWN_EVENT_KEYS = ['idleSpeak', 'idleMs', 'idleRepeatMs', 'awaySpeak', 'returnSpeak', 'awayHiddenMs', 'quietMs'];
  function mergeEventsIntoConfig(prev, incoming) {
    const base = (typeof prev === 'object' && prev) ? prev : {};
    const merged = Object.assign({}, base.events || {}, incoming || {});
    const clean = {};
    for (const k of KNOWN_EVENT_KEYS) if (k in merged) clean[k] = merged[k];
    return Object.assign({}, base, { events: clean });
  }

  // Persist ONLY the ambient-event block, preserving every other part of the
  // config (connections, tts, camera, motion). Used by the Behaviour panel in
  // the UI: the events block is user-facing tuning, so it must round-trip
  // without ever rewriting (and thus risking) the user's API keys or other
  // blocks. persistConnections() deliberately ignores events, so we write the
  // full document here instead.
  function persistEvents(events) {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (e) {}
    const data = mergeEventsIntoConfig(prev, events);
    try { writeJsonAtomic(path.join(ROOT, 'config.json'), data); } catch (e) {
      console.warn('[config] gagal menyimpan events:', e.message);
    }
  }

  // ── GET /api/config → list connections + active (apiKey masked) ──
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/config') {
    const cfg = loadConfig();
    const conns = (cfg.connections || []).map(c => {
      const o = Object.assign({}, c);
      if (o.apiKey && !o.apiKey.startsWith('MASUKKAN')) o.apiKey = maskKey(o.apiKey);
      return o;
    });
    res.writeHead(200);
    res.end(JSON.stringify({ activeId: cfg.activeId, connections: conns, tts: cfg.tts || {}, events: cfg.events || {}, camera: cfg.camera || {}, motion: cfg.motion || {} }));
    return;
  }

  // ── POST /api/config → CRUD connections (set from web UI) ──
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/config') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      let incoming;
      try { incoming = JSON.parse(body); } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'body JSON rusak' })); return;
      }
      const action = incoming.action || 'save';
      const cfg = loadConfig();
      let conns = Array.isArray(cfg.connections) ? cfg.connections.slice() : [];
      try {
        if (action === 'add') {
          const id = 'conn_' + Date.now().toString(36);
          const conn = Object.assign({ id, testStatus: 'untested', provider: 'openai-compatible' }, incoming.connection || {});
          conn.id = id;
          conns.push(conn);
          if (!cfg.activeId) cfg.activeId = id;
        } else if (action === 'update') {
          const i = conns.findIndex(c => c.id === incoming.id);
          if (i < 0) { res.writeHead(404); res.end(JSON.stringify({ error: 'connection tidak ada' })); return; }
          const upd = incoming.connection || {};
          // Kalau field key kosong saat edit, PERTAHANKAN key lama (GET mengembalikan
          // key yang di-mask, jadi jangan pakai itu — pakai yang tersimpan di server).
          if (!upd.apiKey || !String(upd.apiKey).trim()) upd.apiKey = conns[i].apiKey;
          conns[i] = Object.assign({}, conns[i], upd);
          conns[i].id = incoming.id;
        } else if (action === 'delete') {
          conns = conns.filter(c => c.id !== incoming.id);
          if (cfg.activeId === incoming.id) cfg.activeId = conns[0] ? conns[0].id : null;
        } else if (action === 'setActive') {
          if (!conns.find(c => c.id === incoming.id)) { res.writeHead(404); res.end(JSON.stringify({ error: 'connection tidak ada' })); return; }
          cfg.activeId = incoming.id;
        } else if (action === 'saveEvents') {
          // Persist ONLY the ambient-event tuning (quietMs/idleMs/.../toggles),
          // leaving connections/tts/camera/motion untouched. The UI sends the
          // full events object; we merge it onto whatever is already stored so
          // a partial object can never drop a field the UI didn't show. Unknown
          // keys are dropped inside mergeEventsIntoConfig(). The live in-app
          // update of the running EVENTS object is done client-side (applyLive),
          // so the server only persists + acknowledges.
          const prevCfg = loadConfig();
          const merged = mergeEventsIntoConfig(prevCfg, incoming.events || {});
          persistEvents(merged.events);
          res.writeHead(200); res.end(JSON.stringify({ ok: true, events: merged.events }));
          return;
        } else if (action === 'save') {
          // full replace (backwards compat)
          if (Array.isArray(incoming.connections)) conns = incoming.connections;
          if (incoming.activeId) cfg.activeId = incoming.activeId;
        } else {
          res.writeHead(400); res.end(JSON.stringify({ error: 'action tidak dikenal: ' + action })); return;
        }
        conns.forEach(c => { if (c.apiKey) c.apiKey = String(c.apiKey).replace(/[\u0000-\u001F\u007F\u00A0\u200B\u200C\u200D\uFEFF]+/g, '').trim(); });
        persistConnections(conns, cfg.activeId);
        res.writeHead(200); res.end(JSON.stringify({ ok: true, activeId: cfg.activeId, connections: conns.length }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: 'gagal menyimpan: ' + e.message }));
      }
    });
    return;
  }

  // ── POST /api/test → test a single connection (9router-style) ──
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/test') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      let incoming;
      try { incoming = JSON.parse(body); } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'body JSON rusak' })); return;
      }
      const conn = incoming.connection || {};
      // UI cuma punya apiKey yang di-mask ('•…') — pakai key ASLI dari config server.
      const cfgNow = loadConfig();
      const stored = (cfgNow.connections || []).find(x => x.id === conn.id);
      if (stored && stored.apiKey) conn.apiKey = stored.apiKey;
      if ((conn.provider || 'openai-compatible').toLowerCase() !== 'mock' &&
          (!conn.apiKey || conn.apiKey.startsWith('MASUKKAN'))) {
        res.writeHead(400); res.end(JSON.stringify({ valid: false, error: 'apiKey belum diisi' })); return;
      }
      callLLM(conn, [{ role: 'user', content: 'Reply with just: OK' }]).then(reply => {
        res.writeHead(200); res.end(JSON.stringify({ valid: true, reply: reply.slice(0, 80) }));
      }).catch(err => {
        res.writeHead(200); res.end(JSON.stringify({ valid: false, error: err.message }));
      });
    });
    return;
  }

  // ── POST /api/model/classify-params → AI-assisted parameter role mapping ──
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/model/classify-params') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      let incoming;
      try { incoming = JSON.parse(body); } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'body JSON rusak' })); return;
      }
      const unclassified = incoming.params || [];
      const knownRoles = incoming.currentRoles || {};
      if (!unclassified.length) {
        res.writeHead(200); res.end(JSON.stringify({ classifications: [] })); return;
      }
      const active = getActiveConnection();
      if (!active) {
        res.writeHead(200); res.end(JSON.stringify({ classifications: [] })); return;
      }

      const prompt = `Kamu adalah pakar Live2D Cubism rigging & parameter modeling.
Berikut daftar parameter model yang BELUM memiliki mapping role baku:
${unclassified.map(u => `- ID: "${u.id}", Range: [${u.min}, ${u.max}], Default: ${u.def}`).join('\n')}

Parameter yang SUDAH ter-mapping:
${Object.entries(knownRoles).map(([r, id]) => `  ${r} -> ${id}`).join('\n') || '(belum ada)'}

Daftar semantic roles yang tersedia:
[${KNOWN_ROLES.join(', ')}]

TUGAS: Analisis setiap parameter di atas (berdasarkan nama ID, range, naming convention JP/CN/EN, dan fungsinya di Live2D).
Tentukan:
- id: ID parameter yang bersangkutan
- role: salah satu nama role di atas, atau null jika ini aksesoris/parts kustom/fisika
- group: "Sudut (Angle)", "Mata (Eye)", "Alis (Eyebrow)", "Mulut (Mouth)", "Badan (Body)", "Rambut (Hair)", "Aksesoris (Accessory)", "Physics", atau "Kustom"
- label: nama ringkas yang mudah dipahami manusia (misal "Kedip Mata Kiri", "Pipi Merah")
- isAccessory: boolean true jika ini toggle aksesoris/properti (0/1)

KEMBALIKAN HANYA JSON array valid tanpa markdown formatting tambahan atau pembuka/penutup kata.
Format:
[
  { "id": "ParamX", "role": "angleX", "group": "Sudut (Angle)", "label": "Kepala X", "isAccessory": false }
]`;

      llmWithFallback([{ role: 'user', content: prompt }]).then(({ reply }) => {
        let clean = reply.replace(/```json/gi, '').replace(/```/g, '').trim();
        let parsed = [];
        try { parsed = JSON.parse(clean); } catch (e) {
          // Attempt extraction of JSON array
          const m = clean.match(/\[\s*\{[\s\S]*\}\s*\]/);
          if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
        }
        // Never hand raw LLM output to the client. Only ids that were actually
        // in the request survive, group/label are length-capped strings, role
        // must be a known role, and any min/max/def the LLM tried to smuggle in
        // is dropped outright (ranges come from Cubism Core, never from an LLM).
        const requestedIds = new Set(unclassified.map(u => String(u.id)));
        const allowedRoles = new Set(KNOWN_ROLES);
        const str = (v, cap) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, cap) : '');
        const safe = (Array.isArray(parsed) ? parsed : []).reduce((acc, it) => {
          if (!it || typeof it !== 'object') return acc;
          const id = String(it.id == null ? '' : it.id);
          if (!requestedIds.has(id)) return acc;   // hallucinated / unrelated id
          const role = typeof it.role === 'string' && allowedRoles.has(it.role) ? it.role : null;
          acc.push({
            id,
            role,
            group: str(it.group, 40),
            label: str(it.label, 60),
            isAccessory: it.isAccessory === true,
          });
          return acc;
        }, []);
        if (Array.isArray(parsed) && safe.length !== parsed.length) {
          console.warn('[classify-params] dropped', parsed.length - safe.length, 'invalid/hallucinated item(s)');
        }
        res.writeHead(200);
        res.end(JSON.stringify({ classifications: safe }));
      }).catch(err => {
        console.warn('[classify-params] AI classification failed:', err.message);
        res.writeHead(200);
        res.end(JSON.stringify({ classifications: [], warning: err.message }));
      });
    });
    return;
  }

  // ── POST /api/model/analyze-sheet → AI-suggested PRESETS ──
  // Distinct from classify-params: that one labels individual parameters, this
  // one proposes whole poses (emosi / properti / aksesoris) as preset
  // candidates. Everything it returns lands in sheet.presets.ai, which is inert
  // until the user presses "Pakai" in the Sheet tab.
  //
  // Validation posture: the LLM is allowed to contribute NAMES, CATEGORIES and
  // TARGET VALUES only. Ranges (min/max/def) and timed keyframes (steps) are
  // never accepted from it — ranges come from Cubism Core via the client, and a
  // frozen pose is not a motion. Values are clamped to the ranges the CLIENT
  // sent, so a hallucinated 999 becomes the parameter's real max instead of
  // deforming the model.
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/model/analyze-sheet') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      let incoming;
      try { incoming = JSON.parse(body); } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'body JSON rusak' })); return;
      }

      // Only params that carry a finite range are usable: without min/max there
      // is nothing to clamp against, and an unclamped write is how a model gets
      // deformed.
      const params = (Array.isArray(incoming.params) ? incoming.params : [])
        .filter(p => p && typeof p.id === 'string' && p.id
          && Number.isFinite(Number(p.min)) && Number.isFinite(Number(p.max)))
        .slice(0, 300);
      const parts = (Array.isArray(incoming.parts) ? incoming.parts : [])
        .map(p => (p && typeof p === 'object') ? p.id : p)
        .filter(p => typeof p === 'string' && p)
        .slice(0, 300);
      // Names the user already owns. Sent to the LLM so it does not spend
      // suggestions re-proposing what exists, and used below to drop collisions
      // outright — a suggestion must never overwrite a user preset.
      const existing = (Array.isArray(incoming.existingNames) ? incoming.existingNames : [])
        .filter(n => typeof n === 'string').map(n => n.toLowerCase()).slice(0, 400);
      // 'gerak' is intentionally absent: motions need timed keyframes, which
      // this endpoint refuses to accept from an LLM.
      const CATS = ['emosi', 'properti', 'aksesoris'];

      if (!params.length) {
        res.writeHead(200); res.end(JSON.stringify({ presets: [], warning: 'tidak ada parameter dengan range valid' })); return;
      }
      const active = getActiveConnection();
      if (!active) {
        res.writeHead(200); res.end(JSON.stringify({ presets: [], warning: 'tidak ada koneksi AI aktif' })); return;
      }

      const paramLines = params.map(p => {
        const label = typeof p.label === 'string' && p.label.trim() ? ` (${p.label.trim().slice(0, 40)})` : '';
        return `- "${p.id}"${label} range [${Number(p.min)}, ${Number(p.max)}] default ${Number(p.def)}`;
      }).join('\n');

      const prompt = `Kamu pakar rigging Live2D Cubism. Berdasarkan daftar parameter model di bawah, usulkan preset pose yang masuk akal untuk model INI.

PARAMETER TERSEDIA (hanya id di bawah yang boleh dipakai):
${paramLines}

${parts.length ? `PART TERSEDIA (opacity 0..1):\n${parts.map(p => `- "${p}"`).join('\n')}` : '(model tidak punya part yang bisa diatur)'}

PRESET YANG SUDAH ADA (jangan diusulkan lagi):
${existing.length ? existing.join(', ') : '(belum ada)'}

TUGAS: usulkan maksimal 12 preset. Untuk tiap preset tentukan:
- name: nama singkat bahasa Indonesia (maks 60 karakter), mis. "Senang", "Kacamata", "Pipi Merah"
- category: salah satu dari ${CATS.join(' / ')}
  · emosi     = ekspresi wajah (mata, alis, mulut)
  · properti  = perubahan tampilan non-aksesoris (warna pipi, ganti kerah)
  · aksesoris = toggle benda yang dipakai/dilepas
- values: objek { "ParamId": angka } berisi HANYA id dari daftar di atas
- parts: objek { "PartId": angka 0..1 }, boleh kosong

ATURAN KERAS:
1. JANGAN mengarang id parameter atau part yang tidak ada di daftar.
2. JANGAN menyertakan min, max, def, atau steps. Itu bukan tugasmu.
3. Sertakan hanya parameter yang benar-benar berubah dari default (3-8 per preset).
4. Kategori "gerak" TIDAK BOLEH diusulkan.

KEMBALIKAN HANYA JSON array valid, tanpa markdown atau kata pembuka/penutup.
Format:
[
  { "name": "Senang", "category": "emosi", "values": { "ParamMouthForm": 1 }, "parts": {} }
]`;

      llmWithFallback([{ role: 'user', content: prompt }]).then(({ reply }) => {
        let clean = reply.replace(/```json/gi, '').replace(/```/g, '').trim();
        let parsed = [];
        try { parsed = JSON.parse(clean); } catch (e) {
          const m = clean.match(/\[\s*\{[\s\S]*\}\s*\]/);
          if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
        }

        const ranges = new Map(params.map(p => [p.id, { lo: Number(p.min), hi: Number(p.max) }]));
        const partIds = new Set(parts);
        const existingSet = new Set(existing);
        const str = (v, cap) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, cap) : '');
        const seen = new Set();
        let dropped = 0;

        const safe = (Array.isArray(parsed) ? parsed : []).reduce((acc, it) => {
          if (!it || typeof it !== 'object' || Array.isArray(it)) { dropped++; return acc; }
          const name = str(it.name, 60);
          const category = CATS.indexOf(it.category) !== -1 ? it.category : null;
          if (!name || !category) { dropped++; return acc; }
          // A suggestion that shadows a user preset is pointless: precedence
          // means it would never be visible anyway.
          const key = category + '\u0000' + name.toLowerCase();
          if (existingSet.has(name.toLowerCase()) || seen.has(key)) { dropped++; return acc; }

          const values = {};
          if (it.values && typeof it.values === 'object' && !Array.isArray(it.values)) {
            for (const k of Object.keys(it.values)) {
              const r = ranges.get(k);
              const n = Number(it.values[k]);
              if (!r || !Number.isFinite(n)) continue;      // invented id or NaN
              values[k] = Math.max(r.lo, Math.min(r.hi, n)); // clamp to Cubism range
            }
          }
          const pparts = {};
          if (it.parts && typeof it.parts === 'object' && !Array.isArray(it.parts)) {
            for (const k of Object.keys(it.parts)) {
              const n = Number(it.parts[k]);
              if (!partIds.has(k) || !Number.isFinite(n)) continue;
              pparts[k] = Math.max(0, Math.min(1, n));       // opacity is always 0..1
            }
          }
          // An empty preset would show up in the UI as an approvable row that
          // does nothing when applied.
          if (!Object.keys(values).length && !Object.keys(pparts).length) { dropped++; return acc; }

          seen.add(key);
          // Note what is NOT copied: min/max/def and steps never leave this
          // reducer, even if the LLM sent them.
          acc.push({ name, category, values: values, parts: pparts, source: 'ai' });
          return acc;
        }, []).slice(0, 12);

        if (dropped) console.warn('[analyze-sheet] dropped', dropped, 'invalid/hallucinated preset(s)');
        res.writeHead(200);
        res.end(JSON.stringify({ presets: safe }));
      }).catch(err => {
        console.warn('[analyze-sheet] preset analysis failed:', err.message);
        res.writeHead(200);
        res.end(JSON.stringify({ presets: [], warning: err.message }));
      });
    });
    return;
  }

  // ── POST /api/animate-text → Two-pass animation director ──
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/animate-text') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      let incoming;
      try { incoming = JSON.parse(body); } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'body JSON rusak' })); return;
      }
      const text = (incoming.text || '').trim();
      const caps = incoming.capabilities || {};
      const emotions = (caps.emotions && caps.emotions.length) ? caps.emotions : ['senang', 'sedih', 'malu', 'kaget', 'normal'];
      const gestures = (caps.gestures && caps.gestures.length) ? caps.gestures : ['nod', 'shake', 'tilt_curious', 'lean_excited', 'recoil_surprised', 'look_away_shy', 'laugh_bounce', 'think', 'wave_hi'];

      if (!text) {
        res.writeHead(200); res.end(JSON.stringify({ segments: [] })); return;
      }

      const active = getActiveConnection();
      if (!active) {
        res.writeHead(200); res.end(JSON.stringify({ segments: [{ text, emotion: 'normal', gesture: 'nod', intensity: 0.7 }] })); return;
      }

      const directorPrompt = `Kamu adalah animation director untuk karakter Live2D Anime yang hidup dan ekspresif.
Karakter baru saja berbicara teks berikut:
"${text}"

Daftar Emosi yang didukung model: [${emotions.join(', ')}]
Daftar Gesture yang tersedia: [${gestures.join(', ')}]

TUGAS:
1. Pecah teks di atas menjadi beberapa segment (per klausa atau per kalimat) agar karakter bergerak seirama omongannya secara hidup (jangan diam selama bicara!).
2. Untuk setiap segment, tentukan:
   - "text": teks klausa/kalimat tersebut (harus sama persis dengan teks asli bila digabung kembali)
   - "emotion": emosi yang SANGAT SESUAI dengan makna klausa tersebut (dari daftar emosi di atas)
   - "gesture": nama gesture yang pas (atau null jika netral)
   - "intensity": angka 0.3 s/d 1.0 (seberapa kuat ekspresinya, 0.4=halus, 0.8=ekspresif)

KEMBALIKAN HANYA JSON array valid tanpa markdown formatting atau kata pengantar.
Contoh format:
[
  { "text": "Halo semuanya!", "emotion": "senang", "gesture": "wave_hi", "intensity": 0.9 },
  { "text": "Aku senang banget ketemu kalian lagi.", "emotion": "senang", "gesture": "lean_excited", "intensity": 0.8 }
]`;

      llmWithFallback([{ role: 'user', content: directorPrompt }]).then(({ reply }) => {
        let clean = reply.replace(/```json/gi, '').replace(/```/g, '').trim();
        let parsed = [];
        try { parsed = JSON.parse(clean); } catch (e) {
          const m = clean.match(/\[\s*\{[\s\S]*\}\s*\]/);
          if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
        }
        // Validate against what this model can actually do: an emotion or
        // gesture the model doesn't have would drive the animation code with a
        // name it can't resolve. Unknown emotion → 'normal', unknown gesture →
        // null (neutral), intensity clamped to the documented 0.3–1.0 band.
        const okEmotion = new Set(emotions);
        const okGesture = new Set(gestures);
        const segments = (Array.isArray(parsed) ? parsed : []).reduce((acc, s) => {
          if (!s || typeof s !== 'object') return acc;
          const t = typeof s.text === 'string' ? s.text : '';
          if (!t.trim()) return acc;
          let inten = Number(s.intensity);
          if (!Number.isFinite(inten)) inten = 0.7;
          acc.push({
            text: t,
            emotion: okEmotion.has(s.emotion) ? s.emotion : 'normal',
            gesture: okGesture.has(s.gesture) ? s.gesture : null,
            intensity: Math.min(1.0, Math.max(0.3, inten)),
          });
          return acc;
        }, []);
        res.writeHead(200);
        res.end(JSON.stringify({
          segments: segments.length ? segments : [{ text, emotion: 'normal', gesture: 'nod', intensity: 0.7 }],
        }));
      }).catch(err => {
        console.warn('[animate-text] fallback due to error:', err.message);
        res.writeHead(200);
        res.end(JSON.stringify({ segments: [{ text, emotion: 'normal', gesture: 'nod', intensity: 0.7 }] }));
      });
    });
    return;
  }

  // ── Model management: list / upload / delete user-imported models ──
  // A Live2D model is a FOLDER of assets (model3.json + .moc3 + .png + .exp3…)
  // that reference each other by relative path. We store uploaded folders
  // under ROOT/model/<name>/ and load them by HTTP path, so sibling assets
  // resolve correctly. Upload is JSON-driven: the client sends each file's
  // relative path + base64 body; the server writes them under model/<name>/.
  const MODELS_DIR = path.join(ROOT, 'model');

  // Recursively find the FIRST *.model3.json under a directory.
  // Handles nested layouts (e.g. lumine_l2d/lumine/lumine.model3.json).
  function findModel3(rootDir, depth = 0) {
    let hit = null;
    try {
      for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        const full = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
          if (depth > 6) continue;            // guard against crazy nesting
          const r = findModel3(full, depth + 1);
          if (r) return r;
        } else if (entry.name.toLowerCase().endsWith('.model3.json') || entry.name.toLowerCase() === 'model3.json') {
          return full;
        }
      }
    } catch (e) { /* ignore unreadable dirs */ }
    return hit;
  }

  // Recursively find the FIRST *.cdi3.json under a directory. This file maps
  // each parameter ID to the DISPLAY NAME the rigger typed in Cubism, which is
  // the only model-agnostic source of meaning for opaque ids like 'Param92'.
  function findCdi3(rootDir, depth = 0) {
    try {
      for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        const full = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
          if (depth > 6) continue;
          const r = findCdi3(full, depth + 1);
          if (r) return r;
        } else if (entry.name.toLowerCase().endsWith('.cdi3.json')) {
          return full;
        }
      }
    } catch (e) { /* ignore unreadable dirs */ }
    return null;
  }

  // GET /api/model/path?name=X -> the model3.json path inside that folder
  // (recursive, so nested folders work too)
  if (req.method === 'GET' && urlPath === '/api/model/path') {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const name = q.get('name');
      const dir = path.join(MODELS_DIR, name || '');
      if (!dir.startsWith(MODELS_DIR) || !fs.existsSync(dir)) throw new Error('not found');
      const abs = findModel3(dir);
      if (!abs) throw new Error('no model3.json in folder');
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      res.writeHead(200, JSON_HEAD);
      res.end(JSON.stringify({ path: rel }));
    } catch (e) {
      res.writeHead(404, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/model/expressions-adoption?name=X
  // Langkah 2d: lets the UI show a per-file checkbox for the auto-adopted
  // orphaned .exp3 files, and reports which ones the user has switched OFF.
  // The disabled list is persisted per-model under sheets/ as
  // exp3-adoption_<folder>.json ({ disabled: [Name,...] }). Adoption stays
  // ON by default — this only lets the user opt OUT of specific files.
  if (req.method === 'GET' && urlPath === '/api/model/expressions-adoption') {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const name = q.get('name');
      // Reuse the discovery endpoint (no await — the request handler is not async).
      const base = (typeof API === 'string' && /^https?:/.test(API)) ? API : ('http://127.0.0.1:' + PORT);
      fetch(base + '/api/model/expressions?name=' + encodeURIComponent(name || ''))
        .then(eRes => eRes.ok ? eRes.json() : Promise.reject(new Error('expressions discovery failed')))
        .then(info => {
          const adoptFile = path.join(SHEETS_DIR, 'exp3-adoption_' + String(name || '').replace(/[^A-Za-z0-9_\\-]+/g, '_') + '.json');
          let disabled = [];
          try { const j = JSON.parse(fs.readFileSync(adoptFile, 'utf8')); if (Array.isArray(j.disabled)) disabled = j.disabled; } catch (e) {}
          const disabledSet = new Set(disabled);
          const expressions = (info.expressions || []).map(e => Object.assign({}, e, { enabled: !disabledSet.has(e.Name) }));
          res.writeHead(200, JSON_HEAD);
          res.end(JSON.stringify({ model3: info.model3, expressions, disabled: Array.from(disabledSet) }));
        })
        .catch(err => { res.writeHead(500, JSON_HEAD); res.end(JSON.stringify({ error: err.message })); });
    } catch (e) {
      res.writeHead(404, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/model/expressions-adoption  body: { name, disabled:[Name,...] }
  // Persists the user's opt-out list for orphaned .exp3 adoption. Only the
  // `disabled` array is honoured; unknown keys are ignored.
  if (req.method === 'POST' && urlPath === '/api/model/expressions-adoption') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      let incoming;
      try { incoming = JSON.parse(body); } catch (e) {
        res.writeHead(400, JSON_HEAD); res.end(JSON.stringify({ error: 'body JSON rusak' })); return;
      }
      try {
        const name = String(incoming.name || '').replace(/[^A-Za-z0-9_\\-]+/g, '_');
        if (!name) throw new Error('name kosong');
        const disabled = Array.isArray(incoming.disabled) ? incoming.disabled.filter(x => typeof x === 'string') : [];
        const adoptFile = path.join(SHEETS_DIR, 'exp3-adoption_' + name + '.json');
        writeJsonAtomic(adoptFile, { disabled });
        res.writeHead(200, JSON_HEAD);
        res.end(JSON.stringify({ ok: true, disabled }));
      } catch (e) {
        res.writeHead(500, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Lists every *.exp3.json that physically exists under model/<X>/, with each
  // File path expressed RELATIVE TO THE model3.json DIRECTORY (which is how
  // Cubism manifests reference them, and how pixi-live2d resolves them).
  //
  // WHY THIS EXISTS: a rigger can ship .exp3 files and forget to list them in
  // model3.json's FileReferences.Expressions. The runtime then reports zero
  // native expressions and the assets are dead weight — no error, just a
  // character that cannot use the expressions it was shipped with. The browser
  // cannot enumerate a directory, so discovery has to happen here.
  //
  // This is deliberately generic: no model name, no expression name, no folder
  // convention is special-cased. Any model with orphaned .exp3 files benefits.
  if (req.method === 'GET' && urlPath === '/api/model/expressions') {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const name = q.get('name');
      const dir = path.join(MODELS_DIR, name || '');
      if (!dir.startsWith(MODELS_DIR) || !fs.existsSync(dir)) throw new Error('not found');
      const model3 = findModel3(dir);
      if (!model3) throw new Error('no model3.json in folder');
      const baseDir = path.dirname(model3);

      // What the manifest already declares — reported so the client can tell
      // "orphaned assets" from "already wired up" without guessing.
      let declared = [];
      try {
        const mj = JSON.parse(stripBom(fs.readFileSync(model3, 'utf8')));
        const ex = mj && mj.FileReferences && mj.FileReferences.Expressions;
        if (Array.isArray(ex)) declared = ex.map(e => e && e.File).filter(Boolean);
      } catch (e) { /* unreadable manifest → treat as declaring nothing */ }
      const declaredSet = new Set(declared.map(f => String(f).split(path.sep).join('/')));

      const found = [];
      (function walk(d, depth) {
        if (depth > 6) return;
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) { walk(full, depth + 1); continue; }
          if (!entry.name.toLowerCase().endsWith('.exp3.json')) continue;
          const rel = path.relative(baseDir, full).split(path.sep).join('/');
          // An .exp3 outside the model3.json directory cannot be referenced by a
          // relative path the loader can resolve, so skip it rather than emit a
          // path that would 404 at load time.
          if (rel.startsWith('..')) continue;
          found.push({
            Name: entry.name.replace(/\.exp3\.json$/i, ''),
            File: rel,
            declared: declaredSet.has(rel),
          });
        }
      })(dir, 0);

      found.sort((a, b) => a.Name.localeCompare(b.Name));
      res.writeHead(200, JSON_HEAD);
      res.end(JSON.stringify({
        model3: path.relative(ROOT, model3).split(path.sep).join('/'),
        declaredCount: declaredSet.size,
        expressions: found,
        orphanCount: found.filter(f => !f.declared).length,
      }));
    } catch (e) {
      res.writeHead(404, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/model/import-zip  body: { name?, base64 }
  // Accepts a .zip of a Live2D model folder, extracts it under model/<name>/,
  // descends into nesting to locate the .model3.json, and returns its path.
  if (req.method === 'POST' && urlPath === '/api/model/import-zip') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 500 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, base64 } = JSON.parse(body);
        if (!base64) throw new Error('zip kosong');
        const clean = (name || '').trim().replace(/[^A-Za-z0-9_\-]+/g, '_') || ('model_' + Date.now().toString(36));
        const dest = path.join(MODELS_DIR, clean);
        fs.mkdirSync(dest, { recursive: true });
        const zipPath = path.join(dest, '_upload.zip');
        fs.writeFileSync(zipPath, Buffer.from(base64, 'base64'));

        // Extract: prefer system `unzip` (git-bash/MSYS has it), else PowerShell.
        try {
          execSync(`unzip -o -q "${zipPath}" -d "${dest}"`, { stdio: 'ignore' });
        } catch (e) {
          try {
            execSync(`powershell -NoProfile -Command "Expand-Archive -Force '${zipPath.replace(/'/g, "''")}' '${dest.replace(/'/g, "''")}'"`, { stdio: 'ignore' });
          } catch (e2) { throw new Error('gagal extract zip: ' + (e2.message || e.message)); }
        }

        const abs = findModel3(dest);
        if (!abs) { throw new Error('zip tidak mengandung *.model3.json'); }
        const rel = path.relative(ROOT, abs).split(path.sep).join('/');
        try { fs.unlinkSync(zipPath); } catch (e) {}
        res.writeHead(200, JSON_HEAD);
        res.end(JSON.stringify({ ok: true, name: clean, path: rel }));
      } catch (e) {
        res.writeHead(400, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Character Sheet persistence (file-backed, not just localStorage) ──
  // The browser inspects a model deeply, then saves the "character sheet"
  // (all params + ranges, expressions, accessories) to a JSON file under
  // ROOT/sheets/<modelKey>.json. This lets the AI reuse the profile on every
  // chat WITHOUT re-inspecting the model each time — exactly the behavior the
  // user asked for. A GET returns the saved sheet (or 404 if none yet).
  const SHEETS_DIR = path.join(ROOT, 'sheets');
  // Filesystem-safe key for a model name. CJK is preserved (models are often
  // named 神宫白子) — only characters that break paths are collapsed.
  function sanitizeKey(name) {
    return (name || 'default').replace(/[^A-Za-z0-9_\u4e00-\u9fff]/g, '_');
  }
  function sheetPathFor(name) {
    return path.join(SHEETS_DIR, sanitizeKey(name) + '.json');
  }
  if (req.method === 'POST' && urlPath === '/api/sheet') {
    let body = '';
    let aborted = false;
    req.on('data', c => { body += c; if (body.length > 5 * 1024 * 1024) { aborted = true; req.destroy(); } });
    req.on('end', () => {
      if (aborted) return;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const data = JSON.parse(body);
        const name = (data.modelName || 'default');
        const sheet = data.sheet || data;
        if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) throw new Error('sheet kosong');
        const target = sheetPathFor(name);
        // Serialized + atomic: two writers for the same model (inspect finishing
        // while ai-classify posts its update, or the sheet editor's Save landing
        // at the same moment) can no longer interleave into a torn file.
        queueJsonWrite(target, sheet).then(() => {
          console.log('[server] character sheet saved ->', target);
          res.writeHead(200, JSON_HEAD);
          res.end(JSON.stringify({ ok: true, path: path.relative(ROOT, target).split(path.sep).join('/') }));
        }).catch(e => {
          res.writeHead(500, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
        });
      } catch (e) {
        res.writeHead(400, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/sheet') {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const p = sheetPathFor(q.get('name') || 'default');
      if (!fs.existsSync(p)) { res.writeHead(404, JSON_HEAD); res.end(JSON.stringify({ error: 'no sheet' })); return; }
      const raw = fs.readFileSync(p, 'utf8');
      res.writeHead(200, JSON_HEAD); res.end(raw);
    } catch (e) {
      res.writeHead(500, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/models -> list of model folders that contain a *.model3.json
  // (searched recursively, so nested layouts like MyChar/CharA.model3.json count)
  if (req.method === 'GET' && urlPath === '/api/models') {
    try {
      if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
      const folders = fs.readdirSync(MODELS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .filter(name => {
          const dir = path.join(MODELS_DIR, name);
          try { return !!findModel3(dir); } catch (e) { return false; }
        })
        .sort();
      res.writeHead(200, JSON_HEAD);
      res.end(JSON.stringify({ models: folders }));
    } catch (e) {
      res.writeHead(500, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/model/files?name=X -> every file under that model folder (recursive).
  // Used by the frontend to discover assets the model3.json may NOT list
  // (e.g. .exp3.json expression files), so the UI can label/toggle them by the
  // modeler-given names instead of guessing. Paths are relative to MODELS_DIR.
  if (req.method === 'GET' && urlPath === '/api/model/files') {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const name = q.get('name');
      const dir = path.join(MODELS_DIR, name || '');
      if (!dir.startsWith(MODELS_DIR) || !fs.existsSync(dir)) {
        res.writeHead(404, JSON_HEAD); res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const out = [];
      (function walk(d, rel) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) walk(full, r);
          else out.push(r);
        }
      })(dir, '');
      res.writeHead(200, JSON_HEAD);
      res.end(JSON.stringify({ name: name || '', files: out }));
    } catch (e) {
      res.writeHead(500, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/model/motion-taxonomy?name=X
  // Parse EVERY *.motion3.json under the model folder and classify each clip
  // into a semantic verb (nod / happy / sad / surprised / ...) by analysing its
  // actual parameter curves — see js/motion-taxonomy.js.
  //
  // WHY SERVER-SIDE: a model like Ichika ships 300+ motion files. Fetching and
  // parsing them all in the browser on every page load is slow and blocks the
  // canvas; doing it once here (and caching to sheets/<model>.motions.json)
  // keeps startup instant. The browser asks for this once per model and folds
  // the result into the character sheet.
  if (req.method === 'GET' && urlPath === '/api/model/motion-taxonomy') {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const name = q.get('name') || '';
      const force = q.get('force') === '1';
      const dir = path.join(MODELS_DIR, name);
      if (!dir.startsWith(MODELS_DIR) || !fs.existsSync(dir)) throw new Error('model not found');

      const cacheFile = path.join(SHEETS_DIR, sanitizeKey(name) + '.motions.json');
      if (!force && fs.existsSync(cacheFile)) {
        res.writeHead(200, JSON_HEAD);
        res.end(fs.readFileSync(cacheFile, 'utf8'));
        return;
      }

      // Collect clip files. The GROUP NAME the runtime must call is whatever
      // the model3.json declares; when the model3 has no Motions block (many
      // do not) pixi-live2d-display falls back to the file basename, so we key
      // on that and also record the file path.
      const clips = [];
      (function walk(d, rel) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) walk(full, r);
          else if (/\.motion3\.json$/i.test(e.name)) clips.push({ file: r, abs: full });
        }
      })(dir, '');

      // Map file -> declared group/index from model3.json when available, so
      // the verb we hand the runtime is something model.motion(group, idx) can
      // actually play.
      const groupOf = {};
      try {
        const m3 = findModel3(dir);
        if (m3) {
          const j = JSON.parse(fs.readFileSync(m3, 'utf8'));
          const motions = (j.FileReferences && j.FileReferences.Motions) || {};
          const m3dir = path.dirname(m3);
          for (const g in motions) {
            (motions[g] || []).forEach((entry, idx) => {
              if (!entry || !entry.File) return;
              const abs = path.resolve(m3dir, entry.File);
              groupOf[abs] = { group: g, index: idx };
            });
          }
        }
      } catch (e) { /* model3 unreadable → fall back to basenames */ }

      const taxo = require('./js/motion-taxonomy.js');

      // Resolve semantic ROLES from the model's own .cdi3.json display names.
      // Parameter IDs are often meaningless ('ParamEX10', 'Param92', 'ParamAnime01');
      // the cdi3 file carries the label the rigger actually typed ('tear',
      // 'angry eye', '生气', 'guruguru'). Without this, curve analysis simply
      // cannot see those params and the classifier degrades to guessing from
      // filenames — which fails completely on models named m_001, m_002, ...
      let roleMap = null;
      try {
        const cdi3Path = findCdi3(dir);
        if (cdi3Path) {
          const built = taxo.buildRoleMap(JSON.parse(fs.readFileSync(cdi3Path, 'utf8')));
          roleMap = built.map;
          console.log('[motion-taxonomy]', name, 'roles from', path.basename(cdi3Path) + ':',
            built.stats.byId, 'by id +', built.stats.byDisplay, 'by display name =',
            Object.keys(roleMap).length, '/', built.stats.total, 'params');
        } else {
          console.log('[motion-taxonomy]', name, 'has no .cdi3.json — opaque param ids will be unreadable');
        }
      } catch (e) { console.warn('[motion-taxonomy] cdi3 unreadable:', e.message); }

      const input = [];
      for (const c of clips) {
        let motion3 = null;
        try { motion3 = JSON.parse(fs.readFileSync(c.abs, 'utf8')); } catch (e) {}
        const g = groupOf[path.resolve(c.abs)];
        input.push({
          name: g ? g.group : path.basename(c.file).replace(/\.motion3\.json$/i, ''),
          group: g ? g.group : null,
          index: g ? g.index : null,
          file: c.file,
          motion3,
        });
      }
      const built = taxo.buildTaxonomy(input, roleMap);
      // Re-attach group/index/file to each classified entry (buildTaxonomy only
      // keeps name+verb) so the runtime can play the exact clip, not just a group.
      built.clips = built.clips.map((entry, i) => Object.assign({}, entry, {
        group: input[i].group, index: input[i].index, file: input[i].file,
      }));
      const payload = { model: name, generatedAt: new Date().toISOString(), clipCount: input.length, ...built };

      try {
        queueJsonWrite(cacheFile, payload).catch(e =>
          console.warn('[motion-taxonomy] cache write failed:', e.message));
      } catch (e) { console.warn('[motion-taxonomy] cache write failed:', e.message); }

      console.log('[motion-taxonomy]', name, '->', input.length, 'clips,',
        JSON.stringify(built.stats), Object.keys(built.byVerb).join('/'));
      res.writeHead(200, JSON_HEAD);
      res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(400, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/model/upload  body: { name, files:[{path, base64}] }
  if (req.method === 'POST' && urlPath === '/api/model/upload') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 200 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, files } = JSON.parse(body);
        if (!name || !/^[^/\\.\s][^/\\]*$/.test(name)) throw new Error('nama model invalid');
        if (!Array.isArray(files) || !files.length) throw new Error('tidak ada file');
        const dest = path.join(MODELS_DIR, name);
        fs.mkdirSync(dest, { recursive: true });
        let wroteModel3 = false;
        for (const f of files) {
          // f.path is relative inside the model folder; sanitize + no traversal
          const rel = path.normalize(f.path || '').replace(/^(\.\.[\/\\])+/, '');
          if (!rel || rel.startsWith('..') || /^[\/\\]/.test(rel)) continue;
          if (/model3\.json$/i.test(rel)) wroteModel3 = true;
          const target = path.join(dest, rel);
          if (!target.startsWith(dest)) continue; // safety
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, Buffer.from(f.base64 || '', 'base64'));
        }
        if (!wroteModel3) throw new Error('folder tidak mengandung *.model3.json');
        res.writeHead(200, JSON_HEAD);
        res.end(JSON.stringify({ ok: true, name }));
      } catch (e) {
        res.writeHead(400, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // DELETE /api/model/:name -> remove a model folder
  if (req.method === 'DELETE' && urlPath.startsWith('/api/model/')) {
    const name = decodeURIComponent(urlPath.slice('/api/model/'.length));
    try {
      const dir = path.join(MODELS_DIR, name);
      if (!dir.startsWith(MODELS_DIR) || !fs.existsSync(dir)) throw new Error('not found');
      fs.rmSync(dir, { recursive: true, force: true });
      res.writeHead(200, JSON_HEAD); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, JSON_HEAD); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const filePath = safeJoin(ROOT, urlPath);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      try { res.destroy(); } catch (e) {}
    });
    stream.pipe(res);
  });
});

ensureConfig();

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  🎭 Live2D Agent server running at:\n  ${url}\n\n  Tekan Ctrl+C untuk menghentikan.\n`);
  // Auto-open in default browser (skip if no TTY / headless)
  if (process.stdout.isTTY !== false) {
    try {
      const { exec } = require('child_process');
      const cmd = process.platform === 'win32'
        ? `start "" "${url}"`
        : process.platform === 'darwin'
          ? `open "${url}"`
          : `xdg-open "${url}"`;
      exec(cmd);
    } catch (e) { /* non-fatal */ }
  }
});
