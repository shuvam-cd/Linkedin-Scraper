/*
 * utils-test.mjs — isolation test for the pure helpers in utils.js.
 *
 *   node tools/utils-test.mjs
 *
 * normalisePublicId() is the front door: everything downstream keys off what
 * it returns, and it has to cope with whatever a human pastes into the target
 * row. csvCell() is the other place a bad input corrupts output silently —
 * a post body with a newline in it must not be able to split a CSV row.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
new Function(readFileSync(join(here, '..', 'utils.js'), 'utf8'))();
const U = globalThis.LIS;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (err) {
    failures.push(name);
    process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
  }
}

function eq(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what || 'value'}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  }
}

const group = (t) => process.stdout.write(`\n${t}\n`);

/* ================================================================== */
group('normalisePublicId — whatever gets pasted into the target row');

const id = U.normalisePublicId;

check('a bare public identifier passes through', () => {
  eq(id('williamhgates'), 'williamhgates');
  eq(id('john-doe-123456'), 'john-doe-123456');
});

check('a full https profile URL', () => {
  eq(id('https://www.linkedin.com/in/williamhgates/'), 'williamhgates');
  eq(id('https://www.linkedin.com/in/williamhgates'), 'williamhgates');
});

check('without a scheme, and without www', () => {
  eq(id('www.linkedin.com/in/satyanadella/'), 'satyanadella');
  eq(id('linkedin.com/in/satyanadella'), 'satyanadella');
});

check('locale subdomains', () => {
  eq(id('https://uk.linkedin.com/in/some-person'), 'some-person');
  eq(id('https://de.linkedin.com/in/some-person/'), 'some-person');
  eq(id('https://br.linkedin.com/in/some-person'), 'some-person');
});

check('trailing query strings — LinkedIn appends ?trk= to nearly every link', () => {
  eq(id('https://www.linkedin.com/in/someone/?trk=public_profile_browsemap'), 'someone');
  eq(id('https://www.linkedin.com/in/someone?originalSubdomain=uk'), 'someone');
  eq(id('someone?trk=abc'), 'someone');
});

check('fragments', () => {
  eq(id('https://www.linkedin.com/in/someone/#experience'), 'someone');
});

check('a deep link into a profile sub-page', () => {
  eq(id('https://www.linkedin.com/in/someone/details/experience/'), 'someone');
  eq(id('https://www.linkedin.com/in/someone/recent-activity/all/'), 'someone');
});

check('a bare /in/ path', () => {
  eq(id('/in/someone/'), 'someone');
  eq(id('in/someone'), 'someone');
});

check('percent-encoded non-ASCII identifiers are decoded', () => {
  eq(id('https://www.linkedin.com/in/jos%C3%A9-garcia'), 'josé-garcia');
});

check('surrounding whitespace and a stray @ are stripped', () => {
  eq(id('  williamhgates  '), 'williamhgates');
  eq(id('@williamhgates'), 'williamhgates');
});

check('identifiers are lowercased to the canonical form', () => {
  eq(id('WilliamHGates'), 'williamhgates');
  eq(id('https://www.linkedin.com/in/WilliamHGates/'), 'williamhgates');
});

check('company and school URLs are rejected, not silently treated as people', () => {
  eq(id('https://www.linkedin.com/company/microsoft/'), '');
  eq(id('https://www.linkedin.com/school/mit/'), '');
});

check('LinkedIn own-path segments are rejected', () => {
  eq(id('feed'), '');
  eq(id('jobs'), '');
  eq(id('checkpoint'), '');
});

check('junk is rejected rather than guessed at', () => {
  eq(id(''), '');
  eq(id(null), '');
  eq(id(undefined), '');
  eq(id('   '), '');
  eq(id('two words'), '');
  eq(id('https://example.com/in/someone'), '');
  eq(id('a'.repeat(200)), '');
});

check('a company URL that happens to contain "in" is not mistaken for a profile', () => {
  eq(id('https://www.linkedin.com/company/linkedin/'), '');
});

group('URL builders');

check('profile and activity URLs', () => {
  eq(U.profileUrl('someone'), 'https://www.linkedin.com/in/someone/');
  eq(U.activityUrl('someone'), 'https://www.linkedin.com/in/someone/recent-activity/all/');
});

check('a post permalink is the same URL the Copy link menu produces', () => {
  eq(U.postUrlFromActivityId('7100000000000000000'), 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000000/');
  eq(U.postUrlFromActivityId(null), null);
});

/* ================================================================== */
group('csvCell — a post body must not be able to break a row');

check('plain values are quoted', () => {
  eq(U.csvCell('hello'), '"hello"');
  eq(U.csvCell(42), '"42"');
});

check('null and undefined become an empty field, not the string "null"', () => {
  eq(U.csvCell(null), '');
  eq(U.csvCell(undefined), '');
});

check('embedded quotes are doubled', () => {
  eq(U.csvCell('say "hi"'), '"say ""hi"""');
});

check('newlines are escaped to \\n rather than quoted through', () => {
  eq(U.csvCell('line one\nline two'), '"line one\\nline two"');
  eq(U.csvCell('crlf\r\nhere'), '"crlf\\nhere"');
  eq(U.csvCell('bare cr\rhere'), '"bare cr\\nhere"');
});

check('an existing backslash is escaped first so \\n stays unambiguous', () => {
  eq(U.csvCell('path\\to\nthing'), '"path\\\\to\\nthing"');
});

check('commas are safe inside quotes', () => {
  eq(U.csvCell('a,b,c'), '"a,b,c"');
});

check('a leading =, +, - or @ is defused so the cell is not run as a formula', () => {
  eq(U.csvCell('=1+1'), '"\'=1+1"');
  eq(U.csvCell('@SUM(A1)'), '"\'@SUM(A1)"');
  eq(U.csvCell('-5'), '"\'-5"');
});

check('a row joins with commas and ends CRLF', () => {
  eq(U.csvRow(['a', 'b']), '"a","b"\r\n');
});

check('a realistic post body survives intact', () => {
  const body = 'Excited to share!\n\n"Growth" is a team sport, not a solo one.\nDM me → x, y, z.';
  const cell = U.csvCell(body);
  eq(cell.indexOf('\n'), -1, 'no raw newline may survive');
  eq(cell.indexOf('\r'), -1, 'no raw carriage return may survive');
  eq(cell.charAt(0), '"');
  eq(cell.charAt(cell.length - 1), '"');
});

/* ================================================================== */
group('formatting');

check('formatCount abbreviates', () => {
  eq(U.formatCount(999), '999');
  eq(U.formatCount(1500), '1.5K');
  eq(U.formatCount(2000000), '2M');
  eq(U.formatCount(null), '—');
});

check('fmtDuration reads naturally at each scale', () => {
  eq(U.fmtDuration(45), '45s');
  eq(U.fmtDuration(600), '10 min');
  eq(U.fmtDuration(7200), '2h 0m');
});

check('fmtTimestamp is always UTC and never throws on junk', () => {
  eq(U.fmtTimestamp(0), 'unknown');
  eq(U.fmtTimestamp(1700000000000), '2023-11-14 22:13:20 UTC');
  eq(U.fmtTimestamp('nonsense'), 'unknown');
});

check('reactionLabel maps the known enum and title-cases the rest', () => {
  eq(U.reactionLabel('PRAISE'), 'Celebrate');
  eq(U.reactionLabel('EMPATHY'), 'Love');
  eq(U.reactionLabel('SOME_NEW_THING'), 'Some new thing');
  eq(U.reactionLabel(''), 'Other');
});

group('sanitizeSegment — filenames');

check('path separators and reserved characters are replaced', () => {
  eq(U.sanitizeSegment('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
});

check('leading and trailing dots and spaces are trimmed', () => {
  eq(U.sanitizeSegment('  ..name..  '), 'name');
});

check('an empty result falls back rather than producing an unnamed entry', () => {
  eq(U.sanitizeSegment('', 'fallback'), 'fallback');
  eq(U.sanitizeSegment('...', 'fallback'), 'fallback');
});

/* ================================================================== */
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
