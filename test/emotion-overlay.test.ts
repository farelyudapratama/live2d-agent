/**
 * test/emotion-overlay.test.ts — Migrated from test/legacy/test-emotion-overlay.js.
 *
 * Invariant:
 * App-level emotion overlay (emotion-overlay.js) matches canonical .exp3 expressions
 * and semantic emotion aliases to visual particles (hearts, blush, sparkles, tears, etc.),
 * avoids triggering on neutral/clothing names, and integrates with app.js / server config.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dir, "..");
const modSrc = readFileSync(join(ROOT, "static/js/emotion-overlay.js"), "utf8");
const appSrc = readFileSync(join(ROOT, "static/js/app.js"), "utf8");
const htmlSrc = readFileSync(join(ROOT, "static/index.html"), "utf8");
const serverSrc = readFileSync(join(ROOT, "src/server/index.ts"), "utf8");

describe("Emotion Overlay (Production Invariant)", () => {
  let sandbox: Record<string, any>;
  let resolveFx: (n: any) => any;

  beforeAll(() => {
    sandbox = {
      window: {},
      console,
      performance: { now: () => 0 },
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      document: { createElement: () => ({ getContext: () => null }) },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(modSrc, sandbox);
    resolveFx = (n: any) => sandbox.__emotionOverlay._resolve(n);
  });

  test("module executes safely without thrown error and installs global", () => {
    expect(sandbox.__emotionOverlay).toBeDefined();
    expect(() => {
      sandbox.__emotionOverlay.onExpression("malu");
      sandbox.__emotionOverlay.clear();
    }).not.toThrow();
  });

  test("maps canonical .exp3 expression names to visual effects", () => {
    expect(resolveFx("exp_heart")?.key).toBe("heart");
    expect(resolveFx("exp_blush")?.key).toBe("blush");
    expect(resolveFx("exp_sparkling")?.key).toBe("sparkle");
    expect(resolveFx("exp_tear")?.key).toBe("tear");
    expect(resolveFx("exp_sweat")?.key).toBe("sweat");
    expect(resolveFx("exp_dizzy")?.key).toBe("dizzy");
    expect(resolveFx("exp_angry")?.key).toBe("anger");
    expect(resolveFx("exp_sad")?.key).toBe("tear");
  });

  test("maps semantic Indonesian aliases and preset prefixes with case/whitespace trimming", () => {
    expect(resolveFx("user:malu")?.key).toBe("blush");
    expect(resolveFx("malu")?.key).toBe("blush");
    expect(resolveFx("senang")?.key).toBe("sparkle");
    expect(resolveFx("sedih")?.key).toBe("tear");
    expect(resolveFx("kaget")?.key).toBe("shock");
    expect(resolveFx("marah")?.key).toBe("anger");
    expect(resolveFx("bingung")?.key).toBe("dizzy");
    expect(resolveFx("User:Malu ")?.key).toBe("blush");
  });

  test("rejects neutral, clothing, non-string, or eye-shape names", () => {
    expect(resolveFx("normal")).toBeNull();
    expect(resolveFx("default")).toBeNull();
    expect(resolveFx("collar_blue")).toBeNull();
    expect(resolveFx("exp_zitome")).toBeNull();
    expect(resolveFx("")).toBeNull();
    expect(resolveFx(null)).toBeNull();
    expect(resolveFx(42)).toBeNull();
  });

  test("wiring in index.html, app.js, and server config", () => {
    expect(htmlSrc.indexOf("voice-input.js")).toBeLessThan(htmlSrc.indexOf("emotion-overlay.js"));
    expect(/playEmotionClip\(name\);\s*\n\s*fireOverlay\(name\);/.test(appSrc)).toBe(true);
    expect(/fireOverlay\(name\);\s*try \{\s*await state\.model\.expression\(nativeName\);/.test(appSrc)).toBe(true);
    expect(/playEmotionClip\(name\); \/\/ body follows the face \(see native branch\)\s*\n\s*fireOverlay\(name\);/.test(appSrc)).toBe(true);
    expect(/function resetEmotion\(\)[\s\S]{0,800}__emotionOverlay && window\.__emotionOverlay\.clear\(\)/.test(appSrc)).toBe(true);
    expect(/const nativeName = \(state\.modelExpressions \|\| \[\]\)\.find\(/.test(appSrc)).toBe(true);
    expect(!/state\.supportedEmotions = Object\.assign\(\{\}, state\.roleEmotions\)/.test(appSrc)).toBe(true);
    expect(!/const supportedEmotions = buildRoleEmotions\(\)/.test(appSrc)).toBe(true);
    expect(/const synth = state\.roleEmotions && state\.roleEmotions\[name\];[\s\S]*?\r?\n    fireOverlay\(name\);\r?\n  \}/.test(appSrc)).toBe(true);
    expect(serverSrc.includes("overlay:cfg.overlay||{}")).toBe(true);
    expect(appSrc.includes("if (d.overlay) window.__overlayCfg")).toBe(true);
  });
});
