import { spawn as nodeSpawn } from "child_process";
import { mkdir, readFile, rm } from "fs/promises";
import { basename, join } from "path";
import { appRoot } from "../../shared/paths";
import { CdpClient } from "./cdp";
import { findChromium } from "./discovery";
import { BrowserOriginGrants, inspectBrowserUrl, type BrowserUrlDecision } from "./policy";
import { BrowserSnapshotStore, SnapshotReferenceError, formatInspect, normalizeAxTree, type CdpAxNode } from "./snapshot";
import type { BrowserInspectResult, BrowserScreenshot, BrowserState } from "./types";

type BrowserProcess = {
  pid?: number;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
};
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type SpawnLike = (file: string, args: string[]) => BrowserProcess;
type ClientLike = Pick<CdpClient, "send" | "on" | "close" | "closed">;

type BrowserTarget = {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
};

export type BrowserManagerDeps = {
  executable?: string | null;
  profileDir?: string;
  fetch?: FetchLike;
  spawn?: SpawnLike;
  createClient?: (url: string) => ClientLike;
  grants?: BrowserOriginGrants;
  inspectUrl?: (raw: string) => Promise<BrowserUrlDecision>;
  now?: () => number;
};

type NavigationHistory = {
  currentIndex: number;
  entries: Array<{ id: number; url: string; title: string }>;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SPAWN_ARGS = [
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--new-window",
  "about:blank",
];

export function browserEngine(executable: string | null): "edge" | "chrome" | null {
  if (!executable) return null;
  const name = basename(executable).toLowerCase();
  return name.includes("edge") ? "edge" : name.includes("chrome") ? "chrome" : null;
}

export function choosePageTarget(targets: readonly BrowserTarget[]): BrowserTarget | null {
  const pages = targets.filter((target) => target.type === "page" && Boolean(target.webSocketDebuggerUrl));
  return pages.find((target) => target.url === "about:blank") ?? pages[0] ?? null;
}

export function parseDevToolsActivePort(content: string): { port: number; browserPath?: string } | null {
  const [portLine, browserPath] = content.trim().split(/\r?\n/);
  const port = Number(portLine);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? { port, browserPath } : null;
}

function defaultSpawn(file: string, args: string[]): BrowserProcess {
  return nodeSpawn(file, args, { detached: false, stdio: "ignore" }) as BrowserProcess;
}

/** Tunggu file port Chromium tanpa menebak port atau membuka listener sendiri. */
export async function waitForDevToolsPort(
  profileDir: string,
  process: BrowserProcess,
  timeoutMs = 12_000,
  read = (path: string) => readFile(path, "utf8"),
): Promise<number> {
  const file = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("proses browser berhenti sebelum CDP siap");
    try {
      const parsed = parseDevToolsActivePort(await read(file));
      if (parsed) return parsed.port;
    } catch {}
    await sleep(75);
  }
  throw new Error("timeout menunggu DevToolsActivePort");
}

export class BrowserManager {
  readonly grants: BrowserOriginGrants;
  private readonly inspectUrl: (raw: string) => Promise<BrowserUrlDecision>;
  private readonly executable: string | null;
  private readonly profileDir: string;
  private readonly fetchImpl: FetchLike;
  private readonly spawnImpl: SpawnLike;
  private readonly createClient: (url: string) => ClientLike;
  private readonly snapshots: BrowserSnapshotStore;
  private process: BrowserProcess | null = null;
  private client: ClientLike | null = null;
  private currentSnapshotId: string | null = null;
  private url = "";
  private title = "";
  private canBack = false;
  private canForward = false;
  private lastError: string | undefined;
  private unsubscribers: Array<() => void> = [];

  constructor(deps: BrowserManagerDeps = {}) {
    this.grants = deps.grants ?? new BrowserOriginGrants();
    this.inspectUrl = deps.inspectUrl ?? inspectBrowserUrl;
    this.executable = deps.executable === undefined ? findChromium() : deps.executable;
    this.profileDir = deps.profileDir ?? join(appRoot(), "data", "browser", "profile");
    this.fetchImpl = deps.fetch ?? fetch;
    this.spawnImpl = deps.spawn ?? defaultSpawn;
    this.createClient = deps.createClient ?? ((url) => new CdpClient(url));
    this.snapshots = new BrowserSnapshotStore({ now: deps.now });
  }

  status(): BrowserState {
    this.syncProcessState();
    return {
      available: Boolean(this.executable),
      running: Boolean(this.process),
      connected: Boolean(this.client && !this.client.closed),
      engine: browserEngine(this.executable),
      url: this.url,
      title: this.title,
      canBack: this.canBack,
      canForward: this.canForward,
      originGranted: this.originIsGranted(),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  grantPrivateOrigin(rawOrigin: string): void {
    const decision = new URL(rawOrigin);
    if (decision.protocol !== "http:" && decision.protocol !== "https:") throw new Error("origin grant harus http/https");
    if (decision.username || decision.password || decision.pathname !== "/" || decision.search || decision.hash) {
      throw new Error("grant harus berupa origin tanpa path/credential");
    }
    this.grants.grant(decision.origin);
  }

  async open(rawUrl: string): Promise<BrowserState> {
    const decision = await this.authorize(rawUrl);
    if (!decision.url) throw new Error("URL tidak valid");
    if (!this.client || this.client.closed) await this.launch();
    await this.navigateAuthorized(decision.url);
    return this.status();
  }

  async navigate(rawUrl: string): Promise<BrowserState> {
    this.requireClient();
    const decision = await this.authorize(rawUrl);
    if (!decision.url) throw new Error("URL tidak valid");
    await this.navigateAuthorized(decision.url);
    return this.status();
  }

  async close(): Promise<void> {
    const client = this.client;
    const process = this.process;
    this.resetConnection();
    try { client?.close(); } catch {}
    try { process?.kill(); } catch {}
    this.grants.revokeAll();
  }

  async focus(): Promise<boolean> {
    const pid = this.process?.pid;
    if (!pid || process.platform !== "win32") return false;
    const escaped = String(pid);
    const command = `$p=Get-Process -Id ${escaped} -ErrorAction Stop;` +
      `Add-Type -Name W -Namespace P -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);';` +
      `if($p.MainWindowHandle -eq 0){exit 2}; if([P.W]::SetForegroundWindow($p.MainWindowHandle)){exit 0}else{exit 3}`;
    return await new Promise((resolve) => {
      try {
        const child = nodeSpawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "ignore" });
        child.once("exit", (code) => resolve(code === 0));
        child.once("error", () => resolve(false));
      } catch { resolve(false); }
    });
  }

  async back(): Promise<void> {
    const history = await this.history();
    const target = history.entries[history.currentIndex - 1];
    if (!target) throw new Error("tidak ada riwayat sebelumnya");
    await this.requireClient().send("Page.navigateToHistoryEntry", { entryId: target.id });
    this.invalidateSnapshot();
  }

  async forward(): Promise<void> {
    const history = await this.history();
    const target = history.entries[history.currentIndex + 1];
    if (!target) throw new Error("tidak ada riwayat berikutnya");
    await this.requireClient().send("Page.navigateToHistoryEntry", { entryId: target.id });
    this.invalidateSnapshot();
  }

  async reload(): Promise<void> {
    await this.requireClient().send("Page.reload", { ignoreCache: false });
    this.invalidateSnapshot();
  }

  async inspect(cursor = 0, maxChars = 12_000, snapshotId?: string): Promise<BrowserInspectResult> {
    if (snapshotId) return formatInspect(this.snapshots.get(snapshotId), cursor, maxChars);
    const client = this.requireClient();
    await this.verifyCurrentPage();
    const result = await client.send<{ nodes?: CdpAxNode[] }>("Accessibility.getFullAXTree", { depth: -1 });
    const snapshot = normalizeAxTree(result.nodes ?? [], { url: this.url, title: this.title });
    this.snapshots.put(snapshot);
    this.currentSnapshotId = snapshot.snapshotId;
    return formatInspect(snapshot, cursor, maxChars);
  }

  async click(snapshotId: string, ref: string): Promise<void> {
    const client = this.requireClient();
    await this.verifyCurrentPage();
    const node = this.resolveNode(snapshotId, ref);
    if (!node.backendDOMNodeId) throw new Error("elemen tidak punya target DOM");
    const model = await client.send<{ model?: { border?: number[]; content?: number[] } }>(
      "DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId },
    );
    const quad = model.model?.border ?? model.model?.content;
    if (!quad || quad.length < 8) throw new Error("elemen tidak terlihat atau tidak punya box");
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await this.dispatchPoint(client, x, y);
  }

  /** Klik koordinat viewport dari preview; input wajib ternormalisasi agar route
   *  tidak berubah menjadi primitive CDP/selector arbitrer. */
  async clickPoint(normalizedX: number, normalizedY: number): Promise<void> {
    const client = this.requireClient();
    await this.verifyCurrentPage();
    if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)
      || normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
      throw new Error("koordinat preview harus antara 0 dan 1");
    }
    const layout = await client.send<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>("Page.getLayoutMetrics");
    const width = Number(layout.cssLayoutViewport?.clientWidth);
    const height = Number(layout.cssLayoutViewport?.clientHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("ukuran viewport browser tidak tersedia");
    }
    await this.dispatchPoint(client, normalizedX * width, normalizedY * height);
  }

  async type(snapshotId: string, ref: string, value: string, pressEnter = false): Promise<void> {
    const client = this.requireClient();
    await this.verifyCurrentPage();
    const node = this.resolveNode(snapshotId, ref);
    if (node.sensitive) throw new Error("pengisian password/rahasia tidak diizinkan");
    if (!node.backendDOMNodeId) throw new Error("elemen tidak punya target DOM");
    await client.send("DOM.focus", { backendNodeId: node.backendDOMNodeId });
    await client.send("Input.insertText", { text: String(value) });
    if (pressEnter) {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
  }

  async screenshot(format: "png" | "jpeg" = "png", quality = 85): Promise<BrowserScreenshot> {
    const client = this.requireClient();
    await this.verifyCurrentPage();
    const result = await client.send<{ data: string }>("Page.captureScreenshot", {
      format,
      fromSurface: true,
      ...(format === "jpeg" ? { quality: Math.max(0, Math.min(100, Math.trunc(quality))) } : {}),
    });
    const layout = await client.send<{ cssLayoutViewport?: { clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics");
    return {
      bytes: Uint8Array.from(Buffer.from(result.data, "base64")),
      mime: format === "jpeg" ? "image/jpeg" : "image/png",
      width: Math.round(layout.cssLayoutViewport?.clientWidth ?? 0),
      height: Math.round(layout.cssLayoutViewport?.clientHeight ?? 0),
      ts: Date.now(),
    };
  }

  private async dispatchPoint(client: ClientLike, x: number, y: number): Promise<void> {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  private async launch(): Promise<void> {
    if (!this.executable) throw new Error("Edge/Chrome tidak ditemukan");
    await mkdir(this.profileDir, { recursive: true });
    await rm(join(this.profileDir, "DevToolsActivePort"), { force: true }).catch(() => {});
    const child = this.spawnImpl(this.executable, [`--user-data-dir=${this.profileDir}`, ...SPAWN_ARGS]);
    this.process = child;
    child.once("exit", () => {
      if (this.process === child) this.resetConnection("browser ditutup");
    });
    try {
      const port = await waitForDevToolsPort(this.profileDir, child);
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`daftar target CDP gagal (${response.status})`);
      const targets = await response.json() as BrowserTarget[];
      const target = choosePageTarget(targets);
      if (!target?.webSocketDebuggerUrl) throw new Error("target page CDP tidak ditemukan");
      const client = this.createClient(target.webSocketDebuggerUrl);
      this.client = client;
      this.url = target.url === "about:blank" ? "" : target.url;
      this.title = target.title ?? "";
      await Promise.all([
        client.send("Page.enable"), client.send("Runtime.enable"),
        client.send("Accessibility.enable"), client.send("DOM.enable"),
      ]);
      this.bindEvents(client);
      await this.refreshHistory();
      this.lastError = undefined;
    } catch (error) {
      try { child.kill(); } catch {}
      this.resetConnection(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private bindEvents(client: ClientLike): void {
    this.unsubscribers.push(client.on("Page.frameNavigated", (params) => {
      const frame = params.frame as { parentId?: string; url?: string } | undefined;
      if (!frame?.parentId && typeof frame?.url === "string") {
        this.url = frame.url;
        this.invalidateSnapshot();
        void this.refreshHistory().catch(() => {});
      }
    }));
    this.unsubscribers.push(client.on("Runtime.executionContextCreated", () => {
      void this.readTitle().catch(() => {});
    }));
    this.unsubscribers.push(client.on("Page.navigatedWithinDocument", (params) => {
      if (typeof params.url === "string") this.url = params.url;
      this.invalidateSnapshot();
    }));
  }

  private async authorize(rawUrl: string): Promise<BrowserUrlDecision> {
    const decision = await this.inspectUrl(rawUrl);
    if (!decision.ok) throw new Error(decision.error ?? "URL tidak diizinkan");
    if (decision.privateNetwork && decision.origin && !this.grants.has(decision.origin)) {
      throw new Error("origin privat memerlukan persetujuan user");
    }
    return decision;
  }

  private async navigateAuthorized(normalizedUrl: string): Promise<void> {
    // Resolve ulang tepat sebelum navigasi untuk mempersempit jendela DNS rebinding.
    const checked = await this.inspectUrl(normalizedUrl);
    if (!checked.ok || !checked.url) throw new Error(checked.error ?? "URL tidak diizinkan");
    if (checked.url !== normalizedUrl) throw new Error("URL berubah saat pemeriksaan ulang");
    if (checked.privateNetwork && checked.origin && !this.grants.has(checked.origin)) {
      throw new Error("origin privat memerlukan persetujuan user");
    }
    const before = await this.requireClient().send<{ frameTree?: { frame?: { url?: string } } }>("Page.getFrameTree");
    const liveUrl = before.frameTree?.frame?.url;
    if (liveUrl && liveUrl !== "about:blank") {
      const live = await this.inspectUrl(liveUrl);
      if (!live.ok || (live.privateNetwork && live.origin && !this.grants.has(live.origin))) {
        throw new Error("halaman aktif berpindah ke origin yang tidak diizinkan");
      }
    }
    const result = await this.requireClient().send<{ errorText?: string }>("Page.navigate", { url: checked.url });
    if (result.errorText) throw new Error("navigasi gagal: " + result.errorText);
    this.url = checked.url;
    this.title = "";
    this.invalidateSnapshot();
  }

  private async verifyCurrentPage(): Promise<void> {
    const tree = await this.requireClient().send<{ frameTree?: { frame?: { url?: string } } }>("Page.getFrameTree");
    const liveUrl = tree.frameTree?.frame?.url ?? this.url;
    if (!liveUrl || liveUrl === "about:blank") return;
    const decision = await this.inspectUrl(liveUrl);
    if (!decision.ok || !decision.url || (decision.privateNetwork && decision.origin && !this.grants.has(decision.origin))) {
      this.invalidateSnapshot();
      throw new Error("halaman aktif berada di origin yang tidak diizinkan");
    }
    if (liveUrl !== this.url) {
      this.url = decision.url;
      this.invalidateSnapshot();
    }
  }

  private resolveNode(snapshotId: string, ref: string) {
    if (!this.currentSnapshotId) throw new SnapshotReferenceError("stale", "inspect halaman sebelum memakai ref");
    if (snapshotId !== this.currentSnapshotId) {
      throw new SnapshotReferenceError("stale", "snapshot browser sudah stale setelah navigasi/inspect baru");
    }
    return this.snapshots.resolve(ref, { snapshotId, url: this.url });
  }

  private requireClient(): ClientLike {
    if (!this.client || this.client.closed) throw new Error("browser belum terbuka atau CDP terputus");
    return this.client;
  }

  private async history(): Promise<NavigationHistory> {
    const history = await this.requireClient().send<NavigationHistory>("Page.getNavigationHistory");
    this.applyHistory(history);
    return history;
  }

  private async refreshHistory(): Promise<void> {
    if (!this.client || this.client.closed) return;
    await this.history();
    await this.readTitle();
  }

  private applyHistory(history: NavigationHistory): void {
    this.canBack = history.currentIndex > 0;
    this.canForward = history.currentIndex >= 0 && history.currentIndex < history.entries.length - 1;
    const current = history.entries[history.currentIndex];
    if (current) {
      if (current.url !== "about:blank") this.url = current.url;
      this.title = current.title || this.title;
    }
  }

  private async readTitle(): Promise<void> {
    if (!this.client || this.client.closed) return;
    const result = await this.client.send<{ result?: { value?: unknown } }>(
      "Runtime.evaluate", { expression: "document.title", returnByValue: true, silent: true },
    );
    if (typeof result.result?.value === "string") this.title = result.result.value;
  }

  private originIsGranted(): boolean {
    try { return Boolean(this.url && this.grants.has(new URL(this.url).origin)); } catch { return false; }
  }

  private invalidateSnapshot(): void {
    this.currentSnapshotId = null;
  }

  private syncProcessState(): void {
    if (this.process && this.process.exitCode !== null) this.resetConnection("browser ditutup");
  }

  private resetConnection(error?: string): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    try { this.client?.close(); } catch {}
    this.process = null;
    this.client = null;
    this.url = "";
    this.title = "";
    this.canBack = false;
    this.canForward = false;
    this.currentSnapshotId = null;
    this.snapshots.clear();
    this.lastError = error;
  }



}

export const browserManager = new BrowserManager();

