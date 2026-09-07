import { browserManager } from "../../browser/manager";
import type { BrowserInspectResult, BrowserState } from "../../browser/types";
import type { ToolDef } from "./index";

const DEFAULT_URL = "https://example.com";
const MAX_INSPECT_CHARS = 3_500;
const MAX_RESULT_CHARS = 4_500;

type BrowserToolManager = {
  status(): BrowserState;
  open(url: string): Promise<BrowserState>;
  navigate(url: string): Promise<BrowserState>;
  inspect(cursor?: number, maxChars?: number, snapshotId?: string): Promise<BrowserInspectResult>;
  click(snapshotId: string, ref: string): Promise<void>;
  type(snapshotId: string, ref: string, text: string, submit?: boolean): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  grantPrivateOrigin(origin: string): void;
};

function required(args: any, key: string): string {
  const value = typeof args?.[key] === "string" ? args[key].trim() : "";
  if (!value) throw new Error(`${key} wajib diisi`);
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Serialisasi inspect tetap JSON valid dan dibatasi untuk konteks LLM. */
function boundedInspect(result: BrowserInspectResult): string {
  const base = {
    snapshotId: String(result.snapshotId).slice(0, 160),
    url: String(result.url).slice(0, 800),
    title: String(result.title).slice(0, 300),
    text: String(result.text),
    nextCursor: result.nextCursor,
    count: result.count,
  };
  let low = 0;
  let high = base.text.length;
  let output = json(base);
  while (output.length > MAX_RESULT_CHARS && low < high) {
    high = Math.floor((low + high) / 2);
    output = json({ ...base, text: base.text.slice(0, high) });
  }
  return output.length <= MAX_RESULT_CHARS ? output : json({ ...base, text: "" });
}

export function createBrowserTools(manager: BrowserToolManager): ToolDef[] {
  return [
    {
      name: "browser_status", desc: "browser_status {} — lihat status browser agent",
      params: {}, level: "safe", run: () => json(manager.status()),
    },
    {
      name: "browser_open", desc: "browser_open {url?} — buka browser terisolasi",
      params: { url: `string opsional, default '${DEFAULT_URL}'` }, level: "mutating",
      run: async (_ctx, args) => json(await manager.open(typeof args?.url === "string" && args.url.trim() ? args.url : DEFAULT_URL)),
    },
    {
      name: "browser_navigate", desc: "browser_navigate {url} — navigasi tab browser aktif",
      params: { url: "string" }, level: "mutating",
      run: async (_ctx, args) => json(await manager.navigate(required(args, "url"))),
    },
    {
      name: "browser_inspect", desc: "browser_inspect {cursor?, maxChars?, snapshotId?} — baca elemen aksesibel halaman",
      params: { cursor: "number opsional", maxChars: "number opsional, maksimum 3500", snapshotId: "string opsional untuk halaman lanjutan" },
      level: "safe",
      run: async (_ctx, args) => {
        const cursor = Math.max(0, Math.trunc(Number(args?.cursor) || 0));
        const requested = Number(args?.maxChars);
        const maxChars = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_INSPECT_CHARS, Math.trunc(requested))) : MAX_INSPECT_CHARS;
        const snapshotId = typeof args?.snapshotId === "string" && args.snapshotId ? args.snapshotId : undefined;
        return boundedInspect(await manager.inspect(cursor, maxChars, snapshotId));
      },
    },
    {
      name: "browser_click", desc: "browser_click {snapshotId, ref} — klik elemen dari inspect terakhir",
      params: { snapshotId: "string", ref: "string" }, level: "mutating",
      run: async (_ctx, args) => {
        const snapshotId = required(args, "snapshotId");
        const ref = required(args, "ref");
        await manager.click(snapshotId, ref);
        return json({ ok: true, snapshotId, ref });
      },
    },
    {
      name: "browser_type", desc: "browser_type {snapshotId, ref, text, submit?} — isi elemen non-rahasia",
      params: { snapshotId: "string", ref: "string", text: "string", submit: "boolean opsional" }, level: "mutating",
      publicArgs: (args) => ({
        snapshotId: String(args?.snapshotId || ""), ref: String(args?.ref || ""),
        chars: String(args?.text ?? "").length, submit: Boolean(args?.submit),
      }),
      run: async (_ctx, args) => {
        const snapshotId = required(args, "snapshotId");
        const ref = required(args, "ref");
        const text = typeof args?.text === "string" ? args.text : "";
        const submit = Boolean(args?.submit);
        await manager.type(snapshotId, ref, text, submit);
        return json({ ok: true, snapshotId, ref, chars: text.length, submit });
      },
    },
    {
      name: "browser_history", desc: "browser_history {action} — back, forward, atau reload",
      params: { action: "back|forward|reload" }, level: "mutating",
      run: async (_ctx, args) => {
        const action = required(args, "action");
        if (action === "back") await manager.back();
        else if (action === "forward") await manager.forward();
        else if (action === "reload") await manager.reload();
        else throw new Error("action harus back, forward, atau reload");
        return json({ ok: true, action });
      },
    },
    {
      name: "browser_close", desc: "browser_close {} — tutup browser agent",
      params: {}, level: "mutating", run: async () => { await manager.close(); return json({ ok: true }); },
    },
    {
      name: "browser_grant_private", desc: "browser_grant_private {origin} — izinkan origin localhost/LAN untuk sesi browser",
      params: { origin: "origin http/https tanpa path" }, level: "mutating",
      run: (_ctx, args) => { const origin = required(args, "origin"); manager.grantPrivateOrigin(origin); return json({ ok: true, origin }); },
    },
  ];
}

export const browserTools = createBrowserTools(browserManager);
