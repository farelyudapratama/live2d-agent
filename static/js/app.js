(function () {
  "use strict";

  (function patchCubismCore() {
    const core = window.Live2DCubismCore;
    if (!core || !core.Moc || !core.Moc.fromArrayBuffer) return;
    const orig = core.Moc.fromArrayBuffer.bind(core.Moc);
    core.Moc.fromArrayBuffer = function (buf) {
      const ab = buf instanceof ArrayBuffer ? buf : (buf && buf.buffer) || buf;
      const direct = orig(ab);
      if (direct) return direct;
      try {
        const u8 = new Uint8Array(ab);
        if (u8.length > 8) {
          const v = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
          if (v > 4) {
            u8[4] = 4;
            u8[5] = 0;
            u8[6] = 0;
            u8[7] = 0;
            return orig(ab);
          }
        }
      } catch (e) {
        /* fall through to null result */
      }
      return direct;
    };
  })();

  // server.js honours process.env.PORT, so a hardcoded :8310 silently breaks every
  // fetch the moment the server runs on any other port. The page is always served
  // BY that same server, so location.origin is correct by construction.
  // The literal survives only as a file:// fallback (opening index.html directly).
  const API = (typeof location !== 'undefined' && /^https?:$/.test(location.protocol))
    ? location.origin
    : 'http://127.0.0.1:8310';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const state = {
    model: null,
    blinkEnabled: true,
    idleEnabled: true,
    blinkInterval: null,
    idleRAF: null,
    aiLock: false,
    frozen: false,
    frozenTimer: null,
    accessoryValues: {},

    overrides: {},

    visfxMap: null,

    cdiInfo: null,

    rawDrive: null,

    rawDrivePrev: null,
    isDragging: false,
    dragTarget: null,
    dragOffset: { x: 0, y: 0 },
    basePos: { x: 0, y: 0 },
    scale: 1,
    talking: false,
    mouthRest: 0,
    mouthTimer: null,

    look: {
      ax: 0,
      ay: 0,
      ex: 0,
      ey: 0,
      tax: 0,
      tay: 0,
      tex: 0,
      tey: 0,
      bx: 0,
      by: 0,
      tbx: 0,
      tby: 0,
    },

    aiPose: {
      ax: 0,
      ay: 0,
      ex: 0,
      ey: 0,
      mouthForm: 0,
      bodyX: 0,
      bodyY: 0,
      bodyZ: 0,
      breath: 0.45,
    },

    fidgetT: 0,
    fidgetSeed: Math.random() * 1000,

    lookFrame: { eyeX: 0, eyeY: 0, w: 1, h: 1 },
    idleMotionTimer: null,
    activeEmotion: "normal",
    activeProperty: "default",
    supportedEmotions: {},

    caps: {
      hasHead: true,
      hasEyes: true,
      hasMouth: true,
      hasBody: false,
      hasBrow: false,
      hasHair: false,
      params: null,
      ids: {},
      motionGroups: [],
    },
    paramRange: {},

    lastSheet: null,

    lastFileSheet: null,

    gesture: { timer: null, nextAt: 0, seed: Math.random() * 1000 },

    motionTaxonomy: null,

    clipUntil: 0,
    clipName: null,
    clipStartedAt: 0,

    emoTarget: {},
    emoCur: {},

    roleEmotions: {},

    impulse: 0,
    energyBoost: 0,

    natW: 0,
    natH: 0,

    fullBody: false,
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  let refreshConfigForm = () => {};

  let refreshSheetUI = () => {};

  function coreModel() {
    return state.model && state.model.internalModel
      ? state.model.internalModel.coreModel
      : null;
  }

  function pokeParam(id, value, weight) {
    const cm = coreModel();
    if (!cm) return;
    try {
      cm.setParameterValueById(id, value, weight === undefined ? 1 : weight);
    } catch (e) {}
  }

  function setSticky(id, value, weight) {
    state.overrides[id] =
      (weight === undefined ? 1 : weight) === 1
        ? value
        : { value, weight: weight === undefined ? 1 : weight };
    pokeParam(id, value, weight);
  }

  function applyOverrides() {
    const cm = coreModel();
    if (!cm) return;
    for (const id in state.overrides) {
      const o = state.overrides[id];
      try {
        if (typeof o === "object")
          cm.setParameterValueById(id, o.value, o.weight);
        else cm.setParameterValueById(id, o, 1);
      } catch (e) {}
    }
  }

  function installOverrideGuard(im) {
    if (!im || typeof im.on !== "function" || im.__overrideGuard) return;
    im.__overrideGuard = true;
    im.on("beforeModelUpdate", () => {
      const cm = coreModel();
      if (!cm) return;
      for (const id in state.overrides) {
        const o = state.overrides[id];
        try {
          if (typeof o === "object")
            cm.setParameterValueById(id, o.value, o.weight);
          else cm.setParameterValueById(id, o, 1);
        } catch (e) {}
      }
      const d = state.rawDrive;
      if (!d) return;
      for (const id in d) {
        let v = d[id];
        if (!Number.isFinite(v)) continue;
        const r = state.paramRange && state.paramRange[id];
        if (r) v = Math.max(r.min, Math.min(r.max, v));
        try {
          cm.setParameterValueById(id, v, 1);
        } catch (e) {}
      }
    });
  }

  function visfxStoreKey(modelKey) {
    return "l2d_visfx_v2_" + (modelKey || "default");
  }
  function visfxLoad() {
    try {
      return JSON.parse(
        localStorage.getItem(visfxStoreKey(currentModelKey())) || "null",
      );
    } catch (e) {
      return null;
    }
  }

  function enumerateParts() {
    const cm = coreModel();
    const out = [];
    try {
      const gm = cm && cm.getModel ? cm.getModel() : cm;
      if (!gm || typeof gm.getPartCount !== "function") return out;
      const n = gm.getPartCount();
      for (let i = 0; i < n; i++) {
        let id = "";
        try {
          id = typeof gm.getPartIds === "function" ? gm.getPartIds()[i] : "";
        } catch (e) {}
        if (!id) continue;
        let def = 1;
        try {
          def = gm.getPartOpacityByIndex ? gm.getPartOpacityByIndex(i) : 1;
        } catch (e) {}
        out.push({
          id,
          min: 0,
          max: 1,
          def,
          group: "Bagian (Parts)",
          label: id,
        });
      }
    } catch (e) {
      console.warn("[inspect] part enumeration failed:", e.message);
    }
    return out;
  }

  function readParam(id) {
    const cm = coreModel();
    if (!cm) return 0;
    try {
      return cm.getParameterValueById(id);
    } catch (e) {
      return 0;
    }
  }

  function stageSize() {
    const el = document.getElementById("stage");
    const w = el ? el.clientWidth : 0;
    const h = el ? el.clientHeight : 0;
    return {
      w: w > 0 ? w : Math.max(280, window.innerWidth - 380),
      h: h > 0 ? h : window.innerHeight,
    };
  }
  const _sz = stageSize();
  const app = new PIXI.Application({
    view: $("#live2d-canvas"),
    width: _sz.w,
    height: _sz.h,
    backgroundColor: 0x0a0a14,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    antialias: true,
  });

  function fitCanvas() {
    const sz = stageSize();
    app.renderer.resize(sz.w, sz.h);
    const canvas = $("#live2d-canvas");
    canvas.style.width = sz.w + "px";
    canvas.style.height = sz.h + "px";
  }
  fitCanvas();
  window.addEventListener("resize", () => {
    fitCanvas();

    try {
      fitStageBgImage(state.modelConfig && state.modelConfig.bgDim);
    } catch (e) {}
    if (state.model) {
      // Panel kontrol kini drawer kanan — panggung tidak pernah dipotong,
      // framing selalu pakai lebar penuh stage.
      state.stageArea = { width: app.screen.width };
      frameModel(state.fullBody ? "full" : "upper");
    }
  });

  async function resolveAnyModelPath() {
    try {
      const r = await fetch(API + "/api/models");
      if (!r.ok) return null;
      const d = await r.json();
      const first = (d.models && d.models[0]) || null;
      if (!first) return null;
      const rp = await fetch(
        API + "/api/model/path?name=" + encodeURIComponent(first),
      );
      if (!rp.ok) return null;
      const dp = await rp.json();
      return dp.path || null;
    } catch (e) {
      console.warn("[model] auto-detect failed:", e.message);
      return null;
    }
  }

  function filterAdoptable(onDisk, disabled) {
    const isOff = (n) => {
      if (disabled && typeof disabled.has === "function")
        return disabled.has(n);
      if (Array.isArray(disabled)) return disabled.indexOf(n) !== -1;
      return false;
    };
    return (Array.isArray(onDisk) ? onDisk : []).filter(
      (e) => e && !e.declared && e.File && e.Name && !isOff(e.Name),
    );
  }

  async function buildModelSettings(modelPath) {
    try {
      const parts = String(modelPath || "").split("/");

      if (parts.length < 3 || parts[0] !== "model") return null;
      const folder = parts[1];
      if (!folder) return null;

      const [mRes, eRes] = await Promise.all([
        fetch(
          API + "/" + modelPath.split("/").map(encodeURIComponent).join("/"),
        ),
        fetch(
          API + "/api/model/expressions?name=" + encodeURIComponent(folder),
        ),
      ]);
      if (!mRes.ok || !eRes.ok) return null;

      const settings = await mRes.json();
      const info = await eRes.json();
      if (!settings || !settings.FileReferences) return null;

      let disabled = new Set();
      try {
        const aRes = await fetch(
          API +
            "/api/model/expressions-adoption?name=" +
            encodeURIComponent(folder),
        );
        if (aRes.ok) {
          const aInfo = await aRes.json();
          if (Array.isArray(aInfo.disabled)) disabled = new Set(aInfo.disabled);
        }
      } catch (e) {
        /* adopt all on error */
      }

      const onDisk = Array.isArray(info.expressions) ? info.expressions : [];
      const orphans = filterAdoptable(onDisk, disabled);
      if (!orphans.length) return null;

      const declared = Array.isArray(settings.FileReferences.Expressions)
        ? settings.FileReferences.Expressions.slice()
        : [];

      const takenNames = new Set(
        declared.map((e) => e && e.Name).filter(Boolean),
      );
      const takenFiles = new Set(
        declared.map((e) => e && e.File).filter(Boolean),
      );

      let added = 0;
      for (const o of orphans) {
        if (takenNames.has(o.Name) || takenFiles.has(o.File)) continue;
        declared.push({ Name: o.Name, File: o.File });
        takenNames.add(o.Name);
        takenFiles.add(o.File);
        added++;
      }
      if (!added) return null;

      settings.FileReferences.Expressions = declared;

      settings.url = new URL(
        modelPath.split("/").map(encodeURIComponent).join("/"),
        location.href,
      ).href;
      console.log(
        "[exp3] adopted",
        added,
        "undeclared expression file(s) for",
        folder,
        "→ total",
        declared.length,
      );
      return settings;
    } catch (e) {
      console.warn("[exp3] adoption skipped:", e.message);
      return null;
    }
  }

  async function loadModel(modelPath) {
    try {
      if (typeof modelPath !== "string" || !modelPath) {
        modelPath = await resolveAnyModelPath();
        if (!modelPath)
          throw new Error(
            "Belum ada model terpasang. Upload model lewat tab 📁 Model.",
          );
      }
      state.modelPath = modelPath;
      hideNoModelState();

      state.motionTaxonomy = null;
      state.clipUntil = 0;
      state.clipName = null;
      state.clipStartedAt = 0;

      state._zoomTarget = null;
      state._zoomCursor = null;

      if (state.model) {
        try {
          app.stage.removeChild(state.model);
          state.model.destroy();
        } catch (e) {}
        state.model = null;

        state.overrides = {};

        state.rawDrive = null;
        state.rawDrivePrev = null;
        state.accessoryValues = {};
        state.activeEmotion = "normal";
        state.activeProperty = "default";
        if (state.idleMotionTimer) {
          clearInterval(state.idleMotionTimer);
          state.idleMotionTimer = null;
        }
        state.lookFrame = { eyeX: 0, eyeY: 0, w: 1, h: 1 };

        state.caps = {};
        state.modelParams = null;

        state.cdiInfo = null;

        state.roleEmotions = {};
        state.supportedEmotions = {};
        state.emoTarget = {};
        state.emoCur = {};
        state.paramRange = {};

        state.lastSheet = null;
        state.lastFileSheet = null;
      }

      try {
        window.__agent &&
          window.__agent.invalidateCapabilityProfile &&
          window.__agent.invalidateCapabilityProfile();
      } catch (e) {}

      const settings = await buildModelSettings(modelPath);
      state.model = await PIXI.live2d.Live2DModel.from(settings || modelPath, {
        autoInteract: false,
      });

      app.stage.addChild(state.model);
      app.stage.sortableChildren = true;
      state.model.zIndex = 0;
      state.model.anchor.set(0, 0);

      state.stageArea = { width: app.screen.width };

      applyModelConfig(loadModelConfigLocal());
      // Panel terbuka saat model selesai dimuat → framing lama memakai
      // stageArea sempit. Hitung ulang dengan lebar penuh.
      applyCharacterIdentity();

      console.log("[Live2D] Model loaded:", state.model);
      rememberModel(modelPath);

      fetchSheetFile().catch(() => {});

      startBlink();
      startIdle();
      installOverrideGuard(state.model.internalModel);
      state.visfxMap = visfxLoad();
      wireInteractions();
      detectModelCapabilities();
      prefetchOverlayGate();
      prefetchCdiInfo();
      startIdleMotion();

      loadMotionTaxonomy()
        .then(() => initMotionRegistry())
        .catch((e) => {
          console.warn("[taxonomy] load error", e);
          initMotionRegistry();
        });

      refreshUserNoteUI().catch((e) =>
        console.warn("[note] UI refresh failed:", e),
      );

      try {
        refreshConfigForm();
      } catch (e) {
        console.warn("[config] UI refresh failed:", e.message);
      }

      try {
        refreshSheetUI();
      } catch (e) {
        console.warn("[sheet] UI refresh failed:", e.message);
      }
    } catch (err) {
      console.error("[Live2D] Failed to load model:", err);
      const p = $("#loader p");
      if (p) p.textContent = "❌ Gagal memuat model: " + err.message;

      if (String((err && err.message) || "").includes("Belum ada model"))
        showNoModelState();
    }
  }

  function showNoModelState() {
    const loader = $("#loader");
    if (loader) loader.classList.add("done", "fade-out", "hidden");
    const empty = $("#stage-empty");
    if (empty) empty.classList.remove("hidden");
    const st = $("#sb-state");
    if (st) st.textContent = "Tanpa model";
    console.warn("[model] belum ada model terpasang — empty state ditampilkan");
  }
  function hideNoModelState() {
    const empty = $("#stage-empty");
    if (empty) empty.classList.add("hidden");
  }

  function rememberModel(modelPath) {
    try {
      const seg = String(modelPath).split("/");
      if (seg[0] === "model" && seg[1])
        localStorage.setItem("live2d_last_model", seg[1]);
    } catch (e) {
      /* abaikan */
    }
  }

  function startBlink() {
    if (state.blinkInterval) clearInterval(state.blinkInterval);
    const blinkOnce = () => {
      if (!state.model || !state.blinkEnabled) return;

      if (state.frozen) return;
      try {
        pokeRoleNorm("eyeLOpen", 0);
        pokeRoleNorm("eyeROpen", 0);
        setTimeout(() => {
          pokeRoleNorm("eyeLOpen", 1);
          pokeRoleNorm("eyeROpen", 1);
        }, 140);
      } catch (e) {
        /* swallow */
      }
    };
    state.blinkInterval = setInterval(() => {
      if (Math.random() < 0.15) blinkOnce();
    }, 3000);
  }

  function startIdle() {
    if (state.idleRAF) cancelAnimationFrame(state.idleRAF);
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const m = state.model;
      if (!m) {
        state.idleRAF = requestAnimationFrame(tick);
        return;
      }

      state.impulse *= 0.9;
      if (state.impulse < 0.001) state.impulse = 0;
      state.energyBoost *= 0.96;
      if (state.energyBoost < 0.001) state.energyBoost = 0;

      const t = now / 1000;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const owned = (id) => !state.caps.params || state.caps.params.has(id);
      const liveliness = Math.min(
        2.4,
        (state.talking ? 1 : 0.4) + state.energyBoost,
      );

      const headXLife = (state.talking ? 14 : 8) + state.impulse * 12;
      const headYLife = state.talking ? 8 : 5;
      const A1 =
        Math.sin(t * 0.7) * headXLife + Math.sin(t * 1.9) * headXLife * 0.3;
      const A2 =
        Math.sin(t * 0.5 + 1.0) * headYLife +
        Math.sin(t * 2.3) * headYLife * 0.25;
      const E1 = Math.sin(t * 0.35) * 0.35 + Math.sin(t * 1.3 + 0.5) * 0.2;
      const E2 =
        Math.sin(t * 0.45 + 2.0) * 0.22 +
        (state.talking ? Math.sin(t * 3.1) * 0.2 : 0);
      const breath = Math.sin(t * 1.1) * 0.5 + 0.5;
      const tiltLife =
        Math.sin(t * 0.4 + 0.7) * (state.talking ? 7 : 4) + state.impulse * 8;
      const bodyLeanLife = Math.sin(t * 0.6) * 4 + Math.sin(t * 1.4) * 1.5;
      const talkHead = state.talking ? Math.sin(t * 9.0) * 5 : 0;

      let bAx, bAy, bEx, bEy, bMf, bBx, bBy, bBz;
      if (!state.aiLock) {
        const L = state.look,
          k = 0.28;
        L.ax += (L.tax - L.ax) * k;
        L.ay += (L.tay - L.ay) * k;
        L.ex += (L.tex - L.ex) * k;
        L.ey += (L.tey - L.ey) * k;
        L.bx += (L.tbx - L.bx) * k;
        L.by += (L.tby - L.by) * k;
        bAx = L.ax + A1 * 0.5;
        bAy = L.ay + A2 * 0.5;
        bEx = L.ex + E1;
        bEy = L.ey + E2;
        bMf = 0;
        bBx = L.bx + bodyLeanLife * 0.4;
        bBy = L.by;
        bBz = tiltLife * 0.4;
      } else {
        const frozen = !!state.frozen;
        const P = state.aiPose;
        state.fidgetT += dt;
        const ft = state.fidgetT + state.fidgetSeed;
        const amp = frozen ? 0 : 1 + liveliness * 1.6;
        const fx = frozen
          ? 0
          : (Math.sin(ft * 0.6) * 9 + Math.sin(ft * 1.7) * 3) * amp;
        const fy = frozen
          ? 0
          : (Math.sin(ft * 0.45 + 1.3) * 7 + Math.sin(ft * 2.1) * 2.5) * amp;
        bAx = P.ax + fx + (frozen ? 0 : talkHead);
        bAy = P.ay + fy;
        bEx = P.ex + fx * 0.05 + (frozen ? 0 : E1);
        bEy = P.ey + fy * 0.05 + (frozen ? 0 : E2);
        bMf = P.mouthForm;
        bBx =
          P.bodyX +
          (frozen
            ? 0
            : (Math.sin(ft * 0.5) * 5 + Math.sin(ft * 1.1) * 1.5) * amp);
        bBy = P.bodyY;
        bBz =
          P.bodyZ +
          (frozen ? 0 : Math.sin(ft * 0.33 + 0.7) * 5 * amp + tiltLife);
      }

      const mGain = MOTION && MOTION.enabled ? MOTION.gain || 1 : 1;
      bAx *= mGain;
      bAy *= mGain;
      bEx *= mGain;
      bEy *= mGain;
      bMf *= mGain;
      bBx *= mGain;
      bBy *= mGain;
      bBz *= mGain;

      const CLIP_IN_MS = 200,
        CLIP_OUT_MS = 350;
      let poseAuthority = 1;
      if (state.clipUntil) {
        const nowMs = performance.now();
        const remain = state.clipUntil - nowMs;
        if (remain > 0) {
          const elapsed = nowMs - (state.clipStartedAt || nowMs);
          poseAuthority = Math.max(0, 1 - elapsed / CLIP_IN_MS);
        } else if (-remain < CLIP_OUT_MS) {
          poseAuthority = Math.min(1, -remain / CLIP_OUT_MS);
        } else {
          state.clipUntil = 0;
          state.clipName = null;
        }
      }

      const ease = state.talking ? 0.25 : 0.16;
      const target = (role, vRef) => {
        const id = roleId(role);
        if (!id || !owned(id)) return;
        if (poseAuthority <= 0.001) return;

        const actual = roleClampActual(role, toActual(role, vRef));
        const cur = readParam(id);
        pokeParam(id, cur + (actual - cur) * ease * poseAuthority, 1);
      };
      if (state.caps.hasHead) {
        target("angleX", bAx);
        target("angleY", bAy);
      }
      if (state.caps.hasEyes) {
        target("eyeBallX", clamp(bEx, -1, 1));
        target("eyeBallY", clamp(bEy, -1, 1));
      }
      if (roleId("mouthForm")) target("mouthForm", clamp(bMf, -1, 1));

      if (state.caps.hasBody) {
        target("bodyAngleX", bBx);
        target("bodyAngleY", bBy);
        target("bodyAngleZ", bBz);
      } else if (roleId("angleZ")) {
        target("angleZ", tiltLife + (state.aiLock ? bBz * 0.5 : 0));
      }

      if (state.hasBreath && !state.frozen)
        pokeRoleNorm("breath", clamp(breath, 0, 1));

      if (state.emoCur) {
        const e = 0.12;
        const eyeLO = roleId("eyeLOpen"),
          eyeRO = roleId("eyeROpen");
        for (const id in state.emoTarget) {
          if (id === eyeLO || id === eyeRO) continue;
          const tgt = state.emoTarget[id];
          const cur =
            state.emoCur[id] === undefined ? readParam(id) : state.emoCur[id];
          const nv = cur + (tgt - cur) * e;
          state.emoCur[id] = nv;
          if (owned(id)) pokeParam(id, nv, 1);
        }
      }

      if (state.talking && !state.frozen) {
        const mId = roleId("mouthOpenY");
        if (mId) {
          let openness;
          const lip = state.audioLipSync;
          if (lip && lip.active) {
            openness = lip.sample();
          } else {
            const base = 0.35 + 0.4 * Math.abs(Math.sin(t * 9));
            const jitter = Math.random() < 0.25 ? 0.25 : 0;
            openness = Math.min(1, base + jitter);
          }

          const r = roleRange("mouthOpenY");
          state.overrides[mId] = r
            ? r.min + openness * (r.max - r.min)
            : openness;
        }
      }
      applyOverrides();
      applyRawDrive();
      state._tickCount = (state._tickCount || 0) + 1;
      state.idleRAF = requestAnimationFrame(tick);
    };
    state.idleRAF = requestAnimationFrame(tick);
  }

  function startIdleMotion() {
    if (state.idleMotionTimer) clearInterval(state.idleMotionTimer);
    const m = state.model;
    if (!m) return;
    const im = m.internalModel && m.internalModel.motionManager;
    if (!im) return;
    const groups =
      (im.definitions && Object.keys(im.definitions)) ||
      (m.motions && Object.keys(m.motions)) ||
      [];
    if (!groups.length) return;
    const playRandom = () => {
      if (!state.model || !state.idleEnabled) return;

      if (state.aiLock) return;
      if (clipIsPlaying()) return;

      if (playEmotionClip(state.activeEmotion || "normal")) return;

      try {
        const g = groups[Math.floor(Math.random() * groups.length)];

        state.model.motion(g, -1, 1);
      } catch (e) {
        /* ignore */
      }
    };
    playRandom();
    state.idleMotionTimer = setInterval(playRandom, 7000);
  }

  function wireInteractions() {
    const canvas = $("#live2d-canvas");

    if (canvas.__l2dWired) return;
    canvas.__l2dWired = true;

    canvas.addEventListener("mousemove", (e) => {
      if (state.isDragging || !state.model || state.aiLock) return;
      const m = state.model;

      const eyeLocalX = state.lookFrame.eyeX || m.width / m.scale.x / 2;
      const eyeLocalY = state.lookFrame.eyeY || (m.height / m.scale.y) * 0.22;
      const eye = m.toGlobal(new PIXI.Point(eyeLocalX, eyeLocalY));
      const W = app.screen.width,
        H = app.screen.height;

      const MARGIN = 0.15;
      const refX = clamp(eye.x, W * MARGIN, W * (1 - MARGIN));
      const refY = clamp(eye.y, H * MARGIN, H * (1 - MARGIN));

      const upRoom = Math.max(1, refY);
      const downRoom = Math.max(1, H - refY);
      const leftRoom = Math.max(1, refX);
      const rightRoom = Math.max(1, W - refX);

      const rawY = e.clientY - refY;
      const rawX = e.clientX - refX;

      const ny = clamp(-rawY / (rawY < 0 ? upRoom : downRoom), -1, 1);
      const nx = clamp(rawX / (rawX < 0 ? leftRoom : rightRoom), -1, 1);

      state.look.tax = nx * REF_HALF;
      state.look.tay = ny * REF_HALF;
      state.look.tex = nx;
      state.look.tey = ny;

      state.look.tbx = nx * REF_HALF * 0.25;
      state.look.tby = ny * REF_HALF * 0.25;
    });

    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    function applyZoomAround(cursor) {
      const m = state.model;
      if (!m) return;
      const cur = m.scale.x;
      const zoomTarget = state._zoomTarget;
      if (!Number.isFinite(zoomTarget)) return;
      const next = cur + (zoomTarget - cur) * 0.25;
      if (Math.abs(zoomTarget - next) < Math.max(0.001, zoomTarget * 0.001)) {
        setScaleAroundPoint(zoomTarget, cursor);
        state._zoomTarget = null;
        return;
      }
      setScaleAroundPoint(next, cursor);
    }
    function setScaleAroundPoint(newScale, cursor) {
      const m = state.model;
      if (!m) return;
      const clamped = Math.max(0.05, Math.min(8, newScale));
      const curW = m.width,
        curH = m.height;

      const wx = cursor ? cursor.x : m.x + curW / 2;
      const wy = cursor ? cursor.y : m.y + curH / 2;
      let local =
        cursor && m.toLocal
          ? m.toLocal(new PIXI.Point(cursor.x, cursor.y))
          : null;

      if (
        local &&
        (!Number.isFinite(local.x) ||
          !Number.isFinite(local.y) ||
          Math.abs(local.x) > 1e7 ||
          Math.abs(local.y) > 1e7)
      )
        local = null;
      m.scale.set(clamped);
      if (local) {
        m.x = wx - local.x * clamped;
        m.y = wy - local.y * clamped;
      } else {
        const curW = m.texture ? m.texture.width * clamped : m.width;
        const curH = m.texture ? m.texture.height * clamped : m.height;
        m.x = wx - curW / 2;
        m.y = wy - curH / 2;
      }

      if (
        !Number.isFinite(m.x) ||
        !Number.isFinite(m.y) ||
        Math.abs(m.x) > 1e6 ||
        Math.abs(m.y) > 1e6
      ) {
        frameModel("reset");
        return;
      }
      state.scale = clamped;
      state.basePos.x = m.x;
      state.basePos.y = m.y;
      if ($("#sl-scale")) {
        $("#sl-scale").value = clamped.toFixed(2);
        $("#val-scale").textContent = clamped.toFixed(2);
      }
    }

    let zoomRafId = null;
    let zoomWatchdogId = null;

    const ZOOM_BUCKET_MAX = 0.25;
    const ZOOM_REFILL_PER_MS = 0.0009;
    let zoomBucket = ZOOM_BUCKET_MAX;
    let zoomLastAt = 0;
    function zoomTick() {
      zoomRafId = null;
      if (zoomWatchdogId != null) {
        clearTimeout(zoomWatchdogId);
        zoomWatchdogId = null;
      }
      if (state._zoomTarget == null || !state.model) return;
      applyZoomAround(state._zoomCursor || null);
      scheduleZoomTick();
    }
    function scheduleZoomTick() {
      if (zoomRafId == null) zoomRafId = requestAnimationFrame(zoomTick);
      if (zoomWatchdogId == null) {
        zoomWatchdogId = setTimeout(() => {
          zoomWatchdogId = null;
          zoomTick();
        }, 250);
      }
    }
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (!state.model) return;

        const dy =
          e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1);
        const cur = state.model.scale.x;

        const now = performance.now();
        if (zoomLastAt)
          zoomBucket = Math.min(
            ZOOM_BUCKET_MAX,
            zoomBucket + (now - zoomLastAt) * ZOOM_REFILL_PER_MS,
          );
        zoomLastAt = now;
        const factor = Math.pow(1.0012, -dy);
        const allow = Math.min(Math.abs(Math.log(factor)), zoomBucket);
        zoomBucket -= allow;
        const step = factor > 1 ? Math.exp(allow) : Math.exp(-allow);
        let target =
          (state._zoomTarget != null ? state._zoomTarget : cur) * step;
        state._zoomTarget = Math.max(0.05, Math.min(8, target));
        scheduleZoomTick();
        const rect = canvas.getBoundingClientRect();
        state._zoomCursor = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        };
        if (state._showFullBtn) state._showFullBtn();
      },
      { passive: false },
    );

    canvas.addEventListener("dblclick", () => {
      if (!state.model) return;
      state.model.rotation = 0;
      state.look.tax = state.look.tay = state.look.tex = state.look.tey = 0;
      state.look.bx = state.look.by = state.look.tbx = state.look.tby = 0;
      state.look.ax = state.look.ay = state.look.ex = state.look.ey = 0;
      frameModel("reset");
    });
  }

  function onPointerDown(e) {
    if (!state.model) return;
    state.isDragging = true;
    state.dragTarget = state.model;
    state.dragOffset.x = e.clientX - state.model.x;
    state.dragOffset.y = e.clientY - state.model.y;
    $("#live2d-canvas").style.cursor = "grabbing";
    if (state._showFullBtn) state._showFullBtn();
  }

  function onPointerMove(e) {
    if (!state.isDragging || !state.dragTarget || !state.model) return;
    state.model.x = e.clientX - state.dragOffset.x;
    state.model.y = e.clientY - state.dragOffset.y;

    state.basePos.x = state.model.x;
    state.basePos.y = state.model.y;
  }

  function onPointerUp() {
    state.isDragging = false;
    state.dragTarget = null;
    $("#live2d-canvas").style.cursor = "grab";
  }

  function setScaleAroundCenter(newScale) {
    const m = state.model;
    if (!m) return;
    const clamped = Math.max(0.05, Math.min(8, newScale));
    const cx = m.x + (m.width * m.scale.x) / 2,
      cy = m.y + (m.height * m.scale.y) / 2;
    m.scale.set(clamped);
    const nw = m.width * clamped,
      nh = m.height * clamped;
    m.x = cx - nw / 2;
    m.y = cy - nh / 2;
    state.scale = clamped;
    state.basePos.x = m.x;
    state.basePos.y = m.y;
    if ($("#sl-scale")) {
      $("#sl-scale").value = clamped.toFixed(2);
      $("#val-scale").textContent = clamped.toFixed(2);
    }
  }

  function frameModel(mode) {
    if (!state.model) return;
    const m = state.model;
    const W = app.screen.width,
      H = app.screen.height;
    // Panel kontrol kini drawer kanan — panggung selalu lebar penuh.
    const stageW = W;

    const validSize = (w, h) =>
      Number.isFinite(w) && Number.isFinite(h) && w > 1 && h > 1;
    let b = m.getBounds();
    let natW = b.width / m.scale.x,
      natH = b.height / m.scale.y;
    if (!validSize(natW, natH)) {
      natW = state.natW;
      natH = state.natH;
      if (!validSize(natW, natH)) return;
    }

    let scale;
    if (mode === "full") {
      scale = (H * 0.82) / natH;
    } else if (mode === "upper") {
      scale = Math.min(stageW / natW, H / natH) * 1.05;
    } else {
      scale = Math.min(stageW / natW, H / natH) * 0.9;
    }
    if (!Number.isFinite(scale) || scale <= 0) return;
    m.scale.set(scale);

    state.natW = natW;
    state.natH = natH;

    b = m.getBounds();
    const bw = validSize(b.width, b.height) ? b.width : natW * scale;
    const bh = validSize(b.width, b.height) ? b.height : natH * scale;
    const ax = stageW / 2;
    m.x = ax - bw / 2;
    m.y = (H - bh) / 2;
    state.basePos.x = m.x;
    state.basePos.y = m.y;
    state.scale = scale;
    if ($("#sl-scale")) {
      $("#sl-scale").value = scale.toFixed(2);
      $("#val-scale").textContent = scale.toFixed(2);
    }
  }

  const ROLE_KEYWORDS = {
    angleX: [
      "ParamAngleX",
      "AngleX",
      "angle_x",
      "yaw",
      "turnx",
      "rotx",
      "頭",
      "头",
      "横向",
      "左右",
      "朝向x",
      "方向x",
    ],
    angleY: [
      "ParamAngleY",
      "AngleY",
      "angle_y",
      "pitch",
      "turny",
      "roty",
      "縦",
      "纵向",
      "上下",
      "朝向y",
      "方向y",
    ],
    angleZ: [
      "ParamAngleZ",
      "AngleZ",
      "angle_z",
      "roll",
      "tilt",
      "傾",
      "倾",
      "回転z",
      "旋转z",
      "歪",
    ],
    eyeBallX: [
      "ParamEyeBallX",
      "EyeBallX",
      "eyeball_x",
      "lookx",
      "瞳X",
      "瞳",
      "眼球",
      "目玉",
      "视x",
    ],
    eyeBallY: [
      "ParamEyeBallY",
      "EyeBallY",
      "eyeball_y",
      "looky",
      "瞳Y",
      "瞳",
      "眼球",
      "目玉",
      "视y",
    ],
    eyeLOpen: ["ParamEyeLOpen", "EyeLOpen", "eye_l_open", "左目", "左眼"],
    eyeROpen: ["ParamEyeROpen", "EyeROpen", "eye_r_open", "右目", "右眼"],
    eyeLSmile: [
      "ParamEyeLSmile",
      "EyeLSmile",
      "eye_l_smile",
      "左目笑",
      "左眼笑",
    ],
    eyeRSmile: [
      "ParamEyeRSmile",
      "EyeRSmile",
      "eye_r_smile",
      "右目笑",
      "右眼笑",
    ],
    eyeForm: ["ParamEyeForm", "EyeForm", "eye_form", "目形", "眼形"],
    mouthOpenY: [
      "ParamMouthOpenY",
      "MouthOpenY",
      "mouth_open",
      "口開",
      "张口",
      "张嘴",
    ],
    mouthForm: [
      "ParamMouthForm",
      "MouthForm",
      "mouth_form",
      "口角",
      "口形",
      "嘴形",
      "口型",
    ],
    mouthOpenX: ["ParamMouthOpenX", "MouthOpenX", "mouth_wide", "口幅", "嘴宽"],
    bodyAngleX: [
      "ParamBodyAngleX",
      "BodyAngleX",
      "body_angle_x",
      "bodyx",
      "体",
      "胴",
      "躯",
    ],
    bodyAngleY: [
      "ParamBodyAngleY",
      "BodyAngleY",
      "body_angle_y",
      "bodyy",
      "体",
      "胴",
      "躯",
    ],
    bodyAngleZ: [
      "ParamBodyAngleZ",
      "BodyAngleZ",
      "body_angle_z",
      "bodyz",
      "体",
      "胴",
      "躯",
    ],
    breath: ["ParamBreath", "Breath", "breath", "呼吸", "breathe", "息"],
    browLForm: ["ParamBrowLForm", "BrowLForm", "brow_l", "左眉", "眉"],
    browRForm: ["ParamBrowRForm", "BrowRForm", "brow_r", "右眉", "眉"],
    browLY: ["ParamBrowLY", "BrowLY", "brow_l_y", "左眉Y", "左眉上下"],
    browRY: ["ParamBrowRY", "BrowRY", "brow_r_y", "右眉Y", "右眉上下"],
    browLAngle: ["ParamBrowLAngle", "BrowLAngle", "brow_l_angle", "左眉角"],
    browRAngle: ["ParamBrowRAngle", "BrowRAngle", "brow_r_angle", "右眉角"],

    blush: [
      "ParamBlush",
      "Blush",
      "blush",
      "ParamCheekRed",
      "CheekRed",
      "頬紅",
      "ほお染め",
      "照れ",
      "脸红",
      "腮红",
      "害羞",
    ],
  };

  function getOfficialGroups(m) {
    const out = { eyeBlinkIds: [], lipSyncIds: [] };
    if (!m || !m.internalModel) return out;
    const im = m.internalModel;
    try {
      if (Array.isArray(im.eyeBlinkIds) && im.eyeBlinkIds.length)
        out.eyeBlinkIds = im.eyeBlinkIds.slice();
      else if (
        im.settings &&
        typeof im.settings.getEyeBlinkParameters === "function"
      ) {
        out.eyeBlinkIds = im.settings.getEyeBlinkParameters() || [];
      }
    } catch (e) {}
    try {
      if (Array.isArray(im.lipSyncIds) && im.lipSyncIds.length)
        out.lipSyncIds = im.lipSyncIds.slice();
      else if (
        im.settings &&
        typeof im.settings.getLipSyncParameters === "function"
      ) {
        out.lipSyncIds = im.settings.getLipSyncParameters() || [];
      }
    } catch (e) {}
    return out;
  }

  function pickFromGroup(list, patterns) {
    if (!Array.isArray(list) || !list.length) return null;
    for (const re of patterns) {
      const hit = list.find((id) => typeof id === "string" && re.test(id));
      if (hit) return hit;
    }
    return null;
  }

  const GROUP_PATTERNS = {
    mouthOpenY: [
      /openy$/i,
      /mouthopen/i,
      /open/i,
      /口開|開口|口を開/,
      /张口|张嘴|开口/,
    ],
    eyeLOpen: [
      /eyelopen/i,
      /^parameyel.*open/i,
      /_l_?open/i,
      /left.*open/i,
      /左目|左眼/,
    ],
    eyeROpen: [
      /eyeropen/i,
      /^parameyer.*open/i,
      /_r_?open/i,
      /right.*open/i,
      /右目|右眼/,
    ],
  };

  function mapRoles(paramSet, official) {
    const ids = {};
    if (!paramSet || !paramSet.size) return ids;
    const list = Array.from(paramSet).map((id) => id.toLowerCase());
    const lowerToReal = {};
    Array.from(paramSet).forEach((id, i) => {
      lowerToReal[list[i]] = id;
    });
    for (const role in ROLE_KEYWORDS) {
      if (official && GROUP_PATTERNS[role]) {
        const pool =
          role === "mouthOpenY" ? official.lipSyncIds : official.eyeBlinkIds;

        const owned = (pool || []).filter((id) => paramSet.has(id));
        const picked = pickFromGroup(owned, GROUP_PATTERNS[role]);
        if (picked) {
          ids[role] = picked;
          continue;
        }

        if (owned.length === 1) {
          ids[role] = owned[0];
          continue;
        }
      }

      const canonical = "Param" + role.charAt(0).toUpperCase() + role.slice(1);
      if (paramSet.has(canonical)) {
        ids[role] = canonical;
        continue;
      }

      let foundLower = null;
      for (const kw of ROLE_KEYWORDS[role]) {
        const lk = kw.toLowerCase();
        const hit = list.find((x) => x.includes(lk));
        if (hit) {
          foundLower = hit;
          break;
        }
      }
      if (foundLower) ids[role] = lowerToReal[foundLower];
    }

    if (ids.mouthOpenY && ids.mouthOpenY === ids.mouthForm) {
      const alt = Array.from(paramSet).find(
        (id) =>
          /open/i.test(id) && /mouth|口|嘴/i.test(id) && id !== ids.mouthForm,
      );
      if (alt) ids.mouthOpenY = alt;
      else delete ids.mouthOpenY;
      console.warn(
        "[roles] mouthOpenY aliased onto mouthForm; resolved to",
        ids.mouthOpenY || "(none)",
      );
    }
    return ids;
  }

  const roleId = (role) =>
    (state.caps && state.caps.ids && state.caps.ids[role]) || null;

  const REF_HALF = 30;

  const DEGREE_ROLES = new Set([
    "angleX",
    "angleY",
    "angleZ",
    "bodyAngleX",
    "bodyAngleY",
    "bodyAngleZ",
  ]);
  const refHalfFor = (role) => (DEGREE_ROLES.has(role) ? REF_HALF : 1);
  function roleRange(role) {
    const id = roleId(role);
    if (!id || !state.paramRange || !state.paramRange[id]) return null;
    return state.paramRange[id];
  }

  function toActual(role, vRef) {
    const RH = refHalfFor(role);
    const r = roleRange(role);
    if (!r) return clamp(vRef, -RH, RH);
    const mid = (r.max + r.min) / 2,
      half = (r.max - r.min) / 2;
    return mid + (vRef / RH) * (half || RH);
  }

  function roleClampActual(role, v) {
    const r = roleRange(role);
    if (!r) return clamp(v, -42, 42);
    return clamp(v, r.min, r.max);
  }

  function pokeRoleNorm(role, t) {
    const id = roleId(role);
    if (!id) return false;
    const r = roleRange(role);
    const v = r ? r.min + clamp(t, 0, 1) * (r.max - r.min) : clamp(t, 0, 1);
    pokeParam(id, v, 1);
    return true;
  }
  function pokeRoleRef(role, vRef) {
    const id = roleId(role);
    if (!id) return false;
    pokeParam(id, roleClampActual(role, toActual(role, vRef)), 1);
    return true;
  }

  function roleDefault(role) {
    const r = roleRange(role);
    if (r && typeof r.def === "number") return r.def;
    return 0;
  }

  const NORM_TEMPLATE_ROLES = new Set(["mouthOpenY", "mouthOpenX", "breath"]);
  const EMOTION_ROLE_TEMPLATES = {
    senang: {
      mouthForm: 0.9,
      eyeLSmile: 0.8,
      eyeRSmile: 0.8,
      browLForm: 0.4,
      browRForm: 0.4,
      mouthOpenY: 0.35,
      angleZ: 4,
    },
    tersenyum: { mouthForm: 0.6, eyeLSmile: 0.5, eyeRSmile: 0.5, angleZ: 3 },
    sedih: {
      mouthForm: -0.8,
      browLForm: -0.7,
      browRForm: -0.7,
      browLY: -0.5,
      browRY: -0.5,
      eyeBallY: -0.4,
      angleY: -6,
    },
    malu: {
      mouthForm: 0.3,
      eyeLSmile: 0.4,
      eyeRSmile: 0.4,
      eyeBallX: -0.5,
      browLY: -0.2,
      browRY: -0.2,
      angleZ: 6,
    },
    kaget: {
      mouthOpenY: 0.8,
      browLY: 0.7,
      browRY: 0.7,
      browLForm: 0.3,
      browRForm: 0.3,
      eyeBallY: 0.2,
      angleY: 5,
    },
    kesal: {
      mouthForm: -0.6,
      browLForm: -0.9,
      browRForm: -0.9,
      browLAngle: -0.6,
      browRAngle: -0.6,
      eyeBallX: 0.3,
      angleZ: -3,
    },
    bingung: {
      angleZ: 9,
      browLY: 0.4,
      browRY: -0.3,
      browLForm: 0.2,
      mouthForm: -0.2,
      eyeBallX: 0.5,
    },
  };

  const EMOTION_MIN_ROLES = 2;

  function emotionActualFor(role, v) {
    const r = roleRange(role);
    if (NORM_TEMPLATE_ROLES.has(role)) {
      const t = clamp(v, 0, 1);
      return r ? r.min + t * (r.max - r.min) : t;
    }
    const RH = refHalfFor(role);
    return r ? roleClampActual(role, toActual(role, v)) : clamp(v, -RH, RH);
  }

  function buildRoleEmotions() {
    const out = {};
    if (!state.caps || !state.caps.ids) return out;
    for (const emo in EMOTION_ROLE_TEMPLATES) {
      const tpl = EMOTION_ROLE_TEMPLATES[emo];
      const vals = {};
      let resolved = 0;
      for (const role in tpl) {
        const id = roleId(role);
        if (!id) continue;
        if (state.caps.params && !state.caps.params.has(id)) continue;

        if (vals[id] !== undefined) continue;
        vals[id] = emotionActualFor(role, tpl[role]);
        resolved++;
      }
      if (resolved < EMOTION_MIN_ROLES) continue;
      out[emo] = vals;
    }
    return out;
  }

  function refreshRoleEmotions() {
    state.roleEmotions = buildRoleEmotions();
    state.supportedEmotions = Object.assign({}, state.roleEmotions);
    console.log(
      "[emotion] role-derived vocabulary:",
      Object.keys(state.roleEmotions).join(", ") ||
        "(none — model lacks facial roles)",
    );
    return state.roleEmotions;
  }

  function setEmotionTargets(preset, intensity) {
    if (!state.model) return;

    const k =
      intensity === undefined || intensity === null
        ? 1
        : clamp(Number(intensity) || 0, 0, 1.5);
    const has = (id) => !state.caps.params || state.caps.params.has(id);
    const defOf = (id) => {
      const r = state.paramRange && state.paramRange[id];
      return r && typeof r.def === "number" ? r.def : 0;
    };
    const next = {};
    for (const id in preset || {}) {
      if (!id || !has(id)) continue;
      let v = Number(preset[id]);
      if (!Number.isFinite(v)) continue;
      const d = defOf(id);
      v = d + (v - d) * k;
      const r = state.paramRange && state.paramRange[id];
      if (r && typeof r.min === "number" && typeof r.max === "number")
        v = clamp(v, r.min, r.max);
      next[id] = v;
    }

    for (const id in state.emoTarget) {
      if (next[id] !== undefined) continue;
      next[id] = defOf(id);
    }
    for (const id in next) {
      if (state.emoCur[id] === undefined) state.emoCur[id] = readParam(id);
    }
    state.emoTarget = next;
  }

  function resetEmotion() {
    const mgr =
      state.model &&
      state.model.internalModel &&
      state.model.internalModel.motionManager &&
      state.model.internalModel.motionManager.expressionManager;
    if (mgr && typeof mgr.resetExpression === "function") mgr.resetExpression();
    setEmotionTargets({});

    try {
      window.__emotionOverlay && window.__emotionOverlay.clear();
    } catch (e) {}
  }

  function detectModelCapabilities() {
    const m = state.model;
    if (!m) return;
    const cm = coreModel();
    console.log("[cap] coreModel?", !!cm, "internalModel?", !!m.internalModel);
    if (m.internalModel)
      console.log(
        "[cap] internalModel keys:",
        Object.keys(m.internalModel).join(","),
      );

    let paramIds = [];

    try {
      if (typeof m.getParameterIds === "function")
        paramIds = m.getParameterIds() || [];
    } catch (e) {}

    if (!paramIds.length && cm) {
      try {
        const gm = cm.getModel && cm.getModel();
        const ids = gm && gm.parameters && gm.parameters.ids;
        if (ids && ids.length) paramIds = Array.prototype.slice.call(ids);
      } catch (e) {}
    }

    if (!paramIds.length && cm) {
      try {
        const gm = cm.getModel && cm.getModel();
        if (gm && typeof gm.getParameterIds === "function")
          paramIds = gm.getParameterIds() || [];
      } catch (e) {}
    }

    if (!paramIds.length && cm) {
      try {
        const gm = cm.getModel && cm.getModel();
        const src = gm || cm;
        if (
          typeof src.getParameterCount === "function" &&
          typeof src.getParameterId === "function"
        ) {
          const n = src.getParameterCount();
          for (let i = 0; i < n; i++) {
            const id = src.getParameterId(i);
            if (id) paramIds.push(id);
          }
        }
      } catch (e) {}
    }

    if (
      !paramIds.length &&
      m.internalModel &&
      Array.isArray(m.internalModel.parameters)
    ) {
      try {
        paramIds = m.internalModel.parameters.map((p) => p.id).filter(Boolean);
      } catch (e) {}
    }

    if (!paramIds.length && cm) {
      try {
        const gm = cm.getModel && cm.getModel();

        if (gm && Array.isArray(gm._parameterIds) && gm._parameterIds.length) {
          paramIds = gm._parameterIds.slice();
        } else if (
          gm &&
          gm._model &&
          gm._model.parameters &&
          Array.isArray(gm._model.parameters.ids)
        ) {
          paramIds = gm._model.parameters.ids.slice();
        }
      } catch (e) {}
    }

    if (!paramIds.length && cm) {
      try {
        const gm = cm.getModel && cm.getModel();
        if (gm) {
          for (const key of ["_parameterIds", "parameterIds"]) {
            if (Array.isArray(gm[key]) && gm[key].length) {
              paramIds = gm[key].slice();
              break;
            }
          }

          if (!paramIds.length) {
            for (const key of ["_parameterIds", "parameterIds"]) {
              if (Array.isArray(cm[key]) && cm[key].length) {
                paramIds = cm[key].slice();
                break;
              }
            }
          }
        }
      } catch (e) {}
    }

    console.log(
      "[cap] paramIds found:",
      paramIds.length,
      "→",
      JSON.stringify(paramIds).slice(0, 400),
    );
    state.modelParams = new Set(paramIds);

    state.caps.ids = mapRoles(state.modelParams, getOfficialGroups(m));
    const R = state.caps.ids;
    state.caps.hasHead = !!(R.angleX || R.angleY);
    state.caps.hasEyes = !!(
      R.eyeBallX ||
      R.eyeBallY ||
      R.eyeLOpen ||
      R.eyeROpen
    );
    state.caps.hasMouth = !!(R.mouthOpenY || R.mouthForm);
    state.caps.hasBody = !!(R.bodyAngleX || R.bodyAngleY || R.bodyAngleZ);
    state.caps.hasBrow = !!(R.browLForm || R.browRForm);
    state.hasBreath = !!R.breath;
    console.log("[cap] role ids:", JSON.stringify(R));

    try {
      const cm = coreModel();
      const gm = cm && cm.getModel ? cm.getModel() : cm;
      if (gm && typeof gm.getParameterCount === "function") {
        const n = gm.getParameterCount();
        for (let i = 0; i < n; i++) {
          const pid = gm.getParameterId(i);
          if (!pid) continue;
          let lo, hi, def;
          try {
            lo = gm.getParameterMinimumValue(i);
            hi = gm.getParameterMaximumValue(i);
            def = gm.getParameterDefaultValue(i);
          } catch (e) {
            continue;
          }
          if (typeof lo !== "number" || typeof hi !== "number") continue;
          state.paramRange[pid] = {
            min: lo,
            max: hi,
            def: typeof def === "number" ? def : (lo + hi) / 2,
          };
        }
        console.log(
          "[cap] paramRange populated:",
          Object.keys(state.paramRange).length,
        );
      }
    } catch (e) {
      console.warn("[cap] paramRange read failed", e.message);
    }

    let exprs = [];
    try {
      if (Array.isArray(m.expressions)) exprs = m.expressions.slice();
      else if (m.expressions && typeof m.expressions === "object")
        exprs = Object.keys(m.expressions);
    } catch (e) {}

    try {
      const em =
        m.internalModel &&
        m.internalModel.motionManager &&
        m.internalModel.motionManager.expressionManager;
      if (em && Array.isArray(em.deferred))
        exprs = exprs.concat(
          em.deferred.map((x) => x && x.name).filter(Boolean),
        );
    } catch (e) {}

    try {
      const st = m.internalModel && m.internalModel.settings;
      if (st && st.expressions && st.expressions.length > 0) {
        state.modelExpressions = st.expressions.map((e) => e.Name);
      }
    } catch (e) {}
    state.modelExpressions = Array.from(new Set(exprs.filter(Boolean)));

    state.emotionMode = state.modelExpressions.length ? "native" : "synthetic";

    refreshRoleEmotions();

    console.log(
      "[Live2D] capabilities:",
      JSON.stringify({
        mode: state.emotionMode,
        paramCount: state.modelParams.size,
        sampleParams: Array.from(state.modelParams).slice(0, 60),
        nativeExpr: state.modelExpressions,
        universalEmotions: Object.keys(state.roleEmotions || {}),
      }),
    );
  }

  let overlayGateExprs = null;
  let overlayGateModelPath = null;

  function overlayGateExpBindings() {
    if (overlayGateModelPath !== (state.modelPath || '')) {
      overlayGateExprs = undefined;
      overlayGateModelPath = state.modelPath || "";
    }
    if (overlayGateExprs !== undefined)
      return Promise.resolve(overlayGateExprs);
    const folder = String(state.modelPath || "").split("/")[1];
    if (!folder) {
      overlayGateExprs = null;
      return Promise.resolve(null);
    }
    return fetch(
      API + "/api/model/expressions?name=" + encodeURIComponent(folder),
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        const map = {};
        const list =
          info && Array.isArray(info.expressions) ? info.expressions : [];
        for (const e of list) {
          if (!e || !e.Name) continue;
          map[e.Name] = Array.isArray(e.params) ? e.params.filter(Boolean) : [];
        }
        overlayGateExprs = map;
        return map;
      })
      .catch(() => {
        overlayGateExprs = null;
        return null;
      });
  }

  function overlayGateSuppress(name, bindings, visfx, resolveFx) {
    if (typeof resolveFx !== "function" || !resolveFx(name)) return false;
    if (!visfx) return false;
    const bare = String(name || "").replace(/^user:/, "");
    const ids =
      bindings && Object.prototype.hasOwnProperty.call(bindings, name)
        ? bindings[name]
        : bindings && Object.prototype.hasOwnProperty.call(bindings, bare)
          ? bindings[bare]
          : null;
    if (!Array.isArray(ids) || !ids.length) return false;
    for (const id of ids) {
      const m = visfx[id];
      if (!m || typeof m.changed !== "number") continue;
      if (m.changed > 0) return true;
    }
    return false;
  }

  function overlayGateExpBindingsSync() {
    return overlayGateExprs === undefined ? null : overlayGateExprs;
  }

  function overlayShouldSuppress(name) {
    const ov = window.__emotionOverlay;
    return overlayGateSuppress(
      name,
      overlayGateExpBindingsSync(),
      state.visfxMap,
      ov && ov._resolve ? (n) => ov._resolve(n) : null,
    );
  }
  function prefetchOverlayGate() {
    overlayGateExpBindings().catch(() => {});
  }

  function cdiGroupTitle(gid) {
    if (!(state.cdiInfo && state.cdiInfo.groups.has(gid))) return gid;
    const members = state.cdiInfo.groups.get(gid) || [];
    const named = members
      .map((id) => {
        const info = state.cdiInfo.byId.get(id);
        return info && info.label;
      })
      .filter(Boolean);
    return named.length
      ? 'Rig: ' + named[0] + (named.length > 1 ? ' +' + (named.length - 1) : '')
      : gid;
  }

  function prefetchCdiInfo() {
    const modelPath = String(state.modelPath || "");
    const dir = modelPath.split("/").slice(0, -1).join("/");
    if (!dir) return;

    fetch(API + "/" + modelPath)
      .then((r) => (r.ok ? r.json() : null))
      .then((m3) => {
        const cdiRel = m3 && m3.FileReferences && m3.FileReferences.DisplayInfo;
        if (!cdiRel) return null;
        return fetch(API + "/" + dir + "/" + cdiRel).then((r) =>
          r.ok ? r.json() : null,
        );
      })
      .then((cdi) => {
        if (!cdi || !Array.isArray(cdi.Parameters)) return;
        const byId = new Map();
        const groups = new Map();
        for (const p of cdi.Parameters) {
          if (!p || !p.Id) continue;
          byId.set(p.Id, {
            label: String(p.Name || "").trim(),
            group: String(p.GroupId || "").trim(),
          });
          if (p.GroupId) {
            if (!groups.has(p.GroupId)) groups.set(p.GroupId, []);
            groups.get(p.GroupId).push(p.Id);
          }
        }
        state.cdiInfo = { byId, groups };

        const sheet = state.lastSheet;
        if (sheet && Array.isArray(sheet.params)) {
          let changed = false;
          for (const p of sheet.params) {
            const info = byId.get(p && p.id);
            if (!info) continue;
            if (info.label && p.label !== info.label) { p.label = info.label; changed = true; }
            if (info.group && p.group !== cdiGroupTitle(info.group)) {
              p.group = cdiGroupTitle(info.group);
              changed = true;
            }
          }
          if (changed) {
            if (window.__pnRefreshIfOpen) window.__pnRefreshIfOpen();
          }
        }
      })
      .catch(() => {});
  }

  function fireOverlay(name) {
    try {
      if (overlayShouldSuppress(name)) {
        console.log("[overlay] suppressed (efek native hidup):", name);
        return;
      }
      window.__emotionOverlay && window.__emotionOverlay.onExpression(name);
    } catch (e) {}
  }

  async function applyExpression(name, intensity) {
    if (!state.model) return;

    if (name === "normal" || name === "default") {
      state.activeEmotion = "normal";
      state.activeProperty = "default";
      resetEmotion();
      $$(".expr-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.expr === "normal"),
      );
      console.log("[Live2D] Expression reset -> normal");
      return;
    }

    if (!state.supportedEmotions.hasOwnProperty(name)) {
      const propPreset =
        findPreset(name, "properti") || findPreset(name, "aksesoris");
      if (propPreset) {
        if (state.activeProperty === name && intensity === undefined) {
          state.activeProperty = "default";
          resetEmotion();
          $$(".expr-btn").forEach((b) =>
            b.classList.toggle("active", b.dataset.expr === "normal"),
          );
          console.log("[Live2D] Property preset toggled off ->", name);
          return;
        }
        const ok = applyPreset(propPreset, propPreset.category);
        if (ok) {
          state.activeProperty = name;
          $$(".expr-btn").forEach((b) =>
            b.classList.toggle("active", b.dataset.expr === name),
          );
          console.log(
            "[Live2D] Property preset ->",
            name,
            "(" + propPreset.source + ")",
          );
          return;
        }

        console.warn(
          "[Live2D] Property preset had no valid target for this model:",
          name,
        );
      }
    }

    if (state.emotionMode === "native") {
      if (state.supportedEmotions.hasOwnProperty(name)) {
        if (state.activeEmotion === name && intensity === undefined) {
          state.activeEmotion = "normal";
          state.activeProperty = "default";
          resetEmotion();
          $$(".expr-btn").forEach((b) =>
            b.classList.toggle("active", b.dataset.expr === "normal"),
          );
          return;
        }
        state.activeEmotion = name;
        state.activeProperty = "default";
        const preset = state.supportedEmotions[name];
        setEmotionTargets(preset, intensity);

        playEmotionClip(name);
        fireOverlay(name);
        $$(".expr-btn").forEach((b) =>
          b.classList.toggle("active", b.dataset.expr === name),
        );
        console.log(
          "[Live2D] Universal emotion (native) ->",
          name,
          "intensity:",
          intensity,
        );
        return;
      }

      if (state.activeEmotion === name || state.activeProperty === name) {
        state.activeEmotion = "normal";
        state.activeProperty = "default";
        resetEmotion();
        $$(".expr-btn").forEach((b) =>
          b.classList.toggle("active", b.dataset.expr === "normal"),
        );
        return;
      }
      state.activeEmotion = name;
      state.activeProperty = "default";
      resetEmotion();

      fireOverlay(name);
      try {
        await state.model.expression(name);
        $$(".expr-btn").forEach((b) =>
          b.classList.toggle("active", b.dataset.expr === name),
        );
        console.log("[Live2D] Native expression ->", name);
      } catch (err) {
        console.warn("[Live2D] Native expression error:", err);
      }
      return;
    }

    if (state.supportedEmotions.hasOwnProperty(name)) {
      if (state.activeEmotion === name && intensity === undefined) {
        name = "normal";
      }
      state.activeEmotion = name;
      state.activeProperty = "default";
      if (name === "normal") {
        resetEmotion();
      } else {
        const preset = state.supportedEmotions[name];
        setEmotionTargets(preset, intensity);
        playEmotionClip(name);   // body follows the face (see native branch)
        fireOverlay(name);
      }
      $$(".expr-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.expr === name),
      );
      console.log(
        "[Live2D] Synthetic emotion ->",
        name,
        "intensity:",
        intensity,
      );
    } else {
      fireOverlay(name);
    }
  }

  function toggleAccessory(paramId, val) {
    if (!state.model) return;
    const current = state.accessoryValues[paramId] || 0;
    const next = current > 0.5 ? 0 : val;
    state.accessoryValues[paramId] = next;
    if (next > 0.5) setSticky(paramId, next, 1);
    else delete state.overrides[paramId];
    pokeParam(paramId, next, 1);

    $$(".acc-btn").forEach((btn) => {
      if (btn.dataset.param === paramId) {
        btn.classList.toggle("active", next > 0.5);
      }
    });
  }

  let bubbleTimeout = null;
  function showBubble(text, duration = 4000) {
    const bubble = $("#bubble");
    const textEl = $("#bubble-text");
    if (bubbleTimeout) clearTimeout(bubbleTimeout);
    textEl.textContent = text;
    bubble.classList.remove("hidden");
    bubbleTimeout = setTimeout(() => bubble.classList.add("hidden"), duration);
  }
  function hideBubble() {
    const bubble = $("#bubble");
    if (bubbleTimeout) clearTimeout(bubbleTimeout);
    bubble.classList.add("hidden");
  }

  // Mesin suara global (dari /api/config). provider "browser" = speechSynthesis;
  // selain itu bicara lewat /api/tts yang meneruskan ke provider remote.
  let TTS_CFG = { provider: "browser", endpoint: "", apiKey: "", voice: "", model: "" };

  let EVENTS = {
    idleSpeak: true,
    idleMs: 1800000,
    idleRepeatMs: 1800000,
    awaySpeak: true,
    returnSpeak: true,
    awayHiddenMs: 10000,
    quietMs: 1800000,
  };

  window.__appEvents = EVENTS;

  // Provider remote aktif bila provider bukan "browser" dan prerequisitnya ada
  // (endpoint untuk gradio/openai/custom, apiKey untuk elevenlabs/gemini).
  function ttsRemoteActive() {
    const p = String(TTS_CFG.provider || "browser");
    if (p === "browser" || !p) return false;
    if (p === "elevenlabs" || p === "gemini") return !!TTS_CFG.apiKey;
    return true; // gradio/openai/custom — kekurangan config ditanggapi server, client fallback browser
  }
  let CAMERA = {
    enabled: false,
    fps: 0.4,
    presenceThreshold: 0.4,
    device: "webgpu",
    model: "Xenova/facial_emotions_image_detection",
  };
  let MOTION = { enabled: false, gain: 1.5 };
  async function loadAppConfig() {
    try {
      const r = await fetch(API + "/api/config");
      const d = await r.json();
      TTS_CFG = Object.assign(
        { provider: "browser", endpoint: "", apiKey: "", voice: "", model: "" },
        d.tts || {},
      );
      // Config lama: hanya ada endpoint Gradio tanpa provider.
      if (!d.tts?.provider && TTS_CFG.endpoint) TTS_CFG.provider = "gradio";
      window.__ttsCfg = TTS_CFG;
      // Form TTS mungkin sudah ter-init sebelum config tiba — paint ulang.
      if (window.__paintTTSForm) window.__paintTTSForm(TTS_CFG);
      if (d.events) Object.assign(EVENTS, d.events);
      if (d.camera) Object.assign(CAMERA, d.camera);
      if (d.motion) {
        MOTION.enabled = !!d.motion.enabled;
        if (typeof d.motion.gain === "number") MOTION.gain = d.motion.gain;
      }

      if (d.overlay) window.__overlayCfg = Object.assign({}, window.__overlayCfg || {}, d.overlay);
    } catch (e) {
      /* pakai default */
    }
  }
  loadAppConfig();

  let presence = null;
  let agentIdleTimer = null;
  let agentIdleRepeat = null;

  function stopAgentIdle() {
    if (agentIdleTimer) {
      clearTimeout(agentIdleTimer);
      agentIdleTimer = null;
    }
    if (agentIdleRepeat) {
      clearInterval(agentIdleRepeat);
      agentIdleRepeat = null;
    }
  }

  function resetAgentIdle() {
    stopAgentIdle();
    if (!EVENTS.idleSpeak) return;
    const fire = () => {
      if (window.__agent && presence === true)
        window.__agent.reactEvent("idle");
      agentIdleRepeat = setInterval(() => {
        if (window.__agent && presence === true)
          window.__agent.reactEvent("idle");
      }, EVENTS.idleRepeatMs);
    };
    agentIdleTimer = setTimeout(fire, EVENTS.idleMs);
  }

  window.__l2dPresenceChanged = function (p) {
    presence = p;
    if (p === true) resetAgentIdle();
    else stopAgentIdle();
  };

  function applyFallbackPresence(p) {
    if (window.__cameraActive) return;
    if (window.__agent) window.__agent.setPresence(p);
    else window.__l2dPresenceChanged(p);
  }
  document.addEventListener("visibilitychange", () =>
    applyFallbackPresence(!document.hidden),
  );
  window.addEventListener("blur", () => applyFallbackPresence(false));
  window.addEventListener("focus", () =>
    applyFallbackPresence(!document.hidden),
  );
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", () =>
      applyFallbackPresence(!document.hidden),
    );
  } else {
    applyFallbackPresence(!document.hidden);
  }

  function browserTTS(text, markDone, fallbackTimer) {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    try {
      if (typeof speechSynthesis === "undefined") {
        markDone();
        return;
      }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);

      const vcfg = currentModelConfig();
      u.lang = vcfg.ttsLang;
      u.rate = vcfg.ttsRate;
      u.pitch = vcfg.ttsPitch;
      u.volume = 1;
      u.onend = markDone;
      u.onerror = markDone;
      const pickVoice = () => {
        const vs = speechSynthesis.getVoices() || [];

        const base = String(vcfg.ttsLang || "")
          .split("-")[0]
          .toLowerCase();
        const langRe = new RegExp("^" + base, "i");
        const v =
          vs.find(
            (x) =>
              String(x.lang).toLowerCase() ===
              String(vcfg.ttsLang).toLowerCase(),
          ) ||
          vs.find((x) => langRe.test(x.lang)) ||
          (base === "id" ? vs.find((x) => /indonesia/i.test(x.name)) : null);
        if (v) u.voice = v;
        speechSynthesis.speak(u);
      };
      if (speechSynthesis.getVoices().length) pickVoice();
      else
        speechSynthesis.addEventListener("voiceschanged", pickVoice, {
          once: true,
        });
    } catch (e) {
      markDone();
    }
  }

  // ── Pipeline TTS per-kalimat (remote) ─────────────────────────
  // Teks panjang dipecah per kalimat. Segmen pertama diputar secepatnya;
  // SEWAKTU diputar, kalimat berikutnya sudah diminta (prefetch) sehingga
  // jeda antar kalimat ≈ nol. Bubble mengikuti kalimat yang sedang dibacakan.
  function splitSpeechSegments(text) {
    const t = String(text || "").trim();
    if (!t) return [];
    // Pecah setelah . ! ? … plus tanda kutip/braket penutup di belakangnya.
    const parts = t.split(/(?<=[.!?…]["”»')\]]?)\s+/);
    const out = [];
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      if (s.length <= 220) {
        out.push(s);
        continue;
      }
      // Kalimat super panjang → potong di koma/spasi terdekat.
      let rest = s;
      while (rest.length > 220) {
        let cut = rest.lastIndexOf(",", 220);
        const sp = rest.lastIndexOf(" ", 220);
        if (cut < 120) cut = sp;
        if (cut < 120) cut = 220;
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
      }
      if (rest.trim()) out.push(rest.trim());
    }
    return out.length ? out : [t];
  }

  async function fetchTTSAudio(text) {
    // Timeout + retry: kadang koneksi request pertama (dari handler klik)
    // menggantung di server tanpa jawaban. Abort menutup socket beku; retry
    // memakai koneksi segar — dan teks yang sama biasanya sudah ter-cache
    // di server sehingga nyaris instan.
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 20000);
      try {
        const resp = await fetch(API + "/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: ctrl.signal,
        });
        if (!resp.ok) {
          const msg = await resp.text().catch(() => "");
          // 429/kuota dll — jangan diulang, langsung dilempar
          throw new Error("HTTP " + resp.status + (msg ? ": " + msg.slice(0, 140) : ""));
        }
        const blob = await resp.blob();
        clearTimeout(to);
        return blob;
      } catch (e) {
        clearTimeout(to);
        if (attempt >= 1 || (e && e.name !== "AbortError")) throw e;
        console.warn("[TTS] request menggantung (timeout 20 dtk), coba ulang…");
      }
    }
  }

  function playTTSAudio(blob, onDone) {
    const url = URL.createObjectURL(blob);
    const audio = (state.ttsAudio = state.ttsAudio || new Audio());
    audio.src = url;
    // Pace untuk suara remote — slider "Kecepatan bicara" per-model
    // berlaku juga di sini (browserTTS memakai rate yang sama).
    audio.playbackRate = clamp(
      Number((currentModelConfig() || {}).ttsRate) || 1,
      0.5,
      2,
    );

    let lip = null;
    if (window.LipSync && window.LipSync.AudioLipSync) {
      lip = state.audioLipSync =
        state.audioLipSync || new window.LipSync.AudioLipSync();
      lip.reset();
      if (!lip.attach(audio)) lip = null;
    }
    state.activeLip = lip;

    audio.onplaying = () => {
      if (lip && !lip.active) lip.attach(audio);
    };
    audio.onended = () => {
      URL.revokeObjectURL(url);
      onDone();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      onDone();
    };
    audio.play().catch(onDone);
    return audio;
  }

  // Kelompokkan potongan kalimat jadi segmen yang panjang teksnya mendekati
  // target (durasi audio ≈ latensi fetch) — jeda antar segmen minimum.
  function regroupByTarget(pieces, target) {
    const out = [];
    let cur = "";
    for (const p of pieces) {
      if (cur && (cur + " " + p).length > target) {
        out.push(cur);
        cur = p;
      } else {
        cur = cur ? cur + " " + p : p;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  async function doRemoteTTS(text, markDone, fallbackTimer, reveal) {
    if (!ttsRemoteActive()) {
      reveal && reveal();
      browserTTS(text, markDone, fallbackTimer);
      return;
    }
    clearTimeout(fallbackTimer);
    // `let` — regroup adaptif mengganti isi segments setelah latensi diukur
    let segments = splitSpeechSegments(text);
    // Teks pendek → jalur lama (satu request), tanpa overhead pipeline.
    if (segments.length <= 1) {
      try {
        const blob = await fetchTTSAudio(text);
        reveal && reveal();
        const fallbackTimer2 = setTimeout(markDone, 45000);
        playTTSAudio(blob, () => {
          clearTimeout(fallbackTimer2);
          markDone();
        });
      } catch (e) {
        console.warn("[TTS] remote gagal, fallback ke browser:", e && e.message);
        reveal && reveal();
        browserTTS(text, markDone, null);
      }
      return;
    }

    // Pipeline: latensi request pertama diukur nyata, lalu sisa kalimat
    // dikelompokkan ulang sehingga durasi audio per segmen ≥ waktu fetch
    // (prefetch selesai pas sebelum giliran putarnya → jeda ≈ nol).
    let aborted = false;
    const guard = () => {
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => {
        aborted = true;
        markDone();
      }, 60000);
    };
    guard();

    const pending = new Map(); // i -> Promise<blob>
    const prefetch = (i) => {
      if (aborted || i >= segments.length || pending.has(i)) return;
      pending.set(
        i,
        fetchTTSAudio(segments[i]).catch((e) => {
          pending.delete(i);
          throw e;
        }),
      );
    };
    prefetch(0);
    const t0 = performance.now();

    for (let i = 0; i < segments.length && !aborted; i++) {
      let blob;
      try {
        blob = await pending.get(i);
      } catch (e) {
        // Segmen gagal → jatuh ke suara browser untuk sisa kalimat, tanpa
        // mengulang API (hemat billing).
        console.warn("[TTS] segmen " + i + " gagal:", e && e.message);
        if (i === 0) reveal && reveal();
        const remaining = segments.slice(i).join(" ");
        browserTTS(remaining, markDone, null);
        return;
      }
      if (aborted) return;
      if (i === 0) {
        // Latensi nyata Gemini dkk besar (terukur 10–16 dtk). Kalau segmen
        // per-kalimat (audio ±3 dtk), prefetch tak akan pernah kejar →
        // gabung kalimat berikutnya sampai durasi audionya ≥ latensi.
        const latencySec = (performance.now() - t0) / 1000;
        if (latencySec > 4 && segments.length > 1) {
          // ~13 char/dtk bicara Indonesia, 1.35 margin keamanan.
          const target = clamp(
            Math.round(latencySec * 13 * 1.35),
            120,
            420,
          );
          const rest = splitSpeechSegments(segments.slice(1).join(" "));
          segments = [segments[0]].concat(regroupByTarget(rest, target));
        }
      }
      // Mulai request kalimat berikutnya SEBELUM audio ini diputar.
      prefetch(i + 1);
      prefetch(i + 2);
      const segText = segments[i];
      reveal && reveal();
      // Bubble menampilkan kalimat yang sedang dibacakan.
      showBubble(segText, 1e9);
      await new Promise((resolve) => {
        playTTSAudio(blob, resolve);
        guard();
      });
      // state.talking & mulut dikelola reveal(); antar segmen tetap "talking".
    }
    if (!aborted) markDone();
  }

  function speak(text, onDone) {
    if (!state.model) {
      showBubble(text);
      if (onDone) setTimeout(onDone, 500);
      return;
    }
    let ttsDone = false,
      revealed = false;
    const markDone = () => {
      if (ttsDone) return;
      ttsDone = true;
      hideBubble();
      state.talking = false;
      if (state.activeLip) state.activeLip.reset();

      const mId = roleId("mouthOpenY");
      if (mId) {
        delete state.overrides[mId];
        pokeParam(
          mId,
          state.mouthRest != null ? state.mouthRest : roleDefault("mouthOpenY"),
          1,
        );
      }
      if (onDone) onDone();
    };

    const reveal = () => {
      if (revealed) return;
      revealed = true;
      showBubble(text, 1e9);
      state.talking = true;
      if (state.mouthTimer) clearTimeout(state.mouthTimer);
      const dur = Math.max(1400, text.length * 75);
      state.mouthTimer = setTimeout(() => {
        state.talking = false;
        const mId = roleId("mouthOpenY");
        if (mId) {
          delete state.overrides[mId];
          pokeParam(
            mId,
            state.mouthRest != null
              ? state.mouthRest
              : roleDefault("mouthOpenY"),
            1,
          );
        }
      }, dur);
    };

    showBubble("…", 1e9);
    const fallbackTimer = setTimeout(
      markDone,
      ttsRemoteActive() ? 45000 : Math.max(1400, text.length * 75) + 800,
    );
    if (ttsRemoteActive()) {
      window.__debugSpeak = (t) => speak(String(t || ""));
      doRemoteTTS(text, markDone, fallbackTimer, reveal);
    } else {
      reveal();
      browserTTS(text, markDone, fallbackTimer);
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[m],
    );
  }

  let editorFreezeApi = null;

  function wireUI() {
    const setControlsOpen = (open) => {
      $("#controls-panel").classList.toggle("hidden", !open);
    };
    const isOpen = () => !$("#controls-panel").classList.contains("hidden");
    $("#btn-toggle-controls").addEventListener("click", () =>
      setControlsOpen(!isOpen()),
    );
    const stageBtn = $("#btn-stage-controls");
    if (stageBtn)
      stageBtn.addEventListener("click", () => setControlsOpen(!isOpen()));

    $("#btn-close-controls").addEventListener("click", () =>
      setControlsOpen(false),
    );
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const panel = $("#controls-panel");
      if (!panel || panel.classList.contains("hidden")) return;

      const ms = document.getElementById("motion-studio-popup");
      if (ms && !ms.classList.contains("hidden")) return;
      if (
        e.target &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)
      )
        return;
      panel.classList.add("hidden");
    });

    $$(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".tab").forEach((t) => t.classList.remove("active"));
        $$(".tab-pane").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        const pane = tab.dataset.tab;
        const el = document.querySelector(
          '.tab-pane[data-pane="' + pane + '"]',
        );
        if (el) el.classList.add("active");
      });
    });

    const fbBtn = $("#btn-fullbody");
    function showFullBtn() {
      if (state.fullBody) return;
      if (fbBtn) fbBtn.classList.remove("hidden");
    }
    function setFullBody(on) {
      state.fullBody = on;
      if (!fbBtn) return;
      if (on) {
        state.preFull = {
          x: state.model.x,
          y: state.model.y,
          scale: state.model.scale.x,
        };
        frameModel("full");
        fbBtn.textContent = "⤡ Kembali";
        fbBtn.classList.add("active");
      } else {
        if (state.preFull) {
          state.model.scale.set(state.preFull.scale);
          state.model.x = state.preFull.x;
          state.model.y = state.preFull.y;
          state.basePos.x = state.preFull.x;
          state.basePos.y = state.preFull.y;
          state.scale = state.preFull.scale;
        } else {
          frameModel("upper");
        }
        fbBtn.textContent = "⤢ Full Body";
        fbBtn.classList.remove("active");
        fbBtn.classList.add("hidden");
      }
    }
    if (fbBtn)
      fbBtn.addEventListener("click", () => setFullBody(!state.fullBody));

    state._showFullBtn = showFullBtn;

    window.showToast = function(msg, type = "info") {
      let container = document.getElementById("toast-container");
      if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        container.className = "toast-container";
        document.body.appendChild(container);
      }
      const toast = document.createElement("div");
      toast.className = "toast " + type;
      const icon = type === "success" ? "✓ " : type === "error" ? "✕ " : "ℹ ";
      toast.textContent = icon + msg;
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(14px) scale(0.95)";
        setTimeout(() => toast.remove(), 300);
      }, 2800);
    };

    function addChat(role, text) {
      const log = $("#chat-log");
      if (!log) return;
      const msg = document.createElement("div");
      msg.className = "msg " + role;
      const av = document.createElement("div");
      av.className = "msg-avatar";
      av.textContent = role === "user" ? "🙂" : characterInitial();
      if (role === "agent") paintAvatarEl(av, characterInitial());
      const bb = document.createElement("div");
      bb.className = "msg-bubble";
      bb.textContent = text;
      bb.title = "Klik untuk menyalin teks";
      bb.style.cursor = "pointer";
      bb.addEventListener("click", () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => {
            window.showToast?.("Pesan disalin ke clipboard 📋", "info");
          }).catch(() => {});
        }
      });
      msg.appendChild(av);
      msg.appendChild(bb);
      log.appendChild(msg);
      log.scrollTop = log.scrollHeight;
    }

    const clearChatBtn = $("#btn-clear-chat");
    if (clearChatBtn) {
      clearChatBtn.addEventListener("click", () => {
        const log = $("#chat-log");
        if (!log) return;
        const name = characterName();
        log.innerHTML = `
          <div class="msg agent">
            <div class="msg-avatar">${characterInitial()}</div>
            <div class="msg-bubble" id="greeting-bubble">Halo! Aku ${name}~ Ada yang bisa kubantu? 😊</div>
          </div>
        `;
        const av = log.querySelector(".msg-avatar");
        if (av) paintAvatarEl(av, characterInitial());
        if (window.__agent) {
          window.__agent.history = [];
        }
        window.showToast?.("Riwayat obrolan dibersihkan", "info");
      });
    }

    window.__addChat = addChat;

    window.__l2dDebug = {
      state,
      loadMotionTaxonomy,
      buildTaxonomyFromNames,
      playEmotionClip,
      clipIsPlaying,
      applyExpression,
      renderer: app.renderer,
    };

    function sendBubble() {
      const input = $("#bubble-input");
      const text = input.value.trim();
      if (!text) return;
      addChat("user", text);
      showBubble(text);
      resetAgentIdle();
      const brainOn = $("#toggle-brain") && $("#toggle-brain").checked;
      input.value = "";

      const g =
        window.__agent && window.__agent.guessEmotion
          ? window.__agent.guessEmotion(text)
          : "";
      const moodMap = {
        senang: "senang",
        tersenyum: "senang",
        sedih: "sedih",
        malu: "normal",
        kaget: "kaget",
        kesal: "marah",
        bingung: "normal",
      };
      const m = moodMap[g] || "normal";

      if (window.__agent) window.__agent.setUserMood(m, "text");
      if (brainOn && window.__agent) {
        window.__agent.think(text);
      } else {
        speak(text);
      }
    }
    $("#btn-bubble").addEventListener("click", sendBubble);
    $("#bubble-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendBubble();
    });

    $$(".phrase-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = btn.dataset.phrase;
        resetAgentIdle();
        showBubble(p, 3500);
        speak(p);
      });
    });

    const camToggle = document.getElementById("use-camera");
    const camStatus = document.getElementById("camera-status");
    function setCamStatus(text, cls) {
      if (!camStatus) return;
      camStatus.textContent = text;
      camStatus.className = "note-status" + (cls ? " " + cls : "");
    }
    if (camToggle) {
      camToggle.checked = !!CAMERA.enabled;
      camToggle.addEventListener("change", async (e) => {
        const on = e.target.checked;
        if (on) {
          if (!window.cameraPresence) {
            e.target.checked = false;
            setCamStatus("modul kamera belum dimuat", "err");
            return;
          }

          e.target.disabled = true;
          setCamStatus("meminta izin & memuat model…", "busy");
          try {
            await window.cameraPresence.start(
              Object.assign({}, CAMERA, { awayHiddenMs: EVENTS.awayHiddenMs }),
            );
            setCamStatus("aktif — deteksi hadir & mood", "ok");
          } catch (err) {
            console.error("[camera] start gagal:", err);
            e.target.checked = false;
            setCamStatus(
              "gagal: " + (err && err.message ? err.message : err),
              "err",
            );
          } finally {
            e.target.disabled = false;
          }
        } else {
          if (window.cameraPresence) window.cameraPresence.stop();
          setCamStatus("mati", "");
          applyFallbackPresence(!document.hidden);
        }
      });
    }

    const connList = $("#conn-list");
    const modal = $("#conn-modal");
    let editingId = null;
    let lastConnSig = null;

    function connSig(conns, activeId) {
      return JSON.stringify(
        [activeId || null].concat(
          (conns || []).map((c) => [
            c.id,
            c.testStatus || "untested",
            c.lastError || "",
            c.rateLimitedUntil || "",
            Array.isArray(c.roles) ? c.roles.join(",") : "",
          ]),
        ),
      );
    }

    async function loadConns() {
      try {
        const r = await fetch(API + "/api/config");
        const d = await r.json();
        renderConns(d.connections || [], d.activeId);
      } catch (e) {
        console.error("[conn] load", e);
      }
    }
    function badgeClass(s) {
      if (s === "success") return "success";
      if (s === "error") return "error";
      return "default";
    }
    function renderConns(conns, activeId) {
      lastConnSig = connSig(conns, activeId);
      connList.innerHTML = "";
      if (!conns.length) {
        connList.innerHTML =
          '<div class="conn-hint">Belum ada connection. Klik ＋ untuk tambah.</div>';
        return;
      }
      for (const c of conns) {
        const card = document.createElement("div");
        card.className = "conn-card" + (c.id === activeId ? " active" : "");
        const status = c.testStatus || "untested";

        const coolMs = c.rateLimitedUntil
          ? new Date(c.rateLimitedUntil).getTime() - Date.now()
          : 0;
        const cooling = coolMs > 0;
        const badgeText = cooling
          ? `◌ cooldown ${Math.ceil(coolMs / 1000)}s`
          : status === "success"
            ? "✓ connected"
            : status === "error"
              ? "✕ error"
              : "○ untested";

        const roleList = Array.isArray(c.roles) ? c.roles : [];
        const roleTags = roleList.length
          ? roleList
              .map((r) => `<span class="conn-role-tag">${esc(r)}</span>`)
              .join("")
          : '<span class="conn-role-tag wild">semua peran</span>';
        card.innerHTML = `
          <div class="conn-head">
            <span class="conn-name">${esc(c.name || c.id)}</span>
            <span class="conn-badge ${cooling ? "default" : badgeClass(status)}">${badgeText}</span>
          </div>
          <div class="conn-meta">${esc(c.provider || "")} · ${esc(c.model || "")}</div>
          <div class="conn-role-tags">${roleTags}</div>
          ${c.lastError ? `<div class="conn-err">${esc(c.lastError)}</div>` : ""}
          <div class="conn-actions">
            <button data-act="active" class="${c.id === activeId ? "act-active" : ""}">${c.id === activeId ? "● Active" : "Set Active"}</button>
            <button data-act="edit">Edit</button>
            <button data-act="test">Test</button>
            <button data-act="delete">Delete</button>
          </div>`;
        card
          .querySelector('[data-act="active"]')
          .addEventListener("click", () => setActive(c.id));
        card
          .querySelector('[data-act="edit"]')
          .addEventListener("click", () => openModal(c));
        card
          .querySelector('[data-act="test"]')
          .addEventListener("click", (e) => testConn(c, e.target));
        card
          .querySelector('[data-act="delete"]')
          .addEventListener("click", () => delConn(c.id));
        connList.appendChild(card);
      }
    }

    function rolesFromForm() {
      const box = $("#m-roles");
      if (!box) return [];
      return Array.from(box.querySelectorAll('input[type="checkbox"]'))
        .filter((cb) => cb.checked)
        .map((cb) => cb.value);
    }
    function rolesToForm(roles) {
      const box = $("#m-roles");
      if (!box) return;
      const want = new Set(Array.isArray(roles) ? roles : []);
      for (const cb of box.querySelectorAll('input[type="checkbox"]'))
        cb.checked = want.has(cb.value);
    }

    function openModal(c) {
      editingId = c ? c.id : null;
      $("#m-name").value = c ? c.name || "" : "";
      $("#m-provider").value = c
        ? c.provider || "openai-compatible"
        : "openai-compatible";
      $("#m-baseurl").value = c ? c.baseUrl || "" : "";
      $("#m-apikey").value = c
        ? c.apiKey && !c.apiKey.startsWith("•")
          ? ""
          : ""
        : "";
      $("#m-model").value = c ? c.model || "" : "";
      $("#m-system").value = c ? c.systemPrompt || "" : "";

      $("#m-maxtokens").value = c && c.maxTokens != null ? c.maxTokens : "";
      $("#m-temp").value = c && c.temperature != null ? c.temperature : "";
      $("#m-stream").checked = !!(c && c.stream);
      rolesToForm(c ? c.roles : []);
      modal.classList.remove("hidden");
    }
    function closeModal() {
      modal.classList.add("hidden");
      editingId = null;
    }
    $("#m-cancel").addEventListener("click", closeModal);
    $("#btn-add-conn").addEventListener("click", () => openModal(null));

    $("#m-save").addEventListener("click", async () => {
      const k = $("#m-apikey").value.trim();
      const conn = {
        name: $("#m-name").value.trim() || "connection",
        provider: $("#m-provider").value,
        baseUrl: $("#m-baseurl").value.trim(),
        apiKey: k,
        model: $("#m-model").value.trim(),
        systemPrompt: $("#m-system").value,
        roles: rolesFromForm(),
      };

      const mt = parseInt($("#m-maxtokens").value, 10);
      const tp = parseFloat($("#m-temp").value);
      if (Number.isFinite(mt)) conn.maxTokens = mt;
      if (Number.isFinite(tp)) conn.temperature = tp;
      conn.stream = $("#m-stream").checked;
      const body = { action: editingId ? "update" : "add" };

      if (editingId && !k) delete conn.apiKey;
      if (editingId) {
        body.id = editingId;
        body.connection = conn;
      } else body.connection = conn;

      await fetch(API + "/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      closeModal();
      loadConns();
    });

    async function setActive(id) {
      await fetch(API + "/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setActive", id }),
      });
      loadConns();
    }
    async function delConn(id) {
      if (!confirm("Hapus connection ini?")) return;
      await fetch(API + "/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      loadConns();
    }
    async function testConn(c, btn) {
      btn.disabled = true;
      btn.textContent = "testing…";
      const r = await fetch(API + "/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection: c }),
      });
      const d = await r.json();
      btn.disabled = false;
      btn.textContent = "Test";
      alert(
        d.valid
          ? "✓ Connection OK: " + (d.reply || "")
          : "✕ " + (d.error || "gagal"),
      );
      loadConns();
    }

    const drop = $("#model-drop");
    const pickBtn = $("#btn-pick-model");
    const folderInput = $("#input-model-folder");
    const nameInput = $("#input-model-name");
    const modelList = $("#model-list");

    async function refreshModels() {
      try {
        const r = await fetch(API + "/api/models");
        const d = await r.json();
        modelList.innerHTML = "";
        const models = d.models || [];
        if (!models.length) {
          modelList.innerHTML =
            '<div class="conn-hint">Belum ada model. Upload lewat drop box di atas.</div>';
        }
        for (const name of models) {
          const item = document.createElement("div");
          item.className = "model-item";
          item.innerHTML = `<span class="m-name">${esc(name)}</span>
            <span class="m-actions">
              <button class="load" data-name="${esc(name)}">Load</button>
              <button class="del" data-name="${esc(name)}">🗑</button>
            </span>`;
          item
            .querySelector(".load")
            .addEventListener("click", () => loadUserModel(name));
          item.querySelector(".del").addEventListener("click", async () => {
            if (
              !confirm(
                'Hapus model "' +
                  name +
                  '"?\n\nFolder model dihapus. Sheet, preset, dan gerakan buatanmu tetap disimpan — impor ulang model dengan nama yang sama dan datanya tersambung kembali otomatis.',
              )
            )
              return;
            await fetch(API + "/api/model/" + encodeURIComponent(name), {
              method: "DELETE",
            });
            deleteCharacterSheet(name);
            refreshModels();

            const curName = state.modelPath
              ? String(state.modelPath).split("/")[1]
              : null;
            if (curName === name) {
              const auto = await resolveAnyModelPath();
              if (auto) await loadModel(auto);
              else {
                try {
                  app.stage.removeChild(state.model);
                  state.model.destroy();
                } catch (e) {}
                state.model = null;
                showNoModelState();
              }
            }
          });
          modelList.appendChild(item);
        }
      } catch (e) {
        console.error("[model] list", e);
      }
    }

    async function assertCubism4(path) {
      try {
        const r = await fetch(API + "/" + path);
        if (!r.ok) return true;
        const j = await r.json();
        if (j && j.Version === 3) {
          console.warn(
            '[model] "' +
              path +
              '" is Cubism 3 — applying moc version-stamp shim (no Editor needed).',
          );
        }
      } catch (e) {
        /* non-JSON — let loadModel report */
      }
      return true;
    }

    async function loadUserModel(name) {
      showLoader("Memuat model: " + name + "...");
      try {
        const path = await resolveModel3(name);
        if (!path) throw new Error("tidak ada *.model3.json");
        if (!(await assertCubism4(path))) {
          hideLoader();
          return;
        }
        await loadModel(path);
        refreshModels();
      } catch (e) {
        console.error("[model] load", e);
        alert("Gagal memuat model: " + e.message);
      } finally {
        hideLoader();
      }
    }

    async function resolveModel3(name) {
      const r = await fetch(
        API + "/api/model/path?name=" + encodeURIComponent(name),
      );
      if (r.ok) {
        const d = await r.json();
        return d.path || null;
      }
      return null;
    }

    function abToBase64(buf) {
      const u = new Uint8Array(buf);
      let s = "";
      const CH = 0x8000;
      for (let i = 0; i < u.length; i += CH) {
        s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
      }
      return btoa(s);
    }

    async function uploadFolder(files, name) {
      if (!name) name = prompt("Nama model?", "MyModel") || "MyModel";
      name = name.trim().replace(/[^\w\-]+/g, "_");
      const payload = { name, files: [] };
      for (const f of files) {
        const rel = f.webkitRelativePath || f.relativePath || f.name;
        const buf = await f.arrayBuffer();
        payload.files.push({ path: rel, base64: abToBase64(buf) });
      }
      showLoader("Mengupload " + payload.files.length + " file...");
      const r = await fetch(API + "/api/model/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "upload gagal");
      return name;
    }

    function showLoader(text) {
      const p = $("#loader p");
      if (p) p.textContent = text;
      $("#loader").classList.remove("done", "fade-out", "hidden");
    }
    function hideLoader() {
      $("#loader").classList.add("done");
      setTimeout(() => $("#loader").classList.add("fade-out"), 300);
      setTimeout(() => $("#loader").classList.add("hidden"), 950);
    }

    if (pickBtn)
      pickBtn.addEventListener(
        "click",
        () => folderInput && folderInput.click(),
      );

    const emptyFolderBtn = $("#btn-empty-folder");
    if (emptyFolderBtn)
      emptyFolderBtn.addEventListener(
        "click",
        () => folderInput && folderInput.click(),
      );
    const emptyZipBtn = $("#btn-empty-zip");
    if (emptyZipBtn)
      emptyZipBtn.addEventListener("click", () => {
        const z = $("#input-model-zip");
        if (z) z.click();
      });
    if (folderInput)
      folderInput.addEventListener("change", async () => {
        if (!folderInput.files || !folderInput.files.length) return;
        try {
          const n = await uploadFolder(folderInput.files, nameInput.value);
          await refreshModels();
          loadUserModel(n);
        } catch (e) {
          alert("Upload gagal: " + e.message);
          hideLoader();
        }
      });

    const zipBtn = $("#btn-pick-zip");
    const zipInput = $("#input-model-zip");
    if (zipBtn)
      zipBtn.addEventListener("click", () => zipInput && zipInput.click());
    if (zipInput)
      zipInput.addEventListener("change", async () => {
        const f = zipInput.files && zipInput.files[0];
        if (!f) return;
        try {
          const nameFromZip = f.name.replace(/\.zip$/i, "") || "MyModel";
          const buf = await f.arrayBuffer();
          const b64 = abToBase64(buf);
          showLoader("Mengekstrak " + f.name + "...");
          const r = await fetch(API + "/api/model/import-zip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: nameFromZip, base64: b64 }),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || "extract gagal");
          await refreshModels();
          if (!(await assertCubism4(d.path))) {
            hideLoader();
            return;
          }
          await loadModel(d.path);
        } catch (e) {
          alert("Import .zip gagal: " + e.message);
        } finally {
          hideLoader();
          zipInput.value = "";
        }
      });
    if (drop) {
      ["dragenter", "dragover"].forEach((ev) =>
        drop.addEventListener(ev, (e) => {
          e.preventDefault();
          drop.classList.add("drag");
        }),
      );
      ["dragleave", "drop"].forEach((ev) =>
        drop.addEventListener(ev, (e) => {
          e.preventDefault();
          drop.classList.remove("drag");
        }),
      );
      drop.addEventListener("drop", async (e) => {
        const items = e.dataTransfer && e.dataTransfer.items;
        let files = e.dataTransfer && e.dataTransfer.files;

        if (items && items.length && items[0].webkitGetAsEntry) {
          const entries = [];
          for (const it of items) {
            const en = it.webkitGetAsEntry();
            if (en) entries.push(en);
          }
          const collected = [];
          const walk = (entry, base) =>
            new Promise((res) => {
              if (entry.isFile) {
                entry.file((f) => {
                  f.relativePath = base + entry.name;
                  collected.push(f);
                  res();
                });
              } else if (entry.isDirectory) {
                const reader = entry.createReader();
                const read = () =>
                  reader.readEntries(async (ents) => {
                    if (!ents.length) return res();
                    for (const c of ents)
                      await walk(c, base + entry.name + "/");
                    read();
                  });
                read();
              } else res();
            });
          for (const en of entries) await walk(en, "");
          if (collected.length) {
            try {
              const n = await uploadFolder(collected, nameInput.value);
              await refreshModels();
              loadUserModel(n);
            } catch (err) {
              alert("Upload gagal: " + err.message);
              hideLoader();
            }
          }
        } else if (files && files.length) {
          try {
            const n = await uploadFolder(files, nameInput.value);
            await refreshModels();
            loadUserModel(n);
          } catch (err) {
            alert("Upload gagal: " + err.message);
            hideLoader();
          }
        }
      });
    }
    refreshModels();

    const inspectBtn = $("#btn-inspect");
    if (inspectBtn)
      inspectBtn.addEventListener("click", () => {
        if (!state.model) {
          alert("Load model dulu sebelum inspeksi.");
          return;
        }
        showLoader("🔍 Menganalisis model...");
        setTimeout(() => {
          const sheet = inspectModel();
          hideLoader();
          if (sheet) {
            refreshUserNoteUI();
            try {
              refreshConfigForm();
            } catch (e) {}
            try {
              refreshSheetUI();
            } catch (e) {}
            alert(
              `✅ Character Sheet generated!\n\n` +
                `📋 ${sheet.paramCount} parameter ditemukan\n` +
                `😊 ${Object.keys(sheet.supportedEmotions).length} emosi didukung\n` +
                `✨ ${sheet.accessories.length} aksesoris terdeteksi\n` +
                `🎭 ${sheet.nativeExpressions.length} expression bawaan\n` +
                `🎬 ${sheet.motionGroups.length} motion group\n\n` +
                `Tersimpan di localStorage. AI akan pakai data ini saat chat.`,
            );
          } else {
            alert("❌ Gagal inspeksi model.");
          }
        }, 100);
      });

    const noteBox = $("#input-user-note");
    const noteBtn = $("#btn-save-note");
    const noteStatus = $("#note-status");
    function setNoteStatus(msg, kind) {
      if (!noteStatus) return;
      noteStatus.textContent = msg;
      noteStatus.className = "note-status" + (kind ? " " + kind : "");
      if (kind === "ok") window.showToast?.("Catatan karakter tersimpan", "success");
      else if (kind === "err") window.showToast?.(msg, "error");
    }
    if (noteBtn && noteBox) {
      noteBtn.addEventListener("click", async () => {
        noteBtn.disabled = true;
        setNoteStatus("menyimpan…");
        try {
          const saved = await saveUserNote(noteBox.value);

          if (saved !== noteBox.value) noteBox.value = saved;
          setNoteStatus(
            saved.length
              ? `tersimpan (${saved.length}/${MAX_USER_NOTE})`
              : "catatan dikosongkan",
            "ok",
          );
        } catch (e) {
          setNoteStatus("gagal: " + e.message, "err");
        } finally {
          noteBtn.disabled = false;
        }
      });

      noteBox.addEventListener("keydown", (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
          ev.preventDefault();
          noteBtn.click();
        }
      });

      noteBox.addEventListener("input", () => {
        const n = noteBox.value.length;
        if (n > MAX_USER_NOTE * 0.8)
          setNoteStatus(
            n + "/" + MAX_USER_NOTE,
            n >= MAX_USER_NOTE ? "err" : "",
          );
        else if (noteStatus && noteStatus.textContent) setNoteStatus("");
      });
    }

    const cfgEls = {
      displayName: $("#cfg-display-name"),
      blink: $("#cfg-blink"),
      idle: $("#cfg-idle"),
      framing: $("#cfg-framing"),
      pitch: $("#cfg-tts-pitch"),
      pitchOut: $("#cfg-tts-pitch-out"),
      rate: $("#cfg-tts-rate"),
      rateOut: $("#cfg-tts-rate-out"),
      lang: $("#cfg-tts-lang"),
      ttsProvider: $("#cfg-tts-provider"),
      ttsEndpoint: $("#cfg-tts-endpoint"),
      ttsKey: $("#cfg-tts-key"),
      ttsVoice: $("#cfg-tts-voice"),
      ttsVoiceFree: $("#cfg-tts-voice-free"),
      ttsModel: $("#cfg-tts-model"),
      ttsModelFree: $("#cfg-tts-model-free"),
      ttsStyle: $("#cfg-tts-style"),
      ttsStylePick: $("#cfg-tts-style-pick"),
      btn: $("#btn-save-cfg"),
      test: $("#btn-test-voice"),
      status: $("#cfg-status"),
      bgColor: $("#cfg-bg-color"),
      bgDim: $("#cfg-bg-dim"),
      bgDimOut: $("#cfg-bg-dim-out"),
      bgFile: $("#cfg-bg-file"),
      bgPick: $("#btn-bg-pick"),
      bgClear: $("#btn-bg-clear"),
      bgReset: $("#btn-bg-reset"),
    };

    let bgImageDraft;
    function setCfgStatus(msg, kind) {
      if (!cfgEls.status) return;
      cfgEls.status.textContent = msg;
      cfgEls.status.className = "note-status" + (kind ? " " + kind : "");
      if (kind === "ok") window.showToast?.("Pengaturan model tersimpan", "success");
      else if (kind === "err") window.showToast?.(msg, "error");
    }

    function paintConfigForm(cfg) {
      const c = normalizeModelConfig(cfg);
      if (cfgEls.displayName) {
        cfgEls.displayName.value = c.displayName;

        try {
          cfgEls.displayName.placeholder =
            "(otomatis: " + characterName() + ")";
        } catch (e) {}
      }
      if (cfgEls.blink) cfgEls.blink.checked = c.blink;
      if (cfgEls.idle) cfgEls.idle.checked = c.idle;
      if (cfgEls.framing) cfgEls.framing.value = c.framing;
      if (cfgEls.pitch) cfgEls.pitch.value = String(c.ttsPitch);
      if (cfgEls.rate) cfgEls.rate.value = String(c.ttsRate);

      if (cfgEls.pitchOut) cfgEls.pitchOut.textContent = c.ttsPitch.toFixed(2);
      if (cfgEls.rateOut) cfgEls.rateOut.textContent = c.ttsRate.toFixed(2);
      if (cfgEls.lang) {
        const has = Array.prototype.some.call(
          cfgEls.lang.options,
          (o) => o.value === c.ttsLang,
        );
        if (!has) {
          const opt = document.createElement("option");
          opt.value = c.ttsLang;
          opt.textContent = c.ttsLang + " (tersimpan)";
          cfgEls.lang.appendChild(opt);
        }
        cfgEls.lang.value = c.ttsLang;
      }

      bgImageDraft = undefined;
      if (cfgEls.bgColor) cfgEls.bgColor.value = c.bgColor || "#0d0d10";
      if (cfgEls.bgDim) cfgEls.bgDim.value = String(c.bgDim);
      if (cfgEls.bgDimOut) cfgEls.bgDimOut.textContent = c.bgDim.toFixed(2);
    }
    refreshConfigForm = () => paintConfigForm(loadModelConfigLocal());

    function readConfigForm() {
      return {
        displayName: cfgEls.displayName ? cfgEls.displayName.value : undefined,
        blink: cfgEls.blink ? !!cfgEls.blink.checked : undefined,
        idle: cfgEls.idle ? !!cfgEls.idle.checked : undefined,
        framing: cfgEls.framing ? cfgEls.framing.value : undefined,
        ttsPitch: cfgEls.pitch ? Number(cfgEls.pitch.value) : undefined,
        ttsRate: cfgEls.rate ? Number(cfgEls.rate.value) : undefined,
        ttsLang: cfgEls.lang ? cfgEls.lang.value : undefined,
        bgColor: cfgEls.bgColor ? cfgEls.bgColor.value : undefined,
        bgDim: cfgEls.bgDim ? Number(cfgEls.bgDim.value) : undefined,

        bgImage: bgImageDraft !== undefined ? bgImageDraft : undefined,
      };
    }

    if (cfgEls.bgColor) {
      cfgEls.bgColor.addEventListener("input", () => {
        applyStageBackground(
          Object.assign({}, state.modelConfig, {
            bgColor: cfgEls.bgColor.value,
            bgImage:
              bgImageDraft === "CLEAR"
                ? ""
                : bgImageDraft !== undefined
                  ? bgImageDraft
                  : (state.modelConfig || {}).bgImage || "",
          }),
        );
        setCfgStatus("belum disimpan", "");
      });
    }
    if (cfgEls.bgDim) {
      cfgEls.bgDim.addEventListener("input", () => {
        if (cfgEls.bgDimOut)
          cfgEls.bgDimOut.textContent = Number(cfgEls.bgDim.value).toFixed(2);
        applyStageBackground(
          Object.assign({}, state.modelConfig, {
            bgDim: Number(cfgEls.bgDim.value),
            bgImage:
              bgImageDraft === "CLEAR"
                ? ""
                : bgImageDraft !== undefined
                  ? bgImageDraft
                  : (state.modelConfig || {}).bgImage || "",
          }),
        );
        setCfgStatus("belum disimpan", "");
      });
    }
    if (cfgEls.bgPick && cfgEls.bgFile) {
      cfgEls.bgPick.addEventListener("click", () => cfgEls.bgFile.click());
      cfgEls.bgFile.addEventListener("change", () => {
        const file = cfgEls.bgFile.files && cfgEls.bgFile.files[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024) {
          setCfgStatus("gambar terlalu besar (maks 3 MB)", "err");
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          bgImageDraft = String(reader.result || "");
          applyStageBackground(
            Object.assign({}, state.modelConfig, { bgImage: bgImageDraft }),
          );
          setCfgStatus("gambar dimuat — tekan Simpan Pengaturan", "");
        };
        reader.onerror = () => setCfgStatus("gagal membaca gambar", "err");
        reader.readAsDataURL(file);
        cfgEls.bgFile.value = "";
      });
    }
    if (cfgEls.bgClear) {
      cfgEls.bgClear.addEventListener("click", () => {
        bgImageDraft = "CLEAR";
        applyStageBackground(
          Object.assign({}, state.modelConfig, { bgImage: "" }),
        );
        setCfgStatus("gambar latar dihapus — tekan Simpan Pengaturan", "");
      });
    }
    if (cfgEls.bgReset) {
      cfgEls.bgReset.addEventListener("click", () => {
        bgImageDraft = "CLEAR";
        if (cfgEls.bgColor) cfgEls.bgColor.value = "#0d0d10";
        applyStageBackground(
          Object.assign({}, state.modelConfig, { bgColor: "", bgImage: "" }),
        );
        setCfgStatus("latar kembali ke default — tekan Simpan Pengaturan", "");
      });
    }

    if (cfgEls.pitch && cfgEls.pitchOut) {
      cfgEls.pitch.addEventListener("input", () => {
        cfgEls.pitchOut.textContent = Number(cfgEls.pitch.value).toFixed(2);
      });
    }
    if (cfgEls.rate && cfgEls.rateOut) {
      cfgEls.rate.addEventListener("input", () => {
        cfgEls.rateOut.textContent = Number(cfgEls.rate.value).toFixed(2);
      });
    }

    if (cfgEls.blink)
      cfgEls.blink.addEventListener("change", () => {
        state.blinkEnabled = !!cfgEls.blink.checked;
        setCfgStatus("belum disimpan", "");
      });
    if (cfgEls.idle)
      cfgEls.idle.addEventListener("change", () => {
        state.idleEnabled = !!cfgEls.idle.checked;
        setCfgStatus("belum disimpan", "");
      });
    if (cfgEls.framing)
      cfgEls.framing.addEventListener("change", () => {
        if (state.model) {
          try {
            frameModel(cfgEls.framing.value);
          } catch (e) {}
        }
        setCfgStatus("belum disimpan", "");
      });

    if (cfgEls.btn) {
      cfgEls.btn.addEventListener("click", async () => {
        cfgEls.btn.disabled = true;
        setCfgStatus("menyimpan…");
        try {
          const saved = await saveModelConfig(readConfigForm());

          // TTS global (config.json) ikut disimpan — apiKey kosong berarti
          // tetap pakai yang tersimpan; hanya dikirim saat bagian TTS diisi.
          if (cfgEls.ttsProvider) {
            const draft = readTTSForm();
            const remoteTouched =
              draft.endpoint ||
              draft.apiKey ||
              draft.voice ||
              draft.model ||
              draft.style ||
              draft.provider !== (TTS_CFG.provider || "browser");
            if (remoteTouched) {
              if (!draft.apiKey) delete draft.apiKey;
              const r = await fetch(API + "/api/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "saveTTS", tts: draft }),
              });
              const d = await r.json();
              if (!r.ok || d.error)
                throw new Error("TTS: " + (d.error || r.status));
              TTS_CFG = Object.assign(
                {
                  provider: "browser",
                  endpoint: "",
                  apiKey: "",
                  voice: "",
                  model: "",
                },
                d.tts || {},
              );
              if (!d.tts?.provider && TTS_CFG.endpoint)
                TTS_CFG.provider = "gradio";
              window.__ttsCfg = TTS_CFG;
              paintTTSForm(TTS_CFG);
            }
          }

          paintConfigForm(saved);
          setCfgStatus("tersimpan", "ok");
        } catch (e) {
          setCfgStatus("gagal: " + e.message, "err");
        } finally {
          cfgEls.btn.disabled = false;
        }
      });
    }

    if (cfgEls.test) {
      cfgEls.test.addEventListener("click", () => {
        const prev = state.modelConfig;

        state.modelConfig = normalizeModelConfig(
          Object.assign({}, prev, readConfigForm()),
        );
        // Provider remote → tes lewat server dengan nilai form yang belum
        // disimpan; provider browser → tes speechSynthesis seperti dulu.
        if (ttsFormRemoteActive()) {
          setCfgStatus("mengetes suara…");
          ttsTestRemote(readTTSForm())
            .then(() => setCfgStatus("tes suara ok", "ok"))
            .catch((e) => setCfgStatus("tes suara gagal: " + e.message, "err"));
          return;
        }
        try {
          browserTTS(
            "Halo, ini suara aku sekarang.",
            () => {
              state.modelConfig = prev;
            },
            null,
          );
        } catch (e) {
          state.modelConfig = prev;
          setCfgStatus("tes suara gagal: " + e.message, "err");
        }
      });
    }

    // ── Mesin Suara (TTS) — global, disimpan di config.json ──────
    const TTS_PROVIDERS = [
      "browser",
      "gradio",
      "openai",
      "elevenlabs",
      "gemini",
      "custom",
    ];
    // Provider yang butuh endpoint (gradio/openai/custom) vs cukup apiKey
    // (elevenlabs/gemini — endpoint bawaan). browser tak butuh apa pun.
    const TTS_NEEDS_ENDPOINT = { gradio: 1, openai: 1, custom: 1 };
    const TTS_NEEDS_KEY = { elevenlabs: 1, gemini: 1 };

    function readTTSForm() {
      return {
        provider: cfgEls.ttsProvider ? cfgEls.ttsProvider.value : "browser",
        endpoint: cfgEls.ttsEndpoint ? cfgEls.ttsEndpoint.value.trim() : "",
        apiKey: cfgEls.ttsKey ? cfgEls.ttsKey.value : "",
        voice: ttsVoiceValue(),
        model: ttsModelValue(),
        style: cfgEls.ttsStyle ? cfgEls.ttsStyle.value.trim() : "",
      };
    }

    // Voice/model bisa berupa dropdown (katalog tersedia) atau input bebas
    // (server tak menyediakan daftar, mis. OpenAI-compat tanpa /v1/audio/voices).
    function ttsVoiceValue() {
      if (!cfgEls.ttsVoice) return "";
      if (cfgEls.ttsVoiceFree && !cfgEls.ttsVoiceFree.hidden)
        return cfgEls.ttsVoiceFree.value.trim();
      return cfgEls.ttsVoice.value === "__free__"
        ? ""
        : cfgEls.ttsVoice.value;
    }
    function ttsModelValue() {
      if (!cfgEls.ttsModel) return "";
      if (cfgEls.ttsModelFree && !cfgEls.ttsModelFree.hidden)
        return cfgEls.ttsModelFree.value.trim();
      return cfgEls.ttsModel.value === "__free__"
        ? ""
        : cfgEls.ttsModel.value;
    }

    function ttsFormRemoteActive() {
      const p = cfgEls.ttsProvider ? cfgEls.ttsProvider.value : "browser";
      if (!p || p === "browser") return false;
      if (TTS_NEEDS_ENDPOINT[p]) return !!cfgEls.ttsEndpoint?.value.trim();
      if (TTS_NEEDS_KEY[p]) return !!cfgEls.ttsKey?.value.trim() || !!(TTS_CFG && TTS_CFG.apiKey);
      return false;
    }

    // ── Katalog voice/model dinamis dari /api/tts/options ────────
    let ttsOptionsSeq = 0;
    async function refreshTTSOptions() {
      const p = cfgEls.ttsProvider ? cfgEls.ttsProvider.value : "browser";
      const seq = ++ttsOptionsSeq;
      const remote = p !== "browser" && p !== "gradio" && p !== "custom";
      const needKey = !!TTS_NEEDS_KEY[p];
      // key yang dimask dipertahankan: kirim tanda supaya server pakai
      // yang tersimpan.
      const keyDraft = cfgEls.ttsKey ? cfgEls.ttsKey.value.trim() : "";
      const q = new URLSearchParams({ provider: p });
      if (needKey && keyDraft) q.set("apiKey", keyDraft);
      if (p === "openai" && cfgEls.ttsEndpoint)
        q.set("endpoint", cfgEls.ttsEndpoint.value.trim());
      let d = { voices: [], models: [], styles: [] };
      try {
        const r = await fetch(API + "/api/tts/options?" + q.toString());
        if (r.ok) d = await r.json();
      } catch (e) {}
      if (seq !== ttsOptionsSeq) return; // provider ganti lagi — buang hasil lama

      fillTTSSelect(
        cfgEls.ttsVoice,
        cfgEls.ttsVoiceFree,
        d.voices || [],
        (TTS_CFG && TTS_CFG.voice) || "",
        "voice bawaan provider",
      );
      fillTTSSelect(
        cfgEls.ttsModel,
        cfgEls.ttsModelFree,
        d.models || [],
        (TTS_CFG && TTS_CFG.model) || "",
        "model bawaan provider",
      );
      fillTTSStyleSelect(d.styles || []);
    }

    function fillTTSSelect(sel, freeInput, list, savedVal, freeLabel) {
      if (!sel) return;
      sel.textContent = "";
      if (list.length) {
        const def = document.createElement("option");
        def.value = "";
        def.textContent = "(pilih — " + freeLabel + ")";
        sel.appendChild(def);
        let savedListed = !savedVal;
        for (const it of list) {
          const o = document.createElement("option");
          o.value = it.id;
          o.textContent = it.name || it.id;
          if (savedVal && it.id === savedVal) savedListed = true;
          sel.appendChild(o);
        }
        if (savedVal && !savedListed) {
          const o = document.createElement("option");
          o.value = savedVal;
          o.textContent = savedVal + " (tersimpan)";
          sel.appendChild(o);
        }
        sel.value = savedVal || "";
        if (freeInput) freeInput.hidden = true;
      } else {
        // Tanpa katalog → mode input bebas (tetap fleksibel seperti dulu)
        const o = document.createElement("option");
        o.value = "__free__";
        o.textContent = "(isi manual →)";
        sel.appendChild(o);
        sel.value = "__free__";
        if (freeInput) {
          freeInput.hidden = false;
          if (savedVal) freeInput.value = savedVal;
        }
      }
    }

    function fillTTSStyleSelect(styles) {
      if (!cfgEls.ttsStylePick) return;
      const current = cfgEls.ttsStyle ? cfgEls.ttsStyle.value.trim() : "";
      const sel = cfgEls.ttsStylePick;
      sel.textContent = "";
      const def = document.createElement("option");
      def.value = "";
      def.textContent = "(default / netral)";
      sel.appendChild(def);
      const preset = styles || [];
      let curListed = !current;
      for (const s of preset) {
        const o = document.createElement("option");
        o.value = s;
        o.textContent = s.length > 52 ? s.slice(0, 52) + "…" : s;
        if (current && s === current) curListed = true;
        sel.appendChild(o);
      }
      if (current && !curListed) {
        const o = document.createElement("option");
        o.value = current;
        o.textContent = "Gaya tersimpan: " + current;
        sel.appendChild(o);
      }
      // Pilihan "tulis sendiri" selalu ada di bawah
      const free = document.createElement("option");
      free.value = "__free__";
      free.textContent = "Tulis gaya sendiri…";
      sel.appendChild(free);
      sel.value = current ? (curListed ? current : "__free__") : "";
      updateStyleFreeVisibility();
    }

    function updateStyleFreeVisibility() {
      if (!cfgEls.ttsStylePick || !cfgEls.ttsStyle) return;
      const freeMode = cfgEls.ttsStylePick.value === "__free__";
      cfgEls.ttsStyle.hidden = !freeMode;
      if (freeMode && !cfgEls.ttsStyle.value) cfgEls.ttsStyle.focus();
    }

    function paintTTSForm(cfg) {
      if (!cfgEls.ttsProvider) return;
      const p = TTS_PROVIDERS.indexOf(cfg.provider) >= 0 ? cfg.provider : "browser";
      cfgEls.ttsProvider.value = p;
      if (cfgEls.ttsEndpoint) cfgEls.ttsEndpoint.value = cfg.endpoint || "";
      if (cfgEls.ttsKey) {
        // apiKey dari server sudah dimask; placeholder menandakan "tersimpan, tidak berubah"
        cfgEls.ttsKey.value = "";
        cfgEls.ttsKey.placeholder = cfg.apiKey
          ? "tersimpan (" + cfg.apiKey + ") — kosongkan bila tetap"
          : "kosongkan bila tidak perlu";
      }
      if (cfgEls.ttsStyle) cfgEls.ttsStyle.value = cfg.style || "";
      paintTTSVisibility();
      refreshTTSOptions();
    }

    function paintTTSVisibility() {
      const p = cfgEls.ttsProvider ? cfgEls.ttsProvider.value : "browser";
      const remote = p !== "browser";
      const needKey = !!TTS_NEEDS_KEY[p];
      $$(".tts-remote-row").forEach((el) =>
        el.classList.toggle("hidden", !remote),
      );
      $$(".tts-key-row").forEach((el) =>
        el.classList.toggle("hidden", !needKey),
      );
      // Gemini & ElevenLabs pakai alamat resmi masing-masing — endpoint
      // disembunyikan supaya tidak membingungkan.
      $$(".tts-endpoint-row").forEach((el) =>
        el.classList.toggle("hidden", needKey),
      );
      // Gaya bicara hanya bermakna untuk Gemini & OpenAI gpt-4o-mini-tts
      $$(".tts-style-row").forEach((el) =>
        el.classList.toggle("hidden", p !== "gemini" && p !== "openai"),
      );
      if (cfgEls.ttsEndpoint) {
        cfgEls.ttsEndpoint.placeholder =
          p === "gradio"
            ? "mis. http://127.0.0.1:7860 (Gradio Space)"
            : p === "openai"
              ? "mis. http://127.0.0.1:8880 (base endpoint, tanpa /v1)"
              : p === "custom"
                ? "URL lengkap POST {text} → audio"
                : "opsional (default bawaan provider)";
      }
    }

    function ttsTestRemote(ttsDraft) {
      // apiKey kosong di form = tetap pakai yang tersimpan (sama seperti
      // pola connection update).
      const saved = TTS_CFG || {};
      const payload = Object.assign({}, ttsDraft);
      if (!payload.apiKey && saved.apiKey) payload.apiKey = saved.apiKey;
      return fetch(API + "/api/tts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tts: payload }),
      }).then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || "HTTP " + r.status);
      });
    }

    if (cfgEls.ttsProvider) {
      cfgEls.ttsProvider.addEventListener("change", () => {
        paintTTSVisibility();
        refreshTTSOptions();
      });
      if (cfgEls.ttsVoice)
        cfgEls.ttsVoice.addEventListener("change", () => {
          if (
            cfgEls.ttsVoiceFree &&
            cfgEls.ttsVoice.value !== "__free__"
          )
            cfgEls.ttsVoiceFree.hidden = true;
        });
      if (cfgEls.ttsModel)
        cfgEls.ttsModel.addEventListener("change", () => {
          if (
            cfgEls.ttsModelFree &&
            cfgEls.ttsModel.value !== "__free__"
          )
            cfgEls.ttsModelFree.hidden = true;
        });
      if (cfgEls.ttsStylePick)
        cfgEls.ttsStylePick.addEventListener("change", () => {
          updateStyleFreeVisibility();
          const v = cfgEls.ttsStylePick.value;
          // pilih preset → isi langsung ke input gaya; "__free__" biarkan user mengetik
          if (v && v !== "__free__" && cfgEls.ttsStyle)
            cfgEls.ttsStyle.value = v;
        });
      // Paint awal; loadAppConfig memanggil ulang lewat __paintTTSForm
      // begitu config dari server tiba.
      paintTTSForm(TTS_CFG);
      window.__paintTTSForm = paintTTSForm;
    }

    refreshConfigForm();

    (function initBehaviourPanel() {
      const els = {
        hidup: $('[data-profil="hidup"]'),
        sedang: $('[data-profil="sedang"]'),
        tenang: $('[data-profil="tenang"]'),
        profilStatus: $("#behaviour-profil-status"),
        idleSpeak: $("#beh-idleSpeak"),
        awaySpeak: $("#beh-awaySpeak"),
        returnSpeak: $("#beh-returnSpeak"),
        quietMs: $("#beh-quietMs"),
        idleMs: $("#beh-idleMs"),
        idleRepeatMs: $("#beh-idleRepeatMs"),
        quietOut: $("#beh-quietMs-out"),
        idleOut: $("#beh-idleMs-out"),
        repeatOut: $("#beh-idleRepeatMs-out"),
        save: $("#btn-beh-save"),
        saveStatus: $("#beh-save-status"),
        countdown: $("#beh-quiet-countdown"),
      };

      const PROFILES = {
        hidup: {
          quietMs: 15000,
          idleMs: 45000,
          idleRepeatMs: 90000,
          idleSpeak: true,
          awaySpeak: true,
          returnSpeak: true,
        },
        sedang: {
          quietMs: 60000,
          idleMs: 180000,
          idleRepeatMs: 300000,
          idleSpeak: true,
          awaySpeak: true,
          returnSpeak: true,
        },
        tenang: {
          quietMs: 1800000,
          idleMs: 1800000,
          idleRepeatMs: 1800000,
          idleSpeak: true,
          awaySpeak: true,
          returnSpeak: true,
        },
      };
      const fmtMs = (ms) => {
        ms = Math.max(0, Math.round(ms));
        if (ms < 1000) return "0 detik";
        const s = Math.round(ms / 1000);
        if (s < 60) return s + " detik";
        const m = Math.floor(s / 60),
          r = s % 60;
        if (m < 60) return r ? m + " mnt " + r + " dtk" : m + " mnt";
        const h = Math.floor(m / 60),
          mr = m % 60;
        return mr ? h + " jam " + mr + " mnt" : h + " jam";
      };

      window.__agentStartApprox = window.__agentStartApprox || Date.now();
      let countdownTimer = null;

      function paintForm() {
        const e = window.__appEvents || EVENTS;
        if (els.idleSpeak) els.idleSpeak.checked = !!e.idleSpeak;
        if (els.awaySpeak) els.awaySpeak.checked = !!e.awaySpeak;
        if (els.returnSpeak) els.returnSpeak.checked = !!e.returnSpeak;
        if (els.quietMs) {
          els.quietMs.value = Number(e.quietMs) || 0;
          els.quietOut.textContent = fmtMs(Number(e.quietMs) || 0);
        }
        if (els.idleMs) {
          els.idleMs.value = Number(e.idleMs) || 0;
          els.idleOut.textContent = fmtMs(Number(e.idleMs) || 0);
        }
        if (els.idleRepeatMs) {
          els.idleRepeatMs.value = Number(e.idleRepeatMs) || 0;
          els.repeatOut.textContent = fmtMs(Number(e.idleRepeatMs) || 0);
        }

        const match = (p) =>
          PROFILES[p] &&
          PROFILES[p].quietMs === (Number(e.quietMs) || 0) &&
          PROFILES[p].idleMs === (Number(e.idleMs) || 0) &&
          PROFILES[p].idleRepeatMs === (Number(e.idleRepeatMs) || 0);
        [
          ["hidup", els.hidup],
          ["sedang", els.sedang],
          ["tenang", els.tenang],
        ].forEach(([k, b]) => {
          if (b) b.classList.toggle("active", match(k));
        });
      }

      function readForm() {
        return {
          idleSpeak: !!(els.idleSpeak && els.idleSpeak.checked),
          awaySpeak: !!(els.awaySpeak && els.awaySpeak.checked),
          returnSpeak: !!(els.returnSpeak && els.returnSpeak.checked),
          quietMs: Number(els.quietMs && els.quietMs.value) || 0,
          idleMs: Number(els.idleMs && els.idleMs.value) || 0,
          idleRepeatMs: Number(els.idleRepeatMs && els.idleRepeatMs.value) || 0,
        };
      }

      function applyLive(ev) {
        Object.assign(EVENTS, ev);

        try {
          if (typeof resetAgentIdle === "function") resetAgentIdle();
        } catch (e) {}
        if (
          window.__agent &&
          typeof window.__agent.invalidateCapabilityProfile === "function"
        ) {
          /* no-op, kept for clarity */
        }

        window.__agentStartApprox = Date.now();
      }

      function setSaveStatus(msg, kind) {
        if (!els.saveStatus) return;
        els.saveStatus.textContent = msg;
        els.saveStatus.className = "note-status" + (kind ? " " + kind : "");
        if (kind === "ok") window.showToast?.("Pengaturan kelakuan tersimpan", "success");
        else if (kind === "err") window.showToast?.(msg, "error");
      }

      [
        ["hidup", els.hidup],
        ["sedang", els.sedang],
        ["tenang", els.tenang],
      ].forEach(([k, b]) => {
        if (!b) return;
        b.addEventListener("click", () => {
          const p = PROFILES[k];
          if (els.idleSpeak) els.idleSpeak.checked = !!p.idleSpeak;
          if (els.awaySpeak) els.awaySpeak.checked = !!p.awaySpeak;
          if (els.returnSpeak) els.returnSpeak.checked = !!p.returnSpeak;
          if (els.quietMs) {
            els.quietMs.value = p.quietMs;
            els.quietOut.textContent = fmtMs(p.quietMs);
          }
          if (els.idleMs) {
            els.idleMs.value = p.idleMs;
            els.idleOut.textContent = fmtMs(p.idleMs);
          }
          if (els.idleRepeatMs) {
            els.idleRepeatMs.value = p.idleRepeatMs;
            els.repeatOut.textContent = fmtMs(p.idleRepeatMs);
          }
          [
            ["hidup", els.hidup],
            ["sedang", els.sedang],
            ["tenang", els.tenang],
          ].forEach(([, x]) => x && x.classList.remove("active"));
          b.classList.add("active");
          if (els.profilStatus)
            els.profilStatus.textContent =
              'Profil "' +
              (k === "hidup" ? "Hidup" : k === "sedang" ? "Sedang" : "Tenang") +
              '" dipakai — tekan Simpan.';
        });
      });

      if (els.quietMs)
        els.quietMs.addEventListener("input", () => {
          els.quietOut.textContent = fmtMs(Number(els.quietMs.value));
        });
      if (els.idleMs)
        els.idleMs.addEventListener("input", () => {
          els.idleOut.textContent = fmtMs(Number(els.idleMs.value));
        });
      if (els.idleRepeatMs)
        els.idleRepeatMs.addEventListener("input", () => {
          els.repeatOut.textContent = fmtMs(Number(els.idleRepeatMs.value));
        });

      if (els.save) {
        els.save.addEventListener("click", async () => {
          els.save.disabled = true;
          setSaveStatus("menyimpan…");
          const ev = readForm();
          applyLive(ev);
          try {
            const r = await fetch(API + "/api/config", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "saveEvents", events: ev }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) throw new Error(d.error || "HTTP " + r.status);
            setSaveStatus("tersimpan", "ok");

            if (d.events) {
              Object.assign(EVENTS, d.events);
              paintForm();
            }
          } catch (e) {
            setSaveStatus("gagal: " + e.message, "err");
          } finally {
            els.save.disabled = false;
          }
        });
      }

      function tickCountdown() {
        const e = window.__appEvents || EVENTS;
        const q = Number(e.quietMs) || 0;
        const elapsed = Date.now() - (window.__agentStartApprox || Date.now());
        const left = q - elapsed;
        if (els.countdown) {
          if (left > 0)
            els.countdown.textContent =
              "Masa tenang: sisa " +
              fmtMs(left) +
              " (karakter belum bicara sendiri).";
          else
            els.countdown.textContent =
              "Masa tenang selesai — karakter bisa bereaksi sendiri.";
        }
      }
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(tickCountdown, 1000);
      tickCountdown();

      paintForm();
    })();

    (function initLiveStateIndicator() {
      const elP = $("#ls-presence"),
        elM = $("#ls-mood"),
        elQ = $("#ls-quiet");
      if (!elP || !elM || !elQ) return;
      const fmtMs = (ms) => {
        ms = Math.max(0, Math.round(ms));
        if (ms < 1000) return "0 dtk";
        const s = Math.round(ms / 1000);
        if (s < 60) return s + " dtk";
        const m = Math.floor(s / 60),
          r = s % 60;
        if (m < 60) return r ? m + " mnt " + r + " dtk" : m + " mnt";
        const h = Math.floor(m / 60),
          mr = m % 60;
        return mr ? h + " jam " + mr + " mnt" : h + " jam";
      };
      function render() {
        const st =
          window.__agent && typeof window.__agent._reactiveState === "function"
            ? window.__agent._reactiveState()
            : null;

        const p = st ? st.presenceState : null;
        elP.textContent =
          "👤 " + (p === true ? "hadir" : p === false ? "pergi" : "tidak tahu");

        const mood =
          st && st.userMood && st.userMood !== "normal"
            ? st.userMood
            : "netral";
        const src = st && st.moodSource ? " (" + st.moodSource + ")" : "";
        elM.textContent = "😶 mood: " + mood + src;

        const q = st ? Number(st.quietMs) || 0 : 0;
        const start = window.__agentStartApprox || Date.now();
        const left = q - (Date.now() - start);
        elQ.textContent =
          "⏳ masa tenang: " + (left > 0 ? "sisa " + fmtMs(left) : "selesai");
      }
      setInterval(render, 1000);
      render();
    })();

    const shEls = {
      summary: $("#sheet-summary"),
      cats: $("#sheet-cats"),
      list: $("#sheet-preset-list"),
      status: $("#sheet-status"),
      analyze: $("#btn-sheet-analyze"),
      reloadFile: $("#btn-sheet-reload-file"),
      reloadStatus: $("#reload-status"),
      name: $("#preset-name"),
      cat: $("#preset-cat"),
      capture: $("#btn-preset-capture"),
      captureInfo: $("#preset-capture-info"),
      values: $("#preset-values"),
      save: $("#btn-preset-save"),
      clear: $("#btn-preset-clear"),
      pStatus: $("#preset-status"),
    };

    let sheetCatFilter = "emosi";

    let draft = { values: {}, parts: {} };

    const presetSliders = $("#preset-param-sliders");
    const presetFreezeInfo = $("#preset-freeze-info");
    const presetStuckIds = new Set();

    if (presetSliders) {
      presetSliders.addEventListener("pointerdown", () =>
        freezeModelForEdit(presetFreezeInfo, true),
      );
    }

    const presetEditorPopup = $("#preset-editor-popup");
    const presetEditorCloseBtn = $("#preset-editor-close");
    const presetEditorOpenBtn = $("#btn-open-preset-editor");

    function openPresetEditor() {
      const sheet = state.lastSheet || loadCharacterSheet();
      paintDraft();
      renderPresetSliders(sheet);
      if (presetEditorPopup) {
        presetEditorPopup.classList.remove("hidden");
        presetEditorPopup.setAttribute("aria-hidden", "false");
      }
    }
    function closePresetEditor() {
      if (presetEditorPopup) {
        presetEditorPopup.classList.add("hidden");
        presetEditorPopup.setAttribute("aria-hidden", "true");
      }
      releasePresetPreview();
    }
    if (presetEditorOpenBtn)
      presetEditorOpenBtn.addEventListener("click", openPresetEditor);
    if (presetEditorCloseBtn)
      presetEditorCloseBtn.addEventListener("click", closePresetEditor);

    function setSheetStatus(msg, kind) {
      if (!shEls.status) return;
      shEls.status.textContent = msg;
      shEls.status.className = "note-status" + (kind ? " " + kind : "");
    }
    function setPresetStatus(msg, kind) {
      if (!shEls.pStatus) return;
      shEls.pStatus.textContent = msg;
      shEls.pStatus.className = "note-status" + (kind ? " " + kind : "");
    }

    function paintSheetSummary(sheet) {
      const box = shEls.summary;
      if (!box) return;
      box.textContent = "";
      if (!sheet) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent =
          "Belum ada sheet untuk model ini. Buka tab 📁 Model → Inspeksi Model.";
        box.appendChild(p);
        return;
      }
      const dl = document.createElement("dl");
      dl.className = "sheet-facts";
      const facts = [
        ["Model", sheet.modelName || "(tanpa nama)"],
        ["Parameter", String(sheet.paramCount || (sheet.params || []).length)],
        ["Parts", String((sheet.parts || []).length)],
        ["Emosi", String(Object.keys(sheet.supportedEmotions || {}).length)],
        ["Expression", String((sheet.nativeExpressions || []).length)],
        ["Motion group", String((sheet.motionGroups || []).length)],
        ["Skema", "v" + (sheet.schemaVersion || 0)],
      ];
      for (const [k, v] of facts) {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = v;
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      box.appendChild(dl);

      if (sheet.rangesEstimated) {
        const w = document.createElement("p");
        w.className = "hint sheet-warn";
        w.textContent =
          "⚠ Rentang parameter masih taksiran (" +
          (sheet.rangeSource || "estimated") +
          "). Inspeksi ulang model agar nilai preset akurat.";
        box.appendChild(w);
      }
    }

    function paintSheetCats(sheet) {
      const box = shEls.cats;
      if (!box) return;
      box.textContent = "";
      for (const cat of PRESET_CATEGORIES) {
        const n = resolvePresets(sheet, cat).length;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sheet-cat" + (cat === sheetCatFilter ? " active" : "");
        b.textContent = cat + " (" + n + ")";
        b.setAttribute("role", "tab");
        b.setAttribute(
          "aria-selected",
          cat === sheetCatFilter ? "true" : "false",
        );
        b.addEventListener("click", () => {
          sheetCatFilter = cat;
          const s = state.lastSheet || loadCharacterSheet();
          paintSheetCats(s);
          paintPresetList(s);
        });
        box.appendChild(b);
      }
    }

    function paintPresetList(sheet) {
      const box = shEls.list;
      if (!box) return;
      box.textContent = "";

      const resetRow = document.createElement("div");
      resetRow.className = "preset-reset-row";
      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "mini-btn";
      resetBtn.style.cssText = "width:auto;padding:4px 12px;font-size:11px";
      resetBtn.textContent = '🔄 Reset Pose';
      resetBtn.title =
        "Lepas semua pose preset yang sedang menempel (param, part, ekspresi) dan kembalikan kendali ke animasi idle.";
      resetBtn.addEventListener("click", () => {
        if (!state.model) {
          setSheetStatus("load model dulu", "err");
          return;
        }
        const n = releasePresetPose();
        setSheetStatus(
          n
            ? "pose dilepas (" + n + " target) — idle kembali"
            : "tidak ada pose preset yang menempel",
          n ? "ok" : "",
        );
      });
      resetRow.appendChild(resetBtn);
      const resetHint = document.createElement("span");
      resetHint.className = "preset-reset-hint";
      resetHint.textContent =
        "membatalkan semua Terap/Coba yang sedang menempel";
      resetRow.appendChild(resetHint);
      box.appendChild(resetRow);

      const items = resolvePresets(sheet, sheetCatFilter);
      if (!items.length) {
        const p = document.createElement("div");
        p.className = "preset-empty";
        p.textContent = 'Belum ada preset kategori "' + sheetCatFilter + '".';
        box.appendChild(p);
        return;
      }
      for (const p of items) {
        const row = document.createElement("div");

        const isAI = p.source === "ai";
        row.className = "preset-item" + (isAI ? " is-ai" : "");

        const nm = document.createElement("span");
        nm.className = "p-name";
        nm.textContent = p.name;
        if (p.renamedFrom)
          nm.title =
            'Otomatis diganti nama dari "' +
            p.renamedFrom +
            '" karena bentrok dengan motion bawaan.';
        row.appendChild(nm);

        const badge = document.createElement("span");
        badge.className = "p-badge";
        badge.textContent = isAI
          ? p.suggestion
            ? "🤖 tertutup"
            : "🤖 saran"
          : "👤";
        badge.title = isAI
          ? p.suggestion
            ? "Saran AI, tapi kamu sudah punya preset dengan nama sama — punyamu yang dipakai."
            : "Saran AI. Belum aktif sampai kamu tekan Pakai."
          : "Preset milikmu (aktif).";
        row.appendChild(badge);

        if (!isAI) {
          const applyBtn = document.createElement("button");
          applyBtn.type = "button";
          applyBtn.className = "p-act";
          applyBtn.textContent = "Terap";
          applyBtn.addEventListener("click", () => {
            if (!state.model) {
              setSheetStatus("load model dulu", "err");
              return;
            }
            releasePresetPreview();
            const ok = applyPreset(p, p.category);
            setSheetStatus(
              ok
                ? "diterapkan: " + p.name + " — batal via 🔄 Reset Pose"
                : "tidak ada target valid di preset ini",
              ok ? "ok" : "err",
            );
          });
          row.appendChild(applyBtn);

          const tryBtn = document.createElement("button");
          tryBtn.type = "button";
          tryBtn.className = "p-act";
          tryBtn.textContent = "Coba";
          tryBtn.title =
            "Pratinjau pose ini tanpa menguncinya sebagai preset aktif.";
          tryBtn.addEventListener("click", () => {
            if (!state.model) {
              setSheetStatus("load model dulu", "err");
              return;
            }
            releasePresetPreview();
            const ok = applyPreset(p, p.category);
            setSheetStatus(
              ok
                ? "pratinjau: " + p.name + " (batal via 🔄 Reset Pose)"
                : "tidak ada target valid di preset ini",
              ok ? "" : "err",
            );
          });
          row.appendChild(tryBtn);

          const editBtn = document.createElement("button");
          editBtn.type = "button";
          editBtn.className = "p-act";
          editBtn.textContent = "Edit";
          editBtn.addEventListener("click", () => {
            if (shEls.name) shEls.name.value = p.name;
            if (shEls.cat) shEls.cat.value = p.category;

            draft = {
              values: Object.assign({}, p.values || {}),
              parts: Object.assign({}, p.parts || {}),
            };
            paintDraft();
            renderPresetSliders(state.lastSheet || loadCharacterSheet());
            setPresetStatus("dimuat untuk diedit", "");
            openPresetEditor();
          });
          row.appendChild(editBtn);

          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "p-act danger";
          delBtn.textContent = "Hapus";
          delBtn.addEventListener("click", async () => {
            if (!confirm('Hapus preset "' + p.name + '" (' + p.category + ")?"))
              return;
            delBtn.disabled = true;
            setSheetStatus("menghapus…");
            try {
              await deleteUserPreset(p.category, p.name);
              setSheetStatus("dihapus: " + p.name, "ok");
              refreshSheetUI();
            } catch (e) {
              setSheetStatus("gagal: " + e.message, "err");
              delBtn.disabled = false;
            }
          });
          row.appendChild(delBtn);
        } else {
          const useBtn = document.createElement("button");
          useBtn.type = "button";
          useBtn.className = "p-act";
          useBtn.textContent = "Pakai";
          useBtn.addEventListener("click", async () => {
            useBtn.disabled = true;
            setSheetStatus("menyetujui saran…");
            try {
              await applyAISuggestion(p.category, p.name);
              setSheetStatus("saran dipakai: " + p.name, "ok");
              refreshSheetUI();
            } catch (e) {
              setSheetStatus("gagal: " + e.message, "err");
              useBtn.disabled = false;
            }
          });
          row.appendChild(useBtn);
        }
        box.appendChild(row);
      }
    }

    const pnPopup = $("#paramnotes-popup");
    const pnList = $("#paramnotes-popup-list");
    const pnOpenBtn = $("#btn-open-paramnotes");
    const pnCloseBtn = $("#pn-popup-close");
    const pnCountdown = $("#pn-countdown");
    const pnSaveAll = $("#pn-save-all");
    const pnSaveStatus = $("#pn-save-status");
    const pnSearch = $('#pn-search');
    let pnTimer = null;
    const pnStuckIds = new Set();

    function setPnStatus(row, msg, kind) {
      const el = row.querySelector(".pn-status");
      if (!el) return;
      el.textContent = msg || "";
      el.className = "pn-status" + (kind ? " " + kind : "");
    }

    function readAny(id, isPart) {
      try {
        const cm = coreModel();
        if (!cm) return null;
        const gm = cm.getModel ? cm.getModel() : cm;
        if (isPart)
          return typeof gm.getPartOpacityById === "function"
            ? gm.getPartOpacityById(id)
            : null;
        return typeof gm.getParameterValueById === "function"
          ? gm.getParameterValueById(id)
          : null;
      } catch (e) {
        return null;
      }
    }

    let _freezeStatusEl = null;
    let _freezeTimer = null;

    function freezeModelForEdit(statusEl, persistent) {
      state.frozen = true;
      const snap = (id) =>
        state.caps.params && state.caps.params.has(id) ? readParam(id) : 0;
      if (typeof state.aiPose === "object") {
        state.aiPose.ax = snap(roleId("angleX"));
        state.aiPose.ay = snap(roleId("angleY"));
        state.aiPose.ex = snap(roleId("eyeBallX"));
        state.aiPose.ey = snap(roleId("eyeBallY"));
        state.aiPose.bodyX = snap(roleId("bodyAngleX"));
        state.aiPose.bodyY = snap(roleId("bodyAngleY"));
        state.aiPose.bodyZ = snap(roleId("bodyAngleZ"));
        state.aiPose.mouthForm = snap(roleId("mouthForm"));
      }
      if (!state.aiLock) {
        state.aiLock = true;
      }
      const im = state.model && state.model.internalModel;
      if (im && !state._frozenRefs) {
        state._frozenRefs = {
          physics: im.physics,
          eyeBlink: im.eyeBlink,
          breath: im.breath,
        };
        try {
          im.motionManager.stopAllMotions();
        } catch (e) {}
        try {
          if (im.motionManager.expressionManager)
            im.motionManager.expressionManager.resetExpression();
        } catch (e) {}

        im.eyeBlink = null;
        im.breath = null;
        if (im.focusController) {
          im.focusController.x = 0;
          im.focusController.y = 0;
        }
      }
      _freezeStatusEl = statusEl || null;
      if (_freezeTimer) clearTimeout(_freezeTimer);
      if (_freezeStatusEl) {
        _freezeStatusEl.classList.add("frozen");
        _freezeStatusEl.textContent = persistent
          ? "❄ mode pose: model diam (idle/blink/napas dimatikan)"
          : "❄ dibekukan — gerak idle kembali dalam 10 dtk";
      }

      if (persistent) return;
      let remaining = 1000;
      const tickCountdown = () => {
        remaining--;
        if (remaining > 0) {
          if (_freezeStatusEl)
            _freezeStatusEl.textContent =
              "❄ dibekukan — gerak idle kembali dalam " + remaining + " dtk";
          _freezeTimer = setTimeout(tickCountdown, 1000);
        } else {
          unfreezeModelForEdit();
        }
      };
      _freezeTimer = setTimeout(tickCountdown, 1000);
    }

    function unfreezeModelForEdit() {
      if (_freezeTimer) {
        clearTimeout(_freezeTimer);
        _freezeTimer = null;
      }
      const im = state.model && state.model.internalModel;
      if (im && state._frozenRefs) {
        im.physics = state._frozenRefs.physics;
        im.eyeBlink = state._frozenRefs.eyeBlink;
        im.breath = state._frozenRefs.breath;
        state._frozenRefs = null;
      }
      state.frozen = false;
      if (state.aiLock) state.aiLock = false;
      if (_freezeStatusEl) {
        _freezeStatusEl.classList.remove("frozen");
        _freezeStatusEl.textContent = "✓ gerak idle aktif kembali";
      }
      _freezeStatusEl = null;
    }

    editorFreezeApi = {
      freeze: freezeModelForEdit,
      unfreeze: unfreezeModelForEdit,
    };

    function renderParamNotesPopup(sheet) {
      if (!pnList) return;
      pnList.textContent = "";
      const params = (sheet && sheet.params) || [];
      const parts = (sheet && sheet.parts) || [];
      if (!params.length && !parts.length) {
        const p = document.createElement("div");
        p.className = "pn-empty";
        p.textContent =
          "Belum ada sheet. Buka tab 📁 Model → Inspeksi Model dulu.";
        pnList.appendChild(p);
        return;
      }

      const groups = [];
      const byGroup = new Map();
      for (const p of params) {
        if (
          !p ||
          !p.id ||
          typeof p.min !== "number" ||
          typeof p.max !== "number"
        )
          continue;
        const g = resolveParamGroup(state.lastSheet || {}, p.id, p.group);
        if (!byGroup.has(g)) {
          byGroup.set(g, []);
          groups.push(g);
        }
        byGroup.get(g).push(p);
      }

      for (const g of groups) {
        const members = byGroup.get(g);
        appendGroupHeader(pnList, g, members.length);
        for (const p of members) {
          const shownLabel =
            p.label && p.label !== p.id ? p.label + " · " + p.id : p.id;
          appendNoteRow(
            pnList,
            p.id,
            shownLabel,
            g,
            p.min,
            p.max,
            p.def,
            false,
            typeof p.userNote === "string" ? p.userNote : "",
          );
        }
      }
      if (parts.length) {
        appendGroupHeader(pnList, 'Bagian (Parts)', parts.length);
        for (const p of parts) {
          if (!p || !p.id) continue;
          appendNoteRow(
            pnList,
            p.id,
            p.id,
            "Bagian (Parts)",
            0,
            1,
            typeof p.def === "number" ? p.def : 1,
            true,
            "",
          );
        }
      }
      applyPnFilter();
    }

    function applyPnFilter() {
      if (!pnList) return;
      const q = ((pnSearch && pnSearch.value) || "").trim().toLowerCase();
      let visible = 0;
      const rows = Array.prototype.slice.call(
        pnList.querySelectorAll(".pn-row"),
      );
      for (const row of rows) {
        const noteEl = row.querySelector(".pn-input");
        const hay =
          (row.dataset.hay || "") + " " + (noteEl ? noteEl.value : "");
        const show = !q || hay.toLowerCase().includes(q);
        row.classList.toggle("pn-hidden", !show);
        if (show) visible++;
      }
      let header = null,
        anyInGroup = false;
      for (const el of pnList.children) {
        if (el.classList.contains('pn-group-header')) {
          if (header) header.classList.toggle('pn-hidden', !anyInGroup);
          header = el;
          anyInGroup = false;
        } else if (!el.classList.contains("pn-hidden")) {
          anyInGroup = true;
        }
      }
      if (header) header.classList.toggle('pn-hidden', !anyInGroup);
      let empty = pnList.querySelector(".pn-empty-search");
      if (q && !visible) {
        if (!empty) {
          empty = document.createElement("div");
          empty.className = "pn-empty pn-empty-search";
          pnList.prepend(empty);
        }
        empty.textContent = 'Tidak ada param yang cocok dengan "' + q + '".';
      } else if (empty) empty.remove();
    }

    function appendGroupHeader(list, title, count) {
      const h = document.createElement("div");
      h.className = 'pn-group-header';
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = title;
      const c = document.createElement("span");
      c.className = "c";
      c.textContent = count + ' param';
      h.appendChild(t);
      h.appendChild(c);
      list.appendChild(h);
      return h;
    }

    function appendNoteRow(
      list,
      id,
      label,
      group,
      min,
      max,
      def,
      isPart,
      note,
    ) {
      const cur = readAny(id, isPart);
      const startVal = cur != null && Number.isFinite(cur) ? cur : def;
      const resolvedGroup = resolveParamGroup(state.lastSheet || {}, id, group);
      const { row } = buildParamSliderRow({
        id,
        label,

        group: "",
        min,
        max,
        def,
        isPart,
        value: startVal,
        onInput: (id, v, isPart) => {
          if (isPart) window.__live2dAgent.setPartOpacity(id, v);
          else window.__live2dAgent.setParameter(id, v);
          pnStuckIds.add(id);
          freezeModelForEdit(pnCountdown);
        },
        onCommit: () => {
          unfreezeMaybe();
        },
      });
      row.classList.toggle("saved", !!note.trim());
      row.dataset.id = id;
      row.dataset.part = isPart ? "1" : "";

      row.dataset.hay = (id + " " + label + " " + resolvedGroup).toLowerCase();

      const input = document.createElement("textarea");
      input.className = "pn-input";
      input.rows = 1;
      input.maxLength = 300;
      input.placeholder = 'Jelaskan fungsi param ini, mis. "skala pupil kiri"';
      input.value = note;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          input.blur();
        }
      });
      input.addEventListener("input", () => {
        const cnt = row.querySelector(".pn-count");
        if (cnt) cnt.textContent = input.value.length + "/300";
        row.classList.toggle("saved", input.value.trim().length > 0);
        if (pnTimer) clearTimeout(pnTimer);
        pnTimer = setTimeout(() => commitPn(row, id, input.value), 500);
      });
      input.addEventListener("blur", () => {
        if (pnTimer) {
          clearTimeout(pnTimer);
          pnTimer = null;
        }
        commitPn(row, id, input.value);
      });
      row.appendChild(input);

      const meta = document.createElement("div");
      meta.className = "pn-meta";
      const cnt = document.createElement("span");
      cnt.className = "pn-count";
      cnt.textContent = input.value.length + "/300";
      const st = document.createElement("span");
      st.className = "pn-status";
      meta.appendChild(cnt);
      meta.appendChild(st);
      row.appendChild(meta);

      list.appendChild(row);
    }

    function fmtNum(n) {
      const x = Number(n);
      if (!Number.isFinite(x)) return "0";
      return (
        (Math.abs(x) >= 100 ? x.toFixed(1) : x.toFixed(2)).replace(
          /\.?0+$/,
          "",
        ) || "0"
      );
    }

    function buildParamSliderRow(opts) {
      const id = opts.id,
        label = opts.label || id,
        group = opts.group || "";
      const min = opts.min,
        max = opts.max,
        def = opts.def;
      const isPart = !!opts.isPart;
      const startVal =
        opts.value != null && Number.isFinite(opts.value) ? opts.value : def;

      const row = document.createElement("div");
      row.className = "pn-row";

      const head = document.createElement("div");
      head.className = "pn-head";
      const idEl = document.createElement("span");
      idEl.className = "pn-id";
      idEl.textContent = label;
      head.appendChild(idEl);
      if (group) {
        const gEl = document.createElement("span");
        gEl.className = "pn-group";
        gEl.textContent = "· " + group;
        head.appendChild(gEl);
      }
      row.appendChild(head);

      const sliderRow = document.createElement("div");
      sliderRow.className = "pn-slider-row";
      const range = document.createElement("input");
      range.type = "range";
      range.className = "pn-range";
      range.min = String(min);
      range.max = String(max);
      range.step = "any";
      range.value = String(startVal);
      const valEl = document.createElement("span");
      valEl.className = "pn-val";
      valEl.textContent =
        fmtNum(startVal) + "  [" + fmtNum(min) + ".." + fmtNum(max) + "]";
      sliderRow.appendChild(range);
      sliderRow.appendChild(valEl);
      row.appendChild(sliderRow);

      range.addEventListener("input", () => {
        const v = Number(range.value);
        valEl.textContent =
          fmtNum(v) + "  [" + fmtNum(min) + ".." + fmtNum(max) + "]";
        if (opts.onInput) opts.onInput(id, v, isPart);
      });
      range.addEventListener("change", () => {
        if (opts.onCommit) opts.onCommit(id, Number(range.value), isPart);
      });

      return { row, range, valEl };
    }

    function unfreezeMaybe() {
      if (state.frozen) freezeModelForEdit(pnCountdown);
    }

    async function commitPn(row, paramId, value) {
      const api = window.__live2dAgent && window.__live2dAgent.sheet;
      if (!api || !api.saveParamNote) return;
      try {
        await api.saveParamNote(paramId, value);
        setPnStatus(row, "tersimpan", "ok");
      } catch (e) {
        setPnStatus(row, "gagal: " + e.message, "err");
      }
    }

    async function saveAllParamNotes() {
      if (pnTimer) {
        clearTimeout(pnTimer);
        pnTimer = null;
      }
      const rows = pnList ? Array.from(pnList.querySelectorAll(".pn-row")) : [];
      let count = 0,
        failed = 0;
      for (const row of rows) {
        const id = row.dataset && row.dataset.id;
        if (!id) continue;
        const ta = row.querySelector(".pn-input");
        const val = ta ? ta.value : "";
        try {
          const api = window.__live2dAgent && window.__live2dAgent.sheet;
          if (!api || !api.saveParamNote)
            throw new Error("API sheet tidak tersedia");
          await api.saveParamNote(id, val);
          count++;
        } catch (e) {
          failed++;
          setPnStatus(row, "gagal: " + e.message, "err");
        }
      }
      if (pnSaveStatus) {
        if (failed) {
          pnSaveStatus.textContent = count + " tersimpan, " + failed + " gagal";
          pnSaveStatus.className = "note-status err";
        } else {
          pnSaveStatus.textContent = count + " catatan tersimpan";
          pnSaveStatus.className = "note-status ok";
        }
      }
    }

    function openParamNotesPopup() {
      const sheet = state.lastSheet || loadCharacterSheet();
      if (!sheet || (!sheet.params && !sheet.parts)) {
        if (window.__addChat)
          window.__addChat(
            "agent",
            "Belum ada sheet. Inspeksi model dulu (tab 📁 Model → 🔍 Inspeksi Model).",
          );
        return;
      }

      if (!state.visfxMap) state.visfxMap = visfxLoad();
      renderParamNotesPopup(sheet);
      if (pnPopup) {
        pnPopup.classList.remove("hidden");
        pnPopup.setAttribute("aria-hidden", "false");
      }
    }

    function closeParamNotesPopup() {
      if (pnPopup) {
        pnPopup.classList.add("hidden");
        pnPopup.setAttribute("aria-hidden", "true");
      }

      for (const id of pnStuckIds) {
        try {
          delete state.overrides[id];
        } catch (e) {}
      }
      pnStuckIds.clear();
      unfreezeModelForEdit();
    }

    if (pnOpenBtn) pnOpenBtn.addEventListener("click", openParamNotesPopup);
    if (pnSearch) pnSearch.addEventListener('input', applyPnFilter);

    window.__pnRefreshIfOpen = () => {
      if (pnPopup && !pnPopup.classList.contains("hidden") && state.lastSheet) {
        renderParamNotesPopup(state.lastSheet);
      }
    };
    if (pnCloseBtn) pnCloseBtn.addEventListener("click", closeParamNotesPopup);
    if (pnSaveAll) pnSaveAll.addEventListener("click", saveAllParamNotes);

    function paintDraft() {
      const box = shEls.values;
      if (!box) return;
      box.textContent = "";
      const rows = Object.entries(draft.values)
        .map(([k, v]) => [k, v, "param"])
        .concat(Object.entries(draft.parts).map(([k, v]) => [k, v, "part"]));
      if (!rows.length) {
        const p = document.createElement("div");
        p.className = "preset-empty";
        p.textContent =
          "Belum ada nilai. Geser slider di atas, atau tekan 📸 Ambil Pose Sekarang untuk memulai dari pose live.";
        box.appendChild(p);
        return;
      }
      for (const [id, v, kind] of rows) {
        const r = document.createElement("div");
        r.className = "pv-row";
        const a = document.createElement("span");
        a.textContent = (kind === "part" ? "◧ " : "") + id;
        a.title = kind === "part" ? "Part (opacity)" : "Parameter";
        const b = document.createElement("span");
        b.textContent = Number(v).toFixed(2);
        r.appendChild(a);
        r.appendChild(b);
        box.appendChild(r);
      }
    }

    function releasePresetPreview() {
      for (const id of presetStuckIds) {
        try {
          delete state.overrides[id];
        } catch (e) {}
      }
      presetStuckIds.clear();
      unfreezeModelForEdit();
    }

    function renderPresetSliders(sheet) {
      if (!presetSliders) return;
      presetSliders.textContent = "";
      const params = (sheet && sheet.params) || [];
      const parts = (sheet && sheet.parts) || [];
      if (!params.length && !parts.length) {
        const p = document.createElement("div");
        p.className = "pn-empty";
        p.textContent = "Belum ada sheet. Inspeksi model dulu.";
        presetSliders.appendChild(p);
        return;
      }
      for (const p of params) {
        if (
          !p ||
          !p.id ||
          typeof p.min !== "number" ||
          typeof p.max !== "number"
        )
          continue;
        const dflt = Number.isFinite(p.def) ? p.def : 0;
        const live = readAny(p.id, false);
        const startVal =
          draft.values[p.id] != null
            ? draft.values[p.id]
            : live != null && Number.isFinite(live)
              ? live
              : dflt;
        const { row } = buildParamSliderRow({
          id: p.id,
          label: p.label && p.label !== p.id ? p.label + " · " + p.id : p.id,
          group: resolveParamGroup(sheet, p.id, p.group),
          min: p.min,
          max: p.max,
          def: dflt,
          isPart: false,
          value: startVal,
          onInput: (id, v) => {
            if (Math.abs(v - dflt) > 1e-3)
              draft.values[id] = Number(v.toFixed(3));
            else delete draft.values[id];
            window.__live2dAgent.setParameter(id, v);
            presetStuckIds.add(id);
            freezeModelForEdit(presetFreezeInfo, true);
            paintDraft();
          },
          onCommit: () => {
            if (state.frozen) freezeModelForEdit(presetFreezeInfo, true);
          },
        });
        presetSliders.appendChild(row);
      }
      for (const p of parts) {
        if (!p || !p.id) continue;
        const dflt = typeof p.def === "number" ? p.def : 1;
        const live = readAny(p.id, true);
        const startVal =
          draft.parts[p.id] != null
            ? draft.parts[p.id]
            : live != null && Number.isFinite(live)
              ? live
              : dflt;
        const { row } = buildParamSliderRow({
          id: p.id,
          label: p.id,
          group: "Bagian (Parts)",
          min: 0,
          max: 1,
          def: dflt,
          isPart: true,
          value: startVal,
          onInput: (id, v) => {
            if (Math.abs(v - dflt) > 1e-3)
              draft.parts[id] = Number(v.toFixed(3));
            else delete draft.parts[id];
            window.__live2dAgent.setPartOpacity(id, v);
            presetStuckIds.add(id);
            freezeModelForEdit(presetFreezeInfo, true);
            paintDraft();
          },
          onCommit: () => {
            if (state.frozen) freezeModelForEdit(presetFreezeInfo, true);
          },
        });
        presetSliders.appendChild(row);
      }
    }

    function captureCurrentPose() {
      const sheet = state.lastSheet || loadCharacterSheet();
      if (!sheet)
        return { ok: false, message: "Belum ada sheet. Inspeksi model dulu." };
      if (!state.model) return { ok: false, message: "Load model dulu." };
      const values = {};
      let skipped = 0;
      for (const p of sheet.params || []) {
        if (!p || !p.id) continue;
        const cur = readParam(p.id);
        const def = Number.isFinite(p.def) ? p.def : 0;

        if (Math.abs(cur - def) > 1e-3) values[p.id] = Number(cur.toFixed(3));
        else skipped++;
      }
      const parts = {};
      const cm = coreModel();
      const gm = cm && cm.getModel ? cm.getModel() : cm;
      for (const pt of sheet.parts || []) {
        const id = pt && pt.id ? pt.id : pt;
        if (!id) continue;
        let cur = null;
        try {
          if (gm && typeof gm.getPartOpacityById === "function")
            cur = gm.getPartOpacityById(id);
        } catch (e) {
          cur = null;
        }
        if (cur === null || !Number.isFinite(cur)) continue;
        const def = pt && Number.isFinite(pt.def) ? pt.def : 1;
        if (Math.abs(cur - def) > 1e-3) parts[id] = Number(cur.toFixed(3));
      }
      return { ok: true, values, parts, skipped };
    }

    if (shEls.capture) {
      shEls.capture.addEventListener("click", () => {
        const res = captureCurrentPose();
        if (!res.ok) {
          if (shEls.captureInfo) {
            shEls.captureInfo.textContent = res.message;
            shEls.captureInfo.className = "note-status err";
          }
          return;
        }
        draft = { values: res.values, parts: res.parts };
        paintDraft();
        renderPresetSliders(state.lastSheet || loadCharacterSheet());
        freezeModelForEdit(presetFreezeInfo, true);
        const n =
          Object.keys(res.values).length + Object.keys(res.parts).length;
        if (shEls.captureInfo) {
          shEls.captureInfo.textContent = n
            ? n + " nilai diambil (" + res.skipped + " param default dilewati)"
            : "model masih di pose default — tidak ada yang diambil";
          shEls.captureInfo.className = "note-status" + (n ? " ok" : "");
        }
      });
    }

    if (shEls.clear) {
      shEls.clear.addEventListener("click", () => {
        draft = { values: {}, parts: {} };
        if (shEls.name) shEls.name.value = "";
        releasePresetPreview();
        paintDraft();
        renderPresetSliders(state.lastSheet || loadCharacterSheet());
        setPresetStatus("editor dikosongkan", "");
        if (shEls.captureInfo) {
          shEls.captureInfo.textContent = "";
          shEls.captureInfo.className = "note-status";
        }
      });
    }

    if (shEls.name && shEls.cat) {
      const preflight = () => {
        if (shEls.cat.value !== "gerak") {
          setPresetStatus("");
          return;
        }
        const nm = shEls.name.value.trim();
        if (!nm) {
          setPresetStatus("");
          return;
        }
        const chk = checkGerakName(nm, state.lastSheet);
        if (!chk.ok)
          setPresetStatus(
            chk.message + ' Usul: "' + chk.suggestion + '"',
            "err",
          );
        else setPresetStatus("nama boleh dipakai", "ok");
      };
      shEls.name.addEventListener("input", preflight);
      shEls.cat.addEventListener("change", preflight);
    }

    if (shEls.save) {
      shEls.save.addEventListener("click", async () => {
        const name = shEls.name ? shEls.name.value.trim() : "";
        const category = shEls.cat ? shEls.cat.value : "properti";
        if (!name) {
          setPresetStatus("nama preset wajib diisi", "err");
          return;
        }

        if (category === "gerak") {
          setPresetStatus(
            "kategori gerak butuh keyframe (steps) — belum didukung editor ini",
            "err",
          );
          return;
        }
        if (
          !Object.keys(draft.values).length &&
          !Object.keys(draft.parts).length
        ) {
          setPresetStatus(
            "belum ada nilai — tekan 📸 Ambil Pose Sekarang",
            "err",
          );
          return;
        }
        shEls.save.disabled = true;
        setPresetStatus("menyimpan…");
        try {
          const saved = await saveUserPreset({
            name,
            category,
            values: draft.values,
            parts: draft.parts,
          });
          setPresetStatus("tersimpan: " + saved.name, "ok");
          sheetCatFilter = saved.category;
          releasePresetPreview();
          refreshSheetUI();
        } catch (e) {
          setPresetStatus("gagal: " + e.message, "err");
        } finally {
          shEls.save.disabled = false;
        }
      });
    }

    if (shEls.analyze) {
      shEls.analyze.addEventListener("click", async () => {
        shEls.analyze.disabled = true;
        setSheetStatus("menganalisa… (bisa belasan detik)", "busy");

        const [labels, presets] = await Promise.allSettled([
          triggerAIParamClassification(),
          analyzeSheetPresets(),
        ]);
        try {
          const parts = [];
          if (presets.status === "fulfilled") {
            const n =
              presets.value && presets.value.count ? presets.value.count : 0;
            parts.push(
              n ? n + " saran preset (🤖)" : "tidak ada saran preset baru",
            );
          } else {
            parts.push("preset gagal: " + presets.reason.message);
          }
          if (labels.status === "fulfilled") {
            const n =
              labels.value && labels.value.count ? labels.value.count : 0;
            if (n) parts.push(n + " parameter dilabeli");
          } else {
            parts.push("label gagal: " + labels.reason.message);
          }
          const bad =
            presets.status === "rejected" || labels.status === "rejected";
          setSheetStatus(parts.join(" · "), bad ? "err" : "ok");
          refreshSheetUI();
        } finally {
          shEls.analyze.disabled = false;
        }
      });
    }

    if (shEls.reloadFile) {
      shEls.reloadFile.addEventListener("click", async () => {
        shEls.reloadFile.disabled = true;
        try {
          const sheet = await fetchSheetFile();
          if (!sheet) {
            shEls.reloadStatus.textContent = "tidak ada file sheet di server";
            shEls.reloadStatus.className = "note-status err";
            return;
          }
          if (!sheet.presets || typeof sheet.presets !== "object")
            sheet.presets = { user: [], ai: [] };
          state.lastSheet = sheet;
          try {
            localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
          } catch (e) {}
          hydrateCaps(sheet);
          draft = { values: {}, parts: {} };
          refreshSheetUI();
          if (
            presetEditorPopup &&
            !presetEditorPopup.classList.contains("hidden")
          ) {
            paintDraft();
            renderPresetSliders(sheet);
          }
          shEls.reloadStatus.textContent = "dimuat ulang dari file ✓";
          shEls.reloadStatus.className = "note-status ok";
        } catch (e) {
          shEls.reloadStatus.textContent = "gagal: " + e.message;
          shEls.reloadStatus.className = "note-status err";
        } finally {
          shEls.reloadFile.disabled = false;
        }
      });
    }

    const adEls = {
      list: $("#adoption-list"),
      save: $("#btn-adoption-save"),
      status: $("#adoption-status"),
    };
    let adDisabled = new Set();

    refreshSheetUI = () => {
      const sheet = state.lastSheet || loadCharacterSheet();
      paintSheetSummary(sheet);
      paintSheetCats(sheet);
      paintPresetList(sheet);

      if (pnPopup && !pnPopup.classList.contains("hidden"))
        renderParamNotesPopup(sheet);
      paintDraft();
      renderPresetSliders(sheet);
      loadAdoption();
    };
    refreshSheetUI();

    function currentModelFolder() {
      const parts = String(state.modelPath || "").split("/");
      return parts.length >= 2 ? parts[1] : null;
    }

    async function loadAdoption() {
      if (!adEls.list) return;
      const folder = currentModelFolder();
      if (!folder) {
        setAdoptionMsg("Load model dulu.", "");
        return;
      }
      try {
        const r = await fetch(
          API +
            "/api/model/expressions-adoption?name=" +
            encodeURIComponent(folder),
        );
        if (!r.ok) throw new Error("HTTP " + r.status);
        const info = await r.json();
        const exprs = Array.isArray(info.expressions) ? info.expressions : [];
        adDisabled = new Set(Array.isArray(info.disabled) ? info.disabled : []);
        if (!exprs.length) {
          setAdoptionMsg("Tidak ada .exp3 di folder ini.", "");
          return;
        }
        adEls.list.textContent = "";
        for (const e of exprs) {
          const row = document.createElement("div");
          row.className = "preset-item" + (e.declared ? " is-ai" : "");
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = !!e.enabled;
          cb.id = "adopt_" + e.Name;
          cb.addEventListener("change", () => {
            if (cb.checked) adDisabled.delete(e.Name);
            else adDisabled.add(e.Name);
          });
          const lbl = document.createElement("label");
          lbl.className = "p-name";
          lbl.htmlFor = cb.id;
          lbl.textContent = e.Name + (e.declared ? " (terdaftar)" : " (yatim)");
          row.appendChild(cb);
          row.appendChild(lbl);

          const testBtn = document.createElement("button");
          testBtn.type = "button";
          testBtn.className = "p-act";
          testBtn.textContent = '👁 tes';
          testBtn.title =
            "Pasang ekspresi ini di model untuk melihat efeknya (ekspresi berikutnya otomatis menggantikan).";
          testBtn.addEventListener("click", () => {
            if (!state.model) {
              setAdoptionMsg("Load model dulu.", "err");
              return;
            }
            window.__live2dAgent.setExpression(e.Name, 1);
            setSheetStatus("ekspresi dipasang: " + e.Name, "");
          });
          row.appendChild(testBtn);
          adEls.list.appendChild(row);
        }
      } catch (e) {
        setAdoptionMsg("Gagal muat: " + e.message, "err");
      }
    }

    function setAdoptionMsg(msg, kind) {
      if (!adEls.list) return;
      adEls.list.textContent = "";
      const d = document.createElement("div");
      d.className = "preset-empty" + (kind ? " " + kind : "");
      d.textContent = msg;
      adEls.list.appendChild(d);
    }

    if (adEls.save) {
      adEls.save.addEventListener("click", async () => {
        adEls.save.disabled = true;
        if (adEls.status) {
          adEls.status.textContent = "menyimpan…";
          adEls.status.className = "note-status";
        }
        const folder = currentModelFolder();
        if (!folder) {
          if (adEls.status) adEls.status.textContent = "load model dulu";
          adEls.save.disabled = false;
          return;
        }
        try {
          const r = await fetch(API + "/api/model/expressions-adoption", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: folder,
              disabled: Array.from(adDisabled),
            }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || "HTTP " + r.status);
          if (adEls.status) {
            adEls.status.textContent =
              "tersimpan (" + adDisabled.size + " dimatikan)";
            adEls.status.className = "note-status ok";
          }

          if (state.model) {
            try {
              await loadModel(state.modelPath);
            } catch (e) {
              console.warn("[adoption] reload failed:", e.message);
            }
          }
        } catch (e) {
          if (adEls.status) {
            adEls.status.textContent = "gagal: " + e.message;
            adEls.status.className = "note-status err";
          }
        } finally {
          adEls.save.disabled = false;
        }
      });
    }

    loadConns();

    let pollBusy = false;
    setInterval(async () => {
      if (pollBusy || document.hidden) return;
      pollBusy = true;
      try {
        const r = await fetch(API + "/api/config");
        const d = await r.json();
        if (connSig(d.connections || [], d.activeId) !== lastConnSig)
          renderConns(d.connections || [], d.activeId);
      } catch {}
      pollBusy = false;
    }, 4000);
  }

  const SHEET_SCHEMA_VERSION = 4;

  const USER_AUTHORED_FIELDS = ['userNote', 'config', 'paramGroups', 'presets'];

  const PRESET_CATEGORIES = ["emosi", "properti", "aksesoris", "gerak"];

  // Bounds for the SEMANTIC pose fields used by a 'gerak' preset's steps.
  //
  // ±30 for bodyX/bodyY/bodyZ is DELIBERATE and matches applyActions() in
  // agent.js — see the long comment there. Do not narrow either one to ±20
  // without changing both: the whole point is that a preset the user designed
  // and a directive the LLM emitted obey the same limit.
  const STEP_FIELD_BOUNDS = {
    ax: 30,
    ay: 30,
    bodyX: 30,
    bodyY: 30,
    bodyZ: 30,
    ex: 1,
    ey: 1,
    mouthForm: 1,
  };

  const STEP_MS_MIN = 40;
  const STEP_MS_MAX = 3000;
  const STEP_COUNT_MAX = 12;
  const STEP_TOTAL_MS_MAX = 8000;

  const MODEL_CONFIG_DEFAULTS = {
    blink: true,
    idle: true,
    framing: "upper",
    ttsRate: 1,
    ttsPitch: 1.15,
    ttsLang: "id-ID",

    displayName: "",

    bgColor: "",
    bgImage: "",
    bgDim: 0.45,
  };

  const FRAMING_MODES = ["upper", "full"];

  const TTS_RATE_RANGE = { min: 0.5, max: 2 };
  const TTS_PITCH_RANGE = { min: 0, max: 2 };

  state.modelConfig = Object.assign({}, MODEL_CONFIG_DEFAULTS);

  wireUI();

  (async () => {
    const q = new URLSearchParams(location.search).get("model");
    if (q) {
      try {
        const r = await fetch(
          API + "/api/model/path?name=" + encodeURIComponent(q),
        );
        if (r.ok) {
          const d = await r.json();
          if (d.path) {
            await loadModel(d.path);
            return;
          }
        }
      } catch (e) {
        console.warn("[boot] ?model load failed, using default", e);
      }
    }

    let names = [];
    try {
      const r = await fetch(API + "/api/models");
      const d = await r.json();
      names = Array.isArray(d.models) ? d.models : [];
    } catch (e) {
      console.warn("[boot] model list failed", e);
    }
    if (!names.length) {
      showNoModelState();
      return;
    }

    let pick = names[0];
    try {
      const last = localStorage.getItem("live2d_last_model");
      if (last && names.includes(last)) pick = last;
    } catch (e) {
      /* localStorage bisa terlarang — pakai model pertama */
    }
    try {
      const r = await fetch(
        API + "/api/model/path?name=" + encodeURIComponent(pick),
      );
      if (r.ok) {
        const d = await r.json();
        if (d.path) {
          await loadModel(d.path);
          return;
        }
      }
    } catch (e) {
      console.warn("[boot] last/default load failed", e);
    }
    loadModel();
  })();

  app.ticker.add(() => {
    if (state.model && !$("#loader").classList.contains("done")) {
      $("#loader").classList.add("done");
      setTimeout(() => {
        $("#loader").classList.add("fade-out");
        setTimeout(() => $("#loader").classList.add("hidden"), 650);
      }, 600);
    }
  });

  const GESTURE_LIBRARY = {
    nod: [
      { d: { ay: -8 }, ms: 160 },
      { d: { ay: 6 }, ms: 160 },
      { d: { ay: -5 }, ms: 140 },
      { d: {}, ms: 160 },
    ],
    shake: [
      { d: { ax: -10 }, ms: 150 },
      { d: { ax: 10 }, ms: 150 },
      { d: { ax: -7 }, ms: 140 },
      { d: {}, ms: 160 },
    ],
    tilt_curious: [
      { d: { bodyZ: 10, ax: 6, ex: 0.15 }, ms: 260 },
      { d: { bodyZ: 8, ax: 5 }, ms: 500 },
    ],
    lean_excited: [
      { d: { bodyY: -6, ay: -6 }, ms: 180 },
      { d: { bodyY: 3, ay: 2 }, ms: 220 },
      { d: {}, ms: 260 },
    ],
    recoil_surprised: [
      { d: { ay: -12, bodyY: 6, ex: -0.1, ey: -0.15 }, ms: 140 },
      { d: { ay: -4 }, ms: 260 },
      { d: {}, ms: 300 },
    ],
    look_away_shy: [
      { d: { ax: -14, ex: -0.35, ay: 6 }, ms: 320 },
      { d: { ax: -8, ex: -0.2 }, ms: 500 },
    ],
    laugh_bounce: [
      { d: { ay: -6, bodyY: -5 }, ms: 120 },
      { d: { ay: 4, bodyY: 3 }, ms: 120 },
      { d: { ay: -4, bodyY: -3 }, ms: 120 },
      { d: { ay: 2, bodyY: 2 }, ms: 120 },
      { d: {}, ms: 160 },
    ],
    think: [
      { d: { bodyZ: -8, ax: -5, ay: 4, ex: -0.2, ey: -0.1 }, ms: 300 },
      { d: { bodyZ: -6, ax: -4 }, ms: 700 },
    ],
    wave_hi: [
      { d: { ax: 8, ay: -4, bodyX: 4 }, ms: 200 },
      { d: { ax: -6 }, ms: 200 },
      { d: { ax: 4 }, ms: 200 },
      { d: {}, ms: 200 },
    ],
  };

  const EMOTION_GESTURE = {
    senang: "lean_excited",
    sedih: "look_away_shy",
    malu: "look_away_shy",
    kaget: "recoil_surprised",
    normal: "nod",
  };

  const haveMotionSystem =
    typeof MotionRegistry !== "undefined" &&
    typeof MotionRuntime !== "undefined" &&
    typeof MotionDSL !== "undefined";
  const motionRegistry = haveMotionSystem
    ? MotionRegistry.createRegistry()
    : null;
  if (haveMotionSystem)
    motionRegistry.registerGestureLibrary(GESTURE_LIBRARY, EMOTION_GESTURE);

  let motionApplied = {};
  const POSE_FIELDS = {
    ax: 1,
    ay: 1,
    ex: 1,
    ey: 1,
    bodyX: 1,
    bodyY: 1,
    bodyZ: 1,
    mouthForm: 1,
  };
  function unwindMotionDelta() {
    const P = state.aiPose;
    for (const k in motionApplied) {
      if (motionApplied[k]) P[k] = (P[k] || 0) - motionApplied[k];
    }
    motionApplied = {};
  }
  const motionBridge = haveMotionSystem
    ? {
        now: () => performance.now(),
        getPoseBase: () => {
          const P = state.aiPose;
          return {
            ax: P.ax || 0,
            ay: P.ay || 0,
            ex: P.ex || 0,
            ey: P.ey || 0,
            bodyX: P.bodyX || 0,
            bodyY: P.bodyY || 0,
            bodyZ: P.bodyZ || 0,
            mouthForm: P.mouthForm || 0,
          };
        },
        getSupports: () => {
          const s = new Set();
          if (state.caps.hasHead) s.add("head");
          if (state.caps.hasEyes) s.add("eyes");
          if (state.caps.hasMouth) s.add("mouth");
          if (state.caps.hasBody) s.add("body");
          return s;
        },

        getOwnedParams: () => (state.caps && state.caps.params) || null,
        readParam: (id) => readParam(id),

        applyParamDrive: (vals) => setRawDrive(vals),
        releaseParamDrive: (ids) => {
          if (!ids || !ids.length) return;
          const patch = {};
          for (const id of ids) patch[id] = null;
          setRawDrive(patch);
        },
        applyPoseDelta: (d) => {
          unwindMotionDelta();
          const P = state.aiPose;
          for (const k in d) {
            if (!POSE_FIELDS[k] || !d[k]) continue;
            P[k] = (P[k] || 0) + d[k];
            motionApplied[k] = d[k];
          }
        },
        clearPoseDelta: unwindMotionDelta,
        playNative: (g) => {
          try {
            state.model.motion(g, -1, 2);

            state.clipStartedAt = performance.now();
            state.clipUntil = state.clipStartedAt + 2200 + 250;
            state.clipName = g;
            state.impulse = Math.min(1.0, state.impulse + 0.3);
          } catch (e) {
            console.warn("[motion] native play failed:", g, e.message);
          }
        },
      }
    : null;
  const motionRuntime = haveMotionSystem
    ? MotionRuntime.createRuntime(motionRegistry, motionBridge)
    : null;

  async function initMotionRegistry() {
    if (!haveMotionSystem || !state.model) return;
    const groups = (state.caps && state.caps.motionGroups) || [];
    const meta = {};
    const T = state.motionTaxonomy;
    if (T && T.clipMeta) {
      for (const c of Object.values(T.clipMeta)) {
        if (!c || !c.group || meta[c.group]) continue;
        meta[c.group] = {
          duration: c.duration && c.duration > 0 ? c.duration : 2,
          tags: c.verb ? [c.verb] : [],
        };
      }
    }
    motionRegistry.registerNativeGroups(groups, meta);

    try {
      const key = characterSheetKey().replace("live2d_sheet_", "");
      const r = await fetch(
        API + "/api/motions?model=" + encodeURIComponent(key),
      );
      if (!r.ok) return;
      const data = await r.json();
      const kept = [];
      for (const a of data.motions || []) {
        if (!motionRegistry.has(a.id)) {
          kept.push(a);
          continue;
        }
        console.warn(
          '[motion] "' + a.id + '" bentrok dengan entri bawaan — dilewati',
        );
      }
      const n = motionRegistry.replaceUserMotions(kept);
      if (n) console.log("[motion] registry:", n, "user motion(s) dimuat");
    } catch (e) {
      /* server mati / belum ada folder: registry tetap berisi builtin+native */
    }
  }

  const PRESET_MOTION_PREFIX = "preset_";
  const presetMotionCache = new Map();
  function playStepsViaRuntime(name, steps) {
    if (!haveMotionSystem) return false;
    const sig = JSON.stringify(steps);
    let hit = presetMotionCache.get(name);
    if (!hit || hit.sig !== sig) {
      const totalMs = steps.reduce((s, st) => s + ((st && st.ms) || 0), 0);
      const r = MotionDSL.sanitizeMotionAsset(
        {
          id:
            PRESET_MOTION_PREFIX +
            name.replace(/[^A-Za-z0-9_\-]/g, "_").slice(0, 48),
          name,
          source: "builtin",
          type: "gesture",
          aiEnabled: false,
          description: "Preset gerak: " + name,
          duration: Math.max(0.2, totalMs / 1000),
          tracks: MotionDSL.stepsToTracks(steps),
        },
        { requireTracks: true, source: "builtin" },
      );
      if (!r.ok) {
        console.warn("[motion] preset", name, "ditolak:", r.errors.join("; "));
        return false;
      }
      hit = { sig, asset: r.asset };
      presetMotionCache.set(name, hit);
    }
    motionRegistry.register(hit.asset, { overwrite: true });
    return motionRuntime.play(hit.asset.id, { priority: 60 });
  }

  function legacyPlaySteps(steps) {
    const P = state.aiPose;
    const base = {
      ax: P.ax || 0,
      ay: P.ay || 0,
      ex: P.ex || 0,
      ey: P.ey || 0,
      bodyX: P.bodyX || 0,
      bodyY: P.bodyY || 0,
      bodyZ: P.bodyZ || 0,
      mouthForm: P.mouthForm || 0,
    };
    const myToken = ++gestureToken;
    let t = 0;
    for (const step of steps) {
      setTimeout(() => {
        if (myToken !== gestureToken) return;
        const d = step.d || {};
        for (const k in base) P[k] = base[k] + (d[k] || 0);
        state.impulse = Math.min(1.0, state.impulse + 0.22);
      }, t);
      t += step.ms;
    }
  }

  function findPreset(name, category) {
    if (!name || typeof name !== "string") return null;
    const sheet = state.lastSheet;
    if (!sheet || !sheet.presets) return null;
    const want = name.trim().toLowerCase();
    for (const branch of ['user', 'ai']) {
      const list = sheet.presets[branch] || [];
      for (const p of list) {
        if (category && p.category !== category) continue;
        if (p.name.toLowerCase() === want) return p;
      }
    }
    return null;
  }

  function findGerakPreset(name) {
    return findPreset(name, "gerak");
  }

  // ── Gesture namespace: collision prevention at the point of CREATION ────
  //
  // playGesture() resolves in the order: native motion group → user 'gerak'
  // preset → GESTURE_LIBRARY. That order is deliberate and stays: a model's own
  // .motion3.json groups are INTRINSIC data, the same class as .exp3 native
  // expressions — not an "AI suggestion" that a user preset is allowed to beat.
  // The user must never lose access to the model's real motions.
  //
  // The user > ai precedence rule does NOT apply here: that rule is for two
  // sources competing for the SAME slot (presets.user vs presets.ai). Native
  // motion is a different namespace entirely.
  //
  // So instead of letting either side win a name fight, we make the fight
  // impossible: a 'gerak' preset may not be SAVED under a name that already
  // resolves to something else. Then both remain callable, under distinct names,
  // and no lookup is ever silently shadowed.
  //
  // Both spellings of a motion group are reserved because playGesture() strips
  // the prefix — a preset called "motion_Idle" would be swallowed by the group
  // "Idle" just as surely as one called "Idle".
  //
  // GESTURE_LIBRARY names are reserved for the same reason in the opposite
  // direction: a preset IS checked before the builtin table, so allowing the
  // name "nod" would shadow the builtin verb that agent.js advertises to the
  // LLM in every prompt. Same silent-shadowing bug, mirrored.
  function reservedGestureNames(sheet) {
    const s = sheet || state.lastSheet || {};
    const out = new Map();
    for (const k of Object.keys(GESTURE_LIBRARY)) {
      out.set(k.toLowerCase(), { kind: "builtin", display: k });
    }

    for (const g of Array.isArray(s.motionGroups) ? s.motionGroups : []) {
      if (!g) continue;
      const disp = String(g);
      out.set(disp.toLowerCase(), { kind: "motion", display: disp });
      out.set(("motion_" + disp).toLowerCase(), {
        kind: "motion",
        display: "motion_" + disp,
      });
    }
    return out;
  }

  function checkGerakName(name, sheet) {
    const clean = String(name == null ? "" : name)
      .trim()
      .slice(0, 60);
    if (!clean)
      return {
        ok: false,
        code: "empty",
        message: "Nama preset tidak boleh kosong.",
      };
    const hit = reservedGestureNames(sheet).get(clean.toLowerCase());
    if (hit) {
      return {
        ok: false,
        code: hit.kind === "motion" ? "motion-group" : "builtin-gesture",
        conflictWith: hit.display,
        message:
          hit.kind === "motion"
            ? 'Nama "' +
              clean +
              '" sudah dipakai motion bawaan model ("' +
              hit.display +
              '"). Pilih nama lain.'
            : 'Nama "' +
              clean +
              '" sudah dipakai gerakan bawaan aplikasi ("' +
              hit.display +
              '"). Pilih nama lain.',
        suggestion: suggestGerakName(clean, sheet),
      };
    }
    return { ok: true, name: clean };
  }

  function suggestGerakName(name, sheet) {
    const base =
      String(name == null ? "" : name)
        .trim()
        .slice(0, 55) || "Gerak";
    const reserved = reservedGestureNames(sheet);
    const s = sheet || state.lastSheet || {};
    const mine = new Set(
      ((s.presets || {}).user || [])
        .filter(
          (p) => p && p.category === "gerak" && typeof p.name === "string",
        )
        .map((p) => p.name.toLowerCase()),
    );
    const taken = (n) =>
      reserved.has(n.toLowerCase()) || mine.has(n.toLowerCase());
    if (!taken(base)) return base;
    for (let i = 2; i <= 99; i++) {
      const cand = base + " " + i;
      if (!taken(cand)) return cand;
    }
    return base + " " + Date.now();
  }

  function deshadowGerakPresets(sheet) {
    if (!sheet || !sheet.presets || !Array.isArray(sheet.presets.user))
      return sheet;
    const reserved = reservedGestureNames(sheet);
    if (!reserved.size) return sheet;
    for (const p of sheet.presets.user) {
      if (!p || p.category !== "gerak" || typeof p.name !== "string") continue;
      const hit = reserved.get(p.name.toLowerCase());
      if (!hit) continue;
      const from = p.name;
      p.name = suggestGerakName(from, sheet);
      p.renamedFrom = from;
      console.warn(
        '[sheet] gerak preset "' +
          from +
          '" collided with ' +
          (hit.kind === "motion" ? "native motion group" : "builtin gesture") +
          ' "' +
          hit.display +
          '" — renamed to "' +
          p.name +
          '"',
      );
    }
    return sheet;
  }

  async function sheetForWrite() {
    let sheet = state.lastSheet || loadCharacterSheet();
    if (!sheet) sheet = await fetchSheetFile();
    if (!sheet) {
      if (!state.model)
        throw new Error("Load model dulu sebelum menyimpan preset.");
      sheet = inspectModel();
      if (!sheet) throw new Error("Gagal membuat character sheet.");
    }
    if (!sheet.presets) sheet.presets = { user: [], ai: [] };
    if (!Array.isArray(sheet.presets.user)) sheet.presets.user = [];
    if (!Array.isArray(sheet.presets.ai)) sheet.presets.ai = [];
    return sheet;
  }

  async function persistSheet(sheet) {
    sheet.schemaVersion = SHEET_SCHEMA_VERSION;
    state.lastSheet = sheet;

    let localOk = true;
    try {
      localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
    } catch (e) {
      localOk = false;
      console.warn("[sheet] localStorage save failed:", e.message);
    }

    const res = await fetch(API + "/api/sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName: sheet.modelName, sheet }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(
        (detail.error || "server HTTP " + res.status) +
          (localOk ? " (tersimpan lokal saja)" : ""),
      );
    }
    try {
      window.__agent &&
        window.__agent.invalidateCapabilityProfile &&
        window.__agent.invalidateCapabilityProfile();
    } catch (e) {}
    return sheet;
  }

  async function saveUserPreset(input) {
    const p = normalizePreset(input, "user");
    if (!p) throw new Error("Preset tidak valid (nama wajib ada).");

    const sheet = await sheetForWrite();

    if (p.category === "gerak") {
      const verdict = checkGerakName(p.name, sheet);
      if (!verdict.ok) {
        const err = new Error(verdict.message);
        err.code = verdict.code;
        err.suggestion = verdict.suggestion;
        throw err;
      }
    }

    const list = sheet.presets.user;
    const at = list.findIndex(
      (x) =>
        x.category === p.category &&
        x.name.toLowerCase() === p.name.toLowerCase(),
    );
    if (at === -1) list.push(p);
    else list[at] = p;

    projectEmotionPresets(sheet);
    await persistSheet(sheet);
    return p;
  }

  async function deleteUserPreset(category, name) {
    const sheet = await sheetForWrite();
    const want = String(name || "")
      .trim()
      .toLowerCase();
    const at = sheet.presets.user.findIndex(
      (x) => x.category === category && x.name.toLowerCase() === want,
    );
    if (at === -1) return false;
    const [gone] = sheet.presets.user.splice(at, 1);

    if (gone.category === "emosi") {
      if (sheet.supportedEmotions) delete sheet.supportedEmotions[gone.name];
      if (state.supportedEmotions) delete state.supportedEmotions[gone.name];
    }
    await persistSheet(sheet);
    return true;
  }

  async function applyAISuggestion(category, name) {
    const sheet = await sheetForWrite();
    const want = String(name || "")
      .trim()
      .toLowerCase();
    const src = sheet.presets.ai.find(
      (x) => x.category === category && x.name.toLowerCase() === want,
    );
    if (!src) throw new Error('Saran AI "' + name + '" tidak ditemukan.');

    return saveUserPreset(Object.assign({}, src, { source: "user" }));
  }

  const presetPoseParams = new Set();
  const presetPoseParts = new Map();

  function releasePresetPose() {
    if (!state.model) return 0;
    let released = 0;
    for (const id of presetPoseParams) {
      if (id in state.overrides) { try { delete state.overrides[id]; released++; } catch (e) {} }
    }
    presetPoseParams.clear();
    if (presetPoseParts.size) {
      try {
        const cm = state.model.internalModel.coreModel;
        const gm = (cm && cm.getModel) ? cm.getModel() : null;
        const partDefs = new Map(((state.lastSheet && state.lastSheet.parts) || [])
          .map((p) => [(p && p.id) || p, typeof p.def === "number" ? p.def : 1]));
        for (const [id, prev] of presetPoseParts) {
          const v = (prev != null && Number.isFinite(prev)) ? prev
            : (partDefs.has(id) ? partDefs.get(id) : 1);
          try { cm.setPartOpacityById(id, Math.max(0, Math.min(1, v))); released++; } catch (e) {}
        }
      } catch (e) {}
      presetPoseParts.clear();
    }
    resetEmotion();
    state.activeProperty = "default";
    return released;
  }

  function applyPreset(nameOrPreset, category) {
    if (!state.model) return false;
    const preset =
      typeof nameOrPreset === "string"
        ? findPreset(nameOrPreset, category)
        : nameOrPreset;
    if (!preset) return false;

    if (preset.category === 'gerak') { playGesture(preset.name); return true; }

    const sheet = state.lastSheet || {};
    const byId = new Map(
      (sheet.params || []).filter((p) => p && p.id).map((p) => [p.id, p]),
    );
    const partIds = new Set(
      (sheet.parts || []).map((p) => (p && p.id) || p).filter(Boolean),
    );

    let applied = 0;
    for (const [id, raw] of Object.entries(preset.values || {})) {
      const meta = byId.get(id);
      if (!meta) continue;
      const lo = Number.isFinite(meta.min) ? meta.min : -1;
      const hi = Number.isFinite(meta.max) ? meta.max : 1;
      setSticky(id, Math.max(lo, Math.min(hi, Number(raw))), 1);
      presetPoseParams.add(id);
      applied++;
    }
    for (const [id, raw] of Object.entries(preset.parts || {})) {
      if (!partIds.has(id)) continue;
      const v = Math.max(0, Math.min(1, Number(raw)));
      try {
        const cm = state.model.internalModel.coreModel;
        if (!presetPoseParts.has(id)) {
          let prev = null;
          try {
            const gm = cm && cm.getModel ? cm.getModel() : null;
            if (gm && typeof gm.getPartOpacityById === "function")
              prev = gm.getPartOpacityById(id);
          } catch (e) {}
          presetPoseParts.set(id, prev);
        }
        cm.setPartOpacityById(id, v);
        applied++;
      } catch (e) {
        /* part vanished with a model swap — ignore */
      }
    }
    state.impulse = Math.min(1.0, state.impulse + 0.25);
    console.log(
      "[preset] applied",
      preset.category + ":" + preset.name,
      "(" + applied + " targets, source=" + preset.source + ")",
    );
    return applied > 0;
  }

  function projectEmotionPresets(sheet) {
    if (!sheet || !sheet.presets) return;
    if (
      !sheet.supportedEmotions ||
      typeof sheet.supportedEmotions !== "object" ||
      Array.isArray(sheet.supportedEmotions)
    )
      sheet.supportedEmotions = {};

    const builtin = state.roleEmotions || {};

    const userNames = new Set(
      (sheet.presets.user || [])
        .filter((p) => p.category === "emosi")
        .map((p) => p.name),
    );
    for (const name in EMOTION_ROLE_TEMPLATES) {
      if (!userNames.has(name)) delete sheet.supportedEmotions[name];
      if (state.supportedEmotions && !userNames.has(name))
        delete state.supportedEmotions[name];
    }
    for (const name in builtin) sheet.supportedEmotions[name] = builtin[name];
    for (const p of (sheet.presets.user || [])) {
      if (p.category !== "emosi") continue;
      sheet.supportedEmotions[p.name] = p.values || {};
    }
    if (state.supportedEmotions) {
      Object.assign(state.supportedEmotions, sheet.supportedEmotions);
    }
  }

  let gestureToken = 0;

  function playNativeGroup(g) {
    if (haveMotionSystem && motionRuntime.play("motion_" + g, { priority: 90 }))
      return;
    try {
      state.model.motion(g, -1, 2);
      state.impulse = Math.min(1.0, state.impulse + 0.3);
    } catch (e) {
      console.warn("[Live2D] Failed to play native motion:", e);
    }
  }

  function playGesture(name) {
    if (!state.model || !name) return;

    if (typeof name === "string") {
      const g = name.replace(/^motion_/, "");
      if (state.caps && state.caps.motionGroups && state.caps.motionGroups.includes(g)) {
        playNativeGroup(g);
        return;
      }
    }

    const preset = findGerakPreset(name);
    const steps = preset ? sanitizeSteps(preset.steps) : GESTURE_LIBRARY[name];
    if (steps && steps.length) {
      if (!preset && haveMotionSystem && motionRegistry.has(name)) {
        if (motionRuntime.play(name, { priority: 60 })) return;
      }
      if (!(haveMotionSystem && playStepsViaRuntime(name, steps)))
        legacyPlaySteps(steps);
      return;
    }

    if (haveMotionSystem && motionRegistry.has(name))
      motionRuntime.play(name, { priority: 60 });
  }

  function applyRawDrive() {
    const d = state.rawDrive;
    if (!d) return;
    const cm = coreModel();
    if (!cm) return;
    state._rawDriveTicks = (state._rawDriveTicks || 0) + 1;
    const wrote = {};
    for (const id in d) {
      let v = d[id];
      if (!Number.isFinite(v)) continue;
      const r = state.paramRange && state.paramRange[id];
      if (r) v = Math.max(r.min, Math.min(r.max, v));
      wrote[id] = v;
      try {
        cm.setParameterValueById(id, v, 1);
      } catch (e) {}
    }
    state._rawDriveLast = wrote;
  }

  function setRawDrive(patch) {
    if (!patch || typeof patch !== "object") return;
    if (!state.rawDrive) state.rawDrive = {};
    if (!state.rawDrivePrev) state.rawDrivePrev = {};
    for (const id in patch) {
      const v = patch[id];
      if (v == null) {
        if (id in state.rawDrivePrev) {
          try {
            const cm = coreModel();
            if (cm) cm.setParameterValueById(id, state.rawDrivePrev[id], 1);
          } catch (e) {}
          delete state.rawDrivePrev[id];
        }
        delete state.rawDrive[id];
      } else if (Number.isFinite(Number(v))) {
        if (!(id in state.rawDrivePrev)) state.rawDrivePrev[id] = readParam(id);
        state.rawDrive[id] = Number(v);
      }
    }
    if (!Object.keys(state.rawDrive).length) state.rawDrive = null;
    applyRawDrive();
  }
  function clearRawDrive() {
    const prev = state.rawDrivePrev;
    if (prev) {
      const cm = coreModel();
      for (const id in prev) {
        try {
          if (cm) cm.setParameterValueById(id, prev[id], 1);
        } catch (e) {}
      }
    }
    state.rawDrive = null;
    state.rawDrivePrev = null;
  }

  function listModelParams() {
    const sheet = state.lastSheet;
    if (sheet && Array.isArray(sheet.params) && sheet.params.length) {
      return sheet.params
        .map((p) => ({
          id: p.id,
          label: p.label || p.id,
          group: resolveParamGroup(sheet, p.id, p.group),
          min: Number(p.min),
          max: Number(p.max),
          def: Number(p.def),
          userNote: p.userNote || "",
          estimated: !!p.estimated,
        }))
        .filter((p) => Number.isFinite(p.min) && Number.isFinite(p.max));
    }
    const out = [];
    const cm = coreModel();
    if (!cm) return out;

    try {
      const gm = cm.getModel ? cm.getModel() : cm;
      const P = gm && gm.parameters;
      if (P && P.ids && P.ids.length) {
        for (let i = 0; i < P.ids.length; i++) {
          const id = P.ids[i];
          if (!id) continue;
          out.push({
            id,
            label: id,
            group: "Lainnya",
            min: Number(P.minimumValues[i]),
            max: Number(P.maximumValues[i]),
            def: Number(P.defaultValues[i]),
            userNote: '',
            estimated: false,
          });
        }
      } else if (
        typeof gm.getParameterCount === "function" &&
        typeof gm.getParameterIds === "function"
      ) {
        const ids = gm.getParameterIds();
        const mins = gm.getParameterMinimumValues();
        const maxs = gm.getParameterMaximumValues();
        const defs = gm.getParameterDefaultValues();
        for (let i = 0; i < gm.getParameterCount(); i++) {
          const id = ids[i];
          if (!id) continue;
          out.push({
            id,
            label: id,
            group: "Lainnya",
            min: Number(mins[i]),
            max: Number(maxs[i]),
            def: Number(defs[i]),
            userNote: '',
            estimated: false,
          });
        }
      }
    } catch (e) {
      console.warn("[params] enumerasi langsung gagal:", e.message);
    }
    return out.filter((p) => Number.isFinite(p.min) && Number.isFinite(p.max));
  }

  window.__live2dAgent = {
    speak,
    setExpression: applyExpression,

    setAccessory: (paramIdOrName, val) => {
      const preset = findPreset(paramIdOrName, 'aksesoris');
      if (preset) return applyPreset(preset);
      return toggleAccessory(paramIdOrName, val);
    },
    applyPreset,
    findPreset,
    setParameter: (id, v) => {
      setSticky(id, v, 1);
    },

    setPartOpacity: (id, v) => {
      const cm = coreModel();
      if (!cm) return;
      const val = Number(v);
      if (!Number.isFinite(val)) return;
      const clamped = Math.max(0, Math.min(1, val));
      state.overrides[id] = clamped;
      try {
        cm.setPartOpacityById(id, clamped);
      } catch (e) {}
    },
    isReady: () => !!state.model,
    getMouth: () => {
      const mId = roleId("mouthOpenY");
      return mId && state.overrides[mId] != null
        ? state.overrides[mId]
        : state.mouthRest;
    },
    frameModel,
    zoom: setScaleAroundCenter,
    _getSupportedEmotions: () => state.supportedEmotions || {},

    getExpressibleEmotions: () => {
      const out = {};
      const add = (name, via) => {
        if (name && !out[name]) out[name] = via;
      };
      for (const k of Object.keys(state.supportedEmotions || {}))
        add(k, "param");
      for (const n of state.modelExpressions || []) add(n, "native");
      const T = state.motionTaxonomy;
      if (T && T.byVerb && typeof MotionTaxonomy !== "undefined") {
        const EV = MotionTaxonomy.EMOTION_VERBS || {};
        for (const emo of Object.keys(EV)) {
          if (emo === "normal") continue;
          const hasClip = EV[emo].some((v) => (T.byVerb[v] || []).length > 0);
          if (hasClip) add(emo, "clip");
        }
      }
      return out;
    },

    expressEmotion: (name) => {
      if (!state.model || !name) return null;
      const via = window.__live2dAgent.getExpressibleEmotions()[name];
      if (!via) return null;
      if (via === "param" || via === "native") {
        applyExpression(name);
        return via;
      }
      return playEmotionClip(name) ? "clip" : null;
    },

    lockAI: () => {
      state.aiLock = true;
      state.fidgetT = 0;
      state.fidgetSeed = Math.random() * 1000;

      const readSafe = (id) =>
        state.caps.params && state.caps.params.has(id) ? readParam(id) : 0;
      state.aiPose = {
        ax: readParam(roleId("angleX") || "ParamAngleX"),
        ay: readParam(roleId("angleY") || "ParamAngleY"),
        ex: readParam(roleId("eyeBallX") || "ParamEyeBallX"),
        ey: readParam(roleId("eyeBallY") || "ParamEyeBallY"),
        mouthForm: readParam(roleId("mouthForm") || "ParamMouthForm"),
        bodyX: readSafe(roleId("bodyAngleX") || "ParamBodyAngleX"),
        bodyY: readSafe(roleId("bodyAngleY") || "ParamBodyAngleY"),
        bodyZ: readSafe(roleId("bodyAngleZ") || "ParamBodyAngleZ"),
        breath: 0.45,
      };

      startGestureScheduler();
      console.log("[Live2D] AI lock ON — user interaction paused");
    },
    unlockAI: () => {
      state.aiLock = false;

      stopGestureScheduler();

      state.look.tax = state.look.tay = 0;
      state.look.tex = state.look.tey = 0;

      resetEmotion();
      console.log("[Live2D] AI lock OFF — user control restored");
    },

    setAIPose: (pose) => {
      if (!pose || typeof pose !== "object") return;
      const P = state.aiPose;
      if (pose.head) {
        if (pose.head.x != null) P.ax = pose.head.x;
        if (pose.head.y != null) P.ay = pose.head.y;
      }
      if (pose.eyes) {
        if (pose.eyes.x != null) P.ex = pose.eyes.x;
        if (pose.eyes.y != null) P.ey = pose.eyes.y;
      }
      if (pose.mouth) {
        if (pose.mouth.form != null) P.mouthForm = pose.mouth.form;
      }
      if (pose.body) {
        if (pose.body.x != null) P.bodyX = pose.body.x;
        if (pose.body.y != null) P.bodyY = pose.body.y;
        if (pose.body.z != null) P.bodyZ = pose.body.z;
      }

      state.impulse = Math.min(1.0, state.impulse + 0.3);
      state.energyBoost = Math.min(0.9, state.energyBoost + 0.22);
    },

    playGesture,
    gestureNames: () => Object.keys(GESTURE_LIBRARY),

    playMotion: (id, opts) =>
      haveMotionSystem ? motionRuntime.play(id, opts) : false,
    stopMotion: (id) => (haveMotionSystem ? motionRuntime.stop(id) : false),
    stopAllMotions: () => {
      if (haveMotionSystem) motionRuntime.stopAll();
    },
    getActiveMotion: () =>
      haveMotionSystem ? motionRuntime.getActive() : null,

    registerUserMotion: (asset) => {
      if (!haveMotionSystem)
        return { ok: false, error: "modul motion tidak termuat" };
      const r = MotionDSL.sanitizeMotionAsset(asset, {
        requireTracks: true,
        source: "user",
      });
      if (!r.ok) return { ok: false, error: r.errors.join("; ") };
      if (motionRegistry.has(r.asset.id)) {
        const prev = motionRegistry.get(r.asset.id);
        if (prev.source !== "user")
          return {
            ok: false,
            error: 'nama "' + r.asset.id + '" dipakai entri ' + prev.source,
          };
      }
      motionRegistry.register(r.asset, { overwrite: true });
      return { ok: true, asset: r.asset };
    },
    removeUserMotion: (id) =>
      haveMotionSystem ? motionRegistry.remove(id, "user") : false,
    listRegistryMotions: () => (haveMotionSystem ? motionRegistry.list() : []),

    modelKey: currentModelKey,

    freezeForEdit: (statusEl, persistent) => {
      if (editorFreezeApi) editorFreezeApi.freeze(statusEl, persistent);
    },
    unfreezeForEdit: () => {
      if (editorFreezeApi) editorFreezeApi.unfreeze();
    },

    roleIdFor: (role) => roleId(role),

    setRawDrive,
    clearRawDrive,

    _rawDrive: () => ({
      values: state.rawDrive ? Object.assign({}, state.rawDrive) : null,
      ticks: state._rawDriveTicks || 0,
      tickCount: state._tickCount || 0,
      hasCore: !!coreModel(),
      lastWrite: state._rawDriveLast || null,
      rangeCount: state.paramRange ? Object.keys(state.paramRange).length : 0,
      range: state.rawDrive
        ? Object.keys(state.rawDrive).map((id) => ({
            id,
            r: state.paramRange && state.paramRange[id],
          }))
        : [],
    }),

    listModelParams,

    readParameter: (id) => readParam(id),

    getCapabilityProfile,

    sheet: {
      load: loadCharacterSheet,
      fetchFile: fetchSheetFile,
      inspect: inspectModel,
      resolvePresets,
      resolveParamGroup,
      findPreset,
      categories: () => PRESET_CATEGORIES.slice(),
      builtinGestures: () => Object.keys(GESTURE_LIBRARY),

      checkGerakName,
      suggestGerakName,

      savePreset: saveUserPreset,
      deletePreset: deleteUserPreset,
      applySuggestion: applyAISuggestion,
      applyPreset,
      saveNote: saveUserNote,

      saveParamNote,
      getParamNote,
      saveConfig: saveModelConfig,

      classifyParams: triggerAIParamClassification,

      analyzePresets: analyzeSheetPresets,
    },
  };

  function currentModelKey() {
    const p = state.modelPath || "default";
    return p.replace(/[^A-Za-z0-9_\u4e00-\u9fff]/g, "_");
  }

  function characterSheetKey() {
    return "live2d_sheet_" + currentModelKey();
  }

  function normalizeModelConfig(raw) {
    const c = Object.assign({}, MODEL_CONFIG_DEFAULTS);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c;
    if (typeof raw.blink === "boolean") c.blink = raw.blink;
    if (typeof raw.idle === "boolean") c.idle = raw.idle;
    if (FRAMING_MODES.indexOf(raw.framing) !== -1) c.framing = raw.framing;

    const r = Number(raw.ttsRate);
    if (Number.isFinite(r))
      c.ttsRate = clamp(r, TTS_RATE_RANGE.min, TTS_RATE_RANGE.max);
    const p = Number(raw.ttsPitch);
    if (Number.isFinite(p))
      c.ttsPitch = clamp(p, TTS_PITCH_RANGE.min, TTS_PITCH_RANGE.max);
    if (
      typeof raw.ttsLang === "string" &&
      /^[a-zA-Z]{2}(-[a-zA-Z0-9]{2,8})*$/.test(raw.ttsLang)
    ) {
      c.ttsLang = raw.ttsLang;
    }

    if (typeof raw.displayName === "string") {
      c.displayName = raw.displayName
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .trim()
        .slice(0, 40);
    }

    if (typeof raw.bgColor === "string") {
      const v = raw.bgColor
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .trim()
        .slice(0, 64);
      c.bgColor = v;
    }
    if (
      typeof raw.bgImage === "string" &&
      /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(
        raw.bgImage,
      ) &&
      raw.bgImage.length <= 4_000_000
    ) {
      c.bgImage = raw.bgImage;
    }
    const d = Number(raw.bgDim);
    if (Number.isFinite(d)) c.bgDim = Math.max(0, Math.min(0.9, d));
    return c;
  }

  function sanitizeSteps(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    let total = 0;
    for (const step of raw) {
      if (out.length >= STEP_COUNT_MAX) break;
      if (!step || typeof step !== "object") continue;
      const d = {};
      const src = step.d && typeof step.d === "object" ? step.d : {};
      for (const k in STEP_FIELD_BOUNDS) {
        const n = Number(src[k]);

        if (Number.isFinite(n) && n !== 0) {
          const b = STEP_FIELD_BOUNDS[k];
          d[k] = Math.max(-b, Math.min(b, n));
        }
      }
      let ms = Number(step.ms);
      if (!Number.isFinite(ms)) ms = STEP_MS_MIN;
      ms = Math.max(STEP_MS_MIN, Math.min(STEP_MS_MAX, Math.round(ms)));
      if (total + ms > STEP_TOTAL_MS_MAX) break;
      total += ms;
      out.push({ d, ms });
    }
    return out;
  }

  function normalizePreset(raw, source) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const name = String(raw.name == null ? "" : raw.name)
      .trim()
      .slice(0, 60);
    if (!name) return null;
    const category =
      PRESET_CATEGORIES.indexOf(raw.category) !== -1
        ? raw.category
        : "properti";
    const num = (obj) => {
      const o = {};
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return o;
      for (const k of Object.keys(obj)) {
        const n = Number(obj[k]);
        if (typeof k === "string" && k && Number.isFinite(n)) o[k] = n;
      }
      return o;
    };
    const p = {
      name,
      category,

      values: num(raw.values),
      parts: num(raw.parts),
      source: source === "ai" ? "ai" : "user",
      updatedAt:
        typeof raw.updatedAt === "string"
          ? raw.updatedAt
          : new Date().toISOString(),
    };

    if (category === "gerak") p.steps = sanitizeSteps(raw.steps);

    if (typeof raw.renamedFrom === "string" && raw.renamedFrom.trim()) {
      p.renamedFrom = raw.renamedFrom.trim().slice(0, 60);
    }
    return p;
  }

  function normalizePresetList(raw, source) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const p = normalizePreset(item, source);
      if (!p) continue;

      const key = p.category + "\u0000" + p.name.toLowerCase();
      if (seen.has(key))
        out.splice(
          out.findIndex(
            (x) => x.category + "\u0000" + x.name.toLowerCase() === key,
          ),
          1,
        );
      seen.add(key);
      out.push(p);
    }
    return out;
  }

  function normalizePresets(raw) {
    const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return {
      user: normalizePresetList(r.user, "user"),
      ai: normalizePresetList(r.ai, "ai"),
    };
  }

  function normalizeGroupMap(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const k of Object.keys(raw)) {
      const label = String(raw[k] == null ? "" : raw[k])
        .trim()
        .slice(0, 40);
      if (k && label) out[k] = label;
    }
    return out;
  }

  function normalizeParamGroups(raw) {
    const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return { user: normalizeGroupMap(r.user), ai: normalizeGroupMap(r.ai) };
  }

  function resolveParamGroup(sheet, paramId, heuristic) {
    const g = (sheet && sheet.paramGroups) || {};
    return (
      (g.user && g.user[paramId]) ||
      (g.ai && g.ai[paramId]) ||
      heuristic ||
      "Kustom"
    );
  }

  function resolvePresets(sheet, category) {
    const P = (sheet && sheet.presets) || {};

    const users = (P.user || [])
      .filter((p) => !category || p.category === category)
      .map((p) => Object.assign({}, p, { source: "user" }));
    const taken = new Set(users.map((p) => p.name.toLowerCase()));
    const ais = (P.ai || [])
      .filter((p) => !category || p.category === category)
      .map((p) =>
        Object.assign({}, p, {
          source: "ai",
          suggestion: taken.has(p.name.toLowerCase()),
        }),
      );
    return users.concat(ais);
  }

  function migrateSheet(sheet) {
    if (!sheet || typeof sheet !== "object" || Array.isArray(sheet))
      return null;
    const v = Number(sheet.schemaVersion) || 0;
    if (v > SHEET_SCHEMA_VERSION) {
      console.warn(
        "[sheet] schemaVersion",
        v,
        "> supported",
        SHEET_SCHEMA_VERSION,
        "— using as-is, not migrating",
      );
      return sheet;
    }
    if (v < 1) {
      if (typeof sheet.userNote !== "string") sheet.userNote = "";
      sheet.schemaVersion = 1;
      console.log(
        "[sheet] migrated v0 -> v1 for",
        sheet.modelName || "(unnamed)",
      );
    }
    if (v < 2) {
      sheet.config = normalizeModelConfig(sheet.config);
      sheet.schemaVersion = 2;
      console.log(
        "[sheet] migrated v1 -> v2 for",
        sheet.modelName || "(unnamed)",
      );
    }
    if (v < 3) {
      if (!sheet.rangeSource) {
        sheet.rangesEstimated = true;
        sheet.rangeSource = "estimated-legacy";
        sheet.needsReinspect = true;
        if (Array.isArray(sheet.params)) {
          for (const p of sheet.params) {
            if (!p || typeof p !== "object") continue;
            p.estimated = true;
            p.estimateSource = p.estimateSource || "legacy-unmeasured";
          }
        }
        if (sheet.paramRange && typeof sheet.paramRange === "object") {
          for (const k in sheet.paramRange) {
            if (
              sheet.paramRange[k] &&
              typeof sheet.paramRange[k] === "object"
            ) {
              sheet.paramRange[k].estimated = true;
            }
          }
        }
        console.warn(
          "[sheet] " +
            (sheet.modelName || "(unnamed)") +
            ": pre-v3 sheet — ranges " +
            "were never measured from Cubism. Flagged as estimated; re-inspect to get real ranges.",
        );
      }
      sheet.schemaVersion = 3;
      console.log(
        "[sheet] migrated v2 -> v3 for",
        sheet.modelName || "(unnamed)",
      );
    }
    if (v < 4) {
      sheet.schemaVersion = 4;
      console.log(
        "[sheet] migrated v3 -> v4 for",
        sheet.modelName || "(unnamed)",
      );
    }

    if (typeof sheet.userNote !== "string") sheet.userNote = "";

    sheet.config = normalizeModelConfig(sheet.config);
    if (!Array.isArray(sheet.params)) sheet.params = [];

    for (const p of sheet.params) {
      if (!p || typeof p !== "object") continue;
      if (typeof p.userNote !== "string") p.userNote = "";
      else if (p.userNote.length > 300) p.userNote = p.userNote.slice(0, 300);
    }

    sheet.paramGroups = normalizeParamGroups(sheet.paramGroups);
    sheet.presets = normalizePresets(sheet.presets);
    if (!Array.isArray(sheet.parts)) sheet.parts = [];
    if (!Array.isArray(sheet.accessories)) sheet.accessories = [];
    if (!Array.isArray(sheet.nativeExpressions)) sheet.nativeExpressions = [];
    if (!Array.isArray(sheet.motionGroups)) sheet.motionGroups = [];

    deshadowGerakPresets(sheet);

    const asMap = (v) =>
      v && typeof v === "object" && !Array.isArray(v) ? v : {};
    sheet.roleIds = asMap(sheet.roleIds);
    sheet.paramRange = asMap(sheet.paramRange);
    sheet.supportedEmotions = asMap(sheet.supportedEmotions);
    sheet.controls = asMap(sheet.controls);
    sheet.schemaVersion = SHEET_SCHEMA_VERSION;
    return sheet;
  }

  function existingUserFields() {
    const carried = {};
    let prev = null;
    try {
      const raw = localStorage.getItem(characterSheetKey());
      if (raw) prev = JSON.parse(raw);
    } catch (e) {}
    if (!prev && state.lastFileSheet) prev = state.lastFileSheet;
    if (!prev && state.lastSheet) prev = state.lastSheet;
    if (!prev) return carried;
    for (const f of USER_AUTHORED_FIELDS) {
      if (prev[f] !== undefined && prev[f] !== null && prev[f] !== "")
        carried[f] = prev[f];
    }

    if (carried.config) carried.config = normalizeModelConfig(carried.config);
    if (carried.paramGroups)
      carried.paramGroups = normalizeParamGroups(carried.paramGroups);
    if (carried.presets) carried.presets = normalizePresets(carried.presets);

    carried.__paramNotes = {};
    if (Array.isArray(prev.params)) {
      for (const p of prev.params) {
        if (
          p &&
          typeof p === "object" &&
          p.id &&
          typeof p.userNote === "string" &&
          p.userNote
        ) {
          carried.__paramNotes[p.id] = p.userNote.slice(0, 300);
        }
      }
    }
    return carried;
  }

  function characterName() {
    const cfg = currentModelConfig();
    if (cfg.displayName) return cfg.displayName;

    const m = /^model\/([^/]+)\//.exec(state.modelPath || "");
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch (e) {
        return m[1];
      }
    }
    return "Live2D Agent";
  }

  function characterInitial() {
    const n = characterName();
    return Array.from(n)[0] || "?";
  }

  // Folder model = segmen pertama di bawah data/model/ — tempat file avatar
  // (mis. avatar.png / png lain di root folder) dicari oleh /api/model/avatar.
  function characterFolderName() {
    const m = /^model\/([^/]+)/.exec(state.modelPath || "");
    if (!m) return "";
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  }

  function characterAvatarURL() {
    const f = characterFolderName();
    return f
      ? API + "/api/model/avatar?name=" + encodeURIComponent(f)
      : "";
  }

  // Isi satu elemen avatar: <img> dari /api/model/avatar kalau model punya
  // file gambar, kalau tidak → inisial huruf seperti biasa.
  function paintAvatarEl(el, initial) {
    if (!el) return;
    const url = characterAvatarURL();
    if (!url) {
      const img = el.querySelector("img");
      if (img) img.remove();
      el.classList.remove("has-image");
      el.textContent = initial;
      return;
    }
    const want =
      url + "&v=" + encodeURIComponent(state.modelPath || "");
    el.textContent = "";
    let img = el.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.alt = initial;
      img.draggable = false;
      img.onerror = () => {
        // Model ternyata tanpa gambar — kembali ke inisial.
        img.remove();
        el.classList.remove("has-image");
        if (!el.textContent) el.textContent = initial;
      };
      el.appendChild(img);
    }
    if (img.getAttribute("src") !== want) img.src = want;
    el.classList.add("has-image");
  }

  function applyCharacterIdentity() {
    const name = characterName();
    const initial = characterInitial();
    document.title = name + " — Live2D Agent";
    const nameEl = $(".sb-name");
    if (nameEl) nameEl.textContent = name;

    const avatars = [$(".sb-avatar")].concat(
      Array.from($$(".msg.agent .msg-avatar")),
    );
    for (const el of avatars) {
      if (el) paintAvatarEl(el, initial);
    }
    const greet = $("#greeting-bubble");
    if (greet)
      greet.textContent = "Halo! Aku " + name + "~ Ada yang bisa kubantu? 😊";
  }

  function currentModelConfig() {
    return state.modelConfig || MODEL_CONFIG_DEFAULTS;
  }

  function applyModelConfig(cfg) {
    const c = normalizeModelConfig(cfg);
    state.modelConfig = c;
    state.blinkEnabled = c.blink;
    state.idleEnabled = c.idle;

    if (state.model) {
      try {
        frameModel(c.framing);
      } catch (e) {
        console.warn("[config] framing failed:", e.message);
      }
    }

    try {
      applyStageBackground(c);
    } catch (e) {
      console.warn("[stage-bg] apply failed:", e.message);
    }

    try {
      applyCharacterIdentity();
    } catch (e) {
      console.warn("[identity] repaint failed:", e.message);
    }
    return c;
  }

  function applyStageBackground(cfg) {
    if (!app || app.destroyed) return;
    const c = normalizeModelConfig(cfg);
    try {
      const hex = c.bgColor ? cssColorToHex(c.bgColor) : 0x0d0d10;

      if (app.renderer.background && "color" in app.renderer.background) {
        app.renderer.background.color = hex;
      } else if ("backgroundColor" in app.renderer) {
        app.renderer.backgroundColor = hex;
      } else {
        app.renderer._backgroundColor = hex;
        app.renderer._backgroundColorString =
          "#" + hex.toString(16).padStart(6, "0");
      }
    } catch (e) {
      console.warn("[stage-bg] color invalid:", c.bgColor);
    }

    const want = c.bgImage || "";
    if (!want) {
      removeStageBgImage();
      return;
    }
    if (state._bgImageKey === want && state._bgSprite) {
      fitStageBgImage(c.bgDim);
      return;
    }
    removeStageBgImage();
    const img = new Image();
    img.onload = () => {
      const cur = state.modelConfig || {};
      if ((cur.bgImage || "") !== want) return;
      const tex = PIXI.Texture.from(img);
      const spr = new PIXI.Sprite(tex);
      spr.zIndex = -1;
      app.stage.addChildAt(spr, 0);
      state._bgSprite = spr;
      state._bgImageKey = want;
      fitStageBgImage(c.bgDim);
    };
    img.onerror = () => console.warn("[stage-bg] gambar gagal dimuat");
    img.src = want;
  }
  function fitStageBgImage(dim) {
    const spr = state._bgSprite;
    if (!spr || !spr.texture) return;
    const W = app.screen.width,
      H = app.screen.height;
    const s = Math.max(W / spr.texture.width, H / spr.texture.height);
    spr.width = spr.texture.width * s;
    spr.height = spr.texture.height * s;
    spr.x = (W - spr.width) / 2;
    spr.y = (H - spr.height) / 2;

    if (!state._bgDimSprite) {
      state._bgDimSprite = new PIXI.Graphics();
      state._bgDimSprite.zIndex = -0.5;
      app.stage.addChild(state._bgDimSprite);
    }
    const g = state._bgDimSprite;
    g.clear();
    g.beginFill(0x000000, Math.max(0, Math.min(0.9, Number(dim) || 0)));
    g.drawRect(0, 0, W, H);
    g.endFill();
  }
  function removeStageBgImage() {
    if (state._bgSprite) {
      try {
        app.stage.removeChild(state._bgSprite);
        state._bgSprite.destroy();
      } catch (e) {}
    }
    if (state._bgDimSprite) {
      try {
        app.stage.removeChild(state._bgDimSprite);
        state._bgDimSprite.destroy();
      } catch (e) {}
    }
    state._bgSprite = null;
    state._bgDimSprite = null;
    state._bgImageKey = null;
  }

  function cssColorToHex(str) {
    const s = String(str || "")
      .trim()
      .toLowerCase();
    let m = s.match(/^#([0-9a-f]{3})$/);
    if (m)
      return parseInt(
        m[1]
          .split("")
          .map((ch) => ch + ch)
          .join(""),
        16,
      );
    m = s.match(/^#([0-9a-f]{6})$/);
    if (m) return parseInt(m[1], 16);
    m = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
    if (m)
      return (
        (Math.min(255, +m[1]) << 16) |
        (Math.min(255, +m[2]) << 8) |
        Math.min(255, +m[3])
      );
    const named = {
      black: 0x000000,
      white: 0xffffff,
      red: 0xff0000,
      green: 0x008000,
      blue: 0x0000ff,
      gray: 0x808080,
      grey: 0x808080,
      navy: 0x000080,
      teal: 0x008080,
      purple: 0x800080,
      pink: 0xffc0cb,
      orange: 0xffa500,
      yellow: 0xffff00,
      brown: 0xa52a2a,
    };
    if (s in named) return named[s];
    throw new Error("warna tidak dikenal: " + s);
  }

  function loadModelConfigLocal() {
    const sheet = loadCharacterSheet();
    return normalizeModelConfig(sheet && sheet.config);
  }

  async function saveModelConfig(patch) {
    let sheet = loadCharacterSheet();
    if (!sheet) {
      if (!state.model)
        throw new Error("Load model dulu sebelum menyimpan pengaturan.");
      sheet = inspectModel();
      if (!sheet)
        throw new Error(
          "Inspeksi model gagal, pengaturan tidak bisa disimpan.",
        );
    }
    const merged = normalizeModelConfig(
      Object.assign({}, sheet.config, patch || {}),
    );
    sheet.config = merged;
    sheet.schemaVersion = SHEET_SCHEMA_VERSION;

    try {
      localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
    } catch (e) {
      console.warn("[config] localStorage write failed:", e.message);
    }
    state.lastSheet = sheet;
    applyModelConfig(merged);

    const key = characterSheetKey().replace("live2d_sheet_", "");
    const res = await fetch(API + "/api/sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName: key, sheet: sheet }),
    });
    if (!res.ok) {
      let detail = {};
      try {
        detail = await res.json();
      } catch (e) {}
      throw new Error(detail.error || "server HTTP " + res.status);
    }
    try {
      window.__agent &&
        typeof window.__agent.invalidateCapabilityProfile === "function" &&
        window.__agent.invalidateCapabilityProfile();
    } catch (e) {}
    return merged;
  }

  const MAX_USER_NOTE = 2000;

  function sanitizeUserNote(text) {
    let s = String(text == null ? "" : text).replace(/\r\n?/g, "\n");

    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    if (s.length > MAX_USER_NOTE) {
      s = s.slice(0, MAX_USER_NOTE);

      const last = s.charCodeAt(s.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
    }
    return s;
  }

  async function saveUserNote(rawText) {
    const note = sanitizeUserNote(rawText);
    let sheet = state.lastSheet || loadCharacterSheet();
    if (!sheet) sheet = await fetchSheetFile();
    if (!sheet) {
      if (!state.model)
        throw new Error("Load model dulu sebelum menyimpan catatan.");
      sheet = inspectModel();
      if (!sheet) throw new Error("Gagal membuat character sheet.");
    }
    sheet.userNote = note;
    sheet.schemaVersion = SHEET_SCHEMA_VERSION;
    state.lastSheet = sheet;

    let localOk = true;
    try {
      localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
    } catch (e) {
      localOk = false;
      console.warn("[note] localStorage save failed:", e.message);
    }

    const res = await fetch(API + "/api/sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName: sheet.modelName, sheet }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(
        detail.error ||
          "server HTTP " +
            res.status +
            (localOk ? " (tersimpan lokal saja)" : ""),
      );
    }

    try {
      window.__agent &&
        window.__agent.invalidateCapabilityProfile &&
        window.__agent.invalidateCapabilityProfile();
    } catch (e) {}
    return note;
  }

  const MAX_PARAM_NOTE = 300;

  function sanitizeParamNote(text) {
    let s = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    if (s.length > MAX_PARAM_NOTE) {
      s = s.slice(0, MAX_PARAM_NOTE);
      const last = s.charCodeAt(s.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
    }
    return s;
  }

  async function saveParamNote(paramId, rawText) {
    if (typeof paramId !== "string" || !paramId)
      throw new Error("paramId wajib ada.");
    const note = sanitizeParamNote(rawText);
    const sheet = await sheetForWrite();
    if (!Array.isArray(sheet.params)) sheet.params = [];
    const pObj = sheet.params.find((p) => p && p.id === paramId);
    if (!pObj)
      throw new Error(
        'Parameter "' + paramId + '" tidak ada di sheet model ini.',
      );
    pObj.userNote = note;
    sheet.schemaVersion = SHEET_SCHEMA_VERSION;
    await persistSheet(sheet);
    return note;
  }

  function getParamNote(paramId) {
    const sheet = state.lastSheet || loadCharacterSheet();
    const p = ((sheet && sheet.params) || []).find(
      (p) => p && p.id === paramId,
    );
    return p && typeof p.userNote === "string" ? p.userNote : "";
  }

  async function refreshUserNoteUI() {
    const box = $("#input-user-note");
    if (!box) return;
    let sheet = state.lastSheet || loadCharacterSheet();
    if (!sheet) sheet = await fetchSheetFile();
    box.value =
      sheet && typeof sheet.userNote === "string" ? sheet.userNote : "";
    const status = $("#note-status");
    if (status) {
      status.textContent = "";
      status.className = "note-status";
    }
  }

  function inspectModel() {
    if (!state.model) return null;
    const cm = coreModel();
    const m = state.model;

    const rawParams = [];
    let rangeSource = "none";
    try {
      const gm = cm && cm.getModel ? cm.getModel() : null;
      const pp = gm && gm.parameters;

      if (
        pp &&
        pp.ids &&
        pp.minimumValues &&
        pp.maximumValues &&
        pp.defaultValues
      ) {
        rangeSource = "core-arrays";
        const n = pp.count != null ? pp.count : pp.ids.length;
        for (let i = 0; i < n; i++) {
          const id = pp.ids[i];
          if (!id) continue;
          rawParams.push({
            id,
            min: pp.minimumValues[i],
            max: pp.maximumValues[i],
            def: pp.defaultValues[i],

            type: pp.types ? pp.types[i] : undefined,
          });
        }
      } else if (
        cm &&
        typeof cm.getParameterCount === "function" &&
        typeof cm.getParameterMinimumValue === "function"
      ) {
        rangeSource = "wrapper-accessors";
        const count = cm.getParameterCount();
        const ids =
          typeof cm.getParameterIds === "function"
            ? cm.getParameterIds()
            : null;
        for (let i = 0; i < count; i++) {
          const id = ids ? ids[i] : "";
          if (!id) continue;
          rawParams.push({
            id,
            min: cm.getParameterMinimumValue(i),
            max: cm.getParameterMaximumValue(i),
            def: cm.getParameterDefaultValue(i),
          });
        }
      }

      const bad = rawParams.filter(
        (p) =>
          !Number.isFinite(p.min) ||
          !Number.isFinite(p.max) ||
          !Number.isFinite(p.def) ||
          !(p.min <= p.def && p.def <= p.max),
      );
      if (bad.length) {
        console.warn(
          "[inspect] " +
            bad.length +
            " params failed the min<=def<=max sanity " +
            "check (source=" +
            rangeSource +
            "); discarding measured ranges. First:",
          bad[0],
        );
        rawParams.length = 0;
        rangeSource = "none";
      }
    } catch (e) {
      console.warn("[inspect] param enumeration failed:", e.message);
      rawParams.length = 0;
      rangeSource = "none";
    }
    if (rawParams.length) {
      console.log(
        "[inspect] measured " +
          rawParams.length +
          " parameter ranges from the engine " +
          "(source=" +
          rangeSource +
          ")",
      );
    }

    let rangesEstimated = false;
    if (!rawParams.length && state.modelParams) {
      rangesEstimated = true;
      console.warn(
        "[inspect] enumeration failed — falling back to ESTIMATED ranges for",
        state.modelParams.length,
        "params. AI will be told these are unmeasured.",
      );
      for (const pid of state.modelParams) {
        const meta = findParamMeta(pid);
        rawParams.push({
          id: pid,
          min: meta ? meta.min : -1,
          max: meta ? meta.max : 1,
          def: meta ? meta.def : 0,
          estimated: true,

          estimateSource: meta ? "cubism-standard" : "neutral-default",
        });
      }
    }

    const cdiById = (state.cdiInfo && state.cdiInfo.byId) || null;
    const classified = [];
    const used = new Set();
    for (const rp of rawParams) {
      const label = (cdiById && cdiById.get(rp.id) && cdiById.get(rp.id).label) || rp.id;
      let group;
      if (cdiById && cdiById.get(rp.id) && cdiById.get(rp.id).group) {
        group = cdiGroupTitle(cdiById.get(rp.id).group);
      } else {
        group = "Lainnya";
        if (/physics/i.test(rp.id)) {
          group = "Physics";
        } else {
          for (const gname in PARAM_META) {
            if (PARAM_META[gname][rp.id]) {
              group = gname;
              break;
            }
          }
          if (group === "Lainnya") {
            if (/^ParamAngle/.test(rp.id)) group = "Sudut (Angle)";
            else if (/^ParamEye/.test(rp.id)) group = "Mata (Eye)";
            else if (/^ParamBrow/.test(rp.id)) group = "Alis (Eyebrow)";
            else if (/^ParamMouth/.test(rp.id)) group = "Mulut (Mouth)";
            else if (/^ParamBody/.test(rp.id)) group = "Badan (Body)";
            else if (/^ParamHair/.test(rp.id)) group = "Rambut (Hair)";
            else group = "Kustom";
          }
        }
      }
      const entry = {
        id: rp.id,
        min: rp.min,
        max: rp.max,
        def: rp.def,
        group,
        label,
      };

      if (rp.type === 1) entry.blendShape = true;

      if (rp.estimated) {
        entry.estimated = true;
        entry.estimateSource = rp.estimateSource;
      }
      classified.push(entry);
      used.add(rp.id);
    }

    const parts = enumerateParts().map((p) => ({ ...p, type: "part" }));

    const roleIds = mapRoles(
      new Set(rawParams.map((p) => p.id)),
      getOfficialGroups(m),
    );
    const ROLE_ID_SET = new Set(Object.values(roleIds).filter(Boolean));

    const isToggleShaped = (p) =>
      p.min >= 0 &&
      p.max <= 1 &&
      p.def === 0 &&
      !ROLE_ID_SET.has(p.id) &&
      !/physics/i.test(p.id);
    const accessories = classified
      .filter(
        (p) =>
          isToggleShaped(p) &&
          (/^Param\d+$/.test(p.id) || p.group === "Kustom"),
      )
      .map((p) => p.id)
      .concat(parts.filter((p) => p.def === 0).map((p) => p.id));

    const supportedEmotions = buildRoleEmotions();

    const nativeExprs = state.modelExpressions || [];

    let motionGroups = [];
    try {
      const mm = m.internalModel && m.internalModel.motionManager;
      if (mm && mm.definitions) motionGroups = Object.keys(mm.definitions);
    } catch (e) {}

    const paramRange = {};
    for (const p of classified) {
      paramRange[p.id] = { min: p.min, max: p.max, def: p.def };
      if (p.estimated) paramRange[p.id].estimated = true;
    }

    const sheet = {
      schemaVersion: SHEET_SCHEMA_VERSION,
      modelName: currentModelKey(),
      inspectedAt: new Date().toISOString(),
      paramCount: rawParams.length,

      rangesEstimated: rangesEstimated,

      rangeSource: rangesEstimated ? "estimated" : rangeSource,
      params: classified,
      parts: parts,
      paramRange: paramRange,
      roleIds: roleIds,
      accessories: accessories,
      supportedEmotions: supportedEmotions,
      nativeExpressions: nativeExprs,
      motionGroups: motionGroups,

      userNote: '',

      config: Object.assign({}, MODEL_CONFIG_DEFAULTS),

      paramGroups: { user: {}, ai: {} },
      presets: { user: [], ai: [] },
      controls: {
        head: !!(roleIds.angleX || roleIds.angleY),
        eyes: !!(
          roleIds.eyeBallX ||
          roleIds.eyeBallY ||
          roleIds.eyeLOpen ||
          roleIds.eyeROpen
        ),
        eyebrows: !!(roleIds.browLForm || roleIds.browRForm),
        mouth: !!(roleIds.mouthOpenY || roleIds.mouthForm),
        body: !!(
          roleIds.bodyAngleX ||
          roleIds.bodyAngleY ||
          roleIds.bodyAngleZ
        ),
        hair: classified.some((p) => /hair/i.test(p.id)),
      },
    };

    const carriedFields = existingUserFields();
    const carriedNotes = carriedFields.__paramNotes || {};
    delete carriedFields.__paramNotes;
    Object.assign(sheet, carriedFields);

    for (const p of sheet.params) {
      if (p && typeof p === "object" && carriedNotes[p.id])
        p.userNote = carriedNotes[p.id];
    }

    projectEmotionPresets(sheet);
    state.lastSheet = sheet;

    triggerAIParamClassification(sheet, classified, roleIds).catch((e) =>
      console.warn("[inspect] classify failed:", e.message),
    );

    try {
      localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
      console.log(
        "[inspect] character sheet saved:",
        sheet.paramCount,
        "params,",
        accessories.length,
        "accessories,",
        nativeExprs.length,
        "expressions",
      );
    } catch (e) {
      console.warn("[inspect] failed to save sheet:", e.message);
    }

    try {
      fetch(API + "/api/sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelName: sheet.modelName, sheet }),
      })
        .then((r) => r.json().catch(() => ({})))
        .then((j) =>
          console.log(
            "[inspect] character sheet file saved:",
            j.path || j.error || "(unknown)",
          ),
        )
        .catch(() => {});
    } catch (e) {
      console.warn("[inspect] failed to push sheet to server:", e.message);
    }

    return sheet;
  }

  async function triggerAIParamClassification(sheet, classified, roleIds) {
    if (!sheet) {
      sheet = state.lastSheet || loadCharacterSheet();
      if (!sheet) throw new Error("Belum ada sheet. Inspeksi model dulu.");
    }
    if (!Array.isArray(classified)) classified = sheet.params || [];
    if (!roleIds) roleIds = sheet.roleIds || {};
    if (!sheet.roleIds) sheet.roleIds = {};
    if (!Array.isArray(sheet.accessories)) sheet.accessories = [];
    try {
      if (!sheet.paramGroups) sheet.paramGroups = { user: {}, ai: {} };

      // The .ai branch is a suggestion cache, so it is rebuilt from scratch on
      // every run rather than accumulating stale labels from older classifies.
      // .user is never touched here.
      sheet.paramGroups.ai = {};
      const mappedParamIds = new Set(Object.values(roleIds || {}));
      const unmapped = classified.filter(
        (p) =>
          !mappedParamIds.has(p.id) && !p.id.toLowerCase().includes("physics"),
      );
      if (!unmapped.length) return { count: 0 };

      const res = await fetch(API + "/api/model/classify-params", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          params: unmapped.map((p) => ({
            id: p.id,
            min: p.min,
            max: p.max,
            def: p.def,
          })),
          currentRoles: roleIds,
        }),
      });
      if (!res.ok) throw new Error("server menolak (HTTP " + res.status + ")");
      const data = await res.json();
      const items = data.classifications || [];
      if (!items.length) return { count: 0 };

      let changed = false;

      // The LLM may only add SEMANTIC meaning (role / group / label / accessory
      // flag). The numeric truth of a parameter — min, max, def — comes from
      // Cubism Core and is never touched here, even if the response contains
      // those fields. We copy field-by-field instead of merging objects so a
      // rogue payload physically cannot reach the range values.
      for (const item of items) {
        if (!item || !item.id) continue;
        const pObj = sheet.params.find((p) => p.id === item.id);

        if (!pObj) continue;
        if (item.role && !sheet.roleIds[item.role]) {
          sheet.roleIds[item.role] = item.id;
          changed = true;
        }

        if (item.group) {
          sheet.paramGroups.ai[item.id] = String(item.group)
            .trim()
            .slice(0, 40);
          changed = true;
        }
        if (item.label) {
          pObj.label = item.label;
          changed = true;
        }
        if (item.isAccessory && !sheet.accessories.includes(item.id)) {
          sheet.accessories.push(item.id);
          changed = true;
        }
      }

      if (changed) {
        console.log(
          "[inspect] AI classified",
          items.length,
          "parameters successfully!",
        );
        hydrateCaps(sheet);
        localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
        fetch(API + "/api/sheet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelName: sheet.modelName, sheet }),
        }).catch(() => {});
      }
      return { count: items.length, changed };
    } catch (e) {
      console.warn(
        "[inspect] AI param classification skipped/failed:",
        e.message,
      );

      throw e;
    }
  }

  async function analyzeSheetPresets(sheet) {
    if (!sheet) {
      sheet = state.lastSheet || loadCharacterSheet();
      if (!sheet) throw new Error("Belum ada sheet. Inspeksi model dulu.");
    }
    if (!sheet.presets || typeof sheet.presets !== "object")
      sheet.presets = { user: [], ai: [] };
    if (!Array.isArray(sheet.presets.user)) sheet.presets.user = [];
    if (!Array.isArray(sheet.presets.ai)) sheet.presets.ai = [];

    const allParams = (sheet.params || [])
      .filter(
        (p) => p && p.id && Number.isFinite(p.min) && Number.isFinite(p.max),
      )
      .map(p => ({ id: p.id, min: p.min, max: p.max, def: p.def, label: p.label || '',
        group: resolveParamGroup(sheet, p.id, p.group) }));
    const params = allParams;
    if (!params.length) return { count: 0 };

    const parts = (sheet.parts || [])
      .map((p) => (p && p.id) || p)
      .filter(Boolean);

    const existingNames = sheet.presets.user.map((p) => p.name);

    const notes = {};
    for (const p of sheet.params || []) {
      if (p && p.id && typeof p.userNote === "string" && p.userNote.trim()) {
        notes[p.id] = p.userNote.trim().slice(0, 300);
      }
    }

    const res = await fetch(API + "/api/model/analyze-sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params, parts, existingNames, notes }),
    });
    if (!res.ok) throw new Error("server menolak (HTTP " + res.status + ")");
    const data = await res.json();
    if (data.warning) console.warn("[analyze-sheet]", data.warning);

    const incoming = normalizePresetList(
      (data.presets || []).filter((p) => p && p.category !== "gerak"),
      "ai",
    );
    if (!incoming.length) return { count: 0 };

    sheet.presets.ai = incoming;
    projectEmotionPresets(sheet);
    localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
    try {
      await fetch(API + "/api/sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelName: sheet.modelName, sheet }),
      });
    } catch (e) {
      console.warn(
        "[analyze-sheet] file write failed, kept locally:",
        e.message,
      );
    }
    try {
      window.__agent &&
        typeof window.__agent.invalidateCapabilityProfile === "function" &&
        window.__agent.invalidateCapabilityProfile();
    } catch (e) {}
    return { count: incoming.length };
  }

  function loadCharacterSheet() {
    try {
      const raw = localStorage.getItem(characterSheetKey());
      return raw ? migrateSheet(JSON.parse(raw)) : null;
    } catch (e) {
      return null;
    }
  }

  function sheetKeyPrefixForModelName(name) {
    const sanitized = String(name || "").replace(
      /[^A-Za-z0-9_\u4e00-\u9fff]/g,
      "_",
    );
    return "live2d_sheet_model_" + sanitized + "_";
  }

  function deleteCharacterSheet(modelName) {
    try {
      const prefix = sheetKeyPrefixForModelName(modelName);
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) doomed.push(k);
      }
      for (const k of doomed) localStorage.removeItem(k);
      if (doomed.length)
        console.log(
          "[sheet] removed",
          doomed.length,
          "sheet(s) for deleted model",
          modelName,
        );
    } catch (e) {}
  }

  const PARAM_META = {
    "Sudut (Angle)": {
      ParamAngleX: { min: -30, max: 30, def: 0 },
      ParamAngleY: { min: -30, max: 30, def: 0 },
      ParamAngleZ: { min: -30, max: 30, def: 0 },
    },
    "Mata (Eye)": {
      ParamEyeLOpen: { min: 0, max: 1, def: 1 },
      ParamEyeROpen: { min: 0, max: 1, def: 1 },
      ParamEyeLSmile: { min: -1, max: 1, def: 0 },
      ParamEyeRSmile: { min: -1, max: 1, def: 0 },
      ParamEyeBallX: { min: -1, max: 1, def: 0 },
      ParamEyeBallY: { min: -1, max: 1, def: 0 },
      ParamEyeForm: { min: -1, max: 1, def: 0 },
    },
    "Alis (Eyebrow)": {
      ParamBrowLX: { min: -1, max: 1, def: 0 },
      ParamBrowRX: { min: -1, max: 1, def: 0 },
      ParamBrowLY: { min: -1, max: 1, def: 0 },
      ParamBrowRY: { min: -1, max: 1, def: 0 },
      ParamBrowLAngle: { min: -1, max: 1, def: 0 },
      ParamBrowRAngle: { min: -1, max: 1, def: 0 },
      ParamBrowLForm: { min: -1, max: 1, def: 0 },
      ParamBrowRForm: { min: -1, max: 1, def: 0 },
    },
    "Mulut (Mouth)": {
      ParamMouthForm: { min: -1, max: 1, def: 0 },
      ParamMouthOpenY: { min: 0, max: 1, def: 0 },
      ParamMouthOpenX: { min: -1, max: 1, def: 0 },
    },
    "Badan (Body)": {
      ParamBodyAngleX: { min: -20, max: 20, def: 0 },
      ParamBodyAngleY: { min: -20, max: 20, def: 0 },
      ParamBodyAngleZ: { min: -20, max: 20, def: 0 },
      ParamBreath: { min: 0, max: 1, def: 0 },
    },
  };

  function findParamMeta(pid) {
    for (const g in PARAM_META) {
      if (PARAM_META[g][pid]) return PARAM_META[g][pid];
    }
    return null;
  }

  async function fetchSheetFile() {
    try {
      const key = characterSheetKey().replace("live2d_sheet_", "");
      const res = await fetch(
        API + "/api/sheet?name=" + encodeURIComponent(key),
      );
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);

      const migrated = data && data.params ? migrateSheet(data) : null;

      if (migrated) state.lastFileSheet = migrated;
      return migrated;
    } catch (e) {
      return null;
    }
  }

  function hydrateCaps(sheet) {
    if (!sheet) return;
    const set = new Set((sheet.params || []).map((p) => p.id));
    state.caps.params = set;

    if (sheet.roleIds && typeof sheet.roleIds === "object")
      state.caps.ids = sheet.roleIds;
    const c = sheet.controls || {};
    state.caps.hasHead = !!c.head;
    state.caps.hasEyes = !!c.eyes;
    state.caps.hasMouth = !!c.mouth;
    state.caps.hasBody = !!c.body;
    state.caps.hasBrow = !!c.eyebrows;
    state.caps.hasHair = !!c.hair;
    state.caps.motionGroups = Array.isArray(sheet.motionGroups)
      ? sheet.motionGroups
      : [];
    console.log("[caps] hydrated:", {
      count: set.size,
      head: state.caps.hasHead,
      eyes: state.caps.hasEyes,
      mouth: state.caps.hasMouth,
      body: state.caps.hasBody,
      brow: state.caps.hasBrow,
      gestures: state.caps.motionGroups.length,
    });
  }

  function capabilityPropertyNames(sheet) {
    const out = [];
    for (const p of (sheet.presets.user || [])) {
      if (
        p &&
        p.category === "properti" &&
        typeof p.name === "string" &&
        p.name.trim()
      ) {
        out.push(p.name.trim());
      }
    }
    return out;
  }

  async function getCapabilityProfile() {
    if (!state.model) return null;

    let sheet = await fetchSheetFile();

    if (!sheet) sheet = loadCharacterSheet();

    if (!sheet) sheet = inspectModel();

    if (!sheet) return null;

    hydrateCaps(sheet);
    state.lastSheet = sheet;

    projectEmotionPresets(sheet);

    // Only USER presets are promoted to capabilities. An .ai suggestion echoed
    // back into the LLM's own prompt would read as a capability the user had
    // already approved, blurring exactly the user/AI boundary this precedence
    // rule exists to keep sharp. AI entries stay UI suggestions until saved.
    const userPresets = (sheet.presets && sheet.presets.user) || [];
    const presetNames = (cat) =>
      userPresets.filter((p) => p.category === cat).map((p) => p.name);

    return {
      modelParams: sheet.params.map((p) => p.id),

      roleIds: sheet.roleIds || {},

      paramGroups: sheet.params.reduce((acc, p) => {
        if (p && p.id) acc[p.id] = resolveParamGroup(sheet, p.id, p.group);
        return acc;
      }, {}),
      paramDetails: sheet.params,
      emotions: Object.keys(sheet.supportedEmotions),
      nativeExpressions: sheet.nativeExpressions,

      accessories: sheet.accessories.concat(presetNames('aksesoris')),

      properties: capabilityPropertyNames(sheet),

      userNote: typeof sheet.userNote === "string" ? sheet.userNote : "",

      gestures: (() => {
        const list = Object.keys(GESTURE_LIBRARY)
          .concat(
            Array.isArray(sheet.motionGroups)
              ? sheet.motionGroups.map((g) => "motion_" + g)
              : [],
          )
          .concat(presetNames('gerak'));
        if (haveMotionSystem) {
          for (const a of motionRegistry.list()) {
            if (
              a.source === "user" &&
              a.aiEnabled !== false &&
              !list.includes(a.id)
            )
              list.push(a.id);
          }
        }
        return list;
      })(),

      motionCatalog: haveMotionSystem
        ? motionRegistry
            .list()
            .filter(
              (a) =>
                a.source === "user" &&
                a.aiEnabled !== false &&
                (a.description || a.tags.length),
            )
            .map((a) => MotionDSL.summaryForLLM(a))
        : [],
      hasHeadControl: sheet.controls.head,
      hasEyeControl: sheet.controls.eyes,
      hasMouthControl: sheet.controls.mouth,
      hasBodyControl: sheet.controls.body,
      hasBrowControl: sheet.controls.eyebrows,
      sheet: sheet,
    };
  }

  async function loadMotionTaxonomy() {
    state.motionTaxonomy = null;

    const parts = String(state.modelPath || "").split("/");
    const folder = parts.length >= 2 ? parts[parts.length - 2] : null;
    if (!folder) return null;
    try {
      const r = await fetch(
        API + "/api/model/motion-taxonomy?name=" + encodeURIComponent(folder),
      );
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if (!data || !data.byVerb) throw new Error("malformed taxonomy");

      if (!data.clipCount) {
        console.log(
          "[taxonomy] server found 0 clips for",
          folder,
          "— trying sheet names",
        );
        return buildTaxonomyFromNames();
      }

      const clipMeta = {};
      for (const c of data.clips || []) clipMeta[c.name] = c;
      state.motionTaxonomy = {
        byVerb: data.byVerb,
        clipMeta,
        stats: data.stats || {},
      };
      console.log(
        "[taxonomy]",
        data.clipCount,
        "clips ->",
        Object.entries(data.byVerb)
          .map(([v, l]) => `${v}:${l.length}`)
          .join(" "),
      );
      return state.motionTaxonomy;
    } catch (e) {
      console.warn(
        "[taxonomy] unavailable, falling back to name-only classification:",
        e.message,
      );

      return buildTaxonomyFromNames();
    }
  }

  function buildTaxonomyFromNames() {
    const groups = (state.caps && state.caps.motionGroups) || [];
    if (!groups.length || typeof MotionTaxonomy === "undefined") return null;
    const built = MotionTaxonomy.buildTaxonomy(
      groups.map((g) => ({ name: g, motion3: null })),
    );
    const clipMeta = {};
    for (const c of built.clips)
      clipMeta[c.name] = {
        name: c.name,
        verb: c.verb,
        group: c.name,
        index: -1,
      };
    state.motionTaxonomy = {
      byVerb: built.byVerb,
      clipMeta,
      stats: built.stats,
      nameOnly: true,
    };
    console.log(
      "[taxonomy] name-only fallback:",
      Object.entries(built.byVerb)
        .map(([v, l]) => `${v}:${l.length}`)
        .join(" "),
    );
    return state.motionTaxonomy;
  }

  function clipIsPlaying() {
    return state.clipUntil > performance.now();
  }

  /**
   * Play a motion clip appropriate to `emotion`. Returns the clip name, or null
   * when the model has nothing emotionally compatible (caller should then use a
   * synthetic gesture rather than playing something contradictory).
   */
  function playEmotionClip(emotion) {
    const T = state.motionTaxonomy;
    if (!T || !state.model || typeof MotionTaxonomy === "undefined")
      return null;
    if (clipIsPlaying()) return null;

    const pick = MotionTaxonomy.pickClipForEmotion(
      T.byVerb,
      emotion || state.activeEmotion || "normal",
    );
    if (!pick) return null;

    const meta = T.clipMeta[pick.name] || {};
    try {
      if (meta.group && typeof meta.index === "number" && meta.index >= 0) {
        state.model.motion(meta.group, meta.index, 1);
      } else {
        state.model.motion(meta.group || pick.name, -1, 1);
      }
    } catch (e) {
      console.warn("[clip] play failed", pick.name, e.message);
      return null;
    }

    const dur =
      (meta.duration && meta.duration > 0 ? meta.duration * 1000 : 2200) + 250;
    state.clipStartedAt = performance.now();
    state.clipUntil = state.clipStartedAt + dur;
    state.clipName = pick.name;
    console.log(
      `[clip] ${pick.name} (verb=${pick.verb}, emotion=${emotion}) for ${Math.round(dur)}ms`,
    );
    return pick.name;
  }

  function startGestureScheduler() {
    stopGestureScheduler();
    const tick = () => {
      if (!state.aiLock || !state.model) {
        stopGestureScheduler();
        return;
      }

      if (clipIsPlaying()) {
        const wait = Math.max(120, state.clipUntil - performance.now() + 80);
        state.gesture.timer = setTimeout(tick, wait);
        return;
      }

      const P = state.aiPose;
      const r = (a, b) => a + Math.random() * (b - a);

      const MIX = {
        senang: [0.3, 0.55],
        kaget: [0.45, 0.6],
        malu: [0.2, 0.85],
        sedih: [0.15, 0.9],
        normal: [0.45, 0.8],
      };
      const [t1, t2] = MIX[state.activeEmotion] || MIX.normal;
      const calm =
        state.activeEmotion === "sedih" || state.activeEmotion === "malu"
          ? 0.55
          : 1;
      const kind = Math.random();
      if (kind < t1) {
        P.ax = clamp((P.ax || 0) + r(-16, 16) * calm, -34, 34);
        P.ay = clamp((P.ay || 0) + r(-10, 10) * calm, -26, 26);
        P.ex = clamp((P.ex || 0) + r(-0.2, 0.2), -1, 1);
        P.ey = clamp((P.ey || 0) + r(-0.2, 0.2), -1, 1);
      } else if (kind < t2) {
        P.ax = clamp((P.ax || 0) + r(-10, 10), -30, 30);
        P.ay = clamp((P.ay || 0) + r(-8, 8), -24, 24);
        if (state.caps.hasBody && roleId("bodyAngleX")) {
          P.bodyZ = clamp((P.bodyZ || 0) + r(-8, 8), -20, 20);
        } else {
          P.bodyZ = clamp((P.bodyZ || 0) + r(-6, 6), -30, 30);
        }
      } else {
        state.energyBoost = Math.min(1.2, state.energyBoost + 0.7);
        state.impulse = Math.min(1.3, state.impulse + 0.5);
        P.ax = clamp((P.ax || 0) + r(-12, 12), -34, 34);
        P.ay = clamp((P.ay || 0) + r(-7, 7), -26, 26);
      }

      if (Math.random() < 0.35) {
        playEmotionClip(state.activeEmotion);
      }

      if (Math.random() < 0.6) {
        try {
          pokeRoleNorm("eyeLOpen", 0);
          pokeRoleNorm("eyeROpen", 0);
          setTimeout(() => {
            pokeRoleNorm("eyeLOpen", 1);
            pokeRoleNorm("eyeROpen", 1);
          }, 130);
        } catch (e) {}
      }

      const next = 1100 + Math.random() * 1500;
      state.gesture.timer = setTimeout(tick, next);
    };
    state.gesture.timer = setTimeout(tick, 1200 + Math.random() * 800);
    state.gesture.seed = Math.random() * 1000;
  }
  function stopGestureScheduler() {
    if (state.gesture && state.gesture.timer) {
      clearTimeout(state.gesture.timer);
      state.gesture.timer = null;
    }
  }
})();
