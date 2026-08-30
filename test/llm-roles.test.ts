/**
 * llm-roles.test.ts — multi-LLM role routing (Fase 1–2).
 *
 * Yang dikunci di sini:
 *   1. normalizeRoles/connHasRole — wildcard kompatibel mundur, dedupe, drop
 *      role tak dikenal.
 *   2. orderForRole — eksplisit menang atas wildcard; tanpa kandidat → []
 *      (= jatuh ke urutan default, endpoint tidak boleh mati).
 *   3. llmWithFallback menerima urutan — bukti via provider mock + field `used`.
 *   4. Prompt-split: prompt pembicara TANPA tabel parameter / userNote
 *      per-param, TAPI kosakata (emosi/gesture) + DAFTAR AKSESORIS tetap ada
 *      (ACC safeguard), dan catatan karakter (userNote top-level) tetap ada.
 *   5. formatParamNotes — sanitasi + batas 24 × 200.
 */
import { describe, test, expect } from "bun:test";
import {
  LLM_ROLES,
  normalizeRoles,
  connHasRole,
  orderForRole,
  llmWithFallback,
} from "../src/shared/llm-client";
import { AgentBrain } from "../src/client/agent/brain";
import { formatParamNotes } from "../src/server/index";

const conn = (id: string, roles?: string[]) =>
  ({ id, name: id, provider: "mock", apiKey: "mock", roles } as any);

describe("normalizeRoles / connHasRole", () => {
  test("role kanonik: chat, motion, sheet", () => {
    expect(LLM_ROLES).toEqual(["chat", "motion", "sheet"]);
  });

  test("absen / kosong / invalid → wildcard (semua role)", () => {
    for (const roles of [undefined, [], "chat", 42]) {
      expect(connHasRole({ id: "x", roles } as any, "chat")).toBe(true);
      expect(connHasRole({ id: "x", roles } as any, "motion")).toBe(true);
    }
    expect(connHasRole(null, "chat")).toBe(true);
  });

  test("eksplisit mencocokkan & mengecualikan yang lain", () => {
    const c = conn("x", ["motion"]);
    expect(connHasRole(c, "motion")).toBe(true);
    expect(connHasRole(c, "chat")).toBe(false);
  });

  test("case-insensitive, trim, dedupe, drop tak dikenal, non-string diabaikan", () => {
    expect(normalizeRoles(["CHAT", "  chat  ", "Motion", "teleport", 1, null, ""])).toEqual(["chat", "motion"]);
  });
});

describe("orderForRole", () => {
  test("eksplisit di atas wildcard; wildcard tetap jadi kandidat", () => {
    const a = conn("a");                    // wildcard
    const b = conn("b", ["motion"]);        // eksplisit motion
    const c = conn("c", ["chat"]);          // tidak match motion
    const order = orderForRole("motion", [a, b, c]);
    expect(order.map((x) => x.id)).toEqual(["b", "a"]);
  });

  test("tanpa kandidat sama sekali → [] (fallback urutan default, bukan mati)", () => {
    const a = conn("a", ["chat"]);
    const b = conn("b", ["chat"]);
    expect(orderForRole("motion", [a, b])).toEqual([]);
  });
});

describe("llmWithFallback menerima urutan (provider mock, bukti via `used`)", () => {
  const getP = (conns: any[]) => ({
    getConnections: () => conns,
    getActive: () => conns[0],
    persist: () => {},
  });

  test("urutan kustom: koneksi kedua-lah yang dipakai dulu", async () => {
    const a = conn("a");
    const b = conn("b");
    const r = await llmWithFallback(getP([a, b]).getConnections, getP([a, b]).getActive, () => {}, [{ role: "user", content: "hai" }], "", [b, a]);
    expect(r.used).toBe("b");
  });

  test("tanpa urutan: perilaku lama — aktif dulu", async () => {
    const a = conn("a");
    const b = conn("b");
    const r = await llmWithFallback(getP([a, b]).getConnections, getP([a, b]).getActive, () => {}, [{ role: "user", content: "hai" }]);
    expect(r.used).toBe("a");
  });
});

describe("prompt-split: prompt pembicara lean, kosakata + aksesoris tetap", () => {
  const brain = new AgentBrain() as any;
  brain.capProfile = {
    emotions: ["senang", "sedih"],
    nativeExpressions: ["exp_a"],
    accessories: ["ParamCheek"],
    properties: [],
    gestures: ["nod", "wave_hi"],
    motionCatalog: [],
    userNote: "dia pemalu",
    sheet: {
      params: [
        { id: "ParamAngleX", label: "ParamAngleX", min: -30, max: 30, def: 0, group: "Sudut (Angle)", userNote: "geser kepala kiri kanan" },
      ],
    },
    roleIds: {},
    paramRange: {},
  };

  const prompt: string = brain.buildSystemPrompt("");

  test("TABEL parameter TIDAK ada lagi di prompt pembicara", () => {
    expect(prompt).not.toContain("DAFTAR PARAMETER LENGKAP");
    expect(prompt).not.toContain("-30..30");
  });

  test("userNote per-parameter TIDAK ada (ini inti perbaikannya)", () => {
    expect(prompt).not.toContain("geser kepala kiri kanan");
  });

  test("identitas karakter (userNote top-level) TETAP ada", () => {
    expect(prompt).toContain("dia pemalu");
  });

  test("kosakata emosi & gesture tetap ada", () => {
    expect(prompt).toContain("senang");
    expect(prompt).toContain("nod");
  });

  test("ACC SAFEGUARD: daftar aksesoris (id param) TETAP ada untuk [ACC:]", () => {
    expect(prompt).toContain("ParamCheek");
  });

  test("prompt materialnya jauh lebih ramping (<4000 char)", () => {
    expect(prompt.length).toBeLessThan(4000);
  });
});

describe("formatParamNotes", () => {
  test("kosong / bentuk aneh → string kosong", () => {
    expect(formatParamNotes(null)).toBe("");
    expect(formatParamNotes("x")).toBe("");
    expect(formatParamNotes([])).toBe("");
    expect(formatParamNotes({})).toBe("");
  });

  test("sanitasi control char + trim", () => {
    const out = formatParamNotes({ ParamRahang: "  buka\u0007rahang bawah  " });
    expect(out).toBe('- "ParamRahang": bukarahang bawah');
  });

  test("batas keras: maks 24 entri, 200 char/entri, 60 char id", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i++) many["P" + i] = "n" + i;
    expect(formatParamNotes(many).split("\n").length).toBe(24);
    const long = formatParamNotes({ ParamX: "a".repeat(500) });
    expect(long.length).toBeLessThanOrEqual('- "ParamX": '.length + 200);
    const longId = formatParamNotes({ ["I".repeat(100)]: "catatan" });
    expect(longId).toContain("I".repeat(60));
    expect(longId).not.toContain("I".repeat(61));
  });
});
