/**
 * utterance-ownership.test.ts — Phase 18: Agent Playback Ownership.
 *
 * Mengunci jaminan perilaku (bukan string sumber):
 *   - AT MOST ONE active utterance chain per AgentBrain
 *   - user input SELALU preemptif; proaktif tidak pernah memotong
 *   - callback async basi (speak onDone / guard timer engine yang telat)
 *     tidak bisa revive rantai lama, tidak bisa bicara, tidak bisa
 *     menyentuh lock rantai baru
 *   - lockAI/unlockAI seimbang: 1 claim = 1 lock, tiap terminal path =
 *     1 unlock (normal selesai, preempt, model switch)
 *   - busy TETAP level request (Phase 16); ownership = level playback
 *   - P15.5/P15.2 record hanya terjadi bila rantai benar-benar dimulai
 *
 * Semua test memakai rantai async SUNGGUHAN: fake speak menyimpan onDone
 * dan tidak memanggilnya (persis kondisi audio-element di-swap chain lain →
 * onended lama tidak pernah fire → hanya guard timer engine yang menyelamatkan).
 * Uji revival zombie = memanggil onDone basi itu, lalu menunggu.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { AgentBrain } from "../src/client/agent/brain";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const origWindow = (globalThis as any).window;
const origDocument = (globalThis as any).document;
const origFetch = (globalThis as any).fetch;

interface FakeEngine {
  spoken: { text: string; done: () => void }[];
  speak: (t: string, cb: () => void) => void;
  locks: number;
  unlocks: number;
  stops: number;
  maxConcurrentLocks: number;
  addChat: any[];
  gestures: string[];
  motions: any[];
  expressions: any[];
}

function makeEngine(opts: { ready?: boolean } = {}): FakeEngine {
  const e: FakeEngine = {
    spoken: [],
    locks: 0,
    unlocks: 0,
    stops: 0,
    maxConcurrentLocks: 0,
    addChat: [],
    gestures: [],
    motions: [],
    expressions: [],
    speak: (_t: string, cb: () => void) => {
      e.spoken.push({ text: _t, done: cb });
    },
  };
  const active = { n: 0 };
  (globalThis as any).window = {
    __live2dAgent: {
      isReady: () => opts.ready !== false,
      getExpressibleEmotions: () => ({ senang: "param", sedih: "param", malu: "param" }),
      setExpression: (...a: any[]) => e.expressions.push(a),
      setAIPose: () => {},
      playMotion: (...a: any[]) => { e.motions.push(a); return false; }, // unknown → false
      playGesture: (g: string) => e.gestures.push(g),
      speak: (t: string, cb: () => void) => e.speak(t, cb),
      lockAI: () => { e.locks++; active.n++; e.maxConcurrentLocks = Math.max(e.maxConcurrentLocks, active.n); },
      unlockAI: () => { e.unlocks++; active.n--; },
      stopSpeech: () => { e.stops++; },
      setGazeIntent: () => {},
    },
    __addChat: (role: string, text: string) => e.addChat.push({ role, text }),
    __appEvents: { idleSpeak: true, quietMs: 0 },
  };
  (globalThis as any).document = { getElementById: () => null };
  return e;
}

const PROFILE: any = {
  emotions: ["senang", "sedih", "malu", "normal"],
  nativeExpressions: [],
  accessories: [],
  properties: [],
  gestures: ["nod", "wave_hi", "look_away_shy", "think"],
  motionCatalog: [],
  sheet: { config: { displayName: "TestChar" } },
  userNote: "",
  roleIds: {},
  paramRange: {},
  modelName: "test-model",
  controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
};

function makeBrain(fetchReply: string) {
  const engine = makeEngine();
  const prompts: string[] = [];
  (globalThis as any).fetch = async (_url: string, init?: any) => {
    prompts.push(JSON.parse(init.body).system);
    return { ok: true, json: async () => ({ reply: fetchReply }) };
  };
  const brain: any = new AgentBrain();
  brain.capProfile = PROFILE;
  return { brain, engine, prompts };
}

afterEach(() => {
  (globalThis as any).window = origWindow;
  (globalThis as any).document = origDocument;
  (globalThis as any).fetch = origFetch;
});

// ═══════════════════════════════════════════════════════════════════════
// T1–T4: single/multi-segment chains run to completion, exactly-once lock
// ═══════════════════════════════════════════════════════════════════════
describe("P18 T1-T4 — rantai normal: jalan, owned sampai segmen terakhir", () => {
  test("T1+T12+T13+T21+T22: dua segmen → 1 lock, selesai setelah onDone+gap terakhir, unlock tepat sekali, P15 record terjadi", async () => {
    const { brain, engine } = makeBrain(
      "[EMOTION:sedih][GESTURE:look_away_shy] Kok sepi... [EMOTION:sedih] Ada?",
    );
    try {
      await brain.reactEvent("idle");
      expect(engine.spoken.length).toBe(1);
      // T3: rantai MASIH owned walau reactEvent (permintaan) sudah selesai
      expect(brain._reactiveState().utteranceActive).toBe(true);
      expect(brain.busy).toBe(false); // busy tetap level REQUEST (Phase 16)
      // T12: claim = tepat satu lockAI
      expect(engine.locks).toBe(1);
      expect(engine.unlocks).toBe(0);
      // T22: aksi dicatat karena rantai BENAR-BENAR dimulai
      expect(brain._lastProactiveAction).toBe("sedih + look_away_shy");
      // T21: record P15.2 (per segmen; action KUMULATIF lintas segmen —
      // semantik parser existing: gesture segmen 1 terbawa ke segmen 2) +
      // hint bersih
      expect(brain._diversityHistory.get("idle")).toEqual([
        "sedih+look_away_shy",
        "sedih+look_away_shy",
      ]);
      expect(brain._diversityHint).toBe("");

      // segmen 2 selesai → gap → chain COMPLETED: unlock tepat sekali
      engine.spoken[0].done();
      await sleep(250);
      expect(engine.spoken.length).toBe(2);
      expect(engine.unlocks).toBe(0); // masih owned — segmen 2 sedang bicara
      engine.spoken[1].done();
      await sleep(250);
      expect(engine.unlocks).toBe(1); // T13: tepat sekali, setelah segmen TERAKHIR
      expect(brain._reactiveState().utteranceActive).toBe(false);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  test("T2+T4: multi-segmeng lanjut hanya via onDone asli; owned sampai segmen TERAKHIR", async () => {
    const { brain, engine } = makeBrain(
      "[EMOTION:senang][GESTURE:nod] Satu. [EMOTION:senang][GESTURE:think] Dua.",
    );
    try {
      await brain.think("hai");
      expect(engine.spoken.map((s) => s.text)).toEqual(["Satu."]);
      // belum selesai — request sudah release busy tapi chain masih owned
      expect(brain._reactiveState().utteranceActive).toBe(true);
      expect(brain.busy).toBe(false);

      engine.spoken[0].done();
      await sleep(250); // gap 180ms
      expect(engine.spoken.map((s) => s.text)).toEqual(["Satu.", "Dua."]);
      expect(brain._reactiveState().utteranceActive).toBe(true); // T4: belum release

      engine.spoken[1].done();
      await sleep(250);
      expect(engine.unlocks).toBe(1); // T4: release tepat setelah segmen terakhir
      expect(brain._reactiveState().utteranceActive).toBe(false);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T5–T9, T14–T15: PREEMPTION — the exact Phase 18 failure scenario
// ═══════════════════════════════════════════════════════════════════════
describe("P18 T5-T9/T14/T15 — user preemptif; rantai lama mati permanen", () => {
  test("T5+T14: think() user saat proaktif multi-segmen bicara → stopSpeech, 1 unlock lama, claim baru", async () => {
    const { brain, engine } = makeBrain(
      "[EMOTION:senang][GESTURE:nod] Proaktif satu. [EMOTION:senang][GESTURE:think] Proaktif dua.",
    );
    try {
      await brain.reactEvent("idle"); // rantai A aktif, speak 1 pending
      expect(engine.spoken.length).toBe(1);
      expect(brain._reactiveState().utteranceActive).toBe(true);

      // balas user dengan teks BERBEDA yang bisa dibedakan
      const aDone = engine.spoken[0].done;
      (globalThis as any).fetch = async (_url: string, init?: any) => ({
        ok: true,
        json: async () => ({ reply: "[EMOTION:malu][GESTURE:wave_hi] Balasan user." }),
      });
      await brain.think("halo"); // entri preemptif: cancel A SEKARANG

      expect(engine.stops).toBe(1);            // stop speech via bridge
      expect(engine.unlocks).toBe(1);          // T14: lock lama dilepas TEPAT sekali
      expect(engine.locks).toBe(2);            // A claim + B claim
      expect(brain._reactiveState().utteranceActive).toBe(true); // milik B
      expect(engine.spoken.map((s) => s.text)).toEqual(["Proaktif satu.", "Balasan user."]);

      // T6+T7+T8: onDone/guard A yang datang TELAT (zombie vector asli)
      aDone();
      await sleep(250);
      expect(engine.spoken.map((s) => s.text)).toEqual(["Proaktif satu.", "Balasan user."]); // T8: "Proaktif dua" TIDAK pernah revive
      expect(engine.addChat.map((c) => c.text)).not.toContain("Proaktif dua.");
      expect(engine.unlocks).toBe(1);          // T15: A basi tidak bisa unlock B

      // B selesai normal
      engine.spoken[1].done();
      await sleep(250);
      expect(engine.unlocks).toBe(2);          // total: 1 preempt + 1 completion
      expect(brain._reactiveState().utteranceActive).toBe(false);
      expect(engine.maxConcurrentLocks).toBe(1); // T11: tidak pernah 2 rantai hidup
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  test("T9: input user KEDUA tidak pernah menciptakan rantai paralel", async () => {
    const { brain, engine } = makeBrain("[EMOTION:senang][GESTURE:nod] Satu. [EMOTION:senang][GESTURE:nod] Dua.");
    try {
      await brain.think("pesan satu"); // chain A bicara "Satu."
      const a2 = engine.spoken[0].done;
      (globalThis as any).fetch = async () => ({
        ok: true,
        json: async () => ({ reply: "[EMOTION:sedih][GESTURE:look_away_shy] B satu. [EMOTION:sedih] B dua." }),
      });
      await brain.think("pesan dua"); // preempt A
      a2(); // zombie A callback
      await sleep(250);
      // "Dua." (segmen A kedua) tidak pernah muncul setelah preempt
      expect(engine.spoken.map((s) => s.text)).toEqual(["Satu.", "B satu."]);
      expect(engine.maxConcurrentLocks).toBe(1);
      expect(brain._reactiveState().utteranceActive).toBe(true); // B masih hidup
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  test("T10/T23: proaktif saat utterance user aktif → TANPA rantai kedua, TANPA record palsu, chain user tetap jalan", async () => {
    const { brain, engine } = makeBrain("[EMOTION:senang][MOTION:tidak_ada][GESTURE:nod] User bicara. [EMOTION:senang] lanjut.");
    try {
      await brain.think("halo"); // chain user aktif
      expect(brain._reactiveState().utteranceActive).toBe(true);

      // reactEvent berikutnya (proaktif) — replynya beda: harus DIBUANG untuk playback
      (globalThis as any).fetch = async () => ({
        ok: true,
        json: async () => ({ reply: "[EMOTION:sedih][GESTURE:wave_hi] Mestinya proaktif." }),
      });
      await brain.reactEvent("idle");

      // tidak ada speak/lock/proactive record dari jalur proaktif
      expect(engine.spoken.map((s) => s.text)).toEqual(["User bicara."]);
      expect(engine.locks).toBe(1);
      expect(brain._lastProactiveAction).toBeNull(); // T10: tidak dicatat — aksi tidak dieksekusi
      expect(brain._diversityHistory.size).toBe(0);
      // chain user TIDAK terganggu: segmen kedua lanjut normal
      engine.spoken[0].done();
      await sleep(250);
      expect(engine.spoken.length).toBe(2);
      expect(engine.unlocks).toBe(0); // masih bicara segmen 2
      engine.spoken[1].done();
      await sleep(250);
      expect(engine.unlocks).toBe(1);
      expect(brain._reactiveState().utteranceActive).toBe(false);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T16–T17: model switch
// ═══════════════════════════════════════════════════════════════════════
describe("P18 T16-T17 — model switch membatalkan playback dengan bersih", () => {
  test("switch → stopSpeech + 1 unlock + owner null; callback basi diabaikan", async () => {
    const { brain, engine } = makeBrain("[EMOTION:senang][GESTURE:nod] Lama satu. [EMOTION:senang][GESTURE:nod] Lama dua.");
    try {
      await brain.think("hai");
      const oldDone = engine.spoken[0].done;
      brain.invalidateCapabilityProfile(); // model switch
      expect(engine.stops).toBe(1);
      expect(engine.unlocks).toBe(1);
      expect(brain._reactiveState().utteranceActive).toBe(false);

      oldDone(); // speak engine model lama selesai TELAT
      await sleep(250);
      expect(engine.spoken.length).toBe(1);  // T17: segmen lama tidak revive
      expect(engine.unlocks).toBe(1);         // tidak ada unlock ganda
      expect(engine.locks).toBe(1);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T18–T20, T24: cancellation & degradasi
// ═══════════════════════════════════════════════════════════════════════
describe("P18 T18-T20/T24 — idempoten, Phase 16 utuh, degradasi aman", () => {
  test("T18: cancel tanpa rantai = no-op penuh (tanpa stopSpeech/unlock)", async () => {
    const { brain, engine } = makeBrain("[EMOTION:senang] halo.");
    try {
      brain.invalidateCapabilityProfile(); // tidak ada chain
      expect(engine.stops).toBe(0);
      expect(engine.unlocks).toBe(0);
      await brain.think("hai");
      expect(engine.unlocks).toBe(0);
      engine.spoken[0].done();
      await sleep(250);
      const stopsBefore = engine.stops; // 0
      brain.invalidateCapabilityProfile(); // chain sudah selesai → tetap no-op
      expect(engine.stops).toBe(stopsBefore);
      expect(engine.unlocks).toBe(1); // tetap satu
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  test("T19: timeout request (Phase 16) → fallback langsung, TIDAK pernah klaim chain", async () => {
    const engine = makeEngine();
    const origTimeout = AgentBrain.LLM_REQUEST_TIMEOUT_MS;
    AgentBrain.LLM_REQUEST_TIMEOUT_MS = 40;
    (globalThis as any).fetch = (_url: string, init?: any) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          const e: any = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      });
    const brain: any = new AgentBrain();
    brain.capProfile = PROFILE;
    try {
      await brain.think("hai"); // timeout → fallback speak langsung
      expect(engine.spoken.length).toBe(1);
      expect(engine.spoken[0].text).toContain("gak bisa mikir");
      expect(brain._reactiveState().utteranceActive).toBe(false); // tanpa chain
      expect(engine.locks).toBe(0);
      expect(engine.unlocks).toBe(0);
      expect(brain.busy).toBe(false);
    } finally {
      AgentBrain.LLM_REQUEST_TIMEOUT_MS = origTimeout;
      (globalThis as any).fetch = origFetch;
    }
  });

  test("T20+T24: model tidak siap / engine tanpa method → tanpa claim, tanpa lock, aman", async () => {
    (globalThis as any).window = { __live2dAgent: { isReady: () => false } };
    (globalThis as any).document = { getElementById: () => null };
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ reply: "[EMOTION:senang] x" }) });
    const brain: any = new AgentBrain();
    brain.capProfile = PROFILE;
    try {
      await brain.think("hai");
      await brain.reactEvent("idle");
      expect(brain._reactiveState().utteranceActive).toBe(false);
      expect(brain.busy).toBe(false);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });
});
