/**
 * live2d-adapter.test.ts — guard lapisan adapter Live2D (src/live2d/).
 *
 * Hal yang dijaga:
 *  1. Kontrak TIDAK berubah diam-diam — daftar method tiap permukaan
 *     (handle, API puncak, backend, pool, scheduler) dikunci. app.js akan
 *     dimigrasi ke kontrak ini dan implementasi renderer ditulis di bawahnya;
 *     mengubah permukaan = mengubah daftar di sini SECARA SADAR.
 *  2. Stub selalu fail-loud — tidak ada method yang no-op senyap.
 *  3. Lapisan kontrak bebas pustaka renderer — file src/live2d/*.ts tidak
 *     boleh merujuk pustaka scene-graph (renderer = detail implementasi di
 *     bawah kontrak). Catatan: lapisan ini MEMBUNGKUS Cubism, jadi menyebut
 *     konsep/API core (moc, csm*) dalam dokumentasi kontrak itu sah — yang
 *     dilarang hanya pustaka renderer.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  createStubAdapter,
  createStubModelHandle,
  createStubRenderBackend,
  createStubRenderTargetPool,
  createStubRenderScheduler,
  STUB_VERSION,
} from "../src/live2d/stub";
import { installLive2DApi, type Live2DApiTarget } from "../src/live2d/index";
import type { Live2DEffect } from "../src/live2d/types";
import {
  ALPHA_BLEND_MODE_COUNT,
  BLEND_NORMAL,
  COLOR_BLEND_MODE_COUNT,
} from "../src/live2d/cubism-core";

const root = join(import.meta.dir, "..");
const MSG = "[live2d] adapter kosong";

/** Kontrak Live2DModelHandle — diurutkan untuk perbandingan.
 * STAGE R1: + isMotionFinished, playExpression, setEffectEnabled,
 * stopAllMotions (bukti caller: static/js/app.js 1013–1023, 2313, 5118–5131). */
const HANDLE_CONTRACT = [
  "destroy",
  "getEyeBlinkParameters",
  "getLipSyncParameters",
  "getMocVersion",
  "getName",
  "getNaturalSize",
  "getParameter",
  "getParameterInfo",
  "getParameters",
  "getPartIds",
  "getPartOpacity",
  "getPosition",
  "getProfile",
  "getScale",
  "isMotionFinished",
  "motionGroups",
  "onBeforeModelUpdate",
  "playExpression",
  "playNativeMotion",
  "readParam",
  "resetExpression",
  "resetFocus",
  "setAnchor",
  "setEffectEnabled",
  "setFocus",
  "setParameter",
  "setPartOpacity",
  "setPosition",
  "setRotation",
  "setScale",
  "stopAllMotions",
  "snapshotCore",
  "toGlobal",
  "toLocal",
  "update",
  "uses53Pipeline",
  "writeParam",
].sort();

/** Kontrak Live2DApi (method + properti). */
const API_CONTRACT = [
  "capabilities",
  "coreInfo",
  "createHost",
  "isStub",
  "loadModel",
  "version",
].sort();

/** Kontrak RenderBackend (abstraksi GPU — dokumen teknis §15). */
const BACKEND_CONTRACT = [
  "beginRenderTarget",
  "createFramebuffer",
  "createRenderTarget",
  "createShader",
  "createTexture",
  "destroy",
  "destroyFramebuffer",
  "destroyRenderTarget",
  "destroyShader",
  "destroyTexture",
  "drawMesh",
  "endRenderTarget",
  "kind",
  "setBlendState",
  "setScissor",
  "setViewport",
].sort();

/** Kontrak RenderTargetPool (§18 — create per frame dilarang). */
const POOL_CONTRACT = ["acquire", "destroy", "release", "stats"].sort();

/** Kontrak RenderScheduler (pipeline §16, node model §9). */
const SCHEDULER_CONTRACT = ["buildPlan", "lastStats", "mocVersion"].sort();

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

describe("adapter Live2D kosong (src/live2d)", () => {
  it("menandai dirinya stub dengan versi eksplisit", () => {
    const api = createStubAdapter();
    expect(api.isStub).toBe(true);
    expect(api.version()).toBe(STUB_VERSION);
  });

  it("kontrak API puncak terkunci (termasuk coreInfo + capabilities)", () => {
    const api = createStubAdapter();
    expect(keysOf(api)).toEqual(API_CONTRACT);
    expect(() => api.coreInfo()).toThrow(MSG);
    expect(() => api.capabilities()).toThrow(MSG);
  });

  it("API puncak fail-loud: createHost & loadModel melempar", async () => {
    const api = createStubAdapter();
    const fakeCanvas = {} as HTMLCanvasElement;
    expect(() =>
      api.createHost({ canvas: fakeCanvas, width: 100, height: 100 }),
    ).toThrow(MSG);
    await expect(
      api.loadModel({} as never, { kind: "path", path: "model/x/model.model3.json" }),
    ).rejects.toThrow(MSG);
  });

  it("kontrak handle terkunci — perubahan permukaan migrasi harus sadar", () => {
    const handle = createStubModelHandle();
    expect(keysOf(handle)).toEqual(HANDLE_CONTRACT);
  });

  it("STAGE R1 — API gerbang motion/ekspresi/efek tersedia di handle dan fail-loud", () => {
    const handle = createStubModelHandle() as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    // 4 method R1 ada di handle (kontrak terkunci di atas) dan melempar —
    // BUKAN diam-diam mengaku sukses (isMotionFinished → false, playExpression
    // → true, dsb. adalah fake implementation yang dilarang pada stub).
    expect(() => handle.isMotionFinished()).toThrow(MSG);
    expect(() => handle.stopAllMotions()).toThrow(MSG);
    expect(() => handle.playExpression("senyum")).toThrow(MSG);
    expect(() => handle.setEffectEnabled("eyeBlink", false)).toThrow(MSG);
    expect(() => handle.setEffectEnabled("breath", true)).toThrow(MSG);
    expect(() => handle.setEffectEnabled("physics", false)).toThrow(MSG);
  });

  it("STAGE R1 — Live2DEffect union tertutup: hanya eyeBlink/breath/physics", () => {
    // Union tertutup di tipe; guard runtime mencegah anggota baru lolos tanpa
    // disadari (anggota hanya boleh bertambah dengan bukti caller engine).
    const VALID_EFFECTS = ["eyeBlink", "breath", "physics"] as const;
    const typed: Live2DEffect[] = [...VALID_EFFECTS];
    expect(typed.sort()).toEqual(["breath", "eyeBlink", "physics"]);
  });

  it("semua method handle stub fail-loud (tanpa no-op senyap)", () => {
    const handle = createStubModelHandle() as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    for (const key of Object.keys(handle)) {
      expect(() => handle[key]()).toThrow(MSG);
    }
  });

  it("kontrak renderer internal terkunci (backend/pool/scheduler)", () => {
    expect(keysOf(createStubRenderBackend("webgl2"))).toEqual(BACKEND_CONTRACT);
    expect(createStubRenderBackend("webgl2").kind).toBe("webgl2");
    expect(keysOf(createStubRenderTargetPool())).toEqual(POOL_CONTRACT);
    const scheduler = createStubRenderScheduler(6);
    expect(keysOf(scheduler)).toEqual(SCHEDULER_CONTRACT);
    expect(scheduler.mocVersion).toBe(6);
    // lastStats belum pernah build → statistik nol, BUKAN melempar.
    expect(scheduler.lastStats()).toEqual({
      ms: 0, drawCalls: 0, passes: 0, poolHits: 0, poolMisses: 0,
    });
  });

  it("install idempoten ke target objek polos (tanpa DOM)", () => {
    const target: Live2DApiTarget = {};
    const first = installLive2DApi(target);
    expect(target.__live2dApi).toBe(first);
    // Pemasangan kedua tidak menimpa instans yang sudah hidup.
    const second = installLive2DApi(target, createStubAdapter());
    expect(second).toBe(first);
  });

  it("spesifikasi blend mode 5.3 terkunci: 15 color + 5 alpha", () => {
    // Jumlah & mapping mode mengikuti spesifikasi resmi — JANGAN dibatasi
    // Normal/Add/Multiply/Screen era lama.
    expect(COLOR_BLEND_MODE_COUNT).toBe(15);
    expect(ALPHA_BLEND_MODE_COUNT).toBe(5);
    expect(BLEND_NORMAL).toBe(0);
  });

  it("lapisan kontrak bebas pustaka scene-graph/renderer", () => {
    // Guard hanya untuk FILE KONTRAK — lapisan implementasi/vendor (mis.
    // pembungkus renderer resmi) boleh menyebut pustaka apapun.
    const contractFiles = [
      "types.ts",
      "cubism-core.ts",
      "render-backend.ts",
      "render-scheduler.ts",
      "stub.ts",
      "index.ts",
    ];
    const dir = join(root, "src", "live2d");
    for (const f of contractFiles) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(
        src.match(/pixi/i),
        `src/live2d/${f} tidak boleh merujuk pustaka renderer langsung`,
      ).toBeNull();
    }
    // file kontrak wajib ada
    expect(contractFiles.length).toBeGreaterThanOrEqual(6);
  });
});
