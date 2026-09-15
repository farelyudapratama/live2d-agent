/**
 * test/exp3-adoption.test.ts — Migrated from test/legacy/test-exp3-adoption.ts.
 *
 * Invariant:
 * Orphan .exp3 files on disk that are not declared in .model3.json must be discovered
 * by server endpoint /api/model/expressions and dynamically adopted into manifest
 * settings by client buildModelSettings() in-memory without modifying user files on disk.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { handleAPI, serveStatic } from "../src/server/index";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const ROOT = path.resolve(import.meta.dir, "..");
const MODEL_DIR = path.join(ROOT, "data", "model");
const appSrc = fs.readFileSync(path.join(ROOT, "static/js/app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "src/server/index.ts"), "utf8");

function extractFn(src: string, name: string): string | null {
  const start =
    src.indexOf("async function " + name + "(") >= 0
      ? src.indexOf("async function " + name + "(")
      : src.indexOf("function " + name + "(");
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

const EXP_BODY = { Type: "Live2D Expression", Parameters: [{ Id: "ParamEX01", Value: 1, Blend: "Add" }] };
function model3(expressions: any[] | null) {
  const fr: any = { Moc: "x.moc3", Textures: ["x.2048/texture_00.png"] };
  if (expressions) fr.Expressions = expressions;
  return { Version: 3, FileReferences: fr };
}

async function apiGet(p: string): Promise<{ status: number; body: string; json: any }> {
  const res = await handleAPI(new Request("http://localhost" + p) as any);
  if (!res) return { status: 404, body: "", json: null };
  const body = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {}
  return { status: res.status, body, json };
}

describe("Expression Adoption (Production Invariant)", () => {
  let nOrphan: string;
  let nDeclared: string;
  let nPartial: string;

  beforeAll(() => {
    nOrphan = stageModel("__exp3_orphan_only", {
      "nested/char.model3.json": model3(null),
      "nested/expr/joy.exp3.json": EXP_BODY,
      "nested/expr/rage.exp3.json": EXP_BODY,
      "nested/deep/sub/wink.exp3.json": EXP_BODY,
    });
    nDeclared = stageModel("__exp3_declared_all", {
      "m.model3.json": model3([
        { Name: "a", File: "a.exp3.json" },
        { Name: "b", File: "b.exp3.json" },
      ]),
      "a.exp3.json": EXP_BODY,
      "b.exp3.json": EXP_BODY,
    });
    nPartial = stageModel("__exp3_partial", {
      "\uFEFFsub/m.model3.json": "\uFEFF" + JSON.stringify(model3([{ Name: "known", File: "known.exp3.json" }])),
      "\uFEFFsub/known.exp3.json": EXP_BODY,
      "\uFEFFsub/\u5446\u732b.exp3.json": EXP_BODY,
      "outside.exp3.json": EXP_BODY,
    });
  });

  afterAll(() => {
    cleanupStaged();
  });

  describe("Server: GET /api/model/expressions", () => {
    test("discovers undeclared .exp3 recursively with relative paths", async () => {
      const a = await apiGet("/api/model/expressions?name=" + nOrphan);
      expect(a.status).toBe(200);
      expect(a.json.expressions.length).toBe(3);
      expect(a.json.declaredCount).toBe(0);
      expect(a.json.expressions.every((e: any) => e.declared === false)).toBe(true);
      expect(a.json.orphanCount).toBe(3);
      expect(a.json.expressions.some((e: any) => e.File === "expr/joy.exp3.json")).toBe(true);
      expect(a.json.expressions.some((e: any) => e.File === "deep/sub/wink.exp3.json")).toBe(true);
      expect(a.json.expressions.some((e: any) => e.Name === "wink")).toBe(true);
    });

    test("handles completely declared manifests without flagging orphans", async () => {
      const b = await apiGet("/api/model/expressions?name=" + nDeclared);
      expect(b.json.orphanCount).toBe(0);
      expect(b.json.expressions.length).toBe(2);
      expect(b.json.expressions.every((e: any) => e.declared === true)).toBe(true);
    });

    test("handles partial declarations, BOM headers, CJK filenames, and skips parent dir escapes", async () => {
      const c = await apiGet("/api/model/expressions?name=" + nPartial);
      expect(c.json.declaredCount).toBe(1);
      expect(c.json.expressions.some((e: any) => e.Name === "known" && e.declared === true)).toBe(true);
      expect(c.json.expressions.some((e: any) => e.Name === "\u5446\u732b" && e.declared === false)).toBe(true);
      expect(c.json.expressions.some((e: any) => e.File.startsWith(".."))).toBe(false);
    });

    test("security path traversal rejection and 404 guards", async () => {
      const t1 = await apiGet("/api/model/expressions?name=../..");
      expect(t1.status).toBe(404);
      const t2 = await apiGet("/api/model/expressions?name=%2E%2E%2F%2E%2E");
      expect(t2.status).toBe(404);
      const t3 = await apiGet("/api/model/expressions?name=does_not_exist");
      expect(t3.status).toBe(404);
    });

    test("read-only guarantee: disk manifest and folder structure unchanged after discovery", async () => {
      const m3 = path.join(MODEL_DIR, nOrphan, "nested", "char.model3.json");
      const before = fs.readFileSync(m3);
      await apiGet("/api/model/expressions?name=" + nOrphan);
      await apiGet("/api/model/expressions?name=" + nOrphan);
      expect(Buffer.compare(before, fs.readFileSync(m3))).toBe(0);
      expect(fs.readdirSync(path.join(MODEL_DIR, nOrphan, "nested", "expr")).length).toBe(2);
    });
  });

  describe("Client: buildModelSettings() in-memory merge logic", () => {
    const fnSrc = extractFn(appSrc, "buildModelSettings");
    const filterSrc = extractFn(appSrc, "filterAdoptable");
    const combined = (filterSrc ? filterSrc + "\n" : "") + (fnSrc || "");

    test("functions exist in app.js", () => {
      expect(fnSrc).not.toBeNull();
      expect(filterSrc).not.toBeNull();
    });

    async function run(manifest: any, discovery: any, modelPath = "model/foo/sub/char.model3.json") {
      const logs: string[] = [];
      const sandbox: any = {
        API: "http://127.0.0.1:9999",
        location: { href: "http://127.0.0.1:9999/index.html" },
        URL,
        console: { log: (...a: any[]) => logs.push(a.join(" ")), warn: (...a: any[]) => logs.push("WARN " + a.join(" ")) },
        fetch: async (url: any) => {
          if (String(url).includes("/api/model/expressions-adoption")) {
            return { ok: true, json: async () => ({ expressions: [], disabled: [] }) };
          }
          if (String(url).includes("/api/model/expressions")) {
            return { ok: discovery !== null, json: async () => discovery };
          }
          return { ok: manifest !== null, json: async () => manifest };
        },
        Promise,
        Array,
        Set,
        String,
        JSON,
        Object,
        result: undefined,
      };
      vm.createContext(sandbox);
      vm.runInContext(combined + `;result = buildModelSettings(${JSON.stringify(modelPath)});`, sandbox);
      return { out: await sandbox.result, logs };
    }

    test("adopts orphans when manifest declares none", async () => {
      const disc = {
        expressions: [
          { Name: "joy", File: "expr/joy.exp3.json", declared: false },
          { Name: "rage", File: "expr/rage.exp3.json", declared: false },
        ],
      };
      const r = await run(model3(null), disc);
      expect(r.out).not.toBeNull();
      expect(r.out.FileReferences.Expressions.length).toBe(2);
      expect(r.out.FileReferences.Expressions.every((e: any) => Object.keys(e).sort().join(",") === "File,Name")).toBe(true);
      expect(typeof r.out.url === "string" && r.out.url.endsWith("model/foo/sub/char.model3.json")).toBe(true);
      expect(r.out.FileReferences.Moc).toBe("x.moc3");
      expect(r.out.FileReferences.Textures.length).toBe(1);
    });

    test("returns null for completely declared manifests", async () => {
      const r = await run(model3([{ Name: "a", File: "a.exp3.json" }]), {
        expressions: [{ Name: "a", File: "a.exp3.json", declared: true }],
      });
      expect(r.out).toBeNull();
    });

    test("appends undeclared entries while preserving rigger declaration order", async () => {
      const r = await run(model3([{ Name: "known", File: "known.exp3.json" }]), {
        expressions: [
          { Name: "known", File: "known.exp3.json", declared: true },
          { Name: "newone", File: "newone.exp3.json", declared: false },
        ],
      });
      expect(r.out.FileReferences.Expressions.length).toBe(2);
      expect(r.out.FileReferences.Expressions[0].Name).toBe("known");
      expect(r.out.FileReferences.Expressions[1].Name).toBe("newone");
    });

    test("skips duplicate names and duplicate files", async () => {
      const rName = await run(model3([{ Name: "joy", File: "other/joy.exp3.json" }]), {
        expressions: [{ Name: "joy", File: "expr/joy.exp3.json", declared: false }],
      });
      expect(rName.out).toBeNull();

      const rFile = await run(model3([{ Name: "alias", File: "expr/joy.exp3.json" }]), {
        expressions: [{ Name: "joy", File: "expr/joy.exp3.json", declared: false }],
      });
      expect(rFile.out).toBeNull();
    });

    test("failure modes gracefully fall back to null without blocking model load", async () => {
      const disc = { expressions: [{ Name: "joy", File: "expr/joy.exp3.json", declared: false }] };
      expect((await run(null, disc)).out).toBeNull();
      expect((await run(model3(null), null)).out).toBeNull();
      expect((await run({ Version: 3 }, disc)).out).toBeNull();
      expect((await run(model3(null), { expressions: [] })).out).toBeNull();
      expect((await run(model3(null), {})).out).toBeNull();
      expect((await run(model3(null), disc, "model/only-two-parts.json")).out).toBeNull();
      expect((await run(model3(null), disc, "sheets/notamodel.json")).out).toBeNull();
    });

    test("model-agnostic guarantees: arbitrary names preserved, no hardcoded model names", async () => {
      const r = await run(model3(null), {
        expressions: [
          { Name: "\u5446\u732b", File: "\u5446\u732b.exp3.json", declared: false },
          { Name: "01", File: "numbered/01.exp3.json", declared: false },
          { Name: "exp_angry", File: "mothion/exp_angry.exp3.json", declared: false },
        ],
      });
      const names: string[] = r.out ? r.out.FileReferences.Expressions.map((e: any) => e.Name) : [];
      expect(names.join(",")).toBe("\u5446\u732b,01,exp_angry");

      const banned = [/['"]lumine['"]/i, /\u795e\u5bab\u767d\u5b50/, /exp_angry/, /['"]mothion['"]/i, /\u5446\u732b/];
      const hits = banned.filter((re) => re.test(fnSrc || ""));
      expect(hits.length).toBe(0);

      const discServer = extractFn(serverSrc, "discoverExpressions");
      expect(discServer).not.toBeNull();
      const srvHits = banned.filter((re) => re.test(discServer || ""));
      expect(srvHits.length).toBe(0);
    });
  });

  describe("Real models in data/model/", () => {
    test("verifies discovery and static fetchability for real disk models", async () => {
      const list = await apiGet("/api/models");
      const models = (list.json && list.json.models) || [];
      expect(models.length).toBeGreaterThan(0);

      for (const name of models) {
        const r = await apiGet("/api/model/expressions?name=" + encodeURIComponent(name));
        if (r.status !== 200) continue;
        const d = r.json;
        const orphans = d.expressions.filter((e: any) => !e.declared);
        expect(d.expressions.every((e: any) => !e.File.startsWith(".."))).toBe(true);
        expect(d.orphanCount).toBe(orphans.length);

        const base = d.model3.split("/").slice(0, -1).join("/");
        for (const e of d.expressions.slice(0, 3)) {
          const url = "/" + base + "/" + e.File;
          const hit = serveStatic(url.split("/").map(encodeURIComponent).join("/").replace(/%2F/g, "/"));
          expect(hit !== null && hit.status === 200).toBe(true);
        }
      }
    });
  });
});
