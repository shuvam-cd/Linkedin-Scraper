/*
 * wiring-check.mjs — static checks that need no browser.
 *
 *   node tools/wiring-check.mjs
 *
 * There is no build step here, which is a feature: what you load unpacked is
 * what you read. The cost is that a typo in an element id, a file listed in
 * the manifest that does not exist, or a message name only one side knows
 * about all fail silently at runtime — usually as "the popup is blank" or
 * "nothing happens when I press Start".
 *
 * These are text-level checks, not a parser. They are deliberately shallow:
 * they catch the mistakes that a missing type system lets through, and they
 * will never catch a logic error.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const note = fn();
    passed++;
    process.stdout.write(`  ok   ${name}${note ? ` (${note})` : ''}\n`);
  } catch (err) {
    failures.push(name);
    process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
  }
}
const group = (t) => process.stdout.write(`\n${t}\n`);

/* ================================================================== */
group('manifest');

const manifest = JSON.parse(read('manifest.json'));

check('every file the manifest names exists', () => {
  const refs = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((c) => c.js)
  ];
  const missing = [...new Set(refs)].filter((f) => !existsSync(join(root, f)));
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  return `${new Set(refs).size} files`;
});

check('content scripts load utils and voyager before content', () => {
  const js = manifest.content_scripts[0].js;
  const iU = js.indexOf('utils.js');
  const iV = js.indexOf('voyager.js');
  const iC = js.indexOf('content.js');
  if (iU < 0 || iV < 0 || iC < 0) throw new Error(`expected all three, got ${js.join(', ')}`);
  if (!(iU < iC && iV < iC)) throw new Error(`content.js must come last: ${js.join(', ')}`);
});

check('the background injection list matches the manifest content scripts', () => {
  const bg = read('background.js');
  const m = bg.match(/files:\s*\[([^\]]+)\]/);
  if (!m) throw new Error('no executeScript files list found in background.js');
  const injected = m[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  const declared = manifest.content_scripts[0].js;
  if (JSON.stringify(injected) !== JSON.stringify(declared)) {
    throw new Error(`manifest ${declared.join(',')} vs inject ${injected.join(',')}`);
  }
});

check('host permissions cover both origins the extension fetches from', () => {
  const h = manifest.host_permissions.join(' ');
  for (const need of ['linkedin.com', 'licdn.com']) {
    if (!h.includes(need)) throw new Error(`missing host permission for ${need}`);
  }
});

check('required permissions are declared', () => {
  for (const p of ['storage', 'downloads', 'scripting', 'activeTab', 'unlimitedStorage', 'offscreen']) {
    if (!manifest.permissions.includes(p)) throw new Error(`missing permission: ${p}`);
  }
});

/* ================================================================== */
group('popup wiring');

const popupHtml = read('popup.html');
const popupJs = read('popup.js');
const shellJs = read('ui/shell.js');

const htmlIds = new Set([...popupHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

function idsUsedBy(src) {
  return new Set([...src.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]));
}

check('every element popup.js looks up exists in popup.html', () => {
  const missing = [...idsUsedBy(popupJs)].filter((id) => !htmlIds.has(id));
  if (missing.length) throw new Error(`not in popup.html: ${missing.join(', ')}`);
  return `${idsUsedBy(popupJs).size} ids`;
});

check('every element ui/shell.js looks up exists in popup.html', () => {
  const missing = [...idsUsedBy(shellJs)].filter((id) => !htmlIds.has(id));
  if (missing.length) throw new Error(`not in popup.html: ${missing.join(', ')}`);
  return `${idsUsedBy(shellJs).size} ids`;
});

check('shell.js can mirror the post count into the status bar', () => {
  // shell.js observes #statPosts and copies it to #footPosts.
  for (const id of ['statPosts', 'footPosts']) {
    if (!htmlIds.has(id)) throw new Error(`#${id} is missing — the status bar would stay at 0`);
  }
});

check('popup.html loads utils.js before popup.js', () => {
  const iU = popupHtml.indexOf('src="utils.js"');
  const iP = popupHtml.indexOf('src="popup.js"');
  if (iU < 0 || iP < 0 || iU > iP) throw new Error('utils.js must be loaded first');
});

check('every option checkbox in the markup is read by popup.js', () => {
  const boxes = [...popupHtml.matchAll(/id="(opt[A-Za-z]+)"/g)].map((m) => m[1]);
  const missing = boxes.filter((b) => !popupJs.includes(b));
  if (missing.length) throw new Error(`not read by popup.js: ${missing.join(', ')}`);
  return boxes.join(', ');
});

check('the four option chips the spec calls for are present', () => {
  for (const id of ['optIncludePosts', 'optIncludeComments', 'optSkipVideos', 'optIncludeProfileMedia']) {
    if (!htmlIds.has(id)) throw new Error(`missing chip: ${id}`);
  }
});

check('comments default to off in the markup', () => {
  const m = popupHtml.match(/id="optIncludeComments"[^>]*>/);
  if (!m) throw new Error('checkbox not found');
  if (/\bchecked\b/.test(m[0])) throw new Error('comments must not be checked by default');
});

check('the target presets are 50 / 100 / 250 / All', () => {
  const ns = [...popupHtml.matchAll(/class="preset" data-n="(\d+)"/g)].map((m) => Number(m[1]));
  const expected = [50, 100, 250, 500];
  if (JSON.stringify(ns) !== JSON.stringify(expected)) {
    throw new Error(`got ${ns.join(',')} — expected ${expected.join(',')}`);
  }
});

/* ================================================================== */
group('message symmetry');

const utils = read('utils.js');
const contentJs = read('content.js');
const backgroundJs = read('background.js');
const offscreenJs = read('offscreen.js');

// The export layout checks below compare against the real POST_TYPES list.
new Function(utils)();

// CFG is preceded by a worked example inside a block comment. Reading code
// state out of prose would report the example's `enabled: true` as shipped
// configuration, so comments come out before any CFG assertion.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const contentCode = stripComments(contentJs);

// Scoped to the MSG literal — KEYS and REACTION_LABELS sit at the same indent.
const msgBlock = utils.slice(utils.indexOf('const MSG = {'), utils.indexOf('const KEYS = {'));
const msgNames = [...msgBlock.matchAll(/^\s+([A-Z_]+):\s*'[^']+'/gm)].map((m) => m[1]);

check('every message name in MSG is used somewhere', () => {
  const all = popupJs + contentJs + backgroundJs;
  const unused = msgNames.filter((n) => !new RegExp(`MSG\\.${n}\\b`).test(all));
  if (unused.length) throw new Error(`declared but never used: ${unused.join(', ')}`);
  return `${msgNames.length} names`;
});

check('every message the content script emits is handled by the worker', () => {
  const emitted = [...contentJs.matchAll(/emit\(MSG\.([A-Z_]+)/g)].map((m) => m[1]);
  const unhandled = [...new Set(emitted)].filter((n) => !new RegExp(`case MSG\\.${n}:`).test(backgroundJs));
  if (unhandled.length) throw new Error(`emitted but unhandled: ${unhandled.join(', ')}`);
  return `${new Set(emitted).size} emitted`;
});

check('every message the popup sends is handled by the worker', () => {
  const sent = [...popupJs.matchAll(/type:\s*MSG\.([A-Z_]+)/g)].map((m) => m[1]);
  const unhandled = [...new Set(sent)].filter((n) => !new RegExp(`case MSG\\.${n}:`).test(backgroundJs));
  if (unhandled.length) throw new Error(`sent but unhandled: ${unhandled.join(', ')}`);
  return `${new Set(sent).size} sent`;
});

check('every offscreen message the worker sends is handled there', () => {
  const offscreen = read('offscreen.js');
  const sent = [...backgroundJs.matchAll(/offscreenSend\(\{\s*type:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
  const unhandled = [...new Set(sent)].filter((n) => !offscreen.includes(`case '${n}':`));
  if (unhandled.length) throw new Error(`sent but unhandled: ${unhandled.join(', ')}`);
  return `${new Set(sent).size} sent`;
});

check('the worker ignores messages addressed to the offscreen document', () => {
  // Both listen on chrome.runtime.onMessage; without this guard the worker
  // answers ZIP_ADD with "unknown message" and races the real handler.
  if (!/msg\.target === 'offscreen'/.test(backgroundJs)) {
    throw new Error('background.js must skip msg.target === "offscreen"');
  }
});

/* ================================================================== */
group('safety limits');

check('LIMITS match the specified floors exactly', () => {
  const want = {
    MIN_REQUEST_GAP_MS: '3000',
    RATE_LIMIT_PAUSE_MS: '180000',
    MAX_RETRIES: '2',
    MAX_POSTS: '500',
    SESSION_MAX_REQUESTS: '300',
    MAX_COMMENTS_PER_POST: '150',
    MAX_COMMENT_PAGES: '8'
  };
  for (const [k, v] of Object.entries(want)) {
    const m = utils.match(new RegExp(`${k}:\\s*([0-9]+)`));
    if (!m) throw new Error(`${k} not found`);
    if (m[1] !== v) throw new Error(`${k} is ${m[1]}, expected ${v}`);
  }
  for (const [k, v] of [['PAGE_DELAY', '[3000, 7000]'], ['DETAIL_DELAY', '[4000, 9000]']]) {
    if (!utils.includes(`${k}: ${v}`)) throw new Error(`${k} must be ${v}`);
  }
});

check('HTTP 999 is handled and never auto-retried', () => {
  if (!/res\.status === 999/.test(contentJs)) throw new Error('999 is not handled');
  const block = contentJs.slice(contentJs.indexOf('res.status === 999'), contentJs.indexOf('res.status === 429'));
  if (!/requireAttention/.test(block)) throw new Error('999 must pause and surface, not retry');
  if (/coolOff/.test(block)) throw new Error('999 must not cool off and retry automatically');
});

check('challenges are surfaced, never solved', () => {
  for (const forbidden of ['captcha-solv', 'recaptcha', '2captcha', 'anticaptcha', 'solveCaptcha']) {
    if (contentJs.toLowerCase().includes(forbidden.toLowerCase())) {
      throw new Error(`content.js references ${forbidden}`);
    }
  }
  if (!/requireAttention\('challenge'/.test(contentJs)) throw new Error('no challenge pause path');
});

check('nothing gates the run on the li_at cookie', () => {
  /*
   * Regression guard. `li_at` is HttpOnly, so document.cookie never contains
   * it on a real session. A login check that required it refused every valid
   * session — this shipped once and made the extension unusable.
   */
  const v = read('voyager.js');
  if (/hasSession/.test(v) || /hasSession/.test(contentJs)) {
    throw new Error('hasSession() encoded exactly this mistake — use sessionState() in content.js');
  }
  const uses = contentCode.match(/li_at/g) || [];
  if (uses.length > 1) throw new Error(`content.js reads li_at ${uses.length} times — it must never be required`);
  // The verdict has to consider the page, not just cookies.
  for (const need of ['signInCtaPresent', 'memberChromePresent', 'sessionState']) {
    if (!contentCode.includes(need)) throw new Error(`missing ${need}() — cookies alone cannot answer this`);
  }
});

check('a refusal to start carries the reason that produced it', () => {
  if (!/error: 'not-logged-in', why:/.test(contentJs)) {
    throw new Error('content.js must send `why` with a not-logged-in refusal');
  }
  if (!/res\.why/.test(backgroundJs)) {
    throw new Error('background.js must surface `why` instead of a generic "log in first"');
  }
});

check('a checkpoint and a sign-in wall are handled as different problems', () => {
  if (!/onChallengePage\s*=\s*\(pathname\)\s*=>\s*\/\^\\\/checkpoint/.test(contentCode)) {
    throw new Error('onChallengePage must match /checkpoint/ only');
  }
  if (!contentCode.includes('onLoginPage')) throw new Error('no separate login-wall predicate');
  if (!contentCode.includes('LOGIN_MSG')) throw new Error('no distinct login message');
});

check('no user-agent or client fingerprint is forged', () => {
  const v = read('voyager.js');
  for (const h of ['user-agent', 'x-li-track', 'sec-ch-ua', 'x-forwarded-for']) {
    if (v.toLowerCase().includes(`'${h}'`) || v.toLowerCase().includes(`"${h}"`)) {
      throw new Error(`voyager.js sets ${h}`);
    }
  }
});

check('no endpoint path is hardcoded — Strategy A ships disabled', () => {
  for (const block of ['profile', 'posts', 'comments', 'reactions']) {
    const m = contentCode.match(new RegExp(`${block}:\\s*\\{[^}]*?enabled:\\s*(true|false)`, 's'));
    if (!m) throw new Error(`CFG.${block} has no enabled flag`);
    if (m[1] !== 'false') throw new Error(`CFG.${block}.enabled must ship as false`);
  }
  // A decorationId or queryId committed to the repo would be stale on arrival.
  const suspicious = contentCode.match(/(decorationId|queryId)['"]?\s*:\s*['"][^'"]+['"]/g);
  if (suspicious) throw new Error(`hardcoded values present: ${suspicious.join(', ')}`);
});

/* ================================================================== */
group('export layout');

check('every path the spec names is produced by zipEntries', () => {
  for (const frag of [
    '/Profile/profile.txt',
    '/Profile/profile.json',
    '/Profile/experience.txt',
    '/Profile/education.txt',
    '/Profile/profile_picture.',
    '/Profile/banner.',
    '/Posts/${folderForType(',
    '/post.txt',
    '/metadata.txt',
    '_comments.txt',
    '/document.txt',
    '/posts.csv',
    '/README.txt',
    '/video_not_downloaded.txt',
    '_frames'
  ]) {
    if (!backgroundJs.includes(frag)) throw new Error(`no entry produces ${frag}`);
  }
});

check('every post type maps to a folder', () => {
  const m = backgroundJs.match(/const TYPE_FOLDER = \{([\s\S]*?)\}/);
  if (!m) throw new Error('TYPE_FOLDER not found');
  const mapped = (m[1].match(/(\w+):/g) || []).map((s) => s.replace(':', ''));
  for (const t of globalThis.LIS.POST_TYPES) {
    if (!mapped.includes(t)) throw new Error(`post type "${t}" has no folder`);
  }
  return `${mapped.length} types`;
});

check('posts.csv has exactly the specified columns, in order', () => {
  const m = backgroundJs.match(/const head = \[([^\]]+)\]/);
  if (!m) throw new Error('csv header not found');
  const cols = m[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  const want = ['post_url', 'date', 'type', 'folder', 'text', 'reactions', 'comments', 'reposts', 'media_count'];
  if (JSON.stringify(cols) !== JSON.stringify(want)) {
    throw new Error(`got ${cols.join(',')}`);
  }
});

check('comments are gated on the option and kept in one folder', () => {
  if (!/options\.includeComments\)\s*\{\s*items\.push\(\{\s*path: `\$\{root\}\/Comments\//.test(backgroundJs)) {
    throw new Error('comments are not gated on options.includeComments, or are not under Comments/');
  }
});

check('a downloadable video is queued for frame extraction', () => {
  if (!/video: \{ framesDir:/.test(backgroundJs)) throw new Error('no frame instruction is emitted');
  if (!/intervalSec: 1/.test(backgroundJs)) throw new Error('the one-per-second interval is gone');
  if (!/extractFrames/.test(offscreenJs)) throw new Error('the offscreen document does not extract frames');
});

check('README.txt carries the third-party data note when comments are on', () => {
  const i = backgroundJs.indexOf('function readmeFileText');
  const body = backgroundJs.slice(i, i + 4000);
  if (!/third-party personal data/i.test(body)) throw new Error('note text missing');
  if (!/state\.options\.includeComments/.test(body)) throw new Error('note is not conditional');
});

/* ================================================================== */
group('namespace hygiene');

check('no Instagram-era global survived the port', () => {
  const files = ['utils.js', 'voyager.js', 'content.js', 'background.js', 'popup.js', 'offscreen.js', 'ui/shell.js', 'zipwriter.js'];
  const bad = [];
  for (const f of files) {
    const src = read(f);
    for (const g of ['globalThis.IGS', 'IGSZip', 'igs_state', 'igs_posts', 'igs_theme', 'igs_form']) {
      if (src.includes(g)) bad.push(`${f}: ${g}`);
    }
  }
  if (bad.length) throw new Error(bad.join(', '));
  return `${files.length} files`;
});

check('storage keys are all lis_-prefixed and consistent', () => {
  const keys = [...utils.matchAll(/'(lis_[a-z_]+)'/g)].map((m) => m[1]);
  if (!keys.includes('lis_state') || !keys.includes('lis_index')) throw new Error('core keys missing');
  const chunkRe = backgroundJs.match(/\/\^(lis_posts_)\\d\+\$\//);
  if (!chunkRe) throw new Error('background.js chunk-key regex does not match the lis_ prefix');
});

/* ================================================================== */
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
