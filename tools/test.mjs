/*
 * test.mjs — runs every suite.
 *
 *   node tools/test.mjs
 *
 * There is no test framework and no dependency to install; each suite is a
 * plain script that prints its own results and exits non-zero on failure.
 *
 * None of this can talk to LinkedIn. What it covers is everything that does
 * not need a session: the URN resolver, the input normalisation, the export
 * layout, and the static wiring between the manifest, the popup markup and the
 * three scripts that message each other. That is deliberately the set of
 * things a live smoke test is worst at catching.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['resolver-test.mjs', 'voyager.js — URN resolution, session cookies, Rest.li'],
  ['utils-test.mjs', 'utils.js — public-id normalisation, CSV escaping'],
  ['engine-test.mjs', 'content.js — session detection, entity mapping, paging'],
  ['export-test.mjs', 'background.js — archive tree, CSV, README'],
  ['wiring-check.mjs', 'manifest / popup / message wiring, safety limits'],
  ['regression-test.mjs', 'the async glue — tabs, ports, timers, worker lifetime']
];

let failed = 0;
const summary = [];

for (const [file, blurb] of SUITES) {
  process.stdout.write(`\n\x1b[1m▸ ${file}\x1b[0m  ${blurb}\n`);
  const r = spawnSync(process.execPath, [join(here, file)], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);

  const tail = (r.stdout || '').trim().split('\n').pop() || '';
  summary.push(`${r.status === 0 ? 'PASS' : 'FAIL'}  ${file.padEnd(20)} ${tail}`);
  if (r.status !== 0) failed++;
}

process.stdout.write('\n' + '─'.repeat(64) + '\n');
for (const line of summary) process.stdout.write(line + '\n');
process.stdout.write('─'.repeat(64) + '\n');
process.stdout.write(failed ? `\n${failed} suite(s) failed\n` : '\nall suites passed\n');
process.exit(failed ? 1 : 0);
