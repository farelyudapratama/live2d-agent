/**
 * mouse-follow-gain.test.ts — kalibrasi gain mouse-follow (resolver murni).
 * Default WAJIB mereproduksi nilai literal lama di handler app.js:
 * head ±30, body ±30×0.25, eye ±1.
 */
import { describe, test, expect } from "bun:test";
import {
  MOUSE_FOLLOW_DEFAULTS,
  MOUSE_FOLLOW_PRESETS,
  resolveMouseFollowGains,
} from "../src/client/engine/mouse-follow-gain";
import { roleClampActual, toActual } from "../src/client/engine/role-mapping";

describe("mouse-follow gain resolver", () => {
  test("1. default configuration reproduces current values", () => {
    expect(resolveMouseFollowGains(null)).toEqual(MOUSE_FOLLOW_DEFAULTS);
    expect(resolveMouseFollowGains(undefined)).toEqual(MOUSE_FOLLOW_DEFAULTS);
    expect(resolveMouseFollowGains({})).toEqual(MOUSE_FOLLOW_DEFAULTS);
    expect(resolveMouseFollowGains({ preset: "default" })).toEqual(
      MOUSE_FOLLOW_DEFAULTS,
    );
    // nilai literal lama: nx*30 / nx*30*0.25 / nx*1
    expect(MOUSE_FOLLOW_DEFAULTS).toEqual({
      headGainX: 30,
      headGainY: 30,
      bodyGainX: 0.25,
      bodyGainY: 0.25,
      eyeGainX: 1,
      eyeGainY: 1,
    });
  });

  test("2. changing head gain changes head target magnitude", () => {
    const nx = -0.7;
    const def = resolveMouseFollowGains(null);
    const strong = resolveMouseFollowGains({ preset: "strong" });
    const tDef = nx * def.headGainX;
    const tStrong = nx * strong.headGainX;
    expect(Math.abs(tStrong)).toBeGreaterThan(Math.abs(tDef));
    expect(strong.headGainX).toBe(40);
    // preset wild
    expect(resolveMouseFollowGains({ preset: "wild" }).headGainX).toBe(50);
  });

  test("3. changing body gain changes body target magnitude", () => {
    const nx = -1;
    const REF_HALF = 30; // skala referensi role (RM.REF_HALF) — konstanta engine
    const def = nx * REF_HALF * resolveMouseFollowGains(null).bodyGainX;
    const strong = nx * REF_HALF * resolveMouseFollowGains({ preset: "strong" }).bodyGainX;
    const wild = nx * REF_HALF * resolveMouseFollowGains({ preset: "wild" }).bodyGainX;
    expect(def).toBeCloseTo(-7.5, 5);
    expect(Math.abs(strong)).toBeGreaterThan(Math.abs(def));
    expect(Math.abs(wild)).toBeGreaterThan(Math.abs(strong));
  });

  test("4. eye gain remains independently configurable", () => {
    const g = resolveMouseFollowGains({ preset: "strong", eyeGainX: 1.5, eyeGainY: 1.2 });
    expect(g.eyeGainX).toBe(1.5);
    expect(g.eyeGainY).toBe(1.2);
    // head/body preset tidak terpengaruh
    expect(g.headGainX).toBe(40);
    expect(g.bodyGainX).toBe(0.5);
    // dan eye default tetap 1
    expect(resolveMouseFollowGains(null).eyeGainX).toBe(1);
  });

  test("5. gain does not bypass existing parameter range safety", () => {
    // jalur tulis existing: toActual (skala ref → range model) →
    // roleClampActual → clamp ParameterApi. Target sebesar apa pun hasilnya
    // WAJIB berada dalam range model.
    const range = { min: -30, max: 30, def: 0 };
    const bodyRange = { min: -10, max: 10, def: 0 };
    const wild = resolveMouseFollowGains({ preset: "wild" });
    const wildHead = wild.headGainX; // 50 ref
    const wildBody = 30 * wild.bodyGainX; // 22.5 ref
    const headClamped = roleClampActual("angleX", toActual("angleX", -wildHead, range), range);
    expect(headClamped).toBeGreaterThanOrEqual(-30);
    expect(headClamped).toBeLessThanOrEqual(30);
    const bodyClamped = roleClampActual("bodyAngleX", toActual("bodyAngleX", -wildBody, bodyRange), bodyRange);
    expect(bodyClamped).toBeGreaterThanOrEqual(-10);
    expect(bodyClamped).toBeLessThanOrEqual(10);
    expect(bodyClamped).toBeCloseTo(-7.5, 5); // 22.5 ref → 75% dari range ±10
    // clamp benar-benar bekerja untuk nilai di luar range
    expect(roleClampActual("angleX", 45, range)).toBe(30);
    expect(roleClampActual("bodyAngleX", -99, bodyRange)).toBe(-10);
  });

  test("6. preset tak dikenal / nilai tak valid → fail-safe ke default", () => {
    expect(resolveMouseFollowGains({ preset: "gila" })).toEqual(MOUSE_FOLLOW_DEFAULTS);
    const bad = resolveMouseFollowGains({
      headGainX: Number.NaN,
      headGainY: -5,
      bodyGainX: Infinity,
      eyeGainX: "banyak" as unknown as number,
    });
    expect(bad.headGainX).toBe(30);
    expect(bad.headGainY).toBe(30);
    expect(bad.bodyGainX).toBe(0.25);
    expect(bad.eyeGainX).toBe(1);
  });

  test("7. preset tidak saling menular (objek preset tidak dimutasi)", () => {
    const a = resolveMouseFollowGains({ preset: "wild", headGainX: 99 });
    const b = resolveMouseFollowGains({ preset: "wild" });
    expect(a.headGainX).toBe(99);
    expect(b.headGainX).toBe(50);
    expect(MOUSE_FOLLOW_PRESETS.wild.headGainX).toBe(50);
  });
});
