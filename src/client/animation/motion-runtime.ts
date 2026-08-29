/**
 * animation/motion-runtime.ts — Single animation scheduler.
 * All motion playback goes through here. Handles priority, blending, and cleanup.
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
  startTime: number;
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
  onDone?: (id: string) => void;
  onProgress?: (p: number) => void;
}

const HISTORY_MAX = 20;

export class MotionRuntime {
  private registry: MotionRegistry;
  private bridge: RuntimeBridge;
  private active: ActiveMotion | null = null;
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

    // Native clip: delegate to bridge
    if (asset.source === "native") {
      this.registry.markPlayed(id, this.now());
      this.bridge.playNative?.(asset.id.replace(/^motion_/, ""));
      return true;
    }

    if (!asset.tracks?.length) return false;

    const prio = opts.priority ?? asset.priority ?? 60;
    if (this.active) {
      const activePrio = this.active.opts.priority ?? this.active.asset.priority ?? 60;
      if (prio < activePrio) return false;
      this.finishActive(false);
    }

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

    this.active = {
      asset,
      opts: { ...opts, priority: prio },
      startTime: this.now(),
      base,
      paramBase,
      paramIds,
    };
    this.scheduleTick();
    return true;
  }

  stop(id?: string): boolean {
    if (this.active && (!id || this.active.asset.id === id)) {
      this.finishActive(true);
      return true;
    }
    return false;
  }

  stopAll(): boolean {
    if (this.active) {
      this.finishActive(true);
      return true;
    }
    return false;
  }

  isPlaying(id?: string): boolean {
    return !!this.active && (!id || this.active.asset.id === id);
  }

  getActive(): { id: string; asset: MotionAsset } | null {
    return this.active ? { id: this.active.asset.id, asset: this.active.asset } : null;
  }

  getHistory(): Array<{ id: string; at: number }> {
    return [...this.history];
  }

  listAvailable(): MotionAsset[] {
    return this.registry.list().filter((a) => a.source !== "native" || a.aiEnabled !== false);
  }

  // ── Private ───────────────────────────────────────────────
  private now(): number {
    return this.bridge.now?.() ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  }

  private finishActive(restore: boolean): void {
    if (!this.active) return;
    this.history.unshift({ id: this.active.asset.id, at: this.now() });
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
    const done = this.active;
    this.active = null;
    this.stopLoop();
    if (restore) this.bridge.clearPoseDelta?.();
    if (restore) this.bridge.releaseParamDrive?.(done.paramIds);
    done.opts.onDone?.(done.asset.id);
  }

  private tick(): void {
    this.rafId = null;
    if (this.watchdogId != null) {
      clearTimeout(this.watchdogId);
      this.watchdogId = null;
    }
    if (!this.active) {
      this.stopLoop();
      return;
    }

    const { asset, opts, startTime, base, paramBase } = this.active;
    const durMs = assetDurationMs(asset);
    const blendIn = Math.max(0, opts.blendIn ?? 120);
    const blendOut = Math.max(0, opts.blendOut ?? 250);
    const tMs = this.now() - startTime;
    const totalMs = durMs + blendOut;

    if (tMs >= totalMs) {
      if (asset.loop) {
        this.active.startTime = this.now();
        this.scheduleTick();
        return;
      }
      this.finishActive(true);
      return;
    }

    // Amplitude envelope
    let amp = 1;
    let tSec = (tMs - blendIn) / 1000;
    if (tMs < blendIn) {
      amp = blendIn > 0 ? tMs / blendIn : 1;
      tSec = 0;
    }
    if (tMs > durMs) {
      const f = (tMs - durMs) / (blendOut || 1);
      amp = 1 - Math.min(1, f);
      tSec = durMs / 1000;
    }

    const supports = this.bridge.getSupports?.();
    const ownedParams = this.bridge.getOwnedParams?.();
    const ev = evaluateAsset(asset, Math.max(0, tSec), opts.intensity, supports, ownedParams);

    // Apply role deltas (scaled by amplitude)
    const scaled: Record<string, number> = {};
    for (const k in ev.roles) scaled[k] = ev.roles[k] * amp;
    // Guard: bridge bisa jadi parsial saat runtime dibuat sebelum engine siap
    // (v1 mengecek keberadaan method ini sebelum memanggil).
    if (typeof this.bridge.applyPoseDelta === "function") this.bridge.applyPoseDelta(scaled);

    // Apply param drive (absolute values, interpolated)
    const paramBaseRef = this.active.paramBase;
    if (this.bridge.applyParamDrive) {
      const blended: Record<string, number> = {};
      for (const id in ev.params) {
        const from = Number.isFinite(paramBaseRef[id]) ? paramBaseRef[id] : ev.params[id];
        blended[id] = from + (ev.params[id] - from) * amp;
      }
      this.bridge.applyParamDrive(blended);
    }

    opts.onProgress?.(Math.min(1, tMs / totalMs));
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
