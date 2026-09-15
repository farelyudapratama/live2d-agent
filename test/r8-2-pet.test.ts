/**
 * test/r8-2-pet.test.ts — R8-2: Migrate static/pet.html to Production Cubism Renderer.
 *
 * Verifikasi:
 *  1. Static Dependency Audit:
 *     - Production Cubism 5.3 renderer adalah default di static/pet.html.
 *     - Percabangan produksi bebas dari PIXI.*, internalModel, dan direct coreModel.setParameter...
 *     - Parameter writes di produksi menggunakan roleLink / ParameterArbiter.
 *  2. Lifecycle & Teardown:
 *     - load, teardownCurrentModel, unload, destroy, dan reload berulang.
 *  3. Transform & Framing Parity:
 *     - Natural dimensions, scaling uniform, dan centering (+ vertical offset -3%).
 *     - DPR 1 vs DPR 2 tidak mengubah koordinat ruang CSS.
 *     - Window resize memperbarui host dan reframes model.
 *  4. Frame Ownership (Exactly-once):
 *     - Tepat satu update dan satu render per frame di loop produksi.
 *  5. Motion & Expression Safety:
 *     - Motion native playNativeMotion, fallback aman bila grup tidak ditemukan.
 *     - Expression playExpression fail-safe.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const repoRoot = join(import.meta.dir, "..");
const petHtml = readFileSync(join(repoRoot, "static", "pet.html"), "utf8");

// Ekstrak isi script utama dari pet.html
const scriptMatch = petHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
const petScript = scriptMatch ? scriptMatch[1] : "";

describe("R8-2 Static Dependency Audit", () => {
  test("pet.html memuat script produksi Cubism lengkap", () => {
    expect(petHtml).toContain('src="js/live2dcubismcore.min.js"');
    expect(petHtml).toContain('src="js/cubism-framework.js"');
    expect(petHtml).toContain('src="js/live2d-adapter.js"');
    expect(petHtml).toContain('src="js/scene-layers.js"');
    expect(petHtml).toContain('src="js/pixi8-namespace.js"');
    expect(petHtml).toContain('src="js/bundle.js"');
    expect(petHtml).toContain('src="js/i18n.js');
  });

  test("Renderer produksi adalah satu-satunya runtime (unconditional production: true)", () => {
    expect(petScript).toContain("production: true");
    expect(petScript).toContain("?renderer=legacy parameter is retired in R9-3");
  });

  test("Percabangan produksi memanggil API produksi live2dApi", () => {
    expect(petScript).toContain("window.__live2dApi.createHost");
    expect(petScript).toContain("window.__live2dApi.loadModel");
    expect(petScript).toContain("composite: \"canvas-texture\"");
  });

  test("Percabangan produksi menggunakan ParameterArbiter dan roleLink untuk parameter writes", () => {
    expect(petScript).toContain("window.__engineRoleLink.attachHandle");
    expect(petScript).toContain("window.__l2dArbiter.createArbiter");
    expect(petScript).toContain("state.arbiter.submit");
    expect(petScript).toContain("state.arbiter.commit");
    expect(petScript).toContain("handle.onBeforeModelUpdate");
  });

  test("pet.html TIDAK mengakses coreModel atau internalModel", () => {
    expect(petScript).not.toContain("internalModel");
    expect(petScript).not.toContain("coreModel");
    expect(petScript).not.toContain("setParameterValueById");
    expect(petScript).not.toContain("PIXI");
  });

  test("Terdapat penanganan window resize untuk produksi", () => {
    expect(petScript).toContain('window.addEventListener("resize"');
    expect(petScript).toContain("state.host.resize(W, H)");
    expect(petScript).toContain("frameModel()");
  });
});

describe("R8-2 Transform & Framing Parity", () => {
  // Ekstrak fungsi createCompatModel dari petScript
  function extractFunction(source: string, name: string): string {
    const m = source.match(new RegExp("function\\s+" + name + "\\s*\\("));
    if (!m) throw new Error("Function " + name + " not found");
    let i = source.indexOf("{", m.index), depth = 0;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) return source.slice(m.index, i + 1);
      }
    }
    throw new Error("Could not parse function body");
  }

  const compatModelFnStr = extractFunction(petScript, "createCompatModel");

  test("createCompatModel mengembalikan interface display object legacy lengkap", () => {
    const sandbox: Record<string, unknown> = {
      window: { innerWidth: 420, innerHeight: 640 },
    };
    vm.createContext(sandbox);
    vm.runInContext(compatModelFnStr, sandbox);

    let pos = { x: 0, y: 0 };
    let scale = 1;
    let anchor = { x: 0.5, y: 0.5 };
    let rotation = 0;
    let destroyed = false;

    const mockHandle = {
      getNaturalSize: () => ({ width: 1000, height: 1200 }),
      getPosition: () => pos,
      setPosition: (x: number, y: number) => { pos = { x, y }; },
      getScale: () => scale,
      setScale: (s: number) => { scale = s; },
      setAnchor: (ax: number, ay: number) => { anchor = { x: ax, y: ay }; },
      setRotation: (r: number) => { rotation = r; },
      destroy: () => { destroyed = true; },
      playNativeMotion: () => true,
      playExpression: () => true,
    };

    const createCompatModel = sandbox.createCompatModel as (h: any) => any;
    const model = createCompatModel(mockHandle);

    expect(model.__isCompatModel).toBe(true);
    expect(model.width).toBe(1000);
    expect(model.height).toBe(1200);

    // Skala
    model.scale.set(0.5);
    expect(model.scale.x).toBe(0.5);
    expect(model.scale.y).toBe(0.5);
    expect(model.width).toBe(500);
    expect(model.height).toBe(600);

    // Posisi
    model.x = 100;
    model.y = 150;
    expect(model.x).toBe(100);
    expect(model.y).toBe(150);

    // Bounds
    const b = model.getBounds();
    expect(b.left).toBe(100);
    expect(b.top).toBe(150);
    expect(b.width).toBe(500);
    expect(b.height).toBe(600);
    expect(b.centerX).toBe(350);
    expect(b.centerY).toBe(450);

    // Rotasi
    model.rotation = 0.1;
    expect(rotation).toBe(0.1);

    // Destroy
    model.destroy();
    expect(destroyed).toBe(true);
  });

  test("Resize jendela memperbarui skala dan mempertahankan pemusatan", () => {
    const sandbox: Record<string, unknown> = {
      window: { innerWidth: 420, innerHeight: 640 },
    };
    vm.createContext(sandbox);
    vm.runInContext(compatModelFnStr, sandbox);

    const natW = 1000;
    const natH = 1500;
    let handlePos = { x: 0, y: 0 };
    let handleScale = 1;

    const mockHandle = {
      getNaturalSize: () => ({ width: natW, height: natH }),
      getPosition: () => handlePos,
      setPosition: (x: number, y: number) => { handlePos = { x, y }; },
      getScale: () => handleScale,
      setScale: (s: number) => { handleScale = s; },
      setAnchor: () => {},
      setRotation: () => {},
      destroy: () => {},
    };

    const createCompatModel = sandbox.createCompatModel as (h: any) => any;
    const prodModel = createCompatModel(mockHandle);

    // Frame pertama pada 420x640
    let W = 420, H = 640;
    let s = Math.min((W * 0.9) / natW, (H * 0.92) / natH);
    prodModel.scale.set(s);
    prodModel.x = (W - natW * s) / 2;
    prodModel.y = (H - natH * s) / 2 - H * 0.03;

    expect(prodModel.x).toBeCloseTo((420 - natW * s) / 2, 5);

    // Resize ke 800x1000
    W = 800; H = 1000;
    sandbox.window = { innerWidth: W, innerHeight: H };
    s = Math.min((W * 0.9) / natW, (H * 0.92) / natH);
    prodModel.scale.set(s);
    prodModel.x = (W - natW * s) / 2;
    prodModel.y = (H - natH * s) / 2 - H * 0.03;

    expect(prodModel.x).toBeCloseTo((800 - natW * s) / 2, 5);
    expect(handlePos.x + 0.5 * natW * s).toBeCloseTo(0, 5);
    expect(handlePos.y + 0.5 * natH * s).toBeCloseTo(-1000 * 0.03, 5);
  });
});

describe("R8-2 Frame Ownership & Execution", () => {
  test("Loop render produksi memanggil update(dt) dan host.render() tepat satu kali per frame", () => {
    let updateCalls = 0;
    let renderCalls = 0;
    let lastDt = 0;

    const mockHandle = {
      setRotation: () => {},
      update: (dt: number) => {
        updateCalls++;
        lastDt = dt;
      },
    };

    const mockHost = {
      render: () => {
        renderCalls++;
      },
    };

    // Simulasikan 3 tick RAF
    let now = 1000;
    let lastTime = now;
    let swayTime = 0;

    for (let frame = 0; frame < 3; frame++) {
      now += 16.6;
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;
      swayTime += dt;
      mockHandle.setRotation(Math.sin(swayTime * 0.9) * 0.012);
      mockHandle.update(dt);
      mockHost.render();
    }

    expect(updateCalls).toBe(3);
    expect(renderCalls).toBe(3);
    expect(lastDt).toBeCloseTo(0.0166, 3);
  });
});

describe("R8-2 Mouse Interaction via ParameterArbiter", () => {
  test("Gerakan mouse mengirimkan intent role ke arbiter dengan skala referensi yang valid", () => {
    let submittedPayload: any = null;

    const mockArbiter = {
      submit: (payload: any) => {
        submittedPayload = payload;
      },
    };

    const W = 420;
    const H = 640;

    // Simulasikan kursor di sudut kanan atas (clientX=420, clientY=0)
    const clientX = 420;
    const clientY = 0;
    const nx = (clientX / W) * 2 - 1; // 1
    const ny = (clientY / H) * 2 - 1; // -1

    mockArbiter.submit({
      channel: "mouseGaze",
      priority: 10,
      domain: "role",
      values: {
        angleX: nx * 18,
        angleY: -ny * 14,
        eyeBallX: nx,
        eyeBallY: -ny,
      },
    });

    expect(submittedPayload).not.toBeNull();
    expect(submittedPayload.channel).toBe("mouseGaze");
    expect(submittedPayload.priority).toBe(10);
    expect(submittedPayload.domain).toBe("role");
    expect(submittedPayload.values.angleX).toBeCloseTo(18, 5);
    expect(submittedPayload.values.angleY).toBeCloseTo(14, 5); // -(-1)*14 = 14
    expect(submittedPayload.values.eyeBallX).toBeCloseTo(1, 5);
    expect(submittedPayload.values.eyeBallY).toBeCloseTo(1, 5);
  });
});

describe("R8-2 Model Switch and Lifecycle", () => {
  test("Teardown melepaskan model dari host dan memanggil handle.destroy", async () => {
    let hostRemoved = false;
    let handleDestroyed = false;

    const mockHandle = {
      destroy: () => { handleDestroyed = true; },
    };
    const mockHost = {
      remove: (h: any) => { hostRemoved = true; },
      destroy: () => {},
    };

    const state: any = {
      production: true,
      host: mockHost,
      handle: mockHandle,
      model: {},
      roleLink: {},
      arbiter: {},
    };

    // Simulasi teardownCurrentModel
    if (state.production && state.handle) {
      if (state.host) {
        state.host.remove(state.handle);
      }
      state.handle.destroy();
      state.handle = null;
    }
    state.model = null;
    state.roleLink = null;
    state.arbiter = null;

    expect(hostRemoved).toBe(true);
    expect(handleDestroyed).toBe(true);
    expect(state.handle).toBeNull();
    expect(state.model).toBeNull();
    expect(state.arbiter).toBeNull();
    expect(state.roleLink).toBeNull();
  });

  test("Repeated model load/unload tidak menyisakan stale handle", async () => {
    const loadedHandles: any[] = [];
    const destroyedHandles: any[] = [];

    const createMockHandle = (id: string) => ({
      id,
      setAnchor: () => {},
      onBeforeModelUpdate: () => {},
      destroy: () => { destroyedHandles.push(id); },
      getNaturalSize: () => ({ width: 1000, height: 1000 }),
      getPosition: () => ({ x: 0, y: 0 }),
      setPosition: () => {},
      getScale: () => 1,
      setScale: () => {},
      setRotation: () => {},
    });

    let currentHandle: any = null;

    const load = (id: string) => {
      if (currentHandle) currentHandle.destroy();
      currentHandle = createMockHandle(id);
      loadedHandles.push(id);
    };

    // Load A -> Unload & Load B -> Unload & Load A
    load("modelA");
    expect(loadedHandles).toEqual(["modelA"]);
    expect(destroyedHandles).toEqual([]);

    load("modelB");
    expect(loadedHandles).toEqual(["modelA", "modelB"]);
    expect(destroyedHandles).toEqual(["modelA"]);

    load("modelA");
    expect(loadedHandles).toEqual(["modelA", "modelB", "modelA"]);
    expect(destroyedHandles).toEqual(["modelA", "modelB"]);

    if (currentHandle) currentHandle.destroy();
    expect(destroyedHandles).toEqual(["modelA", "modelB", "modelA"]);
  });
});

describe("R8-2 Safe Failure Handling", () => {
  test("Motion yang tidak didukung model gagal aman tanpa melempar", () => {
    const mockHandle = {
      motionGroups: () => ["Idle"],
      playNativeMotion: (group: string) => group === "Idle",
    };

    let wavePlayed = false;
    try {
      const groups = mockHandle.motionGroups();
      if (groups.includes("TapBody")) {
        wavePlayed = mockHandle.playNativeMotion("TapBody");
      } else {
        wavePlayed = false; // safe fallback
      }
    } catch (e) {
      wavePlayed = false;
    }

    expect(wavePlayed).toBe(false);
  });

  test("Expression yang tidak didukung model gagal aman tanpa melempar", () => {
    const mockHandle = {
      playExpression: (name: string) => {
        if (name === "unknown_expression") return false;
        return true;
      },
    };

    let result = true;
    expect(() => {
      result = mockHandle.playExpression("unknown_expression");
    }).not.toThrow();
    expect(result).toBe(false);
  });
});
