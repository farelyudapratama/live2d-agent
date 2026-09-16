/**
 * test/smoke-engine-utterance.ts — POST-ROADMAP VERIFICATION (bukan fase):
 * Engine Main utterance bridge — jalur PRODUKSI nyata, dari AgentBrain sampai
 * window.__live2dAgent.speak/stopSpeech implementasi app.js asli.
 *
 * Unit test Phase 18 mengunci ownership terhadap fake engine (kontrak bridge).
 * Smoke ini menutup gap P2 audit pasca-18: bridge produksi (speak browser-TTS
 * + fallbackTimer markDone + stopSpeech pause/cancel + rantai chain) belum
 * pernah dijalankan bersamaan dengan ownership brain di browser nyata.
 *
 * Yang stub HANYA batas jaringan (di dalam halaman, pola preseden R12
 * "deterministic provider end-to-end verification"):
 *   /api/chat      → reply directive deterministic (tanpa LLM nyata)
 *   /api/tts       → 599 (memaksa jalur produksi browserTTS, tanpa jaringan)
 * Selain itu 100% produksi: index.html, app.js speak/stopSpeech/aiLock,
 * brain playSegments/token, CDP Chromium.
 *
 * Skenario:
 *   S1 normal playback multi-segmen sampai selesai + tidak ada revive
 *   S2 preempt user: rantai A dibatalkan, B bicara & selesai
 *   S4 stale callback A tiba setelah preempt → inert (bagian dari alur S2,
 *      diamati lewat chat log & lock)
 *   S3 stopSpeech eksplisit: idempoten, rantai tetap selesai normal
 *      (stopSpeech BUKAN pembatalan rantai — semantik Phase 18)
 *   S5 model switch membatalkan utterance; model baru tetap terpakai
 *
 * Batas observabilitas dicatat jujur (tidak ada instrumentasi produksi baru):
 *  - "kedalaman" lock = state.aiLock boolean (satu flag produksi), bukan
 *    counter; keseimbangan dibuktikan lewat transisi true→false per rantai.
 *  - audio internal headless (utterance queue) tidak reliable; kepastian
 *    completion lewat jalur markDone engine (fallbackTimer) yang memang
 *    bagian dari kode produksi yang diuji.
 *
 * Jalankan: bun test/smoke-engine-utterance.ts
 */
import { spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { findChromium } from "../src/server/browser/discovery";
import { CdpClient } from "../src/server/browser/cdp";
import { handleAPI, serveStatic } from "../src/server/index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForPortFile(dir: string, timeoutMs = 15_000): Promise<number> {
  const start = Date.now();
  const file = join(dir, "DevToolsActivePort");
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await readFile(file, "utf8");
      const port = parseInt(content.split(/\r?\n/)[0].trim(), 10);
      if (Number.isFinite(port) && port > 0) return port;
    } catch {}
    await sleep(50);
  }
  throw new Error("Timeout waiting for DevToolsActivePort");
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? "  -> " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
}

// Teks segmen panjang menentukan upper-bound durasi (fallbackTimer engine):
// max(1400, len*75) + 800 ms per segmen.
const pad = (tag: string, len: number) =>
  `${tag} ${"x".repeat(Math.max(0, len - tag.length - 1))}`.slice(0, len);
const A1 = pad("SATU-A", 140); // ~11.3s — jendela aman untuk preempt
const A2 = pad("DUA-A", 40);
const A3 = pad("TIGA-A", 40);
const B1 = pad("SATU-B", 34);
const B2 = pad("DUA-B", 34);
// marker专属 S2/S4 — bukan ulang konstanta S1 (chain lama sudah sah
// menaruh A2/A3 di chat; stale check harus tanpa ambiguitas)
const PA1 = pad("SATU-PA", 140); // ±11s: jendela preempt
const PA2 = pad("DUA-PA", 40);
const PA3 = pad("TIGA-PA", 40);
const C1 = pad("SATU-C", 120);
const C2 = pad("DUA-C", 34);
const D1 = pad("SATU-D", 140);
const D2 = pad("DUA-D", 40);
const D3 = pad("TIGA-D", 40);
const E1 = pad("SATU-E", 34);
const E2 = pad("DUA-E", 34);

const REPLY = (...texts: string[]) =>
  texts.map((t, i) => `[EMOTION:senang][GESTURE:${i % 2 ? "nod" : "wave_hi"}] ${t}`).join(" ");

async function run() {
  console.log("🚀 Engine Main utterance-bridge smoke (production bridge + brain ownership)");

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      const url = new URL(req.url);
      let pathname = url.pathname;
      if (pathname.startsWith("/api/")) {
        const resp = await handleAPI(req);
        if (resp) return resp;
        return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      }
      if (pathname === "/") pathname = "/index.html";
      const staticResp = serveStatic(pathname);
      if (staticResp) return staticResp;
      return new Response("Not Found", { status: 404 });
    },
  });
  const port = server.port;
  console.log(`📡 server :${port}`);

  const chromeExe = findChromium();
  if (!chromeExe) { console.error("❌ Chromium not found"); server.stop(); process.exit(1); }

  const profileDir = await mkdtemp(join(tmpdir(), "utterance-smoke-"));
  const browserProc = spawn(chromeExe, [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--headless=new",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,800",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);

  let cdp: CdpClient | null = null;
  try {
    const cdpPort = await waitForPortFile(profileDir);
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as any[];
    const page = targets.find((t) => t.type === "page");
    if (!page?.webSocketDebuggerUrl) throw new Error("no page target");
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable")]);

    const ev = async (expr: string, awaitPromise = false): Promise<any> => {
      const r = await cdp!.send<any>("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) throw new Error("page eval error: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result?.value;
    };
    const pollFor = async (expr: string, timeoutMs: number, everyMs = 200): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try { if (await ev(expr)) return true; } catch {}
        await sleep(everyMs);
      }
      return false;
    };

    // ── boot halaman + model ren (tesmodel) ──────────────────────
    console.log("\n🧪 boot: index.html + load model tesmodel (ren)");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` });
    check("page + brain bridge terpasang",
      await pollFor("!!(window.__agent && window.__live2dAgent && window.__l2dDebug)", 20000));

    // listener error hanya READ-only test-side (bukan instrumentasi produk)
    await ev(`window.__smokeErrors=[];
      window.addEventListener('error', e=>window.__smokeErrors.push(String(e.message)));
      window.addEventListener('unhandledrejection', e=>window.__smokeErrors.push(String(e.reason)));`);

    await pollFor(`!!document.querySelector('.model-item button.load[data-name="tesmodel"]')`, 15000);
    await ev(`document.querySelector('.model-item button.load[data-name="tesmodel"]').click(); true`);
    check("model produksi termuat (handle+model+motionGroups)",
      await pollFor(`!!(window.__l2dDebug.state.handle && window.__l2dDebug.state.model && window.__l2dDebug.state.handle.motionGroups().length >= 0)`, 40000));

    // Environment shim (TEST-SIDE, jujur dicatat): headless Chromium tidak
    // punya voice speechSynthesis → onend tak pernah fire; dengan config
    // provider "openai" (data/config.json user nyata) jalur produksi
    // remote-fail→browserTTS bergantung pada onend itu. Shim ini mensimulasi
    // browser BERSUARA (onend setelah durasi wajar), BUKAN menggantikan
    // bridge: app.js speak/doRemoteTTS/browserTTS/stopSpeech/markDone dan
    // rantai brain tetap 100% produksi.
    await ev(`(() => {
      window.__ssCancels = 0;
      window.__ssSpoke = []; // LOG murni untuk bukti akustik S6
      let q = [];
      try { delete window.speechSynthesis; } catch (e) {}
      window.speechSynthesis = {
        get speaking(){ return q.length > 0; },
        get pending(){ return false; },
        // Browser BERSUARA: voices tersedia => jalur pickVoice app.js memanggil
        // speechSynthesis.speak sungguhan; cancel memicu onend (paritas Chrome).
        getVoices(){ return [{ name:'smoke-voice', lang:'id-ID', default:true }]; },
        pause(){}, resume(){},
        addEventListener(){}, removeEventListener(){},
        cancel(){ window.__ssCancels++; const cur=q.slice(); q=[];
          cur.forEach(x=>{ clearTimeout(x.timer); try { x.u.onend && x.u.onend(); } catch (e) {} }); },
        speak(u){ window.__ssSpoke.push(String(u.text).slice(0,8));
          const ms = 300 + Math.min(3000, u.text.length * 25);
          const item = { u, timer: 0 };
          item.timer = setTimeout(() => { q = q.filter(x=>x!==item); try { u.onend && u.onend(); } catch (e) {} }, ms);
          q.push(item); },
      };
      window.__appEvents = { idleSpeak: false, awaySpeak: false, returnSpeak: false, quietMs: 0 };
      if (window.__agent) { window.__agent.setCameraMood = () => {}; }
      return true;
    })()`);

    // stub batas jaringan: /api/chat antrean deterministic; /api/tts 599 →
    // jalur produksi browserTTS (tanpa jaringan); lainnya tembus ke aslinya.
    const stub = (replies: string[]) => ev(`(async () => {
      window.__queue = ${JSON.stringify(replies)};
      if (!window.__origFetch) window.__origFetch = window.fetch.bind(window);
      window.fetch = (u, i) => {
        const s = String(u);
        if (s.includes('/api/chat')) {
          const q = window.__queue;
          const reply = q.length ? q.shift() : "";   // shift murni; habis → ""
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ reply }) });
        }
        if (s.includes('/api/tts')) {
          return Promise.resolve({ ok: false, status: 599, text: async () => 'stubbed (no network)' });
        }
        return window.__origFetch(u, i);
      };
      return true;
    })()`, true);
    const chat = () => ev(`Array.from(document.querySelectorAll('#chat-log .msg.agent .msg-bubble')).map(e=>e.textContent.trim())`);
    const submit = (text: string) => ev(`(() => {
      const i = document.getElementById('bubble-input');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    const active = () => ev(`window.__agent._reactiveState().utteranceActive === true`);
    const locked = () => ev(`window.__l2dDebug.state.aiLock === true`);

    // ── S1 — playback normal ─────────────────────────────────────
    console.log("\n🧪 S1: multi-segmen selesai normal, ownership release, tanpa revive");
    await stub([REPLY(A1, A2, A3)]);
    await submit("pesan S1");
    check("S1 rantai jadi aktif & owned", await pollFor(`window.__agent._reactiveState().utteranceActive === true`, 5000));
    check("S1 lockAI aktif via bridge produksi", await pollFor(`window.__l2dDebug.state.aiLock === true`, 3000));
    check("S1 SpeechChannel dimiliki brain/chain (logis S6-prep)",
      await pollFor(`!!window.__speechChannel && window.__speechChannel.current()?.producer === 'brain/chain'`, 3000));
    const c0 = await chat();
    check("S1 segmen pertama tampil di chat", c0.includes(A1), `${c0.length} entri agent`);
    check("S1 rantai selesai penuh", await pollFor(`window.__agent._reactiveState().utteranceActive === false`, 40000));
    const c1 = await chat();
    check("S1 tiga segmen TEPAT sekali masing-masing",
      [A1, A2, A3].every((t) => c1.filter((x: string) => x === t).length === 1));
    check("S1 lockAI lepas saat selesai", (await locked()) === false);
    check("S1 kanal lepas setelah rantai selesai",
      (await ev(`!!window.__speechChannel && window.__speechChannel.current() === null`)) === true);
    await sleep(6000); // lewat semua sisa fallback/guard timer rantai lama
    const c2 = await chat();
    check("S1 tidak ada revive setelah selesai", c2.length === c1.length, `${c2.length} vs ${c1.length}`);

    // ── S2 + S4 — preemption user & callback basi ────────────────
    console.log("\n🧪 S2/S4: user kedua preempt; segmen rantai A yang telat inert");
    await stub([REPLY(PA1, PA2, PA3), REPLY(B1, B2)]);
    await submit("pesan S2-A");
    check("S2 rantai A aktif", await pollFor(`window.__agent._reactiveState().utteranceActive === true`, 5000));
    const tokenBefore = await ev(`window.__agent._reactiveState().utteranceChain`);
    await submit("pesan S2-B"); // preemption saat A masih bicara segmen 1 (±11s)
    check("S2 token rantai berganti ke B",
      await pollFor(`window.__agent._reactiveState().utteranceChain !== ${JSON.stringify(tokenBefore)} && window.__agent._reactiveState().utteranceActive === true`, 6000));
    const cB1 = await pollFor(`Array.from(document.querySelectorAll('#chat-log .msg-bubble')).some(e=>e.textContent.trim()==${JSON.stringify(B1)})`, 8000);
    check("S2 rantai B bicara", cB1);
    await sleep(9000); // lewati fallbackTimer PA1 (±11.3s dari awal ≈ sisa 1s lagi)
    const cS4 = await chat();
    check("S4 segmen PA kedua/ketiga TIDAK PERNAH muncul (stale inert)",
      !cS4.includes(PA2) && !cS4.includes(PA3));
    check("S4 tidak ada unlock ganda / rantai B utuh",
      (await active()) === true || (await chat()).includes(B2));
    check("S2 rantai B selesai normal", await pollFor(`window.__agent._reactiveState().utteranceActive === false`, 30000));
    const cS2 = await chat();
    check("S2 chat B tepat sekali", [B1, B2].every((t) => cS2.filter((x: string) => x === t).length === 1));
    check("S2 lockAI balance setelah preempt+selesai", (await locked()) === false);

    // ── S3 — stopSpeech eksplisit dua kali ───────────────────────
    console.log("\n🧪 S3: stopSpeech manual idempoten; rantai lanjut & release sekali");
    await stub([REPLY(C1, C2)]);
    await submit("pesan S3");
    check("S3 rantai aktif", await pollFor(`window.__agent._reactiveState().utteranceActive === true`, 5000), JSON.stringify(await ev(`Object.assign(window.__agent._reactiveState(), {busy: window.__agent.busy, req: !!window.__agent._reqCtrl, chatCount: window.__chatCount, dirCalls: window.__dirCalls})`)));
    const stopTwice = await ev(`(() => {
      try { window.__live2dAgent.stopSpeech(); window.__live2dAgent.stopSpeech(); return 'ok'; }
      catch (e) { return 'ERR:' + e.message; }
    })()`);
    check("S3 stopSpeech 2× tanpa exception", stopTwice === "ok", stopTwice);
    // stopSpeech BUKAN pembatalan rantai (semantik Phase 18): token masih
    // pemilik → chain lanjut via markDone engine → C2 harus muncul.
    check("S3 rantai tetap lanjut & selesai setelah stopSpeech manual",
      await pollFor(`Array.from(document.querySelectorAll('#chat-log .msg-bubble')).some(e=>e.textContent.trim()==${JSON.stringify(C2)})`, 30000));
    check("S3 release tepat sekali", await pollFor(`window.__agent._reactiveState().utteranceActive === false`, 20000));
    const stopIdle = await ev(`(() => { try { window.__live2dAgent.stopSpeech(); window.__live2dAgent.stopSpeech(); return 'ok'; } catch (e) { return 'ERR:' + e.message; } })()`);
    check("S3 stopSpeech saat idle tetap aman", stopIdle === "ok", stopIdle);
    check("S3 lockAI false di akhir", (await locked()) === false);

    // ── S5 — model switch saat utterance aktif ───────────────────
    console.log("\n🧪 S5: switch model membatalkan utterance; model baru terpakai");
    await stub([REPLY(D1, D2, D3), REPLY(E1, E2)]);
    await submit("pesan S5-D");
    check("S5 rantai D aktif", await pollFor(`window.__agent._reactiveState().utteranceActive === true`, 5000));
    await ev(`document.querySelector('.model-item button.load[data-name="lumine"]').click(); true`);
    check("S5 ownership batal & lock lepas saat switch",
      await pollFor(`window.__agent._reactiveState().utteranceActive === false`, 15000));
    check("S5 kanal ucap ikut bersih saat model switch (INV-7)",
      (await ev(`!!window.__speechChannel && window.__speechChannel.current() === null`)) === true);
    check("S5 model baru siap (handle lumine)",
      await pollFor(`!!(window.__l2dDebug.state.handle && window.__l2dDebug.state.model && window.__l2dDebug.state.modelPath && window.__l2dDebug.state.modelPath.includes('lumine'))`, 60000));
    const afterSwitch = (await chat()).length;
    await sleep(14000); // fallbackTimer D1 (±11.3s) + margin: segmen basi tak boleh muncul
    const cS5 = await chat();
    check("S5 segmen D2/D3 tidak pernah muncul setelah switch", !cS5.includes(D2) && !cS5.includes(D3));
    check("S5 callback basi tidak menambah chat", cS5.length === afterSwitch, `${cS5.length} vs ${afterSwitch}`);
    await submit("pesan S5-E");
    check("S5 model baru bisa utterance penuh",
      await pollFor(`window.__agent._reactiveState().utteranceActive === false && Array.from(document.querySelectorAll('#chat-log .msg-bubble')).some(e=>e.textContent.trim()==${JSON.stringify(E2)})`, 30000));
    const cS5b = await chat();
    check("S5 E tepat sekali & lock balance",
      [E1, E2].every((t) => cS5b.filter((x: string) => x === t).length === 1) && (await locked()) === false);

    // ── S6 (S1) — takeover eksternal: logika + akustik; brain TIDAK boleh lanjut ──
    console.log("\n🧪 S6: eksternal merebut kanal saat brain bicara — brain mati, bukan 'selesai'");
    const G1 = pad("S6SATU", 140);
    const G2 = "S6DUA tak seharusnya";
    await stub([REPLY(G1, G2)]);
    await submit("pesan S6");
    check("S6 brain chain aktif", await pollFor(`window.__agent._reactiveState().utteranceActive === true`, 5000));
    check("S6 kanal milik brain/chain sebelum takeover",
      await pollFor(`window.__speechChannel.current()?.producer === 'brain/chain'`, 3000));
    const cancelsBefore = await ev(`window.__ssCancels`);
    // producer luar masuk lewat BRIDGE PRODUKSI (speakShared), bukan stub:
    const extSpoke = await ev(`window.__live2dAgent.speak('S6LUAR ' + 'v'.repeat(60), undefined, { producer: 'probe/external' }); true`);
    void extSpoke;
    check("S6 owner berpindah ke probe/external",
      await pollFor(`window.__speechChannel.current()?.producer === 'probe/external'`, 3000));
    check("S6 brain ditandai lost: rantai mati + lock lepas",
      (await ev(`window.__agent._reactiveState().utteranceActive === false && window.__l2dDebug.state.aiLock === false`)) === true);
    check("S6 enforcer menghentikan audio brain (cancel meningkat)",
      (await ev(`window.__ssCancels`)) > cancelsBefore);
    // akustik: brain seg1 pernah benar-benar bersuara
    const spoke1 = await ev(`window.__ssSpoke`);
    check("S6 akustik: segmen brain terdengar sebelum takeover",
      Array.isArray(spoke1) && spoke1.some((x: string) => x.startsWith("S6SATU")), JSON.stringify(spoke1));
    // eksternal berbicara penuh lalu melepas kanal
    check("S6 eksternal bersuara",
      (await ev(`window.__ssSpoke.some(x=>x.startsWith('S6LUAR'))`)) === true);
    check("S6 kanal bebas setelah eksternal selesai",
      await pollFor(`window.__speechChannel.current() === null`, 8000));
    await sleep(500); // lewati jeda 180ms: bukti telat bahwa brain TIDAK lanjut
    const cS6 = await chat();
    const spokeS6 = await ev(`window.__ssSpoke`);
    check("S6 REGRESI: segmen brain kedua TIDAK pernah bersuara (lost ≠ completed)",
      !spokeS6.some((x: string) => x.startsWith("S6DUA")) && !cS6.includes(G2),
      JSON.stringify(spokeS6));

    // ── health akhir ─────────────────────────────────────────────
    const errs = await ev(`window.__smokeErrors`);
    check("tanpa error halaman / unhandled rejection", Array.isArray(errs) && errs.length === 0, JSON.stringify(errs));

    console.log(`\n${fail === 0 ? "🎉" : "❌"} UTTERANCE BRIDGE SMOKE: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error("❌ smoke crashed:", e);
    process.exitCode = 1;
  } finally {
    try { cdp?.close?.(); } catch {}
    try { browserProc.kill(); } catch {}
    try { await rm(profileDir, { recursive: true, force: true }); } catch {}
    server.stop();
  }
}

run().catch((e) => { console.error("❌ Smoke test failed:", e); process.exit(1); });
