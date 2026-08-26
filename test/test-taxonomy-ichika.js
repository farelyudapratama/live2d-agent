/**
 * test-taxonomy-ichika.js — coverage check against a REAL 306-group model.
 *
 * The Ichika model's character sheet (sheets/model_ichika_*.json) lists 306
 * motion group names. The model folder itself is not currently in model/, so
 * this exercises the NAME-HINT fallback path — which is exactly the path that
 * runs when a sheet outlives its model folder.
 *
 * Purpose: prove the taxonomy assigns a usable verb to the large majority of
 * real-world group names, and print the residual so the hint table can be
 * extended deliberately rather than guessed at.
 *
 * Run: node test/test-taxonomy-ichika.js
 */
const fs = require('fs');
const path = require('path');
const T = require('../js/motion-taxonomy.js');

const sheetsDir = path.join(__dirname, '..', 'sheets');
const candidates = fs.existsSync(sheetsDir)
  ? fs.readdirSync(sheetsDir).filter(f => /ichika/i.test(f) && f.endsWith('.json'))
  : [];

if (!candidates.length) {
  console.log('No ichika sheet found in sheets/ — skipping (not a failure).');
  process.exit(0);
}

const sheet = JSON.parse(fs.readFileSync(path.join(sheetsDir, candidates[0]), 'utf8'));
const groups = sheet.motionGroups || [];
console.log(`\nsheet: ${candidates[0]}`);
console.log(`motion groups: ${groups.length}\n`);

const built = T.buildTaxonomy(groups.map(g => ({ name: g, motion3: null })));

const counts = {};
for (const c of built.clips) counts[c.verb] = (counts[c.verb] || 0) + 1;

console.log('verb distribution:');
Object.entries(counts).sort((a, b) => b[1] - a[1])
  .forEach(([v, n]) => console.log(`  ${String(v).padEnd(11)} ${String(n).padStart(4)}  ${(n / groups.length * 100).toFixed(1)}%`));

// A group that fell through to 'neutral' with the lowest confidence had NO
// signal at all — neither curves (absent here) nor a name hint.
const unmatched = built.clips.filter(c => c.evidence === 'no-signal').map(c => c.name);
const coverage = (groups.length - unmatched.length) / groups.length;
console.log(`\nname-hint coverage: ${(coverage * 100).toFixed(1)}%  (${groups.length - unmatched.length}/${groups.length})`);

if (unmatched.length) {
  console.log(`\nunmatched group names (${unmatched.length}) — candidates for new hints:`);
  // Group by the middle token so patterns are obvious at a glance.
  const byToken = {};
  for (const n of unmatched) {
    const tok = (String(n).split('-')[1] || n).replace(/\d+$/, '');
    (byToken[tok] = byToken[tok] || []).push(n);
  }
  Object.entries(byToken).sort((a, b) => b[1].length - a[1].length)
    .forEach(([tok, list]) => console.log(`  ${tok.padEnd(18)} x${String(list.length).padStart(3)}   e.g. ${list[0]}`));
}

// Emotion gating over the REAL verb pool: every emotion must resolve to at
// least one clip, otherwise the runtime silently falls back to synthetic
// gestures for that emotion on this model.
console.log('\nemotion -> resolvable clip (real pool):');
let gaps = 0;
for (const emo of Object.keys(T.EMOTION_VERBS)) {
  const pick = T.pickClipForEmotion(built.byVerb, emo, () => 0.5);
  if (pick) console.log(`  ${emo.padEnd(10)} OK   verb=${pick.verb.padEnd(10)} clip=${pick.name}`);
  else { console.log(`  ${emo.padEnd(10)} GAP  (no compatible clip — will use synthetic gesture)`); gaps++; }
}

// Cross-contamination check: this is the actual bug being fixed. Assert that
// no clip classified with a negative verb is reachable when the character is
// happy, and vice versa.
console.log('\ncross-contamination check:');
const sadClips = built.byVerb.sad || [];
const angryClips = built.byVerb.angry || [];
let leaks = 0;
for (let i = 0; i < 2000; i++) {
  const p = T.pickClipForEmotion(built.byVerb, 'senang');
  if (!p) continue;
  if (sadClips.includes(p.name) || angryClips.includes(p.name)) leaks++;
}
console.log(`  2000 draws for "senang": ${leaks} negative-clip leaks (want 0)`);

const happyClips = built.byVerb.happy || [];
let leaks2 = 0;
for (let i = 0; i < 2000; i++) {
  const p = T.pickClipForEmotion(built.byVerb, 'sedih');
  if (p && happyClips.includes(p.name)) leaks2++;
}
console.log(`  2000 draws for "sedih":  ${leaks2} happy-clip leaks (want 0)`);

const ok = leaks === 0 && leaks2 === 0 && coverage >= 0.8;
console.log(`\n${ok ? 'PASS' : 'FAIL'}  (coverage >= 80% and zero leaks; emotion gaps: ${gaps})\n`);
process.exit(ok ? 0 : 1);
