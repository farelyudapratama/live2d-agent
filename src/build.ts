/**
 * build.ts — Bundle the TypeScript client into static/js/bundle.js.
 *
 * The bundle is the SINGLE SOURCE OF TRUTH for the motion DSL / registry / runtime
 * (window.MotionDSL / MotionRegistry / MotionRuntime) and the agent brain
 * (window.__agent, installed inside brain.ts). It installs itself onto `window` as
 * side effects and starts no render loop — static/js/app.js owns the engine, model
 * loading, render loop and UI, and consumes those globals. This makes the rewrite's
 * TS logic actually execute in the browser instead of being dead code.
 */
import { Glob } from "bun";

const result = await Bun.build({
  entrypoints: ["./src/client/bundle-entry.ts"],
  outdir: "./static/js",
  naming: "bundle.[ext]",
  target: "browser",
  format: "iife",
  splitting: false,
  minify: false,
  sourcemap: "inline",
});

if (!result.success) {
  console.error("Build failed:");
  for (const msg of result.logs) {
    console.error(msg);
  }
  process.exit(1);
}

// Entry kedua: core i18n saja (kamus + t()) untuk static/pet.html yang tidak
// memuat bundle.js penuh. index.html tidak memuat file ini.
const i18n = await Bun.build({
  entrypoints: ["./src/client/i18n-entry.ts"],
  outdir: "./static/js",
  naming: "i18n.[ext]",
  target: "browser",
  format: "iife",
  splitting: false,
  minify: false,
  sourcemap: "inline",
});

if (!i18n.success) {
  console.error("i18n build failed:");
  for (const msg of i18n.logs) {
    console.error(msg);
  }
  process.exit(1);
}

// Entry ketiga: RENDERER RESMI Cubism (CubismWebFramework dari Live2D) untuk
// halaman golden pixi8-official.html. Sumber semantik Cubism 5.3 yang sah —
// offscreen drawing, blend 15+5, HD masking, physics. Folder vendor
// sengaja di-exclude dari tsc (butuh d.ts Core dari SDK).
const framework = await Bun.build({
  entrypoints: ["./src/live2d/cubismframework-entry.ts"],
  outdir: "./static/js",
  naming: "cubism-framework.[ext]",
  target: "browser",
  format: "iife",
  splitting: false,
  minify: false,
  sourcemap: "inline",
});

if (!framework.success) {
  console.error("cubism-framework build failed:");
  for (const msg of framework.logs) {
    console.error(msg);
  }
  process.exit(1);
}

// Entry keempat: PARAMETER API (Phase 8) untuk halaman golden pixi8-official.html.
// Murni (tanpa pustaka renderer/core) — hanya ekspos ParameterApi +
// createCubismModelBacking ke global window.Live2DParameterApi. Dipakai harness
// untuk bukti visual setParameter → model bergerak.
const paramApi = await Bun.build({
  entrypoints: ["./src/live2d/param-api-entry.ts"],
  outdir: "./static/js",
  naming: "live2d-param-api.[ext]",
  target: "browser",
  format: "iife",
  splitting: false,
  minify: false,
  sourcemap: "inline",
});

if (!paramApi.success) {
  console.error("parameter-api build failed:");
  for (const msg of paramApi.logs) {
    console.error(msg);
  }
  process.exit(1);
}

// Entry kelima: MODEL INSPECTOR (Phase 9) untuk halaman golden pixi8-official.html.
// Murni (type-only import ke Phase 8) — ekspos buildModelProfile +
// createCubismInspectorBacking + formatProfileSummary ke window.Live2DModelProfile.
const modelProfile = await Bun.build({
  entrypoints: ["./src/live2d/profile-entry.ts"],
  outdir: "./static/js",
  naming: "live2d-model-profile.[ext]",
  target: "browser",
  format: "iife",
  splitting: false,
  minify: false,
  sourcemap: "inline",
});

if (!modelProfile.success) {
  console.error("model-profile build failed:");
  for (const msg of modelProfile.logs) {
    console.error(msg);
  }
  process.exit(1);
}

// Entry keenam: ROLE BRIDGE (Phase 10) untuk halaman golden pixi8-official.html —
// modul yang sama dengan yang dipakai engine utama via bundle.js
// (window.__engineRoleLink); sandbox memuatnya sebagai window.Live2DRoleBridge.
const roleBridge = await Bun.build({
  entrypoints: ["./src/client/engine/role-bridge-entry.ts"],
  outdir: "./static/js",
  naming: "live2d-role-bridge.[ext]",
  target: "browser",
  format: "iife",
  splitting: false,
  minify: false,
  sourcemap: "inline",
});

if (!roleBridge.success) {
  console.error("role-bridge build failed:");
  for (const msg of roleBridge.logs) {
    console.error(msg);
  }
  process.exit(1);
}

// Entry ketujuh: ADAPTER PRODUKSI (Stage R2) untuk halaman smoke/golden yang
// memuat Core + cubism-framework.js. ENGINE MAIN TIDAK memuat bundle ini —
// bundle.js tetap memasang stub, jadi perilaku engine existing tidak berubah.
const production = await Bun.build({
  entrypoints: ["./src/live2d/production-entry.ts"],
  outdir: "./static/js",
  naming: "live2d-adapter.[ext]",
  target: "browser",
  format: "iife",
  splitting: false,
  minify: false,
  sourcemap: "inline",
});

if (!production.success) {
  console.error("live2d-adapter build failed:");
  for (const msg of production.logs) {
    console.error(msg);
  }
  process.exit(1);
}

console.log("✓ Client bundle built → static/js/bundle.js + static/js/i18n.js + static/js/cubism-framework.js + static/js/live2d-param-api.js + static/js/live2d-model-profile.js + static/js/live2d-role-bridge.js + static/js/live2d-adapter.js (TS is now the live client source-of-truth)");
