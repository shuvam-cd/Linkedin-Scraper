/*
 * regression-test.mjs — one case per bug fixed in 1.0.2.
 *
 *   node tools/regression-test.mjs
 *
 * Every bug this file guards lived in the *async glue* — tab navigation,
 * ports, timers, service-worker lifetime — which is precisely the ground the
 * other four suites do not cover. They tested pure functions and were fully
 * green while the extension was failing to start a run at all.
 *
 * Some of what follows is therefore a source assertion rather than a call.
 * That is a deliberate trade: a racy `setTimeout` against a live Chrome tab
 * cannot be exercised here, but the shape of the code that caused it can be
 * pinned so the same mistake cannot quietly return. wiring-check.mjs already
 * works this way for the li_at and endpoint rules.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/* ---------------- harness ---------------- */
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
/**
 * The frame extractor is genuinely asynchronous — it awaits a seek per frame —
 * so it needs a variant that waits. Kept separate from `check` rather than
 * making that async, so the synchronous cases keep printing in source order.
 */
async function checkAsync(name, fn) {
  try {
    const note = await fn();
    passed++;
    process.stdout.write(`  ok   ${name}${note ? ` (${note})` : ''}\n`);
  } catch (err) {
    failures.push(name);
    process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
  }
}

function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what || 'value'}\n       expected ${JSON.stringify(b)}\n       actual   ${JSON.stringify(a)}`);
  }
}
const ok = (c, w) => {
  if (!c) throw new Error(w || 'expected truthy');
};
const group = (t) => process.stdout.write(`\n${t}\n`);

const BG_SRC = read('background.js');
const CS_SRC = read('content.js');
const OS_SRC = read('offscreen.js');
const VY_SRC = read('voyager.js');
const PU_SRC = read('popup.js');

/**
 * Comments in this project describe the bug that was fixed, so they quote the
 * very code being asserted against. Counting occurrences has to look at the
 * code alone or a good comment fails the test.
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * One function's source, ending at its own closing brace rather than at
 * whatever happens to be declared next — so inserting a helper below it does
 * not silently widen every assertion made about it.
 */
const fnBody = (decl, src) => {
  const from = (src || CS_SRC).indexOf(decl);
  if (from < 0) throw new Error(`not found: ${decl}`);
  const end = (src || CS_SRC).indexOf('\n  }\n', from);
  return (src || CS_SRC).slice(from, end < 0 ? undefined : end + 4);
};

/* ---------------- load background.js ---------------- */
const ev = () => ({ addListener: () => {}, removeListener: () => {} });
const chromeStub = {
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  tabs: { onRemoved: ev(), onUpdated: ev(), get: async () => ({}), query: async () => [], create: async () => ({}), update: async () => ({}), sendMessage: async () => ({}) },
  windows: { update: async () => {} },
  runtime: { onConnect: ev(), onMessage: ev(), onInstalled: ev(), onStartup: ev(), sendMessage: async () => {}, getPlatformInfo: async () => ({}) },
  downloads: { onCreated: ev(), onChanged: ev(), onDeterminingFilename: ev(), search: async () => [], download: async () => 1 },
  scripting: { executeScript: async () => {} },
  offscreen: { hasDocument: async () => false, createDocument: async () => {}, closeDocument: async () => {} }
};
const BG = new Function(
  'importScripts',
  'chrome',
  `${BG_SRC}
   return { samePage, isLinkedInTab, needsMoreWork, blankState, mergeProfileRecords };`
)(() => new Function(read('utils.js'))(), chromeStub);

/**
 * A fresh worker over a storage stub of the caller's choosing, with its
 * persistence internals exposed — for tests about what is on disk.
 */
function loadBackground(storage) {
  const local = Object.assign({ get: async () => ({}), set: async () => {}, remove: async () => {} }, storage || {});
  const stub = Object.assign({}, chromeStub, { storage: { local } });
  return new Function(
    'importScripts',
    'chrome',
    `${BG_SRC}
     return { loadFromStorage, persist, posts: () => posts, dirty: () => dirtyChunks, state: () => state };`
  )(() => new Function(read('utils.js'))(), stub);
}

/* ---------------- load content.js ---------------- */
globalThis.window = globalThis;
new Function(read('utils.js'))();
new Function(read('voyager.js'))();
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: () => {} },
    connect: () => ({ postMessage: () => {}, onDisconnect: { addListener: () => {} } })
  }
};
globalThis.__LIS_TEST__ = {};
globalThis.location = { pathname: '/in/someone/', href: 'https://www.linkedin.com/in/someone/' };
globalThis.document = {
  cookie: '',
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: {},
  body: {}
};
new Function(CS_SRC)();
const E = globalThis.__LIS_TEST__;

/* ================================================================== *
 * 1. waitForTabLoad believed the *previous* page's `complete`
 *
 * chrome.tabs.update() does not flip a tab to `loading` synchronously, so the
 * old status check passed instantly, the 900 ms settle elapsed before the new
 * page existed, and CS_START was delivered into a document being torn down.
 * The visible result was "Could not reach the page. Reload the LinkedIn tab
 * and try again." — intermittently, which is what made it hard to place.
 * ================================================================== */
group('waitForTabLoad — the navigation race');

check('samePage ignores the ?trk= LinkedIn appends to everything', () => {
  ok(BG.samePage('https://www.linkedin.com/in/ada/?trk=nav', 'https://www.linkedin.com/in/ada/'));
});

check('samePage ignores a trailing slash and a fragment', () => {
  ok(BG.samePage('https://www.linkedin.com/in/ada', 'https://www.linkedin.com/in/ada/#exp'));
});

check('samePage separates the profile from its activity feed', () => {
  ok(
    !BG.samePage(
      'https://www.linkedin.com/in/ada/',
      'https://www.linkedin.com/in/ada/recent-activity/all/'
    ),
    'the profile->activity handoff must count as a real navigation'
  );
});

check('samePage separates two different profiles', () => {
  ok(!BG.samePage('https://www.linkedin.com/in/ada/', 'https://www.linkedin.com/in/grace/'));
});

check('samePage returns false for junk rather than throwing', () => {
  eq(BG.samePage('not a url', 'https://www.linkedin.com/in/ada/'), false);
});

check('the load wait takes the URL it is waiting for', () => {
  ok(
    /function waitForTabLoad\(\s*tabId\s*,\s*expectUrl/.test(BG_SRC),
    'waitForTabLoad must be told which page counts as loaded'
  );
});

check('`complete` is only believed when the tab is showing the target', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('function waitForTabLoad'));
  ok(/atTarget\s*=\s*\(t\)\s*=>[^;]*samePage/.test(body), 'the status check must be paired with a URL check');
});

check('both call sites pass the URL they navigated to', () => {
  ok(/waitForTabLoad\(tabId, target\)/.test(BG_SRC), 'startScrape');
  ok(/waitForTabLoad\(state\.tabId, url\)/.test(BG_SRC), 'continueAt');
  ok(!/waitForTabLoad\([^,)]*\)/.test(BG_SRC.replace(/function waitForTabLoad\([^)]*\)/, '')), 'no bare call left');
});

check('a tab already on the target is not re-navigated', () => {
  ok(/navigated = false/.test(BG_SRC), 'reloading a good page only recreates the race');
});

/* ================================================================== *
 * 2. ensureLoaded() could wipe collected posts
 * ================================================================== */
group('ensureLoaded — the concurrent-load race');

check('the load is memoised as a promise, not just a finished flag', () => {
  ok(/let loadPromise/.test(BG_SRC) && /loadPromise = loadFromStorage\(\)/.test(BG_SRC));
});

check('a second caller reuses the first promise instead of reloading', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('function ensureLoaded'), BG_SRC.indexOf('async function loadFromStorage'));
  ok(/if \(!loadPromise\)/.test(body), 'must not start a second load while one is in flight');
});

check('the loader re-checks `loaded` after every await', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('async function loadFromStorage'));
  const guards = (body.slice(0, body.indexOf('loaded = true')).match(/if \(loaded\) return;/g) || []).length;
  ok(guards >= 2, `expected a guard after each await, found ${guards}`);
  return `${guards} guards`;
});

check('posts are swapped in atomically, never emptied then refilled', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('async function loadFromStorage'), BG_SRC.indexOf('function reindex'));
  ok(!/posts = \[\];/.test(body), 'clearing posts before an await is what dropped a live batch');
  ok(/posts = fresh;/.test(body));
});

/* ================================================================== *
 * 3. The session request budget reset mid-run
 * ================================================================== */
group('session budget — carried across the DOM handoff');

check('the content script starts from the count it was handed', () => {
  ok(/S\.requests = Number\(cfg\.requestsSoFar\) \|\| 0;/.test(CS_SRC), 'must not hard-reset to 0');
  ok(!/S\.requests = 0;/.test(CS_SRC), 'a bare reset would hand one sitting a second allowance');
});

check('continueAt passes the spend so far', () => {
  ok(/requestsSoFar: state\.requests/.test(BG_SRC));
});

check('a fresh run still starts the budget at zero', () => {
  ok(/requestsSoFar: 0/.test(BG_SRC), 'runCfg default — a new sitting gets a full allowance');
});

check('the carried count is published before the first request', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('S.requests = Number(cfg.requestsSoFar)'));
  ok(/emitProgress\(true\)/.test(body.slice(0, 400)), 'otherwise the meter reads 0 until the tenth request');
});

/* ================================================================== *
 * 4. The heartbeat interval leaked on every reconnect
 * ================================================================== */
group('heartbeat — one timer, not one per reconnect');

check('the interval is created in exactly one place', () => {
  const n = (stripComments(CS_SRC).match(/setInterval\(/g) || []).length;
  eq(n, 1, 'content.js should own a single interval');
});

check('starting the heartbeat clears any previous one first', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('function startHeartbeat'), CS_SRC.indexOf('function connectPort'));
  ok(/stopHeartbeat\(\);/.test(body), 'without this each reconnect orphans a live timer');
});

check('a disconnect outside a run stops the heartbeat', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('function connectPort'), CS_SRC.indexOf('function emit'));
  ok(/else stopHeartbeat\(\)/.test(body), 'an orphan would reconnect forever and hold the worker awake');
});

check('the run cleans the timer up through the same helper', () => {
  ok(/S\.active = false;\s*\n\s*stopHeartbeat\(\);/.test(CS_SRC));
});

/* ================================================================== *
 * 5. The worker could be evicted mid-package or mid-stop
 * ================================================================== */
group('service-worker keep-alive');

check('a keep-alive exists and is reference counted', () => {
  ok(/function keepAliveStart/.test(BG_SRC) && /keepAliveDepth/.test(BG_SRC));
});

check('it makes a real API call — a bare timer does not reset the idle clock', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('function keepAliveStart'), BG_SRC.indexOf('function keepAliveStop'));
  ok(/chrome\.runtime\.getPlatformInfo\(\)/.test(body));
});

check('it fires well inside the ~30 s eviction window', () => {
  const m = BG_SRC.slice(BG_SRC.indexOf('function keepAliveStart')).match(/\}, (\d+)\);/);
  ok(m && Number(m[1]) <= 25000, `interval ${m && m[1]}ms must be under the eviction timeout`);
  return `${m[1]}ms`;
});

check('packaging holds the worker up for its whole run', () => {
  ok(/keepAliveStart\(\);\s*\n\s*try \{/.test(BG_SRC), 'started before the try');
  ok(/keepAliveStop\(\);\s*\n\s*\}\s*\n\}/.test(BG_SRC), 'released in the finally');
});

check('the stop-settle timer is covered too', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('async function stopScrape'), BG_SRC.indexOf('async function resumeScrape'));
  ok(/keepAliveStart\(\)/.test(body) && /keepAliveStop\(\)/.test(body), 'otherwise the UI sticks on "Stopping"');
});

/* ================================================================== *
 * 6. Comment paging returned the same comments over and over
 * ================================================================== */
group('comment paging');

check('comments are de-duped by author, time and text', () => {
  const a = { author: 'Ada', at: 1700000000000, text: 'Nice work' };
  const b = { author: 'Ada', at: 1700000000000, text: 'Nice work' };
  const c = { author: 'Ada', at: 1700000000001, text: 'Nice work' };
  eq(E.commentKey(a), E.commentKey(b), 'the same comment twice must collapse');
  ok(E.commentKey(a) !== E.commentKey(c), 'a different timestamp is a different comment');
});

check('two commenters with identical text stay separate', () => {
  ok(
    E.commentKey({ author: 'Ada', at: 1, text: 'Congrats!' }) !==
      E.commentKey({ author: 'Grace', at: 1, text: 'Congrats!' })
  );
});

check('the unpaged by-type fallback runs once and stops', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function fetchComments'), CS_SRC.indexOf('async function commentPass'));
  ok(/unpaged = true/.test(body) && /if \(unpaged \|\| fresh === 0\) break;/.test(body));
});

check('a page with nothing new ends the loop', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function fetchComments'), CS_SRC.indexOf('async function commentPass'));
  ok(/fresh === 0/.test(body), 'otherwise paging spins against a stalled cursor');
});

check('a configured endpoint answering "none" is final', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function fetchComments'), CS_SRC.indexOf('async function commentPass'));
  ok(!/if \(list\.length\) return \{ list, truncated \};/.test(body), 'falling through spent a request per post');
});

check('the finder failing still falls back to the post page', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function fetchComments'), CS_SRC.indexOf('async function commentPass'));
  ok(/catch \(err\)/.test(body) && /if \(err instanceof Abort\) throw err;/.test(body), 'but a Stop must still unwind');
});

/* ================================================================== *
 * 7. A repurposed tab was navigated away
 * ================================================================== */
group('tab ownership');

check('a tab showing something else is not claimed', () => {
  eq(BG.isLinkedInTab({ url: 'https://mail.google.com/' }), false);
  eq(BG.isLinkedInTab({ url: 'https://www.linkedin.com/feed/' }), true);
});

check('a tab whose URL is hidden is not claimed', () => {
  eq(BG.isLinkedInTab({}), false, 'no host permission means not ours to navigate');
  eq(BG.isLinkedInTab(null), false);
});

check('the remembered tab id is re-checked before reuse', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('async function ensureTab'), BG_SRC.indexOf('function waitForTabLoad'));
  ok(/if \(isLinkedInTab\(t\)\) tab = t;/.test(body), 'the user may have repurposed it since');
});

/* ================================================================== *
 * 8. Reposts were filed under the original post's id
 * ================================================================== */
group('repost identity');

check("a repost keeps its own activity id, not the original's", () => {
  const p = E.mapUpdate({
    entityUrn: 'urn:li:fsd_update:(urn:li:activity:7200000000000000001,FEED,EMPTY)',
    resharedUpdate: {
      entityUrn: 'urn:li:fsd_update:(urn:li:activity:7100000000000000002,FEED,EMPTY)',
      commentary: { text: 'the original post' }
    }
  });
  eq(p.activityId, '7200000000000000001', 'the outer update is the post being collected');
  eq(p.type, 'repost');
});

check('its permalink points at the repost', () => {
  const p = E.mapUpdate({
    entityUrn: 'urn:li:fsd_update:(urn:li:activity:7200000000000000001,FEED,EMPTY)',
    resharedUpdate: { entityUrn: 'urn:li:activity:7100000000000000002' }
  });
  ok(p.postUrl.includes('7200000000000000001'), p.postUrl);
  ok(!p.postUrl.includes('7100000000000000002'), 'must not link to somebody else’s post');
});

check('the recorded URN matches the recorded id', () => {
  const p = E.mapUpdate({
    entityUrn: 'urn:li:fsd_update:(urn:li:activity:7200000000000000001,FEED,EMPTY)',
    resharedUpdate: { entityUrn: 'urn:li:activity:7100000000000000002' }
  });
  eq(globalThis.LISVoyager.activityId(p.urn), p.activityId);
});

check('a plain post is unaffected', () => {
  const p = E.mapUpdate({
    entityUrn: 'urn:li:fsd_update:(urn:li:activity:7300000000000000003,FEED,EMPTY)',
    commentary: { text: 'hello' }
  });
  eq(p.activityId, '7300000000000000003');
  eq(p.text, 'hello');
});

check('a URN-only stub from the embedded payload still maps', () => {
  const p = E.mapUpdate({ entityUrn: 'urn:li:activity:7400000000000000004' });
  eq(p.activityId, '7400000000000000004');
});

/* ================================================================== *
 * 9. Non-ASCII profile slugs re-fetched a page already open
 * ================================================================== */
group('profile-page detection');

check('an ASCII slug matches the open page', () => {
  globalThis.location = { pathname: '/in/ada-lovelace/', href: '' };
  ok(E.onProfilePageFor('ada-lovelace'));
});

check('a percent-encoded non-ASCII slug matches its decoded id', () => {
  globalThis.location = { pathname: '/in/%C3%B8yvind-hansen', href: '' };
  ok(E.onProfilePageFor('øyvind-hansen'), 'this refetched the open page before the fix');
});

check('a different profile does not match', () => {
  globalThis.location = { pathname: '/in/grace-hopper/', href: '' };
  ok(!E.onProfilePageFor('ada-lovelace'));
});

check('a profile sub-page does not match', () => {
  globalThis.location = { pathname: '/in/ada-lovelace/recent-activity/all/', href: '' };
  ok(!E.onProfilePageFor('ada-lovelace'), 'the activity feed is a different document');
});

check('a malformed escape is compared raw rather than throwing', () => {
  globalThis.location = { pathname: '/in/%E0%A4%A', href: '' };
  eq(typeof E.onProfilePageFor('anything'), 'boolean');
});

/* ================================================================== *
 * 10. Overflow past the handoff limit vanished silently
 * ================================================================== */
group('handoff overflow');

check('carrying only part of the backlog is announced', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('function runCfg'), BG_SRC.indexOf('Keeping the worker alive'));
  ok(/needy\.length > HANDOFF_LIMIT/.test(body) && /addLog\(/.test(body), 'the rest would otherwise just be missing');
});

check('needsMoreWork still drives the list', () => {
  const done = { detailFetched: true, text: 'hi', reactions: 0, comments: 0, commentList: [] };
  eq(BG.needsMoreWork({ detailFetched: false }), true);
  eq(BG.needsMoreWork(done), false);
});

check('the worker and the content script agree on what is unfinished', () => {
  // They each wrote the rule out separately and had drifted: the worker only
  // checked detailFetched, so a post the run would have fetched — no text,
  // null counts, declared-but-missing media — was never handed back to it.
  // The embedded fallback makes URN-only stubs with detailFetched true.
  const U = globalThis.LIS;
  const base = { detailFetched: true, text: 'hi', reactions: 4, comments: 2 };
  eq(U.postNeedsDetail(base), false, 'a finished post');
  eq(U.postNeedsDetail(Object.assign({}, base, { text: '' })), true, 'no text');
  eq(U.postNeedsDetail(Object.assign({}, base, { text: '', type: 'image' })), false, 'an image may be wordless');
  eq(U.postNeedsDetail(Object.assign({}, base, { reactions: null })), true, 'null counts');
  eq(U.postNeedsDetail(Object.assign({}, base, { mediaIncomplete: true })), true, 'declared media missing');
  for (const p of [base, Object.assign({}, base, { text: '' })]) {
    eq(BG.needsMoreWork(Object.assign({ commentList: [] }, p)), U.postNeedsDetail(p), 'the two agree');
  }
  ok(/U\.postNeedsDetail/.test(read('content.js')), 'and the content script uses the shared one');
});

check('a resume picks up where the run was, not at the beginning', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('async function startScrape'), BG_SRC.indexOf('async function stopScrape'));
  // state.phase was written on every handoff and persisted, and nothing ever
  // read it — so an interrupted feed scroll resumed at 'main' and spent ten
  // requests of the budget getting back to where it already was.
  ok(/const keepPhase = /.test(body), 'the phase survives the state reset');
  ok(/state\.phase === 'posts-dom' \? U\.activityUrl/.test(body), 'and decides which page to open');
  const cfg = BG_SRC.slice(BG_SRC.indexOf('function runCfg'), BG_SRC.indexOf('function runCfg') + 1400);
  ok(/phase: state\.phase \|\| 'main'/.test(cfg), 'and the cfg carries it');
  // Resuming into the feed with no profile would export a run with no profile.
  ok(/keepProfile \? 'posts-dom' : 'main'/.test(body), 'only when the profile came with it');
});

check('a post with no comments is recorded as finished', () => {
  const U = globalThis.LIS;
  // `comments === 0` is normal and such a post never gets a list, so testing
  // only for the list read as "unfinished" forever — re-shipping finished
  // posts every resume and crowding needy ones out of the bounded handoff.
  eq(U.postNeedsComments({ comments: 0 }), false, 'zero comments is done');
  eq(U.postNeedsComments({ comments: 3 }), true, 'three and no list is not');
  eq(U.postNeedsComments({ comments: 3, commentList: [] }), false, 'a list settles it');
  const pass = read('content.js');
  const body = pass.slice(pass.indexOf('async function commentPass'));
  ok(/p\.comments === 0 && !Array\.isArray\(p\.commentList\)/.test(body), 'the pass records the skip');
  ok(/p\.commentList = \[\];/.test(body), 'as an empty list');
});

/* ================================================================== *
 * 11. The avatar error handler was attached after src
 * ================================================================== */
group('popup avatar');

check('onerror is set before src', () => {
  const src = read('popup.js');
  const body = src.slice(src.indexOf('if (p.photoUrl) {'), src.indexOf('} else {', src.indexOf('if (p.photoUrl) {')));
  ok(body.indexOf('onerror') < body.indexOf('avatar.src'), 'a cached failure fires before a later handler exists');
});

/* ================================================================== *
 * 12. Media collection swept up the author's avatar
 *
 * imagesFrom() walked the whole update graph for anything with `artifacts`,
 * and an update carries the poster's avatar, a reshared post's author avatar,
 * and publisher logos alongside the post's own photos. This is the bug behind
 * "it does not scrape the photos and videos properly": every post folder
 * opened with a profile picture as media_01.jpg, media_count was wrong on
 * every row of posts.csv, and a text-only post came back classified as an
 * image post because its media list was not empty.
 * ================================================================== */
group('media scope — content only, never the chrome around it');

const vimg = (tag) => ({
  rootUrl: `https://media.licdn.com/dms/image/v2/${tag}/`,
  artifacts: [
    { fileIdentifyingUrlPathSegment: `200_200/0/1?t=${tag}`, width: 200 },
    { fileIdentifyingUrlPathSegment: `800_800/0/1?t=${tag}`, width: 800 }
  ]
});
const avatarOf = (tag) => ({ image: { attributes: [{ detailData: { nonEntityProfilePicture: { vectorImage: vimg(tag) } } }] } });
const urnOf = (id) => `urn:li:fsd_update:(urn:li:activity:${id},FEED,EMPTY)`;
const tags = (post) => post.media.map((m) => String(m.url || m.manifestUrl).match(/v2\/([A-Z_0-9]+)\/|vid\/(\w+)/)).map((m) => (m ? m[1] || m[2] : '?'));

check('an image post yields its photos and not the author avatar', () => {
  const p = E.mapUpdate({
    entityUrn: urnOf('7200000000000000001'),
    actor: avatarOf('AVATAR'),
    commentary: { text: 'two photos' },
    content: {
      imageComponent: {
        images: [
          { attributes: [{ detailData: { vectorImage: vimg('PHOTO1') } }] },
          { attributes: [{ detailData: { vectorImage: vimg('PHOTO2') } }] }
        ]
      }
    }
  });
  eq(tags(p), ['PHOTO1', 'PHOTO2'], 'the avatar must not appear');
  eq(p.mediaCount, 2);
  return 'widest artifact each';
});

check('a text-only post has no media and is typed text', () => {
  const p = E.mapUpdate({
    entityUrn: urnOf('7200000000000000009'),
    actor: avatarOf('AVATAR'),
    commentary: { text: 'no picture attached' },
    socialDetail: { totalSocialActivityCounts: { numLikes: 9 } }
  });
  eq(p.mediaCount, 0, 'an avatar used to count as the post’s image');
  eq(p.type, 'text', 'which then made classifyPost call it an image post');
});

check('a repost keeps the original photo and drops both avatars', () => {
  const p = E.mapUpdate({
    entityUrn: urnOf('7200000000000000010'),
    actor: avatarOf('RESHARER'),
    commentary: { text: 'worth reading' },
    resharedUpdate: {
      actor: avatarOf('ORIGINALAUTHOR'),
      content: { imageComponent: { images: [{ attributes: [{ detailData: { vectorImage: vimg('REALPHOTO') } }] }] } }
    }
  });
  eq(tags(p), ['REALPHOTO']);
  eq(p.type, 'repost', 'a reshare is still a reshare');
});

check('a video post keeps the stream and drops the avatar and poster', () => {
  const p = E.mapUpdate({
    entityUrn: urnOf('7200000000000000002'),
    actor: avatarOf('AVATAR'),
    content: {
      linkedInVideoComponent: {
        videoPlayMetadata: {
          duration: 95000,
          thumbnail: vimg('POSTER'),
          progressiveStreams: [
            { bitRate: 500000, width: 640, streamingLocations: [{ url: 'https://dms.licdn.com/playlist/vid/360p' }] },
            { bitRate: 2500000, width: 1280, streamingLocations: [{ url: 'https://dms.licdn.com/playlist/vid/720p' }] }
          ]
        }
      }
    }
  });
  eq(p.mediaCount, 1, 'one video, no avatar, no poster as a separate file');
  eq(p.media[0].type, 'video');
  ok(/720p/.test(p.media[0].url), 'highest bitrate wins');
});

check('an adaptive-only video still records its manifest', () => {
  const p = E.mapUpdate({
    entityUrn: urnOf('7200000000000000003'),
    actor: avatarOf('AVATAR'),
    content: {
      linkedInVideoComponent: {
        videoPlayMetadata: {
          adaptiveStreams: [{ protocol: 'HLS', masterPlaylists: [{ url: 'https://dms.licdn.com/playlist/master.m3u8' }] }]
        }
      }
    }
  });
  eq(p.mediaCount, 1);
  eq(p.media[0].downloadable, false);
  ok(/master\.m3u8/.test(p.media[0].manifestUrl));
});

check('a document post is unaffected by the scoping', () => {
  const p = E.mapUpdate({
    entityUrn: urnOf('7200000000000000004'),
    actor: avatarOf('AVATAR'),
    content: {
      documentComponent: {
        document: { title: 'Q4 deck', totalPageCount: 12, transcribedDocumentUrl: 'https://media.licdn.com/dms/document/deck.pdf' }
      }
    }
  });
  eq(p.type, 'document');
  eq(p.media.filter((m) => m.type === 'document').length, 1);
});

check('the post body is not the author’s headline', () => {
  const p = E.mapUpdate({
    entityUrn: urnOf('7200000000000000005'),
    actor: {
      name: { text: 'Ada Lovelace' },
      description: { text: 'Analytical Engine pioneer, mathematician, and a very long headline indeed' }
    },
    commentary: { text: 'Short one.' }
  });
  eq(p.text, 'Short one.', 'the longest string used to win, headline included');
});

check('collectContent refuses to descend into identity containers', () => {
  const found = E.collectContent({ actor: { deep: { marker: 1 } }, content: { marker: 2 } }, (n) => n.marker != null);
  eq(found.map((n) => n.marker), [2]);
});

check('collectContent skips the starred twin of a skipped key', () => {
  const found = E.collectContent({ '*actor': { marker: 1 }, content: { marker: 2 } }, (n) => n.marker != null);
  eq(found.map((n) => n.marker), [2], 'an unresolved reference names the same thing');
});

check('collectContent survives a cyclic graph', () => {
  const a = { marker: 1 };
  a.self = a;
  a.content = { marker: 2, back: a };
  eq(E.collectContent(a, (n) => n.marker != null).length, 2);
});

/* ================================================================== *
 * 13. The detail pass could shrink a post's media list
 * ================================================================== */
group('detail pass — media merges, never replaces');

check('media found by the harvest survives a thinner detail response', () => {
  const merged = E.mergeMedia(
    [{ type: 'image', url: 'https://a/1' }, { type: 'image', url: 'https://a/2' }],
    [{ type: 'image', url: 'https://a/1' }]
  );
  eq(merged.length, 2, 'the second photo used to be deleted by the detail pass');
});

check('the richer record wins for the same URL', () => {
  const merged = E.mergeMedia(
    [{ type: 'video', url: 'https://a/v' }],
    [{ type: 'video', url: 'https://a/v', width: 1280, height: 720, durationMs: 9000 }]
  );
  eq(merged.length, 1);
  eq(merged[0].width, 1280);
});

check('an adaptive-only video is keyed on its manifest, not a null url', () => {
  const one = { type: 'video', url: null, manifestUrl: 'https://a/m.m3u8' };
  eq(E.mergeMedia([one], [one]).length, 1, 'two null urls must not collapse into one another');
});

check('two different stranded videos stay separate', () => {
  const merged = E.mergeMedia(
    [{ type: 'video', url: null, manifestUrl: 'https://a/1.m3u8' }],
    [{ type: 'video', url: null, manifestUrl: 'https://a/2.m3u8' }]
  );
  eq(merged.length, 2);
});

check('the merge tolerates a missing or junk list', () => {
  eq(E.mergeMedia(undefined, [{ type: 'image', url: 'https://a/1' }]).length, 1);
  eq(E.mergeMedia([{ type: 'image', url: 'https://a/1' }], null).length, 1);
  eq(E.mergeMedia(null, null).length, 0);
});

check('detailPass routes media through the merge and re-derives the count', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function detailPass'));
  ok(/post\.media = mergeMedia\(post\.media, v\);/.test(body));
  ok(/post\.mediaCount = post\.media\.length;/.test(body), 'the count must follow the merged list');
  ok(/if \(k === 'mediaCount'\) continue;/.test(body), 'not the raw count from the detail response');
});

/* ================================================================== *
 * 14. Lazy-loaded feed images had no src yet
 * ================================================================== */
group('DOM harvest — images below the fold');

check('the delayed-url attribute is read as a source', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('function cardMedia'), CS_SRC.indexOf('function readCard('));
  ok(/data-delayed-url/.test(body), 'LinkedIn parks the real URL there until the image scrolls in');
});

check('avatars and ghosts are excluded by path', () => {
  const m = CS_SRC.match(/const NON_CONTENT_IMAGE\s*=\s*\n?\s*(\/.*\/);/);
  ok(m, 'the shared exclusion pattern is gone');
  for (const pat of ['profile-displayphoto', 'company-logo', 'profile-displaybackgroundimage', 'ghost-person']) {
    ok(m[1].includes(pat), `missing exclusion: ${pat}`);
  }
  // Both DOM readers must use it — the permalink fallback is a second entry point.
  ok(/NON_CONTENT_IMAGE\.test\(src\)/.test(CS_SRC), 'readCard');
  ok(/NON_CONTENT_IMAGE\.test\(u\)/.test(CS_SRC), 'mediaFromHtml');
  return '6 patterns, 2 readers';
});

/* ================================================================== *
 * 15. Media that the list response declared but never delivered
 *
 * A feed-list entry routinely names the component and ships an empty payload;
 * the real image only appears on the permalink page. Such a post looked
 * finished from every angle — body text present, counts present, mapUpdate
 * stamping detailFetched, and classifyPost calling it `text` *because* no
 * media was found — so the detail pass skipped it and its photos were never
 * fetched. This is the "media still missing on some posts" case.
 * ================================================================== */
group('declared-but-undelivered media');

check('a declared-but-empty image component is flagged incomplete', () => {
  const p = E.mapUpdate({
    entityUrn: urnOf('7200000000000000020'),
    actor: avatarOf('AVATAR'),
    commentary: { text: 'Photos from the workshop' },
    content: { imageComponent: { images: [] } },
    socialDetail: { totalSocialActivityCounts: { numComments: 4, numLikes: 31 } }
  });
  eq(p.mediaCount, 0);
  eq(p.mediaIncomplete, true, 'the post said it had an image and shipped none');
  eq(p.detailFetched, false, 'so it is not finished');
});

check('the detail pass will pick it up', () => {
  const p = {
    detailFetched: false, mediaIncomplete: true, text: 'Photos from the workshop',
    type: 'text', reactions: 31, comments: 4
  };
  eq(E.needsDetail(p), true);
  // Before the fix this exact post returned false and was never fetched again.
  eq(E.needsDetail(Object.assign({}, p, { detailFetched: true, mediaIncomplete: false })), false);
});

check('a genuinely text-only post is not flagged', () => {
  const p = E.mapUpdate({
    entityUrn: urnOf('7200000000000000021'),
    actor: avatarOf('AVATAR'),
    commentary: { text: 'just words' },
    socialDetail: { totalSocialActivityCounts: { numComments: 1, numLikes: 2 } }
  });
  eq(p.mediaIncomplete, false, 'nothing was declared, so nothing is owed');
  eq(E.needsDetail(p), false, 'and it must not cost a request');
});

check('a post that delivered its media is complete', () => {
  const p = E.mapUpdate({
    entityUrn: urnOf('7200000000000000022'),
    commentary: { text: 'here it is' },
    content: { imageComponent: { images: [{ attributes: [{ detailData: { vectorImage: vimg('PHOTO') } }] }] } },
    socialDetail: { totalSocialActivityCounts: { numComments: 0, numLikes: 3 } }
  });
  eq(p.mediaIncomplete, false);
  eq(p.detailFetched, true);
});

check('declaresMedia recognises each component kind', () => {
  for (const shape of [
    { imageComponent: {} },
    { linkedInVideoComponent: {} },
    { documentComponent: {} },
    { carouselComponent: {} },
    { videoPlayMetadata: {} },
    { images: [] },
    { progressiveStreams: [] }
  ]) {
    ok(E.declaresMedia({ content: shape }), `missed ${Object.keys(shape)[0]}`);
  }
  ok(!E.declaresMedia({ commentary: { text: 'x' } }), 'plain text declares nothing');
  return '7 shapes';
});

/* ================================================================== *
 * 16. The permalink page with no embedded payload
 * ================================================================== */
group('permalink markup fallback');

// A DOMParser good enough for mediaFromHtml: it answers the four selector
// shapes that function uses, off a tiny hand-parsed model.
function stubDomParser(model) {
  globalThis.DOMParser = class {
    parseFromString() {
      const match = (sel) => {
        if (sel.includes('og:image')) return (model.og || []).map((content) => ({ getAttribute: () => content }));
        if (sel === 'img') {
          return (model.imgs || []).map((a) => ({ getAttribute: (k) => (typeof a === 'string' ? (k === 'src' ? a : null) : a[k] || null) }));
        }
        if (sel === '[data-sources]') {
          return (model.sources || []).map((json) => ({ getAttribute: () => json }));
        }
        if (sel.includes('video')) return (model.videos || []).map((src) => ({ getAttribute: () => src }));
        return [];
      };
      return { querySelectorAll: match };
    }
  };
}

check('og:image is read as the post image', () => {
  stubDomParser({ og: ['https://media.licdn.com/dms/image/v2/REAL/800/0/1'] });
  const m = E.mediaFromHtml('<html/>');
  eq(m.length, 1);
  eq(m[0].type, 'image');
});

check('avatars in the markup are still excluded', () => {
  stubDomParser({
    og: ['https://media.licdn.com/dms/image/v2/profile-displayphoto-shrink_800/x'],
    imgs: ['https://media.licdn.com/dms/image/v2/company-logo_100/y', 'https://media.licdn.com/dms/image/v2/REAL/z']
  });
  const m = E.mediaFromHtml('<html/>');
  eq(m.map((x) => x.url), ['https://media.licdn.com/dms/image/v2/REAL/z']);
});

check('a lazy image contributes its delayed url', () => {
  stubDomParser({ imgs: [{ 'data-delayed-url': 'https://media.licdn.com/dms/image/v2/LAZY/a' }] });
  eq(E.mediaFromHtml('<html/>').length, 1);
});

check('a progressive source is downloadable, an m3u8 is not', () => {
  stubDomParser({
    sources: [JSON.stringify([{ src: 'https://dms.licdn.com/v/clip.mp4', type: 'video/mp4' }, { src: 'https://dms.licdn.com/v/m.m3u8', type: 'application/x-mpegURL' }])]
  });
  const m = E.mediaFromHtml('<html/>');
  eq(m.length, 2);
  eq(m[0].downloadable, true);
  eq(m[1].downloadable, false);
  eq(m[1].url, null, 'a manifest is not a file');
});

check('malformed data-sources does not lose the images', () => {
  stubDomParser({ og: ['https://media.licdn.com/dms/image/v2/REAL/a'], sources: ['{not json'] });
  eq(E.mediaFromHtml('<html/>').length, 1);
});

check('a parser that throws yields nothing rather than crashing the pass', () => {
  globalThis.DOMParser = class {
    parseFromString() {
      throw new Error('nope');
    }
  };
  eq(E.mediaFromHtml('<html/>'), []);
});

check('media arriving late re-types the post', () => {
  eq(E.classifyByMedia([{ type: 'image' }], 'text'), 'image');
  eq(E.classifyByMedia([{ type: 'video' }], 'text'), 'video');
  eq(E.classifyByMedia([{ type: 'image' }], 'repost'), 'repost', 'a reshare stays a reshare');
  eq(E.classifyByMedia([], 'text'), 'text');
});

/* ================================================================== *
 * 17. Frame extraction — one still per second
 * ================================================================== */
group('video frames');

// A <video> that seeks instantly and a <canvas> that yields a stub blob, so
// the seek loop's arithmetic can be checked without a decoder.
function loadOffscreen(duration, machine) {
  // The packer sizes itself to the machine it runs on. Tests declare one, and
  // the default is roomy so the frame-per-second assertions below hold as
  // written; the small-machine tests declare theirs explicitly.
  // Node 22 defines `navigator` as a getter on globalThis, so plain assignment
  // throws under strict mode; define it instead.
  Object.defineProperty(globalThis, 'navigator', {
    value: Object.assign({ deviceMemory: 8, hardwareConcurrency: 4 }, machine || {}),
    configurable: true,
    writable: true
  });
  const seeks = [];
  const el = {
    _t: 0,
    duration,
    videoWidth: 1920,
    videoHeight: 1080,
    // 1 = HAVE_METADATA. A real element has no decoded picture yet, and
    // drawing here paints nothing — the extractor has to wait for loadeddata.
    readyState: 1,
    listeners: {},
    set currentTime(v) {
      const same = Math.abs(this._t - v) < 1e-3;
      this._t = v;
      seeks.push(v);
      // A real <video> does NOT reliably fire `seeked` when asked to seek to
      // the position it is already at. Modelling that is what makes this stub
      // able to catch a first-frame stall.
      if (same) return;
      queueMicrotask(() => (this.listeners.seeked || []).forEach((f) => f()));
    },
    get currentTime() {
      return this._t;
    },
    addEventListener(n, f) {
      (this.listeners[n] = this.listeners[n] || []).push(f);
      if (n === 'loadedmetadata') queueMicrotask(() => f());
      if (n === 'loadeddata') {
        queueMicrotask(() => {
          el.readyState = 2;
          f();
        });
      }
    },
    removeEventListener() {},
    removeAttribute() {},
    load() {}
  };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (cb) => cb({ size: 1024 }) };
  globalThis.document = {
    createElement: (tag) => (tag === 'video' ? el : canvas),
    body: { appendChild() {}, removeChild() {} }
  };
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  globalThis.chrome = { runtime: { onMessage: { addListener: () => {} } } };
  globalThis.__LIS_OFFSCREEN_TEST__ = {};
  new Function(read('offscreen.js'))();
  return { OS: globalThis.__LIS_OFFSCREEN_TEST__, seeks, canvas };
}

await checkAsync('a 10s video yields 10 frames, one per second', async () => {
  const { OS } = loadOffscreen(10);
  const at = [];
  const r = await OS.extractFrames({ size: 1 }, 1, (f) => at.push(f.at));
  eq(r.count, 10);
  eq(at, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

await checkAsync('the first frame does not stall on a same-position seek', async () => {
  // A real <video> starts at currentTime 0, and seeking to 0 does not
  // reliably fire `seeked`. Waiting for one anyway stalled every extraction
  // for the full 15s timeout before it produced a single frame.
  const { OS, seeks } = loadOffscreen(3);
  const at = [];
  const started = Date.now();
  const r = await OS.extractFrames({ size: 1 }, 1, (f) => at.push(f.at));
  ok(Date.now() - started < 2000, 'extraction must not sit on a timeout');
  eq(r.count, 3);
  eq(at[0], 0, 'and frame zero is still produced');
  // No seek is issued for it at all: the element is already at 0 with decoded
  // data, so the first seek recorded belongs to the *second* frame.
  eq(seeks[0], 1, 'the redundant seek is skipped, not merely tolerated');
});

await checkAsync('drawing waits for decoded picture data, not just metadata', async () => {
  // loadedmetadata is readyState 1 — dimensions but no picture. Drawing then
  // paints a blank frame.
  ok(/readyState < 2\) await onceEvent\(video, 'loadeddata'/.test(read('offscreen.js')));
  const { OS } = loadOffscreen(2);
  await OS.extractFrames({ size: 1 }, 1, () => {});
});

await checkAsync('the seek listener is attached before the seek is issued', async () => {
  const body = read('offscreen.js');
  const seek = body.slice(body.indexOf('async function seekTo'), body.indexOf('const canvasBlob'));
  ok(
    seek.indexOf('onceEvent(video, ') < seek.indexOf('video.currentTime = t'),
    'a seek that resolves immediately would fire before anything listened'
  );
});

await checkAsync('frames are handed out as produced, not buffered to the end', async () => {
  const { OS } = loadOffscreen(5);
  const seenDuring = [];
  await OS.extractFrames({ size: 1 }, 1, (f) => seenDuring.push(f.index));
  eq(seenDuring, [0, 1, 2, 3, 4], 'the callback fires per frame');
  // 900 frames returned in one array would be hundreds of MB held live.
  ok(!/frames: out/.test(read('offscreen.js')), 'no array is accumulated');
});

await checkAsync('a fractional duration keeps every whole second it contains', async () => {
  const { OS } = loadOffscreen(4.6);
  const at = [];
  await OS.extractFrames({ size: 1 }, 1, (f) => at.push(f.at));
  eq(at, [0, 1, 2, 3, 4]);
});

await checkAsync('the last seek never lands past the end', async () => {
  const { seeks, OS } = loadOffscreen(4.6);
  await OS.extractFrames({ size: 1 }, 1, () => {});
  ok(Math.max(...seeks) < 4.6, `seeked to ${Math.max(...seeks)}`);
});

await checkAsync('frames are downscaled to the long-edge cap, aspect kept', async () => {
  const { OS, canvas } = loadOffscreen(2);
  await OS.extractFrames({ size: 1 }, 1, () => {});
  eq(canvas.width, OS.FRAMES.MAX_EDGE, '1920 wide caps at MAX_EDGE');
  eq(canvas.height, Math.round(1080 * (OS.FRAMES.MAX_EDGE / 1920)), 'height scales with it');
});

await checkAsync('a very long video is capped rather than running away', async () => {
  const { OS } = loadOffscreen(100000);
  const r = await OS.extractFrames({ size: 1 }, 1, () => {});
  eq(r.count, OS.FRAMES.MAX_PER_VIDEO);
  eq(r.truncated, true);
});

await checkAsync('a video with no duration is rejected, not looped over', async () => {
  const { OS } = loadOffscreen(NaN);
  let threw = false;
  try {
    await OS.extractFrames({ size: 1 }, 1, () => {});
  } catch (_) {
    threw = true;
  }
  ok(threw, 'an infinite or NaN duration must not enter the loop');
});

await checkAsync('the frames note records duration, interval and count', async () => {
  const { OS } = loadOffscreen(3);
  const r = await OS.extractFrames({ size: 1 }, 1, () => {});
  const note = OS.framesReadme({ path: 'a/video_01.mp4', video: { intervalSec: 1 } }, r);
  ok(note.includes('3.0s'), 'duration');
  ok(note.includes('Frames written : 3'), 'count');
});

/* ================================================================== *
 * The packer sizes itself to the machine
 *
 * Measured before it was written: twenty one-minute videos at a still per
 * second held ~550 MB above Chrome's floor and took 138 s on four cores.
 * On a 2 GB two-core laptop the same defaults are a stall.
 * ================================================================== */
group('the packer sizes itself to the machine');

await checkAsync('a small machine shares its frame budget and says so', async () => {
  const { OS } = loadOffscreen(120, { deviceMemory: 2, hardwareConcurrency: 2 });
  eq(OS.MACHINE.tier, 'small');
  eq(OS.MACHINE.fetchConcurrency, 1, 'one CDN fetch at a time');
  eq(OS.FRAMES.MAX_EDGE, 720, 'smaller stills');
  // 600 stills across 30 videos is 20 each — well under a two-minute video
  // at one a second, so the step widens to spread them across its length.
  eq(OS.shareFrameBudget(30), 20);
  const at = [];
  const r = await OS.extractFrames({ size: 1 }, 1, (f) => at.push(f.at));
  eq(r.step, 6);
  eq(r.count, 20);
  eq(at.slice(0, 3), [0, 6, 12]);
  const note = OS.framesReadme({ path: 'a/video_01.mp4', video: { intervalSec: 1 } }, r);
  ok(/Interval\s+: 6s \(asked for 1s; widened for this machine\)/.test(note), 'frames.txt explains the widening');
});

await checkAsync('every video gets a share, however many there are', async () => {
  // A floor of thirty times forty videos exceeded a 600-frame ceiling, and
  // the videos at the tail of the archive got an empty folder.
  const { OS } = loadOffscreen(60, { deviceMemory: 2, hardwareConcurrency: 2 });
  eq(OS.shareFrameBudget(40), 15);
  let total = 0;
  const counts = [];
  for (let i = 0; i < 40; i++) counts.push((await OS.extractFrames({ size: 1 }, 1, () => total++)).count);
  ok(counts.every((c) => c === 15), `every one of forty gets its fifteen: ${[...new Set(counts)].join(',')}`);
  eq(total, 600);
});

await checkAsync('a fractional step yields exactly the share, never one over', async () => {
  // 100 s at a share of 30 is a step of 3.333…; adding it repeatedly landed
  // at 99.99999999999997 and took a 31st frame, so every video overshot its
  // share and the last was falsely reported as cut by the ceiling.
  const { OS } = loadOffscreen(100, { deviceMemory: 2, hardwareConcurrency: 2 });
  OS.shareFrameBudget(20); // 600 / 20 = 30
  const at = [];
  const r = await OS.extractFrames({ size: 1 }, 1, (f) => at.push(f.at));
  eq(r.count, 30);
  ok(!r.exportCapped, 'and not reported as cut');
  ok(at[29] < 100, 'the last frame is inside the video');
});

await checkAsync('a roomy machine keeps the interval it was asked for', async () => {
  const { OS } = loadOffscreen(5, { deviceMemory: 16, hardwareConcurrency: 8 });
  eq(OS.MACHINE.tier, 'roomy');
  eq(OS.MACHINE.fetchConcurrency, 4, 'capped at four however many cores');
  const r = await OS.extractFrames({ size: 1 }, 1, () => {});
  eq(r.step, 1);
  eq(r.count, 5);
});

await checkAsync('the frame budget is shared fairly, not first-come', async () => {
  const { OS } = loadOffscreen(1000, { deviceMemory: 2, hardwareConcurrency: 2 });
  // Three long videos on a 600-still budget: 200 each, and every one of
  // them gets its share. First-come gave the first three everything and the
  // rest an empty folder.
  eq(OS.shareFrameBudget(3), 200);
  let total = 0;
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await OS.extractFrames({ size: 1 }, 1, () => total++));
  eq(results.map((r) => r.count), [200, 200, 200], 'each video gets its share');
  eq(total, 600, 'and together they meet the ceiling exactly');
  ok(results.every((r) => !r.exportCapped), 'finishing on the ceiling is not being cut by it');
  // A fourth video the worker did not count is the one that gets cut.
  const extra = await OS.extractFrames({ size: 1 }, 1, () => total++);
  eq(extra.count, 0);
  ok(extra.exportCapped, 'and says so');
  const note = OS.framesReadme({ path: 'a/video_04.mp4', video: { intervalSec: 1 } }, extra);
  ok(/600-frame ceiling for a 2 GB machine/.test(note), 'and the note says which ceiling');
});

check('the ceiling resets with the archive', () => {
  ok(/case 'ZIP_INIT':[\s\S]{0,200}framesThisExport = 0;/.test(read('offscreen.js')), 'ZIP_INIT resets the count');
});

/* ================================================================== *
 * 18. "Skip video" destroyed whole posts
 *
 * The option sat beside "Profile media" and read as "do not download videos".
 * It discarded the entire update — body text, engagement counts, permalink —
 * with no way to recover them short of re-running the scrape.
 * ================================================================== */
group('skip video drops the video, not the post');

const stripBody = CS_SRC.slice(CS_SRC.indexOf('function stripVideos'), CS_SRC.indexOf('function needsDetail'));

check('a video post survives with its text and counts', () => {
  const add = CS_SRC.slice(CS_SRC.indexOf('const add = (post)'), CS_SRC.indexOf('try {', CS_SRC.indexOf('const add = (post)')));
  ok(!/skipVideos && post\.type === 'video'\) \{[\s\S]{0,120}return false;/.test(add), 'the post must not be dropped');
  ok(/post\.media = post\.media\.filter\(\(m\) => m\.type !== 'video'\)/.test(stripBody), 'the video media is stripped');
  ok(/post\.videosSkipped = true/.test(stripBody), 'and the fact is recorded');
});

check('a stripped video post is re-typed by what is left', () => {
  // By the same rule the detail pass uses, so a surviving document files under
  // Documents rather than Photos.
  ok(/post\.type = classifyByMedia\(post\.media, 'text'\)/.test(stripBody), 'so it files under the right folder');
  ok(!/post\.media\.length \? 'image' : 'text'/.test(stripBody), 'the old rule called a document an image');
});

check('classifyByMedia prefers a document over an image', () => {
  eq(E.classifyByMedia([{ type: 'document' }, { type: 'image' }], 'video'), 'document');
  eq(E.classifyByMedia([{ type: 'image' }], 'video'), 'image');
  eq(E.classifyByMedia([], 'video'), 'video');
  eq(E.classifyByMedia([], 'text'), 'text');
});

check('the detail pass cannot put the skipped video back', () => {
  // The harvest strips it, then the detail pass merges a fresh media list read
  // from the permalink page — which carries the video straight back in.
  const detail = CS_SRC.slice(CS_SRC.indexOf('async function detailPass'));
  ok(/post\.media = mergeMedia\(post\.media, v\);[\s\S]{0,200}stripVideos\(post\);/.test(detail), 'strip must run after the merge');
});

check('metadata separates "none" from "skipped" and "unavailable"', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('function metadataFileText'));
  ok(/post\.mediaUnavailable/.test(body), 'declared but never returned');
  ok(/post\.videosSkipped/.test(body), 'dropped by the option');
  ok(/\(none\)/.test(body), 'genuinely nothing attached');
});

check('a post whose media proved unobtainable is not retried forever', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function detailPass'));
  ok(/post\.mediaIncomplete = false;/.test(body), 'the permalink is the authoritative source');
  ok(/post\.mediaUnavailable = true;/.test(body), 'recorded rather than silently dropped');
});

/* ================================================================== *
 * Strategy escalation
 * ================================================================== */
group('the feed scroll runs wherever the tab already is');

check('being on the activity page does not skip the DOM strategy', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('const onActivityPage'), CS_SRC.indexOf("if (phase === 'posts-dom'"));
  // The guard must not mention onActivityPage at all: deciding *whether* to
  // escalate on where the tab happens to be is what skipped the strategy.
  ok(
    /if \(CFG\.dom\.enabled && via !== 'voyager' && S\.collected < cfg\.maxPosts\) \{/.test(body),
    'escalation is decided by the shortfall alone'
  );
  ok(/if \(onActivityPage\) \{/.test(body), 'where the tab is only chooses scroll-here vs move-there');
  ok(/harvestViaDom\(add\)/.test(body), 'scroll here rather than navigating to where we already are');
  ok(/MSG\.C_NAVIGATE/.test(body), 'the move is still there for the profile page');
});

/* ================================================================== *
 * A retry that succeeds must undo the failure it recorded
 * ================================================================== */
group('recovering from a failed detail fetch');

check('the content script clears the error rather than deleting the key', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function detailPass'));
  ok(/post\.error = '';/.test(body), 'assigned empty');
  ok(!/delete post\.error/.test(body), 'a delete cannot survive the worker\'s Object.assign merge');
});

check('the worker drops the post from its failure list', () => {
  ok(/function dropFailure\(/.test(BG_SRC), 'dropFailure exists');
  const body = BG_SRC.slice(BG_SRC.indexOf('function upsertPosts'));
  ok(/if \(!posts\[at\]\.error\) dropFailure/.test(body), 'called from the merge branch');
});

/* ================================================================== *
 * Nothing in the archive may silently overwrite anything else
 * ================================================================== */
group('archive path collisions');

check('documents are numbered like every other media kind', () => {
  // The counter lives where every media file is named, so the archive and
  // metadata.txt cannot disagree about it.
  const naming = BG_SRC.slice(BG_SRC.indexOf('function mediaFileNames'), BG_SRC.indexOf('function zipEntries'));
  ok(/let docNo = 0;/.test(naming), 'a counter exists');
  const body = BG_SRC.slice(BG_SRC.indexOf('function zipEntries'));
  ok(!/`\$\{folder\}\/document\.txt`/.test(body), 'the fixed path is what collided');
  ok(/mediaFileNames\(post\)/.test(body), 'and the archive asks the helper');
  ok(/mediaFileNames\(post\)/.test(BG_SRC.slice(BG_SRC.indexOf('function metadataFileText'), BG_SRC.indexOf('function commentsFileText'))), 'so does metadata.txt');
});

check('a final pass guarantees every path is unique', () => {
  ok(/function dedupePaths\(/.test(BG_SRC), 'dedupePaths exists');
  // The README is rendered from the deduped list, so the pass runs before
  // the last entry is added rather than on the way out.
  const ze = BG_SRC.slice(BG_SRC.indexOf('function zipEntries'), BG_SRC.indexOf('async function buildZip'));
  ok(/const deduped = dedupePaths\(items\);/.test(ze) && /return deduped;/.test(ze), 'zipEntries returns through it');
  // Renamed, never dropped — losing the file is the worse archive.
  const body = BG_SRC.slice(BG_SRC.indexOf('function dedupePaths'));
  ok(!/splice|filter|continue;\s*\}\s*$/.test(body.slice(0, body.indexOf('return items'))) || /item\.path = /.test(body),
     'collisions are renamed');
});

/* ================================================================== *
 * The profile card is a preview, not the history
 * ================================================================== */
group('the full history is followed, not assumed');

check('getProfile reads the card and then follows the Show all pages', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function getProfile'), CS_SRC.indexOf('async function readProfile'));
  ok(/readProfile\(publicId\)/.test(body), 'the card first');
  ok(/enrichFromDetailPages\(/.test(body), 'then the pages it links to');
  ok(/S\.cfg\.fullProfile === false/.test(body), 'and the option can turn it off');
});

check('the links come from the document already fetched, not a second fetch', () => {
  // getProfile's own body, not everything declared before readProfile — the
  // helpers that live between them do make requests, and legitimately.
  const body = fnBody('async function getProfile');
  ok(/S\.detailLinks/.test(body), 'collected during the read');
  ok(!/apiGet\(/.test(body), 'looking at the links must not cost a request of its own');
});

check('the row mappers are hoisted, because the page table names them at load', () => {
  // `const experienceFromRows = …` leaves DETAILS_PAGES referencing it inside
  // its temporal dead zone, which throws before a single listener registers.
  for (const fn of ['experienceFromRows', 'educationFromRows', 'entriesFromRows']) {
    ok(new RegExp(`function ${fn}\\(`).test(CS_SRC), `${fn} must be a declaration`);
    ok(!new RegExp(`const ${fn}\\s*=`).test(CS_SRC), `${fn} must not be a const arrow`);
  }
});

check('the cost of following them is bounded and paced', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function enrichFromDetailPages'));
  ok(/MAX_DETAILS_PAGES/.test(body), 'a ceiling on how many pages');
  ok(/pause\(U\.randOf\(L\.PAGE_DELAY\)\)/.test(body), 'paced like every other page fetch');
  ok(/if \(S\.stop\) break/.test(body), 'and Stop still stops it');
});

check('a section that fails keeps whatever the card found', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function enrichFromDetailPages'));
  ok(/keeping what the profile card showed/.test(body), 'says so');
  ok(/mergeById\(profile\[d\.key\]/.test(body), 'and merges rather than replaces');
});

/* ================================================================== *
 * A run has to end, and Stop has to mean now
 * ================================================================== */
group('terminating');

check('an idle scroll round counts even when the page height moved', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function harvestViaDom'));
  // Requiring an exact scrollHeight match meant the idle counter reset on
  // almost every round — a LinkedIn feed's height is never exactly unchanged
  // — so a feed that had run out kept scrolling for the full round ceiling.
  ok(!/if \(h === lastHeight && fresh === 0\)/.test(body), 'the height must not gate the count');
  ok(/if \(fresh === 0\) idleRounds \+=/.test(body), 'no new posts is what idle means');
  ok(/idleRounds >= CFG\.dom\.idleRoundsBeforeStop/.test(body), 'and it still stops on the ceiling');
});

check('every pacing delay can be cut short by Stop', () => {
  ok(/async function pause\(ms\)/.test(CS_SRC), 'an interruptible sleep exists');
  const body = CS_SRC.slice(CS_SRC.indexOf('async function pause'));
  ok(/if \(S\.stop\) return;/.test(body.slice(0, 400)), 'it checks Stop');
  // A plain sleep here is up to nine seconds of not noticing Stop, which is
  // long enough for the worker's twelve-second settle to fire first.
  ok(!/await U\.sleep\(U\.randOf\(/.test(CS_SRC), 'no raw pacing sleep is left');
});

check('the run reports which pass it is on, not just the collected count', () => {
  ok(/function setStage\(/.test(CS_SRC) && /function bumpStage\(/.test(CS_SRC), 'stage helpers');
  ok(/setStage\('detail'/.test(CS_SRC), 'the detail pass announces itself');
  ok(/setStage\('comments'/.test(CS_SRC), 'so does the comment pass');
  ok(/setStage\('done'/.test(CS_SRC), 'and the end is a stage too');
  ok(/stage: S\.stage/.test(CS_SRC), 'and it rides on the progress message');
});

check('the worker keeps the stage apart from the navigation phase', () => {
  // `state.phase` already means main vs posts-dom — where the tab is, not
  // what the run is doing. Reusing it would have made both wrong.
  ok(/stage: 'harvest'/.test(BG_SRC), 'blankState carries a stage');
  ok(/phase: 'main'/.test(BG_SRC), 'and still carries the phase');
  ok(/state\.stage = msg\.stage/.test(BG_SRC), 'the stage comes off the progress message');
});

/* ================================================================== *
 * "Where does he work"
 *
 * The field the user actually asks for, and the four separate ways it came
 * back empty or wrong.
 * ================================================================== */
group('where does he work');

check('currentPosition is computed after the history is complete', () => {
  const body = fnBody('async function getProfile');
  // The "Show all" pass is forced precisely when the card yielded no roles,
  // so the case it exists for is the case that left currentPosition null.
  ok(/withCurrentPosition\(full\)/.test(body), 'the enriched profile is what gets the current role');
  ok(/withCurrentPosition\(profile\)/.test(body), 'and so does the un-enriched early return');
});

check('the DOM reader is never skipped for want of a document', () => {
  const body = stripComments(CS_SRC.slice(CS_SRC.indexOf('async function readProfile')));
  // It is the only reader that sees a component-rendered job history, and it
  // used to do nothing at all when strategy B's fetch had failed.
  ok(/if \(!fetched\) fetched = await fetchProfileDocument\(publicId\)/.test(body), 'it fetches its own page');
  ok(/async function fetchProfileDocument/.test(CS_SRC), 'and the helper exists');
  ok(!/\} else if \(fetched\) \{/.test(body), 'no branch that silently does nothing');
});

check('the last-resort read does not harvest a stranger', () => {
  const body = stripComments(CS_SRC.slice(CS_SRC.indexOf('async function readProfile')));
  ok(
    /onProfilePageFor\(publicId\) \? profileFromDom\(publicId, document\) : null/.test(body),
    'the live document is only read when it is showing this profile'
  );
});

check('a school with only a linked reference still counts', () => {
  const src = fnBody('function readEducation');
  // The mapper below already resolves `*school`; the predicate above it did
  // not, so those entities were dropped before it ever saw them.
  ok(/x\['\*school'\] != null/.test(src), 'the predicate accepts a school reference');
  ok(/x\.school != null/.test(src), 'and a resolved one');
  ok(/textOf\(linked\(n, 'school'\)\)/.test(src), 'which is exactly what the mapper resolves');
});

check('the component payload keeps its columns', () => {
  const body = fnBody('function componentRows');
  // titleV2 / subtitle / caption / metadata are read by position downstream —
  // company is spans[1], dates spans[2] — so a compacted gap shifts them all.
  ok(!/\]\.filter\(Boolean\)/.test(body), 'no compaction of the four named slots');
  ok(/\.map\(\(v\) => v \|\| ''\)/.test(body), 'absent fields become blanks, not gaps');
  ok(/while \(spans\.length && !spans\[spans\.length - 1\]\) spans\.pop\(\)/.test(body), 'only trailing blanks go');
});

check('a date range is never filed as a company', () => {
  ok(/function looksLikeDateRange/.test(CS_SRC) && /function realignDates/.test(CS_SRC), 'the guard exists');
  const exp = fnBody('function experienceFromRows');
  const edu = fnBody('function educationFromRows');
  ok(/realignDates\(row, 1\)/.test(exp), 'experience rows are realigned');
  ok(/realignDates\(row, 1\)/.test(edu), 'and so are education rows');
});

check('a section reader cannot read the section next door', () => {
  const body = fnBody('function sectionContainer');
  // "Any ancestor holding an <li>" reaches <main>, which holds every other
  // section's rows — so an empty experience card read the education list and
  // the first school became the answer to "where does he work".
  ok(/reachesAnotherSection/.test(body), 'the walk rejects a container that spans other sections');
  ok(/SECTION_ANCHORS/.test(CS_SRC), 'the other anchors are known');
  const anchors = CS_SRC.slice(CS_SRC.indexOf('const SECTION_ANCHORS'), CS_SRC.indexOf('function sectionContainer'));
  ok(/PROFILE_SECTIONS\.map/.test(anchors), 'including every optional section, not a hand-kept list');
});

check('the richer projection of an entity wins the index', () => {
  const body = VY_SRC.slice(VY_SRC.indexOf('function buildIndex'));
  // The same URN appears in several of a page's payloads, one full and one a
  // stub; last-wins meant a reader could find the full entity and resolve it
  // back into the stub, then discard the row as empty.
  ok(/const prev = byUrn\.get\(e\.entityUrn\)/.test(body), 'the existing entry is consulted');
  ok(/Object\.keys\(e\)\.length > Object\.keys\(prev\)\.length/.test(body), 'and only beaten by a richer one');
});

/* ================================================================== *
 * The archive is whole or it is not saved
 * ================================================================== */
group('the archive is whole or it is not saved');

check('a run cannot start on top of a package in flight', () => {
  // `state` is rebound to a blank object by both, which strands the running
  // build's writes and resets the very flag that guards re-entry.
  for (const fn of ['async function startScrape', 'async function clearAll']) {
    const body = BG_SRC.slice(BG_SRC.indexOf(fn), BG_SRC.indexOf(fn) + 1400);
    ok(/state\.zip && state\.zip\.building/.test(body), `${fn} checks for a build in flight`);
  }
  ok(/state\.zip && state\.zip\.building/.test(PU_SRC), 'and the popup disables Start for it');
});

check('a cancelled package is not saved', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('for (const group of groups)'));
  const finish = body.indexOf("type: 'ZIP_FINISH'");
  const guard = body.indexOf('if (zipCancelled) {', body.indexOf('broadcast(true);'));
  // Twenty entries to a batch means a small export is one group, so a cancel
  // reached no further check and the truncated archive was saved as a success.
  ok(guard > 0 && finish > guard, 'the flag is read again after the last batch');
});

check('a stale building flag cannot outlive the worker', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('async function loadFromStorage'));
  ok(/state\.zip = Object\.assign\(\{\}, state\.zip, \{ building: false \}\)/.test(body), 'it is repaired on load');
  // Object.assign is shallow, so a persisted zip block replaces the blank one
  // wholesale — and only a finally the dead worker never ran would clear it.
  ok(body.indexOf('building: false') < body.indexOf('loaded = true'), 'before anything can read it');
});

check('a failed save actually retries', () => {
  const body = BG_SRC.slice(BG_SRC.indexOf('async function persist()'));
  // dirtyChunks is inert; only schedulePersist arms a write, and the catch
  // never called it — so the last write of a run had no retry behind it.
  ok(/persistTimer = setTimeout\(persist,/.test(body), 'the retry is armed from the failure path');
  ok(/persistFailures/.test(body) && /MAX_PERSIST_RETRIES/.test(BG_SRC), 'and bounded');
  ok(/persistFailures = 0;/.test(body), 'and reset once a write lands');
});

/* ================================================================== *
 * The export tells the truth about itself
 *
 * README.txt and skipped.txt exist to explain why an archive is short.
 * Each of these had them explaining something that had not happened.
 * ================================================================== */
group('the export tells the truth');

check('a run that was stopped does not read as one that finished', () => {
  // Comments stripped: the note explaining this fix names `stoppedEarly`, and
  // an ordering check that a good comment can fail is not a check.
  const body = stripComments(
    BG_SRC.slice(BG_SRC.indexOf("out.push('COMPLETENESS')"), BG_SRC.indexOf("out.push('DATA HANDLING')"))
  );
  // Stop raises before any page returns zero, so `stoppedEarly` is still
  // false — a hand-stopped run was described as pagination ending naturally.
  ok(/state\.status === 'stopped'/.test(body), 'a stopped run says so');
  ok(/state\.status === 'interrupted'/.test(body), 'so does an interrupted one');
  ok(/state\.status === 'error'/.test(body), 'and an errored one');
  ok(
    body.indexOf("state.status === 'stopped'") < body.indexOf('stoppedEarly'),
    'how the run ended is decided before why pagination did'
  );
});

check('the data-handling notice is checked against the files, not the options', () => {
  const body = stripComments(BG_SRC.slice(BG_SRC.indexOf("out.push('DATA HANDLING')")));
  // Reshare provenance writes another person's name, headline, profile URL
  // and post body into three files regardless of the comments setting.
  ok(/const reshared = posts\.filter/.test(body), 'reshared posts are counted');
  const noThirdParty = body.indexOf('no third-party personal data beyond');
  ok(body.lastIndexOf('reshared', noThirdParty) > 0, 'and the claim is guarded on it');
});

check('an empty comment fetch is not reported as one that never ran', () => {
  ok(/post\.commentsFetchedAt = new Date\(\)\.toISOString\(\)/.test(CS_SRC), 'the pass records that it ran');
  const body = fnBody('function commentsFileText', BG_SRC);
  // Without the marker, "the pass returned nothing" and "the pass never
  // happened" are byte-for-byte the same state — and with no comments
  // endpoint configured the first is the common case.
  ok(/post\.commentsFetchedAt && post\.comments/.test(body), 'and the file tells them apart');
});

check('frames that would not decode are not counted as missing files', () => {
  // The video is in the archive; only its stills are not. Counted together,
  // a complete export reported itself short under an expired-CDN-link
  // explanation that had nothing to do with it.
  ok(/kind: 'frames'/.test(OS_SRC), 'the packer tags them');
  ok(/kind: 'item'/.test(OS_SRC), 'and tags real item failures too');
  const body = BG_SRC.slice(BG_SRC.indexOf('async function buildZip'));
  ok(/f\.kind !== 'frames'/.test(body), 'the worker counts only item failures');
  ok(/FRAMES NOT EXTRACTED/.test(body), 'and skipped.txt gives them their own section');
});

/* ================================================================== *
 * The window tells the truth
 * ================================================================== */
group('the window tells the truth');

check('the progress sheen belongs to the fill, not the track', () => {
  const css = read('ui/components.css');
  const bar = css.slice(css.indexOf('.progress > .bar {'), css.indexOf('.progress > .bar.live::after'));
  // inset:0 on the ::after resolves against the nearest positioned ancestor;
  // without this the shimmer swept the whole track at any percentage.
  ok(/position: relative;/.test(bar), '.bar establishes its own containing block');
});

check('Stop is visible the moment it is pressed', () => {
  // BUSY includes 'stopping', and the content script keeps emitting its stage
  // after the flag is set, so the stage word kept overwriting "Stopping".
  ok(/state\.status === 'running' && STAGE\[state\.stage\]/.test(PU_SRC), 'the stage word yields to the status');
  ok(/!live \|\| state\.status === 'stopping'/.test(PU_SRC), 'and the button does not re-arm itself');
});

check('a paused run cannot be cleared out from under itself', () => {
  // Every other control treats paused as in-flight; this one wiped the cursor
  // and every collected post, with no confirmation, next to a Resume button.
  ok(/el\.btnClear\.disabled = live \|\|/.test(PU_SRC), 'Clear is gated on live, not busy');
});

check('an attention notice does not outlive what it asks for', () => {
  ok(/state\.attention\.message && \(live \|\| resumable\)/.test(PU_SRC), 'the banner needs a run that can act');
  const stop = BG_SRC.slice(BG_SRC.indexOf('async function stopScrape'), BG_SRC.indexOf("setStatus('stopping')"));
  ok(/state\.attention = null;/.test(stop), 'and Stop clears it worker-side too');
});

/* ================================================================== *
 * Nothing waits forever
 *
 * fetch() has no timeout of its own, and neither half of this extension used
 * to give it one. A connection that opens and then never answers parked the
 * run at an await that no flag could reach: the popup froze mid-count, Stop
 * did nothing at all, and the tab then refused every later run with "A scrape
 * is already running in this tab." until the page was reloaded. The packer had
 * the same hole one layer down, where it also disabled every button.
 *
 * Proved in a browser before it was fixed: with one held request, the shipped
 * build never returned from run(), emitted no DONE, and left S.active true —
 * with or without Stop. The current build settles the moment Stop arrives.
 * ================================================================== */
group('nothing waits forever');

check('every LinkedIn request carries a deadline', () => {
  ok(/const REQUEST_TIMEOUT_MS = /.test(CS_SRC), 'a deadline is defined');
  const body = CS_SRC.slice(CS_SRC.indexOf('async function apiRequest'));
  ok(/signal: startDeadline\(dl\)/.test(body), 'and the request is issued under it');
  // The wrapper is what guarantees teardown on a return, a throw, or an Abort
  // unwinding the whole run — not just on the happy path.
  const wrapper = CS_SRC.slice(CS_SRC.indexOf('async function apiGet'), CS_SRC.indexOf('async function apiRequest'));
  ok(/finally \{\s*clearDeadline\(dl\);/.test(wrapper), 'and torn down on every exit path');
});

check('the deadline covers the body, not just the headers', () => {
  const body = CS_SRC.slice(CS_SRC.indexOf('async function apiRequest'));
  const read = body.indexOf('text = await res.text();');
  const clear = body.indexOf('clearDeadline(dl);', read);
  ok(read > 0 && clear > read, 'the deadline is released after the body is read, not before');
  // A bare `await res.text()` under an AbortSignal rejects with a raw
  // AbortError that no caller recognises — Stop then marked the post being
  // fetched as failed, and a timeout was never retried.
  const after = body.slice(read, clear);
  ok(/throwIfStopped\(\);/.test(after), 'an abort during the body read is classified, not raw');
  ok(/await coolOff\(/.test(after), 'and a timeout there still gets its retry');
});

check('Stop tears down what is in flight instead of waiting it out', () => {
  ok(/function abortInFlight\(\)/.test(CS_SRC), 'an abort helper exists');
  const stop = CS_SRC.slice(CS_SRC.indexOf('case MSG.STOP:'), CS_SRC.indexOf('case MSG.RESUME:'));
  ok(/abortInFlight\(\)/.test(stop), 'Stop calls it');
  // The worker dying mid-run is the same situation wearing a different hat.
  ok(/if \(S\.active\) \{\s*S\.stop = true;\s*abortInFlight\(\);/.test(stripComments(CS_SRC)), 'so does losing the worker');
});

check('an aborted request is told apart from a network error', () => {
  const body = stripComments(CS_SRC.slice(CS_SRC.indexOf('async function apiRequest')));
  // Retrying a request the user just cancelled is how a Stop turns into
  // another three minutes of backoff.
  const idx = body.indexOf('throwIfStopped();');
  ok(idx > 0 && idx < body.indexOf('await coolOff'), 'Stop is checked before any retry decision');
  ok(/signal\.aborted/.test(body), 'and a timeout is reported as one');
});

await checkAsync('a media body that stops sending bytes is abandoned, one that trickles on is kept', async () => {
  const { OS } = loadOffscreen(1);
  OS.setFetchTimeout(120);
  // A body that follows a plan of delays, and — as a real fetch's body does —
  // errors when the request's signal is aborted.
  const bodyThat = (plan) => {
    let ctrl = null;
    let closed = false;
    const stream = new ReadableStream({
      start(c) {
        ctrl = c;
        let i = 0;
        const tick = () => {
          const step = plan[i++];
          if (closed) return;
          if (step === undefined) {
            closed = true;
            return c.close();
          }
          if (step === 'stall') return; // never enqueue again
          setTimeout(() => {
            if (closed) return;
            c.enqueue(new Uint8Array([i]));
            tick();
          }, step);
        };
        tick();
      }
    });
    const abort = () => {
      if (closed) return;
      closed = true;
      try {
        ctrl.error(new DOMException('The operation was aborted.', 'AbortError'));
      } catch (_) {
        /* already closed */
      }
    };
    return { stream, abort };
  };
  const responses = [];
  globalThis.fetch = async (url, init) => {
    const r = responses.shift();
    if (init && init.signal) init.signal.addEventListener('abort', () => r.abort());
    return { ok: true, status: 200, headers: new Headers(), body: r.stream };
  };
  // Byte, byte, byte … each within the deadline, for longer than the deadline in total.
  responses.push(bodyThat([40, 40, 40, 40, 40, 40]));
  const blob = await OS.fetchBlob('https://media.licdn.com/trickle');
  eq(blob.size, 6, 'a slow but live transfer completes');
  // A body that sends two bytes and then nothing.
  responses.push(bodyThat([10, 10, 'stall']));
  let err = null;
  try {
    await OS.fetchBlob('https://media.licdn.com/stall');
  } catch (e) {
    err = e;
  }
  ok(err && /no bytes for/.test(err.message), `a stalled body is abandoned with the reason: ${err && err.message}`);
});

check('the packer gives its media fetches a deadline too', () => {
  ok(/(const|let) FETCH_TIMEOUT_MS = /.test(OS_SRC), 'a deadline is defined');
  const body = OS_SRC.slice(OS_SRC.indexOf('async function fetchBlob'));
  ok((body.match(/signal: ctl\.signal/g) || []).length >= 2, 'both attempts run under it');
  // `return res.blob()` would hand the promise back outside the try, and with
  // it every guarantee the deadline was meant to provide.
  ok(/return await res\.blob\(\);/.test(body), 'and the body read is awaited inside it');
});

check('Cancel is felt inside a batch, not only between batches', () => {
  ok(/case 'ZIP_CANCEL':/.test(OS_SRC), 'the packer accepts a cancel');
  const worker = OS_SRC.slice(OS_SRC.indexOf('const workers = Array.from'));
  ok(/if \(cancelled\) \{/.test(worker.slice(0, 300)), 'and its workers stop pulling work');
  // A short batch that reports no failures reads as a complete one.
  ok(/error: 'cancelled'/.test(worker), 'recording what it abandons rather than reporting a clean batch');
  ok(/offscreenSend\(\{ type: 'ZIP_CANCEL' \}\)/.test(BG_SRC), 'and the worker sends it on Cancel');
  // A batch is twenty media fetches; waiting one out is what made Cancel look dead.
  ok(/cancelled = false;/.test(OS_SRC), 'and a new archive starts uncancelled');
});

/* ================================================================== *
 * Stop leaves the run, not just a loop
 * ================================================================== */
group('stop leaves the run');

check('Stop does not survive the profile phase', () => {
  const body = stripComments(CS_SRC.slice(CS_SRC.indexOf('async function runToCompletion(cfg)')));
  // stripComments has eaten the `/* ---- posts ---- */` banner, so anchor on
  // the code rather than on the comment that labels it.
  const postsPhase = body.indexOf('if (cfg.includePosts)');
  ok(postsPhase > 0, 'the posts phase is found');
  ok(/throwIfStopped\(\);/.test(body.slice(0, postsPhase)), 'and a Stop unwinds before it starts');
});

check('a pending Stop never escalates the run into a new page', () => {
  const body = stripComments(CS_SRC.slice(CS_SRC.indexOf('async function runToCompletion(cfg)')));
  const escalate = body.indexOf('const onActivityPage =');
  const guard = body.lastIndexOf('throwIfStopped();', escalate);
  ok(escalate > 0, 'the escalation is found');
  ok(guard > body.indexOf('if (cfg.includePosts)'), 'the guard sits inside the posts phase');
  // The escalation navigates the tab and has the worker start the run again,
  // where S.stop begins life false — so a Stop reaching it is a Stop erased.
  ok(guard > 0 && escalate > guard, 'the escalation is guarded on the stop flag');
  ok(/throwIfStopped\(\);\s*await tryStrategy\('Feed scroll'/.test(body), 'so is the feed-scroll leg');
});

check('finding a card is linear in the length of the feed', () => {
  // cardOf climbed from every URN node and asked each ancestor for the other
  // URN nodes beneath it — quadratic. A thousand-card feed cost a second per
  // harvest round on four cores, and rounds repeat for the length of the
  // scroll. The counts are taken once per harvest and looked up.
  const body = stripComments(fnBody('function cardOf'));
  ok(!/querySelectorAll|safeQueryAll/.test(body), 'cardOf never queries an ancestor');
  ok(/counts\.get\(parent\)/.test(body), 'it reads a precomputed count');
  ok(/function countUrnsPerAncestor/.test(CS_SRC), 'built once per harvest');
  ok(/const urnCount = countUrnsPerAncestor\(nodes, top\)/.test(fnBody('function harvestFeedCards')), 'and harvestFeedCards builds it');
});

check('Stop pressed while the run is starting is not undone', () => {
  const body = stripComments(BG_SRC.slice(BG_SRC.indexOf('async function startScrape'), BG_SRC.indexOf('function handleStartResponse')));
  // Stop is enabled during 'starting', and it went to a tab with no content
  // script yet; startScrape then carried on and sent START anyway.
  ok(/const abandoned = \(\) =>/.test(body), 'the status is re-read');
  const checks = (body.match(/if \(abandoned\(\)\)/g) || []).length;
  ok(checks >= 4, `after every await, found ${checks}`);
  const hsr = fnBody('function handleStartResponse', BG_SRC);
  ok(/if \(state\.status === 'starting'\) setStatus\('running'\)/.test(hsr), "and 'running' is only set from 'starting'");
});

check('a Stop lands within a slice, not after a gap', () => {
  const cool = stripComments(fnBody('async function coolOff'));
  ok(!/U\.sleep\(/.test(cool), 'coolOff no longer sleeps ten seconds blind');
  ok(/await pause\(/.test(cool), 'it uses the interruptible pause');
  ok(/await limiter\.wait\(0, \(\) => S\.stop\);\s*[^;]*throwIfStopped\(\);/s.test(stripComments(CS_SRC)), 'and the limiter gap is cancellable with no request after it');
  const wait = read('utils.js').slice(read('utils.js').indexOf('async wait(extra = 0, cancelled)'));
  ok(/Math\.min\(250, left\)/.test(wait), 'sliced to a quarter second');
});

check('a failed comment fetch stays outstanding', () => {
  const U = globalThis.LIS;
  // An empty list read as "fetched, none"; the post was never handed back.
  eq(U.postNeedsComments({ comments: 4, commentError: 'HTTP 500' }), true, 'no list, an error: outstanding');
  eq(U.postNeedsComments({ comments: 4, commentList: [], commentError: 'HTTP 500' }), true, 'the earlier build wrote an empty list beside the error: still outstanding');
  eq(U.postNeedsComments({ comments: 4, commentList: [], commentsFetchedAt: 'x' }), false, 'a fetch that ran and found none is done');
  eq(U.postNeedsComments({ comments: 4, commentList: [{ text: 'hi' }] }), false, 'a list from before the stamp existed is done');
  const pass = stripComments(CS_SRC.slice(CS_SRC.indexOf('async function commentPass')));
  ok(/delete post\.commentList;/.test(pass), 'and the pass no longer writes an empty list on failure');
});

check('the profile is merged on receipt, not replaced', () => {
  const merged = BG.mergeProfileRecords(
    { publicId: 'a', headline: 'old', about: 'kept', experience: [{ title: 'x' }], contact: { email: 'e' } },
    { publicId: 'a', headline: 'new', about: '', experience: [{ title: 'y' }, { title: 'x' }], contact: { phone: 'p' } }
  );
  eq(merged.headline, 'new', 'a new non-empty scalar wins');
  eq(merged.about, 'kept', 'an empty one does not erase');
  eq(merged.experience.map((e) => e.title), ['x', 'y'], 'lists union');
  eq(merged.contact, { email: 'e', phone: 'p' }, 'records merge');
  ok(/state\.profile = mergeProfileRecords\(state\.profile, msg\.profile\)/.test(BG_SRC), 'and C_PROFILE uses it');
});

await checkAsync('a stored layout with another chunk size is rewritten whole', async () => {
  // 250 posts under the previous build's 100-post buckets. Writing only the
  // dirty chunks over them scrambled the order and lost 75 posts.
  const mk = (i) => ({ activityId: String(i), urn: 'u' + i, text: 't' + i, media: [] });
  const stored = {
    lis_state: { publicId: 'ada', status: 'done' },
    lis_index: { total: 250, chunks: 3 },
    lis_posts_0: Array.from({ length: 100 }, (_, i) => mk(i)),
    lis_posts_1: Array.from({ length: 100 }, (_, i) => mk(100 + i)),
    lis_posts_2: Array.from({ length: 50 }, (_, i) => mk(200 + i))
  };
  const removed = [];
  const W = loadBackground({
    get: async (keys) => {
      const out = {};
      for (const k of [].concat(keys)) if (k in stored) out[k] = stored[k];
      return out;
    },
    set: async (payload) => Object.assign(stored, payload),
    remove: async (keys) => { for (const k of [].concat(keys)) { removed.push(k); delete stored[k]; } }
  });
  await W.loadFromStorage();
  eq(W.posts().length, 250, 'every post kept');
  eq(W.posts().map((p) => p.activityId), Array.from({ length: 250 }, (_, i) => String(i)), 'in order, none duplicated');
  // The rewrite happens as part of the load, so the disk is already right.
  eq(W.dirty().size, 0, 'and nothing is left dirty afterwards');
  eq(stored.lis_index.chunkSize, 25, 'the index now says which layout it is');
  eq(stored.lis_index.chunks, 10);
  for (let i = 0; i < 10; i++) eq((stored['lis_posts_' + i] || []).length, 25, `chunk ${i} rewritten`);
  ok(!('lis_posts_10' in stored), 'nothing beyond the new count');
  // And a second load of what was written comes back identical.
  const again = loadBackground({ get: async (keys) => { const o = {}; for (const k of [].concat(keys)) if (k in stored) o[k] = stored[k]; return o; } });
  await again.loadFromStorage();
  eq(again.posts().map((p) => p.activityId), W.posts().map((p) => p.activityId), 'round-trips');
  eq(again.dirty().size, 0, 'and is recognised as its own layout');
});

check('a "…see more" is answered by the detail fetch, once', () => {
  const U = globalThis.LIS;
  eq(U.postNeedsDetail({ detailFetched: true, text: 'full', reactions: 1, comments: 1, textTruncated: true }), false, 'fetched detail settles it');
  eq(U.postNeedsDetail({ detailFetched: false, text: 'short…', reactions: 1, comments: 1, textTruncated: true }), true, 'unfetched, it is wanted');
  const merge = stripComments(CS_SRC.slice(CS_SRC.indexOf('const { mapped } = await fetchPostDetail(post);'), CS_SRC.indexOf('const { mapped } = await fetchPostDetail(post);') + 3000));
  ok(/if \(post\.text\) post\.textTruncated = false;/.test(merge), 'and the detail merge clears the flag');
});

check('a strategy that never makes a request still notices Stop', () => {
  // On the activity page the payload comes out of the document, so this
  // strategy can run start to finish without touching apiGet — which is where
  // the stop check used to live.
  const body = CS_SRC.slice(CS_SRC.indexOf('async function harvestViaEmbedded'));
  ok(/throwIfStopped\(\)/.test(body.slice(0, 500)), 'it checks Stop itself');
});

check('nothing that sets S.active sits outside a finally', () => {
  const wrapper = fnBody('async function run(cfg)');
  // The listener starts the run without awaiting it, so a throw in the
  // prologue was an unhandled rejection: no DONE, and the tab refused every
  // later Start with "A scrape is already running in this tab."
  ok(/await runToCompletion\(cfg\)/.test(wrapper), 'the run is wrapped');
  ok(/finally \{\s*S\.active = false;/.test(wrapper), 'and S.active is cleared from the outermost finally');
  ok(/finish\('error', message\)/.test(wrapper), 'and the worker is told rather than left waiting');
  ok(/run\(msg\.cfg\)\.catch\(\(\) => \{\}\)/.test(CS_SRC), 'the floating call carries a handler');
});

check('the worker does not start a run it was told to stop', () => {
  const body = stripComments(BG_SRC.slice(BG_SRC.indexOf('async function continueAt'), BG_SRC.indexOf('async function stopScrape')));
  ok(/const abandoned = \(\) =>/.test(body), 'the status is re-read, not trusted from entry');
  // tabs.update, waitForTabLoad and injectContent each take seconds, and
  // waitForTabLoad alone allows a minute — a Stop can land in any of them.
  const checks = (body.match(/if \(abandoned\(\)\) return;/g) || []).length;
  ok(checks >= 4, `every await is followed by a re-check, found ${checks}`);
  ok(body.indexOf('if (abandoned()) return;') < body.indexOf('type: MSG.START'), 'and the last one precedes START');
});

/* ================================================================== *
 * A partial answer is a contribution, not a reason to stop asking
 * ================================================================== */
group('profile readers do not race each other');

check('readProfile has no early return that ends the chain', () => {
  const body = stripComments(CS_SRC.slice(CS_SRC.indexOf('async function readProfile'), CS_SRC.indexOf('const escapeRe')));
  // The shipped version returned on the first strategy that found a Profile
  // entity. LinkedIn still ships that entity, so the embedded strategy always
  // "succeeded" — with empty lists — and the DOM reader that can see the
  // rendered job history was never reached.
  const returns = (body.match(/\n\s+return\s/g) || []).length;
  ok(returns <= 1, `readProfile should end at one return, found ${returns}`);
  ok(/contribute\(/.test(body), 'each strategy contributes');
  ok(/mergeProfiles/.test(CS_SRC), 'and the contributions are merged');
});

check('the rendered page is read even when the payload answered', () => {
  const body = stripComments(CS_SRC.slice(CS_SRC.indexOf('async function readProfile'), CS_SRC.indexOf('const escapeRe')));
  const dom = body.indexOf('profileFromDom(publicId, document)');
  const emb = body.indexOf('embedded-json');
  ok(dom > 0, 'the DOM reader is called');
  ok(emb > 0 && dom > emb, 'and it runs after the payload read rather than instead of it');
});

check('a fetched profile page is read as markup too, from the same fetch', () => {
  const body = stripComments(CS_SRC.slice(CS_SRC.indexOf('async function readProfile'), CS_SRC.indexOf('const escapeRe')));
  ok(/profileFromDom\(publicId, fetched\)/.test(body), 'the fetched HTML feeds the DOM reader');
  ok((body.match(/apiGet\(/g) || []).length === 1, 'and it costs exactly one request');
});

check('the DOM readers can run against a document that is not the live page', () => {
  for (const fn of ['experienceFromDom', 'educationFromDom', 'skillsFromDom', 'profileSectionsFromDom']) {
    ok(new RegExp(`function ${fn}\\(doc\\)`).test(CS_SRC), `${fn} must take a document`);
  }
  ok(/function profileFromDom\(publicId, doc\)/.test(CS_SRC));
});

check('a details page uses both its markup and its payload', () => {
  const body = stripComments(CS_SRC.slice(CS_SRC.indexOf('async function enrichFromDetailPages')));
  ok(/const marked =/.test(body) && /const components =/.test(body), 'both are read');
  ok(/mergeById\(marked, components/.test(body), 'and merged rather than raced');
});

/* ---------------- summary ---------------- */
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
