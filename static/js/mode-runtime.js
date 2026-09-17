/**
 * js/mode-runtime.js — Sistem mode: chat (default) / vtuber / assistant / pet.
 * Aturan ketat: HANYA SATU mode aktif. Pindah mode = runtime lama dihancurkan
 * (interval, listener, feed dibersihkan) sebelum yang baru dinyalakan.
 */
(function () {
  const API = location.origin;
  // i18n: window.__i18n dipasang bundle.js (dimuat sebelum file ini).
  const __t = (k, v) => (window.__i18n ? window.__i18n.t(k, v) : k);
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let active = "chat";
  let destroyFn = null;
  let pollTimer = null;

  // ── Util ─────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function post(path, body) {
    const r = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || "HTTP " + r.status);
    return d;
  }

  // Panggilan LLM generik (dipakai vtuber untuk membalas chat)
  async function askLLM(messages, system) {
    const r = await fetch(API + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, system }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || "LLM error");
    return d.reply || "";
  }

  // ── Mode switching ───────────────────────────────────────────
  function setPanel(mode) {
    $$(".mode-panel").forEach((p) => p.classList.add("hidden"));
    const panel = $("#mode-" + mode);
    if (panel) panel.classList.remove("hidden");
    $$("#mode-switch button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    // Workspace agent melebar dan pane teknis hanya hidup di mode Assistant.
    const workspace = $("#agent-workspace");
    if (workspace) workspace.classList.toggle("agent-wide", mode === "assistant");
    const tech = $("#agent-tech");
    if (tech) tech.classList.toggle("hidden", mode !== "assistant");
    // Mode Agent saja: panggung bersih — HUD (hint/Full Body/strip status)
    // disembunyikan via CSS body.mode-agent. Mode lain tanpa perubahan.
    document.body.classList.toggle("mode-agent", mode === "assistant");
    // Mode Chat: strip telemetri (presence/mood/masa tenang) ikut disembunyikan
    // — itu instrumen pacing siaran (VTuber), bukan bagian dari ngobrol.
    document.body.classList.toggle("mode-chat", mode === "chat");
    const labels = { chat: "Chat", vtuber: "VTuber", assistant: "Assistant", pet: "Pet" };
    const lbl = $("#mode-label");
    if (lbl) lbl.textContent = labels[mode] || mode;
  }

  async function switchMode(mode) {
    if (mode === active) { setPanel(mode); return; }
    // 1) hancurkan runtime client lama (UI saja — assistant & pet di server
    //    adalah layanan mandiri, tidak ikut dimatikan)
    try { if (destroyFn) destroyFn(); } catch (e) { console.warn("[mode] teardown lama gagal:", e); }
    destroyFn = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    // 2) mode aktif untuk PANEL; server hanya membongkar runtime vtuber
    try { await post("/api/mode", { mode }); } catch (e) { console.warn("[mode] server switch:", e.message); }
    active = mode;
    setPanel(mode);
    // S6 (bridge MURNI — nol kebijakan): beri tahu brain mode aktif supaya
    // gerbang proaktif menyetel dirinya; kebijakannya hidup di brain.ts.
    try {
      if (window.__agent && window.__agent.setProactiveContext)
        window.__agent.setProactiveContext({ mode });
    } catch (e) {}
    // 3) nyalakan runtime client baru
    if (mode === "vtuber") destroyFn = startVtuberClient();
    else if (mode === "assistant") destroyFn = startAssistantClient();
    else if (mode === "pet") destroyFn = startPetClient();
  }

  // ═════════════════════════════════════════════════════════════
  // VTUBER — feed live + balasan AI + alert donasi
  // ═════════════════════════════════════════════════════════════
  function startVtuberClient() {
    const feed = $("#vt-feed");
    const status = $("#vt-status");
    const alertBox = $("#vt-alert");
    let cursor = 0;
    let stopped = false;
    let lastSpeakAt = 0;
    let speakQueue = [];
    // Overlay OBS (vtuber.html) terhubung → app utama mundur dari balasan
    // otomatis supaya chat tidak dibalas dobel (di sini DAN di overlay).
    let overlayOn = false;

    // ── S3-A: Audience suppression + DONATION FIFO (lokal, bounded) ──
    // seenIds   : guard re-delivery event (dua poll tumpang tindih) — window
    //             300 dtk, cap 500. Dipakai audience DAN donation (identity
    //             event yang sama), BUKAN pengganti cooldown.
    // dupKeys   : suppression spam AUDIENCE saja — key = user lowercase +
    //             teks ternormalisasi (trim+lowercase+whitespace), window
    //             8 dtk. User berbeda dengan teks sama TIDAK dibungkam
    //             (percakapan sah); DONASI tidak melewati key ini sama sekali.
    // audBusy   : SATU request audience in-flight; yang lain skip (bukan
    //             antrean — audience tidak pernah punya queue, kontrak S3-A).
    // gen       : generasi mount — kontinuaasi async yang datang setelah
    //             destroy/stop dibungkam (tidak bicara ke mode/session baru).
    // donoQueue : FIFO event DONASI SEBELUM LLM (tidak pre-generate);
    //             overflow menjatuhkan yang TERBARU (FIFO yang tertampung
    //             tetap utuh), drain serialized oleh donoBusy.
    // S3-B — opQueue : FIFO perintah OPERATOR (composer jendela utama), pola
    //       persis donoQueue (cap + buang-terbaru + dedup HANYA event-id;
    //       teks operator sama BUKAN spam — tidak pernah lewat dupKeys).
    // S3-B — donoBusy kini adalah flag SATU slot aktif BERBAGI donation +
    //       operator: hanya satu lifecycle ucap yang pernah berjalan.
    //       Prioritas klaim (D-1): donasi dulu; slot yang sedang jalan
    //       TIDAK pernah dipreempt. Wake operator: rantai self-drain-nya
    //       sendiri + sapuan tiap poll (setelah donasi mengosongkan slot,
    //       drain lanjut paling lambat satu tick poll — 2,5 dtk).
    const AUDIENCE_DUP_MS = 8000;
    const AUDIENCE_SEEN_MS = 300000;
    const AUDIENCE_SEEN_MAX = 500;
    const DONO_QUEUE_MAX = 20;
    const SPEECH_WAIT_MAX_MS = 60000;
    const OP_QUEUE_MAX = 20;
    const seenIds = new Map();
    const dupKeys = new Map();
    let audBusy = false;
    let gen = 0;
    const donoQueue = [];
    const opQueue = [];
    let donoBusy = false;

    function line(ev) {
      const cls = ev.type === "donation" ? "donation" : ev.type === "system" ? "system" : ev.type === "agent" ? "agent" : ev.type === "operator" ? "operator" : "";
      const row = el("div", "vt-line " + cls);
      if (ev.type === "donation") row.appendChild(el("span", "vt-amount", String(ev.amount || "")));
      row.appendChild(el("span", "vt-user", ev.user));
      row.appendChild(document.createTextNode(ev.text || ""));
      feed.appendChild(row);
      while (feed.children.length > 120) feed.removeChild(feed.firstChild);
      feed.scrollTop = feed.scrollHeight;
    }

    function alert(ev) {
      alertBox.textContent = ev.user + " donasi " + (ev.amount || "") + "!";
      alertBox.classList.remove("hidden");
      setTimeout(() => alertBox.classList.add("hidden"), 6000);
    }

    // suara + bubble via app utama kalau ada
    function speak(text) {
      try {
        // S1: identitas vtuber/audience untuk kanal kepemilikan ucap.
        if (window.__debugSpeak) window.__debugSpeak(text, null, "vtuber/audience");
        else if (window.__addChat) window.__addChat("agent", text);
      } catch (e) {}
    }

    // S3-A helpers — semua murni atas state lokal bounded di atas.
    function pruneSeen(now) {
      for (const [id, t] of seenIds) if (now - t > AUDIENCE_SEEN_MS) seenIds.delete(id);
      while (seenIds.size > AUDIENCE_SEEN_MAX) seenIds.delete(seenIds.keys().next().value);
    }
    function alreadySeen(id) {
      return seenIds.has(Number(id));
    }
    function noteSeen(id) {
      seenIds.set(Number(id), Date.now());
      pruneSeen(Date.now());
    }
    function normKey(ev) {
      return (
        String(ev.user || "").toLowerCase() +
        "::" +
        String(ev.text || "").trim().toLowerCase().replace(/\s+/g, " ")
      );
    }
    function audienceDup(key) {
      const now = Date.now();
      for (const [k, t] of dupKeys) if (now - t > AUDIENCE_DUP_MS * 4) dupKeys.delete(k);
      if (dupKeys.size > 200) dupKeys.delete(dupKeys.keys().next().value);
      const prev = dupKeys.get(key);
      if (prev !== undefined && now - prev < AUDIENCE_DUP_MS) return true;
      dupKeys.set(key, now);
      return false;
    }

    // speakWait: ucapkan lewat kanal S1 dan TUNGGU siklus hidupnya selesai.
    // 'completed' dan 'lost' sama-sama mengakhiri slot (tidak ada retry-loop
    // tanpa batas); watchdog melindungi bridge yang tidak memanggil callback.
    function speakWait(text, producer) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          resolve();
        };
        const watchdog = setTimeout(finish, SPEECH_WAIT_MAX_MS);
        try {
          if (window.__debugSpeak) window.__debugSpeak(text, finish, producer);
          else if (window.__addChat) window.__addChat("agent", text);
          else finish();
        } catch (e) {
          finish();
        }
      });
    }

    // AUDIENCE (S3-A): dedup → cooldown → in-flight. Yang ditekan TIDAK
    // pernah masuk antrean apa pun — skip adalah final (kebijakan produk).
    async function maybeRespond(ev) {
      // Overlay OBS yang pegang balasan → app utama hanya jadi penonton feed.
      if (overlayOn) return;
      const respond = $("#vt-respond") && $("#vt-respond").checked;
      if (!respond) return;
      if (alreadySeen(ev.id)) return;                 // polling dobel → satu proses
      noteSeen(ev.id);
      if (audienceDup(normKey(ev))) return;           // spam user yang sama, 8 dtk
      const cooldown = Math.max(5, Number(($("#vt-cooldown") || {}).value) || 12) * 1000;
      if (Date.now() - lastSpeakAt < cooldown) return; // kebijakan lama: skip
      if (audBusy) return;                             // tak pernah 2 request paralel
      lastSpeakAt = Date.now();
      audBusy = true;
      const myGen = gen;
      const persona = ($("#vt-persona") || {}).value || "ceria dan ramah";
      try {
        const reply = await askLLM(
          [{ role: "user", content: __t("vt.chatPrompt", { user: ev.user, text: ev.text }) }],
          "Kamu adalah VTuber Live2D yang sedang streaming. Gaya bicara: " + persona + ". Jawab HANYA kalimat yang akan diucapkan, tanpa awalan nama.",
        );
        if (reply && !stopped && myGen === gen) {
          vtuberAgentSay(reply);
          speak(reply);
        }
      } catch (e) {
        if (!stopped && myGen === gen)
          line({ type: "system", user: "system", text: __t("vt.aiFail", { msg: e.message }) });
      } finally {
        if (myGen === gen) audBusy = false;
      }
    }

    // DONATION (S3-A): TIDAK pernah lewat cooldown/dup audience — selalu
    // masuk FIFO; tidak ada yang hilang karena audience sedang antre/sibuk.
    function enqueueDonation(ev) {
      if (alreadySeen(ev.id)) return;                 // D5: polling dobel → sekali
      noteSeen(ev.id);
      if (donoQueue.length >= DONO_QUEUE_MAX) {
        console.warn("[vtuber] antrean donasi penuh — donasi TERBARU dilewati (bounded)");
        return;                                       // yang terbuang = yang baru (FIFO utuh)
      }
      donoQueue.push(ev);
      pumpDonations();
    }

    // Drain serialized: satu donasi aktif; lanjut HANYA setelah siklus ucap
    // selesai (completed/lost) — bukan saat request/bubble mulai.
    async function pumpDonations() {
      if (donoBusy) return;                           // D10: dua trigger → satu drain
      const ev = donoQueue.shift();
      if (!ev) return;                                // D9: drain queue kosong aman
      donoBusy = true;
      const myGen = gen;
      try {
        if (stopped || myGen !== gen) return;         // teardown menang: diam
        const respond = $("#vt-respond") && $("#vt-respond").checked;
        if (overlayOn || !respond) return;            // yield/mute existing: slot
                                                      // TETAP diakhiri (tanpa sumbat)
        const persona = ($("#vt-persona") || {}).value || "ceria dan ramah";
        try {
          const reply = await askLLM(
            [
              {
                role: "user",
                content: __t("vt.donatePrompt", { user: ev.user, amount: ev.amount || "", text: ev.text }),
              },
            ],
            "Kamu adalah VTuber Live2D yang sedang streaming. Gaya bicara: " + persona + ". Jawab HANYA kalimat yang akan diucapkan, tanpa awalan nama.",
          );
          if (reply && !stopped && myGen === gen) {
            vtuberAgentSay(reply);
            // COMPLETION POINT: queue maju hanya setelah lifecycle ucap via
            // kanal S1 selesai — 'lost' juga mengakhiri slot (no retry loop).
            await speakWait(reply, "vtuber/donation");
          }
        } catch (e) {
          // D5-error: LLM gagal → slot tetap selesai, queue tidak deadlock.
          if (!stopped && myGen === gen)
            line({ type: "system", user: "system", text: __t("vt.aiFail", { msg: e.message }) });
        }
      } finally {
        if (myGen === gen) donoBusy = false;
        if (myGen === gen && !stopped && donoQueue.length) pumpDonations();
      }
    }

    // OPERATOR (S3-B): TIDAK pernah lewat cooldown/dup audience — perintah
    // eksplisit bukan spam. Dedup hanya event-id (identity yang sama dengan
    // donasi: satu event tidak pernah diproses dua jalur).
    function enqueueOperator(ev) {
      if (alreadySeen(ev.id)) return;                 // polling dobel → sekali
      noteSeen(ev.id);
      if (opQueue.length >= OP_QUEUE_MAX) {
        console.warn("[vtuber] antrean operator penuh — perintah TERBARU dilewati (bounded)");
        return;                                       // yang terbuang = yang baru (FIFO utuh)
      }
      opQueue.push(ev);
      pumpOperators();
    }

    // Slot BERSAMA (donoBusy) — klaim sinkron sebelum await pertama. D-1:
    // saat slot bebas dan donasi menunggu, donasi yang klaim lebih dulu;
    // operator tidak pernah mem-preempt slot yang sedang jalan.
    async function pumpOperators() {
      if (donoBusy) return;                           // satu slot: donasi/operatorku
      if (donoQueue.length) { pumpDonations(); return; } // prioritas klaim D-1
      const ev = opQueue.shift();
      if (!ev) return;                                // drain queue kosong aman
      donoBusy = true;
      const myGen = gen;
      try {
        if (stopped || myGen !== gen) return;         // teardown menang: diam
        // D-3: perintah operator = input eksplisit manusia untuk jendela
        // utama — TIDAK diredam switch auto-balas audience maupun overlay
        // OBS. Yang boleh membungkamnya hanya lifecycle (stopped/gen).
        const persona = ($("#vt-persona") || {}).value || "ceria dan ramah";
        try {
          const reply = await askLLM(
            [
              {
                role: "user",
                content: __t("vt.operatorPrompt", { text: ev.text }),
              },
            ],
            "Kamu adalah VTuber Live2D yang sedang streaming. Gaya bicara: " + persona + ". Jawab HANYA kalimat yang akan diucapkan, tanpa awalan nama.",
          );
          if (reply && !stopped && myGen === gen) {
            vtuberAgentSay(reply);
            // COMPLETION POINT: sama persis dengan donasi — queue maju hanya
            // setelah lifecycle ucap (completed ATAU lost) berakhir.
            await speakWait(reply, "vtuber/operator");
          }
        } catch (e) {
          // LLM gagal → slot berakhir, antrean tidak deadlock.
          if (!stopped && myGen === gen)
            line({ type: "system", user: "system", text: __t("vt.aiFail", { msg: e.message }) });
        }
      } finally {
        if (myGen === gen) donoBusy = false;
        if (myGen === gen && !stopped && (donoQueue.length || opQueue.length)) {
          // Rantai release: donasi tetap menang klaim saat dua antrean menunggu.
          if (donoQueue.length) pumpDonations(); else pumpOperators();
        }
      }
    }

    async function poll() {
      if (stopped) return;
      try {
        const r = await fetch(API + "/api/vtuber/events?since=" + cursor);
        const d = await r.json();
        cursor = d.cursor || cursor;
        const nowOverlay = !!d.overlay;
        if (nowOverlay && !overlayOn)
          line({ type: "system", user: "system", text: __t("vt.overlayYield") });
        overlayOn = nowOverlay;
        for (const ev of d.events || []) {
          line(ev);
          // S3-A: klasifikasi jalur di SATU titik — donasi tidak pernah lewat
          // cooldown/dedup audience, dan sebaliknya. S3-B: operator jalur
          // ketiganya — tidak pernah disalahartikan sebagai chat penonton.
          if (ev.type === "donation") {
            alert(ev);
            enqueueDonation(ev);
          } else if (ev.type === "chat") {
            maybeRespond(ev);
          } else if (ev.type === "operator") {
            enqueueOperator(ev);
          }
        }
        // Wake bounded: donasi yang barusan mengosongkan slot tidak punya
        // rantai ke operator; sapuan tiap poll (2,5 dtk) menjamin drain lanjut.
        pumpOperators();
        } catch (e) { /* server restart dsb — coba lagi */ }
    }

    // wiring tombol start/stop
    const vtStartBtn = $("#vt-start");
    const vtStopBtn = $("#vt-stop");
    const setStatus = (text, color) => {
      status.textContent = text;
      status.style.color = color || "";
    };
    const reflectRunning = (running) => {
      // State tombol = state stream: tidak ada dua aksi aktif sekaligus.
      vtStartBtn.disabled = running;
      vtStopBtn.disabled = !running;
    };
    reflectRunning(false);
    const onStart = async () => {
      const provider = ($("#vt-provider") || {}).value || "mock";
      const body = { provider };
      if (provider === "twitch") body.channel = ($("#vt-channel") || {}).value || "";
      if (provider === "youtube") {
        body.videoId = ($("#vt-video-id") || {}).value || "";
        body.apiKey = ($("#vt-yt-key") || {}).value || "";
      }
      vtStartBtn.disabled = true; // cegah dobel-klik selama request
      try {
        await post("/api/vtuber/start", body);
        setStatus("AKTIF (" + provider + ")", "var(--mint)");
        reflectRunning(true);
        cursor = 0;
        feed.textContent = "";
        // S6 bridge: stream NYATA menyala → proaktif companion wajib sunyi
        // (sabuk pengaman selain gate mode — flag ikut dibaca brain).
        publishStreamFlag(true);
      } catch (e) {
        setStatus("gagal: " + e.message, "var(--coral)");
        reflectRunning(false);
      }
    };
    const onStop = async () => {
      stopped = true;
      gen++;                       // S3-A: bungkam kontinuaasi donasi/audience in-flight
      donoQueue.length = 0;        // S3-A: antrean tidak boleh selamat lintas stop
      opQueue.length = 0;          // S3-B: antrean operator ikut mati — stop bersih
      publishStreamFlag(false);    // S6: stream berhenti → companion boleh aktif lagi
      vtStopBtn.disabled = true;
      try { await post("/api/vtuber/stop"); } catch (e) {}
      setStatus(__t("vt.inactive"));
      reflectRunning(false);
    };
    const onProviderChange = () => {
      const v = ($("#vt-provider") || {}).value;
      $("#vt-row-channel").classList.toggle("hidden", v !== "twitch");
      $("#vt-row-ytid").classList.toggle("hidden", v !== "youtube");
      $("#vt-row-ytkey").classList.toggle("hidden", v !== "youtube");
    };
    $("#vt-start").addEventListener("click", onStart);
    $("#vt-stop").addEventListener("click", onStop);
    $("#vt-provider").addEventListener("change", onProviderChange);
    onProviderChange();
    // Overlay OBS: halaman transparan untuk Browser Source. Dibuka dengan
    // ?hud=1 (panel preferensi tampil); URL untuk OBS = tanpa ?hud=1.
    const onOverlayOpen = () => window.open(API + "/vtuber.html?hud=1", "_blank");
    $("#vt-overlay-open").addEventListener("click", onOverlayOpen);
    // S3-B composer — operator mengetik perintah langsung: HANYA menyuntik
    // event "operator" ke feed server lewat pintu resmi mock-event. Tidak ada
    // LLM/ucap di composer; pemrosesan penuh lewat FIFO responder yang sama
    // (guard O18 mengunci tidak adanya askLLM/speak pada jalur ini).
    const opInputEl = $("#vt-operator-input");
    const opSendEl = $("#vt-operator-send");
    function onOperatorSend() {
      const text = String((opInputEl && opInputEl.value) || "").trim();
      if (!text) return;                              // input kosong = bukan perintah
      if (opInputEl) opInputEl.value = "";
      post("/api/vtuber/mock-event", { type: "operator", user: "operator", text }).catch((e) => {
        setStatus("gagal: " + e.message, "var(--coral)");
      });
    }
    const onOperatorKey = (e) => { if (e.key === "Enter") onOperatorSend(); };
    if (opSendEl) opSendEl.addEventListener("click", onOperatorSend);
    if (opInputEl) opInputEl.addEventListener("keydown", onOperatorKey);
    pollTimer = setInterval(poll, 2500);
    // S6 bridge helper — flag stream hidup/mati untuk gate proaktif brain.
    function publishStreamFlag(on) {
      try {
        if (window.__agent && window.__agent.setProactiveContext)
          window.__agent.setProactiveContext({ vtuberStream: !!on });
      } catch (e) {}
    }

    return function destroy() {
      stopped = true;
      gen++;                  // S3-A: bungkam kontinuaasi donasi/audience in-flight
      donoQueue.length = 0;   // S3-A: queue tidak survive teardown
      opQueue.length = 0;     // S3-B: queue operator juga tidak
      publishStreamFlag(false); // S6: pindah mode = stop di server → flag ikut bersih
      $("#vt-start").removeEventListener("click", onStart);
      $("#vt-stop").removeEventListener("click", onStop);
      $("#vt-provider").removeEventListener("change", onProviderChange);
      $("#vt-overlay-open").removeEventListener("click", onOverlayOpen);
      if (opSendEl) opSendEl.removeEventListener("click", onOperatorSend);
      if (opInputEl) opInputEl.removeEventListener("keydown", onOperatorKey);
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      post("/api/vtuber/stop").catch(() => {});
      feed.textContent = "";
      reflectRunning(false);
    };
  }

  // Helper dipanggil dari vtuber client untuk mencatat balasan AI di feed
  function vtuberAgentSay(text) {
    fetch(API + "/api/vtuber/mock-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "agent", user: "AI", text }),
    }).catch(() => {});
  }

  // ═════════════════════════════════════════════════════════════
  // ASSISTANT — panel agent (remake ala ZCode)
  // Seluruh logic panel (streaming SSE, transcript, kartu tool/approval,
  // plan, memory, direktur akting) sudah port ke TS:
  //   src/client/agent/panel/ → window.__agentPanel (bundle.js)
  // File ini hanya bridge mode: pasang/lepas UI, tanpa logika.
  // Panel ini hanya LAYAR: runtime assistant di server adalah layanan
  // mandiri (tetap hidup saat pindah panel / CLI agent memakainya juga).
  // ═════════════════════════════════════════════════════════════
  function startAssistantClient() {
    if (window.__agentPanel && typeof window.__agentPanel.start === "function") {
      try {
        return window.__agentPanel.start();
      } catch (e) {
        console.warn("[assistant] panel gagal nyala:", e);
        return function () {};
      }
    }
    // bundle belum terpasang (build lama / gagal) — degrade gracefully,
    // jangan crash (pola sama dengan brain di app.js).
    console.warn("[assistant] window.__agentPanel tidak ada — jalankan `bun run build`");
    return function () {};
  }

  // ═════════════════════════════════════════════════════════════
  // PET — jendela overlay terpisah
  // ═════════════════════════════════════════════════════════════
  function startPetClient() {
    const status = $("#pet-status");
    let throughOn = false;
    async function checkStatus() {
      try {
        const st = await fetch(API + "/api/mode").then((r) => r.json());
        if (!st.pet?.running) {
          status.textContent = __t("pet.notOpen");
          throughOn = false;
        } else if (st.pet.shell) {
          status.textContent =
            (st.pet.shell === "tauri" ? "shell Tauri" : "shell Chrome/Edge") +
            (st.pet.clickThrough ? __t("pet.clickThroughOn") : "") +
            (st.pet.shell === "tauri" ? "" : __t("pet.noClickThrough"));
        } else {
          status.textContent = __t("pet.windowOpen");
        }
        paintThrough();
      } catch (e) { status.textContent = ""; }
    }
    function paintThrough() {
      const b = $("#pet-through");
      if (b) {
        b.textContent = throughOn ? __t("pet.clickThroughOnBtn") : __t("pet.clickThrough");
        b.classList.toggle("active", throughOn);
      }
    }
    const onLaunch = async () => {
      status.textContent = __t("pet.opening");
      try {
        const d = await post("/api/pet/launch");
        status.textContent = d.how ? __t("pet.openedHow", { how: d.how }) : __t("pet.opened");
        checkStatus();
      } catch (e) { status.textContent = "gagal: " + e.message; }
    };
    const onClose = async () => {
      try { await post("/api/pet/close"); } catch (e) {}
      throughOn = false;
      paintThrough();
      status.textContent = "ditutup";
    };
    // Klik-tembus hanya ada di shell Tauri; server mengabaikan bila shell
    // browser. Saat menyala, satu-satunya cara mematikan adalah dari sini —
    // klik pada jendela pet menembus ke desktop.
    const onThrough = async () => {
      throughOn = !throughOn;
      paintThrough();
      try {
        const d = await post("/api/pet/clickthrough", { on: throughOn });
        throughOn = !!d.clickThrough;
        paintThrough();
      } catch (e) {
        throughOn = false;
        paintThrough();
      }
    };
    $("#pet-launch").addEventListener("click", onLaunch);
    $("#pet-close").addEventListener("click", onClose);
    $("#pet-through").addEventListener("click", onThrough);
    checkStatus();
    const iv = setInterval(checkStatus, 5000);
    // Auto-buka saat panel pet dipilih — TAPI hanya kalau jendela belum
    // jalan; onLaunch mematikan-menyalakan, jadi re-enter panel tidak
    // me-restart jendela yang sudah ada.
    (async () => {
      try {
        const st = await fetch(API + "/api/mode").then((r) => r.json());
        if (st.pet?.running) { checkStatus(); return; }
      } catch (e) {}
      onLaunch();
    })();

    return function destroy() {
      // Panel ditutup ≠ jendela pet ditutup: pet adalah layanan mandiri
      // (kontrak baru sejak shell Tauri). Yang dilepas hanya UI panel.
      $("#pet-launch").removeEventListener("click", onLaunch);
      $("#pet-close").removeEventListener("click", onClose);
      $("#pet-through").removeEventListener("click", onThrough);
      clearInterval(iv);
    };
  }

  // ── Boot ─────────────────────────────────────────────────────
  $$("#mode-switch button").forEach((b) => b.addEventListener("click", () => switchMode(b.dataset.mode)));
  fetch(API + "/api/mode").then((r) => r.json()).then((st) => {
    // mode tersimpan di server hanya berlaku sesi runtime; UI selalu mulai chat
    setPanel("chat");
  }).catch(() => setPanel("chat"));

  // ekspor untuk debug
  window.__modeRuntime = { switchMode, get active() { return active; } };
})();
