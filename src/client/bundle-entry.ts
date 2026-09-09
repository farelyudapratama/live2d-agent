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
import * as Framing from "./engine/framing";
import * as LipSync from "./speech/lip-sync";
import * as i18n from "./i18n/index";
import "./agent/directive-parser";
import "./agent/brain"; // installs window.__agent at module load
import { startAssistantPanel } from "./agent/panel/panel";
import { startProjekRail } from "./shell/projek";
import { startBrowserPanel } from "./browser/panel";
import { startStageHintFade } from "./shell/stage-hint";

if (typeof window !== "undefined") {
  (window as any).MotionDSL = MotionDSL;
  (window as any).MotionRegistry = MotionRegistry;
  (window as any).MotionRuntime = MotionRuntime;
  (window as any).MotionTaxonomy = MotionTaxonomy;
  (window as any).LipSync = LipSync;
  // Rumus framing panggung (murni) — dipakai legacy frameModel. upper/full
  // hanya fungsi TINGGI stage (anti-gepeng saat splitter didrag).
  (window as any).__framing = Framing;
  // i18n: init() sinkron menyweep atribut data-i18n* di DOM statis SEBELUM
  // app.js dieksekusi (script di akhir body → DOM sudah ter-parse), lalu
  // app.js/motion-editor/mode-runtime memakai window.__i18n.t() saat runtime.
  (window as any).__i18n = i18n;
  // Panel agent (mode Assistant) — dipanggil mode-runtime.js saat tab
  // assistant aktif. Remake tampilan ala ZCode tinggal di sini (TS).
  (window as any).__agentPanel = { start: startAssistantPanel };
  // Rail projek shell (activity bar kiri) — start sekali di boot app.
  (window as any).__shellProjek = { start: startProjekRail };
  (window as any).__browserPanel = { start: startBrowserPanel };
  try { startProjekRail(); } catch {}
  // Hint panggung memudar setelah interaksi pertama (drag/zoom).
  try { startStageHintFade(); } catch {}
  // Mount ada setelah panel Assistant membangun halaman teknis; panel memanggil
  // start ulang saat tab Browser tersedia.
  i18n.init();
  console.log("🎭 Live2D Agent v2 — TS core installed (MotionDSL/Registry/Runtime/Taxonomy/LipSync + brain + i18n)");
}
