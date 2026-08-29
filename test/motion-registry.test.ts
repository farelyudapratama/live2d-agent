/**
 * test/motion-registry.test.ts — Tests for motion registry.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { MotionRegistry } from "../src/client/animation/motion-registry";
import type { MotionAsset } from "../src/shared/types";

function makeAsset(id: string, overrides?: Partial<MotionAsset>): MotionAsset {
  return {
    version: 1, id, name: id, description: "test",
    tags: [], source: "builtin", type: "gesture",
    duration: 1, loop: false,
    intensity: { min: 0.3, max: 1, default: 0.8 },
    emotionCompatibility: {}, cooldown: 0, priority: 60,
    aiEnabled: true, requires: [],
    tracks: [],
    ...overrides,
  };
}

describe("MotionRegistry", () => {
  let reg: MotionRegistry;

  beforeEach(() => {
    reg = new MotionRegistry();
  });

  it("registers and retrieves an asset", () => {
    const asset = makeAsset("wave");
    expect(reg.register(asset).ok).toBe(true);
    expect(reg.get("wave")).not.toBeNull();
    expect(reg.get("wave")!.id).toBe("wave");
  });

  it("rejects duplicate ID from different source", () => {
    reg.register(makeAsset("wave", { source: "builtin" }));
    const result = reg.register(makeAsset("wave", { source: "user" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("sudah dipakai");
  });

  it("allows same source to overwrite", () => {
    reg.register(makeAsset("wave", { source: "builtin", description: "old" }));
    reg.register(makeAsset("wave", { source: "builtin", description: "new" }));
    expect(reg.get("wave")!.description).toBe("new");
  });

  it("removes an asset", () => {
    reg.register(makeAsset("wave"));
    expect(reg.remove("wave")).toBe(true);
    expect(reg.get("wave")).toBeNull();
  });

  it("lists all assets", () => {
    reg.register(makeAsset("a"));
    reg.register(makeAsset("b"));
    expect(reg.list()).toHaveLength(2);
  });

  it("searches by tags", () => {
    reg.register(makeAsset("a", { tags: ["happy"] }));
    reg.register(makeAsset("b", { tags: ["sad"] }));
    expect(reg.search({ tags: ["happy"] })).toHaveLength(1);
    expect(reg.search({ tags: ["happy"] })[0].id).toBe("a");
  });

  it("searches by source", () => {
    reg.register(makeAsset("a", { source: "builtin" }));
    reg.register(makeAsset("b", { source: "user" }));
    expect(reg.search({ source: "builtin" })).toHaveLength(1);
  });

  it("checks cooldown", () => {
    reg.register(makeAsset("wave", { cooldown: 1000 }));
    reg.markPlayed("wave", 1000);
    expect(reg.canPlay("wave", 1500)).toBe(false);
    expect(reg.canPlay("wave", 2001)).toBe(true);
  });

  it("replaces user motions", () => {
    reg.register(makeAsset("a", { source: "builtin" }));
    reg.register(makeAsset("b", { source: "user" }));
    const n = reg.replaceUserMotions([makeAsset("c", { source: "user" })]);
    expect(n).toBe(1);
    expect(reg.get("a")).not.toBeNull(); // builtin preserved
    expect(reg.get("b")).toBeNull(); // old user removed
    expect(reg.get("c")).not.toBeNull(); // new user added
  });

  it("builds LLM catalog", () => {
    reg.register(makeAsset("wave", { description: "Wave hand", aiEnabled: true }));
    reg.register(makeAsset("hidden", { aiEnabled: false }));
    const cat = reg.catalogForLLM();
    expect(cat).toHaveLength(1);
    expect(cat[0].id).toBe("wave");
  });

  it("rejects empty asset", () => {
    expect(reg.register(null as any).ok).toBe(false);
  });
});
