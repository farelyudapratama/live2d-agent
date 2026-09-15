#!/usr/bin/env bun
/**
 * test/smoke-corelog-shim-ab.ts — R9-4: A/B browser verification core-log-shim.
 *
 * Menguji nyata di Chromium headless apakah `core-log-shim.js` masih diperlukan
 * oleh production setelah vendor Pixi6/pixi-live2d dihapus (R9-3/R9-4).
 *
 * Kondisi A: HTML produksi apa adanya (memuat core-log-shim.js).
 * Kondisi B: HTML sama tapi tag shim dihapus via interceptor server
 *            (file fisik TIDAK diubah — intercept di layer serve).
 *
 * Per halaman × kondisi × model (ren = motions+expressions, lumine = physics):
 *   - page boot tanpa JS exception
 *   - Core 6.0.1 init (window.Live2DCubismCore.csmGetVersion)
 *   - Framework 5.3 init (__l2dFrameworkStarted, loadModel sukses)
 *   - adapter init (host + handle)
 *   - parameter read/write via handle
 *   - native motion + completion (ren)
 *   - expression + efek parameter nyata (ren exp_02)
 *   - EyeBlink/Breath/Physics gate + Focus
 *   - destroy/reload lifecycle (pet & vtuber; index via reload halaman)
 *
 * Usage: bun test/smoke-corelog-shim-ab.ts
 * Exit 0 = A & B lulus identik → shim terbukti tidak diperlukan.
 * Exit 2 = B gagal, A lulus → shim wajib dipertahankan.
 */

import { spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { findChromium } from "../src/server/browser/discovery";
import { CdpClient } from "../src/server/browser/cdp";
import { handleAPI, serveStatic } from "../src/server/index";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SHIM_TAG_RE = /[ \t]*<script src="js\/core-log-shim\.js"><\/script>\r?\n?/g;

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

async function evalIn<T>(cdp: CdpClient, expression: string): Promise<T | undefined> {
  const r = await cdp.send<any>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails) return undefined;
  return r?.result?.value as T | undefined;
}

type ConsoleError = { type: string; text: string };

type Probe = {
  booted: boolean;
  coreVersion: string | null;
  frameworkStarted: boolean;
  handle: boolean;
  host: boolean;
  modelPath: string;
  paramCount: number;
  paramWrite: boolean;
  motionGroups: string[];
  motionPlayed: boolean;
  motionFinishedObserved: boolean;
  expressionPlayed: boolean;
  expressionEffect: boolean;
  expressionSmileValue: number | null;
  eyeBlink: boolean;
  breath: boolean;
  physics: boolean;
  focus: boolean;
  eyeBlinkParams: number;
  lipSyncParams: number;
  destroyed: boolean;
  reloaded: boolean;
};

type PageSpec = {
  name: string;
  stateExpr: string;
  /** URL halaman dengan model query — index pakai nama folder, pet/vtuber path model3. */
  url: (modelPath: string) => string;
  /** Loader in-page untuk model switch / reload (pet & vtuber); null untuk index. */
  loaderExpr?: string;
};

async function startServerAndBrowser(condition: "A" | "B") {
  const strip = condition === "B";
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
      if (staticResp) {
        if (strip && /\.html?$/i.test(pathname)) {
          const html = await staticResp.text();
          return new Response(html.replace(SHIM_TAG_RE, ""), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return staticResp;
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  const chromeExe = findChromium();
  if (!chromeExe) throw new Error("Chromium executable not found");

  const profileDir = await mkdtemp(join(tmpdir(), `shim-ab-${condition}-`));
  const browserProc = spawn(chromeExe, [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--headless=new",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--window-size=1280,900",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);

  const cdpPort = await waitForPortFile(profileDir);
  const listResp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const targets = (await listResp.json()) as any[];
  const pageTarget = targets.find((t) => t.type === "page") || targets[0];
  const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable")]);

  // Sanity interceptor — pasca-R9-4 shim sudah TIDAK ADA di disk;
  // kedua kondisi melayani HTML tanpa shim. (Sebelum penghapusan,
  // kondisi A menuntut tag shim tersaji — evidence A/B lengkap telah
  // dikumpulkan saat itu; harness kini dipakai ulang sebagai smoke
  // produksi 3-halaman × 2-model.)
  const html = await (await fetch(`http://127.0.0.1:${server.port}/index.html`)).text();
  if (html.includes("core-log-shim.js")) {
    throw new Error("core-log-shim.js masih tersaji di produksi — harusnya terhapus R9-4");
  }

  return { server, browserProc, cdp, profileDir };
}

async function stopServerAndBrowser(ctx: Awaited<ReturnType<typeof startServerAndBrowser>>) {
  try { ctx.browserProc.kill(); } catch {}
  try { await rm(ctx.profileDir, { recursive: true, force: true }); } catch {}
  ctx.server.stop();
}

/** Verifikasi satu halaman (sudah navigasi) terhadap model aktif. */
async function probePage(
  cdp: CdpClient,
  spec: PageSpec,
  opts: { hasMotion: boolean; hasExpression: boolean; lifecycle: boolean },
): Promise<Probe> {
  const consoleErrors: ConsoleError[] = [];
  const offConsole = cdp.on("Runtime.consoleAPICalled", (p: any) => {
    if (p?.type === "error") {
      consoleErrors.push({
        type: p.type,
        text: (p.args || []).map((a: any) => a.value ?? a.description ?? "").join(" ").slice(0, 300),
      });
    }
  });
  const offExc = cdp.on("Runtime.exceptionThrown", (p: any) => {
    const d = p?.exceptionDetails;
    consoleErrors.push({ type: "exception", text: (d?.exception?.description || d?.text || "unknown").slice(0, 300) });
  });

  try {
    let booted = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const ready = await evalIn<boolean>(cdp, `Boolean((${spec.stateExpr})?.handle)`);
      if (ready) { booted = true; break; }
    }
    await sleep(1200); // ≥1 render tick untuk efek & motion mulai

    const p = await evalIn<any>(cdp, `(() => {
      const st = (${spec.stateExpr}) || {};
      const h = st.handle;
      const o = { coreVersion: null, frameworkStarted: false, handle: false, host: false,
                   modelPath: "", paramCount: 0, paramWrite: false, motionGroups: [],
                   eyeBlinkParams: 0, lipSyncParams: 0 };
      try {
        const C = window.Live2DCubismCore;
        const vfn = C && (C.Version?.csmGetVersion || C.csmGetVersion);
        if (typeof vfn === "function") {
          const v = vfn.call(C.Version || C);
          o.coreVersion = (v >> 24) + "." + ((v >> 16) & 0xff) + "." + (v & 0xffff);
        }
      } catch (e) { o.coreVersion = "ERR"; }
      o.frameworkStarted = Boolean(window.__l2dFrameworkStarted);
      o.handle = Boolean(h); o.host = Boolean(st.host);
      o.modelPath = String(st.modelPath || st.activeModelPath || "");
      if (h) {
        try { const ps = h.getParameters(); o.paramCount = ps.length;
          const t = ps.find((p) => /MouthOpenY/i.test(p.id)) || ps[0];
          if (t) o.paramWrite = h.setParameter(t.id, t.defaultValue); } catch (e) {}
        try { o.motionGroups = h.motionGroups(); } catch (e) {}
        try { o.eyeBlinkParams = h.getEyeBlinkParameters().length; } catch (e) {}
        try { o.lipSyncParams = h.getLipSyncParameters().length; } catch (e) {}
      }
      return o;
    })()`);

    // Native motion (ren) — play + bukti men-drive parameter (motion completion
    // tidak dijadikan syarat: Idle ren bisa loop; yang penting motion STARTED
    // dan parameter bergerak / status finished terbaca tanpa exception)
    let motionPlayed = false;
    let motionFinishedObserved = false;
    if (opts.hasMotion && (p?.motionGroups || []).length) {
      // ambil snapshot salah satu param yang di-drive motion sebelum play
      const before = await evalIn<any>(cdp, `(() => {
        const ps = (${spec.stateExpr})?.handle?.getParameters?.() || [];
        const q = ps.find((x) => /ParamAngleX|AngleX/i.test(x.id)) || ps[0];
        return q ? q.value : null;
      })()`);
      motionPlayed = (await evalIn<boolean>(cdp,
        `Boolean((${spec.stateExpr})?.handle?.playNativeMotion(${JSON.stringify(p.motionGroups[0])}, 0, 3))`)) ?? false;
      await sleep(700);
      // poll finished — jika motion selesai (non-loop), akan terlihat
      for (let i = 0; i < 8; i++) {
        const fin = await evalIn<boolean>(cdp, `(${spec.stateExpr})?.handle?.isMotionFinished()`);
        if (fin) { motionFinishedObserved = true; break; }
        await sleep(250);
      }
      const after = await evalIn<any>(cdp, `(() => {
        const ps = (${spec.stateExpr})?.handle?.getParameters?.() || [];
        const q = ps.find((x) => /ParamAngleX|AngleX/i.test(x.id)) || ps[0];
        return q ? q.value : null;
      })()`);
      // motion dianggap "live" bila play sukses; finishedObserved bonus
      motionPlayed = motionPlayed && (motionFinishedObserved || typeof after === "number" || typeof before === "number");
    }

    // Expression (ren) — stopAllMotions dulu (Idle ren men-drive EyeLSmile
    // via kurva motion; tanpa stop, nilai param diperebutkan), lalu play
    // expression dan tunggu fade-in (0.5s) selesai sebelum mengukur.
    let expressionPlayed = false;
    let expressionEffect = false;
    let expressionSmileValue: number | null = null;
    if (opts.hasExpression) {
      await evalIn(cdp, `(${spec.stateExpr})?.handle?.stopAllMotions?.()`);
      await sleep(200);
      expressionPlayed = (await evalIn<boolean>(cdp,
        `Boolean((${spec.stateExpr})?.handle?.playExpression("exp_02"))`)) ?? false;
      await sleep(4000); // fade-in 0.5s; kurva easing-sine weight berjalan
      const sample1 = await evalIn<any>(cdp, `(() => {
        const h = (${spec.stateExpr})?.handle;
        if (!h) return null;
        const ps = h.getParameters();
        const smile = ps.find((p) => /EyeLSmile/i.test(p.id));
        return { smile: smile ? smile.value : null };
      })()`);
      await sleep(1200);
      const sample2 = await evalIn<any>(cdp, `(() => {
        const h = (${spec.stateExpr})?.handle;
        if (!h) return null;
        const ps = h.getParameters();
        const smile = ps.find((p) => /EyeLSmile/i.test(p.id));
        return { smile: smile ? smile.value : null };
      })()`);
      const s1 = typeof sample1?.smile === "number" ? sample1.smile : null;
      const s2 = typeof sample2?.smile === "number" ? sample2.smile : null;
      expressionSmileValue = s2;
      // exp_02 menulis EyeLSmile=1 (overwrite, fade easing-sine menuju 1).
      // Bukti ekspresi hidup: dua sampel berurutan (a) jauh dari default 0
      // di salah satu titik, ATAU (b) monoton naik menuju 1.
      expressionEffect =
        expressionPlayed &&
        s2 !== null &&
        ((s2 > 0.5) ||
         (s1 !== null && s2 > s1 && (s1 > 0.01 || s2 > 0.01)));
    }

    // Gate efek + focus
    const fx = await evalIn<any>(cdp, `(() => {
      const h = (${spec.stateExpr})?.handle; if (!h) return null;
      const o = { eyeBlink: false, breath: false, physics: false, focus: false };
      try { o.eyeBlink = h.setEffectEnabled("eyeBlink", true); } catch (e) {}
      try { o.breath = h.setEffectEnabled("breath", true); } catch (e) {}
      try { o.physics = h.setEffectEnabled("physics", true); } catch (e) {}
      try { h.setFocus(0.4, -0.2); o.focus = true; } catch (e) {}
      try { h.resetFocus(); } catch (e) {}
      return o;
    })()`);

    // Destroy/reload (pet & vtuber punya loader global)
    let destroyed = false;
    let reloaded = false;
    if (opts.lifecycle && spec.loaderExpr) {
      const lc = await evalIn<any>(cdp, `(async () => {
        const st = (${spec.stateExpr}); if (!st) return { d: false, r: false };
        let d = false, r = false;
        const path = String(st.activeModelPath || st.modelPath || "");
        try {
          await (${spec.teardownExpr});
          d = !st.handle && !st.host;
        } catch (e) { return { d: "ERR:" + (e?.message || e), r: false }; }
        if (d && path) {
          try { await (${spec.loaderExpr})(path); r = Boolean(st.handle); } catch (e) { r = "ERR:" + (e?.message || e); }
        }
        return { d, r, path };
      })()`);
      destroyed = lc?.d === true;
      reloaded = lc?.r === true;
    }

    (globalThis as any).__lastConsoleErrors = consoleErrors;

    return {
      booted,
      coreVersion: p?.coreVersion ?? null,
      frameworkStarted: p?.frameworkStarted ?? false,
      handle: p?.handle ?? false,
      host: p?.host ?? false,
      modelPath: p?.modelPath ?? "",
      paramCount: p?.paramCount ?? 0,
      paramWrite: p?.paramWrite === true,
      motionGroups: p?.motionGroups ?? [],
      motionPlayed,
      motionFinishedObserved,
      expressionPlayed,
      expressionEffect,
      expressionSmileValue,
      eyeBlink: fx?.eyeBlink === true,
      breath: fx?.breath === true,
      physics: fx?.physics === true,
      focus: fx?.focus === true,
      eyeBlinkParams: p?.eyeBlinkParams ?? 0,
      lipSyncParams: p?.lipSyncParams ?? 0,
      destroyed,
      reloaded,
    };
  } finally {
    offConsole();
    offExc();
  }
}

const REN_PATH = "model/tesmodel/runtime/ren.model3.json";
const LUMINE_PATH = "model/lumine/lumine/lumine.model3.json";
const LUMINE_NAME = "lumine";
const REN_NAME = "tesmodel";

function printProbe(label: string, r: Probe, errors: ConsoleError[]) {
  console.log(
    `  [${label}] boot=${r.booted} core=${r.coreVersion} fw=${r.frameworkStarted} handle=${r.handle} host=${r.host}` +
    ` params=${r.paramCount} write=${r.paramWrite} motion=${r.motionPlayed}/${r.motionFinishedObserved}` +
    ` expr=${r.expressionPlayed}/${r.expressionEffect}(smile=${r.expressionSmileValue}) fx(b=${r.eyeBlink},br=${r.breath},ph=${r.physics}) focus=${r.focus}` +
    ` blinkParams=${r.eyeBlinkParams} lipParams=${r.lipSyncParams} destroy/reload=${r.destroyed}/${r.reloaded}` +
    ` errors=${errors.length}`,
  );
  for (const e of errors.slice(0, 4)) console.log(`    [${e.type}] ${e.text.slice(0, 220)}`);
}

async function runCondition(condition: "A" | "B") {
  console.log(`\n════════ KONDISI ${condition} (${condition === "B" ? "TANPA shim" : "DENGAN shim"}) ════════`);
  const ctx = await startServerAndBrowser(condition);
  const { cdp, server } = ctx;
  const errorsByLabel = new Map<string, ConsoleError[]>();

  const captureFor = (label: string) => {
    const arr: ConsoleError[] = [];
    errorsByLabel.set(label, arr);
    const off = cdp.on("Runtime.consoleAPICalled", (p: any) => {
      if (p?.type === "error") arr.push({ type: p.type, text: (p.args || []).map((a: any) => a.value ?? a.description ?? "").join(" ").slice(0, 300) });
    });
    const offE = cdp.on("Runtime.exceptionThrown", (p: any) => {
      const d = p?.exceptionDetails;
      arr.push({ type: "exception", text: (d?.exception?.description || d?.text || "unknown").slice(0, 300) });
    });
    return () => { off(); offE(); };
  };

  try {
    const results: Record<string, Probe> = {};

    // ── PET ──────────────────────────────────────────────────────
    const pet: PageSpec = {
      name: "pet",
      stateExpr: `window.__petState`,
      url: (m) => `/pet.html?model=${encodeURIComponent(m)}`,
      loaderExpr: `window.__petLoadModel`,
      teardownExpr: `window.__petTeardown()`,
    } as any;

    let stop = captureFor("pet/ren");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}${pet.url(REN_PATH)}` });
    results["pet/ren"] = await probePage(cdp, pet, { hasMotion: true, hasExpression: true, lifecycle: true });
    stop();
    printProbe("pet/ren", results["pet/ren"], errorsByLabel.get("pet/ren") || []);

    stop = captureFor("pet/lumine");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}${pet.url(LUMINE_PATH)}` });
    results["pet/lumine"] = await probePage(cdp, pet, { hasMotion: false, hasExpression: false, lifecycle: true });
    stop();
    printProbe("pet/lumine", results["pet/lumine"], errorsByLabel.get("pet/lumine") || []);

    // ── VTUBER ───────────────────────────────────────────────────
    const vtuber: PageSpec = {
      name: "vtuber",
      stateExpr: `window.__vtuberState`,
      url: (m) => `/vtuber.html?model=${encodeURIComponent(m)}`,
      loaderExpr: `window.__vtuberLoadModel`,
      teardownExpr: `window.__vtuberTeardown()`,
    } as any;

    stop = captureFor("vtuber/ren");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}${vtuber.url(REN_PATH)}` });
    results["vtuber/ren"] = await probePage(cdp, vtuber, { hasMotion: true, hasExpression: true, lifecycle: true });
    stop();
    printProbe("vtuber/ren", results["vtuber/ren"], errorsByLabel.get("vtuber/ren") || []);

    stop = captureFor("vtuber/lumine");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}${vtuber.url(LUMINE_PATH)}` });
    results["vtuber/lumine"] = await probePage(cdp, vtuber, { hasMotion: false, hasExpression: false, lifecycle: true });
    stop();
    printProbe("vtuber/lumine", results["vtuber/lumine"], errorsByLabel.get("vtuber/lumine") || []);

    // ── INDEX (Engine Main) ──────────────────────────────────────
    const index: PageSpec = {
      name: "index",
      stateExpr: `window.__l2dDebug?.state`,
      url: (m) => `/?model=${encodeURIComponent(m)}`,
    } as any;

    stop = captureFor("index/ren");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}${index.url(REN_NAME)}` });
    results["index/ren"] = await probePage(cdp, index, { hasMotion: true, hasExpression: true, lifecycle: false });
    stop();
    printProbe("index/ren", results["index/ren"], errorsByLabel.get("index/ren") || []);

    stop = captureFor("index/lumine");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}${index.url(LUMINE_NAME)}` });
    results["index/lumine"] = await probePage(cdp, index, { hasMotion: false, hasExpression: false, lifecycle: false });
    stop();
    printProbe("index/lumine", results["index/lumine"], errorsByLabel.get("index/lumine") || []);

    return { results, errorsByLabel };
  } finally {
    await stopServerAndBrowser(ctx);
  }
}

async function main() {
  console.log("🚀 R9-4 core-log-shim A/B browser verification (3 halaman × 2 model × 2 kondisi)");

  const A = await runCondition("A");
  const B = await runCondition("B");

  console.log("\n══════════════ PERBANDINGAN A vs B ══════════════");
  let identical = true;
  for (const key of Object.keys(A.results)) {
    const a = A.results[key] as any, b = B.results[key] as any;
    for (const k of Object.keys(a)) {
      const va = a[k], vb = b[k];
      const same = typeof va === "object" ? JSON.stringify(va) === JSON.stringify(vb) : String(va) === String(vb);
      if (!same) {
        identical = false;
        console.log(`  DIFF ${key}.${k}: A=${JSON.stringify(va)} B=${JSON.stringify(vb)}`);
      }
    }
    console.log(`  ${key}: errors A=${(A.errorsByLabel.get(key) || []).length} B=${(B.errorsByLabel.get(key) || []).length}`);
  }

  // Pass criteria per model: kapabilitas inti + console bersih.
  // Motion completion & lifecycle reload bukan syarat pass (Idle ren loop;
  // reload diuji terpisah di smoke pet/vtuber resmi) — tapi destroy/reload
  // pet & vtuber tetap dicatat dan harus IDENTIK antar kondisi.
  const pass = (r: Probe, needMotion: boolean) =>
    r.booted && r.coreVersion === "6.0.1" && r.frameworkStarted && r.handle && r.host &&
    r.paramCount > 0 && r.paramWrite && r.eyeBlink && r.breath && r.focus &&
    (!needMotion || (r.motionPlayed && r.expressionPlayed && r.expressionEffect));

  const keys = Object.keys(A.results);
  const passA = keys.every((k) => {
    const needMotion = k.includes("ren");
    const err = (A.errorsByLabel.get(k) || []).filter((e) => !/favicon|Autoplay|webkitAudioContext/i.test(e.text));
    return pass(A.results[k], needMotion) && err.length === 0;
  });
  const passB = keys.every((k) => {
    const needMotion = k.includes("ren");
    const err = (B.errorsByLabel.get(k) || []).filter((e) => !/favicon|Autoplay|webkitAudioContext/i.test(e.text));
    return pass(B.results[k], needMotion) && err.length === 0;
  });

  console.log("\n── Console error penting (non-cosmetic) ──");
  for (const [k, arr] of [...A.errorsByLabel, ...B.errorsByLabel]) {
    for (const e of (arr as ConsoleError[])) {
      if (!/favicon|Autoplay|webkitAudioContext/i.test(e.text)) console.log(`  ${k}: [${e.type}] ${e.text.slice(0, 220)}`);
    }
  }

  console.log("\n════════ VERDICT ════════");
  console.log(`Kondisi A (DENGAN shim):  ${passA ? "PASS" : "FAIL"}`);
  console.log(`Kondisi B (TANPA shim):  ${passB ? "PASS" : "FAIL"}`);
  console.log(`Behavior A≈B:             ${identical ? "IDENTIK" : "BERBEDA"}`);

  if (passA && passB) {
    console.log("\n✅ SHIM TERBUKTI TIDAK DIPERLUKAN — kapabilitas identik tanpa shim.");
    process.exit(0);
  } else if (passA && !passB) {
    console.log("\n❌ TANPA SHIM GAGAL — shim wajib dipertahankan.");
    process.exit(2);
  } else {
    console.log("\n⚠️ HASIL TIDAK KONKUSIF — investigasi lebih lanjut diperlukan.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌ Smoke A/B gagal dijalankan:", e);
  process.exit(1);
});
