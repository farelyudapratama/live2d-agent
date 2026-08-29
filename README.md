# 🎭 Live2D Agent v2

Rewrite **Live2D Cubism 4** dari [`live2d-agent`](../live2d-agent/) — runtime **Bun** (zero-dep), arsitektur modular, TypeScript di bagian yang paling penting.

> **Status rewrite — hybrid, bukan total.** Yang di-rewrite penuh ke TS: **server** (1.945 baris JS → 1.234 baris TS), **otak agent** (840 → 970), dan **motion core** (856 → 734). Layer **engine/UI** (`static/js/app.js` + motion-editor + camera-presence + taxonomy, ±8.200 baris) **sengaja dipertahankan identik dengan v1** — keputusan manajemen risiko: kode itu jalan dan mengubahnya tanpa untung fungsional hanya menambah risiko regresi. Lihat tabel lengkap di [§ Status Rewrite](#-status-rewrite).
>
> **Model-agnostic:** jalan dengan model Cubism 4 **apa pun** di `data/model/<nama>/`. Aturan mengikat: [`docs/MODEL-AGNOSTIC-RULES.md`](docs/MODEL-AGNOSTIC-RULES.md).
>
> **Paritas v1 terverifikasi** — 27 route API + OPTIONS (`server.js` v1), seluruh perilaku otak `agent.js` (prompt, directive, inferensi gerak dari emosi, jitter, arbitrase motion/gesture, lockAI, timing TTS, quietMs live dari config), dan prompt LLM versi lengkap. Bridge `window.*` antara bundle TS dan engine legacy lengkap: `app.js` maupun `motion-editor.js` tidak memanggil satu pun global yang tidak dipasang bundle.

## 🚀 Cara Menjalankan

```bash
cd live2d-agent-v2
bun run build                # WAJIB untuk clone baru — static/js/bundle.js di-gitignore
bun run src/server/index.ts  # default http://127.0.0.1:8310
PORT=9000 bun run src/server/index.ts   # port lain — frontend ikut location.origin
HOST=0.0.0.0 bun run src/server/index.ts  # ekspos ke LAN (default loopback!)
# atau klik start.bat (Windows — otomatis build dulu, lalu start server)
```

`bun run dev` = alias `bun run src/server/index.ts` · `bun run build` = `bun run src/build.ts` → `static/js/bundle.js`. **Lewati `bun run build` dan aplikasi jalan tapi tanpa otak**: chat mati diam-diam karena `window.__agent` tidak ada (engine legacy degrade gracefully, bukan crash). `bun install` hanya perlu untuk `bun test` / `tsc` (devDep `bun-types`) — server dan build tidak butuh node_modules. `PORT` dihormati, `location.origin` dipakai frontend jadi LAN/https jalan tanpa ubah kode.

## 📊 Status Rewrite

| Lapisan | v1 | v2 | Status |
|---|---|---|---|
| Server (API, LLM proxy, static, upload) | `server.js` 1.945 baris | `src/server/index.ts` (729) + `src/shared/{config,llm-client,types}.ts` (505) | ✅ rewrite TS penuh |
| Otak agent (prompt, directive, proaktif) | `agent.js` 840 baris | `src/client/agent/{brain,directive-parser}.ts` (970) | ✅ rewrite TS penuh |
| Motion core (DSL, registry, runtime, easing) | `js/motion-{dsl,registry,runtime}.js` 856 baris | `src/client/animation/*.ts` (734) → bundle | ✅ rewrite TS penuh |
| Motion taxonomy | `js/motion-taxonomy.js` 555 baris | `src/client/engine/motion-taxonomy.ts` (tahap 2 dimulai) | ✅ port TS (dipakai server & bundle) |
| Engine/UI (render loop, chat, panel, sheet) | `js/app.js` 6.339 baris | `static/js/app.js` **identik isinya** (beda line-ending saja) | ⬜ legacy by design |
| Motion Studio UI | `js/motion-editor.js` 1.101 baris | `static/js/motion-editor.js` identik | ⬜ legacy by design |
| Webcam presence | `js/camera-presence.js` 216 baris | `static/js/camera-presence.js` identik | ⬜ legacy by design |

Kenapa hybrid: TS port fokus ke logika yang punya test dan berisiko salah port (server, otak, motion, taxonomy). UI dipertahankan byte-faithful supaya paritas bisa diverifikasi dengan `diff` — dan sistem bridge `window.*` membuat keduanya satu aplikasi, bukan dua sistem.

**Titik berhenti rewrite (keputusan final):** rewrite dinyatakan selesai — bukan karena semua baris sudah TS, tapi karena nilai porting selanjutnya sudah mengendap. Sisa legacy mengikuti aturan **"port saat disentuh"**: bagian yang perlu diubah suatu hari di-port potongannya di commit yang sama dengan perubahannya, bersama guard-nya. Dua area logika yang bernilai port bila kelak disentuh: **sistem sheet** (`migrateSheet`/`resolvePresets` — guard 220 assertion siap di `test/legacy/`) dan **role mapping + inspect model** (`mapRoles`/`pokeRole*` — guard 84 assertion). Chat UI/panel DOM di `app.js`, `motion-editor.js`, dan `camera-presence.js` **sengaja tidak** direncanakan port (lihat `docs/UI-CONSTRAINTS.md`). Pekerjaan berikutnya yang benar-benar menambah nilai adalah fitur, bukan refactor: **STT 2 arah** dan **lip-sync presisi dari audio** (⬜ di tabel Fitur).

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
| STT mic (ngobrol 2 arah) | ⬜ | belum ada di v1, belum ada di v2 |
| Lip-sync presisi (dari audio) | ⬜ | masih timer-osilasi di kedua versi |

### Interaksi
- **Gerak mouse** → mata + kepala + badan ikut · **Drag** → geser posisi · **Scroll** → zoom · **Double-click** → reset framing

## 🧠 Arsitektur

```
src/server/index.ts        # Bun.serve (loopback default) — 27 route API + static
src/shared/{types,config,llm-client}.ts
src/client/animation/{easing,motion-dsl,motion-registry,motion-runtime}.ts  # → bundle.js
src/client/engine/motion-taxonomy.ts   # klasifikasi klip native — server & bundle
src/client/agent/{directive-parser,brain}.ts   # otak agent → window.__agent
src/build.ts               # bundle-entry.ts → static/js/bundle.js (IIFE, dimuat SEBELUM app.js)
static/{index.html,css/app.css,js/app.js}      # engine/UI legacy (identik v1, punya render loop)
static/js/{bundle.js,motion-editor.js,camera-presence.js}
data/{config.json,sheets/,motions/,model/}     # data user — TIDAK disajikan sembarangan
docs/                      # panduan mengikat (lihat bawah)
```

Urutan muat `index.html`: **`bundle.js`** (Taxonomy+DSL+Registry+Runtime+brain) → `app.js` → `motion-editor.js` → `camera-presence.js`. `bundle-entry.ts` memasang `window.MotionTaxonomy / MotionDSL / MotionRegistry / MotionRuntime / __agent`; `app.js` mengonsumsinya persis seperti dulu mengonsumsi script v1 yang kini sudah seluruhnya diganti TS.

LLM: `browser → POST /api/chat → llmWithFallback (active dulu, cooldown, fallback) → provider → reply → parseSegments → animateTextViaDirector (POST /api/animate-text) → MotionRuntime`.

Motion: `Motion Asset → Registry (builtin + native + user) → Runtime (priority+blend+watchdog rAF) → Live2D`.

## 🔒 Keamanan

- `data/config.json` (apiKey plaintext) **tidak pernah disajikan** lewat HTTP statis — 403. Di v1, `config.json` root bisa di-GET siapa pun yang buka server.
- Path traversal (`../`) → 403; default bind **loopback** (`HOST=0.0.0.0` untuk LAN — sadari semua orang di jaringan bisa membaca server).
- Body cap per endpoint (413): sheet 5 MB, upload 200 MB, import-zip 500 MB, lainnya 1 MB.
- `/api/*` tak dikenal → 404 JSON, bukan SPA fallback.
- `data/` di luar folder model tidak bisa disentuh endpoint model (guard `startsWith` + pemisah direktori).

## 📦 Migrasi dari v1

Copy `live2d-agent/config.json` → `data/config.json` (contoh: `config.example.json`), `model/*` → `data/model/`, `sheets/*` → `data/sheets/`, `motions/*` → `data/motions/`. Format file identik — tidak ada konversi. Model bawaan `神宫白子` + `lumine` sudah ada di `data/model/`.

## ⚠️ Divergensi yang diketahui vs v1

Port ini bukan byte-identik; hal-hal berikut berbeda secara **sengaja**:

1. **Keamanan lebih ketat**: blokir `config.json`, tutup traversal, body cap, bind loopback — v1 menyajikan seluruh repo root (apiKey kebaca via HTTP!).
2. **Bug v1 diperbaiki**: `llmWithFallback` v1 me-reset `activeId` ke koneksi pertama di setiap panggilan LLM; v2 mempertahankannya. Reply kosong/error kini juga tampil sebagai bubble chat.
3. **SPA fallback dipersempit**: path statis tanpa ekstensi → `index.html` 200 (rute UI), tetapi asset `.js`/`.css`/model yang missing → 404 yang jelas, bukan HTML ber-extension js (v1: fallback tanpa syarat).
4. **`motion-dsl.ts` kanonik persis v1**: nama gaya SPEC (`angleX`, `eyeX`, …) diterima lalu **dikanoniskan** ke `ax/ay/ex/ey` saat sanitize — format file selalu satu kosakata dan file motion v2 tetap terbaca runtime v1. (`normalizeTarget` mengunci ini.)

Catatan QA: `bun test` memanggil dispatcher langsung — endpoint yang menyentuh LLM di-stub ke provider `mock`, jadi suite tidak pernah melakukan panggilan jaringan dan tidak pernah menulis `data/config.json`.

## 🧪 Test

```bash
bun run test         # SEMUA: 140 unit test (bun test) + 381 guard legacy (5 suite)
bun run test:unit    # hanya unit test TS (parser, DSL/registry/taxonomy, dispatcher server)
bun run test:guards  # hanya guard legacy
bun run build && bunx tsc --noEmit   # build + type-check (keduanya bersih)
```

Guard legacy (`test/legacy/`) adalah port dari suite v1 paling bernilai: role-mapping & param-scaling (model-agnostic), sheet schema v4 (220 assertion, mengekstrak `migrateSheet()` dari `app.js` asli via `vm`), exp3-adoption (endpoint diuji in-process via `handleAPI` dengan model sintetis yang dihapus otomatis), api-origin. Tidak ada guard yang memanggil jaringan. Suite taxonomy v1 sudah **lulus** — konversinya kini `test/motion-taxonomy.test.ts` yang mengimpor modul TS langsung. Suite yang belum dipindah: motion-dsl/registry/runtime v1 — file `js/motion-*.js` sudah tidak ada di v2 (DSL/registry terkunci test TS; runtime guard menyusul). Saat `app.js` di-port ke TS, guard-guard ini dikonversi ke bun test bersama modulnya — bukan dibuang.

## 📚 Dokumentasi (lokal, mengikat)

| File | Isi |
|---|---|
| [`docs/MODEL-AGNOSTIC-RULES.md`](docs/MODEL-AGNOSTIC-RULES.md) | Aturan model-agnostic — kenapa & bagaimana tetap tidak meng-hardcode |
| [`docs/UI-CONSTRAINTS.md`](docs/UI-CONSTRAINTS.md) | Pagar UI: apa yang TIDAK boleh diubah saat menambah fitur |
| [`docs/SHEET-SYSTEM.md`](docs/SHEET-SYSTEM.md) | Sistem sheet, 4 aturan terkunci, adopsi `.exp3`, keputusan agen reaktif |
| [`docs/MOTION-SYSTEM-SPEC.md`](docs/MOTION-SYSTEM-SPEC.md) | Spesifikasi Motion Studio + pipeline gerak (satu pipeline, prioritas, validasi) |

Dokumen historis (rencana kerja yang sudah terektusi): `../live2d-agent/docs/PLAN-BESOK-ALIVE.md`, `PLAN-MOTION-STUDIO.md`.

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
