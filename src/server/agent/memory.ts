/**
 * server/agent/memory.ts — Long-term memory lintas sesi (eksplisit).
 * Disimpan di .agent-memory/memory.json (di akar app). Model memanggil
 * remember/recall SECARA EKSPLISIT — history tidak auto-tersimpan — supaya
 * memory tetap ringkas dan relevan. Ringkasan memory disuntik ke system
 * prompt di awal tiap sesi.
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { appRoot } from "../../shared/paths";

export type MemoryEntry = { key: string; value: string; ts: number };

const MEMORY_DIR = join(appRoot(), ".agent-memory");
const MEMORY_FILE = join(MEMORY_DIR, "memory.json");
const MAX_ENTRIES = 100;
const MAX_VALUE = 1200;

function loadAll(): MemoryEntry[] {
  try {
    const j = JSON.parse(readFileSync(MEMORY_FILE, "utf8"));
    return Array.isArray(j?.entries) ? j.entries : [];
  } catch {
    return [];
  }
}

function saveAll(entries: MemoryEntry[]): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(MEMORY_FILE, JSON.stringify({ entries }, null, 2), "utf8");
}

export function remember(key: string, value: string): string {
  const k = String(key || "").trim().slice(0, 60);
  const v = String(value || "").trim().slice(0, MAX_VALUE);
  if (!k || !v) return "ERROR: key dan value wajib diisi";
  const entries = loadAll().filter((e) => e.key !== k);
  entries.push({ key: k, value: v, ts: Date.now() });
  while (entries.length > MAX_ENTRIES) entries.shift();
  saveAll(entries);
  return "Tersimpan di memory: [" + k + "] " + v.slice(0, 80) + (v.length > 80 ? "…" : "");
}

export function recall(key?: string): string {
  const entries = loadAll();
  if (!entries.length) return "(memory kosong)";
  if (key) {
    const k = String(key).trim().toLowerCase();
    const hits = entries.filter((e) => e.key.toLowerCase().includes(k));
    return hits.length
      ? hits.map((e) => "[" + e.key + "] " + e.value).join("\n")
      : '(tidak ada memory dengan key "' + key + '")';
  }
  return entries.map((e) => "[" + e.key + "] " + e.value).join("\n");
}

/** Suntikan ringkasan memory ke system prompt (dibatasi biar prompt ramping). */
export function memoryPromptBlock(): string {
  const entries = loadAll();
  if (!entries.length) return "";
  const lines = entries.slice(-24).map((e) => "- [" + e.key + "] " + e.value.slice(0, 200));
  return (
    "\n=== MEMORY LINTAS SESI (ingatan eksplisit dari sesi-sesi sebelumnya) ===\n" +
    lines.join("\n") +
    "\n"
  );
}

// ── API untuk UI (Lihat/Lupakan memory) ────────────────────────

export function memoryList(): MemoryEntry[] {
  return loadAll();
}

export function memoryDelete(key: string): { ok: boolean; error?: string } {
  const k = String(key || "").trim();
  const entries = loadAll();
  const next = entries.filter((e) => e.key !== k);
  if (next.length === entries.length) return { ok: false, error: "memory tidak ditemukan: " + k };
  if (next.length) saveAll(next);
  else if (existsSync(MEMORY_FILE)) unlinkSync(MEMORY_FILE);
  return { ok: true };
}
