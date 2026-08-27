# ATURAN: Sistem Harus Model-Agnostic

> **Prinsip yang tidak bisa dinegosiasikan.** Sistem ini harus jalan dengan
> model Live2D Cubism **apa pun** yang diimpor user — bukan cuma model yang
> kebetulan ada di `model/` sekarang (lumine, 神宫白子). Jangan pernah menyetel
> parameter spesifik hanya untuk model-model itu.

## Kenapa aturan ini ada

Kegagalannya **senyap**. Kalau sebuah fitur mengambil makna dari nama, angka,
atau urutan yang bebas ditentukan rigger, tidak akan ada error — karakternya
cuma jadi datar, salah gerak, atau menggerakkan bagian tubuh yang keliru.
User baru sadar setelah lama memakai. Empat pelanggaran nyata yang pernah ada
di kode ini:

| # | Pelanggaran | Akibat terukur |
|---|---|---|
| 1 | `ROLE_KEYWORDS.blush` menaruh `'Param91'` di prioritas tertinggi | Model lain yang punya `Param91` untuk keperluan berbeda (ekor, kancing) akan menggerakkan bagian itu setiap karakter malu |
| 2 | `PARAM_META` hardcode 9 id aksesoris bernomor dari satu model | `9` aksesoris terdeteksi di satu model, `0` di model lain. Blok itu ternyata **100% redundan** — aturan generik sudah menangkap 9/9 |
| 3 | `mapRoles()` memakai `lipSyncIds[0]` | Urutan grup `model3.json` **arbitrer**. Di lumine indeks 0 = `ParamMouthForm`, jadi `mouthOpenY` beralias ke `mouthForm` → 3 penulis berebut 1 param → **mulut tidak pernah membuka** |
| 4 | `eyeBlinkIds[0]`/`[1]` diasumsikan L-lalu-R | Rigger yang menulis R dulu akan membuat mata kiri/kanan tertukar |
| 5 | `ParamHair*` spekulatif di `PARAM_META` | 0/3 cocok di kedua model — murni tebakan |
| 6 | **Nilai literal ditulis langsung ke param role** (bypass skala) | `pokeParam(eyeLOpen, 0/1)`, `pokeParam(breath, 0..1)`, lip-sync `Math.min(1, …)`, mouth-rest `0`. Kedua model bundled **sama-sama** pakai `eyeOpen` 0..1 dan `angle` ±30 — itulah kenapa bypass ini tak pernah kelihatan |

Nomor 3 dan 4 satu spesies dengan 1 dan 2: **mengambil makna dari urutan array
sama rapuhnya dengan mengambil makna dari nama.** Nomor 6 juga: **menulis angka
literal ke param role sama saja mengasumsikan konvensi numerik rigger.**

## Menulis ke parameter: HANYA lewat role space

Semua gerak ditulis dalam **skala referensi** (±30 untuk role derajat, ±1 untuk
role ternormalisasi), lalu dipetakan ke range **nyata** milik model. Jangan pernah
menulis angka literal ke param role.

| Helper | Untuk | Arti |
|---|---|---|
| `pokeRoleRef(role, vRef)` | sudut, arah pandang | `vRef` skala referensi → dipetakan proporsional ke range model |
| `pokeRoleNorm(role, t)` | kedip, napas, buka mulut | `t` 0..1 → `min`..`max` milik model |
| `roleDefault(role)` | nilai istirahat | default **milik model**, bukan `0` |

Kenapa penting: rig yang memakai `eyeOpen` 0..100 akan menerima `pokeParam(id, 1)`
sebagai **1% terbuka** — matanya tampak terpejam terus, tanpa satu pun error.
Begitu juga rig yang `mouthOpen`-nya istirahat di nilai bukan-nol, atau yang
range kepalanya asimetris (`-10..+40`, netral di `+15`) — mengasumsikan `0`
sebagai tengah membuat kepalanya miring permanen.

## Tingkatan sumber makna (pakai dari atas)

1. **Kurva `.motion3.json`** — mengukur apa yang klip *benar-benar lakukan*. Paling tepercaya.
2. **`.cdi3.json` display name** — label asli si rigger (`Param92` → `"生气"`). Ikut di setiap ekspor Cubism dan sering dilupakan.
3. **`model3.json` `Groups`** — otoritatif soal param mana yang **anggota** grup, **tapi tidak soal urutannya**. Pakai sebagai kumpulan kandidat, lalu pilih berdasarkan nama.
4. **ID kanonik Cubism** (`ParamMouthOpenY`) — biasanya ada, tidak dijamin.
5. **Regex nama** — hanya pemecah seri. **Jangan pernah** memuat id bernomor.

## Yang dilarang

- ❌ ID bernomor (`Param91`, `Param92`) di tabel universal mana pun
- ❌ Mengambil makna dari indeks array (`lipSyncIds[0]`, `eyeBlinkIds[1]`)
- ❌ Mendaftar aksesoris secara manual — **deteksi bentuknya**: range 0..1, default 0, bukan role
- ❌ Menebak lalu diam. Kalau ambigu, **jangan resolve** — tidak ada lebih aman daripada salah
- ❌ Menambah satu regex per nama yang tidak cocok (begitulah 7 pola khusus Ichika dulu menyusup)

## Yang wajib

- ✅ **Ukur dari model**, jangan asumsikan dari daftar
- ✅ Gate setiap penulisan param: `state.modelParams.has(id)` / `sheet.controls`
- ✅ Invariant eksplisit: `mouthOpenY !== mouthForm` (dicek di `mapRoles`)
- ✅ Tolak id dari `Groups` yang tidak dimiliki model (metadata bisa basi)
- ✅ Laporkan provenance, bukan cuma persen: `curveClassified / nameOnly / unclassified`

## Cara membuktikan tidak melanggar

```bash
node test/test-role-mapping.js      # 32 tes — resolusi role model-agnostic
node test/test-param-scaling.js     # 52 tes — skala referensi & anti-bypass
node test/test-motion-taxonomy.js   # 47 tes — klasifikasi klip
```

`test-role-mapping.js` melakukan **uji invariansi penggantian nama**: rig yang
sama dideskripsikan dalam kosakata Inggris / Jepang / Mandarin harus me-resolve
ke *role* yang sama. Ada juga kasus **model opaque** (`m_001`..`m_020`) yang
harus resolve ke **nol role** — membuktikan tidak ada positif palsu — dan dua
**guard yang membaca `js/app.js` langsung**, sehingga id bernomor tidak bisa
menyusup balik tanpa memerahkan test.

Kalau menambah logika yang menyimpulkan makna: jalankan ulang dengan semua nama
diganti `m_001` / `モーション1` / hash, lalu bandingkan. Kalau distribusi
hasilnya kolaps, logika itu masih bergantung nama.

## Catatan sheet

`sheets/*.json` adalah **cache hasil scan**, bukan sumber kebenaran. Kalau
logika role-mapping berubah, sheet lama jadi basi dan menyimpan hasil resolusi
yang salah. `test-role-mapping.js` bagian H me-resolve ulang dari daftar param
dan akan memberi tahu kalau sheet di disk perlu di-scan ulang.
