/**
 * live2d/production-host.ts — pemilik context GL + composite untuk adapter
 * produksi.
 *
 * DUA strategi composite (STAGE R3, dipilih via HostOptions.composite):
 *
 *  - "direct" (default, perilaku R2): CubismRenderer_WebGL menggambar langsung
 *    ke context WebGL kanvas halaman.
 *  - "canvas-texture": CubismRenderer_WebGL menggambar ke kanvas GL OFFSCREEN
 *    milik host → compositor v8 (namespace terisolasi static/js/ (loader compositor terpisah), namespace
 *    loader compositor (static/js/)) menampilkan kanvas itu sebagai satu Sprite
 *    penuh kanvas: Texture.from(cubCanvas) → per-frame texture.source.update()
 *    → renderer.render(stage). Pola identik halaman golden (proven).
 *
 * KEPEMILIKAN RESOURCE (owner tunggal + destroy path eksplisit):
 *   | Resource                     | Owner           | Destroy                   |
 *   | kanvas halaman               | halaman         | halaman                   |
 *   | context GL (mode direct)     | host            | host.destroy              |
 *   | kanvas GL offscreen          | host            | host.destroy              |
 *   | CubismRenderer per model     | model (user)    | model.destroy→release     |
 *   | tekstur model di GL          | host (tracking) | binding.releaseGLTextures |
 *   | compositor app/renderer/stage| host            | host.destroy→app.destroy  |
 *   | Texture/Sprite kanvas        | host            | host.destroy              |
 *
 * TICKER: TIDAK ADA loop milik host. Compositor di-init dengan
 * autoStart:false — ticker v8 tidak pernah started; render selalu dipanggil
 * eksplisit oleh pemilik loop (R4+ yang menentukan owner frame loop).
 *
 * CATATAN transform: framing parity penuh = R7; composite hanya memastikan
 * fondasi (ukuran CSS vs piksel perangkat, sprite 1:1 kanvas) tidak membuat
 * R7 mustahil.
 */

import { Live2DLoadError, type LitBounds } from "./types";
import type { ProductionHandle } from "./production-handle";
import type { CompositorAppLike, CompositorLike, ProductionEnv } from "./production-env";
import type { HostOptions, Live2DHost } from "./types";

interface GLTextureLike {
  deleteTexture(t: unknown): void;
}

/** Binding internal handle ↔ host GL (dibuat host, dipakai handle). */
export interface GLHostBinding {
  /** ukuran kanvas GL dalam PIKSEL perangkat (untuk viewport/render target) */
  canvasWidth(): number;
  canvasHeight(): number;
  /** R6 — ukuran CSS logis: ruang koordinat MVP (paritas DPR — MVP tidak
   * boleh memakai piksel perangkat, atau model salah skala pada res≠1) */
  cssWidth(): number;
  cssHeight(): number;
  beforeDraw(): void;
  releaseGLTextures(): void;
}

export interface ProductionHost extends Live2DHost {
  /** Internal adapter: buat renderer Cubism + upload tekstur untuk handle.
   * Dipanggil production.ts dalam loadModel — BUKAN bagian kontrak publik.
   * Di mode composite, init compositor v8 terjadi DI SINI (async, sekali). */
  bindHandle(
    handle: ProductionHandle,
    shaderBase: string,
    env: ProductionEnv,
  ): Promise<void>;
  /** Internal adapter: context GL mentah (mode direct: kanvas halaman;
   * mode composite: kanvas offscreen milik host). */
  gl(): unknown;
  /** Diagnostik R3: mode composite aktif + ukuran piksel/CSS. */
  compositeInfo(): {
    mode: "direct" | "canvas-texture";
    canvasCss: { width: number; height: number };
    canvasPixels: { width: number; height: number };
    cubPixels: { width: number; height: number };
    compositorReady: boolean;
    compositorVersion?: string;
    /** R3-G: null bila mode direct; false = ticker compositor tidak jalan. */
    compositorTickerStarted: boolean | null;
  };
  /** R7-1 GAP-2 — bbox piksel terang frame terakhir (pengganti measureHead
   * legacy; caller: emotion-overlay port). Lihat kontrak Live2DHost. */
  measureLitBounds(): LitBounds | null;
  /** STAGE R4 — instrumen render (exactly-once proof). */
  renderStats(): {
    renders: number;
    cubismDraws: number;
    textureUpdates: number;
    composites: number;
    cubismMs: number;
    compositeMs: number;
  };
}

export function createProductionHost(options: HostOptions): ProductionHost {
  const {
    canvas,
    width,
    height,
    background = 0x000000,
    backgroundAlpha = 0,
    resolution,
    antialias = true,
    composite = "direct",
  } = options;

  const res = resolution ?? Math.min(globalThis.devicePixelRatio || 1, 2);
  let w = width;
  let h = height;

  // ── Context GL Cubism ──
  // direct: kanvas halaman. canvas-texture: kanvas offscreen milik host
  // (pola golden) — kanvas halaman menjadi milik compositor v8.
  const cubCanvas: HTMLCanvasElement =
    composite === "canvas-texture"
      ? document.createElement("canvas")
      : canvas;
  cubCanvas.width = Math.round(w * res);
  cubCanvas.height = Math.round(h * res);

  const gl = cubCanvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias,
    preserveDrawingBuffer: true,
  } as WebGLContextAttributes) as (WebGL2RenderingContext & GLTextureLike) | null;

  if (!gl) {
    throw new Live2DLoadError(
      "unknown",
      "WebGL2 tidak tersedia pada kanvas ini — adapter produksi butuh WebGL2",
    );
  }

  let bgR = 0, bgG = 0, bgB = 0, bgA = backgroundAlpha;
  const parseBg = (bg: number | string) => {
    if (typeof bg === "number") {
      bgR = ((bg >> 16) & 0xff) / 255;
      bgG = ((bg >> 8) & 0xff) / 255;
      bgB = (bg & 0xff) / 255;
    } else if (typeof bg === "string" && bg.startsWith("#")) {
      const v = parseInt(bg.slice(1), 16);
      bgR = ((v >> 16) & 0xff) / 255;
      bgG = ((v >> 8) & 0xff) / 255;
      bgB = (v & 0xff) / 255;
    }
  };
  parseBg(background);

  const children: ProductionHandle[] = [];
  let destroyed = false;

  // ── Composite state (di-init async di bindHandle; render tanpa itu tetap
  // menggambar ke kanvas GL Cubism — aman, tanpa frame parsial di layar) ──
  type CompositeState = {
    app: CompositorAppLike;
    sprite: { width: number; height: number; destroy(): void };
    textureSource: { update?(): void } | null;
  };
  let compositeState: CompositeState | null = null;
  let compositorVersion: string | undefined;
  const renderCounters = {
    renders: 0,
    cubismDraws: 0,
    textureUpdates: 0,
    composites: 0,
    /** R4-I — akumulasi ms: gambar Cubism vs composite v8 */
    cubismMs: 0,
    compositeMs: 0,
  };
  /** R7-1: true setelah host.destroy() — measureLitBounds fail-safe */
  let destroyedFrameEmpty = false;

  const host: ProductionHost = {
    resize(nextW, nextH) {
      if (destroyed) return;
      w = nextW;
      h = nextH;
      cubCanvas.width = Math.round(w * res);
      cubCanvas.height = Math.round(h * res);
      for (const child of children) {
        child.notifyResize(cubCanvas.width, cubCanvas.height);
      }
      if (compositeState) {
        compositeState.app.renderer.resize(w, h);
        compositeState.sprite.width = w;
        compositeState.sprite.height = h;
      }
    },
    screenSize() {
      return { width: w, height: h };
    },
    setBackgroundColor(color, alpha) {
      parseBg(color as number | string);
      if (alpha !== undefined) bgA = alpha;
    },
    add(model, _at) {
      if (destroyed) return;
      const handle = model as ProductionHandle;
      if (!children.includes(handle)) children.push(handle);
    },
    remove(model) {
      const i = children.indexOf(model as ProductionHandle);
      if (i >= 0) children.splice(i, 1);
    },
    render() {
      if (destroyed) return;
      renderCounters.renders++;
      const t0 = performance.now();
      // 1) Cubism: clear + draw semua model ke context GL Cubism
      gl.viewport(0, 0, cubCanvas.width, cubCanvas.height);
      gl.clearColor(bgR, bgG, bgB, bgA);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (const child of children) {
        child.draw();
        renderCounters.cubismDraws++;
      }
      renderCounters.cubismMs += performance.now() - t0;
      // 2) Composite (mode canvas-texture): upload kanvas → render sprite.
      //    TANPA ticker: render eksplisit milik pemanggil.
      if (compositeState) {
        const t1 = performance.now();
        compositeState.textureSource?.update?.();
        renderCounters.textureUpdates++;
        compositeState.app.renderer.render(compositeState.app.stage);
        renderCounters.composites++;
        renderCounters.compositeMs += performance.now() - t1;
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroyedFrameEmpty = true;
      // Handle TIDAK di-destroy host (pemiliknya yang memutuskan) — host
      // hanya melepas binding renderernya.
      for (const child of children) {
        (child.data.user as { deleteRenderer(): void }).deleteRenderer();
      }
      children.length = 0;
      if (compositeState) {
        // destroy path eksplisit: renderer + stage v8 (owner = host ini)
        compositeState.app.destroy(true, true);
        compositeState = null;
      }
    },
    async bindHandle(handle, shaderBase, env) {
      if (destroyed) {
        throw new Live2DLoadError("unknown", "host sudah destroyed");
      }
      // Composite init SEKALI (async di sini — createHost tetap sinkron).
      if (composite === "canvas-texture" && !compositeState) {
        const C = env.compositor?.();
        if (!C) {
          throw new Live2DLoadError(
            "unknown",
            'composite "canvas-texture" membutuhkan compositor v8 terisolasi — muat loader compositor (static/js/)',
          );
        }
        compositorVersion = C.VERSION;
        const app = new C.Application();
        await app.init({
          canvas,
          width: w,
          height: h,
          backgroundAlpha: bgA,
          background,
          antialias,
          resolution: res,
          autoStart: false, // R3-G: TANPA ticker tersembunyi
        });
        const texture = C.Texture.from(cubCanvas);
        const sprite = new C.Sprite(texture);
        sprite.width = w;
        sprite.height = h;
        const stageWithAdd = app.stage as unknown as {
          addChild(child: unknown): void;
        };
        stageWithAdd.addChild(sprite);
        compositeState = {
          app,
          sprite,
          textureSource: texture.source ?? null,
        };
      }

      const user = handle.data.user;
      user.createRenderer(cubCanvas.width, cubCanvas.height);
      const renderer = user.getRenderer();
      if (!renderer) {
        throw new Live2DLoadError("unknown", "CubismRenderer_WebGL gagal dibuat");
      }
      renderer.startUp(gl);
      renderer.loadShaders(shaderBase);

      // Upload tekstur premultiplied (proven golden PATCH 6)
      const textures: unknown[] = [];
      const setting = handle.data.setting;
      try {
        const texCount = setting.getTextureCount();
        for (let i = 0; i < texCount; i++) {
          const url = env.resolveUrl(
            handle.data.manifestUrl,
            setting.getTextureFileName(i).split("\\").join("/"),
          );
          const bitmap = await env.fetchImage(url);
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
            bitmap as TexImageSource,
          );
          renderer.bindTexture(i, tex);
          textures.push(tex);
        }
      } catch (e) {
        for (const t of textures) gl.deleteTexture(t);
        throw new Live2DLoadError(
          "texture-failed",
          "tekstur model gagal dimuat: " + ((e as Error)?.message ?? e),
        );
      }

      handle.bindHost({
        canvasWidth: () => cubCanvas.width,
        canvasHeight: () => cubCanvas.height,
        cssWidth: () => w,
        cssHeight: () => h,
        beforeDraw() {
          gl.enable(gl.BLEND);
        },
        releaseGLTextures() {
          for (const t of textures) gl.deleteTexture(t);
          textures.length = 0;
        },
      });
    },
    gl: () => gl,
    measureLitBounds() {
      if (destroyed || destroyedFrameEmpty) return null;
      const w = cubCanvas.width, h = cubCanvas.height;
      if (!w || !h) return null;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let minX = w, maxX = -1, minY = h, maxY = -1;
      // pita atas (6% tinggi) untuk centroid puncak kepala — parity anchor legacy
      const bandH = Math.max(2, Math.round(h * 0.06));
      let bandSum = 0, bandCount = 0;
      for (let y = 0; y < h; y++) {
        const row = y * w * 4;
        const inBand = y < bandH; // GL bawah-kiri → pita ATAS layar = y besar; koreksi di bawah
        for (let x = 0; x < w; x++) {
          if (px[row + x * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        void inBand;
      }
      if (maxX < 0) return null;
      // GL origin bawah-kiri → layar atas-kiri: pita atas layar = y GL besar
      const topGL = h - 1 - Math.round(h * 0.06);
      for (let y = Math.max(0, topGL); y < h; y++) {
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
          if (px[row + x * 4 + 3] > 8) { bandSum += x; bandCount++; }
        }
      }
      // GL origin bawah-kiri → layar atas-kiri (flip Y untuk caller)
      const top = h - 1 - maxY, bottom = h - 1 - minY;
      return {
        minX, maxX, minY: top, maxY: bottom,
        width: maxX - minX, height: bottom - top,
        topCentroidX: bandCount ? bandSum / bandCount : (minX + maxX) / 2,
      };
    },
    renderStats: () => ({ ...renderCounters }),
    compositeInfo() {
      return {
        mode: composite,
        canvasCss: { width: w, height: h },
        canvasPixels: { width: canvas.width, height: canvas.height },
        cubPixels: { width: cubCanvas.width, height: cubCanvas.height },
        compositorReady: !!compositeState,
        compositorVersion,
        // R3-G: bukti tanpa ticker tersembunyi
        compositorTickerStarted: compositeState?.app.ticker?.started ?? null,
      };
    },
  };

  return host;
}
