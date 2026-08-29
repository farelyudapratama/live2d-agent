/**
 * server-integration.test.ts — prove the v2 server actually implements the API
 * contract the (legacy) static client depends on. We call the real dispatcher
 * (src/server/index.ts → handleAPI) with constructed Request objects — no socket,
 * no external LLM — so parity is verified by execution, not by reading prose.
 */
import { describe, it, expect } from "bun:test";
import { handleAPI, serveStatic } from "../src/server/index";

const BASE = "http://localhost:8310";

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: {} as any };
  if (body !== undefined) {
    (init.headers as any)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return handleAPI(new Request(BASE + path, init) as any);
}

describe("server API parity (dispatcher-level)", () => {
  // Endpoints the legacy client (static/js/app.js, agent.js, motion-editor.js) calls.
  const clientEndpoints = [
    ["POST", "/api/chat"],
    ["POST", "/api/tts"],
    ["GET", "/api/config"],
    ["POST", "/api/config"],
    ["POST", "/api/test"],
    ["POST", "/api/model/classify-params"],
    ["POST", "/api/model/analyze-sheet"],
    ["POST", "/api/animate-text"],
    ["POST", "/api/motions/analyze"],
    ["POST", "/api/motions/generate"],
    ["POST", "/api/sheet"],
    ["GET", "/api/sheet"],
    ["GET", "/api/models"],
    ["GET", "/api/model/path"],
    ["GET", "/api/model/expressions"],
    ["GET", "/api/model/expressions-adoption"],
    ["POST", "/api/model/expressions-adoption"],
    ["GET", "/api/model/files"],
    ["GET", "/api/model/motion-taxonomy"],
    ["POST", "/api/model/import-zip"],
    ["POST", "/api/model/upload"],
    ["DELETE", "/api/model/lumine"],
    ["GET", "/api/motions"],
    ["POST", "/api/motions"],
    ["PUT", "/api/motions/some-id"],
    ["GET", "/api/motions/some-id"],
    ["DELETE", "/api/motions/some-id"],
  ] as const;

  for (const [method, path] of clientEndpoints) {
    it(`${method} ${path} is handled by the dispatcher`, async () => {
      const res = await call(method as string, path as string, { model: "lumine" });
      // Not every endpoint will succeed without setup, but ALL must be recognized
      // (handleAPI returns non-null) — a null response would mean a 404/route miss.
      expect(res).not.toBeNull();
      expect(res).toBeInstanceOf(Response);
    });
  }

  it("unknown route is NOT claimed by the dispatcher (returns null => SPA fallback)", async () => {
    const res = await call("GET", "/api/does-not-exist");
    expect(res).toBeNull();
  });

  it("/api/config returns valid JSON shape", async () => {
    const res = await call("GET", "/api/config");
    expect(res).not.toBeNull();
    const json = await (res as Response).json();
    expect(json).toHaveProperty("connections");
    expect(json).toHaveProperty("events");
  });

  it("/api/models returns the bundled model folders", async () => {
    const res = await call("GET", "/api/models");
    expect(res).not.toBeNull();
    const json = await (res as Response).json();
    expect(Array.isArray(json.models)).toBe(true);
    expect(json.models.length).toBeGreaterThan(0);
    // CJK-named models must be handled (no 404 on decode)
    expect(json.models).toContain("神宫白子");
  });

  it("/api/model/motion-taxonomy works WITHOUT the v1 sibling repo present", async () => {
    // The server must be self-contained: it imports its own static/js/motion-taxonomy.js,
    // never the ../live2d-agent copy. If this resolves, the cross-repo dependency is gone.
    const res = await call("GET", "/api/model/motion-taxonomy?name=" + encodeURIComponent("神宫白子"));
    expect(res).not.toBeNull();
    const json = await (res as Response).json();
    expect(json).toHaveProperty("clips");
    expect(Array.isArray(json.clips)).toBe(true);
  });
});

describe("static serving security", () => {
  it("index.html dan bundle tersedia", () => {
    // "/" → "/index.html" rewrite terjadi di fetch handler; di level
    // serveStatic kita cek file-nya langsung.
    expect(serveStatic("/index.html")?.status).toBe(200);
    expect(serveStatic("/js/bundle.js")?.status).toBe(200);
  });

  it("model CJK tersajikan lewat fallback DATA", () => {
    const res = serveStatic("/model/" + encodeURIComponent("神宫白子") + "/" + encodeURIComponent("面饼0.model3.json"));
    expect(res?.status).toBe(200);
  });

  it("config.json (apiKey plaintext) TIDAK pernah disajikan statis — 403", () => {
    expect(serveStatic("/config.json")?.status).toBe(403);
    expect(serveStatic("/config.json.bak")?.status).toBe(403);
  });

  it("path traversal dijawab 403, bukan SPA fallback", () => {
    // Catatan: di HTTP nyata, parser URL WHATWG (Bun) melipat SEMUA bentuk
    // dot-segment ("..", "%2e%2e") sebelum fetch handler — jadi cek 403 ini
    // adalah lapisan pertahanan terakhir di level safeJoinStatic.
    expect(serveStatic("/../server/index.ts")?.status).toBe(403);
    expect(serveStatic("/js/../../server/index.ts")?.status).toBe(403);
    expect(serveStatic("/%2e%2e/server/index.ts")?.status).toBe(403);
  });

  it("file yang benar-benar tidak ada tetap null (boleh SPA fallback)", () => {
    expect(serveStatic("/js/tidak-ada-xyz.js")).toBeNull();
  });
});
