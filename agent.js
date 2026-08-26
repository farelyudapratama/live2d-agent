/* agent.js — the "brain" glue (browser side)
 * - keeps a short conversation history
 * - calls the local server proxy /api/chat (which holds the API key)
 * - feeds the reply to window.__live2dAgent.speak()
 * - FULL AI CONTROL: emotion, head, eyes, mouth, body, accessories, properties
 * - supports MULTI-SEGMENT action blocks for long dialogs
 * - SMART FALLBACK: infers movement from emotion when no action blocks
 * The actual LLM key never leaves the local server.
 */
(function () {
  const HISTORY_LIMIT = 12;
  const history = [];
  let busy = false;

  // ── Capability profile ──
  let capProfile = null;

  async function loadCapabilityProfile() {
    if (!window.__live2dAgent || !window.__live2dAgent.getCapabilityProfile) return;
    capProfile = await window.__live2dAgent.getCapabilityProfile();
    console.log('[agent] capability profile loaded:', capProfile);
  }

  // ── Build system prompt with FULL capability context ──
  function buildSystemPrompt(basePrompt) {
    let sys = basePrompt || '';
    if (!capProfile) return sys;

    // Build detailed param reference from character sheet
    const sheet = capProfile.sheet;
    let paramRef = '';
    if (sheet && sheet.params && sheet.params.length) {
      const byGroup = {};
      for (const p of sheet.params) {
        if (!byGroup[p.group]) byGroup[p.group] = [];
        byGroup[p.group].push(p);
      }
      paramRef = '\nDAFTAR PARAMETER LENGKAP (min..max, default):\n';
      for (const g in byGroup) {
        paramRef += g + ':\n';
        for (const p of byGroup[g]) {
          paramRef += '  ' + p.id + ' (' + p.label + '): ' + p.min + '..' + p.max + ', default=' + p.def + '\n';
        }
      }
    }

    const capBlock = `

=== KARAKTER LIVE2D — KENDALI PENUH ===

Kamu memainkan karakter anime LIVE2D. KAMU bisa menggerakkan karakter ini secara real-time!
Semua gerakan dikirim sebagai directive tersembunyi dalam balasanmu.

=== DAFTAR EMOSI ===
${capProfile.emotions.length ? capProfile.emotions.join(', ') : 'tidak ada preset emosi'}
Format: [EMOTION:nama]

=== DAFTAR EXPRESSION / PROPERTI BAWAAN ===
${capProfile.nativeExpressions.length ? capProfile.nativeExpressions.join(', ') : 'tidak ada'}
Format: [EXPR:nama] atau [PROP:nama]

=== DAFTAR AKSESORIS ===
${capProfile.accessories.length ? capProfile.accessories.join(', ') : 'tidak ada'}
Format: [ACC:ParamXX:1] nyalakan, [ACC:ParamXX:0] matikan

=== DAFTAR PARAMETER (dengan range aktual dari model) ===
${paramRef || 'Tidak ada data parameter.'}

=== DAFTAR GESTURE (gerakan siap-pakai, PALING DIUTAMAKAN untuk gerak) ===
${capProfile.gestures && capProfile.gestures.length ? capProfile.gestures.join(', ') : 'nod, shake, tilt_curious, lean_excited, recoil_surprised, look_away_shy, laugh_bounce, think, wave_hi'}
Format: [GESTURE:nama]
Ini gerakan yang UDAH JADI (anggukan, geleng, kaget, dll) — bentuknya SELALU
benar karena sudah dirancang manual, beda dari [HEAD]/[BODY] yang kamu harus
nebak angka sendiri. UTAMAKAN pilih dari daftar ini setiap ada momen ekspresif
(setuju→nod, nolak/gak percaya→shake, kaget→recoil_surprised, mikir→think,
malu→look_away_shy, seneng banget→lean_excited, ketawa→laugh_bounce,
sapa→wave_hi, penasaran→tilt_curious).

=== FORMAT DIRECTIVE ===
1. EMOSI:    [EMOTION:senang] [EMOTION:sedih] [EMOTION:malu] [EMOTION:kaget] [EMOTION:normal]
2. GESTURE:  [GESTURE:nama] — lihat daftar gesture di atas, PAKAI INI untuk gerakan (bukan HEAD/BODY manual)
3. KEPALA:   [HEAD:x,y]   — HANYA untuk arah pandang halus tambahan, opsional, x=kiri/kanan y=atas/bawah
4. MATA:     [EYES:x,y]   — bola mata, opsional (pakai range dari daftar di atas)
5. MULUT:    [MOUTH:form,open] — bentuk & buka mulut, opsional
6. BADAN:    [BODY:x,y,z] — HANYA kalau tidak ada gesture yang pas, opsional
7. AKSESORIS: [ACC:ParamXX:1] atau [ACC:ParamXX:0]
8. EXPRESSION: [EXPR:nama] atau [PROP:nama]

=== MULTI-SEGMENT (WAJIB, bikin sesering mungkin) ===
Jangan cuma 1 action block per kalimat panjang — pecah juga di titik koma/jeda
alami kalau ada perubahan nada, biar karakter berubah SEIRAMA omongannya,
bukan diem sepanjang kalimat baru berubah sekali di akhir.

Contoh:
[EMOTION:senang][GESTURE:wave_hi] Halo! [EMOTION:senang][GESTURE:lean_excited] Senang banget ketemu kamu hari ini~
[EMOTION:malu][GESTURE:look_away_shy] Eh, [EMOTION:malu] tadi aku mimpi tentang kamu lho...
[EMOTION:normal][GESTURE:nod] Hehe, bercanda kok~

Contoh pendek:
[EMOTION:kaget][GESTURE:recoil_surprised] Wah, serius?! [EMOTION:kaget][GESTURE:shake] Aku gak nyangka banget!

=== ATURAN ===
1. SELALU sertakan [EMOTION:...] di setiap segment; TAMBAHKAN [GESTURE:...] di
   setiap momen yang ekspresif (jangan tiap segment kalau memang datar/netral)
2. UTAMAKAN [GESTURE] daripada [HEAD]/[BODY] manual — hasilnya lebih jelas terbaca
3. GUNAKAN range parameter yang benar dari daftar di atas kalau tetap pakai HEAD/EYES/BODY manual
4. Nyalakan aksesoris saat cocok (pipi merah saat malu, dll)
5. Jangan pakai directive yang tidak ada di daftar
6. Balasan tetap natural — directive tersembunyi dari user
7. Boleh jawab panjang lebar (3-6 kalimat), sesuaikan emosi & gesture per kalimat/klausa
8. Emosi & gesture HARUS cocok isi kalimat itu sendiri — baca ulang tiap kalimat
   sebelum milih, jangan asal ganti-ganti biar "keliatan hidup"
---`;

    return sys + capBlock;
  }

  // ── Parse into multi-segment array ──
  function parseSegments(text) {
    const segments = [];
    const parts = text.split(/(\[(?:ACTION|EMOTION|HEAD|EYES|MOUTH|ACC|EXPR|BODY|PROP|PROPERTY|GESTURE):[^\]]+\]\s*)/gi);

    let currentActions = {};
    let currentText = '';

    for (const part of parts) {
      const blockMatch = part.match(/^\[(ACTION|EMOTION|HEAD|EYES|MOUTH|ACC|EXPR|BODY|PROP|PROPERTY|GESTURE):([^\]]+)\]\s*$/i);
      if (blockMatch) {
        const clean = currentText.trim();
        if (clean) {
          segments.push({ text: clean, actions: { ...currentActions } });
          currentText = '';
        }
        const type = blockMatch[1].toUpperCase();
        const val = blockMatch[2].trim();
        switch (type) {
          case 'EMOTION':
          case 'EXPR':
            currentActions.emotion = val;
            break;
          case 'HEAD': {
            const p = val.split(',').map(Number);
            if (p.length >= 2) currentActions.head = { x: p[0], y: p[1] };
            break;
          }
          case 'EYES': {
            const p = val.split(',').map(Number);
            if (p.length >= 2) currentActions.eyes = { x: p[0], y: p[1] };
            break;
          }
          case 'MOUTH': {
            const p = val.split(',').map(Number);
            if (p.length >= 2) currentActions.mouth = { form: p[0], open: p[1] };
            break;
          }
          case 'BODY': {
            const p = val.split(',').map(Number);
            if (p.length >= 2) currentActions.body = { x: p[0] || 0, y: p[1] || 0, z: p[2] || 0 };
            break;
          }
          case 'ACC': {
            const p = val.split(':');
            if (p.length >= 2) {
              if (!currentActions.accessories) currentActions.accessories = {};
              currentActions.accessories[p[0]] = Number(p[1]) || 0;
            }
            break;
          }
          case 'PROP':
          case 'PROPERTY':
            currentActions.property = val;
            break;
          case 'GESTURE':
            currentActions.gesture = val;
            break;
        }
      } else {
        currentText += part;
      }
    }

    const clean = currentText.trim();
    if (clean) {
      segments.push({ text: clean, actions: { ...currentActions } });
    }

    if (!segments.length && text.trim()) {
      segments.push({ text: text.trim(), actions: {} });
    }

    return segments;
  }

  // ── Smart fallback: infer head/eyes/body from emotion ──
  // When the LLM doesn't output explicit HEAD/EYES/BODY directives,
  // we generate natural movement based on the emotion type.
  function inferMovementFromEmotion(emotion) {
    // Scale movement values proportionally to the model's actual parameter ranges
    // (from capability profile), so they work correctly for any model regardless
    // of range (e.g. -30..30 vs -1..1 for secondary angle params).
    const pct = (role, fraction) => {
      if (!capProfile || !capProfile.sheet) return fraction * 30; // fallback: assume -30..30
      const id = capProfile.roleIds && capProfile.roleIds[role];
      if (!id) return 0;
      const r = capProfile.sheet.paramRange && capProfile.sheet.paramRange[id];
      if (!r) return fraction * 30;
      return fraction > 0 ? fraction * r.max : fraction * Math.abs(r.min);
    };
    const movements = {
      senang:  { head: { x: pct('angleX', 0.17), y: pct('angleY', -0.1) }, eyes: { x: 0.2, y: 0 }, body: { x: pct('bodyAngleX', 0.15), y: 0, z: 0 } },
      sedih:   { head: { x: pct('angleX', -0.1), y: pct('angleY', 0.27) }, eyes: { x: 0, y: 0.4 }, body: { x: pct('bodyAngleX', -0.1), y: 0, z: pct('bodyAngleZ', -0.1) } },
      malu:    { head: { x: pct('angleX', -0.27), y: pct('angleY', 0.17) }, eyes: { x: -0.3, y: 0.3 }, body: { x: pct('bodyAngleX', -0.15), y: 0, z: pct('bodyAngleZ', -0.05) } },
      kaget:   { head: { x: 0, y: pct('angleY', -0.33) }, eyes: { x: 0, y: -0.5 }, body: { x: 0, y: 0, z: 0 } },
      normal:  { head: { x: 0, y: 0 }, eyes: { x: 0, y: 0 }, body: { x: 0, y: 0, z: 0 } },
    };
    return movements[emotion] || movements.normal;
  }

  // Matching gesture for the fallback path (no directives at all from the
  // LLM) — so even the "worst case" still plays a real, recognizable motion
  // instead of just a static pose + idle mouth-flap.
  const EMOTION_GESTURE_FALLBACK = {
    senang: 'lean_excited', sedih: 'look_away_shy', malu: 'look_away_shy',
    kaget: 'recoil_surprised', normal: 'nod',
  };

  // ── Apply actions to the model (AI-driven, EASED) ──
  // Instead of hard-setting params (which snaps and looks stiff), we push a
  // TARGET pose to the engine via setAIPose(). The engine eases toward it and
  // layers ambient fidget on top, so transitions are smooth and the character
  // is never frozen — like neuro-sama, not a statue.
  function applyActions(actions, segmentIndex, totalSegments) {
    const agent = window.__live2dAgent;
    if (!agent || !agent.isReady()) return;

    // Emotion
    if (actions.emotion) {
      const supported = (agent._getSupportedEmotions && agent._getSupportedEmotions()) || {};
      const int = actions.intensity != null ? actions.intensity : 0.85;
      if (supported[actions.emotion] || actions.emotion === 'normal') {
        agent.setExpression(actions.emotion, int);
      } else {
        agent.setExpression('user:' + actions.emotion, int);
      }
    }

    // Build a pose target. Add a small per-segment offset so consecutive
    // segments of the same emotion don't land on the EXACT same pose — this
    // is what sells "alive" rather than "reading a script".
    const vary = (segmentIndex || 0);
    const jitter = (n) => (Math.sin(vary * 1.3 + n) * 2.5); // ±2.5° organic drift
    const pose = {};

    // If explicit head/eyes/body are provided, use them; otherwise infer natural pose from emotion
    const inferred = actions.emotion ? inferMovementFromEmotion(actions.emotion) : null;

    if (actions.head) {
      pose.head = {
        x: Math.max(-30, Math.min(30, actions.head.x + jitter(0.7))),
        y: Math.max(-30, Math.min(30, actions.head.y + jitter(1.9))),
      };
    } else if (inferred && inferred.head) {
      pose.head = {
        x: inferred.head.x + jitter(0.7),
        y: inferred.head.y + jitter(1.9),
      };
    }

    if (actions.eyes) {
      pose.eyes = {
        x: Math.max(-1, Math.min(1, actions.eyes.x + jitter(0.3) * 0.02)),
        y: Math.max(-1, Math.min(1, actions.eyes.y + jitter(0.5) * 0.02)),
      };
    } else if (inferred && inferred.eyes) {
      pose.eyes = {
        x: inferred.eyes.x + jitter(0.3) * 0.02,
        y: inferred.eyes.y + jitter(0.5) * 0.02,
      };
    }

    if (actions.mouth) {
      pose.mouth = { form: Math.max(-1, Math.min(1, actions.mouth.form)) };
    }

    if (actions.body) {
      pose.body = {
        x: Math.max(-20, Math.min(20, actions.body.x + jitter(1.1))),
        y: Math.max(-20, Math.min(20, actions.body.y)),
        z: Math.max(-20, Math.min(20, actions.body.z + jitter(0.4))),
      };
    } else if (inferred && inferred.body) {
      pose.body = {
        x: inferred.body.x + jitter(1.1),
        y: inferred.body.y,
        z: inferred.body.z + jitter(0.4),
      };
    }

    if (Object.keys(pose).length) agent.setAIPose(pose);

    // Accessories
    if (actions.accessories) {
      for (const [param, val] of Object.entries(actions.accessories)) {
        agent.setAccessory(param, val);
      }
    }

    // Property / Expression
    if (actions.property) {
      agent.setExpression(actions.property);
    }

    // Gesture verb — played AFTER the pose target above, so its deltas
    // compose on top of whatever HEAD/EMOTION just set for this segment.
    const gestureToPlay = actions.gesture || (actions.emotion && EMOTION_GESTURE_FALLBACK[actions.emotion]) || null;
    if (gestureToPlay && agent.playGesture) {
      agent.playGesture(gestureToPlay);
    }
  }

  // ── Speak segments sequentially with ACTUAL TTS callback timing ──
  function speakSegments(segments) {
    const agent = window.__live2dAgent;
    if (!agent || !segments.length) return;

    // Lock: AI takes control
    agent.lockAI();

    let i = 0;
    function nextSegment() {
      if (i >= segments.length) {
        // All done — release lock
        agent.unlockAI();
        console.log('[agent] all', segments.length, 'segments done, AI lock released');
        return;
      }
      const seg = segments[i];
      const segIdx = i;
      i++;

      // Apply this segment's actions (with inference fallback)
      applyActions(seg.actions, segIdx, segments.length);
      // Chat log per-segment: teks baru muncul SESUDAH (seiring) TTS segmen ini
      if (window.__addChat) window.__addChat('agent', seg.text);
      console.log('[agent] segment', segIdx + 1, '/', segments.length,
        'text:', seg.text.slice(0, 40) + (seg.text.length > 40 ? '...' : ''),
        'actions:', seg.actions);

      // Speak with callback — next segment starts when THIS one finishes
      agent.speak(seg.text, () => {
        // Small pause between segments for natural rhythm
        setTimeout(nextSegment, 180);
      });
    }
    nextSegment();
  }

  // Fallback emotion guesser (when no action blocks at all)
  function guessEmotion(text) {
    const t = (text || '').toLowerCase();
    if (/(senang|gembira|hehe|haha|lucu|mantap|yes|hore|terima kasih|makasih|love|sayang|seru|asik|keren)/.test(t)) return 'senang';
    if (/(senyum|senang|suka|ramah|halo|hai)/.test(t)) return 'tersenyum';
    if (/(sedih|kecewa|sepi|rindu|galau|huhu|nangis|kasihan)/.test(t)) return 'sedih';
    if (/(malu|grogi|cantik|ganteng|pacar|cium|peluk|dekat|mesra|blush)/.test(t)) return 'malu';
    if (/(wah|kaget|serius|gila|astaga|beneran|loo|wow|hah|apa)/.test(t)) return 'kaget';
    if (/(kesal|marah|bete|sebel|benci|gamau|ngambek)/.test(t)) return 'kesal';
    if (/(bingung|gimana|kenapa|maksudnya|ragu|entah|mikir)/.test(t)) return 'bingung';
    return 'normal';
  }

  // Client-side smart clause segmenter fallback
  function segmentTextFallback(text) {
    // Split by punctuation: . ! ? ~ or comma when clause is long enough
    const clauses = text.split(/(?<=[.!?~…\n]+)\s+|(?<=,\s+)(?=[A-Z0-9\u4e00-\u9fff])/g).filter(c => c.trim().length > 0);
    if (!clauses.length) clauses.push(text);
    return clauses.map((clause, idx) => {
      const emo = guessEmotion(clause);
      const gest = EMOTION_GESTURE_FALLBACK[emo] || (idx === 0 ? 'wave_hi' : 'nod');
      return {
        text: clause.trim(),
        actions: {
          emotion: emo,
          gesture: gest,
          intensity: emo === 'normal' ? 0.5 : 0.85,
        }
      };
    });
  }

  // Request AI Animation Director (Two-Pass Architecture)
  async function animateTextViaDirector(text, profile) {
    try {
      const res = await fetch('http://127.0.0.1:8310/api/animate-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          capabilities: {
            emotions: profile?.emotions || ['senang', 'tersenyum', 'sedih', 'malu', 'kaget', 'kesal', 'bingung', 'normal'],
            gestures: profile?.gestures || Object.keys(EMOTION_GESTURE_FALLBACK),
          },
        }),
      });
      if (!res.ok) throw new Error('Director HTTP ' + res.status);
      const data = await res.json();
      const rawSegs = data.segments || [];
      if (Array.isArray(rawSegs) && rawSegs.length) {
        return rawSegs.map(s => ({
          text: s.text || '',
          actions: {
            emotion: s.emotion || 'normal',
            gesture: s.gesture || null,
            intensity: typeof s.intensity === 'number' ? s.intensity : 0.8,
          }
        })).filter(s => s.text.trim().length > 0);
      }
    } catch (e) {
      console.warn('[agent] Director pass fallback:', e.message);
    }
    return segmentTextFallback(text);
  }

  async function think(userText) {
    if (busy) return;
    if (!window.__live2dAgent || !window.__live2dAgent.isReady()) {
      console.warn('[agent] model not ready');
      return;
    }

    if (!capProfile) await loadCapabilityProfile();

    busy = true;
    history.push({ role: 'user', content: userText });
    if (history.length > HISTORY_LIMIT * 2) history.splice(0, history.length - HISTORY_LIMIT * 2);

    setThinking(true);
    try {
      // Pass 1: Character text response generation
      const resp = await fetch('http://127.0.0.1:8310/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, system: buildSystemPrompt('') + moodSuffix() }),
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error || ('HTTP ' + resp.status));
      }
      const data = await resp.json();
      const reply = (data.reply || '').trim();
      if (reply) {
        const clean = reply.replace(/\[(?:ACTION|EMOTION|HEAD|EYES|MOUTH|ACC|EXPR|BODY|PROP|PROPERTY|GESTURE):[^\]]+\]/gi, '').trim();
        let segments = parseSegments(reply);

        // If the reply is clean text (no bracket directives), run Pass 2 (Animation Director)
        const hasDirectives = /\[(?:ACTION|EMOTION|HEAD|EYES|MOUTH|ACC|EXPR|BODY|PROP|PROPERTY|GESTURE):/i.test(reply);
        if (!hasDirectives || segments.length <= 1) {
          console.log('[agent] Running Pass 2: Animation Director for long response...');
          segments = await animateTextViaDirector(cleanFullReply, capProfile);
        }

        console.log('[agent] speaking reply with', segments.length, 'animation segments');
        speakSegments(segments);
      } else {
        window.__live2dAgent.speak('Hmm, aku bingung jawabnya...');
      }
    } catch (err) {
      console.error('[agent]', err);
      window.__live2dAgent.speak('Maaf, aku lagi gak bisa mikir sekarang. Cek koneksi atau api key ya.');
    } finally {
      setThinking(false);
      busy = false;
    }
  }

  function setThinking(on) {
    const el = document.getElementById('thinking');
    if (el) el.classList.toggle('hidden', !on);
  }

  // ── Reactive events (idle / away / return / mood) ──
  let userMood = 'normal';
  let presenceState = null;

  // Masa tenang sejak app nyala: jangan langsung merespons apa pun
  // (user diam / hilang / mood) sebelum 30 menit lewat.
  const AGENT_QUIET_MS = 30 * 60 * 1000;
  const agentStart = Date.now();

  function moodSuffix() {
    return (userMood && userMood !== 'normal')
      ? ('\nUser saat ini terlihat ' + userMood + '. Tunjukkan empati yang wajar dan konsisten.')
      : '';
  }

  const EVENT_PROMPTS = {
    idle: 'User diam tidak mengatakan apa-apa padahal dia ada di depanmu. Mulai ngobrol sendiri secara santai, seperti karakter yang menunggu dan mencoba meramaikan suasana. Boleh cerita ringan atau tanya hal kecil.',
    'user_left': 'User tiba-tiba pergi / menghilang dari depan layar. Tunjukkan kalau kamu perhatian dan sedikit sedih atau nunggu dia balik. Bilang sesuatu yang manis sebelum dia pergi.',
    'user_returned': 'User baru saja balik setelah tadi pergi. Sambut dia dengan senang, seperti menyambut teman yang kembali.',
    'mood:marah': 'User terlihat MARAH/kesal dari ekspresi wajahnya. Tunjukkan empati, tanyakan kenapa, jangan bikin dia makin kesal. Tenang dan pengertian.',
    'mood:sedih': 'User terlihat SEDIH dari ekspresi wajahnya. Hibur dia dengan lembut: "jangan sedih ya", "kalau kamu sedih aku juga sedih nih", tawarkan dengar ceritanya.',
    'mood:senang': 'User terlihat SENANG/bahagia. Ikut senang dan rayakan mood-nya, tunjukkan antusias.',
    'mood:kaget': 'User terlihat KAGET. Tanyakan ada apa, tunjukkan kepedulian.',
  };

  function setUserMood(m) {
    userMood = m || 'normal';
    console.log('[agent] userMood ->', userMood);
  }

  function setCameraMood(m) {
    if (!m || m === 'normal') { setUserMood('normal'); return; }
    setUserMood(m);
    reactEvent('mood:' + m);
  }

  function setPresence(p) {
    // p: true=hadir, false=pergi, null=tidak tahu (pakai fallback visibility)
    if (p === null) { presenceState = null; return; }
    const was = presenceState;
    presenceState = p;
    if (Date.now() < agentStart + AGENT_QUIET_MS) return; // masa tenang: jangan reaksi
    if (p === false && was !== false) {
      reactEvent('user_left');
      if (window.__live2dAgent) window.__live2dAgent.setExpression('sedih');
    } else if (p === true && was === false) {
      reactEvent('user_returned');
    }
  }

  async function reactEvent(type) {
    if (busy) return;
    if (Date.now() < agentStart + AGENT_QUIET_MS) {
      console.log('[agent] masa tenang, skip event:', type);
      return;
    }
    if (!window.__live2dAgent || !window.__live2dAgent.isReady()) {
      console.warn('[agent] reactEvent skipped, model not ready');
      return;
    }
    if (!capProfile) await loadCapabilityProfile();

    busy = true;
    setThinking(true);
    try {
      const eventLine = EVENT_PROMPTS[type] || '';
      const system = buildSystemPrompt('')
        + '\n\n[EVENT: ' + type + '] ' + eventLine + moodSuffix()
        + '\nBalas SINGKAT dan natural (1-3 kalimat), seperti karakter merespons kejadian, BUKAN menjawab pertanyaan. Jangan pakai bahasa bahwa kamu adalah AI.';

      // Synthetic user turn — TIDAK dipush ke history asli.
      const synthetic = '(' + type + ')';
      const messages = history.slice(-6).concat([{ role: 'user', content: synthetic }]);

      const resp = await fetch('http://127.0.0.1:8310/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, system }),
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error || ('HTTP ' + resp.status));
      }
      const data = await resp.json();
      const reply = (data.reply || '').trim();
      if (reply) {
        const cleanFullReply = reply.replace(/\[(?:ACTION|EMOTION|HEAD|EYES|MOUTH|ACC|EXPR|BODY|PROP|PROPERTY|GESTURE):[^\]]+\]/gi, '').trim();
        speakSegments(segments);
      }
    } catch (err) {
      console.error('[agent] reactEvent', type, err);
    } finally {
      setThinking(false);
      busy = false;
    }
  }

  window.__agent = {
    think,
    reactEvent,
    setUserMood,
    setCameraMood,
    setPresence,
    history,
    guessEmotion,
    loadCapabilityProfile,
  };
})();