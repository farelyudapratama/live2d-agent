/**
 * server/browser/discovery.ts — Temukan Edge/Chrome terpasang (Windows).
 * Dipakai bersama browser agent dan fallback Desktop Pet; tidak ada nama/path
 * browser hardcode di dua modul berbeda.
 */
import { existsSync } from "fs";

export function chromiumCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA || "";
  return [
    local && local + "\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    local && local + "\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
}

export function findChromium(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const file of chromiumCandidates(env)) {
    try { if (existsSync(file)) return file; } catch {}
  }
  return null;
}
