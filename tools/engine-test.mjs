/*
 * engine-test.mjs — the pure parts of content.js, without a browser.
 *
 *   node tools/engine-test.mjs
 *
 * The session check exists here because it shipped broken: it required the
 * `li_at` cookie, which is HttpOnly and therefore invisible to
 * `document.cookie`, so it reported "not logged in" for every valid session.
 * That is a two-line test's worth of bug and it made the extension unusable.
 *
 * The entity mappers are here for the same reason — they are pure functions
 * that were otherwise only reachable through a live LinkedIn session, which
 * means in practice they were only ever exercised by the user.
 *
 * content.js is a content-script IIFE, so it is evaluated against a minimal
 * fake DOM and exports through the __LIS_TEST__ hook.
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
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what || 'value'}\n       expected ${JSON.stringify(b)}\n       actual   ${JSON.stringify(a)}`);
  }
}
const ok = (c, w) => {
  if (!c) throw new Error(w || 'expected truthy');
};
const group = (t) => process.stdout.write(`\n${t}\n`);

/* ---------------- fake page ---------------- */
/**
 * Enough DOM for the session predicates: querySelector answers from a list of
 * selectors declared present, and `header, nav` yields the given nav text.
 */
function setPage({ pathname = '/in/someone/', cookie = '', present = [], navText = '' } = {}) {
  const node = (extra) => Object.assign({ textContent: '', querySelector: () => null, querySelectorAll: () => [] }, extra || {});
  globalThis.location = { pathname, href: 'https://www.linkedin.com' + pathname };
  globalThis.document = {
    cookie,
    querySelector(sel) {
      const parts = String(sel).split(',').map((s) => s.trim());
      if (parts.some((p) => present.includes(p))) return node();
      if (parts.includes('header') || parts.includes('nav')) return node({ textContent: navText });
      return null;
    },
    querySelectorAll: () => [],
    documentElement: node(),
    body: node()
  };
}

/* ---------------- load content.js ---------------- */
globalThis.window = globalThis;
new Function(read('utils.js'))();
new Function(read('voyager.js'))();

const noop = () => {};
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: noop },
    connect: () => ({ postMessage: noop, onDisconnect: { addListener: noop } })
  }
};
globalThis.__LIS_TEST__ = {};
setPage();
new Function(read('content.js'))();
const E = globalThis.__LIS_TEST__;

ok(typeof E.sessionState === 'function', 'content.js did not export its test hook');

/* ================================================================== *
 * Session detection — the bug that shipped
 * ================================================================== */
group('sessionState — logged in');

// What document.cookie genuinely looks like on a signed-in LinkedIn session:
// no li_at, because it is HttpOnly.
const REAL_JAR = 'bcookie="v=2&x"; bscookie="v=1&y"; JSESSIONID="ajax:1234567890"; lang=v=2&lang=en-us; liap=true';

check('a real signed-in cookie jar is accepted even though li_at is invisible', () => {
  setPage({ pathname: '/in/someone/', cookie: REAL_JAR });
  const s = E.sessionState();
  ok(s.ok, `refused a valid session: ${s.why}`);
  return s.why;
});

check('signed-in page chrome alone is enough', () => {
  setPage({ pathname: '/in/someone/', cookie: '', present: ['#global-nav'] });
  ok(E.sessionState().ok);
});

check('a visible li_at is still honoured where the context can see it', () => {
  setPage({ pathname: '/in/someone/', cookie: 'li_at=AQEDA...' });
  ok(E.sessionState().ok);
});

check('an ambiguous page is allowed through rather than blocking the run', () => {
  // No markers either way, but a readable JSESSIONID. A false negative here
  // strands the user; a false positive costs one 401 that is handled properly.
  setPage({ pathname: '/in/someone/', cookie: 'JSESSIONID="ajax:1"' });
  ok(E.sessionState().ok);
});

check('the activity page is treated the same as the profile page', () => {
  setPage({ pathname: '/in/someone/recent-activity/all/', cookie: REAL_JAR });
  ok(E.sessionState().ok);
});

group('sessionState — genuinely not logged in');

check('an auth wall is refused', () => {
  setPage({ pathname: '/authwall', cookie: REAL_JAR });
  const s = E.sessionState();
  ok(!s.ok);
  ok(/sign-in/i.test(s.why), s.why);
});

check('the login and signup pages are refused', () => {
  for (const p of ['/login', '/signup', '/uas/login']) {
    setPage({ pathname: p, cookie: REAL_JAR });
    ok(!E.sessionState().ok, `${p} should be refused`);
  }
});

check('a signed-out public profile is refused on its Join now / Sign in nav', () => {
  setPage({ pathname: '/in/someone/', cookie: 'bcookie="v=2&x"', navText: 'Join now Sign in' });
  const s = E.sessionState();
  ok(!s.ok);
  ok(/signed-out/i.test(s.why), s.why);
});

check('a sign-in form on the page is refused', () => {
  setPage({ pathname: '/in/someone/', cookie: REAL_JAR, present: ['form.login__form'] });
  ok(!E.sessionState().ok);
});

check('an empty cookie jar with no page markers is refused', () => {
  setPage({ pathname: '/in/someone/', cookie: '' });
  const s = E.sessionState();
  ok(!s.ok);
  ok(/no linkedin cookies/i.test(s.why), s.why);
});

check('every refusal explains itself', () => {
  for (const page of [
    { pathname: '/authwall', cookie: REAL_JAR },
    { pathname: '/checkpoint/challenge', cookie: REAL_JAR },
    { pathname: '/in/x/', cookie: '' },
    { pathname: '/in/x/', cookie: 'bcookie=1', navText: 'Join now Sign in' }
  ]) {
    setPage(page);
    const s = E.sessionState();
    ok(!s.ok, `${page.pathname} should refuse`);
    ok(s.why && s.why.length > 12, `unhelpful reason for ${page.pathname}: ${s.why}`);
  }
});

group('challenge vs login are kept apart');

check('a checkpoint is a challenge, not a login prompt', () => {
  setPage({ pathname: '/checkpoint/challenge', cookie: REAL_JAR });
  ok(E.onChallengePage(), 'checkpoint is a challenge');
  ok(!E.onLoginPage(), 'and not a login page');
  ok(E.onAuthWall());
});

check('an auth wall is a login prompt, not a challenge', () => {
  setPage({ pathname: '/authwall', cookie: '' });
  ok(!E.onChallengePage());
  ok(E.onLoginPage());
  ok(E.onAuthWall());
});

check('an ordinary profile page is neither', () => {
  setPage({ pathname: '/in/someone/', cookie: REAL_JAR });
  ok(!E.onChallengePage() && !E.onLoginPage() && !E.onAuthWall());
});

check('a profile whose slug merely contains "login" is not an auth page', () => {
  setPage({ pathname: '/in/loginexpert/', cookie: REAL_JAR });
  ok(!E.onAuthWall(), 'the match must be anchored to the path root');
  ok(E.sessionState().ok);
});

/* ================================================================== *
 * Entity mapping
 * ================================================================== */
group('textOf — LinkedIn wraps strings a dozen ways');

check('unwraps every envelope shape', () => {
  eq(E.textOf('plain'), 'plain');
  eq(E.textOf({ text: 'tvm' }), 'tvm');
  eq(E.textOf({ text: { text: 'nested' } }), 'nested');
  eq(E.textOf({ rawText: 'raw' }), 'raw');
  eq(E.textOf({ defaultLocalizedName: 'company' }), 'company');
  eq(E.textOf({ name: 'named' }), 'named');
  eq(E.textOf({ localized: { en_US: 'localised' } }), 'localised');
  eq(E.textOf({ attributedText: { text: 'attr' } }), 'attr');
});

check('returns empty for junk instead of "[object Object]"', () => {
  eq(E.textOf(null), '');
  eq(E.textOf(undefined), '');
  eq(E.textOf({}), '');
  eq(E.textOf({ nope: 1 }), '');
});

check('does not recurse forever on a cyclic value', () => {
  const a = { text: {} };
  a.text = a;
  eq(typeof E.textOf(a), 'string');
});

group('dateRangeText');

check('renders a closed and an open range', () => {
  eq(E.dateRangeText({ start: { month: 3, year: 2019 }, end: { month: 6, year: 2022 } }), 'Mar 2019 – Jun 2022');
  eq(E.dateRangeText({ start: { month: 1, year: 2020 } }), 'Jan 2020 – Present');
  eq(E.dateRangeText({ start: { year: 2015 } }), '2015 – Present');
  eq(E.dateRangeText(null), '');
});

group('timestampFromActivityId');

check('recovers a plausible date from a real-shaped id', () => {
  const ms = E.timestampFromActivityId('7100000000000000000');
  const iso = new Date(ms).toISOString();
  ok(iso.startsWith('2023-'), iso);
});

check('rejects anything outside a sane range instead of inventing a date', () => {
  eq(E.timestampFromActivityId('1'), null, 'too small');
  eq(E.timestampFromActivityId('99999999999999999999999'), null, 'too large');
  eq(E.timestampFromActivityId('not-a-number'), null);
  eq(E.timestampFromActivityId(null), null);
  eq(E.timestampFromActivityId(''), null);
});

check('is monotonic — a later id yields a later date', () => {
  ok(E.timestampFromActivityId('7200000000000000000') > E.timestampFromActivityId('7100000000000000000'));
});

group('media extraction');

check('prefers the highest-bitrate progressive stream', () => {
  const v = E.videosFrom({
    videoPlayMetadata: {
      duration: 30000,
      progressiveStreams: [
        { bitRate: 500, width: 480, streamingLocations: [{ url: 'https://x/low.mp4' }] },
        { bitRate: 4000, width: 1920, streamingLocations: [{ url: 'https://x/high.mp4' }] }
      ],
      adaptiveStreams: [{ protocol: 'HLS', masterPlaylists: [{ url: 'https://x/m.m3u8' }] }]
    }
  });
  eq(v.length, 1);
  eq(v[0].url, 'https://x/high.mp4');
  eq(v[0].downloadable, true);
  eq(v[0].width, 1920);
});

check('falls back to the manifest when there is no progressive variant', () => {
  const v = E.videosFrom({
    m: { duration: 62000, adaptiveStreams: [{ protocol: 'DASH', masterPlaylists: [{ url: 'https://x/m.mpd' }] }] }
  });
  eq(v[0].url, null, 'nothing to download');
  eq(v[0].manifestUrl, 'https://x/m.mpd');
  eq(v[0].downloadable, false);
  eq(v[0].protocol, 'DASH');
});

check('finds video metadata wherever it sits, not at a fixed path', () => {
  const deep = { a: { b: { c: { progressiveStreams: [{ bitRate: 1, streamingLocations: [{ url: 'https://x/v.mp4' }] }] } } } };
  eq(E.videosFrom(deep).length, 1);
});

check('resolves images to the widest artifact', () => {
  const imgs = E.imagesFrom({
    thing: {
      rootUrl: 'https://media.licdn.com/dms/image/A/',
      artifacts: [
        { fileIdentifyingUrlPathSegment: '200/a.jpg', width: 200 },
        { fileIdentifyingUrlPathSegment: '1200/a.jpg', width: 1200 }
      ]
    }
  });
  eq(imgs, [{ type: 'image', url: 'https://media.licdn.com/dms/image/A/1200/a.jpg' }]);
});

check('extracts a document with its page count', () => {
  const d = E.documentsFrom({ doc: { transcribedDocumentUrl: 'https://x/d.pdf', title: 'Deck', totalPageCount: 12 } });
  eq(d[0].url, 'https://x/d.pdf');
  eq(d[0].pages, 12);
  eq(d[0].downloadable, true);
});

group('classifyPost — decided by shape, not by $type');

const T = (node, media) => E.classifyPost(node, media || []);

check('identifies each post kind', () => {
  eq(T({}, []), 'text');
  eq(T({}, [{ type: 'image' }]), 'image');
  eq(T({}, [{ type: 'video' }]), 'video');
  eq(T({}, [{ type: 'document' }]), 'document');
  eq(T({ resharedUpdate: {} }), 'repost');
  eq(T({ x: { pollOptions: [] } }), 'poll');
  eq(T({ x: { navigationContext: { actionTarget: 'https://e/x' }, title: 'T', subtitle: 'S' } }), 'article');
});

check('a repost wins over its own attached media', () => {
  eq(T({ resharedUpdate: {} }, [{ type: 'image' }]), 'repost');
});

check('a document wins over the images LinkedIn renders beside it', () => {
  eq(T({}, [{ type: 'document' }, { type: 'image' }]), 'document');
});

check('a bare navigationContext is not enough to call something an article', () => {
  // navigationContext appears all over a feed payload; keying off it alone
  // would classify most posts as articles.
  eq(T({ x: { navigationContext: { actionTarget: 'https://e/x' } } }, []), 'text');
});

group('reaction and social counts');

check('sums the per-type breakdown', () => {
  const r = E.reactionsFrom({ s: { reactionTypeCounts: [{ reactionType: 'LIKE', count: 30 }, { reactionType: 'PRAISE', count: 8 }], numLikes: 38 } });
  eq(r.total, 38);
  eq(r.byType, { LIKE: 30, PRAISE: 8 });
});

check('derives a total from the breakdown when none is given', () => {
  eq(E.reactionsFrom({ s: { reactionTypeCounts: [{ reactionType: 'LIKE', count: 5 }] } }).total, 5);
});

check('carries an unknown reaction type through instead of dropping it', () => {
  const r = E.reactionsFrom({ s: { reactionTypeCounts: [{ reactionType: 'SOME_NEW_ONE', count: 3 }] } });
  eq(r.byType.SOME_NEW_ONE, 3);
});

check('a count that was never returned stays null, not zero', () => {
  const c = E.socialCountsFrom({});
  eq([c.reactions, c.comments, c.reposts], [null, null, null]);
});

check('a genuine zero survives as zero', () => {
  const c = E.socialCountsFrom({ s: { numComments: 0, numShares: 0 } });
  eq([c.comments, c.reposts], [0, 0]);
});

group('mapUpdate');

check('maps a resolved update end to end', () => {
  const p = E.mapUpdate({
    entityUrn: 'urn:li:fsd_update:(urn:li:activity:7100000000000000009,FEED,EMPTY)',
    commentary: { text: 'Hello world' },
    social: { numLikes: 12, numComments: 3, numShares: 1, reactionTypeCounts: [{ reactionType: 'LIKE', count: 12 }] }
  });
  eq(p.activityId, '7100000000000000009');
  eq(p.postUrl, 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000009/');
  eq(p.text, 'Hello world');
  eq(p.type, 'text');
  eq([p.reactions, p.comments, p.reposts], [12, 3, 1]);
  eq(p.timestampSource, 'derived-from-urn', 'no createdAt, so the id supplies the date');
  ok(p.publishedAt > 0);
});

check('prefers a real timestamp over the derived one', () => {
  const p = E.mapUpdate({ entityUrn: 'urn:li:activity:7100000000000000009', c: { createdAt: 1700000000000 } });
  eq(p.publishedAt, 1700000000000);
  eq(p.timestampSource, 'api');
});

check('returns null for a node with no activity URN rather than a junk post', () => {
  eq(E.mapUpdate({ entityUrn: 'urn:li:fsd_profile:ABC', text: 'not a post' }), null);
});

check("drops a video's poster frame from the image list", () => {
  const p = E.mapUpdate({
    entityUrn: 'urn:li:activity:7100000000000000009',
    v: {
      progressiveStreams: [{ bitRate: 1, streamingLocations: [{ url: 'https://x/v.mp4' }] }],
      thumbnail: { rootUrl: 'https://media.licdn.com/dms/image/P/', artifacts: [{ fileIdentifyingUrlPathSegment: '800/p.jpg', width: 800 }] }
    }
  });
  eq(p.media.filter((m) => m.type === 'image').length, 0, 'the poster is not a separate attachment');
  eq(p.type, 'video');
});

/* ================================================================== *
 * Pagination honesty
 * ================================================================== */
group('PageTracker');

check('a page with nothing new stops the run', () => {
  const t = new E.PageTracker('test');
  eq(t.record(20), 'continue');
  eq(t.record(0), 'stop');
  ok(t.stoppedEarly);
  ok(/no new posts/.test(t.reason), t.reason);
});

check('the summary never implies the account was exhausted', () => {
  const t = new E.PageTracker('test');
  t.record(20);
  t.record(0);
  eq(t.summary(20), 'Collected 20 posts — LinkedIn stopped returning more.');
});

check('a clean run says only what it collected', () => {
  const t = new E.PageTracker('test');
  t.record(20);
  eq(t.summary(20), 'Collected 20 posts.');
});

check('three consecutive declines warn exactly once', () => {
  const t = new E.PageTracker('test');
  [20, 14, 9, 5, 3].forEach((n) => t.record(n));
  ok(t.warned, 'should have warned');
  eq(t.declineStreak >= 3, true);
});

check('a single dip does not warn', () => {
  const t = new E.PageTracker('test');
  [20, 14, 20, 20].forEach((n) => t.record(n));
  ok(!t.warned);
});

/* ================================================================== */
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);

/*
 * Exit explicitly. Anything above that logs — PageTracker's decline warning
 * does — goes through the real emit path, which opens a port and starts the
 * 15-second heartbeat that keeps the service worker alive. That is correct in
 * a browser and holds Node's event loop open forever here.
 */
process.exit(failures.length ? 1 : 0);
