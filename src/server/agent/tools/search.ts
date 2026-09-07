/**
 * server/agent/tools/search.ts — search_code & git_diff (read-only).
 * search_code: grep sederhana rekursif dengan skip folder berat
 * (node_modules, .git, dist) dan batas hasil supaya context tidak meledak.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { safePath, clip } from "./fs";
import { exec } from "child_process";
import { promisify } from "util";
import type { ToolCtx } from "./index";

const execAsync = promisify(exec);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".zcode",
  "target", ".next", "coverage", "agent-shell\\target",
]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".html",
  ".md", ".txt", ".yml", ".yaml", ".toml", ".svg", ".sh", ".bat", ".iss",
  ".rs", ".py", ".go", ".java", ".c", ".h", ".cpp", ".hpp", ".sql", ".xml",
]);

function walk(dir: string, base: string, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 400) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length > 400) return;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, base, out, depth + 1);
      continue;
    }
    const ext = e.name.slice(e.name.lastIndexOf(".")).toLowerCase();
    if (ext && !TEXT_EXT.has(ext)) continue;
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size > 512 * 1024) continue;
    out.push(full);
  }
}

export function toolSearchCode(ctx: ToolCtx, args: any): string {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query kosong");
  const lower = query.toLowerCase();
  const root = safePath(ctx.workDir, args.path || ".");
  const files: string[] = [];
  walk(root, root, files);
  const hits: string[] = [];
  for (const fp of files) {
    if (hits.length >= 60) break;
    let text: string;
    try {
      text = readFileSync(fp, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < 60; i++) {
      if (lines[i].toLowerCase().includes(lower)) {
        hits.push(fp.slice(root.length + 1) + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 160));
      }
    }
  }
  return clip(
    hits.length
      ? hits.length + " hasil untuk \"" + query + "\":\n" + hits.join("\n")
      : "Tidak ada hasil untuk \"" + query + "\"",
    8000,
  );
}

export async function toolGitDiff(ctx: ToolCtx): Promise<string> {
  const shell =
    process.platform === "win32"
      ? String(process.env.ComSpec || "cmd.exe")
      : String(process.env.SHELL || "/bin/bash");
  const opts = { cwd: ctx.workDir, timeout: 15000, maxBuffer: 1024 * 1024, shell };
  try {
    const { stdout: st } = await execAsync("git status --short", opts);
    let out = "git status:\n" + (st.trim() || "(bersih)");
    try {
      const { stdout: df } = await execAsync("git diff --stat", opts);
      if (df.trim()) out += "\n\ngit diff --stat:\n" + df.trim();
    } catch {}
    return clip(out, 8000);
  } catch (e: any) {
    return "ERROR: git tidak tersedia atau folder bukan repo — " + (e?.message || e);
  }
}
