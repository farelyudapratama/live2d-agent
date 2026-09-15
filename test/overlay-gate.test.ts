/**
 * test/overlay-gate.test.ts — Migrated from test/legacy/test-overlay-gate.ts.
 *
 * Invariant:
 * The overlay-vs-native gate (overlayGateSuppress in app.js) must prevent double-drawing
 * emotion effects when the Live2D model's native rig binds to that parameter and is
 * confirmed alive (changed > 0), while failing-open on any uncertainty.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { handleAPI } from "../src/server/index";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const ROOT = path.resolve(import.meta.dir, "..");
const MODEL_DIR = path.join(ROOT, "data", "model");
const appSrc = fs.readFileSync(path.join(ROOT, "static/js/app.js"), "utf8");

function extractFn(src: string, name: string): string | null {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) return null;
  let depth = 0,
    i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const staged: string[] = [];
function stageModel(name: string, files: Record<string, string | object>) {
  const base = path.join(MODEL_DIR, name);
  staged.push(base);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body, null, 1));
  }
  return name;
}
function cleanupStaged() {
  for (const dir of staged) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

async function apiGet(p: string): Promise<{ status: number; json: any }> {
  const res = await handleAPI(new Request("http://localhost" + p) as any);
  if (!res) return { status: 404, json: null };
  const body = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {}
  return { status: res.status, json };
}

describe("Overlay Gate (Production Invariant)", () => {
  let n: string;

  beforeAll(() => {
    n = stageModel("__gate_bindings", {
      "m.model3.json": {
        Version: 3,
        FileReferences: {
          Moc: "x.moc3",
          Textures: ["t.png"],
          Expressions: [{ Name: "known", File: "known.exp3.json" }],
        },
      },
      "known.exp3.json": {
        Type: "Live2D Expression",
        Parameters: [
          { Id: "ParamEX04", Value: 1 },
          { Id: "ParamEX08", Value: 1 },
        ],
      },
      "orph.exp3.json": { Type: "Live2D Expression", Parameters: [{ Id: "Param91", Value: 0.5 }] },
      "multi.exp3.json": {
        Type: "Live2D Expression",
        Parameters: [
          { Id: "A", Value: 1 },
          { Id: "A", Value: 2 },
          { Id: "B", Value: 0 },
        ],
      },
      "broken.exp3.json": "{ ini bukan json",
      "noparams.exp3.json": { Type: "Live2D Expression" },
    });
  });

  afterAll(() => {
    cleanupStaged();
  });

  describe("Server: GET /api/model/expressions includes param bindings", () => {
    test("returns 200 and reports all expression files with parameters", async () => {
      const res = await apiGet("/api/model/expressions?name=" + n);
      expect(res.status).toBe(200);
      const list = res.json && Array.isArray(res.json.expressions) ? res.json.expressions : [];
      expect(list.length).toBe(5);

      const by = (nm: string) => list.find((e: any) => e && e.Name === nm);
      expect(by("known")?.params).toEqual(["ParamEX04", "ParamEX08"]);
      expect(!by("orph")?.declared && by("orph")?.params).toEqual(["Param91"]);
      expect(by("multi")?.params).toEqual(["A", "B"]);
      expect(Array.isArray(by("broken")?.params) && by("broken")?.params.length === 0).toBe(true);
      expect(Array.isArray(by("noparams")?.params) && by("noparams")?.params.length === 0).toBe(true);
      expect(!!by("known")?.File && typeof by("known")?.declared === "boolean").toBe(true);
    });
  });

  describe("Client: overlayGateSuppress (vm-extract)", () => {
    const src = extractFn(appSrc, "overlayGateSuppress");
    test("function exists in app.js", () => {
      expect(src).not.toBeNull();
    });

    test("suppresses overlay only when confirmed alive and handles fail-open", () => {
      if (!src) return;
      const sandbox: any = {};
      vm.createContext(sandbox);
      vm.runInContext(src + "\nthis.__f = overlayGateSuppress;", sandbox);
      const gate: (n: string, b: any, v: any, r: any) => boolean = sandbox.__f;

      const visfxAlive = { ParamEX04: { changed: 512, maxDelta: 255, at: 1 } };
      const visfxDead = { ParamEX04: { changed: 0, maxDelta: 0, at: 1 } };
      const resolveHeart = (n: string) => (n && /heart/i.test(String(n)) ? { key: "heart" } : null);
      const bind = { exp_heart: ["ParamEX04"] };

      expect(gate("exp_heart", bind, visfxAlive, resolveHeart)).toBe(true);
      expect(gate("user:exp_heart", bind, visfxAlive, resolveHeart)).toBe(true);
      expect(gate("exp_heart", bind, visfxDead, resolveHeart)).toBe(false);
      expect(gate("exp_heart", bind, null, resolveHeart)).toBe(false);
      expect(gate("exp_heart", bind, { ParamLain: { changed: 999, maxDelta: 9, at: 1 } }, resolveHeart)).toBe(false);
      expect(gate("sedih", bind, visfxAlive, (n: string) => (n === "sedih" ? { key: "tear" } : null))).toBe(false);
      expect(gate("exp_heart", bind, visfxAlive, null) === false && gate("exp_heart", bind, visfxAlive, 42 as any) === false).toBe(true);
      expect(gate("collar_blue", bind, visfxAlive, resolveHeart)).toBe(false);
      expect(
        gate("exp_heart", { exp_heart: [] }, visfxAlive, resolveHeart) === false &&
        gate("exp_heart", null, visfxAlive, resolveHeart) === false
      ).toBe(true);
      expect(
        gate(
          "exp_heart",
          { exp_heart: ["ParamEX04", "ParamEX08", "ParamEX11"] },
          { ParamEX04: { changed: 0, maxDelta: 0, at: 1 }, ParamEX08: { changed: 77, maxDelta: 77, at: 1 } },
          resolveHeart
        )
      ).toBe(true);
    });

    test("model-agnostic: handles arbitrary opaque ids without assumptions", () => {
      if (!src) return;
      const sandbox: any = {};
      vm.createContext(sandbox);
      vm.runInContext(src + "\nthis.__f = overlayGateSuppress;", sandbox);
      const gate: (n: string, b: any, v: any, r: any) => boolean = sandbox.__f;

      const opaque = { m_001: ["m_01", "m_02"] };
      const resolveOpaque = (n: string) => (n === "m_001" ? { key: "sparkle" } : null);

      expect(gate("m_001", opaque, { m_01: { changed: 3, maxDelta: 3, at: 1 } }, resolveOpaque)).toBe(true);
      expect(gate("m_001", opaque, { m_01: { changed: 0, maxDelta: 0, at: 1 }, m_02: { changed: 0, maxDelta: 0, at: 1 } }, resolveOpaque)).toBe(false);
      expect(
        gate(null as any, opaque, { m_01: { changed: 3, maxDelta: 3, at: 1 } }, resolveOpaque) === false &&
        gate(7 as any, opaque, { m_01: { changed: 3, maxDelta: 3, at: 1 } }, resolveOpaque) === false
      ).toBe(true);
    });
  });

  describe("Wiring level source guards", () => {
    test("app.js and server wiring", () => {
      expect(/overlayShouldSuppress\(name\)[\s\S]{0,200}__emotionOverlay && window\.__emotionOverlay\.onExpression\(name\)/.test(appSrc)).toBe(true);
      expect(/detectModelCapabilities\(\);[\s\S]{0,120}prefetchOverlayGate\(\)/.test(appSrc)).toBe(true);
      expect(/overlayGateSuppress\(\s*\n\s*name,\s*\n\s*overlayGateExpBindingsSync\(\),\s*\n\s*state\.visfxMap/.test(appSrc)).toBe(true);
      expect(appSrc.includes("Array.isArray(e.params)")).toBe(true);
      expect(/overlayGateModelPath !== \(state\.modelPath \|\| ''\)/.test(appSrc)).toBe(true);
      expect(/readFileSync\(full,\s*"utf8"\)[\s\S]{0,120}\.Parameters/.test(fs.readFileSync(path.join(ROOT, "src", "server", "index.ts"), "utf8"))).toBe(true);
    });
  });
});
