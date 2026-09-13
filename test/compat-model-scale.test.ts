/**
 * compat-model-scale.test.ts — R7-2 regression guard: createCompatModel scale
 * facade harus memenuhi kontrak observable-point agar frameModel tidak
 * early-return (natH=NaN → model off-screen → measureLitBounds null).
 *
 * Bukti historis: sebelum fix, scale object hanya punya `{get x, set}` tanpa
 * `get y` → `m.scale.y` undefined → `b.height / m.scale.y` = NaN → validSize
 * gagal → frameModel early-return → model tetap di scale=1/pos(0,0) → off-screen.
 *
 * Yang diuji:
 *  1. scale.x tersedia dan readable
 *  2. scale.y tersedia dan readable
 *  3. scale.set(v) mengubah x dan y secara seragam
 *  4. scale.set(x, y) mengubah masing-masing (atau x saja untuk uniform)
 *  5. getBounds().width/scale.x dan getBounds().height/scale.y harus finite
 *     (frameModel tidak boleh early-return karena natH=NaN)
 *  6. Negative control: scale object tanpa y (old bug shape) → natH = NaN
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const repoRoot = join(import.meta.dir, "..");
const appSrc = readFileSync(join(repoRoot, "static", "js", "app.js"), "utf8");

// ── vm extraction (sama dengan test-override-guard) ──────────────────────
function extractFn(source: string, name: string): string | null {
  const m = source.match(new RegExp("\\bfunction\\s+" + name + "\\s*\\("));
  if (!m) return null;
  let i = source.indexOf("{", m.index),
    depth = 0,
    inStr: string | null = null,
    esc = false;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (!depth)
        return source.slice(
          source.lastIndexOf("function", m.index + 1),
          i + 1,
        );
    }
  }
  return null;
}

const compatModelSrc = extractFn(appSrc, "createCompatModel");

// ── fake handle ──────────────────────────────────────────────────────────
function makeHandle(natW = 5200, natH = 7000, initialScale = 0.05) {
  let scale = initialScale;
  let posX = 0,
    posY = 0;
  const calls: Record<string, any[][]> = {};

  // helper: fungsi yang mencatat panggilan lalu menjalankan impl
  const rec =
    (name: string, impl: (...args: any[]) => any) =>
    (...args: any[]) => {
      (calls[name] = calls[name] || []).push(args);
      return impl(...args);
    };

  return {
    get calls() {
      return calls;
    },
    get _scale() {
      return scale;
    },
    get _pos() {
      return { x: posX, y: posY };
    },
    getNaturalSize: rec("getNaturalSize", () => ({ width: natW, height: natH })),
    getScale: rec("getScale", () => scale),
    setScale: rec("setScale", (v: number) => {
      scale = v;
    }),
    getPosition: rec("getPosition", () => ({ x: posX, y: posY })),
    setPosition: rec("setPosition", (x: number, y: number) => {
      posX = x;
      posY = y;
    }),
    setRotation: rec("setRotation", () => {}),
    setAnchor: rec("setAnchor", () => {}),
    playNativeMotion: rec("playNativeMotion", () => Promise.resolve()),
    playExpression: rec("playExpression", () => Promise.resolve()),
    destroy: rec("destroy", () => {}),
  };
}

// ── sandbox dengan globals yang dibutuhkan createCompatModel ──────────────
function runCompatModel(handle: ReturnType<typeof makeHandle>) {
  const sandbox = {
    // stageSize() → { w, h } — compositor canvas CSS size
    stageSize: () => ({ w: 1280, h: 720 }),
    // R8-1: createCompatModel mandiri — TIDAK lagi membutuhkan PIXI/PIXI.Point
    __handle: handle,
    Number,
    Math,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(compatModelSrc!, sandbox);
  vm.runInContext("var model = createCompatModel(__handle)", sandbox);
  return (sandbox as any).model;
}

// ── tests ────────────────────────────────────────────────────────────────
describe("compat model scale facade (R7-2 regression guard)", () => {
  test("source createCompatModel exists in app.js", () => {
    expect(compatModelSrc).not.toBeNull();
  });

  test("__isCompatModel flag present", () => {
    const m = runCompatModel(makeHandle());
    expect(m.__isCompatModel).toBe(true);
  });

  test("scale.x readable dan sama dengan getScale()", () => {
    const h = makeHandle(5200, 7000, 0.10485);
    const m = runCompatModel(h);
    expect(m.scale.x).toBeCloseTo(0.10485, 5);
  });

  test("scale.y readable dan sama dengan getScale()", () => {
    const h = makeHandle(5200, 7000, 0.10485);
    const m = runCompatModel(h);
    expect(m.scale.y).toBeCloseTo(0.10485, 5);
  });

  test("scale.x === scale.y (uniform — produksi hanya punya satu skala)", () => {
    const h = makeHandle(5200, 7000, 0.082);
    const m = runCompatModel(h);
    expect(m.scale.x).toBe(m.scale.y);
  });

  test("scale.set(v) mengubah x dan y seragam", () => {
    const h = makeHandle(5200, 7000, 0.05);
    const m = runCompatModel(h);
    m.scale.set(0.42);
    expect(m.scale.x).toBeCloseTo(0.42, 5);
    expect(m.scale.y).toBeCloseTo(0.42, 5);
    expect(h.calls.setScale![0][0]).toBe(0.42);
  });

  test("scale.set(x, y) → setScale(x) (uniform, x saja; y ditoleransi)", () => {
    const h = makeHandle(5200, 7000, 0.05);
    const m = runCompatModel(h);
    m.scale.set(0.3, 0.9);
    // Produksi uniform: x saja yang ditulis, y diabaikan (callback kedua).
    expect(m.scale.x).toBeCloseTo(0.3, 5);
    expect(h.calls.setScale).toHaveLength(1);
    expect(h.calls.setScale![0][0]).toBe(0.3);
  });

  test("scale.x assignment menulis ke setScale (sama seperti set(v))", () => {
    const h = makeHandle(5200, 7000, 0.05);
    const m = runCompatModel(h);
    m.scale.x = 0.25;
    expect(m.scale.x).toBeCloseTo(0.25, 5);
    expect(h.calls.setScale).toHaveLength(1);
    expect(h.calls.setScale![0][0]).toBe(0.25);
  });

  test("scale.y assignment menulis ke setScale (sama seperti set(v))", () => {
    const h = makeHandle(5200, 7000, 0.05);
    const m = runCompatModel(h);
    m.scale.y = 0.35;
    expect(m.scale.y).toBeCloseTo(0.35, 5);
    expect(h.calls.setScale).toHaveLength(1);
    expect(h.calls.setScale![0][0]).toBe(0.35);
  });

  test("getBounds() mengembalikan dimensi yang valid", () => {
    const h = makeHandle(5200, 7000, 0.10485);
    const m = runCompatModel(h);
    const b = m.getBounds();
    // width = naturalWidth * scale, height = naturalHeight * scale
    expect(b.width).toBeCloseTo(5200 * 0.10485, 0);
    expect(b.height).toBeCloseTo(7000 * 0.10485, 0);
    expect(b.left).toBeTypeOf("number");
    expect(b.top).toBeTypeOf("number");
  });

  test("frameModel natW/natH finite: b.height / scale.y === naturalHeight", () => {
    const h = makeHandle(5200, 7000, 0.10485);
    const m = runCompatModel(h);
    const b = m.getBounds();
    const natW = b.width / m.scale.x;
    const natH = b.height / m.scale.y;
    // natW/natH harus finite dan equal natural size — frameModel tidak early-return
    expect(Number.isFinite(natW)).toBe(true);
    expect(Number.isFinite(natH)).toBe(true);
    expect(natW).toBeCloseTo(5200, 0);
    expect(natH).toBeCloseTo(7000, 0);
  });

  test("edge case: scale sangat kecil → natW/natH tetap valid", () => {
    const h = makeHandle(5200, 7000, 0.001);
    const m = runCompatModel(h);
    const b = m.getBounds();
    expect(Number.isFinite(b.width / m.scale.x)).toBe(true);
    expect(Number.isFinite(b.height / m.scale.y)).toBe(true);
    expect(b.width / m.scale.x).toBeCloseTo(5200, 0);
    expect(b.height / m.scale.y).toBeCloseTo(7000, 0);
  });

  test("NEGATIVE CONTROL: scale object tanpa y → natH = NaN (old bug shape)", () => {
    // Replikasi bug sebelum R7-2 fix: scale hanya punya {get x, set}
    const brokenScale = {
      get x() {
        return 0.10485;
      },
      set(v: number) {},
      // TIDAK ADA get y → m.scale.y = undefined → b.height / undefined = NaN
    };
    const b = { width: 5200 * 0.10485, height: 7000 * 0.10485 };
    const natH = b.height / (brokenScale as any).y;
    expect(Number.isFinite(natH)).toBe(false); // NaN → validSize gagal → early-return
  });

  test("destroy() memanggil handle.destroy()", () => {
    const h = makeHandle();
    const m = runCompatModel(h);
    m.destroy();
    expect(h.calls.destroy).toHaveLength(1);
  });

  test("x/y getter/setter menghitung posisi pusat (coord transformation)", () => {
    const h = makeHandle(5200, 7000, 0.10485);
    const m = runCompatModel(h);
    // x = stageW/2 + posX = 640 + 0 = 640
    expect(m.x).toBeCloseTo(640, 0);
    // Set x → posX = x - stageW/2
    m.x = 300;
    expect(h.calls.setPosition).toHaveLength(1);
    expect(h.calls.setPosition![0][0]).toBeCloseTo(300 - 640, 0);
  });

  test("R8-1 toGlobal(p) mengembalikan POJO {x, y} tanpa ketergantungan PIXI", () => {
    const h = makeHandle(5200, 7000, 0.1);
    const m = runCompatModel(h);
    const g = m.toGlobal({ x: 100, y: 200 });
    // stage: w=1280, h=720; r.x=0, r.y=0; L=640, T=360; sc=0.1
    // g.x = 640 + 100 * 0.1 = 650; g.y = 360 + 200 * 0.1 = 380
    expect(g).toBeTypeOf("object");
    expect(g.x).toBeCloseTo(650, 4);
    expect(g.y).toBeCloseTo(380, 4);
    expect(g.constructor.name).toBe("Object");
  });

  test("R8-1 toLocal(p) mengembalikan POJO {x, y} tanpa ketergantungan PIXI", () => {
    const h = makeHandle(5200, 7000, 0.1);
    const m = runCompatModel(h);
    const l = m.toLocal({ x: 650, y: 380 });
    expect(l).toBeTypeOf("object");
    expect(l.x).toBeCloseTo(100, 4);
    expect(l.y).toBeCloseTo(200, 4);
    expect(l.constructor.name).toBe("Object");
  });

  test("R8-1 toGlobal dan toLocal adalah inversi satu sama lain", () => {
    const h = makeHandle(5200, 7000, 0.125);
    const m = runCompatModel(h);
    const initial = { x: 345.6, y: 789.1 };
    const globalPt = m.toGlobal(initial);
    const roundTrip = m.toLocal(globalPt);
    expect(roundTrip.x).toBeCloseTo(initial.x, 4);
    expect(roundTrip.y).toBeCloseTo(initial.y, 4);
  });
});
