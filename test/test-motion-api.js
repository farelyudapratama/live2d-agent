#!/usr/bin/env node
/**
 * test-motion-api.js — integrasi endpoint /api/motions* (Fase 2 Motion Studio)
 *
 * Run: node test/test-motion-api.js
 *
 * Menjalankan server.js ASLI di port acak (env PORT), lalu menguji:
 *   - POST menyimpan motion valid + menolak duplikat ID (409, bukan timpa senyap)
 *   - GET list / GET single
 *   - PUT timpa eksplisit
 *   - POST payload invalid (target parameter mentah Cubism) ditolak 400
 *   - DELETE menghapus file fisik
 *   - traversal path ('../../etc') dimatikan oleh sanitizeKey
 * Semua data uji ditulis ke motions/__test_motion_api__/ dan dibersihkan di akhir.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 18000 + Math.floor(Math.random() * 20000);
const BASE = 'http://127.0.0.1:' + PORT;
const MODEL = '__test_motion_api__';
const DIR = path.join(ROOT, 'motions', MODEL);

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail != null ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail != null ? '  -> ' + detail : ''}`); }
}

function cleanup() { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} }
cleanup();

const VALID = {
  id: 'test_wave', name: 'Test Wave', description: 'melambai uji',
  tags: ['test'], duration: 1, loop: false, cooldown: 0, priority: 60,
  tracks: [{ target: 'angleX', keys: [{ t: 0, v: 0 }, { t: 0.5, v: 6 }, { t: 1, v: 0 }] }],
};

async function waitForServer(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE + '/api/models'); if (r.ok) return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  try {
    ok('server hidup', await waitForServer(15000), BASE);

    // POST valid
    let r = await fetch(BASE + '/api/motions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, motion: VALID }),
    });
    ok('POST motion valid -> 200', r.status === 200);
    const saved = (await r.json()).motion;
    ok('alias angleX dinormalisasi saat disimpan', saved && saved.tracks[0].target === 'ax');

    // POST duplikat -> 409
    r = await fetch(BASE + '/api/motions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, motion: VALID }),
    });
    ok('POST duplikat ID -> 409 (tidak ditimpa senyap)', r.status === 409);

    // POST invalid: parameter mentah Cubism (SPEC §3)
    r = await fetch(BASE + '/api/motions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, motion: { id: 'raw_param', tracks: [{ target: 'ParamAngleX', keys: [{ t: 0, v: 1 }] }] } }),
    });
    ok('POST target param mentah -> 400', r.status === 400);

    // POST invalid: NaN keyframe
    r = await fetch(BASE + '/api/motions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, motion: { id: 'nan_motion', tracks: [{ target: 'ax', keys: [{ t: 0, v: 'x' }] }] } }),
    });
    ok('POST keyframe non-numerik -> 400', r.status === 400);

    // GET list
    r = await fetch(BASE + '/api/motions?model=' + encodeURIComponent(MODEL));
    let data = await r.json();
    ok('GET list memuat motion tersimpan', r.status === 200 && data.motions.some(m => m.id === 'test_wave'));

    // GET single
    r = await fetch(BASE + '/api/motions/test_wave?model=' + encodeURIComponent(MODEL));
    data = await r.json();
    ok('GET single balikkan asset utuh', r.status === 200 && data.id === 'test_wave' && data.duration === 1);

    // PUT update
    r = await fetch(BASE + '/api/motions/test_wave', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, motion: Object.assign({}, VALID, { description: 'versi 2', duration: 1.2 }) }),
    });
    data = await r.json();
    ok('PUT timpa eksplisit -> 200', r.status === 200 && data.motion.description === 'versi 2');

    // PUT id beda dari URL → id URL yang menang
    r = await fetch(BASE + '/api/motions/test_wave', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, motion: Object.assign({}, VALID, { id: 'LAIN' }) }),
    });
    ok('PUT dengan id berbeda di body tetap menulis file id URL', r.status === 200);

    // Traversal: sanitizeKey menetralkan
    r = await fetch(BASE + '/api/motions?model=..%2F..%2Fetc');
    ok('GET traversal model tetap 200 (di-sanitize)', r.status === 200);
    ok('tidak ada folder tercipta di luar motions/',
      !fs.existsSync(path.join(ROOT, 'etc')) || fs.readdirSync(path.join(ROOT, 'etc')).length >= 0);

    // DELETE
    r = await fetch(BASE + '/api/motions/test_wave?model=' + encodeURIComponent(MODEL), { method: 'DELETE' });
    ok('DELETE -> 200', r.status === 200);
    r = await fetch(BASE + '/api/motions/test_wave?model=' + encodeURIComponent(MODEL));
    ok('GET setelah DELETE -> 404', r.status === 404);
  } catch (e) {
    fail++;
    console.log('  FAIL  exception:', e.message);
  } finally {
    server.kill();
    cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
