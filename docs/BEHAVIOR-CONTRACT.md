# docs/BEHAVIOR-CONTRACT.md — Behavior Contract v1 (S1–S6), TERKODIFIKASI

> **File ini ditulis untuk AI agent dan manusia** sebagai spesifikasi perilaku
> yang TERKUNCI dari seri Behavior Contract S1–S6 (2026-09-16, entri STATUS
> 53–61). Dokumen kontrak aslinya pernah hidup sebagai catatan sesi (kutipan
> `§n`, `O#`, `D#` di kode) dan **tidak pernah di-commit** — file ini
> rekonstruksi otoritatifnya, dibangun HANYA dari bukti terverifikasi.
> Jika dokumen dan kode bertentangan, **kode yang benar — perbaiki dokumennya.**
> Aturan repo tetap berlaku: jangan memperbaiki balik aturan yang terkunci.

## 0. Status & aturan perubahan

Klasifikasi yang dipakai di seluruh dokumen (setiap klausul berlabel satu):

- **[TERKUNCI]** — invarian perilaku terkunci. Mengubahnya = putusan user
  eksplisit + entri STATUS baru. Test yang menguncinya tidak boleh dilonggarkan.
- **[DETAIL]** — detail implementasi yang membuat invarian tercapai. Boleh
  berevolusi selama invarian tetap; bukan janji antarmuka.
- **[BATAS]** — keterbatasan/deferral yang DITERIMA secara eksplisit (tercatat
  di entri STATUS). Bukan bug terselubung; tidak boleh "diperbaiki diam-diam".
- **[BUKTI]** — penunjuk verifikasi historis (entri STATUS, commit hash,
  file test).

Aturan perubahan:

1. Seri roadmap **S1–S6 TERTUTUP** (S1 `a26c0da`, S2 `8bfc6fb`, S3-A `10c8235`,
   S3-B `4a6d82c`, S4-A `4a38014`, S4-B `3b171f3`, S4-C `27d878a`,
   S4-D `8037fc4`, S6 `21d0a11`). Tidak ada fase S7+ yang pernah didefinisikan.
2. **"S5" adalah slot kosong** — tidak pernah didefinisikan/diimplementasikan
   (audit sesi pasca-S6). Dua sisa polish berlabel "kandidat polish kecil
   S5+" di entri 60 tetap berstatus [BATAS] di §7.
3. Amandemen hanya lewat: putusan user → implementasi → verifikasi gates
   (unit + guards + tsc + build + smoke bila menyentuh jalur ucap) → entri
   STATUS → baris baru di dokumen ini.
4. Dokumen ini **tidak menciptakan aturan baru**. Klausul tanpa bukti S1–S6
   tidak masuk (anti-invention rule).

## 1. Terminologi & penomoran [TERKUNCI]

- `S#` (S1, S2, …) = **fase roadmap Behavior Contract**, dan TIDAK dipakai
  untuk hal lain. Sejarah tabrakan yang mengharuskan aturan ini: "S5" muncul
  sebagai label skenario P17 (brain convergence), smoke S5 (model switch),
  sekaligus slot roadmap yang kosong; "S7" muncul sebagai skenario smoke
  S4-D (S7a/b/c) dan item teardown Phase 18 — semuanya BUKAN fase.
- Label skenario test/smoke wajib membawa prefiks konteksnya (`P18-S5`,
  `smoke-S7a`, `O2`, `M5`, `T6`, `R8`, `B1`). Jangan membuat label `S#` baru
  untuk skenario.
- Istilah: **chain** = rantai segmen brain (pemilik `_chainOwner`, Phase 18);
  **kanal** = SpeechChannel (akses output bicara jendela utama); **lane** =
  jalur produsen ucap (companion / vtuber / harness / direct); **worker** =
  eksekutor task assistant (runtime server `assistant.ts`).

## 2. Model kepemilikan ucap [TERKUNCI]

Tiga sumbu kepemilikan yang SENGAJA terpisah (sumber: header `channel.ts`,
entri 53; kutipan legacy `§7`):

1. **Request ownership** — Phase 16 (`_reqCtrl/_reqGen`, timeout/abort):
   satu request LLM aktif; hasil basi dibuang.
2. **Chain ownership** — Phase 18 (`_chainOwner` di AgentBrain): mengatur
   sekuens segmen brain; klaim = 1× `lockAI`, tiap terminal = 1× `unlockAI`
   (pairing 1:1); callback bertoken basi inert — tidak bicara, tidak lanjut
   segmen, tidak menyentuh lock rantai baru.
3. **Speech channel** — `src/client/speech/channel.ts` (S1): satu-satunya
   pemegang akses output bicara jendela utama.

Invarian kanal (entri 53; test `speech-channel.test.ts`, `brain-speech-channel.test.ts`):

- INV-1 hanya satu owner aktif.
- INV-2 token opaque; token basi tidak bisa melepas owner aktif.
- INV-3 takeover: `onLost` lama terkirim SINKRON sebelum klaim return, lalu
  enforcer (`stopSpeechNow` app.js) menghentikan audio yang jalan.
- INV-4 completion ≠ loss: outcome dihitung dari KEPEMILIKAN saat callback
  engine tiba — `onend` setelah cancel tidak bisa menyamar jadi completion.
- INV-5 release idempoten; release token basi = no-op.
- INV-6 klaim atas kanal bebas TIDAK menyentuh enforcer (bukan peristiwa
  takeover).
- INV-7 `reset()` saat teardown model: pemilik lama `lost`, audio sisa
  berhenti, kanal bersih — ownership tidak selamat lintas model.

[DETAIL] channel.ts adalah INFRASTRUKTUR, bukan kebijakan — tidak boleh
menampung kebijakan mode/produk. [BATAS] Overlay OBS (`vtuber.html`) =
jendela/proses lain → DI LUAR kanal dan DI LUAR ctx gating S6 (putusan S1,
entri 53; sisa area produk yang tak diputuskan — lihat §7).

## 3. Kebijakan prioritas ucap D1–D7 (S4-D) [TERKUNCI]

Angka prioritas adalah MEKANISME arbitrase, bukan hierarki kepentingan
(entri 60). Aturan kanal tak berubah: `incoming < holder → refused`, selain
itu takeover legal.

| Prioritas | Produsen | Konsekuensi |
|---|---|---|
| `0` | chain brain (user), `vtuber/*`, `app/direct`, semua default | perilaku lama persis; 0-vs-0 = takeover legal |
| `-1` | worker/harness/actor (`speakAsCharacter`) | refused selama chain memegang (**D1**); legal saat kanal bebas/proaktif |
| `-2` | proaktif (`reactEvent` → `playSegments(false)`) | refused vs holder mana pun ≥ −1 (**D2**); lapisan terendah |

- **D1** — worker TIDAK BISA preempt/mematikan rantai companion; supresi
  worker tidak pernah menyentuh `rt.*` (speech ⊥ eksekusi; kutipan legacy
  `§7/§25`).
- **D2** — proaktif terendah; refusal = rantai proaktif TIDAK pernah lahir
  (owner+lock dibatalkan; pairing 1:1 tetap utuh).
- **D3** — serialisasi worker producer-side: SATU baris worker audible
  (`harnessVoicing`); baris baru saat lama aktif = **DROP** (bukan defer —
  tanpa replay, tanpa queue di kanal). Sisa polish DROP-vs-DEFER: §7.
- **D4** — approval TETAP SUNYI: tidak ada klaim untuk `permission_request`;
  pasca-resolve lewat jalur normal.
- **D5** — yang ditolak tidak pernah "dikatakan": refusal → `onDone("refused")`
  + return SEBELUM audio, tanpa completed palsu, tanpa release token asing,
  tanpa bubble (bubble = "dikatakan", bukan "dicoba"). Kutipan legacy `§5`
  = penutupan jalur refusal laten ini.
- **D6** — "user input menang" dieksekusi lewat klaim preempt yang sudah ada
  (`playSegments(true)`, prioritas 0), bukan angka magis.
- **D7** — `_onChannelLost` & taksonomi outcome completed/lost TIDAK diubah
  oleh kebijakan mana pun.

[DETAIL] Serialisasi worker memakai watchdog 60 dtk mengikuti konvensi
`speakWait` (S3). [BATAS] `app/direct` tetap prioritas 0 (policy diam,
didokumentasikan — entri 60). [BUKTI] `test/speech-policy.test.ts` (14),
`smoke-engine-utterance` S7a/S7b/S7c (58/58), smoke `S7c` membuktikan kanal
tak berpindah saat klaim proaktif ditolak.

## 4. Lanes produsen

### 4.1 Companion (brain) [TERKUNCI]

S2 PET THINKING MERGE (entri 54; test `pet-merge.test.ts` R1–R8):

- Input user saat brain **THINKING** → DITERIMA: masuk history seketika
  (urutan arrival) + buffer penanda `_pendingMerge` ber-watermark
  `historyIndex`. Respons aktif yang belum mencakup input digugurkan (TIDAK
  diucapkan, TIDAK masuk chat log) dan **SATU pass penggantian** membawa
  history gabungan — model yang menafsir, tanpa classifier.
- Saat **SPEAKING** (busy sudah false) → jalur think() normal: claim + preempt
  rantai Phase 18 (D6). Buffer merge tidak pernah dilalui di jalur ini.
- Proaktif (`reactEvent`) checkpoint identik: bila input user menunggu,
  balasan proaktif TIDAK diucapkan, TIDAK dicatat P15.x, loop user mengambil
  alih (`_scheduleFoldedThink()`).
- Invarian puncak: **maks satu request thinking paralel**; pass k+1 hanya
  setelah pass k resolve/reject; fallback percakapan TEPAT SATU; siklus basi
  (model switch) tidak mewarisi merge dan tidak menghilangkan pesan dari
  history.
- [DETAIL] history = array hidup otoritatif; balasan assistant tidak
  disimpan (semantik user-only existing). Respons gugur tidak pernah klaim
  di UI.

### 4.2 VTuber [TERKUNCI]

S3-A — AUDIENCE + DONATION (entri 55; test `vtuber-audience-donation.test.ts`
21): 

- **Audience tidak punya antrean** — yang ditekan di titik mana pun = FINAL
  (seen-id event cap 500/300 s; dup-key `lowercase(user)+"::"+teks`
  window 8 dtk; cooldown existing ≥5 s; satu request in-flight). Dua user
  berbeda dengan teks sama TIDAK dibungkam.
- **Donasi** = FIFO cap 20, overflow membuang yang TERBARU (FIFO tertampung
  utuh); LLM saat slot aktif (tanpa pre-generate); queue maju HANYA setelah
  lifecycle ucap selesai — `completed` ATAU `lost` sama-sama mengakhiri slot
  (tanpa retry-loop); watchdog 60 dtk; error LLM tetap mengakhiri slot
  (antrean tidak deadlock); teardown = `stopped + gen++ + queue kosong`,
  kontinuaasi lama dibungkam cek generasi di setiap titik set-side-effect.
- Donasi tidak pernah lewat dup-key audience; dedup identity = event-id.

S3-B — OPERATOR (entri 56; test `vtuber-operator.test.ts` 21, keputusan
D-1..D-5):

- Operator adalah **tipe event eksplisit** (`"operator"`), tidak pernah
  reinterpretasi dari chat (O2). FIFO sendiri cap 20 (buang-terbaru),
  berbagi SATU slot aktif dengan donasi (`donoBusy`).
- **D-1** prioritas di KLAIM (bukan preempt): saat slot bebas dan donasi
  menunggu, donasi menang; slot berjalan tidak pernah dipreempt; wake
  operator ≤ satu tick poll (2,5 dtk) bila donasi yang melepas slot.
- **D-3** perintah operator tidak pernah diredam switch auto-balas audience
  maupun overlay OBS; yang membungkamnya hanya lifecycle (stopped/gen).
- **D-4** persona + system string identik dengan donasi.
- **D-5** switch `#vt-donate-respond` tetap utuh/mati sebagaimana adanya.
- Composer operator HANYA menyuntik event (`/api/vtuber/mock-event`) — tanpa
  LLM, tanpa ucap di composer (guard O18). Tipe tak dikenal dari mock-event
  tetap jatuh ke `"chat"` (safety lama).
- [DETAIL] satu-satunya flag slot bernama `donoBusy` (nama historis S3-A
  dipertahankan agar teks `pumpDonations` tak berubah). [BATAS] rilis slot
  oleh DONASI tidak merantai ke operator — wake lewat sapuan poll, bounded.

### 4.3 Harness / worker [TERKUNCI]

S4-A — identitas task + PARK/QUEUE (entri 57; test `harness-queue.test.ts`
24, invarian I6–I11):

- Kepemilikan slot runtime = `activeTask` (BUKAN `busy`): approval-pause
  melepas `busy` tetapi slot tetap terpegang → ask berikutnya PARK (I11;
  bug lama tertutup).
- Task baru saat slot terisi = PARK FIFO cap `MAX_PARKED=20`; overflow
  menolak yang TERBARU dengan feedback eksplisit — tanpa drop senyap.
- `taskId = t_<n>` unik seumur runtime, deterministik [DETAIL].
- Drain tunggal: `releaseAndDrain` hanya dari jalur terminal + guard
  equality `taskId` — completion basi tidak bisa melepas/drain milik task
  lain (I6/I7); klaim task berikutnya sinkron di fungsi yang sama.
- Cancel task-aware: parked dibuang per-taskId (I9); antrean tidak pernah
  ikut batal global (I10); paused → terminal seketika + `approvals.clear()`.
- Reset guard: ditolak selama ada task aktif/busy (I8).
- [BATAS] task hasil drain tanpa sink SSE pemilik → suara akhir lewat quip
  actor atas `final_answer` (= perilaku ask klien luar/CLI; memangkas G8,
  §7). [BATAS] cooldown provider bisa membuat parked gagal cepat beruntun —
  tiap task tetap terminal + drain tepat sekali, tanpa retry otomatis.

S4-B — UI antrean = PROYEKSI MURNI (entri 58; test `harness-queue-ui.test.ts`
15):

- Satu-satunya jalur antrean → DOM adalah hitung ulang dari snapshot
  `/status` (`queueRows`, `heroTaskText`, `shouldSyncOnDrain`) — tanpa state
  client antrean, tanpa edit optimistik; baris hilang KARENA `/status`
  berubah. Server S4-A tidak berubah satu barispun.
- **Aturan legacy `§15 O4`: PARKED = eksekusi state, bukan pesan chat** —
  tidak ada baris antrean di transcript.
- Cancel per-taskId hanya di baris parked; task aktif lewat tombol global.
- B1: identitas activeTask berganti A→B (drain) dan stream sendiri mati →
  `syncHistory()` sekali; same-A tidak pernah fetch; tanpa event/polling baru.
- [BATAS] deferral `§13 B2/B3` — lihat §7.

S4-C — modifikasi task AKTIF (entri 59; test `harness-modify.test.ts` 14):

- Modifikasi = cancel-kooperatif + replacement: A′ mewarisi posisi pipeline A
  (menjadi eksekusi berikutnya, di depan seluruh parked). Bukan rewind dunia —
  side effect tool in-flight A tetap berdiri.
- HANYA task AKTIF yang bisa dimodifikasi; modifikasi task PARKED ditolak
  eksplisit (deferred, §7). Server `assistantModify` = SATU fungsi tanpa
  `await` → atomik; id lama pensiun PERMANEN (cancel/modify/release stale
  untuk id lama = no-op).

## 5. Gating proaktif (S6) [TERKUNCI]

Sumber: entri 61; test `proactive-gating.test.ts` (16: A1–A9, B1–B4, C1–C2,
D1); commit `21d0a11`.

- **Gate = predikat murni `proactiveAllowed` di brain.ts**, dieksekusi
  PALING AWAL `reactEvent` — bahkan sebelum cek busy. Refusal = TERJAMIN
  nol efek: nol `/api/chat`, nol `/api/animate-text`, nol thinking/gaze/
  ekspresi, nol klaim kanal, nol bubble.
- **Allowlist tipe** = kunci `EVENT_PROMPTS`: event tak dikenal → REFUSE.
- **Matriks acceptance:**

| Kondisi | Hasil |
|---|---|
| mode chat + brain ON + worker idle | ALLOW (aturan lama utuh: busy/idleSpeak/quiet/ready tetap berlaku) |
| brain OFF (switch Mode Otak) | REFUSE |
| mode `vtuber` ATAU flag `vtuberStream` | REFUSE |
| worker `running` ATAU `paused` | REFUSE |
| event tak dikenal | REFUSE |

- Mood/return ikut gerbang yang sama (state mood tetap tersimpan — itu
  konteks prompt, bukan reaksi); pamit (`user_left`) dievaluasi SAAT JEDA
  SELESAI (keputusan sedekat mungkin ke ucap), bukan saat penjadwalan.
- Queued-parked TANPA pemegang slot = `"idle"` → TIDAK menyetel gate (parkir
  bukan aktivitas; arbitrase −1 tetap bekerja saat baris benar-benar
  diucapkan).
- **ctx = PUSH murni** (`setProactiveContext`, merge parsial tervalidasi;
  default chat/ON/idle = perilaku P15 lama persis). Brain tidak polling dan
  tidak membaca window. Produsen: app.js (toggle Mode Otak), mode-runtime.js
  (bridge mode + stream flag), projek.ts (petaan `activeTask.state`/busy dari
  poll `/status` 4 dtk yang sudah ada).
- **Anchor masa tenang otoritatif**: `resetQuietPeriod()` memindahkan gerbang
  `inQuietPeriod()` dan mengembalikan anchor yang sama untuk countdown UI —
  SATU sumber kebenaran (perbaikan G4).
- **Urutan arbitrase: gate PERTAMA, kanal TERAKHIR.** Saat gate lolos tapi
  kanal terpegang (race), D2 tetap menolak di klaim — LLM sudah dihabiskan;
  itu semantik S4-D yang dipertahankan [BATAS, bukan bug].
- **[BATAS] keadaan ctx adalah proyeksi per-jendela** — freshness dibatasi
  desain push: nilai worker bertahan antara poll (early-return saat fetch
  gagal = nilai terakhir); window lain punya kanal dan ctx sendiri. Arah
  kegagalan yang didokumentasikan: over-suppression (aman) dan race ≤ 4 dtk
  (ditutup baris terakhir). Tidak ada TTL/watchdog — menambahkannya butuh
  putusan user (lihat §7).

## 6. Invariansi lintas-lane [TERKUNCI]

- **Klaim SENYAP sinkron sebelum await pertama** — dua pemicu sinkron tidak
  pernah klaim ganda (S2 klaim busy; S3 slot `donoBusy`; S4-A slot task).
- **Teardown membungkam kontinuaasi lama** — generasi/mount-generation dicek
  di SETIAP titik set-side-effect; antrean tidak selamat lintas stop/teardown
  (S3-A/B `stopped+gen++`; S4-B destroy; S6 flag stream ikut bersih).
- **Antrean bounded + overflow membuang yang TERBARU + feedback eksplisit**
  (donasi, operator, parked) — tanpa drop senyap di jalur eksekusi.
- **Watchdog 60 dtk** melindungi bridge yang tidak memanggil callback
  (konvensi `speakWait`).
- **Speech ⊥ eksekusi** — supresi/gating ucap tidak pernah menyentuh
  `rt.*`/eksekusi worker (kutipan legacy `§7/§25`).
- **Kebijakan hidup di produsen; kanal beku** — channel.ts tidak menampung
  kebijakan; gate tidak pernah mem-preempt, hanya menolak lahir.

## 7. Ledger deferrals [BATAS]

Semua berikut PARKED dengan putusan tercatat — mengimplementasikannya butuh
putusan user baru:

| Item | Putusan sumber |
|---|---|
| G6 — backoff idle setelah ucap-agent | kontrak S6: tidak melakukannya; "jangan reset idle seolah user aktif" dipatuhi dengan tidak berbuat apa-apa (entri 61) |
| G8 — worker selesai tanpa panel terpasang → voiceless | defer per kontrak S6 (entri 61); sisa mitigasi quip `final_answer` = S4-A limitasi #1 |
| Worker line DROP vs DEFER (baris ke-2 hilang senyap) | "kandidat polish kecil S5+" (entri 60) |
| `app/direct` prioritas 0 (policy diam) | terdokumentasi (entri 60) |
| Modifikasi task PARKED | ditolak eksplisit, deferred (entri 59) |
| `§13 B2/B3` — remount panel → antrean parked bisa pensiun tanpa feedback per-baris; `taskId` unik per-umur-runtime | diterima eksplisit (entri 58) |
| pet.html standalone: canned bubble 90 dtk tanpa gating | di luar scope S1–S6 (tak pernah diputuskan) |
| Overlay OBS vs companion (ucap lintas-window) | out-of-kanal by contract (S1); area produk belum diputuskan |

## 8. Indeks kutipan legacy (pemetaan, bukan penulisan-ulang)

Kutipan `§n`/`O#`/`D#` di komentar kode/STATUS merujuk dokumen kontrak asli
yang tidak pernah di-commit. Pemetaan ke isi terverifikasi (jangan tulis
ulang komentar sumber):

| Kutipan | Lokasi asal | Isi terverifikasi → seksi dokumen ini |
|---|---|---|
| `§5` | brain.ts (`_claimUtterance`), entri 60 ("menutup §5") | jalur refusal D5: tanpa audio, tanpa completed palsu, tanpa release token asing → §3 |
| `§7` | `channel.ts:5`, brain.ts | tiga sumbu kepemilikan ucap → §2 |
| `§25` | brain.ts ("speech ⊥ eksekusi (§7/§25)") | speech ⊥ eksekusi — hanya sebatas kalimat yang mengutipnya; tidak ada definisi lebih rinci di bukti → §6 |
| `§13` | entri 58 ("kontrak §13 B2/B3") | deferral remount + taskId per-runtime → §7 |
| `§15` | entri 58 ("aturan §15 O4") | PARKED = eksekusi state, bukan pesan chat → §4.3 |
| `O2`, `O3→S4`, `O4→S4-B` | entri 56/57/58 | O2 = identitas operator eksplisit; O3 = task identity (S4-A); O4 = UI antrean (S4-B) → §4.2/§4.3 |
| `O1–O20` | `vtuber-operator.test.ts` | ID skenario test S3-B (O18 = guard composer tanpa LLM) → §4.2 [BUKTI] |
| `D-1..D-5` | entri 56 | keputusan desain S3-B (prioritas klaim, D-3, D-4, D-5) → §4.2 |
| `D1–D7` | entri 60 | kebijakan prioritas ucap S4-D → §3 |
| label `D1..D10`, `D5-error` di `vtuber-audience-donation.test.ts` | test S3-A | ID SKENARIO TEST, bukan keputusan D-# S3-B — jangan tertukar → §1 |
| label `S5`/`S6`/`S7` di test/smoke lama | P17/P18/smoke | skenario berprefiks, bukan fase roadmap → §1 |
