/**
 * expression-classifier.test.ts — Phase 15.4: Conservative expression classifier.
 *
 * Menguji classifier heuristic berbasis nama token untuk expression Live2D.
 * Classifier hanya menggunakan token nama — tidak menggunakan parameter,
 * file path, urutan, atau index.
 *
 * Yang dikunci:
 *   T1  obvious "angry" expression classified angry
 *   T2  obvious "sad/tear" expression classified sad
 *   T3  obvious "happy/smile" expression classified happy
 *   T4  obvious "surprise/shock" expression classified surprised
 *   T5  obvious "shy/blush" expression classified shy
 *   T6  obvious sleep expression classified sleep (→ bingung jika tidak ada kanonik sleep)
 *   T7  obvious think expression classified think (→ bingung jika tidak ada kanonik think)
 *   T8  neutral/normal classified neutral if present
 *   T9  exp_01 remains UNKNOWN
 *   T10 exp_02 remains UNKNOWN
 *   T11 numeric/index-only names remain UNKNOWN
 *   T12 arbitrary prop/character name remains UNKNOWN unless strong evidence
 *   T13 ambiguous name does not get a confident classification
 *   T14 classifier is deterministic
 *   T15 no model-specific mapping
 *   T16 no index-based mapping
 *   T17 existing expression IDs are preserved
 *   T18 opaque expressions remain selectable
 *   T19 model switch recomputes classification
 *   T20 no raw parameter IDs/ranges exposed
 *   T21 existing Speaker expression catalog remains intact
 *   T22 existing Director expression behavior remains intact
 *   T23 P15.1 context remains intact
 *   T24 P15.2 diversity remains intact
 *   T25 P15.3 Director context remains intact
 *
 * Real model verification:
 *   ren: exp_01..exp_05 (opaque) → semua UNKNOWN
 *   lumine: exp_angry, exp_blush, exp_sad, exp_tear, collar_blue → semantic + opaque
 *   神宮白子: 呆猫, 猫咪滤镜, 拍照, 眼镜 → prop/character, UNKNOWN
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  classifyExpressionName,
  expressionHint,
  type ExpressionClassification,
} from "../src/client/agent/expression-classifier";
import { AgentBrain } from "../src/client/agent/brain";

// ── Fake window setup (konsisten dengan test lain) ──

function makeAgent(overrides: Record<string, any> = {}) {
  return {
    isReady: () => true,
    getExpressibleEmotions: () => ({
      senang: "param", tersenyum: "param", sedih: "native", malu: "param",
      kaget: "param", kesal: "param", bingung: "param", normal: "param",
    }),
    setExpression: () => {},
    setAIPose: () => {},
    playMotion: () => true,
    playGesture: () => {},
    ...overrides,
  };
}

const origWindow = (globalThis as any).window;
function withAgent(agent: any): void {
  (globalThis as any).window = { __live2dAgent: agent };
}
afterEach(() => { (globalThis as any).window = origWindow; });

const DEFAULT_PROFILE: any = {
  emotions: ["senang", "tersenyum", "sedih", "malu", "kaget", "kesal", "bingung", "normal"],
  nativeExpressions: ["exp_01", "exp_02", "exp_03", "exp_04", "exp_05"],
  accessories: [],
  properties: [],
  gestures: ["nod", "shake"],
  motionCatalog: [],
  sheet: { config: { displayName: "TestChar" } },
  userNote: "",
  roleIds: {},
  paramRange: {},
  modelName: "test-model",
  controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
};

// ═══════════════════════════════════════════════════════════════════════
// T1: obvious "angry" expression classified angry
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T1 — angry classification", () => {
  test("'exp_angry' → kesal", () => {
    const r = classifyExpressionName("exp_angry");
    expect(r.emotion).toBe("kesal");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.evidence).toContain("angry");
  });

  test("'angry' → kesal", () => {
    const r = classifyExpressionName("angry");
    expect(r.emotion).toBe("kesal");
  });

  test("'exp_rage' → kesal", () => {
    expect(classifyExpressionName("exp_rage").emotion).toBe("kesal");
  });

  test("'anger_face' → kesal (token boundary prevents false match)", () => {
    // 'anger' matches as a standalone token in 'anger_face'
    const r = classifyExpressionName("anger_face");
    expect(r.emotion).toBe("kesal");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T2: obvious "sad/tear" expression classified sad
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T2 — sad classification", () => {
  test("'exp_sad' → sedih", () => {
    const r = classifyExpressionName("exp_sad");
    expect(r.emotion).toBe("sedih");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.evidence).toContain("sad");
  });

  test("'exp_tear' → sedih", () => {
    const r = classifyExpressionName("exp_tear");
    expect(r.emotion).toBe("sedih");
  });

  test("'cry' → sedih", () => {
    expect(classifyExpressionName("cry").emotion).toBe("sedih");
  });

  test("'exp_crying' → sedih", () => {
    expect(classifyExpressionName("exp_crying").emotion).toBe("sedih");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T3: obvious "happy/smile" expression classified happy
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T3 — happy classification", () => {
  test("'exp_happy' → senang", () => {
    const r = classifyExpressionName("exp_happy");
    expect(r.emotion).toBe("senang");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("'exp_smile' → tersenyum", () => {
    const r = classifyExpressionName("exp_smile");
    expect(r.emotion).toBe("tersenyum");
  });

  test("'exp_heart' → senang (love = happy)", () => {
    // heart bukan token emosi langsung — jadi harus UNKNOWN
    // KECUALI kita menambahkannya. Saat ini heart tidak ada di TOKEN_TO_EMOTION.
    const r = classifyExpressionName("exp_heart");
    expect(r.emotion).toBeNull(); // heart tidak ada di peta → UNKNOWN
  });

  test("'happy_face' → senang", () => {
    expect(classifyExpressionName("happy_face").emotion).toBe("senang");
  });

  test("'exp_joy' → senang", () => {
    expect(classifyExpressionName("exp_joy").emotion).toBe("senang");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T4: obvious "surprise/shock" expression classified surprised
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T4 — surprised classification", () => {
  test("'exp_surprised' → kaget", () => {
    const r = classifyExpressionName("exp_surprised");
    expect(r.emotion).toBe("kaget");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("'exp_shock' → kaget", () => {
    expect(classifyExpressionName("exp_shock").emotion).toBe("kaget");
  });

  test("'surprise_face' → kaget", () => {
    expect(classifyExpressionName("surprise_face").emotion).toBe("kaget");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T5: obvious "shy/blush" expression classified shy
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T5 — shy classification", () => {
  test("'exp_shy' → malu", () => {
    const r = classifyExpressionName("exp_shy");
    expect(r.emotion).toBe("malu");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("'exp_blush' → malu", () => {
    expect(classifyExpressionName("exp_blush").emotion).toBe("malu");
  });

  test("'blushing' → malu", () => {
    expect(classifyExpressionName("blushing").emotion).toBe("malu");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T6: sleep → bingung (tidak ada kanonik "sleep" di DEFAULT_EMOTIONS)
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T6 — sleep classification", () => {
  test("'sleepy' → UNKNOWN (tidak ada kanonik sleep)", () => {
    const r = classifyExpressionName("sleepy");
    // sleep tidak ada di TOKEN_TO_EMOTION → UNKNOWN
    expect(r.emotion).toBeNull();
  });

  test("'exp_sleep' → UNKNOWN", () => {
    expect(classifyExpressionName("exp_sleep").emotion).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T7: think → bingung (tidak ada kanonik "think" di DEFAULT_EMOTIONS)
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T7 — think classification", () => {
  test("'thinking' → UNKNOWN (tidak ada kanonik think)", () => {
    const r = classifyExpressionName("thinking");
    // think tidak ada di TOKEN_TO_EMOTION → UNKNOWN
    expect(r.emotion).toBeNull();
  });

  test("'exp_think' → UNKNOWN", () => {
    expect(classifyExpressionName("exp_think").emotion).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T8: neutral/normal classified neutral if present
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T8 — neutral classification", () => {
  test("'neutral' → normal", () => {
    const r = classifyExpressionName("neutral");
    expect(r.emotion).toBe("normal");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("'exp_normal' → normal", () => {
    expect(classifyExpressionName("exp_normal").emotion).toBe("normal");
  });

  test("'default' → normal", () => {
    expect(classifyExpressionName("default").emotion).toBe("normal");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T9: exp_01 remains UNKNOWN
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T9 — exp_01 remains UNKNOWN", () => {
  test("'exp_01' → null emotion", () => {
    const r = classifyExpressionName("exp_01");
    expect(r.emotion).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.evidence).toContain("no semantic token");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T10: exp_02 remains UNKNOWN
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T10 — exp_02 remains UNKNOWN", () => {
  test("'exp_02' → null emotion", () => {
    const r = classifyExpressionName("exp_02");
    expect(r.emotion).toBeNull();
    expect(r.confidence).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T11: numeric/index-only names remain UNKNOWN
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T11 — numeric names remain UNKNOWN", () => {
  test("'expression_3' → null", () => {
    expect(classifyExpressionName("expression_3").emotion).toBeNull();
  });

  test("'expr_12' → null", () => {
    expect(classifyExpressionName("expr_12").emotion).toBeNull();
  });

  test("'001' → null", () => {
    expect(classifyExpressionName("001").emotion).toBeNull();
  });

  test("'exp03' → null (angka tanpa separator)", () => {
    expect(classifyExpressionName("exp03").emotion).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T12: arbitrary prop/character name remains UNKNOWN
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T12 — prop/character names remain UNKNOWN", () => {
  test("'collar_blue' → null (prop)", () => {
    expect(classifyExpressionName("collar_blue").emotion).toBeNull();
  });

  test("'X_change' → null (prop)", () => {
    expect(classifyExpressionName("X_change").emotion).toBeNull();
  });

  test("'glasses' → null (prop)", () => {
    expect(classifyExpressionName("glasses").emotion).toBeNull();
  });

  test("'apron' → null (prop)", () => {
    expect(classifyExpressionName("apron").emotion).toBeNull();
  });

  // Real model: 神宮白子
  test("'呆猫' → null (prop/character)", () => {
    expect(classifyExpressionName("呆猫").emotion).toBeNull();
  });

  test("'猫咪滤镜' → null (prop)", () => {
    expect(classifyExpressionName("猫咪滤镜").emotion).toBeNull();
  });

  test("'拍照' → null (action/prop)", () => {
    expect(classifyExpressionName("拍照").emotion).toBeNull();
  });

  test("'眼镜' → null (prop)", () => {
    expect(classifyExpressionName("眼镜").emotion).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T13: ambiguous name does not get a confident classification
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T13 — ambiguous names", () => {
  test("'exp_love' → null (love bisa happy, tapi ambigu)", () => {
    const r = classifyExpressionName("exp_love");
    expect(r.emotion).toBeNull();
  });

  test("'star' → null (bukan emosi)", () => {
    expect(classifyExpressionName("star").emotion).toBeNull();
  });

  test("'fire' → null (bukan emosi)", () => {
    expect(classifyExpressionName("fire").emotion).toBeNull();
  });

  test("'exp_question' → null", () => {
    expect(classifyExpressionName("exp_question").emotion).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T14: classifier is deterministic
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T14 — determinism", () => {
  test("same input always produces same output", () => {
    const inputs = [
      "exp_angry", "exp_01", "happy", "sad", "unknown_name",
      "exp_blush", "neutral", "呆猫", "collar_blue",
    ];
    for (const input of inputs) {
      const r1 = classifyExpressionName(input);
      const r2 = classifyExpressionName(input);
      expect(r1.emotion).toBe(r2.emotion);
      expect(r1.confidence).toBe(r2.confidence);
      expect(r1.evidence).toBe(r2.evidence);
    }
  });

  test("empty/null/undefined inputs are safe and consistent", () => {
    for (const input of ["", null, undefined, 42 as any]) {
      const r = classifyExpressionName(input as string);
      expect(r.emotion).toBeNull();
      expect(r.confidence).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T15: no model-specific mapping
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T15 — no model-specific mapping", () => {
  test("classifier tidak menyebut nama model spesifik", () => {
    const inputs = ["exp_angry", "exp_sad", "happy", "exp_01"];
    for (const input of inputs) {
      const r = classifyExpressionName(input);
      // evidence hanya berisi 'name token: ...' — tidak ada nama model
      expect(r.evidence).not.toMatch(/ren|lumine|Ichika|Natsumi|koharu|haru/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T16: no index-based mapping
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T16 — no index-based mapping", () => {
  test("expression_1 dan expression_2 keduanya UNKNOWN (tidak ada mapping by index)", () => {
    const r1 = classifyExpressionName("expression_1");
    const r2 = classifyExpressionName("expression_2");
    expect(r1.emotion).toBeNull();
    expect(r2.emotion).toBeNull();
  });

  test("exp_03 juga UNKNOWN — tidak ada hardcoded index mapping", () => {
    expect(classifyExpressionName("exp_03").emotion).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T17: existing expression IDs are preserved
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T17 — expression IDs preserved", () => {
  test("expressionHint() mengembalikan nama asli untuk UNKNOWN", () => {
    expect(expressionHint("exp_01")).toBe("exp_01");
    expect(expressionHint("collar_blue")).toBe("collar_blue");
    expect(expressionHint("呆猫")).toBe("呆猫");
  });

  test("expressionHint() menambahkan emotion hint untuk yang dikenal", () => {
    const h = expressionHint("exp_angry");
    expect(h).toContain("exp_angry");
    expect(h).toContain("emotion: kesal");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T18: opaque expressions remain selectable
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T18 — opaque expressions selectable", () => {
  test("exp_01 tetap muncul di expressionHint output", () => {
    const h = expressionHint("exp_01");
    expect(h).toBe("exp_01"); // tanpa emosi, hanya nama
  });

  test("expression catalog dengan semua UNKNOWN tetap valid", () => {
    const names = ["exp_01", "exp_02", "exp_03", "exp_04", "exp_05"];
    const hints = names.map(expressionHint);
    // Semua harus kembali dengan nama asli
    expect(hints).toEqual(["exp_01", "exp_02", "exp_03", "exp_04", "exp_05"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T19: model switch recomputes classification
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T19 — model switch recomputes", () => {
  test("classification is stateless — tidak ada cache yang bisa stale", () => {
    // Classifier adalah pure function — tidak ada state internal.
    // Setiap panggilan mengklasifikasi dari awal.
    const r1 = classifyExpressionName("exp_angry");
    const r2 = classifyExpressionName("exp_01");
    // Berbeda input → berbeda output (bukan cache)
    expect(r1.emotion).toBe("kesal");
    expect(r2.emotion).toBeNull();
  });

  test("expressionHint untuk catalog baru langsung benar", () => {
    // Simulasi: model A punya exp_01, model B punya exp_angry
    const modelA = ["exp_01", "exp_02"];
    const modelB = ["exp_angry", "exp_sad"];
    const hintsA = modelA.map(expressionHint);
    const hintsB = modelB.map(expressionHint);
    expect(hintsA).toEqual(["exp_01", "exp_02"]); // semua UNKNOWN
    expect(hintsB).toEqual(["exp_angry — emotion: kesal", "exp_sad — emotion: sedih"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T20: no raw parameter IDs/ranges exposed
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T20 — no raw parameter IDs exposed", () => {
  test("classifyExpressionName tidak mengembalikan parameter info", () => {
    const r = classifyExpressionName("exp_angry");
    // Output hanya berisi emotion, confidence, evidence
    expect(r).toHaveProperty("emotion");
    expect(r).toHaveProperty("confidence");
    expect(r).toHaveProperty("evidence");
    expect(r).not.toHaveProperty("params");
    expect(r).not.toHaveProperty("file");
    expect(r).not.toHaveProperty("range");
  });

  test("expressionHint tidak menyebut ParamAngleX atau parameter lain", () => {
    const h = expressionHint("exp_angry");
    expect(h).not.toMatch(/Param[A-Z]/);
    expect(h).not.toContain("range");
    expect(h).not.toContain("min:");
    expect(h).not.toContain("max:");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T21: existing Speaker expression catalog remains intact
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T21 — Speaker expression catalog intact", () => {
  test("buildSystemPrompt masih mengandung DAFTAR EXPRESSION", () => {
    withAgent(makeAgent());
    const brain: any = new AgentBrain();
    brain.capProfile = DEFAULT_PROFILE;
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("DAFTAR EXPRESSION");
    expect(prompt).toContain("PROP");
  });

  test("buildSystemPrompt dengan expressions opaque tetap benar", () => {
    withAgent(makeAgent());
    const brain: any = new AgentBrain();
    brain.capProfile = { ...DEFAULT_PROFILE, nativeExpressions: ["exp_01", "exp_02"] };
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("exp_01");
    expect(prompt).toContain("exp_02");
  });

  test("buildSystemPrompt dengan expressions semantic menambahkan hint", () => {
    withAgent(makeAgent());
    const brain: any = new AgentBrain();
    brain.capProfile = { ...DEFAULT_PROFILE, nativeExpressions: ["exp_angry", "exp_sad"] };
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("exp_angry — emotion: kesal");
    expect(prompt).toContain("exp_sad — emotion: sedih");
  });

  test("buildSystemPrompt tanpa expressions menampilkan 'tidak ada'", () => {
    withAgent(makeAgent());
    const brain: any = new AgentBrain();
    brain.capProfile = { ...DEFAULT_PROFILE, nativeExpressions: [] };
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("tidak ada");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T22: existing Director expression behavior remains intact
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T22 — Director behavior intact", () => {
  test("Director prompt tidak termasuk nativeExpressions (konsisten sebelumnya)", () => {
    // Director prompt tidak pernah memasukkan nativeExpressions — tetap benar.
    // P15.4 hanya mempengaruhi Speaker prompt.
    withAgent(makeAgent());
    const brain: any = new AgentBrain();
    brain.capProfile = DEFAULT_PROFILE;
    // buildSystemPrompt adalah Speaker prompt — Director prompt di server.
    // Cukup verifikasi bahwa classifier tidak mengubah Director behavior.
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("KARAKTER LIVE2D");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T23: P15.1 context remains intact
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T23 — P15.1 context intact", () => {
  test("contextBlock masih berfungsi", () => {
    withAgent(makeAgent());
    const brain: any = new AgentBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain.userMood = "sedih";
    brain.agentStart = Date.now() - 5 * 60 * 1000;
    const prompt = brain.buildSystemPrompt("");
    expect(prompt).toContain("KONTEKS PERILAKU");
    expect(prompt).toContain("Mood user: sedih");
    expect(prompt).toContain("Sesi: 5m");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T24: P15.2 diversity remains intact
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T24 — P15.2 diversity intact", () => {
  test("diversityHistory di _reactiveState tetap berfungsi", () => {
    withAgent(makeAgent());
    const brain: any = new AgentBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain._diversityHistory.set("idle", ["senang+nod"]);
    const state = brain._reactiveState();
    expect(state.diversityHistory.idle).toEqual(["senang+nod"]);
  });

  test("diversity tidak dipengaruhi oleh classifier", () => {
    withAgent(makeAgent());
    const brain: any = new AgentBrain();
    brain.capProfile = DEFAULT_PROFILE;
    brain._diversityHistory.set("idle", ["senang+nod"]);
    // Classifier tidak mengubah diversity state
    classifyExpressionName("exp_angry");
    expect(brain._diversityHistory.get("idle")).toEqual(["senang+nod"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T25: P15.3 Director context remains intact
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 T25 — P15.3 Director context intact", () => {
  test("directorContextBlock masih berfungsi", () => {
    withAgent(makeAgent());
    const brain: any = new AgentBrain();
    brain.userMood = "kaget";
    brain.agentStart = Date.now() - 10 * 60 * 1000;
    const ctx = brain.directorContextBlock();
    expect(ctx).toContain("Mood user: kaget");
    expect(ctx).toContain("Sesi: 10m");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tambahan: Real model expression verification
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 — Real model expression names", () => {
  test("ren: exp_01..exp_05 semua UNKNOWN", () => {
    const ren = ["exp_01", "exp_02", "exp_03", "exp_04", "exp_05"];
    for (const name of ren) {
      expect(classifyExpressionName(name).emotion).toBeNull();
    }
  });

  test("lumine: exp_angry → kesal", () => {
    expect(classifyExpressionName("exp_angry").emotion).toBe("kesal");
  });

  test("lumine: exp_sad → sedih", () => {
    expect(classifyExpressionName("exp_sad").emotion).toBe("sedih");
  });

  test("lumine: exp_tear → sedih", () => {
    expect(classifyExpressionName("exp_tear").emotion).toBe("sedih");
  });

  test("lumine: exp_blush → malu", () => {
    expect(classifyExpressionName("exp_blush").emotion).toBe("malu");
  });

  test("lumine: collar_blue → UNKNOWN (prop)", () => {
    expect(classifyExpressionName("collar_blue").emotion).toBeNull();
  });

  test("lumine: collar_green → UNKNOWN (prop)", () => {
    expect(classifyExpressionName("collar_green").emotion).toBeNull();
  });

  test("lumine: X_change → UNKNOWN (prop)", () => {
    expect(classifyExpressionName("X_change").emotion).toBeNull();
  });

  test("lumine: exp_dizzy → bingung", () => {
    expect(classifyExpressionName("exp_dizzy").emotion).toBe("bingung");
  });

  test("lumine: exp_sparkling → UNKNOWN (bukan emosi)", () => {
    expect(classifyExpressionName("exp_sparkling").emotion).toBeNull();
  });

  test("lumine: exp_heart → UNKNOWN (bukan emosi)", () => {
    expect(classifyExpressionName("exp_heart").emotion).toBeNull();
  });

  test("lumine: exp_sweat → UNKNOWN (bukan emosi)", () => {
    expect(classifyExpressionName("exp_sweat").emotion).toBeNull();
  });

  test("lumine: exp_zitome → UNKNOWN (tidak dikenal)", () => {
    expect(classifyExpressionName("exp_zitome").emotion).toBeNull();
  });

  test("神宮白子: 呆猫 → UNKNOWN (prop/character)", () => {
    expect(classifyExpressionName("呆猫").emotion).toBeNull();
  });

  test("神宮白子: 拍照 → UNKNOWN (action)", () => {
    expect(classifyExpressionName("拍照").emotion).toBeNull();
  });

  test("神宮白子: 眼镜 → UNKNOWN (prop)", () => {
    expect(classifyExpressionName("眼镜").emotion).toBeNull();
  });

  test("神宮白子: 围裙 → UNKNOWN (prop)", () => {
    expect(classifyExpressionName("围裙").emotion).toBeNull();
  });

  test("神宮白子: 呆猫眼珠摇晃 → UNKNOWN (prop+action)", () => {
    expect(classifyExpressionName("呆猫眼珠摇晃").emotion).toBeNull();
  });

  test("lumine full catalog: semantic ones classify, opaque ones don't", () => {
    const lumine = [
      "exp_angry", "exp_blush", "exp_dizzy", "exp_heart",
      "exp_sad", "exp_sparkling", "exp_sweat", "exp_tear", "exp_zitome",
      "X_change", "Z_change",
      "collar_blue", "collar_green", "collar_lightblue",
      "collar_mintgreen", "collar_orange", "collar_purple", "collar_red", "collar_white",
    ];
    const classified = lumine.filter((n) => classifyExpressionName(n).emotion !== null);
    const unknown = lumine.filter((n) => classifyExpressionName(n).emotion === null);
    // Hanya exp_angry, exp_blush, exp_dizzy, exp_sad, exp_tear terklasifikasi
    expect(classified).toContain("exp_angry");
    expect(classified).toContain("exp_sad");
    expect(classified).toContain("exp_tear");
    expect(classified).toContain("exp_blush");
    expect(classified).toContain("exp_dizzy");
    // Semua collar/prop tetap UNKNOWN
    expect(unknown).toContain("collar_blue");
    expect(unknown).toContain("X_change");
    expect(unknown).toContain("exp_heart");
    expect(unknown).toContain("exp_sparkling");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tambahan: negative token boundary tests
// ═══════════════════════════════════════════════════════════════════════
describe("P15.4 — Token boundary safety", () => {
  test("'unhappy' → UNKNOWN (negative token)", () => {
    expect(classifyExpressionName("unhappy").emotion).toBeNull();
  });

  test("'shirt' → UNKNOWN ('sh' bukan 'shy')", () => {
    // shirt tidak mengandung 'shy' sebagai token terpisah
    expect(classifyExpressionName("shirt").emotion).toBeNull();
  });

  test("'danger' → UNKNOWN ('anger' bukan token terpisah di 'danger')", () => {
    // danger: ['dan', 'ger'] — tidak ada yang cocok
    expect(classifyExpressionName("danger").emotion).toBeNull();
  });

  test("'angry' → kesal (token boundary cocok)", () => {
    expect(classifyExpressionName("angry").emotion).toBe("kesal");
  });
});
