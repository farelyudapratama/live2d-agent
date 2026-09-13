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
import type {} from "./window-contract";
import * as MotionDSL from "./animation/motion-dsl";
import { MotionRegistry } from "./animation/motion-registry";
import { MotionRuntime } from "./animation/motion-runtime";
import * as MotionTaxonomy from "./engine/motion-taxonomy";
import * as Framing from "./engine/framing";
import * as RoleMapping from "./engine/role-mapping";
import {
  createEngineParameterLink,
  createRoleParameterBridge,
} from "./engine/role-parameter-bridge";
import type { Live2DModelHandle } from "../live2d/types";
import { createParameterArbiter } from "./engine/parameter-arbiter";
import { collectNativeExpressions } from "./engine/native-expressions";
import * as LipSync from "./speech/lip-sync";
import * as i18n from "./i18n/index";
import "./agent/directive-parser";
import "./agent/brain"; // installs window.__agent at module load
import { startAssistantPanel } from "./agent/panel/panel";
import { startProjekRail } from "./shell/projek";
import { startBrowserPanel } from "./browser/panel";
import { startStageHintFade } from "./shell/stage-hint";
import { installLive2DApi } from "../live2d/index";

if (typeof window !== "undefined") {
  window.MotionDSL = MotionDSL;
  window.MotionRegistry = MotionRegistry;
  window.MotionRuntime = MotionRuntime;
  window.MotionTaxonomy = MotionTaxonomy;
  window.LipSync = LipSync;
  // Role mapping & skala referensi (murni) — sumber kebenaran tunggal;
  // app.js legacy memanggil lewat window.__roleMapping (wrapper tipis).
  window.__roleMapping = RoleMapping;
  // PHASE 10 — jembatan role → Parameter API (Phase 8). app.js memanggil
  // attach(coreModel, getRoleIds) saat model dimuat; pokeRoleRef/pokeRoleNorm
  // mendelegasikan ke bridge. Registry disimpan untuk diagnostik/probe.
  window.__engineRoleLink = {
    links: [],
    attach(
      coreModel: unknown,
      getRoleIds: () => Record<string, string> | null | undefined,
    ) {
      const link = createEngineParameterLink(
        coreModel as Parameters<typeof createEngineParameterLink>[0],
        getRoleIds,
      );
      if (link) {
        this.links.push(link);
        if (this.links.length > 8) this.links.shift();
      }
      return link;
    },
    /**
     * R7-2 — roleLink Phase 10 di atas production Live2DModelHandle.
     * Semantik bridge IDENTIK (createRoleParameterBridge yang sama — satu
     * sumber kebenaran role math); yang berubah hanya target tulis:
     * handle.writeParam (raw, pin:false — bridge yang clamp). Nol akses
     * internalModel/coreModel.
     */
    attachHandle(
      handle: Live2DModelHandle,
      getRoleIds: () => Record<string, string> | null | undefined,
    ) {
      const target = {
        // bridge sudah validasi id (getParameterInfo) sebelum menulis — writeParam
        // raw (pin:false) selalu dieksekusi di sini, jadi true jujur.
        setParameter: (id: string, value: number) => {
          handle.writeParam(id, value);
          return true;
        },
        getParameter: (id: string) => handle.getParameter(id),
        getParameterInfo: (id: string) => handle.getParameterInfo(id),
      };
      const bridge = createRoleParameterBridge(target, getRoleIds);
      const link = {
        api: {
          getParameters: () => handle.getParameters(),
          getParameterInfo: (id: string) => handle.getParameterInfo(id),
          getParameter: (id: string) => handle.getParameter(id),
          setParameter: (id: string, value: number) => handle.setParameter(id, value),
        },
        bridge,
        stats: bridge.stats,
        writeActual: (id: string, value: number) => handle.writeParam(id, value),
      };
      this.links.push(link);
      if (this.links.length > 8) this.links.shift();
      return link;
    },
  };
  window.__nativeExpressions = { collect: collectNativeExpressions };
  // PHASE 13 STAGE 0 — Parameter Arbiter: pabrik arbiter (resolusi intent +
  // single commit point). app.js membuat instance per model load dan
  // memanggil commit() di slot beforeModelUpdate.
  window.__l2dArbiter = { createArbiter: createParameterArbiter };
  // Rumus framing panggung (murni) — dipakai legacy frameModel. upper/full
  // hanya fungsi TINGGI stage (anti-gepeng saat splitter didrag).
  window.__framing = Framing;
  // i18n: init() sinkron menyweep atribut data-i18n* di DOM statis SEBELUM
  // app.js dieksekusi (script di akhir body → DOM sudah ter-parse), lalu
  // app.js/motion-editor/mode-runtime memakai window.__i18n.t() saat runtime.
  window.__i18n = i18n;
  // Panel agent (mode Assistant) — dipanggil mode-runtime.js saat tab
  // assistant aktif. Remake tampilan ala ZCode tinggal di sini (TS).
  window.__agentPanel = { start: startAssistantPanel };
  // Rail projek shell (activity bar kiri) — start sekali di boot app.
  window.__shellProjek = { start: startProjekRail };
  window.__browserPanel = { start: startBrowserPanel };
  // Adapter Live2D (kosong, fail-loud) — seam arsitektur: app.js → API ini →
  // Cubism. Implementasi renderer menyusul di bawah kontrak src/live2d/types.ts;
  // sampai itu app.js masih memanggil pustaka lama langsung.
  window.__live2dApi = installLive2DApi(window);
  try { startProjekRail(); } catch {}
  // Hint panggung memudar setelah interaksi pertama (drag/zoom).
  try { startStageHintFade(); } catch {}
  // Mount ada setelah panel Assistant membangun halaman teknis; panel memanggil
  // start ulang saat tab Browser tersedia.
  i18n.init();
  console.log("🎭 Live2D Agent v2 — TS core installed (MotionDSL/Registry/Runtime/Taxonomy/LipSync + brain + i18n)");
}
