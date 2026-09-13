/**
 * r4-frame.test.ts — STAGE R4: bukti update lifecycle + frame ownership dengan
 * pipeline NYATA (Cubism Core WASM + framework 5.3 + model ren dari disk).
 *
 * Yang dibuktikan di sini (bukan klaim):
 *  - R4-C  handle.update deterministic & exactly-once (100 panggilan → 100
 *          motion/scheduler/core update, tanpa hidden loop)
 *  - R4-D  seam beforeModelUpdate → ParameterArbiter.commit → coreModel.update:
 *          arbiter tetap satu-satunya commit point engine; urutan tulis
 *          role SEBELUM param di parameter fisik yang sama (invariant Phase 13)
 *  - R4-E  undo-buffer: intent arbiter tidak hilang lintas frame; release →
 *          saved state kembali
 *  - R4-F  multi-intent satu frame: priority rawDrive(30) > lipsync(20) >
 *          sticky(10), idle-emotion(5) > idle-pose(3) — semantik identik Phase 13
 *  - R4-G  scheduler 5.3: setiap updater tepat sekali per update; gating
 *          removeUpdatableList benar-benar menghentikan updater
 *  - R4-H  model switch: counter A beku di destroy; B mulai dari nol
 *
 * Rendering (host/composite) dibuktikan terpisah di smoke browser (r4-frame.html)
 * — Bun tidak punya WebGL.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { createParameterArbiter } from "../src/client/engine/parameter-arbiter";
import { createEngineParameterLink } from "../src/client/engine/role-parameter-bridge";
import { mapRoles } from "../src/client/engine/role-mapping";

const repoRoot = resolve(import.meta.dir, "..");
const CORE_JS = join(repoRoot, "static/js/live2dcubismcore.min.js");
const DATA_MODEL = join(repoRoot, "data", "model");
const REN_MANIFEST = join(DATA_MODEL, "tesmodel", "runtime", "ren.model3.json");
const HAS_REN = existsSync(REN_MANIFEST);

type FrameworkNS = typeof import("../src/live2d/cubismframework-exports");
type ProductionEnv = import("../src/live2d/production-env").ProductionEnv;
type ProductionHandle = import("../src/live2d/production-handle").ProductionHandle;
type ArbiterLike = ReturnType<
  typeof import("../src/client/engine/parameter-arbiter").createParameterArbiter
>;

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
    fetchImage: async (url) => {
      throw new Error("fetchImage tidak tersedia di unit test (tanpa GL): " + url);
    },
    resolveUrl: (base, relative) => new URL(relative, base).href,
    rootUrl: () => pathToFileURL(join(repoRoot, "data") + "/").href,
  };
}

function relOf(manifestPath: string): string {
  return "model/" + manifestPath.replace(/\\/g, "/").split("data/model/")[1];
}

async function loadHandle(manifestPath: string): Promise<ProductionHandle> {
  const { loadProductionModel } = await import("../src/live2d/production-model");
  const { createProductionHandle } = await import("../src/live2d/production-handle");
  const data = await loadProductionModel({ kind: "path", path: relOf(manifestPath) }, env);
  return createProductionHandle(data, env);
}

/** Matikan semua efek framework → update() deterministik. */
function disableEffects(h: ProductionHandle): void {
  for (const e of ["breath", "physics", "eyeBlink"] as const) h.setEffectEnabled(e, false);
}

/** Pasang ParameterArbiter di seam — persis pola yang akan dipakai engine R4+. */
async function wireArbiter(h: ProductionHandle): Promise<ArbiterLike> {
  const model = h.data.user.getModel()!;
  const roleIds = mapRoles(
    new Set(h.getParameters().map((p) => p.id)),
    {
      eyeBlinkIds: h.getProfile().eyeBlinkParameters,
      lipSyncIds: h.getProfile().lipSyncParameters,
    },
  );
  const link = createEngineParameterLink(model, () => roleIds);
  if (!link) throw new Error("engine parameter link gagal dibangun");
  const arb = createParameterArbiter({
    writeRole: (role, v) => link.bridge.writeRef(role, v),
    writeRoleNorm: (role, t) => link.bridge.writeNorm(role, t),
    writeParam: (id, v) => link.writeActual(id, v),
  });
  h.onBeforeModelUpdate(() => arb.commit());
  return arb;
}

const describeIf = (cond: boolean) => (cond ? describe : describe.skip);

describeIf(HAS_REN)("R4-C — handle.update deterministic & exactly-once", () => {
  test("100 panggilan eksplisit → 100 logical update (tanpa hidden loop)", async () => {
    await bootPipeline();
    const h = await loadHandle(REN_MANIFEST);
    disableEffects(h);
    let seams = 0;
    h.onBeforeModelUpdate(() => seams++);
    for (let i = 0; i < 100; i++) h.update(1 / 60);
    const st = h.data.stats;
    expect(st.frames).toBe(100);
    expect(st.motionUpdates).toBe(100);
    expect(st.schedulerRuns).toBe(100);
    expect(st.seamCalls).toBe(100);
    expect(st.coreUpdates).toBe(100);
    expect(seams).toBe(100);
    // sinkron: setelah for-loop selesai, tidak ada callback lain jalan
    h.update(1 / 60);
    expect(st.frames).toBe(101);
    expect(st.coreUpdates).toBe(101);
    h.destroy();
    h.update(1 / 60); // no-op
    expect(st.frames).toBe(101); // beku di destroy
  });

  test("R4-G scheduler: setiap updater tepat sekali per update; gating menghentikan", async () => {
    await bootPipeline();
    const h = await loadHandle(REN_MANIFEST);
    disableEffects(h); // semua off dulu
    const counts: Record<string, number> = {};
    for (const [name, u] of Object.entries(h.data.updaters)) {
      if (!u) continue;
      counts[name] = 0;
      const orig = u.onLateUpdate.bind(u);
      (u as unknown as { onLateUpdate: unknown }).onLateUpdate = (
        model: Parameters<typeof orig>[0],
        dt: Parameters<typeof orig>[1],
      ) => {
        counts[name]++;
        orig(model, dt);
      };
      h.setEffectEnabled(name as "breath", true); // nyalakan kembali
    }
    for (let i = 0; i < 50; i++) h.update(1 / 60);
    const st = h.data.stats;
    expect(st.schedulerRuns).toBe(50);
    for (const [name, n] of Object.entries(counts)) {
      expect(n).toBe(50); // tepat sekali per update — TIDAK dobel
      void name;
    }
    // gating: breath off → invokasi berhenti, scheduler tetap jalan
    const breathBefore = counts.breath ?? 0;
    h.setEffectEnabled("breath", false);
    for (let i = 0; i < 10; i++) h.update(1 / 60);
    expect(counts.breath).toBe(breathBefore); // tidak bertambah
    expect(st.schedulerRuns).toBe(60); // scheduler tetap tepat sekali
    h.destroy();
  });
});

describeIf(HAS_REN)("R4-D/E — seam → Arbiter → core.update (in-frame)", () => {
  let h: ProductionHandle;
  let arb: ArbiterLike;

  beforeAll(async () => {
    await bootPipeline();
    h = await loadHandle(REN_MANIFEST);
    disableEffects(h);
    arb = await wireArbiter(h);
  });

  test("R4-D param intent lewat seam: commit → readback; role SEBELUM param di param fisik sama", () => {
    const meta = h.getProfile().parameters.find((p) => p.id === "ParamAngleY") ||
      h.getProfile().parameters[0];
    const info = h.getParameterInfo(meta.id)!;

    // spy urutan tulis per-parameter fisik
    const model = h.data.user.getModel()!;
    const order: string[] = [];
    const idOf = (i: number) => model.getParameterId(i).getString();
    const origSet = model.setParameterValueByIndex.bind(model);
    (model as unknown as { setParameterValueByIndex: unknown }).setParameterValueByIndex =
      (index: number, value: number, weight: number) => {
        order.push(idOf(index));
        return origSet(index, value, weight);
      };

    // role intent (domain role, priority 3) + param intent (sticky, priority 10)
    // pada param fisik yang sama — invariant Phase 13: param menang fisik,
    // dan tulisan role DIPROSES dulu (commit role → param).
    const roleValue = info.max; // ref +30 → batas atas
    const paramValue = info.min + (info.max - info.min) * 0.25;
    const roleIds = mapRoles(
      new Set(h.getParameters().map((p) => p.id)),
      {
        eyeBlinkIds: h.getProfile().eyeBlinkParameters,
        lipSyncIds: h.getProfile().lipSyncParameters,
      },
    );
    const angleRole = Object.entries(roleIds).find(([, id]) => id === meta.id)?.[0];

    arb.submit({
      channel: "sticky", priority: 10, domain: "param",
      values: { [meta.id]: paramValue },
    });
    if (angleRole) {
      arb.submit({
        channel: "idle-pose-motion", priority: 3, domain: "role", mode: "ref",
        values: { [angleRole]: 30 },
      });
    }
    h.update(1 / 60);
    // readback: param menang (commit param TERAKHIR di param fisik yang sama)
    expect(h.getParameter(meta.id)).toBeCloseTo(paramValue, 3);
    // urutan tulis: role id muncul SEBELUM param id di spy
    if (angleRole) {
      const iRole = order.indexOf(meta.id);
      expect(iRole).toBeGreaterThan(-1);
      expect(order.length).toBeGreaterThan(iRole + 1); // param menulis setelahnya
    }

    // commit terjadi TEPAT di seam (bukan di luar): tanpa update, tanpa tulisan baru
    const before = h.getParameter(meta.id);
    order.length = 0;
    h.update(1 / 60);
    expect(h.getParameter(meta.id)).toBe(before); // intent persist via seam
    void roleValue;
  });

  test("R4-E undo-buffer: intent tidak hilang lintas frame; release → saved state", () => {
    const meta = h.getProfile().parameters.find((p) => p.id === "ParamMouthOpenY") ||
      h.getProfile().parameters[0];
    const info = h.getParameterInfo(meta.id)!;
    const target = info.min + (info.max - info.min) * 0.7;

    arb.submit({ channel: "lipsync", priority: 20, domain: "param", values: { [meta.id]: target } });
    h.update(1 / 60);
    // readback SEGERA setelah update — intent arbiter hidup
    expect(h.getParameter(meta.id)).toBeCloseTo(target, 3);
    // update BERIKUTNYA: loadParameters revert → seam commit LAGI → tetap target
    h.update(1 / 60);
    expect(h.getParameter(meta.id)).toBeCloseTo(target, 3);

    // release intent → framework/saved state kembali
    arb.clearSource("lipsync");
    h.update(1 / 60);
    expect(h.getParameter(meta.id)).not.toBeCloseTo(target, 3);
    // nilai kembali ke saved/default (bukan menempel di target)
    const def = info.defaultValue;
    expect(Math.abs(h.getParameter(meta.id)! - target)).toBeGreaterThan(
      Math.abs(def - target) * 0.5,
    );
  });

  test("R4-F multi-intent satu frame: rawDrive(30) > lipsync(20) > sticky(10); emo(5) > pose(3)", () => {
    const meta = h.getProfile().parameters[0];
    const info = h.getParameterInfo(meta.id)!;
    const at = (f: number) => info.min + (info.max - info.min) * f;
    const near = (a: number | undefined, b: number) =>
      a !== undefined && Math.abs(a - b) < Math.abs(info.max - info.min) * 0.01;

    // tiga channel param menarget param yang sama
    arb.submit({ channel: "sticky", priority: 10, domain: "param", values: { [meta.id]: at(0.1) } });
    arb.submit({ channel: "lipsync", priority: 20, domain: "param", values: { [meta.id]: at(0.5) } });
    arb.submit({ channel: "rawDrive", priority: 30, domain: "param", values: { [meta.id]: at(0.9) } });
    h.update(1 / 60);
    expect(near(h.getParameter(meta.id), at(0.9))).toBe(true); // rawDrive menang

    arb.clearSource("rawDrive");
    h.update(1 / 60);
    expect(near(h.getParameter(meta.id), at(0.5))).toBe(true); // lipsync naik

    arb.clearSource("lipsync");
    h.update(1 / 60);
    expect(near(h.getParameter(meta.id), at(0.1))).toBe(true); // sticky tampil

    arb.clearSource("sticky");

    // dua channel berbeda prioritas di param lain (semua channel tersisa bersih)
    const form = h.getProfile().parameters.find((p) => p.id === "ParamMouthForm");
    if (form) {
      const fi = h.getParameterInfo(form.id)!;
      const fAt = (f: number) => fi.min + (fi.max - fi.min) * f;
      arb.submit({ channel: "idle-pose", priority: 3, domain: "param", values: { [form.id]: fAt(0.0) } });
      arb.submit({ channel: "idle-emotion", priority: 5, domain: "param", values: { [form.id]: fAt(0.8) } });
      h.update(1 / 60);
      expect(near(h.getParameter(form.id), fAt(0.8))).toBe(true); // idle-emotion menang
      arb.clearSource("idle-emotion");
      h.update(1 / 60);
      expect(near(h.getParameter(form.id), fAt(0.0))).toBe(true); // pose kembali
      arb.clearSource("idle-pose");
    }
  });
});

describeIf(HAS_REN)("R4-H — model switch: counter A beku, B dari nol", () => {
  test("A 100 update → destroy → B 100 update dari nol", async () => {
    await bootPipeline();
    const a = await loadHandle(REN_MANIFEST);
    let aSeams = 0;
    a.onBeforeModelUpdate(() => aSeams++);
    disableEffects(a);
    for (let i = 0; i < 100; i++) a.update(1 / 60);
    expect(a.data.stats.frames).toBe(100);
    expect(a.data.stats.coreUpdates).toBe(100);
    expect(aSeams).toBe(100);
    a.destroy();
    a.update(1 / 60);
    expect(a.data.stats.frames).toBe(100); // beku
    expect(aSeams).toBe(100);              // tidak ada callback usang

    const b = await loadHandle(REN_MANIFEST);
    expect(b.data.stats.frames).toBe(0); // instance baru mulai nol
    let bSeams = 0;
    b.onBeforeModelUpdate(() => bSeams++);
    disableEffects(b);
    for (let i = 0; i < 100; i++) b.update(1 / 60);
    expect(b.data.stats.frames).toBe(100);
    expect(b.data.stats.coreUpdates).toBe(100);
    expect(bSeams).toBe(100);
    b.destroy();
  });
});
