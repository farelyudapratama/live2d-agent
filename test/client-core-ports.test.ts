import { describe, expect, it } from "bun:test";
import { scaleRoleFraction } from "../src/client/agent/param-range";
import { toActual } from "../src/client/engine/role-mapping";
import { collectNativeExpressions } from "../src/client/engine/native-expressions";

function profile(range: Record<string, { min: number; max: number; def: number }>) {
  return { roleIds: { angleX: "opaque-id" }, paramRange: range, sheet: null } as any;
}

describe("role-space AgentBrain", () => {
  it("menghasilkan skala referensi, bukan nilai aktual model", () => {
    const cap = profile({ "opaque-id": { min: 0, max: 100, def: 50 } });
    const reference = scaleRoleFraction(cap, "angleX", 0.2);
    expect(reference).toBe(6);
    expect(toActual("angleX", reference, cap.paramRange["opaque-id"])).toBe(60);
  });

  it("range model tidak mengubah intent role-space", () => {
    const asymmetric = profile({ "opaque-id": { min: -10, max: 40, def: 15 } });
    const standard = profile({ "opaque-id": { min: -30, max: 30, def: 0 } });
    expect(scaleRoleFraction(asymmetric, "angleX", -0.5)).toBe(-15);
    expect(scaleRoleFraction(standard, "angleX", -0.5)).toBe(-15);
  });

  it("role hilang aman menjadi nol", () => {
    expect(scaleRoleFraction(profile({}), "angleY", 0.5)).toBe(0);
  });

  it("profil belum tersedia tetap memakai role-space resmi", () => {
    expect(scaleRoleFraction(null, "angleX", -0.5)).toBe(-15);
    expect(scaleRoleFraction(null, "eyeBallX", 0.5)).toBe(0.5);
  });
});

describe("collectNativeExpressions", () => {
  it("union stabil dan dedupe dengan nama asli", () => {
    const model = {
      expressions: { "喜び": {}, "wink-left": {} },
      internalModel: {
        motionManager: { expressionManager: { definitions: [{ Name: "喜び" }, { Name: "怒り 強" }] } },
        settings: { expressions: [{ Name: "wink-left" }, { Name: "驚き!" }] },
      },
    };
    expect(collectNativeExpressions(model)).toEqual(["喜び", "wink-left", "怒り 強", "驚き!"]);
  });

  it("mengabaikan entri malformed", () => {
    expect(collectNativeExpressions({
      expressions: ["ok", null, 2],
      internalModel: { settings: { expressions: [{}, null, { Name: 4 }] } },
    } as any)).toEqual(["ok"]);
  });

  it("getter yang melempar tidak menggagalkan sumber lain", () => {
    const model: any = { internalModel: { settings: { expressions: [{ Name: "aman" }] } } };
    Object.defineProperty(model, "expressions", { get() { throw new Error("rusak"); } });
    expect(collectNativeExpressions(model)).toEqual(["aman"]);
  });
});
