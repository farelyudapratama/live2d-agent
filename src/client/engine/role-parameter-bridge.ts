/**
 * engine/role-parameter-bridge.ts — PHASE 10: reconnect Role Mapping →
 * Parameter API (Phase 8).
 *
 * Flow yang disambungkan (spesifikasi Phase 10):
 *
 *   semantic role (angleX, mouthOpenY, …)
 *        ↓
 *   role-mapping.ts   (toActual / roleClampActual / normToRange /
 *                      roleDefaultOf — SATU sumber kebenaran, TIDAK diduplikasi)
 *        ↓
 *   model-specific parameter ID   (hasil mapRoles — milik model)
 *        ↓
 *   Phase 8 ParameterApi.setParameter(id, value)   ← canonical write path
 *        ↓
 *   Cubism
 *
 * Aturan mengikat:
 *  - SEMANTIK PRESERVED: matematika role TIDAK ditulis ulang — modul ini
 *    memanggil role-mapping.ts apa adanya. Yang berubah hanya LINTASAN
 *    tulis terakhir (dulu: cm.setParameterValueById langsung; kini: lewat
 *    Parameter API yang tervalidasi).
 *  - VALIDASI EKSISTENSI: role tanpa mapping, atau id yang tidak dikenal
 *    model (getParameterInfo → undefined) → safe failure (false), tanpa
 *    throw, tanpa membuat parameter, tanpa menyentuh parameter lain.
 *  - DUA LAPIS RANGE TETAP TERPISAH: role range (skala referensi ±30 / 0..1)
 *    = konstrain semantik di role-mapping.ts; model range (mis. [-30,30])
 *    = konstrain milik Phase 8 ParameterApi. Bridge tidak mencampurnya.
 *  - pin:false — tulisan bridge adalah tulisan engine biasa (setara pokeParam
 *    lama); mekanisme pin Phase 8 tetap khusus uji manual sandbox.
 *  - TANPA STATE PARAMETER KEDUA: nilai live hanya di Cubism, dibaca lewat
 *    getParameter. Bridge menyimpan statistik, bukan salinan nilai.
 *  - Legacy path (state.paramRange, setSticky/override-guard) TETAP ADA
 *    sebagai compatibility layer — tidak dihapus di phase ini (§18).
 */

import {
  normToRange,
  refHalfFor,
  roleClampActual,
  roleDefaultOf,
  toActual,
  type ParamRange,
} from "./role-mapping";
import {
  ParameterApi,
  type CubismParameterBacking,
} from "../../live2d/parameter-api";

/** Permukaan Phase 8 yang dibutuhkan bridge (subset ParameterApi). */
export interface RoleParameterTarget {
  setParameter(id: string, value: number, opts?: { pin?: boolean }): boolean;
  getParameter(id: string): number | undefined;
  getParameterInfo(
    id: string,
  ): { id: string; min: number; max: number; defaultValue: number } | undefined;
}

export interface BridgeStats {
  refWrites: number;
  normWrites: number;
  resets: number;
  /** Role/id gagal tulis terakhir (role tak termapping / param tak dikenal). */
  lastMiss: string | null;
  misses: number;
}

export interface RoleParameterBridge {
  /** id parameter aktual milik model untuk role, atau undefined. */
  roleIdOf(role: string): string | undefined;
  hasRole(role: string): boolean;
  /** pokeRoleRef semantics: vRef skala referensi (±30 / ±1) → aktual. */
  writeRef(role: string, vRef: number): boolean;
  /** pokeRoleNorm semantics: t 0..1 → range model. */
  writeNorm(role: string, t: number): boolean;
  /** Kembalikan role ke default MILIK model. */
  resetRole(role: string): boolean;
  /** Baca aktual → role-space (inverse toActual). undefined bila tak termapping. */
  readRole(role: string): number | undefined;
  stats(): BridgeStats;
}

export function createRoleParameterBridge(
  target: RoleParameterTarget,
  getRoleIds: () => Record<string, string> | null | undefined,
): RoleParameterBridge {
  const stats: BridgeStats = {
    refWrites: 0,
    normWrites: 0,
    resets: 0,
    lastMiss: null,
    misses: 0,
  };

  const miss = (label: string): false => {
    stats.lastMiss = label;
    stats.misses++;
    return false;
  };

  const resolve = (role: string): { id: string; range: ParamRange } | null => {
    const id = getRoleIds()?.[role];
    if (!id) {
      miss(role + " (tanpa mapping)");
      return null;
    }
    const info = target.getParameterInfo(id);
    if (!info) {
      miss(role + " → " + id + " (parameter tidak dikenal model)");
      return null;
    }
    // Adaptasi bentuk: ParameterInfo (Phase 8) → ParamRange (role-mapping) —
    // dua kontrak terverifikasi, jangan diubah salah satunya.
    return { id, range: { min: info.min, max: info.max, def: info.defaultValue } };
  };

  return {
    roleIdOf(role) {
      return getRoleIds()?.[role] ?? undefined;
    },
    hasRole(role) {
      const id = getRoleIds()?.[role];
      return !!id && !!target.getParameterInfo(id);
    },
    writeRef(role, vRef) {
      if (!Number.isFinite(vRef)) return miss(role + " (vRef tidak finite)");
      const r = resolve(role);
      if (!r) return false;
      // Semantik role-mapping.ts PERSIS writeRef(): toActual lalu clamp role.
      // Parameter API lalu meng-clamp ke range model (idempoten).
      const value = roleClampActual(role, toActual(role, vRef, r.range), r.range);
      // pin:false — tulisan engine biasa; pin Phase 8 khusus uji manual.
      if (!target.setParameter(r.id, value, { pin: false }))
        return miss(role + " → " + r.id);
      stats.refWrites++;
      return true;
    },
    writeNorm(role, t) {
      if (!Number.isFinite(t)) return miss(role + " (t tidak finite)");
      const r = resolve(role);
      if (!r) return false;
      const value = normToRange(t, r.range);
      if (!target.setParameter(r.id, value, { pin: false }))
        return miss(role + " → " + r.id);
      stats.normWrites++;
      return true;
    },
    resetRole(role) {
      const r = resolve(role);
      if (!r) return false;
      if (!target.setParameter(r.id, roleDefaultOf(r.range), { pin: false }))
        return miss(role);
      stats.resets++;
      return true;
    },
    readRole(role) {
      const id = getRoleIds()?.[role];
      if (!id) return undefined;
      const info = target.getParameterInfo(id);
      const v = target.getParameter(id);
      if (!info || v === undefined) return undefined;
      // Inverse toActual: aktual → skala referensi role (±RH) terhadap
      // MIDPOINT range model — persis kebalikan rumus toActual.
      const mid = (info.max + info.min) / 2;
      const half = halfOf(info) || refHalfFor(role);
      return ((v - mid) / half) * refHalfFor(role);
    },
    stats: () => ({ ...stats }),
  };
}

/** Setengah range model — untuk inverse readRole. */
function halfOf(info: { min: number; max: number }): number {
  return (info.max - info.min) / 2;
}

// ── Engine link: Cubism model (stack legacy maupun 5.3) → ParameterApi ──

/**
 * Bentuk parameter id dari dua generasi framework: Cubism 5.3 memberi
 * CubismIdHandle ({getString()}), stack legacy memberi string mentah.
 */
type ParamIdLike = string | { getString(): string };

interface FrameworkModelLike {
  setParameterValueById?(id: string, value: number, weight?: number): void;
  setParameterValueByIndex?(index: number, value: number, weight?: number): void;
  getParameterValueById?(id: string): number;
  getParameterCount?(): number;
  getParameterId?(index: number): ParamIdLike | null | undefined;
  getParameterValueByIndex?(index: number): number;
  getParameterMinimumValue?(index: number): number;
  getParameterMaximumValue?(index: number): number;
  getParameterDefaultValue?(index: number): number;
  /** Raw core (framework.getModel()) — struct .parameters kalau getter hilang. */
  getModel?(): unknown;
  update?(): void;
}

interface RawParametersLike {
  count?: number;
  ids?: ArrayLike<ParamIdLike>;
  values?: ArrayLike<number>;
  minimums?: ArrayLike<number>;
  maximums?: ArrayLike<number>;
  defaults?: ArrayLike<number>;
}

function rawParameters(src: unknown): RawParametersLike | null {
  if (src && typeof src === "object") {
    const p = (src as { parameters?: unknown }).parameters;
    if (p && typeof p === "object") return p as RawParametersLike;
  }
  return null;
}

function paramIdToString(v: ParamIdLike | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return typeof v.getString === "function" ? v.getString() : null;
}

/**
 * Backing CubismParameterBacking yang TOLERAN terhadap dua generasi model:
 *  - Cubism 5.3 framework (sandbox): getter per-indeks lengkap.
 *  - Stack legacy app.js (pixi-live2d era-core-4): setter by-ID terbukti
 *    (pokeParam lama), getter per-indeks bisa di framework atau raw core.
 * Tulisan SELALU lewat framework cm (setParameterValueById) — jalur yang
 * sama dan sudah terbukti dipakai engine bertahun-tahun.
 */
export function buildTolerantParameterBacking(
  cm: FrameworkModelLike,
): CubismParameterBacking | null {
  if (!cm) return null;
  const raw = cm.getModel ? cm.getModel() : null;
  // Prioritas probing: FRAMEWORK cm dulu (getter typed lengkap — terbukti di
  // sandbox 5.3), raw core hanya fallback untuk potongan yang hilang.
  // (Raw core TIDAK punya getParameterMinimumValue dst. — memakai raw sebagai
  // sumber utama membuat semua range terbaca 0 → clamp ke 0.)
  const src = cm;
  const rp = rawParameters(raw) ?? rawParameters(cm);

  const count = (() => {
    if (typeof src.getParameterCount === "function") {
      try { return src.getParameterCount(); } catch { /* lanjut */ }
    }
    return rp?.count ?? 0;
  })();
  if (!count || count <= 0) return null;

  const idAt = (i: number): string | null => {
    if (typeof src.getParameterId === "function") {
      try {
        const s = paramIdToString(src.getParameterId(i));
        if (s != null) return s;
      } catch { /* lanjut ke raw */ }
    }
    const v = rp?.ids ? rp.ids[i] : undefined;
    return paramIdToString(v ?? null);
  };

  const indexById = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const id = idAt(i);
    if (id != null) indexById.set(id, i);
  }
  if (indexById.size === 0) return null;

  const num = (fn: () => number | undefined, arr: ArrayLike<number> | undefined, i: number): number => {
    if (fn) { try { const v = fn(); if (typeof v === "number") return v; } catch { /* lanjut */ } }
    const v = arr ? arr[i] : undefined;
    return typeof v === "number" ? v : 0;
  };

  const valueAt = (i: number): number =>
    num(() => (typeof src.getParameterValueByIndex === "function" ? src.getParameterValueByIndex(i) : undefined), rp?.values, i);
  const minAt = (i: number): number =>
    num(() => (typeof src.getParameterMinimumValue === "function" ? src.getParameterMinimumValue(i) : undefined), rp?.minimums, i);
  const maxAt = (i: number): number =>
    num(() => (typeof src.getParameterMaximumValue === "function" ? src.getParameterMaximumValue(i) : undefined), rp?.maximums, i);
  const defAt = (i: number): number =>
    num(() => (typeof src.getParameterDefaultValue === "function" ? src.getParameterDefaultValue(i) : undefined), rp?.defaults, i);

  return {
    getParameterCount: () => count,
    getParameterId: (i) => idAt(i) ?? "",
    getParameterValue: (id) => {
      const i = indexById.get(id);
      if (i === undefined) {
        // fallback by-ID framework (proven path)
        if (typeof cm.getParameterValueById === "function") {
          try { return cm.getParameterValueById(id); } catch { return 0; }
        }
        return 0;
      }
      return valueAt(i);
    },
    getParameterMinimum: (id) => {
      const i = indexById.get(id);
      return i === undefined ? 0 : minAt(i);
    },
    getParameterMaximum: (id) => {
      const i = indexById.get(id);
      return i === undefined ? 0 : maxAt(i);
    },
    getParameterDefault: (id) => {
      const i = indexById.get(id);
      return i === undefined ? 0 : defAt(i);
    },
    setParameterValue: (id, value) => {
      // Utamakan tulis VIA INDEKS — generasi-agnostik dan terbukti (adapter
      // Phase 8). setParameterValueById di framework 5.3 menuntut
      // CubismIdHandle: string masuk → getParameterIndex gagal → tulisan
      // mendarat di indeks sampah (terverifikasi runtime Phase 10).
      const i = indexById.get(id);
      if (i !== undefined && typeof src.setParameterValueByIndex === "function") {
        try {
          src.setParameterValueByIndex(i, value, 1);
          return;
        } catch { /* jatuh ke by-ID */ }
      }
      // Fallback stack legacy (framework era-core-4, id = string).
      if (typeof cm.setParameterValueById === "function") {
        cm.setParameterValueById(id, value, 1);
      }
    },
    update: () => {
      try { cm.update?.(); } catch { /* renderer pemilik update() */ }
    },
    isAlive: () => !!cm,
  };
}

/** Statistik tulisan bridge untuk probe/diagnostik (bukan sumber kebenaran). */
export interface EngineParameterLink {
  api: ParameterApi;
  bridge: RoleParameterBridge;
  stats(): BridgeStats;
  /**
   * Tulis nilai AKTUAL (sudah di ruang parameter) lewat Parameter API —
   * canonical writer Phase 8, TANPA pin (pin = khusus uji manual).
   * Dipakai channel param-drive MotionRuntime dan hop tulis role-channel.
   * false bila id tak dikenal model (safe failure, tanpa throw).
   */
  writeActual(id: string, value: number): boolean;
}

/**
 * Bangun link engine utama: coreModel framework (apa pun generasi) →
 * ParameterApi Phase 8 → bridge role. null bila model tak bisa dibaca.
 */
export function createEngineParameterLink(
  coreModel: FrameworkModelLike | null | undefined,
  getRoleIds: () => Record<string, string> | null | undefined,
): EngineParameterLink | null {
  const backing = coreModel ? buildTolerantParameterBacking(coreModel) : null;
  if (!backing) return null;
  const api = new ParameterApi(backing);
  const bridge = createRoleParameterBridge(api, getRoleIds);
  return {
    api,
    bridge,
    stats: bridge.stats,
    writeActual: (id, value) => api.setParameter(id, value, { pin: false }),
  };
}
