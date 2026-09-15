/**
 * capability-resync.test.ts — Phase 17: Capability Re-sync Integrity.
 *
 * Menguji perilaku NYATA dari kode app.js asli (ekstraksi sumber + vm —
 * pola guard arbiter-stage3), bukan string-match:
 *
 *   S1  live handle = sumber kebenaran grup native — sheet scan-cache basi
 *       dengan motionGroups: [] TIDAK BISA menghapus grup yang dilaporkan
 *       handle hidup; caps tetap fallback saat handle tidak ada.
 *   S2  satu seam resyncCapabilities(): taxonomy → registry → invalidate
 *       brain; wiring hanya ke jalur pengubah kapabilitas (rescan,
 *       klasifikasi AI, reload sheet) — dijaga guard sumber.
 *   S3  resync/taxonomy overlap: hasil generasi lebih tua yang selesai
 *       belakangan tidak boleh menimpa yang lebih baru.
 *   S5  brain converged: setelah invalidasi ala seam, think() berikutnya
 *       membangun ulang CapabilityProfile dari sumber terkini.
 *   Model switch ren→lumine→ren: native lama tidak bocor; clear dulu, baru
 *       register; entri non-native selamat.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { MotionRegistry } from "../src/client/animation/motion-registry";
import * as MotionTaxonomy from "../src/client/engine/motion-taxonomy";
import { AgentBrain } from "../src/client/agent/brain";

const repoRoot = resolve(import.meta.dir, "..");
const appSrc = readFileSync(join(repoRoot, "static", "js", "app.js"), "utf8");

/** Ekstrak fungsi (termasuk async) dari app.js via brace matching. */
function extractFn(src: string, name: string): string {
  const m = src.match(new RegExp("\\b(async\\s+)?function\\s+" + name + "\\s*\\("));
  if (!m || m.index === undefined) throw new Error("fungsi " + name + " tidak ada di app.js");
  let i = src.indexOf("{", m.index + m[0].length - 1);
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (!depth) break;
    }
  }
  const isAsync = !!m[1];
  const fnStart = src.indexOf("function", m.index);
  return (isAsync ? "async " : "") + src.slice(fnStart, i + 1);
}

interface SandboxOpts {
  state: Record<string, any>;
  fetchImpl?: (url: string, init?: any) => Promise<any>;
}

function makeSandbox(opts: SandboxOpts) {
  const registry = new MotionRegistry();
  const rec = { invalidateCalls: 0, fetchUrls: [] as string[] };
  const sandbox: any = {
    state: opts.state,
    haveMotionSystem: true,
    motionRegistry: registry,
    MotionTaxonomy,
    API: "http://sandbox.test",
    characterSheetKey: () => "live2d_sheet_test",
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    performance: { now: () => Date.now() },
    window: {
      __agent: {
        invalidateCapabilityProfile: () => { rec.invalidateCalls++; },
      },
    },
    fetch: async (url: string, init?: any) => {
      rec.fetchUrls.push(String(url));
      if (opts.fetchImpl) return opts.fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => ({ motions: [] }) };
    },
  };
  const code = [
    "let _taxonomyGen = 0;",
    "let _resyncGen = 0;",
    extractFn(appSrc, "initMotionRegistry"),
    extractFn(appSrc, "loadMotionTaxonomy"),
    extractFn(appSrc, "buildTaxonomyFromNames"),
    extractFn(appSrc, "resyncCapabilities"),
  ].join("\n\n");
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, registry, rec };
}

const nativeIds = (reg: MotionRegistry) =>
  reg.list().filter((a: any) => a.source === "native").map((a: any) => a.id).sort();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════
// S1 — live handle sebagai sumber kebenaran; stale sheet tidak bisa menclobber
// ═══════════════════════════════════════════════════════════════════════
describe("P17 S1 — initMotionRegistry: live handle menang atas scan-cache basi", () => {
  test("sheet basi motionGroups:[] TIDAK menghapus grup dari handle hidup", async () => {
    const { sandbox, registry } = makeSandbox({
      state: {
        model: {}, modelPath: "model/ren/runtime/ren.model3.json",
        motionTaxonomy: null,
        caps: { motionGroups: [] }, // hasil hidrasi sheet scan-cache LAMA
        handle: { motionGroups: () => ["Idle", "TapBody"] }, // sumber hidup
      },
    });
    await sandbox.initMotionRegistry();
    expect(nativeIds(registry)).toEqual(["motion_Idle", "motion_TapBody"]);
  });

  test("caps basi kalah prioritas: handle non-empty menang walau caps berisi nama hantu", async () => {
    const { sandbox, registry } = makeSandbox({
      state: {
        model: {}, modelPath: "model/ren/runtime/ren.model3.json",
        motionTaxonomy: null,
        caps: { motionGroups: ["GhostOld"] },
        handle: { motionGroups: () => ["Idle"] },
      },
    });
    await sandbox.initMotionRegistry();
    expect(nativeIds(registry)).toEqual(["motion_Idle"]);
    expect(registry.has("motion_GhostOld")).toBe(false);
  });

  test("tanpa handle (jalur non-produksi) → caps tetap dipakai sebagai fallback", async () => {
    const { sandbox, registry } = makeSandbox({
      state: {
        model: {}, modelPath: "model/ren/runtime/ren.model3.json",
        motionTaxonomy: null,
        caps: { motionGroups: ["Idle"] },
        handle: null,
      },
    });
    await sandbox.initMotionRegistry();
    expect(nativeIds(registry)).toEqual(["motion_Idle"]);
  });

  test("handle yang melempar (mis. pasca-destroy) → fallback aman ke caps, tanpa crash", async () => {
    const { sandbox, registry } = makeSandbox({
      state: {
        model: {}, modelPath: "model/ren/runtime/ren.model3.json",
        motionTaxonomy: null,
        caps: { motionGroups: ["Idle"] },
        handle: { motionGroups: () => { throw new Error("destroyed"); } },
      },
    });
    await sandbox.initMotionRegistry();
    expect(nativeIds(registry)).toEqual(["motion_Idle"]);
  });

  test("klasifikasi taksonomi + emotionCompatibility tetap terpelihara (regresi Phase 14)", async () => {
    const { sandbox, registry } = makeSandbox({
      state: {
        model: {}, modelPath: "model/ren/runtime/ren.model3.json",
        caps: { motionGroups: [] },
        handle: { motionGroups: () => ["Idle"] },
        motionTaxonomy: {
          byVerb: { wave: ["Idle"] },
          clipMeta: { Idle: { name: "Idle", group: "Idle", verb: "wave", duration: 1.7 } },
          stats: {},
        },
      },
    });
    await sandbox.initMotionRegistry();
    const entry: any = registry.get("motion_Idle");
    expect(entry).toBeTruthy();
    expect(entry.duration).toBe(1.7);
    expect(entry.tags).toContain("wave");
    // verb "wave" ∈ EMOTION_VERBS.senang → emotionCompatibility terisi 0.7
    expect(entry.emotionCompatibility.senang).toBe(0.7);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Model switch: clear → register, tanpa bocor, non-native selamat
// ═══════════════════════════════════════════════════════════════════════
describe("P17 — model switch ren→lumine→ren: registry converged, tanpa kebocoran native", () => {
  test("native model B hilang saat kembali ke A; entri non-native selamat (server = sumber user motion)", async () => {
    const state: Record<string, any> = {
      model: {}, modelPath: "model/ren/runtime/ren.model3.json",
      motionTaxonomy: null,
      caps: { motionGroups: [] },
      handle: { motionGroups: () => ["Idle", "TapBody"] }, // ren
    };
    // Server user-motion = sumber kebenaran entri source:"user" (perilaku
    // lama replaceUserMotions). Harness menyediakan daftar server yang stabil
    // supaya "my_custom" selamat lintas siklus switch.
    const USER_SERVER_LIST = [
      { version: 1, id: "my_custom", name: "my_custom", type: "dsl", tags: [], duration: 1, tracks: [] },
    ];
    const { sandbox, registry } = makeSandbox({
      state,
      fetchImpl: async (url: string) => {
        if (String(url).includes("/api/motions")) {
          return { ok: true, json: async () => ({ motions: USER_SERVER_LIST }) };
        }
        return { ok: true, json: async () => ({}) };
      },
    });
    await sandbox.initMotionRegistry();
    expect(nativeIds(registry)).toEqual(["motion_Idle", "motion_TapBody"]);

    // switch ke lumine
    state.handle = { motionGroups: () => ["Bow"] };
    await sandbox.initMotionRegistry();
    expect(nativeIds(registry)).toEqual(["motion_Bow"]);
    expect(registry.has("motion_Idle")).toBe(false); // TIDAK bocor ke model baru

    // kembali ke ren
    state.handle = { motionGroups: () => ["Idle", "TapBody"] };
    await sandbox.initMotionRegistry();
    expect(nativeIds(registry)).toEqual(["motion_Idle", "motion_TapBody"]);
    expect(registry.has("motion_Bow")).toBe(false);
    expect(registry.has("my_custom")).toBe(true); // non-native utuh
  });
});

// ═══════════════════════════════════════════════════════════════════════
// S3 — taksonomi/resync overlap: generasi terakhir menang
// ═══════════════════════════════════════════════════════════════════════
describe("P17 S3 — load/resync yang tumpang tindih tidak bisa menimpa hasil lebih baru", () => {
  test("loadMotionTaxonomy A lambat + B cepat → state akhir = hasil B", async () => {
    let call = 0;
    const state: Record<string, any> = {
      model: {}, modelPath: "model/ren/runtime/ren.model3.json",
      motionTaxonomy: null,
      caps: { motionGroups: ["Idle"] },
      handle: { motionGroups: () => ["Idle"] },
    };
    const { sandbox } = makeSandbox({
      state,
      fetchImpl: async () => {
        call++;
        const mine = call;
        await sleep(mine === 1 ? 40 : 5); // A lambat, B cepat
        return {
          ok: true,
          json: async () => ({
            byVerb: { wave: ["Idle"] },
            clips: [{ name: "Idle", group: "Idle", verb: "wave", duration: 2 }],
            clipCount: 1,
            stats: { marker: "load-" + mine },
          }),
        };
      },
    });
    const pA = sandbox.loadMotionTaxonomy();
    const pB = sandbox.loadMotionTaxonomy();
    await Promise.all([pA, pB]);
    // B (marker load-2) selesai duluan; A selesai belakangan TAPI generasi
    // sudah naik → tulisannya dibuang. Hasil akhir harus milik B.
    expect(state.motionTaxonomy.stats.marker).toBe("load-2");
  });

  test("resync A lambat + resync B cepat → B yang converge; A dibatalkan diam-diam", async () => {
    let call = 0;
    const state: Record<string, any> = {
      model: {}, modelPath: "model/ren/runtime/ren.model3.json",
      motionTaxonomy: null,
      caps: { motionGroups: [] },
      handle: { motionGroups: () => ["Idle"] },
    };
    const { sandbox, registry, rec } = makeSandbox({
      state,
      fetchImpl: async (url: string) => {
        if (String(url).includes("/api/motions")) {
          return { ok: true, json: async () => ({ motions: [] }) };
        }
        call++;
        const mine = call;
        await sleep(mine === 1 ? 40 : 5);
        return {
          ok: true,
          json: async () => ({
            byVerb: { wave: ["Idle"] },
            clips: [{ name: "Idle", group: "Idle", verb: "wave", duration: 2 }],
            clipCount: 1,
            stats: { marker: "load-" + mine },
          }),
        };
      },
    });
    const pA = sandbox.resyncCapabilities("A");
    const pB = sandbox.resyncCapabilities("B");
    await Promise.all([pA, pB]);
    // rantai B menyelesaikan registry init + invalidate; rantai A dibatalkan
    // oleh _resyncGen sebelum sempat menyentuh registry/brain setelah await.
    expect(state.motionTaxonomy.stats.marker).toBe("load-2");
    expect(nativeIds(registry)).toEqual(["motion_Idle"]);
    expect(rec.invalidateCalls).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// S5 — brain converged: profil baru dibangun ulang setelah invalidasi ala seam
// ═══════════════════════════════════════════════════════════════════════
describe("P17 S5 — AgentBrain observe katalog native terbaru pasca resync", () => {
  const origWindow = (globalThis as any).window;
  const origDocument = (globalThis as any).document;
  const origFetch = (globalThis as any).fetch;

  test("invalidate (efek seam) → think() berikutnya memakai catalog model kini", async () => {
    let catalogVersion = 1;
    const profile = () => ({
      emotions: ["senang", "sedih", "normal"],
      nativeExpressions: ["exp_angry"],
      accessories: [],
      properties: [],
      gestures: ["nod"],
      motionCatalog:
        catalogVersion === 1
          ? [{ id: "motion_OldGroup", verb: "wave", compatibleEmotions: ["senang"], source: "native", duration: 2, tags: [], description: "" }]
          : [{ id: "motion_NewGroup", verb: "nod", compatibleEmotions: ["senang"], source: "native", duration: 2, tags: [], description: "" }],
      sheet: { config: { displayName: "X" } },
      userNote: "",
      roleIds: {},
      paramRange: {},
      modelName: "test-model",
      controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
    });
    const spoken: string[] = [];
    (globalThis as any).window = {
      __live2dAgent: {
        isReady: () => true,
        getCapabilityProfile: async () => profile(),
        getExpressibleEmotions: () => ({}),
        setExpression: () => {},
        setAIPose: () => {},
        playMotion: () => true,
        playGesture: () => {},
        speak: (t: string) => { spoken.push(t); },
        lockAI: () => {},
        unlockAI: () => {},
        setGazeIntent: () => {},
      },
      __addChat: () => {},
    };
    (globalThis as any).document = { getElementById: () => null };
    const prompts: string[] = [];
    (globalThis as any).fetch = async (url: string, init?: any) => {
      prompts.push(JSON.parse(init.body).system);
      return { ok: true, json: async () => ({ reply: "[EMOTION:senang][GESTURE:nod] halo. [EMOTION:senang][GESTURE:nod] lagi." }) };
    };
    try {
      const brain: any = new AgentBrain();
      await brain.think("satu"); // lazy loadProfile → catalog v1
      expect(prompts[0]).toContain("motion_OldGroup");
      expect(prompts[0]).not.toContain("motion_NewGroup");

      // efek seam resync: invalidasi + sumber (registry/handle) sudah berganti
      catalogVersion = 2;
      brain.invalidateCapabilityProfile();
      await brain.think("dua");
      expect(prompts[1]).toContain("motion_NewGroup");
      expect(prompts[1]).not.toContain("motion_OldGroup");
      // dan tetap bebas raw parameter id
      expect(prompts[1]).not.toContain("ParamAngle");
    } finally {
      (globalThis as any).window = origWindow;
      (globalThis as any).document = origDocument;
      (globalThis as any).fetch = origFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// S2/S6/S7 — guard wiring (jalur handler UI tidak bisa dijalankan di vm;
// seam-nya sendiri sudah diuji perilaku di atas)
// ═══════════════════════════════════════════════════════════════════════
describe("P17 S2/S6/S7 — wiring & teardown guards", () => {
  test("hanya jalur pengubah kapabilitas yang men-sinkronkan seam (rescan, classify, reload)", () => {
    expect(appSrc).toMatch(/inspectBtn[\s\S]{0,900}resyncCapabilities\("rescan"\)/);
    expect(appSrc).toMatch(/AI classified[\s\S]{0,700}resyncCapabilities\("ai-classify"\)/);
    expect(appSrc).toMatch(/reloadFile[\s\S]{0,1200}resyncCapabilities\("sheet-reload"\)/);
    // persistSheet (preset/catatan) TIDAK ikut men-sinkronkan taxonomy —
    // metadata brain-only; invalidate existing tetap ada.
    const persistRegion = appSrc.slice(
      appSrc.indexOf("async function persistSheet"),
      appSrc.indexOf("async function persistSheet") + 1400,
    );
    expect(persistRegion).toContain("invalidateCapabilityProfile");
    expect(persistRegion).not.toContain("resyncCapabilities");
  });

  test("S7: teardown model-load me-reset state.modelExpressions", () => {
    const loadRegion = appSrc.slice(
      appSrc.indexOf("async function loadModel"),
      appSrc.indexOf("async function loadModel") + 4000,
    );
    expect(loadRegion).toMatch(/state\.supportedEmotions = \{\};\s*\n\s*\/\/ PHASE 17 S7[\s\S]{0,200}state\.modelExpressions = \[\];/);
  });

  test("S6: jalur re-scan tetap memakai SATU mekanisme persistensi server (/api/sheet)", () => {
    const inspectRegion = appSrc.slice(
      appSrc.indexOf("function inspectModel"),
      appSrc.indexOf("function inspectModel") + 9000,
    );
    expect(inspectRegion).toMatch(/fetch\(API \+ "\/api\/sheet"[\s\S]{0,120}method: "POST"/);
    // tidak ada endpoint persistensi kapabilitas kedua yang baru
    expect(inspectRegion).not.toMatch(/\/api\/(sheet-v2|capability|capabilities)/);
  });
});
