/**
 * server/agent/tools/index.ts — Registry tool agent + metadata approval.
 * Tiap tool punya schema (nama, deskripsi, parameter) dan level:
 *   "safe"     → read-only, auto-jalan di loop.
 *   "mutating" → mengubah/mengeksekusi, WAJIB approval user (permission gate).
 * Level adalah DATA, bukan if-else di loop — menambah tool = tambah entri.
 */

export type ToolLevel = "safe" | "mutating";

export type ToolDef = {
  name: string;
  /** Deskripsi untuk prompt LLM (format panggilan: TOOL: name {json}). */
  desc: string;
  /** Parameter JSON untuk schema prompt. */
  params: Record<string, string>;
  level: ToolLevel;
  /** Argumen aman untuk bus/SSE/history. Argumen asli tetap untuk eksekusi. */
  publicArgs?: (args: any) => any;
  run: (ctx: ToolCtx, args: any) => string | Promise<string>;
};

/** Konteks eksekusi tool — sandbox di dalam workDir. */
export type ToolCtx = {
  workDir: string;
  noteFile: (p: string) => void;
  /** Runtime penuh — hanya tool internal (update_plan, memory) yang memakai. */
  rt?: any;
};

import { toolListDir, toolReadFile, toolWriteFile, toolEditFile, toolDeleteFile } from "./fs";
import { toolRunCommand } from "./shell";
import { toolSearchCode, toolGitDiff } from "./search";
import { updatePlanTool } from "./plan";
import { rememberTool, recallTool } from "./memory";
import { spawnSubagentTool } from "./subagent";
import { browserTools } from "./browser";

export const TOOLS: ToolDef[] = [
  {
    name: "list_dir",
    desc: "list_dir {path} — lihat isi folder",
    params: { path: "string, default '.'" },
    level: "safe",
    run: toolListDir,
  },
  {
    name: "read_file",
    desc: "read_file {path} — baca file teks",
    params: { path: "string" },
    level: "safe",
    run: toolReadFile,
  },
  {
    name: "search_code",
    desc: "search_code {query, path?} — cari string di file proyek (rekursif)",
    params: { query: "string", path: "string opsional, default '.'" },
    level: "safe",
    run: toolSearchCode,
  },
  {
    name: "git_diff",
    desc: "git_diff {} — lihat perubahan belum commit (git diff --stat + status)",
    params: {},
    level: "safe",
    run: toolGitDiff,
  },
  {
    name: "write_file",
    desc: "write_file {path, content} — simpan file (menimpa)",
    params: { path: "string", content: "string" },
    level: "mutating",
    run: toolWriteFile,
  },
  {
    name: "edit_file",
    desc: "edit_file {path, old, new} — ganti potongan teks dalam file",
    params: { path: "string", old: "string yang dicari persis", new: "string pengganti" },
    level: "mutating",
    run: toolEditFile,
  },
  {
    name: "delete_file",
    desc: "delete_file {path} — hapus file",
    params: { path: "string" },
    level: "mutating",
    run: toolDeleteFile,
  },
  {
    name: "run_command",
    desc: "run_command {command} — jalankan perintah di folder kerja",
    params: { command: "string" },
    level: "mutating",
    run: toolRunCommand,
  },
  updatePlanTool,
  rememberTool,
  recallTool,
  spawnSubagentTool,
  ...browserTools,
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Argumen yang boleh masuk UI, bus, dan history; default mempertahankan bentuk lama. */
export function publicToolArgs(tool: ToolDef | string, args: any): any {
  const def = typeof tool === "string" ? toolByName(tool) : tool;
  if (!def?.publicArgs) return args;
  try {
    return def.publicArgs(args);
  } catch {
    return {};
  }
}

/** Baris prompt untuk system prompt agent. */
export function toolPromptLines(): string[] {
  return TOOLS.map((t) => "TOOL: " + t.desc);
}
