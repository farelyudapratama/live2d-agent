import { describe, expect, it } from "bun:test";
import { createBrowserTools } from "../src/server/agent/tools/browser";
import { publicToolArgs, toolByName } from "../src/server/agent/tools/index";
import { assistantStatus } from "../src/server/assistant";
import { makeRuntime, setRuntime } from "../src/server/agent/state";
import type { BrowserInspectResult, BrowserState } from "../src/server/browser/types";

type Call = { name: string; args: unknown[] };

function fakeManager() {
  const calls: Call[] = [];
  const state: BrowserState = {
    available: true, running: true, connected: true, engine: "chrome",
    url: "https://example.com/", title: "Example", canBack: false,
    canForward: false, originGranted: false,
  };
  const manager = {
    status: () => state,
    open: async (...args: unknown[]) => { calls.push({ name: "open", args }); return state; },
    navigate: async (...args: unknown[]) => { calls.push({ name: "navigate", args }); return state; },
    inspect: async (...args: unknown[]): Promise<BrowserInspectResult> => {
      calls.push({ name: "inspect", args });
      return { snapshotId: "bs_1", url: state.url, title: state.title, text: "x".repeat(Number(args[1]) || 0), nextCursor: null, count: 1 };
    },
    click: async (...args: unknown[]) => { calls.push({ name: "click", args }); },
    type: async (...args: unknown[]) => { calls.push({ name: "type", args }); },
    back: async () => { calls.push({ name: "back", args: [] }); },
    forward: async () => { calls.push({ name: "forward", args: [] }); },
    reload: async () => { calls.push({ name: "reload", args: [] }); },
    close: async () => { calls.push({ name: "close", args: [] }); },
    grantPrivateOrigin: (...args: unknown[]) => { calls.push({ name: "grant", args }); },
  };
  return { manager, calls };
}

const ctx = { workDir: ".", noteFile: () => {} };

describe("tool browser agent", () => {
  it("mendaftarkan sembilan tool dengan level yang benar", () => {
    const expected = {
      browser_status: "safe", browser_open: "mutating", browser_navigate: "mutating",
      browser_inspect: "safe", browser_click: "mutating", browser_type: "mutating",
      browser_history: "mutating", browser_close: "mutating", browser_grant_private: "mutating",
    } as const;
    for (const [name, level] of Object.entries(expected)) expect(toolByName(name)?.level).toBe(level);
  });

  it("membatasi inspect maksimum 3500 karakter dan hasil tetap bounded", async () => {
    const { manager, calls } = fakeManager();
    const inspect = createBrowserTools(manager).find((tool) => tool.name === "browser_inspect")!;
    const result = await inspect.run(ctx, { cursor: 4, maxChars: 99_999, snapshotId: "bs_1" });
    expect(calls[0]).toEqual({ name: "inspect", args: [4, 3500, "bs_1"] });
    expect(result.length).toBeLessThanOrEqual(4500);
    expect(JSON.parse(result).text.length).toBe(3500);
  });

  it("open memakai URL default yang deterministik", async () => {
    const { manager, calls } = fakeManager();
    const open = createBrowserTools(manager).find((tool) => tool.name === "browser_open")!;
    await open.run(ctx, {});
    expect(calls[0]).toEqual({ name: "open", args: ["https://example.com"] });
  });

  it("browser_type meredaksi teks dari argumen publik dan hasil", async () => {
    const secret = "rahasia-sangat-panjang";
    const args = { snapshotId: "bs_1", ref: "br_1", text: secret, submit: true };
    const visible = publicToolArgs("browser_type", args);
    expect(visible).toEqual({ snapshotId: "bs_1", ref: "br_1", chars: secret.length, submit: true });
    expect(JSON.stringify(visible)).not.toContain(secret);

    const { manager, calls } = fakeManager();
    const type = createBrowserTools(manager).find((tool) => tool.name === "browser_type")!;
    const result = await type.run(ctx, args);
    expect(calls[0]).toEqual({ name: "type", args: ["bs_1", "br_1", secret, true] });
    expect(result).not.toContain(secret);
    expect(JSON.parse(result).chars).toBe(secret.length);
  });

  it("status approval hanya menampilkan argumen publik", () => {
    const secret = "jangan-masuk-status";
    const rt = makeRuntime({}, ".", []);
    rt.approvals.set("ap_1", {
      id: "ap_1", tool: "browser_type",
      args: { snapshotId: "bs_1", ref: "br_1", text: secret, submit: false }, ts: 1,
    });
    setRuntime(rt);
    try {
      const visible = assistantStatus().pendingApprovals[0];
      expect(JSON.stringify(visible)).not.toContain(secret);
      expect(visible.args).toEqual({ snapshotId: "bs_1", ref: "br_1", chars: secret.length, submit: false });
      expect(rt.approvals.get("ap_1")?.args.text).toBe(secret);
    } finally {
      setRuntime(null);
    }
  });

  it("tool lain mempertahankan argumen publik untuk diff client", () => {
    const args = { path: "a.ts", content: "isi" };
    expect(publicToolArgs("write_file", args)).toBe(args);
  });
});
