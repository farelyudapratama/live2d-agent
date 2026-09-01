/* test-auto-rescue.js — folder tanpa .model3.json harus tetap bisa dimuat.
 *
 * KENAPA ADA
 * Banyak model fan-made dibagikan tanpa manifest: hanya .moc3, tekstur,
 * motion, dan .exp3 yatim (kadang hanya petunjuknya tersimpan di
 * lumine.vtube.json milik VTube Studio — "IdleAnimation"). Tanpa
 * .model3.json folder itu tidak pernah muncul di daftar model dan tidak
 * bisa dimuat runtime. Auto-Rescue (src/server/rescue.ts) menyapu folder
 * dan merakit blueprint manifest DI MEMORI, disajikan lewat jalur virtual
 * model/<folder>/__rescue__.model3.json — tanpa menulis ke folder model.
 *
 * KONTRAK yang di-guard:
 *   1. Rakitan: Moc/Textures (urut natural, atlas-like dipilih, icon
 *      dikeluarkan), Physics/DisplayInfo, Expressions (nama unik),
 *      Motions grup "Idle" dari petunjuk vtube.json ATAU /idle/i, sisanya
 *      "Motion". Penanda AutoRescued ada.
 *   2. Idempoten: folder dengan manifest → null (manifest user tak disentuh).
 *   3. Tanpa .moc3 → null.
 *   4. Wiring level sumber: route virtual, handleModelPath fallback,
 *      discoverExpressions fallback, handleListModels memakai rakitan.
 *
 * Run: node test/legacy/test-auto-rescue.js  (bun)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

(async () => {
  // bun menjalankan TS ini langsung
  const rescue = await import('../../src/server/rescue.ts');
  const { buildRescueBlueprint, scanRescueFolder, RESCUE_FILENAME } = rescue;

  // ── fixture ─────────────────────────────────────────────────────
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-rescue-'));
  const dir = path.join(root, 'lumine');
  fs.mkdirSync(path.join(dir, 'lumine.8192'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'mothion'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lumine.moc3'), 'MOC3-fake');
  fs.writeFileSync(path.join(dir, 'lumine.8192', 'texture_01.png'), 'png1');
  fs.writeFileSync(path.join(dir, 'lumine.8192', 'texture_00.png'), 'png0');
  fs.writeFileSync(path.join(dir, 'lumine_icon.png'), 'icon');           // harus dikecualikan
  fs.writeFileSync(path.join(dir, 'lumine.physics3.json'), '{}');
  fs.writeFileSync(path.join(dir, 'lumine.cdi3.json'), '{}');
  fs.writeFileSync(path.join(dir, 'mothion', 'idle.motion3.json'), '{"Meta":{}}');
  fs.writeFileSync(path.join(dir, 'mothion', 'wave.motion3.json'), '{"Meta":{}}');
  fs.writeFileSync(path.join(dir, 'mothion', 'exp_heart.exp3.json'), '{"Parameters":[]}');
  fs.writeFileSync(path.join(dir, 'lumine.vtube.json'), JSON.stringify({
    FileReferences: { IdleAnimation: 'idle.motion3.json' },
  }));

  section('rakitan blueprint dari folder tanpa manifest');
  const bp = buildRescueBlueprint(dir);
  ok('blueprint dirakit', !!bp);
  if (bp) {
    const F = bp.manifest.FileReferences;
    ok('Moc menunjuk .moc3', F.Moc === 'lumine.moc3', F.Moc);
    ok('Textures urut natural (00 sebelum 01)',
      JSON.stringify(F.Textures) === JSON.stringify(['lumine.8192/texture_00.png', 'lumine.8192/texture_01.png']),
      JSON.stringify(F.Textures));
    ok('ikon dikecualikan dari Textures', !F.Textures.some(t => /icon/i.test(t)));
    ok('Physics terisi', F.Physics === 'lumine.physics3.json');
    ok('DisplayInfo (cdi3) terisi', F.DisplayInfo === 'lumine.cdi3.json');
    ok('Motion idle masuk grup "Idle" (petunjuk vtube.json)',
      JSON.stringify(F.Motions.Idle) === JSON.stringify([{ File: 'mothion/idle.motion3.json' }]),
      JSON.stringify(F.Motions.Idle));
    ok('motion lain masuk grup "Motion"',
      JSON.stringify(F.Motions.Motion) === JSON.stringify([{ File: 'mothion/wave.motion3.json' }]),
      JSON.stringify(F.Motions.Motion));
    ok('Ekspresi yatim diadopsi', F.Expressions.length === 1 && F.Expressions[0].Name === 'exp_heart');
    ok('penanda AutoRescued ada', !!(bp.manifest.AutoRescued && bp.manifest.AutoRescued.by));
    ok('summary konsisten', bp.summary.textures === 2 && bp.summary.motions === 2 && bp.summary.expressions === 1 && bp.summary.idleMotion === 'mothion/idle.motion3.json');
  }

  section('idempoten & penolakan');
  fs.writeFileSync(path.join(dir, 'dummy.model3.json'), '{}');   // manifest user muncul
  ok('folder dengan manifest → null (manifest user tidak disentuh)', buildRescueBlueprint(dir) === null);
  const noMoc = path.join(root, 'kosong');
  fs.mkdirSync(noMoc, { recursive: true });
  ok('folder tanpa .moc3 → null', buildRescueBlueprint(noMoc) === null);
  ok('folder tidak ada → null', buildRescueBlueprint(path.join(root, 'tidak-ada')) === null);

  // motion tanpa petunjuk vtube: nama /idle/i juga masuk grup Idle
  section('deteksi idle via pola nama (tanpa vtube.json)');
  {
    const dir2 = path.join(root, 'tanpa-vtube');
    fs.mkdirSync(path.join(dir2, 'm'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'a.moc3'), 'x');
    fs.writeFileSync(path.join(dir2, 'm', 'my_idle.motion3.json'), '{}');
    fs.writeFileSync(path.join(dir2, 'm', 'jump.motion3.json'), '{}');
    const bp2 = buildRescueBlueprint(dir2);
    ok('my_idle → grup Idle', !!(bp2 && bp2.manifest.FileReferences.Motions.Idle));
    ok('jump → grup Motion', !!(bp2 && bp2.manifest.FileReferences.Motions.Motion));
  }

  // ── wiring level sumber ─────────────────────────────────────────
  section('wiring di server (level sumber)');
  const serverSrc = fs.readFileSync(path.join(ROOTsrc(), 'index.ts'), 'utf8');
  function ROOTsrc() { return path.join(__dirname, '..', '..', 'src', 'server'); }
  ok('route virtual __rescue__ terpasang di fetch',
    serverSrc.includes('__rescue__') && serverSrc.includes('buildRescueBlueprint(dir)'));
  ok('handleModelPath fallback ke blueprint',
    /if\(!abs\)\{ const bp=buildRescueBlueprint\(dir\)/.test(serverSrc));
  ok('discoverExpressions fallback ke blueprint',
    /if\(!model3\)\{ const bp=buildRescueBlueprint\(dir\)/.test(serverSrc));
  ok('handleListModels memakai rakitan (folder tanpa manifest ikut terdaftar)',
    /if\(findModel3\(dir\)\|\|buildRescueBlueprint\(dir\)\) usable\.push\(name\)/.test(serverSrc));

  // cleanup
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
