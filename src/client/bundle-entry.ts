/**
 * client/bundle-entry.ts — Single entrypoint that bundles the TS client core into
 * static/js/bundle.js and installs it onto `window` for the legacy static/js/app.js
 * (engine/UI) to consume.
 *
 * This makes the TypeScript code the LIVE source-of-truth for:
 *   - the motion DSL        → window.MotionDSL  (namespace of pure functions)
 *   - the motion registry   → window.MotionRegistry  (the CLASS, so .createRegistry() works)
 *   - the motion runtime    → window.MotionRuntime   (the CLASS, so .createRuntime() works)
 *   - the motion taxonomy   → window.MotionTaxonomy  (namespace of pure functions)
 *   - the agent brain       → window.__agent  (installed inside brain.ts)
 *
 * app.js still owns model loading, the render loop, and the UI; it calls
 * MotionRegistry.createRegistry() / MotionRuntime.createRuntime(...) — hence the
 * classes (with their static factory facades) are installed directly, not wrapped
 * in a namespace. No render loop is started here, so there is no conflict.
 */
import * as MotionDSL from "./animation/motion-dsl";
import { MotionRegistry } from "./animation/motion-registry";
import { MotionRuntime } from "./animation/motion-runtime";
import * as MotionTaxonomy from "./engine/motion-taxonomy";
import "./agent/directive-parser";
import "./agent/brain"; // installs window.__agent at module load

if (typeof window !== "undefined") {
  (window as any).MotionDSL = MotionDSL;
  (window as any).MotionRegistry = MotionRegistry;
  (window as any).MotionRuntime = MotionRuntime;
  (window as any).MotionTaxonomy = MotionTaxonomy;
  console.log("🎭 Live2D Agent v2 — TS core installed (MotionDSL/Registry/Runtime/Taxonomy + brain)");
}
