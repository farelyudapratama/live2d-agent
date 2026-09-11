/**
 * live2d-adapter.test.ts — guard lapisan adapter Live2D (src/live2d/).
 *
 * Tiga hal yang dijaga:
 *  1. Kontrak TIDAK berubah diam-diam — daftar method handle/API dikunci.
 *     app.js akan dimigrasi ke kontrak ini; perubahan harus sadar (update
 *     daftar di sini berarti mengubah permukaan migrasi).
 *  2. Stub selalu fail-loud — tidak ada method yang no-op senyap.
 *  3. Lapisan kontrak bebas renderer — file src/live2d/*.ts tidak boleh
 *    menyebut/memakai pustaka scene-graph atau core; renderer adalah detail
 *    implementasi DI BAWAH kontrak (aturan bebas-renderer di types.ts).
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  createStubAdapter,
  createStubModelHandle,
  STUB_VERSION,
} from "../src/live2d/stub";
import { installLive2DApi, type Live2DApiTarget } from "../src/live2d/index";

const root = join(import.meta.dir, "..");
const MSG = "[live2d] adapter kosong";

/** Kontrak Live2DModelHandle yang dijamin ada — diurutkan untuk perbandingan. */
const HANDLE_CONTRACT = [
  "destroy",
  "getEyeBlinkParameters",
  "getLipSyncParameters",
  "getName",
  "getNaturalSize",
  "getPosition",
  "getScale",
  "motionGroups",
  "onBeforeModelUpdate",
  "playNativeMotion",
  "readParam",
  "resetExpression",
  "resetFocus",
  "setAnchor",
  "setFocus",
  "setPosition",
  "setRotation",
  "setScale",
  "toGlobal",
  "toLocal",
  "writeParam",
].sort();

describe("adapter Live2D kosong (src/live2d)", () => {
  it("menandai dirinya stub dengan versi eksplisit", () => {
    const api = createStubAdapter();
    expect(api.isStub).toBe(true);
    expect(api.version()).toBe(STUB_VERSION);
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
    expect(Object.keys(handle).sort()).toEqual(HANDLE_CONTRACT);
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

  it("install idempoten ke target objek polos (tanpa DOM)", () => {
    const target: Live2DApiTarget = {};
    const first = installLive2DApi(target);
    expect(target.__live2dApi).toBe(first);
    // Pemasangan kedua tidak menimpa instans yang sudah hidup.
    const second = installLive2DApi(target, createStubAdapter());
    expect(second).toBe(first);
  });

  it("lapisan kontrak bebas renderer/pustaka scene-graph", () => {
    const dir = join(root, "src", "live2d");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(
        src.match(/pixi|live2dcubismcore|csmGet/i),
        `src/live2d/${f} tidak boleh merujuk pustaka renderer/core langsung`,
      ).toBeNull();
    }
  });
});
