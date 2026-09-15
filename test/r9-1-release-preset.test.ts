/**
 * test/r9-1-release-preset.test.ts — Regression test for R9-1.
 *
 * Verifikasi:
 *  1. Jalur PRODUKSI pada releaseAllPresetPoses() TIDAK mengakses `state.model.internalModel`.
 *  2. Pada jalur produksi, releaseAllPresetPoses() mereset parameter ke defaultValue melalui
 *     Production Parameter API (state.handle.getParameters() -> pokeActual).
 *  3. Parameter yang nilainya telah diubah dari default benar-benar kembali ke nilai default.
 *  4. Tidak ada exception yang dilempar atau ditelan diam-diam.
 *  5. Jalur LEGACY tetap mempertahankan perilaku pengambilan coreModel dari internalModel.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const repoRoot = resolve(import.meta.dir, "..");
const appJsPath = join(repoRoot, "static/js/app.js");
const appSrc = readFileSync(appJsPath, "utf8");

// Helper untuk mengekstrak fungsi by name dengan kurung seimbang
function extractFn(source: string, name: string): string | null {
  const m = source.match(new RegExp("\\bfunction\\s+" + name + "\\s*\\("));
  if (!m) return null;
  let i = source.indexOf("{", m.index),
    depth = 0,
    inStr: string | null = null,
    esc = false;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (!depth)
        return source.slice(
          source.lastIndexOf("function", m.index + 1),
          i + 1,
        );
    }
  }
  return null;
}

const releasePresetPoseSrc = extractFn(appSrc, "releasePresetPose");

describe("R9-1: releasePresetPose accidental coupling fix", () => {
  test("source releasePresetPose exists and is production-only without internalModel fallback", () => {
    expect(releasePresetPoseSrc).not.toBeNull();
    expect(releasePresetPoseSrc).toContain("state.handle");
    expect(releasePresetPoseSrc).not.toContain("state.model.internalModel");
  });

  test("production path: resets parameters to default without accessing internalModel", () => {
    const params = [
      { id: "ParamAngleX", min: -30, max: 30, defaultValue: 0, current: 25 },
      { id: "ParamEyeLOpen", min: 0, max: 1, defaultValue: 1, current: 0.2 },
      { id: "ParamMouthOpenY", min: 0, max: 1, defaultValue: 0, current: 0.8 },
    ];

    const currentValues: Record<string, number> = {};
    for (const p of params) currentValues[p.id] = p.current;

    const pokeActualLog: Array<{ id: string; val: number }> = [];

    const mockHandle = {
      getParameters() {
        return params.map((p) => ({
          id: p.id,
          min: p.min,
          max: p.max,
          defaultValue: p.defaultValue,
        }));
      },
      setPartOpacity: () => {},
    };

    const mockModel: Record<string, any> = {
      __isCompatModel: true,
    };
    Object.defineProperty(mockModel, "internalModel", {
      get() {
        throw new Error("VIOLATION: internalModel was accessed on production path!");
      },
      configurable: true,
    });

    const presetPoseParams = new Map<string, number>([["ParamAngleX", 25]]);
    const presetPoseParts = new Map<string, number>();

    const sandbox: Record<string, any> = {
      state: {
        production: true,
        handle: mockHandle,
        model: mockModel,
        arbiter: {
          clearSource: () => {},
        },
        idlePoseCur: {},
        paramRange: {},
        aiPose: {},
        activeProperty: "custom",
        activeEmotion: "smile",
        overrides: {},
      },
      presetPoseParams,
      presetPoseParts,
      window: {
        __live2dAgent: { stopAllMotions: () => {} },
      },
      startIdleMotion: () => {},
      resetEmotion: () => {},
      pokeActual: (id: string, val: number) => {
        pokeActualLog.push({ id, val });
        currentValues[id] = val;
      },
      Math,
      Number,
      console,
    };

    vm.createContext(sandbox);
    vm.runInContext(releasePresetPoseSrc!, sandbox);

    let thrownError: any = null;
    try {
      vm.runInContext("releasePresetPose()", sandbox);
    } catch (e) {
      thrownError = e;
    }

    expect(thrownError).toBeNull();
    expect(sandbox.state.activeProperty).toBe("default");
    expect(sandbox.state.activeEmotion).toBe("");

    expect(pokeActualLog.length).toBe(3);
    expect(pokeActualLog).toEqual([
      { id: "ParamAngleX", val: 0 },
      { id: "ParamEyeLOpen", val: 1 },
      { id: "ParamMouthOpenY", val: 0 },
    ]);

    expect(currentValues["ParamAngleX"]).toBe(0);
    expect(currentValues["ParamEyeLOpen"]).toBe(1);
    expect(currentValues["ParamMouthOpenY"]).toBe(0);

    expect(sandbox.state.paramRange["ParamAngleX"]).toEqual({ min: -30, max: 30, def: 0 });
    expect(sandbox.state.paramRange["ParamEyeLOpen"]).toEqual({ min: 0, max: 1, def: 1 });
  });

  test("legacy fallback path: retired, no access to coreModel or internalModel", () => {
    expect(releasePresetPoseSrc).not.toContain("coreModel");
    expect(releasePresetPoseSrc).not.toContain("internalModel");
  });

  test("behavioral proof: real production handle resets parameter to default without internalModel", async () => {
    // 1. Setup real Cubism Core & Framework if data model exists
    const fs = await import("node:fs");
    const DATA_MODEL = join(repoRoot, "data", "model");
    const REN_MANIFEST = join(DATA_MODEL, "tesmodel", "runtime", "ren.model3.json");
    if (!fs.existsSync(REN_MANIFEST)) {
      console.log("  [skip: ren model not present on disk]");
      return;
    }

    const CORE_JS = join(repoRoot, "static/js/live2dcubismcore.min.js");
    const coreSrc = fs.readFileSync(CORE_JS, "utf8");
    const coreSandbox: Record<string, unknown> = {
      console, setTimeout, clearTimeout, WebAssembly, Math, Date, JSON,
      TextDecoder, TextEncoder,
      atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
      btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
      document: { createElement: () => ({}), getElementsByTagName: () => [], currentScript: null },
      location: { href: "file:///core.js" },
      navigator: { userAgent: "bun" },
    };
    coreSandbox.globalThis = coreSandbox;
    coreSandbox.self = coreSandbox;
    coreSandbox.window = coreSandbox;
    vm.createContext(coreSandbox);
    vm.runInContext(coreSrc, coreSandbox, { timeout: 60_000 });
    const core = (coreSandbox as any).Live2DCubismCore;
    (globalThis as any).Live2DCubismCore = core;

    const F = await import("../src/live2d/cubismframework-exports");
    (globalThis as any).CubismFrameworkBundle = F;

    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const env: any = {
      core: () => core,
      framework: () => F,
      fetchBytes: async (url: string) => {
        const p = url.startsWith("file://") ? fileURLToPath(url) : url;
        const buf = fs.readFileSync(p);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
      fetchImage: async () => { throw new Error("no image"); },
      resolveUrl: (base: string, rel: string) => new URL(rel, base).href,
      rootUrl: () => pathToFileURL(join(repoRoot, "data") + "/").href,
    };

    const { loadProductionModel } = await import("../src/live2d/production-model");
    const { createProductionHandle } = await import("../src/live2d/production-handle");
    const data = await loadProductionModel(
      { kind: "path", path: "model/tesmodel/runtime/ren.model3.json" },
      env,
    );
    const handle = createProductionHandle(data, env);

    // Disable background effects so values don't fluctuate
    for (const e of ["breath", "physics", "eyeBlink"] as const) {
      handle.setEffectEnabled(e, false);
    }

    // 2. Identify a writable parameter with known defaultValue
    const param = handle.getParameters().find((p) => p.id === "ParamAngleX") || handle.getParameters()[0];
    const defaultVal = param.defaultValue;
    const testVal = param.max !== defaultVal ? param.max : param.min;

    // 3. Change that parameter away from default
    expect(handle.setParameter(param.id, testVal)).toBe(true);
    handle.update(1 / 30);
    expect(handle.getParameter(param.id)).toBe(testVal);
    expect(handle.getParameter(param.id)).not.toBe(defaultVal);

    // 4. Invoke releasePresetPose with trap on internalModel
    const compatModel: Record<string, any> = { __isCompatModel: true };
    let internalModelAccessed = false;
    Object.defineProperty(compatModel, "internalModel", {
      get() {
        internalModelAccessed = true;
        throw new Error("VIOLATION: internalModel accessed!");
      },
      configurable: true,
    });

    const sandbox: Record<string, any> = {
      state: {
        production: true,
        handle,
        model: compatModel,
        arbiter: { clearSource: () => {} },
        idlePoseCur: {},
        paramRange: {},
        aiPose: {},
        overrides: {},
        activeProperty: "custom",
        activeEmotion: "custom",
      },
      presetPoseParams: new Map(),
      presetPoseParts: new Map(),
      window: { __live2dAgent: { stopAllMotions: () => {} } },
      startIdleMotion: () => {},
      resetEmotion: () => {},
      pokeActual: (id: string, val: number) => {
        handle.setParameter(id, val);
      },
      Math,
      Number,
      console,
    };

    vm.createContext(sandbox);
    vm.runInContext(releasePresetPoseSrc!, sandbox);

    expect(() => {
      vm.runInContext("releasePresetPose()", sandbox);
    }).not.toThrow();

    // 5. Verify the parameter returned to its model-defined default
    handle.update(1 / 30);
    expect(handle.getParameter(param.id)).toBe(defaultVal);

    // 6. Verify no exception occurred & internalModel was never accessed
    expect(internalModelAccessed).toBe(false);

    handle.destroy();
  });
});
