/**
 * app.js — Live2D Interaction Engine (FIXED)
 * 神宫白子 (Jingu Shiroshi) — PixiJS v6 + pixi-live2d-display@0.4.0
 *
 * Root-cause fixes vs the previous (broken) version:
 *   - The page loaded PixiJS v7, but pixi-live2d-display@0.4.0 only supports PixiJS v6.
 *     The SDK attaches the model to a v6-style stage; under v7 the model silently
 *     never rendered and every interaction threw. We now use pixi.6.5.10.min.js.
 *   - PIXI.Application in v6 needs an explicit `view` to a canvas (done) and the
 *     model is added as a normal DisplayObject (done). No `app.stage` v7 quirks.
 *   - Setting parameters: correct API is model.setParameterValueById(id, value, weight).
 *     The old code called model.setParameter(...) which does not exist -> every
 *     eye-tracking / slider / accessory call failed silently.
 *   - Expressions: correct API is model.expression(id) (async), where id is the
 *     expression NAME (e.g. "呆猫") from model3.json, or no arg for random.
 *     The old code used model.expression = null (no setter) and
 *     motionManager._runtime.setExpression(...) (path does not exist).
 *     To reset we call model.internalModel.motionManager.expressionManager.resetExpression().
 *   - Idle sway used model.y += ... inside setInterval without resetting, which
 *     drifted the model off-screen; now we apply a small offset relative to a
 *     base position each tick instead of accumulating.
 */
(function () {
  'use strict';

  // ─── moc version-stamp compatibility shim ───────────────────────
  // Core lama (Cubism 4.2.2) menolak moc binary ber-stamp versi > 4
  // (C.Moc.fromArrayBuffer returns null). Banyak Cubism 3 / early-Cubism-4
  // models are stamped version 5 but use a v4-compatible layout; the core
  // simply refuses them. Rewrite the 4-byte version stamp at offset 4 to 4
  // so the core accepts them — no Cubism Editor re-export required.
  //
  // Core 5.1 (yang sekarang di-vendor) SUDAH mendukung moc v5 — dan menurunkan
  // stamp secara membuta justru MEMATIKAN fitur v5: ParameterType_BlendShape
  // (efek EX02-05/08-11 rig lumine v5 — heart eye/blush/dizzy dst.) tidak
  // pernah diinisialisasi keyform-nya, jadi slidernya bergerak tapi tidak ada
  // piksel yang berubah (terukur 2026-09-01: exType=1, dOp=0 dengan stamp 4;
  // evaluasi penuh tanpa stamp). Urutan sekarang: coba stamp ASLI dulu; hanya
  // kalau core menolak, stamp diturunkan ke 4 lalu dicoba lagi.
  (function patchCubismCore() {
    const core = window.Live2DCubismCore;
    if (!core || !core.Moc || !core.Moc.fromArrayBuffer) return;
    const orig = core.Moc.fromArrayBuffer.bind(core.Moc);
    core.Moc.fromArrayBuffer = function (buf) {
      const ab = (buf instanceof ArrayBuffer) ? buf : (buf && buf.buffer) || buf;
      const direct = orig(ab);
      if (direct) return direct;
      try {
        const u8 = new Uint8Array(ab);
        if (u8.length > 8) {
          const v = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
          if (v > 4) { u8[4] = 4; u8[5] = 0; u8[6] = 0; u8[7] = 0; return orig(ab); }
        }
      } catch (e) { /* fall through to null result */ }
      return direct;
    };
  })();

  // Backend origin. Derived from the page that served this script, NOT a literal:
  // server.js honours process.env.PORT, so a hardcoded :8310 silently breaks every
  // fetch the moment the server runs on any other port. The page is always served
  // BY that same server, so location.origin is correct by construction.
  // The literal survives only as a file:// fallback (opening index.html directly).
  const API = (typeof location !== 'undefined' && /^https?:$/.test(location.protocol))
    ? location.origin
    : 'http://127.0.0.1:8310';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));  // shared math helper
  // ─── State ────────────────────────────────────────────────────
  const state = {
    model: null,
    blinkEnabled: true,
    idleEnabled: true,
    blinkInterval: null,
    idleRAF: null,
    aiLock: false,            // true while AI controls the character (pause user interaction)
    frozen: false,            // true while the param-notes popup is dragging a slider (suppress idle fidget)
    frozenTimer: null,        // 10s cooldown that re-enables idle after the last drag
    accessoryValues: {},
    // Sticky parameter overrides (accessories + sliders + eye-follow).
    // The model re-evaluates its own motion/physics every frame, so we re-apply
    // these after each model update to keep them "held".
    overrides: {},
    // Cache pengukuran efek visual LEGACY (visfxLoad()) — map id → {changed,
    // maxDelta, at}. Fitur kalibrasinya sudah dihapus; data warisan ini kini
    // cuma dibaca gate overlay-vs-native. Null = tidak pernah discan.
    visfxMap: null,
    // Label + grup dari cdi3.json (DisplayInfo model): paramId → { label, group }.
    // Nama & pengelompokan ASLI rigger — jauh lebih informatif daripada
    // heuristik regex id. Di-fetch saat model dimuat; null = gagal/belum ada.
    cdiInfo: null,
    // ── Raw parameter drive (Motion Studio) ──
    // { paramId: number } nilai ABSOLUT yang ditulis PALING AKHIR setiap frame
    // dengan weight 1, jadi ia menang atas idle fidget, emosi, dan overrides.
    //
    // Kenapa terpisah dari `overrides`: overrides adalah keadaan sticky jangka
    // panjang milik user (aksesoris yang dinyalakan, slider yang disetel) dan
    // ikut disimpan/di-restore. Raw drive itu SEMENTARA — hanya hidup selama
    // editor terbuka atau motion raw sedang diputar — dan harus bisa dibuang
    // sekaligus tanpa mengganggu aksesoris yang user nyalakan sebelumnya.
    // Ditulis setelah applyOverrides() karena Motion Studio harus menampilkan
    // pose apa adanya, tanpa dicampur nilai sticky lama untuk param yang sama.
    rawDrive: null,
    // Nilai parameter SEBELUM raw drive menyentuhnya, per id. Dipakai untuk
    // memulihkan pose saat drive dilepas. Tanpa ini, parameter yang tidak
    // dikemudikan sistem lain (mis. pipi, aksesoris, rambut) akan menempel di
    // nilai terakhir editor selamanya — "pose nyangkut" yang paling kentara
    // justru pada parameter yang tidak ikut idle.
    rawDrivePrev: null,
    isDragging: false,
    dragTarget: null,
    dragOffset: { x: 0, y: 0 },
    basePos: { x: 0, y: 0 },     // center, used by idle sway as anchor
    scale: 1,
    talking: false,            // true while TTS/simulated speech is playing
    mouthRest: 0,              // resting mouth-open value (set by slider)
    mouthTimer: null,
    // Look/follow target + current (eased) values. We store a TARGET on
    // mousemove and lerp CURRENT -> TARGET every frame, then write with
    // weight=1 so the head/eyes reach the target exactly (precise) while
    // still moving smoothly (eased). This fixes the "follow feels imprecise"
    // problem caused by the old weight=0.3 blend that never fully arrived.
    look: { ax:0, ay:0, ex:0, ey:0, tax:0, tay:0, tex:0, tey:0, bx:0, by:0, tbx:0, tby:0 },
    // AI-driven POSE TARGET while the AI has the lock. While aiLock is true,
    // the engine eases the model toward THIS (plus a live fidget), so poses
    // transition smoothly instead of snapping — the "stiff" fix.
    aiPose: { ax:0, ay:0, ex:0, ey:0, mouthForm:0, bodyX:0, bodyY:0, bodyZ:0, breath:0.45 },
    // Live fidget seed (randomized each lock) so every session feels unique.
    fidgetT: 0,
    fidgetSeed: Math.random() * 1000,
    // Cached look reference frame (computed once per model load) so the
    // follow gain is stable and doesn't get "held back" if getLocalBounds()
    // returns a different box after re-framing.
    lookFrame: { eyeX:0, eyeY:0, w:1, h:1 },
    idleMotionTimer: null,
    activeEmotion: 'normal',
    activeProperty: 'default',
    supportedEmotions: {},   // role-derived per model by refreshRoleEmotions(); user 'emosi' presets layer on top
    // Real, sheet-derived capability flags so the AI engine only drives
    // parameters THIS model actually owns. Populated by hydrateCaps() from
    // the character sheet (file -> localStorage -> live inspect fallback).
    caps: {
      hasHead: true, hasEyes: true, hasMouth: true,
      hasBody: false, hasBrow: false, hasHair: false,
      params: null,          // Set of owned param ids (or null = unknown)
      ids: {},               // role -> actual model param id (model-agnostic)
      motionGroups: [],      // model's own motion groups (if any)
    },
    paramRange: {},          // id -> {min,max,def} from Cubism Core (true ranges)
    // Most recently resolved character sheet for the CURRENT model. Kept so
    // user-authored fields (userNote) can be carried across a re-inspection
    // even when localStorage is unavailable. Reset on model load.
    lastSheet: null,
    // Mirror sheet FILE (data/sheets/) yang terakhir berhasil dibaca. existingUserFields()
    // memakainya sebagai sumber ketiga: cache localStorage bisa kosong (browser baru /
    // dibersihkan) padahal file berisi preset & catatan user — tanpa mirror ini,
    // re-inspeksi di browser begitu akan MENGHAPUS tulisan user saat menimpa file.
    lastFileSheet: null,
    // Micro-gesture scheduler state (neuro-sama-ish "always alive" feel).
    gesture: { timer: null, nextAt: 0, seed: Math.random() * 1000 },
    // ── Motion-clip taxonomy (semantic verbs) ──
    // byVerb: verb -> [clip names]; clipMeta: clip name -> {verb, group, index}.
    // Fetched once per model from GET /api/model/motion-taxonomy (server parses
    // every .motion3.json and classifies it by its actual curves). Used to pick
    // clips that MATCH the current emotion instead of uniformly at random —
    // the fix for "she plays a crying animation while saying something happy".
    motionTaxonomy: null,
    // Clip playback guard. While a native clip is playing it owns the head/body
    // params, so the eased AI pose must NOT fight it (two writers on the same
    // parameter = the stiff, twitchy look). Timestamp in ms; 0 = idle.
    clipUntil: 0,
    clipName: null,
    clipStartedAt: 0,
    // Eased emotion system: AI/UI set a TARGET, the engine eases toward it
    // every frame so expression changes morph smoothly instead of snapping.
    emoTarget: {}, emoCur: {},
    // Universal emotion name -> { realParamId: actualValue }, resolved from the
    // ROLE templates against whichever model is loaded. Rebuilt every load.
    roleEmotions: {},
    // "Pop" impulse + transient energy boost fired on each response segment so
    // she bounces/lurches with life when she starts talking or changes pose.
    impulse: 0,
    energyBoost: 0,
    // Intrinsic (scale-1) model size, cached at framing so we can do breathing
    // squash/stretch and bob around a stable center every frame.
    natW: 0, natH: 0,
    // Current framing mode flag, read by the resize handler so a resize keeps
    // whichever framing the user chose instead of reverting to 'upper'.
    // Declared here (not implicitly created in setFullBody) so it is never
    // `undefined` on the first resize.
    fullBody: false,
  };

  // ─── DOM helpers ──────────────────────────────────────────────
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // Assigned by wireUI() once the config panel exists. Declared here because
  // loadModel() must re-sync the panel on every model swap, and it runs outside
  // wireUI()'s scope. No-op until wired, so an early model load can't throw.
  let refreshConfigForm = () => {};
  // Same contract for the Sheet pane: preset lists belong to ONE model, so a
  // model swap must repaint them or the user would be editing model A's presets
  // while looking at model B.
  let refreshSheetUI = () => {};

  // ─── Parameter helpers (CORRECT API for pixi-live2d-display@0.4.0) ──
  // The public Live2DModel has NO setParameter* method; the real setter lives
  // on internalModel.coreModel (the Cubism core model wrapper).
  function coreModel() {
    return state.model && state.model.internalModel
      ? state.model.internalModel.coreModel : null;
  }

  // Apply a value immediately (transient writes, e.g. blink).
  function pokeParam(id, value, weight) {
    const cm = coreModel();
    if (!cm) return;
    try { cm.setParameterValueById(id, value, weight === undefined ? 1 : weight); } catch (e) {}
  }

  // Set a sticky override (accessories / sliders / eye-follow) — re-applied
  // every frame so the model's own update can't erase it.
  function setSticky(id, value, weight) {
    state.overrides[id] = (weight === undefined ? 1 : weight) === 1 ? value
      : { value, weight: weight === undefined ? 1 : weight };
    pokeParam(id, value, weight);
  }

  function applyOverrides() {
    const cm = coreModel();
    if (!cm) return;
    for (const id in state.overrides) {
      const o = state.overrides[id];
      try {
        if (typeof o === 'object') cm.setParameterValueById(id, o.value, o.weight);
        else cm.setParameterValueById(id, o, 1);
      } catch (e) {}
    }
  }

  // ── Render-frame reassertion (beforeModelUpdate guard) ─────────
  // applyOverrides()/applyRawDrive() jalan di rAF tick kita — SETELAH
  // internalModel.update() frame yang sama selesai, sehingga tulisannya
  // ditimpa lagi oleh update() frame BERIKUTNYA: physics.evaluate()
  // menulis ulang SEMUA parameter output physics, eyeBlink menulis ulang
  // group EyeBlink, breath menulis ulang ParamBreath — semuanya SEBELUM
  // o.update() yang merender. Di lumine 178 dari 223 parameter adalah
  // output physics, jadi slider di atas param itu tampak mati (terukur
  // 0% frame menahan nilai slider). Library memancarkan
  // 'beforeModelUpdate' tepat sebelum o.update() — menulis ulang nilai
  // sticky PADA titik itu membuatnya benar-benar menjadi nilai yang
  // dirender, tanpa harus membekukan model (freeze tetap berguna untuk
  // pose diam). Ukur 0% → 100% di browser; guard:
  // test/legacy/test-override-guard.js.
  function installOverrideGuard(im) {
    if (!im || typeof im.on !== 'function' || im.__overrideGuard) return;
    im.__overrideGuard = true;
    im.on('beforeModelUpdate', () => {
      const cm = coreModel();
      if (!cm) return;
      for (const id in state.overrides) {
        const o = state.overrides[id];
        try {
          if (typeof o === 'object') cm.setParameterValueById(id, o.value, o.weight);
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
        try { cm.setParameterValueById(id, v, 1); } catch (e) {}
      }
    });
  }

  // ── Cache pengukuran efek visual (LEGACY — hanya untuk gate overlay) ──
  // Dulu ada fitur "🧪 Kalibrasi Efek" (render tiap param MIN vs MAX, hitung
  // piksel berubah) + badge "🚫 tanpa efek" + filter saran preset AI.
  // DIHAPUS 2026-09-02 atas keputusan user: hasil ukurnya sering tidak cocok
  // dengan apa yang terlihat (param bergerak halus terukur "mati"; param
  // yatim seperti ParamEyePhysics18 — tidak ada di physics3.json maupun di
  // ikatan art — justru terukur benar). Yang tersisa: cache localStorage v2
  // per model DIBACA oleh gate overlay-vs-native (overlayGateSuppress) sebagai
  // bukti "efek native hidup" untuk mencegah dobel-gambar. Tanpa data (model
  // tak pernah discan / localStorage bersih) gate fail-open: overlay jalan
  // seperti sebelum fix shim — bukan efek yang hilang. Tidak ada scanner baru:
  // data yang ada adalah warisan scan lama dan tidak pernah ditulis ulang.
  function visfxStoreKey(modelKey) {
    // v2 — cache lama (kunci 'l2d_visfx_…') dihasilkan scanner yang ternoda
    // override-hold + idle-restart, dan/atau diambil saat shim stamp moc
    // v5→v4 masih membuta (param BlendShape terukur mati palsu — 171/223
    // param rig v5 bertipe ini). Data lama otomatis tak terbaca.
    return 'l2d_visfx_v2_' + (modelKey || 'default');
  }
  function visfxLoad() {
    try { return JSON.parse(localStorage.getItem(visfxStoreKey(currentModelKey())) || 'null'); }
    catch (e) { return null; }
  }

  // ── Parts (opacity) — distinct from Parameters ──
  // Cubism models expose two separate systems: Parameters (deformation, what
  // we've been driving above) and Parts (per-layer opacity, 0..1). The model's
  // parts are enumerated below for the inspect/capability engine.
  // Enumerate every Part this model owns (id + current opacity as default).
  function enumerateParts() {
    const cm = coreModel();
    const out = [];
    try {
      const gm = (cm && cm.getModel) ? cm.getModel() : cm;
      if (!gm || typeof gm.getPartCount !== 'function') return out;
      const n = gm.getPartCount();
      for (let i = 0; i < n; i++) {
        let id = '';
        try { id = (typeof gm.getPartIds === 'function') ? gm.getPartIds()[i] : ''; } catch (e) {}
        if (!id) continue;
        let def = 1;
        try { def = gm.getPartOpacityByIndex ? gm.getPartOpacityByIndex(i) : 1; } catch (e) {}
        out.push({ id, min: 0, max: 1, def, group: 'Bagian (Parts)', label: id });
      }
    } catch (e) { console.warn('[inspect] part enumeration failed:', e.message); }
    return out;
  }

  // Read a parameter's CURRENT value (eased) so the AI pose can build on top
  // of where the character already is — this is what makes transitions smooth
  // instead of snapping to a fixed number.
  function readParam(id) {
    const cm = coreModel();
    if (!cm) return 0;
    try { return cm.getParameterValueById(id); } catch (e) { return 0; }
  }

  // ─── Init Pixi Application (v6 API) ───────────────────────────
  // The canvas lives inside #stage (left of the sidebar), so the renderer
  // must match the STAGE element size — NOT the full window. Otherwise the
  // drawing buffer is wider than the displayed canvas and the character
  // gets squished horizontally ("gepeng").
  function stageSize() {
    const el = document.getElementById('stage');
    const w = el ? el.clientWidth : 0;
    const h = el ? el.clientHeight : 0;
    return {
      w: w > 0 ? w : Math.max(280, window.innerWidth - 380),
      h: h > 0 ? h : window.innerHeight,
    };
  }
  const _sz = stageSize();
  const app = new PIXI.Application({
    view: $('#live2d-canvas'),
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
    const canvas = $('#live2d-canvas');
    canvas.style.width  = sz.w + 'px';
    canvas.style.height = sz.h + 'px';
  }
  fitCanvas();
  window.addEventListener('resize', () => {
    fitCanvas();
    if (state.model) {
      // Re-frame through frameModel() instead of slamming the model to the raw
      // screen CENTER. The model's anchor is top-left (0,0), so assigning
      // x/y = screen/2 places its top-left corner at the middle of the canvas
      // and pushes the whole body off the bottom edge — only the top of the
      // head stays visible. frameModel() measures real bounds and centers the
      // ART, and it also refreshes state.basePos, which the idle loop restores
      // m.x/m.y from every frame (so a wrong basePos here is permanent).
      state.stageArea = { width: Math.max(280, app.screen.width - 380) };
      frameModel(state.fullBody ? 'full' : 'upper');
    }
  });

  // Ask the server which models exist and return a loadable path for the first
  // one. Extracted from the boot block so loadModel() with no argument and boot
  // share ONE fallback policy — previously boot auto-detected but loadModel()
  // fell back to a hardcoded path, so the two disagreed about what "default"
  // means. Returns null when the server has no models at all.
  async function resolveAnyModelPath() {
    try {
      const r = await fetch(API + '/api/models');
      if (!r.ok) return null;
      const d = await r.json();
      const first = (d.models && d.models[0]) || null;
      if (!first) return null;
      const rp = await fetch(API + '/api/model/path?name=' + encodeURIComponent(first));
      if (!rp.ok) return null;
      const dp = await rp.json();
      return dp.path || null;
    } catch (e) {
      console.warn('[model] auto-detect failed:', e.message);
      return null;
    }
  }

  // ─── Orphaned .exp3 adoption (model-agnostic) ─────────────────
  // A rigger can ship .exp3.json files and forget to list them in model3.json's
  // FileReferences.Expressions. pixi-live2d-display only creates an
  // ExpressionManager when settings.expressions exists, so those files are
  // simply never loaded: state.modelExpressions comes back empty, emotionMode
  // drops to 'synthetic', and assets the character was shipped with are dead.
  //
  // Fix: fetch the manifest ourselves, ask the server which .exp3 files actually
  // exist on disk (GET /api/model/expressions), merge the missing ones into
  // FileReferences.Expressions, and hand the PATCHED OBJECT to the loader.
  //
  // MODEL-AGNOSTIC by construction:
  //   • the model folder is derived from modelPath, never named
  //   • expression NAMES come from the filenames the rigger chose — we don't
  //     rename, translate, or interpret them (a name may be CJK, English, or
  //     numeric; all are equally valid)
  //   • nothing is added that the manifest already declares
  //   • the file on disk is never modified — the merge is in-memory only, so a
  //     user's model folder is left byte-identical
  //
  // NON-DESTRUCTIVE: any failure (offline server, unreadable JSON, no orphans)
  // returns null and the caller falls back to loading by URL.
  // Pure helper: which orphaned (undeclared) .exp3 files should be auto-adopted,
  // given the user's opt-out set. Extracted so Langkah 2d's exclusion logic is
  // unit-testable without booting the engine (test-fase4-adoption.js).
  //   - declared files are never "orphans" (rigger owns them)
  //   - files without File/Name are unresolvable → skipped
  //   - names in `disabled` (user opt-out) are skipped
  function filterAdoptable(onDisk, disabled) {
    // Realm-agnostic membership test: a Set created in another JS realm is not
    // `instanceof` this realm's Set, so we probe for a `.has` method first, then
    // fall back to array `.includes`. Keeps the opt-out logic correct even when
    // the disabled set arrives from a different context (e.g. a test sandbox).
    const isOff = (n) => {
      if (disabled && typeof disabled.has === 'function') return disabled.has(n);
      if (Array.isArray(disabled)) return disabled.indexOf(n) !== -1;
      return false;
    };
    return (Array.isArray(onDisk) ? onDisk : [])
      .filter(e => e && !e.declared && e.File && e.Name && !isOff(e.Name));
  }

  async function buildModelSettings(modelPath) {
    try {
      const parts = String(modelPath || '').split('/');
      // 'model/<folder>/.../x.model3.json' → '<folder>'. Everything after the
      // folder is handled server-side by findModel3(), which walks nesting.
      if (parts.length < 3 || parts[0] !== 'model') return null;
      const folder = parts[1];
      if (!folder) return null;

      const [mRes, eRes] = await Promise.all([
        fetch(API + '/' + modelPath.split('/').map(encodeURIComponent).join('/')),
        fetch(API + '/api/model/expressions?name=' + encodeURIComponent(folder)),
      ]);
      if (!mRes.ok || !eRes.ok) return null;

      const settings = await mRes.json();
      const info = await eRes.json();
      if (!settings || !settings.FileReferences) return null;

      // Langkah 2d: a user may have opted OUT of specific auto-adopted .exp3
      // files. We fetch that opt-out list and skip those names so adoption stays
      // model-agnostic AND respects user choice. If the endpoint is missing or
      // errors, we adopt everything (the old default) — never fail closed.
      let disabled = new Set();
      try {
        const aRes = await fetch(API + '/api/model/expressions-adoption?name=' + encodeURIComponent(folder));
        if (aRes.ok) {
          const aInfo = await aRes.json();
          if (Array.isArray(aInfo.disabled)) disabled = new Set(aInfo.disabled);
        }
      } catch (e) { /* adopt all on error */ }

      const onDisk = Array.isArray(info.expressions) ? info.expressions : [];
      const orphans = filterAdoptable(onDisk, disabled);
      if (!orphans.length) return null;   // manifest already complete (or all opted out)

      const declared = Array.isArray(settings.FileReferences.Expressions)
        ? settings.FileReferences.Expressions.slice()
        : [];
      // getExpressionIndex() matches on Name, so a duplicate Name would make one
      // entry permanently unreachable. Keep the rigger's declaration and skip our
      // discovery in that case — the declared File is the authoritative one.
      const takenNames = new Set(declared.map(e => e && e.Name).filter(Boolean));
      const takenFiles = new Set(declared.map(e => e && e.File).filter(Boolean));

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
      // The loader needs `url` on a settings object to resolve every relative
      // File/Texture path; without it the moc and textures 404.
      settings.url = new URL(modelPath.split('/').map(encodeURIComponent).join('/'),
                             location.href).href;
      console.log('[exp3] adopted', added, 'undeclared expression file(s) for', folder,
                  '→ total', declared.length);
      return settings;
    } catch (e) {
      console.warn('[exp3] adoption skipped:', e.message);
      return null;
    }
  }

  // ─── Load Model ───────────────────────────────────────────────
  // modelPath is OPTIONAL. When omitted we ask the server for whatever model it
  // actually has (there is no bundled default any more — a hardcoded path is a
  // guaranteed 404 on a machine with a different model installed).
  // autoInteract is OFF so the library's built-in pointer-follow does NOT fight
  // our own mouse handler.
  async function loadModel(modelPath) {
    try {
      if (typeof modelPath !== 'string' || !modelPath) {
        modelPath = await resolveAnyModelPath();
        if (!modelPath) throw new Error('Belum ada model terpasang. Upload model lewat tab 📁 Model.');
      }
      state.modelPath = modelPath;
      hideNoModelState();
      // Reset per-model derived state so a previous model's clips can't leak.
      state.motionTaxonomy = null;
      state.clipUntil = 0; state.clipName = null; state.clipStartedAt = 0;
      // unload previous model if switching
      if (state.model) {
        try { app.stage.removeChild(state.model); state.model.destroy(); } catch (e) {}
        state.model = null;
        // drop sticky overrides + timers from the previous model
        state.overrides = {};
        // Raw drive menunjuk id parameter milik model LAMA. Dibiarkan hidup, ia
        // akan menulis id yang tak ada di model baru setiap frame (no-op senyap
        // yang menyulitkan debug) atau — lebih buruk — id yang kebetulan sama
        // namanya tapi artinya beda di rig baru.
        state.rawDrive = null;
        state.rawDrivePrev = null;
        state.accessoryValues = {};
        state.activeEmotion = 'normal';
        state.activeProperty = 'default';
        if (state.idleMotionTimer) { clearInterval(state.idleMotionTimer); state.idleMotionTimer = null; }
        state.lookFrame = { eyeX:0, eyeY:0, w:1, h:1 };
        // state.caps describes the OLD model's parameters/roles. hydrateCaps()
        // refills it after the new sheet loads, but until then nothing may read
        // stale capabilities — a role id from the previous model would resolve
        // to a parameter the new model doesn't have.
        state.caps = {};
        state.modelParams = null;
        // cdi3 milik model LAMA — id param beda model beda makna.
        state.cdiInfo = null;
        // Emotion state is resolved against the OLD model's parameter ids, so all
        // of it is invalid the moment the model is swapped. Left behind, the eased
        // ease loop would keep writing the previous character's ids and the LLM
        // would still be told about emotions this model may not have.
        state.roleEmotions = {};
        state.supportedEmotions = {};
        state.emoTarget = {};
        state.emoCur = {};
        state.paramRange = {};
        // Belongs to the model being replaced; carrying it over would leak the
        // previous character's userNote into the new model's sheet.
        state.lastSheet = null;
        state.lastFileSheet = null;   // mirror file model lama — jangan sampai
                                      // field-nya terbawa ke re-inspeksi model baru
      }
      // The agent memoizes the capability profile; that cache belongs to the
      // model being replaced, so drop it here regardless of whether a model was
      // previously loaded.
      try { window.__agent && window.__agent.invalidateCapabilityProfile && window.__agent.invalidateCapabilityProfile(); } catch (e) {}

      // Load through a settings OBJECT rather than a URL string so orphaned
      // .exp3.json files can be adopted before the runtime reads the manifest.
      // buildModelSettings() returns null on any problem, in which case we hand
      // the plain URL to the loader exactly as before — the adoption step must
      // never be able to stop a model from loading.
      const settings = await buildModelSettings(modelPath);
      state.model = await PIXI.live2d.Live2DModel.from(settings || modelPath, {
        autoInteract: false,
      });

      app.stage.addChild(state.model);
      app.stage.sortableChildren = true;
      state.model.zIndex = 0;
      state.model.anchor.set(0, 0);   // top-left origin → easy to frame by top margin

      // Stage area = the canvas itself (renderer now matches #stage size),
      // so the character is centered within the full visible canvas.
      state.stageArea = { width: app.screen.width };

      // Per-model config must be resolved BEFORE framing and before blink/idle
      // start, otherwise the model briefly renders with the previous character's
      // settings. loadModelConfigLocal() is synchronous (localStorage only), and
      // applyModelConfig() does the framing itself (was a hardcoded 'upper').
      applyModelConfig(loadModelConfigLocal());

      console.log('[Live2D] Model loaded:', state.model);
      rememberModel(modelPath);
      // Preload sheet file ke mirror: existingUserFields() butuh sumber field
      // user sedini mungkin — cache localStorage saja tidak cukup (bisa kosong).
      fetchSheetFile().catch(() => {});

      startBlink();
      startIdle();
      installOverrideGuard(state.model.internalModel);
      state.visfxMap = visfxLoad();   // cache legacy untuk gate overlay-vs-native
      wireInteractions();
      detectModelCapabilities();   // adapt emotions/params to THIS model
      prefetchOverlayGate();       // bindings .exp3 untuk gate overlay-vs-native (fire-and-forget)
      prefetchCdiInfo();           // label + grup asli rigger dari cdi3 (fire-and-forget)
      startIdleMotion();           // auto-play model's own motions so it isn't a static T-pose

      // Classify this model's motion clips by semantic verb so gestures can be
      // matched to emotion. Fire-and-forget: the gesture scheduler treats a null
      // taxonomy as "synthetic gestures only", so nothing breaks while it loads.
      // Motion registry diisi SETELAH taxonomy selesai supaya meta durasi/verb
      // klip native ikut; lalu motion user di-fetch dari server.
      loadMotionTaxonomy()
        .then(() => initMotionRegistry())
        .catch(e => { console.warn('[taxonomy] load error', e); initMotionRegistry(); });

      // The note is per-model, so the textarea must follow the model swap.
      // Fire-and-forget: it only reads storage, nothing depends on it.
      refreshUserNoteUI().catch(e => console.warn('[note] UI refresh failed:', e));

      // Same for the config panel: it shows the PREVIOUS model's values until
      // repainted, which would let a Save write them onto the new model.
      try { refreshConfigForm(); } catch (e) { console.warn('[config] UI refresh failed:', e.message); }

      // Sheet pane too: preset lists belong to one model, so leaving the old
      // model's presets on screen would let a Terap/Hapus hit the wrong sheet.
      try { refreshSheetUI(); } catch (e) { console.warn('[sheet] UI refresh failed:', e.message); }

    } catch (err) {
      console.error('[Live2D] Failed to load model:', err);
      const p = $('#loader p');
      if (p) p.textContent = '❌ Gagal memuat model: ' + err.message;
      // Tanpa satu pun model: undangan impor di stage, bukan loader mati
      // yang menutupi seluruh UI (clone baru datang tanpa model).
      if (String((err && err.message) || '').includes('Belum ada model')) showNoModelState();
    }
  }

  // ─── Empty state + ingat model terakhir ──────────────────────
  // data/model/ di-gitignore (aset berlisensi), jadi clone baru datang kosong.
  // showNoModelState() menyembunyikan loader dan menampilkan undangan impor
  // di atas stage; hideNoModelState() dipanggil loadModel saat model berhasil
  // dilemparkan ke jalur pemuatan.
  function showNoModelState() {
    const loader = $('#loader');
    if (loader) loader.classList.add('done', 'fade-out', 'hidden');
    const empty = $('#stage-empty');
    if (empty) empty.classList.remove('hidden');
    const st = $('#sb-state');
    if (st) st.textContent = 'Tanpa model';
    console.warn('[model] belum ada model terpasang — empty state ditampilkan');
  }
  function hideNoModelState() {
    const empty = $('#stage-empty');
    if (empty) empty.classList.add('hidden');
  }
  // Ingat model terakhir yang berhasil dibuka (segmen folder pertama dari
  // path, mis. 'model/lumine/lumine.model3.json' → 'lumine') — boot berikutnya
  // memuat yang itu. localStorage bisa terlarang: bukan fatal.
  function rememberModel(modelPath) {
    try {
      const seg = String(modelPath).split('/');
      if (seg[0] === 'model' && seg[1]) localStorage.setItem('live2d_last_model', seg[1]);
    } catch (e) { /* abaikan */ }
  }

  // ─── Blink System (uses real parameter ids) ──────────────────
  function startBlink() {
    if (state.blinkInterval) clearInterval(state.blinkInterval);
      const blinkOnce = () => {
        if (!state.model || !state.blinkEnabled) return;
        // Hold still while the user is posing/inspecting (preset editor or the
        // param-notes popup freeze): no blinking during a hand-built pose.
        if (state.frozen) return;
      try {
        // Blink in ROLE space: fully-closed / fully-open are the ENDS of the
        // model's own eyeOpen range, not the literals 0 and 1. A rig using
        // 0..100 (or an inverted range) still blinks correctly this way.
        pokeRoleNorm('eyeLOpen', 0);
        pokeRoleNorm('eyeROpen', 0);
        setTimeout(() => {
          pokeRoleNorm('eyeLOpen', 1);
          pokeRoleNorm('eyeROpen', 1);
        }, 140);
      } catch (e) { /* swallow */ }
    };
    state.blinkInterval = setInterval(() => {
      if (Math.random() < 0.15) blinkOnce();
    }, 3000);
  }

  // ─── Idle Animation + LIVELY "alive" engine ──────────────────
  // IMPORTANT: all life comes from the model's OWN rigged parameters (head
  // angles, eye-balls, breath, body tilt, mouth), NOT by moving/scaling the
  // whole sprite. We never touch model.x / model.y / model.scale here — the
  // character stays framed; only her internal params animate, so she looks
  // alive (neuro-sama style) whether idle or mid-response.
  function startIdle() {
    if (state.idleRAF) cancelAnimationFrame(state.idleRAF);
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const m = state.model;
      if (!m) { state.idleRAF = requestAnimationFrame(tick); return; }

      // Decay the transient "life" signals fired per response segment.
      state.impulse *= 0.90;
      if (state.impulse < 0.001) state.impulse = 0;
      state.energyBoost *= 0.96;
      if (state.energyBoost < 0.001) state.energyBoost = 0;

      const t = now / 1000;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const owned = (id) => !state.caps.params || state.caps.params.has(id);
      const liveliness = Math.min(2.4, (state.talking ? 1 : 0.4) + state.energyBoost);

      // ── Autonomous "life" oscillators (rigged params, visible amplitude) ──
      // These run every frame so she is NEVER frozen, and grow while talking.
      const headXLife = (state.talking ? 14 : 8) + state.impulse * 12;
      const headYLife = (state.talking ? 8 : 5);
      const A1 = Math.sin(t * 0.7) * headXLife + Math.sin(t * 1.9) * headXLife * 0.3;   // head L/R
      const A2 = Math.sin(t * 0.5 + 1.0) * headYLife + Math.sin(t * 2.3) * headYLife * 0.25; // head U/D
      const E1 = Math.sin(t * 0.35) * 0.35 + Math.sin(t * 1.3 + 0.5) * 0.2;            // eye L/R wander
      const E2 = Math.sin(t * 0.45 + 2.0) * 0.22 + (state.talking ? Math.sin(t * 3.1) * 0.2 : 0); // eye U/D
      const breath = Math.sin(t * 1.1) * 0.5 + 0.5;                                     // 0..1 chest
      const tiltLife = Math.sin(t * 0.4 + 0.7) * (state.talking ? 7 : 4) + state.impulse * 8; // body/head tilt
      const bodyLeanLife = Math.sin(t * 0.6) * 4 + Math.sin(t * 1.4) * 1.5;             // weight shift
      const talkHead = state.talking ? Math.sin(t * 9.0) * 5 : 0;                        // speech head bob

      // ── Resolve the control target (mouse vs AI) + layer life on top ──
      let bAx, bAy, bEx, bEy, bMf, bBx, bBy, bBz;
      if (!state.aiLock) {
        // Mouse-follow, but with life mixed in so she still moves when idle.
        const L = state.look, k = 0.28;
        L.ax += (L.tax - L.ax) * k; L.ay += (L.tay - L.ay) * k;
        L.ex += (L.tex - L.ex) * k; L.ey += (L.tey - L.ey) * k;
        L.bx += (L.tbx - L.bx) * k; L.by += (L.tby - L.by) * k;
        bAx = L.ax + A1 * 0.5;
        bAy = L.ay + A2 * 0.5;
        bEx = L.ex + E1;
        bEy = L.ey + E2;
        bMf = 0; bBx = L.bx + bodyLeanLife * 0.4; bBy = L.by; bBz = tiltLife * 0.4;
      } else {
        // AI lock: pose target + BIG fidget + life + speech head bob.
        // When the parameter-notes popup is FROZEN (user is dragging a slider),
        // suppress the fidget oscillators so the slider alone drives the rig —
        // the whole point is to see what THIS parameter does without the idle
        // animation fighting it. Mouse-follow is already off (it gates on
        // !aiLock). Unfreeze after 10s of no dragging returns here to normal.
        const frozen = !!state.frozen;
        const P = state.aiPose;
        state.fidgetT += dt;
        const ft = state.fidgetT + state.fidgetSeed;
        const amp = frozen ? 0 : (1 + liveliness * 1.6);
        const fx = frozen ? 0 : (Math.sin(ft * 0.6) * 9 + Math.sin(ft * 1.7) * 3) * amp;
        const fy = frozen ? 0 : (Math.sin(ft * 0.45 + 1.3) * 7 + Math.sin(ft * 2.1) * 2.5) * amp;
        bAx = P.ax + fx + (frozen ? 0 : talkHead);
        bAy = P.ay + fy;
        bEx = P.ex + fx * 0.05 + (frozen ? 0 : E1);
        bEy = P.ey + fy * 0.05 + (frozen ? 0 : E2);
        bMf = P.mouthForm;
        bBx = P.bodyX + (frozen ? 0 : (Math.sin(ft * 0.5) * 5 + Math.sin(ft * 1.1) * 1.5) * amp);
        bBy = P.bodyY;
        bBz = P.bodyZ + (frozen ? 0 : Math.sin(ft * 0.33 + 0.7) * 5 * amp + tiltLife);
      }

      // Global motion amplitude boost (config: motion.enabled + motion.gain).
      // OFF by default (gain 1) so behaviour is unchanged unless the user opts
      // in via config.json. Scales the whole control intent (look + life + AI
      // fidget) together; values past the model's real range simply clamp.
      const mGain = (MOTION && MOTION.enabled) ? (MOTION.gain || 1) : 1;
      bAx *= mGain; bAy *= mGain; bEx *= mGain; bEy *= mGain;
      bMf *= mGain; bBx *= mGain; bBy *= mGain; bBz *= mGain;

      // ── Ease current param values toward the live target ──
      // CLIP HANDOFF: while a native motion clip owns the rig we must not also
      // write head/eye/body params — the clip animates them and our ease pulls
      // them somewhere else, so the two writers fight and the result reads as
      // stiff twitching. Instead of hard-cutting (which snaps at both ends) we
      // ramp our authority down over 200ms at clip start and back up over 350ms
      // after it ends, so control crossfades.
      const CLIP_IN_MS = 200, CLIP_OUT_MS = 350;
      let poseAuthority = 1;
      if (state.clipUntil) {
        const nowMs = performance.now();
        const remain = state.clipUntil - nowMs;
        if (remain > 0) {
          // Inside the clip: fade out fast, hold at 0.
          const elapsed = nowMs - (state.clipStartedAt || nowMs);
          poseAuthority = Math.max(0, 1 - elapsed / CLIP_IN_MS);
        } else if (-remain < CLIP_OUT_MS) {
          // Just ended: fade our control back in.
          poseAuthority = Math.min(1, -remain / CLIP_OUT_MS);
        } else {
          state.clipUntil = 0;      // fully handed back
          state.clipName = null;
        }
      }

      const ease = state.talking ? 0.25 : 0.16;
      const target = (role, vRef) => {
        const id = roleId(role);
        if (!id || !owned(id)) return;
        if (poseAuthority <= 0.001) return;   // clip owns this parameter
        // Map the reference-scale intent into THIS model's real range, then
        // clamp to the actual min/max. Scaling the STEP (not the target) by
        // poseAuthority keeps the clip handoff continuous.
        const actual = roleClampActual(role, toActual(role, vRef));
        const cur = readParam(id);
        pokeParam(id, cur + (actual - cur) * ease * poseAuthority, 1);
      };
      if (state.caps.hasHead) {
        target('angleX', bAx);
        target('angleY', bAy);
      }
      if (state.caps.hasEyes) {
        target('eyeBallX', clamp(bEx, -1, 1));
        target('eyeBallY', clamp(bEy, -1, 1));
      }
      if (roleId('mouthForm'))
        target('mouthForm', clamp(bMf, -1, 1));

      if (state.caps.hasBody) {
        target('bodyAngleX', bBx);
        target('bodyAngleY', bBy);
        target('bodyAngleZ', bBz);
      } else if (roleId('angleZ')) {
        // No body-lean params: a visible head/body tilt keeps her lively.
        target('angleZ', tiltLife + (state.aiLock ? bBz * 0.5 : 0));
      }

      // Breathing drives the chest/body param directly (smooth controller).
      // `breath` is authored 0..1 (none..full) so it maps through role space.
      // Suppressed while frozen so a posed character is truly still (no "napas").
      if (state.hasBreath && !state.frozen) pokeRoleNorm('breath', clamp(breath, 0, 1));

      // ── EASED EMOTION (morph the face instead of snapping) ──
      if (state.emoCur) {
        const e = 0.12;
        const eyeLO = roleId('eyeLOpen'), eyeRO = roleId('eyeROpen');
        for (const id in state.emoTarget) {
          // Eye-open is owned by the blink system — never fight it here.
          if (id === eyeLO || id === eyeRO) continue;
          const tgt = state.emoTarget[id];
          const cur = (state.emoCur[id] === undefined) ? readParam(id) : state.emoCur[id];
          const nv = cur + (tgt - cur) * e;
          state.emoCur[id] = nv;
          if (owned(id)) pokeParam(id, nv, 1);
        }
      }

      if (state.talking && !state.frozen) {
        const mId = roleId('mouthOpenY');
        if (mId) {
          let openness;
          const lip = state.audioLipSync;
          if (lip && lip.active) {
            // Lip-sync presisi: keterbukaan mengikuti amplitudo audio ASLI —
            // senyap di antara kata benar-benar menutup mulut, bukan terus
            // bergetar dengan ritme palsu.
            openness = lip.sample();
          } else {
            const base = 0.35 + 0.4 * Math.abs(Math.sin(t * 9));   // syllable rhythm
            const jitter = Math.random() < 0.25 ? 0.25 : 0;         // occasional wider open
            openness = Math.min(1, base + jitter);
          }
          // Openness is authored as a 0..1 fraction; map it into the model's
          // real mouthOpen range instead of writing 0..1 literally. On a rig
          // using 0..100 a raw 0.75 would be a 0.75% open mouth — i.e.
          // visually shut while "talking".
          const r = roleRange('mouthOpenY');
          state.overrides[mId] = r ? r.min + openness * (r.max - r.min) : openness;
        }
      }
      applyOverrides();
      applyRawDrive();
      state._tickCount = (state._tickCount || 0) + 1;
      state.idleRAF = requestAnimationFrame(tick);
    };    state.idleRAF = requestAnimationFrame(tick);
  }

  // ─── Idle Motion (auto-play the model's own motions) ──────────
  // Many imported models (e.g. Ichika) ship motions but NO idle loop, so they
  // sit in a static T-pose. We periodically fire one of the model's own motion
  // groups (pixi-live2d's model.motion(group, index|random)) so the character
  // actually moves. If the model has no motions we silently skip.
  function startIdleMotion() {
    if (state.idleMotionTimer) clearInterval(state.idleMotionTimer);
    const m = state.model;
    if (!m) return;
    const im = m.internalModel && m.internalModel.motionManager;
    if (!im) return;
    const groups = (im.definitions && Object.keys(im.definitions)) ||
                   (m.motions && Object.keys(m.motions)) || [];
    if (!groups.length) return;   // no motions → nothing to play
    const playRandom = () => {
      if (!state.model || !state.idleEnabled) return;
      // Don't fight the AI: the model's own idle motion would override the
      // AI's eased pose, so pause it while the AI has the lock.
      if (state.aiLock) return;
      if (clipIsPlaying()) return;   // a clip is already running

      // Prefer a clip that matches her current mood. When idle that's usually
      // 'normal', which the taxonomy maps to calm verbs (neutral/nod/tilt) —
      // so a resting character no longer randomly bursts into an angry or
      // crying animation, which was the old behaviour here.
      if (playEmotionClip(state.activeEmotion || 'normal')) return;

      // No taxonomy (or nothing compatible): fall back to the original random
      // pick so models still move rather than freezing in a T-pose.
      try {
        const g = groups[Math.floor(Math.random() * groups.length)];
        // index = -1 / 'random' picks a random clip in the group
        state.model.motion(g, -1, 1);
      } catch (e) { /* ignore */ }
    };
    playRandom();
    state.idleMotionTimer = setInterval(playRandom, 7000);  // a little life every 7s
  }

  // ─── Mouse / Touch Interactions ────────────────────────────────
  function wireInteractions() {
    const canvas = $('#live2d-canvas');

    // Head + eye-follow: store a TARGET on mousemove; the frame loop eases
    // CURRENT -> TARGET and writes it with weight=1 (precise + smooth).
    //
    // The look reference point is the CHARACTER'S FACE (eye line), NOT the
    // canvas center. So when the cursor sits on her eyes she looks straight
    // ahead (neutral); only when the cursor moves away does she tilt to follow.
    // (Previously the reference was the canvas center ≈ her belly, which made
    // her tilt UP whenever the cursor was near her face.)
    canvas.addEventListener('mousemove', (e) => {
      if (state.isDragging || !state.model || state.aiLock) return;
      const m = state.model;

      // ── Look mapping, normalized against the REACHABLE cursor area ──
      //
      // The eye line is the neutral reference: cursor on her eyes -> looks
      // straight ahead. But normalizing the offset by the model's LOCAL height
      // (lb.height, the whole body ≈ 8000 units) is what made her unable to
      // look up: in upper-body framing her eye line sits only ~129px below the
      // canvas top but ~495px above the bottom, so the cursor could only ever
      // produce ~36% of the upward range while downward saturated past 100%.
      // The container really was clipping her gaze — exactly the asymmetry.
      //
      // Fix: normalize each direction by the space ACTUALLY available on that
      // side of the eye line inside the canvas. Cursor at the top edge now
      // means "full look up", bottom edge "full look down", on any framing,
      // zoom level or window size.
      const lb = m.getLocalBounds();
      const eyeLocalX = lb.x + lb.width / 2;
      const eyeLocalY = lb.y + lb.height * 0.22;
      const eye = m.toGlobal(new PIXI.Point(eyeLocalX, eyeLocalY));
      const W = app.screen.width, H = app.screen.height;

      // Keep the reference point inside the canvas with a guaranteed margin on
      // every side. When zoomed in far enough that her eye line sits ABOVE the
      // top edge, the raw eye point would leave zero room above it — the cursor
      // could then only ever be "below her eyes" and she'd be stuck looking
      // down. Clamping to a 15% margin trades a slightly offset neutral point
      // at extreme zoom for gaze that always reaches full travel both ways.
      const MARGIN = 0.15;
      const refX = clamp(eye.x, W * MARGIN, W * (1 - MARGIN));
      const refY = clamp(eye.y, H * MARGIN, H * (1 - MARGIN));

      const upRoom    = Math.max(1, refY);
      const downRoom  = Math.max(1, H - refY);
      const leftRoom  = Math.max(1, refX);
      const rightRoom = Math.max(1, W - refX);

      const rawY = e.clientY - refY;
      const rawX = e.clientX - refX;
      // ny/nx are -1..+1 where POSITIVE = UP / RIGHT, independent of framing.
      const ny = clamp(-rawY / (rawY < 0 ? upRoom : downRoom), -1, 1);
      const nx = clamp(rawX / (rawX < 0 ? leftRoom : rightRoom), -1, 1);

      // Cubism sign convention (verified against this rig): ParamAngleY and
      // ParamEyeBallY are POSITIVE when looking UP, so ny maps straight across.
      // Gains use the role reference scale (REF_HALF for degree roles, ±1 for
      // normalized ones) so ±1 input = full travel without clamping. The old
      // gains (55 for angles, 4 for eyeballs) overshot the reference range and
      // clamped, which is why the gaze felt like it snapped between extremes.
      state.look.tax =  nx * REF_HALF;    // head turn L/R
      state.look.tay =  ny * REF_HALF;    // head tilt up/down (+ = up)
      state.look.tex =  nx;               // eye ball x (±1 = full)
      state.look.tey =  ny;               // eye ball y (+ = up)
      // Body leans with her (25% of head travel) so it isn't just the head.
      state.look.tbx =  nx * REF_HALF * 0.25;
      state.look.tby =  ny * REF_HALF * 0.25;
    });

    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    // Scroll to zoom — scale AROUND the current screen-center of the model,
    // so zooming out reveals the full body instead of shrinking toward the head.
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!state.model) return;
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      const newScale = Math.max(0.15, Math.min(3, state.model.scale.x + delta));
      setScaleAroundCenter(newScale);
      if (state._showFullBtn) state._showFullBtn();
    }, { passive: false });

    // Double-click to reset framing
    canvas.addEventListener('dblclick', () => {
      if (!state.model) return;
      state.model.rotation = 0;
      state.look.tax = state.look.tay = state.look.tex = state.look.tey = 0;
      state.look.bx = state.look.by = state.look.tbx = state.look.tby = 0;
      state.look.ax = state.look.ay = state.look.ex = state.look.ey = 0;
      frameModel('reset');
    });
  }

  function onPointerDown(e) {
    if (!state.model) return;
    state.isDragging = true;
    state.dragTarget = state.model;
    state.dragOffset.x = e.clientX - state.model.x;
    state.dragOffset.y = e.clientY - state.model.y;
    $('#live2d-canvas').style.cursor = 'grabbing';
    if (state._showFullBtn) state._showFullBtn();
  }

  function onPointerMove(e) {
    if (!state.isDragging || !state.dragTarget || !state.model) return;
    state.model.x = e.clientX - state.dragOffset.x;
    state.model.y = e.clientY - state.dragOffset.y;
    // Keep idle sway anchored to wherever the user dragged it
    state.basePos.x = state.model.x;
    state.basePos.y = state.model.y;
  }

  function onPointerUp() {
    state.isDragging = false;
    state.dragTarget = null;
    $('#live2d-canvas').style.cursor = 'grab';
  }

  // ─── Framing (top-level so loadModel + interactions can both call it) ───
  // Zoom while keeping the model's on-screen center fixed (no head-only shrink).
  function setScaleAroundCenter(newScale) {
    const m = state.model;
    if (!m) return;
    const mw = m.width * m.scale.x, mh = m.height * m.scale.y;
    const cx = m.x + mw / 2, cy = m.y + mh / 2;   // anchor is top-left (0,0)
    m.scale.set(newScale);
    const nw = m.width * newScale, nh = m.height * newScale;
    m.x = cx - nw / 2;
    m.y = cy - nh / 2;
    state.scale = newScale;
    if ($('#sl-scale')) { $('#sl-scale').value = newScale.toFixed(2); $('#val-scale').textContent = newScale.toFixed(2); }
  }

  // Frame the model: 'upper' (head+shoulders, default), 'full' (whole body), 'reset'.
  function frameModel(mode) {
    if (!state.model) return;
    const m = state.model;
    const W = app.screen.width, H = app.screen.height;
    const stageW = (state.stageArea && state.stageArea.width) || W * 0.55;

    // Intrinsic size measured from actual rendered bounds (robust — does NOT
    // trust m.width/m.height, which can disagree with the drawn art).
    let b = m.getBounds();
    const natW = b.width / m.scale.x, natH = b.height / m.scale.y;

    let scale;
    if (mode === 'full') {
      // fit the ENTIRE body into stage height with a small margin
      scale = (H * 0.82) / natH;
    } else if (mode === 'upper') {
      scale = Math.min(stageW / natW, H / natH) * 1.05;
    } else { // reset
      scale = Math.min(stageW / natW, H / natH) * 0.9;
    }

    m.scale.set(scale);

    // Cache intrinsic (scale-1) size so the per-frame breathing/bob transform
    // can keep the model centered regardless of the current zoom.
    state.natW = natW;
    state.natH = natH;

    // Center using the ACTUAL bounds at the new scale (verify-correct pass),
    // so horizontal/vertical placement is exact regardless of rigging quirks.
    b = m.getBounds();
    const ax = stageW / 2;
    m.x = ax - b.width / 2;     // center horizontally within the left stage
    m.y = (H - b.height) / 2;   // center vertically within the window
    state.basePos.x = m.x;
    state.basePos.y = m.y;
    state.scale = scale;
    if ($('#sl-scale')) { $('#sl-scale').value = scale.toFixed(2); $('#val-scale').textContent = scale.toFixed(2); }
  }

  // ─── Expression System (correct API) ─────────────────────────
  //
  // Two kinds of "expression":
  //   1) Model's own .exp3 expressions (name-based, e.g. 围裙, 眼镜, 呆猫…).
  //      These are actually PROPERTY toggles (apron/glasses/pen…), not emotions.
  //   2) REAL EMOTIONS we synthesize from the model's facial parameters
  //      (brows, eye-smile, mouth form). The model HAS these params
  //      (ParamBrowLForm, ParamEyeLSmile, ParamMouthForm, …) but ships no
  //      emotion .exp3 — so we drive them directly. This is the fix for the
  //      "expressions look like duplicates of accessories" problem.
  // ─── Cubism-style parameter catalog (for the emotion editor) ───
  // Mirrors the Live2D Cubism inspector: every parameter is grouped the
  // same way Cubism Editor organizes them (Angle / Eye / Eyebrow / Mouth /
  // Body / Hair / Accessory / custom ParamXX). The editor shows ONLY params
  // THIS model actually owns (filtered against state.modelParams), so users
  // see exactly "what can be moved" on their character — like Cubism itself.

  // ── Model-agnostic role → actual parameter id mapping ──
  // Live2D creators name parameters however they like (English Param* names,
  // Japanese 目/口/眉/頭, Chinese 左目/口開, etc.). To drive the "alive"
  // animation on ANY model we map semantic ROLES (head/eye/mouth/body/breath)
  // to the model's REAL parameter ids. Exact English Param* ids are tried
  // first for precision; keyword lists (incl. CJK) catch other conventions.
  const ROLE_KEYWORDS = {
    angleX:     ['ParamAngleX','AngleX','angle_x','yaw','turnx','rotx','頭','头','横向','左右','朝向x','方向x'],
    angleY:     ['ParamAngleY','AngleY','angle_y','pitch','turny','roty','縦','纵向','上下','朝向y','方向y'],
    angleZ:     ['ParamAngleZ','AngleZ','angle_z','roll','tilt','傾','倾','回転z','旋转z','歪'],
    eyeBallX:   ['ParamEyeBallX','EyeBallX','eyeball_x','lookx','瞳X','瞳','眼球','目玉','视x'],
    eyeBallY:   ['ParamEyeBallY','EyeBallY','eyeball_y','looky','瞳Y','瞳','眼球','目玉','视y'],
    eyeLOpen:   ['ParamEyeLOpen','EyeLOpen','eye_l_open','左目','左眼'],
    eyeROpen:   ['ParamEyeROpen','EyeROpen','eye_r_open','右目','右眼'],
    eyeLSmile:  ['ParamEyeLSmile','EyeLSmile','eye_l_smile','左目笑','左眼笑'],
    eyeRSmile:  ['ParamEyeRSmile','EyeRSmile','eye_r_smile','右目笑','右眼笑'],
    eyeForm:    ['ParamEyeForm','EyeForm','eye_form','目形','眼形'],
    mouthOpenY: ['ParamMouthOpenY','MouthOpenY','mouth_open','口開','张口','张嘴'],
    mouthForm:  ['ParamMouthForm','MouthForm','mouth_form','口角','口形','嘴形','口型'],
    mouthOpenX: ['ParamMouthOpenX','MouthOpenX','mouth_wide','口幅','嘴宽'],
    bodyAngleX: ['ParamBodyAngleX','BodyAngleX','body_angle_x','bodyx','体','胴','躯'],
    bodyAngleY: ['ParamBodyAngleY','BodyAngleY','body_angle_y','bodyy','体','胴','躯'],
    bodyAngleZ: ['ParamBodyAngleZ','BodyAngleZ','body_angle_z','bodyz','体','胴','躯'],
    breath:     ['ParamBreath','Breath','breath','呼吸','breathe','息'],
    browLForm:  ['ParamBrowLForm','BrowLForm','brow_l','左眉','眉'],
    browRForm:  ['ParamBrowRForm','BrowRForm','brow_r','右眉','眉'],
    browLY:     ['ParamBrowLY','BrowLY','brow_l_y','左眉Y','左眉上下'],
    browRY:     ['ParamBrowRY','BrowRY','brow_r_y','右眉Y','右眉上下'],
    browLAngle: ['ParamBrowLAngle','BrowLAngle','brow_l_angle','左眉角'],
    browRAngle: ['ParamBrowRAngle','BrowRAngle','brow_r_angle','右眉角'],
    // MODEL-AGNOSTIC RULE: never list a NUMBERED id (Param91, Param92, ...) here.
    // Numbered ids are arbitrary per-rigger slots — 'Param91' is blush on ONE
    // model and could be a tail/button/prop on the next, so matching it would
    // silently animate a random body part whenever the character blushes.
    // Only real semantic tokens belong in this table.
    // 'cheekpuff'/'puff' is EXCLUDED on purpose: puffing the cheeks (mouth full
    // of air) is a different action from blushing (skin reddening).
    blush:      ['ParamBlush','Blush','blush','ParamCheekRed','CheekRed',
                 '頬紅','ほお染め','照れ','脸红','腮红','害羞'],
  };

  // ── Official ground-truth from model3.json "Groups" ──
  // Cubism Editor lets the model creator explicitly tag which parameters are
  // EyeBlink / LipSync in the "Groups" section of the .model3.json — this is
  // authored metadata, not a naming guess, so it beats any keyword heuristic
  // whenever it's present. pixi-live2d-display already parses this for us
  // (internalModel.eyeBlinkIds / lipSyncIds, sourced from
  // settings.getEyeBlinkParameters() / getLipSyncParameters()).
  function getOfficialGroups(m) {
    const out = { eyeBlinkIds: [], lipSyncIds: [] };
    if (!m || !m.internalModel) return out;
    const im = m.internalModel;
    try {
      if (Array.isArray(im.eyeBlinkIds) && im.eyeBlinkIds.length) out.eyeBlinkIds = im.eyeBlinkIds.slice();
      else if (im.settings && typeof im.settings.getEyeBlinkParameters === 'function') {
        out.eyeBlinkIds = im.settings.getEyeBlinkParameters() || [];
      }
    } catch (e) {}
    try {
      if (Array.isArray(im.lipSyncIds) && im.lipSyncIds.length) out.lipSyncIds = im.lipSyncIds.slice();
      else if (im.settings && typeof im.settings.getLipSyncParameters === 'function') {
        out.lipSyncIds = im.settings.getLipSyncParameters() || [];
      }
    } catch (e) {}
    return out;
  }

  // Pick the member of an official Groups array that matches a semantic intent,
  // instead of trusting ARRAY ORDER. The order inside model3.json "Groups" is
  // authored arbitrarily by the rigger: on some models LipSync[0] is
  // ParamMouthForm, not ParamMouthOpenY. Taking index 0 therefore aliases
  // mouthOpenY onto mouthForm and three writers (lip-sync, pose easing, emotion
  // morph) fight over ONE param every frame -> the mouth never opens.
  // Strategy: score by name tokens (multi-language), fall back to null so the
  // caller can continue to the canonical-id / keyword tiers rather than
  // committing to a wrong id.
  function pickFromGroup(list, patterns) {
    if (!Array.isArray(list) || !list.length) return null;
    for (const re of patterns) {
      const hit = list.find(id => typeof id === 'string' && re.test(id));
      if (hit) return hit;
    }
    return null;
  }

  // Intent patterns for members of the official Groups arrays. Ordered
  // most-specific first. Deliberately NO numbered ids and no positional
  // assumptions — these are semantic tokens only (EN / JA / ZH).
  const GROUP_PATTERNS = {
    mouthOpenY: [/openy$/i, /mouthopen/i, /open/i, /口開|開口|口を開/, /张口|张嘴|开口/],
    eyeLOpen:   [/eyelopen/i, /^parameyel.*open/i, /_l_?open/i, /left.*open/i, /左目|左眼/],
    eyeROpen:   [/eyeropen/i, /^parameyer.*open/i, /_r_?open/i, /right.*open/i, /右目|右眼/],
  };

  // Build the role→actualId map for a set of owned param ids.
  // `official` (optional) = { eyeBlinkIds, lipSyncIds } read straight from the
  // model3.json Groups metadata — authored truth about WHICH params belong to a
  // group, but NOT about their order. We therefore use it as a candidate pool
  // and select by name intent (pickFromGroup), never by index.
  function mapRoles(paramSet, official) {
    const ids = {};
    if (!paramSet || !paramSet.size) return ids;
    const list = Array.from(paramSet).map(id => id.toLowerCase());
    const lowerToReal = {};
    Array.from(paramSet).forEach((id, i) => { lowerToReal[list[i]] = id; });
    for (const role in ROLE_KEYWORDS) {
      // 0) OFFICIAL model3.json Groups — authored by the model creator. Beats
      // name guessing, but ONLY when we can identify the intended member by
      // name; a bare index would be a coin flip (see pickFromGroup).
      if (official && GROUP_PATTERNS[role]) {
        const pool = (role === 'mouthOpenY') ? official.lipSyncIds : official.eyeBlinkIds;
        // Restrict to params the model really owns, so a stale/incorrect Groups
        // entry can't inject a nonexistent id.
        const owned = (pool || []).filter(id => paramSet.has(id));
        const picked = pickFromGroup(owned, GROUP_PATTERNS[role]);
        if (picked) { ids[role] = picked; continue; }
        // If the group has exactly ONE owned member there is no ambiguity to
        // resolve — that member IS the role.
        if (owned.length === 1) { ids[role] = owned[0]; continue; }
        // Otherwise fall through to the canonical/keyword tiers below.
      }
      // 1) exact English Param* id (most precise)
      const canonical = 'Param' + role.charAt(0).toUpperCase() + role.slice(1);
      if (paramSet.has(canonical)) { ids[role] = canonical; continue; }
      // 2) keyword substring (EN + CJK) — last resort
      let foundLower = null;
      for (const kw of ROLE_KEYWORDS[role]) {
        const lk = kw.toLowerCase();
        const hit = list.find(x => x.includes(lk));
        if (hit) { foundLower = hit; break; }
      }
      if (foundLower) ids[role] = lowerToReal[foundLower];
    }
    // INVARIANT: mouthOpenY and mouthForm must never resolve to the SAME param.
    // If they do, lip-sync and mouth-shape writers collide and the mouth freezes.
    // Prefer keeping mouthForm and re-deriving mouthOpenY from an owned param.
    if (ids.mouthOpenY && ids.mouthOpenY === ids.mouthForm) {
      const alt = Array.from(paramSet).find(id =>
        /open/i.test(id) && /mouth|口|嘴/i.test(id) && id !== ids.mouthForm);
      if (alt) ids.mouthOpenY = alt;
      else delete ids.mouthOpenY;   // absent is safer than aliased
      console.warn('[roles] mouthOpenY aliased onto mouthForm; resolved to',
        ids.mouthOpenY || '(none)');
    }
    return ids;
  }

  // Get the actual model param id for a semantic role (or null when absent).
  const roleId = (role) => (state.caps && state.caps.ids && state.caps.ids[role]) || null;

  // ── Range-aware motion (fixes "stiff / head-only on other models") ──
  // All motion code below authors values in a REFERENCE scale (tuned for
  // 神宫白子, whose head param half-range ≈ 30°). We map that reference value
  // proportionally into THIS model's real parameter range (from Cubism Core via
  // state.paramRange) so the same code produces natural motion on any model —
  // small-range models get small motion, large-range models get large motion,
  // instead of everything slamming into a hard-coded ±42 clamp.
  const REF_HALF = 30;
  // Roles authored in DEGREES (±30 reference = full travel) vs NORMALIZED roles
  // (±1 reference = full travel, e.g. eyeBall / mouth / brow). Mixing the two on
  // one ±30 scale made normalized params (esp. the eyes) move only ~3% of their
  // range — so the gaze looked "stuck in the middle" no matter where the mouse
  // went. Splitting the reference scale fixes eye-follow on models like Lumine.
  const DEGREE_ROLES = new Set(['angleX','angleY','angleZ','bodyAngleX','bodyAngleY','bodyAngleZ']);
  const refHalfFor = (role) => DEGREE_ROLES.has(role) ? REF_HALF : 1;
  function roleRange(role) {
    const id = roleId(role);
    if (!id || !state.paramRange || !state.paramRange[id]) return null;
    return state.paramRange[id];
  }
  // Convert a reference-scale value into the model's actual parameter value.
  function toActual(role, vRef) {
    const RH = refHalfFor(role);
    const r = roleRange(role);
    if (!r) return clamp(vRef, -RH, RH);   // no range info → assume full reference
    const mid = (r.max + r.min) / 2, half = (r.max - r.min) / 2;
    return mid + (vRef / RH) * (half || RH);
  }
  // Clamp an already-actual value to the model's real min/max (fallback ±42).
  function roleClampActual(role, v) {
    const r = roleRange(role);
    if (!r) return clamp(v, -42, 42);
    return clamp(v, r.min, r.max);
  }

  // ── Role-space writers: the ONLY sanctioned way to drive a semantic role ──
  // MODEL-AGNOSTIC RULE: never write a literal number into a role param. Values
  // like `pokeParam(eyeLOpen, 0)` / `pokeParam(breath, 0.7)` silently assume the
  // model uses the same numeric convention as the model the code was written
  // against. The two models measured here BOTH happen to use eyeOpen 0..1 and
  // angle ±30, which is exactly why such bypasses stayed invisible — a rigger
  // using eyeOpen 0..100, an inverted range (1=closed), or a non-zero default
  // would produce a character that never blinks or never breathes, with no error.
  //
  // pokeRoleNorm(role, t)  — t in 0..1 maps across the role's REAL min..max.
  //                          t=0 -> min, t=1 -> max. Use for open/closed,
  //                          breath, mouth-open: anything with a natural
  //                          "none .. full" reading.
  // pokeRoleRef(role, vRef) — vRef in the REFERENCE scale (±30 for degree roles,
  //                          ±1 for normalized ones), mapped proportionally into
  //                          the model's real range. Use for angles/gaze.
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
  // Resting value of a role — the model's OWN declared default, not a literal 0.
  // A rigger may default eyeOpen to 1 (open) or mouthOpen to 0; assuming 0 for
  // both is how "her eyes start shut" bugs appear on an imported model.
  function roleDefault(role) {
    const r = roleRange(role);
    if (r && typeof r.def === 'number') return r.def;
    return 0;
  }



  // ── Universal emotions, authored in ROLE SPACE ────────────────
  // MODEL-AGNOSTIC RULE: an emotion is described by WHICH SEMANTIC ROLES move
  // and HOW FAR in the reference scale — never by parameter id. The role→id map
  // is resolved per model by mapRoles(), so the same table produces a correct
  // face on a rig named in English, Japanese or Chinese, and produces NOTHING
  // on a rig that lacks the parts (better absent than wrong).
  //
  // Values follow the same two-scale convention as the writers above:
  //   • roles in NORM_TEMPLATE_ROLES → 0..1 "none..full" openness
  //   • every other role            → reference scale (±30 degrees / ±1 normalized)
  //
  // eyeLOpen / eyeROpen appear in NO template on purpose: the blink system owns
  // them, and the ease loop skips them anyway. Listing them would create targets
  // that can never be written.
  const NORM_TEMPLATE_ROLES = new Set(['mouthOpenY', 'mouthOpenX', 'breath']);
  const EMOTION_ROLE_TEMPLATES = {
    senang:    { mouthForm:  0.9, eyeLSmile:  0.8, eyeRSmile:  0.8, browLForm:  0.4, browRForm:  0.4, mouthOpenY: 0.35, angleZ:  4 },
    tersenyum: { mouthForm:  0.6, eyeLSmile:  0.5, eyeRSmile:  0.5, angleZ:  3 },
    sedih:     { mouthForm: -0.8, browLForm: -0.7, browRForm: -0.7, browLY: -0.5, browRY: -0.5, eyeBallY: -0.4, angleY: -6 },
    malu:      { mouthForm:  0.3, eyeLSmile:  0.4, eyeRSmile:  0.4, eyeBallX: -0.5, browLY: -0.2, browRY: -0.2, angleZ:  6 },
    kaget:     { mouthOpenY: 0.8, browLY:  0.7, browRY:  0.7, browLForm: 0.3, browRForm: 0.3, eyeBallY:  0.2, angleY:  5 },
    kesal:     { mouthForm: -0.6, browLForm: -0.9, browRForm: -0.9, browLAngle: -0.6, browRAngle: -0.6, eyeBallX: 0.3, angleZ: -3 },
    bingung:   { angleZ:  9, browLY:  0.4, browRY: -0.3, browLForm: 0.2, mouthForm: -0.2, eyeBallX:  0.5 },
  };
  // One lonely role is not a recognisable emotion — it reads as a twitch. Below
  // this many resolved roles we decline to offer the emotion at all, per the
  // "jangan menebak lalu diam" rule.
  const EMOTION_MIN_ROLES = 2;

  // Map a template value for one role into THIS model's real parameter value.
  function emotionActualFor(role, v) {
    const r = roleRange(role);
    if (NORM_TEMPLATE_ROLES.has(role)) {
      const t = clamp(v, 0, 1);
      return r ? r.min + t * (r.max - r.min) : t;
    }
    const RH = refHalfFor(role);
    return r ? roleClampActual(role, toActual(role, v)) : clamp(v, -RH, RH);
  }

  // Resolve the role templates against the CURRENT model. Returns
  // { emotionName: { realParamId: actualValue } } containing only emotions this
  // model can actually express. Rebuilt on every model load — never read from a
  // sheet, because a sheet is a cache and may predate the role mapping.
  function buildRoleEmotions() {
    const out = {};
    if (!state.caps || !state.caps.ids) return out;
    for (const emo in EMOTION_ROLE_TEMPLATES) {
      const tpl = EMOTION_ROLE_TEMPLATES[emo];
      const vals = {};
      let resolved = 0;
      for (const role in tpl) {
        const id = roleId(role);
        if (!id) continue;                                            // model lacks this part
        if (state.caps.params && !state.caps.params.has(id)) continue; // metadata was stale
        // Two roles can collapse onto one id on a coarse rig (e.g. a single brow
        // param). Two writers on one param is exactly the mouthOpenY/mouthForm
        // aliasing bug, so the first role wins and the second is dropped.
        if (vals[id] !== undefined) continue;
        vals[id] = emotionActualFor(role, tpl[role]);
        resolved++;
      }
      if (resolved < EMOTION_MIN_ROLES) continue;
      out[emo] = vals;
    }
    return out;
  }

  // Refresh state.roleEmotions + state.supportedEmotions for the current model.
  // User-authored 'emosi' presets are layered on top afterwards by
  // projectEmotionPresets(), preserving the documented user > builtin precedence.
  function refreshRoleEmotions() {
    state.roleEmotions = buildRoleEmotions();
    state.supportedEmotions = Object.assign({}, state.roleEmotions);
    console.log('[emotion] role-derived vocabulary:', Object.keys(state.roleEmotions).join(', ') || '(none — model lacks facial roles)');
    return state.roleEmotions;
  }

  // Set the eased emotion TARGET from a preset (param->value) with optional
  // intensity factor. Any param the PREVIOUS emotion moved but this one does not
  // mention is eased back to the model's OWN declared default, so the last
  // expression never "sticks". Current values are seeded from the live param so
  // the morph starts from wherever the face already is.
  function setEmotionTargets(preset, intensity) {
    if (!state.model) return;
    // Intensity scales AWAY FROM THE MODEL'S DEFAULT, not from zero. A rig whose
    // mouthForm rests at 0.5 would read intensity*value as "half closed" if we
    // scaled from 0 — the classic literal-zero assumption.
    const k = (intensity === undefined || intensity === null)
      ? 1 : clamp(Number(intensity) || 0, 0, 1.5);
    const has = (id) => !state.caps.params || state.caps.params.has(id);
    const defOf = (id) => {
      const r = state.paramRange && state.paramRange[id];
      return (r && typeof r.def === 'number') ? r.def : 0;
    };
    const next = {};
    for (const id in (preset || {})) {
      if (!id || !has(id)) continue;
      let v = Number(preset[id]);
      if (!Number.isFinite(v)) continue;
      const d = defOf(id);
      v = d + (v - d) * k;
      const r = state.paramRange && state.paramRange[id];
      if (r && typeof r.min === 'number' && typeof r.max === 'number') v = clamp(v, r.min, r.max);
      next[id] = v;
    }
    // Release whatever the previous emotion held.
    for (const id in state.emoTarget) {
      if (next[id] !== undefined) continue;
      next[id] = defOf(id);
    }
    for (const id in next) {
      if (state.emoCur[id] === undefined) state.emoCur[id] = readParam(id);
    }
    state.emoTarget = next;
  }

  // Clear all emotion-driven params back to neutral. Passing an empty preset
  // makes setEmotionTargets() ease every held param back to the model's own
  // default instead of snapping — and instead of leaving it stuck, which is what
  // happened while this only reset native .exp3 state.
  function resetEmotion() {
    const mgr = state.model && state.model.internalModel &&
                state.model.internalModel.motionManager &&
                state.model.internalModel.motionManager.expressionManager;
    if (mgr && typeof mgr.resetExpression === 'function') mgr.resetExpression();
    setEmotionTargets({});
    // Overlay efek emosi app-level ikut padam — resetEmotion adalah satu-satunya
    // titik yang SELALU dilewati setiap kali ekspresi kembali ke normal (native,
    // synthetic, maupun preset).
    try { window.__emotionOverlay && window.__emotionOverlay.clear(); } catch (e) {}
  }

  // ─── Adaptive model capabilities (for user-imported models) ────
  // A user may import ANY Cubism model. We must NOT assume it has the same
  // parameters / .exp3 expressions as 神宫白子. After load we introspect the
  // model and decide how to drive emotions:
  //   • NATIVE  → model ships its own .exp3 expressions → use those directly.
  //   • SYNTHETIC → no .exp3 (or unknown) → drive the facial params the model
  //     actually owns, so we never poke a parameter the model lacks.
  function detectModelCapabilities() {
    const m = state.model;
    if (!m) return;
    const cm = coreModel();
    console.log('[cap] coreModel?', !!cm, 'internalModel?', !!(m.internalModel));
    if (m.internalModel) console.log('[cap] internalModel keys:', Object.keys(m.internalModel).join(','));

    // ── Enumerate ALL parameter IDs this model owns ──
    // Cubism models vary widely; we try every known path until one works.
    let paramIds = [];

    // Path A: pixi-live2d model has getParameterIds() directly
    try {
      if (typeof m.getParameterIds === 'function') paramIds = m.getParameterIds() || [];
    } catch (e) {}

    // Path A2: raw core parameter table. Checked early because it is the
    // engine's own storage — the same source inspectModel() reads. The paths
    // below dig through wrapper internals and only happened to work here by
    // luck (cm._parameterIds), which is exactly how inspectModel() ended up
    // silently falling back to guessed ranges.
    if (!paramIds.length && cm) {
      try {
        const gm = cm.getModel && cm.getModel();
        const ids = gm && gm.parameters && gm.parameters.ids;
        if (ids && ids.length) paramIds = Array.prototype.slice.call(ids);
      } catch (e) {}
    }

    // Path B: CubismModel wrapper via cm.getModel()
    if (!paramIds.length && cm) {
      try {
        const gm = cm.getModel && cm.getModel();
        if (gm && typeof gm.getParameterIds === 'function') paramIds = gm.getParameterIds() || [];
      } catch (e) {}
    }

    // Path C: iterate via getParameterCount() + getParameterId(i)
    if (!paramIds.length && cm) {
      try {
        const gm = cm.getModel && cm.getModel();
        const src = gm || cm;
        if (typeof src.getParameterCount === 'function' && typeof src.getParameterId === 'function') {
          const n = src.getParameterCount();
          for (let i = 0; i < n; i++) {
            const id = src.getParameterId(i);
            if (id) paramIds.push(id);
          }
        }
      } catch (e) {}
    }

    // Path D: internalModel.parameters array (pixi-live2d legacy)
    if (!paramIds.length && m.internalModel && Array.isArray(m.internalModel.parameters)) {
      try {
        paramIds = m.internalModel.parameters.map(p => p.id).filter(Boolean);
      } catch (e) {}
    }

    // Path E: raw CubismModel._parameterIds (last resort — dig into internal)
    if (!paramIds.length && cm) {
      try {
        const gm = cm.getModel && cm.getModel();
        // CubismModel stores IDs in _parameterIds or _model.parameters.ids
        if (gm && Array.isArray(gm._parameterIds) && gm._parameterIds.length) {
          paramIds = gm._parameterIds.slice();
        } else if (gm && gm._model && gm._model.parameters && Array.isArray(gm._model.parameters.ids)) {
          paramIds = gm._model.parameters.ids.slice();
        }
      } catch (e) {}
    }

    // Path F: scan all properties for anything that looks like a parameter array
    if (!paramIds.length && cm) {
      try {
        const gm = cm.getModel && cm.getModel();
        if (gm) {
          // Check common Cubism property paths
          for (const key of ['_parameterIds', 'parameterIds']) {
            if (Array.isArray(gm[key]) && gm[key].length) { paramIds = gm[key].slice(); break; }
          }
          // Check if the coreModel itself has the array
          if (!paramIds.length) {
            for (const key of ['_parameterIds', 'parameterIds']) {
              if (Array.isArray(cm[key]) && cm[key].length) { paramIds = cm[key].slice(); break; }
            }
          }
        }
      } catch (e) {}
    }

    console.log('[cap] paramIds found:', paramIds.length, '→', JSON.stringify(paramIds).slice(0, 400));
    state.modelParams = new Set(paramIds);

    // Map semantic roles → this model's REAL parameter ids so the "alive"
    // animation drives the correct params regardless of how the creator named
    // them (English Param* / Japanese / Chinese / etc.).
    state.caps.ids = mapRoles(state.modelParams, getOfficialGroups(m));
    const R = state.caps.ids;
    state.caps.hasHead  = !!(R.angleX || R.angleY);
    state.caps.hasEyes  = !!(R.eyeBallX || R.eyeBallY || R.eyeLOpen || R.eyeROpen);
    state.caps.hasMouth = !!(R.mouthOpenY || R.mouthForm);
    state.caps.hasBody  = !!(R.bodyAngleX || R.bodyAngleY || R.bodyAngleZ);
    state.caps.hasBrow  = !!(R.browLForm || R.browRForm);
    state.hasBreath     = !!R.breath;
    console.log('[cap] role ids:', JSON.stringify(R));

    // Populate TRUE per-parameter ranges straight from Cubism Core so the
    // motion system can scale amplitudes to THIS model (range-aware). Don't
    // rely on the sheet alone — read every load so a fresh/changed model is
    // always correct.
    try {
      const cm = coreModel();
      const gm = (cm && cm.getModel) ? cm.getModel() : cm;
      if (gm && typeof gm.getParameterCount === 'function') {
        const n = gm.getParameterCount();
        for (let i = 0; i < n; i++) {
          const pid = gm.getParameterId(i);
          if (!pid) continue;
          let lo, hi, def;
          try {
            lo = gm.getParameterMinimumValue(i);
            hi = gm.getParameterMaximumValue(i);
            def = gm.getParameterDefaultValue(i);
          } catch (e) { continue; }
          if (typeof lo !== 'number' || typeof hi !== 'number') continue;
          state.paramRange[pid] = {
            min: lo, max: hi,
            def: (typeof def === 'number' ? def : (lo + hi) / 2),
          };
        }
        console.log('[cap] paramRange populated:', Object.keys(state.paramRange).length);
      }
    } catch (e) { console.warn('[cap] paramRange read failed', e.message); }

    // 2) native expressions (exp3 names) if the model ships any
    let exprs = [];
    try {
      if (Array.isArray(m.expressions)) exprs = m.expressions.slice();
      else if (m.expressions && typeof m.expressions === 'object') exprs = Object.keys(m.expressions);
    } catch (e) {}
    // The Cubism core often exposes them here:
    try {
      const em = m.internalModel && m.internalModel.motionManager &&
                 m.internalModel.motionManager.expressionManager;
      if (em && Array.isArray(em.deferred)) exprs = exprs.concat(em.deferred.map(x => x && x.name).filter(Boolean));
    } catch (e) {}
    // SUMBER PALING ANDAL: settings.expressions — definisi {Name, File} yang
    // DIBACA LOADER dari model3.json (plus adopsi yatim). m.expressions dan
    // em.deferred ternyata kosong di pixi-live2d 0.4 utk model yang manifestnya
    // lengkap: mode jatuh ke 'synthetic' padahal 8 .exp3 terdaftar (神宫白子)
    // dan tombol tes ekspresi tidak berefek sama sekali (keluhan 2026-09-02).
    try {
      const st = m.internalModel && m.internalModel.settings;
      if (st && Array.isArray(st.expressions)) {
        exprs = exprs.concat(st.expressions.map(e => e && e.Name).filter(Boolean));
      }
    } catch (e) {}
    state.modelExpressions = Array.from(new Set(exprs.filter(Boolean)));

    state.emotionMode = state.modelExpressions.length ? 'native' : 'synthetic';

    // Build the universal emotion vocabulary for THIS model. Must run AFTER
    // caps.ids and paramRange are populated above, because every template value
    // is mapped through the role ranges. Rebuilt on every load so swapping a
    // model can never leave the previous character's parameter ids behind.
    refreshRoleEmotions();

    console.log('[Live2D] capabilities:', JSON.stringify({
      mode: state.emotionMode,
      paramCount: state.modelParams.size,
      sampleParams: Array.from(state.modelParams).slice(0, 60),
      nativeExpr: state.modelExpressions,
      universalEmotions: Object.keys(state.roleEmotions || {}),
    }));
  }

  // ── Gate overlay vs efek native (dobel-gambar di rig v5) ────────
  // Overlay kompensasi dibuat untuk ekspresi yang rig-nya TIDAK menggambar
  // apa pun. Setelah shim moc v5→v4 diperbaiki (try-genuine-first), rig v5
  // dengan keyform BlendShape kini hidup — exp_heart dsb. menggambar efeknya
  // sendiri, dan overlay menggambar LAGI (hati melayang dobel). Gate: kalau
  // ekspresi NATIVE yang cocok ada dan pengukuran lama mengukur efeknya
  // ALIVE, overlay ditekan. Dua sumber data:
  //   • bindings .exp3 dari disk (GET /api/model/expressions?name=) —
  //     nama → daftar param id yang ditulis file .exp3 itu. Cukup SATU
  //     param terukur mengubah piksel untuk menyimpulkan efeknya digambar
  //     native.
  //   • state.visfxMap — cache pengukuran LEGACY dari fitur "Kalibrasi
  //     Efek" yang sudah dihapus (per param: changed, maxDelta). Tidak ada
  //     scanner baru; data hanya dari localStorage warisan. Tanpa data =
  //     TIDAK TAHU → fail-open (overlay jalan, seperti dulu); kegagalan
  //     fetch juga fail-open. Menekan overlay hanya boleh terjadi dengan
  //     bukti terukur, tidak dengan tebakan.
  // Per model (cache dibuang saat model diganti); nama file .exp3 tidak
  // diinterpretasi — cuma dicocokkan dengan nama ekspresi yang dipasang.
  let overlayGateExprs = null;   // { name: [paramId, ...] } | null | undefined (undefined = belum di-fetch)
  let overlayGateModelPath = null;
  // Server melaporkan `params` per ekspresi (Id dari isi file .exp3.json —
  // ditambahkan ke discoverExpressions, backward-compatible).
  function overlayGateExpBindings() {
    if (overlayGateModelPath !== (state.modelPath || '')) {
      overlayGateExprs = undefined;   // model ganti — cache basi
      overlayGateModelPath = state.modelPath || '';
    }
    if (overlayGateExprs !== undefined) return Promise.resolve(overlayGateExprs);
    const folder = String(state.modelPath || '').split('/')[1];
    if (!folder) { overlayGateExprs = null; return Promise.resolve(null); }
    return fetch(API + '/api/model/expressions?name=' + encodeURIComponent(folder))
      .then(r => (r.ok ? r.json() : null))
      .then(info => {
        const map = {};
        const list = (info && Array.isArray(info.expressions)) ? info.expressions : [];
        for (const e of list) {
          if (!e || !e.Name) continue;
          map[e.Name] = Array.isArray(e.params) ? e.params.filter(Boolean) : [];
        }
        overlayGateExprs = map;
        return map;
      })
      .catch(() => { overlayGateExprs = null; return null; });
  }
  // MURNI — dipakai guard test (vm), tanpa DOM/window/state. Keputusan gate:
  //   true  = efek native TERUKUR hidup → overlay ditekan (hindari dobel-gambar)
  //   false = tidak ada bukti native hidup → overlay jalan (fail-open)
  // Fail-open adalah arah yang aman: data basi/kurang paling parah membuat
  // overlay jalan seperti sebelum fix shim — bukan efek yang hilang.
  //   • bukan efek overlay (resolveFx null) → bukan urusan gate
  //   • tanpa kalibrasi (visfx null) → tidak tahu → jangan tekan
  //   • bindings tidak memuat nama ini (mis. alias emosi 'sedih', bukan
  //     nama .exp3) → bukan ekspresi native → jangan tekan
  //   • param yang BELUM dikalibrasi diabaikan (bukan bukti); butuh minimal
  //     satu param terukur changed > 0 untuk menyimpulkan native menggambar.
  function overlayGateSuppress(name, bindings, visfx, resolveFx) {
    if (typeof resolveFx !== 'function' || !resolveFx(name)) return false;
    if (!visfx) return false;
    const bare = String(name || '').replace(/^user:/, '');
    const ids = (bindings && Object.prototype.hasOwnProperty.call(bindings, name)) ? bindings[name]
      : (bindings && Object.prototype.hasOwnProperty.call(bindings, bare)) ? bindings[bare]
      : null;
    if (!Array.isArray(ids) || !ids.length) return false;
    for (const id of ids) {
      const m = visfx[id];
      if (!m || typeof m.changed !== 'number') continue;
      if (m.changed > 0) return true;
    }
    return false;
  }
  // Sinkron akses ke cache bindings (harus sudah di-fetch; undefined → null).
  function overlayGateExpBindingsSync() {
    return overlayGateExprs === undefined ? null : overlayGateExprs;
  }
  // Dipanggil fireOverlay: keputusan gate SYNC (jalur ekspresi sync), jadi
  // bindings di-prefetch saat model dimuat; sebelum tiba → fail-open.
  function overlayShouldSuppress(name) {
    const ov = window.__emotionOverlay;
    return overlayGateSuppress(
      name,
      overlayGateExpBindingsSync(),
      state.visfxMap,
      (ov && ov._resolve) ? (n) => ov._resolve(n) : null
    );
  }
  function prefetchOverlayGate() {
    overlayGateExpBindings().catch(() => {});
  }

  // Judul grup rigger untuk header popup: GroupId mentah ("ParamGroup17") tak
  // berarti — pakai label anggota pertama + jumlah sisanya. Penanda "Rig:"
  // membedakannya dari grup heuristik.
  function cdiGroupTitle(gid) {
    if (!(state.cdiInfo && state.cdiInfo.groups.has(gid))) return gid;
    const members = state.cdiInfo.groups.get(gid) || [];
    const named = members.map(id => {
      const info = state.cdiInfo.byId.get(id);
      return info && info.label;
    }).filter(Boolean);
    return named.length
      ? ('Rig: ' + named[0] + (named.length > 1 ? ' +' + (named.length - 1) : ''))
      : gid;
  }

  // Label + pengelompokan ASLI rigger dari cdi3.json (DisplayInfo). Sumber:
  //   Parameters[i] = { Id, Name, GroupId } — file yang sama yang ditulis
  //   Live2D Editor saat rig dibuat. Gagal fetch = fitur tanpa data (label
  //   kembali ke id mentah, grup kembali ke heuristik) — tidak error.
  // state.cdiInfo = { byId: Map paramId → {label, group}, groups: Map GroupId →
  // [paramId...] dalam urutan file }.
  function prefetchCdiInfo() {
    const modelPath = String(state.modelPath || '');
    const dir = modelPath.split('/').slice(0, -1).join('/');
    if (!dir) return;
    // Ambil model3.json untuk menemukan DisplayInfo (path cdi3 relative ke
    // folder model), lalu cdi3-nya sendiri.
    fetch(API + '/' + modelPath)
      .then(r => (r.ok ? r.json() : null))
      .then(m3 => {
        const cdiRel = m3 && m3.FileReferences && m3.FileReferences.DisplayInfo;
        if (!cdiRel) return null;
        return fetch(API + '/' + dir + '/' + cdiRel)
          .then(r => (r.ok ? r.json() : null));
      })
      .then(cdi => {
        if (!cdi || !Array.isArray(cdi.Parameters)) return;
        const byId = new Map();
        const groups = new Map();
        for (const p of cdi.Parameters) {
          if (!p || !p.Id) continue;
          byId.set(p.Id, { label: String(p.Name || '').trim(), group: String(p.GroupId || '').trim() });
          if (p.GroupId) {
            if (!groups.has(p.GroupId)) groups.set(p.GroupId, []);
            groups.get(p.GroupId).push(p.Id);
          }
        }
        state.cdiInfo = { byId, groups };
        // Sheet yang sudah ada (disk/localStorage) memakai label=id mentah +
        // grup heuristik — patch in place supaya UI/LLM langsung merasakan
        // label rigger tanpa menunggu re-inspect. label/grup BUKAN field
        // user-authored, jadi menimpanya aman.
        const sheet = state.lastSheet;
        if (sheet && Array.isArray(sheet.params)) {
          let changed = false;
          for (const p of sheet.params) {
            const info = byId.get(p && p.id);
            if (!info) continue;
            if (info.label && p.label !== info.label) { p.label = info.label; changed = true; }
            if (info.group && p.group !== cdiGroupTitle(info.group)) { p.group = cdiGroupTitle(info.group); changed = true; }
          }
          if (changed) {
            // Popup sedang terbuka? Render ulang lewat jembatan yang dipasang
            // wireUI() (renderParamNotesPopup hidup di scope dalam wireUI).
            if (window.__pnRefreshIfOpen) window.__pnRefreshIfOpen();
          }
        }
      })
      .catch(() => {});
  }

  // Overlay efek emosi (js/emotion-overlay.js): modul mandiri yang menggambar
  // efek hati/blush/kilau/air mata untuk ekspresi yang rig-nya tidak mengikat
  // art (terukur via kalibrasi). Nama apa pun diteruskan — yang tak cocok
  // diabaikan di dalam modul; kegagalan modul tidak boleh menyentuh ekspresi.
  function fireOverlay(name) {
    try {
      if (overlayShouldSuppress(name)) {
        console.log('[overlay] suppressed (efek native hidup):', name);
        return;
      }
      window.__emotionOverlay && window.__emotionOverlay.onExpression(name);
    } catch (e) {}
  }

  async function applyExpression(name, intensity) {
    if (!state.model) return;

    // Normal / reset (works in both modes)
    if (name === 'normal' || name === 'default') {
      state.activeEmotion = 'normal';
      state.activeProperty = 'default';
      resetEmotion();
      $$('.expr-btn').forEach(b => b.classList.toggle('active', b.dataset.expr === 'normal'));
      console.log('[Live2D] Expression reset -> normal');
      return;
    }

    // ── Preset 'properti' / 'aksesoris' ──
    // Checked BEFORE the native .exp3 lookup so a user preset wins over a
    // built-in expression name (the documented user > ai > builtin precedence),
    // but AFTER supportedEmotions so a 'properti' preset that happens to share a
    // name with an emotion cannot silently disable the emotion engine — that
    // has a far bigger blast radius than losing one name to the other side.
    //
    // This is what gives the 'properti' category an execution path at all;
    // before this, a saved 'properti' preset was inert.
    if (!state.supportedEmotions.hasOwnProperty(name)) {
      const propPreset = findPreset(name, 'properti') || findPreset(name, 'aksesoris');
      if (propPreset) {
        // Toggle semantics match the rest of this function: pressing the active
        // property again returns to default instead of re-applying it.
        if (state.activeProperty === name && intensity === undefined) {
          state.activeProperty = 'default';
          resetEmotion();
          $$('.expr-btn').forEach(b => b.classList.toggle('active', b.dataset.expr === 'normal'));
          console.log('[Live2D] Property preset toggled off ->', name);
          return;
        }
        const ok = applyPreset(propPreset, propPreset.category);
        if (ok) {
          // activeEmotion is deliberately left alone: a property (glasses on,
          // collar changed) is orthogonal to the face, so applying one must not
          // clear the emotion the character is currently wearing.
          state.activeProperty = name;
          $$('.expr-btn').forEach(b => b.classList.toggle('active', b.dataset.expr === name));
          console.log('[Live2D] Property preset ->', name, '(' + propPreset.source + ')');
          return;
        }
        // applyPreset() returning false means every id in the preset was stale
        // for THIS model. Fall through rather than reporting success.
        console.warn('[Live2D] Property preset had no valid target for this model:', name);
      }
    }

    // NATIVE mode: the model has its own .exp3 expressions.
    //   • Universal emotions are driven via params (supportedEmotions)
    //   • Model's own .exp3 names are played directly via model.expression().
    if (state.emotionMode === 'native') {
      // universal emotion preset?
      if (state.supportedEmotions.hasOwnProperty(name)) {
        if (state.activeEmotion === name && intensity === undefined) {
          state.activeEmotion = 'normal'; state.activeProperty = 'default';
          resetEmotion();
          $$('.expr-btn').forEach(b => b.classList.toggle('active', b.dataset.expr === 'normal'));
          return;
        }
        state.activeEmotion = name; state.activeProperty = 'default';
        const preset = state.supportedEmotions[name];
        setEmotionTargets(preset, intensity);
        // Punctuate the emotion change with a clip whose verb matches it, so the
        // BODY agrees with the face instead of drifting on the old gesture.
        playEmotionClip(name);
        fireOverlay(name);
        $$('.expr-btn').forEach(b => b.classList.toggle('active', b.dataset.expr === name));
        console.log('[Live2D] Universal emotion (native) ->', name, 'intensity:', intensity);
        return;
      }
      // otherwise treat as a native .exp3 name
      if (state.activeEmotion === name || state.activeProperty === name) {
        // toggle off back to normal
        state.activeEmotion = 'normal'; state.activeProperty = 'default';
        resetEmotion();
        $$('.expr-btn').forEach(b => b.classList.toggle('active', b.dataset.expr === 'normal'));
        return;
      }
      state.activeEmotion = name; state.activeProperty = 'default';
      resetEmotion();
      // Overlay DIPASANG SEBELUM model.expression(): justru untuk ekspresi
      // yang tidak terdaftar di model3.json (art-nya tidak diekspor) call
      // expression() melempar — dan itulah kasus yang overlay-nya wajib jalan.
      fireOverlay(name);
      try {
        await state.model.expression(name);
        $$('.expr-btn').forEach(b => b.classList.toggle('active', b.dataset.expr === name));
        console.log('[Live2D] Native expression ->', name);
      } catch (err) {
        console.warn('[Live2D] Native expression error:', err);
      }
      return;
    }

    // SYNTHETIC mode: drive facial params the model actually has.
    if (state.supportedEmotions.hasOwnProperty(name)) {
      if (state.activeEmotion === name && intensity === undefined) {
        name = 'normal';
      }
      state.activeEmotion = name;
      state.activeProperty = 'default';
      if (name === 'normal') {
        resetEmotion();
      } else {
        const preset = state.supportedEmotions[name];
        setEmotionTargets(preset, intensity);
        playEmotionClip(name);   // body follows the face (see native branch)
        fireOverlay(name);
      }
      $$('.expr-btn').forEach(b => b.classList.toggle('active', b.dataset.expr === name));
      console.log('[Live2D] Synthetic emotion ->', name, 'intensity:', intensity);
    } else {
      // Nama tak dikenal di mode synthetic (mis. 'exp_heart' — efek yang
      // rig-nya tidak mengikat art, 0 piksel via kalibrasi): wajah tidak
      // bisa diubah, dan justru INILAH kasus overlay kompensasi wajib.
      // fireOverlay menyeleksi sendiri nama mana yang cocok tabelnya.
      fireOverlay(name);
    }
  }

  // ─── Accessory Toggle ─────────────────────────────────────────
  function toggleAccessory(paramId, val) {
    if (!state.model) return;
    const current = state.accessoryValues[paramId] || 0;
    const next = current > 0.5 ? 0 : val;
    state.accessoryValues[paramId] = next;
    if (next > 0.5) setSticky(paramId, next, 1);
    else delete state.overrides[paramId];   // turn off -> stop holding
    pokeParam(paramId, next, 1);

    $$('.acc-btn').forEach(btn => {
      if (btn.dataset.param === paramId) {
        btn.classList.toggle('active', next > 0.5);
      }
    });
  }

  // ─── Bubble Chat ──────────────────────────────────────────────
  let bubbleTimeout = null;
  function showBubble(text, duration = 4000) {
    const bubble = $('#bubble');
    const textEl = $('#bubble-text');
    if (bubbleTimeout) clearTimeout(bubbleTimeout);
    textEl.textContent = text;
    bubble.classList.remove('hidden');
    bubbleTimeout = setTimeout(() => bubble.classList.add('hidden'), duration);
  }
  function hideBubble() {
    const bubble = $('#bubble');
    if (bubbleTimeout) clearTimeout(bubbleTimeout);
    bubble.classList.add('hidden');
  }

  // ─── Speech (TTS + lip-sync) ───────────────────────────────────
  // Drives the browser SpeechSynthesis voice (id-ID) and animates the mouth
  // (ParamMouthOpenY) via a timer-driven oscillation so lip-sync works even
  // where audio is unavailable. Agent layer can call speak() directly later.
   // speak(text, onDone) — TTS + lip-sync. Calls onDone() when speech finishes.

  // ─── Remote TTS (Colab/Gradio) — URL diambil dari config.json (tts.endpoint) ───
  // Edit config.json, bukan file ini. Kosongkan ('') untuk pakai browser SpeechSynthesis bawaan.
  let TTS_ENDPOINT = '';
  // Single source of truth for ambient-event behaviour. `quietMs` is the startup
  // grace period the agent honours before it is allowed to speak unprompted; it
  // used to be a hardcoded constant inside agent.js, which made it impossible to
  // configure or to test in anything under 30 real minutes.
  let EVENTS = { idleSpeak: true, idleMs: 1800000, idleRepeatMs: 1800000, awaySpeak: true, returnSpeak: true, awayHiddenMs: 10000, quietMs: 1800000 };
  // Published so agent.js can read the LIVE object (loadAppConfig() mutates it in
  // place via Object.assign, so the reference stays valid). agent.js loads after
  // this file but the config fetch is async — a push-based handoff would race,
  // a shared reference read at event time cannot.
  window.__appEvents = EVENTS;
  let CAMERA = { enabled: false, fps: 0.4, presenceThreshold: 0.4, device: 'webgpu', model: 'Xenova/facial_emotions_image_detection' };
  let MOTION = { enabled: false, gain: 1.5 };
  async function loadAppConfig() {
    try {
      const r = await fetch(API + '/api/config');
      const d = await r.json();
      TTS_ENDPOINT = (d.tts && d.tts.endpoint) || '';
      window.__ttsEndpoint = TTS_ENDPOINT; // debug: cek di console (window.__ttsEndpoint)
      if (d.events) Object.assign(EVENTS, d.events);
      if (d.camera) Object.assign(CAMERA, d.camera);
      if (d.motion) {
        MOTION.enabled = !!d.motion.enabled;
        if (typeof d.motion.gain === 'number') MOTION.gain = d.motion.gain;
      }
      // Overlay efek emosi (js/emotion-overlay.js) — config.json "overlay".
      if (d.overlay) window.__overlayCfg = Object.assign({}, window.__overlayCfg || {}, d.overlay);
    } catch (e) { /* pakai default */ }
  }
  loadAppConfig();

  // ── Reactive presence + idle (agent-driven events) ──
  let presence = null;          // true=hadir, false=pergi, null=tidak tahu
  let agentIdleTimer = null;
  let agentIdleRepeat = null;

  function stopAgentIdle() {
    if (agentIdleTimer) { clearTimeout(agentIdleTimer); agentIdleTimer = null; }
    if (agentIdleRepeat) { clearInterval(agentIdleRepeat); agentIdleRepeat = null; }
  }

  function resetAgentIdle() {
    // clearTimeout on an interval handle is a no-op in browsers — the repeat used
    // to keep firing forever after the first idle event. Cancel both with the
    // right primitive.
    stopAgentIdle();
    if (!EVENTS.idleSpeak) return;
    const fire = () => {
      if (window.__agent && presence === true) window.__agent.reactEvent('idle');
      agentIdleRepeat = setInterval(() => {
        if (window.__agent && presence === true) window.__agent.reactEvent('idle');
      }, EVENTS.idleRepeatMs);
    };
    agentIdleTimer = setTimeout(fire, EVENTS.idleMs);
  }

  // Presence has TWO possible producers (webcam module, or tab focus/visibility
  // fallback) and they must never both be believed at once. The agent is the
  // single hub: every producer calls window.__agent.setPresence(), and the agent
  // calls straight back here. Before this, `presence` was only ever assigned on
  // the fallback path, so turning the camera ON silently disabled every idle
  // event: fire() requires presence === true and nothing could set it.
  window.__l2dPresenceChanged = function (p) {
    presence = p;
    if (p === true) resetAgentIdle();
    else stopAgentIdle();   // away / unknown: stop nagging an empty chair
  };

  function applyFallbackPresence(p) {
    if (window.__cameraActive) return;   // kamera yang pegang kendali presence
    if (window.__agent) window.__agent.setPresence(p);
    else window.__l2dPresenceChanged(p); // agent.js belum ter-load (urutan script)
  }
  document.addEventListener('visibilitychange', () => applyFallbackPresence(!document.hidden));
  window.addEventListener('blur', () => applyFallbackPresence(false));
  window.addEventListener('focus', () => applyFallbackPresence(!document.hidden));
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => applyFallbackPresence(!document.hidden));
  } else {
    applyFallbackPresence(!document.hidden);
  }

  function browserTTS(text, markDone, fallbackTimer) {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    try {
      if (typeof speechSynthesis === 'undefined') { markDone(); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      // Per-model voice: pitch/rate/lang are part of a character's identity, so
      // they come from the model's own config instead of a hardcoded constant.
      const vcfg = currentModelConfig();
      u.lang = vcfg.ttsLang; u.rate = vcfg.ttsRate; u.pitch = vcfg.ttsPitch; u.volume = 1;
      u.onend = markDone;
      u.onerror = markDone;
      const pickVoice = () => {
        const vs = speechSynthesis.getVoices() || [];
        // Match against the configured language, not a hardcoded id-ID, or a
        // Japanese-voiced character would still be handed an Indonesian voice.
        const base = String(vcfg.ttsLang || '').split('-')[0].toLowerCase();
        const langRe = new RegExp('^' + base, 'i');
        const v = vs.find(x => String(x.lang).toLowerCase() === String(vcfg.ttsLang).toLowerCase())
          || vs.find(x => langRe.test(x.lang))
          || (base === 'id' ? vs.find(x => /indonesia/i.test(x.name)) : null);
        if (v) u.voice = v;
        speechSynthesis.speak(u);
      };
      if (speechSynthesis.getVoices().length) pickVoice();
      else speechSynthesis.addEventListener('voiceschanged', pickVoice, { once: true });
    } catch (e) { markDone(); }
  }

  async function doRemoteTTS(text, markDone, fallbackTimer, reveal) {
    if (!TTS_ENDPOINT) { reveal && reveal(); browserTTS(text, markDone, fallbackTimer); return; }
    try {
      // Lewat proxy lokal (server.js /api/tts) → Colab → balik audio same-origin.
      // Hindari CORS/autoplay cross-origin yang bikin remote gagal & fallback browser.
      const resp = await fetch(API + '/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      // Satu elemen audio DIPAKAI ULANG antar baris: MediaElementAudioSourceNode
      // hanya boleh dibuat SEKALI per elemen, dan routing analyser lip-sync
      // membutuhkan elemen yang selalu sama.
      const audio = (state.ttsAudio = state.ttsAudio || new Audio());
      audio.src = url;
      // Lip-sync presisi: route audio lewat AnalyserNode. Kalau AudioContext
      // masih ditahan autoplay policy, attach() menolak — audio tetap bunyi
      // normal lewat speaker dan mulut memakai osilasi fallback; percobaan
      // routing diulang saat onplaying.
      let lip = null;
      if (window.LipSync && window.LipSync.AudioLipSync) {
        lip = (state.audioLipSync = state.audioLipSync || new window.LipSync.AudioLipSync());
        lip.reset();
        if (!lip.attach(audio)) lip = null;
      }
      state.activeLip = lip;
      // Baru reveal teks + mulai mulut saat audio BENAR-BENAR siap main (canplay),
      // bukan pas teks diterima — biar nggak kelihatan "baca duluan".
      audio.oncanplay = () => { reveal && reveal(); };
      audio.onplaying = () => { reveal && reveal(); if (lip && !lip.active) lip.attach(audio); };
      audio.onended = () => { clearTimeout(fallbackTimer); markDone(); };
      audio.onerror = () => { reveal && reveal(); browserTTS(text, markDone, fallbackTimer); };
      audio.play().catch(() => { reveal && reveal(); browserTTS(text, markDone, fallbackTimer); });
    } catch (e) {
      console.warn('[TTS] remote gagal, fallback ke browser:', e && e.message);
      reveal && reveal();
      browserTTS(text, markDone, fallbackTimer);
    }
  }

  function speak(text, onDone) {
    if (!state.model) { showBubble(text); if (onDone) setTimeout(onDone, 500); return; }
    let ttsDone = false, revealed = false;
    const markDone = () => {
      if (ttsDone) return;
      ttsDone = true;
      hideBubble();                 // sembunyikan teks pas audio selesai
      state.talking = false;        // hentikan mulut
      if (state.activeLip) state.activeLip.reset();   // baris berikut mulai dari mulut tertutup
      // Rest the mouth at the MODEL's own default for this role, not a literal
      // 0 — a rig whose mouthOpen rests at a non-zero value would otherwise be
      // forced shut (or left ajar) after every line.
      const mId = roleId('mouthOpenY');
      if (mId) {
        delete state.overrides[mId];
        pokeParam(mId, state.mouthRest != null ? state.mouthRest : roleDefault('mouthOpenY'), 1);
      }
      if (onDone) onDone();
    };
    // Reveal teks + mulai gerak mulut HANYA saat audio benar-benar mulai main.
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      showBubble(text, 1e9);        // tetap tampil sampai markDone sembunyikan
      state.talking = true;
      if (state.mouthTimer) clearTimeout(state.mouthTimer);
      const dur = Math.max(1400, text.length * 75);
      state.mouthTimer = setTimeout(() => {
        state.talking = false;
        const mId = roleId('mouthOpenY');
        if (mId) {
          delete state.overrides[mId];
          pokeParam(mId, state.mouthRest != null ? state.mouthRest : roleDefault('mouthOpenY'), 1);
        }
      }, dur);
    };
    // Indikator "menyiapkan suara" — baru teks asli & mulut jalan pas audio siap.
    showBubble('…', 1e9);
    const fallbackTimer = setTimeout(markDone, TTS_ENDPOINT ? 45000 : Math.max(1400, text.length * 75) + 800);
    if (TTS_ENDPOINT) {
      doRemoteTTS(text, markDone, fallbackTimer, reveal);
    } else {
      reveal();
      browserTTS(text, markDone, fallbackTimer);
    }
  }

  // ─── HTML escaping ─────────────────────────────────────────────
  // Module-level on purpose: every innerHTML sink in this file must be able to
  // reach it. It used to be declared inside wireUI(), which meant any code
  // outside that function (the sheet editor and the dynamic group UI planned
  // next) had no way to escape text and would be tempted to interpolate raw
  // strings — model names, LLM-produced labels, and user-typed descriptions all
  // end up in markup, so this has to be available everywhere.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  // ─── UI Event Wiring ───────────────────────────────────────────
  // Pintu freeze untuk editor di FILE LAIN (js/motion-editor.js). Fungsi
  // freezeModelForEdit/unfreezeModelForEdit hidup di dalam wireUI() bersama
  // editor preset; Motion Studio harus memakai freeze yang SAMA, bukan
  // menulis mekanisme kedua yang bisa saling melepas bekuan. Diisi oleh
  // wireUI(), dibaca lewat window.__live2dAgent.freezeForEdit.
  let editorFreezeApi = null;

  function wireUI() {
    // ── Sidebar controls toggle + tabs + frame controls ──
    $('#btn-toggle-controls').addEventListener('click', () => {
      const panel = $('#controls-panel');
      panel.classList.toggle('hidden');
      // Penanda untuk CSS: popup mengambang (pn-popup) bergeser kiri dari
      // sidebar supaya kolom chat tetap terlihat saat panel kontrol terbuka.
      document.body.classList.toggle('controls-open', !panel.classList.contains('hidden'));
    });

    // Drawer kontrol kini overlay (inset:0) — tanpa tombol ini dia menutupi
    // tombol ⚙️-nya sendiri dan sekali kebuka tak bisa ditutup.
    $('#btn-close-controls').addEventListener('click', () => {
      $('#controls-panel').classList.add('hidden');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const panel = $('#controls-panel');
      if (!panel || panel.classList.contains('hidden')) return;
      // Motion Studio punya penanganan Escape-nya sendiri (listener-nya
      // terdaftar lebih belakang) — biarkan dia yang menutup dulu.
      const ms = document.getElementById('motion-studio-popup');
      if (ms && !ms.classList.contains('hidden')) return;
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      panel.classList.add('hidden');
    });

    // Tabs inside controls panel
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.remove('active'));
        $$('.tab-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const pane = tab.dataset.tab;
        const el = document.querySelector('.tab-pane[data-pane="' + pane + '"]');
        if (el) el.classList.add('active');
      });
    });

    // ── Full Body button (only after manual zoom/drag) ──
    const fbBtn = $('#btn-fullbody');
    function showFullBtn() {
      if (state.fullBody) return;            // already in full-body mode → keep label
      if (fbBtn) fbBtn.classList.remove('hidden');
    }
    function setFullBody(on) {
      state.fullBody = on;
      if (!fbBtn) return;
      if (on) {
        // save current (manual) position so we can return to it
        state.preFull = { x: state.model.x, y: state.model.y, scale: state.model.scale.x };
        frameModel('full');                  // whole body, centered (NOT face zoom)
        fbBtn.textContent = '⤡ Kembali';
        fbBtn.classList.add('active');
      } else {
        // restore the manual position the user had
        if (state.preFull) {
          state.model.scale.set(state.preFull.scale);
          state.model.x = state.preFull.x;
          state.model.y = state.preFull.y;
          state.basePos.x = state.preFull.x;
          state.basePos.y = state.preFull.y;
          state.scale = state.preFull.scale;
        } else {
          frameModel('upper');
        }
        fbBtn.textContent = '⤢ Full Body';
        fbBtn.classList.remove('active');
        fbBtn.classList.add('hidden');       // hide again until next manual interaction
      }
    }
    if (fbBtn) fbBtn.addEventListener('click', () => setFullBody(!state.fullBody));
    // expose for wheel/drag handlers
    state._showFullBtn = showFullBtn;

    function addChat(role, text) {
      const log = $('#chat-log');
      if (!log) return;
      const msg = document.createElement('div');
      msg.className = 'msg ' + role;
      const av = document.createElement('div');
      av.className = 'msg-avatar';
      av.textContent = role === 'user' ? '🙂' : characterInitial();
      const bb = document.createElement('div');
      bb.className = 'msg-bubble';
      bb.textContent = text;
      msg.appendChild(av);
      msg.appendChild(bb);
      log.appendChild(msg);
      log.scrollTop = log.scrollHeight;
    }
    // expose for agent.js to append the character's reply
    window.__addChat = addChat;

    // Debug/QA handle: lets an automated check drive the animation internals
    // (taxonomy load, clip selection, guard state) from the browser console
    // without exporting the whole module. Read-only in practice — nothing in the
    // app itself reads this back.
    window.__l2dDebug = {
      state,
      loadMotionTaxonomy,
      buildTaxonomyFromNames,
      playEmotionClip,
      clipIsPlaying,
      applyExpression,
      renderer: app.renderer,   // untuk overlay efek emosi (ukur anchor kepala)
    };

    function sendBubble() {
      const input = $('#bubble-input');
      const text = input.value.trim();
      if (!text) return;
      addChat('user', text);                              // show what you typed (in chat log)
      showBubble(text);                                   // + bubble over character
      resetAgentIdle();
      const brainOn = $('#toggle-brain') && $('#toggle-brain').checked;
      input.value = '';
      // Mood dari teks ketikan (gabung dgn kamera)
      const g = (window.__agent && window.__agent.guessEmotion) ? window.__agent.guessEmotion(text) : '';
      const moodMap = { senang: 'senang', tersenyum: 'senang', sedih: 'sedih', malu: 'normal', kaget: 'kaget', kesal: 'marah', bingung: 'normal' };
      const m = moodMap[g] || 'normal';
      // Selalu kirim, termasuk 'normal'. Sebelumnya 'normal' di-skip, jadi sekali
      // user menulis sesuatu yang sedih, mood itu menempel SELAMANYA dan setiap
      // balasan berikutnya dibumbui "user terlihat sedih" walau sudah lama ceria.
      // Sumber 'text' ditandai agar tidak menimpa mood kamera (sinyal wajah lebih
      // kuat daripada tebakan kata kunci).
      if (window.__agent) window.__agent.setUserMood(m, 'text');
      if (brainOn && window.__agent) {
        window.__agent.think(text);                      // route to the LLM brain
      } else {
        speak(text);                                      // TTS-only fallback
      }
    }
    $('#btn-bubble').addEventListener('click', sendBubble);
    $('#bubble-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendBubble();
    });

    $$('.phrase-btn').forEach(btn => {
      btn.addEventListener('click', () => { const p = btn.dataset.phrase; resetAgentIdle(); showBubble(p, 3500); speak(p); });
    });

    // ── Kamera reactive toggle (opt-in) ──
    const camToggle = document.getElementById('use-camera');
    const camStatus = document.getElementById('camera-status');
    function setCamStatus(text, cls) {
      if (!camStatus) return;
      camStatus.textContent = text;
      camStatus.className = 'note-status' + (cls ? ' ' + cls : '');
    }
    if (camToggle) {
      camToggle.checked = !!CAMERA.enabled;
      camToggle.addEventListener('change', async (e) => {
        const on = e.target.checked;
        if (on) {
          if (!window.cameraPresence) {
            e.target.checked = false;
            setCamStatus('modul kamera belum dimuat', 'err');
            return;
          }
          // Model emosi diunduh dari CDN — bisa belasan detik. Kunci checkbox
          // supaya user tidak bisa start/stop bertubi-tubi saat masih memuat.
          e.target.disabled = true;
          setCamStatus('meminta izin & memuat model…', 'busy');
          try {
            // awayHiddenMs hidup di `events`, bukan `camera`, tapi yang memakainya
            // adalah loop kamera (lowStreak × interval). Tanpa diteruskan,
            // ambang "pergi" milik user diam-diam diabaikan.
            await window.cameraPresence.start(Object.assign({}, CAMERA, { awayHiddenMs: EVENTS.awayHiddenMs }));
            setCamStatus('aktif — deteksi hadir & mood', 'ok');
          } catch (err) {
            console.error('[camera] start gagal:', err);
            e.target.checked = false;
            setCamStatus('gagal: ' + (err && err.message ? err.message : err), 'err');
          } finally {
            e.target.disabled = false;
          }
        } else {
          if (window.cameraPresence) window.cameraPresence.stop();
          setCamStatus('mati', '');
          applyFallbackPresence(!document.hidden);   // kembalikan ke fallback visibility
        }
      });
    }

    // ── AI Connections manager (9router-style) ──
    const connList = $('#conn-list');
    const modal = $('#conn-modal');
    let editingId = null;
    let lastConnSig = null;

    // Signature ringan status koneksi — dipakai polling realtime supaya
    // re-render hanya terjadi bila ada yang BENAR-BENAR berubah
    // (status/error/cooldown/roles), bukan tiap tick.
    function connSig(conns, activeId) {
      return JSON.stringify([activeId || null].concat((conns || []).map(c =>
        [c.id, c.testStatus || 'untested', c.lastError || '', c.rateLimitedUntil || '',
          Array.isArray(c.roles) ? c.roles.join(',') : ''])));
    }

    async function loadConns() {
      try {
        const r = await fetch(API + '/api/config');
        const d = await r.json();
        renderConns(d.connections || [], d.activeId);
      } catch (e) { console.error('[conn] load', e); }
    }
    function badgeClass(s) {
      if (s === 'success') return 'success';
      if (s === 'error') return 'error';
      return 'default';
    }
    function renderConns(conns, activeId) {
      lastConnSig = connSig(conns, activeId);
      connList.innerHTML = '';
      if (!conns.length) {
        connList.innerHTML = '<div class="conn-hint">Belum ada connection. Klik ＋ untuk tambah.</div>';
        return;
      }
      for (const c of conns) {
        const card = document.createElement('div');
        card.className = 'conn-card' + (c.id === activeId ? ' active' : '');
        const status = c.testStatus || 'untested';
        // Cooldown live: koneksi yang gagal baru saja didinginkan classifier
        // (rate limit / error transien) — badge harus jujur kalau sedang
        // di-skip, jangan tetap pamer "connected" padahal tak dipakai dulu.
        const coolMs = c.rateLimitedUntil ? new Date(c.rateLimitedUntil).getTime() - Date.now() : 0;
        const cooling = coolMs > 0;
        const badgeText = cooling
          ? `◌ cooldown ${Math.ceil(coolMs / 1000)}s`
          : status === 'success' ? '✓ connected' : status === 'error' ? '✕ error' : '○ untested';
        // Tag peran: kosong = wildcard ("semua peran") — user tidak wajib paham konsep role.
        const roleList = Array.isArray(c.roles) ? c.roles : [];
        const roleTags = roleList.length
          ? roleList.map(r => `<span class="conn-role-tag">${esc(r)}</span>`).join('')
          : '<span class="conn-role-tag wild">semua peran</span>';
        card.innerHTML = `
          <div class="conn-head">
            <span class="conn-name">${esc(c.name || c.id)}</span>
            <span class="conn-badge ${cooling ? 'default' : badgeClass(status)}">${badgeText}</span>
          </div>
          <div class="conn-meta">${esc((c.provider||''))} · ${esc((c.model||''))}</div>
          <div class="conn-role-tags">${roleTags}</div>
          ${c.lastError ? `<div class="conn-err">${esc(c.lastError)}</div>` : ''}
          <div class="conn-actions">
            <button data-act="active" class="${c.id === activeId ? 'act-active' : ''}">${c.id === activeId ? '● Active' : 'Set Active'}</button>
            <button data-act="edit">Edit</button>
            <button data-act="test">Test</button>
            <button data-act="delete">Delete</button>
          </div>`;
        card.querySelector('[data-act="active"]').addEventListener('click', () => setActive(c.id));
        card.querySelector('[data-act="edit"]').addEventListener('click', () => openModal(c));
        card.querySelector('[data-act="test"]').addEventListener('click', (e) => testConn(c, e.target));
        card.querySelector('[data-act="delete"]').addEventListener('click', () => delConn(c.id));
        connList.appendChild(card);
      }
    }

    // Peran connection: baca/tulis checkbox #m-roles. Semua centang KOSONG =
    // wildcard (server memperlakukannya "boleh semua peran"), jadi user tidak
    // wajib paham konsep role.
    function rolesFromForm() {
      const box = $('#m-roles');
      if (!box) return [];
      return Array.from(box.querySelectorAll('input[type="checkbox"]')).filter(cb => cb.checked).map(cb => cb.value);
    }
    function rolesToForm(roles) {
      const box = $('#m-roles');
      if (!box) return;
      const want = new Set(Array.isArray(roles) ? roles : []);
      for (const cb of box.querySelectorAll('input[type="checkbox"]')) cb.checked = want.has(cb.value);
    }

    function openModal(c) {
      editingId = c ? c.id : null;
      $('#m-name').value = c ? (c.name || '') : '';
      $('#m-provider').value = c ? (c.provider || 'openai-compatible') : 'openai-compatible';
      $('#m-baseurl').value = c ? (c.baseUrl || '') : '';
      $('#m-apikey').value = c ? (c.apiKey && !c.apiKey.startsWith('•') ? '' : '') : '';  // keep existing key hidden
      $('#m-model').value = c ? (c.model || '') : '';
      $('#m-system').value = c ? (c.systemPrompt || '') : '';
      // Kosong = pertahankan yang tersimpan (server merge, field tak dikirim)
      $('#m-maxtokens').value = c && c.maxTokens != null ? c.maxTokens : '';
      $('#m-temp').value = c && c.temperature != null ? c.temperature : '';
      $('#m-stream').checked = !!(c && c.stream);
      rolesToForm(c ? c.roles : []);
      modal.classList.remove('hidden');
    }
    function closeModal() { modal.classList.add('hidden'); editingId = null; }
    $('#m-cancel').addEventListener('click', closeModal);
    $('#btn-add-conn').addEventListener('click', () => openModal(null));

    $('#m-save').addEventListener('click', async () => {
      const k = $('#m-apikey').value.trim();
      const conn = {
        name: $('#m-name').value.trim() || 'connection',
        provider: $('#m-provider').value,
        baseUrl: $('#m-baseurl').value.trim(),
        apiKey: k,
        model: $('#m-model').value.trim(),
        systemPrompt: $('#m-system').value,
        roles: rolesFromForm(),
      };
      // Kosong = jangan kirim (server merge mempertahankan nilai lama)
      const mt = parseInt($('#m-maxtokens').value, 10);
      const tp = parseFloat($('#m-temp').value);
      if (Number.isFinite(mt)) conn.maxTokens = mt;
      if (Number.isFinite(tp)) conn.temperature = tp;
      conn.stream = $('#m-stream').checked;
      const body = { action: editingId ? 'update' : 'add' };
      // Kalau edit dan field key kosong, jangan kirim key (server pertahankan yang lama).
      // Jangan kirim key yang di-mask ('•…') karena itu bukan key asli.
      if (editingId && !k) delete conn.apiKey;
      if (editingId) { body.id = editingId; body.connection = conn; }
      else body.connection = conn;

      await fetch(API + '/api/config', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
      });
      closeModal();
      loadConns();
    });

    async function setActive(id) {
      await fetch(API + '/api/config', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ action: 'setActive', id }),
      });
      loadConns();
    }
    async function delConn(id) {
      if (!confirm('Hapus connection ini?')) return;
      await fetch(API + '/api/config', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ action: 'delete', id }),
      });
      loadConns();
    }
    async function testConn(c, btn) {
      btn.disabled = true; btn.textContent = 'testing…';
      const r = await fetch(API + '/api/test', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ connection: c }),
      });
      const d = await r.json();
      btn.disabled = false; btn.textContent = 'Test';
      alert(d.valid ? '✓ Connection OK: ' + (d.reply || '') : '✕ ' + (d.error || 'gagal'));
      loadConns();
    }

    // ── Model import / switch (user-imported Live2D models) ──
    const drop = $('#model-drop');
    const pickBtn = $('#btn-pick-model');
    const folderInput = $('#input-model-folder');
    const nameInput = $('#input-model-name');
    const modelList = $('#model-list');

    async function refreshModels() {
      try {
        const r = await fetch(API + '/api/models');
        const d = await r.json();
        modelList.innerHTML = '';
        const models = d.models || [];
        if (!models.length) {
          modelList.innerHTML = '<div class="conn-hint">Belum ada model. Upload lewat drop box di atas.</div>';
        }
        for (const name of models) {
          const item = document.createElement('div');
          item.className = 'model-item';
          item.innerHTML = `<span class="m-name">${esc(name)}</span>
            <span class="m-actions">
              <button class="load" data-name="${esc(name)}">Load</button>
              <button class="del" data-name="${esc(name)}">🗑</button>
            </span>`;
          item.querySelector('.load').addEventListener('click', () => loadUserModel(name));
          item.querySelector('.del').addEventListener('click', async () => {
            // Sheet/preset/motion TIDAK ikut dihapus: semuanya hidup di data/
            // dan berkunci dari nama folder model — impor ulang nama yang sama
            // dan semua datanya tersambung kembali otomatis (fungsinya backup).
            if (!confirm('Hapus model "' + name + '"?\n\nFolder model dihapus. Sheet, preset, dan gerakan buatanmu tetap disimpan — impor ulang model dengan nama yang sama dan datanya tersambung kembali otomatis.')) return;
            await fetch(API + '/api/model/' + encodeURIComponent(name), { method: 'DELETE' });
            deleteCharacterSheet(name);  // hanya cache sheet di localStorage; sumbernya (file data/) tetap ada
            refreshModels();
            // Yang dihapus model yang sedang tampil? Muat penggantinya; kalau
            // folder jadi kosong sama sekali, tampilkan empty-state pasang model.
            const curName = state.modelPath ? String(state.modelPath).split('/')[1] : null;
            if (curName === name) {
              const auto = await resolveAnyModelPath();
              if (auto) await loadModel(auto);
              else {
                try { app.stage.removeChild(state.model); state.model.destroy(); } catch (e) {}
                state.model = null;
                showNoModelState();
              }
            }
          });
          modelList.appendChild(item);
        }
      } catch (e) { console.error('[model] list', e); }
    }

    // Guard / heads-up: the bundled Cubism 4.2.2 core only natively accepts moc
    // versions <= 4. Cubism 3 models (model3.json "Version": 3) are often stamped
    // moc version 5 but use a v4-compatible layout; the moc version-stamp shim at
    // the top of this file rewrites that stamp so they still load. We only warn —
    // loading proceeds and the core will report a real error if a model is truly
    // incompatible.
    async function assertCubism4(path) {
      try {
        const r = await fetch(API + '/' + path);
        if (!r.ok) return true;
        const j = await r.json();
        if (j && j.Version === 3) {
          console.warn('[model] "' + path + '" is Cubism 3 — applying moc version-stamp shim (no Editor needed).');
        }
      } catch (e) { /* non-JSON — let loadModel report */ }
      return true;
    }

    async function loadUserModel(name) {
      showLoader('Memuat model: ' + name + '...');
      try {
        const path = await resolveModel3(name);
        if (!path) throw new Error('tidak ada *.model3.json');
        if (!(await assertCubism4(path))) { hideLoader(); return; }
        await loadModel(path);
        refreshModels();
      } catch (e) {
        console.error('[model] load', e);
        alert('Gagal memuat model: ' + e.message);
      } finally {
        hideLoader();
      }
    }

    // Ask the server for the model3.json path inside a folder.
    async function resolveModel3(name) {
      const r = await fetch(API + '/api/model/path?name=' + encodeURIComponent(name));
      if (r.ok) { const d = await r.json(); return d.path || null; }
      return null;
    }

    // Encode an ArrayBuffer to base64 in safe chunks. The naive
    // btoa(String.fromCharCode(...bytes)) spreads every byte as a function
    // argument and throws "Maximum call stack size exceeded" on files larger
    // than ~65k bytes — i.e. ANY real Live2D texture. Chunk it instead.
    function abToBase64(buf) {
      const u = new Uint8Array(buf);
      let s = '';
      const CH = 0x8000;
      for (let i = 0; i < u.length; i += CH) {
        s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
      }
      return btoa(s);
    }

    async function uploadFolder(files, name) {
      if (!name) name = prompt('Nama model?', 'MyModel') || 'MyModel';
      name = name.trim().replace(/[^\w\-]+/g, '_');
      const payload = { name, files: [] };
      for (const f of files) {
        const rel = f.webkitRelativePath || f.relativePath || f.name;
        const buf = await f.arrayBuffer();
        payload.files.push({ path: rel, base64: abToBase64(buf) });
      }
      showLoader('Mengupload ' + payload.files.length + ' file...');
      const r = await fetch(API + '/api/model/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'upload gagal');
      return name;
    }

    function showLoader(text) {
      const p = $('#loader p'); if (p) p.textContent = text;
      $('#loader').classList.remove('done', 'fade-out', 'hidden');
    }
    function hideLoader() {
      $('#loader').classList.add('done');
      setTimeout(() => $('#loader').classList.add('fade-out'), 300);
      setTimeout(() => $('#loader').classList.add('hidden'), 950);
    }

    if (pickBtn) pickBtn.addEventListener('click', () => folderInput && folderInput.click());
    // Empty-state stage: tombol undangan impor meneruskan ke input yang SAMA
    // dengan tab 📁 Model — satu jalur upload untuk semuanya, tanpa duplikasi.
    const emptyFolderBtn = $('#btn-empty-folder');
    if (emptyFolderBtn) emptyFolderBtn.addEventListener('click', () => folderInput && folderInput.click());
    const emptyZipBtn = $('#btn-empty-zip');
    if (emptyZipBtn) emptyZipBtn.addEventListener('click', () => { const z = $('#input-model-zip'); if (z) z.click(); });
    if (folderInput) folderInput.addEventListener('change', async () => {
      if (!folderInput.files || !folderInput.files.length) return;
      try { const n = await uploadFolder(folderInput.files, nameInput.value); await refreshModels(); loadUserModel(n); }
      catch (e) { alert('Upload gagal: ' + e.message); hideLoader(); }
    });

    // ── .zip upload (auto-extract on server, nested-safe) ──
    const zipBtn = $('#btn-pick-zip');
    const zipInput = $('#input-model-zip');
    if (zipBtn) zipBtn.addEventListener('click', () => zipInput && zipInput.click());
    if (zipInput) zipInput.addEventListener('change', async () => {
      const f = zipInput.files && zipInput.files[0];
      if (!f) return;
      try {
        const nameFromZip = (f.name.replace(/\.zip$/i, '') || 'MyModel');
        const buf = await f.arrayBuffer();
        const b64 = abToBase64(buf);
        showLoader('Mengekstrak ' + f.name + '...');
        const r = await fetch(API + '/api/model/import-zip', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameFromZip, base64: b64 }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'extract gagal');
        await refreshModels();
        if (!(await assertCubism4(d.path))) { hideLoader(); return; }
        await loadModel(d.path);     // switch active stage to the new model
      } catch (e) {
        alert('Import .zip gagal: ' + e.message);
      } finally {
        hideLoader();
        zipInput.value = '';
      }
    });
    if (drop) {
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
      drop.addEventListener('drop', async e => {
        const items = e.dataTransfer && e.dataTransfer.items;
        let files = e.dataTransfer && e.dataTransfer.files;
        // webkitGetAsEntry lets us grab the whole dropped folder
        if (items && items.length && items[0].webkitGetAsEntry) {
          const entries = [];
          for (const it of items) { const en = it.webkitGetAsEntry(); if (en) entries.push(en); }
          const collected = [];
          const walk = (entry, base) => new Promise(res => {
            if (entry.isFile) {
              entry.file(f => { f.relativePath = base + entry.name; collected.push(f); res(); });
            } else if (entry.isDirectory) {
              const reader = entry.createReader();
              const read = () => reader.readEntries(async ents => {
                if (!ents.length) return res();
                for (const c of ents) await walk(c, base + entry.name + '/');
                read();
              });
              read();
            } else res();
          });
          for (const en of entries) await walk(en, '');
          if (collected.length) {
            try { const n = await uploadFolder(collected, nameInput.value); await refreshModels(); loadUserModel(n); }
            catch (err) { alert('Upload gagal: ' + err.message); hideLoader(); }
          }
        } else if (files && files.length) {
          try { const n = await uploadFolder(files, nameInput.value); await refreshModels(); loadUserModel(n); }
          catch (err) { alert('Upload gagal: ' + err.message); hideLoader(); }
        }
      });
    }
    refreshModels();

    // ── Inspect Model button ──
    const inspectBtn = $('#btn-inspect');
    if (inspectBtn) inspectBtn.addEventListener('click', () => {
      if (!state.model) { alert('Load model dulu sebelum inspeksi.'); return; }
      showLoader('🔍 Menganalisis model...');
      setTimeout(() => {
        const sheet = inspectModel();
        hideLoader();
        if (sheet) {
          // Re-inspection preserves the user's note; reflect that in the UI so
          // the textarea can't drift from what was actually persisted.
          refreshUserNoteUI();
          try { refreshConfigForm(); } catch (e) {}
          try { refreshSheetUI(); } catch (e) {}
          alert(`✅ Character Sheet generated!\n\n` +
            `📋 ${sheet.paramCount} parameter ditemukan\n` +
            `😊 ${Object.keys(sheet.supportedEmotions).length} emosi didukung\n` +
            `✨ ${sheet.accessories.length} aksesoris terdeteksi\n` +
            `🎭 ${sheet.nativeExpressions.length} expression bawaan\n` +
            `🎬 ${sheet.motionGroups.length} motion group\n\n` +
            `Tersimpan di localStorage. AI akan pakai data ini saat chat.`);
        } else {
          alert('❌ Gagal inspeksi model.');
        }
      }, 100);
    });

    // ── Catatan Karakter (user note) ──
    const noteBox = $('#input-user-note');
    const noteBtn = $('#btn-save-note');
    const noteStatus = $('#note-status');
    function setNoteStatus(msg, kind) {
      if (!noteStatus) return;
      noteStatus.textContent = msg;
      noteStatus.className = 'note-status' + (kind ? ' ' + kind : '');
    }
    if (noteBtn && noteBox) {
      noteBtn.addEventListener('click', async () => {
        noteBtn.disabled = true;
        setNoteStatus('menyimpan…');
        try {
          const saved = await saveUserNote(noteBox.value);
          // Show the sanitized/truncated result so the user sees exactly what
          // was stored rather than what they typed.
          if (saved !== noteBox.value) noteBox.value = saved;
          setNoteStatus(saved.length
            ? `tersimpan (${saved.length}/${MAX_USER_NOTE})`
            : 'catatan dikosongkan', 'ok');
        } catch (e) {
          setNoteStatus('gagal: ' + e.message, 'err');
        } finally {
          noteBtn.disabled = false;
        }
      });
      // Ctrl/Cmd+Enter saves without reaching for the mouse.
      noteBox.addEventListener('keydown', (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); noteBtn.click(); }
      });
      // Live length feedback once the cap is in sight.
      noteBox.addEventListener('input', () => {
        const n = noteBox.value.length;
        if (n > MAX_USER_NOTE * 0.8) setNoteStatus(n + '/' + MAX_USER_NOTE, n >= MAX_USER_NOTE ? 'err' : '');
        else if (noteStatus && noteStatus.textContent) setNoteStatus('');
      });
    }

    // ── Pengaturan per-model (config) ──
    const cfgEls = {
      displayName: $('#cfg-display-name'),
      blink: $('#cfg-blink'),
      idle: $('#cfg-idle'),
      framing: $('#cfg-framing'),
      pitch: $('#cfg-tts-pitch'),
      pitchOut: $('#cfg-tts-pitch-out'),
      rate: $('#cfg-tts-rate'),
      rateOut: $('#cfg-tts-rate-out'),
      lang: $('#cfg-tts-lang'),
      btn: $('#btn-save-cfg'),
      test: $('#btn-test-voice'),
      status: $('#cfg-status'),
    };
    function setCfgStatus(msg, kind) {
      if (!cfgEls.status) return;
      cfgEls.status.textContent = msg;
      cfgEls.status.className = 'note-status' + (kind ? ' ' + kind : '');
    }
    // Paint the form from a config object. Exposed on the module scope below so
    // a model swap can re-sync the panel.
    function paintConfigForm(cfg) {
      const c = normalizeModelConfig(cfg);
      if (cfgEls.displayName) {
        cfgEls.displayName.value = c.displayName;
        // Placeholder shows what the empty field will actually resolve to, so
        // "blank" does not read as "no name".
        try { cfgEls.displayName.placeholder = '(otomatis: ' + characterName() + ')'; } catch (e) {}
      }
      if (cfgEls.blink) cfgEls.blink.checked = c.blink;
      if (cfgEls.idle) cfgEls.idle.checked = c.idle;
      if (cfgEls.framing) cfgEls.framing.value = c.framing;
      if (cfgEls.pitch) cfgEls.pitch.value = String(c.ttsPitch);
      if (cfgEls.rate) cfgEls.rate.value = String(c.ttsRate);
      // toFixed(2) keeps the readout width stable while dragging.
      if (cfgEls.pitchOut) cfgEls.pitchOut.textContent = c.ttsPitch.toFixed(2);
      if (cfgEls.rateOut) cfgEls.rateOut.textContent = c.ttsRate.toFixed(2);
      if (cfgEls.lang) {
        // A sheet may carry a lang that isn't in the dropdown (hand-edited, or
        // written by a newer build). Add it rather than silently showing id-ID,
        // which would misrepresent what is actually stored.
        const has = Array.prototype.some.call(cfgEls.lang.options, o => o.value === c.ttsLang);
        if (!has) {
          const opt = document.createElement('option');
          opt.value = c.ttsLang; opt.textContent = c.ttsLang + ' (tersimpan)';
          cfgEls.lang.appendChild(opt);
        }
        cfgEls.lang.value = c.ttsLang;
      }
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
      };
    }

    // Live readout while dragging — no save, just feedback.
    if (cfgEls.pitch && cfgEls.pitchOut) {
      cfgEls.pitch.addEventListener('input', () => {
        cfgEls.pitchOut.textContent = Number(cfgEls.pitch.value).toFixed(2);
      });
    }
    if (cfgEls.rate && cfgEls.rateOut) {
      cfgEls.rate.addEventListener('input', () => {
        cfgEls.rateOut.textContent = Number(cfgEls.rate.value).toFixed(2);
      });
    }

    // Blink/idle/framing apply IMMEDIATELY on change (cheap, instantly visible,
    // and reversible), but are only persisted by the Save button. This way the
    // user can try a framing without committing it.
    if (cfgEls.blink) cfgEls.blink.addEventListener('change', () => {
      state.blinkEnabled = !!cfgEls.blink.checked;
      setCfgStatus('belum disimpan', '');
    });
    if (cfgEls.idle) cfgEls.idle.addEventListener('change', () => {
      state.idleEnabled = !!cfgEls.idle.checked;
      setCfgStatus('belum disimpan', '');
    });
    if (cfgEls.framing) cfgEls.framing.addEventListener('change', () => {
      if (state.model) { try { frameModel(cfgEls.framing.value); } catch (e) {} }
      setCfgStatus('belum disimpan', '');
    });

    if (cfgEls.btn) {
      cfgEls.btn.addEventListener('click', async () => {
        cfgEls.btn.disabled = true;
        setCfgStatus('menyimpan…');
        try {
          const saved = await saveModelConfig(readConfigForm());
          // Repaint from the SAVED value: clamping may have changed what the
          // user selected, and the form must show the truth.
          paintConfigForm(saved);
          setCfgStatus('tersimpan', 'ok');
        } catch (e) {
          setCfgStatus('gagal: ' + e.message, 'err');
        } finally {
          cfgEls.btn.disabled = false;
        }
      });
    }

    // Hear the current slider values without saving them first.
    if (cfgEls.test) {
      cfgEls.test.addEventListener('click', () => {
        const prev = state.modelConfig;
        // Temporarily apply the form values so browserTTS() picks them up, then
        // restore — a preview must not mutate live state on its own.
        state.modelConfig = normalizeModelConfig(
          Object.assign({}, prev, readConfigForm()));
        try {
          browserTTS('Halo, ini suara aku sekarang.', () => { state.modelConfig = prev; }, null);
        } catch (e) {
          state.modelConfig = prev;
          setCfgStatus('tes suara gagal: ' + e.message, 'err');
        }
      });
    }

    refreshConfigForm();

    // ── Kelakuan (Behaviour) panel — Langkah 2a ──
    // Menyelesaikan Temuan A: karakter diam 30 menit karena config.events, bukan
    // bug kode. Panel ini membiarkan user mengatur proaktivitas tanpa menyentuh
    // config.json manual (yang merupakan data milik user — lihat HANDOLD rule).
    // Perubahan di-apply LIVE ke EVENTS (referensi yang dibaca agent.js saat
    // event terjadi) DAN di-persist ke server via POST /api/config saveEvents.
    (function initBehaviourPanel() {
      const els = {
        hidup: $('[data-profil="hidup"]'), sedang: $('[data-profil="sedang"]'), tenang: $('[data-profil="tenang"]'),
        profilStatus: $('#behaviour-profil-status'),
        idleSpeak: $('#beh-idleSpeak'), awaySpeak: $('#beh-awaySpeak'), returnSpeak: $('#beh-returnSpeak'),
        quietMs: $('#beh-quietMs'), idleMs: $('#beh-idleMs'), idleRepeatMs: $('#beh-idleRepeatMs'),
        quietOut: $('#beh-quietMs-out'), idleOut: $('#beh-idleMs-out'), repeatOut: $('#beh-idleRepeatMs-out'),
        save: $('#btn-beh-save'), saveStatus: $('#beh-save-status'),
        countdown: $('#beh-quiet-countdown'),
      };
      // Profil: nilai sementara uji (TIDAK di-commit sebagai default diam-diam —
      // user yang memilih, lalu Save). Diambil dari PLAN-BESOK-ALIVE.md §0 Temuan A.
      const PROFILES = {
        hidup:  { quietMs: 15000, idleMs: 45000, idleRepeatMs: 90000, idleSpeak: true, awaySpeak: true, returnSpeak: true },
        sedang: { quietMs: 60000, idleMs: 180000, idleRepeatMs: 300000, idleSpeak: true, awaySpeak: true, returnSpeak: true },
        tenang: { quietMs: 1800000, idleMs: 1800000, idleRepeatMs: 1800000, idleSpeak: true, awaySpeak: true, returnSpeak: true },
      };
      const fmtMs = (ms) => {
        ms = Math.max(0, Math.round(ms));
        if (ms < 1000) return '0 detik';
        const s = Math.round(ms / 1000);
        if (s < 60) return s + ' detik';
        const m = Math.floor(s / 60), r = s % 60;
        if (m < 60) return r ? m + ' mnt ' + r + ' dtk' : m + ' mnt';
        const h = Math.floor(m / 60), mr = m % 60;
        return mr ? h + ' jam ' + mr + ' mnt' : h + ' jam';
      };
      // Approximation of the agent's quiet-period start, so the countdown matches
      // agent.js's inQuietPeriod() (which uses its own agentStart). Good enough
      // for a live "sisa N menit" readout; not a contract.
      window.__agentStartApprox = window.__agentStartApprox || Date.now();
      let countdownTimer = null;

      function paintForm() {
        const e = window.__appEvents || EVENTS;
        if (els.idleSpeak) els.idleSpeak.checked = !!e.idleSpeak;
        if (els.awaySpeak) els.awaySpeak.checked = !!e.awaySpeak;
        if (els.returnSpeak) els.returnSpeak.checked = !!e.returnSpeak;
        if (els.quietMs) { els.quietMs.value = Number(e.quietMs) || 0; els.quietOut.textContent = fmtMs(Number(e.quietMs) || 0); }
        if (els.idleMs) { els.idleMs.value = Number(e.idleMs) || 0; els.idleOut.textContent = fmtMs(Number(e.idleMs) || 0); }
        if (els.idleRepeatMs) { els.idleRepeatMs.value = Number(e.idleRepeatMs) || 0; els.repeatOut.textContent = fmtMs(Number(e.idleRepeatMs) || 0); }
        // Highlight the matching profile button, if any.
        const match = (p) => PROFILES[p] && PROFILES[p].quietMs === (Number(e.quietMs) || 0) &&
          PROFILES[p].idleMs === (Number(e.idleMs) || 0) && PROFILES[p].idleRepeatMs === (Number(e.idleRepeatMs) || 0);
        [['hidup', els.hidup], ['sedang', els.sedang], ['tenang', els.tenang]].forEach(([k, b]) => {
          if (b) b.classList.toggle('active', match(k));
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

      // Apply to the live EVENTS object (agent.js reads this by reference) and
      // restart the idle timer so the new timing takes effect immediately.
      function applyLive(ev) {
        Object.assign(EVENTS, ev);
        // Restart idle scheduling with the new timing. Only fires if presence is
        // currently true (resetAgentIdle checks EVENTS.idleSpeak internally).
        try { if (typeof resetAgentIdle === 'function') resetAgentIdle(); } catch (e) {}
        if (window.__agent && typeof window.__agent.invalidateCapabilityProfile === 'function') { /* no-op, kept for clarity */ }
        // Reset our countdown anchor so the new quietMs is measured from now.
        window.__agentStartApprox = Date.now();
      }

      function setSaveStatus(msg, kind) {
        if (!els.saveStatus) return;
        els.saveStatus.textContent = msg;
        els.saveStatus.className = 'note-status' + (kind ? ' ' + kind : '');
      }

      // Profil buttons: fill the form with the profile, mark active.
      [['hidup', els.hidup], ['sedang', els.sedang], ['tenang', els.tenang]].forEach(([k, b]) => {
        if (!b) return;
        b.addEventListener('click', () => {
          const p = PROFILES[k];
          if (els.idleSpeak) els.idleSpeak.checked = !!p.idleSpeak;
          if (els.awaySpeak) els.awaySpeak.checked = !!p.awaySpeak;
          if (els.returnSpeak) els.returnSpeak.checked = !!p.returnSpeak;
          if (els.quietMs) { els.quietMs.value = p.quietMs; els.quietOut.textContent = fmtMs(p.quietMs); }
          if (els.idleMs) { els.idleMs.value = p.idleMs; els.idleOut.textContent = fmtMs(p.idleMs); }
          if (els.idleRepeatMs) { els.idleRepeatMs.value = p.idleRepeatMs; els.repeatOut.textContent = fmtMs(p.idleRepeatMs); }
          [['hidup', els.hidup], ['sedang', els.sedang], ['tenang', els.tenang]].forEach(([, x]) => x && x.classList.remove('active'));
          b.classList.add('active');
          if (els.profilStatus) els.profilStatus.textContent = 'Profil "' + (k === 'hidup' ? 'Hidup' : k === 'sedang' ? 'Sedang' : 'Tenang') + '" dipakai — tekan Simpan.';
        });
      });

      // Sliders update their readouts live.
      if (els.quietMs) els.quietMs.addEventListener('input', () => { els.quietOut.textContent = fmtMs(Number(els.quietMs.value)); });
      if (els.idleMs) els.idleMs.addEventListener('input', () => { els.idleOut.textContent = fmtMs(Number(els.idleMs.value)); });
      if (els.idleRepeatMs) els.idleRepeatMs.addEventListener('input', () => { els.repeatOut.textContent = fmtMs(Number(els.idleRepeatMs.value)); });

      if (els.save) {
        els.save.addEventListener('click', async () => {
          els.save.disabled = true;
          setSaveStatus('menyimpan…');
          const ev = readForm();
          applyLive(ev);   // live immediately, even if the server call fails
          try {
            const r = await fetch(API + '/api/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'saveEvents', events: ev }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
            setSaveStatus('tersimpan', 'ok');
            // Re-paint from the server-authoritative value (it may have clamped).
            if (d.events) { Object.assign(EVENTS, d.events); paintForm(); }
          } catch (e) {
            setSaveStatus('gagal: ' + e.message, 'err');
          } finally {
            els.save.disabled = false;
          }
        });
      }

      // Live countdown of the quiet period ("sisa 12 menit").
      function tickCountdown() {
        const e = window.__appEvents || EVENTS;
        const q = Number(e.quietMs) || 0;
        const elapsed = Date.now() - (window.__agentStartApprox || Date.now());
        const left = q - elapsed;
        if (els.countdown) {
          if (left > 0) els.countdown.textContent = 'Masa tenang: sisa ' + fmtMs(left) + ' (karakter belum bicara sendiri).';
          else els.countdown.textContent = 'Masa tenang selesai — karakter bisa bereaksi sendiri.';
        }
      }
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(tickCountdown, 1000);
      tickCountdown();

      paintForm();
    })();

    // ── Indikator keadaan hidup — Langkah 2b ──
    // Merender window.__agent._reactiveState() (presence, mood + sumber, masa
    // tenang) ke strip di sidebar, sehingga user tahu KENAPA karakter diam
    // tanpa membuka console. Poll 1 Hz; murah dan tidak mengganggu render model.
    (function initLiveStateIndicator() {
      const elP = $('#ls-presence'), elM = $('#ls-mood'), elQ = $('#ls-quiet');
      if (!elP || !elM || !elQ) return;
      const fmtMs = (ms) => {
        ms = Math.max(0, Math.round(ms));
        if (ms < 1000) return '0 dtk';
        const s = Math.round(ms / 1000);
        if (s < 60) return s + ' dtk';
        const m = Math.floor(s / 60), r = s % 60;
        if (m < 60) return r ? m + ' mnt ' + r + ' dtk' : m + ' mnt';
        const h = Math.floor(m / 60), mr = m % 60;
        return mr ? h + ' jam ' + mr + ' mnt' : h + ' jam';
      };
      function render() {
        const st = (window.__agent && typeof window.__agent._reactiveState === 'function')
          ? window.__agent._reactiveState() : null;
        // presence
        const p = st ? st.presenceState : null;
        elP.textContent = '👤 ' + (p === true ? 'hadir' : p === false ? 'pergi' : 'tidak tahu');
        // mood + source
        const mood = st && st.userMood && st.userMood !== 'normal' ? st.userMood : 'netral';
        const src = st && st.moodSource ? ' (' + st.moodSource + ')' : '';
        elM.textContent = '😶 mood: ' + mood + src;
        // quiet period
        const q = st ? Number(st.quietMs) || 0 : 0;
        const start = window.__agentStartApprox || Date.now();
        const left = q - (Date.now() - start);
        elQ.textContent = '⏳ masa tenang: ' + (left > 0 ? 'sisa ' + fmtMs(left) : 'selesai');
      }
      setInterval(render, 1000);
      render();
    })();

    // ── Tab 📋 Sheet: baca sheet + kelola preset ──
    const shEls = {
      summary: $('#sheet-summary'),
      cats: $('#sheet-cats'),
      list: $('#sheet-preset-list'),
      status: $('#sheet-status'),
      analyze: $('#btn-sheet-analyze'),
      reloadFile: $('#btn-sheet-reload-file'),
      reloadStatus: $('#reload-status'),
      name: $('#preset-name'),
      cat: $('#preset-cat'),
      capture: $('#btn-preset-capture'),
      captureInfo: $('#preset-capture-info'),
      values: $('#preset-values'),
      save: $('#btn-preset-save'),
      clear: $('#btn-preset-clear'),
      pStatus: $('#preset-status'),
    };
    // Which category the preset LIST is filtered to. Independent of the editor's
    // category dropdown: the user may be browsing 'gerak' while authoring an
    // 'emosi', and forcing those to move together would fight the user.
    let sheetCatFilter = 'emosi';
    // Values captured from the live model, held here until Save. Kept out of the
    // DOM because a Part opacity and a Parameter value are different engine
    // calls (setPartOpacityById vs setParameterValueById) and must not be merged
    // into one bag of numbers — same split as normalizePreset().
    let draft = { values: {}, parts: {} };
    // Direct param/part sliders for the preset editor. Lets the user COMPOSE a
    // pose by hand (muka/tubuh/bagian) instead of only snapshotting the live
    // model via "Ambil Pose Sekarang". presetStuckIds tracks overrides we set so
    // we can release them (return model to idle) on Save/Clear.
    const presetSliders = $('#preset-param-sliders');
    const presetFreezeInfo = $('#preset-freeze-info');
    const presetStuckIds = new Set();
    // The moment the user touches the editor's slider area, hold the model
    // completely still (persistent freeze) so posing is predictable. Released
    // again on Save/Clear/Terap/Coba via releasePresetPreview().
    if (presetSliders) {
      presetSliders.addEventListener('pointerdown', () => freezeModelForEdit(presetFreezeInfo, true));
    }

    // § Editor Preset sekarang tampil sebagai popup mengambang (serupa dengan
    //   📝 Jelaskan Parameter). Tombol pembuka ada di tab 📋 Sheet; popup ini
    //   memuat ulang slider + draft tiap dibuka, dan melepas bekuan saat ditutup.
    const presetEditorPopup = $('#preset-editor-popup');
    const presetEditorCloseBtn = $('#preset-editor-close');
    const presetEditorOpenBtn = $('#btn-open-preset-editor');

    function openPresetEditor() {
      const sheet = state.lastSheet || loadCharacterSheet();
      paintDraft();
      renderPresetSliders(sheet);
      if (presetEditorPopup) {
        presetEditorPopup.classList.remove('hidden');
        presetEditorPopup.setAttribute('aria-hidden', 'false');
      }
    }
    function closePresetEditor() {
      if (presetEditorPopup) {
        presetEditorPopup.classList.add('hidden');
        presetEditorPopup.setAttribute('aria-hidden', 'true');
      }
      releasePresetPreview();
    }
    if (presetEditorOpenBtn) presetEditorOpenBtn.addEventListener('click', openPresetEditor);
    if (presetEditorCloseBtn) presetEditorCloseBtn.addEventListener('click', closePresetEditor);

    function setSheetStatus(msg, kind) {
      if (!shEls.status) return;
      shEls.status.textContent = msg;
      shEls.status.className = 'note-status' + (kind ? ' ' + kind : '');
    }
    function setPresetStatus(msg, kind) {
      if (!shEls.pStatus) return;
      shEls.pStatus.textContent = msg;
      shEls.pStatus.className = 'note-status' + (kind ? ' ' + kind : '');
    }

    // textContent everywhere below, never innerHTML: preset names come from a
    // hand-editable sheets/*.json and from LLM output, so treating them as
    // markup would be an injection sink in the user's own panel.
    function paintSheetSummary(sheet) {
      const box = shEls.summary;
      if (!box) return;
      box.textContent = '';
      if (!sheet) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = 'Belum ada sheet untuk model ini. Buka tab 📁 Model → Inspeksi Model.';
        box.appendChild(p);
        return;
      }
      const dl = document.createElement('dl');
      dl.className = 'sheet-facts';
      const facts = [
        ['Model', sheet.modelName || '(tanpa nama)'],
        ['Parameter', String(sheet.paramCount || (sheet.params || []).length)],
        ['Parts', String((sheet.parts || []).length)],
        ['Emosi', String(Object.keys(sheet.supportedEmotions || {}).length)],
        ['Expression', String((sheet.nativeExpressions || []).length)],
        ['Motion group', String((sheet.motionGroups || []).length)],
        ['Skema', 'v' + (sheet.schemaVersion || 0)],
      ];
      for (const [k, v] of facts) {
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd'); dd.textContent = v;
        dl.appendChild(dt); dl.appendChild(dd);
      }
      box.appendChild(dl);
      // rangesEstimated means the numbers are guesses, not measurements from
      // Cubism. Saving a preset against guessed ranges clamps to the wrong
      // bounds, so this warning is not cosmetic.
      if (sheet.rangesEstimated) {
        const w = document.createElement('p');
        w.className = 'hint sheet-warn';
        w.textContent = '⚠ Rentang parameter masih taksiran (' +
          (sheet.rangeSource || 'estimated') + '). Inspeksi ulang model agar nilai preset akurat.';
        box.appendChild(w);
      }
    }

    function paintSheetCats(sheet) {
      const box = shEls.cats;
      if (!box) return;
      box.textContent = '';
      for (const cat of PRESET_CATEGORIES) {
        const n = resolvePresets(sheet, cat).length;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sheet-cat' + (cat === sheetCatFilter ? ' active' : '');
        b.textContent = cat + ' (' + n + ')';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', cat === sheetCatFilter ? 'true' : 'false');
        b.addEventListener('click', () => {
          sheetCatFilter = cat;
          const s = state.lastSheet || loadCharacterSheet();
          paintSheetCats(s); paintPresetList(s);
        });
        box.appendChild(b);
      }
    }

    function paintPresetList(sheet) {
      const box = shEls.list;
      if (!box) return;
      box.textContent = '';
      // Tombol Reset Pose selalu tersedia di atas daftar — membatalkan SEMUA
      // pose yang dipasang preset (sticky override + part + ekspresi) tanpa
      // harus mencari param satu-satu di popup.
      const resetRow = document.createElement('div');
      resetRow.className = 'preset-reset-row';
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'mini-btn';
      resetBtn.style.cssText = 'width:auto;padding:4px 12px;font-size:11px';
      resetBtn.textContent = '🔄 Reset Pose';
      resetBtn.title = 'Lepas semua pose preset yang sedang menempel (param, part, ekspresi) dan kembalikan kendali ke animasi idle.';
      resetBtn.addEventListener('click', () => {
        if (!state.model) { setSheetStatus('load model dulu', 'err'); return; }
        const n = releasePresetPose();
        setSheetStatus(n ? 'pose dilepas (' + n + ' target) — idle kembali' : 'tidak ada pose preset yang menempel', n ? 'ok' : '');
      });
      resetRow.appendChild(resetBtn);
      const resetHint = document.createElement('span');
      resetHint.className = 'preset-reset-hint';
      resetHint.textContent = 'membatalkan semua Terap/Coba yang sedang menempel';
      resetRow.appendChild(resetHint);
      box.appendChild(resetRow);

      const items = resolvePresets(sheet, sheetCatFilter);
      if (!items.length) {
        const p = document.createElement('div');
        p.className = 'preset-empty';
        p.textContent = 'Belum ada preset kategori "' + sheetCatFilter + '".';
        box.appendChild(p);
        return;
      }
      for (const p of items) {
        const row = document.createElement('div');
        // resolvePresets() marks an AI entry shadowed by a same-named user preset
        // with suggestion:true. Both are listed so the user can see what the AI
        // proposed, but only the user's is live.
        const isAI = p.source === 'ai';
        row.className = 'preset-item' + (isAI ? ' is-ai' : '');

        const nm = document.createElement('span');
        nm.className = 'p-name';
        nm.textContent = p.name;
        if (p.renamedFrom) nm.title = 'Otomatis diganti nama dari "' + p.renamedFrom + '" karena bentrok dengan motion bawaan.';
        row.appendChild(nm);

        const badge = document.createElement('span');
        badge.className = 'p-badge';
        badge.textContent = isAI ? (p.suggestion ? '🤖 tertutup' : '🤖 saran') : '👤';
        badge.title = isAI
          ? (p.suggestion
              ? 'Saran AI, tapi kamu sudah punya preset dengan nama sama — punyamu yang dipakai.'
              : 'Saran AI. Belum aktif sampai kamu tekan Pakai.')
          : 'Preset milikmu (aktif).';
        row.appendChild(badge);

        // Only a user preset is callable. Applying an AI entry directly would
        // make an unapproved suggestion behave exactly like an approved one, so
        // the AI row offers Pakai (promote to .user) instead of Terap.
        if (!isAI) {
          const applyBtn = document.createElement('button');
          applyBtn.type = 'button'; applyBtn.className = 'p-act';
          applyBtn.textContent = 'Terap';
          applyBtn.addEventListener('click', () => {
            if (!state.model) { setSheetStatus('load model dulu', 'err'); return; }
            releasePresetPreview();
            const ok = applyPreset(p, p.category);
            setSheetStatus(ok ? 'diterapkan: ' + p.name + ' — batal via 🔄 Reset Pose' : 'tidak ada target valid di preset ini',
              ok ? 'ok' : 'err');
          });
          row.appendChild(applyBtn);

          // Langkah 2c: "Coba" = pratinjau preset tanpa mengunci status aktif.
          // applyPreset() memang mengubah pose model secara langsung (sama seperti
          // Terap), tapi kami TIDAK menandainya sebagai preset aktif, sehingga
          // user bisa kembali ke pose netral lewat tombol biasa / emosi lain —
          // berbeda dari "Terap" yang mengklaim slot activeProperty.
          const tryBtn = document.createElement('button');
          tryBtn.type = 'button'; tryBtn.className = 'p-act';
          tryBtn.textContent = 'Coba';
          tryBtn.title = 'Pratinjau pose ini tanpa menguncinya sebagai preset aktif.';
          tryBtn.addEventListener('click', () => {
            if (!state.model) { setSheetStatus('load model dulu', 'err'); return; }
            releasePresetPreview();
            const ok = applyPreset(p, p.category);
            setSheetStatus(ok ? 'pratinjau: ' + p.name + ' (batal via 🔄 Reset Pose)' : 'tidak ada target valid di preset ini',
              ok ? '' : 'err');
          });
          row.appendChild(tryBtn);

          const editBtn = document.createElement('button');
          editBtn.type = 'button'; editBtn.className = 'p-act';
          editBtn.textContent = 'Edit';
          editBtn.addEventListener('click', () => {
            if (shEls.name) shEls.name.value = p.name;
            if (shEls.cat) shEls.cat.value = p.category;
            // Copy, not reference: editing the draft must not mutate the stored
            // preset before the user presses Save.
            draft = {
              values: Object.assign({}, p.values || {}),
              parts: Object.assign({}, p.parts || {}),
            };
            paintDraft();
            renderPresetSliders(state.lastSheet || loadCharacterSheet());
            setPresetStatus('dimuat untuk diedit', '');
            openPresetEditor();
          });
          row.appendChild(editBtn);

          const delBtn = document.createElement('button');
          delBtn.type = 'button'; delBtn.className = 'p-act danger';
          delBtn.textContent = 'Hapus';
          delBtn.addEventListener('click', async () => {
            if (!confirm('Hapus preset "' + p.name + '" (' + p.category + ')?')) return;
            delBtn.disabled = true;
            setSheetStatus('menghapus…');
            try {
              await deleteUserPreset(p.category, p.name);
              setSheetStatus('dihapus: ' + p.name, 'ok');
              refreshSheetUI();
            } catch (e) {
              setSheetStatus('gagal: ' + e.message, 'err');
              delBtn.disabled = false;
            }
          });
          row.appendChild(delBtn);
        } else {
          const useBtn = document.createElement('button');
          useBtn.type = 'button'; useBtn.className = 'p-act';
          useBtn.textContent = 'Pakai';
          useBtn.addEventListener('click', async () => {
            useBtn.disabled = true;
            setSheetStatus('menyetujui saran…');
            try {
              await applyAISuggestion(p.category, p.name);
              setSheetStatus('saran dipakai: ' + p.name, 'ok');
              refreshSheetUI();
            } catch (e) {
              // A 'gerak' suggestion can collide with a native motion name —
              // applyAISuggestion() routes through saveUserPreset(), so the
              // rejection surfaces here rather than silently writing.
              setSheetStatus('gagal: ' + e.message, 'err');
              useBtn.disabled = false;
            }
          });
          row.appendChild(useBtn);
        }
        box.appendChild(row);
      }
    }

    // ── Penjelasan parameter (params[i].userNote) — POPUP ─────────
    // Floating panel on the RIGHT (does not cover the model on the left stage).
    // Renders EVERY parameter + part with a live slider (so the user sees what
    // the param actually moves) and a description textarea. Dragging a slider
    // freezes the idle fidget + mouse-follow (state.frozen) for 10s so the user
    // sees a clean signal, then idle resumes smoothly. textContent only — param
    // ids come from disk, so innerHTML would be an injection sink.
    const pnPopup = $('#paramnotes-popup');
    const pnList = $('#paramnotes-popup-list');
    const pnOpenBtn = $('#btn-open-paramnotes');
    const pnCloseBtn = $('#pn-popup-close');
    const pnCountdown = $('#pn-countdown');
    const pnSaveAll = $('#pn-save-all');
    const pnSaveStatus = $('#pn-save-status');
    const pnSearch = $('#pn-search');
    let pnTimer = null;          // debounce for description autosave
    const pnStuckIds = new Set(); // param/part ids we setSticky'd (cleared on close)

    function setPnStatus(row, msg, kind) {
      const el = row.querySelector('.pn-status');
      if (!el) return;
      el.textContent = msg || '';
      el.className = 'pn-status' + (kind ? ' ' + kind : '');
    }

    // Read the model's CURRENT value of a param/part (for slider initial pos).
    function readAny(id, isPart) {
      try {
        const cm = coreModel();
        if (!cm) return null;
        const gm = (cm.getModel) ? cm.getModel() : cm;
        if (isPart) return (typeof gm.getPartOpacityById === 'function') ? gm.getPartOpacityById(id) : null;
        return (typeof gm.getParameterValueById === 'function') ? gm.getParameterValueById(id) : null;
      } catch (e) { return null; }
    }

    // Freeze idle fidget + mouse-follow while dragging, then resume after 10s.
    // ── Shared model-freeze for DIRECT param editing ──
    // Used by BOTH the "Penjelasan Parameter" popup and the Sheet preset editor
    // so they share one mechanism. ROOT CAUSE of "slider moves nothing on some
    // models": pixi-live2d runs internalModel.update() (physics/motion/expression/
    // eyeBlink/focus/breath) INSIDE its own PIXI render, which runs BEFORE our
    // separate rAF tick() that calls applyOverrides(). So any param bound to those
    // systems is overwritten every frame unless we suspend the writers. We null
    // them for the freeze window and stash originals in state._frozenRefs so
    // unfreeze restores them exactly. While frozen we also hold state.aiLock so
    // idle fidget + mouse-follow don't fight the slider; tick() eases back in from
    // the current values when we release, so idle resumes smoothly. statusEl (if
    // given) shows the freeze countdown instead of the popup's own element.
    let _freezeStatusEl = null;
    let _freezeTimer = null;

    function freezeModelForEdit(statusEl, persistent) {
      state.frozen = true;
      const snap = (id) => (state.caps.params && state.caps.params.has(id)) ? readParam(id) : 0;
      if (typeof state.aiPose === 'object') {
        state.aiPose.ax = snap(roleId('angleX')); state.aiPose.ay = snap(roleId('angleY'));
        state.aiPose.ex = snap(roleId('eyeBallX')); state.aiPose.ey = snap(roleId('eyeBallY'));
        state.aiPose.bodyX = snap(roleId('bodyAngleX')); state.aiPose.bodyY = snap(roleId('bodyAngleY'));
        state.aiPose.bodyZ = snap(roleId('bodyAngleZ'));
        state.aiPose.mouthForm = snap(roleId('mouthForm'));
      }
      if (!state.aiLock) { state.aiLock = true; }
      const im = state.model && state.model.internalModel;
      if (im && !state._frozenRefs) {
        state._frozenRefs = {
          physics: im.physics, eyeBlink: im.eyeBlink, breath: im.breath,
        };
        try { im.motionManager.stopAllMotions(); } catch (e) {}
        try { if (im.motionManager.expressionManager) im.motionManager.expressionManager.resetExpression(); } catch (e) {}
        // PHYSICS TIDAK di-nol-kan. Di rig VBridger, kepala/badan/rok bergerak
        // LEWAT rantai physics: ParamAngleX & kawan-kawannya cuma INPUT, jadi
        // dengan im.physics = null slider pada param itu mengubah buffer tapi
        // tak mengubah satu piksel pun — tampak mati total (terukur: AngleX
        // 0 px physics-mati vs ±26.000 px physics-hidup). Physics dibiarkan
        // jalan supaya slider input terlihat efeknya; nilai slider pada param
        // OUTPUT tetap menang lewat override guard (re-assert di
        // beforeModelUpdate = SETELAH physics.evaluate). Blink/breath tetap
        // dibungkam — itu penulis parameter yang mengganggu pembacaan slider,
        // bukan bagian dari rantai deformasi.
        im.eyeBlink = null; im.breath = null;
        if (im.focusController) { im.focusController.x = 0; im.focusController.y = 0; }
      }
      _freezeStatusEl = statusEl || null;
      if (_freezeTimer) clearTimeout(_freezeTimer);
      if (_freezeStatusEl) {
        _freezeStatusEl.classList.add('frozen');
        _freezeStatusEl.textContent = persistent
          ? '❄ mode pose: model diam (idle/blink/napas dimatikan)'
          : '❄ dibekukan — gerak idle kembali dalam 10 dtk';
      }
      // Persistent freeze (preset/motion editor): hold the model completely still
      // until releasePresetPreview() — no 10s auto-resume, so the user can take
      // their time posing without idle/blink/breath fighting the sliders.
      if (persistent) return;
      let remaining = 1000;
      const tickCountdown = () => {
        remaining--;
        if (remaining > 0) {
          if (_freezeStatusEl) _freezeStatusEl.textContent = '❄ dibekukan — gerak idle kembali dalam ' + remaining + ' dtk';
          _freezeTimer = setTimeout(tickCountdown, 1000);
        } else {
          unfreezeModelForEdit();
        }
      };
      _freezeTimer = setTimeout(tickCountdown, 1000);
    }

    function unfreezeModelForEdit() {
      if (_freezeTimer) { clearTimeout(_freezeTimer); _freezeTimer = null; }
      const im = state.model && state.model.internalModel;
      if (im && state._frozenRefs) {
        im.physics = state._frozenRefs.physics;
        im.eyeBlink = state._frozenRefs.eyeBlink;
        im.breath = state._frozenRefs.breath;
        state._frozenRefs = null;
      }
      state.frozen = false;
      if (state.aiLock) state.aiLock = false;   // idle/mouse-follow resume; tick eases from CURRENT values → smooth, no snap
      if (_freezeStatusEl) {
        _freezeStatusEl.classList.remove('frozen');
        _freezeStatusEl.textContent = '✓ gerak idle aktif kembali';
      }
      _freezeStatusEl = null;
    }

    // Publikasikan ke scope luar sekali saja (lihat editorFreezeApi di atas).
    editorFreezeApi = { freeze: freezeModelForEdit, unfreeze: unfreezeModelForEdit };

    function renderParamNotesPopup(sheet) {
      if (!pnList) return;
      pnList.textContent = '';
      const params = (sheet && sheet.params) || [];
      const parts = (sheet && sheet.parts) || [];
      if (!params.length && !parts.length) {
        const p = document.createElement('div');
        p.className = 'pn-empty';
        p.textContent = 'Belum ada sheet. Buka tab 📁 Model → Inspeksi Model dulu.';
        pnList.appendChild(p);
        return;
      }
      // Kelompokkan param menurut grup yang sudah di-resolve (user > ai >
      // heuristik sheet); header terpisah bikin 200+ baris bisa dinavigasi.
      // Urutan = kemunculan pertama di sheet (stabil, ikut urutan rig).
      const groups = [];
      const byGroup = new Map();
      for (const p of params) {
        if (!p || !p.id || typeof p.min !== 'number' || typeof p.max !== 'number') continue;
        const g = resolveParamGroup(state.lastSheet || {}, p.id, p.group);
        if (!byGroup.has(g)) { byGroup.set(g, []); groups.push(g); }
        byGroup.get(g).push(p);
      }
      // EVERY parameter + part, no cap — the popup scrolls.
      for (const g of groups) {
        const members = byGroup.get(g);
        appendGroupHeader(pnList, g, members.length);
        for (const p of members) {
          // Label tampil duluan (nama asli rigger dari cdi3), id mengikuti —
          // membedakan "Heart eye · ParamEX08" dari nomor telanjang. Banyak
          // sheet menyimpan label = id sendiri; jangan duplikasi.
          const shownLabel = (p.label && p.label !== p.id) ? (p.label + ' · ' + p.id) : p.id;
          appendNoteRow(pnList, p.id, shownLabel, g, p.min, p.max, p.def, false,
            (typeof p.userNote === 'string') ? p.userNote : '');
        }
      }
      if (parts.length) {
        appendGroupHeader(pnList, 'Bagian (Parts)', parts.length);
        for (const p of parts) {
          if (!p || !p.id) continue;
          appendNoteRow(pnList, p.id, p.id, 'Bagian (Parts)', 0, 1, (typeof p.def === 'number' ? p.def : 1), true, '');
        }
      }
      applyPnFilter();
    }

    // Filter live untuk popup Penjelasan Parameter: cocokkan kueri pencarian
    // pada id/label/grup + ISI catatan yang sedang diedit. Tanpa re-render —
    // nilai slider & fokus textarea tidak ikut hilang. Header grup yang semua
    // barisnya tersaring ikut disembunyikan.
    function applyPnFilter() {
      if (!pnList) return;
      const q = (pnSearch && pnSearch.value || '').trim().toLowerCase();
      let visible = 0;
      const rows = Array.prototype.slice.call(pnList.querySelectorAll('.pn-row'));
      for (const row of rows) {
        const noteEl = row.querySelector('.pn-input');
        const hay = (row.dataset.hay || '') + ' ' + (noteEl ? noteEl.value : '');
        const show = !q || hay.toLowerCase().includes(q);
        row.classList.toggle('pn-hidden', !show);
        if (show) visible++;
      }
      let header = null, anyInGroup = false;
      for (const el of pnList.children) {
        if (el.classList.contains('pn-group-header')) {
          if (header) header.classList.toggle('pn-hidden', !anyInGroup);
          header = el; anyInGroup = false;
        } else if (!el.classList.contains('pn-hidden')) {
          anyInGroup = true;
        }
      }
      if (header) header.classList.toggle('pn-hidden', !anyInGroup);
      let empty = pnList.querySelector('.pn-empty-search');
      if (q && !visible) {
        if (!empty) {
          empty = document.createElement('div');
          empty.className = 'pn-empty pn-empty-search';
          pnList.prepend(empty);
        }
        empty.textContent = 'Tidak ada param yang cocok dengan "' + q + '".';
      } else if (empty) empty.remove();
    }

    function appendGroupHeader(list, title, count) {
      const h = document.createElement('div');
      h.className = 'pn-group-header';
      const t = document.createElement('span');
      t.className = 't'; t.textContent = title;
      const c = document.createElement('span');
      c.className = 'c'; c.textContent = count + ' param';
      h.appendChild(t); h.appendChild(c);
      list.appendChild(h);
      return h;
    }

    // Build one row: id, slider (min..max), live value label, description box.
    // The slider portion is delegated to the shared buildParamSliderRow() so the
    // popup and the preset editor use the exact same widget.
    function appendNoteRow(list, id, label, group, min, max, def, isPart, note) {
      const cur = readAny(id, isPart);
      const startVal = (cur != null && Number.isFinite(cur)) ? cur : def;
      const resolvedGroup = resolveParamGroup(state.lastSheet || {}, id, group);
      const { row } = buildParamSliderRow({
        id, label,
        // Header grup sudah menampilkan nama grup di atas kumpulan baris —
        // badge per-baris jadi redundan dan membuat baris ramai. Grup tetap
        // di-index untuk pencarian lewat dataset.hay di bawah.
        group: '',
        min, max, def, isPart, value: startVal,
        onInput: (id, v, isPart) => {
          // Drive the model live. setSticky keeps it held each frame; while frozen
          // the idle fidget won't fight it (see tick() frozen branch).
          if (isPart) window.__live2dAgent.setPartOpacity(id, v);
          else window.__live2dAgent.setParameter(id, v);
          pnStuckIds.add(id);
          freezeModelForEdit(pnCountdown);
        },
        onCommit: () => { unfreezeMaybe(); },
      });
      row.classList.toggle('saved', !!note.trim());
      row.dataset.id = id;
      row.dataset.part = isPart ? '1' : '';
      // Haystack pencarian (id + label + grup) — catatan dibaca live saat filter.
      row.dataset.hay = (id + ' ' + label + ' ' + resolvedGroup).toLowerCase();

      // Description textarea.
      const input = document.createElement('textarea');
      input.className = 'pn-input';
      input.rows = 1;
      input.maxLength = 300;
      input.placeholder = 'Jelaskan fungsi param ini, mis. "skala pupil kiri"';
      input.value = note;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.blur(); }
      });
      input.addEventListener('input', () => {
        const cnt = row.querySelector('.pn-count');
        if (cnt) cnt.textContent = input.value.length + '/300';
        row.classList.toggle('saved', input.value.trim().length > 0);
        if (pnTimer) clearTimeout(pnTimer);
        pnTimer = setTimeout(() => commitPn(row, id, input.value), 500);
      });
      input.addEventListener('blur', () => {
        if (pnTimer) { clearTimeout(pnTimer); pnTimer = null; }
        commitPn(row, id, input.value);
      });
      row.appendChild(input);

      const meta = document.createElement('div');
      meta.className = 'pn-meta';
      const cnt = document.createElement('span');
      cnt.className = 'pn-count'; cnt.textContent = input.value.length + '/300';
      const st = document.createElement('span');
      st.className = 'pn-status';
      meta.appendChild(cnt); meta.appendChild(st);
      row.appendChild(meta);

      list.appendChild(row);
    }

    function fmtNum(n) {
      const x = Number(n);
      if (!Number.isFinite(x)) return '0';
      return (Math.abs(x) >= 100 ? x.toFixed(1) : x.toFixed(2)).replace(/\.?0+$/, '') || '0';
    }

    // Reusable parameter/part SLIDER widget. Shared by the "Penjelasan Parameter"
    // popup AND the Sheet preset editor so both compose poses from the SAME
    // sliders instead of duplicating markup. Returns { row, range, valEl }; the
    // caller appends its own extra controls (textarea, meta) into `row`.
    // opts: { id, label, group, min, max, def, isPart, value, onInput, onCommit }
    function buildParamSliderRow(opts) {
      const id = opts.id, label = opts.label || id, group = opts.group || '';
      const min = opts.min, max = opts.max, def = opts.def;
      const isPart = !!opts.isPart;
      const startVal = (opts.value != null && Number.isFinite(opts.value)) ? opts.value : def;

      const row = document.createElement('div');
      row.className = 'pn-row';

      const head = document.createElement('div');
      head.className = 'pn-head';
      const idEl = document.createElement('span');
      idEl.className = 'pn-id'; idEl.textContent = label;
      head.appendChild(idEl);
      if (group) {
        const gEl = document.createElement('span');
        gEl.className = 'pn-group'; gEl.textContent = '· ' + group;
        head.appendChild(gEl);
      }
      row.appendChild(head);

      const sliderRow = document.createElement('div');
      sliderRow.className = 'pn-slider-row';
      const range = document.createElement('input');
      range.type = 'range'; range.className = 'pn-range';
      range.min = String(min); range.max = String(max); range.step = 'any';
      range.value = String(startVal);
      const valEl = document.createElement('span');
      valEl.className = 'pn-val';
      valEl.textContent = fmtNum(startVal) + '  [' + fmtNum(min) + '..' + fmtNum(max) + ']';
      sliderRow.appendChild(range);
      sliderRow.appendChild(valEl);
      row.appendChild(sliderRow);

      range.addEventListener('input', () => {
        const v = Number(range.value);
        valEl.textContent = fmtNum(v) + '  [' + fmtNum(min) + '..' + fmtNum(max) + ']';
        if (opts.onInput) opts.onInput(id, v, isPart);
      });
      range.addEventListener('change', () => {
        if (opts.onCommit) opts.onCommit(id, Number(range.value), isPart);
      });

      return { row, range, valEl };
    }

    function unfreezeMaybe() {
      // Re-arm the 10s resume-from-now so a quick re-drag doesn't cut it short.
      if (state.frozen) freezeModelForEdit(pnCountdown);
    }

    async function commitPn(row, paramId, value) {
      const api = window.__live2dAgent && window.__live2dAgent.sheet;
      if (!api || !api.saveParamNote) return;
      try {
        await api.saveParamNote(paramId, value);
        setPnStatus(row, 'tersimpan', 'ok');
      } catch (e) {
        setPnStatus(row, 'gagal: ' + e.message, 'err');
      }
    }

    // Flush EVERY note field in the popup at once. The per-field autosave already
    // persists on its own, but an explicit "Simpan Catatan" gives the user a clear
    // single action (matching the rest of the panels) and guarantees nothing is
    // left in the 500ms debounce queue when they close the popup.
    async function saveAllParamNotes() {
      if (pnTimer) { clearTimeout(pnTimer); pnTimer = null; }
      const rows = pnList ? Array.from(pnList.querySelectorAll('.pn-row')) : [];
      let count = 0, failed = 0;
      for (const row of rows) {
        const id = row.dataset && row.dataset.id;
        if (!id) continue;
        const ta = row.querySelector('.pn-input');
        const val = ta ? ta.value : '';
        try {
          const api = window.__live2dAgent && window.__live2dAgent.sheet;
          if (!api || !api.saveParamNote) throw new Error('API sheet tidak tersedia');
          await api.saveParamNote(id, val);
          count++;
        } catch (e) {
          failed++;
          setPnStatus(row, 'gagal: ' + e.message, 'err');
        }
      }
      if (pnSaveStatus) {
        if (failed) {
          pnSaveStatus.textContent = count + ' tersimpan, ' + failed + ' gagal';
          pnSaveStatus.className = 'note-status err';
        } else {
          pnSaveStatus.textContent = count + ' catatan tersimpan';
          pnSaveStatus.className = 'note-status ok';
        }
      }
    }

    function openParamNotesPopup() {
      const sheet = state.lastSheet || loadCharacterSheet();
      if (!sheet || (!sheet.params && !sheet.parts)) {
        if (window.__addChat) window.__addChat('agent', 'Belum ada sheet. Inspeksi model dulu (tab 📁 Model → 🔍 Inspeksi Model).');
        return;
      }
      // Cache pengukuran lama dimuat per model saat load — tapi wireUI bisa
      // jalan sebelum itu; sinkronkan saat popup dibuka (gate overlay yang
      // membaca visfxMap tetap jalan untuk model yang pernah discan).
      if (!state.visfxMap) state.visfxMap = visfxLoad();
      renderParamNotesPopup(sheet);
      if (pnPopup) { pnPopup.classList.remove('hidden'); pnPopup.setAttribute('aria-hidden', 'false'); }
    }

    function closeParamNotesPopup() {
      if (pnPopup) { pnPopup.classList.add('hidden'); pnPopup.setAttribute('aria-hidden', 'true'); }
      // Release every sticky override we set so the model returns to its own
      // rigged behaviour (smooth — idle eases back in from current values).
      for (const id of pnStuckIds) {
        try { delete state.overrides[id]; } catch (e) {}
      }
      pnStuckIds.clear();
      unfreezeModelForEdit();
    }

    if (pnOpenBtn) pnOpenBtn.addEventListener('click', openParamNotesPopup);
    if (pnSearch) pnSearch.addEventListener('input', applyPnFilter);
    // Jembatan untuk kode di luar wireUI (mis. prefetchCdiInfo) yang perlu
    // me-render ulang popup jika kebetulan sedang terbuka.
    window.__pnRefreshIfOpen = () => {
      if (pnPopup && !pnPopup.classList.contains('hidden') && state.lastSheet) {
        renderParamNotesPopup(state.lastSheet);
      }
    };
    if (pnCloseBtn) pnCloseBtn.addEventListener('click', closeParamNotesPopup);
    if (pnSaveAll) pnSaveAll.addEventListener('click', saveAllParamNotes);

    function paintDraft() {
      const box = shEls.values;
      if (!box) return;
      box.textContent = '';
      const rows = Object.entries(draft.values).map(([k, v]) => [k, v, 'param'])
        .concat(Object.entries(draft.parts).map(([k, v]) => [k, v, 'part']));
      if (!rows.length) {
        const p = document.createElement('div');
        p.className = 'preset-empty';
        p.textContent = 'Belum ada nilai. Geser slider di atas, atau tekan 📸 Ambil Pose Sekarang untuk memulai dari pose live.';
        box.appendChild(p);
        return;
      }
      for (const [id, v, kind] of rows) {
        const r = document.createElement('div');
        r.className = 'pv-row';
        const a = document.createElement('span');
        a.textContent = (kind === 'part' ? '◧ ' : '') + id;
        a.title = kind === 'part' ? 'Part (opacity)' : 'Parameter';
        const b = document.createElement('span');
        b.textContent = Number(v).toFixed(2);
        r.appendChild(a); r.appendChild(b);
        box.appendChild(r);
      }
    }

    // Release the live preview we drove via the editor sliders: clear every
    // override we stuck and unfreeze idle. Called on Save/Clear so the model
    // returns to normal instead of staying locked in the edited pose.
    function releasePresetPreview() {
      for (const id of presetStuckIds) { try { delete state.overrides[id]; } catch (e) {} }
      presetStuckIds.clear();
      unfreezeModelForEdit();
    }

    // Render an editable slider for EVERY parameter + part of the model, wired to
    // the draft (and previewed live). Dragging updates draft.values/parts (only
    // non-default values are stored, matching captureCurrentPose()) and drives
    // the model via setParameter/setPartOpacity while frozen, so the slider is
    // the sole writer and actually moves the model.
    function renderPresetSliders(sheet) {
      if (!presetSliders) return;
      presetSliders.textContent = '';
      const params = (sheet && sheet.params) || [];
      const parts = (sheet && sheet.parts) || [];
      if (!params.length && !parts.length) {
        const p = document.createElement('div');
        p.className = 'pn-empty';
        p.textContent = 'Belum ada sheet. Inspeksi model dulu.';
        presetSliders.appendChild(p);
        return;
      }
      for (const p of params) {
        if (!p || !p.id || typeof p.min !== 'number' || typeof p.max !== 'number') continue;
        const dflt = Number.isFinite(p.def) ? p.def : 0;
        const live = readAny(p.id, false);
        const startVal = (draft.values[p.id] != null) ? draft.values[p.id]
          : (live != null && Number.isFinite(live)) ? live : dflt;
        const { row } = buildParamSliderRow({
          // Konsisten dengan popup Penjelasan Parameter: label nama rigger dari
          // cdi3 ("heart eye"), bukan id mentah; grup lewat resolveParamGroup.
          id: p.id, label: (p.label && p.label !== p.id) ? (p.label + ' · ' + p.id) : p.id,
          group: resolveParamGroup(sheet, p.id, p.group),
          min: p.min, max: p.max, def: dflt, isPart: false, value: startVal,
          onInput: (id, v) => {
            if (Math.abs(v - dflt) > 1e-3) draft.values[id] = Number(v.toFixed(3));
            else delete draft.values[id];
            window.__live2dAgent.setParameter(id, v);
            presetStuckIds.add(id);
            freezeModelForEdit(presetFreezeInfo, true);
            paintDraft();
          },
          onCommit: () => { if (state.frozen) freezeModelForEdit(presetFreezeInfo, true); },
        });
        presetSliders.appendChild(row);
      }
      for (const p of parts) {
        if (!p || !p.id) continue;
        const dflt = (typeof p.def === 'number') ? p.def : 1;
        const live = readAny(p.id, true);
        const startVal = (draft.parts[p.id] != null) ? draft.parts[p.id]
          : (live != null && Number.isFinite(live)) ? live : dflt;
        const { row } = buildParamSliderRow({
          id: p.id, label: p.id, group: 'Bagian (Parts)', min: 0, max: 1, def: dflt, isPart: true, value: startVal,
          onInput: (id, v) => {
            if (Math.abs(v - dflt) > 1e-3) draft.parts[id] = Number(v.toFixed(3));
            else delete draft.parts[id];
            window.__live2dAgent.setPartOpacity(id, v);
            presetStuckIds.add(id);
            freezeModelForEdit(presetFreezeInfo, true);
            paintDraft();
          },
          onCommit: () => { if (state.frozen) freezeModelForEdit(presetFreezeInfo, true); },
        });
        presetSliders.appendChild(row);
      }
    }

    // Capture the pose the user has actually arranged on screen. Only params
    // that DIFFER from their sheet default are stored: snapshotting all ~90
    // parameters would freeze the whole model, killing blink and idle motion the
    // moment the preset is applied.
    function captureCurrentPose() {
      const sheet = state.lastSheet || loadCharacterSheet();
      if (!sheet) return { ok: false, message: 'Belum ada sheet. Inspeksi model dulu.' };
      if (!state.model) return { ok: false, message: 'Load model dulu.' };
      const values = {};
      let skipped = 0;
      for (const p of (sheet.params || [])) {
        if (!p || !p.id) continue;
        const cur = readParam(p.id);
        const def = Number.isFinite(p.def) ? p.def : 0;
        // 1e-3: Cubism values are floats and idle/physics jitter constantly, so
        // an exact !== comparison would capture dozens of meaningless deltas.
        if (Math.abs(cur - def) > 1e-3) values[p.id] = Number(cur.toFixed(3));
        else skipped++;
      }
      const parts = {};
      const cm = coreModel();
      const gm = (cm && cm.getModel) ? cm.getModel() : cm;
      for (const pt of (sheet.parts || [])) {
        const id = pt && pt.id ? pt.id : pt;
        if (!id) continue;
        let cur = null;
        try {
          if (gm && typeof gm.getPartOpacityById === 'function') cur = gm.getPartOpacityById(id);
        } catch (e) { cur = null; }
        if (cur === null || !Number.isFinite(cur)) continue;
        const def = (pt && Number.isFinite(pt.def)) ? pt.def : 1;
        if (Math.abs(cur - def) > 1e-3) parts[id] = Number(cur.toFixed(3));
      }
      return { ok: true, values, parts, skipped };
    }

    if (shEls.capture) {
      shEls.capture.addEventListener('click', () => {
        const res = captureCurrentPose();
        if (!res.ok) {
          if (shEls.captureInfo) {
            shEls.captureInfo.textContent = res.message;
            shEls.captureInfo.className = 'note-status err';
          }
          return;
        }
        draft = { values: res.values, parts: res.parts };
        paintDraft();
        renderPresetSliders(state.lastSheet || loadCharacterSheet());
        freezeModelForEdit(presetFreezeInfo, true);
        const n = Object.keys(res.values).length + Object.keys(res.parts).length;
        if (shEls.captureInfo) {
          shEls.captureInfo.textContent = n
            ? n + ' nilai diambil (' + res.skipped + ' param default dilewati)'
            : 'model masih di pose default — tidak ada yang diambil';
          shEls.captureInfo.className = 'note-status' + (n ? ' ok' : '');
        }
      });
    }

    if (shEls.clear) {
      shEls.clear.addEventListener('click', () => {
        draft = { values: {}, parts: {} };
        if (shEls.name) shEls.name.value = '';
        releasePresetPreview();
        paintDraft();
        renderPresetSliders(state.lastSheet || loadCharacterSheet());
        setPresetStatus('editor dikosongkan', '');
        if (shEls.captureInfo) { shEls.captureInfo.textContent = ''; shEls.captureInfo.className = 'note-status'; }
      });
    }

    // Pre-flight the gerak name check so the user learns about a collision
    // BEFORE filling in a pose, not after pressing Save.
    if (shEls.name && shEls.cat) {
      const preflight = () => {
        if (shEls.cat.value !== 'gerak') { setPresetStatus(''); return; }
        const nm = shEls.name.value.trim();
        if (!nm) { setPresetStatus(''); return; }
        const chk = checkGerakName(nm, state.lastSheet);
        if (!chk.ok) setPresetStatus(chk.message + ' Usul: "' + chk.suggestion + '"', 'err');
        else setPresetStatus('nama boleh dipakai', 'ok');
      };
      shEls.name.addEventListener('input', preflight);
      shEls.cat.addEventListener('change', preflight);
    }

    if (shEls.save) {
      shEls.save.addEventListener('click', async () => {
        const name = shEls.name ? shEls.name.value.trim() : '';
        const category = shEls.cat ? shEls.cat.value : 'properti';
        if (!name) { setPresetStatus('nama preset wajib diisi', 'err'); return; }
        // A 'gerak' preset is driven by timed keyframes (steps), which this
        // editor does not author — capturing a frozen pose and calling it a
        // motion would save something that plays as a single static frame.
        if (category === 'gerak') {
          setPresetStatus('kategori gerak butuh keyframe (steps) — belum didukung editor ini', 'err');
          return;
        }
        if (!Object.keys(draft.values).length && !Object.keys(draft.parts).length) {
          setPresetStatus('belum ada nilai — tekan 📸 Ambil Pose Sekarang', 'err');
          return;
        }
        shEls.save.disabled = true;
        setPresetStatus('menyimpan…');
        try {
          const saved = await saveUserPreset({
            name, category,
            values: draft.values,
            parts: draft.parts,
          });
          setPresetStatus('tersimpan: ' + saved.name, 'ok');
          sheetCatFilter = saved.category;
          releasePresetPreview();
          refreshSheetUI();
        } catch (e) {
          setPresetStatus('gagal: ' + e.message, 'err');
        } finally {
          shEls.save.disabled = false;
        }
      });
    }

    if (shEls.analyze) {
      shEls.analyze.addEventListener('click', async () => {
        shEls.analyze.disabled = true;
        setSheetStatus('menganalisa… (bisa belasan detik)', 'busy');
        // Two independent analyses. Run with allSettled, not sequential awaits:
        // parameter labelling failing must not deny the user preset suggestions,
        // and vice versa. Each outcome is reported separately below.
        const [labels, presets] = await Promise.allSettled([
          triggerAIParamClassification(),
          analyzeSheetPresets(),
        ]);
        try {
          const parts = [];
          if (presets.status === 'fulfilled') {
            const n = presets.value && presets.value.count ? presets.value.count : 0;
            parts.push(n ? n + ' saran preset (🤖)' : 'tidak ada saran preset baru');
          } else {
            parts.push('preset gagal: ' + presets.reason.message);
          }
          if (labels.status === 'fulfilled') {
            const n = labels.value && labels.value.count ? labels.value.count : 0;
            if (n) parts.push(n + ' parameter dilabeli');
          } else {
            parts.push('label gagal: ' + labels.reason.message);
          }
          const bad = presets.status === 'rejected' || labels.status === 'rejected';
          setSheetStatus(parts.join(' · '), bad ? 'err' : 'ok');
          refreshSheetUI();
        } finally {
          shEls.analyze.disabled = false;
        }
      });
    }

    // "🔄 Muat Ulang dari File": baca sheet dari file di server (bukan localStorage/
    // cache in-memory) dan pakai itu sebagai kebenaran. Ini supaya edit manual pada
    // sheets/<key>.json langsung terlihat di UI tanpa harus clear localStorage.
    if (shEls.reloadFile) {
      shEls.reloadFile.addEventListener('click', async () => {
        shEls.reloadFile.disabled = true;
        try {
          const sheet = await fetchSheetFile();
          if (!sheet) {
            shEls.reloadStatus.textContent = 'tidak ada file sheet di server';
            shEls.reloadStatus.className = 'note-status err';
            return;
          }
          if (!sheet.presets || typeof sheet.presets !== 'object') sheet.presets = { user: [], ai: [] };
          state.lastSheet = sheet;
          try { localStorage.setItem(characterSheetKey(), JSON.stringify(sheet)); } catch (e) {}
          hydrateCaps(sheet);
          draft = { values: {}, parts: {} };
          refreshSheetUI();
          if (presetEditorPopup && !presetEditorPopup.classList.contains('hidden')) {
            paintDraft();
            renderPresetSliders(sheet);
          }
          shEls.reloadStatus.textContent = 'dimuat ulang dari file ✓';
          shEls.reloadStatus.className = 'note-status ok';
        } catch (e) {
          shEls.reloadStatus.textContent = 'gagal: ' + e.message;
          shEls.reloadStatus.className = 'note-status err';
        } finally {
          shEls.reloadFile.disabled = false;
        }
      });
    }

    // Declared early (before the first refreshSheetUI() call) so loadAdoption()
    // can reference them without hitting the const TDZ during wireUI().
    const adEls = {
      list: $('#adoption-list'),
      save: $('#btn-adoption-save'),
      status: $('#adoption-status'),
    };
    let adDisabled = new Set();   // current (unsaved) disabled names

    // Assigned to the module-scope hook so loadModel() can repaint on swap.
    refreshSheetUI = () => {
      const sheet = state.lastSheet || loadCharacterSheet();
      paintSheetSummary(sheet);
      paintSheetCats(sheet);
      paintPresetList(sheet);
      // Penjelasan parameter kini di popup terpisah; render ulang hanya bila
      // popup sedang terbuka agar nilai slider/deskripsi tetap sinkron.
      if (pnPopup && !pnPopup.classList.contains('hidden')) renderParamNotesPopup(sheet);
      paintDraft();
      renderPresetSliders(sheet);
      loadAdoption();   // Langkah 2d: keep the opt-out list in sync with the model
    };
    refreshSheetUI();

    // ── Ekspresi teradopsi (opt-out) — Langkah 2d ──
    // Renders each auto-adopted orphaned .exp3 with a checkbox, and saves the
    // user's disabled set via POST /api/model/expressions-adoption. Adoption
    // stays ON by default; this only lets the user switch specific files off.
    function currentModelFolder() {
      const parts = String(state.modelPath || '').split('/');
      return parts.length >= 2 ? parts[1] : null;
    }

    async function loadAdoption() {
      if (!adEls.list) return;
      const folder = currentModelFolder();
      if (!folder) { setAdoptionMsg('Load model dulu.', ''); return; }
      try {
        const r = await fetch(API + '/api/model/expressions-adoption?name=' + encodeURIComponent(folder));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const info = await r.json();
        const exprs = Array.isArray(info.expressions) ? info.expressions : [];
        adDisabled = new Set(Array.isArray(info.disabled) ? info.disabled : []);
        if (!exprs.length) { setAdoptionMsg('Tidak ada .exp3 di folder ini.', ''); return; }
        adEls.list.textContent = '';
        for (const e of exprs) {
          const row = document.createElement('div');
          row.className = 'preset-item' + (e.declared ? ' is-ai' : '');
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.checked = !!e.enabled;
          cb.id = 'adopt_' + e.Name;
          cb.addEventListener('change', () => {
            if (cb.checked) adDisabled.delete(e.Name);
            else adDisabled.add(e.Name);
          });
          const lbl = document.createElement('label');
          lbl.className = 'p-name'; lbl.htmlFor = cb.id;
          lbl.textContent = e.Name + (e.declared ? ' (terdaftar)' : ' (yatim)');
          row.appendChild(cb); row.appendChild(lbl);
          // Tes langsung: pasang ekspresi ini di model supaya ceklis bukan
          // satu-satunya yang bisa dilakukan — user bisa LIHAT dulu efeknya
          // sebelum memutuskan mengadopsi/menonaktifkan.
          const testBtn = document.createElement('button');
          testBtn.type = 'button'; testBtn.className = 'p-act';
          testBtn.textContent = '👁 tes';
          testBtn.title = 'Pasang ekspresi ini di model untuk melihat efeknya (ekspresi berikutnya otomatis menggantikan).';
          testBtn.addEventListener('click', () => {
            if (!state.model) { setAdoptionMsg('Load model dulu.', 'err'); return; }
            window.__live2dAgent.setExpression(e.Name, 1);
            setSheetStatus('ekspresi dipasang: ' + e.Name, '');
          });
          row.appendChild(testBtn);
          adEls.list.appendChild(row);
        }
      } catch (e) {
        setAdoptionMsg('Gagal muat: ' + e.message, 'err');
      }
    }
    // Uses textContent (never innerHTML) so a model/expession name from disk can
    // never inject markup — same XSS guard as the rest of the sheet pane.
    function setAdoptionMsg(msg, kind) {
      if (!adEls.list) return;
      adEls.list.textContent = '';
      const d = document.createElement('div');
      d.className = 'preset-empty' + (kind ? ' ' + kind : '');
      d.textContent = msg;
      adEls.list.appendChild(d);
    }

    if (adEls.save) {
      adEls.save.addEventListener('click', async () => {
        adEls.save.disabled = true;
        if (adEls.status) { adEls.status.textContent = 'menyimpan…'; adEls.status.className = 'note-status'; }
        const folder = currentModelFolder();
        if (!folder) { if (adEls.status) adEls.status.textContent = 'load model dulu'; adEls.save.disabled = false; return; }
        try {
          const r = await fetch(API + '/api/model/expressions-adoption', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: folder, disabled: Array.from(adDisabled) }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
          if (adEls.status) { adEls.status.textContent = 'tersimpan (' + adDisabled.size + ' dimatikan)'; adEls.status.className = 'note-status ok'; }
          // Re-adopt on next load: changing the opt-out set must re-run buildModelSettings.
          if (state.model) { try { await loadModel(state.modelPath); } catch (e) { console.warn('[adoption] reload failed:', e.message); } }
        } catch (e) {
          if (adEls.status) { adEls.status.textContent = 'gagal: ' + e.message; adEls.status.className = 'note-status err'; }
        } finally {
          adEls.save.disabled = false;
        }
      });
    }

    loadConns();

    // Status koneksi REALTIME: testStatus/lastError/rateLimitedUntil ditulis
    // server SETIAP KALI LLM benar-benar dipanggil (sukses maupun gagal), bukan
    // hanya saat tombol Test ditekan. Polling ringan 4 dtk + render hanya bila
    // signature berubah — daftar tidak berkedip dan klik tidak terganggu.
    let pollBusy = false;
    setInterval(async () => {
      if (pollBusy || document.hidden) return;
      pollBusy = true;
      try {
        const r = await fetch(API + '/api/config');
        const d = await r.json();
        if (connSig(d.connections || [], d.activeId) !== lastConnSig)
          renderConns(d.connections || [], d.activeId);
      } catch {}
      pollBusy = false;
    }, 4000);
  }

  // ── Sheet schema + per-model config constants ───────────────────
  // These live ABOVE the Boot call on purpose. `const` is not hoisted the way
  // function declarations are: it sits in a temporal dead zone until its own
  // line executes. wireUI() -> refreshConfigForm() -> loadModelConfigLocal() ->
  // normalizeModelConfig() reads MODEL_CONFIG_DEFAULTS synchronously during
  // boot, so declaring these further down the file (where the sheet code that
  // also uses them lives) threw "Cannot access 'MODEL_CONFIG_DEFAULTS' before
  // initialization" and killed the whole IIFE before the model ever loaded.
  // Keep declarations that boot-time code touches in this block.
  //
  // Sheets are persisted in two places (localStorage + sheets/*.json) and are
  // read back by code that keeps gaining fields. Without a version stamp there
  // is no way to tell "field missing because the model lacks it" from "field
  // missing because this sheet predates the field", so every reader would need
  // its own defensive guesswork. The version lets migrateSheet() normalize once,
  // at the single point where a sheet enters the app.
  //
  // v0 = unversioned legacy sheets already on disk / in localStorage.
  // v1 = adds schemaVersion + userNote.
  // v2 = adds config{} (per-model user preferences: blink, idle, framing, TTS).
  // v3 = adds rangeSource. Pre-v3 sheets were written by a broken enumeration
  //      path whose ranges were ALWAYS guesses while claiming to be measured,
  //      so v3 relabels them as estimated and asks for a re-inspect.
  // v4 = adds params[i].userNote (per-parameter description written by the user),
  //      paramGroups{user,ai} (CATEGORISATION: which tab/section a raw slider
  //      belongs to) and presets{user,ai} (NAMED PRESETS: one clickable name ->
  //      several params at specific values). The last two are deliberately
  //      separate structures: a category label carries no values, and a preset
  //      does not tell you where to file a slider. Both are needed.
  const SHEET_SCHEMA_VERSION = 4;

  // Fields authored by the USER, never by inspection or by the LLM. These must
  // survive re-inspection: inspectModel() rebuilds the sheet from scratch, so
  // without this list a re-inspect would silently erase the user's own notes.
  //
  // paramGroups and presets are carried WHOLE, including their .ai branch.
  // Re-inspection is about re-measuring ranges from Cubism, not about revising
  // groupings — dropping .ai here would make a range re-measure silently throw
  // away the LLM's suggestions too. The .ai branch is replaced only by an
  // explicit "Kirim ke LLM". Stale ids inside either branch are harmless: they
  // are validated against sheet.params at render/apply time.
  const USER_AUTHORED_FIELDS = ['userNote', 'config', 'paramGroups', 'presets'];

  // ── Preset model ────────────────────────────────────────────────
  // A preset is a NAME the user (or the LLM) can invoke, mapping to concrete
  // values. Four categories, matching the four tabs:
  //   emosi     -> projected into state.supportedEmotions, so applyExpression()
  //                and getExpressibleEmotions() pick it up with no new engine
  //   properti  -> manual click only for now (see note in capability profile)
  //   aksesoris -> merged into capProfile.accessories, driven via [ACC:...]
  //   gerak     -> merged into capProfile.gestures, driven via [GESTURE:...]
  const PRESET_CATEGORIES = ['emosi', 'properti', 'aksesoris', 'gerak'];

  // Bounds for the SEMANTIC pose fields used by a 'gerak' preset's steps.
  //
  // ±30 for bodyX/bodyY/bodyZ is DELIBERATE and matches applyActions() in
  // agent.js — see the long comment there. Do not narrow either one to ±20
  // without changing both: the whole point is that a preset the user designed
  // and a directive the LLM emitted obey the same limit.
  //
  // ex/ey/mouthForm are normalized -1..1 in the engine, not degrees.
  //
  // Only these eight names exist. Anything else in a step's delta is DROPPED
  // rather than passed through — that is what keeps a 'gerak' preset
  // model-agnostic and stops a raw Cubism paramId from sneaking in via `d`.
  const STEP_FIELD_BOUNDS = {
    ax: 30, ay: 30, bodyX: 30, bodyY: 30, bodyZ: 30,
    ex: 1, ey: 1, mouthForm: 1,
  };
  // Structural limits. Clamping values alone does not save us here: a preset
  // with ms:0 repeated 400 times floods setTimeout without any single number
  // being out of range. 40ms is below one frame at 24fps, so anything shorter
  // is invisible anyway.
  const STEP_MS_MIN = 40;
  const STEP_MS_MAX = 3000;
  const STEP_COUNT_MAX = 12;
  const STEP_TOTAL_MS_MAX = 8000;


  // Per-model config. These were previously hardcoded and reset on every reload:
  // blink/idle lived only in `state`, framing was a literal frameModel('upper')
  // at load time, and the TTS voice was `pitch: 1.15` baked into browserTTS().
  // Pitch in particular is part of a character's identity — every model sounded
  // identical.
  //
  // Stored INSIDE the sheet rather than in a second file: the sheet already has
  // atomic writes, a serialized write queue, schema migration and a user-authored
  // whitelist. A separate file would mean rebuilding all four and would introduce
  // a desync window between two files describing one model.
  const MODEL_CONFIG_DEFAULTS = {
    blink: true,
    idle: true,
    framing: 'upper',     // 'upper' | 'full'
    ttsRate: 1,
    ttsPitch: 1.15,       // the old hardcoded value, now just the default
    ttsLang: 'id-ID',
    // Empty means "derive from the model folder name". Storing '' rather than a
    // baked-in character name is what makes the app model-agnostic: importing
    // someone else's model must not leave another character's name in the UI.
    displayName: '',
  };

  const FRAMING_MODES = ['upper', 'full'];
  // Web Speech API accepts rate 0.1..10 and pitch 0..2. Values outside those are
  // silently ignored by the browser, which looks like "the setting did nothing",
  // so clamp here instead of letting a bad number reach speechSynthesis.
  const TTS_RATE_RANGE = { min: 0.5, max: 2 };
  const TTS_PITCH_RANGE = { min: 0, max: 2 };

  // Live per-model config: the single place the running app reads its per-model
  // preferences from. Seeded from the sheet on model load; a saved sheet is
  // authoritative. Assigned here (not further down) for the same TDZ reason —
  // refreshConfigForm() runs during wireUI() and would otherwise read undefined.
  state.modelConfig = Object.assign({}, MODEL_CONFIG_DEFAULTS);

  // ─── Boot ─────────────────────────────────────────────────────
  wireUI();
  // Optional ?model=NAME lets you open a user-imported model directly in the
  // URL (handy for debugging / sharing). Falls back to the bundled default.
  (async () => {
    const q = new URLSearchParams(location.search).get('model');
    if (q) {
      try {
        const r = await fetch(API + '/api/model/path?name=' + encodeURIComponent(q));
        if (r.ok) { const d = await r.json(); if (d.path) { await loadModel(d.path); return; } }
      } catch (e) { console.warn('[boot] ?model load failed, using default', e); }
    }
    // Auto-detect: load the first model the server actually has. Delegated to
    // resolveAnyModelPath() so this path and loadModel()'s own no-arg fallback
    // cannot drift apart.
    let names = [];
    try {
      const r = await fetch(API + '/api/models');
      const d = await r.json();
      names = Array.isArray(d.models) ? d.models : [];
    } catch (e) { console.warn('[boot] model list failed', e); }
    if (!names.length) { showNoModelState(); return; }
    // Model terakhir yang dibuka diingat di localStorage (per browser) dan
    // divalidasi ke daftar server — kalau sudah dihapus, jatuh ke model pertama.
    let pick = names[0];
    try {
      const last = localStorage.getItem('live2d_last_model');
      if (last && names.includes(last)) pick = last;
    } catch (e) { /* localStorage bisa terlarang — pakai model pertama */ }
    try {
      const r = await fetch(API + '/api/model/path?name=' + encodeURIComponent(pick));
      if (r.ok) { const d = await r.json(); if (d.path) { await loadModel(d.path); return; } }
    } catch (e) { console.warn('[boot] last/default load failed', e); }
    loadModel();
  })();

  app.ticker.add(() => {
    if (state.model && !$('#loader').classList.contains('done')) {
      $('#loader').classList.add('done');
      setTimeout(() => {
        $('#loader').classList.add('fade-out');
        setTimeout(() => $('#loader').classList.add('hidden'), 650);
      }, 600);
    }
  });

  // ─── Public Agent API (used by the agent layer later) ─────────
  // The future agent (LLM/mic/STT) calls these directly instead of clicking
  // buttons. Keeps the UI as a thin shell over controllable state.
  // ── Gesture Library ("gesture verbs") ──────────────────────────
  // Why: asking the LLM to freehand numeric coordinates ([HEAD:x,y] etc) for
  // every clause is unreliable — a language model reasons much better about
  // picking a NAME from a short list than about choreographing raw numbers,
  // and free-drift numeric poses tend to blur into one continuous "wobble"
  // instead of reading as a distinct, recognizable motion (a nod that
  // actually looks like nodding). So we predefine a small set of named
  // pose-delta sequences built ONLY from the same semantic pose fields
  // setAIPose() already uses (ax/ay/ex/ey/bodyX/bodyY/bodyZ/mouthForm) — so
  // they stay 100% model-agnostic; they play through roleId() same as always.
  // Each step's delta composes ON TOP of whatever [HEAD]/[EMOTION] set right
  // before the gesture, so a "senang" head-tilt + a "nod" gesture blend
  // together instead of fighting.
  const GESTURE_LIBRARY = {
    nod:              [ { d:{ ay:-8 }, ms:160 }, { d:{ ay:6 }, ms:160 }, { d:{ ay:-5 }, ms:140 }, { d:{}, ms:160 } ],
    shake:            [ { d:{ ax:-10 }, ms:150 }, { d:{ ax:10 }, ms:150 }, { d:{ ax:-7 }, ms:140 }, { d:{}, ms:160 } ],
    tilt_curious:     [ { d:{ bodyZ:10, ax:6, ex:0.15 }, ms:260 }, { d:{ bodyZ:8, ax:5 }, ms:500 } ],
    lean_excited:     [ { d:{ bodyY:-6, ay:-6 }, ms:180 }, { d:{ bodyY:3, ay:2 }, ms:220 }, { d:{}, ms:260 } ],
    recoil_surprised: [ { d:{ ay:-12, bodyY:6, ex:-0.1, ey:-0.15 }, ms:140 }, { d:{ ay:-4 }, ms:260 }, { d:{}, ms:300 } ],
    look_away_shy:    [ { d:{ ax:-14, ex:-0.35, ay:6 }, ms:320 }, { d:{ ax:-8, ex:-0.2 }, ms:500 } ],
    laugh_bounce:     [ { d:{ ay:-6, bodyY:-5 }, ms:120 }, { d:{ ay:4, bodyY:3 }, ms:120 }, { d:{ ay:-4, bodyY:-3 }, ms:120 }, { d:{ ay:2, bodyY:2 }, ms:120 }, { d:{}, ms:160 } ],
    think:            [ { d:{ bodyZ:-8, ax:-5, ay:4, ex:-0.2, ey:-0.1 }, ms:300 }, { d:{ bodyZ:-6, ax:-4 }, ms:700 } ],
    wave_hi:          [ { d:{ ax:8, ay:-4, bodyX:4 }, ms:200 }, { d:{ ax:-6 }, ms:200 }, { d:{ ax:4 }, ms:200 }, { d:{}, ms:200 } ],
  };
  // Emotion → default gesture, used by the fallback path when the LLM gave
  // no explicit [GESTURE:...] (keeps the "no directive at all" case lively
  // instead of falling back to plain idle).
  const EMOTION_GESTURE = { senang: 'lean_excited', sedih: 'look_away_shy', malu: 'look_away_shy', kaget: 'recoil_surprised', normal: 'nod' };

  // ── Motion Studio: registry + runtime (SPEC §31: satu pipeline) ─────────
  // Registry membungkus TIGA sumber motion tanpa menyalin datanya: gesture
  // builtin (tabel di atas), motion native model, dan Motion Asset buatan
  // user dari motions/<modelKey>/. Runtime mengevaluasi keyframe lalu menulis
  // delta ke state.aiPose lewat bridge di bawah — jalur yang sama dengan
  // gesture lama — sehingga ease engine, fidget, override sticky, dan guard
  // clipUntil tetap memerintah. TIDAK ada penulis parameter kedua.
  const haveMotionSystem = typeof MotionRegistry !== 'undefined'
    && typeof MotionRuntime !== 'undefined' && typeof MotionDSL !== 'undefined';
  const motionRegistry = haveMotionSystem ? MotionRegistry.createRegistry() : null;
  if (haveMotionSystem) motionRegistry.registerGestureLibrary(GESTURE_LIBRARY, EMOTION_GESTURE);

  // Delta yang SEDANG diterapkan runtime ke state.aiPose, per field. Dipakai
  // untuk komposisi inkremental: tiap frame kita hanya menambahkan SELISIH dari
  // frame sebelumnya, sehingga emosi/pose lain yang berubah SAAT motion jalan
  // tetap hidup di bawah delta (motion menunggangi, bukan menimpa).
  let motionApplied = {};
  const POSE_FIELDS = { ax: 1, ay: 1, ex: 1, ey: 1, bodyX: 1, bodyY: 1, bodyZ: 1, mouthForm: 1 };
  function unwindMotionDelta() {
    const P = state.aiPose;
    for (const k in motionApplied) {
      if (motionApplied[k]) P[k] = (P[k] || 0) - motionApplied[k];
    }
    motionApplied = {};
  }
  const motionBridge = haveMotionSystem ? {
    now: () => performance.now(),
    getPoseBase: () => {
      const P = state.aiPose;
      return { ax: P.ax || 0, ay: P.ay || 0, ex: P.ex || 0, ey: P.ey || 0,
        bodyX: P.bodyX || 0, bodyY: P.bodyY || 0, bodyZ: P.bodyZ || 0, mouthForm: P.mouthForm || 0 };
    },
    getSupports: () => {
      const s = new Set();
      if (state.caps.hasHead) s.add('head');
      if (state.caps.hasEyes) s.add('eyes');
      if (state.caps.hasMouth) s.add('mouth');
      if (state.caps.hasBody) s.add('body');
      return s;
    },
    // Parameter mentah yang BENAR-BENAR dimiliki model ini. Runtime memakai ini
    // untuk melewati track milik model lain dengan aman (motion model-scoped
    // dibuka di rig berbeda) — bukan menulis id yang tidak ada.
    getOwnedParams: () => (state.caps && state.caps.params) || null,
    readParam: (id) => readParam(id),
    // Nilai absolut per parameter dari track raw. Lewat setRawDrive supaya
    // di-assert ulang tiap frame (internalModel.update() akan menimpanya).
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
        // Pasang guard clip yang sama dengan playEmotionClip(): tanpa ini pose
        // AI yang di-ease melawan klip (dua penulis satu parameter = kejang).
        // Durasi tak diketahui untuk index acak → pakai default konservatif.
        state.clipStartedAt = performance.now();
        state.clipUntil = state.clipStartedAt + 2200 + 250;
        state.clipName = g;
        state.impulse = Math.min(1.0, state.impulse + 0.3);
      } catch (e) { console.warn('[motion] native play failed:', g, e.message); }
    },
  } : null;
  const motionRuntime = haveMotionSystem ? MotionRuntime.createRuntime(motionRegistry, motionBridge) : null;

  // Muat isi registry untuk model yang sedang aktif: grup native + motion user
  // dari server. Dipanggil dari loadModel() SETELAH taxonomy selesai, supaya
  // durasi/verb klip native ikut terbawa.
  async function initMotionRegistry() {
    if (!haveMotionSystem || !state.model) return;
    const groups = (state.caps && state.caps.motionGroups) || [];
    const meta = {};
    const T = state.motionTaxonomy;
    if (T && T.clipMeta) {
      for (const c of Object.values(T.clipMeta)) {
        if (!c || !c.group || meta[c.group]) continue;
        meta[c.group] = {
          duration: (c.duration && c.duration > 0) ? c.duration : 2,
          tags: c.verb ? [c.verb] : [],
        };
      }
    }
    motionRegistry.registerNativeGroups(groups, meta);
    // Motion user (file motions/<modelKey>/). Nama yang bentrok dengan
    // builtin/native DITOLAK registry — konsisten dengan reservedGestureNames().
    try {
      const key = characterSheetKey().replace('live2d_sheet_', '');
      const r = await fetch(API + '/api/motions?model=' + encodeURIComponent(key));
      if (!r.ok) return;
      const data = await r.json();
      const kept = [];
      for (const a of (data.motions || [])) {
        if (!motionRegistry.has(a.id)) { kept.push(a); continue; }
        console.warn('[motion] "' + a.id + '" bentrok dengan entri bawaan — dilewati');
      }
      const n = motionRegistry.replaceUserMotions(kept);
      if (n) console.log('[motion] registry:', n, 'user motion(s) dimuat');
    } catch (e) { /* server mati / belum ada folder: registry tetap berisi builtin+native */ }
  }

  // Preset 'gerak' milik user diputar lewat runtime JUGA (satu pipeline): steps
  // dikonversi jadi asset ephemeral, di-cache berdasarkan isi steps.
  //
  // ID diberi prefiks PRESET_MOTION_PREFIX, bukan nama preset itu sendiri.
  // Dengan nama polos, memutar preset bernama sama dengan gesture bawaan atau
  // Motion Asset user akan MENIMPA entri itu di registry (source & deskripsi
  // berubah). Entri registry harus mencerminkan apa yang terdaftar, bukan apa
  // yang terakhir diputar. aiEnabled:false karena preset gerak sudah diiklankan
  // ke LLM lewat capProfile.gestures — masuk motionCatalog lagi hanya ganda.
  const PRESET_MOTION_PREFIX = 'preset_';
  const presetMotionCache = new Map();   // name -> { sig, asset }
  function playStepsViaRuntime(name, steps) {
    if (!haveMotionSystem) return false;
    const sig = JSON.stringify(steps);
    let hit = presetMotionCache.get(name);
    if (!hit || hit.sig !== sig) {
      const totalMs = steps.reduce((s, st) => s + ((st && st.ms) || 0), 0);
      const r = MotionDSL.sanitizeMotionAsset({
        id: PRESET_MOTION_PREFIX + name.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 48),
        name, source: 'builtin', type: 'gesture', aiEnabled: false,
        description: 'Preset gerak: ' + name,
        duration: Math.max(0.2, totalMs / 1000),
        tracks: MotionDSL.stepsToTracks(steps),
      }, { requireTracks: true, source: 'builtin' });
      if (!r.ok) { console.warn('[motion] preset', name, 'ditolak:', r.errors.join('; ')); return false; }
      hit = { sig, asset: r.asset };
      presetMotionCache.set(name, hit);
    }
    motionRegistry.register(hit.asset, { overwrite: true });
    return motionRuntime.play(hit.asset.id, { priority: 60 });
  }

  // Jalur lama (rantai setTimeout) — fallback kalau modul Motion gagal dimuat,
  // supaya gesture TETAP bekerja (persis kode playGesture sebelum Motion Studio).
  function legacyPlaySteps(steps) {
    const P = state.aiPose;
    const base = { ax: P.ax || 0, ay: P.ay || 0, ex: P.ex || 0, ey: P.ey || 0,
      bodyX: P.bodyX || 0, bodyY: P.bodyY || 0, bodyZ: P.bodyZ || 0, mouthForm: P.mouthForm || 0 };
    const myToken = ++gestureToken;
    let t = 0;
    for (const step of steps) {
      setTimeout(() => {
        if (myToken !== gestureToken) return;   // gesture lebih baru menimpa
        const d = step.d || {};
        for (const k in base) P[k] = base[k] + (d[k] || 0);
        state.impulse = Math.min(1.0, state.impulse + 0.22);
      }, t);
      t += step.ms;
    }
  }

  // ── Preset lookup + apply ───────────────────────────────────────
  // Name lookup ALWAYS hits presets.user before presets.ai. That is the same
  // precedence the UI shows: an AI suggestion never shadows a preset the user
  // authored under the same name, and nothing is overwritten — the two live in
  // separate branches of the sheet.
  function findPreset(name, category) {
    if (!name || typeof name !== 'string') return null;
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

  function findGerakPreset(name) { return findPreset(name, 'gerak'); }

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
    const out = new Map();   // lowercased name -> { kind, display }
    for (const k of Object.keys(GESTURE_LIBRARY)) {
      out.set(k.toLowerCase(), { kind: 'builtin', display: k });
    }
    // Native motion last so it wins the description when a model happens to name
    // a group after a builtin verb — native is what playGesture() would reach.
    for (const g of (Array.isArray(s.motionGroups) ? s.motionGroups : [])) {
      if (!g) continue;
      const disp = String(g);
      out.set(disp.toLowerCase(), { kind: 'motion', display: disp });
      out.set(('motion_' + disp).toLowerCase(), { kind: 'motion', display: 'motion_' + disp });
    }
    return out;
  }

  // Validate a candidate 'gerak' preset name. Returns a plain result object
  // rather than throwing, because the caller is a UI field that wants to show a
  // message next to the input, not an exception.
  function checkGerakName(name, sheet) {
    const clean = String(name == null ? '' : name).trim().slice(0, 60);
    if (!clean) return { ok: false, code: 'empty', message: 'Nama preset tidak boleh kosong.' };
    const hit = reservedGestureNames(sheet).get(clean.toLowerCase());
    if (hit) {
      return {
        ok: false,
        code: hit.kind === 'motion' ? 'motion-group' : 'builtin-gesture',
        conflictWith: hit.display,
        message: hit.kind === 'motion'
          ? 'Nama "' + clean + '" sudah dipakai motion bawaan model ("' + hit.display + '"). Pilih nama lain.'
          : 'Nama "' + clean + '" sudah dipakai gerakan bawaan aplikasi ("' + hit.display + '"). Pilih nama lain.',
        suggestion: suggestGerakName(clean, sheet),
      };
    }
    return { ok: true, name: clean };
  }

  // Offered alongside the rejection so the UI can present a one-click fix. The
  // user is never silently renamed — they still have to accept it.
  //
  // Dodges existing user 'gerak' preset names too, not just reserved ones: a
  // suggestion that landed on another preset's name would be accepted by
  // saveUserPreset() as an in-place edit and quietly overwrite that preset's
  // keyframes.
  function suggestGerakName(name, sheet) {
    const base = String(name == null ? '' : name).trim().slice(0, 55) || 'Gerak';
    const reserved = reservedGestureNames(sheet);
    const s = sheet || state.lastSheet || {};
    const mine = new Set(
      (((s.presets || {}).user) || [])
        .filter(p => p && p.category === 'gerak' && typeof p.name === 'string')
        .map(p => p.name.toLowerCase())
    );
    const taken = (n) => reserved.has(n.toLowerCase()) || mine.has(n.toLowerCase());
    if (!taken(base)) return base;
    for (let i = 2; i <= 99; i++) {
      const cand = base + ' ' + i;
      if (!taken(cand)) return cand;
    }
    return base + ' ' + Date.now();
  }

  // Repair pass for collisions that are ALREADY on disk. Called from
  // migrateSheet(), i.e. at the single boundary where a sheet enters the app, so
  // every downstream reader sees a collision-free gesture namespace.
  //
  // Renames rather than deletes, and records the original in `renamedFrom` so the
  // UI can explain why a button's label changed instead of it looking like data
  // loss. Only presets.user is touched: presets.ai is a suggestion cache that is
  // rebuilt from scratch, and an AI suggestion is never callable anyway.
  function deshadowGerakPresets(sheet) {
    if (!sheet || !sheet.presets || !Array.isArray(sheet.presets.user)) return sheet;
    const reserved = reservedGestureNames(sheet);
    if (!reserved.size) return sheet;
    for (const p of sheet.presets.user) {
      if (!p || p.category !== 'gerak' || typeof p.name !== 'string') continue;
      const hit = reserved.get(p.name.toLowerCase());
      if (!hit) continue;
      const from = p.name;
      p.name = suggestGerakName(from, sheet);
      p.renamedFrom = from;
      console.warn('[sheet] gerak preset "' + from + '" collided with ' +
        (hit.kind === 'motion' ? 'native motion group' : 'builtin gesture') +
        ' "' + hit.display + '" — renamed to "' + p.name + '"');
    }
    return sheet;
  }

  // Resolve the sheet to write into, creating one by inspection if this model
  // has never been inspected. Shared by every mutation below so they cannot
  // drift apart on the "no sheet yet" path.
  async function sheetForWrite() {
    let sheet = state.lastSheet || loadCharacterSheet();
    if (!sheet) sheet = await fetchSheetFile();
    if (!sheet) {
      if (!state.model) throw new Error('Load model dulu sebelum menyimpan preset.');
      sheet = inspectModel();
      if (!sheet) throw new Error('Gagal membuat character sheet.');
    }
    if (!sheet.presets) sheet.presets = { user: [], ai: [] };
    if (!Array.isArray(sheet.presets.user)) sheet.presets.user = [];
    if (!Array.isArray(sheet.presets.ai)) sheet.presets.ai = [];
    return sheet;
  }

  // Persist a mutated sheet: localStorage first (synchronous, survives a dead
  // server) then the sheet file, then drop the capability cache so the very next
  // message already sees the change. Extracted from saveUserPreset() so delete
  // and suggestion-approval write through exactly the same path — three
  // hand-rolled copies of this is how one of them ends up forgetting to
  // invalidate the cache.
  async function persistSheet(sheet) {
    sheet.schemaVersion = SHEET_SCHEMA_VERSION;
    state.lastSheet = sheet;

    let localOk = true;
    try { localStorage.setItem(characterSheetKey(), JSON.stringify(sheet)); }
    catch (e) { localOk = false; console.warn('[sheet] localStorage save failed:', e.message); }

    const res = await fetch(API + '/api/sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelName: sheet.modelName, sheet }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error((detail.error || ('server HTTP ' + res.status)) +
        (localOk ? ' (tersimpan lokal saja)' : ''));
    }
    try { window.__agent && window.__agent.invalidateCapabilityProfile && window.__agent.invalidateCapabilityProfile(); } catch (e) {}
    return sheet;
  }

  // Save (create or overwrite) a preset in presets.user. Rejects a colliding
  // 'gerak' name instead of writing it, so the shadowing case never reaches the
  // sheet at all. Overwriting the user's OWN preset of the same name is normal
  // editing and is allowed.
  async function saveUserPreset(input) {
    const p = normalizePreset(input, 'user');
    if (!p) throw new Error('Preset tidak valid (nama wajib ada).');

    const sheet = await sheetForWrite();

    if (p.category === 'gerak') {
      const verdict = checkGerakName(p.name, sheet);
      if (!verdict.ok) {
        const err = new Error(verdict.message);
        err.code = verdict.code;
        err.suggestion = verdict.suggestion;
        throw err;
      }
    }

    const list = sheet.presets.user;
    const at = list.findIndex(x => x.category === p.category && x.name.toLowerCase() === p.name.toLowerCase());
    if (at === -1) list.push(p); else list[at] = p;

    // An 'emosi' preset must reach state.supportedEmotions immediately, or the
    // just-saved emotion would not be callable until the next model load.
    projectEmotionPresets(sheet);
    await persistSheet(sheet);
    return p;
  }

  // Remove one preset from presets.user. Only the user branch is deletable: an
  // .ai entry is a suggestion cache that the next analysis rebuilds anyway, and
  // "deleting" one would silently come back.
  async function deleteUserPreset(category, name) {
    const sheet = await sheetForWrite();
    const want = String(name || '').trim().toLowerCase();
    const at = sheet.presets.user.findIndex(
      x => x.category === category && x.name.toLowerCase() === want);
    if (at === -1) return false;
    const [gone] = sheet.presets.user.splice(at, 1);
    // A deleted 'emosi' preset must also leave the advertised vocabulary,
    // otherwise the LLM keeps emitting an [EMOTION:] the engine can no longer
    // resolve. projectEmotionPresets() only ADDS, so drop it by hand here.
    if (gone.category === 'emosi') {
      if (sheet.supportedEmotions) delete sheet.supportedEmotions[gone.name];
      if (state.supportedEmotions) delete state.supportedEmotions[gone.name];
    }
    await persistSheet(sheet);
    return true;
  }

  // Promote ONE AI suggestion into presets.user. This is the only way an .ai
  // entry becomes callable, and it takes an explicit user click — that is the
  // whole point of keeping the branches apart.
  //
  // The .ai entry is left in place rather than moved: analysis output is a cache
  // keyed by name, and after promotion resolvePresets() already flags it
  // `suggestion: true` (a user entry now owns the name), so the UI stops
  // offering it without anything being deleted.
  async function applyAISuggestion(category, name) {
    const sheet = await sheetForWrite();
    const want = String(name || '').trim().toLowerCase();
    const src = sheet.presets.ai.find(
      x => x.category === category && x.name.toLowerCase() === want);
    if (!src) throw new Error('Saran AI "' + name + '" tidak ditemukan.');
    // Round-trip through saveUserPreset() so the promoted copy goes through the
    // same normalization, gerak-name check and persistence as anything the user
    // typed by hand. source is forced to 'user' by normalizePreset().
    return saveUserPreset(Object.assign({}, src, { source: 'user' }));
  }

  // Apply a preset's static values. Parameters and Parts go through DIFFERENT
  // engine calls, so they are stored and applied separately — a Part id sent
  // through setParameterValue() is a silent no-op.
  //
  // Every value is clamped to the parameter's MEASURED Cubism range at apply
  // time, and ids not present in the sheet are dropped. Neither the stored file
  // nor the LLM is trusted to have stayed in range: min/max come from the engine
  // only, exactly as in Fase 0.
  // ── Pelacak pose preset (untuk tombol Reset Pose) ──
  // Terap/Coba/agent memasang sticky override lewat applyPreset(); tanpa
  // pencatatan ini tidak ada cara membatalkannya — override guard me-re-assert
  // nilainya tiap frame sehingga pose kelihatan TERKUNCI dan idle tidak bisa
  // mengambil alih param itu lagi (keluhan user 2026-09-02). Parts dilacak
  // berpasangan dengan opacity SEBELUM diubah supaya bisa dikembalikan persis.
  const presetPoseParams = new Set();
  const presetPoseParts = new Map();   // partId → opacity sebelumnya (null = tak terbaca)

  // Lepas SEMUA pose yang dipasang preset: hapus sticky override (idle langsung
  // mengambil alih lagi dan men-ease dari nilai sekarang — tanpa snap), pulihkan
  // opacity part ke nilai semula (fallback: def dari sheet), dan padamkan
  // ekspresi/overlay. Mengembalikan jumlah target yang dilepas.
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
          .map(p => [(p && p.id) || p, typeof p.def === 'number' ? p.def : 1]));
        for (const [id, prev] of presetPoseParts) {
          const v = (prev != null && Number.isFinite(prev)) ? prev
            : (partDefs.has(id) ? partDefs.get(id) : 1);
          try { cm.setPartOpacityById(id, Math.max(0, Math.min(1, v))); released++; } catch (e) {}
        }
      } catch (e) {}
      presetPoseParts.clear();
    }
    resetEmotion();
    state.activeProperty = 'default';
    return released;
  }

  function applyPreset(nameOrPreset, category) {
    if (!state.model) return false;
    const preset = (typeof nameOrPreset === 'string')
      ? findPreset(nameOrPreset, category)
      : nameOrPreset;
    if (!preset) return false;

    if (preset.category === 'gerak') { playGesture(preset.name); return true; }

    const sheet = state.lastSheet || {};
    const byId = new Map((sheet.params || []).filter(p => p && p.id).map(p => [p.id, p]));
    const partIds = new Set((sheet.parts || []).map(p => (p && p.id) || p).filter(Boolean));

    let applied = 0;
    for (const [id, raw] of Object.entries(preset.values || {})) {
      const meta = byId.get(id);
      if (!meta) continue;                       // invented / stale id — drop
      const lo = Number.isFinite(meta.min) ? meta.min : -1;
      const hi = Number.isFinite(meta.max) ? meta.max : 1;
      setSticky(id, Math.max(lo, Math.min(hi, Number(raw))), 1);
      presetPoseParams.add(id);
      applied++;
    }
    for (const [id, raw] of Object.entries(preset.parts || {})) {
      if (!partIds.has(id)) continue;
      const v = Math.max(0, Math.min(1, Number(raw)));   // opacity is always 0..1
      try {
        const cm = state.model.internalModel.coreModel;
        if (!presetPoseParts.has(id)) {
          // Catat opacity SEBELUM diubah — dasar pemulihan Reset Pose.
          let prev = null;
          try {
            const gm = (cm && cm.getModel) ? cm.getModel() : null;
            if (gm && typeof gm.getPartOpacityById === 'function') prev = gm.getPartOpacityById(id);
          } catch (e) {}
          presetPoseParts.set(id, prev);
        }
        cm.setPartOpacityById(id, v); applied++;
      }
      catch (e) { /* part vanished with a model swap — ignore */ }
    }
    state.impulse = Math.min(1.0, state.impulse + 0.25);
    console.log('[preset] applied', preset.category + ':' + preset.name,
      '(' + applied + ' targets, source=' + preset.source + ')');
    return applied > 0;
  }

  // Make user-authored 'emosi' presets visible to the EXISTING emotion engine.
  // applyExpression() gates on state.supportedEmotions.hasOwnProperty(name) and
  // getExpressibleEmotions() builds the LLM's vocabulary from the same map, so
  // projecting here is all that is needed — no change to either function.
  //
  // Only .user is projected: an AI suggestion must not become an advertised
  // capability before the user saves it.
  function projectEmotionPresets(sheet) {
    if (!sheet || !sheet.presets) return;
    if (!sheet.supportedEmotions || typeof sheet.supportedEmotions !== 'object' ||
        Array.isArray(sheet.supportedEmotions)) sheet.supportedEmotions = {};
    // Builtin role-derived emotions go in FIRST so a user preset of the same name
    // overwrites them below — the documented user > builtin precedence. These are
    // recomputed per model load (never read back from the sheet), so a sheet
    // written for another character cannot inject its parameter ids here.
    const builtin = state.roleEmotions || {};
    // Drop any stale builtin entry BEFORE re-adding. A sheet may have been saved
    // while another model was loaded, so it can carry emotion names resolved
    // against a different rig's parameter ids. Names the CURRENT model cannot
    // express must disappear rather than linger as dead vocabulary the LLM is
    // told about. User presets are untouched — they are authored data, not cache.
    const userNames = new Set((sheet.presets.user || [])
      .filter(p => p.category === 'emosi').map(p => p.name));
    for (const name in EMOTION_ROLE_TEMPLATES) {
      if (!userNames.has(name)) delete sheet.supportedEmotions[name];
      if (state.supportedEmotions && !userNames.has(name)) delete state.supportedEmotions[name];
    }
    for (const name in builtin) sheet.supportedEmotions[name] = builtin[name];
    for (const p of (sheet.presets.user || [])) {
      if (p.category !== 'emosi') continue;
      sheet.supportedEmotions[p.name] = p.values || {};
    }
    if (state.supportedEmotions) {
      Object.assign(state.supportedEmotions, sheet.supportedEmotions);
    }
  }

  let gestureToken = 0;
  // Native motion group → MotionManager model. Diekstrak jadi fungsi supaya
  // cabang native di playGesture() tetap pendek: urutan resolusinya adalah
  // invariant yang diuji, jadi jangan ditumpuk logika di dalam blok itu.
  function playNativeGroup(g) {
    if (haveMotionSystem && motionRuntime.play('motion_' + g, { priority: 90 })) return;
    try {
      state.model.motion(g, -1, 2);
      state.impulse = Math.min(1.0, state.impulse + 0.3);
    } catch (e) { console.warn('[Live2D] Failed to play native motion:', e); }
  }

  // ── Resolusi gesture (urutan TIDAK berubah — lihat reservedGestureNames): ──
  //   native motion group → user 'gerak' preset → registry (builtin + Motion
  //   Studio user motions) → tabel literal. Yang baru hanyalah SEMUA jalur
  //   keyframe kini lewat Motion Runtime (satu pipeline, SPEC §31); perilaku
  //   publik playGesture("nama") identik.
  function playGesture(name) {
    if (!state.model || !name) return;

    // 1) Native motion group (nama grup polos ATAU id berprefiks motion_).
    if (typeof name === 'string') {
      const g = name.replace(/^motion_/, '');
      if (state.caps && state.caps.motionGroups && state.caps.motionGroups.includes(g)) {
        playNativeGroup(g);
        return;
      }
    }

    // 2) User 'gerak' preset, lalu 3) registry/builtin. sanitizeSteps() tetap
    //    dijalankan DI SINI saat apply — sheets/*.json bisa di-edit tangan
    //    setelah disimpan, jadi cek di jalur simpan saja mudah dilewati.
    const preset = findGerakPreset(name);
    const steps = preset ? sanitizeSteps(preset.steps) : GESTURE_LIBRARY[name];
    if (steps && steps.length) {
      // Gesture bawaan sudah terdaftar di registry (dikonversi ke keyframe saat
      // init), jadi diputar langsung dari sana — tidak perlu asset ephemeral.
      // Preset user tidak ada di registry, jadi dibungkus dulu.
      if (!preset && haveMotionSystem && motionRegistry.has(name)) {
        if (motionRuntime.play(name, { priority: 60 })) return;
      }
      if (!(haveMotionSystem && playStepsViaRuntime(name, steps))) legacyPlaySteps(steps);
      return;
    }

    // 4) Motion Asset buatan user dari Motion Studio (tak punya bentuk steps).
    if (haveMotionSystem && motionRegistry.has(name)) motionRuntime.play(name, { priority: 60 });
  }

  // ── Raw parameter drive (Motion Studio) ────────────────────────
  // Ditulis SETELAH applyOverrides() di setiap frame, jadi ini penulis terakhir
  // dan menang atas semua jalur lain (idle fidget, emosi, sticky overrides).
  //
  // Ini yang membuat preview realtime bekerja. Menulis sekali saat slider
  // digeser TIDAK cukup: pixi-live2d menjalankan internalModel.update()
  // (physics/motion/expression/eyeBlink/focus/breath) di dalam render PIXI-nya
  // sendiri, yang jalan SEBELUM rAF tick kita — jadi tulisan satu kali langsung
  // ditimpa pada frame berikutnya. Nilai harus di-assert ulang tiap frame.
  //
  // DUA penggerak, sengaja: rAF tick untuk mempertahankan nilai, dan pemanggilan
  // langsung dari setRawDrive() supaya efeknya seketika bahkan ketika rAF
  // sedang tidak berjalan (tab background / webview tanpa compositing).
  //
  // Nilai di-clamp ke range asli parameter dari Cubism (state.paramRange) bila
  // tersedia. paramRange hanya terisi setelah model di-inspeksi; kalau kosong,
  // nilai ditulis apa adanya dan Cubism sendiri yang meng-clamp — jauh lebih
  // baik daripada menolak menulis dan membuat editor terlihat mati.
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
      try { cm.setParameterValueById(id, v, 1); } catch (e) {}
    }
    state._rawDriveLast = wrote;
  }

  // Set/hapus nilai raw. `patch` = { paramId: number|null }; null menghapus
  // param itu dari drive (kembali ke kendali normal), sedangkan clearRawDrive()
  // melepas SEMUANYA sekaligus saat editor ditutup.
  //
  // Nilai ditulis LANGSUNG di sini, tidak menunggu frame berikutnya — pola yang
  // sama dengan setSticky(). Dua alasan, keduanya nyata:
  //   1. Menunggu rAF menambah jeda sampai 16ms pada setiap gerakan slider;
  //      untuk "live edit" itu terasa seperti lag.
  //   2. rAF BISA mati total (tab background, jendela tersembunyi, webview yang
  //      tidak meng-compositing). Tanpa penulisan langsung, menggeser slider
  //      pada kondisi itu tidak menghasilkan apa pun sama sekali dan editor
  //      terlihat rusak. Loop per-frame tetap diperlukan untuk MEMPERTAHANKAN
  //      nilai melawan internalModel.update(); penulisan langsung memastikan
  //      efeknya terjadi seketika.
  function setRawDrive(patch) {
    if (!patch || typeof patch !== 'object') return;
    if (!state.rawDrive) state.rawDrive = {};
    if (!state.rawDrivePrev) state.rawDrivePrev = {};
    for (const id in patch) {
      const v = patch[id];
      if (v == null) {
        // Dilepas: pulihkan nilai sebelum drive menyentuhnya. Parameter yang
        // tidak dikemudikan sistem lain tidak akan pernah kembali sendiri.
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
    // Pulihkan semua parameter yang pernah dikemudikan, lalu buang state-nya.
    const prev = state.rawDrivePrev;
    if (prev) {
      const cm = coreModel();
      for (const id in prev) {
        try { if (cm) cm.setParameterValueById(id, prev[id], 1); } catch (e) {}
      }
    }
    state.rawDrive = null;
    state.rawDrivePrev = null;
  }

  // Daftar parameter LENGKAP milik model yang sedang dimuat, langsung dari
  // Cubism Core — bukan 8 peran semantik. Inilah sumber track Motion Studio.
  //
  // Sheet dipakai lebih dulu karena di sana ada label + kategori hasil
  // inspeksi/anotasi user; kalau sheet belum ada, enumerasi langsung dari core
  // supaya editor tetap bisa dipakai tanpa menunggu Inspeksi Model.
  function listModelParams() {
    const sheet = state.lastSheet;
    if (sheet && Array.isArray(sheet.params) && sheet.params.length) {
      return sheet.params.map(p => ({
        id: p.id,
        label: p.label || p.id,
        group: resolveParamGroup(sheet, p.id, p.group),
        min: Number(p.min), max: Number(p.max), def: Number(p.def),
        userNote: p.userNote || '',
        estimated: !!p.estimated,
      })).filter(p => Number.isFinite(p.min) && Number.isFinite(p.max));
    }
    const out = [];
    const cm = coreModel();
    if (!cm) return out;
    // Jalur langsung ke Cubism Core. Objek yang dipegang pixi-live2d adalah
    // CubismModel, yang TIDAK punya getParameterIds() — daftar id hidup di
    // typed array `parameters` milik model native di bawahnya. Ini jalur yang
    // sama dengan inspectModel(); memakai nama method yang salah membuat
    // fungsi ini mengembalikan array kosong secara senyap dan panel parameter
    // Motion Studio terlihat "tidak punya parameter apa pun".
    try {
      const gm = cm.getModel ? cm.getModel() : cm;
      const P = gm && gm.parameters;
      if (P && P.ids && P.ids.length) {
        for (let i = 0; i < P.ids.length; i++) {
          const id = P.ids[i];
          if (!id) continue;
          out.push({
            id, label: id, group: 'Lainnya',
            min: Number(P.minimumValues[i]), max: Number(P.maximumValues[i]),
            def: Number(P.defaultValues[i]),
            userNote: '', estimated: false,
          });
        }
      } else if (typeof gm.getParameterCount === 'function' && typeof gm.getParameterIds === 'function') {
        // Wrapper yang memang menyediakan accessor (versi runtime lain).
        const ids = gm.getParameterIds();
        const mins = gm.getParameterMinimumValues();
        const maxs = gm.getParameterMaximumValues();
        const defs = gm.getParameterDefaultValues();
        for (let i = 0; i < gm.getParameterCount(); i++) {
          const id = ids[i];
          if (!id) continue;
          out.push({
            id, label: id, group: 'Lainnya',
            min: Number(mins[i]), max: Number(maxs[i]), def: Number(defs[i]),
            userNote: '', estimated: false,
          });
        }
      }
    } catch (e) { console.warn('[params] enumerasi langsung gagal:', e.message); }
    return out.filter(p => Number.isFinite(p.min) && Number.isFinite(p.max));
  }

  window.__live2dAgent = {
    speak,
    setExpression: applyExpression,
    // [ACC:...] now carries either a raw paramId (as always) OR the name of a
    // user 'aksesoris' preset, because those names are advertised in
    // capProfile.accessories. Preset lookup goes FIRST so a user preset named
    // after a paramId still wins; unknown names fall through to the original
    // toggle, so existing behaviour is unchanged.
    setAccessory: (paramIdOrName, val) => {
      const preset = findPreset(paramIdOrName, 'aksesoris');
      if (preset) return applyPreset(preset);
      return toggleAccessory(paramIdOrName, val);
    },
    applyPreset,
    findPreset,
    setParameter: (id, v) => { setSticky(id, v, 1); },
    // Parts use a DIFFERENT engine call (setPartOpacityById), so expose it
    // separately — merging the two would make a part-id a silent no-op.
    setPartOpacity: (id, v) => {
      const cm = coreModel();
      if (!cm) return;
      const val = Number(v);
      if (!Number.isFinite(val)) return;
      const clamped = Math.max(0, Math.min(1, val));
      state.overrides[id] = clamped;
      try { cm.setPartOpacityById(id, clamped); } catch (e) {}
    },
    isReady: () => !!state.model,
    getMouth: () => { const mId = roleId('mouthOpenY'); return (mId && state.overrides[mId] != null ? state.overrides[mId] : state.mouthRest); },
    frameModel,
    zoom: setScaleAroundCenter,
    _getSupportedEmotions: () => state.supportedEmotions || {},
    // Emosi mana yang model INI benar-benar bisa sampaikan, diurutkan dari cara
    // yang paling ekspresif. Tiga sumber, semuanya diukur dari model — bukan
    // daftar nama karakter tertentu:
    //   1. supportedEmotions — preset param wajah (hasil scan)
    //   2. nativeExpressions — file .exp3 milik rigger
    //   3. taksonomi motion  — verb klip yang benar-benar ada (dari kurva)
    // Dipakai agent.js supaya reaksi event memilih dari kemampuan nyata,
    // bukan menulis nama emosi secara literal.
    getExpressibleEmotions: () => {
      const out = {};
      const add = (name, via) => { if (name && !out[name]) out[name] = via; };
      for (const k of Object.keys(state.supportedEmotions || {})) add(k, 'param');
      for (const n of (state.modelExpressions || [])) add(n, 'native');
      const T = state.motionTaxonomy;
      if (T && T.byVerb && typeof MotionTaxonomy !== 'undefined') {
        const EV = MotionTaxonomy.EMOTION_VERBS || {};
        for (const emo of Object.keys(EV)) {
          if (emo === 'normal') continue;
          const hasClip = EV[emo].some(v => (T.byVerb[v] || []).length > 0);
          if (hasClip) add(emo, 'clip');
        }
      }
      return out;
    },
    // Sampaikan emosi lewat jalur terbaik yang tersedia. applyExpression() sendiri
    // tidak melakukan apa pun untuk nama yang bukan preset param dan bukan .exp3
    // — pada kedua model bundled itu berarti SETIAP reaksi jadi no-op senyap.
    // Di sini klip motion dipakai sebagai jalur terakhir supaya tubuh tetap
    // bereaksi walau wajahnya tak punya preset.
    expressEmotion: (name) => {
      if (!state.model || !name) return null;
      const via = window.__live2dAgent.getExpressibleEmotions()[name];
      if (!via) return null;
      if (via === 'param' || via === 'native') { applyExpression(name); return via; }
      return playEmotionClip(name) ? 'clip' : null;
    },
    // ── AI Lock: pause user interaction while AI controls the character ──
    lockAI: () => {
      state.aiLock = true;
      state.fidgetT = 0;                       // restart fidget clock each turn
      state.fidgetSeed = Math.random() * 1000;  // fresh flavour every reply
      // Re-center the AI pose target on where the character currently is, so
      // the first eased frame doesn't yank it back to neutral. Only read body
      // params that the model actually owns (otherwise 0 — no body lean).
      const readSafe = (id) => state.caps.params && state.caps.params.has(id) ? readParam(id) : 0;
      state.aiPose = {
        ax: readParam(roleId('angleX') || 'ParamAngleX'), ay: readParam(roleId('angleY') || 'ParamAngleY'),
        ex: readParam(roleId('eyeBallX') || 'ParamEyeBallX'), ey: readParam(roleId('eyeBallY') || 'ParamEyeBallY'),
        mouthForm: readParam(roleId('mouthForm') || 'ParamMouthForm'),
        bodyX: readSafe(roleId('bodyAngleX') || 'ParamBodyAngleX'),
        bodyY: readSafe(roleId('bodyAngleY') || 'ParamBodyAngleY'),
        bodyZ: readSafe(roleId('bodyAngleZ') || 'ParamBodyAngleZ'), breath: 0.45,
      };
      // Kick off the micro-gesture scheduler for that "always alive" feel.
      startGestureScheduler();
      console.log('[Live2D] AI lock ON — user interaction paused');
    },
    unlockAI: () => {
      state.aiLock = false;
      // Stop the AI micro-gesture scheduler; user is back in control.
      stopGestureScheduler();
      // Reset head/eye look targets back to neutral
      state.look.tax = state.look.tay = 0;
      state.look.tex = state.look.tey = 0;
      // Clear all AI-set emotion params, restore neutral
      resetEmotion();
      console.log('[Live2D] AI lock OFF — user control restored');
    },
    // ── Set the AI pose TARGET (eased by the engine, not snapped) ──
    // Called by the agent layer per dialog segment. Values are the EXPLICIT
    // pose the character should ease toward; the engine adds ambient fidget.
    // head {x,y}, eyes {x,y}, mouth {form}, body {x,y,z} (all optional).
    setAIPose: (pose) => {
      if (!pose || typeof pose !== 'object') return;
      const P = state.aiPose;
      if (pose.head) { if (pose.head.x != null) P.ax = pose.head.x; if (pose.head.y != null) P.ay = pose.head.y; }
      if (pose.eyes) { if (pose.eyes.x != null) P.ex = pose.eyes.x; if (pose.eyes.y != null) P.ey = pose.eyes.y; }
      if (pose.mouth) { if (pose.mouth.form != null) P.mouthForm = pose.mouth.form; }
      if (pose.body) {
        if (pose.body.x != null) P.bodyX = pose.body.x;
        if (pose.body.y != null) P.bodyY = pose.body.y;
        if (pose.body.z != null) P.bodyZ = pose.body.z;
      }
      // Fire a gentle "pop" — she bounces/lurches with life at the start of each
      // clause/gesture, like a VTuber reacting. Decays over ~1s in the ticker.
      // Kept small so streaming many per-clause poses stays smooth, not jittery.
      state.impulse = Math.min(1.0, state.impulse + 0.3);
      state.energyBoost = Math.min(0.9, state.energyBoost + 0.22);
    },
    // ── Play a named gesture ("gesture verb") — see GESTURE_LIBRARY above.
    playGesture,
    gestureNames: () => Object.keys(GESTURE_LIBRARY),
    // ── Motion Studio runtime surface ──
    // playMotion menerima ID APAPUN dari registry (builtin / motion_<group> /
    // Motion Asset user) dan mengembalikan false bila ditolak scheduler
    // (prioritas lebih rendah / cooldown LLM). Dipakai agent.js (Phase 5) dan
    // editor (Phase 3) — satu pintu pemutaran, bukan jalur kedua.
    playMotion: (id, opts) => (haveMotionSystem ? motionRuntime.play(id, opts) : false),
    stopMotion: (id) => (haveMotionSystem ? motionRuntime.stop(id) : false),
    stopAllMotions: () => { if (haveMotionSystem) motionRuntime.stopAll(); },
    getActiveMotion: () => (haveMotionSystem ? motionRuntime.getActive() : null),
    // Editor (Phase 3) mendaftarkan/menghapus Motion Asset milik user secara
    // live — registry adalah cache; file tetap disimpan lewat /api/motions.
    registerUserMotion: (asset) => {
      if (!haveMotionSystem) return { ok: false, error: 'modul motion tidak termuat' };
      const r = MotionDSL.sanitizeMotionAsset(asset, { requireTracks: true, source: 'user' });
      if (!r.ok) return { ok: false, error: r.errors.join('; ') };
      if (motionRegistry.has(r.asset.id)) {
        const prev = motionRegistry.get(r.asset.id);
        if (prev.source !== 'user') return { ok: false, error: 'nama "' + r.asset.id + '" dipakai entri ' + prev.source };
      }
      motionRegistry.register(r.asset, { overwrite: true });
      return { ok: true, asset: r.asset };
    },
    removeUserMotion: (id) => (haveMotionSystem ? motionRegistry.remove(id, 'user') : false),
    listRegistryMotions: () => (haveMotionSystem ? motionRegistry.list() : []),
    // Kunci model aktif — dipakai Motion Studio sebagai ?model= pada /api/motions,
    // sehingga penamaan file motion konsisten dengan sheets/.
    modelKey: currentModelKey,
    // Freeze yang SAMA dengan editor preset (bukan mekanisme kedua). persistent
    // = tahan sampai unfreeze eksplisit, tanpa auto-resume 10 detik.
    freezeForEdit: (statusEl, persistent) => { if (editorFreezeApi) editorFreezeApi.freeze(statusEl, persistent); },
    unfreezeForEdit: () => { if (editorFreezeApi) editorFreezeApi.unfreeze(); },
    // Peran semantik → parameter asli model, untuk Mode Lanjutan Motion Studio.
    roleIdFor: (role) => roleId(role),
    // ── Raw parameter drive (Motion Studio) ──
    // setRawDrive({ ParamAngleX: 12 }) menahan nilai itu SETIAP frame sampai
    // dihapus, jadi preview benar-benar realtime meski internalModel.update()
    // menimpa parameter di antara frame. null = lepas param itu.
    setRawDrive,
    clearRawDrive,
    // Debug/QA: baca nilai raw drive yang sedang berlaku tanpa memberi akses
    // tulis ke state internal.
    _rawDrive: () => ({
      values: state.rawDrive ? Object.assign({}, state.rawDrive) : null,
      ticks: state._rawDriveTicks || 0,
      tickCount: state._tickCount || 0,
      hasCore: !!coreModel(),
      lastWrite: state._rawDriveLast || null,
      rangeCount: state.paramRange ? Object.keys(state.paramRange).length : 0,
      range: state.rawDrive ? Object.keys(state.rawDrive).map(id => ({ id, r: state.paramRange && state.paramRange[id] })) : [],
    }),
    // Daftar parameter LENGKAP model ini (id, label, kategori, min/max/def).
    listModelParams,
    // Nilai parameter saat ini — dipakai editor untuk menyeed nilai keyframe
    // baru dari pose yang sedang terlihat.
    readParameter: (id) => readParam(id),
    // ── Capability profile: describes what this model can do ──
    getCapabilityProfile,

    // ── Character sheet surface ────────────────────────────────
    // The sheet editor UI (tab 📋 Sheet) is wired inside this same IIFE, so it
    // does not strictly need these. They are exposed because the sheet is the
    // model's semantic contract and everything outside app.js — agent.js, the
    // console, tests, any future panel — has to reach it through one door
    // instead of re-implementing precedence or the localStorage+file write.
    //
    // Namespaced under .sheet rather than flattened into this object: names like
    // `save`/`remove` are far too generic at the top level of a public API that
    // already carries speak/playGesture/frameModel.
    sheet: {
      // read
      load: loadCharacterSheet,
      fetchFile: fetchSheetFile,
      inspect: inspectModel,
      resolvePresets,
      resolveParamGroup,
      findPreset,
      categories: () => PRESET_CATEGORIES.slice(),
      builtinGestures: () => Object.keys(GESTURE_LIBRARY),
      // validate — returns a verdict object instead of throwing, because the
      // caller is a text field that has to render the message + suggestion.
      checkGerakName,
      suggestGerakName,
      // write
      savePreset: saveUserPreset,
      deletePreset: deleteUserPreset,
      applySuggestion: applyAISuggestion,
      applyPreset,
      saveNote: saveUserNote,
      // Per-parameter description (params[i].userNote) — AUTHORITATIVE user
      // context fed into the LLM prompt so it understands each param's meaning.
      saveParamNote,
      getParamNote,
      saveConfig: saveModelConfig,
      // AI classification of raw params (writes paramGroups.ai only)
      classifyParams: triggerAIParamClassification,
      // AI-suggested presets (writes presets.ai only, never .user)
      analyzePresets: analyzeSheetPresets,
    },
  };

  // ─── Character Sheet System ───
  // Deep-inspect a model once, save the profile to localStorage, and reuse
  // it for all future AI interactions — no hardcoding needed.

  // Identity of the currently loaded model, used to name its character sheet
  // (localStorage key AND sheets/<key>.json on the server).
  //
  // This was referenced in two places but never defined — a ReferenceError that
  // rejected getCapabilityProfile(), which in turn killed agent.think() BEFORE
  // it ever reached fetch(). Result: typing a message produced no request, no
  // reply and no error, and left the agent's `busy` flag stuck true forever.
  //
  // Derived from the model PATH (not a display name) so two models sharing a
  // folder name can't collide. The sanitizer mirrors sanitizeKey() in
  // server.js exactly, so the browser and the server agree on the filename:
  //   model/神宫白子/面饼0.model3.json -> model_神宫白子_面饼0_model3_json
  // which is the sheet already present in sheets/ — existing sheets keep working.
  function currentModelKey() {
    const p = state.modelPath || 'default';
    return p.replace(/[^A-Za-z0-9_\u4e00-\u9fff]/g, '_');
  }

  function characterSheetKey() { return 'live2d_sheet_' + currentModelKey(); }

  // SHEET_SCHEMA_VERSION, USER_AUTHORED_FIELDS, MODEL_CONFIG_DEFAULTS,
  // FRAMING_MODES and the TTS ranges are declared in the block above the Boot
  // call. They belong logically here with the sheet code, but boot-time code
  // (wireUI -> refreshConfigForm -> loadModelConfigLocal) reads them
  // synchronously, and `const` in a temporal dead zone throws if declared this
  // far down. Do not re-declare them here.

  function normalizeModelConfig(raw) {
    const c = Object.assign({}, MODEL_CONFIG_DEFAULTS);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c;
    if (typeof raw.blink === 'boolean') c.blink = raw.blink;
    if (typeof raw.idle === 'boolean') c.idle = raw.idle;
    if (FRAMING_MODES.indexOf(raw.framing) !== -1) c.framing = raw.framing;
    // Number(): a persisted "1.4" from a form field must not poison the math.
    const r = Number(raw.ttsRate);
    if (Number.isFinite(r)) c.ttsRate = clamp(r, TTS_RATE_RANGE.min, TTS_RATE_RANGE.max);
    const p = Number(raw.ttsPitch);
    if (Number.isFinite(p)) c.ttsPitch = clamp(p, TTS_PITCH_RANGE.min, TTS_PITCH_RANGE.max);
    if (typeof raw.ttsLang === 'string' && /^[a-zA-Z]{2}(-[a-zA-Z0-9]{2,8})*$/.test(raw.ttsLang)) {
      c.ttsLang = raw.ttsLang;
    }
    // Control chars stripped: this string is written into the document title and
    // chat header. textContent handles markup, but a stray \u0000 or newline in a
    // title is just corruption.
    if (typeof raw.displayName === 'string') {
      c.displayName = raw.displayName.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 40);
    }
    return c;
  }

  // ── Preset sanitisation ─────────────────────────────────────────
  // Applied AT APPLY TIME, not at save time. sheets/*.json is a plain file the
  // user can edit by hand after saving, so a save-path-only check is trivially
  // bypassed — same reasoning as clamping param values to the Cubism range at
  // apply rather than trusting what is stored.
  function sanitizeSteps(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    let total = 0;
    for (const step of raw) {
      if (out.length >= STEP_COUNT_MAX) break;
      if (!step || typeof step !== 'object') continue;
      const d = {};
      const src = (step.d && typeof step.d === 'object') ? step.d : {};
      for (const k in STEP_FIELD_BOUNDS) {
        const n = Number(src[k]);
        // Unknown keys are never copied: `for k in STEP_FIELD_BOUNDS` iterates
        // the WHITELIST, not the input. A raw paramId in `d` simply vanishes.
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

  // One preset entry. `source` is forced by the CALLER (the save path decides
  // whether it is writing the .user or the .ai branch) — never read from the
  // stored object, or a hand-edited file could promote an AI suggestion into a
  // user-authored preset and win the precedence rule.
  function normalizePreset(raw, source) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = String(raw.name == null ? '' : raw.name).trim().slice(0, 60);
    if (!name) return null;
    const category = PRESET_CATEGORIES.indexOf(raw.category) !== -1 ? raw.category : 'properti';
    const num = (obj) => {
      const o = {};
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return o;
      for (const k of Object.keys(obj)) {
        const n = Number(obj[k]);
        if (typeof k === 'string' && k && Number.isFinite(n)) o[k] = n;
      }
      return o;
    };
    const p = {
      name,
      category,
      // Parameters (setParameterValue) and Parts (setPartOpacity) are driven by
      // DIFFERENT engine calls, so they cannot share one map — a value meant for
      // a Part, applied as a Parameter, is a silent no-op.
      values: num(raw.values),
      parts: num(raw.parts),
      source: source === 'ai' ? 'ai' : 'user',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    };
    // Timed keyframes only make sense for 'gerak'. A frozen {paramId: value}
    // map is a pose, not a motion.
    if (category === 'gerak') p.steps = sanitizeSteps(raw.steps);
    // Provenance of an automatic de-shadow rename. Preserved through
    // normalization so the note survives a save/load round-trip and the UI can
    // keep explaining the changed label; purely informational, never used for
    // lookup.
    if (typeof raw.renamedFrom === 'string' && raw.renamedFrom.trim()) {
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
      // Within ONE branch a name is unique (last write wins). Across branches it
      // is not: presets.user and presets.ai may both hold "Senang", and that is
      // exactly the case the precedence rule exists for.
      const key = p.category + '\u0000' + p.name.toLowerCase();
      if (seen.has(key)) out.splice(out.findIndex(x => x.category + '\u0000' + x.name.toLowerCase() === key), 1);
      seen.add(key);
      out.push(p);
    }
    return out;
  }

  function normalizePresets(raw) {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return { user: normalizePresetList(r.user, 'user'), ai: normalizePresetList(r.ai, 'ai') };
  }

  // paramId -> group label. Categorisation only; carries no values.
  function normalizeGroupMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const k of Object.keys(raw)) {
      const label = String(raw[k] == null ? '' : raw[k]).trim().slice(0, 40);
      if (k && label) out[k] = label;
    }
    return out;
  }

  function normalizeParamGroups(raw) {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return { user: normalizeGroupMap(r.user), ai: normalizeGroupMap(r.ai) };
  }

  // Resolution for a single parameter: user wins over AI, AI wins over the
  // heuristic already computed by inspectModel(). Per-parameter, not
  // whole-sheet — so moving one slider by hand does not freeze the rest of the
  // sheet against future AI suggestions.
  function resolveParamGroup(sheet, paramId, heuristic) {
    const g = (sheet && sheet.paramGroups) || {};
    return (g.user && g.user[paramId]) || (g.ai && g.ai[paramId]) || heuristic || 'Kustom';
  }

  // Presets to SHOW/INVOKE for a category. User entries first; an AI entry whose
  // name collides with a user entry is kept but flagged `suggestion` so the UI
  // can badge it — it never replaces the user's button, and lookup-by-name hits
  // the user's copy first.
  function resolvePresets(sheet, category) {
    const P = (sheet && sheet.presets) || {};
    // Each entry is tagged with `source` so the UI can decide between a live
    // "Terap" (user) and a "Pakai" (AI suggestion) action — paintPresetList()
    // branches on `p.source === 'ai'`. Without this tag EVERY preset renders as
    // a user preset (👤 + Terap/Edit/Hapus) and AI suggestions can never be
    // approved from the UI, silently defeating the whole user>ai workflow.
    const users = (P.user || [])
      .filter(p => !category || p.category === category)
      .map(p => Object.assign({}, p, { source: 'user' }));
    const taken = new Set(users.map(p => p.name.toLowerCase()));
    const ais = (P.ai || [])
      .filter(p => !category || p.category === category)
      .map(p => Object.assign({}, p, { source: 'ai', suggestion: taken.has(p.name.toLowerCase()) }));
    return users.concat(ais);
  }

  function migrateSheet(sheet) {
    if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return null;
    const v = Number(sheet.schemaVersion) || 0;
    if (v > SHEET_SCHEMA_VERSION) {
      // A sheet written by a NEWER build. Don't rewrite it — we'd strip fields we
      // don't know about. Use it as-is and say so.
      console.warn('[sheet] schemaVersion', v, '> supported', SHEET_SCHEMA_VERSION,
        '— using as-is, not migrating');
      return sheet;
    }
    if (v < 1) {
      // v0 -> v1: no destructive change, just establish the new fields.
      if (typeof sheet.userNote !== 'string') sheet.userNote = '';
      sheet.schemaVersion = 1;
      console.log('[sheet] migrated v0 -> v1 for', sheet.modelName || '(unnamed)');
    }
    if (v < 2) {
      // v1 -> v2: establish config{} from defaults. Non-destructive; a v1 sheet
      // simply had no per-model preferences, so defaults are exactly right.
      sheet.config = normalizeModelConfig(sheet.config);
      sheet.schemaVersion = 2;
      console.log('[sheet] migrated v1 -> v2 for', sheet.modelName || '(unnamed)');
    }
    if (v < 3) {
      // v2 -> v3: every sheet written before v3 came out of the broken
      // enumeration path — inspectModel() called the wrapper's accessor methods
      // on the raw core object, which throws, so rawParams was always empty and
      // the ranges were ALWAYS the PARAM_META/neutral guesses. Those sheets
      // carry no estimated flag, so they currently claim to be measured.
      //
      // We cannot recover the real ranges here (no engine at migration time), so
      // we do the only honest thing: relabel them as estimated and ask for a
      // re-inspect. Verified against the live engine before writing this: 18% of
      // lumine's ranges and 57% of 神宫白子's were wrong.
      if (!sheet.rangeSource) {
        sheet.rangesEstimated = true;
        sheet.rangeSource = 'estimated-legacy';
        sheet.needsReinspect = true;
        if (Array.isArray(sheet.params)) {
          for (const p of sheet.params) {
            if (!p || typeof p !== 'object') continue;
            p.estimated = true;
            p.estimateSource = p.estimateSource || 'legacy-unmeasured';
          }
        }
        if (sheet.paramRange && typeof sheet.paramRange === 'object') {
          for (const k in sheet.paramRange) {
            if (sheet.paramRange[k] && typeof sheet.paramRange[k] === 'object') {
              sheet.paramRange[k].estimated = true;
            }
          }
        }
        console.warn('[sheet] ' + (sheet.modelName || '(unnamed)') + ': pre-v3 sheet — ranges ' +
          'were never measured from Cubism. Flagged as estimated; re-inspect to get real ranges.');
      }
      sheet.schemaVersion = 3;
      console.log('[sheet] migrated v2 -> v3 for', sheet.modelName || '(unnamed)');
    }
    if (v < 4) {
      // v3 -> v4: establish per-parameter userNote, paramGroups and presets.
      // Purely additive — a v3 sheet simply had none of them, so empty is
      // exactly right. Nothing existing is read or rewritten here, which is why
      // this migration cannot lose data the way v2->v3 had to warn about.
      sheet.schemaVersion = 4;
      console.log('[sheet] migrated v3 -> v4 for', sheet.modelName || '(unnamed)');
    }
    // Defensive normalization that every reader below relies on. Legacy sheets
    // in the wild are missing some of these entirely.
    if (typeof sheet.userNote !== 'string') sheet.userNote = '';
    // Always re-normalize: a hand-edited sheets/*.json could carry an out-of-range
    // pitch or a bogus framing mode, and those flow straight into the TTS engine.
    sheet.config = normalizeModelConfig(sheet.config);
    if (!Array.isArray(sheet.params)) sheet.params = [];
    // Per-parameter user note. Normalized here, in the one place a sheet enters
    // the app, so no renderer has to distinguish "no note" from "predates v4".
    for (const p of sheet.params) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.userNote !== 'string') p.userNote = '';
      else if (p.userNote.length > 300) p.userNote = p.userNote.slice(0, 300);
    }
    // Always re-normalize both structures, for the same reason config is
    // re-normalized above: these are user-editable files, and presets feed the
    // engine directly.
    sheet.paramGroups = normalizeParamGroups(sheet.paramGroups);
    sheet.presets = normalizePresets(sheet.presets);
    if (!Array.isArray(sheet.parts)) sheet.parts = [];
    if (!Array.isArray(sheet.accessories)) sheet.accessories = [];
    if (!Array.isArray(sheet.nativeExpressions)) sheet.nativeExpressions = [];
    if (!Array.isArray(sheet.motionGroups)) sheet.motionGroups = [];
    // Collisions can still ARRIVE on disk even though saveUserPreset() rejects
    // them: the file is hand-editable, and a model can gain a motion group after
    // the preset was saved (re-export from Cubism, or the preset was written
    // before this check existed). Doing nothing here would restore the exact
    // silent shadowing we set out to remove, so an already-stored collision is
    // renamed on load and logged loudly. Renaming beats dropping — the user's
    // keyframes survive and stay callable, just under a distinct name.
    deshadowGerakPresets(sheet);
    // `typeof [] === 'object'`, so an array slips through a plain typeof check and
    // then behaves like an empty map for the rest of its life: hasOwnProperty()
    // is always false on it, which is precisely how supportedEmotions could sit
    // as `[]` while every [EMOTION:...] silently failed. These four are all
    // keyed maps, so an array is always corrupt input — reset it.
    const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    sheet.roleIds = asMap(sheet.roleIds);
    sheet.paramRange = asMap(sheet.paramRange);
    sheet.supportedEmotions = asMap(sheet.supportedEmotions);
    sheet.controls = asMap(sheet.controls);
    sheet.schemaVersion = SHEET_SCHEMA_VERSION;
    return sheet;
  }

  // Read whatever sheet is currently persisted for this model, WITHOUT touching
  // the network — used to carry user-authored fields across a re-inspection.
  function existingUserFields() {
    const carried = {};
    let prev = null;
    try {
      const raw = localStorage.getItem(characterSheetKey());
      if (raw) prev = JSON.parse(raw);
    } catch (e) {}
    if (!prev && state.lastFileSheet) prev = state.lastFileSheet;   // file = sumber user paling awal
    if (!prev && state.lastSheet) prev = state.lastSheet;
    if (!prev) return carried;
    for (const f of USER_AUTHORED_FIELDS) {
      if (prev[f] !== undefined && prev[f] !== null && prev[f] !== '') carried[f] = prev[f];
    }
    // Re-normalize a carried config: the previous sheet may predate a field or
    // have been hand-edited, and this value is about to become the live config.
    if (carried.config) carried.config = normalizeModelConfig(carried.config);
    if (carried.paramGroups) carried.paramGroups = normalizeParamGroups(carried.paramGroups);
    if (carried.presets) carried.presets = normalizePresets(carried.presets);
    // Per-parameter userNote needs its OWN carry-over. USER_AUTHORED_FIELDS only
    // protects TOP-LEVEL keys, and inspectModel() rebuilds sheet.params from
    // scratch on every re-inspect — so without this map, re-measuring ranges
    // would silently erase every per-param description the user wrote. Keyed by
    // param id because the new params array may be a different length or order.
    carried.__paramNotes = {};
    if (Array.isArray(prev.params)) {
      for (const p of prev.params) {
        if (p && typeof p === 'object' && p.id && typeof p.userNote === 'string' && p.userNote) {
          carried.__paramNotes[p.id] = p.userNote.slice(0, 300);
        }
      }
    }
    return carried;
  }

  // ── Identitas karakter (model-agnostic) ─────────────────────────
  // Source of truth, in order: config.displayName (user-set) → model folder
  // name → generic fallback. Nothing here is hardcoded to one character, so
  // importing any model produces a coherent UI without editing source.
  function characterName() {
    const cfg = currentModelConfig();
    if (cfg.displayName) return cfg.displayName;
    // state.modelPath looks like 'model/<folder>/<file>.model3.json'. The folder
    // is the modeler's own name for the character and is the best automatic
    // guess available.
    const m = /^model\/([^/]+)\//.exec(state.modelPath || '');
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    return 'Live2D Agent';
  }

  // One grapheme for the avatar circle. Array.from() (not [0]) because the name
  // may start with an astral-plane char or an emoji — slicing by UTF-16 code
  // unit would render half a surrogate pair as a replacement glyph.
  function characterInitial() {
    const n = characterName();
    return Array.from(n)[0] || '?';
  }

  // Repaint every place the character's identity is shown. Called on model load
  // and after a config save, so a rename takes effect without a reload.
  function applyCharacterIdentity() {
    const name = characterName();
    const initial = characterInitial();
    document.title = name + ' — Live2D Agent';
    const nameEl = $('.sb-name');
    if (nameEl) nameEl.textContent = name;
    // Sidebar avatar + any agent bubbles ALREADY on screen. Bubbles rendered
    // before the model resolved would otherwise keep the placeholder initial.
    // Array.from() because $$ returns a NodeList — [x].concat(nodeList) would
    // nest the list as a single element instead of spreading it.
    const avatars = [$('.sb-avatar')].concat(Array.from($$('.msg.agent .msg-avatar')));
    for (const el of avatars) { if (el) el.textContent = initial; }
    const greet = $('#greeting-bubble');
    if (greet) greet.textContent = 'Halo! Aku ' + name + '~ Ada yang bisa kubantu? 😊';
  }

  // ── Live per-model config ───────────────────────────────────────
  // state.modelConfig is seeded in the constants block above the Boot call.
  // It must NOT be re-seeded here: this line sits below the boot call but still
  // runs in the same synchronous pass, so a second Object.assign would clobber
  // anything boot already resolved. (Harmless today only because the model load
  // is async and lands after this line; that is luck, not design.)

  function currentModelConfig() {
    return state.modelConfig || MODEL_CONFIG_DEFAULTS;
  }

  // Push config values into the parts of the engine that read `state` directly,
  // so a load or a save takes effect without a page reload.
  function applyModelConfig(cfg) {
    const c = normalizeModelConfig(cfg);
    state.modelConfig = c;
    state.blinkEnabled = c.blink;
    state.idleEnabled = c.idle;
    // Blink runs on an interval that checks state.blinkEnabled each tick, so
    // toggling the flag is enough; no restart needed.
    if (state.model) {
      try { frameModel(c.framing); } catch (e) { console.warn('[config] framing failed:', e.message); }
    }
    // Identity lives in the same config object, so a save that changed
    // displayName must repaint the header here rather than at every call site.
    try { applyCharacterIdentity(); } catch (e) { console.warn('[identity] repaint failed:', e.message); }
    return c;
  }

  // Read the persisted config for the CURRENT model without hitting the network.
  function loadModelConfigLocal() {
    const sheet = loadCharacterSheet();
    return normalizeModelConfig(sheet && sheet.config);
  }

  // Persist config into the sheet. Mirrors saveUserNote(): localStorage first
  // (synchronous, survives a dead server), then the sheet file.
  async function saveModelConfig(patch) {
    let sheet = loadCharacterSheet();
    if (!sheet) {
      if (!state.model) throw new Error('Load model dulu sebelum menyimpan pengaturan.');
      sheet = inspectModel();
      if (!sheet) throw new Error('Inspeksi model gagal, pengaturan tidak bisa disimpan.');
    }
    const merged = normalizeModelConfig(Object.assign({}, sheet.config, patch || {}));
    sheet.config = merged;
    sheet.schemaVersion = SHEET_SCHEMA_VERSION;

    try {
      localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
    } catch (e) {
      console.warn('[config] localStorage write failed:', e.message);
    }
    state.lastSheet = sheet;
    applyModelConfig(merged);

    const key = characterSheetKey().replace('live2d_sheet_', '');
    const res = await fetch(API + '/api/sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelName: key, sheet: sheet }),
    });
    if (!res.ok) {
      let detail = {};
      try { detail = await res.json(); } catch (e) {}
      throw new Error(detail.error || ('server HTTP ' + res.status));
    }
    try { window.__agent && typeof window.__agent.invalidateCapabilityProfile === 'function' && window.__agent.invalidateCapabilityProfile(); } catch (e) {}
    return merged;
  }

  // ── User note: read / write ─────────────────────────────────────
  // The note lives INSIDE the character sheet (single source of truth) rather
  // than in its own storage key, so it travels with the sheet file and can't
  // drift out of sync with the model it describes.
  //
  // Capped because the note is injected into every LLM request as character
  // context — an unbounded note would silently eat the context window and, on
  // token-billed providers, the user's money.
  const MAX_USER_NOTE = 2000;

  function sanitizeUserNote(text) {
    // Normalize line endings FIRST. A pasted note (or a non-conforming browser)
    // can carry CRLF; leaving the CR in means the stored note differs from what
    // the textarea shows and the count drifts by one per line.
    let s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    // Strip remaining control chars but KEEP newlines and tabs, which are
    // meaningful formatting in a free-text description.
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (s.length > MAX_USER_NOTE) {
      s = s.slice(0, MAX_USER_NOTE);
      // Truncating by UTF-16 length can split a surrogate pair and leave a lone
      // half, which serializes as U+FFFD. Drop the orphan so emoji never rot.
      const last = s.charCodeAt(s.length - 1);
      if (last >= 0xD800 && last <= 0xDBFF) s = s.slice(0, -1);
    }
    return s;
  }

  // Persist the note to BOTH stores the sheet lives in. Returns the saved text.
  // Never silently no-ops: if there is no sheet yet we build one first, so the
  // user's typing is not thrown away just because they hadn't run inspect.
  async function saveUserNote(rawText) {
    const note = sanitizeUserNote(rawText);
    let sheet = state.lastSheet || loadCharacterSheet();
    if (!sheet) sheet = await fetchSheetFile();
    if (!sheet) {
      if (!state.model) throw new Error('Load model dulu sebelum menyimpan catatan.');
      sheet = inspectModel();          // creates + persists a fresh sheet
      if (!sheet) throw new Error('Gagal membuat character sheet.');
    }
    sheet.userNote = note;
    sheet.schemaVersion = SHEET_SCHEMA_VERSION;
    state.lastSheet = sheet;

    // localStorage first: it's synchronous and local, so the note is safe even
    // if the server write fails.
    let localOk = true;
    try {
      localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
    } catch (e) { localOk = false; console.warn('[note] localStorage save failed:', e.message); }

    // Then the file, which is the primary source on next load. The server
    // serializes writes per sheet path, so this can't tear a concurrent save.
    const res = await fetch(API + '/api/sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelName: sheet.modelName, sheet }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || ('server HTTP ' + res.status) +
        (localOk ? ' (tersimpan lokal saja)' : ''));
    }
    // The agent caches the capability profile, which now carries userNote —
    // drop it so the very next message sees the new note.
    try { window.__agent && window.__agent.invalidateCapabilityProfile && window.__agent.invalidateCapabilityProfile(); } catch (e) {}
    return note;
  }

  // ── Per-parameter description (params[i].userNote) ──────────────
  // A free-text note the USER writes to explain what a specific model parameter
  // actually does on THIS rig ("ParamX = scale pupil kiri", "ParamY = buka
  // kerah baju"). Unlike label (which is the rigger's own id, verbatim) and the
  // AI .ai suggestion, this is AUTHORITATIVE user context and is fed straight
  // into the LLM prompt so the model understands the parameter's real meaning.
  //
  // Capped at 300 chars (matches the v4 migration cap) so it can't blow the LLM
  // context window when many params are annotated. Sanitised like saveUserNote.
  const MAX_PARAM_NOTE = 300;

  function sanitizeParamNote(text) {
    let s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (s.length > MAX_PARAM_NOTE) {
      s = s.slice(0, MAX_PARAM_NOTE);
      const last = s.charCodeAt(s.length - 1);
      if (last >= 0xD800 && last <= 0xDBFF) s = s.slice(0, -1);
    }
    return s;
  }

  // Persist a per-parameter note to the sheet (both stores). Throws if the
  // paramId is not a real parameter of the current model — we never invent
  // entries for ids the rig doesn't own (model-agnostic invariant: only the
  // model's own parameters may carry descriptions).
  async function saveParamNote(paramId, rawText) {
    if (typeof paramId !== 'string' || !paramId) throw new Error('paramId wajib ada.');
    const note = sanitizeParamNote(rawText);
    const sheet = await sheetForWrite();
    if (!Array.isArray(sheet.params)) sheet.params = [];
    const pObj = sheet.params.find(p => p && p.id === paramId);
    if (!pObj) throw new Error('Parameter "' + paramId + '" tidak ada di sheet model ini.');
    pObj.userNote = note;
    sheet.schemaVersion = SHEET_SCHEMA_VERSION;
    await persistSheet(sheet);
    return note;
  }

  // Fill a per-parameter note editor field for the CURRENT model's param.
  function getParamNote(paramId) {
    const sheet = state.lastSheet || loadCharacterSheet();
    const p = (sheet && sheet.params || []).find(p => p && p.id === paramId);
    return (p && typeof p.userNote === 'string') ? p.userNote : '';
  }

  // Fill the textarea with the stored note for the CURRENT model.
  async function refreshUserNoteUI() {
    const box = $('#input-user-note');
    if (!box) return;
    let sheet = state.lastSheet || loadCharacterSheet();
    if (!sheet) sheet = await fetchSheetFile();
    box.value = (sheet && typeof sheet.userNote === 'string') ? sheet.userNote : '';
    const status = $('#note-status');
    if (status) { status.textContent = ''; status.className = 'note-status'; }
  }

  // Deep-inspect the loaded model: read every parameter's actual range from
  // Cubism Core (min/max/default), list native expressions, detect accessory
  // params, and build a complete "character sheet" the AI can reference.
  function inspectModel() {
    if (!state.model) return null;
    const cm = coreModel();
    const m = state.model;

    // 1) Enumerate all parameters with REAL ranges from Cubism Core.
    //
    // There are TWO different objects in play and they do NOT share an API:
    //
    //   cm  = CubismModel (the pixi-live2d-display wrapper). Has the
    //         getParameterCount() / getParameterIds() / getParameterMinimumValue(i)
    //         accessor methods.
    //   cm.getModel() = Live2DCubismCore.Model (the raw WASM object). Has NO
    //         such methods — it exposes `.parameters` with parallel typed
    //         arrays: ids, minimumValues, maximumValues, defaultValues, types.
    //
    // The previous version called cm.getModel() and then invoked the accessor
    // methods on THAT, which throws TypeError on the very first call. The throw
    // was swallowed by the outer catch, rawParams stayed empty, and every sheet
    // silently fell through to the estimated-range path. Verified against the
    // live engine: 18% of ranges were wrong on one model and 57% on another,
    // while the sheet still claimed they were measured.
    //
    // Preference order below is deliberate: the raw typed arrays are the
    // engine's own storage (fewest layers, nothing to misread), so they come
    // first. The wrapper accessors are the documented fallback.
    const rawParams = [];
    let rangeSource = 'none';
    try {
      const gm = (cm && cm.getModel) ? cm.getModel() : null;
      const pp = gm && gm.parameters;

      if (pp && pp.ids && pp.minimumValues && pp.maximumValues && pp.defaultValues) {
        // Path 1: raw core arrays — the engine's actual parameter table.
        rangeSource = 'core-arrays';
        const n = pp.count != null ? pp.count : pp.ids.length;
        for (let i = 0; i < n; i++) {
          const id = pp.ids[i];
          if (!id) continue;
          rawParams.push({
            id,
            min: pp.minimumValues[i],
            max: pp.maximumValues[i],
            def: pp.defaultValues[i],
            // ParameterType_BlendShape (1) behaves additively rather than as an
            // absolute pose value; recorded so the AI can treat it differently.
            type: pp.types ? pp.types[i] : undefined,
          });
        }
      } else if (cm && typeof cm.getParameterCount === 'function' &&
                 typeof cm.getParameterMinimumValue === 'function') {
        // Path 2: CubismModel wrapper accessors.
        rangeSource = 'wrapper-accessors';
        const count = cm.getParameterCount();
        const ids = (typeof cm.getParameterIds === 'function') ? cm.getParameterIds() : null;
        for (let i = 0; i < count; i++) {
          const id = ids ? ids[i] : '';
          if (!id) continue;
          rawParams.push({
            id,
            min: cm.getParameterMinimumValue(i),
            max: cm.getParameterMaximumValue(i),
            def: cm.getParameterDefaultValue(i),
          });
        }
      }

      // Never let a partially-read table masquerade as complete: any
      // non-finite number means we misread the engine, so discard everything
      // and let the estimated path take over with its honest flag.
      const bad = rawParams.filter(p =>
        !Number.isFinite(p.min) || !Number.isFinite(p.max) || !Number.isFinite(p.def) ||
        !(p.min <= p.def && p.def <= p.max));
      if (bad.length) {
        console.warn('[inspect] ' + bad.length + ' params failed the min<=def<=max sanity ' +
          'check (source=' + rangeSource + '); discarding measured ranges. First:', bad[0]);
        rawParams.length = 0;
        rangeSource = 'none';
      }
    } catch (e) {
      console.warn('[inspect] param enumeration failed:', e.message);
      rawParams.length = 0;
      rangeSource = 'none';
    }
    if (rawParams.length) {
      console.log('[inspect] measured ' + rawParams.length + ' parameter ranges from the engine ' +
        '(source=' + rangeSource + ')');
    }

    // Fallback: Cubism Core enumeration produced nothing, so we have no MEASURED
    // ranges at all. We still build a sheet (a blank one would break every
    // downstream reader), but every param coming from here is tagged
    // estimated:true so the range is never mistaken for the model's truth.
    // PARAM_META covers only Cubism-standard ids; anything else gets a neutral
    // -1..1 and is flagged too.
    let rangesEstimated = false;
    if (!rawParams.length && state.modelParams) {
      rangesEstimated = true;
      console.warn('[inspect] enumeration failed — falling back to ESTIMATED ranges for',
        state.modelParams.length, 'params. AI will be told these are unmeasured.');
      for (const pid of state.modelParams) {
        const meta = findParamMeta(pid);
        rawParams.push({
          id: pid,
          min: meta ? meta.min : -1,
          max: meta ? meta.max : 1,
          def: meta ? meta.def : 0,
          estimated: true,
          // Distinguishes "Cubism convention for a known id" from "we had no
          // idea at all", which are very different confidence levels.
          estimateSource: meta ? 'cubism-standard' : 'neutral-default',
        });
      }
    }

    // 2) Classify params into groups. Sumber label & grup ada dua, dengan
    // prioritas: (a) cdi3.json milik rigger (Name + GroupId — nama yang ASLI
    // ditulis pembuat rig, mis. "heart eye", "eyelashes shake4"), (b) heuristik
    // regex id (physics/Sudut/Mata/…). Jangan pernah translate/rename id:
    // dua-duanya tetap ditampilkan, label memperkaya, id tetap identitas.
    const cdiById = (state.cdiInfo && state.cdiInfo.byId) || null;
    const classified = [];
    const used = new Set();
    for (const rp of rawParams) {
      const label = (cdiById && cdiById.get(rp.id) && cdiById.get(rp.id).label) || rp.id;
      let group;
      if (cdiById && cdiById.get(rp.id) && cdiById.get(rp.id).group) {
        // Grup rigger via judul turunan label anggota (lihat cdiGroupTitle).
        group = cdiGroupTitle(cdiById.get(rp.id).group);
      } else {
        group = 'Lainnya';
        if (/physics/i.test(rp.id)) {
          group = 'Physics';            // model-driven physics outputs, kept apart
        } else {
          for (const gname in PARAM_META) {
            if (PARAM_META[gname][rp.id]) { group = gname; break; }
          }
          if (group === 'Lainnya') {
            if (/^ParamAngle/.test(rp.id)) group = 'Sudut (Angle)';
            else if (/^ParamEye/.test(rp.id)) group = 'Mata (Eye)';
            else if (/^ParamBrow/.test(rp.id)) group = 'Alis (Eyebrow)';
            else if (/^ParamMouth/.test(rp.id)) group = 'Mulut (Mouth)';
            else if (/^ParamBody/.test(rp.id)) group = 'Badan (Body)';
            else if (/^ParamHair/.test(rp.id)) group = 'Rambut (Hair)';
            else group = 'Kustom';
          }
        }
      }
      const entry = { id: rp.id, min: rp.min, max: rp.max, def: rp.def, group, label };
      // BlendShape params are additive offsets, not absolute poses. Only tagged
      // when the engine actually told us (absent on the estimated path).
      if (rp.type === 1) entry.blendShape = true;
      // Only present on the fallback path; absent means the range was measured.
      if (rp.estimated) { entry.estimated = true; entry.estimateSource = rp.estimateSource; }
      classified.push(entry);
      used.add(rp.id);
    }

    // 2b) Parts — a separate opacity system from Parameters. Many riggers
    // toggle accessories/outfits via Part opacity rather than a custom Param,
    // so we enumerate these too (tagged type:'part' so the UI/AI know to use
    // setPartOpacity, not setParameterValue, when driving them).
    const parts = enumerateParts().map(p => ({ ...p, type: 'part' }));

    // 3) Role map FIRST — the accessory detector below needs to know which ids
    // are already claimed as semantic roles so it never offers e.g. the blush or
    // mouth-open param as a toggleable "accessory".
    const roleIds = mapRoles(new Set(rawParams.map(p => p.id)), getOfficialGroups(m));
    const ROLE_ID_SET = new Set(Object.values(roleIds).filter(Boolean));

    // 4) Detect accessory params + accessory Parts — MEASURED, not listed.
    // An accessory behaves like a toggle: a 0..1 range that rests at 0 (hidden
    // by default). We detect that SHAPE rather than matching specific ids, so it
    // works on any rigger's numbering scheme and yields nothing on models that
    // simply have no accessory params (verified: 9 on one model, 0 on another,
    // with no hardcoded id list involved).
    const isToggleShaped = (p) =>
      p.min >= 0 && p.max <= 1 && p.def === 0 &&
      !ROLE_ID_SET.has(p.id) &&            // never expose a semantic role as an accessory
      !/physics/i.test(p.id);
    const accessories = classified.filter(p =>
      isToggleShaped(p) && (/^Param\d+$/.test(p.id) || p.group === 'Kustom')
    ).map(p => p.id).concat(
      parts.filter(p => p.def === 0).map(p => p.id)
    );

    // 5) Emotions: the universal vocabulary is DERIVED from the role map, not
    //    authored per character. buildRoleEmotions() resolves the role templates
    //    against this model's own params and ranges, so a rig missing brows or a
    //    mouth simply advertises fewer emotions instead of getting wrong ones.
    //    Written into the sheet so the LLM profile and the Sheet tab can report a
    //    real count, but it is a CACHE — refreshRoleEmotions() recomputes it on
    //    every model load and projectEmotionPresets() drops stale names.
    const supportedEmotions = buildRoleEmotions();

    // 6) Native expressions (.exp3)
    const nativeExprs = state.modelExpressions || [];

    // 7) Motion groups
    let motionGroups = [];
    try {
      const mm = m.internalModel && m.internalModel.motionManager;
      if (mm && mm.definitions) motionGroups = Object.keys(mm.definitions);
    } catch (e) {}

    // 8) True range per param (from Cubism Core) for accurate clamping + sliders.
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
      // True only when Cubism Core enumeration failed and every range above is a
      // guess. The LLM prompt reads this and stops trusting the numbers.
      rangesEstimated: rangesEstimated,
      // Where the numbers came from: 'core-arrays' | 'wrapper-accessors' |
      // 'estimated'. Recorded so a sheet can be audited later without having to
      // re-derive provenance from which fields happen to be present.
      rangeSource: rangesEstimated ? 'estimated' : rangeSource,
      params: classified,
      parts: parts,
      paramRange: paramRange,
      roleIds: roleIds,
      accessories: accessories,
      supportedEmotions: supportedEmotions,
      nativeExpressions: nativeExprs,
      motionGroups: motionGroups,
      // User-authored, empty by default; re-inspection must not wipe it, so any
      // existing value is carried over below.
      userNote: '',
      // Per-model preferences. Same carry-over rule as userNote.
      config: Object.assign({}, MODEL_CONFIG_DEFAULTS),
      // Two-branch structures (v4). Both are in USER_AUTHORED_FIELDS so a
      // re-inspect keeps them, and both keep .user and .ai apart so an AI
      // suggestion can never overwrite something the user made.
      //   paramGroups: paramId -> group label   (categorisation; where a slider shows)
      //   presets:     named value sets         (action; what happens on click)
      // These are two different jobs: a group label stores no values, and a
      // preset says nothing about where a slider belongs.
      paramGroups: { user: {}, ai: {} },
      presets: { user: [], ai: [] },
      controls: {
        head: !!(roleIds.angleX || roleIds.angleY),
        eyes: !!(roleIds.eyeBallX || roleIds.eyeBallY || roleIds.eyeLOpen || roleIds.eyeROpen),
        eyebrows: !!(roleIds.browLForm || roleIds.browRForm),
        mouth: !!(roleIds.mouthOpenY || roleIds.mouthForm),
        body: !!(roleIds.bodyAngleX || roleIds.bodyAngleY || roleIds.bodyAngleZ),
        hair: classified.some(p => /hair/i.test(p.id)),
      },
    };

    // Carry over user-authored fields BEFORE anything persists this sheet.
    // inspectModel() rebuilds from scratch, so a re-inspect would otherwise
    // silently destroy notes the user typed.
    const carriedFields = existingUserFields();
    const carriedNotes = carriedFields.__paramNotes || {};
    delete carriedFields.__paramNotes;   // internal transport, never persisted
    Object.assign(sheet, carriedFields);
    // Re-attach per-param notes by id onto the freshly rebuilt params array.
    // Ids that no longer exist (the model changed) are simply dropped.
    for (const p of sheet.params) {
      if (p && typeof p === 'object' && carriedNotes[p.id]) p.userNote = carriedNotes[p.id];
    }
    // Emosi presets must reach state.supportedEmotions before the sheet is
    // published, or the freshly inspected model would advertise fewer emotions
    // than the user actually defined.
    projectEmotionPresets(sheet);
    state.lastSheet = sheet;

    // Trigger AI classification for unmapped parameters in background.
    // .catch() is mandatory now that the function rethrows for the UI caller —
    // without it a failed classify becomes an unhandled promise rejection.
    triggerAIParamClassification(sheet, classified, roleIds)
      .catch(e => console.warn('[inspect] classify failed:', e.message));

    // Save to localStorage (fast reuse, no network)
    try {
      localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
      console.log('[inspect] character sheet saved:', sheet.paramCount, 'params,',
        accessories.length, 'accessories,', nativeExprs.length, 'expressions');
    } catch (e) { console.warn('[inspect] failed to save sheet:', e.message); }

    // Also persist to a FILE via the server (sheets/<modelKey>.json) so the
    // AI profile survives across browsers / clears and is reusable without
    // re-inspecting the model every time.
    try {
      fetch(API + '/api/sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelName: sheet.modelName, sheet }),
      }).then(r => r.json().catch(() => ({}))).then(j =>
        console.log('[inspect] character sheet file saved:', j.path || j.error || '(unknown)')
      ).catch(() => {});
    } catch (e) { console.warn('[inspect] failed to push sheet to server:', e.message); }

    return sheet;
  }

  // Asynchronously classify unmapped parameters using the LLM (runs once per model)
  // Callable two ways:
  //   • from inspectModel() with the freshly built (sheet, classified, roleIds)
  //   • from the Sheet tab with NO arguments, where everything is derived from
  //     the sheet already in memory
  // The second form exists because the UI button has no access to inspect's
  // locals, and re-running a full inspect just to re-classify would throw away
  // the user's current pose.
  //
  // Returns { count } so the UI can report how many suggestions came back;
  // inspectModel() ignores the return value (fire-and-forget).
  async function triggerAIParamClassification(sheet, classified, roleIds) {
    if (!sheet) {
      sheet = state.lastSheet || loadCharacterSheet();
      if (!sheet) throw new Error('Belum ada sheet. Inspeksi model dulu.');
    }
    if (!Array.isArray(classified)) classified = sheet.params || [];
    if (!roleIds) roleIds = sheet.roleIds || {};
    if (!sheet.roleIds) sheet.roleIds = {};
    if (!Array.isArray(sheet.accessories)) sheet.accessories = [];
    try {
      // Defensive: this runs on a sheet that may have come from a v3 file whose
      // migration ran in a previous session, or from a caller that built one by
      // hand. Writing sheet.paramGroups.ai[...] on a sheet without the structure
      // would throw and kill the whole classification silently.
      if (!sheet.paramGroups) sheet.paramGroups = { user: {}, ai: {} };
      // The .ai branch is a suggestion cache, so it is rebuilt from scratch on
      // every run rather than accumulating stale labels from older classifies.
      // .user is never touched here.
      sheet.paramGroups.ai = {};
      const mappedParamIds = new Set(Object.values(roleIds || {}));
      const unmapped = classified.filter(p => !mappedParamIds.has(p.id) && !p.id.toLowerCase().includes('physics'));
      if (!unmapped.length) return { count: 0 };

      const res = await fetch(API + '/api/model/classify-params', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          params: unmapped.map(p => ({ id: p.id, min: p.min, max: p.max, def: p.def })),
          currentRoles: roleIds,
        }),
      });
      if (!res.ok) throw new Error('server menolak (HTTP ' + res.status + ')');
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
        const pObj = sheet.params.find(p => p.id === item.id);
        // Ignore any id that isn't a real parameter of THIS model.
        if (!pObj) continue;
        if (item.role && !sheet.roleIds[item.role]) {
          sheet.roleIds[item.role] = item.id;
          changed = true;
        }
        // Grouping goes into paramGroups.ai, NOT pObj.group. pObj.group is the
        // heuristic slot computed by inspectModel() from the parameter id, and
        // overwriting it would destroy the fallback that makes the panel work
        // with no LLM at all. Keeping the two apart is also what lets
        // resolveParamGroup() honour user > ai > heuristic — a single field
        // cannot express three precedence levels.
        //
        // The .ai branch is REWRITTEN on every classify run by design: it is a
        // suggestion cache, not user data. USER_AUTHORED_FIELDS protects the
        // paramGroups object from re-inspection, but only .user is durable.
        if (item.group) { sheet.paramGroups.ai[item.id] = String(item.group).trim().slice(0, 40); changed = true; }
        if (item.label) { pObj.label = item.label; changed = true; }
        if (item.isAccessory && !sheet.accessories.includes(item.id)) {
          sheet.accessories.push(item.id);
          changed = true;
        }
      }

      if (changed) {
        console.log('[inspect] AI classified', items.length, 'parameters successfully!');
        hydrateCaps(sheet);
        localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
        fetch(API + '/api/sheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelName: sheet.modelName, sheet }),
        }).catch(() => {});
      }
      return { count: items.length, changed };
    } catch (e) {
      console.warn('[inspect] AI param classification skipped/failed:', e.message);
      // Rethrown, not swallowed: the Sheet tab shows this in #sheet-status, and
      // the inspect path passes fire-and-forget with its own .catch(). Swallowing
      // here would make the UI button report success on a failed request.
      throw e;
    }
  }

  // Ask the server for PRESET suggestions and park them in sheet.presets.ai.
  //
  // Deliberately separate from triggerAIParamClassification(): that one enriches
  // individual parameters (role/label/group), this one proposes whole poses. They
  // fail independently, so the Analyze button runs both and reports each.
  //
  // Everything written here goes to the .ai branch ONLY. .user is never touched,
  // which is what makes an unwanted suggestion a no-op rather than data loss.
  async function analyzeSheetPresets(sheet) {
    if (!sheet) {
      sheet = state.lastSheet || loadCharacterSheet();
      if (!sheet) throw new Error('Belum ada sheet. Inspeksi model dulu.');
    }
    if (!sheet.presets || typeof sheet.presets !== 'object') sheet.presets = { user: [], ai: [] };
    if (!Array.isArray(sheet.presets.user)) sheet.presets.user = [];
    if (!Array.isArray(sheet.presets.ai)) sheet.presets.ai = [];

    const allParams = (sheet.params || [])
      .filter(p => p && p.id && Number.isFinite(p.min) && Number.isFinite(p.max))
      .map(p => ({ id: p.id, min: p.min, max: p.max, def: p.def, label: p.label || '',
        group: resolveParamGroup(sheet, p.id, p.group) }));
    const params = allParams;
    if (!params.length) return { count: 0 };

    const parts = (sheet.parts || []).map(p => (p && p.id) || p).filter(Boolean);
    // Sent so the LLM does not waste its budget re-proposing what the user owns.
    const existingNames = sheet.presets.user.map(p => p.name);

    // Per-parameter descriptions the user wrote. AUTHORITATIVE: the LLM must
    // honour these meanings when proposing presets, so a param the user has
    // explained ("ParamX = scale pupil") is not re-guessed wrongly. Only params
    // that actually carry a note are sent, keeping the payload small.
    const notes = {};
    for (const p of (sheet.params || [])) {
      if (p && p.id && typeof p.userNote === 'string' && p.userNote.trim()) {
        notes[p.id] = p.userNote.trim().slice(0, 300);
      }
    }

    const res = await fetch(API + '/api/model/analyze-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params, parts, existingNames, notes }),
    });
    if (!res.ok) throw new Error('server menolak (HTTP ' + res.status + ')');
    const data = await res.json();
    if (data.warning) console.warn('[analyze-sheet]', data.warning);

    // normalizePresetList() is reused rather than trusting the response shape:
    // it strips unknown fields, forces source='ai', and — because category is
    // not 'gerak' — drops any steps the payload carried.
    const incoming = normalizePresetList(
      (data.presets || []).filter(p => p && p.category !== 'gerak'), 'ai');
    if (!incoming.length) return { count: 0 };

    // Full replace, not merge: .ai is a regenerable cache, and merging would let
    // suggestions from an older model linger after a re-analyse.
    sheet.presets.ai = incoming;
    projectEmotionPresets(sheet);   // no-op for .ai, but keeps the sheet coherent
    localStorage.setItem(characterSheetKey(), JSON.stringify(sheet));
    try {
      await fetch(API + '/api/sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelName: sheet.modelName, sheet }),
      });
    } catch (e) {
      // localStorage already has it; the file write is best-effort.
      console.warn('[analyze-sheet] file write failed, kept locally:', e.message);
    }
    try { window.__agent && typeof window.__agent.invalidateCapabilityProfile === 'function' && window.__agent.invalidateCapabilityProfile(); } catch (e) {}
    return { count: incoming.length };
  }

  // Load saved character sheet (returns null if none)
  function loadCharacterSheet() {
    try {
      const raw = localStorage.getItem(characterSheetKey());
      return raw ? migrateSheet(JSON.parse(raw)) : null;
    } catch (e) { return null; }
  }

  // Delete character sheet(s) belonging to a deleted model.
  //
  // Tricky bit: characterSheetKey() is derived from state.modelPath — the full
  // 'model/<name>/<file>.model3.json' — while model deletion only knows <name>.
  // The old code did 'live2d_sheet_' + name, a key that was NEVER the one
  // written, so every sheet was orphaned in localStorage on delete and a later
  // model could read back a stale predecessor's sheet. We instead sweep for the
  // keys whose sanitized path segment matches this model name.
  function sheetKeyPrefixForModelName(name) {
    const sanitized = String(name || '').replace(/[^A-Za-z0-9_\u4e00-\u9fff]/g, '_');
    return 'live2d_sheet_model_' + sanitized + '_';
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
      if (doomed.length) console.log('[sheet] removed', doomed.length, 'sheet(s) for deleted model', modelName);
    } catch (e) {}
  }

  // Cubism standard parameter table. Two jobs, both narrow:
  //
  //  1) GROUP HINTS — mostly redundant with the prefix rules in inspectModel()
  //     (ParamAngle* -> Sudut, ParamEye* -> Mata, ...). The one id that genuinely
  //     needs the table is ParamBreath, which belongs to Badan (Body) but does
  //     not match /^ParamBody/. Kept for that.
  //
  //  2) ESTIMATED FALLBACK RANGES — used ONLY when Cubism Core enumeration fails
  //     outright. These are the Cubism *convention*, NOT this model's truth: a
  //     rigger is free to give ParamAngleX a -45..45 range, and we would record
  //     -30..30 and quietly cap the AI's head movement at two thirds of what the
  //     model can do. Anything sourced from here is therefore tagged
  //     estimated:true and the LLM is told the range was never measured.
  //
  // The per-param `label` fields were removed: they were dead code. inspectModel()
  // deliberately shows each parameter's REAL model id, so the Indonesian labels
  // that used to live here were never read by anything.
  const PARAM_META = {
    'Sudut (Angle)': {
      ParamAngleX:  { min: -30, max: 30, def: 0 },
      ParamAngleY:  { min: -30, max: 30, def: 0 },
      ParamAngleZ:  { min: -30, max: 30, def: 0 },
    },
    'Mata (Eye)': {
      ParamEyeLOpen:  { min: 0, max: 1, def: 1 },
      ParamEyeROpen:  { min: 0, max: 1, def: 1 },
      ParamEyeLSmile: { min: -1, max: 1, def: 0 },
      ParamEyeRSmile: { min: -1, max: 1, def: 0 },
      ParamEyeBallX:  { min: -1, max: 1, def: 0 },
      ParamEyeBallY:  { min: -1, max: 1, def: 0 },
      ParamEyeForm:   { min: -1, max: 1, def: 0 },
    },
    'Alis (Eyebrow)': {
      ParamBrowLX:     { min: -1, max: 1, def: 0 },
      ParamBrowRX:     { min: -1, max: 1, def: 0 },
      ParamBrowLY:     { min: -1, max: 1, def: 0 },
      ParamBrowRY:     { min: -1, max: 1, def: 0 },
      ParamBrowLAngle: { min: -1, max: 1, def: 0 },
      ParamBrowRAngle: { min: -1, max: 1, def: 0 },
      ParamBrowLForm:  { min: -1, max: 1, def: 0 },
      ParamBrowRForm:  { min: -1, max: 1, def: 0 },
    },
    'Mulut (Mouth)': {
      ParamMouthForm:  { min: -1, max: 1, def: 0 },
      ParamMouthOpenY: { min: 0, max: 1, def: 0 },
      ParamMouthOpenX: { min: -1, max: 1, def: 0 },
    },
    'Badan (Body)': {
      ParamBodyAngleX: { min: -20, max: 20, def: 0 },
      ParamBodyAngleY: { min: -20, max: 20, def: 0 },
      ParamBodyAngleZ: { min: -20, max: 20, def: 0 },
      ParamBreath:     { min: 0, max: 1, def: 0 },
    },
    // NOTE: no 'Rambut (Hair)' and no 'Aksesoris (Accessory)' entries here.
    //
    // Hair: ParamHairFront/Side/Back are NOT a Cubism standard and were absent
    // from every model actually measured. Hair params are matched by the
    // /^ParamHair/ prefix rule in the classifier below instead of being listed.
    //
    // Accessories: previously this table hardcoded Param91/92/93/94/52/55/68/76/96
    // — the accessory slots of ONE specific model. That is exactly the kind of
    // name-dependence that breaks silently on an imported model, where the same
    // numbers mean something entirely different. It was also fully REDUNDANT:
    // the generic rule in inspectModel() (numbered id + 0..1 range + default 0)
    // already detects 9/9 of them, and correctly finds 0 on a model that has
    // none. Detection is measured from the model, never assumed from a list.
  };

  // Find meta info for a param by ID (from PARAM_META)
  function findParamMeta(pid) {
    for (const g in PARAM_META) {
      if (PARAM_META[g][pid]) return PARAM_META[g][pid];
    }
    return null;
  }

  // ── Capability profile: builds from saved sheet or live inspection ──
  // RECOMMENDATION A: the character sheet FILE (sheets/<modelKey>.json, served
  // by the backend at GET /api/sheet) is now the PRIMARY source. We fetch it
  // first, fall back to localStorage, then finally live-inspect. This means the
  // file the user generated is genuinely reused every chat — not just cached in
  // localStorage (which is wiped on clear). After resolving the sheet we also
  // hydrate state.caps so the AI engine only drives parameters the model owns.
  async function fetchSheetFile() {
    try {
      const key = characterSheetKey().replace('live2d_sheet_', '');
      const res = await fetch(API + '/api/sheet?name=' + encodeURIComponent(key));
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      // Migrate on the way in: this is the boundary where a legacy on-disk sheet
      // (written before schemaVersion existed) enters the running app.
      const migrated = data && data.params ? migrateSheet(data) : null;
      // Simpan mirror agar existingUserFields() tetap punya sumber field user
      // walau cache localStorage kosong. Kegagalan baca TIDAK menghapus mirror
      // lama — data yang pernah terbaca lebih baik daripada tidak sama sekali.
      if (migrated) state.lastFileSheet = migrated;
      return migrated;
    } catch (e) { return null; }
  }

  function hydrateCaps(sheet) {
    if (!sheet) return;
    const set = new Set((sheet.params || []).map(p => p.id));
    state.caps.params = set;
    // Persisted role→id map (so AI/animation work even before live re-detection).
    if (sheet.roleIds && typeof sheet.roleIds === 'object') state.caps.ids = sheet.roleIds;
    const c = sheet.controls || {};
    state.caps.hasHead    = !!c.head;
    state.caps.hasEyes    = !!c.eyes;
    state.caps.hasMouth   = !!c.mouth;
    state.caps.hasBody    = !!c.body;
    state.caps.hasBrow    = !!c.eyebrows;
    state.caps.hasHair    = !!c.hair;
    state.caps.motionGroups = Array.isArray(sheet.motionGroups) ? sheet.motionGroups : [];
    console.log('[caps] hydrated:', {
      count: set.size, head: state.caps.hasHead, eyes: state.caps.hasEyes,
      mouth: state.caps.hasMouth, body: state.caps.hasBody, brow: state.caps.hasBrow,
      gestures: state.caps.motionGroups.length,
    });
  }

  // Surface the model's user-authored 'properti' presets to the LLM as a
  // capability list. Extracted as its own function so it can be unit-tested in
  // isolation (test-fase4-properties.js) without booting the whole engine.
  //
  // Rules (mirrors the user > ai precedence elsewhere):
  //   - only presets.user of category 'properti' are advertised
  //   - presets.ai entries are EXCLUDED — they are suggestions until the user
  //     approves them, and must never read as an already-granted capability
  //   - an unknown/garbage category is never leaked into the LLM prompt
  function capabilityPropertyNames(sheet) {
    const out = [];
    const list = (sheet && sheet.presets && sheet.presets.user) || [];
    for (const p of list) {
      if (p && p.category === 'properti' && typeof p.name === 'string' && p.name.trim()) {
        out.push(p.name.trim());
      }
    }
    return out;
  }

  async function getCapabilityProfile() {
    if (!state.model) return null;

    // PRIMARY source: the backend file sheet (the user-generated file).
    let sheet = await fetchSheetFile();

    // Fallback to localStorage (fast) if the file fetch failed.
    if (!sheet) sheet = loadCharacterSheet();

    // Auto-inspect if no sheet exists yet (first-ever load).
    if (!sheet) sheet = inspectModel();

    if (!sheet) return null;

    // Hydrate engine capability flags from the sheet so AI moves respect the
    // model's real parameters.
    hydrateCaps(sheet);
    state.lastSheet = sheet;

    // Project user-authored 'emosi' presets into supportedEmotions BEFORE the
    // profile is built. This is why presets live in the sheet rather than in a
    // parallel store: applyExpression() already gates on
    // state.supportedEmotions.hasOwnProperty(name), and getExpressibleEmotions()
    // already feeds agent.js from it — so a projected preset becomes callable
    // via [EMOTION:...] with no change to either function.
    projectEmotionPresets(sheet);

    // Only USER presets are promoted to capabilities. An .ai suggestion echoed
    // back into the LLM's own prompt would read as a capability the user had
    // already approved, blurring exactly the user/AI boundary this precedence
    // rule exists to keep sharp. AI entries stay UI suggestions until saved.
    const userPresets = (sheet.presets && sheet.presets.user) || [];
    const presetNames = (cat) => userPresets.filter(p => p.category === cat).map(p => p.name);

    // Build concise profile for LLM
    return {
      modelParams: sheet.params.map(p => p.id),
      // Role → REAL model parameter id (head/eye/mouth/body/breath...). The AI
      // should use THESE ids when it wants to drive a specific part, so it works
      // for any model regardless of how the creator named its parameters.
      roleIds: sheet.roleIds || {},
      // Resolved CATEGORISATION (user ?? ai ?? heuristic) as id -> label. This
      // was a dead `[]` placeholder before v4.
      paramGroups: sheet.params.reduce((acc, p) => {
        if (p && p.id) acc[p.id] = resolveParamGroup(sheet, p.id, p.group);
        return acc;
      }, {}),
      paramDetails: sheet.params,
      emotions: Object.keys(sheet.supportedEmotions),
      nativeExpressions: sheet.nativeExpressions,
      // Accessory presets ride the EXISTING [ACC:...] directive.
      accessories: sheet.accessories.concat(presetNames('aksesoris')),
      // 'properti' presets surfaced to the LLM as their OWN field. applyExpression()
      // already resolves a 'properti' preset before .exp3, and the [PROP:] execution
      // path works — what was missing was only the advertisement. Kept SEPARATE from
      // nativeExpressions so the user-vs-rigger provenance stays legible; .ai
      // suggestions are deliberately EXCLUDED (they are not capabilities until the
      // user presses "Pakai" — see HANDOFF rule #1).
      properties: capabilityPropertyNames(sheet),
      // Free-text note the USER wrote about this character. Passed to the LLM as
      // character context; empty string when unset.
      userNote: typeof sheet.userNote === 'string' ? sheet.userNote : '',
      // Named gesture verbs — model-agnostic + native motion groups from model
      // + user 'gerak' presets + Motion Studio user motions (aiEnabled saja).
      // The LLM only ever PICKS a name from this list; it never authors timed
      // keyframes (same reason min/max stay locked to Cubism: a timed sequence
      // is far harder to validate than one number).
      gestures: (() => {
        const list = Object.keys(GESTURE_LIBRARY).concat(
          Array.isArray(sheet.motionGroups) ? sheet.motionGroups.map(g => 'motion_' + g) : []
        ).concat(presetNames('gerak'));
        if (haveMotionSystem) {
          for (const a of motionRegistry.list()) {
            if (a.source === 'user' && a.aiEnabled !== false && !list.includes(a.id)) list.push(a.id);
          }
        }
        return list;
      })(),
      // Katalog Motion Studio untuk LLM (SPEC §19): id + description + tags +
      // compatibleEmotions, TANPA keyframe. Phase 5 menyuntikkan ini ke prompt;
      // dipisah dari `gestures` supaya directive [GESTURE:] lama tetap bekerja
      // tanpa diubah.
      motionCatalog: haveMotionSystem
        ? motionRegistry.list()
            .filter(a => a.source === 'user' && a.aiEnabled !== false && (a.description || a.tags.length))
            .map(a => MotionDSL.summaryForLLM(a))
        : [],
      hasHeadControl: sheet.controls.head,
      hasEyeControl: sheet.controls.eyes,
      hasMouthControl: sheet.controls.mouth,
      hasBodyControl: sheet.controls.body,
      hasBrowControl: sheet.controls.eyebrows,
      sheet: sheet,  // full sheet for reference
    };
  }

  // ── Motion clip taxonomy: load + emotion-aware selection ──────
  // The server classifies every .motion3.json into a semantic verb by reading
  // its curves (js/motion-taxonomy.js). We fetch that once per model, then use
  // it to pick clips that fit what she's feeling.
  //
  // WHY: the old code did
  //     const g = motionGroups[Math.floor(Math.random() * motionGroups.length)]
  // every ~1.5s. On Ichika (306 groups: 17 sad, 7 angry, 49 happy) that means
  // roughly 1 in 12 gestures actively contradicted her mood — the single most
  // visible cause of "animasinya nggak sesuai konteks".
  async function loadMotionTaxonomy() {
    state.motionTaxonomy = null;
    // The server keys taxonomies by MODEL FOLDER name, which is the directory
    // component of the loaded model3.json path (e.g. 'model/lumine/lumine.model3.json'
    // -> 'lumine'). Deriving it here means it works for the bundled default and
    // for user-imported models without any extra bookkeeping.
    const parts = String(state.modelPath || '').split('/');
    const folder = parts.length >= 2 ? parts[parts.length - 2] : null;
    if (!folder) return null;
    try {
      const r = await fetch(API + '/api/model/motion-taxonomy?name=' + encodeURIComponent(folder));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      if (!data || !data.byVerb) throw new Error('malformed taxonomy');

      // Zero clips means the model folder ships no .motion3.json files (or they
      // aren't where the sheet says). The sheet may still list motion group
      // names, so try the name-only classifier before giving up entirely.
      if (!data.clipCount) {
        console.log('[taxonomy] server found 0 clips for', folder, '— trying sheet names');
        return buildTaxonomyFromNames();
      }

      // Index clip -> metadata so playback can use the declared group/index
      // (model.motion(group, index)) rather than guessing from the name.
      const clipMeta = {};
      for (const c of data.clips || []) clipMeta[c.name] = c;
      state.motionTaxonomy = { byVerb: data.byVerb, clipMeta, stats: data.stats || {} };
      console.log('[taxonomy]', data.clipCount, 'clips ->',
        Object.entries(data.byVerb).map(([v, l]) => `${v}:${l.length}`).join(' '));
      return state.motionTaxonomy;
    } catch (e) {
      console.warn('[taxonomy] unavailable, falling back to name-only classification:', e.message);
      // FALLBACK: classify the sheet's group NAMES in-browser. Lower quality
      // than curve analysis but still far better than uniform random, and it
      // keeps emotion gating working when the model folder is gone.
      return buildTaxonomyFromNames();
    }
  }

  // Name-only taxonomy from whatever motion groups the sheet knows about.
  // Uses the SAME classifier as the server, so verbs are consistent.
  function buildTaxonomyFromNames() {
    const groups = (state.caps && state.caps.motionGroups) || [];
    if (!groups.length || typeof MotionTaxonomy === 'undefined') return null;
    const built = MotionTaxonomy.buildTaxonomy(groups.map(g => ({ name: g, motion3: null })));
    const clipMeta = {};
    for (const c of built.clips) clipMeta[c.name] = { name: c.name, verb: c.verb, group: c.name, index: -1 };
    state.motionTaxonomy = { byVerb: built.byVerb, clipMeta, stats: built.stats, nameOnly: true };
    console.log('[taxonomy] name-only fallback:',
      Object.entries(built.byVerb).map(([v, l]) => `${v}:${l.length}`).join(' '));
    return state.motionTaxonomy;
  }

  // True while a native motion clip owns the rig. The eased AI pose and the
  // micro-gesture scheduler both stand down during this window so only ONE
  // writer drives the head/body params.
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
    if (!T || !state.model || typeof MotionTaxonomy === 'undefined') return null;
    if (clipIsPlaying()) return null;   // don't interrupt a clip mid-way

    const pick = MotionTaxonomy.pickClipForEmotion(T.byVerb, emotion || state.activeEmotion || 'normal');
    if (!pick) return null;

    const meta = T.clipMeta[pick.name] || {};
    try {
      // Prefer the declared group+index (exact clip). Fall back to the name as
      // a group with random index, which is what pixi-live2d does for models
      // whose model3.json has no Motions block.
      if (meta.group && typeof meta.index === 'number' && meta.index >= 0) {
        state.model.motion(meta.group, meta.index, 1);
      } else {
        state.model.motion(meta.group || pick.name, -1, 1);
      }
    } catch (e) {
      console.warn('[clip] play failed', pick.name, e.message);
      return null;
    }

    // Hold the guard for the clip's real duration when we know it, otherwise a
    // conservative default. +250ms so the pose ease resumes AFTER the clip's
    // own fade-out instead of yanking the head mid-blend.
    const dur = (meta.duration && meta.duration > 0 ? meta.duration * 1000 : 2200) + 250;
    state.clipStartedAt = performance.now();
    state.clipUntil = state.clipStartedAt + dur;
    state.clipName = pick.name;
    console.log(`[clip] ${pick.name} (verb=${pick.verb}, emotion=${emotion}) for ${Math.round(dur)}ms`);
    return pick.name;
  }

  // ── Micro-gesture scheduler (RECOMMENDATION C) ──
  // While the AI has the lock, fire small random "gestures" every 1.5–2.8s so
  // the character is never frozen between sentences — the neuro-sama "alive"
  // feel. A gesture nudges the AI pose target (which the engine eases toward),
  // so transitions stay smooth. For models that SHIP motion groups we also
  // occasionally play one of their own motion clips (RECOMMENDATION D).
  function startGestureScheduler() {
    stopGestureScheduler();
    const tick = () => {
      if (!state.aiLock || !state.model) { stopGestureScheduler(); return; }

      // A native clip is driving the rig right now. Nudging the pose target
      // here would make the engine ease the head toward a DIFFERENT place than
      // the clip is animating it — two writers on one parameter, which reads as
      // fighting/twitching. Stand down and re-check shortly after it ends.
      if (clipIsPlaying()) {
        const wait = Math.max(120, state.clipUntil - performance.now() + 80);
        state.gesture.timer = setTimeout(tick, wait);
        return;
      }

      const P = state.aiPose;
      const r = (a, b) => a + Math.random() * (b - a);
      // Pick a gesture "personality" each time, WEIGHTED by the currently
      // active emotion so idle drift stays consistent with what she's feeling
      // instead of being pure random noise. [t1, t2] = cutoffs for
      // [look-around, tilt/thinking, wiggle] shares of the roll.
      const MIX = {
        senang: [0.30, 0.55], kaget: [0.45, 0.60], malu: [0.20, 0.85],
        sedih:  [0.15, 0.90], normal: [0.45, 0.80],
      };
      const [t1, t2] = MIX[state.activeEmotion] || MIX.normal;
      const calm = (state.activeEmotion === 'sedih' || state.activeEmotion === 'malu') ? 0.55 : 1; // smaller amplitude when subdued
      const kind = Math.random();
      if (kind < t1) {
        // Look-around: a bigger head/eye sweep.
        P.ax = clamp((P.ax || 0) + r(-16, 16) * calm, -34, 34);
        P.ay = clamp((P.ay || 0) + r(-10, 10) * calm, -26, 26);
        P.ex = clamp((P.ex || 0) + r(-0.2, 0.2), -1, 1);
        P.ey = clamp((P.ey || 0) + r(-0.2, 0.2), -1, 1);
      } else if (kind < t2) {
        // Head tilt / thinking lean.
        P.ax = clamp((P.ax || 0) + r(-10, 10), -30, 30);
        P.ay = clamp((P.ay || 0) + r(-8, 8), -24, 24);
        if (state.caps.hasBody && roleId('bodyAngleX')) {
          P.bodyZ = clamp((P.bodyZ || 0) + r(-8, 8), -20, 20);
        } else {
          P.bodyZ = clamp((P.bodyZ || 0) + r(-6, 6), -30, 30);
        }
      } else {
        // Excited wiggle — a short burst of energy so she "vibrates" with glee.
        state.energyBoost = Math.min(1.2, state.energyBoost + 0.7);
        state.impulse = Math.min(1.3, state.impulse + 0.5);
        P.ax = clamp((P.ax || 0) + r(-12, 12), -34, 34);
        P.ay = clamp((P.ay || 0) + r(-7, 7), -26, 26);
      }
      // Occasionally play one of the model's own motion clips — but ONLY one
      // whose semantic verb matches her current emotion. Previously this picked
      // uniformly at random from every group the model shipped, which is why a
      // crying clip could fire mid-happy-sentence.
      //
      // Probability is deliberately below 1: native clips are strong, full-body
      // statements. Firing one on every tick reads as twitchy, so most ticks
      // stay with the subtle synthetic drift above.
      if (Math.random() < 0.35) {
        playEmotionClip(state.activeEmotion);
      }
      // A blink nudge for liveliness. Role space, so it works on any eyeOpen
      // convention (see pokeRoleNorm).
      if (Math.random() < 0.6) {
        try {
          pokeRoleNorm('eyeLOpen', 0); pokeRoleNorm('eyeROpen', 0);
          setTimeout(() => {
            pokeRoleNorm('eyeLOpen', 1); pokeRoleNorm('eyeROpen', 1);
          }, 130);
        } catch (e) {}
      }
      // Schedule next gesture at a randomized interval (organic, not metronomic).
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
