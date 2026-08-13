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

/**
 * Comments in this project describe the bug that was fixed, so they quote the
 * very code being asserted against. Counting occurrences has to look at the
 * code alone or a good comment fails the test.
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
   return { samePage, isLinkedInTab, needsMoreWork, blankState };`
)(() => new Function(read('utils.js'))(), chromeStub);

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
  eq(BG.needsMoreWork({ detailFetched: false }), true);
  eq(BG.needsMoreWork({ detailFetched: true }), false);
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
  const body = CS_SRC.slice(CS_SRC.indexOf('function readCard'), CS_SRC.indexOf('function readCounts'));
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
function loadOffscreen(duration) {
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
  const body = BG_SRC.slice(BG_SRC.indexOf('function zipEntries'));
  ok(/let docNo = 0;/.test(body), 'a counter exists');
  ok(!/`\$\{folder\}\/document\.txt`/.test(body), 'the fixed path is what collided');
});

check('a final pass guarantees every path is unique', () => {
  ok(/function dedupePaths\(/.test(BG_SRC), 'dedupePaths exists');
  ok(/return dedupePaths\(items\);/.test(BG_SRC), 'zipEntries returns through it');
  // Renamed, never dropped — losing the file is the worse archive.
  const body = BG_SRC.slice(BG_SRC.indexOf('function dedupePaths'));
  ok(!/splice|filter|continue;\s*\}\s*$/.test(body.slice(0, body.indexOf('return items'))) || /item\.path = /.test(body),
     'collisions are renamed');
});

/* ---------------- summary ---------------- */
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
