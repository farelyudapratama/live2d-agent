/**
 * server/agent/tools/shell.ts — run_command di folder kerja.
 * ASYNC: execAsync, jangan pernah memblokir event loop Bun (polling pet,
 * TTS, dan HTTP chat semuanya mati kalau event loop macet).
 */
import { exec } from "child_process";
import { promisify } from "util";
import { safePath, clip } from "./fs";
import type { ToolCtx } from "./index";

const execAsync = promisify(exec);

export function toolRunCommand(ctx: ToolCtx, args: any): Promise<string> {
  const cmd = String(args.command || "").trim();
  if (!cmd) return Promise.reject(new Error("command kosong"));
  // cwd opsional — tetap dikunci di dalam folder kerja.
  let cwd = ctx.workDir;
  if (args.cwd) cwd = safePath(ctx.workDir, args.cwd);
  // Windows tanpa SHELL (start.bat dari cmd.exe) dulu jatuh ke "/bin/bash"
  // dan run_command selalu error — fallback ke ComSpec.
  const shell =
    process.platform === "win32"
      ? String(process.env.ComSpec || "cmd.exe")
      : String(process.env.SHELL || "/bin/bash");
  return execAsync(cmd, {
    cwd,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    shell,
  }).then(
    ({ stdout }) => clip(String(stdout || "(tanpa output)")),
    (err: any) => {
      // exit non-zero / timeout tetap diekspos ke LLM sebagai hasil tool,
      // bukan exception yang mematahkan loop reasoning.
      const out =
        String(err?.stdout || "") + (err?.stdout ? "\n" : "") + String(err?.stderr || err?.message || "gagal");
      const text = out.trim() || "gagal tanpa output";
      return text.startsWith("ERROR:") ? clip(text) : clip("ERROR: " + text);
    },
  );
}
