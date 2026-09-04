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
- Tools: `list_dir`, `read_file` (aman — jalan otomatis), `write_file`,
  `run_shell` (butuh approval — server membuat id `ap_*` dan MENAHAN eksekusi).
- Protokol LLM: system prompt memerintahkan tool call; balasan model dideteksi
  dengan `detect()` — cari **nama tool yang dikenal** di teks (model memformat
  bebas: `TOOL: nama {json}`, `**Tool: nama**` + fence json, atau `nama {json}`),
  lalu ambil `{...}` pertama dalam jendela 160 char; JSON longgar (key tanpa
  kutip, kutip tunggal) ditoleransi.
- Setelah tool aman dieksekusi, hasil dimasukkan sebagai pesan `[hasil tool]`
  dan loop lanjut (maks 6 turn) sampai jawaban final.
- Approval: `POST /api/assistant/approve {id, approve}` — mengeksekusi tool
  lalu melanjutkan reasoning; menolak memasukkan pesan "User MENOLAK".
- Sandbox: `safePath` mengunci path di dalam folder kerja; `run_shell` timeout
  30 dtk, output dipangkas 12 KB. Tetap: shell = akses penuh mesin — hanya
  izinkan perintah yang kamu pahami.

## Desktop Pet (`src/server/pet.ts` + `static/pet.html`)

Web murni tidak bisa menembus desktop; pet berjalan di jendela aplikasi
terpisah:

1. `POST /api/pet/launch` — cari Chrome/Edge (path resmi + LOCALAPPDATA), lalu
   spawn `<exe> --app=http://127.0.0.1:8310/pet.html --window-size=420,640`.
2. Always-on-top via PowerShell `SetWindowPos(hwnd, -1, …, 0x0041)` (Win32
   resmi) 2,5 dtk setelah spawn — flag CLI Chromium tidak punya always-on-top.
3. `pet.html` — PIXI + model Live2D `backgroundAlpha: 0`; mata/kepala ikut
   kursor (`ParamAngleX/Y`, `ParamEyeBallX/Y`), sapaan berkala, tombol
   Sapa/Bicara/Tutup (`POST /api/pet/close` mematikan proses).
4. Pindah mode dari app utama otomatis menutup jendela pet (`petClose()` di
   teardown).

## Catatan pengembangan lanjutan

- Twitch donasi asli butuh EventSub (webhook/public URL) atau layanan pihak
  ketiga (StreamElements) — belum dibangun; donasi Twitch saat ini hanya via
  mock/inject.
- Click-through pet (klik menembus karakter) butuh Electron/Neutralino —
  belum dibangun.
- YouTube `liveChatMessages.streamList` bisa mengganti polling bila tersedia
  di semua akun.
