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

console.log("✓ Client bundle built → static/js/bundle.js (TS is now the live client source-of-truth)");
