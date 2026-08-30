# 🎭 Live2D Agent

Karakter Live2D (Cubism 4) yang dikendalikan AI — ngobrol lewat teks atau suara, karakter menjawab dengan gerak, ekspresi, dan suara (TTS), dan tetap hidup saat kamu diam: bicara sendiri saat idle, menyapa saat kamu pergi/balik, membaca mood dari webcam. Runtime **Bun** (zero-dep), inti logika **TypeScript**.

> **Repo ini adalah proyek utama — satu-satunya yang dikembangkan.** `../deprecated-live2d-agent/` adalah arsip versi lama: jangan mengembangkan atau menaruh data di sana; pakai hanya sebagai referensi historis.
>
> **Model-agnostic:** jalan dengan model Cubism 4 **apa pun** di `data/model/<nama>/`. Aturan mengikat: [`docs/MODEL-AGNOSTIC-RULES.md`](docs/MODEL-AGNOSTIC-RULES.md).

## 🚀 Cara Menjalankan

```bash
cd live2d-agent
bun run build                # WAJIB untuk clone baru — static/js/bundle.js di-gitignore
bun run src/server/index.ts  # default http://127.0.0.1:8310
PORT=9000 bun run src/server/index.ts   # port lain — frontend ikut location.origin
HOST=0.0.0.0 bun run src/server/index.ts  # ekspos ke LAN (default loopback!)
# atau klik start.bat (Windows — otomatis build dulu, lalu start server)
```

`bun run dev` = alias `bun run src/server/index.ts` · `bun run build` = `bun run src/build.ts` → `static/js/bundle.js`. **Lewati `bun run build` dan aplikasi jalan tapi tanpa otak**: chat mati diam-diam karena `window.__agent` tidak ada (engine degrade gracefully, bukan crash). `bun install` hanya perlu untuk `bun test` / `tsc` (devDep `bun-types`) — server dan build tidak butuh node_modules. `PORT` dihormati, `location.origin` dipakai frontend jadi LAN/https jalan tanpa ubah kode.

**Clone baru (tanpa model)?** `data/model/` kosong karena aset berlisensi tidak di-commit — aplikasi tetap terbuka dengan **layar impor**: klik 📂 pilih folder model atau 🗜️ impor `.zip` (bisa juga copy manual ke `data/model/`). Model terakhir yang dibuka **diingat otomatis** dan dimuat lagi saat berikutnya; menghapus model dari UI **tidak** menghapus sheet/preset/motion buatanmu — impor ulang model dengan nama sama dan semuanya tersambung kembali. Sheet karakter juga **tidak ikut repo** (privasi): dibuat ulang lewat 🔍 Inspeksi Model, tapi preset & catatan yang kamu tulis hanya hidup di mesin tempat kamu mengetiknya — backup manual `data/sheets/` sebelum pindah mesin.

## 🧩 Arsitektur

Satu aplikasi dengan dua lapisan yang saling menopang: **inti logika di TypeScript** (punya unit test), **engine/UI legacy di `static/js/`** (sudah teruji jalan, dijaga guard). Kode TS client di-bundle `src/build.ts` → `static/js/bundle.js` (IIFE), dimuat **sebelum** `app.js`, dan memasang bridge `window.MotionTaxonomy / MotionDSL / MotionRegistry / MotionRuntime / __agent` — engine legacy mengonsumsi global itu, `app.js` tetap pemilik render loop, pemuatan model, dan UI.

| Lapisan | Lokasi | Karakter |
|---|---|---|
| Server — 27 route API, LLM proxy, static, upload | `src/server/index.ts` + `src/shared/{config,llm-client,types}.ts` | TS penuh, teruji unit |
| Otak agent — prompt, directive, proaktif | `src/client/agent/{brain,directive-parser}.ts` | TS penuh, teruji unit |
| Motion core — DSL, registry, runtime, easing | `src/client/animation/*.ts` | TS penuh, teruji unit |
| Motion taxonomy — klasifikasi klip native | `src/client/engine/motion-taxonomy.ts` | TS — dipakai server & bundle |
| Engine/UI — render loop, chat, panel, sheet, role mapping | `static/js/app.js` (±6.300 baris) | **legacy** — dijaga guard |
| Motion Studio UI | `static/js/motion-editor.js` | legacy — terisolasi |
| Webcam presence | `static/js/camera-presence.js` | legacy — terisolasi |
| STT push-to-talk | `static/js/voice-input.js` | modul ES mandiri |

**Aturan kontribusi — "port saat disentuh":** bagian legacy yang perlu diubah suatu hari di-port potongannya di commit yang sama dengan perubahannya, bersama guard-nya. Dua area logika yang paling bernilai di-port bila kelak disentuh: **sistem sheet** (`migrateSheet`/`resolvePresets` — guard 220 assertion siap di `test/legacy/`) dan **role mapping + inspect model** (`mapRoles`/`pokeRole*` — guard 84 assertion). Chat UI/panel DOM tidak direncanakan di-port.

```
src/server/index.ts        # Bun.serve (loopback default) — 27 route API + static
src/shared/{types,config,llm-client}.ts
src/client/animation/{easing,motion-dsl,motion-registry,motion-runtime}.ts  # → bundle.js
src/client/engine/motion-taxonomy.ts   # klasifikasi klip native — server & bundle
src/client/agent/{directive-parser,brain}.ts   # otak agent → window.__agent
src/build.ts               # bundle-entry.ts → static/js/bundle.js (IIFE, dimuat SEBELUM app.js)
static/{index.html,css/app.css,js/app.js}      # engine/UI legacy (punya render loop)
static/js/{bundle.js,motion-editor.js,camera-presence.js,voice-input.js}
data/{config.json,sheets/,motions/,model/}     # data user — TIDAK disajikan sembarangan
docs/                      # panduan mengikat (lihat bawah)
```

Urutan muat `index.html`: **`bundle.js`** (Taxonomy+DSL+Registry+Runtime+brain) → `app.js` → `motion-editor.js` → `camera-presence.js` → `voice-input.js`.

LLM: `browser → POST /api/chat → llmWithFallback (active dulu, cooldown, fallback) → provider → reply → parseSegments → animateTextViaDirector (POST /api/animate-text) → MotionRuntime`.

Motion: `Motion Asset → Registry (builtin + native + user) → Runtime (priority+blend+watchdog rAF) → Live2D`.

## 🎮 Fitur & Status

| Fitur | Status | Catatan |
|-------|--------|---------|
| Viewer Live2D | ✅ | `data/model/<nama>/` apa pun, CJK `神宫白子` OK |
| Sheet per model (schema v4) | ✅ | `GET/POST /api/sheet` + `queueJsonWrite` atomic — aturan terkunci: [`docs/SHEET-SYSTEM.md`](docs/SHEET-SYSTEM.md) |
| Preset 4 kategori | ✅ | `emosi`/`properti`/`aksesoris`/`gerak`, user > AI |
| Analisa sheet oleh LLM | ✅ | `POST /api/model/analyze-sheet` (clamp & dedup ketat) |
| Adopsi `.exp3` tak terdaftar | ✅ | `discoverExpressions` + opt-out per file |
| Injeksi gerak LLM | ✅ | `[EMOTION:] [GESTURE:] [MOTION:] [INTENSITY:] [ACC:] [PROP:] [HEAD:] [EYES:] [MOUTH:] [BODY:]` |
| Pose dari emosi tanpa directive | ✅ | `inferMovementFromEmotion` + jitter ±2.5°, scaled ke range param model |
| Arbitrase motion/gesture | ✅ | `[MOTION:]` prioritas 80; gagal → jatuh ke gesture; tidak pernah keduanya |
| `lockAI()/unlockAI()` | ✅ | fidget & interaksi dibekukan selama playback segmen |
| Timing segmen ikut TTS | ✅ | segmen berikut mulai saat TTS segmen ini selesai (+180 ms) |
| Agent proaktif | ✅ | `idle/away/return/mood` + panel **🎚️ Kelakuan** — `quietMs` dibaca LIVE dari config |
| Mood via webcam | ✅ | opt-in, inferensi lokal `transformers.js` — frame tidak di-upload |
| Mouse-follow | ✅ | mata + kepala + badan |
| TTS proxy | ✅ | `POST /api/tts` → Gradio |
| Otak LLM (multi-provider + fallback) | ✅ | `openai-compatible/gemini/groq/openai/anthropic/mock` + 13 `ERROR_RULES` di `src/shared/llm-client.ts` |
| Indikator hidup | ✅ | presence/mood/quiet |
| Motion Studio (editor keyframe per param) | ✅ | `static/js/motion-editor.js` + `POST /api/motions` (sanitize via `motion-dsl`) — spec: [`docs/MOTION-SYSTEM-SPEC.md`](docs/MOTION-SYSTEM-SPEC.md) |
| Motion Registry + Runtime | ✅ | 3 sumber (builtin 9 gesture + native .motion3 + user), priority+cooldown+blending |
| Motion dipakai AI | ✅ | `[MOTION:id]` divalidasi runtime & server |
| ✨ Analisa AI motion | ✅ | `POST /api/motions/analyze` — butuh persetujuan user |
| 🪄 Buat motion dari teks | ✅ | `POST /api/motions/generate` — draft, di-preview lalu disetujui |
| 🎤 STT mic (ngobrol 2 arah) | ✅ | push-to-talk — Whisper lokal di browser (transformers.js); audio tidak pernah di-upload |
| Lip-sync presisi (dari audio) | ⬜ | masih timer-osilasi |

### Interaksi
- **Gerak mouse** → mata + kepala + badan ikut · **Drag** → geser posisi · **Scroll** → zoom · **Double-click** → reset framing

### 🎤 Ngobrol 2 arah (STT)
Klik **🎤** di panel chat → bicara → berhenti otomatis saat senyap (atau klik lagi) → teks masuk chat dan terkirim. Push-to-talk murni: **tidak ada perekaman latar**, dan memulai rekam **ditolak saat karakter sedang bicara TTS** (anti-echo — kalau tidak, dia mengobrol dengan dirinya sendiri). Inferensi 100% lokal di browser; audio tidak pernah di-upload. Model Whisper diunduh dari CDN **saat pertama dipakai** (butuh internet sekali, lalu ter-cache browser): default `Xenova/whisper-base` — untuk bahasa Indonesia yang lebih akurat ganti `stt.model` ke `Xenova/whisper-small` di `data/config.json` (lebih besar, ±250 MB). `stt.autoSend: false` bila mau review teks sebelum kirim. Bagian murni (RMS, resampler 16 kHz, auto-stop) diuji di `test/voice-input.test.ts`.

Catatan arsitektur: fitur ini butuh **nol perubahan `app.js`** — semua hook yang dibutuhkan sudah disiapkan (`#btn-mic` yang dulu disabled, `window.__l2dDebug.state.talking`, kirim via klik `#btn-bubble`).

## 🔒 Keamanan

- `data/config.json` (apiKey plaintext) **tidak pernah disajikan** lewat HTTP statis — 403.
- Path traversal (`../`) → 403; default bind **loopback** (`HOST=0.0.0.0` untuk LAN — sadari semua orang di jaringan bisa membaca server).
- Body cap per endpoint (413): sheet 5 MB, upload 200 MB, import-zip 500 MB, lainnya 1 MB.
- `/api/*` tak dikenal → 404 JSON, bukan SPA fallback.
- `data/` di luar folder model tidak bisa disentuh endpoint model (guard `startsWith` + pemisah direktori).
- Privasi sensor: inferensi kamera & STT **100% lokal di browser** (transformers.js) — frame/audio tidak pernah di-upload.

## 🧭 Keputusan desain yang disengaja

1. **Keamanan di atas kenyamanan** — apiKey tidak pernah keluar via HTTP, bind loopback default, body cap per endpoint, asset sensitif diblokir.
2. **`llmWithFallback` mempertahankan koneksi aktif** antar panggilan; reply kosong/error tetap tampil sebagai bubble chat — kegagalan terlihat, tidak diam.
3. **SPA fallback dipersempit** — path tanpa ekstensi → `index.html` 200 (rute UI), tetapi asset `.js`/`.css`/model yang missing → 404 yang jelas, bukan HTML ber-extension js.
4. **Satu kosakata target motion** — nama gaya SPEC (`angleX`, `eyeX`, …) diterima lalu **dikanoniskan** ke `ax/ay/ex/ey` saat sanitize (`normalizeTarget`), jadi format file motion selalu satu kosakata.

## 📦 Impor data dari versi lama

Copy `deprecated-live2d-agent/config.json` → `data/config.json` (contoh: `config.example.json`), `model/*` → `data/model/`, `sheets/*` → `data/sheets/`, `motions/*` → `data/motions/`. Format file identik — tidak ada konversi. Model bawaan `神宫白子` + `lumine` sudah ada di `data/model/`.

## 🧪 Test

```bash
bun run test         # SEMUA: 152 unit test (bun test) + 381 guard legacy (5 suite)
bun run test:unit    # hanya unit test TS (parser, DSL/registry/taxonomy, dispatcher server, voice-input)
bun run test:guards  # hanya guard legacy
bun run build && bunx tsc --noEmit   # build + type-check (keduanya bersih)
```

Guard legacy (`test/legacy/`) menguji **fungsi asli yang jalan di aplikasi**, bukan salinan: role-mapping & param-scaling (uji invariansi penggantian nama — jantung aturan model-agnostic), sheet schema v4 (220 assertion, mengekstrak `migrateSheet()` dari `app.js` asli via `vm`), exp3-adoption (endpoint diuji in-process dengan model sintetis yang dihapus otomatis), api-origin. Tidak ada test yang memanggil jaringan. `bun test` men-stub endpoint yang menyentuh LLM ke provider `mock` — suite tidak pernah melakukan panggilan jaringan dan tidak pernah menulis `data/config.json`.

## 📚 Dokumentasi (lokal, mengikat)

| File | Isi |
|---|---|
| [`docs/MODEL-AGNOSTIC-RULES.md`](docs/MODEL-AGNOSTIC-RULES.md) | Aturan model-agnostic — kenapa & bagaimana tetap tidak meng-hardcode |
| [`docs/SHEET-SYSTEM.md`](docs/SHEET-SYSTEM.md) | Sistem sheet, 4 aturan terkunci, adopsi `.exp3`, keputusan agen reaktif |
| [`docs/MOTION-SYSTEM-SPEC.md`](docs/MOTION-SYSTEM-SPEC.md) | Spesifikasi Motion Studio + pipeline gerak (satu pipeline, prioritas, validasi) |

Dokumen historis (arsip repo lama): `../deprecated-live2d-agent/docs/PLAN-BESOK-ALIVE.md`, `PLAN-MOTION-STUDIO.md`.

## 🔧 Troubleshooting

- **Chat diam total?** Belum `bun run build` — `static/js/bundle.js` tidak ada (di-gitignore), jadi `window.__agent` tidak terpasang. Jalankan build, refresh.
- **Diam 30 menit?** Tab ⚙️ AI → **🎚️ Kelakuan** → **⚡ Hidup** → Simpan. Otak membaca `quietMs` langsung dari `window.__appEvents` (live, tanpa restart).
- **0 emosi?** Console `[exp3] adopted N` — kalau 0, model memang tanpa `.exp3`; bikin preset `emosi` di tab Sheet.
- **Fetch gagal?** Cek `location.origin` — jangan hardcode `127.0.0.1:8310`.
- **Model CJK 404?** `safeJoin` decode `%E7%A5%9E` → `神宫白子` di-handle `src/server/index.ts`.
- **413 saat upload?** Body melebihi cap endpoint (sheet 5 MB, upload 200 MB, import-zip 500 MB).
- **Akses dari HP/LAN?** `HOST=0.0.0.0` — sadari semua orang di jaringan bisa membaca server.
- **Model blank di headless?** Normal — swiftshader tidak render WebGL ke framebuffer; model tetap load (console `[Live2D] Model loaded`).

## ⚠️ Model assets

`data/model/` **tidak di-commit** (binary berlisensi). Letakkan model Cubism 4 sendiri di `data/model/<nama>/<file>.model3.json`. Model v4 kompatibel dengan runtime Cubism 5 (jangan buka & re-save di Editor v5 kalau mau balik v4).
