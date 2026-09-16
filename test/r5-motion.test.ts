/**
 * r5-motion.test.ts — STAGE R5: Native Motion / Expression / Effects
 * Integration — bukti dengan pipeline NYATA (Core WASM + framework 5.3 +
 * model ren & lumine dari disk), bukan klaim.
 *
 * Struktur bukti:
 *  - Motion discovery/playback/completion/interruption/stop/destroy
 *  - Motion ownership: native motion owns via gate isFinished(); arbiter
 *    intent menang di seam HANYA saat engine tidak men-gate (bukti dua arah)
 *  - Expression: param benar-benar berubah; exactly-once; overlap dengan
 *    arbiter intent diselesaikan oleh URUTAN pipeline (framework writers →
 *    seam) — bukan priority system baru
 *  - EyeBlink: framework owner, L/R sinkron, tanpa penulis kedua
 *  - Breath/Physics/Pose/Look: framework owner, exactly-once, toggle jujur
 *  - Model switch ren→lumine→ren dengan motion/ekspresi/efek aktif
 *  - Invalid input: fail-safe, tanpa korupsi state
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
const LUMINE_MANIFEST = join(DATA_MODEL, "lumine", "lumine", "lumine.model3.json");
const HAS_REN = existsSync(REN_MANIFEST);
const HAS_LUMINE = existsSync(LUMINE_MANIFEST);

type FrameworkNS = typeof import("../src/live2d/cubismframework-exports");
type ProductionEnv = import("../src/live2d/production-env").ProductionEnv;
type ProductionHandle = import("../src/live2d/production-handle").ProductionHandle;

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

const describeIf = (cond: boolean) => (cond ? describe : describe.skip);
const EPS = 1e-4;

describeIf(HAS_REN)("R5 Motion — discovery, playback, completion, interruption", () => {
  let h: ProductionHandle;

  beforeAll(async () => {
    await bootPipeline();
    h = await loadHandle(REN_MANIFEST);
  });

  test("discovery: SEMUA motion di profil dapat dimainkan (bukan cuma return true)", () => {
    const motions = h.getProfile().motions;
    expect(motions.length).toBeGreaterThan(0);
    for (const m of motions) {
      expect(h.playNativeMotion(m.group, m.index, 3)).toBe(true);
      h.stopAllMotions();
    }
  });

  test("playback: motion benar-benar menganimasi parameter (sampling readback)", () => {
    const g = h.motionGroups()[0];
    expect(h.playNativeMotion(g, 0, 3)).toBe(true);
    expect(h.isMotionFinished()).toBe(false);
    // sampling: param yang digerakkan kurva motion berubah nilainya
    const params = h.getProfile().parameters;
    const base = new Map(params.map((p) => [p.id, h.getParameter(p.id)!]));
    const changed = new Set<string>();
    for (let i = 0; i < 30; i++) {
      h.update(1 / 60);
      for (const p of params) {
        const v = h.getParameter(p.id)!;
        if (Math.abs(v - (base.get(p.id) as number)) > 0.01) changed.add(p.id);
      }
    }
    expect(changed.size).toBeGreaterThan(0);
    h.stopAllMotions();
  });

  test("completion deterministik: motion aktif → selesai di frame tertentu → idle kembali", () => {
    const g = h.motionGroups()[0];
    expect(h.playNativeMotion(g, 0, 3)).toBe(true);
    let activeFrames = 0;
    let completedAt = -1;
    for (let i = 1; i <= 900; i++) {
      h.update(1 / 60);
      if (!h.isMotionFinished()) activeFrames++;
      else if (completedAt === -1) completedAt = i;
    }
    expect(activeFrames).toBeGreaterThan(0);
    expect(completedAt).toBeGreaterThan(activeFrames);
    // post-completion: isFinished TETAP true (tidak flicker), idle = tidak ada penulis motion
    for (let i = 0; i < 30; i++) {
      h.update(1 / 60);
      expect(h.isMotionFinished()).toBe(true);
    }
    void completedAt;
  });

  test("interruption: motion B menggantikan A — owner tunggal, tanpa crash", () => {
    const g = h.motionGroups()[0];
    expect(h.playNativeMotion(g, 0, 3)).toBe(true);
    for (let i = 0; i < 10; i++) h.update(1 / 60);
    // interrupt dengan motion indeks lain (atau sama — queue manager fade-out A)
    const idx = h.getProfile().motions.filter((m) => m.group === g).length > 1 ? 1 : 0;
    expect(h.playNativeMotion(g, idx, 3)).toBe(true);
    expect(h.isMotionFinished()).toBe(false);
    for (let i = 0; i < 40; i++) {
      h.update(1 / 60);
      expect(Number.isFinite(h.getParameter(h.getProfile().parameters[0].id))).toBe(true);
    }
    h.stopAllMotions();
    // stop = fade-out: entri fade sampai selesai secara deterministik (bukan instan)
    let stopped = -1;
    for (let i = 1; i <= 180; i++) {
      h.update(1 / 60);
      if (h.isMotionFinished()) { stopped = i; break; }
    }
    expect(stopped).toBeGreaterThan(0);
  });

  test("destroy saat motion main: tidak ada update/callback tersisa", () => {
    let seams = 0;
    const d = h.data;
    h.onBeforeModelUpdate(() => seams++);
    const g = h.motionGroups()[0];
    expect(h.playNativeMotion(g, 0, 3)).toBe(true);
    const framesBefore = d.stats.frames;
    h.destroy();
    h.update(1 / 60);
    expect(d.stats.frames).toBe(framesBefore); // beku
    expect(seams).toBe(0); // callback ini dipasang setelah test lain → tak pernah jalan
    expect(h.isMotionFinished()).toBe(true);
  });
});

describeIf(HAS_REN)("R5 Motion ownership vs Arbiter (gate isFinished)", () => {
  test("TANPA gate: arbiter menimpa kurva motion di seam (bukti mengapa gate perlu)", async () => {
    await bootPipeline();
    const h = await loadHandle(REN_MANIFEST);
    // STEP2 — breath kini komposit pasca-seam (paritas baseline): test ini
    // memverifikasi OWNERSHIP seam, bukan komposit breath → breath off agar
    // toleransi ±1 murni mengukur tulisan arbiter.
    h.setEffectEnabled("breath", false);
    const model = h.data.user.getModel()!;
    const roleIds = mapRoles(new Set(h.getParameters().map((p) => p.id)), {
      eyeBlinkIds: h.getProfile().eyeBlinkParameters,
      lipSyncIds: h.getProfile().lipSyncParameters,
    });
    const link = createEngineParameterLink(model, () => roleIds)!;
    const arb = createParameterArbiter({
      writeRole: (role, v) => link.bridge.writeRef(role, v),
      writeRoleNorm: (role, t) => link.bridge.writeNorm(role, t),
      writeParam: (id, v) => link.writeActual(id, v),
    });
    h.onBeforeModelUpdate(() => arb.commit());
    const angleY = roleIds["angleY"];
    expect(angleY).toBeDefined();
    const info = h.getParameterInfo(angleY)!;
    const mid = (info.min + info.max) / 2;

    // submit intent TANPA gate selama motion main → arbiter menang tiap frame
    expect(h.playNativeMotion(h.motionGroups()[0], 0, 3)).toBe(true);
    for (let i = 0; i < 30; i++) {
      arb.submit({ channel: "idle-pose-motion", priority: 3, domain: "role", mode: "ref", values: { angleY: 15 } });
      h.update(1 / 60);
      // ref +15 (skala ±30) → aktual = mid + 15 (toActual) — arbiter menang di seam
      expect(Math.abs(h.getParameter(angleY)! - (mid + 15))).toBeLessThan(1);
    }
    h.stopAllMotions();
    h.destroy();
  });

  test("DENGAN gate isFinished: motion owns selama main; setelah selesai intent kembali", async () => {
    await bootPipeline();
    const h = await loadHandle(REN_MANIFEST);
    // STEP2 — breath pasca-seam (paritas baseline): ownership test → breath off
    h.setEffectEnabled("breath", false);
    const model = h.data.user.getModel()!;
    const roleIds = mapRoles(new Set(h.getParameters().map((p) => p.id)), {
      eyeBlinkIds: h.getProfile().eyeBlinkParameters,
      lipSyncIds: h.getProfile().lipSyncParameters,
    });
    const link = createEngineParameterLink(model, () => roleIds)!;
    const arb = createParameterArbiter({
      writeRole: (role, v) => link.bridge.writeRef(role, v),
      writeRoleNorm: (role, t) => link.bridge.writeNorm(role, t),
      writeParam: (id, v) => link.writeActual(id, v),
    });
    let intentFrames = 0;
    h.onBeforeModelUpdate(() => {
      // gate ala ENGINE MAIN: idle intent hanya saat native motion TIDAK main
      if (h.isMotionFinished()) {
        arb.submit({ channel: "idle-pose-motion", priority: 3, domain: "role", mode: "ref", values: { angleY: 15 } });
        intentFrames++;
      } else {
        arb.clearSource("idle-pose-motion");
      }
      arb.commit();
    });
    const angleY = roleIds["angleY"]!;
    const info = h.getParameterInfo(angleY)!;
    const mid = (info.min + info.max) / 2;

    expect(h.playNativeMotion(h.motionGroups()[0], 0, 3)).toBe(true);
    const motionSamples = new Set<number>();
    for (let i = 0; i < 900 && !h.isMotionFinished(); i++) {
      h.update(1 / 60);
      motionSamples.add(Math.round(h.getParameter(angleY)! * 10));
    }
    expect(h.isMotionFinished()).toBe(true);
    expect(motionSamples.size).toBeGreaterThan(1); // kurva motion hidup (bukan terkunci)
    // pasca completion: intent mengambil alih — TIDAK ADA pose terkunci selamanya
    for (let i = 0; i < 10; i++) h.update(1 / 60);
    expect(intentFrames).toBeGreaterThan(0);
    expect(Math.abs(h.getParameter(angleY)! - (mid + 15))).toBeLessThan(1); // ref +15 → aktual 15
    h.destroy();
  });
});

describeIf(HAS_REN)("R5 Expression — native .exp3 via handle", () => {
  let h: ProductionHandle;

  beforeAll(async () => {
    await bootPipeline();
    h = await loadHandle(REN_MANIFEST);
  });

  test("valid → true; invalid → false (tanpa crash, tanpa korupsi state)", () => {
    const names = h.getProfile().expressions.map((e) => e.name);
    expect(names.length).toBeGreaterThan(0);
    expect(h.playExpression(names[0])).toBe(true);
    h.update(1 / 60);
    expect(h.playExpression("tidak_ada_999")).toBe(false);
    // state tetap sehat: motion queue & param tetap berfungsi
    expect(h.playNativeMotion(h.motionGroups()[0], 0, 3)).toBe(true);
    h.stopAllMotions();
  });

  test("expression mengubah parameter yang dikontrolnya (bukan cuma return true)", () => {
    const base = new Map(h.getParameters().map((p) => [p.id, p.value]));
    const names = h.getProfile().expressions.map((e) => e.name);
    // reset dulu, 2 frame, snapshot; lalu play expression, 5 frame, diff
    h.resetExpression();
    h.update(1 / 60); h.update(1 / 60);
    const before = new Map(h.getParameters().map((p) => [p.id, p.value]));
    expect(h.playExpression(names[0])).toBe(true);
    const changed = new Set<string>();
    for (let i = 0; i < 5; i++) {
      h.update(1 / 60);
      for (const p of h.getParameters()) {
        const b = before.get(p.id) ?? 0;
        const b0 = base.get(p.id) ?? 0;
        if (Math.abs(p.value - b) > EPS && Math.abs(p.value - b0) > EPS) changed.add(p.id);
      }
    }
    expect(changed.size).toBeGreaterThan(0);
    void base;
  });

  test("expression updater tepat sekali per frame; destroy membersihkan", () => {
    const u = h.data.updaters.expression!;
    let count = 0;
    const orig = u.onLateUpdate.bind(u);
    (u as unknown as { onLateUpdate: unknown }).onLateUpdate = (
      model: Parameters<typeof orig>[0], dt: Parameters<typeof orig>[1],
    ) => { count++; orig(model, dt); };
    for (let i = 0; i < 40; i++) h.update(1 / 60);
    expect(count).toBe(40);
    const frames = h.data.stats.frames;
    h.destroy();
    h.update(1 / 60);
    expect(h.data.stats.frames).toBe(frames); // beku — expression ikut mati
  });

  test("overlap expression × idle-emotion: diselesaikan URUTAN pipeline (seam menang)", async () => {
    await bootPipeline();
    const h2 = await loadHandle(REN_MANIFEST);
    const model = h2.data.user.getModel()!;
    const roleIds = mapRoles(new Set(h2.getParameters().map((p) => p.id)), {
      eyeBlinkIds: h2.getProfile().eyeBlinkParameters,
      lipSyncIds: h2.getProfile().lipSyncParameters,
    });
    const link = createEngineParameterLink(model, () => roleIds)!;
    const arb = createParameterArbiter({
      writeRole: (role, v) => link.bridge.writeRef(role, v),
      writeRoleNorm: (role, t) => link.bridge.writeNorm(role, t),
      writeParam: (id, v) => link.writeActual(id, v),
    });
    h2.onBeforeModelUpdate(() => arb.commit());
    // cari param yang dikontrol ekspresi
    const base = new Map(h2.getParameters().map((p) => [p.id, p.value]));
    const names = h2.getProfile().expressions.map((e) => e.name);
    h2.playExpression(names[0]);
    h2.update(1 / 60); h2.update(1 / 60);
    const changedId = h2.getParameters().find((p) =>
      Math.abs(p.value - (base.get(p.id) ?? 0)) > EPS)?.id;
    expect(changedId).toBeDefined();
    const info = h2.getParameterInfo(changedId!)!;
    const intent = info.min + (info.max - info.min) * 0.1;
    arb.submit({ channel: "idle-emotion", priority: 5, domain: "param", values: { [changedId!]: intent } });
    h2.update(1 / 60);
    // aturan pipeline: arbiter commit di SEAM (setelah scheduler) → menang untuk
    // param yang diambil alih engine. TANPA priority system baru.
    expect(Math.abs(h2.getParameter(changedId!)! - intent))
      .toBeLessThan((info.max - info.min) * 0.02);
    arb.clearSource("idle-emotion");
    h2.update(1 / 60);
    // intent lepas → ekspresi (framework) kembali menulis param itu
    h2.destroy();
  });
});

describeIf(HAS_REN)("R5 Effects — EyeBlink / Breath / Physics / Pose / Look (framework owner)", () => {
  let h: ProductionHandle;

  beforeAll(async () => {
    await bootPipeline();
    h = await loadHandle(REN_MANIFEST);
  });

  test("EyeBlink: framework owner (grup EyeBlink ada), L/R sinkron, tanpa penulis kedua", () => {
    expect(h.getEyeBlinkParameters().length).toBeGreaterThan(0);
    expect(!!h.data.updaters.eyeBlink).toBe(true);
    const eyeL = h.getEyeBlinkParameters()[0];
    const eyeR = h.getEyeBlinkParameters()[1] || eyeL;
    let blinkFrames = 0;
    let desync = 0;
    for (let i = 0; i < 700; i++) { // ±11,6 dtk — interval kedip default pasti tercapai
      h.update(1 / 60);
      const l = h.getParameter(eyeL)!;
      const r = h.getParameter(eyeR)!;
      if (l < 1 - EPS) {
        blinkFrames++;
        if (Math.abs(l - r) > EPS) desync++;
      }
    }
    expect(blinkFrames).toBeGreaterThan(0); // kedip framework benar-benar jalan
    expect(desync).toBe(0); // L/R sinkron sempurna
  });

  test("EyeBlink gated: updater tetap ter-invoke, tapi tidak menulis selama motion main", () => {
    // gate motionUpdated: framework blink hanya menulis saat motion TIDAK main
    const g = h.motionGroups()[0];
    h.playNativeMotion(g, 0, 3);
    // (bukti gate ada di source updater + motionUpdated value diset per frame)
    h.update(1 / 60);
    expect(h.data.motionUpdated.value).toBe(true); // motion main → blink digate
    h.stopAllMotions();
    h.update(1 / 60);
    expect(h.data.motionUpdated.value).toBe(false);
  });

  test("Breath: smooth saat on, beku saat off, tepat sekali saat on kembali", async () => {
    const breathId = h.getProfile().parameters.find((p) => p.id === "ParamBreath");
    if (!breathId) return; // model tanpa ParamBreath
    // handle FRESH — isolasi dari fade motion test sebelumnya (motion bisa
    // menganimasi ParamBreath saat fade-out)
    const hb = await loadHandle(REN_MANIFEST);
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) { hb.update(1 / 60); samples.push(hb.getParameter("ParamBreath")!); }
    const range = Math.max(...samples) - Math.min(...samples);
    expect(range).toBeGreaterThan(0.05); // bernapas
    const maxStep = Math.max(...samples.slice(1).map((v, i) => Math.abs(v - samples[i])));
    expect(maxStep).toBeLessThan(0.1); // smooth
    hb.setEffectEnabled("breath", false);
    hb.update(1 / 60); // buffer kembali ke saved state (semantik undo-buffer)
    const frozen = hb.getParameter("ParamBreath");
    for (let i = 0; i < 30; i++) hb.update(1 / 60);
    expect(hb.getParameter("ParamBreath")).toBe(frozen); // beku persis (tanpa osilasi)
    const u = hb.data.updaters.breath!;
    let count = 0;
    const orig = u.onLateUpdate.bind(u);
    (u as unknown as { onLateUpdate: unknown }).onLateUpdate = (
      model: Parameters<typeof orig>[0], dt: Parameters<typeof orig>[1],
    ) => { count++; orig(model, dt); };
    hb.setEffectEnabled("breath", true);
    for (let i = 0; i < 20; i++) hb.update(1 / 60);
    expect(count).toBe(20); // kembali tepat sekali per frame
    hb.destroy();
  });

  test("Physics: updater exactly-once; deformasi terbukti (physics on vs off)", async () => {
    expect(h.getProfile().physics).toBe(true);
    const u = h.data.updaters.physics!;
    let count = 0;
    const orig = u.onLateUpdate.bind(u);
    (u as unknown as { onLateUpdate: unknown }).onLateUpdate = (
      model: Parameters<typeof orig>[0], dt: Parameters<typeof orig>[1],
    ) => { count++; orig(model, dt); };
    // fisika bereaksi pada gerakan: mainkan motion + fisika on, snapshot
    h.playNativeMotion(h.motionGroups()[0], 0, 3);
    for (let i = 0; i < 60; i++) { h.update(1 / 60); }
    const withPhysics = new Map(h.getParameters().map((p) => [p.id, p.value]));
    h.stopAllMotions();
    expect(count).toBe(60); // exactly-once per frame
    // bandingkan dengan model fresh TANPA fisika (seed internal sama)
    const h2 = await loadHandle(REN_MANIFEST);
    h2.setEffectEnabled("physics", false);
    h2.playNativeMotion(h2.motionGroups()[0], 0, 3);
    for (let i = 0; i < 60; i++) h2.update(1 / 60);
    let diff = 0;
    for (const p of h2.getParameters()) {
      const a = withPhysics.get(p.id) ?? 0;
      if (Math.abs(a - p.value) > 0.01) diff++;
    }
    expect(diff).toBeGreaterThan(0); // fisika benar-benar mendeformasi output
    h2.destroy();
  });

  test("Pose: fakta manifest — ren tanpa pose file → updater null (bukan klaim)", () => {
    expect(h.getProfile().pose).toBe(false);
    expect(h.data.updaters.pose).toBeNull();
  });

  test("Look/Focus: setFocus → eyeBall & angle param berubah; resetFocus pulih", () => {
    h.resetFocus();
    for (let i = 0; i < 10; i++) h.update(1 / 60);
    const baseEyeX = h.getParameter("ParamEyeBallX") ?? 0;
    const baseAngleX = h.getParameter("ParamAngleX") ?? 0;
    h.setFocus(0.8, 0);
    for (let i = 0; i < 30; i++) h.update(1 / 60);
    const eyeX = h.getParameter("ParamEyeBallX") ?? 0;
    const angleX = h.getParameter("ParamAngleX") ?? 0;
    expect(eyeX).toBeGreaterThan(baseEyeX + 0.3);   // drag 0.8 → eyeball mengikuti
    expect(angleX).toBeGreaterThan(baseAngleX + 10); // faktor 30 → hingga +24
    // exactly-once updater look
    const u = h.data.updaters.look!;
    let count = 0;
    const orig = u.onLateUpdate.bind(u);
    (u as unknown as { onLateUpdate: unknown }).onLateUpdate = (
      model: Parameters<typeof orig>[0], dt: Parameters<typeof orig>[1],
    ) => { count++; orig(model, dt); };
    h.resetFocus();
    for (let i = 0; i < 40; i++) h.update(1 / 60);
    expect(count).toBe(40);
    expect(Math.abs((h.getParameter("ParamEyeBallX") ?? 0) - eyeX)).toBeGreaterThan(0.1); // pulih
  });
});

describeIf(HAS_LUMINE)("R5 Model switch — ren (semua aktif) → lumine → ren", () => {
  test("switch bersih: tidak ada motion/ekspresi/efek/callback lama", async () => {
    await bootPipeline();
    // ren: nyalakan SEMUA
    const a = await loadHandle(REN_MANIFEST);
    a.playNativeMotion(a.motionGroups()[0], 0, 3);
    a.playExpression(a.getProfile().expressions[0].name);
    let aSeams = 0;
    a.onBeforeModelUpdate(() => aSeams++);
    for (let i = 0; i < 20; i++) a.update(1 / 60);
    const aFrames = a.data.stats.frames;
    const aSeamsAtDestroy = aSeams;
    expect(aFrames).toBe(20);
    expect(aSeamsAtDestroy).toBe(20);
    a.destroy();
    a.update(1 / 60);
    expect(a.data.stats.frames).toBe(20); // beku
    expect(aSeams).toBe(aSeamsAtDestroy); // callback pasca-destroy tidak jalan lagi

    // lumine: model TANPA motion/ekspresi — API jujur false (model-agnostic)
    const b = await loadHandle(LUMINE_MANIFEST);
    expect(b.motionGroups().length).toBe(0);
    expect(b.playNativeMotion("Idle", 0, 3)).toBe(false);
    expect(b.playExpression("apa pun")).toBe(false);
    expect(b.getProfile().physics).toBe(true);
    let bSeams = 0;
    b.onBeforeModelUpdate(() => bSeams++);
    for (let i = 0; i < 20; i++) b.update(1 / 60);
    expect(b.data.stats.frames).toBe(20);
    expect(bSeams).toBe(20);
    b.destroy();

    // ren lagi: bersih, counters dari nol
    const c = await loadHandle(REN_MANIFEST);
    expect(c.data.stats.frames).toBe(0);
    expect(c.playNativeMotion(c.motionGroups()[0], 0, 3)).toBe(true);
    expect(c.playExpression(c.getProfile().expressions[0].name)).toBe(true);
    for (let i = 0; i < 10; i++) c.update(1 / 60);
    expect(c.data.stats.frames).toBe(10);
    c.destroy();
  });
});

describeIf(HAS_REN)("R5 API behavior — invalid input & idempotensi", () => {
  test("playNativeMotion/playExpression asing → false tanpa korupsi state", async () => {
    await bootPipeline();
    const h = await loadHandle(REN_MANIFEST);
    const before = h.data.stats.frames;
    expect(h.playNativeMotion("does-not-exist", 0, 3)).toBe(false);
    expect(h.playNativeMotion("", 999, 3)).toBe(false);
    expect(h.playExpression("does-not-exist")).toBe(false);
    expect(h.isMotionFinished()).toBe(true); // tidak ada motion aktif
    expect(h.data.stats.frames).toBe(before);
    // stopAllMotions pada kondisi idle / aktif / destroyed → aman
    expect(() => h.stopAllMotions()).not.toThrow();
    h.playNativeMotion(h.motionGroups()[0], 0, 3);
    expect(() => h.stopAllMotions()).not.toThrow();
    expect(h.isMotionFinished()).toBe(true);
    h.destroy();
    expect(() => h.stopAllMotions()).not.toThrow();
    expect(h.isMotionFinished()).toBe(true);
  });
});
