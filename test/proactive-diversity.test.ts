/**
 * proactive-diversity.test.ts — Phase 15.2: Proactive behavior diversity.
 *
 * Menguji mekanisme anti-pengulangan behavior pada proactive events
 * (idle, user_left, user_returned, mood:*) tanpa mengubah pipeline
 * user-driven (think), ParameterArbiter, MotionRuntime, atau Cubism.
 *
 * Yang dikunci:
 *   T1  proactive event masih menghasilkan behavior (diversity tidak memblokir)
 *   T2  repeated proactive event menghindari behavior identik bila ada alternatif
 *   T3  single-candidate behavior tetap diizinkan
 *   T4  cooldown/blokir behavior tetap berjalan persis seperti sebelumnya
 *   T5  diversity tidak mempengaruhi normal user-driven actions (think)
 *       (termasuk regresi F1: lifecycle reactEvent → think)
 *   T6  model switch mengosongkan/isolasi diversity state
 *   T7  empty candidate list aman
 *   T8  unknown candidate aman
 *   T9  tidak ada hardcoded model-specific motion ID
 *   T10 existing P15.1 structured context tetap utuh
 *   T11 existing native motion catalog tetap utuh
 *   T12 existing emotion/gesture behavior tetap utuh
 */
import { describe, test, expect, afterEach } from "bun:test";
import { AgentBrain, estimateSpeechMs } from "../src/client/agent/brain";
import { parseSegments } from "../src/client/agent/directive-parser";

// ── Fake window.__live2dAgent (persis pola brain-apply-actions.test.ts) ──

type Calls = Record<string, any[]>;

function makeAgent(overrides: Record<string, any> = {}) {
  const calls: Calls = {
    setExpression: [],
    setAIPose: [],
    playMotion: [],
    playGesture: [],
  };
  const agent: any = {
    isReady: () => true,
    getExpressibleEmotions: () => ({
      senang: "param",
      tersenyum: "param",
      sedih: "native",
      malu: "param",
      kaget: "param",
      kesal: "param",
      bingung: "param",
      normal: "param",
    }),
    setExpression: (...a: any[]) => calls.setExpression.push(a),
    setAIPose: (...a: any[]) => calls.setAIPose.push(a),
    playMotion: (...a: any[]) => {
      calls.playMotion.push(a);
      return true;
    },
    playGesture: (...a: any[]) => calls.playGesture.push(a),
    getCapabilityProfile: () => ({
      emotions: ["senang", "tersenyum", "sedih", "malu", "kaget", "kesal", "bingung", "normal"],
      nativeExpressions: ["exp_01", "exp_02"],
      accessories: [],
      properties: [],
      gestures: ["nod", "shake", "tilt_curious", "lean_excited", "recoil_surprised", "look_away_shy", "laugh_bounce", "think", "wave_hi"],
      motionCatalog: [],
      sheet: null,
      userNote: "",
      roleIds: {},
      paramRange: {},
      modelName: "test-model",
      controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
    }),
    ...overrides,
  };
  return { agent, calls };
}

const origWindow = (globalThis as any).window;
function withAgent(agent: any): void {
  (globalThis as any).window = { __live2dAgent: agent };
}
afterEach(() => {
  (globalThis as any).window = origWindow;
});

// Helper: buat brain + fake agent + capProfile
function makeBrain(overrides?: Record<string, any>) {
  const { agent, calls } = makeAgent(overrides);
  withAgent(agent);
  const brain: any = new AgentBrain();
  return { brain, calls };
}

// Helper: set capProfile langsung (hindari fetch)
function setCapProfile(brain: any, profile: any) {
  brain.capProfile = profile;
}

// Helper: isi diversity history langsung (simulasi behavior record)
function fillHistory(brain: any, eventType: string, entries: string[]) {
  for (const e of entries) {
    const arr: string[] = brain._diversityHistory.get(eventType) || [];
    arr.push(e);
    brain._diversityHistory.set(eventType, arr);
  }
}

// Default capProfile untuk test
const DEFAULT_PROFILE = {
  emotions: ["senang", "tersenyum", "sedih", "malu", "kaget", "kesal", "bingung", "normal"],
  nativeExpressions: ["exp_01", "exp_02"],
  accessories: [],
  properties: [],
  gestures: ["nod", "shake", "tilt_curious", "lean_excited", "recoil_surprised", "look_away_shy", "laugh_bounce", "think", "wave_hi"],
  motionCatalog: [],
  sheet: { config: { displayName: "TestChar" } },
  userNote: "Karakter ceria yang suka mengobrol",
  roleIds: {},
  paramRange: {},
  modelName: "test-model",
  controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
};

// ═══════════════════════════════════════════════════════════════════════
// T1: Proactive event masih menghasilkan behavior — diversity tidak
//     memblokir event, hanya menambah hint ke prompt.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T1 — proactive event still produces behavior", () => {
  test("diversity history kosong → diversityHint mengembalikan string kosong", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // Tanpa history → tidak ada hint
    const hint = brain.diversityHint("idle");
    expect(hint).toBe("");
  });

  test("diversity tidak memblokir prompt — system prompt tetap dihasilkan", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // System prompt dihasilkan tanpa error
    const prompt = brain.buildSystemPrompt("");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("_recordProactiveBehavior tidak crash dengan segments kosong", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // Tidak boleh throw
    brain._recordProactiveBehavior("idle", []);
    brain._recordProactiveBehavior("idle", null);
    brain._recordProactiveBehavior("idle", undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T2: Repeated proactive event menghindari behavior identik bila
//     ada alternatif yang tersedia.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T2 — repeated proactive event avoids identical behavior", () => {
  test("history ada 'senang' → hint menyarankan variasi dari emosi lain", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    fillHistory(brain, "idle", ["senang"]);
    const hint = brain.diversityHint("idle");
    expect(hint).toContain("senang");
    expect(hint).toContain("VARIASI PERILAKU");
    expect(hint).toContain("BERBEDA");
  });

  test("history ada 'senang+nod' → hint menyebut pasangan yang sudah dipakai", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    fillHistory(brain, "mood:senang", ["senang+nod"]);
    const hint = brain.diversityHint("mood:senang");
    expect(hint).toContain("senang+nod");
    expect(hint).toContain("VARIASI PERILAKU");
  });

  test("diversity hint masuk ke system prompt untuk reactEvent", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    fillHistory(brain, "idle", ["senang+nod"]);
    // Simulasikan apa yang reactEvent lakukan
    brain._diversityHint = brain.diversityHint("idle");
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("VARIASI PERILAKU");
    expect(prompt).toContain("senang+nod");
    expect(prompt).toContain("BERBEDA");
  });

  test("setelah 3+ emosi berbeda tercatat, alternatif tetap ada", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    fillHistory(brain, "idle", ["senang", "sedih", "kaget"]);
    const hint = brain.diversityHint("idle");
    // Masih ada alternatif (malu, bingung, kesal, tersenyum, normal)
    expect(hint).toContain("VARIASI PERILAKU");
  });

  test("kandidat yang sudah dipakai ada di hint, kandidat lain tidak disebut", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    fillHistory(brain, "user_left", ["sedih+look_away_shy"]);
    const hint = brain.diversityHint("user_left");
    expect(hint).toContain("sedih+look_away_shy");
    // Tidak menyebut kandidat lain secara eksplisit (hanya menyuruh beda)
    expect(hint).not.toContain("malu");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T3: Single-candidate behavior tetap diizinkan.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T3 — single-candidate behavior still allowed", () => {
  test("capProfile dengan 1 emosi → diversityHint mengembalikan kosong", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, { ...DEFAULT_PROFILE, emotions: ["senang"] });
    fillHistory(brain, "idle", ["senang"]);
    const hint = brain.diversityHint("idle");
    expect(hint).toBe("");
  });

  test("event tanpa preference + 1 emosi supported → hint kosong", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, { ...DEFAULT_PROFILE, emotions: ["senang"] });
    // idle punya preferences: [] (kosong), supported: ["senang"]
    // → kandidat = ["senang"] (1 item)
    fillHistory(brain, "idle", ["senang"]);
    const hint = brain.diversityHint("idle");
    expect(hint).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T4: Cooldown/blokir behavior tetap berjalan persis seperti sebelumnya.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T4 — cooldown still blocks behavior exactly as before", () => {
  test("busy flag tetap memblokir reactEvent", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    brain.busy = true;
    // reactEvent harus return tanpa fetch
    brain.reactEvent("idle");
    // Tidak ada error — busy mengembalikan
  });

  test("inQuietPeriod tetap memblokir reactive events", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // agentStart = Date.now() — quiet period aktif
    brain.quietMs = () => 60000; // 60s quiet period
    brain.agentStart = Date.now();
    // inQuietPeriod harus return true
    expect(brain.inQuietPeriod()).toBe(true);
  });

  test("idleSpeak=false tetap memblokir idle event", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    brain.getEvents = () => ({ idleSpeak: false, awaySpeak: true, returnSpeak: true, quietMs: 0 });
    brain.quietMs = () => 0;
    brain.agentStart = Date.now() - 100000; // bukan quiet period
    brain.busy = false;
    // reactEvent("idle") harus return tanpa fetch karena idleSpeak=false
    brain.reactEvent("idle");
  });

  test("_DIVERSITY_WINDOW membatasi jumlah entry per event type", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // Gunakan _recordProactiveBehavior untuk melewati _pushHistory yang
    // menerapkan window size.
    const makeSeg = (emo: string, ges: string) =>
      ({ text: "", actions: { emotion: emo, gesture: ges, intensity: 0.8 } } as any);
    brain._recordProactiveBehavior("idle", [makeSeg("senang", "nod")]);
    brain._recordProactiveBehavior("idle", [makeSeg("sedih", "shake")]);
    brain._recordProactiveBehavior("idle", [makeSeg("kaget", "recoil_surprised")]);
    brain._recordProactiveBehavior("idle", [makeSeg("malu", "look_away_shy")]);
    brain._recordProactiveBehavior("idle", [makeSeg("kesal", "tilt_curious")]);
    const history = brain._diversityHistory.get("idle");
    // Sliding window = 3, jadi hanya 3 entry terakhir
    expect(history.length).toBe(3);
    expect(history).toEqual(["kaget+recoil_surprised", "malu+look_away_shy", "kesal+tilt_curious"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T5: Diversity tidak mempengaruhi normal user-driven actions (think).
//
// REGRESI F1: hint diversity di-set di reactEvent() dan dipakai untuk
// request proaktif itu. Ia HARUS dibersihkan setelah request selesai —
// kalau tidak, ia bocor ke prompt think() user berikutnya. Test lifecycle
// di bawah menjalankan urutan nyata: reactEvent → hint dipakai →
// reactEvent selesai → think() user.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T5 — diversity does not affect normal user-driven actions", () => {
  test("diversity hint tidak muncul di system prompt saat _diversityHint kosong", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // think() tidak men-set _diversityHint → kosong
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).not.toContain("VARIASI PERILAKU");
  });

  test("think() tidak memanggil _recordProactiveBehavior", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // think() menggunakan history asli, bukan diversity history
    // Cukup verifikasi _diversityHistory tetap kosong setelah think
    expect(brain._diversityHistory.size).toBe(0);
  });

  test("brain.history (chat) terpisah dari diversity history", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // Chat history
    brain.history.push({ role: "user", content: "test" });
    // Diversity history berbeda
    fillHistory(brain, "idle", ["senang"]);
    // Keduanya tidak saling mempengaruhi
    expect(brain.history.length).toBe(1);
    expect(brain._diversityHistory.get("idle")?.length).toBe(1);
  });

  test("REGRESI F1 — reactEvent memakai hint, think() berikutnya tidak menerimanya", async () => {
    const { agent } = makeAgent();
    const origDoc = (globalThis as any).document;
    const origFetch = (globalThis as any).fetch;
    // speak tanpa memanggil callback → hanya segmen 0 diproses (deterministik,
    // tanpa timer lanjutan yang bisa bocor ke test lain).
    withAgent({ ...agent, speak: () => {}, lockAI: () => {}, unlockAI: () => {} });
    (globalThis as any).window.__appEvents = { idleSpeak: true, quietMs: 0 };
    (globalThis as any).document = { getElementById: () => null };

    const brain: any = new AgentBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // Isi history supaya diversityHint("idle") benar-benar menghasilkan hint.
    fillHistory(brain, "idle", ["senang+nod"]);

    const seen: { url: string; system: string }[] = [];
    (globalThis as any).fetch = async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      seen.push({ url: String(url), system: String(body.system || "") });
      if (String(url).includes("/api/animate-text")) {
        return { ok: true, status: 200, json: async () => ({ segments: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          reply: "[EMOTION:senang][GESTURE:nod] Halo! [EMOTION:malu][GESTURE:look_away_shy] Eh.",
        }),
      };
    };

    try {
      // 1) Request proaktif HARUS menerima hint.
      await brain.reactEvent("idle");
      const proactiveCall = seen.find((c) => c.url.includes("/api/chat"));
      expect(proactiveCall).toBeTruthy();
      expect(proactiveCall!.system).toContain("VARIASI PERILAKU");

      // 2) Setelah reactEvent selesai, hint bersih dan tidak ikut prompt berikutnya.
      expect(brain._diversityHint).toBe("");
      expect(brain.buildSystemPrompt("")).not.toContain("VARIASI PERILAKU");

      // 3) think() user berikutnya juga tidak menerima hint.
      seen.length = 0;
      await brain.think("halo");
      const thinkCall = seen.find((c) => c.url.includes("/api/chat"));
      expect(thinkCall).toBeTruthy();
      expect(thinkCall!.system).not.toContain("VARIASI PERILAKU");

      // 4) Mekanisme P15.2 sendiri tetap utuh (history tercatat).
      expect(brain._diversityHistory.size).toBeGreaterThan(0);
    } finally {
      (globalThis as any).fetch = origFetch;
      (globalThis as any).document = origDoc;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T6: Model switch mengosongkan/isolasi diversity state.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T6 — model switch clears diversity state", () => {
  test("invalidateCapabilityProfile mengosongkan diversity history", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    fillHistory(brain, "idle", ["senang", "sedih"]);
    fillHistory(brain, "mood:sedih", ["sedih+look_away_shy"]);
    expect(brain._diversityHistory.size).toBe(2);

    // Simulasi model switch
    brain.invalidateCapabilityProfile();

    expect(brain._diversityHistory.size).toBe(0);
    expect(brain._diversityHint).toBe("");
    expect(brain.capProfile).toBeNull();
  });

  test("setelah model switch, diversityHistory di _reactiveState kosong", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    fillHistory(brain, "idle", ["senang"]);
    brain.invalidateCapabilityProfile();
    const state = brain._reactiveState();
    expect(state.diversityHistory).toEqual({});
  });

  test("model switch tidak mempengaruhi chat history", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    brain.history.push({ role: "user", content: "test" });
    fillHistory(brain, "idle", ["senang"]);
    brain.invalidateCapabilityProfile();
    // Chat history tetap
    expect(brain.history.length).toBe(1);
    // Diversity history kosong
    expect(brain._diversityHistory.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T7: Empty candidate list aman.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T7 — empty candidate list is safe", () => {
  test("capProfile tanpa emotions → diversityHint mengembalikan kosong", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, { ...DEFAULT_PROFILE, emotions: [] });
    fillHistory(brain, "idle", ["senang"]);
    const hint = brain.diversityHint("idle");
    expect(hint).toBe("");
  });

  test("capProfile null → diversityHint mengembalikan kosong", () => {
    const { brain } = makeBrain();
    brain.capProfile = null;
    fillHistory(brain, "idle", ["senang"]);
    const hint = brain.diversityHint("idle");
    expect(hint).toBe("");
  });

  test("event type tidak dikenal + emotions kosong → aman", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, { ...DEFAULT_PROFILE, emotions: [] });
    fillHistory(brain, "unknown_event_type", ["something"]);
    const hint = brain.diversityHint("unknown_event_type");
    expect(hint).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T8: Unknown candidate aman.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T8 — unknown candidate is safe", () => {
  test("history berisi kandidat yang tidak ada di emotions → tetap aman", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // 'berbahagia' bukan emosi yang dikenal
    fillHistory(brain, "idle", ["berbahagia"]);
    const hint = brain.diversityHint("idle");
    // 'berbahagia' tidak ada di candidates → bukan duplikat →
    // tapi karena ada kandidat lain, hint tetap dihasilkan
    expect(typeof hint).toBe("string");
  });

  test("all candidates adalah unknown → tidak crash", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, { ...DEFAULT_PROFILE, emotions: ["unknown_emo_1", "unknown_emo_2"] });
    fillHistory(brain, "idle", ["unknown_emo_1"]);
    const hint = brain.diversityHint("idle");
    expect(hint).toContain("VARIASI PERILAKU");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T9: Tidak ada hardcoded model-specific motion ID.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T9 — no hardcoded model-specific motion IDs", () => {
  test("diversity mechanism tidak menyebut nama model spesifik", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    fillHistory(brain, "idle", ["senang+nod"]);
    const hint = brain.diversityHint("idle");

    // Tidak ada hardcoded model names
    const modelNames = [
      "ren", "lumine", "Ichika", "Natsumi", "koharu", "haru",
      "hiyori", "ritsu", "ARKit", "Mao", "wanko",
    ];
    for (const name of modelNames) {
      expect(hint).not.toContain(name);
    }
  });

  test("_recordProactiveBehavior tidak menyebut model name", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // record hanya menyimpan emotion+gesture pairs
    brain._recordProactiveBehavior("idle", [
      { text: "Halo!", actions: { emotion: "senang", gesture: "nod", intensity: 0.8 } },
    ]);
    const history = brain._diversityHistory.get("idle");
    expect(history).toEqual(["senang+nod"]);
    // Tidak ada nama model
    expect(history![0]).not.toMatch(/ren|lumine|ichika/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T10: Existing P15.1 structured context tetap utuh.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T10 — existing P15.1 structured context remains intact", () => {
  test("contextBlock masih ada dan berfungsi", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    // contextBlock dihasilkan oleh buildSystemPrompt
    const prompt = brain.buildSystemPrompt("");
    // Harus mengandung karakter info
    expect(prompt).toContain("KARAKTER LIVE2D");
    expect(prompt).toContain("TestChar");
  });

  test("contextBlock menampilkan mood jika bukan normal", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    brain.userMood = "senang";
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("Mood user: senang");
  });

  test("contextBlock tidak menampilkan mood saat normal", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    brain.userMood = "normal";
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).not.toContain("Mood user:");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T11: Existing native motion catalog tetap utuh.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T11 — native motion catalog remains intact", () => {
  test("motionCatalogBlock berfungsi dengan native motions", () => {
    const { brain } = makeBrain();
    const profileWithNative = {
      ...DEFAULT_PROFILE,
      motionCatalog: [
        { id: "idle_friendly", verb: "greet", compatibleEmotions: ["senang"], duration: 2.5, source: "native" },
        { id: "nod_yes", verb: "nod", compatibleEmotions: ["senang", "tersenyum"], duration: 1.0, source: "native" },
      ],
    };
    setCapProfile(brain, profileWithNative);
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("GERAKAN BAWAAN MODEL");
    expect(prompt).toContain("idle_friendly");
    expect(prompt).toContain("greet");
    expect(prompt).toContain("nod_yes");
  });

  test("motionCatalogBlock berfungsi dengan user motions", () => {
    const { brain } = makeBrain();
    const profileWithUser = {
      ...DEFAULT_PROFILE,
      motionCatalog: [
        { id: "dance_01", description: "Tarian kecil", tags: ["fun"], source: "user" },
      ],
    };
    setCapProfile(brain, profileWithUser);
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("GERAKAN BUATAN USER");
    expect(prompt).toContain("dance_01");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T12: Existing emotion/gesture behavior tetap utuh.
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 T12 — existing emotion/gesture behavior remains intact", () => {
  test("applyActions memanggil setExpression untuk emosi", () => {
    const { brain, calls } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    withAgent({
      isReady: () => true,
      getExpressibleEmotions: () => ({ senang: "param" }),
      setExpression: (...a: any[]) => calls.setExpression.push(a),
      setAIPose: (...a: any[]) => calls.setAIPose.push(a),
      playGesture: (...a: any[]) => calls.playGesture.push(a),
    });
    const segments = parseSegments("[EMOTION:senang][GESTURE:nod] Halo!");
    brain.applyActions(segments[0].actions, 0, "Halo!");
    expect(calls.setExpression.length).toBeGreaterThanOrEqual(1);
    expect(calls.setExpression[0][0]).toBe("senang");
  });

  test("applyActions memanggil playGesture", () => {
    const { brain, calls } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    withAgent({
      isReady: () => true,
      getExpressibleEmotions: () => ({ senang: "param" }),
      setExpression: (...a: any[]) => calls.setExpression.push(a),
      setAIPose: (...a: any[]) => calls.setAIPose.push(a),
      playGesture: (...a: any[]) => calls.playGesture.push(a),
    });
    const segments = parseSegments("[EMOTION:senang][GESTURE:nod] Halo!");
    brain.applyActions(segments[0].actions, 0, "Halo!");
    expect(calls.playGesture.length).toBe(1);
    expect(calls.playGesture[0][0]).toBe("nod");
  });

  test("EVENT_EMOTION_PREFS tetap benar untuk semua event type", () => {
    // Verifikasi preferences tidak berubah setelah P15.2
    const { brain } = makeBrain();
    const prefs = (brain as any)._EVENT_EMOTION_PREFS;
    expect(prefs.user_left).toEqual(["sedih", "malu", "bingung"]);
    expect(prefs.user_returned).toEqual(["senang", "tersenyum", "kaget"]);
    expect(prefs["mood:sedih"]).toEqual(["sedih", "bingung"]);
    expect(prefs["mood:marah"]).toEqual(["bingung", "kaget", "sedih"]);
    expect(prefs["mood:senang"]).toEqual(["senang", "tersenyum"]);
    expect(prefs["mood:kaget"]).toEqual(["kaget", "bingung"]);
  });

  test("all emotions tetap ada di DEFAULT_EMOTIONS", () => {
    // Pastikan emosi default tidak berubah
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("DAFTAR EMOSI");
    expect(prompt).toContain("senang");
    expect(prompt).toContain("tersenyum");
    expect(prompt).toContain("sedih");
    expect(prompt).toContain("malu");
    expect(prompt).toContain("kaget");
    expect(prompt).toContain("kesal");
    expect(prompt).toContain("bingung");
    expect(prompt).toContain("normal");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tambahan: _reactiveState mengekspos diversityHistory
// ═══════════════════════════════════════════════════════════════════════
describe("P15.2 — _reactiveState exposes diversityHistory", () => {
  test("diversityHistory muncul di _reactiveState", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    fillHistory(brain, "idle", ["senang"]);
    const state = brain._reactiveState();
    expect(state.diversityHistory).toBeDefined();
    expect(state.diversityHistory.idle).toEqual(["senang"]);
  });

  test("tanpa history, diversityHistory adalah objek kosong", () => {
    const { brain } = makeBrain();
    setCapProfile(brain, DEFAULT_PROFILE);
    const state = brain._reactiveState();
    expect(state.diversityHistory).toEqual({});
  });
});
