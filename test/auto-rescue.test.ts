/**
 * test/auto-rescue.test.ts — Migrated from test/legacy/test-auto-rescue.js.
 *
 * Invariant:
 * Models distributed without .model3.json manifest (only .moc3, textures, motions,
 * expressions, and optional vtube.json) must still be discovered and loaded via
 * in-memory Auto-Rescue blueprint.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRescueBlueprint } from "../src/server/rescue";

const ROOT = resolve(import.meta.dir, "..");
const serverSrc = readFileSync(join(ROOT, "src/server/index.ts"), "utf8");

describe("Auto-Rescue Blueprint (Production Invariant)", () => {
  let root: string;
  let dir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "l2d-rescue-"));
    dir = join(root, "lumine");
    mkdirSync(join(dir, "lumine.8192"), { recursive: true });
    mkdirSync(join(dir, "mothion"), { recursive: true });
    writeFileSync(join(dir, "lumine.moc3"), "MOC3-fake");
    writeFileSync(join(dir, "lumine.8192", "texture_01.png"), "png1");
    writeFileSync(join(dir, "lumine.8192", "texture_00.png"), "png0");
    writeFileSync(join(dir, "lumine_icon.png"), "icon");
    writeFileSync(join(dir, "lumine.physics3.json"), "{}");
    writeFileSync(join(dir, "lumine.cdi3.json"), "{}");
    writeFileSync(join(dir, "mothion", "idle.motion3.json"), '{"Meta":{}}');
    writeFileSync(join(dir, "mothion", "wave.motion3.json"), '{"Meta":{}}');
    writeFileSync(join(dir, "mothion", "exp_heart.exp3.json"), '{"Parameters":[]}');
    writeFileSync(
      join(dir, "lumine.vtube.json"),
      JSON.stringify({ FileReferences: { IdleAnimation: "idle.motion3.json" } }),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("builds rescue blueprint from manifest-less folder with natural textures and idle grouping", () => {
    const bp = buildRescueBlueprint(dir);
    expect(bp).not.toBeNull();
    if (!bp) return;

    const F = bp.manifest.FileReferences;
    expect(F.Moc).toBe("lumine.moc3");
    expect(F.Textures).toEqual(["lumine.8192/texture_00.png", "lumine.8192/texture_01.png"]);
    expect(F.Textures.some((t) => /icon/i.test(t))).toBe(false);
    expect(F.Physics).toBe("lumine.physics3.json");
    expect(F.DisplayInfo).toBe("lumine.cdi3.json");
    expect(F.Motions?.Idle).toEqual([{ File: "mothion/idle.motion3.json" }]);
    expect(F.Motions?.Motion).toEqual([{ File: "mothion/wave.motion3.json" }]);
    expect(F.Expressions?.length).toBe(1);
    expect(F.Expressions?.[0]?.Name).toBe("exp_heart");
    expect(bp.manifest.AutoRescued?.by).toBeDefined();

    expect(bp.summary.textures).toBe(2);
    expect(bp.summary.motions).toBe(2);
    expect(bp.summary.expressions).toBe(1);
    expect(bp.summary.idleMotion).toBe("mothion/idle.motion3.json");
  });

  test("idempotency and rejection: manifest present, no moc, or non-existent folder", () => {
    writeFileSync(join(dir, "dummy.model3.json"), "{}");
    expect(buildRescueBlueprint(dir)).toBeNull();

    const noMoc = join(root, "kosong");
    mkdirSync(noMoc, { recursive: true });
    expect(buildRescueBlueprint(noMoc)).toBeNull();
    expect(buildRescueBlueprint(join(root, "tidak-ada"))).toBeNull();
  });

  test("detects idle motion via name pattern when vtube.json is absent", () => {
    const dir2 = join(root, "tanpa-vtube");
    mkdirSync(join(dir2, "m"), { recursive: true });
    writeFileSync(join(dir2, "a.moc3"), "x");
    writeFileSync(join(dir2, "m", "my_idle.motion3.json"), "{}");
    writeFileSync(join(dir2, "m", "jump.motion3.json"), "{}");

    const bp2 = buildRescueBlueprint(dir2);
    expect(bp2?.manifest.FileReferences.Motions?.Idle).toBeDefined();
    expect(bp2?.manifest.FileReferences.Motions?.Motion).toBeDefined();
  });

  test("server wiring level source guards", () => {
    expect(serverSrc.includes("__rescue__") && serverSrc.includes("buildRescueBlueprint(dir)")).toBe(true);
    expect(/if\(!abs\)\{ const bp=buildRescueBlueprint\(dir\)/.test(serverSrc)).toBe(true);
    expect(/if\(!model3\)\{ const bp=buildRescueBlueprint\(dir\)/.test(serverSrc)).toBe(true);
    expect(/if\(findModel3\(dir\)\|\|buildRescueBlueprint\(dir\)\) usable\.push\(name\)/.test(serverSrc)).toBe(true);
  });
});
