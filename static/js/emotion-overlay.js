/* emotion-overlay.js — efek emosi app-level (overlay visual) ─────────────
 *
 * KENAPA ADA
 * Sebagian efek rig hanya hidup di proyek Cubism Editor — di moc3 hasil
 * ekspor binding-nya tidak ada. Contoh terukur lumine: 'heart eye',
 * 'blush', 'tear', 'Sparkling eye', 'sweat', 'dizzy' (label cdi3 rigger
 * mengonfirmasi semuanya efek overlay; kalibrasi efek mengukurnya
 * 0 piksel — identik di rig v4.2, hasil import web, maupun salinan
 * langsung rig sumber v5.0, dengan core 4.2 maupun resmi 5.1). Modul
 * ini menggambar efeknya sendiri di atas stage saat ekspresi/emosi
 * yang cocok dipasang, sehingga ekspresi tetap TERLIHAT tanpa
 * memodifikasi rig.
 *
 * MODEL-AGNOSTIC
 * Dicocokkan dari NAMA ekspresi/emosi (kanonik + alias Indonesia),
 * bukan id parameter; posisi mengikuti kepala model dari bounds layar
 * (kepala ≈ 16% tinggi model) — bukan dari nama/range parameter
 * tertentu. Tidak ada satu pun id rig yang di-hardcode.
 *
 * API: window.__emotionOverlay
 *   .onExpression(name) — cocokkan nama & nyalakan efek (app.js memanggil
 *     ini di titik ekspresi dipasang; 'user:' prefix ditangani)
 *   .clear()            — hentikan semua efek (resetEmotion memanggil)
 *   ._status()          — debug: { active, key, particles }
 *   ._tick(now)         — loop animasi; diekspos agar pengujian headless
 *                         bisa memompa manual (rAF hanya jalan saat aktif)
 *
 * KONFIGURASI: data/config.json → "overlay": { enabled, alpha, size }
 * (dibaca app.js loadAppConfig → window.__overlayCfg; tanpa key itu =
 * enabled, alpha 0.9, size 1).
 */
(function () {
  'use strict';
  if (window.__emotionOverlay) return;

  // ── Tabel efek ──────────────────────────────────────────────────
  // emoji: daftar karakter yang diputar untuk partikel (null = digambar
  // Graphics). dur: lama efek aktif (ms). spawnEvery: interval spawn
  // partikel (0 = sekali di awal).
  var EFFECTS = {
    heart:   { emoji: ['💗', '💜', '💖', '💙'], dur: 3600, spawnEvery: 380 },
    blush:   { emoji: null,                     dur: 3200, spawnEvery: 0 },
    sparkle: { emoji: ['✨', '⭐', '🌟'],        dur: 3200, spawnEvery: 340 },
    tear:    { emoji: ['💧'],                    dur: 2800, spawnEvery: 640 },
    sweat:   { emoji: ['💦'],                    dur: 2200, spawnEvery: 0 },
    dizzy:   { emoji: ['💫', '🌀'],              dur: 3200, spawnEvery: 300 },
    anger:   { emoji: ['💢'],                    dur: 2000, spawnEvery: 0 },
    shock:   { emoji: ['❗'],                    dur: 1500, spawnEvery: 0 },
  };

  // ── Pemetaan nama → efek (kanonik + alias, pakai contains) ──────
  // Urutan = prioritas pencocokan. Nama datang dari banyak sumber:
  // emosi bawaan ('malu','senang',…), file .exp3 rigger ('exp_heart',…),
  // preset user ('user:malu'). Bukan match eksak — nama rig tiap model
  // berbeda, jadi contains pada alias adalah kontrak sengaja dipilih.
  var ALIASES = [
    ['heart',   ['heart', 'cinta', 'love', 'sayang']],
    ['blush',   ['blush', 'malu']],
    ['tear',    ['tear', 'nangis', 'menangis', 'sedih', 'sad']],
    ['sweat',   ['sweat', 'keringat', 'panik', 'gugup', 'deg-degan']],
    ['sparkle', ['sparkl', 'senang', 'tersenyum', 'senyum', 'seneng', 'kagum', 'excited']],
    ['dizzy',   ['dizzy', 'pusing', 'bingung']],
    ['anger',   ['angry', 'marah', 'kesal', 'jengkel', 'murka']],
    ['shock',   ['kaget', 'shock', 'terkejut', 'gaspet']],
  ];

  // MURNI — dipakai guard test (vm), tidak menyentuh DOM.
  function resolveEmotionFx(name) {
    if (!name || typeof name !== 'string') return null;
    var n = String(name).toLowerCase().replace(/^user:/, '').trim();
    if (!n || n === 'normal' || n === 'default') return null;
    for (var i = 0; i < ALIASES.length; i++) {
      var key = ALIASES[i][0], list = ALIASES[i][1];
      for (var j = 0; j < list.length; j++) {
        if (n.indexOf(list[j]) !== -1) return { key: key, dur: EFFECTS[key].dur };
      }
    }
    return null;
  }

  // ── State ───────────────────────────────────────────────────────
  var container = null;        // DOM overlay container (atau null bila tidak aktif)
  var particles = [];          // { obj, kind, born, dur, x, y, vx, vy, seed, emojiIdx }
  var current = null;          // { key, until, lastSpawn }
  var rafId = null;
  var cfg = function () {
    var o = window.__overlayCfg || {};
    return {
      enabled: o.enabled !== false,
      alpha: (typeof o.alpha === 'number') ? o.alpha : 0.9,
      size: (typeof o.size === 'number') ? o.size : 1,
    };
  };

  function model() {
    var st = window.__l2dDebug && window.__l2dDebug.state;
    return (st && st.model) ? st.model : null;
  }
  // Anchor kepala DIUKUR dari framebuffer, bukan dari bounds — bounds tekstur
  // sering memuat area kosong besar di atas kepala (padding texture atlas +
  // framing upper-body), sehingga fraksi tinggi bounds mendarat di ruang
  // hampa (terbukti: hati melayang ~250px di atas kepala lumine). Yang
  // diukur: baris piksel ter-atas yang benar-benar tergambar = puncak rambut;
  // cx = pusat massa piksel pada pita atas itu; tinggi konten terlihat
  // ── R7-2: jalur produksi ──────────────────────────────────────
  // renderer scene-graph legacy digantikan host.measureLitBounds()
  // (readPixels) + partikel DOM. R9-6-4: pixi-live2d/Pixi6 dihapus —
  // hanya jalur produksi yang tersisa.
  function isProd() {
    return !!(window.__live2dApi && !window.__live2dApi.isStub &&
              window.__l2dDebug && window.__l2dDebug.host);
  }
  var prodOverlayEl = null;
  function prodGetOverlay() {
    if (prodOverlayEl && document.body.contains(prodOverlayEl)) return prodOverlayEl;
    var canvas = document.getElementById('live2d-canvas');
    if (!canvas) return null;
    prodOverlayEl = document.createElement('div');
    prodOverlayEl.className = 'l2d-emoji-overlay';
    prodOverlayEl.style.cssText =
      'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:4;';
    (canvas.parentElement || document.body).appendChild(prodOverlayEl);
    prodOverlayEl.style.width = canvas.clientWidth + 'px';
    prodOverlayEl.style.height = canvas.clientHeight + 'px';
    return prodOverlayEl;
  }
  function domSprite(el) {
    return {
      el: el,
      get x() { return this._x || 0; },
      set x(v) { this._x = v; el.style.left = v + 'px'; },
      get y() { return this._y || 0; },
      set y(v) { this._y = v; el.style.top = v + 'px'; },
      get alpha() { return this._a === undefined ? 0 : this._a; },
      set alpha(v) { this._a = v; el.style.opacity = String(Math.max(0, Math.min(1, v))); },
      scale: {
        set(v) { el.style.transform = 'scale(' + v + ')'; },
      },
      destroy() { el.remove(); },
    };
  }
  function prodMeasureHead() {
    var host = window.__l2dDebug && window.__l2dDebug.host;
    if (!host || !host.measureLitBounds) return null;
    var b = host.measureLitBounds();
    if (!b) return null;
    var ci = host.compositeInfo ? host.compositeInfo() : null;
    var s = ci && ci.cubPixels.width ? ci.canvasCss.width / ci.cubPixels.width : 1;
    return {
      cx: b.topCentroidX * s,
      headY: b.minY * s,
      h: Math.max(64, b.height * s),
      w: Math.max(64, b.width * s),
    };
  }

  // (bawah-atas) dipakai sebagai satuan h. Hasil di-cache per aktivasi —
  // satu kali render kecil per fire ekspresi, bukan per partikel.
  var _anchorCache = null;   // { cx, headY, h, w, at, path }
  function measureHead() {
    if (isProd()) return prodMeasureHead();
    return null;
  }
  function headAnchor() {
    try {
      var now = performance.now();
      if (_anchorCache && now - _anchorCache.at < 5000 && _anchorCache.path === (window.__l2dDebug.state.modelPath || '')) {
        return _anchorCache;
      }
      var a = measureHead();
      if (!a) {
        // fallback lama (bounds) bila pengukuran gagal — lebih baik sedikit
        // meleset daripada tidak ada efek sama sekali.
        var m = model();
        if (!m) return null;
        a = { cx: m.x + m.width * 0.5, headY: m.y + m.height * 0.16, h: m.height, w: m.width };
      }
      a = { cx: a.cx, headY: a.headY, h: a.h, w: a.w, at: now, path: (window.__l2dDebug.state.modelPath || '') };
      _anchorCache = a;
      return a;
    } catch (e) { return null; }
  }

  function makeSprite(kind, i, cfgv, a) {
    var def = EFFECTS[kind];
    var el;
    if (def.emoji) {
      var idx2 = (i + Math.floor(Math.random() * def.emoji.length)) % def.emoji.length;
      el = document.createElement('span');
      el.textContent = def.emoji[idx2];
      el.style.cssText = 'position:absolute;font-size:' +
        Math.max(18, Math.round(a.w * 0.05 * cfgv.size)) + 'px;user-select:none;';
    } else {
      var r = Math.max(8, a.w * 0.032 * cfgv.size);
      el = document.createElement('div');
      el.style.cssText = 'position:absolute;width:' + (r * 2.7).toFixed(0) +
        'px;height:' + (r * 1.5).toFixed(0) + 'px;background:rgba(255,158,194,0.55);' +
        'border-radius:50%;';
    }
    el.style.opacity = '0';
    prodGetOverlay() && prodGetOverlay().appendChild(el);
    return domSprite(el);
  }

  function spawnParticle(kind, i, cfgv) {
    var a = headAnchor();
    if (!a) return;
    var obj = makeSprite(kind, i, cfgv, a);
    var p = {
      obj: obj, kind: kind, born: performance.now(),
      seed: Math.random() * Math.PI * 2, emojiIdx: i,
      x: a.cx, y: a.headY, vx: 0, vy: 0,
    };
    if (kind === 'heart') {
      p.x = a.cx + (Math.random() - 0.5) * a.w * 0.24;
      p.y = a.headY - a.h * (0.02 + Math.random() * 0.04);
      p.vy = -a.h * 0.055;               // naik
    } else if (kind === 'blush') {
      p.x = a.cx + (i === 0 ? -1 : 1) * a.w * 0.058;
      p.y = a.headY + a.h * 0.055;
    } else if (kind === 'sparkle') {
      var ang = p.seed;
      p.x = a.cx + Math.cos(ang) * a.w * 0.26;
      p.y = a.headY - a.h * 0.06 + Math.sin(ang) * a.h * 0.07;
    } else if (kind === 'tear') {
      p.x = a.cx + (i % 2 === 0 ? -1 : 1) * a.w * 0.05;
      p.y = a.headY + a.h * 0.045;
      p.vy = a.h * 0.03;                 // jatuh pelan, dipercepat di update
    } else if (kind === 'sweat') {
      p.x = a.cx + a.w * 0.075;
      p.y = a.headY - a.h * 0.025;
      p.vy = a.h * 0.02;
    } else if (kind === 'dizzy') {
      p.x = a.cx;
      p.y = a.headY - a.h * 0.05;
    } else if (kind === 'anger' || kind === 'shock') {
      p.x = a.cx + (Math.random() - 0.5) * a.w * 0.1;
      p.y = a.headY - a.h * 0.09;
    }
    p.obj.x = p.x; p.obj.y = p.y;
    particles.push(p);
  }

  // Satu frame animasi. now = performance.now(). Dipanggil dari rAF
  // internal (saat efek aktif) atau manual (pengujian headless).
  function tick(now) {
    if (!container) return;
    var cfgv = cfg();
    if (!cfgv.enabled) return;
    var a = headAnchor();
    if (!a) return;
    var dead = [];
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var t = (now - p.born) / 1000;
      var prog = Math.min(1, (now - p.born) / (current ? current.dur : 2200));
      var k = p.kind;
      if (k === 'heart') {
        p.obj.y = p.y + p.vy * t;
        p.obj.x = p.x + Math.sin(t * 2.2 + p.seed) * a.w * 0.02;
        p.obj.alpha = (prog < 0.15 ? prog / 0.15 : 1 - (prog - 0.15) / 0.85) * cfgv.alpha;
        p.obj.scale.set(cfgv.size * (0.85 + 0.15 * Math.sin(t * 3 + p.seed)));
      } else if (k === 'blush') {
        p.obj.alpha = (prog < 0.1 ? prog / 0.1 : prog > 0.8 ? (1 - prog) / 0.2 : 1) * cfgv.alpha * 0.9;
      } else if (k === 'sparkle') {
        p.obj.x = p.x + Math.sin(t * 1.6 + p.seed) * a.w * 0.015;
        p.obj.y = p.y + Math.cos(t * 1.3 + p.seed) * a.h * 0.012;
        p.obj.alpha = Math.max(0, Math.sin(t * 4 + p.seed)) * cfgv.alpha;
        p.obj.scale.set(cfgv.size * (0.7 + 0.3 * Math.sin(t * 5 + p.seed)));
      } else if (k === 'tear') {
        p.vy += a.h * 0.0007 * 1000 * 0.016 * 60 * 0.016; // gravitasi lembut
        p.obj.y = p.y + p.vy * t + 0.5 * a.h * 0.35 * t * t;
        p.obj.x = p.x;
        p.obj.alpha = (1 - prog) * cfgv.alpha;
      } else if (k === 'sweat') {
        p.obj.y = p.y + p.vy * t * t * 2.2;
        p.obj.alpha = (1 - prog) * cfgv.alpha;
        p.obj.scale.set(cfgv.size * (1 + 0.4 * prog));
      } else if (k === 'dizzy') {
        var orb = t * 2.6 + p.seed;
        p.obj.x = a.cx + Math.cos(orb) * a.w * 0.13;
        p.obj.y = a.headY - a.h * 0.05 + Math.sin(orb * 2) * a.h * 0.02;
        p.obj.alpha = (1 - prog) * cfgv.alpha;
      } else if (k === 'anger' || k === 'shock') {
        var pop = Math.min(1, t / 0.18);
        p.obj.scale.set(cfgv.size * (0.4 + 0.6 * (1 + 0.25 * Math.sin(pop * Math.PI)) * pop));
        p.obj.alpha = (1 - prog) * cfgv.alpha;
      }
      if (prog >= 1) dead.push(i);
    }
    for (var d = dead.length - 1; d >= 0; d--) {
      var idx = dead[d];
      var q = particles[idx];
      if (q.obj.destroy) q.obj.destroy();
      particles.splice(idx, 1);
    }
    // spawn lanjutan selama efek masih aktif
    if (current && now < current.until) {
      var def = EFFECTS[current.key];
      if (def.spawnEvery > 0 && now - current.lastSpawn >= def.spawnEvery) {
        current.lastSpawn = now;
        spawnParticle(current.key, Math.floor(Math.random() * 4), cfgv);
      }
    }
    // selesai: semua partikel mati & window habis
    if (!particles.length && (!current || now >= current.until + 400)) {
      container.removeChildren();
      current = null;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    }
  }

  function loop() {
    tick(performance.now());
    if (rafId !== null) rafId = requestAnimationFrame(loop);
  }

  function attach() {
    if (isProd()) {
      if (container) return container;
      var ov = prodGetOverlay();
      if (!ov) return null;
      container = {
        addChild: function (obj) { ov.appendChild(obj.el || obj); },
        removeChildren: function () { ov.innerHTML = ''; },
      };
      return container;
    }
    return null;
  }

  // ── API publik ──────────────────────────────────────────────────
  window.__emotionOverlay = {
    // Dipanggil app.js di titik ekspresi dipasang (semua mode: universal,
    // .exp3 native, synthetic) — nama apa pun, yang tak cocok diabaikan.
    onExpression: function (name) {
      var cfgv = cfg();
      if (!cfgv.enabled) return;
      var fx = resolveEmotionFx(name);
      var now = performance.now();
      if (!fx) { this.clear(); return; }
      if (!container) attach();
      if (!container) return;
      var def = EFFECTS[fx.key];
      if (current && current.key === fx.key) {
        current.until = now + def.dur;      // perpanjang, jangan numpuk
        return;
      }
      current = { key: fx.key, until: now + def.dur, lastSpawn: now - def.spawnEvery, dur: def.dur };
      var counts = { heart: 3, blush: 2, sparkle: 4, tear: 1, sweat: 1, dizzy: 3, anger: 1, shock: 1 };
      var n = counts[fx.key] || 1;
      for (var i = 0; i < n; i++) spawnParticle(fx.key, i, cfgv);
      if (rafId === null) rafId = requestAnimationFrame(loop);
    },
    clear: function () {
      current = null;
      for (var i = 0; i < particles.length; i++) {
        if (particles[i].obj.destroy) particles[i].obj.destroy();
      }
      particles = [];
      if (container) container.removeChildren();
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    },
    _status: function () {
      return { active: !!current, key: current ? current.key : null, particles: particles.length, attached: !!container };
    },
    _tick: function (now) { tick(now || performance.now()); },
    _resolve: resolveEmotionFx,          // ekspos untuk guard test
  };

  console.log('emotion-overlay: siap (efek app-level untuk ekspresi yang rig-nya tidak mengikat art)');
})();
