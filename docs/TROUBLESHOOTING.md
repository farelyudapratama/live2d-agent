# Troubleshooting

Masalah umum dan solusinya. Detail arsitektur: [`AGENTS.md`](../AGENTS.md)
untuk agent · README untuk ringkasan produk.

- **Chat diam total?** Belum `bun run build` — `static/js/bundle.js` tidak ada (di-gitignore), jadi `window.__agent` tidak terpasang. Jalankan build, refresh.
- **Diam 30 menit?** Tab ⚙️ AI → **🎚️ Kelakuan** → **⚡ Hidup** → Simpan. Otak membaca `quietMs` langsung dari `window.__appEvents` (live, tanpa restart).
- **0 emosi?** Console `[exp3] adopted N` — kalau 0, model memang tanpa `.exp3`; bikin preset `emosi` di tab Sheet.
- **Fetch gagal?** Cek `location.origin` — jangan hardcode `127.0.0.1:8310`.
- **Model CJK 404?** `safeJoin` decode `%E7%A5%9E` → `神宫白子` di-handle `src/server/index.ts`.
- **413 saat upload?** Body melebihi cap endpoint (sheet 5 MB, upload 200 MB, import-zip 500 MB).
- **Akses dari HP/LAN?** `HOST=0.0.0.0` — sadari semua orang di jaringan bisa membaca server.
- **Model blank di headless?** Normal — swiftshader tidak render WebGL ke framebuffer; model tetap load (console `[Live2D] Model loaded`).
- **TTS 429 / suara browser terus?** Kuota provider TTS habis (mis. Gemini free tier) — sistem otomatis jatuh ke suara browser; tunggu reset kuota atau isi billing. Detail provider: ⚙️ → Mesin Suara.
- **Suara panjang terpotong/berjeda?** Pipeline per-kalimat menunggu latensi provider (Gemini ±12–16 s/request); segmen berikutnya di-prefetch — pastikan jaringan stabil. Cache server 30 mnt membuat kalimat sama instan.
- **VTuber Twitch feed kosong padahal "Terhubung"?** Sebagian ISP/proxy memblokir TMI chat Twitch — coba VPN/hotspot, atau pakai provider YouTube/mock.
- **Assistant menolak menjalankan perintah?** Itu fitur — `write_file`/`run_command` menunggu persetujuanmu di panel Assistant (kartu ⚠️).
- **STT tidak mulai merekam?** Karakter sedang bicara TTS — push-to-talk sengaja ditolak saat itu (anti-echo: tanpa itu dia mengobrol dengan dirinya sendiri).
