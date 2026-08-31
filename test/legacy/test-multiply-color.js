#!/usr/bin/env node
/* test-multiply-color.js — warna moc3 v4.2 (multiplyColor) HARUS sampai ke layar.
 *
 * WHY THIS EXISTS
 * Model Cubism 4.2+ bisa mengunci perubahan warna artmesh lewat parameter
 * (contoh lumine: ParamCollarChange 0..7 ganti warna ikat pinggang/pergelangan
 * via drawable multiplyColor — terukur: core mengubah 7 artmesh dari putih
 * (1,1,1) ke (0.64,0.46,1)). Framework yang dibundel di pixi-live2d-display
 * 0.4.0 berasal dari SDK 4.0 — SEBELUM fitur multiplyColor ada — sehingga
 * renderer menggambar setiap artmesh dengan warna dasar putih: nilai param
 * berubah di core tapi layar diam (user melihat "slider geser, warna tetap
 * putih"). Ini kegagalan senyap kelas MODEL-AGNOSTIC-RULES #7: memercayai
 * bahwa fitur runtime = fitur yang didukung.
 *
 * FIX (surgical patch pada lib vendored static/js/pixi-live2d-0.4.0.js):
 *   1. CubismRenderer_WebGL.doDrawModel(): sebelum tiap drawMesh, simpan
 *      drawables.multiplyColors[4i..4i+4] ke this.__mcDraw.
 *   2. Shader manager (CubismShader_F).setupShaderProgram(): saat upload
 *      u_baseColor, kalikan RGB+A dengan __mcDraw yang dibaca dari PARAM
 *      PERTAMA (renderer) — `this` di sana adalah shader manager, bukan
 *      renderer.
 *   3. live2dcubismcore.min.js harus memang punya API csmGetDrawableMultiplyColors.
 * Efek samping: nol untuk model tanpa fitur ini (multiplyColor default putih
 * (1,1,1) → perkalian identitas), jadi aman untuk model APA PUN.
 * Guard ini mencegah re-vendoring lib menghapus patch secara senyap.
 *
 * Run: node test/legacy/test-multiply-color.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const libSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'pixi-live2d-0.4.0.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'live2dcubismcore.min.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

section('patch #1: doDrawModel menyimpan multiplyColors per-drawable');
ok('doDrawModel men-stash __mcDraw dari drawables.multiplyColors',
  libSrc.includes('this.__mcDraw=this.getModel()._model&&this.getModel()._model.drawables&&this.getModel()._model.drawables.multiplyColors?this.getModel()._model.drawables.multiplyColors.subarray(4*t,4*t+4):null'));
ok('stash dilakukan SEBELUM drawMesh di loop draw utama',
  (() => {
    const i = libSrc.indexOf('this.__mcDraw=this.getModel()._model');
    if (i < 0) return false;
    return libSrc.slice(i, i + 400).includes('this.drawMesh(this.getModel().getDrawableTextureIndices(t)');
  })());

section('patch #2: setupShaderProgram mengalikan u_baseColor dengan __mcDraw');
ok('upload u_baseColor memakai __mcDraw dari PARAM RENDERER (t), bukan this',
  libSrc.includes('h.R*(t.__mcDraw?t.__mcDraw[0]:1),h.G*(t.__mcDraw?t.__mcDraw[1]:1),h.B*(t.__mcDraw?t.__mcDraw[2]:1),h.A*(t.__mcDraw?t.__mcDraw[3]:1)'));
ok('tidak ada varian lama this.__mcDraw tersisa di shader manager (sumber bug pertama)',
  !libSrc.includes('h.R*(this.__mcDraw'));
ok('patch hanya ada di jalur draw normal — path mask (layout bounds) tak tersentuh',
  libSrc.includes('uniform4f(t.uniformBaseColorLocation,2*n.x-1,2*n.y-1,2*n.getRight()-1,2*n.getBottom()-1)'));

section('prasyarat runtime');
ok('live2dcubismcore punya API multiply color 4.2',
  coreSrc.includes('getDrawableMultiplyColors'));
ok('core membungkus drawables.multiplyColors sebagai Float32Array view',
  coreSrc.includes('this.multiplyColors=new Float32Array'));

section('dokumentasi patch tertanam di lib');
ok('komentar patch ada di lib (penanda re-vendoring)',
  libSrc.includes('PATCH: Cubism 4.2 multiplyColor'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
