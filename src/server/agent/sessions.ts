/**
 * server/agent/sessions.ts — Multi-session assistant (riwayat sesi bernama).
 * Store satu file `data/assistant-sessions.json`:
 *   { active: id, sessions: [{ id, name, workDir, ts, messages }] }
 * cap MAX_SESSIONS sesi (FIFO bila penuh & bukan yang aktif), tiap history
 * cap MAX_HISTORY (warisan state.ts).
 *
 * Migrasi sekali: store belum ada tapi `assistant-history.json` (format lama)
 * ada → diimpor jadi SATU sesi. Path file di-inject lewat makeSessionsStore
 * supaya test memakai folder tmp — tanpa menyentuh data/ user.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join, basename } from "path";
import type { AsMsg } from "./state";
import { MAX_HISTORY } from "./state";

export type SessionRec = {
  id: string;
  /** Nama tampilan: pesan user pertama (dipotong) atau tanggal. */
  name: string;
  workDir: string;
  ts: number;
  messages: AsMsg[];
};

export type SessionsFile = { active: string; sessions: SessionRec[] };

export const MAX_SESSIONS = 20;

/** Path store default (produksi). */
export function defaultSessionsPath(appRootDir: string): string {
  return join(appRootDir, "data", "assistant-sessions.json");
}

/** Path legacy (migrasi satu kali). */
function legacyHistoryPath(appRootDir: string): string {
  return join(appRootDir, "data", "assistant-history.json");
}

export function makeSessionsStore(appRootDir: string) {
  const filePath = defaultSessionsPath(appRootDir);
  const legacyPath = legacyHistoryPath(appRootDir);

  let cache: SessionsFile | null = null;

  function sessionId(): string {
    return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  /** Nama tampilan sesi: user pertama yang bermakna, fallback tanggal. */
  function deriveName(messages: AsMsg[]): string {
    const first = (messages || []).find(
      (m) => m.role === "user" && String(m.content || "").trim() &&
        String(m.content).trim() !== "Lanjutkan tugas berdasarkan hasil tool di atas.",
    );
    const t = first ? String(first.content).replace(/\s+/g, " ").trim() : "";
    if (t) return t.slice(0, 40);
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return "Sesi " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function normalize(f: SessionsFile): SessionsFile {
    const sessions = (f.sessions || [])
      .filter((s) => s && typeof s.id === "string")
      .slice(-MAX_SESSIONS)
      .map((s) => ({
        id: s.id,
        name: String(s.name || "Sesi").slice(0, 80),
        workDir: String(s.workDir || ""),
        ts: Number(s.ts) || Date.now(),
        messages: Array.isArray(s.messages) ? s.messages.slice(-MAX_HISTORY) : [],
      }));
    const active = sessions.some((s) => s.id === f.active)
      ? f.active
      : (sessions[sessions.length - 1]?.id || "");
    return { active, sessions };
  }

  function load(): SessionsFile {
    if (cache) return cache;
    try {
      const raw = readFileSync(filePath, "utf8");
      cache = normalize(JSON.parse(raw));
      return cache;
    } catch {}
    // Migrasi sekali dari format lama (assistant-history.json).
    try {
      const raw = readFileSync(legacyPath, "utf8");
      const j = JSON.parse(raw);
      if (Array.isArray(j?.history) && j.history.length) {
        const msgs: AsMsg[] = j.history.slice(-MAX_HISTORY);
        const rec: SessionRec = {
          id: sessionId(),
          name: deriveName(msgs),
          workDir: String(j.workDir || ""),
          ts: Date.now(),
          messages: msgs,
        };
        cache = normalize({ active: rec.id, sessions: [rec] });
        save();
        // Arsipkan file lama supaya migrasi tidak mengulang & data tak hilang.
        try { renameSync(legacyPath, legacyPath + ".bak"); } catch {}
        return cache;
      }
    } catch {}
    cache = { active: "", sessions: [] };
    return cache;
  }

  function save(): void {
    if (!cache) return;
    try {
      mkdirSync(join(filePath, ".."), { recursive: true });
      const tmp = filePath + ".tmp";
      // Tulis tmp lalu rename — hindari file setengah tertulis.
      writeFileSync(tmp, JSON.stringify(cache, null, 1), "utf8");
      renameSync(tmp, filePath);
    } catch {}
  }

  return {
    load,
    save,
    /** Ringkasan untuk UI — tanpa messages. */
    list(): { active: string; sessions: Array<{ id: string; name: string; workDir: string; ts: number; count: number }> } {
      const f = load();
      return {
        active: f.active,
        sessions: f.sessions.map((s) => ({
          id: s.id, name: s.name, workDir: s.workDir, ts: s.ts, count: s.messages.length,
        })),
      };
    },
    get(id: string): SessionRec | undefined {
      return load().sessions.find((s) => s.id === id);
    },
    activeRec(): SessionRec | undefined {
      const f = load();
      return f.sessions.find((s) => s.id === f.active);
    },
    create(workDir: string): SessionRec {
      const f = load();
      const rec: SessionRec = {
        id: sessionId(),
        name: "Sesi " + new Date().toLocaleString(),
        workDir: String(workDir || ""),
        ts: Date.now(),
        messages: [],
      };
      f.sessions.push(rec);
      if (f.sessions.length > MAX_SESSIONS) {
        // Buang TERLUKA yang bukan aktif; bila semuanya bukan aktif, buang tertua.
        const idxOldest = f.sessions.findIndex((s) => s.id !== f.active);
        if (idxOldest >= 0) f.sessions.splice(idxOldest, 1);
        else f.sessions.shift();
      }
      f.active = rec.id;
      save();
      return rec;
    },
    /** Simpan history ke sesi aktif + segarkan nama otomatis bila masih generik. */
    persistActive(history: AsMsg[], workDir: string): void {
      const f = load();
      const rec = f.sessions.find((s) => s.id === f.active);
      if (!rec) {
        if (!history.length) return; // belum ada apa pun untuk disimpan
        const made = this.create(workDir);
        made.messages = history.slice(-MAX_HISTORY);
        made.name = deriveName(made.messages);
        save();
        return;
      }
      rec.messages = history.slice(-MAX_HISTORY);
      rec.workDir = workDir || rec.workDir;
      rec.ts = Date.now();
      if (/^(Sesi \d{4}-|Sesi \d{1,2}\/)/.test(rec.name)) rec.name = deriveName(rec.messages);
      save();
    },
    switchTo(id: string): SessionRec | null {
      const f = load();
      const rec = f.sessions.find((s) => s.id === id);
      if (!rec) return null;
      f.active = id;
      save();
      return rec;
    },
    /** Hapus sesi; bila aktif terhapus, aktif pindah ke sesi terbaru sisa. */
    remove(id: string): { ok: boolean; newActive?: string; deleted?: SessionRec } {
      const f = load();
      const idx = f.sessions.findIndex((s) => s.id === id);
      if (idx < 0) return { ok: false };
      const [deleted] = f.sessions.splice(idx, 1);
      if (f.active === id) {
        const next = f.sessions[f.sessions.length - 1];
        f.active = next ? next.id : "";
      }
      save();
      return { ok: true, newActive: f.active || undefined, deleted };
    },
    /** Basename workDir — untuk indikator project di rail. */
    projectLabel(): string | null {
      const rec = this.activeRec();
      if (!rec || !rec.workDir) return null;
      return basename(rec.workDir) || rec.workDir;
    },
  };
}

export type SessionsStore = ReturnType<typeof makeSessionsStore>;
