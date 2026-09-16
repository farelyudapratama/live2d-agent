/**
 * proactive-gating.test.ts — S6 Behavior Contract: GATE PROAKTIF TERKUNCI.
 *
 * Kontrak acceptance (TERKUNCI):
 *   Chat ON + brain ON + worker idle → ALLOW (aturan lama utuh)
 *   Brain OFF                        → REFUSE
 *   Mode VTuber / stream aktif       → REFUSE
 *   Worker RUNNING / PAUSED          → REFUSE
 *   Event tak dikenal               → REFUSE
 *
 * REFUSAL HARUS NOL di SEMUA dimensi: /api/chat, /api/animate-text,
 * thinking/gaze/emotion, klaim SpeechChannel, dan bubble/chat-log. Gate
 * dievaluasi paling awal reactEvent — bahkan sebelum check busy.
 *
 * Yang TIDAK diuji di sini (sengaja, kontrak): arbitrase S4-D (matriks
 * prioritas 0/-1/-2) tetap milik speech-policy.test.ts; kelompok D di sini
 * hanya membuktikan baris-terakhir itu UTUH saat gate meloloskan tapi kanal
 * terisi.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { AgentBrain } from "../src/client/agent/brain";
import { createSpeechChannel } from "../src/client/speech/channel";

const origWindow = (globalThis as any).window;
const origDocument = (globalThis as any).document;
const origFetch = (globalThis as any).fetch;
const origAwayMin = AgentBrain.AWAY_DELAY_MIN_MS;
const origAwayMax = AgentBrain.AWAY_DELAY_MAX_MS;
afterEach(() => {
  (globalThis as any).window = origWindow;
  (globalThis as any).document = origDocument;
  (globalThis as any).fetch = origFetch;
  AgentBrain.AWAY_DELAY_MIN_MS = origAwayMin;
  AgentBrain.AWAY_DELAY_MAX_MS = origAwayMax;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Req {
  url: string;
  body: any;
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

/** env dengan PENGHITUT untuk setiap dimensi efek samping yang dilarang
 *  saat refusal. Kanal = stub berhitung (bukan implementasi asli) kecuali
 *  kelompok D yang memakai kanal ASLI. */
function makeEnv(opts: { channel?: any } = {}) {
  const reqs: Req[] = [];
  const spoken: string[] = [];
  const bubbles: { role: string; text: string }[] = [];
  const n = {
    lockAI: 0,
    unlockAI: 0,
    gaze: 0,
    emotion: 0, // expressEmotion/setExpression dari jalur reaksi event
    speak: 0,
    claims: 0,
    releases: 0,
  };
  const engine = {
    isReady: () => true,
    getExpressibleEmotions: () => ({
      senang: "param", sedih: "param", malu: "param", kaget: "param",
      bingung: "param", normal: "param",
    }),
    setExpression: () => { n.emotion++; },
    expressEmotion: () => { n.emotion++; return "param"; },
    setAIPose: () => {}, playMotion: () => true, playGesture: () => {},
    speak: (t: string, cb?: (o?: string) => void) => {
      spoken.push(t); n.speak++; (engine as any)._cb = cb;
    },
    finishSpeech: () => {
      const cb = (engine as any)._cb; (engine as any)._cb = null;
      if (cb) cb();
    },
    lockAI: () => { n.lockAI++; },
    unlockAI: () => { n.unlockAI++; },
    stopSpeech: () => {}, setGazeIntent: () => { n.gaze++; },
  };
  const channelStub = opts.channel || {
    claim: (_p: string, _o: any) => { n.claims++; return { id: Date.now() + n.claims, producer: _p, priority: (_o && _o.priority) | 0 }; },
    release: () => { n.releases++; return true; },
    isOwner: () => true,
  };
  (globalThis as any).window = {
    __live2dAgent: engine,
    __addChat: (role: string, text: string) => bubbles.push({ role, text }),
    __appEvents: { idleSpeak: true, awaySpeak: true, returnSpeak: true, quietMs: 0 },
    __speechChannel: channelStub,
  };
  (globalThis as any).document = { getElementById: () => null };
  (globalThis as any).fetch = async (u: string, init?: any) => {
    const body = JSON.parse(init.body);
    return new Promise<any>((resolve, reject) => {
      reqs.push({ url: String(u), body, resolve, reject });
    });
  };
  const brain: any = new AgentBrain();
  brain.capProfile = {
    emotions: ["senang", "sedih", "malu", "kaget", "bingung", "normal"],
    nativeExpressions: [], accessories: [], properties: [],
    gestures: ["nod", "wave_hi", "look_away_shy", "think"],
    motionCatalog: [], sheet: { config: { displayName: "T" } }, userNote: "",
    roleIds: {}, paramRange: {}, modelName: "m",
    controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
  };
  const chatReqs = () => reqs.filter((r) => r.url.includes("/api/chat"));
  const dirReqs = () => reqs.filter((r) => r.url.includes("/api/animate-text"));
  const answer = (i: number, text: string) =>
    chatReqs()[i].resolve({ ok: true, json: async () => ({ reply: text }) });
  /** Snapshot "nol efek" untuk jalur refusal. */
  const zeroSideEffects = () => ({
    chat: chatReqs().length, dir: dirReqs().length, speak: n.speak,
    claims: n.claims, lockAI: n.lockAI, unlockAI: n.unlockAI, gaze: n.gaze,
    emotion: n.emotion, bubbles: bubbles.length,
  });
  return { brain, reqs, spoken, bubbles, n, chatReqs, dirReqs, answer, zeroSideEffects, engine };
}

// Dua segmen (bukan satu) supaya director TIDAK dipanggil — satu segmen
// memicu /api/animate-text (aturan lama) dan butuh fetch kedua di test.
const REPLY = "[EMOTION:senang][GESTURE:nod] HALO-SATU. [EMOTION:senang] HALO-DUA.";

// ─────────────────────────────────────────────────────────────────
describe("S6 A — matriks acceptance gate (reactEvent lapis pertama)", () => {
  test("A1: chat + brain ON + worker idle → ALLOW (aturan lama: 1 LLM → ucap)", async () => {
    const E = makeEnv();
    const p = E.brain.reactEvent("idle");
    await sleep(5);
    expect(E.chatReqs().length).toBe(1);
    E.answer(0, REPLY);
    await p;
    expect(E.dirReqs().length).toBe(0); // dua segmen berdirektif → tanpa director
    expect(E.spoken).toEqual(["HALO-SATU."]);
    expect(E.n.claims).toBe(1); // klaim kanal terjadi DI SINI — bukan saat refuse
    // drain rantai: seg-1 selesai → jeda 180ms → seg-2 → selesai → rilis.
    E.engine.finishSpeech();
    await sleep(250);
    expect(E.spoken).toEqual(["HALO-SATU.", "HALO-DUA."]);
    E.engine.finishSpeech();
    // Jeda rilis rantai = 180ms (chain timer) — harus tuntas DALAM test,
    // kalau tidak unlock-nya mendarat di env test berikutnya (jebakan:
    // window global dipulihkan afterEach tapi closure brain lama hidup).
    await sleep(250);
    expect(E.n.lockAI).toBe(1);
    expect(E.n.unlockAI).toBe(1);
    expect(E.brain._reactiveState().utteranceActive).toBe(false);
  });

  test("A2: event tak dikenal → REFUSE total, bahkan sebelum cek apa pun", async () => {
    const E = makeEnv();
    await E.brain.reactEvent("mood:bukan-mood");
    await E.brain.reactEvent("event-random");
    await E.brain.reactEvent("");
    expect(E.zeroSideEffects()).toEqual({
      chat: 0, dir: 0, speak: 0, claims: 0, lockAI: 0, unlockAI: 0,
      gaze: 0, emotion: 0, bubbles: 0,
    });
    expect(E.brain._reactiveState().activeRequest).toBe(false);
  });

  test("A3: brain OFF (switch Mode Otak) → REFUSE nol efek", async () => {
    const E = makeEnv();
    E.brain.setProactiveContext({ brainOn: false });
    await E.brain.reactEvent("idle");
    expect(E.zeroSideEffects()).toEqual({
      chat: 0, dir: 0, speak: 0, claims: 0, lockAI: 0, unlockAI: 0,
      gaze: 0, emotion: 0, bubbles: 0,
    });
  });

  test("A4: mode VTuber → REFUSE (jalur ucap milik siaran, bukan companion)", async () => {
    const E = makeEnv();
    E.brain.setProactiveContext({ mode: "vtuber" });
    await E.brain.reactEvent("idle");
    expect(E.zeroSideEffects().chat).toBe(0);
    expect(E.zeroSideEffects().claims).toBe(0);
  });

  test("A5: stream vtuber aktif (flag) mode chat → REFUSE — sabuk pengaman selain mode", async () => {
    const E = makeEnv();
    E.brain.setProactiveContext({ vtuberStream: true });
    await E.brain.reactEvent("user_returned");
    expect(E.zeroSideEffects().chat).toBe(0);
  });

  test("A6: worker RUNNING → REFUSE", async () => {
    const E = makeEnv();
    E.brain.setProactiveContext({ worker: "running" });
    await E.brain.reactEvent("idle");
    expect(E.zeroSideEffects().chat).toBe(0);
    expect(E.zeroSideEffects().claims).toBe(0);
  });

  test("A7: worker PAUSED (approval menahan slot) → REFUSE", async () => {
    const E = makeEnv();
    E.brain.setProactiveContext({ worker: "paused" });
    await E.brain.reactEvent("mood:senang");
    expect(E.zeroSideEffects().chat).toBe(0);
  });

  test("A8: worker idle (parked-only TANPA pemegang slot bukan aktivitas) → ALLOW", async () => {
    const E = makeEnv();
    E.brain.setProactiveContext({ worker: "idle" });
    E.brain.reactEvent("idle");
    await sleep(5);
    expect(E.chatReqs().length).toBe(1);
  });

  test("A9: gate lolos TIDAK mengubah aturan lama — idleSpeak off tetap menolak", async () => {
    const E = makeEnv();
    (globalThis as any).window.__appEvents.idleSpeak = false;
    await E.brain.reactEvent("idle");
    expect(E.zeroSideEffects().chat).toBe(0);
    // mood TIDAK punya flag idleSpeak — aturan lama: tetap jalan saat gate lolos
    E.brain.reactEvent("mood:sedih");
    await sleep(5);
    expect(E.chatReqs().length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("S6 B — gate di SUMBER event (mood / sambutan / pamit)", () => {
  test("B1: mood refused → state mood TETAP tersimpan (konteks), nol reaksi", async () => {
    const E = makeEnv();
    E.brain.setProactiveContext({ worker: "running" });
    E.brain.setCameraMood("sedih");
    await sleep(5);
    expect(E.brain._reactiveState().userMood).toBe("sedih");
    expect(E.zeroSideEffects().emotion).toBe(0); // expressEventEmotion TIDAK jalan
    expect(E.chatReqs().length).toBe(0);
  });

  test("B2: mood allowed → ekspresi + LLM (perilaku P15 utuh)", async () => {
    const E = makeEnv();
    E.brain.setCameraMood("senang");
    await sleep(5);
    expect(E.n.emotion).toBe(1);
    expect(E.chatReqs().length).toBe(1);
  });

  test("B3: sambutan refused → nol ekspresi, nol LLM; returnSpeak lama tetap jalan", async () => {
    const E = makeEnv();
    E.brain.setPresence(true); // hadir dulu
    E.brain.setPresence(false); // pergi (jeda pamit dimatikan via awaySpeak)
    // awaySpeak off → tidak ada timer menggantung yang bisa bocor ke test
    (globalThis as any).window.__appEvents.awaySpeak = false;
    E.brain.setProactiveContext({ worker: "paused" });
    E.brain.setPresence(true); // balik → sambutan DIGATE
    await sleep(5);
    expect(E.zeroSideEffects().emotion).toBe(0);
    expect(E.chatReqs().length).toBe(0);
  });

  test("B4: pamit — gate dievaluasi SAAT JEDA SELESAI, bukan saat penjadwalan", async () => {
    const E = makeEnv();
    AgentBrain.AWAY_DELAY_MIN_MS = 5;
    AgentBrain.AWAY_DELAY_MAX_MS = 6;
    // Saat pergi: worker RUNNING → pamit dijadwalkan lalu TERTOLAK saat fired.
    E.brain.setProactiveContext({ worker: "running" });
    E.brain.setPresence(true);
    E.brain.setPresence(false); // pergi → pamit dijadwalkan (5-6 dtk)
    await sleep(30);
    expect(E.chatReqs().length).toBe(0); // fired → refuse, nol efek
    expect(E.zeroSideEffects().emotion).toBe(0);
    // Kontrol positif: worker kelar + sambutan MATI (agar tidak mengotori
    // penghitung) → pamit yang sama BOLEH lahir.
    (globalThis as any).window.__appEvents.returnSpeak = false;
    E.brain.setProactiveContext({ worker: "idle" });
    E.brain.setPresence(true);  // balik (tanpa sambutan)
    E.brain.setPresence(false); // pergi lagi → jadwal baru
    await sleep(30);
    expect(E.chatReqs().length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
describe("S6 C — anchor masa tenang otoritatif + validasi ctx", () => {
  test("C1: resetQuietPeriod memindahkan GERBANG NYATA (bukan cuma UI) dan mengembalikan anchor", async () => {
    const E = makeEnv();
    (globalThis as any).window.__appEvents.quietMs = 60_000;
    // Anchor lama (2 menit lalu) → di luar masa tenang → gate aturan lama lolos.
    E.brain.agentStart = Date.now() - 120_000;
    E.brain.reactEvent("idle");
    await sleep(5);
    expect(E.chatReqs().length).toBe(1);
    // Reset otoritatif: anchor = sekarang → masa tenang AKTIF lagi di gate.
    const anchor = E.brain.resetQuietPeriod();
    expect(typeof anchor).toBe("number");
    expect(Math.abs(anchor - Date.now())).toBeLessThan(2000);
    expect(E.brain._reactiveState().quietAnchor).toBe(anchor);
    await E.brain.reactEvent("idle");
    expect(E.chatReqs().length).toBe(1); // tetap satu — yang kedua tertolak tenang
  });

  test("C2: setProactiveContext — merge parsial, nilai invalid diabaikan", () => {
    const E = makeEnv();
    E.brain.setProactiveContext({ mode: "assistant", worker: "running" });
    E.brain.setProactiveContext({ brainOn: false } as any);
    let c = E.brain._reactiveState().proactiveCtx;
    expect(c).toEqual({ brainOn: false, mode: "assistant", vtuberStream: false, worker: "running" });
    // tipe salah / enum worker salah / string kosong → TIDAK mengubah apa pun
    E.brain.setProactiveContext({ mode: "", brainOn: "yes", worker: "parked" } as any);
    E.brain.setProactiveContext(null);
    E.brain.setProactiveContext(undefined);
    c = E.brain._reactiveState().proactiveCtx;
    expect(c.brainOn).toBe(false);
    expect(c.mode).toBe("assistant");
    expect(c.worker).toBe("running");
  });
});

// ─────────────────────────────────────────────────────────────────
describe("S6 D — baris terakhir S4-D utuh (gate meloloskan, kanal menolak)", () => {
  test("D1: kanal dipegang worker(-1) → proaktif lolos gate, tetep REFUSED di klaim -2; lock 1:1", async () => {
    const ch = createSpeechChannel();
    const holder = ch.claim("harness/actor", { priority: -1 });
    expect(holder).not.toBe(null);
    const E = makeEnv({ channel: ch });
    // Catatan kontrak: refusal-kanal memang TERJADI SETELAH LLM (S4-D lama);
    // gate S6 tidak mengubah itu — yang dijamin di sini arbitrase + pairing.
    const p = E.brain.reactEvent("idle");
    await sleep(5);
    expect(E.chatReqs().length).toBe(1);
    E.answer(0, REPLY);
    await p;
    await sleep(30);
    expect(E.spoken.length).toBe(0);            // tidak pernah bersuara
    expect(E.bubbles.length).toBe(0);           // tidak klaim "dikatakan"
    expect(ch.current()!.producer).toBe("harness/actor"); // kanal tak berpindah
    // pairing lockP18: claim memasang lockAI lalu pembatalan D2 melepasnya
    expect(E.n.lockAI).toBe(1);
    expect(E.n.unlockAI).toBe(1);
    expect(E.brain._reactiveState().utteranceActive).toBe(false);
    ch.release(holder);
  });
});
