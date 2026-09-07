/**
 * server/agent/tools/fs.ts — Tool filesystem (sandbox di dalam workDir).
 * Semua path dinormalisasi & dicek supaya tidak keluar dari folder kerja.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, unlinkSync } from "fs";
import { join, resolve, normalize, sep, dirname } from "path";
import type { ToolCtx } from "./index";

export function safePath(workDir: string, p: string): string {
  const base = resolve(workDir);
  const full = resolve(base, normalize(String(p || ".")));
  if (full !== base && !full.startsWith(base + sep))
    throw new Error("di luar folder kerja: " + p);
  return full;
}

/** Potong hasil panjang sebelum masuk context (manajemen token). */
export function clip(text: string, max = 12000): string {
  const t = String(text ?? "");
  return t.length > max ? t.slice(0, max) + "\n…(terpotong, " + t.length + " char)" : t;
}

export function toolListDir(ctx: ToolCtx, args: any): string {
  const dir = safePath(ctx.workDir, args.path || ".");
  const entries = readdirSync(dir, { withFileTypes: true })
    .slice(0, 200)
    .map((e) => {
      let size = 0;
      try {
        size = statSync(join(dir, e.name)).size;
      } catch {}
      return (
        (e.isDirectory() ? "[d] " : "[f] ") +
        e.name +
        (e.isDirectory() ? "/" : " (" + size + " B)")
      );
    });
  return clip("Isi " + dir + ":\n" + (entries.join("\n") || "(kosong)"));
}

export function toolReadFile(ctx: ToolCtx, args: any): string {
  const fp = safePath(ctx.workDir, args.path);
  return clip(readFileSync(fp, "utf8"));
}

export function toolWriteFile(ctx: ToolCtx, args: any): string {
  const fp = safePath(ctx.workDir, args.path);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, String(args.content ?? ""), "utf8");
  ctx.noteFile(fp);
  return "Tersimpan: " + fp + " (" + String(args.content ?? "").length + " char)";
}

export function toolEditFile(ctx: ToolCtx, args: any): string {
  const fp = safePath(ctx.workDir, args.path);
  const oldStr = String(args.old ?? "");
  const newStr = String(args.new ?? "");
  if (!oldStr) throw new Error("parameter 'old' kosong");
  const text = readFileSync(fp, "utf8");
  const count = text.split(oldStr).length - 1;
  if (count === 0) throw new Error("teks 'old' tidak ditemukan di " + args.path);
  if (count > 1)
    throw new Error(
      "teks 'old' muncul " + count + "x — perjelas dengan potongan yang lebih panjang",
    );
  writeFileSync(fp, text.replace(oldStr, newStr), "utf8");
  ctx.noteFile(fp);
  return "Diedit: " + fp + " (1 penggantian)";
}

export function toolDeleteFile(ctx: ToolCtx, args: any): string {
  const fp = safePath(ctx.workDir, args.path);
  unlinkSync(fp);
  return "Dihapus: " + fp;
}
