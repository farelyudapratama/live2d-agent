#!/usr/bin/env node
/* test-override-guard.js — sticky overrides HARUS dimenangkan kembali di frame render.
 *
 * WHY THIS EXISTS
 * Slider parameter (dan raw drive Motion Studio) menulis lewat
 * applyOverrides()/applyRawDrive() di rAF tick milik app.js — yang jalan
 * SETELAH internalModel.update() PIXI pada frame yang sama, tetapi nilainya
 * langsung ditimpa lagi oleh update() frame BERIKUTNYA: physics.evaluate()
 * menulis ulang SEMUA parameter output physics, eyeBlink menulis ulang group
 * EyeBlink, breath menulis ulang ParamBreath — semuanya sebelum o.update()
 * yang benar-benar merender. Di lumine, 178 dari 223 parameter adalah output
 * physics, jadi slider di atas param itu tampak MATI (terukur 0% frame
 * menahan nilai slider) padahal parameternya hidup. Fix:
 * installOverrideGuard() memasang listener 'beforeModelUpdate' (dipancarkan
 * library tepat sebelum o.update(), SETELAH physics/blink/breath selesai)
 * yang menulis ulang semua sticky override + raw drive — nilai itu-lah yang
 * sampai ke render. Terukur 0% → 100% menahan nilai slider tanpa freeze.
 *
 * Guard ini mengekstrak applyOverrides() + installOverrideGuard() dari
 * app.js asli (vm), lalu menguji kontraknya terhadap internal model palsu.
 * Selain itu: pemasangan saat model dimuat dan urutan penulis di tick()
 * dicek di level sumber — menghapus panggilan itu adalah regresi senyap.
 *
 * Run: node test/legacy/test-override-guard.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── extraction helpers ───────────────────────────────────────────────────────
// Ambil sumber fungsi top-level by name dengan kurung seimbang (string-aware).
function extractFn(src, name) {
  const m = src.match(new RegExp('\\bfunction\\s+' + name + '\\s*\\('));
  if (!m) return null;
  let i = src.indexOf('{', m.index), depth = 0, inStr = null, esc = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) return src.slice(src.lastIndexOf('function', m.index + 1), i + 1); }
  }
  return null;
}

// Build a sandbox with fake coreModel + fake internalModel emitter.
function makeSandbox() {
  const writes = [];               // { id, value, weight, via }
  const cm = {
    setParameterValueById(id, v, w) { writes.push({ id, value: v, weight: w, via: 'param' }); },
  };
  const listeners = {};            // event -> [fn]
  const im = {
    __overrideGuard: false,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return im; },
    off(ev, fn) { const a = listeners[ev] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); return im; },
    emit(ev) { for (const fn of (listeners[ev] || []).slice()) fn(); },
  };
  const state = { overrides: {}, rawDrive: null, paramRange: {} };
  const sandbox = {
    state,
    coreModel: () => sandbox.__cmNull ? null : cm,
    __cmNull: false,
    __im: im,
    __writes: writes,
    __listeners: listeners,
    Number, Math, console,
  };
  vm.createContext(sandbox);
  return { sandbox, im, state, writes };
}

const aoSrc = extractFn(appSrc, 'applyOverrides');
const iogSrc = extractFn(appSrc, 'installOverrideGuard');

// ── 1. sumber ada ────────────────────────────────────────────────────────────
section('sumber fungsi ada di app.js');
ok('applyOverrides() diekstrak', !!aoSrc);
ok('installOverrideGuard() diekstrak', !!iogSrc);
ok('installOverrideGuard memasang listener beforeModelUpdate',
  !!iogSrc && /beforeModelUpdate/.test(iogSrc));
ok('installOverrideGuard juga menegaskan kembali rawDrive',
  !!iogSrc && /rawDrive/.test(iogSrc));

// ── 2. pemasangan idempoten ──────────────────────────────────────────────────
section('pemasangan guard idempoten per internal model');
{
  const { sandbox, im } = makeSandbox();
  vm.runInContext(iogSrc, sandbox);
  vm.runInContext('installOverrideGuard(__im)', sandbox);
  ok('flag __overrideGuard terpasang', im.__overrideGuard === true);
  const n1 = (sandbox.__listeners.beforeModelUpdate || []).length;
  ok('tepat satu listener terdaftar', n1 === 1, 'n=' + n1);
  vm.runInContext('installOverrideGuard(__im); installOverrideGuard(__im)', sandbox);
  const n2 = (sandbox.__listeners.beforeModelUpdate || []).length;
  ok('panggilan ulang tidak menambah listener', n2 === 1, 'n=' + n2);
  let threw = false;
  try { vm.runInContext('installOverrideGuard(null); installOverrideGuard(undefined)', sandbox); }
  catch (e) { threw = true; }
  ok('null/undefined internal model tidak melempar', !threw);
}

// ── 3. kontrak handler ───────────────────────────────────────────────────────
section('handler beforeModelUpdate menulis ulang semua nilai sticky');
{
  const { sandbox, im, state, writes } = makeSandbox();
  vm.runInContext(iogSrc, sandbox);
  vm.runInContext('installOverrideGuard(__im)', sandbox);
  writes.length = 0;

  state.overrides.ParamSkirtX1 = -1;                    // bentuk flat
  state.overrides.ParamA = { value: 0.5, weight: 0.7 }; // bentuk {value,weight}
  state.rawDrive = { ParamBreath: 5, ParamBad: NaN };   // clamp + skip non-finite
  state.paramRange.ParamBreath = { min: 0, max: 1 };

  im.emit('beforeModelUpdate');
  const find = (id) => writes.find(w => w.id === id);
  const w1 = find('ParamSkirtX1');
  ok('override flat ditulis', !!w1 && w1.value === -1 && w1.weight === 1,
    w1 ? `value=${w1.value} weight=${w1.weight}` : 'tidak ditulis');
  const w2 = find('ParamA');
  ok('override {value,weight} ditulis dengan bobotnya', !!w2 && w2.value === 0.5 && w2.weight === 0.7,
    w2 ? `value=${w2.value} weight=${w2.weight}` : 'tidak ditulis');
  const w3 = find('ParamBreath');
  ok('rawDrive di-clamp ke range model', !!w3 && w3.value === 1,
    w3 ? `value=${w3.value}` : 'tidak ditulis');
  ok('rawDrive non-finite dilewati', !find('ParamBad'));

  writes.length = 0;
  state.rawDrive = null;
  let threw = false;
  try { im.emit('beforeModelUpdate'); } catch (e) { threw = true; }
  ok('rawDrive null → tidak melempar', !threw);
  ok('override tetap ditulis saat rawDrive null',
    writes.some(w => w.id === 'ParamSkirtX1'));

  sandbox.__cmNull = true;
  writes.length = 0;
  threw = false;
  try { im.emit('beforeModelUpdate'); } catch (e) { threw = true; }
  ok('coreModel null → tidak melempar', !threw && writes.length === 0);
}

// ── 4. pemasangan saat model dimuat (level sumber) ──────────────────────────
section('loadModel() memasang guard (level sumber)');
{
  ok('installOverrideGuard dipanggil dengan internal model saat load',
    /installOverrideGuard\s*\(\s*state\.model\.internalModel\s*\)/.test(appSrc));
}

// ── 5. urutan penulis di tick() tetap dipertahankan ─────────────────────────
section('tick(): applyOverrides lalu applyRawDrive (urutan tak boleh dibalik)');
{
  // tick adalah arrow fn di dalam startIdle() — ekstrak pembungkusnya.
  const startIdleSrc = extractFn(appSrc, 'startIdle') || '';
  const iAo = startIdleSrc.indexOf('applyOverrides()');
  const iAr = startIdleSrc.indexOf('applyRawDrive()');
  ok('startIdle/tick memanggil applyOverrides()', iAo >= 0);
  ok('tick memanggil applyRawDrive() setelahnya', iAo >= 0 && iAr > iAo,
    iAo >= 0 && iAr > iAo ? `offset ${iAr - iAo}` : '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
