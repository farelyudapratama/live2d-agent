/**
 * test/api-origin.test.ts — Migrated from test/legacy/test-api-origin.js.
 *
 * Invariant:
 * The backend API origin must be dynamically derived via location.origin,
 * never hardcoded to a literal port (such as 127.0.0.1:8310) in client code.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dir, "..");
const appSrc = readFileSync(join(ROOT, "static/js/app.js"), "utf8");
const agentSrc = readFileSync(join(ROOT, "src/client/agent/brain.ts"), "utf8");
const srvSrc = readFileSync(join(ROOT, "src/server/index.ts"), "utf8");

describe("API Origin Derivation (Production Invariant)", () => {
  test("no hardcoded origin outside documented fallbacks", () => {
    for (const [label, src] of [
      ["static/js/app.js", appSrc],
      ["src/client/agent/brain.ts", agentSrc],
    ]) {
      const lines = src.split(/\r?\n/);
      const hits: string[] = [];
      lines.forEach((line, i) => {
        if (!/127\.0\.0\.1:8310|localhost:8310/.test(line)) return;
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
        const isFallback = /:\s*['"]http:\/\/127\.0\.0\.1:8310['"]\s*;?\s*$/.test(line);
        if (isComment || isFallback) return;
        hits.push(`${i + 1}: ${line.trim()}`);
      });
      expect(hits).toEqual([]);
    }
  });

  test("fetches route through API constant and not absolute URLs", () => {
    for (const [label, src] of [
      ["static/js/app.js", appSrc],
      ["src/client/agent/brain.ts", agentSrc],
    ]) {
      const fetches = src.match(/fetch\(\s*['"`]https?:\/\/[^'"`]+/g) || [];
      expect(fetches.length).toBe(0);
      const viaApi = (src.match(/fetch\(API\s*\+/g) || []).length;
      expect(viaApi).toBeGreaterThan(0);
    }
  });

  test("declares its own API constant", () => {
    for (const [label, src] of [
      ["static/js/app.js", appSrc],
      ["src/client/agent/brain.ts", agentSrc],
    ]) {
      expect(/const API\s*=\s*\(?\s*typeof location/.test(src)).toBe(true);
    }
  });

  test("app.js derivation expression behaves across protocols", () => {
    const API_EXPR_RE = /const API = \(typeof location[\s\S]*?'http:\/\/127\.0\.0\.1:8310';/;
    expect(API_EXPR_RE.test(appSrc)).toBe(true);

    function deriveWith(locObj: any) {
      const m = appSrc.match(API_EXPR_RE);
      if (!m) return { err: "expression not found" };
      const sandbox = { location: locObj, __out: undefined };
      vm.createContext(sandbox);
      vm.runInContext(m[0] + "\n;__out = API;", sandbox);
      return { api: sandbox.__out };
    }

    expect(deriveWith({ protocol: "http:", origin: "http://127.0.0.1:8310" }).api).toBe("http://127.0.0.1:8310");
    expect(deriveWith({ protocol: "http:", origin: "http://127.0.0.1:8399" }).api).toBe("http://127.0.0.1:8399");
    expect(deriveWith({ protocol: "http:", origin: "http://192.168.1.50:8310" }).api).toBe("http://192.168.1.50:8310");
    expect(deriveWith({ protocol: "https:", origin: "https://live2d.example.com" }).api).toBe("https://live2d.example.com");
    expect(deriveWith({ protocol: "file:", origin: "null" }).api).toBe("http://127.0.0.1:8310");

    let threw = false;
    let fallbackOut: any;
    try {
      const m = appSrc.match(API_EXPR_RE)!;
      const sb = { __out: undefined };
      vm.createContext(sb);
      vm.runInContext(m[0] + "\n;__out = API;", sb);
      fallbackOut = sb.__out;
    } catch {
      threw = true;
    }
    expect(fallbackOut).toBe("http://127.0.0.1:8310");
    expect(threw).toBe(false);
  });

  test("server reads process.env.PORT and defaults to 8310", () => {
    expect(/Number\(process\.env\.PORT\)\s*\|\|\s*8310/.test(srvSrc)).toBe(true);
    expect(/\|\|\s*8310/.test(srvSrc)).toBe(true);
  });

  test("brain.ts derivation behaves across protocols", () => {
    const BRAIN_API_RE = /const API =[\s\S]*?['"]http:\/\/127\.0\.0\.1:8310['"];/;
    expect(BRAIN_API_RE.test(agentSrc)).toBe(true);

    function deriveBrainWith(locObj: any) {
      const m = agentSrc.match(BRAIN_API_RE);
      if (!m) return { err: "expression not found" };
      const sandbox = { location: locObj, __out: undefined };
      vm.createContext(sandbox);
      vm.runInContext(m[0] + "\n;__out = API;", sandbox);
      return { api: sandbox.__out };
    }

    expect(deriveBrainWith({ protocol: "http:", origin: "http://127.0.0.1:8399" }).api).toBe("http://127.0.0.1:8399");
    expect(deriveBrainWith({ protocol: "https:", origin: "https://live2d.example.com" }).api).toBe("https://live2d.example.com");
    expect(deriveBrainWith({ protocol: "file:", origin: "null" }).api).toBe("http://127.0.0.1:8310");
    expect(deriveBrainWith(undefined).api).toBe("http://127.0.0.1:8310");
  });
});
