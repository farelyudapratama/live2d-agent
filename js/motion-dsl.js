/* motion-dsl.js — Motion Asset DSL: parse/validate/convert/evaluate (UMD)
 *
 * Bagian dari Motion Studio (docs/SPECIFICATION — Motion Studio & AI Motion
 * System.md §2/§7). Sebuah "Motion Asset" adalah definisi animasi semantik
 * yang model-independent: hanya menyebut nama field peran (ax/ay/bodyX/...),
 * BUKAN parameter mentah Cubism. Resolusi ke parameter asli tetap tugas
 * engine (roleId() di app.js), sama seperti gesture & directive yang ada.
 *
 * UMD agar bisa dipakai browser (window.MotionDSL) DAN di-require dari
 * server.js / test Node (pola yang sama dengan js/motion-taxonomy.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MotionDSL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Batas nilai per field semantik. HARUS identik dengan STEP_FIELD_BOUNDS di
  // js/app.js (whitelist gesture) dan batas ±30/±1 di applyActions() agent.js
  // — tiga jalur (preset gerak, directive LLM, motion asset) sengaja memakai
  // limit yang sama supaya tidak ada jalur yang "lebih longgar" secara diam-diam.
  // Duplikasi disengaja (bukan di-import) karena modul ini harus hidup tanpa app.js.
  const FIELD_BOUNDS = {
    ax: 30, ay: 30, bodyX: 30, bodyY: 30, bodyZ: 30,
    ex: 1, ey: 1, mouthForm: 1,
  };

  // Alias nama peran bergaya SPEC (§3: angleX/eyeX/...) → field internal yang
  // dipakai engine. Satu-satunya tempat pemetaan ini hidup, supaya format file
  // bisa memakai nama manapun tanpa menumbuhkan sistem penamaan kedua.
  const ROLE_ALIASES = {
    angleX: 'ax', angleY: 'ay',
    eyeX: 'ex', eyeY: 'ey',
    bodyX: 'bodyX', bodyY: 'bodyY', bodyZ: 'bodyZ',
    mouthForm: 'mouthForm',
  };

  // Kapabilitas yang boleh disebut di asset.requires. Dievaluasi runtime untuk
  // degrade-graceful (SPEC §23): track milik bagian yang tidak dimiliki model
  // dilewati, bukan dijalankan paksa.
  const KNOWN_REQUIRES = ['head', 'eyes', 'mouth', 'body'];

  // Batas struktural — cermin STEP_*_MAX di app.js untuk preset gerak, dengan
  // sedikit ruang lebih karena motion asset boleh lebih panjang dari gesture.
  const LIMITS = {
    idLen: 60, nameLen: 60, descLen: 400,
    tagLen: 30, tagsMax: 10,
    durationMin: 0.1, durationMax: 20,   // detik
    keysPerTrackMax: 64,
    // Raw Parameter Mode: satu gerakan wajar menyentuh belasan parameter
    // (kepala + badan + rambut + alis + tangan), jadi batas 8 dari mode semantik
    // lama akan memotong motion yang sah. 48 masih jauh di bawah beban render
    // (48 track × 64 key = 3072 angka; evaluasinya sepele) tapi tetap menutup
    // file yang dibuat untuk membanjiri loop.
    tracksMax: 48,
    cooldownMax: 600000,                  // ms
  };

  const INTERP_MODES = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'stepped'];

  // ── Dua jenis track ──────────────────────────────────────────────
  // 'role'  : field semantik (ax/ay/bodyZ/...) — delta di atas pose dasar,
  //           model-agnostic, dipakai gesture bawaan & motion lama.
  // 'param' : parameter Cubism MENTAH (ParamAngleX, ParamHairFront, ...) —
  //           nilai ABSOLUT dalam range asli parameter itu, terikat ke model
  //           tempat parameternya diambil (asset.sourceModelId).
  //
  // Keduanya hidup berdampingan dalam satu asset: motion lama tetap jalan tanpa
  // konversi, dan satu motion baru boleh mencampur keduanya bila perlu.
  const TRACK_KINDS = ['role', 'param'];

  // Batas nilai untuk track 'param' tidak bisa ditentukan di sini: range-nya
  // milik rig (0..100, -1..1, -30..30 — semuanya sah). Yang bisa dilakukan modul
  // ini hanyalah menolak nilai non-finite; clamp ke range sesungguhnya terjadi
  // di titik tulis (applyRawDrive di app.js, dari state.paramRange) dan di
  // editor saat user mengetik angka. Batas kasar di bawah hanya jaring pengaman
  // terhadap angka absurd yang jelas bukan nilai parameter Cubism.
  const PARAM_ABS_MAX = 1e6;

  function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  // Normalisasi nama track: terima field internal maupun alias SPEC. Return
  // field internal, atau null kalau tak dikenal — caller wajib menolak.
  function normalizeTarget(name) {
    if (typeof name !== 'string') return null;
    const k = name.trim();
    if (Object.prototype.hasOwnProperty.call(FIELD_BOUNDS, k)) return k;
    if (Object.prototype.hasOwnProperty.call(ROLE_ALIASES, k)) return ROLE_ALIASES[k];
    return null;
  }

  // ── Interpolasi keyframe ─────────────────────────────────────────
  // 'stepped' hanya jika user memilih eksplisit (SPEC §6: jangan snapping
  // mendadak kecuali diminta). Kurva ease standar cubic.
  function ease(t, mode) {
    switch (mode) {
      case 'stepped': return 0;                       // pegang nilai key sebelumnya
      case 'ease-in': return t * t * t;
      case 'ease-out': return 1 - Math.pow(1 - t, 3);
      case 'ease-in-out': return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      case 'linear':
      default: return t;
    }
  }

  // Nilai sebuah track pada waktu t (detik). Key terurut naik; sebelum key
  // pertama dan sesudah key terakhir nilai dipegang (clamp), sehingga track
  // yang tidak dimulai dari t=0 tetap halus.
  //
  // Easing dibaca dari key AWAL segmen bila ada (`key.easing`), jatuh ke
  // `track.interp` bila tidak — persis model Cubism Editor, di mana kurva
  // dimiliki oleh segmen antar dua key, bukan oleh seluruh track.
  function evalTrack(track, t) {
    const keys = track.keys;
    if (!keys.length) return 0;
    if (t <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (t >= last.t) return last.v;
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i].t) {
        const a = keys[i - 1], b = keys[i];
        const span = b.t - a.t;
        const mode = a.easing || track.interp || 'linear';
        const f = span <= 0 ? 1 : ease((t - a.t) / span, mode);
        return a.v + (b.v - a.v) * f;
      }
    }
    return last.v;
  }

  // Evaluasi seluruh asset pada waktu t.
  //
  // Mengembalikan DUA hal yang sengaja dipisah karena semantiknya berbeda:
  //   roles  : delta per field semantik (relatif ke pose dasar) — di-clamp ke
  //            FIELD_BOUNDS dan diskalakan intensity, seperti gesture.
  //   params : nilai ABSOLUT per parameter Cubism mentah — TIDAK diskalakan
  //            intensity dan TIDAK di-clamp di sini. Menskalakan nilai absolut
  //            dengan intensity itu salah: "ParamHairFront = 0.5 × 0.8" bukan
  //            "gerakan yang lebih halus", melainkan pose yang berbeda, dan pada
  //            rig ber-range 10..20 hasilnya keluar range sama sekali. Clamp ke
  //            range asli dilakukan di titik tulis (applyRawDrive di app.js),
  //            satu-satunya tempat yang tahu range rig yang sedang dimuat.
  //
  // `supports` (Set kapabilitas) menyaring track role; `ownedParams` (Set id
  // parameter milik model) menyaring track param — id yang tak dimiliki model
  // ini dilewati dengan aman, bukan bikin error (motion model-scoped di model lain).
  function evaluateAsset(asset, t, intensity, supports, ownedParams) {
    const roles = {};
    const params = {};
    const inten = isFiniteNum(intensity) ? clampNum(intensity, 0, 1) : (asset.intensity ? asset.intensity.default : 0.8);
    for (const track of asset.tracks || []) {
      const tt = Math.max(0, t);
      if (track.kind === 'param') {
        const id = typeof track.param === 'string' ? track.param : null;
        if (!id) continue;
        if (ownedParams && ownedParams.size && !ownedParams.has(id)) continue;
        params[id] = evalTrack(track, tt);
        continue;
      }
      const target = normalizeTarget(track.target);
      if (!target) continue;
      if (supports && supports.size && !supports.has(fieldCapability(target))) continue;
      const scale = isFiniteNum(track.intensityScale) ? clampNum(track.intensityScale, 0, 2) : 1;
      roles[target] = clampNum(evalTrack(track, tt) * inten * scale,
        -FIELD_BOUNDS[target], FIELD_BOUNDS[target]);
    }
    // Bentuk lama (objek delta polos) tetap dikembalikan lewat spread supaya
    // pemanggil lama — dan test yang membaca `.ax` langsung — tidak patah.
    return Object.assign({}, roles, { __roles: roles, __params: params });
  }

  // Field → nama kapabilitas (untuk requires/degrade).
  function fieldCapability(field) {
    if (field === 'ax' || field === 'ay') return 'head';
    if (field === 'ex' || field === 'ey') return 'eyes';
    if (field === 'mouthForm') return 'mouth';
    return 'body';
  }

  // ── Konversi dua-arah dengan format preset 'gerak' ───────────────
  // steps [{d:{field:delta}, ms}] → tracks (kumulatif t dalam detik).
  //
  // Semantik yang dipertahankan dari playGesture() lama: di SETIAP batas step,
  // semua field yang pernah disentuh di-set ke base + (d[k]||0) — termasuk
  // kembali ke 0 di step yang tidak menyebutnya (step kosong = "pulang ke
  // base"). Karena itu konversi memunculkan key v=0 untuk field lama di step
  // berikutnya, dan key duplikat berurutan dibuang supaya track tetap ramping.
  function stepsToTracks(steps) {
    const touched = [];        // urutan field pertama kali disentuh
    const vals = {};           // field -> nilai target saat ini
    const keysByField = {};
    let t = 0;
    for (const step of (steps || [])) {
      const d = (step && step.d) || {};
      const ms = (step && step.ms) || 0;
      const mentioned = new Set();
      for (const k in d) {
        const target = normalizeTarget(k);
        if (!target || !isFiniteNum(d[k])) continue;
        if (!(target in vals)) { touched.push(target); vals[target] = 0; keysByField[target] = []; }
        vals[target] = d[k];
        mentioned.add(target);
      }
      // Field lama yang TIDAK disebut step ini kembali ke 0 — persis
      // P[k] = base[k] + (d[k]||0) di playGesture() lama.
      for (const f of touched) if (!mentioned.has(f)) vals[f] = 0;
      if (ms > 0 && touched.length) {
        const tt = +(t / 1000).toFixed(3);
        for (const f of touched) {
          const v = +(vals[f] || 0).toFixed(3);
          const keys = keysByField[f];
          if (keys.length && keys[keys.length - 1].v === v) continue;   // nilainya sama: skip
          keys.push({ t: tt, v });
        }
        t += ms;
      }
    }
    return Object.keys(keysByField).map(target => ({ target, interp: 'linear', keys: keysByField[target] }));
  }

  // tracks → steps preset 'gerak' (dipakai kalau user ingin memakai motion
  // asset sebagai preset gerak biasa). Sampling kasar per 100ms — cukup untuk
  // kompatibilitas, bukan jalur utama.
  function tracksToSteps(asset, sampleMs) {
    const step = Math.max(40, sampleMs || 100);
    const dur = assetDurationMs(asset);
    const out = [];
    const fields = (asset.tracks || []).map(tr => normalizeTarget(tr.target)).filter(Boolean);
    for (let t = 0; t < dur; t += step) {
      const vals = evaluateAsset(asset, t / 1000, 1, null);
      const d = {};
      for (const f of fields) if (vals[f] != null) d[f] = +vals[f].toFixed(2);
      out.push({ d, ms: Math.min(step, dur - t) });
    }
    return out.length ? out : [{ d: {}, ms: step }];
  }

  function assetDurationMs(asset) {
    let maxT = 0;
    for (const tr of asset.tracks || []) for (const k of tr.keys || []) if (k.t > maxT) maxT = k.t;
    return Math.max((asset.duration || 0) * 1000, maxT * 1000, 200);
  }

  // ── Sanitasi / validasi asset ────────────────────────────────────
  // Satu pintu untuk SEMUA sumber motion: file user (POST /api/motions),
  // hasil generate AI (fase 7), dan import. Mengembalikan {ok, asset} atau
  // {ok:false, errors:[...]} — tidak lempar exception, karena caller-nya
  // handler HTTP yang ingin daftar masalah, bukan stack trace.
  function sanitizeMotionAsset(raw, opts) {
    const errors = [];
    const o = opts || {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, errors: ['bukan objek motion'] };
    }

    const id = String(raw.id || '').trim();
    if (!/^[A-Za-z0-9_\-]{1,60}$/.test(id)) errors.push('id tidak valid (1-60 karakter alfanumerik/_/-)');

    const name = String(raw.name || id).trim().slice(0, LIMITS.nameLen);

    let tags = [];
    if (raw.tags != null) {
      if (!Array.isArray(raw.tags)) errors.push('tags harus array');
      else tags = raw.tags.slice(0, LIMITS.tagsMax).map(t => String(t).trim().toLowerCase().slice(0, LIMITS.tagLen)).filter(Boolean);
    }

    let duration = Number(raw.duration);
    if (!isFiniteNum(duration) || duration < LIMITS.durationMin) duration = 1;
    duration = Math.min(duration, LIMITS.durationMax);

    let intensity = { min: 0.3, max: 1.0, default: 0.8 };
    if (raw.intensity && typeof raw.intensity === 'object') {
      const mn = isFiniteNum(raw.intensity.min) ? clampNum(raw.intensity.min, 0, 1) : 0.3;
      const mx = isFiniteNum(raw.intensity.max) ? clampNum(raw.intensity.max, 0, 1) : 1.0;
      const df = isFiniteNum(raw.intensity.default) ? clampNum(raw.intensity.default, 0, 1) : 0.8;
      intensity = { min: Math.min(mn, mx), max: Math.max(mn, mx), default: clampNum(df, Math.min(mn, mx), Math.max(mn, mx)) };
    }

    let emotionCompatibility = {};
    if (raw.emotionCompatibility && typeof raw.emotionCompatibility === 'object') {
      for (const [emo, v] of Object.entries(raw.emotionCompatibility)) {
        if (!isFiniteNum(v)) continue;
        emotionCompatibility[String(emo).slice(0, 30)] = clampNum(v, 0, 1);
      }
    }

    let cooldown = Number(raw.cooldown);
    if (!isFiniteNum(cooldown) || cooldown < 0) cooldown = 0;
    cooldown = Math.min(cooldown, LIMITS.cooldownMax);

    let priority = Number(raw.priority);
    if (!isFiniteNum(priority)) priority = 60;
    priority = clampNum(Math.round(priority), 0, 100);

    const requires = (Array.isArray(raw.requires) ? raw.requires : [])
      .map(r => String(r).trim().toLowerCase())
      .filter(r => KNOWN_REQUIRES.includes(r));

    // Track + keyframe: bagian paling rawan sampah (file bisa di-edit tangan,
    // dan generate-AI mengirimkan hasil LLM). Dua jenis track ditangani di sini:
    //   kind 'role'  → nilai di-clamp ke FIELD_BOUNDS (delta semantik)
    //   kind 'param' → nilai dibiarkan apa adanya (absolut, range milik rig);
    //                  hanya non-finite dan angka absurd yang ditolak
    // Timestamp di luar [0, duration] dibuang, key duplikat waktu digabung.
    const seen = new Set();
    const tracks = [];
    if (raw.tracks != null) {
      if (!Array.isArray(raw.tracks)) errors.push('tracks harus array');
      else {
        for (const tr of raw.tracks.slice(0, LIMITS.tracksMax)) {
          // Jenis track ditentukan dari isinya, bukan dari field `kind` yang
          // bisa hilang: track dengan `param` adalah raw parameter, sisanya
          // peran semantik. Ini juga yang membuat motion lama (tanpa `kind`)
          // terbaca benar tanpa migrasi file.
          const isParam = !!(tr && typeof tr.param === 'string' && tr.param.trim());
          let target = null, paramId = null, seenKey = null;
          if (isParam) {
            paramId = tr.param.trim().slice(0, 120);
            seenKey = 'param:' + paramId;
          } else {
            target = normalizeTarget(tr && tr.target);
            if (!target) { errors.push('track target tidak dikenal: ' + (tr && tr.target)); continue; }
            seenKey = 'role:' + target;
          }
          if (seen.has(seenKey)) continue;   // track kedua untuk sasaran sama: buang
          seen.add(seenKey);
          const bound = isParam ? PARAM_ABS_MAX : FIELD_BOUNDS[target];
          const label = isParam ? paramId : target;
          const keys = [];
          for (const k of ((tr && tr.keys) || []).slice(0, LIMITS.keysPerTrackMax)) {
            const t = Number(k && k.t);
            const v = Number(k && k.v);
            if (!isFiniteNum(t) || !isFiniteNum(v)) { errors.push('keyframe non-numerik di ' + label); continue; }
            if (t < 0 || t > duration + 0.001) continue;
            const key = { t: +t.toFixed(3), v: clampNum(v, -bound, bound) };
            // Easing PER KEY (Cubism-style): kalau ada, ia menang atas interp
            // level track untuk segmen yang dimulai di key ini.
            if (INTERP_MODES.includes(k && k.easing)) key.easing = k.easing;
            keys.push(key);
          }
          keys.sort((a, b) => a.t - b.t);
          // Gabungkan key dengan timestamp identik (nilai terakhir menang).
          const merged = [];
          for (const k of keys) {
            if (merged.length && merged[merged.length - 1].t === k.t) merged[merged.length - 1] = k;
            else merged.push(k);
          }
          if (merged.length) {
            const interp = INTERP_MODES.includes(tr.interp) ? tr.interp : 'linear';
            const intensityScale = isFiniteNum(tr.intensityScale) ? clampNum(tr.intensityScale, 0, 2) : undefined;
            if (isParam) {
              // Range asli parameter DISIMPAN bersama track (bila editor
              // mengirimkannya) supaya editor bisa menampilkan slider yang benar
              // tanpa harus punya model sumbernya, dan supaya nilai lama tetap
              // bisa dibaca konteksnya saat motion dibuka di model berbeda.
              const t = { kind: 'param', param: paramId, interp, keys: merged };
              if (isFiniteNum(tr.min) && isFiniteNum(tr.max)) { t.min = Number(tr.min); t.max = Number(tr.max); }
              if (typeof tr.label === 'string' && tr.label.trim()) t.label = tr.label.trim().slice(0, 80);
              tracks.push(t);
            } else {
              tracks.push(intensityScale != null
                ? { kind: 'role', target, interp, intensityScale, keys: merged }
                : { kind: 'role', target, interp, keys: merged });
            }
          }
        }
      }
    }

    // Motion user wajib punya minimal satu track — tanpa itu tidak ada yang
    // bisa diputar. Aset builtin/native boleh tanpa track (diputar via jalur
    // engine sendiri), jadi ceknya hanya untuk source 'user'.
    if (o.requireTracks && !tracks.length) errors.push('minimal satu track keyframe diperlukan');

    if (errors.length) return { ok: false, errors };

    const asset = {
      version: 1,
      id, name,
      description: String(raw.description || '').trim().slice(0, LIMITS.descLen),
      tags,
      source: raw.source || o.source || 'user',
      type: raw.type || (tracks.length ? 'keyframe' : 'gesture'),
      duration: +duration.toFixed(3),
      loop: !!raw.loop,
      intensity,
      emotionCompatibility,
      cooldown, priority,
      aiEnabled: raw.aiEnabled !== false,
      requires,
      tracks,
    };
    // Motion yang memuat track parameter mentah TERIKAT ke model asalnya:
    // 'ParamHairFront' di satu rig bisa tidak ada — atau berarti lain — di rig
    // berikutnya. sourceModelId dicatat supaya editor & runtime tahu harus
    // mencocokkan per nama dan melewati yang tak cocok, bukan menebak.
    const hasParamTrack = tracks.some(t => t.kind === 'param');
    const srcModel = String(raw.sourceModelId || o.sourceModelId || '').trim().slice(0, 200);
    if (srcModel) asset.sourceModelId = srcModel;
    if (hasParamTrack) asset.modelScoped = true;

    return { ok: true, asset };
  }

  // Ubah track semantik (8 field) menjadi track parameter mentah memakai peta
  // peran→id milik model yang sedang dimuat. Inilah migrasi motion lama ke
  // Raw Parameter Mode: satu-satunya cara menerjemahkan `ax` menjadi angka yang
  // rig ini pahami adalah lewat peta yang sama dengan yang dipakai engine saat
  // render, jadi peta itu di-INJECT dari app.js (roleIds + range) alih-alih
  // ditebak ulang di sini.
  //
  // Delta semantik berskala referensi ±30 / ±1 diproyeksikan ke range asli
  // parameter, sama seperti toActual() di app.js — kalau tidak, delta 8 derajat
  // akan ditulis apa adanya ke rig ber-range 0..1 dan pose meledak.
  //
  // Track peran yang tidak punya padanan di model ini DIBIARKAN apa adanya
  // (tetap kind 'role'), bukan dibuang: motion tetap utuh dan tetap berfungsi
  // di model lain yang punya peran itu.
  function rolesToParamTracks(asset, roleMap, ranges) {
    if (!asset || !Array.isArray(asset.tracks)) return asset;
    const REF_HALF = 30;   // sama dengan REF_HALF di app.js
    const out = [];
    for (const tr of asset.tracks) {
      if (tr.kind === 'param' || !tr.target) { out.push(tr); continue; }
      const role = ROLE_FOR_FIELD[tr.target];
      const id = role && roleMap ? roleMap[role] : null;
      const range = id && ranges ? ranges[id] : null;
      if (!id || !range || !isFiniteNum(range.min) || !isFiniteNum(range.max)) {
        out.push(tr);
        continue;
      }
      const half = FIELD_BOUNDS[tr.target] === 1 ? 1 : REF_HALF;
      const def = isFiniteNum(range.def) ? range.def : (range.min + range.max) / 2;
      const keys = tr.keys.map(k => {
        // Delta referensi → fraksi (-1..1) → offset dalam range asli, dari default.
        const frac = clampNum(k.v / half, -1, 1);
        const span = frac >= 0 ? (range.max - def) : (def - range.min);
        const key = { t: k.t, v: +(def + frac * span).toFixed(4) };
        if (k.easing) key.easing = k.easing;
        return key;
      });
      out.push({
        kind: 'param', param: id, interp: tr.interp || 'linear', keys,
        min: range.min, max: range.max,
        label: tr.target,
      });
    }
    return Object.assign({}, asset, { tracks: out, modelScoped: out.some(t => t.kind === 'param') });
  }

  // field semantik → nama peran yang dipakai roleIds/state.caps.ids.
  const ROLE_FOR_FIELD = {
    ax: 'angleX', ay: 'angleY',
    ex: 'eyeBallX', ey: 'eyeBallY',
    bodyX: 'bodyAngleX', bodyY: 'bodyAngleY', bodyZ: 'bodyAngleZ',
    mouthForm: 'mouthForm',
  };

  // Ringkasan ringkas untuk katalog LLM (SPEC §19) — id, deskripsi, tag, dan
  // emosi yang kompatibel (skor >= 0.5), TANPA keyframe: prompt harus tetap
  // pendek dan LLM tidak boleh diberi kesan bisa mengedit angka.
  function summaryForLLM(asset) {
    const compatible = Object.entries(asset.emotionCompatibility || {})
      .filter(([, v]) => v >= 0.5).map(([k]) => k);
    return {
      id: asset.id,
      description: asset.description || asset.name,
      tags: asset.tags || [],
      compatibleEmotions: compatible,
      source: asset.source,
      duration: asset.duration,
    };
  }

  return {
    FIELD_BOUNDS, ROLE_ALIASES, KNOWN_REQUIRES, LIMITS, INTERP_MODES,
    TRACK_KINDS, ROLE_FOR_FIELD, PARAM_ABS_MAX,
    normalizeTarget, ease, evalTrack, evaluateAsset, fieldCapability,
    stepsToTracks, tracksToSteps, assetDurationMs,
    rolesToParamTracks,
    sanitizeMotionAsset, summaryForLLM,
  };
});
