import { describe, expect, it } from "bun:test";
import { BrowserManager, browserEngine, choosePageTarget, parseDevToolsActivePort } from "../src/server/browser/manager";
import { normalizeAxTree, SnapshotReferenceError } from "../src/server/browser/snapshot";
import type { BrowserUrlDecision } from "../src/server/browser/policy";

describe("browser manager helpers", () => {
  it("mendeteksi engine dari executable", () => {
    expect(browserEngine("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe")).toBe("edge");
    expect(browserEngine("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")).toBe("chrome");
    expect(browserEngine(null)).toBeNull();
  });

  it("memilih satu target page yang punya websocket", () => {
    const target = choosePageTarget([
      { id: "worker", type: "service_worker", url: "https://x/", title: "", webSocketDebuggerUrl: "ws://worker" },
      { id: "other", type: "page", url: "chrome://newtab/", title: "Lain", webSocketDebuggerUrl: "ws://other" },
      { id: "bad", type: "page", url: "about:blank", title: "" },
      { id: "page", type: "page", url: "about:blank", title: "Tab", webSocketDebuggerUrl: "ws://page" },
    ]);
    expect(target?.id).toBe("page");
  });


  it("memeriksa URL lagi tepat sebelum Page.navigate", async () => {
    let checks = 0;
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = {
      closed: false,
      send: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        sent.push({ method, params });
        if (method === "Page.getFrameTree") return { frameTree: { frame: { url: "about:blank" } } } as T;
        if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ id: 1, url: "about:blank", title: "" }] } as T;
        if (method === "Runtime.evaluate") return { result: { value: "" } } as T;
        return {} as T;
      },
      on: () => () => {},
      close: () => {},
    };
    const manager = new BrowserManager({
      executable: "C:\\Chrome\\chrome.exe",
      profileDir: "X:\\profile",
      spawn: () => ({ pid: 7, exitCode: null, kill: () => true, once: () => undefined }),
      fetch: async () => new Response(JSON.stringify([{ id: "p", type: "page", url: "about:blank", title: "", webSocketDebuggerUrl: "ws://page" }])),
      createClient: () => client,
      inspectUrl: async (): Promise<BrowserUrlDecision> => {
        checks++;
        return { ok: true, url: "https://example.com/", origin: "https://example.com", privateNetwork: false };
      },
    });
    // Launch file polling tidak dicakup di helper ini; pasang client lewat open sulit tanpa disk.
    (manager as unknown as { client: typeof client }).client = client;
    await manager.navigate("example.com");
    expect(checks).toBe(2);
    expect(sent.at(-1)).toEqual({ method: "Page.navigate", params: { url: "https://example.com/" } });
    expect(sent.some((item) => item.method === "Page.getFrameTree")).toBe(true);
  });

  it("menolak snapshotId lama saat click meski ref masih tersimpan", async () => {
    const client = {
      closed: false,
      send: async <T>(method: string): Promise<T> => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { url: "https://example.com/" } } } as T;
        return {} as T;
      },
      on: () => () => {}, close: () => {},
    };
    const manager = new BrowserManager({
      executable: "C:\\Chrome\\chrome.exe", createClient: () => client,
      inspectUrl: async () => ({ ok: true, url: "https://example.com/", origin: "https://example.com", privateNetwork: false }),
    });
    (manager as any).client = client;
    (manager as any).url = "https://example.com/";
    const snapshot = normalizeAxTree(
      [{ role: { value: "button" }, name: { value: "OK" }, backendDOMNodeId: 1 }],
      { url: "https://example.com/", title: "" }, { makeId: (() => { let n = 0; return () => String(++n); })() },
    );
    (manager as any).snapshots.put(snapshot);
    (manager as any).currentSnapshotId = snapshot.snapshotId;
    expect(manager.click("bs_lama", snapshot.nodes[0].ref)).rejects.toBeInstanceOf(SnapshotReferenceError);
  });

  it("memvalidasi DevToolsActivePort", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/abc\n")).toEqual({ port: 9222, browserPath: "/devtools/browser/abc" });
    expect(parseDevToolsActivePort("0\n/devtools/browser/abc")).toBeNull();
    expect(parseDevToolsActivePort("bukan-port")).toBeNull();
  });
});

