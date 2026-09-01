#!/usr/bin/env node
/* test-emotion-overlay.js — efek emosi app-level harus cocok & menyala.
 *
 * WHY THIS EXISTS
 * Sebagian efek rig hanya hidup di proyek Cubism Editor — di moc3 hasil
 * ekspor binding-nya tidak ada (lumine: 'heart eye','blush','tear',
 * 'Sparkling eye','sweat','dizzy'; kalibrasi mengukurnya 0 piksel, dan
 * identik di rig v4.2/hasil import/rig sumber v5.0, core 4.2 maupun 5.1).
 * emotion-overlay.js menggambar efeknya sendiri (sprite di atas stage)
 * saat ekspresi yang cocok dipasang — jadi ekspresi tetap TERLIHAT.
 *
 * KONTRAK yang di-guard:
 *   1. resolveEmotionFx(): pemetaan nama → efek — kanonik (.exp3 rigger:
 *      exp_heart/exp_blush/…), alias Indonesia (malu/senang/sedih/kaget/
 *      pusing/…), prefix preset 'user:', dan JANGAN memicu untuk nama
 *      netral/properti ('normal','collar_blue','exp_zitome' — zitome adalah
 *      ganti bentuk mata yang rig-nya justru hidup).
 *   2. Wiring level sumber: modul dimuat index.html, app.js menyalakan
 *      overlay di TIGA jalur pemasangan ekspresi (native universal, .exp3,
 *      synthetic) dan memadamkan di resetEmotion, config 'overlay' dibaca.
 *   3. Tanpa PIXI/model, modul tetap aman dimuat & onExpression tak melempar.
 *
 * Run: node test/legacy/test-emotion-overlay.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const modSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'emotion-overlay.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'index.ts'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// Jalankan modul utuh dalam sandbox: tanpa PIXI & tanpa model — modul harus
// tetap aman dimuat dan API-nya tetap tersedia.
const sandbox = {
  window: {}, console,
  performance: { now: () => 0 },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  // PIXI Container/Text/Graphics tidak dipakai selama belum ada model
  document: { createElement: () => ({ getContext: () => null }) },
};
sandbox.window = sandbox;             // modul menulis window.__emotionOverlay
vm.createContext(sandbox);
let modOk = true;
try { vm.runInContext(modSrc, sandbox); } catch (e) { modOk = false; console.error(e.message); }

section('modul aman dimuat tanpa PIXI/model');
ok('modul dieksekusi tanpa throw', modOk);
ok('window.__emotionOverlay terpasang', !!sandbox.__emotionOverlay);
ok('onExpression tanpa model tidak melempar', (() => {
  try { sandbox.__emotionOverlay.onExpression('malu'); sandbox.__emotionOverlay.clear(); return true; }
  catch (e) { return false; }
})());

const resolve = (n) => sandbox.__emotionOverlay._resolve(n);

section('pemetaan nama → efek (kanonik .exp3 rigger)');
ok('exp_heart → heart', resolve('exp_heart') && resolve('exp_heart').key === 'heart');
ok('exp_blush → blush', resolve('exp_blush') && resolve('exp_blush').key === 'blush');
ok('exp_sparkling → sparkle', resolve('exp_sparkling') && resolve('exp_sparkling').key === 'sparkle');
ok('exp_tear → tear', resolve('exp_tear') && resolve('exp_tear').key === 'tear');
ok('exp_sweat → sweat', resolve('exp_sweat') && resolve('exp_sweat').key === 'sweat');
ok('exp_dizzy → dizzy', resolve('exp_dizzy') && resolve('exp_dizzy').key === 'dizzy');
ok('exp_angry → anger', resolve('exp_angry') && resolve('exp_angry').key === 'anger');
ok('exp_sad → tear', resolve('exp_sad') && resolve('exp_sad').key === 'tear');

section('pemetaan alias Indonesia + prefix preset');
ok('user:malu → blush (prefix preset ditangani)', resolve('user:malu') && resolve('user:malu').key === 'blush');
ok('malu → blush', resolve('malu') && resolve('malu').key === 'blush');
ok('senang → sparkle', resolve('senang') && resolve('senang').key === 'sparkle');
ok('sedih → tear', resolve('sedih') && resolve('sedih').key === 'tear');
ok('kaget → shock', resolve('kaget') && resolve('kaget').key === 'shock');
ok('marah → anger', resolve('marah') && resolve('marah').key === 'anger');
ok('bingung → dizzy', resolve('bingung') && resolve('bingung').key === 'dizzy');
ok('bersih-case: "User:Malu " (kapital+spasi) tetap cocok',
  resolve('User:Malu ') && resolve('User:Malu ').key === 'blush');

section('nama yang TIDAK boleh memicu overlay');
ok('normal → null', resolve('normal') === null);
ok('default → null', resolve('default') === null);
ok('collar_blue → null (properti warna, bukan efek wajah)', resolve('collar_blue') === null);
ok('exp_zitome → null (ganti bentuk mata — rig-nya hidup, jangan dobel)', resolve('exp_zitome') === null);
ok('string kosong/null/number → null',
  resolve('') === null && resolve(null) === null && resolve(42) === null);

section('wiring di app.js / index.html / server');
ok('modul dimuat di index.html setelah voice-input',
  htmlSrc.indexOf('voice-input.js') < htmlSrc.indexOf('emotion-overlay.js'));
ok('app.js menyalakan overlay di jalur native universal',
  /playEmotionClip\(name\);\s*\n\s*fireOverlay\(name\);/.test(appSrc));
ok('app.js menyalakan overlay di jalur .exp3 native — SEBELUM try, karena justru ekspresi tak terdaftar di model3.json yang membuat expression() melempar',
  /fireOverlay\(name\);\s*try \{\s*await state\.model\.expression\(name\);/.test(appSrc));
ok('app.js menyalakan overlay di jalur synthetic',
  /playEmotionClip\(name\);   \/\/ body follows the face \(see native branch\)\s*\n\s*fireOverlay\(name\);/.test(appSrc));
ok('resetEmotion memadamkan overlay',
  /function resetEmotion\(\)[\s\S]{0,800}__emotionOverlay && window\.__emotionOverlay\.clear\(\)/.test(appSrc));
ok('mode synthetic: nama tak dikenal (mis. exp_heart) tetap memicu overlay',
  /\[Live2D\] Synthetic emotion ->[\s\S]{0,400}?\} else \{[\s\S]{0,400}?fireOverlay\(name\);/.test(appSrc));
ok('config.json "overlay" diteruskan server ke client',
  serverSrc.includes('overlay:cfg.overlay||{}'));
ok('app.js membaca config overlay',
  appSrc.includes('if (d.overlay) window.__overlayCfg'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
