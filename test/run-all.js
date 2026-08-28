// Cross-platform test runner. Replaces the old shell loop
//   for f in test/test-*.js; do node "$f"; done
// so `npm test` works the same on Windows (cmd/powershell), Linux and macOS.
//
// Behaviour matches the project convention from HANDOFF-SHEET-SYSTEM.md:
//   - every suite prints its own "N passed, M failed" line
//   - we grep the LAST such line per file (some suites print notes after it)
//   - test-taxonomy-ichika.js is SKIPPED by design (needs an Ichika model asset
//     not in the repo) — a skip is reported, not counted as a failure.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const testDir = path.join(ROOT, 'test');

const files = fs.readdirSync(testDir)
  .filter(f => /^test-.*\.js$/.test(f))
  .sort();

let totalPass = 0, totalFail = 0, suitesRun = 0, suitesSkipped = 0;
let firstFailure = null;

for (const f of files) {
  const full = path.join(testDir, f);
  const res = spawnSync(process.execPath, [full], { cwd: ROOT, encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');
  // show the suite's own output so failures are debuggable
  process.stdout.write('\n=== ' + f + ' ===\n');
  process.stdout.write(out);

  // Some suites legitimately print lines AFTER their summary; take the LAST
  // "N passed, M failed" line (matches the documented grep behaviour).
  const lines = out.split('\n').filter(l => /\d+\s+passed,\s*\d+\s+failed/.test(l));
  const summary = lines.length ? lines[lines.length - 1] : null;

  if (summary) {
    const m = summary.match(/(\d+)\s+passed,\s*(\d+)\s+failed/);
    const p = m ? Number(m[1]) : 0;
    const fl = m ? Number(m[2]) : 0;
    totalPass += p; totalFail += fl; suitesRun++;
    if (fl > 0 && !firstFailure) firstFailure = f;
  } else {
    // No summary line. A clean exit (0) with no summary is a SKIP (e.g. the
    // ichika asset is absent) — not a failure. Only a non-zero exit without a
    // summary means the suite actually crashed.
    if (res.status === 0) {
      suitesSkipped++;
      process.stdout.write('[skipped: no summary line — asset/condition not met]\n');
    } else {
      suitesSkipped++;
      totalFail++;
      if (!firstFailure) firstFailure = f;
      process.stdout.write('[FAIL: suite crashed (exit ' + res.status + ') — check output above]\n');
    }
  }
}

process.stdout.write('\n==================================================\n');
process.stdout.write('Suites run: ' + suitesRun + ', skipped: ' + suitesSkipped + '\n');
process.stdout.write('TOTAL: ' + totalPass + ' passed, ' + totalFail + ' failed\n');
process.stdout.write('==================================================\n');

process.exit(totalFail > 0 ? 1 : 0);
