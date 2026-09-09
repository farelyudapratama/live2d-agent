#!/usr/bin/env node
/* test-core6-compat.js — kompatibilitas Core 6.0.1 (SDK Web 5-r.5) dengan
 * framework vendored era core 4 (pixi-live2d-0.4.0.js).
 *
 * WHY THIS EXISTS
 * moc3 dari Cubism 5.1 export = versi 6 (byte ke-4). Core 5.1.0 lama hanya
 * mengenal MocVersion_50=5 → fromArrayBuffer NULL → shim app.js men-stamp
 * 6→4 buta → mask/clip/physics berantakan senyap (lihat STATUS entri 19).
 * Solusi: swap core ke 6.0.1. TAPI core 6.0.1 memindahkan
 * Drawables.renderOrders ke Model.getRenderOrders() — framework vendored
 * membaca drawables.renderOrders (getDrawableRenderOrders) → undefined →
 * _sortedDrawableIndexList kosong → TIDAK ADA drawable tergambar (karakter
 * blank TANPA satu pun error console). PATCH 3 di lib vendored menempelkan
 * kembali renderOrders sebagai getter delegasi di Model.fromMoc.
 *
 * Guard ini mencegah dua kegagalan senyap sekaligus:
 *   1. re-vendoring lib menghapus PATCH 3 (string-match level sumber);
 *   2. core di-swap balik ke lama TANPA patch, atau core baru berubah lagi
 *      (eksekusi nyata via Bun: muat moc v5 & v6, cek permukaan API).
 *
 * Run: node test/legacy/test-core6-compat.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const libSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'pixi-live2d-0.4.0.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'live2dcubismcore.min.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

section('A. PATCH 3 hidup di lib vendored (string-match level sumber)');
ok('lib membungkus Model.fromMoc (patchCore6Compat)',
  libSrc.includes('(function patchCore6Compat()'));
ok('getter renderOrders: kompresi peringat orders drawable (permutasi padat 0..n-1)',
  libSrc.includes('idx.sort(function (a, b) { return orders[a] - orders[b] || a - b; })'));
ok('syarat kompat: hanya menempel saat drawables.renderOrders TIDAK ADA (core lama tak tersentuh)',
  libSrc.includes('d.renderOrders === undefined && typeof model.getRenderOrders === "function"'));
ok('framework masih membaca drawables.renderOrders (titik buta yang diperbaiki patch)',
  libSrc.includes('getDrawableRenderOrders(){return this._model.drawables.renderOrders}'));

section('A2. PATCH 4: blendModes moc3 v6 dipetakan (warna -> 3 mode lama; alpha bersyarat)');
ok('getDrawableBlendMode membaca drawables.blendModes lebih dulu (core 6)',
  libSrc.includes('if(_b.blendModes){const _v=_b.blendModes[t],_c=255&_v,_a=_v>>>8&255;'));
ok('keluarga glow (Add/AddGlow/Screen/Lighten/ColorDodge/AddCompatible) -> Additive',
  libSrc.includes('_c===1||_c===3||_c===4||_c===9||_c===10||_c===11?1:'));
ok('keluarga darken (MultiplyCompatible/Darken/Multiply/ColorBurn/LinearBurn) -> Multiplicative',
  libSrc.includes('_c===2||_c===5||_c===6||_c===7||_c===8?2:0'));
ok('Atop/Out HANYA saat canvas alpha — deteksi LAZY __l2dCanvasAlpha() (PELAJARAN: canvas opaque'
  + ' membuat Out jadi quad hitam; getContext di load-time menciptakan context & bisa merusak pixi)',
  libSrc.includes('if(!window.__l2dCanvasAlpha())')
  && libSrc.includes('if(_a===2)return 4;return _mult?2:_c===1||_c===3||_c===4||_c===9||_c===10||_c===11?1:3}')
  && libSrc.includes('window.__l2dCanvasAlpha = function () {'));
ok('peta Atop per keluarga: Multiply+Atop -> Multiplicative (rahang), glow+Atop -> Additive, Normal+Atop -> case 3',
  libSrc.includes('return _mult?2:_c===1||_c===3||_c===4||_c===9||_c===10||_c===11?1:3}'));
ok('blendFunc Out aman di canvas utama: (ONE_MINUS_DST_ALPHA, ONE, ONE_MINUS_DST_ALPHA, ONE)'
  + ' — gambar hanya di area kosong sambil MEMPERTAHANKAN dst; varian lama (faktor dst ZERO)'
  + ' MENGHAPUS pixel wajah jadi transparan (terbukti readPixels alpha=0)',
  libSrc.includes('m=this.gl.ONE_MINUS_DST_ALPHA,g=this.gl.ONE,p=this.gl.ONE_MINUS_DST_ALPHA,_=this.gl.ONE;break;'));

section('A4. PATCH 6: tekstur model di-premultiply saat upload (garis merah kelopak moc v6)');
ok('opsi muat tekstur menyertakan alphaMode:1 (PREMULTIPLY_ON_UPLOAD pixi 6)',
  libSrc.includes('const i={alphaMode:1,resourceOptions:{crossorigin:e.crossOrigin}};'));
ok('PELAJARAN: texel shade v6 = RGB berwarna + ALPHA 0 (sample PNG (116,46,46,0)) — tanpa premultiply'
  + ' warna itu bocor jadi garis merah di kelopak; viewer resmi mem-premultiply',
  libSrc.includes('alphaMode:1,resourceOptions'));
ok('deteksi alpha canvas dari getContextAttributes',
  libSrc.includes('gl.getContextAttributes() && gl.getContextAttributes().alpha'));
ok('case blend Atop (DST_ALPHA,ONE_MINUS_SRC_ALPHA) & Out (ONE_MINUS_DST_ALPHA,ZERO) ada di switch',
  libSrc.includes('case 3:n=this._shaderSets[kt.ShaderNames_NormalPremultipliedAlpha+r],')
  && libSrc.includes('case 4:n=this._shaderSets[kt.ShaderNames_NormalPremultipliedAlpha+r],'));
ok('fallback constantFlags utk core lama tetap ada',
  libSrc.includes('Live2DCubismCore.Utils.hasBlendAdditiveBit(e[t])'));

section('A3. PATCH 5: opacity group offscreen (lengan transparan moc v6, string-match)');
ok('getDrawableOpacity mengalikan faktor group dari CORE model (bukan wrapper)',
  libSrc.includes('const _g=this._model.__offGroupFactor?this._model.__offGroupFactor(t):1;'));
ok('peta part->faktor dibangun dari offscreens.opacities < 1',
  libSrc.includes('if (owner >= 0 && o.opacities[k] < 1) factorByPart.set(owner, o.opacities[k]);'));
ok('cache faktor per drawable (Float32Array)',
  libSrc.includes('const cache = new Float32Array(d.count).fill(-1);'));
ok('PELAJARAN: faktor harus dari this._model (core) — this wrapper tak punya __offGroupFactor (bug pertama)',
  !libSrc.includes('const _g=this.__offGroupFactor'));

section('B. Core di disk adalah 6.x yang mengenal moc3 v6 (string-match)');
ok('core punya enum MocVersion_53 (=6, Cubism 5.1 export)',
  coreSrc.includes('MocVersion_53'));
ok('core masih punya API multiply color yang dipatch lib (prasyarat guard multiply-color)',
  coreSrc.includes('csmGetDrawableMultiplyColors') || coreSrc.includes('GetDrawableMultiplyColors'));

section('C. Eksekusi nyata (Bun child process): muat core+patch, moc v5 & v6');
function bunEval(code) {
  const r = spawnSync('bun', ['-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const probe = `
const fs=require('fs');
// core pilih env node bila window tak ada — eval core DULU tanpa window,
// lalu pasang window sebelum patch (patch membaca window.Live2DCubismCore).
eval(fs.readFileSync('static/js/live2dcubismcore.min.js','utf8'));
globalThis.window=globalThis;
eval(fs.readFileSync('static/js/pixi-live2d-0.4.0.js','utf8').match(/;\\(function patchCore6Compat\\(\\)[\\s\\S]*?\\}\\)\\(\\);/)[0]);
const C=globalThis.Live2DCubismCore;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  for(let i=0;i<200;i++){ try{ if(C.Version.csmGetVersion()) break; }catch(e){} await sleep(50); }
  const results={};
  for(const [name,p] of [['v5','data/model/lumine/lumine/lumine.moc3'],['v6','data/model/tesmodel/runtime/ren.moc3']]){
    const b=fs.readFileSync(p);
    const ab=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
    const moc=C.Moc.fromArrayBuffer(ab);
    if(!moc){ results[name]={moc:false}; continue; }
    const model=C.Model.fromMoc(moc);
    const d=model.drawables;
    results[name]={moc:true, count:d.count, roType: d.renderOrders && d.renderOrders.constructor.name, roLen: d.renderOrders && d.renderOrders.length,
      roStable: d.renderOrders && d.renderOrders.length===d.count,
      hasFactorMap: typeof model.__offGroupFactor};
    if(model.__offGroupFactor){
      // cari satu drawable anak part ber-offscreen opacity < 1 (ren: part 17 op 0.6)
      const parts=model.parts, offs=model.offscreens;
      for(let k=0;k<offs.count;k++){
        if(offs.opacities[k]<1){
          const owner=offs.ownerIndices[k];
          for(let i=0;i<d.count;i++){
            if(d.parentPartIndices[i]===owner){ results[name].factorLow=model.__offGroupFactor(i); break; }
          }
          if(results[name].factorLow!==undefined) break;
        }
      }
    }
  }
  console.log(JSON.stringify(results));
  process.exit(0);
})();`;
const r = bunEval(probe);
let results = null;
try { results = JSON.parse(r.out.trim().split('\n').filter(l => l.startsWith('{')).pop()); } catch (e) { /* parse error ditangani di bawah */ }
ok('probe Bun sukses dieksekusi', r.code === 0 && results !== null, r.code === 0 ? 'exit 0' : r.out.slice(0, 200));
if (results) {
  ok('moc v5 (lumine): fromMoc OK + renderOrders Int32Array sepanjang drawable count',
    results.v5 && results.v5.moc && results.v5.roType === 'Int32Array' && results.v5.roStable,
    JSON.stringify(results.v5));
  ok('moc v6 (ren): fromMoc OK + renderOrders Int32Array sepanjang drawable count',
    results.v6 && results.v6.moc && results.v6.roType === 'Int32Array' && results.v6.roStable,
    JSON.stringify(results.v6));
  ok('moc v6 (ren): peta faktor opacity offscreen terpasang (PATCH 5) — anak part op<1 dapat faktor',
    results.v6 && results.v6.hasFactorMap === 'function' && typeof results.v6.factorLow === 'number' && results.v6.factorLow < 1,
    JSON.stringify({hasFactorMap: results.v6 && results.v6.hasFactorMap, factorLow: results.v6 && results.v6.factorLow}));
  ok('moc v5 (lumine): tanpa offscreen -> peta tak terpasang tak apa (model tanpa group)',
    results.v5 && results.v5.moc,
    JSON.stringify({hasFactorMap: results.v5 && results.v5.hasFactorMap}));
}

section('D. Shim stamp versi app.js tidak memakan moc v6 di core baru');
ok('app.js shim try-genuine-first (stempel hanya bila core bilang NULL)',
  appSrc.includes('const direct = orig(ab);') && appSrc.includes('if (direct) return direct;'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
