/**
 * brain-speech-channel.test.ts — S1: integrasi rantai brain dengan SpeechChannel.
 *
 * Fake engine meniru KONTRAK app.js speakShared: callback onDone menerima
 * outcome yang dihitung dari kepemilikan kanal SAAT ucapan engine selesai
 * ("completed" bila masih pemilik / implicit, "lost" bila kanal sudah pindah).
 * Brain memakai SpeechChannel ASLI (bukan stub) + _chainOwner Phase 18 ASLI.
 *
 * Regression yang dikunci:
 *   Brain A -> Brain B           : lanjut normal (perilaku lama)
 *   Brain A -> eksternal preempt : Brain B TIDAK BOLEH jalan
 */
import { describe, test, expect, afterEach } from "bun:test";
import { AgentBrain } from "../src/client/agent/brain";
import { createSpeechChannel } from "../src/client/speech/channel";

const origWindow = (globalThis as any).window;
const origDocument = (globalThis as any).document;
const origFetch = (globalThis as any).fetch;
afterEach(() => {
  (globalThis as any).window = origWindow;
  (globalThis as any).document = origDocument;
  (globalThis as any).fetch = origFetch;
});

const PROFILE: any = {
  emotions: ["senang", "sedih", "malu", "normal"],
  nativeExpressions: [],
  accessories: [],
  properties: [],
  gestures: ["nod", "wave_hi", "look_away_shy", "think"],
  motionCatalog: [],
  sheet: { config: { displayName: "T" } },
  userNote: "",
  roleIds: {},
  paramRange: {},
  modelName: "m",
  controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(opts: { withChannel?: boolean } = {}) {
  const withChannel = opts.withChannel !== false;
  const ch = withChannel ? createSpeechChannel() : null;
  const engine = {
    spoken: [] as { text: string; token: any; onDone: any }[],
    locks: 0,
    unlocks: 0,
    stops: 0,
  };
  const done = (t: string, token: any, onDone: any) => {
    engine.spoken.push({ text: t, token, onDone });
  };
  (globalThis as any).window = {
    __speechChannel: ch,
    __live2dAgent: {
      isReady: () => true,
      getExpressibleEmotions: () => ({}),
      setExpression: () => {},
      setAIPose: () => {},
      playMotion: () => true,
      playGesture: () => {},
      // tiruan kontrak app.js speakShared: outcome dari kepemilikan SAAT selesai
      speak: (t: string, onDone?: any, opts?: any) => {
        const token =
          opts && typeof opts === "object" && "token" in opts
            ? opts.token ?? null
            : null;
        done(t, token, onDone);
      },
      lockAI: () => { engine.locks++; },
      unlockAI: () => { engine.unlocks++; },
      stopSpeech: () => { engine.stops++; },
      setGazeIntent: () => {},
    },
    __addChat: () => {},
    __appEvents: { idleSpeak: false, quietMs: 0 },
  };
  (globalThis as any).document = { getElementById: () => null };
  const brain: any = new AgentBrain();
  brain.capProfile = PROFILE;
  const finishCurrent = (i = 0) => {
    const s = engine.spoken[i];
    if (!s || !s.onDone) return;
    const outcome = !s.token || (ch && ch.isOwner(s.token)) || !ch ? "completed" : "lost";
    s.onDone(outcome);
  };
  return { brain, ch, engine, finishCurrent };
}

const chatStub = (reply: string) => {
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({ reply }),
  });
};

describe("S1 brain ↔ SpeechChannel", () => {
  test("regresi: chain selesai natural — A lalu B jalan, kanal lepas, unlock tepat sekali", async () => {
    const { brain, ch, engine, finishCurrent } = setup();
    chatStub("[EMOTION:senang][GESTURE:nod] SEG-A. [EMOTION:malu][GESTURE:look_away_shy] SEG-B.");
    const p = brain.think("hai");
    await p; // request selesai; chain bicara seg A
    expect(ch!.current()?.producer).toBe("brain/chain");
    expect(engine.spoken.map((s) => s.text)).toEqual(["SEG-A."]);
    expect(engine.locks).toBe(1);
    finishCurrent(0); // A selesai natural → chain lanjut B
    await sleep(250);
    expect(engine.spoken.map((s) => s.text)).toEqual(["SEG-A.", "SEG-B."]);
    finishCurrent(1); // B selesai → gap terakhir → rantai release penuh
    await sleep(250);
    expect(ch!.current()).toBeNull();
    expect(engine.unlocks).toBe(1);
    expect(brain._reactiveState().utteranceActive).toBe(false);
  });

  test("PREEMPT eksternal saat seg A: brain dapat lost, seg B TIDAK BOLEH jalan", async () => {
    const { brain, ch, engine, finishCurrent } = setup();
    chatStub("[EMOTION:senang][GESTURE:nod] SEG-A. [EMOTION:malu] SEG-B.");
    await brain.think("hai");
    expect(ch!.current()?.producer).toBe("brain/chain");
    let lostSeen: string | null | undefined = undefined;
    const external = ch!.claim("probe/external", {});
    void lostSeen; void external;
    // onLost brain fires SINKRON di claim():
    expect(brain._reactiveState().utteranceActive).toBe(false); // rantai mati
    expect(engine.unlocks).toBe(1); // lepas tepat sekali
    expect(ch!.current()?.producer).toBe("probe/external");
    finishCurrent(0); // callback engine lama tiba — outcome harus lost
    expect(engine.unlocks).toBe(1); // cb basi TIDAK menambah unlock
    await sleep(250);
    expect(engine.spoken.map((s) => s.text)).toEqual(["SEG-A."]); // SEG-B TIDAK pernah
    expect(engine.unlocks).toBe(1); // tidak ada unlock kedua
  });

  test("defensif: cb('lost') tanpa onLost (anomali urutan) tetap menghentikan chain", async () => {
    const { brain, ch, engine } = setup();
    chatStub("[EMOTION:senang][GESTURE:nod] SEG-A. [EMOTION:senang] SEG-B.");
    await brain.think("hai");
    // buang kepemilikan kanal brain diam-diam (tanpa melewati onLost brain):
    // release paksa dari sisi eksternal via takeover HANYA setelah onLost
    // dinetralkan — simulasi: panggil cb dengan 'lost' langsung.
    const s = engine.spoken[0];
    s.onDone("lost");
    await sleep(250);
    expect(engine.spoken.length).toBe(1); // B tidak lanjut
    expect(brain._reactiveState().utteranceActive).toBe(false);
    expect(ch!.current()).toBeNull(); // unlock + kanal dilepas jalur defensif
  });

  test("stale token brain tidak boleh melepas owner eksternal pasca-takeover", async () => {
    const { brain, ch } = setup();
    chatStub("[EMOTION:senang][GESTURE:nod] SEG-A. [EMOTION:senang] SEG-B.");
    await brain.think("hai");
    ch!.claim("probe/external", {}); // brain jadi basi
    const external = ch!.current();
    brain._cancelActiveUtterance(); // jalur preempt think() berikutnya
    expect(ch!.current()).toEqual(external!); // pemilik eksternal utuh
  });

  test("user think() baru mengalahkan klaim eksternal (user wins, takeover legal)", async () => {
    const { brain, ch, engine } = setup();
    chatStub("[EMOTION:senang][GESTURE:nod] SEG-LAMA. [EMOTION:senang] x.");
    await brain.think("satu");
    ch!.claim("probe/external", {});
    chatStub("[EMOTION:sedih][GESTURE:look_away_shy] BARU. [EMOTION:sedih] y.");
    const p = brain.think("dua"); // entry-cancel + claim ulang kanal
    await p;
    expect(ch!.current()?.producer).toBe("brain/chain");
    expect(engine.spoken.some((s) => s.text === "BARU.")).toBe(true);
  });

  test("model switch (invalidateCapabilityProfile) melepas kanal + rantai", async () => {
    const { brain, ch } = setup();
    chatStub("[EMOTION:senang][GESTURE:nod] SEG-A. [EMOTION:senang] SEG-B.");
    await brain.think("hai");
    expect(ch!.current()?.producer).toBe("brain/chain");
    brain.invalidateCapabilityProfile();
    expect(ch!.current()).toBeNull();
    expect(brain._reactiveState().utteranceActive).toBe(false);
  });

  test("graceful: tanpa SpeechChannel (bundle lama) chain tetap utuh seperti pra-S1", async () => {
    const { brain, engine, finishCurrent } = setup({ withChannel: false });
    chatStub("[EMOTION:senang][GESTURE:nod] SEG-A. [EMOTION:senang] SEG-B.");
    await brain.think("hai");
    expect(engine.spoken.length).toBe(1);
    finishCurrent(0);
    await sleep(250);
    expect(engine.spoken.map((s) => s.text)).toEqual(["SEG-A.", "SEG-B."]);
    finishCurrent(1);
    await sleep(250);
    expect(engine.unlocks).toBe(1);
  });
});
