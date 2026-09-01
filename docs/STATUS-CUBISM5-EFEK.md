# STATUS SESI — Dukungan Cubism 5 & Efek Model (Handoff)

> Dokumen handoff sesi kerja. Tulis ulang/tambah sesuai perkembangan; jangan
> hapus keputusan yang masih berlaku. Kode yang dirujuk: sudah ter-commit di
> master (lihat daftar commit di bawah).

## Ringkasan satu paragraf

Dukungan model Cubism 5.x dan efek rig dituntaskan sebagian besar: (1)
**override guard** membuat nilai slider/pose bertahan 100% frame (dulu 0%),
(2) patch **multiplyColor** membuat efek ganti warna rig 4.2+ (collar) tampil,
(3) **kalibrasi efek visual** mengukur param mana yang benar-benar mengubah
piksel, (4) **overlay efek emosi** menggambar hati/blush/kilau/air mata untuk
efek yang rig-nya tidak memuat, (5) **Auto-Rescue** merakit manifest untuk
folder model tanpa .model3.json, (6) **core resmi 5.1.0** terpasang. SATU
HAL yang belum tuntas: efek **BlendShape** rig lumine v5.0 (heart eye, blush,
tear, sparkling, sweat, dizzy — EX02-05/08-11) belum tampil karena butuh
core ≥5.2; overlay manual kini yang menutupi kebutuhan visualnya.

## Urutan perbaikan & commit

| Commit | Isi |
|---|---|
| 5292c86 | Override guard: re-assert overrides+rawDrive di event `beforeModelUpdate` (app.js `installOverrideGuard`); guard test-override-guard.js |
| 97e8ba5 | Patch multiplyColor 2 titik di lib vendored + core resmi 5.1.0 (207KB); guard test-multiply-color.js |
| 5f51c87 | Kalibrasi efek visual (🧪 tombol di popup Penjelasan Parameter) + badge "🚫 tanpa efek" + filterVisfxDead di analyze-sheet; guard test-visual-calibration.js |
| 05fab80 | Overlay efek emosi app-level (js/emotion-overlay.js, 8 efek, anchor kepala diukur dari framebuffer); guard test-emotion-overlay.js |
| 15a5298 | Auto-Rescue: src/server/rescue.ts + jalur virtual `model/<f>/__rescue__.model3.json`; guard test-auto-rescue.js |

Suite: **212 unit + 498 guard, 0 gagal** (10 suite). Working tree bersih
(`data/` dan log server tetap untracked sesuai desain).

## Akar masalah teknis (penting untuk sesi berikutnya)

### A. Urutan update pixi-live2d-display 0.4.0 (lib vendored)
```
per frame: [PIXI ticker] internalModel.update():
  motionManager.update → o.saveParameters() → expressionManager →
  eyeBlink → updateFocus (ADD ke EyeBall/Angle) → breath →
  physics.evaluate → pose → emit("beforeModelUpdate") →
  o.update()  ← DEFORMER + BLEND COLOR dievaluasi/dirender DI SINI
  o.loadParameters()  ← nilai param kembali ke snapshot
[rAF app.js] tick(): target() easing → emotion ease → applyOverrides()
  → applyRawDrive()
```
Akibat: tulisan app selalu "telat satu frame" terhadap sistem internal —
inilah akar dua bug pertama (slider kalah, warna collar tak muncul).
Titik injeksi yang benar: event **`beforeModelUpdate`** (dipancarkan tepat
sebelum `o.update()`).

### B. Efek BlendShape lumine (BELUM TUNTAS di web runtime)
- `ParamEX01–EX11` bertipe **`ParameterType_BlendShape = 1`** (171 dari 223
  param rig v5.0 bertipe ini). Rig diekspor dari Cubism 5.3.
- Bukti binding ADA: kombinasi EX04+EX08+EX11 (= exp_heart) menyalakan flag
  **`BLEND_COLOR_DID_CHANGE` (bit6, 0x40)** di 32 artmesh pada
  `drawableDynamicFlags` — arti bit terkonfirmasi dari class constants
  Cubism 5.3 resmi (`CubismDrawableFlag$DynamicFlag` di
  `app/lib/Live2DCubismCore.jar` milik Editor 5.3 yang terinstal).
- TAPI nilai akhirnya tidak berubah (opacity/blend color/vertex tetap) —
  **core Web 5.1.0** (yang tersedia di CDN publik
  `cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`,
  terverifikasi unduh fresh = 5.1.0) menandai perubahan tapi tidak
  mengevaluasi keyform blendshape sampai selesai. Viewer resmi
  **5.3.03 (core 5.2/5.3)** menampilkan penuh (screenshot user: heart eye).
- Formula resmi screen/multiply keyform sudah diperoleh dari
  `Shaders/WebGL/fragshadersrccolorblend.frag` + `cubismshader_webgl.ts`
  (framework 5-r.5): shader premultiplied menerapkan
  `tex.rgb *= multiply.rgb; tex.rgb += screen.rgb - tex.rgb*screen.rgb;`
  lalu `tex *= baseColor`.

### C. Kesimpulan lama yang SUDAH DIKOREKSI
"Binding efek tidak ada di moc3" — SALAH untuk rig v5.0 (binding ada,
terbukti via flag). Yang benar: binding ada, evaluasinya butuh core
≥5.2. Untuk rig v4.2 lumine: efek memang tidak terikat (export lama).

## State model & data

- `data/model/lumine` — moc3 **Cubism 4.2** (hash f458de1d2a). Efek
  BlendShape memang tidak terikat di ekspor ini.
- `data/model/MyModel/lumine` — moc3 **Cubism 5.0**, hash identik dengan
  rig sumber `F:/lumine_l2d` (e07d58a858). SALINAN LANGSUNG dari sumber
  (import web ternyata sudah membawa moc3 yang benar — bukan itu masalahnya).
- 94/223 param lumine v4.2 "mati" di scan; daftar mati MyModel v5.0
  identik. 7 param yang tampak mati (AngleX/Y/Z, BodyAngleX/Y/Z,
  BodyPotisionZ) sebenarnya INPUT physics — hidup di produksi.
- `ParamAnime01/2/3` (guruguru + tetesan air mata) dianimasikan oleh
  `idle.motion3.json` (direferensikan `lumine.vtube.json`
  `IdleAnimation`); keyform-nya juga tidak dievaluasi core 5.1.
- Kalibrasi tersimpan di **localStorage** per model (`l2d_visfx_<key>`) —
  sengaja bukan sheet (skema v4 tak tersentuh); hilangnya bukan data loss.

## Yang belum tuntas + opsi

1. **Core ≥5.2 untuk web** (jalur "efek native tampil"): unduh Cubism SDK
   for Web terbaru dari live2d.com (gratis, klik lisensi — link CDN publik
   masih menyajikan 5.1.0) → ambil `live2dcubismcore.min.js` → taruh di
   proyek → swap → verifikasi EX08/EX11 menyalakan BLEND_COLOR pada
   multiply/screen arrays (probe RGBA penuh — jangan lupa channel a) →
   patch screen color (formula sudah ada di bawah) bila diperlukan.
2. **Patch screen color** (opsional, future-proof): perluas patch lib
   titik (A): stash juga `screenColors[4i..4i+4]`, dan di titik (B) banding
   `h.rgb += (1-h.rgb)*screen.rgb` bila keyform menganimasikannya. Saat ini
   hanya multiply yang diterapkan — cukup untuk collar, belum tentu untuk
   efek berbasis screen.
3. **Overlay vs native**: overlay tetap ON default (config
   `overlay.enabled`). Kalau kelak core 5.3 membuat efek native hidup,
   overlay jadi pelengkap opsional — atau digate dengan data kalibrasi.
4. Jangan migrasi pixi 8 hanya demi ini: rendering pixi 6 sudah benar;
   migrasi = menulis ulang seluruh integrasi (app.js, motion editor,
   overlay, guard semuanya terikat internal 0.4.0).

## Berkas kunci

- `static/js/app.js` — installOverrideGuard, visfx helpers
  (visfxStoreKey/visfxIsDead/visfxSummarize/filterVisfxDead),
  runVisualCalibration, fireOverlay di 3 jalur + else synthetic-unknown,
  resetEmotion memadamkan overlay, label cdi3 di popup.
- `static/js/emotion-overlay.js` — modul overlay (EFFECTS/ALIASES/
  resolveEmotionFx/_tick/_status; anchor `measureHead()` ukur framebuffer,
  cache 5 dtk, fallback bounds).
- `static/js/pixi-live2d-0.4.0.js` — 2 patch: doDrawModel stash
  `__mcDraw`, setupShaderProgram kalikan `t.__mcDraw` ke u_baseColor
  (t = renderer! `this` di sana = shader manager — jangan dibalik lagi).
- `static/js/live2dcubismcore.min.js` — core resmi 5.1.0 dari CDN
  (mampu memuat moc3 v5.0; mengevaluasi param biasa + multiply color;
  blendshape keyform v5.2+ BELUM).
- `src/server/rescue.ts` — scanRescueFolder/buildRescueBlueprint.
- `src/shared/types.ts` + `config.ts` — Config.overlay.
- Guard: test/legacy/{test-override-guard,test-multiply-color,
  test-visual-calibration,test-emotion-overlay,test-auto-rescue}.js

## Cara verifikasi cepat (kalau sesi baru ragu)

1. `bun run test` → harus 212 unit + 474+ guard, 0 gagal.
2. `bun run src/server/index.ts` → buka 127.0.0.1:8310 → Load lumine →
   geser ParamCollarChange → warna ikat pinggang berubah.
3. Popup Penjelasan Parameter → 🧪 Kalibrasi Efek → selesai ±30 dtk →
   "94/223 param tanpa efek visual" + badge muncul.
4. Load MyModel (Cubism 5.0) → termuat ±300ms.
5. `window.__live2dAgent.setExpression('exp_heart',1)` → hati melayang
   di atas kepala (overlay).
