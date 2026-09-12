/**
 * live2d/stub.ts — adapter KOSONG, fail-loud.
 *
 * Dipasang sekarang supaya seam arsitektur (app.js → API ini → Cubism) nyata
 * dan bisa dites, padahal implementasi renderer belum ada. app.js legacy masih
 * lewat pustaka lama langsung sampai migrasi dimulai — tidak ada yang memanggil
 * adapter ini di jalur hidup.
 *
 * Aturan: method yang belum diimplementasikan MELEMPAR, bukan no-op senyap
 * (budaya fail-loud repo — lihat shim override/bridge lain). Implementasi
 * parsial kelak harus mengganti stub per-method secara eksplisit, jadi lupa
 * mengimplementasikan sesuatu selalu terlihat di console, bukan jadi bug diam.
 */

import type {
  CoreInfo,
  CoreModelSnapshot,
  HostOptions,
  Live2DApi,
  Live2DHost,
  Live2DModelHandle,
  Live2DPoint,
  ModelSource,
  RendererCapabilities,
} from "./types";
import type {
  FramebufferHandle,
  MeshDrawCall,
  BlendState,
  RenderBackend,
  RenderTarget,
  RenderTargetPool,
  ShaderHandle,
  TextureHandle,
  TextureSource,
  BackendKind,
} from "./render-backend";
import type {
  FrameStats,
  RenderPlan,
  RenderScheduler,
} from "./render-scheduler";

export const STUB_VERSION = "0.0.0-stub";

function belum(api: string): never {
  throw new Error(
    "[live2d] adapter kosong — " + api + " belum diimplementasikan (src/live2d/)",
  );
}

/** Handle stub: kontrak lengkap, semua method fail-loud. Diekspor untuk
 * guard test kontrak (daftar method dijamin ada walau belum ada implementasi). */
export function createStubModelHandle(): Live2DModelHandle {
  return {
    getMocVersion: () => belum("getMocVersion"),
    uses53Pipeline: () => belum("uses53Pipeline"),
    getPosition: () => belum("getPosition"),
    setPosition: () => belum("setPosition"),
    getScale: () => belum("getScale"),
    setScale: () => belum("setScale"),
    setAnchor: () => belum("setAnchor"),
    getNaturalSize: () => belum("getNaturalSize"),
    setRotation: () => belum("setRotation"),
    toGlobal: (_point: Live2DPoint) => belum("toGlobal"),
    toLocal: (_point: Live2DPoint) => belum("toLocal"),
    readParam: (_id: string) => belum("readParam"),
    writeParam: (_id: string, _value: number, _weight?: number) =>
      belum("writeParam"),
    getParameters: () => belum("getParameters"),
    getParameter: (_id: string) => belum("getParameter"),
    getParameterInfo: (_id: string) => belum("getParameterInfo"),
    setParameter: (_id: string, _value: number) => belum("setParameter"),
    getPartIds: () => belum("getPartIds"),
    getPartOpacity: (_id: string) => belum("getPartOpacity"),
    setPartOpacity: (_id: string, _opacity: number) => belum("setPartOpacity"),
    onBeforeModelUpdate: (_cb: () => void) => belum("onBeforeModelUpdate"),
    motionGroups: () => belum("motionGroups"),
    playNativeMotion: (_group: string, _index?: number, _priority?: number) =>
      belum("playNativeMotion"),
    resetExpression: () => belum("resetExpression"),
    setFocus: (_x: number, _y: number) => belum("setFocus"),
    resetFocus: () => belum("resetFocus"),
    getName: () => belum("getName"),
    getEyeBlinkParameters: () => belum("getEyeBlinkParameters"),
    getLipSyncParameters: () => belum("getLipSyncParameters"),
    snapshotCore: () => belum("snapshotCore"),
    destroy: () => belum("destroy"),
  };
}

export function createStubAdapter(): Live2DApi {
  return {
    version: () => STUB_VERSION,
    isStub: true,
    coreInfo: (): CoreInfo => belum("coreInfo"),
    capabilities: (): RendererCapabilities => belum("capabilities"),
    createHost: (_options: HostOptions) => belum("createHost"),
    loadModel: async (_host: Live2DHost, _source: ModelSource) =>
      belum("loadModel"),
  };
}

// ── Stub lapisan renderer internal (backend/pool/scheduler) ────
// Kontraknya dikunci guard test; implementasi nyata kelak menggantikan
// factory ini satu per satu.

export function createStubRenderBackend(kind: BackendKind = "webgl2"): RenderBackend {
  return {
    kind,
    createTexture: (_source: TextureSource): TextureHandle =>
      belum("backend.createTexture"),
    destroyTexture: (_t: TextureHandle) => belum("backend.destroyTexture"),
    createFramebuffer: (): FramebufferHandle => belum("backend.createFramebuffer"),
    destroyFramebuffer: (_f: FramebufferHandle) =>
      belum("backend.destroyFramebuffer"),
    createRenderTarget: (_w: number, _h: number): RenderTarget =>
      belum("backend.createRenderTarget"),
    destroyRenderTarget: (_t: RenderTarget) =>
      belum("backend.destroyRenderTarget"),
    createShader: (_source: string): ShaderHandle => belum("backend.createShader"),
    destroyShader: (_s: ShaderHandle) => belum("backend.destroyShader"),
    beginRenderTarget: (_t: RenderTarget | null) => belum("backend.beginRenderTarget"),
    endRenderTarget: () => belum("backend.endRenderTarget"),
    setViewport: () => belum("backend.setViewport"),
    setScissor: () => belum("backend.setScissor"),
    setBlendState: (_state: BlendState) => belum("backend.setBlendState"),
    drawMesh: (_call: MeshDrawCall) => belum("backend.drawMesh"),
    destroy: () => belum("backend.destroy"),
  };
}

export function createStubRenderTargetPool(): RenderTargetPool {
  return {
    acquire: (_w: number, _h: number): RenderTarget => belum("pool.acquire"),
    release: (_t: RenderTarget) => belum("pool.release"),
    stats: () => belum("pool.stats"),
    destroy: () => belum("pool.destroy"),
  };
}

export function createStubRenderScheduler(mocVersion = 6): RenderScheduler {
  const zeroStats: FrameStats = {
    ms: 0, drawCalls: 0, passes: 0, poolHits: 0, poolMisses: 0,
  };
  return {
    mocVersion,
    buildPlan: (_snapshot: CoreModelSnapshot): RenderPlan => belum("scheduler.buildPlan"),
    lastStats: (): FrameStats | null => zeroStats,
  };
}
