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
  HostOptions,
  Live2DApi,
  Live2DHost,
  Live2DModelHandle,
  Live2DPoint,
  ModelSource,
} from "./types";

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
    destroy: () => belum("destroy"),
  };
}

export function createStubAdapter(): Live2DApi {
  return {
    version: () => STUB_VERSION,
    isStub: true,
    createHost: (_options: HostOptions) => belum("createHost"),
    loadModel: async (_host: Live2DHost, _source: ModelSource) =>
      belum("loadModel"),
  };
}
