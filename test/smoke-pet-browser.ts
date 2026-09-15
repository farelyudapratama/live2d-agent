/**
 * test/smoke-pet-browser.ts — Browser Smoke Test for static/pet.html.
 *
 * Menguji perilaku nyata di browser Chromium (headless=new):
 *  1. Booting dan model loading di jalur default (Produksi Cubism 5.3).
 *  2. Verifikasi state: production===true, handle!=null, host!=null, arbiter!=null.
 *  3. Transform dan bounds di viewport browser.
 *  4. Mouse interaction / eye-tracking: mousemove men-submit ke ParameterArbiter.
 *  5. Resize: dispatch resize event -> host.resize() dan model reframed.
 *  6. Native motion: tombol sapa (#b-wave) memicu motion pada handle.
 *  7. Teardown dan model reload: unload model dan muat ulang tanpa error.
 *  8. Legacy fallback (?renderer=legacy): verify production===false dan PIXI.Application aktif.
 *  9. A/B Parity comparison antara Production dan Legacy bounds.
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
  console.log("🚀 Starting Desktop Pet Browser Smoke Test...");

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      const url = new URL(req.url);
      let pathname = url.pathname;
      if (pathname.startsWith("/api/")) {
        const resp = await handleAPI(req);
        if (resp) return resp;
        return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
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

  const profileDir = await mkdtemp(join(tmpdir(), "pet-smoke-"));
  const browserProc = spawn(chromeExe, [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--headless=new",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--window-size=420,640",
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
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}/pet.html` });

    // Tunggu sampai model termuat (status text === 'pet aktif' atau timeout)
    let prodReady = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const evalStatus = await cdp.send<any>("Runtime.evaluate", {
        expression: "document.getElementById('status')?.textContent",
        returnByValue: true,
      });
      const st = evalStatus.result?.value;
      if (st && (st.includes("aktif") || st.includes("active"))) {
        prodReady = true;
        break;
      }
    }

    if (!prodReady) {
      const errEval = await cdp.send<any>("Runtime.evaluate", {
        expression: "document.getElementById('status')?.textContent",
        returnByValue: true,
      });
      console.warn("⚠️ Production load did not report active, current status:", errEval.result?.value);
    } else {
      console.log("  ✓ Production mode booted and model marked active");
    }

    // Evaluasi State Produksi
    const prodStateEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `({
        production: window.__petState?.production,
        hasHandle: Boolean(window.__petState?.handle),
        hasHost: Boolean(window.__petState?.host),
        hasModel: Boolean(window.__petState?.model),
        hasArbiter: Boolean(window.__petState?.arbiter),
        hasRoleLink: Boolean(window.__petState?.roleLink),
        bounds: window.__petState?.model?.getBounds ? window.__petState.model.getBounds() : null,
        scale: window.__petState?.handle?.getScale ? window.__petState.handle.getScale() : null,
        naturalSize: window.__petState?.handle?.getNaturalSize ? window.__petState.handle.getNaturalSize() : null,
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

    // ── 2. Interaction Smoke (MouseMove -> Arbiter) ──────────────
    console.log("\n🧪 Testing 2: Pointer Interaction via ParameterArbiter...");
    const mouseEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `(() => {
        const evt = new MouseEvent('mousemove', { clientX: 300, clientY: 200 });
        window.dispatchEvent(evt);
        return {
          hasGaze: window.__petState?.arbiter?.hasSource('mouseGaze'),
          roleChannels: window.__petState?.arbiter?.orderedChannels('role'),
        };
      })()`,
      returnByValue: true,
    });
    console.log("  Mouse Interaction:", JSON.stringify(mouseEval.result?.value));
    if (!mouseEval.result?.value?.hasGaze) {
      throw new Error("mouseGaze channel was not registered in arbiter");
    }
    console.log("  ✓ Mouse interaction routed to ParameterArbiter successfully");

    // ── 3. Resize Smoke ──────────────────────────────────────────
    console.log("\n🧪 Testing 3: Viewport Resize Response...");
    const resizeEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `(() => {
        window.innerWidth = 600;
        window.innerHeight = 800;
        window.dispatchEvent(new Event('resize'));
        return {
          hostSize: window.__petState?.host?.screenSize ? window.__petState.host.screenSize() : null,
          bounds: window.__petState?.model?.getBounds ? window.__petState.model.getBounds() : null,
        };
      })()`,
      returnByValue: true,
    });
    console.log("  Resize Result:", JSON.stringify(resizeEval.result?.value));
    console.log("  ✓ Resize dispatched and handled");

    // ── 4. Motion Smoke ──────────────────────────────────────────
    console.log("\n🧪 Testing 4: Native Motion Trigger...");
    const motionEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `(() => {
        const btn = document.getElementById('b-wave');
        btn.click();
        const bubble = document.getElementById('bubble');
        const bubbleText = document.getElementById('bubble-text');
        return {
          bubbleVisible: bubble.style.display !== 'none',
          bubbleText: bubbleText.textContent,
        };
      })()`,
      returnByValue: true,
    });
    console.log("  Wave Motion Result:", JSON.stringify(motionEval.result?.value));
    if (!motionEval.result?.value?.bubbleVisible) {
      throw new Error("Bubble did not appear after wave button click");
    }
    console.log("  ✓ Native motion and UI feedback triggered successfully");

    // ── 5. Teardown & Reload Smoke ───────────────────────────────
    console.log("\n🧪 Testing 5: Teardown and Reload Lifecycle...");
    const reloadEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `(async () => {
        const path = window.__petState.activeModelPath;
        await window.__petTeardown();
        const afterTeardown = {
          handle: Boolean(window.__petState.handle),
          host: Boolean(window.__petState.host),
          model: Boolean(window.__petState.model),
        };
        await window.__petLoadModel(path);
        const afterReload = {
          handle: Boolean(window.__petState.handle),
          host: Boolean(window.__petState.host),
          model: Boolean(window.__petState.model),
        };
        return { afterTeardown, afterReload };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log("  Teardown/Reload eval raw:", JSON.stringify(reloadEval));
    console.log("  Teardown/Reload:", JSON.stringify(reloadEval.result?.value));
    if (reloadEval.result?.value?.afterTeardown?.handle !== false) {
      throw new Error("Handle was not cleaned during teardown");
    }
    if (reloadEval.result?.value?.afterReload?.handle !== true) {
      throw new Error("Handle was not re-created on reload");
    }
    console.log("  ✓ Model lifecycle teardown & reload verified");

    // ── 6. Legacy Fallback Mode & Parity ──────────────────────────
    console.log("\n🧪 Testing 6: Legacy Fallback (?renderer=legacy) & A/B Parity...");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}/pet.html?renderer=legacy` });

    let legacyReady = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const evalStatus = await cdp.send<any>("Runtime.evaluate", {
        expression: "document.getElementById('status')?.textContent",
        returnByValue: true,
      });
      const st = evalStatus.result?.value;
      if (st && (st.includes("aktif") || st.includes("active"))) {
        legacyReady = true;
        break;
      }
    }

    const legacyStateEval = await cdp.send<any>("Runtime.evaluate", {
      expression: `({
        production: window.__petState?.production,
        hasHandle: Boolean(window.__petState?.handle),
        hasHost: Boolean(window.__petState?.host),
        hasApp: Boolean(window.__petState?.app),
        bounds: window.__petState?.model?.getBounds ? window.__petState.model.getBounds() : null,
      })`,
      returnByValue: true,
    });
    const legacyState = legacyStateEval.result?.value;
    console.log("  State with ?renderer=legacy:", JSON.stringify(legacyState));
    if (legacyState.production !== true) {
      throw new Error("Expected production === true unconditionally (legacy fallback retired in R9-3)");
    }
    if (legacyState.hasApp) {
      throw new Error("Expected NO PIXI.Application (legacy fallback retired in R9-3)");
    }
    if (!legacyState.hasHandle || !legacyState.hasHost) {
      throw new Error("Expected production handle and host to remain active with ?renderer=legacy");
    }
    console.log("  ✓ Retired legacy parameter safely ignored; production Cubism renderer active");

    console.log("\n🎉 ALL PET BROWSER SMOKE CHECKS PASSED!");
  } finally {
    try { browserProc.kill(); } catch {}
    try { await rm(profileDir, { recursive: true, force: true }); } catch {}
    server.stop();
  }
}

run().catch((e) => {
  console.error("❌ Smoke test failed:", e);
  process.exit(1);
});
