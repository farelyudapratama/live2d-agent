/**
 * vtuber-inject.test.ts — kontrak /api/vtuber/mock-event: tipe "agent" harus
 * lolos utuh (balasan AI dapat kelas .agent di Feed Live), tipe asing jatuh
 * ke "chat". Ini bug nyata: dulu semua tipe non-donasi dipaksa "chat" sehingga
 * balasan AI tampil tak berwarna di feed.
 */
import { describe, it, expect } from "bun:test";
import {
  vtuberStart,
  vtuberStop,
  vtuberInjectEvent,
  vtuberEvents,
} from "../src/server/vtuber";

describe("vtuberInjectEvent — kontrak tipe mock-event", () => {
  it("start mock → inject type=agent dipertahankan (bukan dipaksa chat)", () => {
    expect(vtuberStart({ provider: "mock" }).ok).toBe(true);
    try {
      const ev = vtuberInjectEvent({ type: "agent", user: "AI", text: "Halo!" });
      expect(ev).not.toBeNull();
      expect(ev!.type).toBe("agent");
      const { events } = vtuberEvents(0);
      expect(events.some((e) => e.type === "agent" && e.user === "AI")).toBe(true);
    } finally {
      vtuberStop();
    }
  });

  it("type donation tetap donation; type asing jatuh ke chat", () => {
    expect(vtuberStart({ provider: "mock" }).ok).toBe(true);
    try {
      expect(vtuberInjectEvent({ type: "donation", user: "Rian", text: "gopek", amount: "Rp 10.000" })!.type).toBe("donation");
      expect(vtuberInjectEvent({ type: "ngawur", user: "X", text: "?" })!.type).toBe("chat");
    } finally {
      vtuberStop();
    }
  });

  it("tanpa runtime aktif → null (bukan throw)", () => {
    vtuberStop();
    expect(vtuberInjectEvent({ type: "agent", user: "AI", text: "halo" })).toBeNull();
  });
});
