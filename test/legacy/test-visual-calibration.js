#!/usr/bin/env node
/* test-visual-calibration.js — hasil kalibrasi efek visual HARUS dipakai, bukan diabaikan.
 *
 * WHY THIS EXISTS
 * Model Cubism 4.2+ bisa punya parameter yang tidak terikat art sama sekali:
 * param kontrol event (Anime01/guruguru), rantai physics yang output-nya tidak
 * dikonsumsi (segmen _1/_4 VBridger), dan art efek yang tidak ikut diekspor
 * (lumine: EX02-05/08-11 "heart eye"/"blush"/"tear" — label cdi3 rigger
 * mengonfirmasi semuanya efek overlay yang hilang dari rig distribusi;
 * terukur 0 piksel bahkan ketika SEMUA param mati digeser serentak).
 * Tanpa data ini, user menggeser slider dan bertanya "kenapa nggak ngefek",
 * dan analyze-sheet menyuruh LLM mengusulkan preset yang pasti tampak rusak.
 *
 * Fitur: runVisualCalibration() merender tiap param di MIN vs MAX (piksel
 * framebuffer), menyimpan {changed, maxDelta, at} per id di localStorage per
 * model — SENGAJA bukan di sheet (skema v4 tak tersentuh; ini cache UI).
 * Kontrak yang di-guard di sini:
 *   1. visfxIsDead() hanya true untuk changed === 0 — efek lemah tetap "hidup".
 *   2. visfxSummarize() menghitung total/dead/alive + tanggal scan terbaru.
 *   3. filterVisfxDead() membuang param mati dari payload analyze-sheet DAN
 *      passthrough apa adanya (referensi sama) saat belum ada data kalibrasi.
 *   4. Wiring level sumber: analyzeSheetPresets memakai filter itu, tombol
 *      kalibrasi ada di popup, buildParamSliderRow menandai baris mati.
 *
 * Run: node test/legacy/test-visual-calibration.js
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

// ── extraction (kurung seimbang, string-aware — sama dengan guard lain) ──
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

const fns = ['visfxStoreKey', 'visfxIsDead', 'visfxSummarize', 'filterVisfxDead']
  .map(n => ({ n, src: extractFn(appSrc, n) }));

section('helper murni diekstrak dari app.js');
for (const { n, src } of fns) ok(`function ${n}() ada`, !!src);

const sandbox = { console, Number, Math, Object, Date };
vm.createContext(sandbox);
for (const { n, src } of fns) if (src) vm.runInContext(src, sandbox);

// ── 1. visfxStoreKey ─────────────────────────────────────────────────────────
section('visfxStoreKey: per model, aman untuk key kosong, v2 meng-invalidasi data lama');
ok('key v2 mengandung model key', vm.runInContext('visfxStoreKey("model_abc")', sandbox) === 'l2d_visfx_v2_model_abc');
ok('model key kosong → default', vm.runInContext('visfxStoreKey("")', sandbox) === 'l2d_visfx_v2_default');
ok('null → default', vm.runInContext('visfxStoreKey(null)', sandbox) === 'l2d_visfx_v2_default');
ok('prefix v2 — data scan pra-fix (ternoda override-hold/idle-restart, shim stamp v4) tak terbaca otomatis',
  vm.runInContext('visfxStoreKey("x")', sandbox).startsWith('l2d_visfx_v2_'));

// ── 2. visfxIsDead ───────────────────────────────────────────────────────────
section('visfxIsDead: hanya changed === 0 yang mati');
const isDead = (map, id) => vm.runInContext(`visfxIsDead(${JSON.stringify(map)}, ${JSON.stringify(id)})`, sandbox);
ok('map null → false (tanpa kalibrasi = tidak pernah mati)', isDead(null, 'ParamEX04') === false);
ok('changed 0 → true', isDead({ ParamEX04: { changed: 0 } }, 'ParamEX04') === true);
ok('changed 1522 → false (efek nyata)', isDead({ ParamCollarChange: { changed: 1522 } }, 'ParamCollarChange') === false);
ok('changed kecil (5 px) → false (efek lemah tetap hidup)', isDead({ ParamEX12: { changed: 5 } }, 'ParamEX12') === false);
ok('id tak ada di map → false', isDead({ ParamEX04: { changed: 0 } }, 'ParamEX09') === false);
ok('entri rusak (tanpa changed) → false, bukan throw', isDead({ X: {} }, 'X') === false);

// ── 3. visfxSummarize ────────────────────────────────────────────────────────
section('visfxSummarize: total/dead/alive + tanggal terbaru');
{
  const sum = vm.runInContext(`visfxSummarize({
    A: { changed: 0, at: '2026-09-01T01:00:00Z' },
    B: { changed: 340, at: '2026-09-01T02:00:00Z' },
    C: { changed: 0, at: '2026-08-30T00:00:00Z' },
  })`, sandbox);
  ok('total 3', sum.total === 3, String(sum.total));
  ok('dead 2', sum.dead === 2, String(sum.dead));
  ok('alive 1', sum.alive === 1, String(sum.alive));
  ok('scannedAt = entri terbaru', sum.scannedAt === '2026-09-01T02:00:00Z', String(sum.scannedAt));
  const empty = vm.runInContext('visfxSummarize(null)', sandbox);
  ok('null map → semua nol, tidak throw', empty.total === 0 && empty.dead === 0 && !empty.scannedAt);
}

// ── 4. filterVisfxDead ───────────────────────────────────────────────────────
section('filterVisfxDead: param mati keluar dari payload analyze-sheet');
{
  const params = [
    { id: 'ParamMouthForm', min: -1, max: 1, def: 0 },
    { id: 'ParamEX04', min: 0, max: 1, def: 0 },
    { id: 'ParamCollarChange', min: 0, max: 7, def: 0 },
    { id: null },
  ];
  const map = { ParamEX04: { changed: 0 } };
  const out = vm.runInContext(`filterVisfxDead(${JSON.stringify(params)}, ${JSON.stringify(map)})`, sandbox);
  ok('param mati dibuang', !out.some(p => p && p.id === 'ParamEX04'), 'sisa ' + out.length);
  ok('param hidup bertahan', out.some(p => p && p.id === 'ParamMouthForm') && out.some(p => p && p.id === 'ParamCollarChange'));
  const same = vm.runInContext(`filterVisfxDead(${JSON.stringify(params)}, null)`, sandbox);
  // params dikirim via JSON (salinan) — passthrough diverifikasi per isi, bukan identitas
  ok('tanpa kalibrasi → passthrough tanpa membuang apa pun',
    same.length === params.length && same.every((p, i) => p && p.id === params[i].id));
}

// ── 5. wiring level sumber ───────────────────────────────────────────────────
section('wiring di app.js (level sumber)');
ok('analyzeSheetPresets memfilter param mati lewat helper yang sama',
  /analyzeSheetPresets[\s\S]{0,4000}?filterVisfxDead\(\s*allParams\s*,\s*state\.visfxMap/.test(appSrc));
ok('tombol kalibrasi ter-wire di popup',
  appSrc.includes("$('#btn-visfx-calibrate')") && appSrc.includes('runVisualCalibration(visfxStatus)'));
ok('buildParamSliderRow menandai baris mati',
  /buildParamSliderRow[\s\S]{0,2500}?visfxIsDead\(state\.visfxMap/.test(appSrc));
ok('hasil disimpan via visfxSave + dimuat ulang saat model load',
  appSrc.includes('state.visfxMap = visfxLoad();'));
ok('cache localStorage — sengaja bukan sheet (skema v4 aman)',
  appSrc.includes("localStorage.setItem(visfxStoreKey(currentModelKey())"));
ok('scan tidak menyentuh nama parameter tertentu (model-agnostic)',
  !/visfx[\s\S]*"Param(Angle|EX|Skirt)/.test(appSrc.slice(appSrc.indexOf('function visfxStoreKey'), appSrc.indexOf('function visfxLoad'))));

// ── 6. isolasi scan — dua penulis parameter dibungkam selama kalibrasi ──────
// Tanpa ini param tertentu terukur "mati" palsu (0 piksel) padahal hidup:
// override guard me-re-assert sticky/slider/eye-follow + rawDrive menimpa
// tulisan MIN/MAX scan, dan auto-restart grup Idle memulai evaluasi motion
// dengan loadParameters() yang MENGHAPUS tulisan scan.
section('isolasi scan: guard minggir + grup Idle di-stash selama kalibrasi');
ok('state punya flag visfxScanning (default false)',
  appSrc.includes('visfxScanning: false'));
ok('override guard minggir saat scan (cek flag SEBELUM re-assert)',
  /function installOverrideGuard[\s\S]{0,1200}if \(state\.visfxScanning\) return;[\s\S]{0,600}applyRawDrive|function installOverrideGuard[\s\S]{0,1200}if \(state\.visfxScanning\) return;/.test(appSrc));
ok('runVisualCalibration menyalakan flag SEBELUM loop scan',
  /state\.visfxScanning = true;[\s\S]{0,600}for \(let i = 0; i < params\.length/.test(appSrc));
ok('flag dipadamkan + grup Idle dipulihkan di finally (scan gagal pun bersih)',
  /finally \{[\s\S]{0,400}state\.visfxScanning = false;[\s\S]{0,400}mm\.groups\.idle = savedIdleGroup/.test(appSrc));
ok('grup Idle di-stash selama scan (auto-restart motion tidak menghapus tulisan MIN/MAX)',
  /const savedIdleGroup = \(mm && mm\.groups\) \? mm\.groups\.idle : undefined;[\s\S]{0,200}mm\.groups\.idle = null;/.test(appSrc));
ok('flag visfxScanning hanya ditulis oleh runVisualCalibration (bukan jalur lain)',
  (appSrc.match(/state\.visfxScanning = (true|false)/g) || []).length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
