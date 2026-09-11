# STATUS SESI — Dukungan Cubism 5 & Efek Model (Handoff)

> Dokumen handoff sesi kerja. Tulis ulang/tambah sesuai perkembangan; jangan
> hapus keputusan yang masih berlaku. Kode yang dirujuk: sudah ter-commit di
> master (lihat daftar commit di bawah).

## UPDATE 2026-09-11 (26) — REFACTOR CLIENT: ROLE-SPACE, LIFECYCLE, KONTRAK BRIDGE, EKSPRESI TS (BELUM COMMIT)

Audit maintainability client dilanjutkan dengan tranche kecil, tanpa rewrite
`app.js` atau perubahan renderer/motion pipeline:
- **Inferensi emosi AgentBrain dikunci di role-space referensi**: pecahan
  semantik memakai `refHalfFor(role)` dan baru dipetakan sekali oleh render
  loop melalui `toActual`. Ini mencegah scaling ganda pada rig 0..100 atau
  asimetris; role yang tidak dimiliki model tetap menghasilkan nol.
- **Lifecycle UI eksplisit dan idempotent** (`src/client/lifecycle.ts`): timer,
  listener, dan AbortController dimiliki satu scope. Panel Assistant tidak
  dapat memasang poll setelah teardown, PanelView membersihkan timer status,
  dan rail projek melepas seluruh listener splitter serta menolak hasil draw
  async yang sudah basi. Start panel/rail kedua membongkar instance lama.
- **Boundary client lebih jelas**: API status/history/events Assistant dipisah
  ke modul typed, kontrak global `Window` dipusatkan, dan tipe wire browser
  dipindah ke `src/shared/browser-types.ts` dengan re-export kompatibilitas.
- **Kolektor ekspresi native dipindah ke TS murni**: union stabil dari
  `model.expressions`, `expressionManager.definitions`, dan
  `settings.expressions`; nama asli rigger dipertahankan dan getter rusak
  tidak menjatuhkan sumber lain. `app.js` sekarang adapter tipis dan fail-loud
  bila bundle belum dibangun, bukan diam-diam mengosongkan ekspresi.
- Guard source yang rapuh karena batas jarak karakter diperbarui agar tetap
  mengunci urutan perilaku fungsi lengkap; test baru mencakup role-space,
  lifecycle race, kolektor ekspresi, dan urutan bootstrap bridge.

Gate: **414 unit + 463 guard, 0 gagal**; build & `tsc --noEmit` bersih.

## UPDATE 2026-09-10 (25) — AUDIT KODE + PERBAIKAN: KOMIT RENDER, SHIM FAIL-LOUD, KEDIP rAF, ROLE-MAPPING TS (COMMIT)


Sesi audit implementasi Cubism dari kode (bukan dokumen). Seluruh WIP entri
(13)-(24) di-commit dalam 5 commit logis (27b95f8 render/core6, 1474b75
server TTS/bahasa/SSE, 9556c84 panel/akting, a1aa0ef app.js/UI, 80fd9a0 docs)
— tree bersih, gate penuh hijau sebelum tiap fase.

Perbaikan (semua sudah di-commit):
- **Shim core fail-loud** (app.js): moc3 v6+ TIDAK di-stamp lagi — log error
  eksplisit suruh update core; v5 masih di-stamp dengan warning. Stamp buta
  = kelas kegagalan senyap entri (19) tidak bisa terulang.
- **Kedip pindah ke tick rAF** (`tickBlink`, dt-based): setInterval 3 dtk +
  random-gate dihapus; interval natural, fase close/closed/open selalu
  dipulihkan saat freeze/model ganti, DIJEDA saat klip emosi memutar (kurva
  wink tidak ditimpa).
- **Breath sadar-motion**: `pokeRoleNorm("breath")` dilewati saat
  `motionLayersActive` — kurva motion3 yang membawa breath tidak ditimpa.
- **BUG EKSPRESI DITEMUKAN & DIPERBAIKI** (b88b825): `state.modelExpressions`
  dari `settings.expressions` DITIMPA baris berikutnya + `em.deferred` tidak
  ada di pixi-live2d 0.4.0 (yang benar `em.definitions`) → ekspresi native
  SELALU kosong untuk semua model (ren punya 5 .exp3 deklaratif, tak pernah
  muncul di vocabulary). Urutan prioritas ekspresi kini benar-benar sampai
  cabang native.
- **Diagnostik runtime**: `window.__live2dAgent.diagnostics()` — versi core
  vs moc (+peringatan core basi), status 4 patch lib, peta role + rentang
  param, probe sumber caps, flag sheet basi.
- **Stamp scannerVersion sheet** (server+client): simpan = stamp, GET =
  tandai `_stale` bila versi beda; client warning + flag `state.sheetStale`.
- **detectModelCapabilities**: warning eksplisit saat jalur resmi habis dan
  pencarian menyelam ke private field framework.
- **ROLE-MAPPING PORT KE TS** (`src/client/engine/role-mapping.ts`, sumber
  kebenaran tunggal): ROLE_KEYWORDS/GROUP_PATTERNS/mapRoles/pickFromGroup +
  role-space math (toActual/roleClampActual/normToRange/roleDefaultOf/
  writeRef/detectAccessories) — murni, diuji bun test. app.js jadi delegasi
  tipis via `window.__roleMapping` (fallback inline utk harness vm).
  Guard duplikat test-role-mapping.js & test-param-scaling.js (salinan port
  "keep in sync" manual) DIHAPUS — diganti test/role-mapping.test.ts (25
  test, termasuk rename-invariance & sheet-nyata). Guard app.js tetap:
  tabel bebas id bernomor kini menguji app.js TIDAK memuat tabel sendiri.
- **Belum dikerjakan (dicatat)**: pipeline offscreen Porter-Duff penuh
  (Atop iso-group masih aproksimasi) — tunggu bukti visual yang mengganggu;
  sheet lama perlu re-scan manual (GET kini menandai basi, belum auto).
Gate: **402 unit + 463 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-09 (24) — GURATAN MERAH KELOPAK: TEKSTUR DI-PREMULTIPLY (BELUM COMMIT)

User kirim screenshot close-up: dua guratan cokelat-merah simetris di atas
kedua mata. Diagnosis: ren punya artmesh Atop (Face/Hairline, mis. ArtMesh82/
188/189) yang teksturnya menyimpan shade sebagai **RGB berwarna dengan ALPHA
0** (sample PNG di UV-nya: (116,46,46,0), (85,28,28,0)). Pixi 6 default
alphaMode NPM=0 — texel itu masuk GPU apa adanya; kapan pun artmesh digambar
(bahkan sebagai Over di antialias edge), RGB bocor → garis merah. Viewer
resmi mem-premultiply saat upload sehingga texel itu menjadi (0,0,0,0).

**PATCH 6:** opsi muat tekstur model di vendored lib (`Texture.fromURL`)
ditambah `alphaMode: 1` (PREMULTIPLY_ON_UPLOAD) — satu properti, memperbaiki
semua artmesh sekaligus tanpa menyentuh shader. Cache-bust lib ke `?v=3` di
3 HTML (pelajaran entri 23: subresource JS bisa basi walau HTML fresh).
Verifikasi (Browser Use, tab baru — capture clip di tab lama macet berulang,
tab baru normal): guratan merah hilang di pose netral/menoleh kanan/kiri;
model lain tak berubah (lumine tanpa texel semacam ini — premultiply
identitas untuk texel opaque). Gate: **377 unit + 550 guard, 0 gagal**;
tsc bersih. PATCH 3/4/5/6 + core 6.0.1 semuanya working tree (belum commit).

## UPDATE 2026-09-09 (23) — KEPALA REN: ATOP/OUT VIA CANVAS ALPHA + BLENDFUNC BENAR (BELUM COMMIT)

User: "bagian kepalanya masih aneh" — saat kepala menoleh muncul patch putih
(di akar: artmesh alpha Atop/Out digambar Over), dan dua percobaan perbaikan
pertamaku justru **wajah hitam bolong**. Diagnosis tuntas lewat instrumen:
`preserveDrawingBuffer` sementara + `readPixels` → area "hitam" ternyata
**RGBA(0,0,0,0) = wajah DIBOLONGKAN**, bukan dilukis hitam: blendFunc Out
versi lama memakai faktor dst ZERO sehingga operator Porter-Duff Out MENGANTI
seluruh dst — artmesh "Hair Shadow Out" (ArtMesh197, menutupi mulut-dagu)
menghapus pixel wajah.

Fix final (PATCH 4 lengkap):
- **Canvas transparan**: app.js `backgroundAlpha: 0` (warna latar tetap dari
  CSS #stage) → dst-alpha canvas = cakupan artmesh, prasyarat Atop/Out.
- **PATCH 4c**: `getDrawableBlendMode` membaca `blendModes` — keluarga warna
  → 3 mode lama (seperti 4a), byte alpha: Atop → case 3
  `(DST_ALPHA, ONE_MINUS_SRC_ALPHA, ZERO, ONE)`; Out → case 4
  `(ONE_MINUS_DST_ALPHA, ONE, ONE_MINUS_DST_ALPHA, ONE)` = "gambar hanya di
  area kosong, dst DIPERTAHANKAN" — bukan mengganti dst (bolong!). Atop
  Multiply (leher) → Multiplicative (butuh dst-RGB, blendFunc tak kuat).
- Deteksi alpha canvas **LAZY** `window.__l2dCanvasAlpha()` — panggilan
  getContext saat load-time MENCIPTAKAN context dan bisa merusak init pixi.
- Cache-bust: tag script lib di 3 HTML di-bump `?v=2` (JS subresource bisa
  basi di cache walau HTML fresh — bikin dua kesimpulan bisect palsu).
PELAJARAN BISECT: matikan-part via setPartOpacity TIDAK valid utk model v6
(cache faktor PATCH 5 beku + part opacity tak mengalir) — pakai
__l2dCanvasAlphaResult=false + readPixels, bukan tebakan part.
Hasil (Browser Use): kepala bersih di pose netral/menoleh kanan-kiri, hitam
hilang, kalung terlihat, lengan tetap transparan. readPixels wajah
(58,55,50,255) opaque, latar (22,18,12,0) transparan sesuai desain.
Sisa batas: Atop iso-group belum sempurna (gloss bisa bocor ke artmesh
non-group yang tumpang tindih), multiply-atop = aproksimasi.
Gate: **377 unit + 548 guard, 0 gagal**; tsc bersih.

## UPDATE 2026-09-09 (22) — LENGAN TRANSPARAN REN: PATCH 5 OPACITY GROUP OFFSCREEN (BELUM COMMIT)

User menunjukkan referensi tampilan resmi: **lengan jaket harusnya transparan**
(bahan bening, tangan terlihat menembus). Render kita masih solid. Peta akar
dari probe + cdi3: 24 offscreen group moc3 v6 — group 9/10 = PartJacketArmL/R
**op 0.50** (lengan transparan), 17/18 = ArmL/RDrawOrder **op 0.00** (layer
tersembunyi by design), 4/5 = Display/See-through op 0.6/0.3, 13/14/19/20/21
berisi artmesh Out (tabung gloss). Core 6 TIDAK membake opacity group itu ke
drawable opacity, dan parts.opacity ↔ offscreens.opacity tidak sinkron dua
arah via update() — framework lama menggambar semua full-opacity.

**PATCH 5:** `getDrawableOpacity` di vendored lib mengalikan opacity drawable
dengan faktor opacity group offscreen part-nya; peta part→faktor dibangun
sekali di `patchCore6Compat` (`model.__offGroupFactor`, cache Float32Array
per drawable). Group op 0 otomatis tak tergambar; lengan ×0.5 → transparan.
**Jebakan yang kena (terdokumentasi guard A3):** peta dipasang di CORE model
tapi versi pertama patch membacanya lewat `this.__offGroupFactor` (`this` =
wrapper framework, SELALU undefined → faktor 1, visual tak berubah); koreksi
`this._model.__offGroupFactor`. Verifikasi: Browser Use — lengan transparan
sesuai referensi, tangan terlihat menembus kain.
**Sisa batas (belum dikerjakan):** 16 artmesh alpha Atop/Out tetap digambar
Over (tabung gloss sedikit beda dari viewer resmi); pipeline resmi
5-r.5 = copy-buffer + frag shader Porter-Duff per group offscreen — port
besar, baru layak kalau bedanya masih terasa.
Gate: **377 unit + 544 guard, 0 gagal**; tsc bersih. Core 6.0.1 + PATCH 3/4a/5
di working tree (belum commit).

## UPDATE 2026-09-09 (21) — REN v6: BLENDMODES BARU + PELAJARAN PATCH YANG GAGAL (BELUM COMMIT)

Laporan user setelah entri (20): "masih aneh" (render sudah tampil tapi ada
artefak), lalu versi patch pertamaku justru bikin **wajah & kaos dalam jadi
hitam solid** — regresi yang kupicu sendiri, kubuktikan sendiri via browser
(Browser Use), kurevert sendiri.

Fakta rig ren (moc3 v6) dari probe core:
- `drawables.blendModes` (BARU di core 6, ada juga utk moc lama): low byte =
  ColorBlendType (Normal=0, AddCompatible=1, MultiplyCompatible=2, Add=3,
  AddGlow=4, Darken=5, Multiply=6, ColorBurn=7, Lighten=9, Screen=10,
  HardLight=14, Color=17, dst.), high byte = AlphaBlendType (Over=0, Atop=1,
  Out=2). Ren: 178 Normal, 5 Multiply, 4+1+2+1 glow/light/hardlight, 9 Atop,
  7 Out. Semua constantFlags blend bits v6 = 0 → framework lama menggambar
  SEMUA sebagai Normal (multiply tidak menggelapkan, glow tidak menyala).
- 24 offscreen per-part compositing; 81/198 drawable anak part ber-offscreen;
  offscreen opacity (0.6/0.3) TIDAK dibake ke drawable opacity oleh core, dan
  parts.opacity ↔ offscreen.opacity TIDAK sinkron dua arah via update().

**PATCH 4 (berlaku):** `getDrawableBlendMode` di vendored lib membaca
`blendModes` lebih dulu dan memetakan HANYA keluarga warna → 3 mode lama
(glow: Add/AddGlow/Lighten/Screen/ColorDodge/AddCompatible → Additive;
darken: MultiplyCompatible/Darken/Multiply/ColorBurn/LinearBurn →
Multiplicative; sisanya Normal). Fallback constantFlags utk core lama tetap.
**PELAJARAN (jangan diulang):** versi pertamaku juga memetakan byte alpha
Atop/Out ke blendFunc baru langsung di framebuffer utama — HASILNYA HITAM
(wajah/kaos). Renderer resmi 5-r.5 menggambar Atop/Out di dalam offscreen
render-target per group (isBlendModeEnabled → _modelRenderTargets) — tanpa
pipeline itu, Atop/Out HARUS digambar Over biasa. Guard A2 di
test-core6-compat.js sekarang MENOLAK kehadiran string Atop/Out blendFunc.
**Batas arsitektur yang diketahui (belum dikerjakan):** (1) alpha Atop/Out 16
artmesh digambar Over — highlight/gloss moc v6 bisa tampak sedikit beda dari
viewer resmi; (2) offscreen compositing + opacity part (0.6/0.3) belum
diterapkan; (3) ekspresi model ren: getExpressibleEmotions() kosong (belum
diinvestigasi, terpisah dari render). Fidelity penuh = renderer 5-r.5.
Verifikasi visual (Browser Use, bukan laporan user): model tampil benar,
wajah normal, mask utuh saat ParamAngleX=30 + physics, console bersih.
Gate: **377 unit + 538 guard, 0 gagal**; tsc bersih. Core 6.0.1 + PATCH 3 +
PATCH 4a semuanya di working tree (belum commit).

## UPDATE 2026-09-09 (20) — REGRESI CORE 6: renderOrders OBJECTS-UNION + PATCH 3 LIB (BELUM COMMIT)

Lanjutan entri (19): setelah swap core 6.0.1, **karakter tak tergambar sama
sekali** (blank, tanpa error console). Akar: core 6.0.1 menghapus
`drawables.renderOrders` (dipindah ke `Model.getRenderOrders()`) DAN di moc v6
nilai itu adalah **objects-union** — order gabungan drawable (0..count-1) +
offscreens (count..count+offscreen-1); ren = 198 drawable + 24 offscreen =
222 entri. Framework vendored era core 4 (pixi-live2d-0.4.0.js) membaca
`drawables.renderOrders` → undefined → `_sortedDrawableIndexList` kosong →
semua drawable dianggap tak terlihat. Bahkan delegasi naif salah: framework
lama mengiterasi slot `0..count-1` pada array (bukan peta), nilai order sparse
(dibumbui offset offscreen) membuat slot kosong = drawable terlewat senyap.

Fix — **PATCH 3** di `static/js/pixi-live2d-0.4.0.js` (pola patch existing:
#1 doDrawModel/__mcDraw, #2 setupShaderProgram multiplyColor): IIFE
`patchCore6Compat` membungkus `Live2DCubismCore.Model.fromMoc`; saat
`drawables.renderOrders === undefined` (core 6+) menempel getter yang
mengembalikan **permutasi padat 0..n-1** drawable — sort drawable by order
asli, rem tie by indeks; offscreen diabaikan (framework lama tak mengenalnya).
Core lama 5.1.0 (moc v5 orders length === count) tak tersentuh — jalur
passthrough. Perubahan user-terlihat: karakter tampil kembali + model moc3 v6
(tesmodel/ren) render dengan mask/clip/physics benar.
Guard baru **test-core6-compat.js** (10 assertion; suites 11→12): string-match
level sumber PATCH 3 + **eksekusi nyata via Bun** — eval core+patch, `Model.
fromMoc` moc v5 (lumine) & v6 (ren), wajib Int32Array sepanjang drawable count
(jebakan v6: delegasi naif mengembalikan 222 entri untuk 198 drawable — guard
menangkapnya). Urutan eval penting di probe: core dulu TANPA window (emscripten
pilih env node), baru `globalThis.window=globalThis` sebelum eval patch.
Gate: **377 unit + 533 guard, 0 gagal**; tsc bersih. Verifikasi user: Ctrl+F5.

## UPDATE 2026-09-09 (19) — MODEL MOC3 v6: CORE DI-SWAP KE 6.0.1 (SDK WEB 5-r.5) (BELUM COMMIT)

Laporan user: model baru ("tesmodel"/ren) **masking texture, physics, dan
clipping berantakan**. Akar masalah TERBUKTI via probe Bun eksekusi sungguhan:
`ren.moc3` = moc3 **versi 6** (byte ke-4 = 0x06, Cubism 5.1 export), sedangkan
core terpasang **5.1.0** hanya mengenal sampai `MocVersion_50 = 5` —
`Moc.fromArrayBuffer` mengembalikan NULL → shim `patchCubismCore` (app.js)
men-stamp 6→4 buta → moc v6 dibaca dengan layout v4 → **mask/clip/texture dan
physics rusak senyap**, persis pola kegagalan entri lama (shim stamp v5→v4).
Inventaris: lumine = v5, 神宫白子 = v4, ren = v6 — hanya v6 yang korban.

Fix: `static/js/live2dcubismcore.min.js` di-swap ke **Core 6.0.1** dari zip
resmi `CubismSdkForWeb-5-r.5.zip` (cubism.live2d.com/sdk-web/bin/ — CDN core
masih menyajikan 5.1.0 identik hash `25ae938c…`, jadi ambil dari zip SDK).
Bukti: `MocVersion_53 = 6` ada di core baru; probe env node — ren v6 load **OK
non-null** (getMocVersion 6), lumine v5 OK, 神宫白子 v4 OK (backward-compat
terjaga). Changelog 5-r.5 (2026-04-02) bahkan menyebut fix "unnecessary
multiply color and screen color settings in mask drawing". Wasm ter-embed
base64 dalam satu file — tanpa fetch eksternal. Guard `test-multiply-color.js`
tetap hijau (API `csmGetDrawableMultiplyColors` masih ada). Shim stamp 6→4 di
app.js tidak diubah: moc v6 kini genuine-load jadi shim tak terpicu; kalau
kelak ada moc v8+, shim itu akan salah stamp lagi (catatan kesadaran, bukan
bengkel sekarang).
Gate: **377 unit + 523 guard, 0 gagal**; tsc bersih. Verifikasi user: hard
reload (Ctrl+F5) — core client-side, tak perlu restart server.

## UPDATE 2026-09-09 (18) — UCAPAN DETERMINISTIK: TERJEMAHAN PINDAH KE SERVER (BELUM COMMIT)

Laporan user: "kadang ngikutin teks yang ditulis user, kadang ngikutin
dropdown" — suara tidak konsisten. Akar masalah: terjemahan ucapan dulu
DILAKUKAN DI CLIENT (fetch /api/tts/translate sebelum TTS) — kalau LLM
role "chat" lambat/gagal/timeout 30 dtk, client diam-diam jatuh ke teks
asli → kadang audio bahasa user, kadang bahasa dropdown. Ditambah kebocoran
tampilan: pipeline doRemoteTTS menampilkan kalimat yang dibacakan di bubble,
jadi teks terjemahan ikut tampil berbahasa asing.

Redesain — SATU titik keputusan di server:
- **/api/tts menerima `ttsLang` opsional**: bila "Bahasa suara" tetap,
  handleTTS menerjemahkan teks DULU (translateForSpeech — LLM role chat,
  cache LRU) lalu menyintesis. Semua request TTS remote kini melalui logika
  yang sama → ucapan TIDAK bisa berganti bahasa sendiri.
- **Skip cerdas**: teks yang sudah berbahasa target TIDAK diterjemahkan
  (detectSpeechLangBase — heuristic skrip+kata layak Indonesia, cermin
  detectTextLang di app.js; dikunci test). User menulis Jepang + suara
  ja-JP = nol panggilan LLM.
- **Bubble tetap bahasa user**: client mengirim kalimat ASLI per segmen;
  terjemahan hanya di sisi audio. (Dulu bubble ikut menampilkan terjemahan.)
- speak() app.js: jalur remote TANPA pre-translate (cukup meneruskan
  ttsLang); jalur suara browser tetap pre-translate via /api/tts/translate
  (Web Speech butuh teks lokal). fetchTTSAudio: timeout 45 dtk saat
  ttsLang aktif (menampung latensi LLM terjemahan). window.__debugSpeak
  kini terpasang apa pun provider — jalur VTuber/mode-runtime selalu masuk
  pipeline ini.
Gate: **377 unit + 523 guard, 0 gagal**; build & tsc bersih. Entri (13)-(18)
masih di working tree; perlu restart server + reload halaman.

## UPDATE 2026-09-09 (17) — "BAHASA SUARA" TETAP = UCAPAN DITERJEMAHKAN, TEKS TETAP BAHASA USER (BELUM COMMIT)

Pertanyaan user: dari dua setelan bahasa, mana yang mengurus ucapan narator?
Dan bisa nggak: user menulis Indonesia → teks balasan tetap Indonesia tapi
suara berbahasa lain (mis. Jepang)? Jawaban lama: "Bahasa" (UI) = UI +
baseline balasan; "Bahasa suara" (ttsLang) HANYA pemilih voice TTS — teks
tidak pernah diterjemahkan, voice ja-JP membaca teks Indonesia mentah-mentah
(hasil aneh).

Sekarang "Bahasa suara" punya makna penuh, dua mode:
- **"Ikuti bahasa teks" (nilai `auto`, DEFAULT baru)** — suara mengikuti
  bahasa balasan. Deteksi bahasa teks heuristic script tanpa jaringan
  (`detectTextLang`: kana→ja, hanzi→zh, hangul→ko, kata layak Indonesia≥20%
  →id, selainnya→en). browserTTS memakai `ttsLangForText()` untuk u.lang +
  pemilihan voice; voice "Suara Sistem" yang dipin user tetap menang (itu
  fungsinya — pilih "(otomatis)" bila mau suara mengikuti bahasa).
- **Bahasa tetap (id-ID/ja-JP/en-US/zh-CN)** — teks yang DIBACAKAN adalah
  TERJEMAHANNYA ke bahasa itu; teks di bubble & chat log tetap bahasa
  balasan (cermin user). Terjemahan via route baru **POST /api/tts/translate**
  (LLM role "chat", prompt bahasa target dari map locale, cache LRU 200 di
  `src/server/persona/speech-lang.ts`, gagal = teks asli — TTS tetap jalan).
  speak() app.js memanggilnya sebelum splitSpeechSegments; fallbackTimer
  di-re-arm setelah terjemahan agar audio tidak terpotong.

Perubahan file: speech-lang.ts (baru, murni + injectable LLM call),
index.ts (route+handler), app.js (speak(), browserTTS, detectTextLang,
ttsLangForText, MODEL_CONFIG_DEFAULTS ttsLang:"auto", normalisasi menerima
"auto"), index.html (option auto + hint), dict-id/en (+2 kunci).
Guard: config lama bersave id-ID/ja-JP tetap berlaku (mode tetap); yang
belum pernah di-set dapat auto. Gate: **375 unit + 515 guard, 0 gagal**;
build & tsc bersih. Entri (13)-(17) masih di working tree.

## UPDATE 2026-09-09 (16) — KARAKTER CERMINKAN BAHASA USER (BELUM COMMIT)

Laporan user: karakter selalu membalas bahasa Indonesia meski user menulis
bahasa lain. Penyebab: (a) buildSystem di agent loop menulis literal
"Jawab user dalam bahasa Indonesia." di kedua varian prompt; (b) prompt
brain (mode chat) sepenuhnya Indonesia tanpa aturan bahasa sama sekali;
(c) narrator memaksa bahasa config.i18n.

Perubahan (aturan cermin, konsisten di 4 titik):
- loop.ts `buildSystem` — rule final id: "Balas dalam bahasa yang SAMA
  dengan bahasa yang dipakai user… (campuran → dominan; istilah teknis
  tetap apa adanya)"; varian en dibuat mirror juga (bukan "Reply in
  English"). Varian prompt id/en tetap ada — yang berubah hanya aturan
  bahasa jawabannya.
- brain.ts `buildSystemPrompt` — block "=== BAHASA ===" mirror-bahasa
  ditambahkan untuk SEMUA lang, dengan penegasan kata kunci directive
  tetap kosakata Indonesia (protokol). Block "=== LANGUAGE ===" (UI
  pilihan en) ditambahkan SESUDAHNYA sehingga tetap menang bila user
  eksplisit pilih English di UI.
- narrator.ts — simpulan akhir meniru bahasa teks hasil kerja agent.
- quip (/api/assistant/quip) SENGAJA TIDAK diubah: label event itu
  teknis (nama tool Inggris) — mencerminkan label membuat komentar
  sampingan berubah bahasa sendiri di UI Indonesia; quip tetap mengikuti
  bahasa UI (config.i18n).
Gate: **369 unit + 515 guard, 0 gagal**; build & tsc bersih. Entri (13)-
(16) semua masih di working tree belum commit.

## UPDATE 2026-09-09 (15) — EKSPRESI MODEL ASLI MENANG ATAS HARDCODE (BELUM COMMIT)

Laporan user: ekspresi karakter ketimpa emosi hardcode engine padahal model
punya .exp3/emote sendiri. Akar masalahnya TIGA lapis: (a)
`refreshRoleEmotions()` mengisi `supportedEmotions` dari
`EMOTION_ROLE_TEMPLATES` (hardcode senang/sedih/... di app.js); (b)
`applyExpression()` memeriksa vocab itu SEBELUM mencoba `.exp3` bawaan model
(cabang native hanya untuk nama yang TIDAK ada di vocab); (c)
`getCapabilityProfile().emotions` mengiklankan emosi hardcode sebagai
kemampuan model ke prompt LLM.

Urutan prioritas BARU (app.js + brain.ts applyActions):
1. **Preset emosi USER** (sheet.presets.user kategori emosi — aturan sheet
   user > segalanya).
2. **Ekspresi bawaan model (.exp3)** — pencocokan case-insensitive ke
   `state.modelExpressions`.
3. **Klip emosi terukur** dari disk (MotionTaxonomy EMOTION_VERBS →
   playEmotionClip).
4. **Template sintetis role-space** (state.roleEmotions dari
   EMOTION_ROLE_TEMPLATES) — HANYA untuk model yang tidak punya apa-apa
   sendiri; nama template tidak lagi masuk supportedEmotions sheet/state.

Perubahan detail:
- `refreshRoleEmotions()` — supportedEmotions = {} + klip emosi (nilai null
  = "mainkan klip"); roleEmotions tetap dibangun sebagai fallback runtime.
  Dipanggil ulang setelah loadMotionTaxonomy (dulu klip kosong karena
  taxonomy async datang setelah detectModelCapabilities).
- `projectEmotionPresets(sheet)` — sheet.supportedEmotions hanya berisi
  preset user; emosi sintetis builtin TIDAK lagi diproyeksikan ke sheet.
- `inspectModel()` — sheet baru dibuat dengan supportedEmotions = {} (dulu
  menanam hasil buildRoleEmotions()).
- `applyExpression()` ditulis ulang: user-preset → .exp3 (nativeName) →
  klip (userEntry===null) → sintetis (state.roleEmotions) → fireOverlay
  untuk nama asing. Log label baru (User emotion preset / Native
  expression / Emotion clip / Synthetic emotion (fallback)).
- `getExpressibleEmotions()` — via jujur: param(preset user) → native(.exp3)
  → clip; emosi sintetis tidak diiklankan.
- `getCapabilityProfile().emotions` — vocab model dulu, nama template
  sintetis dicantumkan hanya sebagai cadangan kosakata prompt (runtime tetap
  prioritaskan yang asli).
- brain.ts `applyActions`: `emotionVia` dari getExpressibleEmotions — pose
  inferensi & gesture fallback (EMOTION_GESTURE_FALLBACK) DILEWATI bila
  emosi dimainkan dari native/clip (aset model membawa face+body sendiri;
  menumpuk pose tebakan merusak ekspresi asli). [GESTURE:] eksplisit LLM
  tetap selalu dipakai.
Guard: test-emotion-overlay.js diperbarui (3 assertion baru: nativeName
case-insensitive, Object.assign roleEmotions dihapus, inspectModel tak
menanam sintetis) — 515 guard. Gate: **369 unit + 515 guard, 0 gagal**;
build & tsc bersih. Sesi (13)(14)(15) semua masih di working tree.

## UPDATE 2026-09-09 (14) — SSE AGENT TERPOTONG 10 DTK OLEH BUN idleTimeout (BELUM COMMIT)

Laporan user: stream agent "kadang berhenti, nggak streaming terus, atau
reconnect ulang". Diagnosis terukur: **Bun 1.4.0 memutus koneksi yang senyap
>10 detik** (default `idleTimeout: 10`) — direproduksi dengan server uji:
stream SSE yang tidak mengirim apa pun terpotong ECONNRESET tepat 10 dtk,
Bun mencetak "timed out a request after 10 seconds. Pass `idleTimeout` to
configure." Korban di app: ask-stream/approve-stream senyap saat tool
berjalan lama, narrate di akhir tugas, atau menunggu approval → panel masuk
jalur follow-bus (terlihat "berhenti/reconnect"); route non-SSE yang handler-
nya menunggu LLM >10 dtk juga berpotensi terpotong.

Perbaikan `src/server/index.ts`:
- `Bun.serve({ idleTimeout: 255 })` — nilai maksimum yang diizinkan (detik).
- Helper `makeSseStream()` (DRY untuk ask-stream & approve-stream):
  **heartbeat** komentar SSE `": ka\n\n"` tiap 5 dtk (parser klien drainSse
  melewatkan frame tanpa `data:` — dikunci test baru). Heartbeat menutupi
  senyap >255 dtk (menunggu approval ber menit) dan menjaga proxy/browser
  tak menganggap koneksi mati.
- Perilaku `clientGone` (enqueue ke stream mati tak menggagalkan tugas)
  dipertahankan persis.
Test: `drainSse` komentar heartbeat → 0 event (test/agent-panel.test.ts).
Gate: **369 unit + 512 guard, 0 gagal**; build & tsc bersih. CATATAN:
perlu **restart server** (`bun run start`) supaya idleTimeout & heartbeat
aktif; perubahan (13) dan (14) keduanya masih di working tree.

## UPDATE 2026-09-09 (13) — AKTING AGENT: LLM-DULU, TEMPLATE JADI JARING PENGAMAN (BELUM COMMIT)

Laporan user: di mode agent karakter cuma mengucap kata template
(`as.actor.*`: "Oke, aku pantauin ya…", "Hmm, dia lagi periksa berkas…")
dan tidak memantau/melaporkan/menyimpulkan pekerjaan agent. Diagnosis:
LLM role "chat" sehat (probe /api/assistant/quip merespons berkarakter),
tapi actor.ts (a) mengucapkan fallback template LANGSUNG lalu quip LLM
menyusul di belakang, (b) mayoritas event di-hardcode `allowLLM: false`
(tool_call_start, final_answer, plan_revised, verification_result,
subagent_spawned — alias seluruh momen kerja), dan (c) cooldown quip
berarti template dikucurkan tanpa henti.

Perubahan `src/client/agent/panel/actor.ts`:
- **Urutan dibalik**: quip LLM diminta DULU; template hanya diucapkan bila
  quip gagal (post reject → segera) atau tak datang dalam `fallbackMs`
  (default 4500 ms, injectable untuk test). Quip datang → template
  DIBATALKAN (timer fallback diclear). Quip datang setelah template
  terlanjur → dibuang (tidak dobel bicara).
- **Semua event kerja kini boleh minta quip** (allowLLM true): tool_call_start,
  final_answer, plan_revised, verification_result gagal, subagent_spawned,
  error, thinking_start. `tool_call_end` tanpa komentar (reaksi pandang saja).
- **Label event asli dikirim ke prompt quip** (`event: ev.label` — mis.
  "read_file package.json") supaya komentar spesifik, bukan generik.
- **Cooldown quip 25s → 15s, dan dalam cooldown = DIAM** (bukan template
  kaleng). Cooldown berarti "baru bicara", bukan izin spam.
- `speak` (bus) kini menclear fallback timer — komentar persona server tidak
  tertimpa template yang menggantung.
Test: test/agent-panel.test.ts ditulis ulang untuk semantik baru (9 test
actor: quip menang, fallback timer, reject → template segera, cooldown =
diam, label ke prompt, dsb). Gate: **368 unit + 512 guard, 0 gagal**;
build & tsc bersih. CATATAN: perubahan ini ADA DI WORKING TREE BELUM
DI-COMMIT — bercampur WIP lain (brain timer, panel draft-clear, stage-hint,
vtuber inject "agent", dsb.) dari sesi sebelumnya.

## UPDATE 2026-09-08 (12) — MODE AGENT: LEBAR DEFAULT + PANGGUNG BERSIH PER-MODE (a2ef22e)

Finalisasi permintaan user (hanya mode Agent; mode lain TANPA perubahan):

- **Lebar workspace agent**: `.agent-wide` 860px →
  `clamp(650px, 100vw - 470px, 1200px)` — mengikuti viewport (1280 CSS ≈
  810; 1920 mentok 1200); stage min-width 340 tetap terlindungi.
  Preferensi drag tersimpan (inline basis) tetap menang di atas default.
  `.agent-wide.tech-collapsed 558px !important` dicabut — bentrok clamp.
- **Panggung bersih per-mode**: `body.mode-agent` (toggle di
  mode-runtime `setPanel`) menyembunyikan `#hint`, `#btn-fullbody`,
  `#live-state` via CSS `display:none !important`. HUD DIKEMBALIKAN ke
  index.html — commit paralel f27868a sempat menghapusnya permanen
  (hilang di semua mode, melanggar batasan user); entri (12) lama yang
  mendaftar penghapusan permanen dicabut. Mode lain: HUD normal kembali.
  app.js null-safe untuk ketiganya (initLiveStateIndicator, fbBtn).
Gate: **362 unit + 512 guard, 0 gagal**; build & tsc bersih; i18n OK.

## UPDATE 2026-09-08 (11) — VTUBER: FEED LIVE UTAMA, KONFIG POPUP (f8b4dae)

Permintaan user: panel kanan mode VTuber diutamakan Feed Live; sisanya
popup. Sekarang #mode-vtuber hanya: baris Mulai/Berhenti/status + tombol
**Pengaturan**, lalu Feed Live mengisi sisa tinggi. Form konfigurasi
(platform/channel YT-Twitch/gaya jawab/toggle AI-balas & donasi/jeda/
Overlay OBS + hint) pindah ke popup **#vt-config** (fixed kanan, pola
controls-panel; ✕ / Escape menutup — Escape menutup popup dulu sebelum
controls-panel).

Kunci desain: SEMUA ID tetap (vt-provider/channel/video-id/yt-key/persona/
respond/donate-respond/cooldown/overlay-open/start/stop/status/feed/
alert) → mode-runtime.js (poll 2.5 dtk, provider change row-toggle,
overlay OBS) tanpa adapter; vt-alert tetap di panel utama. i18n +3 kunci
(vt.cfgOpen/cfgOpenTip/cfgTitle) di id+en. Mulai/Berhenti bisa dipakai
tanpa membuka popup (setting terakhir dipakai).
Gate: **362 unit + 512 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-08 (10) — RAIL PROJEK POPUP MELAYANG (c5ab550)

Permintaan user: panel projek boleh muncul di posisi sama tapi JANGAN
mengecilkan panel Live2D. `#projek-rail` dari kolom flex (mendorong
layout) → **popup absolute**: anchor `#left-workspace` (kini
`position: relative`), menempel samping activity bar (`left: 66px`),
melayang di atas stage — bayangan + border `--line-strong`, lebar 264px,
z-index 30. Stage tak tersentuh: `measureOccupied` di projek.ts otomatis
benar karena offsetWidth left-workspace tetap 56 saat rail melayang.

Default auto-open ≥1600px DILEPAS — popup menutupi stage, jadi tak
membuka sendiri tanpa pilihan eksplisit (localStorage `projekRail.open`
tetap dihormati; komentar di projek.ts menjelaskan).
Gate: **362 unit + 512 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-08 (9) — IKON DESAIN SENDIRI UNTUK VTUBER/ASSISTANT/PET (b3082a9)

Masukan user: Video (kamera) generik kurang pas untuk VTuber; Sparkles
'AI magic' kurang mewakili agent. Tiga SVG dirancang sendiri (stroke 1.6,
currentColor, 24×24 — koheren dengan set Reicon yang bergaris):

- **VTuber**: kepala+bahu avatar + dot LIVE ber-arc gelombang siaran di
  sudut — "orang yang sedang live", bukan kamera.
- **Assistant**: kepala robot — antena dot, dua mata, stub kuping, mulut.
- **Pet**: paw versi stroke terbuka (4 jari ellipse + telapak outline),
  bukan blob fill — supaya senada gaya garis.
- Chat tetap Reicon Message. Karan gaya: 2 ikon stroke → paw fill ikut
  dikonversi stroke demi koherensi.
Gate: **362 unit + 512 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-08 (8) — IKON SET REICON DI ACTIVITY BAR (4027ea4)

User minta pelajari reicon.dev dan terapkan + selesaikan overlap tombol
mode (CHAT/VTUBER/ASSISTANT/PET overflow di bar sempit). Riset: Reicon =
library ikon SVG open-source **MIT** (2676+ ikon, Outline & Filled, paket
npm `reicon` + ikonify). Konsumsi dipilih **inline SVG copy** — cocok
prinsip zero-dep client (tanpa npm/CDN runtime), pattern sama dengan
Feather yang sudah ada.

- Mode switcher: Chat→Message, VTuber→Video, Assistant→Sparkles,
  Pet→Paw. `data-mode` & tooltip i18n dipertahankan → wiring
  mode-runtime.js (switcher bergantung tombol data-mode) tak tersentuh.
  Label teks keluar dari DOM; kunci `top.tab.*` tinggal di dict (guard
  i18n hanya parity dict ↔ dict + coverage HTML→dict, jadi aman).
- Gear ⚙ dan folder rail diganti path Reicon (Settings/Folder) — satu
  gaya ikon di activity bar.
- CSS: tombol mode 40×34 → 38×38 persegi; `::before
  attr(data-mode)` (singkatan teks) dihapus; dot status agent tetap.
- Kalau nanti butuh ikon lain: ambil dari `reicon` npm (tar paket →
  icons/*.js punya path `O:` outline), tempel sebagai inline SVG
  `fill="none"` + path `fill="currentColor"` — JANGAN tambah dependensi.
- Gate: **362 unit + 512 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-08 (7) — GEAR GANDA + GRIP SPLITTER (bdfe04f)

Laporan user: di sebelah Clear masih ada tombol lagi (⚙). Akar: kelalaian
di 2422809 — ⚙ baru ditambah ke activity bar tapi ⚙ header lama tak
dihapus → dua tombol, dan yang di header MATI karena ID kembar
(`$("#btn-toggle-controls")` menangkap yang pertama di DOM). Header kini
avatar + nama + Clear saja.

Splitter dipertegas sesuai permintaan: grip 3×56 → 4×96px warna `--muted`
(lebih kontras), hover/drag 5×160px `--lamp`; hit area 8→10px.
Gate: **362 unit + 512 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-08 (6) — KOREKSI: REVERT b42e6aa + PERMINTAAN ASLI (2422809)

User mengoreksi b42e6aa: yang diminta HANYA (1) hapus ☰ overlay stage,
(2) pindah ⚙ ke panel kiri paling bawah — bukan memindahkan composer chat.
Pelajaran: instruksi beranotasi dieksekusi apa adanya; jangan improvisasi
di luar anotasi meski terlihat "cocok secara desain".

- `git revert b42e6aa` (38178c0) — composer kembali ke sidebar, overlay
  stage kembali semula; lalu di atasnya: ☰ stage dihapus, `⚙
  btn-toggle-controls` (ID tetap) jadi `.act-btn` ber-svg gear di dasar
  `#activity` (spacer `.act-flex`); gaya tombol header lama dilepas;
  wiring `stageBtn` null-guard.
- **Jebakan revert yang perlu diingat**: `git revert` menulis ulang 3 file
  static dengan **CRLF** (repo memakai LF). Guard legacy yang menghitung
  jarak karakter antar pola (test-param-notes-ui.js `releasePresetPose
  total`) melewati ambang hanya karena `\r` tambahan per baris
  (d3: 1973→2023, ambang 2000). Solusi: normalisasi `sed -i 's/\r$//'`
  kembali ke LF — jangan ubah ambang guard untuk itu.
- Gate: **362 unit + 512 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-08 (5) — BAR CHAT DI BAWAH STAGE (b42e6aa) — DIREVERT

Anotasi user pada screenshot: **Hapus** Full Body + ☰ overlay pojok stage
dan ⚙ di header chat; **Pindah** composer chat (Mic/ketik/Kirim/frasa/Mode
Otak) ke bar di bawah stage.

- `#stage-chat-bar` baru di dalam `#stage`: Mic + input + Kirim + toggle
  Mode Otak + ☰ (satu-satunya pintu `#controls-panel` sekarang; ⚙ header
  dihapus) + Full Body kontekstual (muncul setelah zoom manual — perilaku
  `state._showFullBtn` tak berubah). SEMUA ID dipertahankan → wiring app.js,
  voice-input, i18n tak tersentuh; composer lama keluar dari `#mode-chat`,
  quick phrases tetap di sidebar.
- CSS: `.stage-ctl` & `#btn-fullbody` dari absolute → static di bar;
  `#live-state` naik ke `bottom: 58px`; bar `flex-wrap` di <1280px (Mode
  Otak turun baris). `frameModel` + `ResizeObserver` (175c6a9/57eb5a0)
  otomatis mem-frame ulang karakter karena stage menyusut ±52px.
- Catatan port: pemindahan ini menyentuh UI legacy app.js — hanya wiring
  tombol (null-guard), logic tetap di app.js; quick phrases & log chat
  belum dipindah (menunggu arahan).
- Gate: **362 unit + 512 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-08 (4) — SPLITTER AKTIF DI 1025–1499PX (fa3f8ed)

User: panel tetap tak bisa digeser (screenshot assistant, tech pane di bawah
percakapan). Akar terverifikasi dari screenshot: mesin user 1920 fisik @
scaling 150% → viewport CSS ±1280 saat maximize → CSS lama menyembunyikan
`#sb-gutter` di ≤1499px, jadi splitter TIDAK PERNAH ada di rentang itu
(kesalahan dugaan "125%" pada entri (2) dikoreksi: sebenarnya 150%).

- CSS: gutter disembunyikan hanya ≤1024px (shell kolom penuh). 1025–1499px:
  .app tetap flex row → flex-basis tetap berarti LEBAR; default 372/540px
  dipertahankan untuk kondisi tanpa ukuran tersimpan (inline menimpa).
- projek.ts: MIN_DESKTOP_W 1025px; `measureOccupied` mengukur anak .app
  nyata (gutter display:none → 0, gap hanya kolom terlihat); floor
  kontekstual — 722px hanya jika tech di samping percakapan (≥1500px +
  agent-wide), bertumpuk 372px. Rentang rasio 20/80 … 50/50 kini dicapai
  (batas bawah stage = min-width 340px ≈ 27% di 1280).
- Regresi: test 1280px (drag 700 → stage 466; 50/50 = 583; tame 372;
  anti-gepeng upper stage 715↔466 skala identik).
- Gate: **362 unit + 512 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-08 (3) — SPLITTER EKSPLISIT + FRAMING ANTI-GEPENG (175c6a9)

Panduan user perbaikan berikutnya (poin 1–2 dieksekusi; poin 3 menunggu
arahan): (1) panel Live2D resize dengan splitter vertikal yang jelas;
(2) panel kiri diperkecil tidak boleh membuat karakter "gepeng" — canvas
jaga rasio, zoom/pan yang menyesuaikan; (3) panel kanan responsif per mode.

- **Anti-gepeng** (`engine/framing.ts` baru, murni → `window.__framing`):
  akar masalah — frameModel legacy membatasi skala dengan lebar stage
  (`min(stageW/natW, H/natH)`) sehingga tiap panel menyempit karakter ikut
  mengecil. Kini `computeFrame` untuk mode `upper`/`full` hanya fungsi
  TINGGI (105%/82% H); lebar hanya menggeser pan (x center) & memotong sisi.
  Hanya `fit` (dobel-klik/reset) yang menyesuaikan lebar. frameModel legacy
  memakai computeFrame dengan fallback rumus lama (degrade manis). Perhatian:
  port "port saat disentuh" — logika framing kini sumber-kebenaran TS,
  app.js tipis; guard = test/framing.test.ts (invarian skala identik untuk
  lebar 840↔372px, tinggi sama).
- **Splitter eksplisit** (CSS `#sb-gutter`): grip bar vertikal 3×56px selalu
  terlihat (`--line-strong`), membesar 96px & menyala `--lamp` saat
  hover/drag; hit area 8px. Drag tetap lewat projek.ts (floor kontekstual,
  state tersimpan — db9d0f2).
- **Panel kanan per mode**: chat & VTuber sudah full-height (sidebar flex
  column, chat-log flex). Assistant menunggu penjelasan user — jangan
  berimprovisasi.
- Gate: **359 unit + 512 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-08 (2) — PANEL LIVE2D RESIZE + STATE TERSIMPAN (db9d0f2)

Lanjutan permintaan user: panel Live2D harus bisa diresize dan ukuran terakhir
tersimpan. Temuan: gutter sudah ada, tapi floor workspace 650px membatasi
stage maksimal ±530px di layar 1536px, dan nilai tersimpan warisan migrasi
(±1040px) otomatis menjadikan stage strip tiap maximize (floor clamp lama
hanya menjamin stage ≥340px — tetap strip).

Fix: floor drag kontekstual — 372px (chat/vtuber) atau 722px (assistant =
tech 340 + gap + percakapan min) di `shell/workspace.ts::workspaceFloor`;
`clampWorkspaceBasis` (drag, stage ≥340) dan `tameStoredWorkspaceBasis`
(restore: stage ≥45% ruang panel, hanya memangkas — preferensi kecil sadar
tetap dihormati). `MIN_DESKTOP_W` 1280→1500: di bawahnya layout bertumpuk dan
inline basis berarti HEIGHT (quirk lama ikut dibersihkan). Mouseup menyimpan
nilai terlihat (hasil clamp), bukan keinginan mentah. Stage = sisa ruang,
di-frame ulang otomatis oleh ResizeObserver `57eb5a0` saat drag.

Konsekuensi user: setelah update, nilai lama 1040 dibaca menjadi ±649 saat
maximize 1536 (stage ±531). Drag gutter ke kiri → stage hingga ±808 (chat
mode). Dobel-klik gutter = reset ke default CSS. Catatan terbuka: default
`.agent-wide` 860px di mode assistant pada layar 1536px tetap menyisakan
stage ±326px (pre-existing, belum disentuh — kandidat perbaikan berikutnya).
Gate: **351 unit + 512 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-08 — STAGE TENGGELAM SAAT MAXIMIZE (FIX 57eb5a0)

Laporan user: restored (gambar 1) stage normal; maximized (gambar 2) stage jadi
strip ±460px dan model Live2D cuma terlihat potongan kiri-bawah. Dua lapis,
satu akar:

1. **Basis workspace tanpa batas.** `applyWorkspaceW` (shell/projek.ts)
   menerapkan preferensi tersimpan `live2d.agentWorkspace.w` (sering ±1040,
   warisan migrasi `live2d.sidebar.w`+340) mentah-mentah begitu
   `innerWidth ≥ 1280`. Workspace `flex-shrink: 0` → stage tergencet sampai
   `min-width: 340px`. Jendela restored (±1260px CSS @125% scaling) justru di
   bawah ambang → default 372px → stage lega. Itulah inkonsistensi yang
   dilaporkan: jendela kecil dapat stage besar, maximize menenggelamkannya.
2. **Canvas/framing tidak mengejar.** `fitCanvas`+`frameModel` (app.js) hanya
   di listener `resize` window; lebar stage berubah belakangan lewat
   transisi `flex-basis 0.18s` → canvas & framing tersangkut di ukuran lama,
   model "tengah canvas lebar" jatuh di luar stage sempit, terpotong
   `overflow: hidden`.

Fix (commit `57eb5a0`): `ResizeObserver` di `#stage` (rAF-debounced) →
`fitCanvas` + `frameModel` mengikuti ukuran akhir elemen apa pun pemicunya
(juga memperbaiki drag gutter yang selama ini tanpa re-frame); fungsi murni
`clampWorkspaceBasis` di **shell/workspace.ts** (modul baru, aman diimpor
test — projek.ts menyentuh `location` di level modul) membatasi basis agar
stage tak pernah di bawah 340px, dipakai `applyWorkspaceW` + `setOpen`.
Regresi: `test/workspace-clamp.test.ts` memakai angka nyata 1260/1536px.
Gate: **344 unit + 512 guard, 0 gagal**; build & tsc bersih.

## UPDATE 2026-09-07 (6) — 4 KOLOM + BROWSER NYATA YANG DIKONTROL AGENT

Target final: `[projek/history][Live2D][conversation][technical pane]` dan browser
harus dapat dilihat serta dimanipulasi oleh user **dan** model. Implementasi
memakai Edge/Chrome headed dengan profil terisolasi + CDP (`ws` yang sudah ada),
bukan iframe/proxy palsu:

- **Keamanan lebih dulu** (`68c6fe9`): API localhost privileged menolak Origin
  asing; same-origin loopback dan CLI/native tanpa Origin tetap berjalan.
  Browser policy hanya HTTP(S), menolak scheme lokal, private/link-local/cloud
  metadata, mengecek DNS, dan mewajibkan grant eksplisit per-origin untuk
  localhost/LAN.
- **Engine CDP** (`bf23263`): discovery Edge/Chrome bersama (fallback Pet ikut
  reuse), launch browser terlihat dengan profil `data/browser/profile`, satu
  tab, navigate/history/focus/close, AX-tree inspect, ref opaque+TTL+stale
  guard, trusted click/type, screenshot, redaksi password/secret.
- **9 tool browser agent** (`9deddc3`): `browser_status/open/navigate/inspect/
  click/type/history/close/grant_private`. Semua aksi mutating lewat approval.
  `browser_type.text` tidak pernah masuk bus/SSE/history/status; hanya panjang
  karakter yang publik, sedangkan nilai asli hidup sementara di approval map.
- **Shell 4 kolom** (`5eecdfc`): conversation tetap di `#sidebar`; Review,
  Terminal, Browser pindah ke `#agent-tech`; Browser punya mount nyata
  `#as-browser-root`. Combined workspace resizable 650–1200px; <1280px panel
  teknis ditumpuk di bawah conversation; Chat tab teknis redundan dihapus.
- **Control plane Browser** (`6b47740`): address/back/forward/reload,
  engine/koneksi/grant, preview screenshot bertimestamp, klik preview trusted,
  focus browser live, close, dan grant origin privat eksplisit. Poll/screenshot
  hanya saat tab terlihat; object URL dibersihkan. API POST wajib JSON 64 KiB;
  screenshot `no-store`; type response tidak mengulang teks.
- Model saat ini text-only, jadi agent melihat halaman lewat accessibility/DOM
  semantic snapshot; screenshot adalah preview user. Tidak ada klaim multimodal
  palsu. User dan agent tetap memakai tab browser nyata yang sama.
- Gate: **336 unit + 512 guard, 0 gagal**; build dan tsc bersih. Manual smoke
  browser terpasang tetap wajib saat merakit release Windows.


## UPDATE 2026-09-07 (4) — GAP AUDIT UI AGENT: STATUS GLOBAL, BADGE LEVEL, CANCEL, QUICK ACTIONS

User memberi checklist "elemen ideal UI agent" (6 kelompok). Hasil audit:
mayoritas sudah ada (streaming, tool card, plan live, approval+diff,
Review/Terminal tab, multi-session, memory, verifikasi ✓/✗, subagent chip,
akting per-event). Empat gap utama ditutup dalam 4 commit:

1. **Status global** — pill panel dapat state `approval` (dulu saat loop
   pause untuk izin, `busy=false` → pill keliru "siap"; kini
   `pendingApprovals` yang menentukan). Tombol Assistant di activity bar
   diberi dot status (`data-agent`: off/idle/busy/approval, poll 4 dtk di
   `projek.ts`) — status agent terlihat dari mana pun. Kartu approval
   dapat pulse rail amber (keyframe `appr-pulse`, opacity-only — patuh
   manifesto).
2. **Badge level tool** — `/status` + field additive `tools [{name,level}]`
   dari registry `TOOLS`; panel menampilkan badge "auto" (mint, safe) /
   "izin" (amber, mutating) di header kartu tool & approval → user paham
   kenapa sesuatu auto-jalan vs diminta izin.
3. **Cancel per-task** — `Runtime.cancelRequested` dicek loop antar-langkah
   (awal turn + setelah `execTool`); tool yang jalan selesai dulu (run_command
   ≤30 dtk — cancel kooperatif, di-dokumentasikan MODES), reply
   "Dibatalkan oleh user.", runtime TIDAK dimatikan. Route
   `POST /api/assistant/cancel` (accepted hanya saat busy); tombol panel
   "Stop Task" (`#as-cancel`) terpisah dari "Matikan Agent" (nuke).
   `ask` baru membersihkan flag sisa — cancel tak bocor antar tugas.
4. **Quick actions + resizable** — 4 chip task umum di composer (teks i18n
   = prompt, dikirim textContent — satu sumber); `#sb-gutter` 6px antara
   stage & sidebar untuk drag lebar panel (320–900px, persist localStorage,
   dobel-klik reset), handler di `projek.ts`.
- i18n: 10 key baru (`as.status.approval`, `as.lvl.*`, `as.cancel*`,
  `as.quick.*`) di KEDUA kamus.
- Gate: **305 unit + 512 guard, 0 gagal**; build & tsc bersih.
- **Sisa gap yang disadari (belum dikerjakan)**: indikator koneksi persisten
  (sekarang masih status line sekali saat drop — bisa jadi dot di pill);
  subagent parallel count (chip ada, hitungan "n/4" belum); rename/pin sesi;
  halaman Review tanpa diff penuh per file.

## UPDATE 2026-09-07 (3) — SHELL 3 KOLOM ala ZCode + PROJEK MULTI-SESSION

User sketsa layout baru (kiblat tetap ZCode desktop): activity bar kiri,
panggung tengah, side panel kanan — dan rail "Projek" berisi riwayat sesi.
Dikerjakan 3 commit (shell / server / rail UI):

- **Shell 3 kolom**: `.app` kini `[activity 56px][projek rail 240px toggle]
  [stage flex:1][sidebar 372px/600px agent-wide]`. `mode-switch` PINDAH utuh
  ke `<nav id="activity">` — id & `data-mode` dipertahankan sehingga
  `mode-runtime.js` TIDAK diubah sama sekali (setPanel/switchMode/boot).
  Tombol mode kini gaya ikon (label disembunyikan, singkatan `data-mode`
  via `::before`, tooltip `top.tabTip.*`). Breakpoint <1024px direvisi.
- **Rail projek** (`#projek-rail`, isi dibangun `src/client/shell/projek.ts`
  → `window.__shellProjek`, start di boot bundle): kartu project (basename
  workdir dari /status, klik = salin path) + daftar sesi (poll 8 dtk saat
  terbuka) dengan switch/new/delete; state buka-tutup di localStorage.
  Aturan AGENTS.md dipatuhi: logic UI baru = TS, bukan legacy JS.
- **Multi-session server** (`src/server/agent/sessions.ts`): store
  `data/assistant-sessions.json` `{active, sessions[]}` — cap 20 sesi FIFO
  (bukan yang aktif), auto-nama sesi = pesan user pertama (40 char),
  migrasi SEKALI dari `assistant-history.json` (+ arsip `.bak`), tulis
  atomic tmp→rename. `state.loadSession/saveSession` jadi wrapper store →
  CLI `bun run agent` otomatis ikut sesi aktif. `Runtime` + `sessionId`.
- **API**: `GET /api/assistant/sessions`, `POST …/sessions/new {workDir?}`,
  `POST …/sessions/switch {id}`, `POST …/sessions/delete {id}` — semua
  409 saat busy. **Pindah sesi TIDAK mematikan runtime** (kontrak MODES
  utuh): facade ganti `rt.history/workDir/sessionId` + persist.
- **Sinkron panel**: `projek.ts` melempar event DOM `agent:session-changed`
  → panel.ts reset transcript/registry/termLog + hydrate ulang dari
  /history + refreshStatus (listener dibersihkan di destroyPanel).
- i18n: 13 key baru (`shell.projek.*`, `as.sess.*`) di KEDUA kamus.
- Guard yang dijaga & hijau: `#pn-search` proximity (area popup tak
  disentuh), urutan script voice-input < emotion-overlay, i18n coverage
  (data-i18n tanpa anak elemen — tombol ikon memakai data-i18n-title).
- Gate: **302 unit + 512 guard, 0 gagal**; build & tsc bersih.
- **Prioritas berikutnya (dicatat)**: rename sesi (sekarang auto-nama
  saja), pin/urutkan sesi, interrupt tugas berjalan per-task (tetap),
  review tab menampilkan diff penuh per file (tetap).

## UPDATE 2026-09-07 (2) — PANEL AGENT "POWERFUL VIBECODING" (diff, markdown, tab, undo)

User menilai UI agent masih kurang powerful untuk vibecoding dibanding kiblat
coding-agent modern; keempat gap diisi dalam 4 commit:

1. **Diff & ringkasan perubahan (client-only)** — `panel/diff.ts` (LCS baris,
   cap 1000 baris, trim prefix/suffix, hunks berkonteks) menghitung diff di
   CLIENT dari argumen `write_file`/`edit_file`/`delete_file` yang SUDAH lewat
   SSE — nol perubahan server. Kartu tool mutasi kini menampilkan diff
   (bukan JSON), kartu approval menampilkan PRATINJAU diff terbuka (keputusan
   Allow/Deny berbasis isi), dan tiap akhir giliran (`done`) memunculkan kartu
   ringkasan "N file berubah +a −r" ala ZCode. Tracking per giliran: reset
   saat `appendUser`, tool ERROR membuang change, pause approval (⏳) menunda
   ringkasan tanpa membuang tracking, `resolveApprovalVisual(klien lain)`
   tetap masuk hitungan.
2. **Markdown + grup langkah** — `panel/md.ts`: parser mini zero-dep → token
   data (heading/paragraf/fenced code/quote/list/inline code+bold+italic+link
   http-saja); view merender via createElement/textContent — TIDAK pernah
   innerHTML konten model (XSS-safe by design). Blok `final` dirender
   markdown; streaming tetap plain+caret. Run ≥2 kartu tool berurutan
   dibungkus grup `.as-step` collapsible ("Bekerja — N langkah", status ikut
   child terakhir, signature rebuild: id+status+rev — state expand child
   terjaga).
3. **Tab Obrolan/Review/Terminal** — `panel/registry.ts` (murni): 
   `ChangeRegistry` (perubahan file lintas giliran; `mergeTouched` menyatukan
   `notes.filesTouched` dari /status — path sesi CLI tampil "touched") &
   `TermLog` (riwayat run_command, cap 80). Server ADDITIVE:
   `assistantStatus()` kini menyertakan `notes: {filesTouched}`. Panel poling
   `view.activeTab()` untuk menggambar halaman aktif.
4. **Undo/revert (server)** — snapshot isi file SEBELUM eksekusi
   write/edit/delete di `execTool` (path lewat `safePath`; hanya bila tool
   SUKSES; SATU rekaman per path = kondisi asli; jalur approval panel/CLI
   ikut karena `agentRunApproved` lewat `execTool`). `Runtime.undo`
   (cap 20 FIFO, in-memory — sengaja TIDAK dipersist, seperti approval).
   Route: `GET /api/assistant/undo`, `POST /api/assistant/revert {id}`
   (error 404 bila id asing; revert ganda ditolak). Panel: tombol Revert per
   file di tab Review → lookup by path → revert → status line di transcript.
- Gate: **295 unit + 512 guard, 0 gagal**; build & tsc bersih. Test baru:
  diff (8), transcript-change (5), md (6), registry (7), undo (6, eksekusi
  sungguhan di workDir mkdtemp), parity status (1).
- **Prioritas berikutnya (dicatat, belum dikerjakan)**: interrupt tugas
  berjalan (cancel 1 task) masih jadi gap — "Matikan Agent" tetap blunt
  instrument; halaman Review belum menampilkan diff penuh per file (baru
  stat), bisa naik level dengan menautkan ke kartu diff di transcript.

## UPDATE 2026-09-07 — REMAKE TAMPILAN AGENT (panel Assistant ala ZCode, port ke TS)

User minta tampilan agent di-remake total — kiblatnya coding-agent seperti
ZCode. Panel lama cuma log teks polos di rail sempit (372px), pertanyaan via
`POST /ask` blocking (user menatap "Memproses…"), aktivitas tool tidak tampil.
Kini:

- **Panel port ke TS** — aturan lama "panel DOM tidak direncanakan di-port"
  DIREVISI (AGENTS.md + MODES.md + README sudah diubah): panel kini di
  `src/client/agent/panel/{stream,transcript,actor,view,panel}.ts`,
  di-bundle sebagai `window.__agentPanel`; `mode-runtime.js` tinggal bridge
  `start()` ±10 baris. Tidak ada guard legacy yang menunjuk mode-runtime
  (dicek grep) — logic teruji lewat `test/agent-panel.test.ts` (32 test baru).
- **Transcript live ala ZCode**: rail melebar `#sidebar.agent-wide`
  (372→600px, karakter tetap terlihat); streaming delta via SSE
  `/api/assistant/ask-stream` yang selama ini hanya dipakai CLI; kartu tool
  collapsible (args pretty + hasil, dot status); kartu approval menonjol;
  plan widget dengan progres x/y; chip subagent; status pill
  (siap/bekerja/bekerja-klien-lain/mati); textarea auto-grow (Enter kirim,
  Shift+Enter baris baru).
- **Server additive** (kontrak lama utuh): `assistantResolveApproval` menerima
  `onEvent` opsional; `agentRunApproved` meng-emit SSE `tool_result` (hasil
  tool yang disetujui kini sampai ke transcript); bus event
  `permission_resolved` (yang selama ini cuma deklarasi) kini benar-benar
  di-emit saat approve/deny; route baru `POST /api/assistant/approve-stream`
  (SSE, pola sama dengan ask-stream); `clipToolResult` line-boundary-aware
  (diff tak putus di tengah baris) + chip "…dipotong" di panel.
- **Dedup eksplisit antar 3 channel** (SSE + poll status 2dtk + poll bus
  1,5dtk): kartu approval satu-satunya sumber = `pendingApprovals` dari
  `/status` keyed by `ap.id` (event SSE/bus hanya pemicu refresh); plan satu
  sumber = `status.plan`; transcript punya mode `live` (SSE) vs `follow`
  (bus — pantau CLI/klien lain) dengan supresi
  `thinking/tool_call/permission/final/error` saat live;
  `verification/subagent` selalu dirender (tidak ada di SSE).
- **Protokol putus-koneksi dua-kasus** (`decideFallback`, teruji): SSE gagal
  sebelum event pertama → cek `/status` fresh, resend `POST /ask` sekali bila
  tidak busy; putus setelah ≥1 event → TIDAK PERNAH resend, lanjut follow
  dari bus + hydrate jawaban final dari history saat busy→false (dedupe by
  teks). Server juga sudah menolak ask kedua saat busy (defense-in-depth).
- **Kontinuitas approve→lanjutan**: kartu approval bermetamorfosis jadi kartu
  tool "menjalankan…" → diisi `tool_result` dari approve-stream; lanjutan
  delta menempel tanpa bubble/header baru; prompt internal "Lanjutkan tugas…"
  difilter dari hydrate.
- **Direktur akting dipertahankan + diperluas per-event** (port ke
  `actor.ts`, cooldown 2,5dtk/25dtk utuh): verification gagal→prihatin,
  lolos→ringan tanpa komentar; subagent_completed→senang; plan_revised→gaze
  think + fallback `as.actor.revised`; permission_resolved disetujui→lega,
  ditolak→tanpa reaksi.
- **Hydrate saat buka panel**: `/api/assistant/history` (user→bubble,
  assistant→bubble final, tool→kartu hasil, `MENUNGGU PERSETUJUAN:`→kartu
  running), bus TIDAK direplay (baseline seq terkini), workdir dicerminkan
  dari `/status`.
- i18n: 21 key baru `as.*` di KEDUA kamus (id/en, parity hijau); key mati
  lama dibiarkan (tak berbahaya). Tombol Reset (`/api/assistant/reset`, sudah
  ada dari dulu) kini diekspos di panel.
- Gate: **260 unit + 512 guard, 0 gagal**; build & tsc bersih.
- **Prioritas berikutnya (dicatat, belum dikerjakan)**: interrupt tugas
  berjalan (cancel 1 task, bukan "Matikan Agent" yang mematikan runtime) —
  `run_command` 30 dtk & subagent paralel maks 4 bisa nyangkut, dan satu-
  satunya jalan keluar sekarang blunt instrument.

## UPDATE 2026-09-02 (4) — jalur saran preset AI diperbaiki & diuji end-to-end

Keluhan "analisis AI untuk sheet gagal mulu" dianamis sampai akar:

1. **Role `sheet` cuma dipegang satu koneksi** (gemini "germini") yang sering
   HTTP 503 high demand — tak ada kandidat fallback ber-role sheet. Kini
   ada koneksi kedua **"Tf-mimo"** (tokenfaucet, model `mimo-v2.5`, role
   sheet, stream:true) lewat `POST /api/config` — chat user (gpt-5.6-terra)
   tidak tersentuh. Germini tetap urutan pertama; 503 → jatuh ke Tf-mimo.
2. **Gateway openai-compatible memutus non-stream dgn HTTP 524 ~15 dtk.**
   conn.stream=true wajib untuk faucet ini. Kelemahan lamanya: postJson
   memakai timeout ABSOLUT 60 dtk — mimo dengan prompt 50k char butuh
   36-59 dtk → bisa ter-abort acak. Kini timeout jadi **idle timeout**
   (di-reset tiap chunk stream) saat conn.stream=true.
3. **Truncation senyap**: gemini-2.5 (thinking model) memakan budget output
   utk reasoning — maxTokens 2048 membuat JSON 12 preset terpotong → parse
   gagal → `presets:[]` tanpa penjelasan. maxTokens germini dinaikkan ke
   8192 (via API), balasan terpotong kini di-**salvage**
   (`salvageJSONArrayOfObjects` — N-1 objek utuh diselamatkan, string-aware)
   dan kalau nihil, warning eksplisit + awalan balasan dikirim ke user.

Hasil end-to-end lewat endpoint asli (payload 223 param + 128 catatan):
**12 preset valid** (emosi/properti) dalam 36 dtk, tersimpan ke
`presets.ai` sheet lumine. Guard: unit test salvage (13) — total **217 unit
+ 505 guard, 0 gagal**. Commit ffd57c3.

## UPDATE 2026-09-02 (3) — peta param 神宫白子 + popup param (cari/grup/label cdi3) + grup di payload AI

**Peta param model kedua (神宫白子 / 面饼0, Cubism 5.0):** seluruh 214 param
dirender MIN vs MAX (freeze persistent + override-per-param + physics hidup +
**settle 45 frame sebelum tiap render**): **213 hidup, 1 mati** (`Param5` =
高光/highlight), 13 halus (31–115 px; highlight mata/pupil + aksesori kecil —
pita, tombol controller). Kontras lumine (83/223 mati) — perbedaan murni rig,
bukan runtime. PELAJARAN PENTING pengukuran: spring physics rig ini punya
konstanta waktu panjang — tanpa settle panjang, sisa getar antar render
menghasilkan noise 5–27 ribu px yang MENUTUPI param mati (hasil "0 mati"
pertama tanpa settle itu palsu). Nilai param setia + render deterministik
(tes MIN-vs-MIN dan render-ganda-0-px dipakai sebagai noise floor).

**Popup "📝 Penjelasan Parameter" diperluas:**
- Kotak pencarian (`#pn-search`): filter live id/label/grup + isi catatan;
  header grup yang semua barisnya tersaring ikut disembunyikan; tanpa
  re-render (nilai slider & fokus textarea tidak rusak).
- Header grup (`appendGroupHeader`): param dikelompokkan via
  `resolveParamGroup` (user > ai > heuristik), urutan kemunculan pertama;
  "Bagian (Parts)" tetap seksi terpisah.
- **Label + grup ASLI rigger dari cdi3.json** (`prefetchCdiInfo`, fire-and-
  forget saat loadModel): Name ("heart eye", "eyelashes shake4", 猫猫贴纸)
  menggantikan id mentah sebagai label; GroupId jadi judul grup
  `Rig: <label0> +N` (lihat `cdiGroupTitle`). Sheet yang sudah ada di-patch
  in place saat data tiba (label/grup bukan field user); popup terbuka
  di-render ulang lewat jembatan `window.__pnRefreshIfOpen` (scope wireUI).

**Saran preset AI:** payload analyze-sheet kini menyertakan `group` per param
(dikirim client, ditulis server ke prompt sebagai `[grup: …]`) supaya LLM
tahu param mana yang sekeluarga. Ditambah pembersihan data: **95 catatan
userNote palsu sisa scanner lama** (template "Tidak ada efek visual
terdeteksi…" — termasuk klaim keliru "ParamAngleX tak dipakai rig" yang
terbantahkan scan 2026-09-02) dihapus dari sheet lumine; catatan analisis
asli (128) dipertahankan. Berkas sheet git-ignored (data user).

Guard baru: `test-param-notes-ui.js` (18 assertion). Suite kini **212 unit +
505 guard, 0 gagal**.

## UPDATE 2026-09-02 (2) — fitur "🧪 Kalibrasi Efek" DIHAPUS (keputusan user)

User memutuskan menghapus fitur kalibrasi efek: hasil ukurnya sering tidak
cocok dengan yang terlihat (param yang bergerak halus terukur "mati" di
beberapa model), dan param yatim yang memang tidak bergerak justru membuat
badge-nya terasa tak berguna. Yang dihapus:

- Tombol `#btn-visfx-calibrate` + span `#visfx-status` (index.html) + CSS
  `.dead-param`/`.pn-dead-badge` (app.css).
- `runVisualCalibration()` + `VISFX_SETTLE_FRAMES` + badge di
  `buildParamSliderRow` + status popup (app.js).
- `visfxIsDead`/`visfxSummarize`/`filterVisfxDead`/`visfxSave` — saran preset
  AI kembali mengirim SEMUA param (data yang tidak dipercaya justru bisa
  menyembunyikan param yang benar-benar hidup dari LLM).
- Guard `test-legacy/test-visual-calibration.js` dihapus (suites 11 → 10;
  total kini 212 unit + 487 guard, 0 gagal).

Yang DIPERTAHANKAN: gate overlay-vs-native (`overlayGateSuppress`) tetap
membaca `state.visfxMap` — kini hanya sebagai cache LEGACY dari localStorage
v2 warisan scan lama (tidak ada scanner baru; tidak pernah ditulis ulang).
Tanpa data → fail-open (overlay jalan seperti dulu; terverifikasi di
browser: lumine tanpa entri visfx → overlay heart tetap menyala, bindings
`exp_heart` → ParamEX04/05/08/09/11 tetap terbaca dari server). Penjelasan
param yang tidak bergerak kini manual: `ParamEyePhysics18` ("eyelashes
shake4") TIDAK ADA sama sekali di `lumine.physics3.json` (outputs hanya
EyePhysics1–16) dan tidak terikat art — param yatim rig distribusi; tidak
ada kode apa pun yang bisa menggerakkannya. Kelas yang sama: RX1_1, EX02-11.

## UPDATE 2026-09-02 — freeze edit TIDAK menol physics lagi

Lanjutan akar masalah yang sama: bukan cuma scanner — **freeze edit manual**
(`freezeModelForEdit`, dipakai popup Penjelasan Parameter + Sheet preset editor
+ Motion Studio) juga me-nol-kan `im.physics`, sehingga geser slider pada param
INPUT physics (ParamAngleX/BodyAngle*/Breath) saat model dibekukan tampak MATI
total: 0 piksel, persis keluhan user. Diperbaiki dengan menyamakan freeze
dengan scan:

- `freezeModelForEdit` kini hanya membungkam **motion (stopAllMotions) +
  expression reset + eyeBlink + breath + fidget/mouse-follow (aiLock)**.
  Physics dibiarkan hidup — slider pada param input langsung terlihat
  (terukur di browser, lumine, freeze aktif: ParamAngleX -30 vs +30 =
  **23.994 px berubah**, dulu 0 px).
- Nilai slider pada param OUTPUT physics tetap menang lewat override guard
  (re-assert di beforeModelUpdate = SETELAH physics.evaluate), jadi kedua
  arah input/output sama-sama bekerja saat frozen.
- `unfreezeModelForEdit` tetap memulihkan physics/eyeBlink/breath dari
  `state._frozenRefs` (same-ref, no-op untuk physics).
- Guard: `test-visual-calibration.js` section 8 +3 assertion (freeze tidak
  menulis `im.physics = null`, blink/breath tetap dibungkam, unfreeze
  memulihkan refs). Suite total: **212 unit + 525 guard, 0 gagal**.
- Tombol "🧪 Kalibrasi Efek" TETAP DIPERTAHANKAN (keputusan sesi ini):
  fungsinya menghasilkan data badge "🚫 tanpa efek" per param (cache
  localStorage v2 per model), menandai param yang GENUINE tidak terikat art
  (lumine: 20/223 — rantai _1/_4 VBridger dsb.), dan memfilter param mati
  dari saran preset AI (`filterVisfxDead` di analyze-sheet) supaya LLM tidak
  mengusulkan preset yang pasti tampak rusak. Setelah fix scan 2026-09-01 (3),
  datanya jujur; sebelum fix, badge banyak yang salah menandai param hidup.

## UPDATE 2026-09-01 (3) — scan kalibrasi diperbaiki + cache lama di-invalidasi

Investigasi keluhan user "param physics (contoh `ParamBodyPhysicsRX1_1`) tidak
bereaksi ke slider" menemukan TIGA titik buta scanner sekaligus. Hasil akhir
setelah semua diperbaiki (scan asli via tombol, lumine): **mati turun
84 → 20/223**, `ParamAngleX` 0 → ±22.000 px, `ParamBodyAngleX` 0 → ±124.000,
`ParamSkirtX1` kembali ±63.000 (sempat 430 saat physics-hidup-tanpa-re-assert).
`ParamBodyPhysicsRX1_1` terukur ±0 piksel (±396 px pada JPEG, 0.07% layar) —
badge "🚫 tanpa efek" untuk param itu kini JUJUR dan konsisten dengan
pengalaman user menggesernya (tak terlihat mata).

Tiga gangguan yang kini dibungkam selama scan (`runVisualCalibration`, app.js):

1. **Overrides user di-stash; param yang DISCAN dipasang sebagai override
   sementara.** Dulu: sticky overrides (slider yang pernah digeser,
   eye-follow, aksesoris) + rawDrive di-re-assert guard pada
   `beforeModelUpdate` dan menimpa tulisan MIN/MAX scan → param itu terukur
   "mati" palsu. Kini `state.overrides` diganti map kosong + `state.rawDrive`
   null selama scan, dan param yang discan dipasang sebagai override — guard
   me-re-assert MIN/MAX pada titik yang benar (setelah physics.evaluate,
   sebelum o.update yang dirender), lalu semuanya dipulihkan di finally.
2. **Grup Idle di-stash** (`mm.groups.idle = null`) — `motionManager.update`
   me-restart idle saat queue kosong; evaluasi CubismMotion dimulai dengan
   `loadParameters()` yang MENGHAPUS tulisan scan. Param yang dianimasikan
   idle terukur mati palsu di model yang mendeklarasikan grup Idle (lumine
   tidak punya — model lain ada).
3. **PHYSICS TETAP HIDUP selama scan** — freeze meng-nol-kan `im.physics`,
   padahal param INPUT physics (AngleX/BodyAngle*/Breath, dst.) hanya
   berdampak piksel MELALUI rantai physics: physics mati → MIN vs MAX
   dirender identik → mati palsu (terukur: AngleX 0 px physics-mati vs
   ±24.000 px physics-hidup). Konsekuensinya physics menimpa param output
   tiap frame — ditangani oleh (1): guard menulis ulang MIN/MAX SETELAH
   physics.evaluate. Settle frames (`VISFX_SETTLE_FRAMES` = 4) memberi
   spring waktu konvergen sebelum render dibandingkan.

Lainnya:
- **Cache kalibrasi dibump ke v2** (`visfxStoreKey` → `l2d_visfx_v2_<key>`) —
  data scan lama (ternoda titik buta 1/2 dan/atau diambil saat shim stamp
  masih buta) otomatis tak terbaca. Scan ulang SEKALI untuk badge akurat;
  data lama tinggal yatim di localStorage (bukan data loss).
- Guard: `test-visual-calibration.js` dirombak ke kontrak baru (stash
  overrides + override-per-param + physics hidup + settle + prefix v2).
  Suite total kini: **212 unit + 522 guard, 0 gagal** (11 suite).
- Catatan verifikasi: mengukur dari tab latar belakang browser menyesatkan
  bila lupa rAF/ticker app tak jalan di sana — `internalModel.update` baru
  dievaluasi saat RENDER (`_render`), jadi pompa uji harus mencakup
  `renderer.render(stage)`, bukan cuma `Ticker.shared.update()`.

## UPDATE 2026-09-01 (2) — gate overlay vs efek native (dobel-gambar) SELESAI

Risiko "overlay emosi bisa dobel dengan efek native di rig v5" (disebut di
bagian konsekuensi fix shim di bawah) kini ditangani dengan data terukur,
bukan toggle manual:

- **Server**: `discoverExpressions()` (`src/server/index.ts`) kini menyertakan
  `params` per ekspresi — Id yang ditulis ISI file `.exp3.json` (baca disk,
  dedupe, file rusak → `[]` bukan error). Backward-compatible: field lama
  `Name/File/declared` tetap.
- **Client** (`static/js/app.js`): `fireOverlay()` melewati gate
  `overlayShouldSuppress()` sebelum menyalakan overlay. Gate = fungsi murni
  `overlayGateSuppress(name, bindings, visfx, resolveFx)`: overlay DITEKAN
  hanya bila ekspresi itu memetakan ke efek overlay (via `_resolve`), namanya
  ada di bindings `.exp3` native, dan minimal SATU param bindings-nya terukur
  HIDUP di kalibrasi (`changed > 0`). Semua keadaan tanpa bukti (belum
  dikalibrasi, fetch gagal, alias emosi universal seperti `sedih` yang bukan
  nama `.exp3`) → **fail-open**: overlay jalan seperti sebelumnya. Kegagalan
  paling parah = dobel-gambar seperti sebelum fix shim, bukan efek hilang.
- Bindings di-prefetch saat model dimuat (`prefetchOverlayGate()`, di samping
  `detectModelCapabilities()`), cache dibuang saat model ganti.
- Guard baru: `test/legacy/test-overlay-gate.ts` (28 assertion — server
  in-process, keputusan murni via vm-extract, wiring level sumber).
  Suite total kini: **212 unit + 514 guard, 0 gagal** (11 suite).
- Catatan: kalibrasi yang tersimpan SEBELUM fix shim (masa stamp v4) akan
  membuat gate fail-open untuk semua efek — aman (dobel seperti perilaku lama),
  tapi re-scan kalibrasi tetap dianjurkan agar gate aktif dan badge akurat.

## UPDATE 2026-09-01 — AKAR MASALAH SEBENARNYA KETEMU (shim stamp v5→v4)

Kesimpulan lama "butuh core ≥5.2" **TERBUKTI SALAH**. Akar masalah sesungguhnya:
**`patchCubismCore()` di `static/js/app.js`** — shim kompatibilitas warisan core
4.2.2 yang menurunkan stamp versi moc3 `5 → 4` secara MEMBUTA sebelum
`Moc.fromArrayBuffer`. Akibatnya moc3 v5 (lumine rig 5.x, hash e07d58a8) di-revive
sebagai moc **v4** → tabel keyform BlendShape (ParameterType_BlendShape=1) tidak
pernah diinisialisasi → EX02–05/08–11 tidak pernah terevaluasi walau nilai
parameternya tertulis benar (terverifikasi: `ex05:1` di buffer, opacity
ArtMesh44/225 tetap 0).

Bukti A/B hari ini (core 5.1.0 yang sama, bytes moc3 yang sama, terverifikasi sha):
- **Tanpa shim** (halaman minimal HTML + probe Bun): keyform BlendShape
  **DIEVALUASI** — mata spiral dizzy tampil, opacity ArtMesh44/225 0→1.
- **Dengan shim** (app): nol perubahan drawable (`dVtx=0 dOp=0 dMul=0 dScr=0`).

**Fix (TER-COMMIT — `096175e`):** shim diubah menjadi *try-genuine-first* —
coba `orig(ab)` dengan stamp asli; hanya kalau core mengembalikan null, stamp
diturunkan ke 4 lalu dicoba lagi. Moc v5 asli → jalan penuh (fitur BlendShape
hidup); moc "stamped-5-tapi-layout-v4" → tetap selamat lewat fallback lama.

Konsekuensi & catatan lanjutan:
- **Kesimpulan B di bawah (BlendShape butuh core ≥5.2) TIDAK LAGI BERLAKU** —
  core 5.1.0 mengevaluasi blendshape dengan baik selama stamp moc tidak dipalsukan.
  Opsi #1 di bawah (unduh core ≥5.2) tidak diperlukan untuk efek ini.
- **Overlay emosi kini bisa dobel dengan efek native** di rig v5 (mis. exp_heart
  menggambar hati via rig + overlay menggambar hati lagi) — **SUDAH DI-GATE**
  dengan data kalibrasi; lihat "UPDATE 2026-09-01 (2)" di atas. Kalau tetap
  terlihat dobel di rig tertentu, cek dulu apakah kalibrasi sudah di-scan
  ulang pasca-fix shim, atau matikan `overlay.enabled`.
- Kalibrasi 🧪 "94/223 tanpa efek" untuk MyModel kini basi — di-scan saat shim
  masih men-stamp v4. Re-scan kalau mau badge yang akurat.

## Ringkasan satu paragraf (historis — dibuat sebelum akar masalah ketemu)

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
- Kalibrasi tersimpan di **localStorage** per model (`l2d_visfx_v2_<key>` —
  v2 sejak fix scan 2026-09-01, data kunci lama basi; lihat UPDATE (3)) —
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
   `overlay.enabled`). Gate dengan data kalibrasi kini TERPASANG (lihat
   "UPDATE 2026-09-01 (2)") — efek yang terukur hidup tidak lagi digambar
   dobel oleh overlay. Overlay tetap relevan sebagai kompensasi untuk ekspresi
   yang rig-nya memang tidak mengikat art (rig v4.2, rig distribusi).
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

1. `bun run test` → harus 212 unit + 487 guard, 0 gagal.
2. `bun run src/server/index.ts` → buka 127.0.0.1:8310 → Load lumine →
   geser ParamCollarChange → warna ikat pinggang berubah.
3. Load MyModel (Cubism 5.0) → termuat ±300ms.
4. `window.__live2dAgent.setExpression('exp_heart',1)` → hati melayang
   di atas kepala (overlay) — lumine fresh TIDAK punya data visfx di
   localStorage → gate fail-open → overlay jalan.
5. Popup Penjelasan Parameter → TIDAK ada tombol 🧪 (fitur dihapus
   2026-09-02 (2)) dan TIDAK ada badge "🚫 tanpa efek".

## Peta param lumine (ukur 2026-09-02, model fresh dari distribusi)

Model dibandingkan hash MD5 (zip distribusi = folder fresh = copy project,
byte-identik) lalu SEMUA 223 param dirender MIN vs MAX (freeze persistent +
override-per-param + physics hidup + pump `im.update` + render ke
RenderTexture): **140 hidup, 83 mati (0 px), 11 halus (<60 px)**. Pola mati
= fakta rig VBridger, bukan bug runtime:

- Rantai physics `*Physics(R|L|)X/Y#_{1,4}`: segmen `_1`/`_4` mati, `_2`/`_3`
  hidup (contoh RX2_3 = 23.512 px vs RX2_1 = 0) — rigger hanya memakai
  segmen tengah tiap rantai.
- `ParamEyePhysics8–14, 17, 18` (grup kedua fisika mata: "Pupil Physics2",
  "eyelashes shake3/4", dst.) mati semua; 17/18 bahkan TIDAK ADA di
  physics3.json. Grup pertama (1–7, 15–16) hidup tapi halus (eyelash
  shake1/2 = 11–25 px).
- Param mulut rigger `MouthFunnel/Shrug/PressLipOpen/PuckerWiden` mati;
  `EX01/04/06/07/12` mati; `EX02/03/05/10` hidup tapi halus (14–52 px).
- Implikasi: slider/preset pada param mati memang tidak akan pernah
  berbuat apa-apa — bukan sesuatu yang bisa diperbaiki app.
