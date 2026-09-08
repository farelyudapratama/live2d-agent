# STATUS SESI — Dukungan Cubism 5 & Efek Model (Handoff)

> Dokumen handoff sesi kerja. Tulis ulang/tambah sesuai perkembangan; jangan
> hapus keputusan yang masih berlaku. Kode yang dirujuk: sudah ter-commit di
> master (lihat daftar commit di bawah).

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
