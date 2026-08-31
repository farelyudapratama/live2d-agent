/**
 * animation/motion-runtime.ts — The animation scheduler.
 * All motion playback goes through here. Multi-layer (SPEC §12): N motion
 * boleh berjalan paralel dengan ownership per field — field/param hanya
 * ditulis layer prioritas tertinggi yang menganimasikannya, jadi tidak pernah
 * ada dua penulis satu parameter. Handles priority, blending, stretch, cleanup.
 */

import { MotionRegistry } from "./motion-registry";
import { evalTrack, assetDurationMs, evaluateAsset } from "./motion-dsl";
import type { MotionAsset } from "../../shared/types";

export interface RuntimeBridge {
  getPoseBase(): Record<string, number>;
  applyPoseDelta(delta: Record<string, number>): void;
  clearPoseDelta(): void;
  applyParamDrive(params: Record<string, number>): void;
  releaseParamDrive(paramIds: string[]): void;
  readParam?(id: string): number;
  getSupports?(): Set<string>;
  getOwnedParams?(): Set<string>;
  playNative?(group: string): void;
  now?(): number;
}

interface ActiveMotion {
  asset: MotionAsset;
  opts: PlayOptions;
  plan: PlaybackPlan;
  startTime: number;
  /** Ms absolut ketika blend-out mulai — batas "masih main" layer ini. */
  fadeStartAt: number;
  base: Record<string, number>;
  paramBase: Record<string, number>;
  paramIds: string[];
}

export interface PlayOptions {
  intensity?: number;
  priority?: number;
  blendIn?: number;
  blendOut?: number;
  loop?: boolean;
  fromLLM?: boolean;
  /** Estimasi durasi bicara (ms) segmen ini — playback dilar agar mengisi seluruh omongan. */
  fitToMs?: number;
  onDone?: (id: string) => void;
  onProgress?: (p: number) => void;
}

const HISTORY_MAX = 20;
/** Batas aman jumlah layer paralel. Band prioritas yang sama saling
 * menggantikan, jadi capa ini hanya terlampaui kalau banyak prioritas berbeda
 * ditumpuk sekaligus — buang yang terendah (tertua bila seri). */
const MAX_LAYERS = 4;

// Batas pelambatan stretch: motion maksimal dilar 2× durasi aslinya. Sisa
// waktu segmen ditahan di nilai keyframe terakhir — lebih baik daripada
// slow-motion ekstrem yang terlihat seperti molase.
export const STRETCH_MAX = 2;

export interface PlaybackPlan {
  durMs: number;
  blendIn: number;
  blendOut: number;
  /** 0 bila tidak di-stretch. */
  fitMs: number;
  /** Pengali laju timeline (1 = durasi asli; <1 = lebih lambat). */
  speed: number;
  /** Ms sejak start ketika blend-out mulai. */
  fadeStartMs: number;
  /** Ms sejak start ketika motion benar-benar selesai. */
  totalMs: number;
}

export function computePlaybackPlan(asset: MotionAsset, opts: PlayOptions): PlaybackPlan {
  const durMs = assetDurationMs(asset);
  const blendIn = Math.max(0, opts.blendIn ?? 120);
  const blendOut = Math.max(0, opts.blendOut ?? 250);
  // Stretch hanya untuk motion non-loop yang lebih pendek dari omongannya —
  // loop sudah mengisi waktu sendiri, dan motion tidak pernah dipercepat.
  const fitMs = opts.fitToMs && !asset.loop && opts.fitToMs > durMs ? opts.fitToMs : 0;
  const spanMs = fitMs ? Math.max(1, fitMs - blendIn) : durMs;
  const speed = fitMs ? Math.max(durMs / spanMs, 1 / STRETCH_MAX) : 1;
  const fadeStartMs = fitMs || durMs;
  return { durMs, blendIn, blendOut, fitMs, speed, fadeStartMs, totalMs: fadeStartMs + blendOut };
}

// Amplitude + posisi timeline pada satu saat wall-clock tMs (ms sejak start).
export function envelopeAt(
  plan: PlaybackPlan,
  tMs: number
): { amp: number; tSec: number } {
  let amp = 1;
  let tSec = ((tMs - plan.blendIn) * plan.speed) / 1000;
  if (tMs < plan.blendIn) {
    amp = plan.blendIn > 0 ? tMs / plan.blendIn : 1;
    tSec = 0;
  }
  if (tMs > plan.fadeStartMs) {
    const f = (tMs - plan.fadeStartMs) / (plan.blendOut || 1);
    amp = 1 - Math.min(1, f);
    tSec = plan.durMs / 1000;
  }
  return { amp, tSec };
}

function prioOf(l: ActiveMotion): number {
  return l.opts.priority ?? l.asset.priority ?? 60;
}

export class MotionRuntime {
  private registry: MotionRegistry;
  private bridge: RuntimeBridge;
  /** Layer aktif — urutan array = urutan play; getActive() mengembalikan terbaru. */
  private layers: ActiveMotion[] = [];
  private history: Array<{ id: string; at: number }> = [];
  private rafId: number | null = null;
  private watchdogId: ReturnType<typeof setTimeout> | null = null;

  constructor(registry: MotionRegistry, bridge?: RuntimeBridge) {
    this.registry = registry;
    // Bridge boleh parsial saat dibuat sebelum engine siap — tick() menjaga
    // setiap pemakaian method dengan optional chaining / typeof check.
    this.bridge = bridge ?? ({} as RuntimeBridge);
  }

  attach(bridge: RuntimeBridge): void {
    this.bridge = bridge;
    this.stopAll();
  }

  play(id: string, opts: PlayOptions = {}): boolean {
    const asset = this.registry.get(id);
    if (!asset) return false;
    if (asset.aiEnabled === false && opts.fromLLM) return false;
    if (!this.registry.canPlay(id, this.now())) {
      if (opts.fromLLM) return false;
    }

    // Native clip: delegate ke bridge. app.js punya guard clip-nya sendiri
    // (clipUntil membuat pose AI mundur selama klip main) — layer DSL tidak
    // disentuh di sini, paritas dengan perilaku lama.
    if (asset.source === "native") {
      this.registry.markPlayed(id, this.now());
      this.bridge.playNative?.(asset.id.replace(/^motion_/, ""));
      return true;
    }

    if (!asset.tracks?.length) return false;

    // Arbitrase multi-layer (SPEC §12): layer baru MENGGANTIKAN semua layer
    // dengan prioritas <= miliknya (same band & di bawah) dan BERJALAN BERSAMA
    // layer prioritas lebih tinggi. Tidak ada penolakan antar-band — benturan
    // parameter diselesaikan ownership per field di combinedDelta().
    const prio = opts.priority ?? asset.priority ?? 60;
    // Cap jumlah layer: layer yang tersisa semua berprioritas LEBIH TINGGI
    // dari yang baru, jadi saat penuh play baru ditolak — bukan mengusir
    // motion yang masih dikehendaki. (Penggantian band sama tetap jalan:
    // play band sama saat penuh tetap berhasil menggantikan.) Dicek SEBELUM
    // drop agar penolakan tidak meninggalkan setengah keadaan.
    const survivors = this.layers.filter((l) => prioOf(l) > prio);
    if (survivors.length >= MAX_LAYERS) return false;
    const replaced = this.layers.filter((l) => prioOf(l) <= prio);
    for (const l of replaced) this.dropLayer(l, false);

    this.registry.markPlayed(id, this.now());
    const base = this.bridge.getPoseBase?.() ?? {};
    const paramIds: string[] = [];
    const paramBase: Record<string, number> = {};
    for (const tr of asset.tracks) {
      if (tr.kind === "param" && tr.param) {
        paramIds.push(tr.param);
        paramBase[tr.param] = this.bridge.readParam?.(tr.param) ?? 0;
      }
    }

    const startTime = this.now();
    const plan = computePlaybackPlan(asset, opts);
    this.layers.push({
      asset,
      opts: { ...opts, priority: prio },
      plan,
      startTime,
      fadeStartAt: startTime + plan.fadeStartMs,
      base,
      paramBase,
      paramIds,
    });
    // Terapkan gabungan sekarang juga: kontribusi layer yang diganti hilang
    // dalam frame yang sama, bukan menunggu rAF berikutnya.
    if (replaced.length) this.recombine();
    this.scheduleTick();
    return true;
  }

  stop(id?: string): boolean {
    const targets = this.layers.filter((l) => !id || l.asset.id === id);
    if (!targets.length) return false;
    for (const l of targets) this.dropLayer(l, true);
    if (!this.layers.length) this.stopLoop();
    return true;
  }

  stopAll(): boolean {
    if (!this.layers.length) return false;
    for (const l of [...this.layers]) this.dropLayer(l, true);
    this.stopLoop();
    return true;
  }

  isPlaying(id?: string): boolean {
    return id ? this.layers.some((l) => l.asset.id === id) : this.layers.length > 0;
  }

  /** Layer terbaru yang di-play (paritas pemanggil lama yang harapkan satu slot). */
  getActive(): { id: string; asset: MotionAsset } | null {
    const top = this.layers[this.layers.length - 1];
    return top ? { id: top.asset.id, asset: top.asset } : null;
  }

  getHistory(): Array<{ id: string; at: number }> {
    return [...this.history];
  }

  listAvailable(): MotionAsset[] {
    return this.registry.list().filter((a) => a.source !== "native" || a.aiEnabled !== false);
  }

  // Hook pengujian: gabungan semua layer PADA SAAT INI tanpa menjadwalkan
  // tick baru (tick dipicu rAF/setTimeout, sulit diuji deterministik).
  sampleForTest(): { roles: Record<string, number>; params: Record<string, number>; amp: number } | null {
    if (!this.layers.length) return null;
    return this.combinedDelta();
  }

  // ── Private ───────────────────────────────────────────────
  private now(): number {
    return this.bridge.now?.() ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  }

  /** Lepas satu layer: riwayat, onDone, release param yang tak lagi dimiliki
   * layer mana pun. `recombineAfter` menerapkan gabungan sisa layer seketika
   * (false saat play() — pemanggilnya recombine setelah layer baru masuk). */
  private dropLayer(l: ActiveMotion, recombineAfter: boolean): void {
    const idx = this.layers.indexOf(l);
    if (idx === -1) return;
    this.layers.splice(idx, 1);
    this.history.unshift({ id: l.asset.id, at: this.now() });
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
    const stillOwned = new Set<string>();
    for (const other of this.layers) for (const p of other.paramIds) stillOwned.add(p);
    const releaseIds = l.paramIds.filter((p) => !stillOwned.has(p));
    if (releaseIds.length) this.bridge.releaseParamDrive?.(releaseIds);
    l.opts.onDone?.(l.asset.id);
    if (recombineAfter) this.recombine();
  }

  /** Hitung gabungan semua layer dan terapkan ke bridge dalam SATU apply —
   * bridge (app.js) unwind delta lama lalu pasang yang baru tiap panggilan. */
  private recombine(): void {
    if (typeof this.bridge.applyPoseDelta === "function") {
      const { roles, params } = this.combinedDelta();
      this.bridge.applyPoseDelta(roles);
      if (this.bridge.applyParamDrive) this.bridge.applyParamDrive(params);
    } else {
      this.bridge.clearPoseDelta?.();
    }
  }

  /**
   * Ownership per field (SPEC §12): field/param hanya ditulis layer prioritas
   * tertinggi yang menganimasikannya; layer di bawahnya mengisi sisanya.
   * Klaim ownership tetap terjadi walau nilai sedang 0 — kalau tidak, track
   * yang melintasi nol (mis. nod yang balik ke 0) melepas kepemilikan di
   * tengah gerak dan layer lain menyala mendadak.
   */
  private combinedDelta(): {
    roles: Record<string, number>;
    params: Record<string, number>;
    amp: number;
  } {
    const ordered = [...this.layers].sort((a, b) => prioOf(b) - prioOf(a));
    const roles: Record<string, number> = {};
    const params: Record<string, number> = {};
    const owned = new Set<string>();
    let amp = 0;
    for (const l of ordered) {
      const tMs = this.now() - l.startTime;
      const { amp: layerAmp, tSec } = envelopeAt(l.plan, tMs);
      amp = Math.max(amp, layerAmp);
      const ev = evaluateAsset(
        l.asset,
        Math.max(0, tSec),
        l.opts.intensity,
        this.bridge.getSupports?.(),
        this.bridge.getOwnedParams?.()
      );
      for (const k in ev.roles) {
        if (owned.has(k)) continue;
        owned.add(k);
        roles[k] = ev.roles[k] * layerAmp;
      }
      for (const id in ev.params) {
        if (owned.has(id)) continue;
        owned.add(id);
        const from = Number.isFinite(l.paramBase[id]) ? l.paramBase[id] : ev.params[id];
        params[id] = from + (ev.params[id] - from) * layerAmp;
      }
    }
    return { roles, params, amp };
  }

  private tick(): void {
    this.rafId = null;
    if (this.watchdogId != null) {
      clearTimeout(this.watchdogId);
      this.watchdogId = null;
    }
    if (!this.layers.length) {
      this.stopLoop();
      return;
    }

    const now = this.now();
    for (const l of [...this.layers]) {
      if (now - l.startTime >= l.plan.totalMs) {
        if (l.asset.loop) {
          l.startTime = now;
          l.fadeStartAt = now + l.plan.fadeStartMs;
        } else {
          this.dropLayer(l, true);
        }
      }
    }
    if (!this.layers.length) {
      this.stopLoop();
      return;
    }

    const { roles, params } = this.combinedDelta();
    if (typeof this.bridge.applyPoseDelta === "function") this.bridge.applyPoseDelta(roles);
    if (this.bridge.applyParamDrive) this.bridge.applyParamDrive(params);
    for (const l of this.layers) {
      l.opts.onProgress?.(Math.min(1, (now - l.startTime) / l.plan.totalMs));
    }
    this.scheduleTick();
  }

  private scheduleTick(): void {
    if (typeof requestAnimationFrame === "function") {
      if (this.rafId == null) {
        this.rafId = requestAnimationFrame(() => this.tick());
      }
      // Watchdog: rAF stops in background tabs
      if (this.watchdogId == null) {
        this.watchdogId = setTimeout(() => {
          this.watchdogId = null;
          this.tick();
        }, 250);
      }
      return;
    }
    if (this.rafId == null) {
      this.rafId = setTimeout(() => this.tick(), 16) as unknown as number;
    }
  }

  private stopLoop(): void {
    if (this.rafId != null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.rafId);
      } else {
        clearTimeout(this.rafId);
      }
      this.rafId = null;
    }
    if (this.watchdogId != null) {
      clearTimeout(this.watchdogId);
      this.watchdogId = null;
    }
  }

  // Factory facade so the proven engine (static/js/app.js) can keep calling
  // MotionRuntime.createRuntime(registry, bridge) exactly as it did with the
  // legacy UMD module.
  static createRuntime(registry: MotionRegistry, bridge?: RuntimeBridge): MotionRuntime {
    return new MotionRuntime(registry, bridge);
  }
}
