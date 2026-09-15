/**
 * loadgen-guard.test.ts — Targeted correctness fix: loadModel generation guard.
 *
 * BUG yang dikunci (audit perilaku pasca-roadmap, bukti runtime):
 *   loadModel() re-entrant — load lama yang selesai belakangan bisa
 *   menimpa/meng-destroy hasil load yang lebih baru (last-request-lost),
 *   termasuk boot auto-load vs klik user.
 *
 * FIX: token generasi di setiap titik await; kontinuaasi basi = no-op
 * (tidak sentuh path/model/handle/roleLink/arbiter/caps/UI/teardown),
 * handle yatim dibersihkan identity-safe, error basi tidak ke UI.
 *
 * Test mengekstrak fungsi ASLI dari app.js via vm (pola r5-motion/
 * capability-resync) dengan deferred promise — urutan penyelesaian
 * dikontrol penuh, bukan sleep.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const repoRoot = resolve(import.meta.dir, "..");
const appSrc = readFileSync(join(repoRoot, "static", "js", "app.js"), "utf8");

function extractFn(src: string, name: string): string {
  const m = src.match(new RegExp("\\b(async\\s+)?function\\s+" + name + "\\s*\\("));
  if (!m || m.index === undefined) throw new Error(name + " tidak ada di app.js");
  let i = src.indexOf("{", m.index + m[0].length - 1);
  let depth = 0, inStr: string | null = null, esc = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (!depth) break; }
  }
  const fnStart = src.indexOf("function", m.index);
  return (m[1] ? "async " : "") + src.slice(fnStart, i + 1);
}

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

interface Harness {
  sandbox: any;
  state: any;
  events: string[];
  settings: Map<string, { res: (v: any) => void; rej: (e: any) => void }>;
  adapter: Map<string, { res: (h: any) => void; rej: (e: any) => void }>;
  handles: Map<string, any>;
  removed: any[];
  loaderText: () => string;
  settleSettings: (name: string) => Promise<void>;
  settleAdapter: (name: string) => Promise<any>;
  failSettings: (name: string, msg: string) => Promise<void>;
  loadModel: (p?: any) => Promise<boolean>;
  loadUserModel: (n: string) => Promise<void>;
}

function makeHarness(): Harness {
  const events: string[] = [];
  const settings = new Map<string, { res: any; rej: any }>();
  const adapter = new Map<string, { res: any; rej: any }>();
  const handles = new Map<string, any>();
  const removed: any[] = [];
  const loaderP = { textContent: "" };
  const fakeEl = { classList: { add: () => {}, remove: () => {}, toggle: () => {} }, textContent: "" };
  const state: any = { modelPath: null, model: null, handle: null, host: null, idleMotionTimer: null, caps: {} };
  const host = {
    added: [] as any[],
    add(h: any) { this.added.push(h); },
    remove(h: any) { const i = this.added.indexOf(h); if (i >= 0) this.added.splice(i, 1); removed.push(h); },
    resize() {},
  };
  const makeHandle = (name: string) => {
    const h = {
      __name: name, destroyed: false,
      destroy() { this.destroyed = true; events.push(`destroy:${name}`); },
      setAnchor() {}, add() {},
      getParameters: () => [], getName: () => name, getMocVersion: () => 6,
      uses53Pipeline: () => true, onBeforeModelUpdate() {},
      motionGroups: () => ["Group_" + name],
    };
    handles.set(name, h);
    return h;
  };
  const sandbox: any = {
    state, console: { log: () => {}, warn: () => {}, error: () => {} },
    Math, JSON, String, Object, Array, Date, Promise, Error, RegExp,
    setTimeout: (fn: any) => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    $: (sel: string) => (sel === "#loader p" ? loaderP : fakeEl),
    __t: (k: string, v?: any) => `${k}:${(v && v.msg) || ""}`,
    alert: (m: string) => events.push("alert:" + m),
    stageCanvas: { style: {} }, stageSize: () => ({ w: 200, h: 200 }),
    resolveAnyModelPath: () => new Promise<any>((res) => { sandbox.__resolveBoot = res; }),
    buildModelSettings: (path: string) =>
      new Promise((res, rej) => { settings.set(String(path), { res: (v: any) => res(v ?? { __from: path }), rej }); }),
    hideNoModelState: () => events.push("hideEmpty"),
    showNoModelState: () => events.push("showEmpty"),
    showLoader: () => events.push("showLoader"),
    hideLoader: () => events.push("hideLoader"),
    resolveModel3: async (name: string) => "model/" + name,
    assertCubism4: async () => true,
    refreshModels: () => events.push("refreshModels"),
    createCompatModel: (h: any) => ({ __h: h }),
    frameModel: () => {}, applyModelConfig: () => {}, loadModelConfigLocal: () => ({}),
    applyCharacterIdentity: () => {}, rememberModel: () => {}, visfxLoad: () => ({}),
    wireInteractions: () => {}, startIdle: () => {}, prefetchOverlayGate: () => {}, prefetchCdiInfo: () => {},
    startIdleMotion: () => {}, refreshSheetUI: () => {}, refreshConfigForm: () => {},
    refreshRoleEmotions: () => events.push("roles"),
    refreshUserNoteUI: async () => {}, fetchSheetFile: async () => null,
    syncGuardChannelsToArbiter: () => {},
    detectModelCapabilities: () => events.push("detect:" + (state.handle && state.handle.__name)),
    initMotionRegistry: () => { events.push("registry:" + (state.handle && state.handle.__name)); return Promise.resolve(); },
    loadMotionTaxonomy: () => { events.push("taxonomy"); return Promise.resolve(null); },
    __bootPromise: Promise.resolve(),
    window: {
      devicePixelRatio: 1,
      __compositor8Ready: Promise.resolve(),
      __agent: { invalidateCapabilityProfile: () => events.push("brainInvalidate") },
      __engineRoleLink: { attachHandle: () => ({ bridge: {}, writeActual: () => false }) },
      __l2dArbiter: { createArbiter: () => ({ commit() {}, }) },
      L2DSceneLayers: { createStageLayers: () => ({}) },
      __refreshModels: () => {},
      __live2dApi: {
        createHost: () => host,
        loadModel: (_h: any, src: any) =>
          new Promise((res, rej) => {
            const p = src.kind === "settings" ? src.settings.__from : src.path;
            adapter.set(String(p), { res: (handle: any) => res(handle), rej });
          }),
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      "var _loadGen = 0;",
      extractFn(appSrc, "loadModel"),
      extractFn(appSrc, "loadUserModel"),
    ].join("\n\n"),
    sandbox,
  );
  // Tunggu sampai deferred terdaftar (chain wrapper menambah microtask hop;
  // bukan sleep — flush deterministic; timeout tetap fail kalau token hilang).
  const waitFor = async (map: Map<string, any>, name: string) => {
    for (let i = 0; i < 40; i++) {
      const d = map.get("model/" + name) || map.get(name);
      if (d) return d;
      await Promise.resolve();
      await Promise.resolve();
    }
    throw new Error("deferred tidak terdaftar: " + name);
  };
  const settleSettings = async (name: string) => {
    const d = await waitFor(settings, name);
    d.res({ __from: "model/" + name });
    await tick();
  };
  const failSettings = async (name: string, msg: string) => {
    const d = await waitFor(settings, name);
    d.rej(new Error(msg));
    await tick();
  };
  const settleAdapter = async (name: string) => {
    const d = await waitFor(adapter, name);
    const h = makeHandle(name);
    d.res(h);
    await tick();
    return h;
  };
  return {
    sandbox, state, events, settings, adapter, handles, removed,
    loaderText: () => loaderP.textContent,
    settleSettings, settleAdapter, failSettings,
    loadModel: (p?: any) => sandbox.loadModel(p),
    loadUserModel: (n: string) => sandbox.loadUserModel(n),
  };
}

// ═══════════════════════════════════════════════════════════════════════
describe("loadModel generation guard — last request owns final state", () => {
  test("T1+T5+T6: A mulai lalu B; B selesai dulu; A selesai belakangan → B tetap, A no-op total", async () => {
    const H = makeHarness();
    const pA = H.loadModel("model/A");
    await tick(2);
    const pB = H.loadModel("model/B");
    await tick(2);
    // B penuh dulu
    await H.settleSettings("B");
    const hb = await H.settleAdapter("B");
    expect(await pB).toBe(true);
    expect(H.state.handle).toBe(hb);
    expect(H.state.modelPath).toBe("model/B");
    // A baru lewat tahap settings SEKARANG — harus basi sebelum adapter
    await H.settleSettings("A");
    expect(await pA).toBe(false);
    expect(H.adapter.has("model/A")).toBe(false); // A tak pernah sentuh adapter
    expect(H.state.handle).toBe(hb);
    expect(hb.destroyed).toBe(false);             // T4-proof: B tidak di-destroy
    expect(H.state.modelPath).toBe("model/B");
    // T5/T6: capabilities & registry HANYA dari B
    expect(H.events.filter((e) => e === "detect:B").length).toBe(1);
    expect(H.events.filter((e) => e.startsWith("detect:")).join()).toBe("detect:B");
    expect(H.events.filter((e) => e.startsWith("registry:")).join()).toBe("registry:B");
  });

  test("T2: boot-load A (resolveAnyModelPath) vs user B — A basi tidak men-destroy B", async () => {
    const H = makeHarness();
    const pA = H.loadModel();          // boot: await resolveAnyModelPath
    await tick(2);
    const pB = H.loadModel("model/B"); // user klik
    await H.settleSettings("B");
    const hb = await H.settleAdapter("B");
    expect(await pB).toBe(true);
    // boot resolve BELAKANGAN: tidak boleh set path, destroy, atau invalidate UI
    H.sandbox.__resolveBoot("model/A");
    expect(await pA).toBe(false);
    await tick();
    expect(H.state.handle).toBe(hb);
    expect(H.state.modelPath).toBe("model/B");
    expect(hb.destroyed).toBe(false);
    expect(H.sandbox.$).toBeTruthy();
    expect(H.events.filter((e) => e.startsWith("detect:")).join()).toBe("detect:B");
  });

  test("T3: load basi yang REJECT — tanpa pesan error ke UI, B tetap aktif", async () => {
    const H = makeHarness();
    const pA = H.loadModel("model/A");
    await tick(2);
    const pB = H.loadModel("model/B");
    await H.settleSettings("B");
    const hb = await H.settleAdapter("B");
    await pB;
    await H.failSettings("A", "A mati");
    expect(await pA).toBe(false);
    // loader p TIDAK ditulis untuk error basi — dan B tetap aktif utuh:
    expect(H.loaderText()).toBe("");
    expect(H.state.handle).toBe(hb);
    expect(H.events.filter((e) => e.startsWith("showEmpty")).length).toBe(0);
  });

  test("T4+G5: A lolos sampai ADAPTER lalu C jadi current → A hanya bersihkan handle milik sendiri", async () => {
    const H = makeHarness();
    const pA = H.loadModel("model/A");
    await H.settleSettings("A"); // A sekarang menggantung di await adapter
    const pC = H.loadModel("model/C");
    await H.settleSettings("C");
    const hc = await H.settleAdapter("C");
    expect(await pC).toBe(true);
    // handle A selesai belakangan → stale
    const ha = await H.settleAdapter("A");
    expect(await pA).toBe(false);
    expect(H.state.handle).toBe(hc);
    expect(hc.destroyed).toBe(false);   // B/C tak tersentuh
    expect(ha.destroyed).toBe(true);    // handle yatim A dibersihkan sendiri
    expect(H.removed).toContain(ha);   // identity-safe remove
    expect(H.removed).not.toContain(hc);
  });

  test("T7: ren → lumine → ren SEQUENTIAL normal: semua menang, teardown sebelumnya, tak ada bail", async () => {
    const H = makeHarness();
    for (const seq of ["ren", "lumine", "ren2"]) {
      const p = H.loadModel("model/" + seq);
      await tick(2);
      await H.settleSettings(seq);
      await H.settleAdapter(seq);
      expect(await p).toBe(true);
      expect(H.state.handle.__name).toBe(seq);
      expect(H.state.modelPath).toBe("model/" + seq);
    }
    // tiap load berikutnya men-destroy handle sebelumnya (teardown normal)
    expect(H.events.filter((e) => e.startsWith("destroy:")).join()).toBe("destroy:ren,destroy:lumine");
    expect(H.events.filter((e) => e.startsWith("detect:")).join()).toBe("detect:ren,detect:lumine,detect:ren2");
    expect(H.events.filter((e) => e.startsWith("registry:")).join()).toBe("registry:ren,registry:lumine,registry:ren2");
  });

  test("T8: A→B→C rapid, urutan resolve C→A→B — C menang mutlak", async () => {
    const H = makeHarness();
    const pA = H.loadModel("model/A"); await tick(2);
    const pB = H.loadModel("model/B"); await tick(2);
    const pC = H.loadModel("model/C"); await tick(2);
    await H.settleSettings("C");
    const hc = await H.settleAdapter("C");
    expect(await pC).toBe(true);
    await H.settleSettings("A");
    await H.settleSettings("B");
    expect(await pA).toBe(false);
    expect(await pB).toBe(false);
    expect(H.state.handle).toBe(hc);
    expect(H.events.filter((e) => e.startsWith("detect:")).join()).toBe("detect:C");
    expect(H.removed.length).toBe(0); // A/B bail sebelum adapter — tak ada handle yatim
  });

  test("T9: loadUserModel — load yang jadi basi tidak hideLoader (pemenang yang pegang UI)", async () => {
    const H = makeHarness();
    const pA = H.loadUserModel("A"); await tick(4);
    const pB = H.loadUserModel("B"); await tick(4);
    // B penuh
    await H.settleSettings("B");
    await H.settleAdapter("B");
    await pB;
    expect(H.events.filter((e) => e === "hideLoader").length).toBe(1);
    // A selesai belakangan → basi → tidak hideLoader lagi, tidak refreshModels kedua
    await H.settleSettings("A");
    await pA;
    expect(H.events.filter((e) => e === "hideLoader").length).toBe(1);
    expect(H.events.filter((e) => e === "refreshModels").length).toBe(1);
  });
});
