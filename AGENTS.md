# AGENTS.md — Panduan AI Agent untuk repo ini

> **File ini ditulis untuk AI agent** (ZCode, Claude Code, Cursor, dsb.) yang
> mengerjakan kode `live2d-agent`. `README.md` ditulis untuk manusia; file ini
> bersama `docs/` adalah acuan **mengikat** saat mengubah kode.
> Jika dokumen dan kode bertentangan, **kode yang benar — perbaiki dokumennya.**

## Ringkasan proyek

Aplikasi Live2D yang dikendalikan AI: karakter Cubism 4/5 **apa pun** di
`data/model/<nama>/` dianimasikan oleh agent — ngobrol (teks/STT), bergerak
(directive → MotionRuntime), bersuara (TTS multi-provider), proaktif saat idle,
membaca mood dari webcam, dan punya 3 mode (VTuber / Assistant / Pet).
Runtime **Bun**, inti logika **TypeScript** (`src/`, di-bundle ke
`static/js/bundle.js`), engine/UI legacy di `static/js/app.js` (±8.600 baris —
dijaga guard, di-port potongan saat disentuh).

Produk ini juga membawa **agent-nya sendiri** sebagai fitur (loop + 12 tool +
permission gate di `src/server/agent/`) — jangan tertukar: itu kode produk,
bukan instruksi untukmu.

## Urutan baca wajib (mengikat)

| # | Dokumen | Baca sebelum… |
|---|---------|---------------|
| 1 | [`docs/MODEL-AGNOSTIC-RULES.md`](docs/MODEL-AGNOSTIC-RULES.md) | menyentuh **apa pun** yang menyimpulkan makna parameter/role/motion |
| 2 | [`docs/SHEET-SYSTEM.md`](docs/SHEET-SYSTEM.md) | menyentuh sheet, preset, migrasi, atau analisa LLM |
| 3 | [`docs/MOTION-SYSTEM-SPEC.md`](docs/MOTION-SYSTEM-SPEC.md) | menyentuh pipeline motion / Motion Studio |
| 4 | [`docs/MODES.md`](docs/MODES.md) | menyentuh mode, runtime, atau teardown |
| 5 | [`docs/STATUS-CUBISM5-EFEK.md`](docs/STATUS-CUBISM5-EFEK.md) | **awal sesi**: baca entri teratas (handoff sesi sebelumnya) · **akhir sesi**: tambah entri baru |
| 6 | [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | debugging perilaku yang dilaporkan user |

## Perintah & definisi "selesai"

```bash
bun run build          # WAJIB sebelum run — static/js/bundle.js di-gitignore
bun run test           # SEMUA: 260 unit test (bun test) + 512 guard (11 suite)
bun run test:unit      # hanya unit test TS
bun run test:guards    # hanya guard legacy
bunx tsc --noEmit      # type-check (harus bersih)
```

**Selesai** = build bersih + `tsc` bersih + `bun run test` hijau.
Tidak ada test yang memanggil jaringan (endpoint LLM di-stub ke provider
`mock`) dan tidak ada test yang menulis `data/config.json` — pertahankan.

## Aturan inti (ringkasan — detail wajib di dokumen masing-masing)

1. **Model-agnostic.** Tidak ada id bernomor (`Param91`), nama model, atau
   range spesifik di tabel universal; makna tidak boleh diambil dari indeks
   array (`lipSyncIds[0]`); menulis ke parameter **hanya lewat role space**
   (`pokeRoleRef` / `pokeRoleNorm` / `roleDefault`) yang memetakan skala
   referensi ke range model; kemampuan model diukur dari **disk**, bukan hanya
   manifest. → [`docs/MODEL-AGNOSTIC-RULES.md`](docs/MODEL-AGNOSTIC-RULES.md)
2. **Sistem sheet.** `user` > `ai` **mutlak** (re-inspeksi tidak boleh
   menghapus tulisan user); `paramGroups` ≠ `presets` — dua struktur, jangan
   digabung; benturan nama gerak dicegah saat **simpan**; angka hanya dari
   engine (LLM tidak pernah boleh mengirim range).
   → [`docs/SHEET-SYSTEM.md`](docs/SHEET-SYSTEM.md)
3. **Motion.** Satu pipeline: LLM hanya memilih id semantik + properti tingkat
   tinggi — **tidak** boleh menyentuh id param Live2D langsung;
   `motion-dsl` satu-satunya sanitize; runtime satu-satunya pemutar
   (priority + blend + watchdog rAF).
   → [`docs/MOTION-SYSTEM-SPEC.md`](docs/MOTION-SYSTEM-SPEC.md)
4. **Mode.** Satu mode aktif; `POST /api/mode` satu-satunya pintu; pindah mode
   = **teardown dulu** runtime lama (interval/WS/feed/riwayat, client dan
   server) baru menyalakan yang baru; mode non-aktif tidak diproses sama
   sekali. → [`docs/MODES.md`](docs/MODES.md)
5. **Keamanan & privasi.** `data/config.json` tidak pernah disajikan via HTTP;
   bind loopback default; body cap per endpoint; guard path traversal;
   frame webcam / audio mic **tidak pernah** di-upload (inferensi 100% lokal).

## Aturan kerja

- **"Port saat disentuh"** — bagian legacy (`static/js/app.js`) yang perlu
  diubah di-port potongannya ke TS **di commit yang sama** bersama guard-nya.
  Dua area bernilai di-port bila kelak disentuh: sistem sheet
  (`migrateSheet`/`resolvePresets`) dan role mapping (`mapRoles`/`pokeRole*`).
  Chat UI utama (bubble `#chat-log`, quick phrase, dsb. di app.js) tidak
  direncanakan di-port. Panel agent **sudah** di-port ke TS
  (`src/client/agent/panel/`, remake ala ZCode) — `mode-runtime.js` kini hanya
  bridge `window.__agentPanel.start()`; logic panel baru ditulis di TS, bukan
  di legacy JS.
- **Guard legacy menguji kode asli** — fungsi diekstrak dari `app.js` via
  `vm`, bukan salinan. Saat mem-port, guard ikut dikonversi ke bun test,
  bukan dibuang.
- **Invariansi nama** — logika penyimpulan makna harus tetap benar setelah
  semua nama diganti (`m_001`, hash, bahasa lain). Guard sudah menguji ini
  (role-mapping); kalau menambah logika baru, uji ulang dengan nama yang
  diganti — bila distribusi hasilnya kolaps, logikanya masih bergantung nama.
- **i18n** — string UI baru wajib ada di **kedua** kamus (`src/client/i18n/`,
  id + en); parity & coverage dijaga `test/i18n.test.ts`. Kosakata directive
  (`[EMOTION:]` dst.) tetap Indonesia — itu protokol antar-komponen.
- **Bahasa kerja** — komentar kode, commit, dan dokumen: Indonesia. Pesan
  commit gaya conventional + deskripsi Indonesia (lihat `git log`):
  `feat(ui): …`, `fix(server): …`, `docs: …`, `test: …`, `refactor: …`,
  `chore: …`.

## Jebakan yang sering terjadi

- Lupa `bun run build` → `window.__agent` tidak terpasang → chat **diam-diam**
  (engine degrade gracefully, bukan crash).
- Hardcode `127.0.0.1:8310` → pakai `location.origin` (frontend) / `appRoot()`
  (`src/shared/paths.ts` — akar app dev vs exe compile).
- Menulis angka literal ke param role (bypass skala) → gagal senyap, karakter
  datar; rig `eyeOpen` 0..100 menerima nilai `1` sebagai 1% terbuka.
- Timeout absolut pada LLM streaming → pakai **idle timeout** (reset per chunk)
  saat `conn.stream=true`.
- Thinking model (mis. gemini-2.5) memakan budget output untuk reasoning →
  JSON terpotong; gunakan `salvageJSONArrayOfObjects` + warning eksplisit.
- Sheet di disk adalah **cache scan**, bukan sumber kebenaran — kalau logika
  role-mapping berubah, sheet lama basi dan perlu re-scan.

## Peta kode

```text
src/server/index.ts          Bun.serve (loopback default) — 40+ route API + static
src/server/{vtuber,assistant,pet}.ts   runtime 3 mode (satu aktif)
src/server/agent/            loop, plan, bus, memory, subagent, tools/ (12 tool)
src/server/persona/          persona narrator
src/shared/                  types, config, llm-client (role routing), paths
src/client/animation/        easing, motion-dsl, motion-registry, motion-runtime
src/client/engine/           motion-taxonomy (klasifikasi klip .motion3.json)
src/client/agent/            brain + directive-parser → window.__agent
src/client/agent/panel/      panel agent (remake ala ZCode): stream/transcript/
                             actor/view/panel → window.__agentPanel
src/client/i18n/             core i18n zero-dep + kamus id/en
src/build.ts                 bundle-entry → static/js/bundle.js (IIFE)
src/dist.ts                  bun run dist — rakit dist/Live2D-Agent/ (exe + static)
src/cli/agent.ts             bun run agent — REPL Assistant di terminal
agent-shell/                 cangkang Tauri (Rust) — jendela utama, pet, sidecar
static/js/app.js             engine/UI legacy (±8.600 baris) — dijaga guard
static/js/mode-runtime.js    switcher mode — panel assistant tinggal bridge
                             window.__agentPanel
static/js/{voice-input,emotion-overlay,motion-editor,camera-presence}.js
test/                        bun test (unit) — termasuk server-parity & integration
test/legacy/                 guard legacy — 512 assertion, 11 suite
data/                        data user — TIDAK di-commit
```

## Jangan

- ❌ Commit `data/` (model berlisensi, `config.json` berisi apiKey, sheet
  user, `.agent-memory/`) atau output build (`static/js/bundle.js`,
  `static/js/i18n.js`) — semuanya di-gitignore, jangan dipaksa masuk.
- ❌ Menyetel parameter hanya untuk model yang sedang dites.
- ❌ Menambah regex/id khusus satu model (begitulah 7 pola khusus Ichika
  dulu menyusup).
- ❌ Menggabungkan `paramGroups` dan `presets` jadi satu.
- ❌ Melewatkan teardown saat pindah mode.
- ❌ Mengirim frame webcam / audio mic ke server atau provider mana pun.
- ❌ Memperbaiki balik aturan yang terkunci di `docs/` — kalaupun kelihatan
  seperti bisa disederhanakan, itu sudah dibalik orang dan punya alasan.
