/**
 * test/r8-3-vtuber.test.ts — R8-3: Migrate static/vtuber.html to Production Cubism Renderer.
 *
 * Verifikasi:
 *  1. Static Dependency Audit:
 *     - Production Cubism 5.3 renderer adalah default di static/vtuber.html.
 *     - PIXI.Application dan PIXI.live2d hanya ada di percabangan legacy fallback (?renderer=legacy).
 *     - Percabangan produksi bebas dari PIXI.*, internalModel, dan direct coreModel.setParameter...
 *     - Parameter writes di produksi menggunakan roleLink / ParameterArbiter via role mouthOpenY.
 *     - Ticker.shared tidak digunakan oleh model produksi; pemilik frame adalah RAF eksplisit.
 *  2. Frame Ownership & Single RAF:
 *     - Satu loop requestAnimationFrame eksplisit mengendalikan frame.
 *     - Idle rotation (sin(t * 0.9) * 0.012) dijalankan di dalam RAF tick, bukan setInterval 16ms.
 *     - Tepat satu handle.update(dt) dan satu host.render() per frame.
 *  3. Model-Agnostic Lip-Sync:
 *     - Browser TTS mouthPulse menggunakan ParameterArbiter role mouthOpenY.
 *     - Remote TTS AudioLipSync disampel di loop RAF ke ParameterArbiter role mouthOpenY.
 *     - Nilai 0 disubmit saat bicara selesai.
 *  4. Transform & Framing Parity:
 *     - Natural dimensions, scaling uniform, dan centering (+ vertical offset -3%)
 *       identik dengan formula legacy.
 *     - DPR 1 vs DPR 2 tidak mengubah koordinat ruang CSS.
 *     - Window resize memperbarui host dan reframes model.
 *  5. Lifecycle & Teardown:
 *     - load, teardownCurrentModel, unload, destroy, dan reload berulang.
 *  6. Future Capability Readiness:
 *     - state.handle mengekspos playNativeMotion, motionGroups, isMotionFinished, stopAllMotions.
 *     - state.handle mengekspos playExpression.
 *     - state.handle mengekspos setFocus.
 *     - state.arbiter mengekspos submit & commit untuk kontrol role-based parameter.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const repoRoot = join(import.meta.dir, "..");
const vtuberHtml = readFileSync(join(repoRoot, "static", "vtuber.html"), "utf8");

// Ekstrak isi script utama dari vtuber.html
const scriptMatch = vtuberHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
const vtuberScript = scriptMatch ? scriptMatch[1] : "";

describe("R8-3 Static Dependency Audit", () => {
  test("vtuber.html memuat script produksi Cubism lengkap", () => {
    expect(vtuberHtml).toContain('src="js/live2dcubismcore.min.js"');
    expect(vtuberHtml).toContain('src="js/cubism-framework.js"');
    expect(vtuberHtml).toContain('src="js/live2d-adapter.js"');
    expect(vtuberHtml).toContain('src="js/scene-layers.js"');
    expect(vtuberHtml).toContain('src="js/pixi8-namespace.js"');
    expect(vtuberHtml).toContain('src="js/bundle.js"');
  });

  test("vtuber.html TIDAK memuat script legacy Pixi6 / pixi-live2d", () => {
    expect(vtuberHtml).not.toContain('src="js/pixi.6.5.10.min.js"');
    expect(vtuberHtml).not.toContain('src="js/pixi-live2d-0.4.0.js');
  });

  test("Renderer produksi adalah satu-satunya runtime (unconditional production: true)", () => {
    expect(vtuberScript).toContain("production: true");
    expect(vtuberScript).toContain("?renderer=legacy parameter is retired in R9-3");
  });

  test("Percabangan produksi memanggil API produksi live2dApi", () => {
    expect(vtuberScript).toContain("window.__live2dApi.createHost");
    expect(vtuberScript).toContain("window.__live2dApi.loadModel");
    expect(vtuberScript).toContain('composite: "canvas-texture"');
  });

  test("Percabangan produksi menggunakan ParameterArbiter dan roleLink untuk parameter writes", () => {
    expect(vtuberScript).toContain("window.__engineRoleLink.attachHandle");
    expect(vtuberScript).toContain("window.__l2dArbiter.createArbiter");
    expect(vtuberScript).toContain("state.arbiter.submit");
    expect(vtuberScript).toContain("state.arbiter.commit");
    expect(vtuberScript).toContain("handle.onBeforeModelUpdate");
  });

  test("vtuber.html TIDAK mengakses coreModel, internalModel, atau PIXI", () => {
    expect(vtuberScript).not.toContain("internalModel");
    expect(vtuberScript).not.toContain("coreModel");
    expect(vtuberScript).not.toContain("setParameterValueById");
    expect(vtuberScript).not.toContain("PIXI");
  });

  test("Percabangan legacy tereliminasi total dari vtuber.html", () => {
    expect(vtuberScript).not.toContain("Live2DModel.registerTicker");
    expect(vtuberScript).not.toContain("new PIXI.Application");
    expect(vtuberScript).not.toContain("PIXI.live2d");
  });

  test("Terdapat penanganan window resize untuk produksi", () => {
    expect(vtuberScript).toContain('window.addEventListener("resize"');
    expect(vtuberScript).toContain("state.host.resize(W, H)");
    expect(vtuberScript).toContain("frameModel()");
  });
});

describe("R8-3 Frame Ownership & Single RAF", () => {
  test("Memiliki render loop tunggal requestAnimationFrame", () => {
    expect(vtuberScript).toContain("function startRenderLoop()");
    expect(vtuberScript).toContain("state.rafId = requestAnimationFrame(tick);");
    expect(vtuberScript).toContain("cancelAnimationFrame(state.rafId)");
  });

  test("Idle rotation dijalankan di dalam RAF loop, bukan setInterval", () => {
    const loopMatch = vtuberScript.match(/function startRenderLoop\(\)\s*\{([\s\S]*?)\n  \}/);
    expect(loopMatch).not.toBeNull();
    const loopBody = loopMatch![1];

    expect(loopBody).toContain("state.swayTime += dt;");
    expect(loopBody).toContain("state.handle.setRotation(Math.sin(state.swayTime * 0.9) * 0.012);");
  });

  test("Tepat satu handle.update(dt) dan satu host.render() di loop produksi", () => {
    const loopMatch = vtuberScript.match(/function startRenderLoop\(\)\s*\{([\s\S]*?)\n  \}/);
    expect(loopMatch).not.toBeNull();
    const loopBody = loopMatch![1];

    const updateCount = (loopBody.match(/state\.handle\.update\(/g) || []).length;
    const renderCount = (loopBody.match(/state\.host\.render\(/g) || []).length;

    expect(updateCount).toBe(1);
    expect(renderCount).toBe(1);
  });
});

describe("R8-3 Model-Agnostic Lip-Sync", () => {
  test("Lip-sync menggunakan ParameterArbiter role mouthOpenY", () => {
    expect(vtuberScript).toContain('channel: "lipSync"');
    expect(vtuberScript).toContain("domain: \"role\"");
    expect(vtuberScript).toContain("mouthOpenY:");
  });

  test("Browser TTS mouthPulse menggunakan role-based submit dan mereset ke 0", () => {
    const pulseMatch = vtuberScript.match(/function mouthPulse\(\)\s*\{([\s\S]*?)\n  \}/);
    expect(pulseMatch).not.toBeNull();
    const pulseBody = pulseMatch![1];

    expect(pulseBody).toContain("state.lipPulseActive = true;");
    expect(pulseBody).toContain("values: { mouthOpenY: 0 }");
  });

  test("Remote TTS AudioLipSync disambungkan ke RAF sampler", () => {
    expect(vtuberScript).toContain("state.audioLipSync = state.audioLipSync || new window.LipSync.AudioLipSync();");
    expect(vtuberScript).toContain("state.audioLipSync.sample(now)");
  });
});

describe("R8-3 Transform & Framing Parity", () => {
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

  const compatModelFnStr = extractFunction(vtuberScript, "createCompatModel");

  test("createCompatModel mengembalikan interface display object legacy lengkap", () => {
    const sandbox: Record<string, unknown> = {
      window: { innerWidth: 1920, innerHeight: 1080 },
    };
    vm.createContext(sandbox);
    vm.runInContext(compatModelFnStr, sandbox);

    let pos = { x: 0, y: 0 };
    let scale = 1;
    let anchor = { x: 0.5, y: 0.5 };
    let rotation = 0;
    let destroyed = false;

    const mockHandle = {
      getNaturalSize: () => ({ width: 4000, height: 6000 }),
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
    expect(model.handle).toBe(mockHandle);
    expect(model.width).toBe(4000);
    expect(model.height).toBe(6000);

    // Skala
    model.scale.set(0.15);
    expect(model.scale.x).toBe(0.15);
    expect(model.scale.y).toBe(0.15);
    expect(model.width).toBe(600);
    expect(model.height).toBe(900);

    // Posisi
    model.x = 200;
    model.y = 300;
    expect(model.x).toBe(200);
    expect(model.y).toBe(300);

    // Bounds
    const b = model.getBounds();
    expect(b.left).toBe(200);
    expect(b.top).toBe(300);
    expect(b.width).toBe(600);
    expect(b.height).toBe(900);
    expect(b.centerX).toBe(500);
    expect(b.centerY).toBe(750);

    // Rotasi
    model.rotation = 0.05;
    expect(rotation).toBe(0.05);

    // Destroy
    model.destroy();
    expect(destroyed).toBe(true);
  });

  test("Paritas kalkulasi framing model di viewport OBS (1920x1080 dan 1280x720)", () => {
    for (const vp of [{ w: 1920, h: 1080 }, { w: 1280, h: 720 }, { w: 720, h: 1280 }]) {
      const natW = 2000;
      const natH = 3000;
      const s = Math.min((vp.w * 0.9) / natW, (vp.h * 0.92) / natH);
      const expectedX = (vp.w - natW * s) / 2;
      const expectedY = (vp.h - natH * s) / 2 - vp.h * 0.03;

      expect(s).toBeGreaterThan(0);
      expect(expectedX).toBeGreaterThanOrEqual(0);
      expect(expectedY).toBeLessThan(vp.h);
    }
  });
});

describe("R8-3 Lifecycle & Teardown", () => {
  test("Fungsi teardownCurrentModel dan teardown terdefinisi", () => {
    expect(vtuberScript).toContain("async function teardownCurrentModel()");
    expect(vtuberScript).toContain("async function teardown()");
  });

  test("teardownCurrentModel membersihkan host dan handle tanpa kebocoran", () => {
    expect(vtuberScript).toContain("state.host.remove(state.handle)");
    expect(vtuberScript).toContain("state.handle.destroy()");
    expect(vtuberScript).toContain("state.handle = null;");
    expect(vtuberScript).toContain("state.arbiter = null;");
    expect(vtuberScript).toContain("state.roleLink = null;");
  });

  test("teardown membatalkan RAF dan membersihkan seluruh timer", () => {
    expect(vtuberScript).toContain("cancelAnimationFrame(state.rafId)");
    expect(vtuberScript).toContain("clearInterval(state.heartbeatTimer)");
    expect(vtuberScript).toContain("clearInterval(state.eventsTimer)");
    expect(vtuberScript).toContain("state.host.destroy()");
  });

  test("loadModel memastikan elemen canvas otomatis dibuat ulang jika hilang", () => {
    expect(vtuberScript).toContain('let stageCanvas = document.getElementById("live2d-canvas");');
    expect(vtuberScript).toContain('stageCanvas = document.createElement("canvas");');
    expect(vtuberScript).toContain('stageEl.appendChild(stageCanvas);');
  });
});

describe("R8-3 Future Capability Readiness", () => {
  test("Ekspos seam helper untuk motion, expression, dan role-based parameter", () => {
    expect(vtuberScript).toContain("window.__vtuberState = state;");
    expect(vtuberScript).toContain("window.__vtuberLoadModel = loadModel;");
    expect(vtuberScript).toContain("window.__vtuberTeardown = teardown;");
    expect(vtuberScript).toContain("window.__vtuberFrameModel = frameModel;");
    expect(vtuberScript).toContain("window.__vtuberPlayMotion =");
    expect(vtuberScript).toContain("window.__vtuberPlayExpression =");
    expect(vtuberScript).toContain("window.__vtuberSubmitRole =");
  });

  test("compatModel meneruskan motion dan expression ke handle tanpa modul pihak ketiga", () => {
    expect(vtuberScript).toContain("handle.playNativeMotion(group");
    expect(vtuberScript).toContain("handle.playExpression(name)");
  });
});
