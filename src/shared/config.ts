/**
 * shared/config.ts — Config management with atomic writes + queue.
 */
import { Config, Connection } from "./types";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";

const DEFAULT_CONFIG: Config = {
  activeId: null,
  connections: [],
  tts: { endpoint: "" },
  events: {
    idleSpeak: true,
    idleMs: 1_800_000,
    idleRepeatMs: 1_800_000,
    awaySpeak: true,
    returnSpeak: true,
    awayHiddenMs: 10_000,
    quietMs: 1_800_000,
  },
  camera: {
    enabled: false,
    fps: 0.4,
    presenceThreshold: 0.4,
    device: "webgpu",
    model: "Xenova/facial_emotions_image_detection",
    moodGraceMs: 20_000,
    moodDebounceMs: 5000,
    moodStableTicks: 2,
  },
  motion: { enabled: false, gain: 1.5 },
};

export const KNOWN_EVENT_KEYS = ["idleSpeak","idleMs","idleRepeatMs","awaySpeak","returnSpeak","awayHiddenMs","quietMs"];

export function mergeEventsIntoConfig(prev: any, incoming: any): any {
  const base = (typeof prev === "object" && prev) ? prev : {};
  const merged = Object.assign({}, base.events || {}, incoming || {});
  const clean: Record<string, unknown> = {};
  for (const k of KNOWN_EVENT_KEYS) if (k in merged) (clean as any)[k] = (merged as any)[k];
  return Object.assign({}, base, { events: clean });
}

const _writeQueues = new Map<string, Promise<void>>();

function writeJsonAtomic(file: string, obj: unknown) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "." + file.split(/[\\/]/).pop() + "." + process.pid + "." + Date.now() + ".tmp");
  const text = JSON.stringify(obj, null, 2);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw e;
  }
}

function queueJsonWrite(file: string, obj: unknown): Promise<void> {
  const prev = _writeQueues.get(file) || Promise.resolve();
  const done = prev.then(() => writeJsonAtomic(file, obj), () => writeJsonAtomic(file, obj));
  const tail = done.catch(() => {});
  _writeQueues.set(file, tail);
  tail.then(() => { if (_writeQueues.get(file) === tail) _writeQueues.delete(file); });
  return done;
}

export class ConfigManager {
  private path: string;
  private cache: Config | null = null;
  private runtimeOverrides: Partial<Config> = {};

  constructor(dataDir: string) {
    this.path = join(dataDir, "config.json");
    this.ensureDefault();
  }

  private ensureDefault(): void {
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(DEFAULT_CONFIG, null, 2));
      console.log("  (config.json tidak ditemukan — membuat default)");
    }
  }

  load(): Config {
    try {
      const base = JSON.parse(readFileSync(this.path, "utf8"));
      this.cache = { ...base, ...this.runtimeOverrides };
    } catch {
      this.cache = { ...DEFAULT_CONFIG, ...this.runtimeOverrides } as Config;
    }
    return this.cache as Config;
  }

  get connections(): Connection[] {
    const cfg = this.load();
    return Array.isArray(cfg.connections) ? cfg.connections : [];
  }

  get activeConnection(): Connection | null {
    const conns = this.connections;
    if (!conns.length) return null;
    const cfg = this.load();
    return conns.find((c) => c.id === cfg.activeId) ?? conns[0] ?? null;
  }

  get events() { return this.load().events; }
  get camera() { return this.load().camera; }
  get motion() { return this.load().motion; }

  saveConnections(conns: Connection[], activeId: string | null): void {
    let prev: any = {};
    try { prev = JSON.parse(readFileSync(this.path, "utf8")); } catch {}
    const data = Object.assign({}, prev, { activeId: activeId ?? conns[0]?.id ?? null, connections: conns });
    this.runtimeOverrides = { activeId: data.activeId, connections: data.connections };
    try { writeJsonAtomic(this.path, data); } catch (e: any) { console.warn("[config] gagal menyimpan:", e.message); }
  }

  saveEvents(events: any): void {
    let prev: any = {};
    try { prev = JSON.parse(readFileSync(this.path, "utf8")); } catch {}
    const data = mergeEventsIntoConfig(prev, events);
    try { writeJsonAtomic(this.path, data); } catch (e: any) { console.warn("[config] gagal menyimpan events:", e.message); }
  }

  atomicWriteRaw(file: string, obj: unknown): Promise<void> { return queueJsonWrite(file, obj); }

  maskKey(k: string): string {
    if (!k || k.startsWith("MASUKKAN")) return k || "";
    return k.slice(0, 6) + "••••••••" + k.slice(-4);
  }
}

export { queueJsonWrite, writeJsonAtomic, DEFAULT_CONFIG };
