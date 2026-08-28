// Fase 5 tests — per-parameter user description (params[i].userNote).
//
// Verifies the THREE pieces needed for the user's intent:
//   1. app.js exposes saveParamNote/getParamNote on window.__live2dAgent.sheet,
//      and the field is created on inspect (v4 schema already has it).
//   2. agent.js buildSystemPrompt feeds a non-empty userNote into the LLM
//      prompt so the model understands what the parameter actually does.
//   3. server.js /api/model/analyze-sheet injects the user's per-param note
//      ("penjelasan user") into the parameter listing it sends the LLM.
//
// Mirrors the slice-and-execute style of test-fase3-analyze-endpoint.js: the
// real source is executed, not re-typed, so a divergence in server.js/app.js
// would make these tests lie.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const agentSrc = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// ───────────────────────────────────────────────────────────────
section('1. app.js exposes the per-parameter note API');

ok('saveParamNote defined in app.js', /async function saveParamNote\(/.test(appSrc));
ok('getParamNote defined in app.js', /function getParamNote\(/.test(appSrc));
ok('saveParamNote exposed on .sheet', /saveParamNote,/.test(appSrc) && /saveParamNote/.test(appSrc.split('window.__live2dAgent.sheet')[0]) || /saveParamNote,/.test(appSrc));
// The exposure block is literal: saveParamNote, getParamNote inside the sheet API object.
ok('both exposed on window.__live2dAgent.sheet',
  /saveParamNote,\s*\n\s*getParamNote,/.test(appSrc), 'saveParamNote + getParamNote adjacent in sheet API');
ok('note capped at 300 (MAX_PARAM_NOTE)', /const MAX_PARAM_NOTE = 300;/.test(appSrc));
ok('saveParamNote rejects unknown paramId',
  /throw new Error\('Parameter "' \+ paramId \+ '" tidak ada di sheet model ini\.'/.test(appSrc));
ok('v4 schema seeds every param with empty userNote',
  /if \(typeof p\.userNote !== 'string'\) p\.userNote = '';/.test(appSrc));
ok('userNote survives re-inspection (carry-over)',
  /carriedNotes\[p\.id\] = p\.userNote/.test(appSrc) || /__paramNotes/.test(appSrc));

// ───────────────────────────────────────────────────────────────
section('2. agent.js feeds userNote into the LLM system prompt');

// Slice buildSystemPrompt() so we execute the real prompt builder.
function sliceFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const bspSrc = sliceFn(agentSrc, 'buildSystemPrompt');
ok('buildSystemPrompt extracted', !!bspSrc, bspSrc ? bspSrc.length + ' chars' : 'NOT FOUND');

if (bspSrc) {
  // The function reads the module-global `capProfile`. We provide it via a
  // closure wrapper so we can drive it directly without the full IIFE.
  const harness = bspSrc + '\nglobalThis.__bsp = buildSystemPrompt;';
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    globalThis: {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(harness, sandbox);

  // Case A: a param WITH a userNote must surface it under "penjelasan user".
  sandbox.capProfile = {
    sheet: {
      params: [
        { id: 'ParamX', label: 'ParamX', min: 0, max: 1, def: 0, group: 'Kustom', userNote: 'skala pupil kiri' },
        { id: 'ParamY', label: 'ParamY', min: -1, max: 1, def: 0, group: 'Sudut (Angle)', userNote: '' },
      ],
    },
    userNote: '', emotions: [], nativeExpressions: [], properties: [], accessories: [], gestures: [],
  };
  const promptA = sandbox.__bsp('');
  ok('param with userNote emits "penjelasan user" line',
    /📝 penjelasan user: skala pupil kiri/.test(promptA),
    'the LLM now sees the user\'s authoritative meaning');
  ok('empty userNote does NOT emit a penjelasan line for that param',
    !/ParamY[\s\S]{0,60}penjelasan user/.test(promptA) || !/ParamY.*📝 penjelasan user/.test(promptA));

  // Case B: long note is clamped to 300 chars in the prompt.
  const longNote = 'x'.repeat(500);
  sandbox.capProfile = {
    sheet: {
      params: [
        { id: 'ParamZ', label: 'ParamZ', min: 0, max: 1, def: 0, group: 'Kustom', userNote: longNote },
      ],
    },
    userNote: '', emotions: [], nativeExpressions: [], properties: [], accessories: [], gestures: [],
  };
  const promptB = sandbox.__bsp('');
  const m = promptB.match(/📝 penjelasan user: (.*)/);
  ok('note clamped to <=300 chars in prompt', m && m[1].length <= 300, m ? m[1].length + ' chars' : 'no line');
}

// ───────────────────────────────────────────────────────────────
section('3. server.js analyze-sheet injects user notes into the LLM listing');

const epBlock = (() => {
  const a = srvSrc.indexOf("/api/model/analyze-sheet'");
  const b = srvSrc.indexOf('/api/animate-text', a);
  return a === -1 ? '' : srvSrc.slice(a, b === -1 ? a + 20000 : b);
})();
ok('analyze-sheet endpoint block found', epBlock.length > 500, epBlock.length + ' chars');

// Slice the exact noteOf() helper + paramLines mapping the endpoint runs. The
// block between them (early-return guards) is skipped so the vm can run them at
// top level. We extract noteOf's body up to its closing `};` and paramLines up
// to its `.join('\n')`.
const notesSlice = (() => {
  const a = epBlock.indexOf('const noteOf = (');
  const ae = epBlock.indexOf('};', a);              // end of the noteOf arrow
  const b = epBlock.indexOf('const paramLines = params.map(');
  const c = epBlock.indexOf("}).join('\\n');", b);
  if (a === -1 || ae === -1 || b === -1 || c === -1) return null;
  return epBlock.slice(a, ae + 2) + '\n' + epBlock.slice(b, c + "}).join('\\n');".length);
})();
ok('noteOf + paramLines slice extracted', !!notesSlice, notesSlice ? notesSlice.length + ' chars' : 'NOT FOUND');

if (notesSlice) {
  function runNoteLines(incomingObj) {
    const sandbox = {
      incoming: incomingObj,
      notes: incomingObj.notes || {},
      params: incomingObj.params || [],
      console: { warn() {}, log() {} },
      Number, Math, Object, Array, String, Set, Map,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(notesSlice + '\nglobalThis.__paramLines = paramLines;', sandbox);
    return sandbox.__paramLines || '';
  }

  const lines = runNoteLines({
    params: [
      { id: 'ParamX', label: 'ParamX', min: 0, max: 1, def: 0 },
      { id: 'ParamY', label: 'ParamY', min: -1, max: 1, def: 0 },
    ],
    notes: { ParamX: 'skala pupil kiri', ParamY: '' },
  });
  ok('param WITH note gets "penjelasan user" suffix',
    /ParamX[^]*penjelasan user: skala pupil kiri/.test(lines),
    'LLM receives the user\'s authoritative meaning');
  ok('param WITHOUT note has no penjelasan suffix',
    !/ParamY[^]*penjelasan user/.test(lines));

  // Control-char + length sanitisation on the note the client sends.
  const lines2 = runNoteLines({
    params: [{ id: 'ParamX', label: 'ParamX', min: 0, max: 1, def: 0 }],
    notes: { ParamX: 'a bc' + 'z'.repeat(400) },
  });
  const m = lines2.match(/penjelasan user: (.*)/);
  ok('note control chars stripped + clamped to 300', m && m[1].length <= 300 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(m[1]),
    m ? m[1].length + ' chars' : 'no line');
}

// The client (analyzeSheetPresets) must actually SEND notes.
ok('analyzeSheetPresets sends notes to /api/model/analyze-sheet',
  /body: JSON\.stringify\(\{ params, parts, existingNames, notes \}\)/.test(appSrc),
  'otherwise the server-side injection above is dead code');

// ───────────────────────────────────────────────────────────────
section('4. Popup UI: live slider + freeze-on-drag + all params');

ok('setPartOpacity exposed on window.__live2dAgent (slider drives parts)',
  /setPartOpacity: \(id, v\) =>/.test(appSrc));
ok('popup container exists in index.html', /id="paramnotes-popup"/.test(htmlSrc));
ok('open button exists in index.html', /id="btn-open-paramnotes"/.test(htmlSrc));
ok('open handler wires button -> openParamNotesPopup',
  /pnOpenBtn\.addEventListener\('click', openParamNotesPopup\)/.test(appSrc));
ok('renderParamNotesPopup renders WITHOUT a MAX_ROWS cap (all params shown)',
  /function renderParamNotesPopup\(sheet\)/.test(appSrc)
  && /for \(const p of params\) \{/.test(appSrc)
  && !/params\.slice\(0, 120\)/.test(appSrc),
  'every parameter + part is listed, popup scrolls instead');
ok('each row has a live range slider', /range\.type = 'range'/.test(appSrc));
ok('slider drives model live via setParameter/setPartOpacity',
  /window\.__live2dAgent\.setParameter\(id, v\)/.test(appSrc)
  && /window\.__live2dAgent\.setPartOpacity\(id, v\)/.test(appSrc));

// Freeze-on-drag: while dragging, state.frozen=true suppresses the idle
// fidget oscillators in tick() so the slider signal is clean; resumes after 10s.
ok('state.frozen flag initialised', /frozen: false,/.test(appSrc));
ok('tick() suppresses fidget when state.frozen (no fighting the slider)',
  /const frozen = !!state\.frozen;/.test(appSrc)
  && /const fx = frozen \? 0 :/.test(appSrc)
  && /const fy = frozen \? 0 :/.test(appSrc));
ok('freezeForDrag flips aiLock (pauses mouse-follow) + starts 10s timer',
  /function freezeForDrag\(\)/.test(appSrc)
  && /remaining = 10;/.test(appSrc));
ok('unfreeze restores idle smoothly (aiLock=false, eases from current)',
  /function unfreeze\(\)/.test(appSrc) && /state\.aiLock = false;/.test(appSrc));
ok('popup close releases sticky overrides (model returns to rig)',
  /for \(const id of pnStuckIds\)/.test(appSrc) && /delete state\.overrides\[id\]/.test(appSrc));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
