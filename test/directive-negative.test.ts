/**
 * directive-negative.test.ts — Phase 12 §4: negative parser tests.
 *
 * Properti yang dikunci: output LLM yang rusak/berbahaya TIDAK BOLEH menjadi
 * eksekusi kode arbitrer. Parser tidak di-redesign — test ini MEMBEKUKAN
 * semantik existing (termasuk perilaku kasus tepi seperti NaN HEAD/EYES/MOUTH
 * yang diteruskan dan dikelola di lapisan clamp — dicatat sebagai risiko di
 * STATUS, bukan diubah di Phase 12).
 */
import { describe, test, expect } from "bun:test";
import { parseSegments, hasDirectives, stripDirectives } from "../src/client/agent/directive-parser";

// Semua nilai hasil parse harus data polos (string/number/boolean/null/
// array/object polos) — tidak ada function/symbol yang bisa dieksekusi.
function assertPlainData(v: any, path = "$"): void {
  if (v === null || v === undefined) return;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertPlainData(x, `${path}[${i}]`));
    return;
  }
  if (t === "object") {
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype, { message: path });
    for (const [k, x] of Object.entries(v)) assertPlainData(x, `${path}.${k}`);
    return;
  }
  throw new Error(`nilai non-data di ${path}: ${t}`);
}

describe("negative parser — directive kosong / malformed", () => {
  test("[EMOTION:] (nilai kosong) tidak match regex → jadi teks literal, bukan action", () => {
    const segs = parseSegments("[EMOTION:] halo");
    expect(segs.length).toBe(1);
    expect(segs[0].actions.emotion).toBeUndefined();
    expect(segs[0].text).toContain("[EMOTION:]");
  });

  test("[HEAD:5] (kurang argumen) → diabaikan, tidak crash", () => {
    const segs = parseSegments("[HEAD:5] halo");
    expect(segs[0].actions.head).toBeUndefined();
  });

  test("[ACC:ParamX] (tanpa nilai) → diabaikan", () => {
    const segs = parseSegments("[ACC:ParamX] halo");
    expect(segs[0].actions.accessories).toBeUndefined();
  });

  test("[MOTION:] kosong → tidak jadi action motion", () => {
    const segs = parseSegments("[MOTION:] halo");
    expect(segs[0].actions.motion).toBeUndefined();
  });
});

describe("negative parser — nilai non-numerik", () => {
  // Semantik existing dibekukan: HEAD/EYES/MOUTH menerima NaN (parser tidak
  // memvalidasi); BODY yang menurunkan NaN ke 0. Ini DICATAT sebagai risiko
  // di docs/STATUS (lapisan clamp engine tidak mengubah NaN) — dilarang
  // "diperbaiki" diam-diam di Phase 12 karena parser tidak boleh di-redesign.
  test("[HEAD:a,b] → NaN diteruskan (semantik saat ini, risiko tercatat)", () => {
    const segs = parseSegments("[HEAD:a,b] halo");
    expect(Number.isNaN(segs[0].actions.head!.x)).toBe(true);
    expect(Number.isNaN(segs[0].actions.head!.y)).toBe(true);
  });

  test("[EYES:x,y] non-numerik → NaN diteruskan (semantik saat ini)", () => {
    const segs = parseSegments("[EYES:kiri,atas] halo");
    expect(Number.isNaN(segs[0].actions.eyes!.x)).toBe(true);
  });

  test("[MOUTH:abc,def] → NaN diteruskan (semantik saat ini)", () => {
    const segs = parseSegments("[MOUTH:abc,def] halo");
    expect(Number.isNaN(segs[0].actions.mouth!.form)).toBe(true);
  });

  test("[BODY:a,b] → jatuh ke 0 (guard NaN BODY existing)", () => {
    const segs = parseSegments("[BODY:a,b,c] halo");
    expect(segs[0].actions.body).toEqual({ x: 0, y: 0, z: 0 });
  });

  test("[BODY:5] (z hilang) → diabaikan", () => {
    const segs = parseSegments("[BODY:5] halo");
    expect(segs[0].actions.body).toBeUndefined();
  });
});

describe("negative parser — INTENSITY", () => {
  test("[INTENSITY:abc] → diabaikan (intensity undefined)", () => {
    const segs = parseSegments("[INTENSITY:abc] halo");
    expect(segs[0].actions.intensity).toBeUndefined();
  });

  test("[INTENSITY:5] → clamp ke 1", () => {
    expect(parseSegments("[INTENSITY:5] x")[0].actions.intensity).toBe(1);
  });

  test("[INTENSITY:0] dan [INTENSITY:-3] → clamp ke 0.1", () => {
    expect(parseSegments("[INTENSITY:0] x")[0].actions.intensity).toBe(0.1);
    expect(parseSegments("[INTENSITY:-3] x")[0].actions.intensity).toBe(0.1);
  });
});

describe("negative parser — id tak dikenal diteruskan sebagai string polos", () => {
  test("[MOTION:...] asing → string polos, keamanan di runtime (playMotion false)", () => {
    const segs = parseSegments("[MOTION:this_does_not_exist] halo");
    expect(segs[0].actions.motion).toBe("this_does_not_exist");
    assertPlainData(segs[0].actions);
  });

  test("[GESTURE:...] / [EMOTION:...] asing → string polos (engine yang memutuskan)", () => {
    const segs = parseSegments("[EMOTION:hapus_semua_file][GESTURE:rm_rf] halo");
    expect(segs[0].actions.emotion).toBe("hapus_semua_file");
    expect(segs[0].actions.gesture).toBe("rm_rf");
  });
});

describe("negative parser — [ACTION:] no-op", () => {
  test("[ACTION:x] dikenali regex tapi diabaikan switch (no-op senyap, perilaku existing)", () => {
    const segs = parseSegments("[ACTION:menari] halo");
    expect(segs.length).toBe(1);
    expect(segs[0].actions).toEqual({});
    // directive dibuang dari teks tampil (split menangkapnya)
    expect(segs[0].text).toBe("halo");
  });
});

describe("negative parser — response non-directive (JSON/HTML/gibberish)", () => {
  test("malformed JSON → teks polos, tidak crash", () => {
    const segs = parseSegments('{"segments":[{"text":"hi"');
    expect(segs.length).toBeGreaterThanOrEqual(1);
    expect(segs[0].actions).toEqual({});
  });

  test("HTML/gibberish → teks polos; tag script tidak dieksekusi (string inert)", () => {
    const reply = "<html><b>halo</b></html> [EMOTION:<script>alert(1)</script>] dunia";
    const segs = parseSegments(reply);
    // nilai directive disimpan sebagai string polos, tidak pernah di-eval
    expect(segs.some((s) => s.actions.emotion === "<script>alert(1)</script>")).toBe(true);
    assertPlainData(segs.map((s) => s.actions));
    // tidak ada kode yang bisa muncul sebagai function
    expect(JSON.parse(JSON.stringify(segs))).toEqual(segs);
  });

  test("string kosong → []", () => {
    expect(parseSegments("")).toEqual([]);
  });

  test("whitespace saja → []", () => {
    expect(parseSegments("   \n\t ")).toEqual([]);
  });
});

describe("negative parser — mixed valid + invalid", () => {
  test("valid selamat, invalid dibuang, tidak crash", () => {
    const reply =
      "[EMOTION:senang][BOGUS:x][GESTURE:nod][INTENSITY:9] Halo dunia [HEAD:bad] lagi";
    const segs = parseSegments(reply);
    const all = segs.flatMap((s) => [s.actions]);
    expect(all.some((a) => a.emotion === "senang")).toBe(true);
    expect(all.some((a) => a.gesture === "nod")).toBe(true);
    expect(all.some((a) => a.intensity === 1)).toBe(true); // clamp dari 9
    // [HEAD:bad] cuma 1 argumen → diabaikan
    expect(all.some((a) => a.head)).toBe(false);
    assertPlainData(all);
  });

  test("directive di tengah kalimat tetap terurai jadi segmen berurutan (actions kumulatif)", () => {
    const segs = parseSegments("[EMOTION:senang] Halo [GESTURE:nod] dunia");
    expect(segs.length).toBe(2);
    expect(segs[0]).toEqual({ text: "Halo", actions: { emotion: "senang" } });
    // semantik existing: actions kumulatif — segmen kedua mewarisi emosi
    // segmen sebelumnya sampai diganti (perilaku yang juga dipakai prompt
    // multi-segment di brain)
    expect(segs[1]).toEqual({ text: "dunia", actions: { emotion: "senang", gesture: "nod" } });
  });

  test("bracket tak dikenal ([FOO:x], [emotion:senang] lowercase type invalid tetap match case-insensitive)", () => {
    // type tak dikenal tidak masuk daftar → dibiarkan jadi teks
    expect(parseSegments("[FOO:x] halo")[0].text).toContain("[FOO:x]");
    // regex case-insensitive: [emotion:senang] tetap directive sah
    expect(parseSegments("[emotion:senang] halo")[0].actions.emotion).toBe("senang");
  });

  test("stripDirectives pada teks berbahaya tidak mengubah eksekusi — hanya string", () => {
    const dirty = "[MOTION:x]; process.exit(1); [EMOTION:senang]";
    const clean = stripDirectives(dirty);
    expect(clean).toBe("; process.exit(1);");
    expect(hasDirectives(dirty)).toBe(true);
  });
});
