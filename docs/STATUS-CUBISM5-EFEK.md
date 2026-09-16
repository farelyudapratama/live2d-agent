# STATUS SESI — Dukungan Cubism 5 & Efek Model (Handoff)

## UPDATE 2026-09-16 (57) — BEHAVIOR CONTRACT S4-A: HARNESS TASK IDENTITY + PARK/QUEUE — VERIFIED

S4-A dari Behavior Contract (O3→S4) diimplementasi dan diverifikasi. HANYA
slice yang dikunci: identitas task worker + antrean PARK FIFO + invariant
active/paused + cancel task-aware + reset guard + feedback minimal. Companion
lane (AgentBrain, merge/preempt PET semantics) TIDAK disentuh; SpeechChannel,
MotionRuntime, ParameterArbiter TIDAK disentuh; task modification dan speech
priority policy TIDAK diimplementasi (kontrak: jangan dulu).

### Mekanisme (server = satu-satunya otoritas)

State (agent/state.ts): `Runtime.activeTask: TaskRec|null` (taskId, text,
state "running"|"paused", cfg) + `parkedTasks: {taskId,text}[]` +
`nextTaskSeq`. taskId = `t_<n>` unik seumur runtime — deterministik, bukan
sistem ID terdistribusi. Cap antrean `MAX_PARKED = 20`.

Invarian inti (assistant.ts): kepemilikan slot = `activeTask`, BUKAN `busy`.
Bug lama tertutup: approval-pause melepas `busy` tetapi `activeTask` tetap
`paused` → ask kedua PARK, tidak pernah ada dua loop di satu history (I11).
`assistantAsk`: slot bebas → klaim SENYAP sebelum await pertama →
`executeTask`; slot terisi → `parkTask` (FIFO; kebanjiran → ok:false
"antrean penuh (20) — task terbaru DITOLAK", antrean tak bermutasi, tanpa
drop senyap). Hasil ask selalu membawa `taskId`; task parked → `{queued,
taskId, position}`.

Drain tunggal: `releaseAndDrain` dipanggil HANYA dari jalur terminal
`executeTask` (sukses, error, cancel-paused, deny final, limit) dan
`cancelActive` (paused). Guard: `rt.destroyed` → no-op; `activeTask.taskId
!== task.taskId` → no-op. Klaim task berikutnya terjadi SINKRON di dalam
fungsi yang sama — satu pemilik transisi, completion basi tidak bisa
melepas/drain milik task lain (I6/I7). Task yang sedang RUNNING tetap
kooperatif: cancel = flag, tool in-flight selesai dulu (kontrak lama).

Cancel task-aware: `assistantCancel({taskId?})` — parked: buang dari antrean
saja (I9); active running: flag kooperatif; active paused: terminal seketika
+ `approvals.clear()` (menutup celah resume basi); tanpa target: active
(perilaku lama `accepted:false` saat idle dipertahankan). Antrean TIDAK
pernah ikut batal (I10).

Reset guard: `assistantReset` → `{ok:false, accepted:false, error}` selama
ada `activeTask`/`busy` (I8); route kini mengembalikan hasil aslinya.
Operasi sesi (create/switch/delete) kini juga menolak bila task paused ATAU
antrean terisi — parked task tidak pernah bisa dieksekusi lintas ganti sesi
(migrasi lintas sesi eksplisit = di luar cakupan, lihat limitation).

/status diperluas (additif, konsumen lama utuh): `activeTask {taskId,text,
state}`, `parkedTasks[]`, `queueCount`.

### Panel (feedback minimal, TANPA UI manajemen antrean)

`#as-input` tidak lagi dilumpuhkan selama stream sendiri — task kedua masuk
antrean via ask non-stream → balasan `{queued,taskId}` → baris status
"Task diantrekan (#t_n)" (helper murni `queuedFeedback` di transcript.ts,
ter-unit-test). Feedback sama untuk event SSE `done{queued}` dan fallback
non-stream. Baris "n task menunggu" saat jumlah antrean berubah. Cancel
dihormati saat paused (tombol aktif bila `activeTask` ada). Reset gagal →
✗ error dari server, transcript lokal TIDAK dihapus. Per-task cancel UI
DENGAN SADIA belum — API-nya sudah ada (S4-B).

### Test

`test/harness-queue.test.ts`: 24 test (T1–T18 + T19/T20/T21 regresi + T22a/
b/c) — facade + loop ASLI in-process; LLM distub di fetch dengan deferred
manual per turn; bukti "tepat sekali" dari state + event bus `thinking_start`
(drain), bukan sleep. T6 mengunci perilaku nyata: error provider memasang
cooldown fallback (classifyError selalu shouldFallback) → task di-drain gagal
cepat TANPA deadlock, rantai tetap FIFO, antrean kering.

Gates: unit 1433 pass (1409 + 24), guards 411/411, tsc bersih, build bersih,
`smoke-engine-utterance.ts` 43/43, `smoke-vtuber-browser.ts` semua pass.
Regresi S1/S2/S3-A/S3-B seluruhnya hijau tanpa perubahan.

### Limitasi faktual yang diterima (bukan bug terselubung)

1. Task hasil drain tidak punya sink SSE pemilik → suara akhirnya lewat quip
   actor atas `final_answer` (persis perilaku ask klien luar/CLI hari ini).
2. `assistantStop` + ask berikutnya → `assistantAsk` error "mode tidak
   aktif" (tetap); CLI tidak menampilkan teks "queued" khusus (ask-stream-nya
   dapat `done{queued}` tanpa reply) — minor, di file di luar scope S4-A.
3. Cooldown provider (30 dtk) bisa membuat sejumlah task parked gagal cepat
   beruntun — tiap task tetap terminal + drain tepat sekali; tidak ada
   retry otomatis.
4. UI per-task cancel / kartu antrean = S4-B (kontrak memang hanya feedback).

Commit kode: 4a38014.

## UPDATE 2026-09-16 (56) — BEHAVIOR CONTRACT S3-B: VTUBER OPERATOR FIFO QUEUE — VERIFIED

S3-B dari Behavior Contract v1 diimplementasi dan diverifikasi: jalur
OPERATOR eksplisit (composer jendela utama) + antrean FIFO operator, berbagi
SATU slot aktif dengan donasi. O2 (audit identitas operator) sudah menutup
kemungkinan "chat disalahartikan operator" — tipe baru `"operator"` dibuat
EKSPLISIT, tidak ada reinterpretasi chat. Overlay OBS (`vtuber.html`) tidak
disentuh dan memang tidak terpengaruh: loop poll-nya hanya bereaksi ke
`chat|donation`, jadi event operator lewat tanpa jejak di sana (D-3 aman).
Switch `#vt-donate-respond` TETAP mati/utuh (D-5).

### Alur nyata setelah S3-B

COMPOSER (input + tombol Kirim di panel `#mode-vtuber`):
  HANYA `post("/api/vtuber/mock-event", { type:"operator", user:"operator",
  text })` — tanpa LLM, tanpa ucap (guard O18 mengunci badan fungsinya).
  Server: `vtuberInjectEvent` kini melewatkan "operator" (whitelist); tipe
  tak dikenal TETAP jatuh ke "chat" (safety lama utuh). Tanpa runtime → 400
  → composer mencatat "gagal: …" di status, tidak crash.

OPERATOR (poll → operator): seen-id (share map dengan donasi — identity
event) → push FIFO (cap 20; overflow buang TERBARU) → drain `pumpOperators`
→ LLM (prompt `vt.operatorPrompt`, PERSONA yang sama, system string sama
persis dengan donasi — D-4) → ucap via kanal S1 (producer
"vtuber/operator", `speakWait`) → slot berakhir setelah lifecycle ucap
(completed/lost/watchdog 60 dtk) — parity penuh donasi, tidak ada jalur
baru ke __agent.

### Scheduler slot bersama — keputusan desain (penting untuk penerus)

Satu-satunya flag slot adalah `donoBusy` (nama historis S3-A dipertahankan
— teks `pumpDonations` TIDAK BERUBAH sehingga 21 test S3-A lolos tanpa
sentuh). Invarian: klaim terjadi SENYAP sebelum await pertama, jadi dua
pemicu sinkron tidak pernah klaim ganda. Prioritas D-1 diterapkan saat
KLAIM (bukan preempt): `pumpOperators` menolak saat `donoBusy`, dan bila
donoQueue masih berisi, ia menyerah ke `pumpDonations()`. Rantai release
operator memanggil donasi lebih dulu bila keduanya menunggu.

Keterbatasan yang diterima (by design): rilis slot oleh DONASI tidak bisa
merantai ke operator (finally `pumpDonations` terkunci teks S3-A) — wake
operator dijamin sapuan `pumpOperators()` tiap poll (≤2,5 dtk, bounded).
Rilis oleh OPERATOR sendiri sudah merantai penuh (donasi dulu, lalu
operator berikutnya).

### Gate & test

`test/vtuber-operator.test.ts` baru: 21 test (O1–O20) — FIFO/serialisasi,
completion point, lost, seen-id vs teks-sama (operator TIDAK pernah
dup-key), prioritas klaim donation, non-preempt, overflow buang-terbaru,
error lanjut, teardown diam, overlay-on & respond-off TETAP proses (D-3),
watchdog pelepasan slot, perilaku composer (trim/clear/payload/no-LLM),
kontrak tipe server (operator lolos; asing→chat), source guards wiring +
lifecycle clear (`opQueue.length = 0` di onStop & destroy) + D-5.

SATU perubahan pada file S3-A yang diizinkan dan jujur: guard sementara
"S3-A tidak menyentuh operator (O2 masih terbuka)" (`not.toMatch
(/vtuber\/operator/)`) sudah TERTUTUPI oleh S3-B — diganti guard penerusnya
(operator ADA + kanal audience/donasi lama utuh). 20 test lainnya + semua
assertion perilaku S3-A tidak berubah sebyte pun.

Gates: unit 1409 pass (1388 + 21), guards 411/411, tsc bersih, build
bersih, `smoke-engine-utterance.ts` 43/43, `smoke-vtuber-browser.ts` semua
pass. Commit kode: 4a6d82c.

## UPDATE 2026-09-16 (55) — BEHAVIOR CONTRACT S3-A: VTUBER AUDIENCE SUPPRESSION + DONATION FIFO — VERIFIED

S3-A dari Behavior Contract v1 diimplementasi dan diverifikasi. HANYA dua itu:
supresi AUDIENCE dan antrean FIFO DONATION pada responder VTuber jendela
utama. OPERATOR (O2) TIDAK diimplementasi — identitas operator memang belum
ada di kode dan kontrak melarang mengarangnya. Halaman overlay OBS
(vtuber.html) TIDAK disentuh: jendela/proses berbeda di luar kanal ucap
jendela utama.

### Alur nyata setelah S3-A

AUDIENCE (poll → chat):
  seen-id (cap 500/300s) → dup-key user+teks window 8 dtk → cooldown
  existing (≥5s, default 12s) → audBusy (satu in-flight) → LLM → ucap.
  Yang ditekan di titik mana pun = FINAL, tidak pernah masuk antrean apa
  pun (kontrak: audience tidak punya queue).

DONATION (poll → donation):
  alert visual (tetap) → seen-id → push FIFO (cap 20; overflow membuang
  yang TERBARU sehingga FIFO yang tertampung utuh) → drain serialized
  (donoBusy) → LLM SAAT slot aktif (tidak pre-generate) → ucap via kanal
  S1 (producer "vtuber/donation", via __debugSpeak/speakWait) → queue
  HANYA maju setelah lifecycle ucap selesai — 'completed' ATAU 'lost'
  sama-sama mengakhiri slot (tidak ada retry-loop); watchdog 60 dtk
  melindungi bridge yang tak memanggil callback.

### Dedup audience — kunci & jendela (dokumentasi kontrak)

Kunci: `lowercase(user) + "::" + trim(lowercase(text)) whitespace-collapsed`,
window 8 dtk, Map bounded (prune >4×window, cap 200). Hanya pengulangan
USER SAMA dengan teks sama yang ditekan — dua user sah mengucapkan hal
sama TIDAK dibungkam (dibuktikan test A4). Event-ID seen-map (window
300s, cap 500) melindungi re-delivery polling yang tumpang tindih untuk
kedua kelas. Donasi TIDAK PERNAH lewat dup-key.

### Semantik antrean donasi

Data: array event mentah (sebelum LLM). Drain: guard `donoBusy` diset
sinkron sebelum await pertama → dua pemicu serentak = satu proses (D10).
Overlay aktif / respond OFF: slot diakhiri tanpa LLM (yield/mute policy
existing — antrean tidak tersumbat; didokumentasikan, bukan preservasi
baru). Error LLM: slot tetap berakhir (finally), donasi berikutnya jalan
(D5). Teardown (destroy + onStop): `stopped=true; gen++; donoQueue.length=0`
— kontinuaasi async mount lama dibungkam oleh cek `myGen === gen` di
SETIAP titik setel-side-effect; test D8 membuktikan stale donasi tidak
bersuara ke mode baru.

### Catatan proses (jujur)

Harness vm mengungkap semantik Bun: binding `var` dalam script context TIDAK
tersinkron dua-arah dengan objek host — state skalar test dibaca/ditulis via
accessor `__ctl` di dalam context; array/Map aman dirujuk (tidak pernah
di-reassign). Test juga fire-and-forget (persis cara poll() memanggil),
bukan await fungsi yang tidak pernah resolve. Ini artefak test-harness,
bukan defect produk.

### Tests: `test/vtuber-audience-donation.test.ts` — 21 test
A1-A6 + A-window (audience); D1/D2-D3-D6/D4/D5-error/D5-lost/D7/D8/D8b/
D9-D10/D-bound/D-nooverlap; plus 3 guard wiring (rute poll, teardown gen++,
tanpa "vtuber/operator" & speak() S1 lama utuh). Semua terhadap TEKS ASLI
mode-runtime.js via vm-extraction, deferred promise deterministik.

### Quality gates (satu rangkaian):
- unit **1388 pass / 0 fail** (74 file; +21) · guards **411 / 0** (7 suite)
- `tsc` bersih · `build` bersih
- `smoke-engine-utterance.ts` **43/43** (halaman memuat mode-runtime) ·
  `smoke-vtuber-browser.ts` penuh hijau (halaman overlay tak berubah)
- Suite S1/S2/vtuber-inject/r8-3/i18n: hijau — semantik SpeechChannel dan
  PET merge tidak disentuh

### Commit: `10c8235` feat(vtuber): audience suppression + donation FIFO queue

---

## UPDATE 2026-09-16 (54) — BEHAVIOR CONTRACT S2: PET THINKING MERGE — VERIFIED

S2 dari Behavior Contract v1 diimplementasi dan diverifikasi. HANYA merge
saat THINKING; CASE SPEAKING (preempt Phase 18) dan S3+ (VTuber queue,
operator, harness lanes, gating proaktif) TIDAK disentuh.

### Perilaku lama → baru

Lama: `think(B)` saat `busy` → silent-drop (B tidak pernah dilihat model).
Baru (CASE 1 — THINKING): B DITERIMA — masuk history seketika (urutan
arrival = urutan history) + ke buffer penanda `_pendingMerge` dengan
`historyIndex` (watermark posisi). Saat respons pass aktif tiba:
- B sudah tercakup payload yang terkirim (masuk sebelum fetch berangkat) →
  respons itu sudah menjawab gabungan; penanda dilepas, TANPA pass sia-sia.
- B tiba SETELAH payload terkirim → respons digugurkan (TIDAK diucapkan,
  TIDAK masuk chat log) dan SATU pass penggantian dikirim dengan history
  gabungan [.., A, B, C]. Model yang menafsir gabungan — tanpa classifier
  "never mind/koreksi/supersede".
CASE 2 (SPEAKING) tak tersentuh: busy sudah false saat rantai bicara →
jalur think() normal → claim + preempt rantai (Phase 18). Buffer merge
tidak pernah dilalui di jalur ini (dibuktikan test R8: pendingMergeCount 0).

### Titik implementasi (semua AgentBrain-lokal; tanpa sistem baru)

- Klaim `busy` + snapshot `_reqGen` + **push history user pindah ke blok
  sinkron** (sebelum `await loadProfile`) — atomisitas klaim Bug-2 utuh dan
  urutan history [A sebelum B] deterministik bahkan saat profil masih
  di-resolve.
- Loop pass di dalam `think()`: tiap iterasi SATU `_beginRequest()` aktif,
  pass k+1 hanya dimulai setelah pass k resolve/reject → tidak pernah dua
  request thinking paralel; proteksi Phase 16 (`_reqCtrl/_reqGen/timeout/
  stale`) tetap otoritatif; finally per-pass membersihkan timer/controller.
- CP-1 (setelah `resp.json()` + guard fresh) dan CP-2 (setelah director pass,
  sebelum playSegments) memakai watermark `sentThrough`. Director pass =
  SATU-SATUNYA window "sudah resolve tapi belum bersuara" yang benar-benar
  await; window lain di luar director sinkron dan TIDAK tercapai
  (didokumentasikan di kode, sesuai instruksi R4).
- Jalur error (R5): SEMUA penanda menuntut satu percobaan percakapan
  (pass pengganti) sebelum fallback; fallback tetap TEPAT SATU di pass
  terakhir tanpa penanda. Timeout (B3) terverifikasi: dua pass SEQUENTIAL,
  timer/controller selalu milik pass aktif.
- Model switch (R6): siklus basi TIDAK mewarisi merge — buffer dibersihkan,
  tanpa pass lintas model, tanpa pesan hilang dari history (history memang
  bertahan lintas switch sejak dulu — tidak ada preservasi baru yang
  direkayasa; didokumentasikan).
- Proaktif (reactEvent): checkpoint identik + prioritas user — bila input
  user menunggu, balasan proaktif TIDAK diucapkan, TIDAK dicatat P15.x,
  dan loop user mengambil alih via `_scheduleFoldedThink()` (flush
  `think("")` yang tidak menambah entri history kosong; ditolak ulang bila
  ternyata sudah ada loop user berjalan — pesan sudah ada di history-nya).
- QA: `_reactiveState().pendingMergeCount` (jumlah, bukan isi).

### Semantik history yang dipertahankan (tidak ada arsitektur transkrip baru)

History = array hidup otoritatif brain (clear-chat sudah in-place sejak
fix 52); balasan assistant memang TIDAK disimpan (model user-only —
semantik existing, sengaja tidak diubah); penggabungan terjadi lewat
history, bukan payload khusus. UI: respons yang digugurkan tidak pernah
masuk chat log, jadi transkrip tidak pernah mengklaim jawaban yang tidak
terdengar.

### Test lama yang DIUPDATE karena kebijakan (bukan dilonggarkan)

`history-clear-and-claim.test.ts` B1/B3 mengunci silent-drop yang kini
DIGANTI kontrak S2; keduanya ditulis ulang mengunci intents aslinya
(tidak ada request paralel, tidak ada controller tercuri, sekuensial,
fallback tepat satu) plus semantik merge baru. Semua suite lain (P15/P16/
P17/P18/S1) hijau tanpa perubahan.

### Tests: `test/pet-merge.test.ts` — 10 test
R1 regresi A-saja; R2 fold+replace (payload [A,B], respons A tak pernah
bersuara/masuk chat); R3/R7 [A,B,C] urut; R4 window director = THINKING →
merge; R5 error → percobaan percakapan lalu tepat satu fallback; R6 switch
membunuh siklus + buffer tanpa menghilangkan pesan; R8 SPEAKING tetap
PREEMPT tanpa buffer; reactEvent menyerahkan ke loop user (proaktif diam,
tidak mencatat, `think("")` tidak menodai history); invarian puncak:
max concurrent thinking request === 1. Semua deterministik via deferred
promise (resolve/reject manual), bukan sleep-as-proof.

### Quality gates (satu rangkaian):
- unit **1367 pass / 0 fail** (73 file; +10) · guards **411 / 0** (7 suite)
- `tsc` bersih · `build` bersih
- `smoke-engine-utterance.ts` **43/43** (jalur think()/rantai yang berubah
  tetap utuh; S6 ownership tak terpengaruh)

### Commit: `8bfc6fb` feat(agent): fold user input into thinking request (PET merge)

---

## UPDATE 2026-09-16 (53) — BEHAVIOR CONTRACT S1: SHARED SPEECH CHANNEL — VERIFIED

S1 dari Behavior Contract v1 diimplementasi dan diverifikasi. Infrastruktur
kepemilikan ucap jendela utama — BUKAN kebijakan produk; S2+ (PET merge,
VTuber queue/operator, Harness lanes, gating proaktif) TIDAK disentuh.

### Yang dibuat

1. **`src/client/speech/channel.ts`** (baru, murni TS tanpa DOM):
   `createSpeechChannel()` — claim/release/isOwner/outcome/current/reset +
   `setEnforcer`. Satu slot pemilik; takeover hanya bila `priority >=`
   pemilik; pemilik lama terima `lost` SINKRON sebelum klaim return, lalu
   enforcer (stopSpeechNow app.js) menghentikan audio; klaim saat kanal
   bebas TIDAK menyentuh enforcer. Release idempoten; token basi tidak
   bisa melepas pemilik (INV-2/5). `reset("model-switch")` = jalur INV-7.
2. **app.js**: `speakShared` membungkus engine `speak` (pipeline TTS/audio
   TIDAK diubah) di SEBELAR tunggal semua ucap jendela utama; outcome
   dihitung dari KEPEMILIKAN saat callback engine tiba — `onend` setelah
   cancel tidak bisa lagi menyamar jadi completion (INV-4). Semua call
   site bawa identitas: `__debugSpeak(text, done, producer)`, jalur direct
   `app/direct`, bridge `speak` = `speakShared`. Enforcer dipasang ke
   `stopSpeechNow` (pause ttsAudio + speechSynthesis.cancel — idempoten).
3. **AgentBrain**: `_chainOwner` Phase 18 TETAP sebagai pengatur sekuens
   segmen; kanalSpeech dipakai SATU klaim per rantai (`brain/chain`,
   token rantai dilewatkan ke speak per segmen → tanpa self-preemption).
   `onLost` kanal → rantai MATI (bukan lanjut); callback speak lama yang
   datang belakangan dapat outcome `lost` → defensif no-op. Jalur tanpa
   kanal (bundle lama/test stub) = perilaku pra-S1 utuh.
4. **Harness panel**: `speakAsCharacter` → `speak(text, undefined,
   {producer:"harness/actor"})` — quip/task ikut kanal. Semantik cancel
   task TIDAK diubah. **VTuber main-app**: `__debugSpeak(..., "vtuber/audience")`.
   Overlay OBS = jendela/proses lain → DI LUAR kanal (sesuai kontrak).
5. **INV-7 seam**: `loadModel` teardown kini `__speechChannel.reset
   ("model-switch")` setelah invalidate brain — pemilik lama `lost`, audio
   sisa berhenti, kanal bersih sebelum model baru.

### Asumsi prioritas yang DIDOKUMENTASIKAN (bukan kebijakan final)

Semua produsen default priority 0 → takeover selalu legal = PERSIS perilaku
fisik engine hari ini (ucapan baru membatalkan lama); yang berubah hanya
korban kini melihat `lost`, bukan completion. Parameter `priority` tersedia
sebagai mekanisme untuk S2/S3; mapping USER>audience>proaktif SENGAJA belum
ditanam. Kuota refusal `null` hanya aktif bila pemilik priority lebih tinggi.

### Tests

- `test/speech-channel.test.ts` — 9 unit murni kanal (checklist claim/
  takeover/refusal/stale-release/double-release/outcome/reset/identity).
- `test/brain-speech-channel.test.ts` — 7 unit integrasi: regresi kunci
  A→B lanjut normal TANPA preempt eksternal; A→preempt eksternal→B TIDAK
  jalan; stale token tak bisa lepas pemilik baru; graceful tanpa kanal;
  model switch melepas kanal.
- `test/smoke-engine-utterance.ts` — S1/S5 diperluas + skenario S6 baru:
  takeover lewat BRIDGE PRODUKSI; bukti LOGIS (owner, rantai mati, lock
  lepas) DAN AKUSTIK (log `__ssSpoke` real-browser-parity + cancel
  meningkat; segmen kedua brain tidak pernah bersuara) + kanal bersih
  saat model switch. Shim smoke dinaikkan ke paritas browser bersuara
  (voices + onend-saat-cancel) — murni file test.

### Quality gates (satu rangkaian):
- unit **1357 pass / 0 fail** (72 file; +16) · guards **411 / 0** (7 suite)
- `tsc` bersih · `build` bersih
- smoke **43/43** termasuk S6 logis+akustik · suite P16/P17/P18 penuh hijau
- Scope audit: nol perubahan MotionRuntime/Arbiter/renderer/prompting/
  queue/merge/operator-lane/gating; overlay tak disentuh

### Catatan proses

Sesi implementasi S1 sebelumnya sudah meninggalkan working tree sebagian
(implementasi utuh, belum terverifikasi/ter-commit); sesi ini memverifikasi
tiap integrasi terhadap invariant (termasuk jalur token anti self-preemption),
memperbaiki shim smoke (artefak environment: tanpa voices, speak engine tak
pernah sampai speechSynthesis — 3 cek akustik gagal), menjalankan semua gate,
baru commit.

### Commit: `a26c0da` feat(app): S1 shared speech channel for main-window speech

---

## UPDATE 2026-09-16 (52) — TARGETED CORRECTNESS FIX: CLEAR-CHAT SHARED ARRAY + ATOMIC REQUEST CLAIM — VERIFIED

Bukan fase baru. Dua bug correctness temuan audit policy pasca-Phase 18.
Kebijakan pesan-konkuren (queue/interrupt/merge/feedback) SENGAJA TIDAK
disentuh — behavior REQUEST-BUSY tetap silent-drop seperti sebelumnya.

### Bug 1 — Clear chat tidak pernah benar-benar mengosongkan history

Akar: handler app.js melakukan `window.__agent.history = []` — facade
`history` adalah REFERENSI SHARED ke array hidup `brain.history` (kontrak
"Array HIDUP", brain.ts:146/1401). Reassign hanya menambat ulang properti
facade; array brain tetap terisi → setelah Clear Chat, UI kosong tapi
SEMUA percakapan lama tetap terkirim ke LLM.

Fix (in-place, satu-satunya operasi yang menjaga invariant):
`window.__agent.history.length = 0` (guard `Array.isArray`). Tidak ada
store history kedua, tidak ada semantik baru.

### Bug 2 — Race klaim awal: dua request paralel + timer tercuri

Akar: `think()`/`reactEvent()` men-set `busy` SETELAH `await loadProfile()`
(kanan ketika `capProfile` masih null — awal sesi / pasca model switch).
Dua panggilan beruntun sama-sama lolos `if (this.busy)` sebelum salah satu
mengklaim → dua request LLM paralel; `_beginRequest()` kedua (defensif)
men-null-kan `_reqCtrl/_reqTimer` milik request pertama → request 1 berjalan
TANPA timeout dan tanpa controller — pelanggaran semantik Phase 16.

Fix: `this.busy = true` + snapshot `const genAtClaim = this._reqGen` dipindah
SEBELUM await pertama (cek-klaim jadi satu satuan atomik JS — tidak ada await
di antaranya), plus outer `try/finally` safety-net (idempoten terhadap finally
dalam) agar klaim tak pernah jadi kunci abadi. Setelah await profil: bila
`_reqGen` naik (model switch SELAMA loadProfile) → dibuang SEBELUM request
mulai, dengan pesan user tetap masuk history (identik semantik abort in-flight
Phase 16 — memakai mekanisme yang SUDAH ADA, bukan generasi kedua).
Payload/timeout/fallback/abort-nya Phase 16 dan kepemilikan playback Phase 18
tidak diubah.

### Temuan yang DILAPORKAN, tidak diperbaiki di sini (disiplin scope)

`nextSegment` dipanggil dari timer jeda 180 ms TANPA pembungkus error: bila
`applyActions` melempar di tengah rantai, exception lolos ke timer dan rantai
tetap memegang `_chainOwner` + `aiLock` selamanya (tidak ada jalur pelepas).
Produksi saat ini tidak punya pelempar yang diketahui di jalur itu, jadi ini
harden-opsional, bukan bug aktif — kandidat penguatan kecil bila nextSegment
disentuh, BUKAN bagian dari dua fix ini.

### Tests: `test/history-clear-and-claim.test.ts` — 10 test

Fix-1: statement handler ASLI dari app.js diekstrak + dijalankan di vm
(mengosongkan array hidup brain, referensi facade tetap identik), guard
sumber anti-rebind, end-to-end: setelah clear, payload /api/chat berikutnya
hanya berisi pesan baru.
Fix-2 (deferred promise, urutan deterministik — bukan sleep-as-proof):
B1 dua think() beruntun → tepat 1 `_beginRequest` + 1 `/api/chat` + payload
hanya pesan pertama; B2 think+reactEvent beruntun → 1 request; B3 timeout
milik request AKTIF (bukan tercuri) + cleanup bersih; B4 provider-error
first-request → 1 fallback pulih penuh; B5 model-switch saat loadProfile →
request tidak pernah mulai, pesan tercatat, model baru bisa jawab; B6
late/stale continuation (provider abai signal) → nol playback; B7 happy-path
sekuensial utuh.

### Quality gates (satu rangkaian):
- unit **1341 pass / 0 fail / 0 errors** (70 file; +10) · guards **411 / 0** (7 suite)
- `tsc` bersih · `build` bersih
- `smoke-engine-utterance.ts` **31/31** DI BAWAH fix (think()/reactEvent()
  yang berubah justru jalur inti smoke) · suite P15/P16/P17/P18 penuh hijau

### Commit: `117c52d` fix(agent): atomic request claim and in-place clear-chat

---

## UPDATE 2026-09-16 (51) — TARGETED CORRECTNESS FIX: loadModel GENERATION GUARD — VERIFIED

Bukan fase baru. Perbaikan tertarget dari temuan audit perilaku pasca-Phase 18.

### Race exact yang ditutup

`loadModel()` re-entrant tanpa guard: dua load yang tumpang tindih (boot
auto-load vs klik user, atau dua klik beruntun) menentukan model akhir dari
URUTAN PENYELESAIAN async, bukan urutan permintaan. Bukti runtime audit:
klik tesmodel → lumine berjarak 250ms berakhir di REN (permintaan terakhir
kalah); boot-load menimpa klik awal; continuation lama sempat men-destroy
model current-nya user.

### Mekanisme

`let _loadGen = 0` di samping `loadModel`; token `my = ++_loadGen` di
ENTRI (sebelum await pertama). Pola sama dengan `_reqGen` brain (P16),
`_taxonomyGen`/`_resyncGen` (P17). Setiap kontinuaasi setelah 4 titik await
(`resolveAnyModelPath`, `buildModelSettings`, `__compositor8Ready`,
adapter `loadModel`) memverifikasi token; bukan current → NO-OP:

- G1 (path request): tidak set modelPath, tidak destroy model pilihan user,
  tidak sentuh UI/teardown.
- G2/G3: berhenti SEBELUM menyentuh host/binding/adapter.
- G5 (hasil adapter telat): bersihkan handle MILIK SENDIRI saja —
  `host.remove(handle)` identity-safe + `handle.destroy()` idempoten —
  model current tidak tersentuh, lalu no-op.
- catch: error dari load basi TIDAK menampilkan pesan loader/empty state;
  load current yang gagal tetap memakai semantik error lama.

`loadModel` kini mengembalikan boolean (true = masih pemilik state saat
selesai, termasuk jalur error-current; false = diambil-alih).
`loadUserModel` menghormati false: load basi tidak `hideLoader` dan tidak
`refreshModels` — pemenang yang pegang UI. Pemanggil lain mengabaikan
return value (kompatibel).

### Batas klaim (jujur)

Guarantee: **lanjutan load basi tidak dapat mutasi state model current**.
Ini BUKAN pembatalan — fetch/network load lama tetap menyelesaikan
diri sendiri dan handle yatim-nya dibersihkan setelah selesai. Tidak ada
perubahan Brain/Phase 16, Arbiter, MotionRuntime, registry, atau renderer.

### Tests: `test/loadgen-guard.test.ts` — 7 test perilaku via vm-extraction
fungsi ASLI app.js dengan deferred promise (urutan penyelesaian dikontrol
penuh, tanpa sleep-as-proof): T1 B-menang-A-no-op, T2 boot vs user (B tidak
ter-destroy), T3 error basi diam, T4+G5 clean-up handle yatim identity-safe,
T5/T6 caps+registry hanya dari pemenang, T7 ren→lumine→ren sekuensial
(teardown normal sebelumnya selamat), T8 A→B→C resolve acak → C menang,
T9 wrapper loadUserModel tidak merampas loader. Tanpa guard, T1/T2 gagal
deterministik (destroyB / hang).

### Quality gates (satu rangkaian):
- unit **1331 pass / 0 fail** (69 file; +7) · guards **411 / 0** · tsc bersih · build bersih
- Suite Phase 16/17/18 (48 test) hijau · `smoke-engine-utterance.ts` **31/31**
  di bawah guard (S5 model switch = bukti browser nyata area perubahan)

### Commit: `5f123b4` fix(app): guard model load against stale continuations

---

## UPDATE 2026-09-16 (50) — Phase 18: AGENT PLAYBACK OWNERSHIP & INTERRUPTION — VERIFIED

Phase 18 selesai diimplementasi dan diverifikasi. Status: **PHASE 18 — VERIFIED**.

### Failure mode yang ditutup (exact, dari audit Phase 18)

`playSegments()` hanya MENGINISIASI segmen 1 secara sinkron; segmen
berikutnya jalan lewat callback `speak` engine (detik–menit). `finally`
`think()/reactEvent()` melepas `busy` begitu REQUEST selesai — sehingga
request kedua bisa mulai saat rantai pertama masih bicara. Dua rantai
berebut satu elemen audio (`state.ttsAudio`): swap src menelan `onended`
rantai lama → rantai lama TIDAK mati, hanya tertunda, lalu timer guard
engine (45–60 dtk) fire → **zombie utterance** menyela pembicaraan baru.
`lockAI/unlockAI` boolean tanpa refcount → rantai yang selesai lebih dulu
membuka lock padahal rantai lain masih bicara.

### Desain ownership (kecil, AgentBrain-lokal — BUKAN behavior engine)

- `_chainGen` (monoton, tak pernah reset) + `_chainOwner` (token rantai
  aktif; null = tidak ada yang bicara) + `_chainTimer` (jeda 180ms).
- **SETIAP kontinuaasi async membawa token**: callback `speak` onDone,
  gap timer, dan jalur completion — semua di-guard
  `if (this._chainOwner !== my) return;` terlebih dahulu. Token basi →
  no-op total (tidak bicara, tidak lanjut segmen, tidak menyentuh lock).
- `busy` TETAP level request (semantik Phase 16 tidak diubah); ownership
  playback adalah keadaan TERPISAH. `_reactiveState()` kini mengekspos
  `utteranceActive`/`utteranceChain` untuk QA.

### Kebijakan preemption (S2 — diuji, bukan diklaim)

1. think() user: **membatalkan rantai aktif di ENTRI** (stop speech +
   unlock sekali + token basi) — sebelum request jalan; balasan berikutnya
   meng-claim ulang lewat `playSegments(segments, true)`.
2. reactEvent() proaktif: `playSegments(segments, false)` — bila sudah ada
   rantai aktif, **tidak** mulai rantai kedua, dan P15.2/P15.5 TIDAK
   mencatat (semantik "catat hanya yang dieksekusi" dipertahankan). Tidak
   ada antrean; tidak ada audio kedua; tidak ada klaim lock kedua.
3. `playSegments` mengembalikan `boolean` (rantai dimulai?) — satu-satunya
   jembatan keputusan record proaktif.

### Cancellation bridge (S4)

`window.__live2dAgent.stopSpeech()` (app.js): pause `state.ttsAudio` +
`speechSynthesis.cancel()` — keduanya guard `try`, **idempoten**, aman
tanpa audio/model. Timer cleanup milik engine (fallbackTimer/guard
`doRemoteTTS`) tetap jalan sendiri → `markDone` final tetap terjadi;
callback brain yang datang telat di-guard token, jadi stop tidak pernah
menghidupkan rantai basi. Nol subsistem audio kedua (`new Audio` tetap 1).

### aiLock balance (S5 — dibuktikan lewat penghitung test)

claim = tepat 1 `lockAI`; tiap terminal path = tepat 1 `unlockAI`:
selesai normal (T1/T4), preempt (T5/T14), model switch (T16). Callback
basi tidak pernah melepas lock rantai baru (T15) dan `maxConcurrentLocks`
terkunci = 1 (T11). Token = otoritas kepemilikan — tanpa refcount global.

### Model switch (S6)

`invalidateCapabilityProfile()` kini: abort request (Phase 16, tak diubah)
→ `_reqGen++` → `_endRequest()` → **`_cancelActiveUtterance()`** →
clear diversity state. Rantai model lama stop + unlock sekali; callback
speak model lama yang tiba setelah switch diabaikan (T17).

### Yang TIDAK diubah

- ParameterArbiter, MotionRuntime, RoleBridge, ProductionHandle/Cubism/
  renderer, MotionRegistry/Taxonomy/ModelProfile/CapabilityProfile,
  semantik request Phase 16 (timeout/abort/fallback), semantik P15.1–
  P15.5, protokol directive — nol perubahan (diff: brain.ts + app.js
  bridge + test + docs; sapuan statis bersih).
- Jujur dicatat: `speechSynthesis.cancel()` memotong audio yang SEDANG
  jalan di tengah kata (kebijakan "user menang"), dan pembatalan audio
  remote bergantung guard timer engine untuk cleanup penuh — keduanya
  perilaku existing yang dipakai, bukan baru.

### Tests: `test/utterance-ownership.test.ts` — 9 test / 63 assertion
memetakan skenario T1–T24, SEMUA lewat lifecycle async nyata (fake speak
menyimpan onDone dan TIDAK memanggilnya — persis kondisi audio di-swap;
zombie direproduksi dengan memanggil onDone basi lalu menunggu). Termasuk
regresi eksplisit failure lama: rantai A multi-segmen dipreempt → onDone
A telat fire → **segmen A kedua tidak pernah revive**, tidak pernah
addChat, tidak menyentuh lock rantai B. Test quality check: 3 asersi
perlu diperbaiki saat penulisan (kumulatifitas action parser + onDone
segmen terakhir) — keduanya perilaku existing yang benar, bukan bug.
P15/P16/P17 suite penuh tetap hijau tanpa satu guard dilonggarkan.

### Quality gates (final, satu rangkaian):
- `bun run test:unit`: **1324 pass / 0 fail** (68 file; +9 dari 1315)
- `bun run test:guards`: **411 pass / 0 fail** (7 suite)
- `bunx tsc --noEmit`: bersih; `bun run build`: bersih
- Browser smoke TIDAK dijalankan: bridge yang disentuh (`stopSpeech`) hanya
  termuat di halaman engine utama (app.js); suite smoke ada di pet/vtuber/
  compositor yang tidak memuat app.js — tidak ada smoke relevan.

### Klaim yang DITEPASKAN (tidak melebih): yang dijamin adalah ownership
rantai utterance di level AgentBrain (≤1 rantai aktif, callback basi
no-op, lock seimbang) — bukan klaim "race-free" global di luar itu.

### Commit: `ec5d164` fix(ai): own utterance playback lifecycle

---

## UPDATE 2026-09-16 (49) — Phase 17: CAPABILITY RE-SYNC INTEGRITY — VERIFIED

Phase 17 selesai diimplementasi dan diverifikasi. Status: **PHASE 17 — VERIFIED**.
**Phase 17 juga menutup temuan audit P16 "native motion registry race" (SISA Phase 11/12).**

### Bug yang ditutup (exact stale-clobber)

Sebelum: `initMotionRegistry()` membaca `state.caps.motionGroups` — dan
`hydrateCaps()` (dipanggil `getCapabilityProfile()`, reload editor, AI
classify) menimpa `caps.motionGroups` dari **scan-cache sheet di disk**.
Sheet v1-era (`motionGroups: []`, flag `_stale` hanya peringatan) yang
mendarat di antara `detectModelCapabilities()` (sinkron dari handle) dan
rantai async `loadMotionTaxonomy().then(initMotionRegistry)` menghasilkan
**registry native kosong sampai reload berikutnya** — padahal handle hidup
melaporkan grup. Ditambah: re-scan / classify / reload sheet dalam sesi tidak
pernah menyentuh registry sama sekali (harus reload halaman).

### Komponen

1. **S1 — live handle = sumber kebenaran grup native.** `initMotionRegistry()`
   kini mengambil `state.handle.motionGroups()` bila ada (handle throw →
   fallback aman); `state.caps` hanya fallback saat handle absen (jalur
   non-produksi). Sheet `[]` tidak BISA lagi menghapus grup handle hidup.
   Klasifikasi taksonomi + `emotionCompatibility` + `clearNativeMotions()`
   tidak berubah. Tidak ada registry kedua; MotionRuntime tidak disentuh.

2. **S2 — SATU seam `resyncCapabilities(reason)`** (dekat `initMotionRegistry`
   di app.js): urutan identik rantai loadModel — `loadMotionTaxonomy()` →
   `initMotionRegistry()` → `window.__agent.invalidateCapabilityProfile()`.
   Dipasang HANYA di jalur pengubah kapabilitas: re-scan (`#btn-inspect`),
   AI-classify selesai (hanya saat `changed`), reload sheet dari editor.
   `persistSheet()` TETAP invalidate-saja — preset/catatan adalah data brain,
   tidak menyentuh taxonomy/registry (dipisah sadar; dicek guard).

3. **S3 — generation guard, bukan state machine baru.** `let _taxonomyGen` —
   hanya generasi terakhir yang boleh menulis `state.motionTaxonomy`
   (termasuk jalur fallback name-only; `buildTaxonomyFromNames(myGen)`;
   pemanggil debug tanpa arg = perilaku lama). `let _resyncGen` — rantai
   resync yang lebih tua berhenti di setiap titik await, tidak bisa
   menimpa rantai yang lebih baru. Dibuktikan lewat fetch overlap sungguhan
   (A lambat + B cepat → akhir = B; A dibatalkan sebelum registry/brain).

4. **S6 — persistensi re-scan:** diaudit ulang — `inspectModel()` SUDAH
   POST `/api/sheet` (localStorage saja tidak; klaim audit lama "hanya
   localStorage" salah — POST ada di ekornya). Mekanisme persistensi tetap
   SATU; tidak ada endpoint kedua.

5. **S7 — `state.modelExpressions = []`** kini ikut di-reset di teardown
   `loadModel` (sebelumnya di-overwrite di detect tanpa reset eksplisit).

6. **Brain convergence:** seam memanggil `invalidateCapabilityProfile()` →
   Phase 16 guard (`_reqGen`) otomatis membatalkan request in-flight;
   `think()` berikutnya lazy-reload `getCapabilityProfile()` → katalog native
   = registry terkini. Dibuktikan end-to-end lewat AgentBrain nyata + profil
   berganti versi (test S5).

### Yang TIDAK diubah

- ParameterArbiter, MotionRuntime, RoleBridge, ProductionHandle/renderer,
  MotionTaxonomy internal, MotionRegistry API, protokol `[ACC:]`, prompt
  P14/P15, lifecycle Phase 16 — nol perubahan (diff = app.js +75/−4 + test
  baru; sapuan statis dikonfirmasi).
- Jendela kecil tetap ada dan jujur dicatat: native model LAMA masih bisa
  berada di registry antara destroy handle dan `initMotionRegistry()` model
  baru (perilaku Phase 11 — konvergensi dijamin rantai loadModel; bukan
  diklaim "race-free", yang diklaim adalah generasi terakhir menang untuk
  taxonomy/resync dan stale-clobber sheet tidak mungkin lagi).

### Tests: `test/capability-resync.test.ts` — 12 test, PERILAKU NYATA lewat
ekstraksi-sumber app.js + vm (pola `arbiter-stage3`), bukan string-match:
stale sheet vs handle hidup, fallback tanpa handle, handle melempar,
regresi emotionCompatibility, ren→lumine→ren tanpa kebocoran native,
user motion server-list selamat, taksonomi overlap A-lambat/B-cepat,
resync overlap + invalidate terpanggil, brain convergence penuh, guard
wiring + teardown.

### Quality gates (final, satu rangkaian):
- `bun run test:unit`: **1315 pass / 0 fail** (67 file)
- `bun run test:guards`: **411 pass / 0 fail** (7 suite)
- `bunx tsc --noEmit`: bersih; `bun run build`: bersih
- Regression P15/P16 suites: hijau (tidak ada yang dilonggarkan)
- Browser smoke tidak relevan untuk jalur ini (perubahan di jalur app.js UI;
  pet/vtuber smoke tidak memuat app.js) — tidak dijalankan.

### Commit: `ce30978` feat(live2d): harden capability resync

---

## UPDATE 2026-09-15 (48) — Phase 16: AGENT REQUEST LIFECYCLE RESILIENCE — VERIFIED

Phase 16 selesai diimplementasi dan diverifikasi. Status: **PHASE 16 — VERIFIED**.

Request LLM di `AgentBrain` tidak bisa lagi membuat agent macet permanen.

### Failure mode yang ditutup (sebelum Phase 16):

`fetch()` klien→server yang tidak pernah settle → `finally` tak pernah jalan →
`busy` tetap `true` selamanya → semua `think()`/`reactEvent()` berikutnya
di-block → agent diam total sampai reload.

### Komponen yang diimplementasi (semua di `brain.ts`, nol dependensi baru):

1. **SATU `AbortController` per request aktif** (`_reqCtrl`) — hanya ada
   selama request hidup, dibersihkan di `finally`. think() dan reactEvent()
   dijamin tidak pernah overlap oleh guard `busy` yang SUDAH ada, jadi satu
   controller cukup; tidak ada state machine kedua.

2. **Timeout bounded** (`LLM_REQUEST_TIMEOUT_MS = 90_000`, konstanta statis
   yang bisa dioverride test): `setTimeout` + `clearTimeout` manual (BUKAN
   `AbortSignal.timeout()`) — kompatibel penuh dengan target browser + Bun
   repo ini dan tidak menambah dependensi runtime. Timer timer hanya menyalakan
   `ctrl.abort()`. 90s sengaja longgar terhadap timeout idle server (60s di
   `shared/llm-client.ts`) — ia hanya terpicu kalau klien→server yang menggantung.
   Director request (`/api/animate-text`) ikut **signal controller induk**
   (opsional param `signal`), jadi satu abort mematikan seluruh rantai; abort
   dari lifecycle induk di-propagate naik supaya fallback tepat satu keluar di
   induk, bukan di director.

3. **Cleanup guarantee** — `_endRequest()` dipanggil PALING AWAL di blok
   `finally` `think()` dan `reactEvent()` (sebelum `setThinking(false)` dan
   `busy = false`), plus `invalidateCapabilityProfile()`. Di SEMUA jalur
   terminal (sukses, HTTP error, network error, AbortError, timeout, exception)
   busy lepas, thinking selesai, controller + timer nol.

4. **Model-switch cancellation + proteksi basi** — `invalidateCapabilityProfile()`
   kini meng-abort controller aktif DAN menaikkan generation counter `_reqGen`.
   Setelah SETIAP await (`resp.json()`, director pass), hasil dibuang bila
   generasi sudah naik / signal aborted — jadi provider/mock yang tetap resolve
   setelah abort pun tidak bisa memainkan segmen model lama ke model baru
   (dibuktikan test dengan fetch yang MENGABAIKAN signal). Pembatalan saat
   switch model = silent (tanpa fallback); timeout = satu fallback.

5. **Fallback semantics** — timeout/error memakai jalur yang SUDAH ada
   ("Maaf, aku lagi gak bisa mikir sekarang…"), tepat SATU pesan, tidak lewat
   parsing directive. Happy path tidak berubah.

### Interaksi Phase 15 (tidak ada semantik P15 yang diubah):

- P15.2 diversity hint: lifetime tetap hanya request proaktif; `finally` P16
  tetap membersihkannya — termasuk saat timeout (test kunci).
- P15.2 history: request timeout tidak mencatat apa pun.
- P15.5 `_lastProactiveAction`: timeout/abort TIDAK mencatat aksi palsu;
  reactEvent sukses tetap mencatat (test T13/T14).
- P15.1/P15.3/P15.4: prompt/context tidak disentuh (regression T21–T24).
- Cooldown `busy` tetap autoritatif; think(A)+think(B) tetap silent-drop (T20).

### Yang TIDAK diubah:

- ParameterArbiter, MotionRuntime, RoleBridge, renderer, Cubism,
  ModelProfile/CapabilityProfile — tidak tersentuh (nol perubahan file di
  luar `brain.ts` + test; dicek via diff sweep).
- `loadProfile()` (`/api/config`) sengaja TIDAK diberi timeout — bukan request
  LLM dan terjadi SEBELUM `busy` diset, jadi tidak bisa mewedge; dicatat,
  bukan dilupakan.
- Tidak ada sistem request-management generik, tidak ada memori/behavior
  engine baru.

### Tests: `test/request-lifecycle.test.ts` — 20 test (checklist T1–T25),
semua pakai fetch yang benar-benar tidak settle (reject hanya via signal) —
bukan simulasi throw instan. Termasuk recovery chain inti:
timeout → cleanup → think() berikutnya → SUKSES.

### Quality gates:
- `bun run test:unit`: **1303 pass / 0 fail** (66 file; +20 dari 1283)
- `bun run test:guards`: **411 pass / 0 fail** (7 suite)
- `bunx tsc --noEmit`: bersih
- `bun run build`: bersih
- Phase 15 suites (diversity/bridge/director/classifier/phase14): hijau semua

### Commit: `c677bd4` feat(ai): bound agent LLM request lifecycle
### Verifikasi: audit statis diff — tidak ada referensi renderer/Cubism/Arbiter/
MotionRuntime/RoleBridge/ModelProfile yang masuk; tidak ada import baru di brain.ts.

---

## UPDATE 2026-09-15 (47) — Phase 15.5: POST-PROACTIVE CONTEXT BRIDGE — VERIFIED

Phase 15.5 selesai diimplementasi dan diverifikasi. Status: **P15.5 VERIFIED**.
**Phase 15 SELESAI (P15.1–P15.5 semua VERIFIED).**

Perilaku proaktif terakhir yang dieksekusi kini di-bridge ke konteks Speaker LLM berikutnya.

### Komponen yang diimplementasi:

1. **`_lastProactiveAction`** (brain.ts): Field `string | null` — menyimpan format semantic `"emotion + gesture"` dari segmen proaktif pertama yang benar-benar dieksekusi. Bounded: hanya 1 string.

2. **`_recordLastProactiveAction(segments)`**: Dipanggil SETELAH `playSegments()` di `reactEvent()` — hanya perilaku yang sampai di execution path yang dicatat. Extracts emotion + gesture dari segmen pertama.

3. **`contextBlock()` bridge**: Baris `Aksi proaktif terakhir: <action>` ditambahkan ke P15.1 behavioral context bila ada. Context tetap bounded (<=300 char gabungan).

4. **Model switch**: `_lastProactiveAction` di-clear di `_clearDiversityState()` (dipanggil `invalidateCapabilityProfile()`). Model baru tidak mewarisi perilaku model lama.

### Sumber kebenaran:
- `_lastProactiveAction`: direkam dari `segments[0].actions` SETELAH `playSegments()` — reliable execution boundary
- `contextBlock()`: reuse mekanisme P15.1, tambah 1 baris
- `directorContextBlock()` (P15.3): TIDAK terpengaruh — Director tetap tanpa proactive context

### Privacy boundary:
- Hanya semantic info: `"emotion + gesture"` (misal `"sedih + look_away_shy"`)
- Tidak mengekspos: raw Cubism param, parameter range, motion/exp file paths, renderer, ParameterArbiter, MotionRuntime

### Apa yang TIDAK diubah:
- P15.1 Speaker context — tetap utuh + bridge
- P15.2 proactive diversity — tetap independen, tidak di-expose ke Speaker
- P15.3 Director context — tidak terpengaruh
- P15.4 expression hints — tetap utuh
- ParameterArbiter, MotionRuntime, renderer, Cubism — tidak tersentuh
- Expression/motion selection — tidak berubah
- User-driven chat behavior — tidak terpengaruh

### Commit: `cc1c5a6` feat(ai): bridge proactive behavior into conversation context
### Verification: `1bc9a6c` test(ai): add P15.5 execution boundary verification tests
### Tests: 59 baru (total 1282 unit + 411 guard)

---

## UPDATE 2026-09-15 (46) — Phase 15.4: EXPRESSION HEURISTIC CLASSIFIER — VERIFIED

Phase 15.4 selesai diimplementasi dan diverifikasi. Status: **P15.4 VERIFIED**.

Classifier heuristic berbasis nama token ditambahkan untuk memberikan petunjuk semantik pada expression catalog yang sudah ada.

### Komponen yang diimplementasi:

1. **`expression-classifier.ts`** (module baru): Pure function `classifyExpressionName(name)` yang mengklasifikasikan nama expression berdasarkan token nama saja. Output: `{ emotion, confidence, evidence }`.

2. **Token mapping**: Peta token nama → emosi kanonik (Indonesia). Hanya token yang JELAS masuk:
   - happy/joy/smile → senang/tersenyum
   - sad/tear/cry → sedih
   - angry/rage/mad → kesal
   - surprised/shock → kaget
   - shy/blush → malu
   - confuse/dizzy → bingung
   - neutral/normal/default → normal
   - CJK: 怒→kesal, 泣→sedih, 悲→sedih, 驚→kaget (hanya arti unambiguous)

3. **`expressionHint(name)`**: Format compact untuk LLM prompt: `"exp_angry — emotion: kesal"` atau hanya nama bila UNKNOWN.

4. **Speaker prompt integration**: `buildSystemPrompt()` di brain.ts menggunakan `expressionHint()` untuk memformat setiap expression. Opaque names tetap tanpa annotation.

### Klasifikasi konservatif:
- **Semantic names** (exp_angry, exp_sad, exp_blush) → klasifikasikan
- **Opaque names** (exp_01, exp_02, exp_03) → UNKNOWN
- **Prop/costume names** (collar_blue, X_change, 呆猫, 拍照, 眼镜) → UNKNOWN
- **Ambiguous names** (exp_heart, exp_sparkling, exp_sweat) → UNKNOWN
- Token boundary mencegah false positive (shirt≠shy, danger≠angry)
- Negative tokens (unhappy) → UNKNOWN

### Real model verification:
- ren: exp_01..exp_05 → semua UNKNOWN ✓
- lumine: exp_angry→kesal, exp_sad→sedih, exp_tear→sedih, exp_blush→malu, exp_dizzy→bingung ✓
- lumine: collar_*, X_change, exp_heart, exp_sparkling → semua UNKNOWN ✓
- 神宮白子: 呆猫, 拍照, 眼镜, 围裙 → semua UNKNOWN ✓

### Apa yang TIDAK diubah:
- Expression selection, reorder, disable — tidak tersentuh
- ParameterArbiter, MotionRuntime, renderer — tidak tersentuh
- P15.1/P15.2/P15.3 — tetap utuh
- Director prompt — tidak mendapat expression info (konsisten sebelumnya)
- Opaque expressions tetap selectable by original name

### Commit: `25e5b61` feat(ai): add conservative expression semantics
### Tests: 89 baru (total 1223 unit + 411 guard)

---

## UPDATE 2026-09-15 (45) — Phase 15.3: DIRECTOR MOOD AWARENESS — VERIFIED

Phase 15.3 selesai diimplementasi dan diverifikasi. Status: **P15.3 VERIFIED**.

Animation Director kini menerima konteks perilaku (mood user + durasi sesi) lewat field `context` pada request body `/api/animate-text`.

### Komponen yang diimplementasi:

1. **`directorContextBlock()`** (brain.ts): Method publik yang menghasilkan blok konteks bounded (<=200 char) berisi:
   - Mood user (dihapus saat "normal" — konsisten dengan P15.1)
   - Durasi sesi (human-readable: `5m`, `1h 05m`)
   - Sumber kebenaran: `this.userMood` + `this.agentStart` (sama dengan P15.1)

2. **Client → Server** (brain.ts: `animateTextViaDirector`): Field `context` ditambahkan ke request body. Opsional — bila kosong, Director beroperasi tanpa batasan mood.

3. **Server → Director prompt** (server/index.ts: `handleAnimateText`): Context di-extract dari body, di-sanitize (max 200 char via `sanitizePersonaText`), dan di-inject ke Director prompt setelah persona block, sebelum TUGAS section.

### Privacy boundary:
- Tidak mengekspos: raw Cubism parameter, parameter range, model profile, renderer state, ParameterArbiter, MotionRuntime
- Tidak ada nama model spesifik, motion ID, atau expression ID
- Context murni mood + durasi — semantic, bukan technical

### Apa yang TIDAK diubah:
- P15.1 Speaker context (contextBlock) — tetap utuh, format konsisten
- P15.2 proactive diversity — tetap isolasi dari Director
- Model identity, control axes, native motion catalog, emotion/gesture capabilities — tetap utuh
- ParameterArbiter, MotionRuntime, renderer, Cubism — tidak tersentuh

### Commit: `cefb1bb` feat(ai): add mood context to animation director
### Tests: 38 baru (total 1134 unit + 411 guard)

---

## UPDATE 2026-09-15 (44) — Phase 15.2: PROACTIVE EVENT DIVERSITY — VERIFIED

Phase 15.2 selesai diimplementasi dan diverifikasi. Status: **P15.2 VERIFIED**.

Mekanisme diversity ditambahkan ke `AgentBrain` untuk mencegah pemilihan behavior/emosi yang sama berulang kali pada proactive events.

### Komponen yang diimplementasi:

1. **Diversity history** (`_diversityHistory`): Map<eventType, string[]> — sliding window max 3 entry per event type. Mencatat emotion+gesture pair (misal `senang+nod`) yang dipilih LLM.
2. **Diversity hint** (`diversityHint()`): Membaca history + kandidat (preferences ∪ emotions). Menghasilkan prompt `=== VARIASI PERILAKU ===` yang menyarankan variasi berbeda. Kandidat model-aware — tidak hardcode nama model atau motion ID.
3. **Recording** (`_recordProactiveBehavior()`): Dijalankan setelah `playSegments()` di `reactEvent()`. Mencatat emotion+gesture pair ke sliding window.
4. **Prompt injection**: Diversity hint di-set saat `reactEvent()` mulai, dipakai `buildSystemPrompt()` untuk request proaktif itu, lalu di-*clear* di blok `finally` `reactEvent()` setelah request selesai — sehingga tidak pernah bocor ke `think()` user berikutnya.
5. **Model switch isolation** (`_clearDiversityState()`): Dipanggil dari `invalidateCapabilityProfile()`. History model A tidak bocor ke model B.
6. **QA/debug exposure**: `diversityHistory` diekspos di `_reactiveState()`.

### Apa yang TIDAK diubah:
- ParameterArbiter, MotionRuntime, Live2D renderer/adapter — tidak tersentuh
- P15.1 structured context — tetap utuh
- User-driven chat/thinking (`think()`) — tidak terpengaruh
- Existing cooldown (busy, quietPeriod, idleSpeak, awaySpeak, returnSpeak) — tetap autoritatif
- Native motion catalog, emotion/gesture behavior — tetap utuh

### Commit: `948132d` feat(ai): diversify proactive behavior selection
### Tests: 38 baru (total 1096 unit + 411 guard)

---

## UPDATE 2026-09-15 (43) — Phase 15.1: STRUCTURED BEHAVIOR CONTEXT — VERIFIED

Phase 15.1 selesai diimplementasi dan diverifikasi. Status: **P15.1 VERIFIED**.

`contextBlock()` ditambahkan ke `AgentBrain` yang menyuntikkan state sesi ke system prompt pembicara:
- Mood user (dihapus saat "normal" untuk hemat token)
- Durasi sesi (human-readable: `5m`, `1h 05m`)
- Jumlah interaksi (pesan user di history)

Blok ini sendiri <=200 karakter; setelah P15.5 menambahkan baris "Aksi proaktif terakhir", total blok konteks perilaku <=300 karakter. Tidak mengekspos parameter Cubism, range, atau state engine.

### Commit: `2bc82e9` feat(ai): add structured behavior context to speaker prompt
### Tests: 19 baru (total 1058 unit + 411 guard)

---

## UPDATE 2026-09-15 (42) — Phase 14 Stage 2: NATIVE MOTION AI CATALOG — VERIFIED

Phase 14 Stage 2 selesai diverifikasi. Status: **PHASE 14 STAGE 2 — VERIFIED**.

Native motion semantic information (verb, compatibleEmotions, duration) sudah exposed ke Speaker LLM dan Motion Director tanpa membuat sistem motion kedua.

### Komponen yang diverifikasi:

1. **Native motion registry metadata** (`app.js:initMotionRegistry`): EMOTION_VERBS di-invert ke verb→emosi, setiap native clip mendapat emotionCompatibility dari verb klasifikasinya. Deterministik (0.7 tetap).
2. **Capability profile** (`app.js:getCapabilityProfile`): motionCatalog menyaring `source==="user" || source==="native"`, di-map via `summaryForLLM()`.
3. **summaryForLLM** (`motion-dsl.ts`): mengembalikan `{id, description, verb, tags, compatibleEmotions, source, duration}`.
4. **Speaker LLM prompt** (`brain.ts:motionCatalogBlock`): section "GERAKAN BAWAAN MODEL" menampilkan verb + compatibleEmotions + duration, dibatasi 30 entri.
5. **Motion Director** (`server/index.ts:handleAnimateText`): menerima native catalog, menampilkannya di director prompt dengan metadata semantic.
6. **Model switching**: `clearNativeMotions()` → rebuild taxonomy → rebuild capability profile. Model A catalog tidak terlihat setelah switch ke Model B.
7. **Model-agnostic**: Tidak ada hardcoded nama model. Semantic intent → active catalog → motion selection.

### Test (49 kasus, termasuk 2 tambahan baru):
- Native catalog berisi entries source:"native" ✓
- Native entries punya verb, compatibleEmotions, duration ✓
- User motion entries tetap utuh ✓
- Speaker prompt punya section NATIVE MOTIONS ✓
- Speaker prompt TIDAK punya raw Cubism parameter IDs ✓
- Motion Director menerima native catalog ✓
- Model switch → catalog berubah ✓
- Unknown native motion aman ✓
- Emotion → native motion selection tetap bekerja ✓
- Prompt-split existing tests hijau ✓

### Quality gates:
- `tsc --noEmit`: bersih
- `bun run build`: bersih
- `bun run test:unit`: 1039 pass, 0 fail
- `bun run test:guards`: 411 pass, 0 fail (26 suite)
- Static safety: tidak ada Cubism param ID bocor ke prompt, tidak ada hardcoded model name, tidak ada duplicate taxonomy/emotion mapping

### Commit:
- `7853077` feat(ai): expose native motion catalog to AI context (implementation)
- `318f811` test(ai): add native motion catalog safety and emotion selection tests

### Remaining Phase 14 gaps:
- Stage 3 (jika ada) belum didefinisikan

---

> Dokumen handoff sesi kerja. Tulis ulang/tambah sesuai perkembangan; jangan
> hapus keputusan yang masih berlaku. Kode yang dirujuk: sudah ter-commit di
> master (lihat daftar commit di bawah).

## UPDATE 2026-09-15 (41) — R9-4: VENDOR DELETION, CORE-LOG-SHIM A/B & PIXI8 AUDIT

Tahap implementasi R9-4 selesai dieksekusi dan diverifikasi secara menyeluruh dengan status **R9-4 VERIFIED**.
Vendor legacy Pixi6 (`pixi.6.5.10.min.js`) + pixi-live2d (`pixi-live2d-0.4.0.js`) terhapus fisik dari `static/js/` (deletion dilakukan sesi sebelumnya, dibuktikan tidak mengubah perilaku produksi), `core-log-shim.js` terbukti tidak diperlukan lewat A/B browser verification nyata lalu **dihapus permanen**, dan `pixi8-namespace.js` teraudit sebagai **dependensi produksi aktif** (bukan dead machinery).

### Ringkasan Pekerjaan R9-4:

1. **A/B Browser Verification core-log-shim (WAJIB NYATA — bukan static analysis):**
   - Harness baru `test/smoke-corelog-shim-ab.ts`: menjalankan 3 halaman produksi (index/pet/vtuber) × 2 model (ren=motions+expressions, lumine=physics-only 223 param) × 2 kondisi via CDP Chromium headless. Kondisi B menghapus tag shim lewat **interceptor server** (file fisik tak disentuh selama pengujian).
   - Kapabilitas diverifikasi per halaman×model: page boot, Core 6.0.1 (`Version.csmGetVersion`), Framework 5.3 (`__l2dFrameworkStarted`), adapter init (host+handle), load ren, load lumine, parameter read/write, native motion, expression + efek param nyata, gate EyeBlink/Breath/Physics, Focus, destroy/reload.
   - **Kondisi A (DENGAN shim): PASS semua, 0 console error.** **Kondisi B (TANPA shim): PASS semua, 0 console error.**
   - Probe expression divulkan detail teknisnya: `exp_02` menulis `ParamEyeLSmile=1` dengan fade-in easing-sine — sampel timing bervariasi (0.02–0.97) tapi **konvergensi identik 1.0000** di kedua kondisi (dibuktikan `poll-stabil` terpisah). Urutan yang benar: `stopAllMotions()` dulu (Idle ren men-drive EyeLSmile via kurva motion) sebelum `playExpression`.
   - **Putusan: shim TIDAK diperlukan** → `static/js/core-log-shim.js` dihapus permanen + seluruh referensi produksi (index/pet/vtuber) dan sandbox (r3–r7) dibersihkan. Alasan teknis: shim adalah first-writer-wins untuk slot log Core saat **DUA binding** (pixi-live2d era-4 + CubismFramework 5.3) memanggil `csmSetLogFunction`; setelah vendor Pixi6/pixi-live2d terhapus, hanya **satu** pemanggil tersisa (`CubismFramework.startUp`, sekali, ter-guard `__l2dFrameworkStarted`) — tak ada slot kedua yang bisa melempar "Unable to grow wasm table". Terbukti behavior di browser identik.

2. **Test disesuaikan dengan keputusan shim:**
   - `test/live2d-production.test.ts`: test "core-log-shim: first-writer-wins" diganti test penegakan **ketiadaan** shim di disk & HTML produksi; test urutan pemuatan `r3-coexist.html` diganti penegakan artefak historis (sandbox = bukan kontrak produk). 24/24 pass.

3. **PIXI8-Namespace Audit (consumer graph nyata):**
   - Simbol diekspor: `window.__compositor8` (PixiJS 8.20.1 terisolasi), `window.__compositor8Ready` (Promise), event `compositor8-ready`.
   - Konsumen produksi: `src/live2d/production-env.ts` (`compositor: () => g.__compositor8 ?? null` — duck-type env) → `src/live2d/production-host.ts` `bindHandle` mode `canvas-texture` (**throw tanpa compositor**) → ketiga halaman produksi `await window.__compositor8Ready` sebelum `createHost` (semuanya `composite: "canvas-texture"`).
   - **Kategori A: masih diperlukan produksi** — bagian integral jalur render (loader satu-satunya Pixi8). Mekanisme capture/restore `window.PIXI` kini sebagian over-engineered (tidak ada lagi Pixi6 untuk dipulihkan) tapi menghapusnya adalah refactor opsional, bukan scope R9-4. **Namespace dipertahankan.**

4. **Dead Tests Vendor (verifikasi ulang & finalisasi):**
   - `test/legacy/test-core6-compat.js` (guard PATCH 3 renderOrders pada `pixi-live2d-0.4.0.js` vendored) dan `test/legacy/test-multiply-color.js` (guard surgical patch multiplyColor pada lib yang sama) — keduanya membaca file vendor yang **sudah tidak ada di disk**, melindungi stack legacy yang sudah mati (produksi modern: CubismWebFramework 5.3 resmi menangani render order & multiplyColor native, tanpa patch). Tidak ada product invariant modern yang belum tercakup. **Tetap dihapus** (deletion sesi sebelumnya final). Guards turun 10→8 suite, 464→429 pass, semuanya hijau — selisih 35 = isi kedua test itu.

5. **Full Reference Scan (klasifikasi, bukan "zero references"):**
   - **Production runtime: ZERO dependensi vendor legacy.** `app.js` `coreModel()` = stub `return null`; `internalModel` hanya guard defensif yang selalu falsy di produksi; `src/client/engine/native-expressions.ts` = duck-type optional (safeRead); `coreModel` di `src/live2d/*` = nama konsep framework 5.3, bukan `internalModel.coreModel` Pixi6.
   - **Tests**: `r8-2-pet.test.ts`/`r8-3-vtuber.test.ts` menegaskan *ketiadaan* tag vendor (guard proteksi, bukan dependensi).
   - **Sandbox/readiness (historis)**: `r3-coexist`, `r4-frame`, `r5-motion`, `r6-parity`, `r7-compat`, `legacy-probe.html`, `pixi8.html`, `pixi8-official.html` — memuat referensi vendor yang fisiknya sudah terhapus (tidak bisa jalan; dipertahankan sebagai artefak sejarah/audit trail era transisi). `legacy-probe.html` = satu-satunya dead code murni (probe eksklusif Pixi6, tanpa consumer test) — diklasifikasikan, TIDAK dihapus di R9-4 (di luar scope).
   - **Docs/history**: entri STATUS sebelumnya + komentar penjelas sejarah di `pixi8-namespace.js`/`pixi8.html`.

6. **Quality Gates (final, satu rangkaian):**
   - `bun run build`: bersih.
   - `bunx tsc --noEmit`: 0 error.
   - `bun test` (unit): **996 passed / 0 failed** (60 file, 5064 expect).
   - `bun run test:guards`: **429 passed / 0 failed** (8 legacy suite — 2 suite vendor terhapus sesi lama).
   - `bun test/smoke-pet-browser.ts`: **6/6 PASSED** (boot, state produksi, mouseGaze→Arbiter, resize, motion via #b-wave, teardown/reload, ?renderer=legacy aman diabaikan).
   - `bun test/smoke-vtuber-browser.ts`: **7/7 PASSED** (termasuk resize OBS 1920×1080, transparansi body, lifecycle).
   - `bun test/smoke-corelog-shim-ab.ts` (pasca-hapus, double-run): **PASS semua** di 6 kombinasi halaman×model — Engine Main browser smoke + bukti stabilitas run ganda.
   - **BARU `test/smoke-compositor-dpr.ts`: 14/14 PASSED** — DPR1 & DPR2 (force-device-scale-factor): compositor v8 8.20.1 aktif, buffer fisik = CSS×DPR (942/1884), **transparansi terbukti via `gl.readPixels` pada kanvas GL host** (sudut alpha=0 murni — kebutuhan OBS; area model 19% piksel opaque dalam bbox — badan solid ter-render; `Page.captureScreenshot(omitBackground)` ternyata menghasilkan RGB opaque di headless, bukan bukti), paritas CSS bounds DPR1≈DPR2 **Δ 0.00px**.

7. **Kepatuhan Hard Constraints:**
   - Tidak ada commit/push/reset/checkout/git clean (semua perubahan dipertahankan di working tree).
   - `data/` tak tersentuh; tidak ada test yang memanggil jaringan atau menulis `config.json`.
   - Kapabilitas `Live2DModelHandle` utuh terbukti di browser pasca-semua-penghapusan: native motion (ren Idle), expression (exp_02 → EyeLSmile konvergen 1.0), EyeBlink/Breath/Physics gate, Focus, ParameterArbiter (mouseGaze pet), parameter read/write, destroy/reload, model switch ren→lumine.

## UPDATE 2026-09-14 (40) — R9-3: RETIRE LEGACY RENDERER FALLBACK

Tahap implementasi R9-3 selesai dieksekusi dan diverifikasi secara menyeluruh dengan status **R9-3 VERIFIED**.
Percabangan kode fallback renderer legacy (Pixi6 + pixi-live2d) telah sepenuhnya dieliminasi dari seluruh permukaan produk (Engine Main, Desktop Pet, dan VTuber Overlay). Production Cubism 5.3 / Core 6.0.1 renderer kini menjadi **satu-satunya runtime renderer aktif** di seluruh repositori.

### Ringkasan Pekerjaan R9-3:

1. **Eliminasi Fallback di `static/index.html` & `static/js/app.js` (Engine Main):**
   - Tag `<script>` legacy `pixi.6.5.10.min.js` dan `pixi-live2d-0.4.0.js` dihapus dari `static/index.html`.
   - Percabangan fallback di `app.js` dibersihkan:
     - `getOfficialGroups(m)`: langsung mengambil dari `state.handle.motionGroups()`.
     - `resetEmotion()`: memanggil `state.handle.resetExpression()`.
     - `detectModelCapabilities()`: seluruh probing legacy via `coreModel()` dan private properties dihapus, digantikan pembacaan resmi via `state.handle`.
     - `freezeModelForEdit()` / `unfreezeModelForEdit()`: mengendalikan efek langsung via `state.handle.setEffectEnabled(...)`.
     - `releasePresetPose()` & `applyPreset()`: pemulihan part opacity dan parameter default berjalan murni via `state.handle`.
     - `readAny()` & `captureCurrentPose()`: pembacaan opacity part melalui `state.handle.getPartOpacity(id)`.
     - `setPartOpacity()`: penulisan via `state.handle.setPartOpacity(id, v)`.
     - `diagnostics()`: mengembalikan diagnostik produksi murni secara tak bersyarat.
     - `applyStageBackground()`, `fitStageBgImage()`, `removeStageBgImage()`: beroperasi langsung pada DOM `#stage` dan `state.sceneLayers` (0 penggunaan PIXI.Sprite/Graphics).
     - `inspectModel()`: enumerasi parameter dan grup motion murni via `state.handle`.
     - `enumerateParts()` & `readParam()`: membaca langsung dari `state.handle`.
     - `applyRawDrive()`, `setRawDrive()`, `clearRawDrive()`, `listModelParams()`: beroperasi via `state.roleLink` dan `state.handle`.
     - `_rawDrive`: `hasCore: false`.

2. **Eliminasi Fallback di `static/pet.html` (Desktop Pet):**
   - Tag `<script>` legacy `pixi.6.5.10.min.js` dan `pixi-live2d-0.4.0.js` dihapus dari `static/pet.html`.
   - Jalur runtime dibuat tanpa syarat produksi (`production: true`).
   - Seluruh blok fallback `else` yang memanggil `new PIXI.Application`, `PIXI.live2d.Live2DModel.registerTicker`, dan `PIXI.live2d.Live2DModel.from` dihapus total.
   - Parameter URL `?renderer=legacy` kini diabaikan secara aman dengan pesan informatif: `"[pet] ?renderer=legacy parameter is retired in R9-3; using production Cubism renderer unconditionally."`.
   - Zero coupling ke `internalModel`, `coreModel`, atau `PIXI`.

3. **Eliminasi Fallback di `static/vtuber.html` (VTuber Overlay):**
   - Tag `<script>` legacy `pixi.6.5.10.min.js` dan `pixi-live2d-0.4.0.js` dihapus dari `static/vtuber.html`.
   - Jalur runtime dibuat tanpa syarat produksi (`production: true`).
   - Seluruh blok fallback `else` yang memanggil `new PIXI.Application`, `registerTicker`, dan `from` dieliminasi total.
   - Parameter URL `?renderer=legacy` diabaikan secara aman dengan pesan informatif: `"[vtuber] ?renderer=legacy parameter is retired in R9-3; using production Cubism renderer unconditionally."`.
   - Zero coupling ke `internalModel`, `coreModel`, atau `PIXI`.

4. **Kepatuhan Hard Constraints & Invarian Masa Depan:**
   - File vendor fisik `pixi.6.5.10.min.js` dan `pixi-live2d-0.4.0.js` **TIDAK dihapus** pada tahap ini (ditangguhkan hingga R9-4).
   - `core-log-shim.js` dan `pixi8-namespace.js` **TIDAK diubah/disederhanakan** pada tahap ini.
   - Seluruh kapabilitas masa depan `Live2DModelHandle` (native motions, motion groups, expressions, ParameterArbiter, lip sync role, focus/gaze) tetap utuh dan beroperasi sempurna.
   - Tidak ada commit atau push yang dilakukan.

5. **Hasil Pengujian & Quality Gate:**
   - `bun run test:unit`: **996 passed / 0 failed** (60 files, 5064 expect calls).
   - `bun run test:guards`: **464 passed / 0 failed** (10 legacy suites).
   - `bunx tsc --noEmit`: Bersih (0 errors).
   - `bun run build`: Bersih (bundle.js, i18n.js, live2d adapters ter-bundle sempurna).
   - `bun test/smoke-pet-browser.ts`: 6/6 test Chromium headless **PASSED**.
   - `bun test/smoke-vtuber-browser.ts`: 7/7 test Chromium headless **PASSED**.

---

## UPDATE 2026-09-14 (39) — R9-1 & R9-2: ACCIDENTAL COUPLING FIX & PRODUCTION GUARD TEST MIGRATION

Tahap implementasi R9-1 dan R9-2 selesai dieksekusi dan diverifikasi dengan status **R9-1 + R9-2 VERIFIED**.

### Ringkasan Pekerjaan R9-1 & R9-2:

1. **R9-1: Perbaikan Accidental Production Coupling pada `releasePresetPose` (`static/js/app.js`):**
   - Pada `releasePresetPose()` (sebelumnya bernama `releaseAllPresetPoses` pada prompt), baris awal `const cm = state.model.internalModel.coreModel;` menimbulkan coupling langsung ke `internalModel` Pixi6 di jalur produksi.
   - Evaluasi diubah: percabangan `if (state.production && state.handle)` dievaluasi terlebih dahulu tanpa menyentuh properti `internalModel`. Parameter dibaca langsung via `state.handle.getParameters()` dan dituliskan kembali ke nilai default via `pokeActual(p.id, p.defaultValue)`.
   - Percabangan legacy (`else`) tetap aman membaca `state.model && state.model.internalModel ? state.model.internalModel.coreModel : null`.
   - Terbukti secara behavior melalui `test/r9-1-release-preset.test.ts` (4 pass, 22 assertions) dengan trap getter pada `internalModel` dan WASM real boot model `ren`.

2. **R9-2: Migrasi 7 Suite Guard Produksi ke Bun Test:**
   - 7 test guard yang menguji fungsionalitas produksi (bukan vendor legacy) dimigrasikan ke unit test TS modern:
     1. `test/api-origin.test.ts` (dari `test/legacy/test-api-origin.js`): 6 pass / 23 assertions.
     2. `test/auto-rescue.test.ts` (dari `test/legacy/test-auto-rescue.js`): 4 pass / 24 assertions.
     3. `test/emotion-overlay.test.ts` (dari `test/legacy/test-emotion-overlay.js`): 5 pass / 36 assertions.
     4. `test/exp3-adoption.test.ts` (dari `test/legacy/test-exp3-adoption.ts`): 13 pass / 74 assertions.
     5. `test/sheet-schema.test.ts` (dari `test/legacy/test-fase1-sheet-schema.js`): 220 pass / 220 assertions (100% exact parity).
     6. `test/overlay-gate.test.ts` (dari `test/legacy/test-overlay-gate.ts`): 5 pass / 28 assertions.
     7. `test/param-notes-ui.test.ts` (dari `test/legacy/test-param-notes-ui.js`): 26 pass / 26 assertions.
   - Paritas pengujian dipertahankan 100% tanpa ada assertion yang dibuang.
   - File lama di `test/legacy/` tetap dipertahankan dan tetap lolos (`test:guards` 464/464 pass) sesuai instruksi koreksi pengguna.

3. **Status Quality Gate:**
   - `bun run test:unit`: **996 passed / 0 failed** (naik dari 713, 5069 expect calls).
   - `bun run test:guards`: **464 passed / 0 failed** (10 legacy suites).
   - `bunx tsc --noEmit`: Bersih (0 error).
   - `bun run build`: Bersih (0 error).

---

## UPDATE 2026-09-14 (38) — R8-3: MIGRATE STATIC/VTUBER.HTML TO PRODUCTION CUBISM RENDERER

Tahap R8-3 selesai dieksekusi dan diverifikasi secara menyeluruh dengan status **R8-3 VERIFIED**.
`static/vtuber.html` (overlay OBS Browser Source) kini menggunakan Production Cubism 5.3/Core 6.0.1 renderer sebagai default stack (`Live2DApi` → `Live2DHost` → `Live2DModelHandle` → `CubismWebFramework 5.3` → `Cubism Core 6.0.1` → `Pixi8 compositor` via `canvas-texture`). Percabangan fallback `?renderer=legacy` tetap dipertahankan terisolasi untuk perbandingan A/B. Seluruh kapabilitas masa depan (motion native, ekspresi, gesture, parameter arbiter, lip-sync audio, focus) tetap terbuka dan teruji.

### Ringkasan Perubahan R8-3

1. **Arsitektur Produksi di `static/vtuber.html`:**
   - Memuat stack resmi: `live2dcubismcore.min.js`, `core-log-shim.js`, `cubism-framework.js`, `live2d-adapter.js`, `scene-layers.js`, `pixi8-namespace.js`, dan `bundle.js`.
   - Script legacy (`pixi.6.5.10.min.js` dan `pixi-live2d-0.4.0.js`) diisolasi hanya untuk percabangan fallback `?renderer=legacy`.
   - Menghapus kepemilikan frame tersembunyi `PIXI.Ticker.shared` dan menggantinya dengan render loop tunggal `requestAnimationFrame` eksplisit: tepat 1 `handle.update(dt)` dan 1 `host.render()` per frame.
   - Rotasi idle `Math.sin(state.swayTime * 0.9) * 0.012` dipindahkan ke dalam loop RAF, menghilangkan timer 16ms terpisah.
2. **Model-Agnostic Lip-Sync & Parameter Control:**
   - Menghilangkan direct write `core.setParameterValueById("ParamMouthOpenY", ...)`.
   - Kontrol bibir dialihkan melalui `ParameterArbiter` via semantic role `mouthOpenY` (prioritas 15), dikomit pada callback `handle.onBeforeModelUpdate` via `RoleBridge`.
   - Mendukung browser TTS pulse dan remote `AudioLipSync.sample()` yang disampel langsung di loop RAF.
3. **Kesiapan Kapabilitas Masa Depan (Future Capability Readiness):**
   - Tidak membatasi fitur hanya pada kebutuhan overlay hari ini.
   - `Live2DModelHandle` tetap mengekspos `motionGroups()`, `playNativeMotion(group, no, priority)`, `isMotionFinished()`, `stopAllMotions()`, `playExpression(name)`, `setFocus(x, y)`, dan `setParameter(id, val)`.
   - Telah dibuktikan di Chromium melalui model `ren.model3.json`: `playNativeMotion("Idle", 0)` dan `playExpression("exp_02")` terbukti menghasilkan deformasi parameter visual nyata (`ParamEyeLSmile > 0`). Pemanggilan grup/ekspresi asing terbukti fail-safe tanpa melempar error.
4. **Transform, Bounds, dan Resize Parity:**
   - Implementasi `createCompatModel(handle)` POJO murni bebas dari `PIXI.Point`.
   - Paritas geometri terbukti di Chromium headless: selisih bounds legacy vs produksi hanya Δwidth=0.10px, Δheight=0.06px, Δx=0.10px, Δy=0.00px (< 0.15px).
   - Penanganan `window.addEventListener("resize")` ditambahkan untuk memperbarui ukuran host (`host.resize(W, H)`) dan reframes model tanpa distorsi pada berbagai resolusi OBS (1080p, 720p, portrait) serta DPR 1 dan DPR 2.
5. **Transparansi OBS & Siklus Hidup:**
   - Transparansi WebGL canvas (`backgroundAlpha: 0`) terbukti menghasilkan latar belakang transparan murni untuk OBS Browser Source.
   - Implementasi `teardownCurrentModel()` dan `teardown()` membersihkan host, handle, RAF, dan timer tanpa kebocoran.
6. **Quality Gates & Pengujian:**
   - `test/r8-3-vtuber.test.ts`: 22 unit test baru (audit dependensi, kepemilikan frame exactly-once, lip-sync role mapping, paritas transform, lifecycle, dan kesiapan kapabilitas masa depan).
   - `test/smoke-vtuber-browser.ts`: 7 uji smoke test Chromium headless via CDP memverifikasi boot produksi, idle sway, lip-sync arbiter, deformasi motion/ekspresi nyata, resize OBS 1080p, teardown/reload, dan komparasi A/B.
   - `bun run test:unit`: **713 passed / 0 failed** (naik dari 691).
   - `bun run test:guards`: **464 passed / 0 failed** (10 legacy suites).
   - `bunx tsc --noEmit`: Bersih (0 error).
   - `bun run build`: Bersih (0 error).

---

## UPDATE 2026-09-14 (37) — R8-2: MIGRATE STATIC/PET.HTML TO PRODUCTION CUBISM RENDERER

Tahap R8-2 selesai dieksekusi dan diverifikasi secara menyeluruh dengan status **R8-2 VERIFIED**.
`static/pet.html` kini menggunakan Production Cubism 5.3/Core 6.0.1 renderer sebagai default, menggunakan arsitektur verified R2–R7 (`Live2DApi` → `Live2DHost` → `Live2DModelHandle` → `CubismWebFramework 5.3` → `Cubism Core 6.0.1` → `Pixi8 compositor` via `canvas-texture`). Percabangan legacy (`?renderer=legacy`) tetap utuh untuk A/B comparison.

### Ringkasan Perubahan R8-2

1. **Arsitektur Produksi di `static/pet.html`:**
   - Memuat stack resmi: `live2dcubismcore.min.js`, `core-log-shim.js`, `cubism-framework.js`, `live2d-adapter.js`, `scene-layers.js`, `pixi8-namespace.js`, `bundle.js`, `i18n.js`.
   - Script legacy (`pixi.6.5.10.min.js` dan `pixi-live2d-0.4.0.js`) dipertahankan terisolasi hanya untuk parameter URL `?renderer=legacy`.
   - Pemilik frame eksplisit: render loop `requestAnimationFrame` tunggal yang memanggil `handle.update(dt)` dan `host.render()`. Tidak ada dependensi ke `PIXI.Ticker.shared` pada jalur produksi.
2. **Transform, Bounds, dan Resize Parity:**
   - Implementasi `createCompatModel(handle)` yang bersih dan bebas PIXI.
   - Paritas geometri terbukti di browser nyata Chromium (headless): selisih bounds legacy vs produksi hanya Δwidth=0.09px, Δheight=0.05px, Δx=0.09px, Δy=0.00px (< 0.1px).
   - Penanganan `resize` otomatis memperbarui ukuran host dan reframes model tanpa distorsi atau pergeseran geometri pada DPR 1 maupun DPR 2.
3. **Interaksi Kursor & Parameter Writes:**
   - Menghilangkan direct write `coreModel.setParameterValueById(...)`.
   - Interaksi tatapan (`mousemove`) kini menggunakan `state.arbiter.submit({ channel: "mouseGaze", priority: 10, domain: "role", values: { angleX, angleY, eyeBallX, eyeBallY } })` dan dikomit di slot `handle.onBeforeModelUpdate`. Parameter ditulis melalui `state.roleLink.bridge.writeRef` model-agnostic.
4. **Motion & Lifecycle:**
   - Tombol "Sapa" (`#b-wave`) menggunakan `handle.playNativeMotion("TapBody", -1, 3)` dengan fallback grup yang aman.
   - Teardown model dan full window teardown membersihkan host, handle, dan listener tanpa meninggalkan kebocoran atau callback basi.
5. **Quality Gates & Pengujian:**
   - `test/r8-2-pet.test.ts`: 17 unit test baru (audit dependensi statis, paritas geometri, kepemilikan frame exactly-once, interaksi arbiter, siklus hidup reload, dan penanganan kegagalan aman).
   - `test/smoke-pet-browser.ts`: smoke test Chromium headless via CDP memverifikasi boot produksi, interaksi pointer, resize, trigger motion, siklus hidup teardown/reload, dan komparasi A/B terhadap fallback legacy.
   - `bun run test:unit`: **691 passed / 0 failed** (naik dari 674).
   - `bun run test:guards`: **464 passed / 0 failed** (10 legacy suites).
   - `bunx tsc --noEmit`: Bersih (0 error).
   - `bun run build`: Bersih (0 error).

---

## UPDATE 2026-09-14 (36) — R8-1: DECOUPLE ACCIDENTAL LEGACY DEPENDENCIES IN ENGINE MAIN

R8-1 selesai diverifikasi dengan status **R8-1 VERIFIED**.
Ketergantungan legacy yang menyusup ke jalur produksi ENGINE MAIN telah didekopel secara bersih tanpa merusak fallback legacy (`?renderer=legacy`) dan tanpa menghapus file vendor.

### Ringkasan Perubahan R8-1

1. **Dekopel `PIXI.Point`:**
   - `createCompatModel` method `toGlobal(p)` dan `toLocal(p)` kini mengembalikan POJO mandiri `{ x, y }`.
   - Call site di `mousemove` eye-tracking (L1517) dan `setScaleAroundPoint` zoom (L1574) memanggil `toGlobal`/`toLocal` menggunakan POJO `{ x, y }`.
   - `PIXI.Point` di `static/js/app.js` kini **0 (ZERO)**.
2. **Perbaikan Lifecycle Delete Model Aktif:**
   - Handler delete model di drawer (`app.js:3865`) kini memiliki percabangan produksi yang benar: memanggil `state.host.remove(state.handle)`, `state.handle.destroy()`, mengosongkan handle, arbiter, dan state terkait.
   - Tidak lagi memanggil `app.stage.removeChild` atau mengandalkan Proxy throw di jalur produksi. Cabang legacy tetap memanggil `app.stage.removeChild(state.model)` dan `state.model.destroy(...)`.
3. **Pembersihan Background Color Coupling:**
   - `applyStageBackground` (`app.js:8317`) mencabangkan `if (state.production)` sebelum menyentuh `app.renderer`.
   - Warna latar diatur langsung ke `#stage.style.backgroundColor`, dan gambar latar/dim didelegasikan ke `L2DSceneLayers` DOM. `app.renderer._backgroundColor` tidak lagi dicemari di jalur produksi.
4. **Regression & Guard Coverage:**
   - `test/compat-model-scale.test.ts`: sandbox tidak lagi memerlukan mock `PIXI.Point` (18 pass).
   - `test/r8-1-decouple.test.ts`: suite baru memverifikasi sweep statis 0 `PIXI.Point`, lifecycle delete model produksi & legacy, serta isolasi background (5 pass).

### Quality Gate Baseline R8-1

| Check | Result |
|---|---|
| `bun run test:unit` | **674 pass / 0 fail** (4430 expect, 50 file) |
| `bun run test:guards` | **464 pass / 0 fail** (10 suite) |
| `bunx tsc --noEmit` | bersih (exit 0) |
| `bun run build` | bersih (exit 0) |

---

## UPDATE 2026-09-13 (35) — R7-2 FINAL VERIFICATION: READY WITH ENVIRONMENT GAP

Seluruh 14 task R7-2 final verification selesai diverifikasi (13 task
dari rencana asli + task STATUS update ini). Semua perbaikan yang tercatat
di entry (34) sudah dikonfirmasi dan baseline akhir bersih.

### Final baseline

| Check | Result |
|-------|--------|
| `bun run test:unit` | **666 pass / 0 fail** (4395 expect) |
| `bun run test:guards` | **464 pass / 0 fail** (10 suite) |
| `bunx tsc --noEmit` | bersih (exit 0) |
| `bun run build` | bersih (bundle.js + i18n.js + cubism-framework.js + ...) |

### Koreksi entry 34: guard "pre-existing" → REGRESI R7-2 (SUDAH DIPERBAIKI)

Entry 34 mencatat "462 guard pass / 1 fail pre-existing" untuk
`releasePresetPose menghapus override` — menyebutnya "bukan regresi
R7-2". Klaim itu **SALAH** dan sudah dibuktikan salah:

- **Bukti char-distance:** diff `app.js` HEAD vs worktree menunjukkan
  `releasePresetPose` berubah +254 baris net → pasti bukan
  "sebelum perubahan".
- **Guard test sebelum fix:** 462 pass / 1 fail
- **Guard test sesudah fix:** 464 pass / 0 fail (regex widened dari
  `{0,1400}` ke `{0,2000}` + production branch assertion ditambahkan)
- **Kesimpulan:** guard failure adalah REGRESI R7-2, bukan
  pre-existing. Sudah diperbaiki dan terverifikasi hijau.

### Ringkasan seluruh 13 task verifikasi

| Task | Hasil |
|------|-------|
| 1. Guard regex fix (`releasePresetPose`) | ✅ PASS — 464/0 (bukan pre-existing, sudah diperbaiki) |
| 2. Scale facade setter fix (`createCompatModel`) | ✅ PASS — 15/15 regress tests (compat-model-scale.test.ts) |
| 3. `frameModel` via facade — natW/natH terbaca | ✅ PASS — scale.y accessible, validSize true |
| 4. `measureLitBounds()` non-null | ✅ PASS — bbox 213×668 (canvas 801×699) |
| 5. Emotion overlay spawn | ✅ PASS — `applyExpression('senang')` → particles 4→5, sparkle di DOM |
| 6. `__l2dDebug` getter live | ✅ PASS — host/renderer dibaca per akses, bukan snapshot |
| 7. No duplicate frame loop | ✅ PASS — compositorTickerStarted:false, renders=composites 1:1 |
| 8. Resize + DPR wiring | ✅ PASS — host.resize + frameModel, DPR auto-convert |
| 9. Emotion overlay anchor numerik | ✅ PASS — prodMeasureHead s=1 @DPR1, sparkle x=426 ∈ range |
| 10. `tsc --noEmit` bersih | ✅ PASS |
| 11. `bun run test` hijau | ✅ PASS — 666 unit + 464 guard |
| 12. Model switch ren→lumine→ren | ✅ PASS — round-trip diagnostics exact match |
| 13. Legacy fallback `?renderer=legacy` | ✅ READY WITH ENVIRONMENT GAP (see below) |

### Task 13 — Legacy fallback: READY WITH ENVIRONMENT GAP

**Verdict:** pixi-live2d 0.4.0 legacy pipeline **BERFUNGSI** di atas
meja; lingkungan IAB (extension headless Chrome) memblokir rAF callback
sehingga canvas kosong. Ini ENVIRONMENT GAP, bukan regression R7-2.

**Bukti langkah-demi-langkah:**

1. `state.production = false` untuk `?renderer=legacy` — source + runtime
   dikonfirmasi.
2. Legacy `app = new PIXI.Application({...})` dengan ticker asli.
3. `Live2DModel.from(modelPath)` panggilan **IDENTIK** ke HEAD (diff
   dikonfirmasi).
4. `buildModelSettings` **IDENTIK** ke HEAD (diff dikonfirmasi).
5. Boot `loadModel` COMPLETED: loader "done", `state.model` set,
   sheet/avatar/motions fetched.
6. 0 non-zero pixels → rAF frozen di IAB (0 callbacks in 800ms, 0
   render calls in 1s).
7. `preserveDrawingBuffer: false` (PIXI default v6) → readPixels
   returns 0 setelah compositing.
8. Force render: `renderer.render(state.model.parent)` → **87,743
   non-zero pixels** (15.7% framebuffer coverage).
9. Model fully loaded: internalModel ✓, coreModel ✓, visible:true,
   alpha:1, valid dimensions (545×734).
10. Isolation test: `Live2DModel.from()` dipanggil langsung dari page
    → resolved in 46ms, fetched texture_00.png (4.2MB), physics3.json,
    mtn_01.motion3.json — pixi-live2d bebenar.

**Lingkungan limitation:** IAB extension Chrome headless memblokir
requestAnimationFrame di background tabs. Ini mempengaruhi KEDUA
pipeline (production & legacy). Pipeline production sudah punya
workaround: manual `handle.update()` + `host.render()` di startIdle rAF
(STATUS 31-33). Pipeline legacy mengandalkan `app.ticker` yang
dirottah oleh requestAnimationFrame — di IAB tabs, ticker berhenti
berjalan, sehingga `renderer.render()` tidak dipanggil, canvas tetap
kosong setelah compositing (`preserveDrawingBuffer: false`).

**Impact:** Ketika user membuka `?renderer=legacy` di browser biasa
(dengan requestAnimationFrame aktif), model akan tampil normal. IAB
tabs adalah lingkungan testing yang membatasi.

### Sisa/terbuka (post-R7-2)

1. rAF suppression di IAB tabs — sudah didokumentasikan untuk
   production (STATUS 31-33) dan sekarang juga untuk legacy (entry ini).
   Tidak ada fix yang diperlukan; ini adalah limitation lingkungan.
2. `__l2dDebug` tidak mengekspos `fireOverlay` sebagai properti
   (sudah di entry 34, bukan blocker).

### Files touched (R7-2 final verification)

- `test/legacy/test-param-notes-ui.js` — guard regex widened + production branch assertion
- `static/js/app.js` — `createCompatModel` scale facade fix (di entry 34)

---

## UPDATE 2026-09-13 (34) — R7-2 VERIFIKASI EFEK: DUA ROOT CAUSE OVERLAY TERKONFIRMASI + FIX COMPAT SCALE (BELUM COMMIT)

R7-2 (verification blocker "emotion overlay tidak spawn" +
"measureLitBounds() null" di ENGINE MAIN) selesai diverifikasi. Metodologi
A/B isolation (host vs handle vs model data) — semua hipotesis dibuktikan
sebelum difix, NOL perubahan ParameterArbiter/MotionRuntime/R4/R5/R6/R7-1/
legacy fallback (sesuai batasan verifikasi).

**ROOT CAUSE #1 (FIXED — fix getter):** `window.__l2dDebug` diinisialisasi
sebagai snapshot saat boot — `state.host` dibaca SEBELUM `loadModel()` async
membuat host → `__l2dDebug.host` terkunci `null` selamanya. Emotion-overlay
`isProd()` melihat null → partikel DOM produksi tidak pernah dibuat; browser
r7-compat 14/14 PASS karena sandbox punya host sendiri. **Fix:** `host` dan
`renderer` jadi getter yang membaca `state` langsung tiap akses (app.js
`__l2dDebug` ~3435). Host async + seam tidak berubah.

**ROOT CAUSE #2 (FIXED — fix call site compat scale):** `createCompatModel`
mengembalikan fasad `scale` hanya dengan `{get x, set}` — TANPA `get y` dan
`set(x,y)` ObservablePoint-parity. `frameModel` menghitung
`natH = b.height / m.scale.y` = **NaN** → `validSize` false → fallback
`state.natW/natH` = 0 → **early return SEBELUM** `m.scale.set(scale)` dan
`m.x/m.y` ditulis. Akibat: model tetap scale=1, anchor(0,0), pos(0,0) →
proyeksi (modelCenter = pos + (0.5-anchor)·nat·scale) menghasilkan tx=6.49,
ty=-10.01 → model digambar ~10 viewport di luar layar → framebuffer alpha
penuh 0 → `measureLitBounds()` null. **Bukti A/B:** model fresh di host yang
sama render sempurna (bbox 800×698) — host + GL + pipeline tak bersalah;
satu-satunya delta = frameModel early-return. **Fix:** objek scale fasad kini
paritas penuh legacy ObservablePoint (`get x/y`, `set v`, `set(x[,y])` —
produksi skala seragam, x=y=handle.getScale()).

**Hipotesis NaN-parameter (bug #3) DIBATALKAN dengan bukti:** setelah fix
#2, handle yang SAMA (tanpa reload state arbiternya, idle loop tetap jalan,
seam commit tiap frame) langsung render penuh — parameterValues null di
snapshotCore ternyata artefak bacaan snapshot, bukan NaN di core. Tidak ada
perubahan di arbiter/seam/roleLink (sesuai batasan "fix the CALL SITE").

**Bukti E2E ENGINE MAIN (fresh reload, app.js baru):**
- `measureLitBounds()` NON-NULL: `{minX:302, maxX:515, minY:12, maxY:680,
  width:213, height:668, topCentroidX:410.7}` (canvas 801×699, model
  ter-frame center).
- `m.scale` kini `{x, set, y}` keys; `modelScaleY = 0.10485`; natW/natH
  5200/7000 tersimpan di state.
- **Overlay spawn via jalur produksi asli**: `applyExpression('senang')`
  (fungsi yang dipakai UI) → `active:true, attached:true, key:'sparkle',
  particles:4→5` — DOM `.l2d-emoji-overlay` berisi span ⭐ di left:426px
  (top ~15px) — bukan lagi panggilan manual.
- **Anchor numerik terikat bbox produksi**: `prodMeasureHead()` = `{cx:
  topCentroidX×s, headY: minY×s, h, w}` dengan `s = canvasCss.width /
  cubPixels.width` — terverifikasi s=1 pada DPR 1 (cx=372.73); partikel
  sparkle x = cx + cos(seed)·w·0.26 = 426 ∈ [cx−62, cx+62] ✓.
- **Tidak ada frame loop duplikat** (R3-G): `compositeInfo().
  compositorTickerStarted: false` — hanya startIdle rAF (frame owner R4) yang
  memanggil handle.update+host.render; renderStats renders=composites
  (1:1, tanpa render ganda).
- **Legacy fallback**: `?renderer=legacy` → `production:false`, host null,
  model PIXI Container asli (`parent` ada, bukan compat `__isCompatModel`).
- **Resize**: wiring app tetap `window.resize`+`ResizeObserver →
  applyStageLayout → fitCanvas (host.resize) + frameModel` — probe
  host.resize(640,480) langsung memang menghasilkan bounds basi (frame
  berikutnya diperlukan; itu perilaku readPixels setelah clear GL), jalur
  app yang benar me-reframe model — bukan regresi.
- **DPR**: `s = canvasCss/cubPixels` mengonversi piksel framebuffer → CSS
  otomatis (DPR 2 terkunci r7-compat 14/14 termasuk tes resize + DPR).

**Test akhir:** build bersih; `tsc --noEmit` bersih; `bun run test` **462
guard pass / 1 fail pre-existing** (`releasePresetPose menghapus override`
— konversi pokeActual Stage 4, sudah gagal SEBELUM perubahan ini; bukan
regresi R7-2) + unit test sesi sebelumnya tetap hijau.

**Sisa/terbuka:** (1) guard pre-existing `releasePresetPose` menunggu fix
Stage 4 terpisah; (2) `__l2dDebug` masih tidak mengekspos `fireOverlay`
sebagai properti (fireLog kosong — applyExpression diekspos dan itu jalur
nyata; tidak ada konsumen yang butuh fireOverlay di debug bridge).

## UPDATE 2026-09-13 (33) — PHASE 13 PARAMETER ARBITER: STAGE 0–4 (BELUM COMMIT)

Phase 13 dijalankan bertahap (audit → 4 stage implementasi). Semua stage
diverifikasi dengan unit test + guard legacy + tsc + build + E2E ENGINE MAIN
in-frame probe. Final verdict Phase 13 menunggu final audit terpisah.

**STAGE 0 — single commit point (VERIFIED).** `src/client/engine/parameter-
arbiter.ts` BARU: resolver intent per (role|param) domain, priority desc +
tie-break nama channel (deterministik, tanpa wall-clock), NaN/Infinity ditolak
per-key, nilai 0 tetap owner, resubmit = replace, `clearSource/clearTarget/
clearAll`, `commit()` lewat backing yang disuntik (roleLink → ParameterApi,
`pin:false`). Dipasang di app.js: instance per model load, `commit()` di slot
`beforeModelUpdate` (setelah framework writers, sebelum `coreModel.update()`).
Stage 0 no-op (tanpa channel) — perilaku tidak berubah. Expose
`window.__l2dArbiter` (bundle-entry) + tipe (window-contract).

**STAGE 1 — override-guard writers (VERIFIED).** sticky/rawDrive/lipsync →
channel arbiter: `syncGuardChannelsToArbiter()` mensubmit dari state plane
(`state.overrides`, `state.lipSyncDrive` BARU — lipsync bukan lagi entri
overrides, `state.rawDrive`); guard tidak menulis core lagi saat arbiter ada
(fallback legacy utk harness vm dipertahankan). `setSticky` bukan penulis
core. Priority evidence-based: rawDrive 30 > lipsync 20 > sticky 10 (urutan
tulis lama). `applyOverrides()` legacy-only (guard vm). getMouth membaca
channel baru.

**STAGE 2 — idle writers (VERIFIED).** idle = produsen intent: `idle-pose`
(param — easing actual), `idle-pose-motion` (role/ref — cabang motion),
`idle-blink`, `idle-breath` (role/norm), `idle-emotion` (param, 5 — DIBUAT
karena emo menulis param raw yang overlap pose; tanpa channel, pose di guard
slot akan merebut menang = flip senyap). Idle tick hanya submit (entry kosong
melepas ownership — stale intent mustahil). **Temuan kritis**: pixi-live2d
`loadParameters()` me-revert buffer tiap update → easing pose wajib feedback
`state.idlePoseCur` (bukan readParam buffer) — tanpa itu AI pose tak konvergen
(terbukti: 17.4→18 monoton bertahan).

**STAGE 3 — native/expression gate + blink fix (VERIFIED).** (1) Gerbang
native motion: `motionManager.isFinished()` (tersedia di 0.4.0) → rolling
window `clipGateUntil` (+450 ms) memperpanjang window poseAuthority selama
motion benar-benar main; tebakan lama (2200+250 / durasi taxonomy) menjadi
window MINIMUM; idle motion acak kini juga tidak diberangi idle-pose. Blink
clipOwns sengaja tetap clipUntil (scope). (2) Expression = framework-owned,
TANPA channel (framework melakukan blending sendiri); param milik channel
arbiter tetap menang di guard slot — dibuktikan in-frame. (3) **Blink fix**:
tickBlink lama memanggil writeNorm dengan param id → no-op laten (kedip tidak
pernah menulis, nilai mata konstan); kini key intent = role name
("eyeLOpen") → benar-benar berkedip (E2E: kurva 0↔1.67 pada model berrange
0..2, framework EyeBlink dinonaktifkan saat atribusi).

**STAGE 4 — final enforcement + cleanup (VERIFIED).** `pokeActual(id, v)`:
satu titik restore/reset engine (writeActual dulu, pokeParam fallback tanpa
link) — dipakai toggle aksesori, release-pose defaults, reset mulut
(markDone/mouthTimer). `clipIsPlaying()` = window gabungan
(clipUntil + clipGateUntil). Direct-write baseline app.js **14 → 12** (dua
baris release-defaults kini lewat ParameterApi); 12 tersisa dikategorikan:
fallback legacy guard/harness (254-255, 311-312, 335, 6961, 6983, 7005),
pokeParam wrapper fallback (213), part opacity ×3 (domain part — di luar
ParameterApi). Guard vm test-param-notes-ui dikonversi sadar (pokeActual).
Invariant role→param commit order terkunci test (urutan terbalik MEMBALIK
pemenang fisik — dibuktikan).

**Bukti ENGINE MAIN (in-frame probe — listener beforeModelUpdate pasca-
guard; wajib, karena async readback tak bermakna: loadParameters me-revert
buffer):** idle pose 47 nilai unik; AI pose konvergen 17.4→18 monoton;
blink 0↔1.67; breath 0.05–1; sticky in-frame konstan 8 di atas runtime
motion; native clip → idle-pose ownership 0/14 + kurva clip in-frame (55–64
nilai unik) → resume 10/10; model switch ren→lumine→ren bersih (overrides 0,
arbiter/roleLink baru, tanpa stale). Physics/pose audit: 64 param non-channel
dipantau — 6 bergerak framework-owned (ParamAngleZ, BodyAngle*2, Center2,
shoulder) tanpa silent flip (`physicsLikeOwned: []`).

**Test akhir:** **589 unit pass / 0 fail** (44 file — termasuk 12 test Stage
3 + 9 test Stage 4; 2 assertion Stage 1 disesuaikan sadar ke helper
pokeActual) + **463 guard / 0 fail** (1 assertion test-param-notes-ui
dikonversi sadar ke pokeActual) + tsc/build bersih.

**Risik/terbuka:** (1) environment: rAF jendela browser terkelola flap
mengikuti fokus user + pipeline render PIXI bisa mati permanen bila halaman
dimuat dalam keadaan ter-occlude (pulih reload di foreground) — pengukuran
wajib in-frame probe + cek emit dulu; (2) fallback legacy guard/harness
dipertahankan terdokumentasi (guard static mengkategori 12 baris); (3) nilai
kedip >1 pada model berrange 0..2 adalah skala model, bukan anomaly.

**POST-STAGE-4 — BLINK REGRESSION INVESTIGATION (RESOLVED).** Laporan visual
"kedip kurang halus setelah Stage 3": root cause = DUPPLICATE OWNERSHIP —
Stage 3 mengaktifkan channel idle-blink yang sejak konversi pokeRoleNorm
(no-op) membuat framework EyeBlink menjadi satu-satunya penulis kedip; bersama
channel baru → dua penulis jadwal independen (terukur: 20 kedip/10 dtk
berpola paksaan vs baseline 3/10 dtk natural 4,3 dtk; lompatan maxDelta 1,0
saat fase bertabrakan). Eksperimen terkontrol A/B/C in-frame: kedua sumber
menghasilkan kurva halus sendirian (184 ms, maxFrameDelta 0,168) — masalahnya
ownership, bukan kurva. **Fix (Option 1, tanpa ubah kurva):** channel
idle-blink hanya aktif untuk model TANPA framework EyeBlink
(`fwEyeBlinkOwns` → submit kosong/clearSource); framework EyeBlink kembali
jadi pemilik baseline. Verifikasi: produksi — channel kosong 0/10, kedip
natural 167–184 ms, maxFrameDeltaOverall 0,171 (lompatan hilang), L/R sinkron
(desync 0); model tanpa framework blink → channel mengambil alih. tickBlink
(fase/rumus) tidak disentuh. Test: +3 assertion Stage 4 (ownership gate);
589 unit + 463 guard + tsc + build tetap hijau.

**Verifikasi suplemen (permintaan final):** (a) kontrol kedua-penulis OFF →
mata DATAR (uniqueL=[1], 120 frame) — membuktikan framework EyeBlink
satu-satunya sumber kedip baseline; (b) baseline framework-only vs produksi
post-fix (tickBlink gated + idle ON) IDENTIK: 2 kedip/9 dtk, 183 ms,
maxFrameDelta 0,168, idleOwnedFrames 0 — paritas penuh; (3) tickBlink kini
nonaktif total saat framework pemilik (early-return; vm test kedua mode);
(4) regresi kombinasi hijau: ekspresi aktif, lipsync drive, rawDrive 0,95,
sticky in-frame 8 — semua lewat arbiter.

**Risik/terbuka (update Stage 4 + blink):** (1) environment rAF/occlusion
(di atas); (2) blink clipOwns masih membaca clipUntil tebakan (sengaja,
scope); (3) fallback legacy guard/harness dipertahankan terdokumentasi
(guard static mengkategori 12 baris); (4) blinkEnabled toggle tidak
memengaruhi framework EyeBlink saat framework pemilik (paritas baseline —
toggle dulu juga no-op). **STATUS PHASE 13: Stage 0–4 VERIFIED + blink
regression RESOLVED — menunggu final audit terpisah.**

## UPDATE 2026-09-13 (33) — PHASE 12 BRAIN/LLM RECONNECT: VERIFICATION + TEST LOCKING (BELUM COMMIT)

Tujuan phase: BUKTI end-to-end + mengunci perilaku dengan test — NOL redesign
brain/parser/runtime/role-mapping/ParameterApi, NOL arbiter, NOL migrasi
renderer. Semua aturan §9 (non-goals) dihormati.

**Test baru (40, semua hijau):**
- `test/brain-apply-actions.test.ts` (14): unit LANGSUNG `applyActions()` via
  fake `window.__live2dAgent` (dipanggil lewat `(brain as any)` — pola guard).
  Dikunci: `[MOTION:id]` → `playMotion(id,{fromLLM:true,priority:80,fitToMs:
  estimateSpeechMs(teks),intensity?})`; motion asing → false → warn, TANPA
  crash, gesture fallback tetap main; `[EMOTION]` default 0.85, emosi asing →
  preset `user:<nama>`; pose NESTED clamp ±30/±1; `[ACC:]` = jalur legacy
  (SENGAJA tidak dimigrasi); agent belum siap → nol panggilan.
- `test/directive-negative.test.ts` (26): negative parser — directive kosong,
  argumen kurang, `[INTENSITY:abc/5/0/-3]` (abaikan/clamp 1/clamp 0.1),
  `[ACTION:]` no-op, JSON/HTML/gibberish → teks polos, `<script>` tersimpan
  sebagai string inert + output `assertPlainData` (TIDAK ada eksekusi kode),
  mixed valid+invalid, directive tengah kalimat terurai (actions KUMULATIF
  lintas segmen — semantik existing yang selama ini dipakai prompt).
- **Risiko tercatat, TIDAK diubah (parser dilarang di-redesign):** NaN dari
  `[HEAD:a,b]`/`[EYES:x,y]`/`[MOUTH:a,b]` diteruskan parser; clamp
  `Math.max/Min` tidak menyaring NaN. Dibekukan test sebagai semantik saat
  ini + dicatat sebagai future work (guard NaN serupa BODY).

**Bukti ENGINE MAIN end-to-end (bukan sandbox) — "deterministic provider
end-to-end verification":** stub fetch klien untuk `/api/chat` (protokol JSON
`{reply}` IDENTIK, koneksi user tidak disentuh — routing role menempatkan
connection eksplisit `chat` milik user selalu di depan, jadi provider
server-side tidak bisa diarahkan tanpa mengubah config user; plumbing
server-side LLM tetap dikunci unit test `llmWithFallback` provider mock).
Rantai terbukti di browser CDP milik app (jendela Chrome dedicated, rAF hidup
±55fps; catatan: WebView ZCode ter-occlude → rAF beku, bukti diambil di
browser manager app seperti entri 30–32):
1. Chat UI asli (`#bubble-input`, Mode Otak nyala) → `submitUtterance` →
   `AgentBrain.think()` → fetch `/api/chat` **tertangkap stub** dengan system
   prompt berkosakata directive + pesan user (bukti protokol).
2. Reply deterministic 2 segmen `[EMOTION:senang][MOTION:nod] … [EMOTION:
   normal][GESTURE:wave_hi] …` → `parseSegments` murni (Pass 2 director TIDAK
   jalan — dibuktikan: bubble chat = teks scripted persis).
3. `applyActions` → `playMotion("nod")` layer aktif → `getActiveMotion()`
   menunjukkan urutan lean_excited(60) → **nod** → wave_hi; selesai →
   `active=null` (semantik completion existing).
4. **ParameterApi/bridge Phase 10/11:** `roleLink.stats()` refWrites 0 →
   **4.960** selama playback (channel pose motion), normWrites idle napas
   terus ±61/dtk; replay nod: 5.128 → 7.656. Model benar-benar berubah —
   screenshot frame (Page.captureScreenshot clip kepala): kepala menoleh +
   bahu geser vs frontal di motion yang sama.
5. Negative E2E di engine: reply `[MOTION:tidak_ada_999]` → playMotion false,
   gesture nod(60) tetap main, engine tetap ready (sesuai unit test).
   Provider gagal (stub 502) → bubble fallback "Maaf, aku lagi gak bisa
   mikir…" + busy ter-reset, pesan berikutnya jalan.

**Model switch lumine → ren (§5):** model ren ternyata di folder
`data/model/tesmodel/` (`runtime/ren.model3.json`, 73 param, 5 emosi —
golden MOC v6 entri 29–32). Switch lewat UI panel (tombol Load): roleLink
dibangun ulang ✓, capability VOCAB BERUBAH 37 → 5 emosi (tidak stale) ✓,
registry hanya 9 builtin — NOL entri native lumine basi ✓, directive Brain
deterministic di ren → nod main via roleLink BARU (refWrites 120 → 2.016,
screenshot model ren) ✓, `playMotion("motion_Idle")` = false (ditolak aman)
✓. **Satu kejadian tak terjadi lagi:** klik Load pertama membekukan renderer
total (Runtime.evaluate tak dibalas, tanpa dialog) — pulih via
`Page.reload`, switch ulang sukses normal (netlog CDP: semua request 200).
Belum bisa direproduksi; dicatat sebagai risk environment/occlusion, bukan
regresi seam (entri 32 pernah switch ren→lumine sukses).

**Batas tetap (future work, sesuai audit):** ACC/sticky writer legacy langsung
ke core (unit test mendokumentasikan jalurnya); tidak ada timeout eksplisit
fetch LLM di brain (hang renderer saat switch = satu-satunya kejadian, pulih
by reload); concurrent `think` masih silent-drop via flag `busy` (by design,
tidak diubah); race registrasi native pasca-sheet-apply (entri 32) masih
terbuka — di ren live, native klip belum terdaftar sampai load berikutnya.

**Gate:** build bersih, `tsc --noEmit` bersih, **513 unit + 463 guard** hijau.

## UPDATE 2026-09-13 (32) — PHASE 11 MOTIONRUNTIME RECONNECT: TIGA SEAM KE PARAMETER API (BELUM COMMIT)

Tujuan phase: reconnect MotionRuntime EXISTING ke pipeline baru — NOL redesign
runtime, NOL arbiter, NOL perubahan brain/role-mapping/ModelProfile/renderer.

**Seam 1 — param-drive → ParameterApi:** `applyRawDrive`, restore di
`setRawDrive(null)`, `clearRawDrive`, dan blok rawDrive di
`installOverrideGuard` (beforeModelUpdate) kini menulis via
`state.roleLink.writeActual(id, v)` (= `api.setParameter(id, v, {pin:false})`,
clamp model range dari Phase 8). Jalur `cm.setParameterValueById` + clamp
`state.paramRange` = FALLBACK legacy (link null — kompatibilitas, bukan jalur
pilihan). Pin Phase 8 sengaja tidak dipakai.

**Seam 2 — channel role motion → bridge Phase 10:** cabang `motionLayersActive`
di `target()` (app.js) kini `L.bridge.writeRef(role, vRef)` dulu (math
role-mapping yang sama dari sisi bridge), fallback `pokeParam` langsung bila
link null. Breath/blink sudah sejak Phase 10 lewat pola yang sama.

**Seam 3 — higienitas registry native:** `MotionRegistry.clearNativeMotions()`
(hanya source:"native"; builtin/user utuh; cooldown ikut terhapus) dipanggil di
`initMotionRegistry` sebelum `registerNativeGroups` — grup native model lama
tidak bisa ter-play di model baru.

**Test baru (5):** `clearNativeMotions` ×4 (hanya native; transisi model A→B;
cooldown reset; kosong) + `writeActual` (pin:false, clamp, unknown id false).
Regresi: 473 unit + 463 guard hijau; guard override-guard tetap hijau (vm
harness tanpa roleLink → jalur legacy identik); urutan tick
applyOverrides→applyRawDrive tidak berubah.

**Bukti ENGINE VIEW MAIN (bukan sandbox):**
- DSL gesture `nod` via `__live2dAgent.playGesture` → runtime.play → layer
  aktif → **refWrites +176 dalam 350 ms lewat bridge** (channel role) +
  ParamAngleY 6.17 terbaca balik via ParameterApi + screenshot mid-nod
  (karakter menunduk) + selesai/fade kembali ke pose idle.
- Param-drive: motion user (track ParamBreath) → **ParamBreath teranimasi
  0→0.81→0** via writeActual, `pinnedIds()` kosong, nilai di-restore setelah
  release. Motion dengan param TAK DIKENAL diputar tanpa crash (safe failure).
- Ganti model live ren→lumine via UI: `playMotion("motion_Idle")` = false —
  **stale native terbukti dibuang** (sebelum fix: entri lama selamat).

**Dua temuan environment/auditing (bukan bug seam):**
1. IAB audit harness: rAF bisa mati saat pane render-suppressed — loop idle
   (rAF) membeku sementara MotionRuntime tetap hidup berkat watchdog 250 ms;
   kanal param tetap jalan karena setRawDrive menulis langsung. Bukti diambil
   di tab segar dengan rAF hidup (dicek eksplisit).
2. **Race pre-existing (temuan, TIDAK diperbaiki — di luar scope):**
   registrasi native hanya jalan SEKALI di load via rantai
   `loadMotionTaxonomy().then(initMotionRegistry)`, padahal
   `caps.motionGroups` terisi belakangan oleh sheet apply; sheet ren lama juga
   basi ("CACHE SCAN BASI", scanner v1). Akibat: `motion_<grup>` tidak
   terdaftar di sesi live ren → playNative native clip tidak tersedia walau
   manifest punya grup. Re-scan via `#btn-inspect` memperbarui sheet (v2,
   motionGroups terisi) — registrasi penuh baru efektif di load berikutnya.
   Rekomendasi: panggil ulang initMotionRegistry setelah hydrateCapabilities
   (perbaikan terpisah, bukan Phase 11).

**Batas tetap:** native pixi-live2d TIDAK dimigrasi ke adapter 5.3; sticky/
override writer non-motion belum dimigrasi (future work); LLM/Arbiter tidak
disentuh.

## UPDATE 2026-09-12 (31) — PHASE 10 ROLE MAPPING: ENGINE UTAMA TERSAMBUNG KE PARAMETER API (BELUM COMMIT)

Tujuan phase: RECONNECT sistem role existing ke runtime baru — bukan sistem
role baru. Flow final yang terbukti DI ENGINE UTAMA (bukan cuma sandbox):

    semantic role (angleX, mouthOpenY, …)
        ↓ role-mapping.ts (toActual/roleClampActual — TIDAK diubah)
        ↓ id milik model (hasil mapRoles dari state.caps.ids)
        ↓ ParameterApi.setParameter(id, value, {pin:false})   ← Phase 8
        ↓ Cubism → renderer

**Audit existing (§0):** math role SUDAH lama jadi TS
(`src/client/engine/role-mapping.ts`, dipakai app.js via
`window.__roleMapping`) — yang bypass hanya LINTASAN TULIS TERAKHIR:
`pokeParam` (app.js:188) → `cm.setParameterValueById` langsung ke core.
`state.paramRange` = duplikat metadata Phase 8 — DIPERTAHANKAN sebagai
compatibility layer (dipakai override-guard rawDrive & jalur legacy), JANGAN
dihapus sampai semua konsumen pindah. `state.caps` = role-mapping semantics
(Phase 10 domain itu sendiri). Multi-writer SUDAH ADA (motion/physics/loop
engine/override-guard) — arbitrase = fase lanjutan, TIDAK dibuat di sini.

**Perubahan:**
- `src/client/engine/role-parameter-bridge.ts` (BARU): `createRoleParameterBridge`
  (validasi eksistensi via `getParameterInfo`, safe-failure `false` tanpa
  throw; adaptasi ParameterInfo→ParamRange; `readRole` = inverse toActual
  berbasis midpoint) + `buildTolerantParameterBacking` (backing dua generasi
  framework: 5.3 handle-id vs legacy string-id) + `createEngineParameterLink`.
- `app.js` (port-saat-disentuh, titik kecil): attach link setelah model load
  (`window.__engineRoleLink.attach(coreModel, () => state.caps.ids)`),
  `state.roleLink` dibersihkan saat teardown, dan `pokeRoleRef/pokeRoleNorm`
  mendelegasikan ke bridge dulu (gagal aman → jatuh ke jalur legacy).
- `bundle-entry.ts`: `window.__engineRoleLink` (registry max 8 link).
- Entry ke-6 `role-bridge-entry.ts` → `live2d-role-bridge.js` untuk sandbox
  (modul SAMA dengan engine); sandbox §12d: mapping DARI model via mapRoles +
  grup resmi ModelProfile Phase 9; `?role=angleX:30`.

**Dua bug nyata yang tertangkap verifikasi runtime (bukan unit test):**
1. Backing memilih RAW core sebagai sumber getter → range terbaca 0/0 →
   semua nilai ter-clamp 0. Fix: framework dulu, raw hanya fallback.
2. Framework 5.3 menuntut `CubismIdHandle`: `setParameterValueById(string)`
   → getParameterIndex gagal → tulisan mendarat di indeks SAMPAH (73 = count!)
   tanpa error. Fix: tulis VIA INDEKS dulu (jalur adapter Phase 8), by-ID
   hanya fallback legacy.

**Test:** `test/role-parameter-bridge.test.ts` 14 test (T2–T8, T10, T11 +
backing dua generasi + model rusak). Regresi: role-mapping.test.ts &
llm-roles.test.ts tetap hijau; guard 463 hijau.

**Bukti runtime (dua jalur):**
- Sandbox (ren, moc v6): `?role=angleX:30` → `writeRef` true, read-back
  sinkron 30 lewat ParameterApi, screenshot kepala menoleh.
- **ENGINE UTAMA (index.html, stack legacy, model lumine 223 param):**
  attach ✓; LOOP ENGINE SENDIRI menulis via bridge ~60 tulisan/dtk
  (norm 864→955 dalam 1,5 dtk, tanpa drive eksternal) — jalur
  `pokeRoleNorm("breath",…)` engine mengalir lewat Parameter API;
  `writeRef("angleX",30)` → read-back 30 → screenshot kepala lumine
  menoleh di UI vtuber. Role tanpa mapping (ParamEyeROpen di lumine)
  gagal aman → fallback legacy → tanpa crash.

**Gate:** build bersih, `tsc --noEmit` bersih, 468 unit + 463 guard hijau.

**Catatan lanjut:** (1) Writer legacy non-role (`setSticky`/override-guard
rawDrive) masih tulis langsung ke core — compatibility layer, dokumentasi §18;
migrasinya fase terpisah. (2) Pin Phase 8 sengaja TIDAK dipakai bridge
(`pin:false`) — sticky tetap milik override-guard engine, perilaku sama dengan
sebelumnya. (3) Isolasi antar-model di engine = link dibangun ulang per load
model (satu model aktif); isolasi dua instance terbukti di unit T11 dan
lintas jalur (sandbox ren vs engine lumine).

## UPDATE 2026-09-12 (30) — PHASE 9 MODEL INSPECTOR: MODEL PROFILE BEKU PER INSTANCE (BELUM COMMIT)

Tujuan phase: runtime mampu menjawab "model ini punya apa?" — satu
representasi capability beku (`ModelProfile`) per instance model, TANPA
menyentuh role mapping (Phase 10), MotionRuntime, LLM, atau Arbiter.

**Audit existing dulu (aturan §0 spesifikasi):** metadata parameter/range
sudah ada di Phase 8 (dipakai — TIDAK ada sistem parameter kedua);
`state.paramRange` app.js & `state.caps` = wilayah engine/role-mapping (tidak
disentuh); `CoreModelSnapshot` (cubism-core.ts) = kontrak data frame
per-render (opacity/warna live) — beda tujuan dari profile statis, tidak
digabung; audit struktur inline Phase 7 di sandbox = logika inspector parsial
yang kini dinaikkan ke adapter; tidak ada `ModelProfile`/`getProfile` sebelumnya.

**Arsitektur (pola Phase 8):**
- `src/live2d/model-profile.ts` — MURNI (nol import runtime): kontrak
  `ModelProfile`/`ModelMetadataBacking` + `buildModelProfile(parameters,
  meta)`. Parameter metadata SELALU dari ParameterApi Phase 8 (field `value`
  DIBUANG — nilai live tetap via `getParameter(id)`, tidak pernah basi).
  Hasil deep-frozen; absen = `[]`/false konsisten; capability tri-state
  (`boolean | "not-verified"`) — physics/pose dari STATE loader runtime
  (`user._physics`/`user._pose`), fallback manifest → "not-verified" bila
  runtime tak tersedia; `formatProfileSummary()` untuk log debug.
- `src/live2d/cubism-model-inspector.ts` — adapter duck-typed (framework tak
  masuk tsc): CubismModel → parts (dgn parent)/drawables (render order
  gabungan, blend enum color+alpha, mask PER-DRAWABLE — layout `Int32Array[]`,
  diverifikasi runtime, BUKAN array rata)/offscreens; manifest →
  textures/motions/expressions/eyeBlink/lipSync (fakta apa adanya — termasuk
  grup motion bernama "" pada ren, tidak disanitasi).
- `src/live2d/profile-entry.ts` + entri ke-5 `src/build.ts` →
  `static/js/live2d-model-profile.js` (artefak, di-gitignore) →
  `window.Live2DModelProfile`. SATU API kanonik: `model.getProfile()` di
  kontrak `Live2DModelHandle` (stub tetap fail-loud) — tanpa varian
  inspectModel/getModelCapabilities/getModelInfo.
- Sandbox §12c: `user.getProfile()` + `window.__profile` + ringkasan di status
  + `?profile=1` dump JSON.

**Test:** `test/model-profile.test.ts` 13 test = T1–T10 + immutability +
adapter (fake duck-typed). Guard kontrak handle +1 (`getProfile`).

**Verifikasi runtime golden (dua tab):** ren — 73 param (dari Phase 8)/51
part/198 drawable == runtime/24 offscreen/1 tekstur; 4 drawable bermask dengan
indeks IDENTIK core; 5 ekspresi; motion Idle#0 + grup "" (fakta manifest);
physics true, pose false; getProfile() read-only (state param identik),
same-ref, deep-frozen. lumine — 223/223/55, moc v5, 0 motion/0 ekspresi,
multiply 2 — profil terpisah total saat ren tetap utuh (T9 ✓).

**Gate:** build bersih, `tsc --noEmit` bersih, 454 unit + 463 guard hijau.

**Catatan lanjut:** Phase 10 (Role Mapping) bisa memakai
`profile.parameters` sebagai daftar kandidat; jangan menambah semantic field
ke ModelProfile. Angka blend yang dilaporkan = enum framework
(CubismColorBlend/CubismAlphaBlend) — pemetaan arti tetap milik renderer.

## UPDATE 2026-09-12 (29) — PHASE 8 PARAMETER API: DISCOVERY/READ/WRITE TERVALIDASI DI ATAS CUBISMMODEL

Tujuan phase: lapisan Parameter API yang stabil dan model-agnostic di atas
Cubism Runtime — `getParameters()` / `getParameter(id)` / `getParameterInfo(id)`
/ `setParameter(id, value)` — membuktikan tulisan parameter benar-benar
menggerakkan model di renderer. TANPA role mapping (Phase 10), TANPA
MotionRuntime (Phase 11), TANPA LLM/Arbiter.

**Arsitektur (3 file TS + 1 bundle entry):**
- `src/live2d/parameter-api.ts` — `ParameterApi` MURNI (nol import; bebas
  Cubism & renderer): logika discovery/read/write/clamp/validasi diuji lewat
  interface polos `CubismParameterBacking`. ID/min/max/default SELALU dari
  backing model — tidak ada id bernomor, tidak ada skala referensi di sini
  (role-space tetap lapisan di atas, Phase 10). Clamp = model range constraint
  (bukan semantic clamp). NaN/±Infinity ditolak (nilai lama lestari); id tak
  dikenal → `false`/`undefined` tanpa throw, tanpa membuat param baru; state
  override milik instance (isolasi dua model); `dispose()` memutus reference
  backing (lifecycle aman). `formatParameterTable()` = debug §8.16.
- `src/live2d/cubism-parameter-backing.ts` — adapter `CubismModel` resmi →
  backing: mapping id→indeks dibangun sekali (O(1), tanpa side-effect
  getIdManager berulang); `CubismModelLike` didefinisikan lokal (import type
  framework tidak masuk tsc — framework tidak lolos strict null-check).
- `src/live2d/param-api-entry.ts` + entri ke-4 `src/build.ts` →
  `static/js/live2d-param-api.js` (IIFE, artefak — kini di-gitignore) menaruh
  `window.Live2DParameterApi`.
- `src/live2d/types.ts` — 4 method Parameter API masuk kontrak
  `Live2DModelHandle`; `stub.ts` tetap fail-loud `belum()`; guard kontrak
  `test/live2d-adapter.test.ts` ikut.

**Mekanisme pin (`SetParameterOptions.pin`, default true):** `setParameter`
mencatat override dan `applyOverrides()` me-re-apply semua pin TEPAT SEBELUM
`model.update()` tiap frame — nilai bertahan melawan motion/physics/breath
yang menulis param tiap frame. Ini tambahan praktis di luar spesifikasi Phase 8
(untuk uji manual "set lalu lihat hasil"); posisinya terhadap MotionRuntime
(Phase 11) & Parameter Arbiter (Phase 13) harus diputuskan agar tidak jadi dua
sistem override yang bersaing.

**Sandbox (`pixi8-official.html` §12b):** `window.__paramApi`, shim
`user.setParameter/getParameter/getParameterInfo/getParameters`, hook
`?set=Id:nilai`, panel debug tabel parameter (refresh tiap 15 frame).

**Verifikasi (dua lapis):**
- Unit: `test/parameter-api.test.ts` 18 test = Testing Matrix T1–T10 + lifecycle
  + sinkronisasi + pin + adapter (mock backing, tanpa WASM).
- Runtime golden (ren, moc v6, 73 param terdiscovery): `setParameter(
  "ParamAngleX", 30)` → kepala terputar di renderer + read-back 30; clamp
  999→30; NaN ditolak; id tak dikenal aman; T8 multi-write 15/−10/0; operasi
  read tidak memutasi; `clearOverride` → nilai kembali dikuasai motion.
  lumine (moc v5, 223 param) terdiscovery & bisa ditulis terpisah — isolasi
  instance terbukti antar-tab. Grep: nol string id parameter di logika.

**Gate:** build bersih, `tsc --noEmit` bersih, 441 unit + 463 guard hijau.

**Catatan lanjut:** (1) `dispose()` belum tersambung ke jalur destroy model
(sandbox tidak punya jalur destroy) — wajib saat engine utama memakai API ini.
(2) Engine (app.js) BELUM mengonsumsi API ini — `Live2DModelHandle.setParameter`
masih stub; konsumsi engine menyusul setelah role-space (Phase 10). (3) Phase 9
(Model Inspector) bisa langsung memakai `getParameters()`.

## UPDATE 2026-09-12 (28) — PHASE NATIVE MOC6: AUDIT HACK + JALUR NATIVE LOLOS GOLDEN (BELUM COMMIT)

Tujuan phase: pastikan MOC binary **asli** (tanpa stamp/hack byte) dimuat
Core 6.0.1 melalui `Moc.fromArrayBuffer → Model.fromMoc()`, terbukti di
golden models.

**Audit hack MOC di repo (TIDAK dihapus, hanya dipetakan):**
- `static/js/app.js:7-45` `patchCubismCore()` — satu-satunya yang
  **menulis ulang byte MOC**: membungkus `core.Moc.fromArrayBuffer`; bila
  load gagal & header v5 → `u8[4..7]=4` (stamp v5→v4) lalu retry; `v>5`
  sudah fail-loud tanpa stamp (entri 25). Tidak aktif di jalur native
  (sandbox tidak memuat app.js).
- `static/js/app.js:3283` `assertCubism4()` — hanya console.warn label
  "version-stamp shim" untuk Cubism 3; tidak menyentuh byte.
- `static/js/pixi-live2d-0.4.0.js:6-80` `patchCore6Compat()` — BUKAN hack
  byte; shim read-model di atas `core.Model.fromMoc` (delegasi
  `renderOrders` + peta opacity offscreen moc v6) untuk framework vendored
  era-core-4 di adapter lama. Jalur native tidak memakainya.
- `src/live2d/` (TS, source-of-truth bundle) — bersih: `CubismMoc.create`
  memanggil `Moc.fromArrayBuffer` + `csmGetMocVersion` apa adanya.

**Jalur native diverifikasi di sandbox (`pixi8-official.html`, tanpa
app.js/pixi-live2d):** model3.json → fetch MOC bytes asli → audit header
sebelum/sesudah load (harus identik, else fail-loud) →
`CubismUserModel.loadModel` (= `CubismMoc.create` → `Moc.fromArrayBuffer` →
`Model.fromMoc`) → audit struktur renderer → draw.

**Golden run (semua ✓, bytes MOC terverifikasi tak berubah):**
- `ren` — MOC **v6** (header `MOC3 06`, sha a9ccf7d6…): 198 drawable,
  7.843 vertex, draw order 222 = 198 drawable + **24 offscreen**, mask
  4 drawable + 4 offscreen (3 inverted), blend normal 198, texture 4096²,
  physics + eyeblink + breath + motion Idle berputar, render proporsional.
- `lumine` — MOC **v5** (header `MOC3 05`, sha eeb81363…): 223 drawable,
  23.468 vertex, draw order 223 (0 offscreen), mask 30 drawable (5
  inverted), blend normal 221 + multiply 2, texture 8192², physics +
  eyeblink + breath jalan. Tidak punya grup motion di manifest (file
  `idle.motion3.json` di disk tak direferensikan model3.json) → dirender
  statis; bukan kegagalan loader.
- Core 6.0.1 memuat MOC v5 & v6 native tanpa stamp; `csmGetLatestMocVersion=6`.

**Perubahan sandbox** (masih `pixi8-official.html`, belum di-commit): audit
native MOC (header before/after, `Model.fromMoc` probe), audit struktur
(mesh/draw-order/mask/blend/offscreen dengan fail-loud), load `pose` bila
ada di manifest, pemilihan grup motion fallback ke grup pertama bila tanpa
`Idle`, `?dir=&file=` untuk memilih model, dan label status pakai nama file.

**PHASE Native MOC6: DONE.** Gate: build bersih, `tsc --noEmit` bersih,
463 guard + unit hijau, golden ren & lumine lolos semua subsistem
(mesh/texture/mask/blend/draw order/offscreen/physics/motion).

**Berikutnya — PHASE Parameter API:** hubungkan penulisan parameter ke
model native ini lewat role-space (`pokeRoleRef`/`pokeRoleNorm`/
`roleDefault` — lihat MODEL-AGNOSTIC-RULES.md); angka hanya dari engine,
tanpa id bernomor.

## UPDATE 2026-09-12 (27) — PIXI8 OFFICIAL: ANTI-GEPENG, PPU KONSTAN TAK TERIKAT WINDOW (BELUM COMMIT)

Perbaikan akar masalah "karakter gepeng" di `static/pixi8-official.html`
(pipeline: model3.json → Cubism SDK 5.3 resmi → PixiJS 8 → canvas):

- **Akar masalah**: `CubismViewMatrix` di bundle `cubism-framework.js` TIDAK
  membentuk proyeksi — `getMatrix()`-nya hanya matriks pan/zoom (identity
  default); `setScreenRect` hanya mengisi batas clamp `adjustTranslate/
  adjustScale`. Halaman memakai `projection = viewMatrix` sebagai MVP →
  MVP efektifnya **matriks identitas** → 1 unit model = `w/2` px horizontal
  tapi `h/2` px vertikal → anisotropik di window non-persegi (gepeng).
  PPU=400 yang lama tidak pernah dieksekusi (di-overwrite `setupProjection`
  dan viewMatrix memang tidak pernah membentuk proyeksi).
- **Perbaikan**: MVP dibangun langsung — `projection.scaleRelative(
  2·PPU/w, 2·PPU/h)` — memetakan unit model → clip space dengan SATU skala
  untuk kedua sumbu (mustahil anisotropik). `CubismViewMatrix`/
  `deviceToScreen` dihapus dari halaman (tidak diperlukan tanpa pan/zoom).
- **PPU konstan, model-agnostic**: `PPU = CANVAS_PX / model.getCanvasHeight()`
  dihitung SEKALI saat boot dari kanvas moc (bukan konstanta per-model);
  tinggi kanvas default 900 px layar, override via `?zoom=1.25`. Resize
  window HANYA memotong/memenjangkan latar — ukuran karakter dalam piksel
  tetap. Terverifikasi terukur: bbox piksel GL identik (90×284) di viewport
  1500×500, 800×800, dan setelah resize live 1250×550.
- **DPR-aware**: kanvas GL resmi kini berukuran device-pixel (`innerWidth ×
  dpr`, dpr ≤ 2) — ketajaman setara viewer resmi; `user.setRenderTargetSize`
  dipanggil saat resize agar buffer mask 5.3 ikut ukuran baru.
- **Debug**: mode `?measure=1` mengukur bbox piksel non-transparan GL di
  frame ke-40 dan menuliskannya ke panel status; callback ticker dibungkus
  try/catch fail-loud (error frame pertama dilaporkan ke status).
- Catatan verifikasi: `getDrawableVertexPositions` core mengembalikan array
  FLAT `[x0,y0,…]` (bukan `{x,y}`), canvas info di `model._model.canvasinfo`
  (CanvasOrigin = titik tengah kanvas → origin model = pusat kanvas).

Gate: guard 463 + unit hijau, `tsc --noEmit` bersih; verifikasi visual via
browser (screenshot proporsi normal, tidak gepeng, di 3 aspek viewport).
Terverifikasi juga pada model lain (`lumine`, tekstur 8192², 223 drawable):
PPU otomatis 562.5 px/unit dari kanvas moc-nya sendiri (bukan konstanta ren)
→ fix benar-benar model-agnostic; proporsi benar di viewport 1280×720 &
1000×560. Path model kini bisa di-override via `?dir=&file=` (default
tesmodel/runtime/ren). Catatan: lumine tidak punya grup motion `Idle` →
dirender statis (physics/breath/eyeblink tetap jalan).

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

## UPDATE 2026-09-12 — PHASE 8: PARAMETER API (model-agnostic, stabil)

Parameter API Phase 8 SELESAI diimplementasikan dan lulus semua gate
("Selesai": build bersih + `bunx tsc --noEmit` bersih + `bun run test` hijau).

- Kontrak publik: `getParameters(): ParameterSnapshot[]`,
  `getParameter(id): number | undefined`,
  `getParameterInfo(id): ParameterInfo | undefined`,
  `setParameter(id, value): boolean`. TIDAK ada semantic role dalam objek
  (role-mapping = Phase 10, di luar scope).
- `ParameterInfo = { id, min, max, defaultValue }`;
  `ParameterSnapshot extends ParameterInfo { value }`. ID/min/max/default
  SELALU diambil DARI model lewat backing (dynamic discovery), tidak pernah
  hard-code.
- Aturan terikat: clamp out-of-range ke [min,max] (model range constraint —
  bukan semantic/role clamp); NaN/Infinity/-Infinity ditolak (nilai lama
  lestari, tidak sampai ke Cubism); id tak dikenal → `false` aman tanpa
  throw / tanpa param baru / tanpa mutasi param lain; dua instance model
  terisolasi (state override milik instans, bukan global); lifecycle aman
  (dispose / model mati → semua panggilan aman); API TIDAK tahu alasan
  perubahan (user/motion/AI/dst).
- `setParameter` mem-pin secara default; `applyOverrides()` di-re-apply tiap
  frame TEPAT sebelum `model.update()` agar nilai pin bertahan melawan
  motion/physics/breath (bukti visual: `?set=ParamAngleX:15` mengubah model
  dan tetap di panel debug).

### Berkas kunci (Phase 8)
- `src/live2d/parameter-api.ts` — `ParameterApi` + `formatParameterTable`
  (§8.16). Murni, hanya bergantung `CubismParameterBacking` (interface
  polos) → bisa dites tanpa WASM.
- `src/live2d/cubism-parameter-backing.ts` — adapter `CubismModel` →
  `CubismParameterBacking`. Pakai interface struktural lokal (`CubismModelLike`)
  agar framework resmi TIDAK masuk ke graf type-check tsc (framework gagal
  strict null-check; di-build via Bun.build, bukan tsc).
- `src/live2d/param-api-entry.ts` — pasang `window.Live2DParameterApi`
  (`ParameterApi` + `createCubismModelBacking` + `formatParameterTable`).
- `src/live2d/types.ts` — 4 method ditambah ke `Live2DModelHandle`;
  `ParameterInfo`/`ParameterSnapshot` di-re-export.
- `src/live2d/stub.ts` — 4 stub fail-loud (belum diimplementasi → melempar).
- `test/parameter-api.test.ts` — 18 test (matrix 10 + lifecycle + sinkron +
  pin/clear + backing adapter), hijau.
- `src/build.ts` — entry ke-4 → `static/js/live2d-param-api.js` (gitignored).
- `static/pixi8-official.html` — harness golden: script tag param-api, install
  `paramApi` ke `user`, frame hook `applyOverrides()`, panel debug (#paramDebug,
  refresh tiap 15 frame via `formatParameterTable`), dan `?set=ID:value,...`.

### Di LUAR scope (tidak diubah)
Renderer pipeline/shader/masking/blend/offscreen, MOC compat hacks,
role-mapping semantic, MotionRuntime, Brain/LLM, Parameter Arbiter.

### Verifikasi cepat
1. `bun run build` → muncul `static/js/live2d-param-api.js`.
2. `bunx tsc --noEmit` → bersih (EXIT 0).
3. `bun run test` → hijau (terakhir: 463 guard + semua unit, 0 gagal).
4. Buka `static/pixi8-official.html?set=ParamAngleX:15,ParamEyeLOpen:0` →
   model miring & mata kiri tertutup, panel debug kiri-bawah menampilkan
   tabel ID/Value/Range.
