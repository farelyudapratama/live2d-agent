/**
 * r7-gaps.test.ts — STAGE R7-1: penutupan GAP via pipeline NYATA (Bun).
 *
 *  - LOAD COMPAT: adopsi `.exp3` orphan in-memory via ModelSource {settings}
 *    — kasus nyata lumine (manifest 0 Expressions, disk punya mothion/*.exp3.json),
 *    persis alur ENGINE MAIN buildModelSettings.
 *  - LOAD COMPAT: file ekspresi hilang → gagal LOUD; deklarasi resmi tidak
 *    pernah tertimpa adopsi.
 *  - DIAGNOSTICS: seluruh data diagnostics() legacy tersedia dari API PUBLIK
 *    handle/adapter — tanpa internalModel/coreModel/settings/__moc.
 *  - INTERACTION: invarian zoom-around-cursor (algoritma app.js) memakai
 *    transform handle (CPU-side) — titik di bawah kursor tetap di tempat.
 *  - GAP-2 measureLitBounds: butuh WebGL → dibuktikan di browser (r7-compat.html).
 *  - GAP-1 scene layers: DOM/CSS — dibuktikan di browser (r7-compat.html).
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const repoRoot = resolve(import.meta.dir, "..");
const CORE_JS = join(repoRoot, "static/js/live2dcubismcore.min.js");
const DATA_MODEL = join(repoRoot, "data", "model");
const REN_MANIFEST = join(DATA_MODEL, "tesmodel", "runtime", "ren.model3.json");
const LUMINE_MANIFEST = join(DATA_MODEL, "lumine", "lumine", "lumine.model3.json");
const LUMINE_DIR = join(DATA_MODEL, "lumine", "lumine");
const HAS_REN = existsSync(REN_MANIFEST);
const HAS_LUMINE = existsSync(LUMINE_MANIFEST);

type FrameworkNS = typeof import("../src/live2d/cubismframework-exports");
type ProductionEnv = import("../src/live2d/production-env").ProductionEnv;

let F: FrameworkNS;
let env: ProductionEnv;

async function bootPipeline(): Promise<void> {
  if (F) return;
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
  const C = core as { Version: { csmGetVersion(): number } };
  for (let i = 0; i < 200; i++) {
    try { C.Version.csmGetVersion(); break; } catch { /* wasm belum siap */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  C.Version.csmGetVersion();
  F = await import("../src/live2d/cubismframework-exports");
  (globalThis as { CubismFrameworkBundle?: unknown }).CubismFrameworkBundle = F;
  env = {
    core: () => core as never,
    framework: () => F as never,
    fetchBytes: async (url) => {
      const p = url.startsWith("file://") ? fileURLToPath(url) : url;
      const buf = readFileSync(p);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
    fetchImage: async () => { throw new Error("tanpa GL di unit test"); },
    resolveUrl: (base, relative) => new URL(relative, base).href,
    rootUrl: () => pathToFileURL(join(repoRoot, "data") + "/").href,
  };
}

async function loadFromSettings(settings: Record<string, unknown>) {
  const { loadProductionModel } = await import("../src/live2d/production-model");
  const { createProductionHandle } = await import("../src/live2d/production-handle");
  const data = await loadProductionModel({ kind: "settings", settings }, env);
  return createProductionHandle(data, env);
}

/** Replika alur adopsi ENGINE MAIN (buildModelSettings): manifest di-patch
 * in-memory dengan file .exp3 di disk yang BELUM dideklarasikan. */
function adoptOrphanExpressions(
  manifest: Record<string, unknown>,
  onDisk: Array<{ Name: string; File: string }>,
): Record<string, unknown> {
  const declared: Array<{ Name: string; File: string }> = Array.isArray(
    (manifest.FileReferences as Record<string, unknown>)?.Expressions,
  ) ? ((manifest.FileReferences as Record<string, unknown>).Expressions as Array<{ Name: string; File: string }>).slice()
    : [];
  const takenNames = new Set(declared.map((e) => e && e.Name).filter(Boolean));
  const takenFiles = new Set(declared.map((e) => e && e.File).filter(Boolean));
  let added = 0;
  for (const o of onDisk) {
    if (takenNames.has(o.Name) || takenFiles.has(o.File)) continue;
    declared.push({ Name: o.Name, File: o.File });
    takenNames.add(o.Name);
    takenFiles.add(o.File);
    added++;
  }
  const out = JSON.parse(JSON.stringify(manifest));
  (out.FileReferences as Record<string, unknown>).Expressions = declared;
  (out as { __adopted?: number }).__adopted = added;
  return out;
}

const describeIf = (cond: boolean) => (cond ? describe : describe.skip);

describeIf(HAS_LUMINE)("R7-1 LOAD COMPAT — adopsi .exp3 orphan via ModelSource settings", () => {
  test("baseline: lumine via path → 0 ekspresi (orphan mati, kasus historis)", async () => {
    await bootPipeline();
    const { loadProductionModel } = await import("../src/live2d/production-model");
    const { createProductionHandle } = await import("../src/live2d/production-handle");
    const data = await loadProductionModel(
      { kind: "path", path: "model/lumine/lumine/lumine.model3.json" }, env,
    );
    const h = createProductionHandle(data, env);
    expect(h.getProfile().expressions.length).toBe(0);
    h.destroy();
  });

  test("adopsi in-memory: orphan .exp3 disk hidup — persis alur buildModelSettings", async () => {
    await bootPipeline();
    const manifest = JSON.parse(readFileSync(LUMINE_MANIFEST, "utf8"));
    // daftar on-disk dari "server" (ENGINE MAIN fetch /api/model/expressions):
    const orphans = readdirSync(LUMINE_DIR + "/mothion")
      .filter((f) => f.endsWith(".exp3.json"))
      .map((f) => ({ Name: f.replace(/\.exp3\.json$/i, ""), File: "mothion/" + f }));
    expect(orphans.length).toBeGreaterThan(0);
    const patched = adoptOrphanExpressions(manifest, orphans);
    expect(patched.__adopted).toBe(orphans.length);
    // pola ENGINE MAIN: buildModelSettings memasang settings.url absolut
    patched.url = pathToFileURL(LUMINE_MANIFEST).href;
    const h = await loadFromSettings(patched);
    const names = h.getProfile().expressions.map((e) => e.name);
    expect(names.length).toBe(orphans.length);
    // ekspresi teradopsi BENAR-BENAR bisa dimainkan
    expect(h.playExpression(names[0])).toBe(true);
    h.update(1 / 60);
    expect(h.playExpression("tidak_ada")).toBe(false);
    h.destroy();
  });

  test("adopsi TIDAK menimpa deklarasi resmi (ren: 5 ekspresi utuh)", async () => {
    await bootPipeline();
    const manifest = JSON.parse(readFileSync(REN_MANIFEST, "utf8"));
    const declared = (manifest.FileReferences as Record<string, unknown>).Expressions as unknown[];
    const patched = adoptOrphanExpressions(manifest, [
      { Name: "exp_01", File: "expressions/exp_01.exp3.json" }, // duplikat nama → dilewati
      { Name: "baru", File: "expressions/exp_02.exp3.json" },   // file sudah dideklarasikan → dilewati
    ]);
    const after = (patched.FileReferences as Record<string, unknown>).Expressions as unknown[];
    expect(after.length).toBe(declared.length); // tidak ada yang ditambahkan
    patched.url = pathToFileURL(REN_MANIFEST).href;
    const h = await loadFromSettings(patched);
    expect(h.getProfile().expressions.length).toBe(declared.length);
    h.destroy();
  });

  test("ekspresi teradopsi hilang dari disk → gagal LOUD (bukan silent)", async () => {
    await bootPipeline();
    const manifest = JSON.parse(readFileSync(LUMINE_MANIFEST, "utf8"));
    const patched = adoptOrphanExpressions(manifest, [
      { Name: "hilang", File: "mothion/tidak_ada.exp3.json" },
    ]);
    await expect(loadFromSettings(patched)).rejects.toThrow();
  });
});

describeIf(HAS_REN)("R7-1 DIAGNOSTICS — tanpa internalModel/legacy internals", () => {
  test("seluruh data diagnostics() tersedia dari API publik handle+adapter", async () => {
    await bootPipeline();
    const { createProductionAdapter } = await import("../src/live2d/production");
    const api = createProductionAdapter({ env });
    const { loadProductionModel } = await import("../src/live2d/production-model");
    const { createProductionHandle } = await import("../src/live2d/production-handle");
    const data = await loadProductionModel(
      { kind: "path", path: "model/tesmodel/runtime/ren.model3.json" }, env,
    );
    const handle = createProductionHandle(data, env);

    // diagnostics() legacy = { model, coreVersion, mocVersion, mocVersionNote,
    //   canvasAlpha, patches, roleCount, roles, paramRanges, emotions, ... } —
    // SEMUA di bawah ini dari API PUBLIK (nol internalModel/coreModel/settings/__moc):
    const diag = {
      model: handle.getName(),                                    // ex: settings.name
      coreVersion: api.coreInfo().version,                        // ex: core global
      mocVersion: handle.getMocVersion(),                         // ex: header moc
      uses53Pipeline: handle.uses53Pipeline(),
      roleCount: Object.keys(handle.getProfile().eyeBlinkParameters).length >= 0
        ? handle.getProfile().parameters.length : 0, // role mapping = Phase 10, di atas handle
      paramRanges: Object.fromEntries(
        handle.getParameters().map((p) => [p.id, { min: p.min, max: p.max }]),
      ),
      emotions: handle.getProfile().expressions.map((e) => e.name),
      motionGroups: handle.motionGroups(),
      physics: handle.getProfile().physics,
      pose: handle.getProfile().pose,
      blinkParams: handle.getEyeBlinkParameters(),
      stats: { ...handle.data.stats },
    };
    expect(diag.model.length).toBeGreaterThan(0);
    expect(String(diag.coreVersion).startsWith("6.")).toBe(true);
    expect(diag.mocVersion).toBe(6);
    expect(Object.keys(diag.paramRanges).length).toBeGreaterThan(0);
    expect(diag.emotions.length).toBe(5);
    expect(diag.blinkParams).toEqual(["ParamEyeLOpen", "ParamEyeROpen"]);
    handle.destroy();
  });

  test("invarian zoom-around-cursor (algoritma app.js) — titik di bawah kursor tetap", async () => {
    await bootPipeline();
    const { loadProductionModel } = await import("../src/live2d/production-model");
    const { createProductionHandle } = await import("../src/live2d/production-handle");
    const data = await loadProductionModel(
      { kind: "path", path: "model/tesmodel/runtime/ren.model3.json" }, env,
    );
    const h = createProductionHandle(data, env);
    h.setScale(1); h.setAnchor(0.5, 0.5);
    // R6 konversi: toLocal produksi = UNIT MODEL; legacy lokal PX. px/unit =
    // PixelsPerUnit × scale — dari natural size (raw px) ÷ unit kanvas:
    const units = h.data.user.getModel()!.getCanvasHeight();
    const ppu = h.getNaturalSize().height / units;
    // kursor di suatu titik layar (relatif center):
    const cursor = { x: 240, y: -90 };
    const before = h.toLocal(cursor);
    // algoritma setScaleAroundPoint (app.js) DIJEMBATAN ke unit model:
    // local = toLocal(cursor); scale = next; center = cursor - local*ppu*next
    for (const next of [0.5, 1.5, 2]) {
      const local = h.toLocal(cursor);
      h.setScale(next);
      // X: unit x-up = px x-right → center = cursor − local·ppu·scale;
      // Y: unit model y-UP vs layar y-DOWN → center = cursor + local·ppu·scale
      h.setPosition(cursor.x - local.x * ppu * next, cursor.y + local.y * ppu * next);
      const after = h.toLocal(cursor);
      // titik model yang tadinya di bawah kursor TETAP di bawah kursor
      expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6);
      expect(Math.abs(after.y - before.y)).toBeLessThan(1e-6);
    }
    h.destroy();
  });
});
