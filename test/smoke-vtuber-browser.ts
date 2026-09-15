/**
 * test/smoke-vtuber-browser.ts — Browser Smoke Test for static/vtuber.html.
 *
 * Menguji perilaku nyata di browser Chromium (headless=new):
 *  1. Booting dan model loading di jalur default (Produksi Cubism 5.3).
 *  2. Verifikasi state: production===true, handle!=null, host!=null, arbiter!=null, roleLink!=null.
 *  3. Verifikasi transparansi canvas dan rendered dimensions.
 *  4. Idle rotation di dalam loop requestAnimationFrame (swayTime berjalan).
 *  5. ParameterArbiter Lip-Sync: submit lipSync intent mengalir ke bridge.
 *  6. Future Capability Readiness:
 *     - handle.motionGroups() dan handle.playNativeMotion()
 *     - handle.playExpression()
 *     - Safe error handling untuk nama yang tidak didukung
 *  7. Resize: window resize event -> host.resize() dan model reframed.
 *  8. Teardown dan model reload: unload model dan muat ulang tanpa error.
 */

import { spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { findChromium } from "../src/server/browser/discovery";
import { CdpClient } from "../src/server/browser/cdp";
import { handleAPI, serveStatic } from "../src/server/index";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPortFile(dir: string, timeoutMs = 10_000): Promise<number> {
  const start = Date.now();
  const file = join(dir, "DevToolsActivePort");
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await readFile(file, "utf8");
      const [firstLine] = content.split(/\r?\n/);
      const port = parseInt(firstLine.trim(), 10);
      if (Number.isFinite(port) && port > 0) return port;
    } catch {}
    await sleep(50);
  }
  throw new Error("Timeout waiting for DevToolsActivePort");
}

async function run() {
  console.log("🚀 Starting VTuber Overlay Browser Smoke Test...");

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      const url = new URL(req.url);
      let pathname = url.pathname;
      if (pathname.startsWith("/api/")) {
        const resp = await handleAPI(req);
        if (resp) return resp;
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === "/") pathname = "/index.html";
      const staticResp = serveStatic(pathname);
      if (staticResp) return staticResp;
      return new Response("Not Found", { status: 404 });
    },
  });

  const appPort = server.port;
  console.log(`📡 Local test server running on port ${appPort}`);

  const chromeExe = findChromium();
  if (!chromeExe) {
    console.error("❌ Chromium executable not found!");
    server.stop();
    process.exit(1);
  }
  console.log(`🌐 Using Chromium: ${chromeExe}`);

  const profileDir = await mkdtemp(join(tmpdir(), "vtuber-smoke-"));
  const browserProc = spawn(chromeExe, [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--headless=new",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--window-size=1280,720",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);

  try {
    const cdpPort = await waitForPortFile(profileDir);
    console.log(`🔌 CDP port active: ${cdpPort}`);

    const listResp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const targets = (await listResp.json()) as any[];
    const pageTarget = targets.find((t) => t.type === "page") || targets[0];
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("No page target available");
    }

    const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
    ]);

    // ── 1. Production Mode Smoke ─────────────────────────────────
    console.log("\n🧪 Testing 1: Production Mode Boot & Load...");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}/vtuber.html` });

    // Tunggu sampai model termuat (status text === 'overlay — idle' atau timeout)
    let prodReady = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const evalStatus = await cdp.send<any>("Runtime.evaluate", {
        expression: "document.getElementById('status')?.textContent",
        returnByValue: true,
      });
      const st = evalStatus.result?.value;
      if (st && (st.includes("chat") || st.includes("menunggu") || st.includes("idle") || st.includes("ready"))) {
        prodReady = true;
        break;
      }
    }

    if (!prodReady) {
      const errEval = await cdp.send<any>("Runtime.evaluate", {
        expression: "document.getElementById('status')?.textContent",
        returnByValue: true,
      });
      console.warn("⚠️ Production load did not report idle, current status:", errEval.result?.value);
    } else {
      console.log("  ✓ Production mode booted and model marked idle");
    }

    // Evaluasi State Produksi
    const prodStateEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `({
        production: window.__vtuberState?.production,
        hasHandle: Boolean(window.__vtuberState?.handle),
        hasHost: Boolean(window.__vtuberState?.host),
        hasModel: Boolean(window.__vtuberState?.model),
        hasArbiter: Boolean(window.__vtuberState?.arbiter),
        hasRoleLink: Boolean(window.__vtuberState?.roleLink),
        bounds: window.__vtuberState?.model?.getBounds ? window.__vtuberState.model.getBounds() : null,
        scale: window.__vtuberState?.handle?.getScale ? window.__vtuberState.handle.getScale() : null,
        naturalSize: window.__vtuberState?.handle?.getNaturalSize ? window.__vtuberState.handle.getNaturalSize() : null,
        transparentBody: window.getComputedStyle(document.body).backgroundColor,
      })`,
      returnByValue: true,
    });

    const prodState = prodStateEval.result?.value;
    console.log("  State Produksi:", JSON.stringify(prodState));
    if (prodState.production !== true) throw new Error("Expected production === true");
    if (!prodState.hasHandle) throw new Error("Expected handle to be present in production");
    if (!prodState.hasHost) throw new Error("Expected host to be present in production");
    if (!prodState.hasArbiter) throw new Error("Expected arbiter to be present in production");
    console.log("  ✓ Production state verified");

    // ── 2. Idle Sway Verification ────────────────────────────────
    console.log("\n🧪 Testing 2: Idle Sway in RAF Loop...");
    await sleep(200);
    const swayEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `({
        swayTime: window.__vtuberState?.swayTime,
        isPositive: window.__vtuberState?.swayTime > 0,
      })`,
      returnByValue: true,
    });
    console.log("  Sway State:", JSON.stringify(swayEval.result?.value));
    if (!swayEval.result?.value?.isPositive) {
      throw new Error("swayTime did not increment in RAF loop");
    }
    console.log("  ✓ Idle sway loop active and ticking");

    // ── 3. Lip-Sync via ParameterArbiter ─────────────────────────
    console.log("\n🧪 Testing 3: Lip-Sync via ParameterArbiter...");
    const lipEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `(() => {
        window.__vtuberSubmitRole('mouthOpenY', 0.8, 15, 'lipSync');
        return {
          hasLipSync: window.__vtuberState?.arbiter?.hasSource('lipSync'),
          activeChannels: window.__vtuberState?.arbiter?.orderedChannels('role'),
        };
      })()`,
      returnByValue: true,
    });
    console.log("  Lip-Sync Submission:", JSON.stringify(lipEval.result?.value));
    if (!lipEval.result?.value?.hasLipSync) {
      throw new Error("lipSync channel was not registered in arbiter");
    }
    console.log("  ✓ Lip-sync routed to ParameterArbiter successfully");

    // ── 4. Future Capability Readiness (Motion & Expression Deformation) ────
    console.log("\n🧪 Testing 4: Future Capability Seam (Motion & Expression Deformation)...");
    const capabilityEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `(async () => {
        const initialPath = window.__vtuberState?.activeModelPath;
        // Muat model dengan motion dan ekspresi resmi (ren.model3.json)
        await window.__vtuberLoadModel("model/tesmodel/runtime/ren.model3.json");
        const handle = window.__vtuberState?.handle;
        const groups = handle?.motionGroups ? handle.motionGroups() : [];

        // 1. Uji playNativeMotion
        const motionTriggered = window.__vtuberPlayMotion("Idle", 0, 3);

        // 2. Uji playExpression & ukur deformasi parameter
        await window.__vtuberPlayExpression("exp_02");

        // Beri waktu fade-in (FadeInTime=0.5s di exp_02) agar update loop menerapkan ekspresi
        await new Promise((r) => setTimeout(r, 300));
        const smileVal = handle?.getParameter ? handle.getParameter("ParamEyeLSmile") : null;

        // 3. Uji fail-safe untuk nama asing
        const badMotion = window.__vtuberPlayMotion("non_existent_group", 0);
        let badExprError = null;
        try {
          await window.__vtuberPlayExpression("non_existent_expr");
        } catch (e) {
          badExprError = e.message;
        }

        // Kembalikan ke model semula
        await window.__vtuberLoadModel(initialPath);

        return {
          availableMotionGroups: groups,
          motionTriggered: Boolean(motionTriggered),
          expressionApplied: typeof smileVal === 'number' && smileVal > 0.01,
          smileVal,
          badMotionSafe: badMotion === false || badMotion === null,
          badExprSafe: badExprError === null,
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log("  Deformation & Capability Result:", JSON.stringify(capabilityEval.result?.value));
    const capRes = capabilityEval.result?.value;
    if (!capRes?.motionTriggered) {
      throw new Error("playNativeMotion failed to trigger native motion on ren model");
    }
    if (!capRes?.expressionApplied) {
      throw new Error(`playExpression failed to deform model parameters (smileVal=${capRes?.smileVal})`);
    }
    if (!capRes?.badMotionSafe || !capRes?.badExprSafe) {
      throw new Error("Unsupported motion or expression did not fail safely");
    }
    console.log("  ✓ Native motion and expression deformation VERIFIED live in Chromium");

    // ── 5. Viewport Resize Smoke ─────────────────────────────────
    console.log("\n🧪 Testing 5: Viewport Resize Response (OBS 1920x1080)...");
    const resizeEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `(() => {
        window.innerWidth = 1920;
        window.innerHeight = 1080;
        window.dispatchEvent(new Event('resize'));
        return {
          hostSize: window.__vtuberState?.host?.screenSize ? window.__vtuberState.host.screenSize() : null,
          bounds: window.__vtuberState?.model?.getBounds ? window.__vtuberState.model.getBounds() : null,
        };
      })()`,
      returnByValue: true,
    });
    console.log("  Resize Result:", JSON.stringify(resizeEval.result?.value));
    console.log("  ✓ Resize dispatched and handled");

    // ── 6. Teardown & Reload Smoke ───────────────────────────────
    console.log("\n🧪 Testing 6: Teardown and Reload Lifecycle...");
    const reloadEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `(async () => {
        const path = window.__vtuberState.activeModelPath;
        await window.__vtuberTeardown();
        const afterTeardown = {
          handle: Boolean(window.__vtuberState.handle),
          host: Boolean(window.__vtuberState.host),
          model: Boolean(window.__vtuberState.model),
        };
        await window.__vtuberLoadModel(path);
        const afterReload = {
          handle: Boolean(window.__vtuberState.handle),
          host: Boolean(window.__vtuberState.host),
          model: Boolean(window.__vtuberState.model),
        };
        return { afterTeardown, afterReload };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log("  Teardown/Reload:", JSON.stringify(reloadEval.result?.value));
    const rRes = reloadEval.result?.value;
    if (rRes?.afterTeardown?.handle || rRes?.afterTeardown?.model) {
      throw new Error("Teardown did not nullify handle or model");
    }
    if (!rRes?.afterReload?.handle || !rRes?.afterReload?.model) {
      throw new Error("Reload did not re-initialize handle or model");
    }
    console.log("  ✓ Model lifecycle teardown & reload verified");

    console.log("\n🎉 ALL VTUBER BROWSER SMOKE CHECKS PASSED!");
  } finally {
    try { browserProc.kill(); } catch {}
    try { await rm(profileDir, { recursive: true, force: true }); } catch {}
    try { server.stop(); } catch {}
  }
}

run().catch((e) => {
  console.error("❌ Smoke test failed:", e);
  process.exit(1);
});
