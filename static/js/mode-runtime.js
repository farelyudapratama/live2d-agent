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
    // Rail melebar hanya saat panel agent aktif (transcript butuh ruang)
    $("#sidebar").classList.toggle("agent-wide", mode === "assistant");
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

    function line(ev) {
      const cls = ev.type === "donation" ? "donation" : ev.type === "system" ? "system" : ev.type === "agent" ? "agent" : "";
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
        if (window.__debugSpeak) window.__debugSpeak(text);
        else if (window.__addChat) window.__addChat("agent", text);
      } catch (e) {}
    }

    async function maybeRespond(ev) {
      // Overlay OBS yang pegang balasan → app utama hanya jadi penonton feed.
      if (overlayOn) return;
      const respond = $("#vt-respond") && $("#vt-respond").checked;
      if (!respond) return;
      const cooldown = Math.max(5, Number(($("#vt-cooldown") || {}).value) || 12) * 1000;
      if (Date.now() - lastSpeakAt < cooldown) return; // antrean sederhana: skip
      lastSpeakAt = Date.now();
      const persona = ($("#vt-persona") || {}).value || "ceria dan ramah";
      const isDono = ev.type === "donation";
      const prompt = isDono
        ? __t("vt.donatePrompt", { user: ev.user, amount: ev.amount || "", text: ev.text })
        : __t("vt.chatPrompt", { user: ev.user, text: ev.text });
      try {
        const reply = await askLLM(
          [{ role: "user", content: prompt }],
          "Kamu adalah VTuber Live2D yang sedang streaming. Gaya bicara: " + persona + ". Jawab HANYA kalimat yang akan diucapkan, tanpa awalan nama.",
        );
        if (reply && !stopped) {
          vtuberAgentSay(reply);
          speak(reply);
        }
      } catch (e) {
        line({ type: "system", user: "system", text: __t("vt.aiFail", { msg: e.message }) });
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
          if (ev.type === "donation") alert(ev);
          if (ev.type === "chat" || ev.type === "donation") maybeRespond(ev);
        }
      } catch (e) { /* server restart dsb — coba lagi */ }
    }

    // wiring tombol start/stop
    const onStart = async () => {
      const provider = ($("#vt-provider") || {}).value || "mock";
      const body = { provider };
      if (provider === "twitch") body.channel = ($("#vt-channel") || {}).value || "";
      if (provider === "youtube") {
        body.videoId = ($("#vt-video-id") || {}).value || "";
        body.apiKey = ($("#vt-yt-key") || {}).value || "";
      }
      try {
        await post("/api/vtuber/start", body);
        status.textContent = "AKTIF (" + provider + ")";
        status.style.color = "var(--mint)";
        cursor = 0;
        feed.textContent = "";
      } catch (e) {
        status.textContent = "gagal: " + e.message;
        status.style.color = "var(--coral)";
      }
    };
    const onStop = async () => {
      stopped = true;
      try { await post("/api/vtuber/stop"); } catch (e) {}
      status.textContent = __t("vt.inactive");
      status.style.color = "";
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
    pollTimer = setInterval(poll, 2500);

    return function destroy() {
      stopped = true;
      $("#vt-start").removeEventListener("click", onStart);
      $("#vt-stop").removeEventListener("click", onStop);
      $("#vt-provider").removeEventListener("change", onProviderChange);
      $("#vt-overlay-open").removeEventListener("click", onOverlayOpen);
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      post("/api/vtuber/stop").catch(() => {});
      feed.textContent = "";
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
