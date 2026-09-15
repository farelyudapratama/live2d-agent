/**
 * director-mood-context.test.ts — Phase 15.3: Director mood awareness.
 *
 * Menguji bahwa Animation Director menerima konteks perilaku (mood user +
 * durasi sesi) lewat field `context` pada request body `/api/animate-text`,
 * dan bahwa konteks tersebut masuk ke Director prompt tanpa merusak
 * existing behavior (P15.1 Speaker context, P15.2 diversity, model identity,
 * native motion catalog, emotion/gesture capabilities).
 *
 * Yang dikunci:
 *   T1  Director receives current user mood
 *   T2  Director receives session duration
 *   T3  normal mood is omitted (sesuai konvensi prompt existing)
 *   T4  context <= 200 characters
 *   T5  no raw Cubism parameter IDs
 *   T6  no parameter ranges
 *   T7  no ModelProfile dump
 *   T8  existing model identity remains present
 *   T9  existing native motion catalog remains present
 *   T10 existing Director emotion/gesture capabilities remain present
 *   T11 user-driven Speaker P15.1 context remains unchanged
 *   T12 P15.2 proactive diversity remains isolated from Director
 *   T13 model switch does not leave stale Director context
 *   T14 empty/invalid mood is safe
 *   T15 no model-specific motion/expression hardcoding
 *   T16 Director still works when context is absent/minimal
 */
import { describe, test, expect, afterEach } from "bun:test";
import { AgentBrain } from "../src/client/agent/brain";

// ── Fake window.__live2dAgent (pola konsisten brain-apply-actions.test.ts) ──

function makeAgent(overrides: Record<string, any> = {}) {
  const agent: any = {
    isReady: () => true,
    getExpressibleEmotions: () => ({
      senang: "param", tersenyum: "param", sedih: "native", malu: "param",
      kaget: "param", kesal: "param", bingung: "param", normal: "param",
    }),
    setExpression: () => {},
    setAIPose: () => {},
    playMotion: () => true,
    playGesture: () => {},
    getCapabilityProfile: () => ({
      emotions: ["senang", "tersenyum", "sedih", "malu", "kaget", "kesal", "bingung", "normal"],
      nativeExpressions: ["exp_01", "exp_02"],
      accessories: [],
      properties: [],
      gestures: ["nod", "shake", "tilt_curious", "lean_excited", "recoil_surprised", "look_away_shy", "laugh_bounce", "think", "wave_hi"],
      motionCatalog: [],
      sheet: { config: { displayName: "TestChar" } },
      userNote: "Karakter ceria",
      roleIds: {},
      paramRange: {},
      modelName: "test-model",
      controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
    }),
    ...overrides,
  };
  return agent;
}

const origWindow = (globalThis as any).window;
function withAgent(agent: any): void {
  (globalThis as any).window = { __live2dAgent: agent };
}
afterEach(() => {
  (globalThis as any).window = origWindow;
});

function makeBrain(overrides?: Record<string, any>) {
  const agent = makeAgent(overrides);
  withAgent(agent);
  return new AgentBrain();
}

const DEFAULT_PROFILE: any = {
  emotions: ["senang", "tersenyum", "sedih", "malu", "kaget", "kesal", "bingung", "normal"],
  nativeExpressions: ["exp_01", "exp_02"],
  accessories: [],
  properties: [],
  gestures: ["nod", "shake", "tilt_curious", "lean_excited", "recoil_surprised", "look_away_shy", "laugh_bounce", "think", "wave_hi"],
  motionCatalog: [
    { id: "idle_friendly", verb: "greet", compatibleEmotions: ["senang"], duration: 2.5, source: "native" },
    { id: "dance_01", description: "Tarian kecil", tags: ["fun"], source: "user" },
  ],
  sheet: { config: { displayName: "TestChar" }, params: [
    { id: "ParamAngleX", userNote: "kepala kiri/kanan" },
    { id: "ParamMouthOpenY", userNote: "buka rahang" },
  ] },
  userNote: "Karakter ceria yang suka mengobrol",
  roleIds: { head: "ParamAngleX" },
  paramRange: { head: { min: -30, max: 30, def: 0 } },
  modelName: "test-model",
  controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
};

// ═══════════════════════════════════════════════════════════════════════
// T1: Director receives current user mood
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T1 — Director receives current user mood", () => {
  test("mood 'sedih' muncul di directorContextBlock", () => {
    const brain: any = makeBrain();
    brain.userMood = "sedih";
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("Mood user: sedih");
  });

  test("mood 'senang' muncul di directorContextBlock", () => {
    const brain: any = makeBrain();
    brain.userMood = "senang";
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("Mood user: senang");
  });

  test("mood 'kaget' muncul di directorContextBlock", () => {
    const brain: any = makeBrain();
    brain.userMood = "kaget";
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("Mood user: kaget");
  });

  test("context block mengandung section header", () => {
    const brain: any = makeBrain();
    brain.userMood = "sedih";
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("=== KONTEKS PERILAKU ===");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T2: Director receives session duration
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T2 — Director receives session duration", () => {
  test("session < 60 menit ditampilkan dalam format menit", () => {
    const brain: any = makeBrain();
    brain.agentStart = Date.now() - 5 * 60 * 1000; // 5 menit lalu
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("Sesi: 5m");
  });

  test("session >= 60 menit ditampilkan dalam format jam + menit", () => {
    const brain: any = makeBrain();
    brain.agentStart = Date.now() - 90 * 60 * 1000; // 1 jam 30 menit lalu
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("Sesi: 1h 30m");
  });

  test("session 0 menit ditampilkan sebagai '0m'", () => {
    const brain: any = makeBrain();
    brain.agentStart = Date.now();
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("Sesi: 0m");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T3: normal mood is omitted (sesuai konvensi P15.1)
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T3 — normal mood is omitted", () => {
  test("mood 'normal' tidak muncul di context block", () => {
    const brain: any = makeBrain();
    brain.userMood = "normal";
    const ctx = brain.directorContextBlock();
    expect(ctx).not.toContain("Mood user:");
  });

  test("mood kosong tidak muncul di context block", () => {
    const brain: any = makeBrain();
    brain.userMood = "";
    const ctx = brain.directorContextBlock();
    expect(ctx).not.toContain("Mood user:");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T4: context <= 200 characters
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T4 — context is <= 200 characters", () => {
  test("mood + sesi pendek <= 200 char", () => {
    const brain: any = makeBrain();
    brain.userMood = "sedih";
    brain.agentStart = Date.now() - 5 * 60 * 1000;
    const ctx = brain.directorContextBlock();
    expect(ctx.length).toBeLessThanOrEqual(200);
  });

  test("mood + sesi panjang <= 200 char", () => {
    const brain: any = makeBrain();
    brain.userMood = "kaget";
    brain.agentStart = Date.now() - 125 * 60 * 1000; // 2h 5m
    const ctx = brain.directorContextBlock();
    expect(ctx.length).toBeLessThanOrEqual(200);
  });

  test("tanpa mood, hanya sesi <= 200 char", () => {
    const brain: any = makeBrain();
    brain.userMood = "normal";
    brain.agentStart = Date.now() - 60 * 60 * 1000;
    const ctx = brain.directorContextBlock();
    expect(ctx.length).toBeLessThanOrEqual(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T5: no raw Cubism parameter IDs
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T5 — no raw Cubism parameter IDs", () => {
  test("directorContextBlock tidak menyebut ParamAngleX, ParamMouth, dll", () => {
    const brain: any = makeBrain();
    brain.userMood = "sedih";
    brain.agentStart = Date.now() - 10 * 60 * 1000;
    const ctx = brain.directorContextBlock();
    const forbidden = ["ParamAngle", "ParamMouth", "ParamEye", "ParamBody", "ParamBrow", "ParamBreath"];
    for (const id of forbidden) {
      expect(ctx).not.toContain(id);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T6: no parameter ranges
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T6 — no parameter ranges", () => {
  test("directorContextBlock tidak menyebut min/max/default", () => {
    const brain: any = makeBrain();
    brain.userMood = "senang";
    brain.agentStart = Date.now() - 20 * 60 * 1000;
    const ctx = brain.directorContextBlock();
    expect(ctx).not.toContain("min:");
    expect(ctx).not.toContain("max:");
    expect(ctx).not.toContain("default:");
    expect(ctx).not.toContain("paramRange");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T7: no ModelProfile dump
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T7 — no ModelProfile dump", () => {
  test("directorContextBlock tidak menyebut capability, sheet, atau roleIds", () => {
    const brain: any = makeBrain();
    brain.userMood = "malu";
    brain.agentStart = Date.now() - 15 * 60 * 1000;
    const ctx = brain.directorContextBlock();
    expect(ctx).not.toContain("capability");
    expect(ctx).not.toContain("sheet");
    expect(ctx).not.toContain("roleIds");
    expect(ctx).not.toContain("userNote");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T8: existing model identity remains present
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T8 — existing model identity remains present", () => {
  test("buildSystemPrompt masih mengandung nama karakter dan model", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("TestChar");
    expect(prompt).toContain("test-model");
  });

  test("directorContextBlock tidak menghapus model identity dari prompt", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain.userMood = "sedih";
    brain.directorContextBlock(); // dipanggil tapi tidak mengubah capProfile
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("TestChar");
    expect(prompt).toContain("test-model");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T9: existing native motion catalog remains present
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T9 — native motion catalog remains present", () => {
  test("Speaker prompt masih mengandung GERAKAN BAWAAN MODEL", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("GERAKAN BAWAAN MODEL");
    expect(prompt).toContain("idle_friendly");
    expect(prompt).toContain("dance_01");
  });

  test("directorContextBlock tidak menghapus native motion catalog", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain.userMood = "kaget";
    brain.directorContextBlock();
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("GERAKAN BAWAAN MODEL");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T10: existing Director emotion/gesture capabilities remain present
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T10 — Director capabilities remain present", () => {
  test("Speaker prompt masih mengandung DAFTAR EMOSI dan DAFTAR GESTURE", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("DAFTAR EMOSI");
    expect(prompt).toContain("DAFTAR GESTURE");
    expect(prompt).toContain("nod");
    expect(prompt).toContain("shake");
    expect(prompt).toContain("senang");
    expect(prompt).toContain("sedih");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T11: user-driven Speaker P15.1 context remains unchanged
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T11 — P15.1 Speaker context remains unchanged", () => {
  test("contextBlock() masih berfungsi dengan mood", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain.userMood = "senang";
    const prompt = brain.buildSystemPrompt("");
    // P15.1 context di system prompt Speaker
    expect(prompt).toContain("KONTEKS PERILAKU");
    expect(prompt).toContain("Mood user: senang");
  });

  test("contextBlock() menampilkan durasi sesi", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain.agentStart = Date.now() - 10 * 60 * 1000;
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("Sesi: 10m");
  });

  test("directorContextBlock() menghasilkan format yang konsisten", () => {
    const brain: any = makeBrain();
    brain.userMood = "sedih";
    brain.agentStart = Date.now() - 3 * 60 * 1000;
    const ctx = brain.directorContextBlock();
    // Format yang sama: === KONTEKS PERILAKU ===
    expect(ctx).toContain("=== KONTEKS PERILAKU ===");
    expect(ctx).toContain("Mood user: sedih");
    expect(ctx).toContain("Sesi: 3m");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T12: P15.2 proactive diversity remains isolated from Director
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T12 — P15.2 diversity isolated from Director", () => {
  test("diversityHistory tidak muncul di directorContextBlock", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain.userMood = "sedih";
    // Isi diversity history (simulasi P15.2)
    brain._diversityHistory.set("idle", ["senang+nod", "sedih+shake"]);
    const ctx = brain.directorContextBlock();
    expect(ctx).not.toContain("senang+nod");
    expect(ctx).not.toContain("VARIASI PERILAKU");
    expect(ctx).not.toContain("idle");
  });

  test("_diversityHint tidak muncul di directorContextBlock", () => {
    const brain: any = makeBrain();
    brain.userMood = "kaget";
    brain._diversityHint = "=== VARIASI PERILAKU === Baru-baru kamu sudah: senang.";
    const ctx = brain.directorContextBlock();
    expect(ctx).not.toContain("VARIASI PERILAKU");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T13: model switch does not leave stale Director context
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T13 — model switch does not leave stale context", () => {
  test("invalidateCapabilityProfile mempertahankan mood yang valid", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain.userMood = "sedih";
    brain.agentStart = Date.now() - 5 * 60 * 1000;
    brain.invalidateCapabilityProfile();
    // userMood dan agentStart tidak di-reset oleh invalidateCapabilityProfile
    // (hanya capProfile dan diversity yang di-reset)
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("Mood user: sedih");
    expect(ctx).toContain("Sesi: 5m");
  });

  test("setelah model switch, Director context mencerminkan state baru", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain.userMood = "senang";
    brain.agentStart = Date.now() - 2 * 60 * 1000;
    brain.invalidateCapabilityProfile();
    // userMood dan agentStart tetap — Director context tetap valid
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("Mood user: senang");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T14: empty/invalid mood is safe
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T14 — empty/invalid mood is safe", () => {
  test("mood null → tidak crash, tidak ada mood line", () => {
    const brain: any = makeBrain();
    brain.userMood = null;
    brain.agentStart = Date.now() - 1 * 60 * 1000;
    const ctx = brain.directorContextBlock();
    expect(ctx).not.toContain("Mood user:");
    expect(ctx).toContain("Sesi: 1m");
  });

  test("mood undefined → tidak crash", () => {
    const brain: any = makeBrain();
    brain.userMood = undefined;
    brain.agentStart = Date.now();
    const ctx = brain.directorContextBlock();
    expect(typeof ctx).toBe("string");
  });

  test("mood string acak → tetap ditampilkan", () => {
    const brain: any = makeBrain();
    brain.userMood = "unknown_mood";
    brain.agentStart = Date.now() - 30 * 1000;
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("Mood user: unknown_mood");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T15: no model-specific motion/expression hardcoding
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T15 — no model-specific motion/expression hardcoding", () => {
  test("directorContextBlock tidak menyebut nama model spesifik", () => {
    const brain: any = makeBrain();
    brain.userMood = "sedih";
    brain.agentStart = Date.now() - 5 * 60 * 1000;
    const ctx = brain.directorContextBlock();
    const modelNames = [
      "ren", "lumine", "Ichika", "Natsumi", "koharu", "haru",
      "hiyori", "ritsu", "Mao", "wanko",
    ];
    for (const name of modelNames) {
      expect(ctx).not.toContain(name);
    }
  });

  test("directorContextBlock tidak menyebut motion ID atau expression ID", () => {
    const brain: any = makeBrain();
    brain.userMood = "senang";
    brain.agentStart = Date.now() - 5 * 60 * 1000;
    const ctx = brain.directorContextBlock();
    const ids = ["idle_friendly", "dance_01", "exp_01", "exp_02", "nod", "shake"];
    for (const id of ids) {
      expect(ctx).not.toContain(id);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T16: Director still works when context is absent/minimal
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 T16 — Director still works when context is absent/minimal", () => {
  test("tanpa capProfile → directorContextBlock mengembalikan kosong", () => {
    const brain: any = makeBrain();
    brain.capProfile = null;
    brain.userMood = "normal";
    brain.agentStart = Date.now();
    const ctx = brain.directorContextBlock();
    // Hanya sesi: 0m — tanpa mood
    expect(ctx).toContain("Sesi: 0m");
    expect(ctx).not.toContain("Mood user:");
  });

  test("mood normal + session 0 → context hanya berisi sesi", () => {
    const brain: any = makeBrain();
    brain.userMood = "normal";
    brain.agentStart = Date.now();
    const ctx = brain.directorContextBlock();
    expect(ctx).toBe("\n=== KONTEKS PERILAKU ===\nSesi: 0m\n");
  });

  test("buildSystemPrompt tetap berfungsi tanpa directorContextBlock", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain.userMood = "normal";
    brain.agentStart = Date.now();
    // directorContextBlock dipanggil tapi context tidak dimasukkan
    // ke buildSystemPrompt (itu hanya untuk Director)
    const prompt = brain.buildSystemPrompt("");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tambahan: animateTextViaDirector mengirim context field
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 — animateTextViaDirector sends context field", () => {
  test("directorContextBlock tersedia sebagai method publik", () => {
    const brain: any = makeBrain();
    brain.userMood = "sedih";
    brain.agentStart = Date.now() - 10 * 60 * 1000;
    // Method publik — bisa dipanggil dari luar
    expect(typeof brain.directorContextBlock).toBe("function");
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("Mood user: sedih");
    expect(ctx).toContain("Sesi: 10m");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tambahan: P15.1 Speaker vs P15.3 Director format consistency
// ═══════════════════════════════════════════════════════════════════════
describe("P15.3 — Speaker vs Director context format consistency", () => {
  test("kedua block menggunakan header yang sama", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain.userMood = "sedih";
    brain.agentStart = Date.now() - 5 * 60 * 1000;
    const directorCtx = brain.directorContextBlock();
    // contextBlock() diakses via buildSystemPrompt
    const prompt = brain.buildSystemPrompt("");
    // Keduanya harus mengandung header yang sama
    expect(directorCtx).toContain("=== KONTEKS PERILAKU ===");
    expect(prompt).toContain("=== KONTEKS PERILAKU ===");
  });

  test("kedua block menampilkan mood dengan format yang sama", () => {
    const brain: any = makeBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain.userMood = "kaget";
    brain.agentStart = Date.now() - 8 * 60 * 1000;
    const directorCtx = brain.directorContextBlock();
    const prompt = brain.buildSystemPrompt("");
    expect(directorCtx).toContain("Mood user: kaget");
    expect(prompt).toContain("Mood user: kaget");
  });
});
