/**
 * test/motion-dsl.test.ts — Tests for motion DSL.
 */
import { describe, it, expect } from "bun:test";
import { evalTrack, evaluateAsset, validateMotion, assetDurationMs } from "../src/client/animation/motion-dsl";
import type { MotionTrack, MotionAsset } from "../src/shared/types";

describe("evalTrack", () => {
  it("returns 0 for empty track", () => {
    const track: MotionTrack = { kind: "role", target: "angleX", interp: "linear", keys: [] };
    expect(evalTrack(track, 0)).toBe(0);
  });

  it("returns first key value before start", () => {
    const track: MotionTrack = {
      kind: "role", target: "angleX", interp: "linear",
      keys: [{ t: 0.5, v: 10 }],
    };
    expect(evalTrack(track, 0)).toBe(10);
  });

  it("interpolates linearly", () => {
    const track: MotionTrack = {
      kind: "role", target: "angleX", interp: "linear",
      keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }],
    };
    expect(evalTrack(track, 0.5)).toBe(5);
  });

  it("holds last value after end", () => {
    const track: MotionTrack = {
      kind: "role", target: "angleX", interp: "linear",
      keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }],
    };
    expect(evalTrack(track, 2)).toBe(10);
  });

  it("handles ease-in interpolation", () => {
    const track: MotionTrack = {
      kind: "role", target: "angleX", interp: "ease-in",
      keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }],
    };
    const v = evalTrack(track, 0.5);
    // ease-in: t^3 = 0.125, so value = 1.25
    expect(v).toBeCloseTo(1.25, 1);
  });
});

describe("evaluateAsset", () => {
  it("evaluates role tracks", () => {
    const asset: MotionAsset = {
      version: 1, id: "test", name: "Test", description: "",
      tags: [], source: "builtin", type: "gesture",
      duration: 1, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{
        kind: "role", target: "angleX", interp: "linear",
        keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }],
      }],
    };
    const ev = evaluateAsset(asset, 0.5, 1);
    expect(ev.roles.ax).toBe(5);
    // alias SPEC dikanoniskan: tidak ada kunci duplikat gaya SPEC di roles
    expect(ev.roles.angleX).toBeUndefined();
  });

  it("respects intensity scaling", () => {
    const asset: MotionAsset = {
      version: 1, id: "test", name: "Test", description: "",
      tags: [], source: "builtin", type: "gesture",
      duration: 1, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{
        kind: "role", target: "angleX", interp: "linear",
        keys: [{ t: 0, v: 0 }, { t: 1, v: 20 }],
      }],
    };
    const ev = evaluateAsset(asset, 0.5, 0.5);
    expect(ev.roles.ax).toBe(5); // 10 * 0.5
  });

  it("clamps to field bounds", () => {
    const asset: MotionAsset = {
      version: 1, id: "test", name: "Test", description: "",
      tags: [], source: "builtin", type: "gesture",
      duration: 1, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{
        kind: "role", target: "angleX", interp: "linear",
        keys: [{ t: 0, v: 0 }, { t: 1, v: 50 }], // 50 > bound of 30
      }],
    };
    const ev = evaluateAsset(asset, 1, 1);
    expect(ev.roles.ax).toBe(30); // clamped
  });
});

describe("validateMotion", () => {
  it("rejects empty id", () => {
    const asset: MotionAsset = {
      version: 1, id: "", name: "Test", description: "",
      tags: [], source: "user", type: "keyframe",
      duration: 1, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{ kind: "role", target: "angleX", interp: "linear", keys: [{ t: 0, v: 0 }] }],
    };
    const errors = validateMotion(asset);
    expect(errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("rejects invalid duration", () => {
    const asset: MotionAsset = {
      version: 1, id: "test", name: "Test", description: "",
      tags: [], source: "user", type: "keyframe",
      duration: 0, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: {}, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{ kind: "role", target: "angleX", interp: "linear", keys: [{ t: 0, v: 0 }] }],
    };
    const errors = validateMotion(asset);
    expect(errors.some((e) => e.includes("duration"))).toBe(true);
  });

  it("accepts valid motion", () => {
    const asset: MotionAsset = {
      version: 1, id: "wave", name: "Wave", description: "Test wave",
      tags: ["greeting"], source: "user", type: "keyframe",
      duration: 1.5, loop: false,
      intensity: { min: 0.3, max: 1, default: 0.8 },
      emotionCompatibility: { senang: 1 }, cooldown: 0, priority: 60,
      aiEnabled: true, requires: [],
      tracks: [{
        kind: "role", target: "angleX", interp: "linear",
        keys: [{ t: 0, v: 0 }, { t: 0.5, v: 5 }, { t: 1, v: 0 }],
      }],
    };
    const errors = validateMotion(asset);
    expect(errors).toHaveLength(0);
  });
});

describe("assetDurationMs", () => {
  it("converts seconds to ms", () => {
    const asset = { duration: 1.5 } as MotionAsset;
    expect(assetDurationMs(asset)).toBe(1500);
  });

  it("has minimum of 200ms", () => {
    const asset = { duration: 0 } as MotionAsset;
    expect(assetDurationMs(asset)).toBe(200);
  });
});
