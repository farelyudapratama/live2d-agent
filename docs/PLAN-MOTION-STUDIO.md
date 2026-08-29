# IMPLEMENTATION PLAN — Motion Studio & AI Motion System

> **STATUS: SELESAI (7/7 fase) + REVISI Raw Parameter Mode.**
> Baseline test 1234 passed / 0 failed di 26 suite.
> Catatan penyimpangan saat implementasi awal ada di §5; revisi besar
> (Semantic Mode dihapus, diganti Raw Parameter Mode) ada di §6.

Dibuat berdasarkan audit kode aktual (semua referensi `file:line` diverifikasi).
Prasyarat baca: `docs/SPECIFICATION — Motion Studio & AI Motion System.md` (SPEC) dan
`docs/CRITICAL UI & FLOW CONSTRAINTS.md` (CONSTRAINTS). Status: **greenfield** — belum ada
`motions/`, `motion-dsl.js`, `motion-registry.js`, atau `motion-runtime.js` di repo.

---

## 0. Temuan Audit Kunci (dasar keputusan desain)

1. **"Motion DSL runtime" sudah setengah ada, implisit.** Gesture prosedural saat ini adalah
   rantai `setTimeout` yang menulis target `state.aiPose` (app.js:4193-4233), dengan step
   `{d:{field:delta}, ms}` terbatas pada 8 field semantik (`ax, ay, bodyX, bodyY, bodyZ, ex, ey,
   mouthForm` — whitelist `STEP_FIELD_BOUNDS` app.js:3747-3751). Interpolasi sesungguhnya
   dilakukan oleh ease engine di tick rAF (`target()` app.js:656-666, ease 0.16/0.25).
2. **Registry juga setengah ada**: preset kategori `gerak` di `sheet.presets.user/ai`
   (persist di localStorage + `POST /api/sheet`), resolusi user>dulu (findPreset app.js:3866),
   proteksi nama reserved (`reservedGestureNames()` app.js:3908), dan server sudah **menolak**
   steps buatan AI (`analyze-sheet` mengecualikan kategori gerak, server.js:806-808).
3. **Scheduler/ownership sebagian ada**: guard `clipUntil` + ramp `poseAuthority`
   (app.js:637-653, di-set hanya oleh `playEmotionClip()` app.js:5807-5811). Jalur
   `playGesture` native (app.js:4200-4207) TIDAK memasang guard — kandidat perbaikan, bukan rewrite.
4. **Penyiaran kapabilitas ke LLM terpusat** di `getCapabilityProfile().gestures`
   (app.js:5693-5695) → prompt agent (agent.js:120-128) + capabilities `/api/animate-text`
   (agent.js:471-475). Mengubah satu titik ini = semua motion baru otomatis terlihat LLM.
5. **Validasi LLM di server sudah baku**: `KNOWN_ROLES` server.js:244-249, pola
   reject-unknown/clamp-intensity di `/api/animate-text` (server.js:1002-1020).
6. **UI sudah punya komponen reusable**: `.modal` (css/app.css:485, dipakai editor koneksi AI,
   `openModal/closeModal` app.js:2051-2063), popup mengambang `.pn-popup`, tab bar
   `.tabs > .tab[data-tab]` (index.html:89-91). Tidak perlu visual system baru.
7. **Server statis melayani file apa pun di ROOT** (server.js:1536-1572) — file JS baru
   tidak butuh perubahan server. Antrian tulis `queueJsonWrite` (server.js:127-140) siap dipakai
   untuk `motions/`.
8. **Pola test**: suite Node standalone ringkasan akhir `N passed, M failed`, di-auto-discover
   `test/run-all.js`; mocking via `extractFn` + `vm` (lihat test/test-fase4-behaviour.js:23-46)
   atau UMD `require()` (motion-taxonomy.js).

### Konflik & risiko yang diidentifikasi
- **Kolisi nama gesture**: sudah dimediasi sistem reserved-name — registry harus memakai mekanisme
  yang sama, bukan sistem paralel.
- **Duel penulis parameter**: pose AI vs motion native vs gesture — loop eksisting sudah punya
  authority/guard; runtime baru WAJIB lewat `state.aiPose` + guard yang sama, dilarang menulis
  `setParameterValueById` langsung.
- **Presedensi format lama**: `[GESTURE:nama]` dan `animate-text {gesture}` harus tetap valid
  di semua fase (CONSTRAINTS §7).
- **Skema sheet v4 tidak boleh diregresi** (HANDOFF-SHEET-SYSTEM) — motion asset TIDAK
  disimpan di sheet, tapi di `motions/<model>/` terpisah.

---

## 1. Keputusan Desain Inti

### D1 — Format Motion Asset (v1) = superset format gesture eksisting
Track memakai nama field semantik yang SAMA dengan whitelist eksisting
(`ax, ay, bodyX, bodyY, bodyZ, ex, ey, mouthForm`) supaya:
- `sanitizeSteps()`/bounds/reuse langsung berlaku;
- konversi dua-arah preset `gerak` ⇄ motion asset trivial;
- tidak muncul sistem penamaan kedua yang bertentangan dengan SPEC §3
  (SPEC memakai `angleX` dsb — kita petakan: `angleX→ax`, `angleY→ay`, `bodyZ→bodyZ`, dst.
  di satu tempat: `motion-dsl.js`).

```json
{
  "version": 1,
  "id": "wave_hi",
  "name": "Wave Hi",
  "description": "Melambaikan tangan dengan ceria.",
  "tags": ["greeting", "happy"],
  "duration": 1.4,
  "loop": false,
  "intensity": { "min": 0.3, "max": 1.0, "default": 0.8 },
  "emotionCompatibility": { "senang": 1.0, "normal": 0.7 },
  "cooldown": 3000, "priority": 60, "aiEnabled": true,
  "requires": ["head", "body"],
  "tracks": [
    { "target": "ax", "intensityScale": 1.0,
      "keys": [{ "t": 0, "v": 0 }, { "t": 0.3, "v": 5 }] }
  ]
}
```

### D2 — Registry = agregator tiga sumber, tanpa duplikasi data
`motion-registry.js` (client-side, singleton di `window.__motionRegistry`) menggabungkan:
1. `source:"builtin"` — 9 entri `GESTURE_LIBRARY` (dibungkus, tidak disalin);
2. `source:"native"` — klip `.motion3.json` dari taxonomy cache
   (`GET /api/model/motion-taxonomy`, `state.motionTaxonomy`) sebagai `id: "motion_<group>"`;
3. `source:"user"` — file `motions/<modelKey>/*.motion.json` (fetch dari server).

Precedence lookup mengikuti aturan eksisting `playGesture`: native → preset user gerak →
builtin (app.js:4193-4216). Tidak ada penyalinan preset gerak; entri user-motion dijual ke LLM
melalui `getCapabilityProfile().gestures` yang diperluas (satu-satunya perubahan di titik ini).

### D3 — Runtime = generalisasi jalur gesture, bukan mesin baru
`motion-runtime.js` mengekspos `motion.play/stop/stopAll/isPlaying/getActive/listAvailable`
(SPEC §11) dan diimplementasikan sebagai:
- evaluator keyframe (linear/ease-in/out/in-out) per track pada timeline miliknya sendiri;
- output tetap **menulis target `state.aiPose`** via API `__live2dAgent.setAIPose` /
  jalur internal gesture (token supersede), sehingga ease engine, fidget, override sticky,
  dan guard `clipUntil` tetap bekerja tanpa perubahan;
- `playGesture()` dialihkan secara internal ke runtime (perilaku publik identik —
  CONSTRAINTS §4); gesture builtin direpresentasikan sebagai keyframe hasil konversi
  dari steps (deterministik, di-cache).
- intensity: skala amplitudo per-track `v * intensity * intensityScale` (SPEC §14),
  clamp ke `STEP_FIELD_BOUNDS`.
- scheduler prioritas (SPEC §12) versi awal: tabel prioritas menentukan siapa yang boleh
  memegang `aiPose` saat bentrok; idle/fidget tetap jalur lama (prioritas terendah, sudah tunduk
  pada `poseAuthority`).

### D4 — Persistensi: `motions/<modelKey>/catalog.json` + `<id>.motion.json`
Ditulis server lewat endpoint baru memakai `queueJsonWrite` + `writeJsonAtomic` yang sama
dengan sheet. `modelKey` = `sanitizeKey()` server (server.js:1272, mirror `currentModelKey()`
app.js:4421). Konflik ID → tolak dengan pesan, jangan overwrite (SPEC §26).

### D5 — UI: tab ke-4 `data-tab="motion"` + editor gaya popup mengambang
Satu tab baru "Motion" di tab bar eksisting (index.html:89-91) membuka Motion Studio
sebagai overlay `.pn-popup`-style besar (pola sudah ada) berisi: daftar motion, preview
(pakai model Live2D yang sudah termuat — tidak ada canvas kedua), timeline, panel metadata.
Semua class CSS memakai konvensi eksisting (`--accent`, `.mini-btn`, dll).

---

## 2. Rencana Berdasar Fase (mengikuti SPEC §30, disesuaikan temuan audit)

### Fase 1 — Core tanpa UI (murni modul baru + test)
File baru:
- `js/motion-dsl.js` (UMD seperti motion-taxonomy.js): parse/validate/normalize Motion Asset,
  konversi `gerak steps ⇄ tracks`, mapping nama peran SPEC↔field internal, evaluator
  interpolasi keyframe, `sanitizeMotionAsset()` (NaN/Infinity/t negatif/durasi ≤0/target tak
  dikenal → ditolak; clamp pakai `STEP_FIELD_BOUNDS`).
- `js/motion-registry.js` (UMD): `register/get/has/list/search`, penanganan ID duplikat,
  field metadata SPEC §8 (source, cooldown, priority, capabilities).
- `js/motion-runtime.js` (browser-only, UMD tipis): API SPEC §11 di atas jalur D3.
Test: `test/test-motion-dsl.js`, `test/test-motion-registry.js`, `test/test-motion-runtime.js`
(pola vm/UMD; runtime diuji dengan stub `__live2dAgent`). Tidak ada perubahan file lama.

### Fase 2 — Integrasi sistem eksisting (masih tanpa UI)
- `app.js`: (a) `playGesture()` dirouting internal via runtime (perilaku publik sama,
  termasuk jalur native `motion_`); (b) bug kecil diperbaiki: jalur native di playGesture
  kini juga memasang `clipUntil` seperti `playEmotionClip()` (konsistensi ownership);
  (c) `getCapabilityProfile().gestures` ditambah entri registry `source:"user"` yang
  `aiEnabled` (satu-satunya titik penyiaran — otomatis sampai ke prompt agent.js:120-128
  dan animate-text agent.js:471-475 tanpa mengubah agent.js).
- Inisialisasi registry saat load model: isi builtin + native (taxonomy) + fetch
  `GET /api/motions?model=<key>`.
- `server.js`: endpoint `GET /api/motions`, `GET/POST/PUT/DELETE /api/motions/:id`
  (validasi ketat payload memakai fungsi validasi yang sama dengan `motion-dsl.js` —
  diekstrak agar bisa dipakai Node; simpan via `queueJsonWrite`).
- Test regresi: seluruh suite lama tetap hijau + `test/test-motion-api.js`
  (roundtrip persist, kolisi ID, payload invalid).

### Fase 3 — Motion Studio UI (minim)
- `index.html`: tab `motion` + markup editor (library list, timeline canvas/div, kontrol
  play/pause/stop/loop/scrub, new/duplicate/rename/delete/save).
- `js/motion-editor.js` (baru, terisolasi — CONSTRAINTS §9): state editor, undo/redo
  stack (SPEC §25, persist hanya saat save eksplisit), preview via runtime.
- `js/app.js`: hanya perekat minimal (buka/tutup tab, sinkron model).
- `css/app.css`: tambahan class bergaya konsisten (tanpa menyentuh rule lama).
- Edit semantik 8 track dulu; Advanced mode (tampilkan parameter hasil resolve) ditunda Fase 4.

### Fase 4 — Metadata editor + kemampuan penuh
Panel metadata (name, description, tags, emotionCompatibility, intensity min/default/max,
cooldown, priority, loop, aiEnabled), advanced mode (role → actual param id via
`state.caps.ids`), degrade-graceful berdasar `hasHeadControl` dll, kontrol intensity live.

### Fase 5 — Integrasi LLM dua format
- `agent.js` (perubahan kecil): `applyActions()` menerima aksi `motion` baru hasil
  normalisasi; `parseSegments()` menambah tipe opsional `[MOTION:id]` — format `[GESTURE:]`
  lama tidak berubah (CONSTRAINTS §7).
- `server.js` `/api/chat` & `/api/animate-text`: validasi motion ID terhadap katalog yang
  dikirim klien (pola sama seperti gesture eksisting server.js:1002-1020); unknown →
  drop + fallback netral. Katalog ringkas (id, description, tags, compatibleEmotions —
  SPEC §19) disuntik ke system prompt melalui jalur capabilities yang sudah ada.

### Fase 6 — ✨ Analyze Motion
Endpoint `POST /api/motions/analyze`: kirim representasi semantik (durasi, track range,
jumlah keyframe — bukan state internal), LLM balas description/tags/emotionCompatibility,
divalidasi & **wajib approval user** sebelum disimpan (pola badge 🤖 + persetujuan ala
sistem sheet; user selalu menang atas ai).

### Fase 7 — Fondasi AI Motion Generation (opsional, tidak memblok)
Prompt→DSL tracks; hasil masuk mode preview editor; approval user; save normal.
Tidak ada endpoint eksekusi langsung dari output LLM.

---

## 3. Urutan File yang Diubah per Fase (ringkas)

| Fase | File baru | File lama disentuh |
|---|---|---|
| 1 | `js/motion-dsl.js`, `js/motion-registry.js`, `js/motion-runtime.js`, 3 test | — |
| 2 | `test/test-motion-api.js` | `server.js` (+4 endpoint), `js/app.js` (routing playGesture, caps.gestures, init registry), `index.html` (1 baris `<script>`) |
| 3 | `js/motion-editor.js`, test editor | `index.html` (tab + markup), `js/app.js` (perekat), `css/app.css` (tambahan) |
| 4 | — | `js/motion-editor.js` |
| 5 | `test/test-motion-llm.js` | `agent.js` (parser+applyActions), `server.js` (validasi) |
| 6 | — | `server.js` (+1 endpoint), `js/motion-editor.js` (tombol ✨) |
| 7 | — | `js/motion-editor.js`, prompt di `agent.js`/server |

## 4. Kriteria Terima (SPEC §32 + CONSTRAINTS §17)
- 993 test lama tetap hijau di setiap fase; suite baru lulus.
- `playGesture("wave_hi")`, preset gerak lama, klip native, sheet v4, format respons LLM lama —
  semuanya bekerja tanpa perubahan perilaku.
- Chat normal tidak pernah butuh Motion Studio terbuka.
- LLM hanya bisa memakai motion ID yang terdaftar; ID asing ditolak runtime & server.

---

## 5. Hasil Implementasi & Penyimpangan dari Rencana

Semua 7 fase selesai. Yang berbeda dari rencana awal, dan alasannya:

### Yang ditambahkan (tidak ada di rencana)
1. **Watchdog timer di Motion Runtime** (`js/motion-runtime.js`).
   `requestAnimationFrame` BERHENTI total di tab background. Tanpa timer cadangan,
   motion yang mulai lalu tab-nya disembunyikan menggantung selamanya: `active`
   tak pernah dibersihkan, delta pose menempel di `state.aiPose`, dan semua motion
   prioritas lebih rendah ditolak sampai tab dibuka lagi. Jalur gesture lama
   memakai `setTimeout` jadi tidak punya masalah ini — jadi ini regresi yang
   tidak boleh dibiarkan. Sekarang rAF + timer 250ms jalan berdampingan.
2. **Prefiks ID untuk preset gerak yang diputar lewat runtime** (`PRESET_MOTION_PREFIX`).
   Awalnya asset ephemeral didaftarkan dengan nama preset polos, yang MENIMPA entri
   registry bernama sama (gesture bawaan berubah `source`/deskripsi, dan sebuah
   preset bisa menimpa Motion Asset user). Registry harus mencerminkan apa yang
   terdaftar, bukan apa yang terakhir diputar.
3. **`[INTENSITY:x]`** sebagai directive terpisah — dibutuhkan agar LLM bisa
   mengatur kekuatan motion tanpa mengarang angka keyframe.
4. **Guard `clipUntil` pada jalur native `playGesture`.** Sebelumnya hanya
   `playEmotionClip()` yang memasangnya, sehingga pose AI yang di-ease bertarung
   dengan klip native saat gesture native diputar (dua penulis satu parameter).

### Yang disederhanakan
- **Advanced mode** tidak jadi editor parameter mentah, hanya tampilan read-only
  peran→parameter. Mengedit parameter mentah akan melanggar SPEC §3 (motion harus
  tetap model-agnostic) — nilainya untuk user adalah memahami pemetaannya, bukan
  mengubahnya.
- **`tracksToSteps()`** dibuat tapi belum dipakai UI. Ada supaya Motion Asset bisa
  diekspor jadi preset `gerak` bila nanti dibutuhkan; tidak diiklankan sebagai fitur.

### Perbaikan test lama (assertion basi, bukan perilaku baru)
Empat assertion menguji NAMA fungsi/teks kode alih-alih perilakunya, dan patah
karena refactor yang tidak mengubah invariannya:
- `test-role-mapping.js`: strip komentar `/\/\/.*$/` gagal pada baris CRLF (`.`
  tak match `\r`), jadi komentar yang sengaja MEMBAHAS `Param91` terbaca sebagai
  pelanggaran. Ditambah `.replace(/\r$/, '')`.
- `test-fase1-sheet-schema.js`: dua assertion mencocokkan teks persis
  `invalidateCapabilityProfile();\n    return merged;`, patah karena pemanggilan
  itu kini dibungkus try/catch. Diganti cek urutan (localStorage sebelum jaringan).
- `test-fase5-paramnotes.js`: `freezeForDrag` sudah lama berganti nama menjadi
  `freezeModelForEdit(statusEl, persistent)`; assertion diperbarui ke nama nyata.
- `test-exp3-adoption.js`: harness men-stage `server.js` ke folder temp, perlu
  ikut menyalin `js/motion-dsl.js` karena server kini me-require-nya.

### Verifikasi end-to-end (browser nyata, model lumine)
Diuji langsung di aplikasi berjalan, bukan hanya unit test: buat gerakan lewat
timeline → simpan (file muncul di `motions/<key>/`) → tampil di katalog LLM
(`capProfile.motionCatalog`) → diputar lewat `playMotion(id, {fromLLM:true})` →
`✨ Analisa AI` mengisi deskripsi/tag/emosi (butuh Simpan) → `🪄 Buat dari Teks`
menghasilkan draft valid → hapus membersihkan file + registry. Gesture lama
(`playGesture('nod')`) tetap jalan dan kini juga lewat runtime; id asing ditolak;
motion prioritas rendah tidak bisa merebut yang tinggi.

---

## 6. Revisi Besar: Semantic Mode → Raw Parameter Mode

Setelah versi pertama dipakai, keterbatasannya jelas: 8 field semantik hanya
menyentuh 8 dari 223 parameter lumine, jadi tangan, rambut, alis, dan aksesoris
tidak bisa dianimasikan sama sekali. Atas permintaan user, **Semantic Mode
dihapus total** (bukan ditambah mode kedua) dan diganti satu mode yang bekerja
langsung pada parameter mentah, seperti timeline Cubism Editor.

### Yang berubah
| Aspek | Sebelum | Sesudah |
|---|---|---|
| Sasaran track | 8 field abstrak (`ax`, `ay`, …) | id parameter rig apa pun (223 di lumine) |
| Nilai | delta ±30 / ±1, diskalakan intensity | ABSOLUT dalam range asli parameter |
| Sumber track | daftar hardcode di editor | `listModelParams()` dari Cubism Core / sheet |
| Panel UI | 8 baris tetap | pencarian + filter kategori atas 223 parameter |
| Easing | per track | **per key** (model Cubism) |
| Cakupan motion | model-agnostic | model-scoped (`sourceModelId`), skip aman di rig lain |
| Batas track | 8 | 48 |

Track peran (`kind: 'role'`) TETAP didukung di DSL dan runtime — gesture bawaan
memakainya, dan motion lama tidak perlu dikonversi di disk. Yang dihapus hanyalah
UI-nya.

### Bug utama yang diperbaiki: preview tidak bergerak
Diagnosisnya bertingkat, dan dua lapis pertama menyesatkan:

1. **Enumerasi parameter salah method.** `listModelParams()` memanggil
   `getParameterIds()` pada objek `CubismModel`, yang tidak punya method itu —
   daftar id sebenarnya ada di typed array `parameters.ids`. Akibatnya panel
   parameter kosong senyap sebelum sheet dimuat.
2. **rAF tidak berjalan di lingkungan uji.** `requestAnimationFrame` di webview
   ini tidak pernah dipanggil (tidak ada compositing), jadi seluruh loop `tick()`
   — termasuk `applyRawDrive()` — tidak jalan sama sekali. Ini bukan hanya artefak
   uji: tab background dan jendela tersembunyi memberi kondisi yang sama pada
   pengguna nyata. Perbaikannya: `setRawDrive()` menulis **langsung** ke model
   selain di-assert ulang tiap frame. Loop tetap diperlukan untuk mempertahankan
   nilai melawan `internalModel.update()`; penulisan langsung memastikan efeknya
   seketika, tanpa jeda 16ms per gerakan slider.
3. **Nilai tidak pulih saat dilepas.** Parameter yang tidak dikemudikan sistem
   lain (pipi, rambut, aksesoris) tidak pernah kembali sendiri, jadi pose
   "nyangkut" di nilai terakhir editor. Ditambah `state.rawDrivePrev`: nilai
   sebelum drive disimpan dan dipulihkan saat param dilepas atau editor ditutup.

Ketiganya sekarang punya assertion di `test/test-motion-raw.js` supaya tidak
kembali secara diam-diam.

### Keputusan desain yang perlu dicatat
- **Intensity tidak menskalakan track param.** Nilai absolut dikalikan 0.3 bukan
  "gerakan lebih halus" — itu pose berbeda, dan pada rig ber-range 10..20 hasilnya
  keluar range. Intensity hanya berlaku untuk track peran.
- **Blend nilai absolut = interpolasi dari nilai awal**, bukan perkalian amplitudo.
  Runtime menyimpan `paramBase` saat motion mulai dan melereng dari sana.
- **Clamp terjadi di titik tulis**, bukan di DSL: hanya `applyRawDrive` di app.js
  yang tahu range rig yang sedang dimuat. DSL cuma menolak non-finite.
- **LLM tetap diberi nama peran, bukan 223 id parameter.** Menyebut id rig ke LLM
  hanya mengundang halusinasi nama; `/api/motions/generate` mengembalikan track
  peran, lalu klien menerjemahkannya ke parameter memakai peta model aktif.
- **`analyze` mengirim label track**, bukan id mentah, karena label yang ditulis
  rigger ("Rambut Depan") punya arti sementara `ParamEX07` tidak.

### Verifikasi end-to-end revisi (browser nyata, lumine)
223 parameter terdaftar dengan 7 kategori; pencarian "cheek" menemukan 2; klik
menambah track dengan key diseed dari nilai live (pose tidak berubah saat track
ditambah); geser slider dan ketik angka langsung mengubah model (0 → 1 → 0.35);
scrub playhead mengikuti kurva (0.35 → 0.406 → 0.773 → 0.988 → 1); easing
`stepped` menahan nilai di tengah segmen lalu `ease-in-out` melunakkannya;
Play memutar lewat runtime dan melepas parameter setelah selesai; menutup studio
memulihkan pose. Motion dengan parameter asing tampil bergaris-coret, label key
memberi peringatan, dan runtime hanya menulis parameter yang ada. Motion semantik
lama otomatis jadi track parameter dengan nilai terproyeksi benar.
