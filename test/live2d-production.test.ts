/**
 * live2d-production.test.ts — STAGE R2: unit test adapter produksi
 * Live2DModelHandle dengan pipeline NYATA (bukan mock):
 *
 *   Cubism Core 6.0.1 (live2dcubismcore.min.js, WASM, dimuat via vm)
 *   + Cubism Framework 5.3 (src/live2d/cubismframework/, import dinamis)
 *   + model asli dari data/model (ren = moc v6, lumine = moc era lama)
 *
 * Yang TIDAK bisa di Bun: WebGL → pengujian render dilakukan smoke halaman
 * (static/handle-smoke.html), bukan di sini. Semua test lain (load nyata,
 * parameter backing nyata, motion nyata, ekspresi nyata, efek nyata,
 * lifecycle) memakai core+framework asli.
 *
 * Model data/ adalah data user lokal — test SKIP bila foldernya tidak ada
 * (bukan gagal), konsisten dengan aturan "data/ tidak di-commit".
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const repoRoot = resolve(import.meta.dir, "..");
const CORE_JS = join(repoRoot, "static/js/live2dcubismcore.min.js");
const DATA_MODEL = join(repoRoot, "data", "model");

const REN_MANIFEST = join(DATA_MODEL, "tesmodel", "runtime", "ren.model3.json");
const LUMINE_MANIFEST = join(DATA_MODEL, "lumine", "lumine", "lumine.model3.json");
const HAS_REN = existsSync(REN_MANIFEST);
const HAS_LUMINE = existsSync(LUMINE_MANIFEST);

// ── Testkit: core WASM nyata + framework 5.3 nyata + fetch file:// ──
type FrameworkNS = typeof import("../src/live2d/cubismframework-exports");
type ProductionEnv = import("../src/live2d/production-env").ProductionEnv;
type ProductionHandle = import("../src/live2d/production-handle").ProductionHandle;

let F: FrameworkNS;
let env: ProductionEnv;

async function bootPipeline(): Promise<void> {
  if (F) return;
  // 1) Core (WASM) di vm sandbox — butuh polyfill atob (wasm base64-embedded)
  const coreSrc = readFileSync(CORE_JS, "utf8");
  const sandbox: Record<string, unknown> = {
    console, setTimeout, clearTimeout, WebAssembly, Math, Date, JSON,
    TextDecoder, TextEncoder,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    document: { createElement: () => ({}), getElementsByTagName: () => [], currentScript: null },
    location: { href: "file:///core.js" },
    navigator: { userAgent: "bun" },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox, { timeout: 60_000 });
  const core = (sandbox as { Live2DCubismCore?: unknown }).Live2DCubismCore;
  if (!core) throw new Error("Cubism Core gagal dimuat di Bun");
  (globalThis as { Live2DCubismCore?: unknown }).Live2DCubismCore = core;

  // poll sampai wasm siap (pola halaman golden)
  const C = core as { Version: { csmGetVersion(): number } };
  for (let i = 0; i < 200; i++) {
    try { C.Version.csmGetVersion(); break; } catch { /* wasm belum siap */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  C.Version.csmGetVersion(); // masih gagal → lempar (fail-loud)

  // 2) Framework 5.3 — import SETELAH core terpasang global (enum module-level)
  F = await import("../src/live2d/cubismframework-exports");
  (globalThis as { CubismFrameworkBundle?: unknown }).CubismFrameworkBundle = F;

  // 3) Env test: fetch file:// langsung dari disk
  env = {
    core: () => core as never,
    framework: () => F as never,
    fetchBytes: async (url) => {
      const p = url.startsWith("file://") ? fileURLToPath(url) : url;
      const buf = readFileSync(p);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
    fetchImage: async (url) => {
      throw new Error("fetchImage tidak tersedia di unit test (tanpa GL): " + url);
    },
    resolveUrl: (base, relative) => new URL(relative, base).href,
    rootUrl: () => pathToFileURL(join(repoRoot, "data") + "/").href,
  };
}

/** Path relatif situs "model/..." dari path manifest absolut. */
function relOf(manifestPath: string): string {
  return "model/" + manifestPath.replace(/\\/g, "/").split("data/model/")[1];
}

/** Muat handle produksi TANPA host GL (semua kecuali renderer/tekstur nyata). */
async function loadHandle(manifestPath: string): Promise<ProductionHandle> {
  const { loadProductionModel } = await import("../src/live2d/production-model");
  const { createProductionHandle } = await import("../src/live2d/production-handle");
  const data = await loadProductionModel(
    { kind: "path", path: relOf(manifestPath) },
    env,
  );
  return createProductionHandle(data, env);
}

/** Matikan semua efek framework → update() deterministik (tanpa add breath). */
function disableEffects(h: ProductionHandle): void {
  for (const e of ["breath", "physics", "eyeBlink"] as const) {
    h.setEffectEnabled(e, false);
  }
}

const describeIf = (cond: boolean) => (cond ? describe : describe.skip);

// ── Baseline adapter ──
describe("adapter produksi R2 — permukaan & core", () => {
  test("createProductionAdapter: bukan stub, coreInfo 6.x, capability jujur tanpa host", async () => {
    await bootPipeline();
    const { createProductionAdapter } = await import("../src/live2d/production");
    const api = createProductionAdapter({ env });
    expect(api.isStub).toBe(false);
    expect(api.version()).toContain("cubism53");
    const info = api.coreInfo();
    expect(info.version.startsWith("6.")).toBe(true); // Core 6.0.1
    expect(info.latestMocVersion).toBeGreaterThanOrEqual(6);
    const caps = api.capabilities();
    expect(caps.coreReady).toBe(true);
    expect(caps.supportsMoc6).toBe(true);
    expect(caps.backend).toBe("none"); // belum ada host
  });

  test("core missing → coreInfo gagal LOUD (bukan silent)", async () => {
    await bootPipeline();
    const { createProductionAdapter } = await import("../src/live2d/production");
    const api = createProductionAdapter({
      env: { ...env, core: () => null },
    });
    expect(() => api.coreInfo()).toThrow();
  });

  test("framework startUp: CubismFramework siap (sekali, idempoten)", async () => {
    await bootPipeline();
    // bootPipeline → loadProductionModel pertama mem-start framework;
    // panggilan load berikutnya tidak boleh melempar "already started".
    if (!HAS_REN) return;
    const a = await loadHandle(REN_MANIFEST);
    const b = await loadHandle(REN_MANIFEST);
    expect(a.getProfile().counts.parameters).toBe(b.getProfile().counts.parameters);
    a.destroy();
    b.destroy();
  });
});

// ── Model loading nyata ──
describeIf(HAS_REN)("R2-A model load nyata — ren (moc v6)", () => {
  let handle: ProductionHandle;

  beforeAll(async () => {
    await bootPipeline();
    handle = await loadHandle(REN_MANIFEST);
  });

  test("load: moc v6, pipeline 5.3, profil nyata", () => {
    expect(handle.getMocVersion()).toBe(6);
    expect(handle.uses53Pipeline()).toBe(true);
    const profile = handle.getProfile();
    expect(profile.counts.parameters).toBeGreaterThan(0);
    expect(profile.counts.drawables).toBeGreaterThan(0);
    expect(profile.modelName.length).toBeGreaterThan(0);
    // motion & ekspresi termuat dari disk (bukan klaim)
    expect(handle.motionGroups().length).toBeGreaterThan(0);
    expect(profile.counts.expressions).toBe(handle.data.expressions.size);
  });

  test("R2-B parameter backing nyata: read/write/clamp/NaN/unknown/readback", () => {
    // efek off → update() deterministik (tanpa add breath/physics)
    disableEffects(handle);
    const meta = handle.getProfile().parameters[0];
    const info = handle.getParameterInfo(meta.id)!;
    expect(info).toBeDefined();
    // write (pin default Phase 8) → update → readback
    const mid = (info.min + info.max) / 2;
    expect(handle.setParameter(meta.id, mid)).toBe(true);
    handle.update(1 / 30);
    expect(handle.getParameter(meta.id)).toBeCloseTo(mid, 5);
    // clamp ke range model
    expect(handle.setParameter(meta.id, info.max + 1000)).toBe(true);
    handle.update(1 / 30);
    expect(handle.getParameter(meta.id)).toBe(info.max);
    // NaN ditolak, nilai lama lestari
    const before = handle.getParameter(meta.id);
    expect(handle.setParameter(meta.id, NaN)).toBe(false);
    expect(handle.setParameter(meta.id, Infinity)).toBe(false);
    handle.update(1 / 30);
    expect(handle.getParameter(meta.id)).toBe(before);
    // id tak dikenal → false, tanpa throw, tanpa membuat parameter
    expect(handle.setParameter("ParamTidakAda999", 1)).toBe(false);
    expect(handle.getParameter("ParamTidakAda999")).toBeUndefined();
    expect(handle.getParameterInfo("ParamTidakAda999")).toBeUndefined();
    // jumlah parameter tetap
    expect(handle.getParameters().length).toBe(handle.getProfile().counts.parameters);
    // writeParam = tulis buffer mentah (pin:false) — terbaca LANGSUNG
    handle.writeParam(meta.id, info.min);
    expect(handle.getParameter(meta.id)).toBe(info.min);
    // …tetapi ter-revert oleh loadParameters() di update berikutnya (undo-buffer,
    // semantik identik stack lama): nilai yang bertahan = pin aktif (info.max)
    handle.update(1 / 30);
    expect(handle.getParameter(meta.id)).toBe(info.max);
  });

  test("R2-F native motion nyata: play → isFinished false → stopAll → true", () => {
    const group = handle.motionGroups()[0];
    expect(handle.playNativeMotion(group, 0, 1)).toBe(true);
    expect(handle.isMotionFinished()).toBe(false);
    handle.update(1 / 30);
    handle.stopAllMotions();
    expect(handle.isMotionFinished()).toBe(true);
    // grup/index tak dikenal → false (fail-safe, bukan throw)
    expect(handle.playNativeMotion("grup_tidak_ada", 0, 1)).toBe(false);
    expect(handle.playNativeMotion(group, 999, 1)).toBe(false);
  });

  test("R2-G expression nyata: nama dikenal → true, asing → false, reset aman", () => {
    const names = handle.getProfile().expressions.map((e) => e.name);
    if (!names.length) return; // model tanpa ekspresi
    expect(handle.playExpression(names[0])).toBe(true);
    handle.update(1 / 30);
    expect(handle.playExpression("ekspresi_tidak_ada")).toBe(false);
    expect(() => handle.resetExpression()).not.toThrow();
    handle.update(1 / 30);
  });

  test("R2-H effects nyata: gate on/off memindahkan updater scheduler (state updater dipertahankan)", () => {
    // pastikan semua efek tersedia ON dulu (test sebelumnya boleh me-disable)
    for (const e of ["breath", "physics", "eyeBlink"] as const) {
      handle.setEffectEnabled(e, true);
    }
    const before = handle.data.scheduler.getUpdatableCount();
    // breath selalu tersedia (parameter default resmi)
    expect(handle.setEffectEnabled("breath", false)).toBe(true);
    expect(handle.data.scheduler.getUpdatableCount()).toBe(before - 1);
    expect(handle.setEffectEnabled("breath", true)).toBe(true);
    expect(handle.data.scheduler.getUpdatableCount()).toBe(before);
    // efek union-valid tetapi tidak tersedia di model → false (bukan throw)
    if (!handle.getProfile().physics) {
      expect(handle.setEffectEnabled("physics", false)).toBe(false);
    } else {
      expect(handle.setEffectEnabled("physics", false)).toBe(true);
      expect(handle.setEffectEnabled("physics", true)).toBe(true);
    }
    // angka luar union → false (runtime guard)
    expect(handle.setEffectEnabled("halo" as never, true)).toBe(false);
    // pasca gate on/off, updater sama yang kembali (referensi dipertahankan)
    const uBreath = handle.data.updaters.breath!;
    expect(handle.data.scheduler.hasUpdatable(uBreath)).toBe(true);
  });

  test("blink single-owner: framework EyeBlink satu-satunya penulis kedip di handle", () => {
    const hasFwBlink = handle.getEyeBlinkParameters().length > 0;
    expect(!!handle.data.updaters.eyeBlink).toBe(hasFwBlink);
    // Handle TIDAK punya blink kedua — tidak ada writer blink lain di adapter;
    // fallback custom tetap milik engine (arbiter) via profile.eyeBlinkParameters
    expect(handle.getEyeBlinkParameters()).toEqual(
      handle.getProfile().eyeBlinkParameters,
    );
  });

  test("R2-E seam beforeModelUpdate: callback jalan sekali per update, unregister bekerja", () => {
    const seen: string[] = [];
    const off = handle.onBeforeModelUpdate(() => seen.push("cb"));
    handle.update(1 / 30);
    expect(seen).toEqual(["cb"]); // TEPAT sekali per update
    off();
    handle.update(1 / 30);
    expect(seen).toEqual(["cb"]); // unregister bekerja
  });

  test("R2-J destroy: semua method publik fail-safe, tanpa resource write", () => {
    const h = handle;
    const partIds = h.getPartIds();
    h.destroy();
    h.destroy(); // dua kali aman
    expect(h.readParam(h.getProfile().parameters[0].id)).toBe(0);
    expect(h.getParameter(h.getProfile().parameters[0].id)).toBeUndefined();
    expect(h.getParameters()).toEqual([]);
    expect(h.setParameter("X", 1)).toBe(false);
    expect(h.writeParam("X", 1)).toBeUndefined();
    expect(h.playNativeMotion("Idle", 0, 1)).toBe(false);
    expect(h.isMotionFinished()).toBe(true);
    expect(() => h.stopAllMotions()).not.toThrow();
    expect(h.playExpression("apa pun")).toBe(false);
    expect(() => h.resetExpression()).not.toThrow();
    expect(h.setEffectEnabled("breath", true)).toBe(false);
    // metadata beku (profil) tetap boleh dibaca — bukan akses resource live
    expect(h.getPartIds()).toEqual(partIds);
    expect(h.getPartOpacity("PartTidakAda")).toBe(0);
    expect(h.setPartOpacity("PartTidakAda", 1)).toBeUndefined();
    expect(h.snapshotCore().drawables).toEqual([]);
    expect(() => h.update(1 / 30)).not.toThrow(); // no-op, tanpa crash
    // callback pasca-destroy tidak bisa dipasang
    let called = false;
    h.onBeforeModelUpdate(() => { called = true; });
    h.update(1 / 30);
    expect(called).toBe(false);
  });
});

describeIf(HAS_LUMINE)("R2-A/K model switch lifecycle — ren → lumine → ren", () => {
  test("create → destroy → create model lain → destroy → create lagi: bersih", async () => {
    await bootPipeline();
    const a = await loadHandle(REN_MANIFEST);
    const probeA = a.getProfile().parameters[0].id;
    a.setParameter(probeA, 1);
    a.destroy();

    const b = await loadHandle(LUMINE_MANIFEST);
    // model baru: nilai ren TIDAK terbawa — id param sama bisa ada di lumine,
    // tapi nilainya kembali ke default MILIK lumine (instance backing terpisah)
    const bDefault = b.getParameterInfo(probeA)?.defaultValue;
    expect(b.getParameter(probeA)).toBe(bDefault);
    expect(b.getProfile().modelName).not.toBe(a.getProfile().modelName);
    b.destroy();

    const c = await loadHandle(REN_MANIFEST);
    const cDefault = c.getParameterInfo(probeA)?.defaultValue;
    expect(c.getParameter(probeA)).toBe(cDefault); // tidak ada stale write dari a
    expect(c.getProfile().counts.parameters).toBe(a.getProfile().counts.parameters);
    c.destroy();
  });

  test("lumine load nyata: moc era lama → uses53Pipeline false (fakta, bukan tebakan)", async () => {
    await bootPipeline();
    const h = await loadHandle(LUMINE_MANIFEST);
    expect(h.getMocVersion()).toBeLessThan(6);
    expect(h.uses53Pipeline()).toBe(false);
    expect(h.getProfile().counts.parameters).toBeGreaterThan(0);
    h.update(1 / 30); // framework update jalan untuk moc < 6 juga
    h.destroy();
  });
});

describe("R2-A invalid model", () => {
  test("manifest rusak → Live2DLoadError manifest-invalid", async () => {
    await bootPipeline();
    const { loadProductionModel } = await import("../src/live2d/production-model");
    const badBytes = new TextEncoder().encode("{ bukan json");
    const badEnv: ProductionEnv = { ...env, fetchBytes: async () => badBytes.buffer as ArrayBuffer };
    await expect(
      loadProductionModel({ kind: "path", path: "model/x/x.model3.json" }, badEnv),
    ).rejects.toMatchObject({ reason: "manifest-invalid" });
  });

  test("moc tak dikenal → Live2DLoadError moc-unsupported (tanpa stamp versi)", async () => {
    await bootPipeline();
    const { loadProductionModel } = await import("../src/live2d/production-model");
    const manifest = JSON.parse(readFileSync(REN_MANIFEST, "utf8"));
    const goodManifest = new TextEncoder().encode(JSON.stringify(manifest));
    // moc palsu: magic "MOC3" sah + byte versi 99 (offset 4)
    const bogus = new Uint8Array(64);
    bogus[0] = 0x4d; bogus[1] = 0x4f; bogus[2] = 0x43; bogus[3] = 0x33;
    bogus[4] = 99;
    let call = 0;
    const envBad: ProductionEnv = {
      ...env,
      fetchBytes: async () =>
        call++ === 0 ? (goodManifest.buffer as ArrayBuffer) : (bogus.buffer as ArrayBuffer),
    };
    await expect(
      loadProductionModel({ kind: "path", path: "model/x/x.model3.json" }, envBad),
    ).rejects.toMatchObject({ reason: "moc-unsupported" });
  });

  test("aset hilang → Live2DLoadError (manifest tidak ditemukan)", async () => {
    await bootPipeline();
    const { loadProductionModel } = await import("../src/live2d/production-model");
    await expect(
      loadProductionModel({ kind: "path", path: "model/tidak/ada.model3.json" }, env),
    ).rejects.toThrow();
  });
});

describe("R2 transform capability (CPU-side, tanpa host)", () => {
  test("natural size / scale / position / anchor / toGlobal-toLocal konsisten", async () => {
    await bootPipeline();
    if (!HAS_REN) return;
    const h = await loadHandle(REN_MANIFEST);
    // R6 PARITAS: natural size = canvasinfo RAW PX core (identik konvensi legacy)
    const ci = (h.data.user.getModel()!.getModel() as { canvasinfo: {
      CanvasWidth: number; CanvasHeight: number; PixelsPerUnit: number } }).canvasinfo;
    const nat = h.getNaturalSize();
    expect(nat.height).toBeCloseTo(ci.CanvasHeight, 3);
    expect(nat.width).toBeCloseTo(ci.CanvasWidth, 3);
    expect(h.getScale()).toBe(1);

    h.setScale(2);
    expect(h.getScale()).toBe(2);
    const nat2 = h.getNaturalSize();
    expect(nat2.height).toBeCloseTo(ci.CanvasHeight, 3); // natural TIDAK terpengaruh skala

    // toGlobal pusat model (0,0 unit) = posisi default (center kanvas)
    const center = h.toGlobal({ x: 0, y: 0 });
    expect(center.x).toBeCloseTo(0, 5);
    expect(center.y).toBeCloseTo(0, 5);
    // y flip: unit +Y (atas model) → layar -Y
    const up = h.toGlobal({ x: 0, y: 1 });
    expect(up.y).toBeLessThan(center.y);
    // round trip
    const local = h.toLocal(up);
    expect(local.x).toBeCloseTo(0, 5);
    expect(local.y).toBeCloseTo(1, 5);
    // setPosition menggeser pusat
    h.setPosition(50, -25);
    const moved = h.toGlobal({ x: 0, y: 0 });
    expect(moved.x).toBeCloseTo(50, 5);
    expect(moved.y).toBeCloseTo(-25, 5);
    h.destroy();
  });

  test("setRotation tanpa crash (komposisi matriks R*S)", async () => {
    await bootPipeline();
    if (!HAS_REN) return;
    const h = await loadHandle(REN_MANIFEST);
    expect(() => h.setRotation(Math.PI / 8)).not.toThrow();
    expect(() => h.update(1 / 30)).not.toThrow();
    expect(() => h.setRotation(0)).not.toThrow();
    h.destroy();
  });
});

describe("R2-L Pixi6 isolation", () => {
  test("modul adapter produksi bebas referensi pixi/pixi-live2d", () => {
    const files = [
      "src/live2d/production.ts",
      "src/live2d/production-env.ts",
      "src/live2d/production-model.ts",
      "src/live2d/production-handle.ts",
      "src/live2d/production-host.ts",
      "src/live2d/production-entry.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(repoRoot, f), "utf8");
      expect(src.match(/pixi/i), f + " tidak boleh merujuk pixi").toBeNull();
    }
  });

  test("tanpa loop tersembunyi: tidak ada rAF/setInterval/Ticker di adapter produksi", () => {
    const files = [
      "src/live2d/production.ts",
      "src/live2d/production-model.ts",
      "src/live2d/production-handle.ts",
      "src/live2d/production-host.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(repoRoot, f), "utf8");
      expect(src.match(/requestAnimationFrame|setInterval|Ticker\.shared/), f).toBeNull();
    }
  });
});

describe("R3 — namespace isolation & composite (static)", () => {
  test("loader compositor v8: capture/restore window.PIXI, idempoten, tanpa loop", () => {
    const src = readFileSync(join(repoRoot, "static/js/pixi8-namespace.js"), "utf8");
    // simpan legacy sebelum muat v8
    expect(src).toContain("var legacyPIXI = window.PIXI");
    // tangkap v8 ke namespace terisolasi
    expect(src).toContain("window.__compositor8 = v8");
    // pulihkan legacy — sinkron di onload
    expect(src).toContain("window.PIXI = legacyPIXI");
    // idempoten
    expect(src).toContain("if (window.__compositor8Ready) return");
    // bukan loop tersembunyi
    expect(src.match(/requestAnimationFrame|setInterval/)).toBeNull();
  });

  test("core-log-shim: DIHAPUS di R9-4 — slot log Core kini single-writer (A/B terbukti)", () => {
    // R9-4: vendor Pixi6/pixi-live2d terhapus → hanya CubismFramework.startUp
    // yang memanggil csmSetLogFunction (sekali, ter-guard __l2dFrameworkStarted).
    // A/B browser verification (test/smoke-corelog-shim-ab.ts) membuktikan
    // WITH & WITHOUT shim identik penuh → file dihapus permanen.
    expect(existsSync(join(repoRoot, "static/js/core-log-shim.js"))).toBe(false);
    for (const page of ["static/index.html", "static/pet.html", "static/vtuber.html"]) {
      const html = readFileSync(join(repoRoot, page), "utf8");
      expect(html.includes("core-log-shim.js")).toBe(false);
    }
  });

  test("HostOptions composite: dua mode terdokumentasi, default direct", () => {
    const types = readFileSync(join(repoRoot, "src/live2d/types.ts"), "utf8");
    expect(types).toContain('composite?: "direct" | "canvas-texture"');
    const host = readFileSync(join(repoRoot, "src/live2d/production-host.ts"), "utf8");
    expect(host).toContain('composite = "direct"');
    expect(host).toContain("autoStart: false"); // R3-G: tanpa ticker tersembunyi
    expect(host).toContain("compositeInfo()");
  });

  test("coexist page (sandbox historis R3): artefak era transisi — shim & vendor legacy tidak lagi tersaji", () => {
    // R9-4: shim dihapus; vendor Pixi6/pixi-live2d sudah dihapus fisik di sesi
    // sebelumnya. r3-coexist.html dipertahankan sebagai ARTEFAK SEJARAH
    // (readiness era coexistence) — urutan pemuatannya tidak lagi kontrak
    // produk. Yang dijaga: halaman produksi TIDAK memuat shim/vendor legacy.
    const html = readFileSync(join(repoRoot, "static/r3-coexist.html"), "utf8");
    // struktur historis masih terbaca (bukti artefak utuh)
    expect(html.indexOf("live2dcubismcore.min.js")).toBeGreaterThan(-1);
    expect(html.indexOf("cubism-framework.js")).toBeGreaterThan(-1);
    expect(html.indexOf("live2d-adapter.js")).toBeGreaterThan(-1);
    expect(html.indexOf("pixi8-namespace.js")).toBeGreaterThan(-1);
  });
});
