# docs/MODES.md — Sistem 3 Mode (VTuber / Assistant / Pet)

Dokumen mengikat untuk arsitektur mode. Aturan di sini menopang UI baru tanpa
membongkar inti lama.

## Aturan inti (terkunci)

1. **Satu mode aktif.** `POST /api/mode {mode}` satu-satunya pintu pindah mode.
   Mode yang sah: `stage` (default) / `vtuber` / `assistant` / `pet`.
2. **Pindah mode = teardown dulu.** `handleModePost` memanggil `teardownMode(modeLama)`
   **sebelum** mengaktifkan mode baru: vtuber → `vtuberStop()` (WS/interval server),
   assistant → `assistantStop()` (riwayat & approval dibuang), pet → `petClose()`
   (jendela overlay ditutup). Client melakukan hal yang sama di
   `static/js/mode-runtime.js` (`destroyFn()` + `clearInterval(pollTimer)`).
3. **Mode non-aktif tidak diproses sama sekali** — tidak ada polling, tidak ada
   interval, tidak ada feed yang berjalan di latar.
4. Status gabungan selalu bisa dibaca: `GET /api/mode` →
   `{active, vtuber, assistant, pet}`.

## Shell 3 kolom (2026-09-07)

Layout app ala coding-agent: `[activity bar 56px][rail projek 240px toggle][stage flex:1][side panel 372px/600px]`.

- **Activity bar** (`<nav id="activity">`): switcher mode vertikal — id
  `mode-switch` + tombol `data-mode` DIPERTAHANKAN agar wiring
  `mode-runtime.js` tak berubah; tombol projek membuka rail.
- **Rail projek** (`#projek-rail`, dibangun `src/client/shell/projek.ts` →
  `window.__shellProjek`): indikator project (basename workdir) + riwayat
  sesi assistant (lihat seksi Multi-session). Panel control drawer
  (`#controls-panel`) & popup lain tetap fixed/float di atas semua ini.
- **Stage** sizing otomatis (`stageSize()` membaca `#stage.clientWidth` —
  tidak ada aritmetika lebar sidebar di mana pun).
- **Side panel** = `#sidebar` (id dipertahankan); `agent-wide` (600px) tetap
  disetel mode-runtime saat mode assistant.
- Breakpoint `<1024px`: activity bar jadi baris horizontal, rail projek
  full-width, sidebar bottom-sheet.

## Multi-session assistant (2026-09-07)

Riwayat sesi bernama di `data/assistant-sessions.json`
(`{active, sessions: [{id, name, workDir, ts, messages}]}`, cap 20 sesi,
migrasi sekali dari `assistant-history.json` lama + arsip `.bak`):

- Store: `src/server/agent/sessions.ts` (`makeSessionsStore(appRoot)` —
  path injectable untuk test). Auto-nama sesi = pesan user pertama
  (40 char), fallback tanggal. Tulis atomic tmp→rename.
- API: `GET /api/assistant/sessions`, `POST /api/assistant/sessions/new
  {workDir?}`, `POST /api/assistant/sessions/switch {id}`,
  `POST /api/assistant/sessions/delete {id}` — semua menolak saat `busy`
  (409/404 sesuai kasus).
- **Pindah sesi TIDAK mematikan runtime** (kontrak mode utuh): facade
  mengganti `rt.history`/`rt.workDir`/`rt.sessionId` lalu persist. Panel
  menangkap event DOM `agent:session-changed` (dilempar `projek.ts`) dan
  hydrate ulang transcript dari `/history`.
- `loadSession`/`saveSession` (state.ts) kini wrapper store — CLI
  `bun run agent` ikut membuka sesi aktif tanpa perubahan.

## AI VTuber (`src/server/vtuber.ts`)

| Provider | Kredensial | Sumber event |
|---|---|---|
| `mock` | tidak perlu | interval 6 dtk: chat acak; setiap ke-5 donasi |
| `twitch` | nama channel (token opsional — anonim `justinfan`) | IRC `wss://irc-ws.chat.twitch.tv:443`; CAP tags; PING→`PONG :tmi.twitch.tv`; PRIVMSG diparse (tags `display-name` menang); auto-reconnect 5 dtk |
| `youtube` | API key + video ID yang sedang live | `videos.list(liveStreamingDetails)` → `activeLiveChatId` → poll `liveChatMessages.list` (part `snippet,authorDetails`), hormati `pollingIntervalMillis` (min 5 dtk); `superChatEvent`/`superStickerEvent` → **donasi** |

Endpoint: `POST /api/vtuber/start|stop`, `GET /api/vtuber/events?since=<id>`
(ring buffer 500 event), `POST /api/vtuber/mock-event` (simulasi dari UI).

Client (`mode-runtime.js`): poll 2,5 dtk → render feed (maks 120 baris) →
donasi memunculkan banner 6 dtk + prioritas ucapan terima kasih; chat dibalas
AI via `/api/chat` dengan gaya dari input `#vt-persona` dan cooldown
`#vt-cooldown`; balasan dilaankan lewat `window.__debugSpeak` (TTS pipeline).

## AI Assistant (`src/server/assistant.ts`)

- Runtime: `{workDir, history (maks 60), approvals Map, busy}`.
- Tools (registry di `src/server/agent/tools/index.ts`, 12 tool; level = data,
  bukan if-else di loop): `list_dir`, `read_file`, `search_code`, `git_diff`
  (level `safe` — jalan otomatis); `write_file`, `edit_file`, `delete_file`,
  `run_command` (level `mutating` — butuh approval: server membuat id `ap_*`
  dan MENAHAN eksekusi); plus `update_plan`, `remember`, `recall`,
  `spawn_subagent` (internal loop).
- Protokol LLM: system prompt memerintahkan tool call; balasan model dideteksi
  dengan `detect()` — cari **nama tool yang dikenal** di teks (model memformat
  bebas: `TOOL: nama {json}`, `**Tool: nama**` + fence json, atau `nama {json}`),
  lalu ambil `{...}` pertama dalam jendela 160 char; JSON longgar (key tanpa
  kutip, kutip tunggal) ditoleransi.
- Setelah tool aman dieksekusi, hasil dimasukkan sebagai pesan `[hasil tool]`
  dan loop lanjut (maks 6 turn) sampai jawaban final.
- Approval: `POST /api/assistant/approve {id, approve}` — mengeksekusi tool
  lalu melanjutkan reasoning; menolak memasukkan pesan "User MENOLAK".
  Varian streaming `POST /api/assistant/approve-stream` (SSE) mengalirkan
  hasil tool + lanjutan reasoning — dipakai panel browser.
- Sandbox: `safePath` mengunci path di dalam folder kerja; `run_command`
  asinkron dengan timeout 30 dtk, output dipangkas 12 KB (server tetap
  responsif selama perintah jalan). Tetap: shell = akses penuh mesin — hanya
  izinkan perintah yang kamu pahami.

### Panel agent (remake ala ZCode, 2026-09-07)

Panel assistant **port ke TS**: `src/client/agent/panel/` (stream / transcript /
actor / view / panel) di-bundle ke `bundle.js` sebagai `window.__agentPanel`;
`mode-runtime.js` hanya bridge `start()`. Bentuk:

- **Rail melebar** — `#sidebar.agent-wide` (372 → 600px) saat mode assistant
  aktif; karakter tetap terlihat di kiri.
- **Transcript live** — pertanyaan dikirim via SSE `/api/assistant/ask-stream`
  (delta token, kartu tool + args/hasil, kartu approval, `speak`, `done`),
  bukan lagi `POST /ask` blocking. Approve via `/approve-stream` agar kartu
  bermetamorfosis mulus ("menunggu izin" → "menjalankan" → hasil).
- **Satu sumber kebenaran per state** — kartu approval & plan dari poll
  `/api/assistant/status` (2 dtk, keyed by `ap.id`); transcript mode `live`
  (SSE) vs `follow` (bus `/events?since=`, untuk pantau CLI/klien lain).
  Bus `thinking/tool_call/permission/final/error` disupresi dari transcript
  saat live (padanannya dari SSE); `verification/subagent` selalu dirender.
- **Protokol putus-koneksi dua-kasus** (`decideFallback`): SSE gagal sebelum
  event pertama → cek status fresh, resend `POST /ask` sekali bila tidak busy;
  putus setelah ≥1 event → tidak pernah resend, lanjut follow dari bus
  (server menolak ask kedua saat `busy` — defense-in-depth).
- **Direktur akting** (`actor.ts`) tetap ada, mapping per-event diperluas:
  verification gagal → prihatin, lolos → ringan tanpa komentar;
  subagent_completed → senang; plan_revised → gaze think;
  permission_resolved disetujui → lega, ditolak → tanpa reaksi.
- **Diff, markdown, tab, undo (vibecoding, 2026-09-07 (2))**:
  - `panel/diff.ts` menghitung diff file di CLIENT dari argumen tool mutasi
    (`write_file`/`edit_file`/`delete_file` lewat SSE) — kartu tool mutasi
    menampilkan diff, kartu approval menampilkan pratinjau diff terbuka, dan
    tiap akhir giliran memunculkan kartu ringkasan "N file berubah +a −r".
  - `panel/md.ts` (zero-dep, token data → textContent, tanpa innerHTML)
    merender jawaban `final` sebagai markdown.
  - Tab **Obrolan / Review / Terminal** di atas transcript: Review = daftar
    file berubah sesi ini (registry client + `notes.filesTouched` dari
    `/api/assistant/status` — field additive) + tombol Revert; Terminal =
    riwayat `run_command` (command + output).
  - **Undo**: `execTool` menyimpan snapshot isi file SEBELUM write/edit/
    delete sukses (`Runtime.undo`, cap 20 FIFO, in-memory, tidak dipersist —
    seperti approval). `GET /api/assistant/undo` + `POST /api/assistant/
    revert {id}`; revert menulis balik isi lama / menghapus bila file tadinya
    belum ada; satu rekaman per path = kondisi asli sebelum rantai mutasi;
    revert ganda ditolak. CLI ikut tercakup (jalur `execTool` sama).
- Kontrak lama utuh: CLI `bun run agent` memakai runtime yang sama; panel
  hanya LAYAR — destroy() melepas UI, runtime tetap hidup.

## Desktop Pet (`src/server/pet.ts` + `static/pet.html`)

Web murni tidak bisa menembus desktop; pet berjalan di jendela aplikasi
terpisah. Peluncur memilih cangkang otomatis:

1. **Shell Tauri** (`agent-shell/target/release/live2d-shell.exe`, dibangun dengan
   `bun run build:pet`) — jendela WebView2 transparan melayang di desktop,
   always-on-top native, tanpa frame, tanpa taskbar (±40-90MB RAM). Server
   menjalankan `live2d-shell.exe pet http://127.0.0.1:<PORT>/pet.html`.
   Shell yang sama juga membuka **jendela utama** app (`live2d-shell.exe main
   <url>`, dipakai start.bat) — jendela berdekorasi normal, dan menunggu
   server bind (maks 15 dtk) sebelum membuat jendela. Di folder release
   portable (`bun run dist` → `dist/Live2D-Agent/`) hubungannya dibalik:
   shell jadi **sidecar** — bila port masih kosong dan `live2d-agent.exe`
   ada di sampingnya, shell menyalakan server sendiri dan mematikannya saat
   aplikasi ditutup, jadi user cukup dobel-klik shell.
   - Klik-tembus: toggle "Klik Tembus" di panel Pet (atau tombol di bar pet)
     → `POST /api/pet/clickthrough {on}` → pet page memanggil Tauri
     `setIgnoreCursorEvents`. Saat menyala, klik menembus ke desktop; satu-
     satunya jalan keluar adalah toggle yang sama di app utama.
2. **Fallback Chrome/Edge** (jika exe Tauri belum dibangun) — cari Chrome/Edge
   (path resmi + LOCALAPPDATA), lalu spawn
   `<exe> --app=http://127.0.0.1:<PORT>/pet.html --window-size=420,640`.
   Always-on-top via PowerShell `SetWindowPos(hwnd, -1, …, 0x0041)` (Win32
   resmi) 2,5 dtk setelah spawn — flag CLI Chromium tidak punya always-on-top.
   Jendela ini opaque dan tanpa klik-tembus.
3. `pet.html` — PIXI + model Live2D `backgroundAlpha: 0`; mata/kepala ikut
   kursor (`ParamAngleX/Y`, `ParamEyeBallX/Y`), sapaan berkala, tombol
   Sapa/Bicara/Klik-tembus/Tutup (`POST /api/pet/close` mematikan proses).
   Esc juga menutup. Bar bawah memakai `data-tauri-drag-region` (bisa
   dipindah di shell Tauri).
4. Pindah mode dari app utama otomatis menutup jendela pet (`petClose()` di
   teardown).

## Catatan pengembangan lanjutan

- Twitch donasi asli butuh EventSub (webhook/public URL) atau layanan pihak
  ketiga (StreamElements) — belum dibangun; donasi Twitch saat ini hanya via
  mock/inject.
- Click-through pet sudah ada via shell Tauri (`set_ignore_cursor_events`);
  fallback Chrome tidak mendukungnya.
- YouTube `liveChatMessages.streamList` bisa mengganti polling bila tersedia
  di semua akun.
