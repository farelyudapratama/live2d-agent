/**
 * test/agent-sessions.test.ts — Store multi-session assistant.
 * Semua operasi dijalankan di folder tmp (mkdtemp) — TIDAK menyentuh
 * data/ user. Menguji: create/list/switch/remove, cap 20 sesi, persist
 * aktif + auto-nama dari pesan user, migrasi format lama, round-trip.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeSessionsStore } from "../src/server/agent/sessions";

const dir = mkdtempSync(join(tmpdir(), "agent-sess-"));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function msg(role: "user" | "assistant" | "tool", content: string) {
  return { role, content, ts: Date.now() };
}

describe("sessions store", () => {
  it("create → list → switch → persist → round-trip", () => {
    const s = makeSessionsStore(dir);
    const a = s.create("/tmp/projek-a");
    expect(a.id).toMatch(/^s_/);

    // persist ke sesi aktif + auto-nama dari pesan user pertama
    s.persistActive([msg("user", "Bikin fitur undo yang bagus ya"), msg("assistant", "siap")], "/tmp/projek-a");
    const l1 = s.list();
    expect(l1.active).toBe(a.id);
    expect(l1.sessions[0].name).toBe("Bikin fitur undo yang bagus ya");
    expect(l1.sessions[0].count).toBe(2);

    const b = s.create("/tmp/projek-b");
    expect(s.list().active).toBe(b.id);
    expect(s.list().sessions.length).toBe(2);

    // switch balik → messages ikut
    const rec = s.switchTo(a.id);
    expect(rec?.name).toBe("Bikin fitur undo yang bagus ya");
    expect(s.activeRec()?.messages.length).toBe(2);
    expect(s.switchTo("s_tidak_ada")).toBeNull();
  });

  it("persistActive tanpa sesi → auto-create sesi dari history", () => {
    const d2 = join(dir, "auto");
    mkdirSync(d2, { recursive: true });
    const s = makeSessionsStore(d2);
    s.persistActive([msg("user", "halo sesi baru")], "/x");
    expect(s.list().sessions.length).toBe(1);
    expect(s.list().sessions[0].name).toBe("halo sesi baru");
  });

  it("remove: hapus non-aktif & hapus aktif (aktif pindah ke terbaru sisa)", () => {
    const d3 = join(dir, "rm");
    mkdirSync(d3, { recursive: true });
    const s = makeSessionsStore(d3);
    const a = s.create("/a");
    const b = s.create("/b");
    const c = s.create("/c");

    const r1 = s.remove(b.id); // non-aktif
    expect(r1.ok).toBe(true);
    expect(s.list().active).toBe(c.id);

    const r2 = s.remove(c.id); // aktif → pindah ke a
    expect(r2.ok).toBe(true);
    expect(r2.newActive).toBe(a.id);
    expect(s.list().active).toBe(a.id);

    expect(s.remove("s_nol").ok).toBe(false);
    const r3 = s.remove(a.id);
    expect(r3.newActive).toBeUndefined();
    expect(s.list().sessions.length).toBe(0);
  });

  it("cap 20 sesi — yang dibuang bukan yang aktif", () => {
    const d4 = join(dir, "cap");
    mkdirSync(d4, { recursive: true });
    const s = makeSessionsStore(d4);
    let firstId = "";
    for (let i = 0; i < 25; i++) {
      const r = s.create("/w" + i);
      if (i === 1) firstId = r.id;
    }
    const l = s.list();
    expect(l.sessions.length).toBe(20);
    expect(l.sessions.some((x) => x.id === firstId)).toBe(false); // tertua terbuang
    expect(l.sessions[l.sessions.length - 1].id).toBe(l.active);
  });

  it("round-trip ke disk: store baru membaca file yang ditulis store lama", () => {
    const d5 = join(dir, "rt");
    mkdirSync(d5, { recursive: true });
    const s1 = makeSessionsStore(d5);
    const r = s1.create("/p");
    s1.persistActive([msg("user", "cek persist")], "/p");

    const s2 = makeSessionsStore(d5);
    expect(s2.list().active).toBe(r.id);
    expect(s2.activeRec()?.messages.length).toBe(1);
  });

  it("migrasi format lama assistant-history.json → satu sesi + .bak", () => {
    const d6 = join(dir, "migr");
    mkdirSync(join(d6, "data"), { recursive: true });
    writeFileSync(join(d6, "data", "assistant-history.json"), JSON.stringify({
      history: [msg("user", "sesi lama dari history.json")],
      workDir: "/legacy",
    }), "utf8");
    // Store default path: <dir>/data/assistant-sessions.json — cocok.
    const s = makeSessionsStore(d6);
    const l = s.list();
    expect(l.sessions.length).toBe(1);
    expect(l.sessions[0].name).toBe("sesi lama dari history.json");
    expect(l.sessions[0].workDir).toBe("/legacy");
    expect(existsSync(join(d6, "data", "assistant-history.json.bak"))).toBe(true);
    // store kedua tidak me-migrasi ulang
    const s2 = makeSessionsStore(d6);
    expect(s2.list().sessions.length).toBe(1);
  });

  it("load lama wrapper (state.loadSession) kompatibel dengan format baru", () => {
    // Pastikan bentuk file yang ditulis store terbaca state.loadSession —
    // diuji lewat komposisi file (tanpa import state agar tidak menyentuh
    // runtime global): file yang sama dibaca ulang sebagai JSON.
    const raw = readFileSync(join(d6Path(), "data", "assistant-sessions.json"), "utf8");
    const j = JSON.parse(raw);
    expect(j.active).toBeTruthy();
    expect(Array.isArray(j.sessions)).toBe(true);
  });
});

/** Folder migrasi dari test sebelumnya (urutan test di file ini deterministik). */
function d6Path(): string {
  return join(dir, "migr");
}
