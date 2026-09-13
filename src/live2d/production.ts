/**
 * live2d/production.ts — STAGE R2: Live2DApi produksi (pengganti stub di
 * bawah kontrak yang sama).
 *
 *   Live2DApi (ini) → Live2DHost (production-host) → Live2DModelHandle
 *     (production-handle) → CubismUserModel → Framework 5.3 → Core 6.0.1
 *
 * Aturan R2:
 *  - ENGINE MAIN TIDAK disentuh — adapter ini dipasang oleh bundle terpisah
 *    (production-entry.ts → static/js/live2d-adapter.js) untuk halaman yang
 *    memuatnya; bundle.js tetap memasang stub.
 *  - Fail-loud pada load (Live2DLoadError bertipe), fail-safe pasca-destroy.
 *  - Env default membaca global halaman; test menyuntik env sendiri.
 */

import { Live2DLoadError, type Live2DApi, type Live2DHost, type Live2DModelHandle, type ModelSource } from "./types";
import type { CoreInfo, RendererCapabilities } from "./types";
import { loadProductionModel } from "./production-model";
import { createProductionHandle, type ProductionHandle } from "./production-handle";
import { createProductionHost, type ProductionHost } from "./production-host";
import { createDefaultProductionEnv, type ProductionEnv } from "./production-env";

export const PRODUCTION_VERSION = "1.0.0-cubism53-r2";

/** Lokasi shader renderer resmi 5.3 (disajikan static/js/shaders/WebGL). */
const DEFAULT_SHADER_BASE = "js/shaders/WebGL/";

export interface ProductionAdapterOptions {
  env?: ProductionEnv;
  shaderBase?: string;
  supportedMocVersions?: import("./cubism-core").MocVersion[];
}

export function createProductionAdapter(
  options: ProductionAdapterOptions = {},
): Live2DApi {
  const env = options.env ?? createDefaultProductionEnv();
  const shaderBase = options.shaderBase ?? DEFAULT_SHADER_BASE;
  let activeHost: Live2DHost | null = null;

  const requireCore = () => {
    const core = env.core();
    if (!core) {
      throw new Live2DLoadError("core-missing", "Cubism Core tidak termuat di halaman ini");
    }
    return core;
  };

  return {
    version: () => PRODUCTION_VERSION,
    isStub: false,

    coreInfo(): CoreInfo {
      const core = requireCore();
      const v = core.Version.csmGetVersion();
      const major = v >> 24;
      const minor = (v >> 16) & 0xff;
      const revision = v & 0xffff;
      const latest = core.Version.csmGetLatestMocVersion();
      return {
        version: `${major}.${minor}.${revision}`,
        latestMocVersion: latest,
        // Core era 5.3 mengekspos render order GABUNGAN (csmGetRenderOrders);
        // keberadaannya dibuktikan lewat model saat load — di level core
        // cukup versi ≥ 6 yang jadi fakta.
        hasCombinedRenderOrders: (latest as number) >= 6,
      };
    },

    capabilities(): RendererCapabilities {
      const core = env.core();
      if (!core) {
        return {
          coreReady: false,
          coreVersion: "0",
          latestMocVersion: 0,
          supportsMoc6: false,
          renderOrdersCombined: false,
          blendModes53: false,
          offscreenDrawing: false,
          highDefinitionMasking: false,
          backend: "none",
        };
      }
      const latest = core.Version.csmGetLatestMocVersion() as number;
      return {
        coreReady: true,
        coreVersion: this.coreInfo().version,
        latestMocVersion: latest,
        supportsMoc6: latest >= 6,
        renderOrdersCombined: latest >= 6,
        blendModes53: latest >= 6,
        offscreenDrawing: latest >= 6,
        highDefinitionMasking: latest >= 6,
        backend: activeHost ? "webgl2" : "none",
      };
    },

    createHost(hostOptions): Live2DHost {
      const host = createProductionHost(hostOptions);
      activeHost = host;
      return host;
    },

    async loadModel(host, source): Promise<Live2DModelHandle> {
      const production = await loadProductionModel(source, env, {
        supportedMocVersions: options.supportedMocVersions,
      });
      const handle = createProductionHandle(production, env, {
        supportedMocVersions: options.supportedMocVersions,
      });
      await (host as ProductionHost).bindHandle(handle, shaderBase, env);
      return handle as unknown as Live2DModelHandle;
    },
  };
}

export type { ProductionHandle, ProductionHost };
