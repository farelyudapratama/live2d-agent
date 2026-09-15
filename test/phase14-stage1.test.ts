/**
 * phase14-stage1.test.ts — Phase 14 Stage 1: Model identity & control axes.
 *
 * Mengunci:
 *   - modelName muncul di system prompt (bila tersedia).
 *   - controlAxes muncul di system prompt: axis yang ada = terdaftar,
 *     axis yang tidak ada = tidak disebut + peringatan.
 *   - Format lama (emosi, gesture, directive, expression, aksesoris) tetap utuh.
 *   - Tidak ada raw parameter ID atau range yang bocor ke Speaker LLM context.
 *   - Model switch → profil baru → prompt berubah (tidak stale).
 *   - animateTextViaDirector mengirim controlAxes + modelName ke server.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const brainSrc = readFileSync(join(ROOT, "src/client/agent/brain.ts"), "utf8");

// ── Fake profile factory ──
function fakeProfile(overrides: Record<string, any> = {}): any {
  return {
    emotions: ["senang", "sedih", "normal"],
    nativeExpressions: ["exp_01", "exp_02"],
    accessories: [],
    properties: [],
    gestures: ["nod", "shake"],
    motionCatalog: [],
    sheet: {
      config: { displayName: "TestChan" },
      params: [],
    },
    userNote: "",
    roleIds: {},
    paramRange: {},
    modelName: "Ren",
    controlAxes: { head: true, eyes: true, mouth: true, body: false, brow: false },
    ...overrides,
  };
}

// ── Helpers ──
// buildSystemPrompt is private — access via (brain as any).
// The pattern mirrors brain-apply-actions.test.ts.
function getBrainWithProfile(profile: any) {
  // Import in test to avoid window/document side effects at module level.
  // brain.ts checks `typeof window` for installation — safe in bun:test.
  const { AgentBrain } = require("../src/client/agent/brain");
  const brain: any = new AgentBrain();
  brain.capProfile = profile;
  return brain;
}

function buildPrompt(profile: any): string {
  const brain = getBrainWithProfile(profile);
  return brain.buildSystemPrompt("");
}

// ── Tests ──
describe("Phase 14 Stage 1 — Model Identity", () => {
  test("modelName appears in system prompt when available", () => {
    const prompt = buildPrompt(fakeProfile({ modelName: "Lumine" }));
    expect(prompt).toContain("model: Lumine");
  });

  test("modelName omitted when empty string", () => {
    const prompt = buildPrompt(fakeProfile({ modelName: "" }));
    expect(prompt).not.toContain("model:");
  });

  test("character name from sheet.config.displayName still present", () => {
    const prompt = buildPrompt(fakeProfile());
    expect(prompt).toContain("TestChan");
  });

  test("character name takes precedence — model identity is supplementary", () => {
    const prompt = buildPrompt(fakeProfile({ modelName: "SomeModel" }));
    // Both should appear: character name in main line, model in parentheses
    expect(prompt).toContain("TestChan");
    expect(prompt).toContain("model: SomeModel");
  });
});

describe("Phase 14 Stage 1 — Control Axes", () => {
  test("available axes appear in prompt", () => {
    const prompt = buildPrompt(fakeProfile());
    // head, eyes, mouth are true → should appear
    expect(prompt).toContain("head");
    expect(prompt).toContain("eyes");
    expect(prompt).toContain("mouth");
  });

  test("unavailable axes NOT listed in axis line", () => {
    const prompt = buildPrompt(fakeProfile());
    // body and brow are false → should NOT appear in the axis list
    // The axis line format is: "Axis kontrol: head, eyes, mouth ..."
    const axisMatch = prompt.match(/Axis kontrol:\s*([^\n]+)/);
    expect(axisMatch).toBeTruthy();
    const axisLine = axisMatch![1];
    expect(axisLine).toContain("head");
    expect(axisLine).toContain("eyes");
    expect(axisLine).toContain("mouth");
    expect(axisLine).not.toMatch(/\bbody\b/);
    expect(axisLine).not.toMatch(/\bbrow\b/);
  });

  test("warning about unavailable axes is present", () => {
    const prompt = buildPrompt(fakeProfile());
    expect(prompt).toContain("jangan pakai directive untuk axis yang tidak ada");
  });

  test("all axes available → all five listed", () => {
    const prompt = buildPrompt(fakeProfile({
      controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: true },
    }));
    const axisMatch = prompt.match(/Axis kontrol:\s*([^\n]+)/);
    expect(axisMatch).toBeTruthy();
    const axisLine = axisMatch![1];
    expect(axisLine).toContain("head");
    expect(axisLine).toContain("eyes");
    expect(axisLine).toContain("mouth");
    expect(axisLine).toContain("body");
    expect(axisLine).toContain("brow");
  });

  test("no axes available → no axis line", () => {
    const prompt = buildPrompt(fakeProfile({
      controlAxes: { head: false, eyes: false, mouth: false, body: false, brow: false },
    }));
    expect(prompt).not.toContain("Axis kontrol:");
  });

  test("missing controlAxes object → no axis line (graceful)", () => {
    const prompt = buildPrompt(fakeProfile({ controlAxes: undefined }));
    expect(prompt).not.toContain("Axis kontrol:");
  });
});

describe("Phase 14 Stage 1 — Existing prompt sections intact", () => {
  const prompt = buildPrompt(fakeProfile());

  test("emotions section present", () => {
    expect(prompt).toContain("DAFTAR EMOSI");
    expect(prompt).toContain("senang");
    expect(prompt).toContain("[EMOTION:nama]");
  });

  test("expressions section present", () => {
    expect(prompt).toContain("DAFTAR EXPRESSION");
    expect(prompt).toContain("exp_01");
  });

  test("gestures section present", () => {
    expect(prompt).toContain("DAFTAR GESTURE");
    expect(prompt).toContain("nod");
    expect(prompt).toContain("shake");
  });

  test("directive format section present", () => {
    expect(prompt).toContain("FORMAT DIRECTIVE");
    expect(prompt).toContain("[EMOTION:senang]");
    expect(prompt).toContain("[GESTURE:nama]");
    expect(prompt).toContain("[HEAD:x,y]");
    expect(prompt).toContain("[EYES:x,y]");
    expect(prompt).toContain("[MOUTH:form,open]");
    expect(prompt).toContain("[BODY:x,y,z]");
  });

  test("multi-segment instructions present", () => {
    expect(prompt).toContain("MULTI-SEGMENT");
  });

  test("rules section present", () => {
    expect(prompt).toContain("ATURAN");
  });

  test("language section present", () => {
    expect(prompt).toContain("BAHASA");
  });
});

describe("Phase 14 Stage 1 — Parameter privacy", () => {
  const prompt = buildPrompt(fakeProfile());

  test("no raw parameter IDs in Speaker prompt", () => {
    // Common Cubism parameter IDs
    expect(prompt).not.toContain("ParamAngleX");
    expect(prompt).not.toContain("ParamAngleY");
    expect(prompt).not.toContain("ParamMouthOpenY");
    expect(prompt).not.toContain("ParamEyeLOpen");
    expect(prompt).not.toContain("ParamBodyAngleX");
  });

  test("no raw parameter ranges in Speaker prompt", () => {
    // No numeric range patterns like "-30..30" or "min/max"
    expect(prompt).not.toMatch(/-30\.\.30/);
    expect(prompt).not.toMatch(/min:\s*-?\d/);
    expect(prompt).not.toMatch(/max:\s*-?\d/);
  });

  test("paramRange not sent to prompt builder", () => {
    // paramRange is in profile but should NOT appear in the prompt text
    expect(prompt).not.toContain("paramRange");
  });
});

describe("Phase 14 Stage 1 — Model switching", () => {
  test("different modelName → different prompt", () => {
    const promptA = buildPrompt(fakeProfile({ modelName: "Ren" }));
    const promptB = buildPrompt(fakeProfile({ modelName: "Lumine" }));
    expect(promptA).toContain("model: Ren");
    expect(promptB).toContain("model: Lumine");
    expect(promptA).not.toContain("model: Lumine");
    expect(promptB).not.toContain("model: Ren");
  });

  test("different controlAxes → different prompt", () => {
    const promptA = buildPrompt(fakeProfile({
      controlAxes: { head: true, eyes: true, mouth: true, body: false, brow: false },
    }));
    const promptB = buildPrompt(fakeProfile({
      controlAxes: { head: false, eyes: true, mouth: false, body: true, brow: true },
    }));
    // promptA has head in axis list, promptB does not
    const axA = promptA.match(/Axis kontrol:\s*([^\n]+)/)?.[1] || "";
    const axB = promptB.match(/Axis kontrol:\s*([^\n]+)/)?.[1] || "";
    expect(axA).toContain("head");
    expect(axB).not.toMatch(/\bhead\b/);
    expect(axB).toContain("body");
    expect(axB).toContain("brow");
  });

  test("invalidateCapabilityProfile clears profile (brain.ts contract)", () => {
    const { AgentBrain } = require("../src/client/agent/brain");
    const brain: any = new AgentBrain();
    brain.capProfile = fakeProfile();
    expect(brain.capProfile).not.toBeNull();
    brain.invalidateCapabilityProfile();
    expect(brain.capProfile).toBeNull();
  });
});

describe("Phase 14 Stage 1 — source code invariants", () => {
  test("brain.ts references controlAxes", () => {
    expect(brainSrc).toContain("controlAxes");
  });

  test("brain.ts references modelName", () => {
    expect(brainSrc).toContain("cap.modelName");
  });

  test("CapabilityProfile type includes modelName", () => {
    const typesSrc = readFileSync(join(ROOT, "src/shared/types.ts"), "utf8");
    expect(typesSrc).toContain("modelName: string");
    expect(typesSrc).toContain("controlAxes");
  });

  test("app.js getCapabilityProfile returns modelName and controlAxes", () => {
    const appSrc = readFileSync(join(ROOT, "static/js/app.js"), "utf8");
    // Verify the return object includes the new fields (search full file)
    expect(appSrc).toContain("modelName: sheet.modelName || \"\"");
    expect(appSrc).toContain("controlAxes: {");
    expect(appSrc).toContain("head: !!sheet.controls.head");
    expect(appSrc).toContain("eyes: !!sheet.controls.eyes");
    expect(appSrc).toContain("mouth: !!sheet.controls.mouth");
    expect(appSrc).toContain("body: !!sheet.controls.body");
    expect(appSrc).toContain("brow: !!sheet.controls.eyebrows");
  });

  test("server animate-text extracts controlAxes and modelName", () => {
    const serverSrc = readFileSync(join(ROOT, "src/server/index.ts"), "utf8");
    expect(serverSrc).toContain("caps.controlAxes");
    expect(serverSrc).toContain("caps.modelName");
    expect(serverSrc).toContain("Axis kontrol model");
  });

  test("brain.ts passes controlAxes + modelName to animate-text", () => {
    expect(brainSrc).toContain("controlAxes:");
    expect(brainSrc).toContain("modelName:");
    // Verify it's in the capabilities object sent to /api/animate-text
    const fetchBlock = brainSrc.slice(
      brainSrc.indexOf('fetch(API + "/api/animate-text"'),
      brainSrc.indexOf('fetch(API + "/api/animate-text"') + 800,
    );
    expect(fetchBlock).toContain("controlAxes");
    expect(fetchBlock).toContain("modelName");
  });
});
