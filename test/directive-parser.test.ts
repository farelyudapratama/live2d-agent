/**
 * test/directive-parser.test.ts — Tests for directive parser.
 */
import { describe, it, expect } from "bun:test";
import {
  parseSegments,
  stripDirectives,
  hasDirectives,
  guessEmotion,
  segmentTextFallback,
} from "../src/client/agent/directive-parser";

describe("stripDirectives", () => {
  it("removes directives from text", () => {
    expect(stripDirectives("[EMOTION:senang] Halo!")).toBe("Halo!");
  });

  it("removes multiple directives", () => {
    const input = "[EMOTION:senang][GESTURE:nod] Halo!";
    expect(stripDirectives(input)).toBe("Halo!");
  });

  it("preserves plain text", () => {
    expect(stripDirectives("Halo dunia!")).toBe("Halo dunia!");
  });
});

describe("hasDirectives", () => {
  it("detects directives", () => {
    expect(hasDirectives("[EMOTION:senang] test")).toBe(true);
  });

  it("detects no directives", () => {
    expect(hasDirectives("just plain text")).toBe(false);
  });

  it("detects gesture directives", () => {
    expect(hasDirectives("[GESTURE:nod]")).toBe(true);
  });
});

describe("parseSegments", () => {
  it("parses single directive + text", () => {
    const segs = parseSegments("[EMOTION:senang] Halo!");
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("Halo!");
    expect(segs[0].actions.emotion).toBe("senang");
  });

  it("parses multiple segments", () => {
    const input = "[EMOTION:senang] Halo! [EMOTION:sedih] Tapi aku sedih.";
    const segs = parseSegments(input);
    expect(segs).toHaveLength(2);
    expect(segs[0].actions.emotion).toBe("senang");
    expect(segs[1].actions.emotion).toBe("sedih");
  });

  it("parses gesture directive", () => {
    const segs = parseSegments("[GESTURE:nod] Iya");
    expect(segs[0].actions.gesture).toBe("nod");
  });

  it("parses head directive", () => {
    const segs = parseSegments("[HEAD:5,-3] test");
    expect(segs[0].actions.head).toEqual({ x: 5, y: -3 });
  });

  it("parses body directive", () => {
    const segs = parseSegments("[BODY:10,5,-2] test");
    expect(segs[0].actions.body).toEqual({ x: 10, y: 5, z: -2 });
  });

  it("parses ACC directive", () => {
    const segs = parseSegments("[ACC:ParamGlasses:1] test");
    expect(segs[0].actions.accessories).toEqual({ ParamGlasses: 1 });
  });

  it("parses INTENSITY directive", () => {
    const segs = parseSegments("[INTENSITY:0.5] test");
    expect(segs[0].actions.intensity).toBe(0.5);
  });

  it("handles plain text without directives", () => {
    const segs = parseSegments("Just plain text.");
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("Just plain text.");
  });

  it("handles multi-segment with gesture + emotion", () => {
    const input = "[EMOTION:senang][GESTURE:wave_hi] Halo! [EMOTION:malu] Eh, malu.";
    const segs = parseSegments(input);
    expect(segs).toHaveLength(2);
    expect(segs[0].actions.emotion).toBe("senang");
    expect(segs[0].actions.gesture).toBe("wave_hi");
    expect(segs[1].actions.emotion).toBe("malu");
  });
});

describe("guessEmotion", () => {
  it("detects happy", () => {
    expect(guessEmotion("Haha lucu banget!")).toBe("senang");
  });

  it("detects sad", () => {
    expect(guessEmotion("Aku sedih sekali")).toBe("sedih");
  });

  it("detects surprised", () => {
    expect(guessEmotion("Wah serius?!")).toBe("kaget");
  });

  it("defaults to normal", () => {
    expect(guessEmotion("Hello world")).toBe("normal");
  });

  // Regression: cakupan keyword v1 (agent.js:489-499) harus utuh.
  it("keeps v1 keyword coverage (tersenyum branch + restored keywords)", () => {
    expect(guessEmotion("makasih ya!")).toBe("senang");
    expect(guessEmotion("halo, hai!")).toBe("tersenyum");
    expect(guessEmotion("ayok dekat sama aku")).toBe("malu");
    expect(guessEmotion("loo kok bisa?!")).toBe("kaget");
    expect(guessEmotion("aku gamau!")).toBe("kesal");
    expect(guessEmotion("entahlah")).toBe("bingung");
  });

  it("is null-safe like v1 stripDirectives", () => {
    expect(guessEmotion("")).toBe("normal");
    expect(stripDirectives(undefined as any)).toBe("");
    expect(hasDirectives(undefined as any)).toBe(false);
  });
});

describe("segmentTextFallback", () => {
  it("segments by punctuation", () => {
    const segs = segmentTextFallback("Halo! Apa kabar?");
    expect(segs.length).toBeGreaterThanOrEqual(1);
  });

  it("returns at least one segment", () => {
    const segs = segmentTextFallback("single sentence");
    expect(segs).toHaveLength(1);
  });

  // Regression: fallback v1 selalu memberi gesture (EMOTION_GESTURE_FALLBACK),
  // supaya segmen tanpa directive tetap menggerakkan karakter.
  it("assigns a gesture to every segment (v1 parity)", () => {
    const segs = segmentTextFallback("Aku senang! Lalu aku sedih.");
    for (const s of segs) expect(s.actions.gesture).toBeTruthy();
  });

  it("BODY parse coerces NaN to 0 like v1", () => {
    const segs = parseSegments("[BODY:a,b] tes");
    expect(segs[0].actions.body).toEqual({ x: 0, y: 0, z: 0 });
  });
});
