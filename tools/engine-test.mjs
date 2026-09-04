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
  eq(imgs, [{ type: 'image', url: 'https://media.licdn.com/dms/image/A/1200/a.jpg', alt: '' }]);
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

/* ================================================================== *
 * Profile media and counts
 *
 * The photo went missing because the DOM reader asked for
 * `img.pv-top-card-profile-picture__image` and LinkedIn ships that image as
 * `…__image--show`. A class selector matches whole tokens, so it never
 * matched, and the read fell through to og:image. These cover the rule that
 * replaced it: the CDN path, which does not churn.
 * ================================================================== */
group('profile media, by CDN path');

const PHOTO = 'https://media.licdn.com/dms/image/v2/D5603AQ/profile-displayphoto-shrink_400_400/0/17?e=1';
const FRAMED = 'https://media.licdn.com/dms/image/v2/D56/profile-framedphoto-shrink_400_400/0/17?e=1';
const BANNER = 'https://media.licdn.com/dms/image/v2/D56/profile-displaybackgroundimage-shrink_350_1400/0/17?e=1';
const POST_IMG = 'https://media.licdn.com/dms/image/v2/D4E22AQ/feedshare-shrink_2048_1536/0/17?e=1';
const LOGO = 'https://media.licdn.com/dms/image/v2/C4D0BAQ/company-logo_200_200/0/16?e=1';

check('picks the avatar out of a page full of other images', () => {
  eq(E.pickImageByPath([LOGO, POST_IMG, PHOTO], E.PROFILE_PHOTO_PATH), PHOTO);
  eq(E.pickImageByPath([POST_IMG, BANNER], E.PROFILE_BANNER_PATH), BANNER);
});

check('a framed photo is still the member photo', () => {
  eq(E.pickImageByPath([FRAMED], E.PROFILE_PHOTO_PATH), FRAMED);
});

check('the avatar and the cover are never confused for each other', () => {
  eq(E.pickImageByPath([BANNER], E.PROFILE_PHOTO_PATH), null);
  eq(E.pickImageByPath([PHOTO], E.PROFILE_BANNER_PATH), null);
});

check('nothing on the right path yields null, not a wrong URL', () => {
  eq(E.pickImageByPath([LOGO, POST_IMG], E.PROFILE_PHOTO_PATH), null);
  eq(E.pickImageByPath([], E.PROFILE_PHOTO_PATH), null);
  eq(E.pickImageByPath(null, E.PROFILE_PHOTO_PATH), null);
  eq(E.pickImageByPath(['/dms/image/profile-displayphoto/x'], E.PROFILE_PHOTO_PATH), null, 'relative is not a URL');
});

check('allImageUrls reaches an avatar the named fields do not', () => {
  // The shape LinkedIn moves between releases: the picture is nested a level
  // deeper than profilePicture.displayImageReference.vectorImage.
  const entity = {
    entityUrn: 'urn:li:fsd_profile:ABC',
    firstName: 'Ada',
    profilePicture: {
      displayImageReferenceResolutionResult: {
        vectorImage: { rootUrl: 'https://media.licdn.com/dms/image/v2/D5603AQ/profile-displayphoto-shrink_400_400/0/17', artifacts: [{ fileIdentifyingUrlPathSegment: '?e=1', width: 400 }] }
      }
    }
  };
  eq(E.pickImageByPath(E.allImageUrls(entity), E.PROFILE_PHOTO_PATH), PHOTO);
});

check('mapProfileEntity falls back to the CDN path for photo and banner', () => {
  const p = {
    entityUrn: 'urn:li:fsd_profile:ABC',
    publicIdentifier: 'ada',
    firstName: 'Ada',
    lastName: 'Lovelace',
    headline: 'Mathematician',
    profilePicture: { somethingNew: { vectorImage: { rootUrl: PHOTO, artifacts: [] } } },
    backgroundPicture: { somethingNew: { vectorImage: { rootUrl: BANNER, artifacts: [] } } }
  };
  const out = E.mapProfileEntity(p, { included: [p] });
  eq(out.photoUrl, PHOTO, 'photoUrl');
  eq(out.bannerUrl, BANNER, 'bannerUrl');
  eq(out.fullName, 'Ada Lovelace');
});

group('follower and connection counts');

check('reads the counts LinkedIn actually prints', () => {
  eq(E.countFromText('Kolkata, India · 18,432 followers · 500+ connections', 'followers?'), 18432);
  eq(E.countFromText('Kolkata, India · 18,432 followers · 500+ connections', 'connections?'), 500);
  eq(E.countFromText('1.2K followers', 'followers?'), 1200);
  eq(E.countFromText('3M followers', 'followers?'), 3000000);
  eq(E.countFromText('1 follower', 'followers?'), 1);
});

check('a missing count is null rather than zero', () => {
  eq(E.countFromText('Kolkata, India', 'followers?'), null);
  eq(E.countFromText('', 'followers?'), null);
  eq(E.countFromText(null, 'connections?'), null);
});

/* ================================================================== *
 * The kinds that carry more than media
 *
 * classifyPost recognised articles, polls and reposts all along — it has to,
 * to file them — but nothing read what makes them what they are, so three of
 * the seven types reached the archive as a label on an empty shell.
 * ================================================================== */
group('article cards');

const ARTICLE_NODE = {
  entityUrn: 'urn:li:activity:1',
  content: {
    articleComponent: {
      title: { text: 'Why watch time is the only number that matters' },
      subtitle: { text: 'contentdaddy.in · 6 min read' },
      navigationContext: { actionTarget: 'https://contentdaddy.in/blog/watch-time?utm=li' },
      largeImage: { rootUrl: 'https://media.licdn.com/dms/image/A/', artifacts: [{ fileIdentifyingUrlPathSegment: '800/hero.jpg', width: 800 }] }
    }
  }
};

check('reads the headline, the link and the domain', () => {
  const a = E.articleFrom(ARTICLE_NODE);
  eq(a.title, 'Why watch time is the only number that matters');
  eq(a.url, 'https://contentdaddy.in/blog/watch-time?utm=li');
  eq(a.domain, 'contentdaddy.in', 'the domain is what makes a link scannable in a spreadsheet');
  eq(a.thumbnail, 'https://media.licdn.com/dms/image/A/800/hero.jpg');
});

check('the type and the record agree about what an article is', () => {
  // Both go through isArticleCard, so they cannot disagree.
  eq(E.classifyPost(ARTICLE_NODE, []), 'article');
  ok(E.articleFrom(ARTICLE_NODE), 'and the record is there to back the label');
});

check('a plain text post has no article card', () => {
  eq(E.articleFrom({ entityUrn: 'urn:li:activity:2', commentary: { text: 'Just a thought.' } }), null);
});

group('polls');

const POLL_NODE = {
  entityUrn: 'urn:li:activity:3',
  content: {
    pollComponent: {
      question: { text: 'How do you repurpose podcast footage?' },
      pollOptions: [
        { option: { text: 'Shorts only' }, voteCount: 42 },
        { option: { text: 'Shorts + carousels' }, voteCount: 118 }
      ],
      pollSummary: { totalVotes: 160, pollClosed: true }
    }
  }
};

check('reads the question, every option and the split', () => {
  const p = E.pollFrom(POLL_NODE);
  eq(p.question, 'How do you repurpose podcast footage?');
  eq(p.options.length, 2);
  eq(p.options[1], { text: 'Shorts + carousels', votes: 118 });
  eq(p.totalVotes, 160);
  eq(p.closed, true);
});

check('a total LinkedIn withheld is summed from the options', () => {
  const p = E.pollFrom({ content: { pollOptions: [{ option: { text: 'A' }, voteCount: 3 }, { option: { text: 'B' }, voteCount: 4 }] } });
  eq(p.totalVotes, 7);
  eq(p.closed, null, 'not stated is not the same as open');
});

check('a post with no poll reads as no poll', () => {
  eq(E.pollFrom({ entityUrn: 'urn:li:activity:4', commentary: { text: 'x' } }), null);
});

group('reshares');

check('records whose post it was', () => {
  const r = E.repostFrom({
    entityUrn: 'urn:li:activity:5',
    commentary: { text: 'This is exactly right.' },
    resharedUpdate: {
      entityUrn: 'urn:li:activity:999',
      actor: { name: { text: 'Grace Hopper' }, description: { text: 'Rear Admiral' }, publicIdentifier: 'grace-hopper' },
      commentary: { text: 'We have always done it this way.' }
    }
  });
  eq(r.author, 'Grace Hopper');
  eq(r.authorHeadline, 'Rear Admiral');
  eq(r.authorUrl, 'https://www.linkedin.com/in/grace-hopper/');
  eq(r.activityId, '999');
  eq(r.postUrl, 'https://www.linkedin.com/feed/update/urn:li:activity:999/');
  eq(r.text, 'We have always done it this way.', 'the original body, not the reposter\'s comment');
});

check('an unresolved reshare still yields a permalink', () => {
  const r = E.repostFrom({ entityUrn: 'urn:li:activity:6', '*resharedUpdate': 'urn:li:activity:12345' });
  eq(r.activityId, '12345');
  eq(r.postUrl, 'https://www.linkedin.com/feed/update/urn:li:activity:12345/');
});

check('an original post is not a reshare', () => {
  eq(E.repostFrom({ entityUrn: 'urn:li:activity:7', commentary: { text: 'Mine.' } }), null);
});

group('hashtags');

check('deduped, case-insensitively, in the order written', () => {
  eq(E.hashtagsFrom('#ContentStrategy and #podcasting and #contentstrategy'), ['ContentStrategy', 'podcasting']);
});

check('reads a tag in parentheses but not a mid-word hash', () => {
  eq(E.hashtagsFrom('(#B2B) email#notatag #Q4'), ['B2B', 'Q4']);
});

check('non-latin tags survive', () => {
  eq(E.hashtagsFrom('#содержание #コンテンツ'), ['содержание', 'コンテンツ']);
});

check('no text, no tags', () => {
  eq(E.hashtagsFrom(''), []);
  eq(E.hashtagsFrom(null), []);
});

group('the rest of the profile');

const SECTION_POOL = {
  included: [
    { $type: 'com.linkedin.voyager.dash.identity.profile.Certification', entityUrn: 'urn:li:c:1', name: { text: 'Google Analytics' }, authority: { text: 'Google' }, url: 'https://cert.example/1', dateRange: { start: { year: 2023, month: 4 } } },
    { $type: 'com.linkedin.voyager.dash.identity.profile.Language', entityUrn: 'urn:li:l:1', name: { text: 'Bengali' }, proficiency: { text: 'Native or bilingual' } },
    { $type: 'com.linkedin.voyager.dash.identity.profile.VolunteerExperience', entityUrn: 'urn:li:v:1', role: { text: 'Mentor' }, companyName: { text: 'STEM India' } },
    { $type: 'com.linkedin.voyager.dash.identity.profile.Honor', entityUrn: 'urn:li:h:1', title: { text: 'Creator of the Year' }, issuer: { text: 'Podcast Awards' } }
  ]
};

check('reads every section the table names', () => {
  const s = E.readProfileSections(SECTION_POOL);
  eq(Object.keys(s).sort(), E.PROFILE_SECTIONS.map((x) => x.key).sort());
  eq(s.certifications.length, 1);
  eq(s.languages[0], { name: 'Bengali', detail: 'Native or bilingual', dates: '', url: null, description: '' });
});

check('a certificate is issued on a date, not held until Present', () => {
  const s = E.readProfileSections(SECTION_POOL);
  eq(s.certifications[0].dates, 'Apr 2023');
  eq(s.certifications[0].url, 'https://cert.example/1');
});

check('a volunteer entry leads with the role, not the organisation', () => {
  const s = E.readProfileSections(SECTION_POOL);
  eq(s.volunteering[0].name, 'Mentor');
  eq(s.volunteering[0].detail, 'STEM India');
});

check('a section the profile does not have is empty, not absent', () => {
  const s = E.readProfileSections({ included: [] });
  for (const sec of E.PROFILE_SECTIONS) eq(Array.isArray(s[sec.key]), true, sec.key);
});

/* ================================================================== *
 * The "Show all" pages
 *
 * A profile card is a preview: two or three roles, a school or two, and the
 * rest behind /in/<id>/details/<section>/. Reading only the card and calling
 * it the full history is the one thing this scraper is written not to do.
 * ================================================================== */
group('following the full history');

check('the sections that have a page are all covered', () => {
  const keys = E.DETAILS_PAGES.map((d) => d.key);
  for (const need of ['experience', 'education', 'skills']) ok(keys.includes(need), need);
  // Every profile section the export renders can be filled from its page.
  for (const s of E.PROFILE_SECTIONS) ok(keys.includes(s.key), `no page for ${s.key}`);
});

check('every page maps rows and can identify a duplicate', () => {
  for (const d of E.DETAILS_PAGES) {
    ok(typeof d.map === 'function', `${d.key} map`);
    ok(typeof d.id === 'function', `${d.key} id`);
    ok(typeof d.path === 'string' && d.path.length, `${d.key} path`);
  }
  return `${E.DETAILS_PAGES.length} pages`;
});

check('a role from the page and the same role from the card merge to one', () => {
  const card = E.experienceFromRows([['Founder', 'Content Daddy · Full-time', 'Jan 2023 - Present', 'Kolkata']]);
  const page = E.experienceFromRows([
    ['Founder', 'Content Daddy · Full-time', 'Jan 2023 - Present', 'Kolkata'],
    ['Video Editor', 'Freelance · Self-employed', 'Mar 2019 - Dec 2022', 'Remote']
  ]);
  const d = E.DETAILS_PAGES.find((x) => x.key === 'experience');
  const merged = E.mergeById(card, page, d.id);
  eq(merged.length, 2, 'the shared role is not counted twice');
  eq(merged[0].title, 'Founder', 'and what the card found stays first');
  eq(merged[1].title, 'Video Editor');
});

check('merging can only grow a list, never shrink it', () => {
  const d = E.DETAILS_PAGES.find((x) => x.key === 'education');
  const card = E.educationFromRows([['University of Calcutta', 'B.Com, Accounting', '2015 - 2018']]);
  // A page that fails to parse hands back nothing; the card must survive it.
  eq(E.mergeById(card, [], d.id).length, 1);
  eq(E.mergeById(card, null, d.id).length, 1);
});

check('skills merge by name because a skill is just a name', () => {
  const d = E.DETAILS_PAGES.find((x) => x.key === 'skills');
  eq(d.map([['Video Editing', '12 endorsements'], ['Content Strategy']]), ['Video Editing', 'Content Strategy']);
  eq(E.mergeById(['Video Editing'], ['Video Editing', 'Copywriting'], d.id), ['Video Editing', 'Copywriting']);
});

check('generic profile components read as the same four fields the markup prints', () => {
  // Modern LinkedIn ships sections as components rather than typed entities.
  const rows = E.componentRows({
    included: [
      { entityComponent: {
          titleV2: { text: { text: 'Founder' } },
          subtitle: { text: 'Content Daddy · Full-time' },
          caption: { text: 'Jan 2023 - Present · 2 yrs' },
          metadata: { text: 'Kolkata, India' } } }
    ]
  });
  eq(rows, [['Founder', 'Content Daddy · Full-time', 'Jan 2023 - Present · 2 yrs', 'Kolkata, India']]);
  const exp = E.experienceFromRows(rows);
  eq(exp[0].title, 'Founder');
  eq(exp[0].company, 'Content Daddy', 'the employment type is split off');
  eq(exp[0].current, true);
});

/* ================================================================== *
 * Every reader contributes; none of them is a fallback
 *
 * The reported bug: a real profile came back with a name, a headline and a
 * photo, and no job history at all. LinkedIn still ships the Profile entity in
 * the page payload, so the embedded strategy always "succeeded" and returned —
 * but it no longer ships typed Position/Education entities beside it, so the
 * lists that entity produced were empty and the DOM reader that can see the
 * rendered rows was never reached.
 * ================================================================== */
group('profile sources merge rather than race');

check('a later source fills lists an earlier one left empty', () => {
  const thin = { fullName: 'Sumon Chowdhury', headline: 'Podcast growth partner', experience: [], education: [], skills: [] };
  const rendered = {
    fullName: '', headline: '',
    experience: [{ title: 'Founder', company: 'Content Daddy', dates: 'Jan 2023 - Present' }],
    education: [{ school: 'University of Calcutta', degree: 'B.Com', dates: '2015 - 2018' }],
    skills: ['Video Editing']
  };
  const m = E.mergeProfiles(thin, rendered);
  eq(m.fullName, 'Sumon Chowdhury', 'the richer scalar is not overwritten by an empty one');
  eq(m.experience.length, 1, 'and the empty list is filled');
  eq(m.education.length, 1);
  eq(m.skills, ['Video Editing']);
});

check('the same role from two sources is one role', () => {
  const a = { experience: [{ title: 'Founder', company: 'Content Daddy', dates: 'Jan 2023 - Present' }] };
  const b = {
    experience: [
      { title: 'Founder', company: 'Content Daddy', dates: 'Jan 2023 - Present' },
      { title: 'Video Editor', company: 'Freelance', dates: 'Mar 2019 - Dec 2022' }
    ]
  };
  eq(E.mergeProfiles(a, b).experience.length, 2);
});

check('merging never shrinks a list', () => {
  const a = { experience: [{ title: 'Founder', company: 'Content Daddy', dates: 'x' }], skills: ['A', 'B'] };
  eq(E.mergeProfiles(a, { experience: [], skills: [] }).experience.length, 1);
  eq(E.mergeProfiles(a, {}).skills, ['A', 'B']);
  eq(E.mergeProfiles(null, a).experience.length, 1, 'nothing to merge onto is not a loss');
  eq(E.mergeProfiles(a, null).experience.length, 1);
});

check('every profile section merges, not just the three headline lists', () => {
  const a = { certifications: [], languages: [{ name: 'Bengali', detail: 'Native', dates: '' }] };
  const b = {
    certifications: [{ name: 'Google Analytics', detail: 'Google', dates: 'Apr 2023' }],
    languages: [{ name: 'Bengali', detail: 'Native', dates: '' }, { name: 'English', detail: 'Full', dates: '' }]
  };
  const m = E.mergeProfiles(a, b);
  eq(m.certifications.length, 1);
  eq(m.languages.length, 2, 'deduped by identity, not appended blindly');
});

check('a role with no resolvable company is still a role', () => {
  // Self-employed, freelance, or a company LinkedIn has since deleted: the
  // predicate used to demand a company alongside the title and dropped these.
  const pool = { included: [
    { $type: 'com.linkedin.voyager.dash.identity.profile.Position', entityUrn: 'urn:li:p:1',
      title: { text: 'Independent Consultant' }, dateRange: { start: { year: 2021, month: 3 } } }
  ]};
  const p = E.mapProfileEntity({ entityUrn: 'urn:li:fsd_profile:X', publicIdentifier: 'x', firstName: 'X' }, pool);
  eq(p.experience.length, 1);
  eq(p.experience[0].title, 'Independent Consultant');
  eq(p.experience[0].current, true, 'no end date means still there');
});

/* ================================================================== */
/* ================================================================== */
group('the rewritten mappers');

check('a post keeps its own words when it reshares a longer one', () => {
  const t = E.postTextFrom({
    commentary: { text: 'Worth a read.' },
    resharedUpdate: { commentary: { text: 'A very long original post that goes on and on and on and on and on.' } }
  });
  eq(t, 'Worth a read.');
});

check('a post with no commentary of its own still finds its text, but not the reshare', () => {
  const t = E.postTextFrom({
    content: { description: { text: 'An article summary' } },
    resharedUpdate: { commentary: { text: 'Somebody else wrote this, at length, and it is the longest string here.' } }
  });
  eq(t, 'An article summary');
});

check('the reaction breakdown comes from the post, not the sum of every nested one', () => {
  const r = E.reactionsFrom({
    socialDetail: { reactionTypeCounts: [{ reactionType: 'LIKE', count: 10 }, { reactionType: 'PRAISE', count: 2 }], numLikes: 12 },
    resharedUpdate: { socialDetail: { reactionTypeCounts: [{ reactionType: 'LIKE', count: 900 }], numLikes: 900 } },
    comments: [{ socialDetail: { reactionTypeCounts: [{ reactionType: 'LIKE', count: 5 }], numLikes: 5 } }]
  });
  eq(r.total, 12);
  eq(r.byType, { LIKE: 10, PRAISE: 2 });
});

check('@mentions carry the profile they point at', () => {
  const text = 'Thanks @Ada Lovelace and Acme Corp for this';
  const m = E.mentionsFrom({
    commentary: {
      text: {
        text,
        attributesV2: [
          // LinkedIn's span covers the name, not the @ it was typed with.
          { start: 8, length: 12, detailData: { profileMention: { publicIdentifier: 'ada-l', firstName: 'Ada', lastName: 'Lovelace' } } },
          { start: 25, length: 9, detailData: { companyMention: { universalName: 'acme' } } },
          { start: 0, length: 6, detailData: { hashtag: { text: '#x' } } }
        ]
      }
    }
  });
  eq(m, [
    { kind: 'person', name: 'Ada Lovelace', url: 'https://www.linkedin.com/in/ada-l/' },
    { kind: 'company', name: 'Acme Corp', url: 'https://www.linkedin.com/company/acme/' }
  ]);
});

check('a comment body in the values[] shape is read, and the newer commentary shape too', () => {
  const older = E.mapComment({ comment: { values: [{ value: 'Great ' }, { value: 'post!' }] }, commenter: { title: { text: 'Bo' } } });
  eq(older.text, 'Great post!');
  eq(older.author, 'Bo');
  const newer = E.mapComment({ commentary: { text: 'Agreed.' }, entityUrn: 'urn:li:comment:1', parentCommentUrn: 'urn:li:comment:0', socialDetail: { numComments: 2 } });
  eq(newer.text, 'Agreed.');
  eq(newer.urn, 'urn:li:comment:1');
  eq(newer.parentUrn, 'urn:li:comment:0');
  eq(newer.replyCount, 2);
});

check('images carry their alt text', () => {
  const imgs = E.imagesFrom({
    images: [{
      accessibilityText: 'A chart of growth',
      attributes: [{ detailData: { vectorImage: { rootUrl: 'https://media.licdn.com/dms/image/B/', artifacts: [{ fileIdentifyingUrlPathSegment: '800/b.jpg', width: 800 }] } } }]
    }]
  });
  eq(imgs, [{ type: 'image', url: 'https://media.licdn.com/dms/image/B/800/b.jpg', alt: 'A chart of growth' }]);
});

check('the contact overlay payload is read', () => {
  const c = E.contactFromPayload({
    included: [{
      $type: 'com.linkedin.voyager.identity.profile.ProfileContactInfo',
      emailAddress: { emailAddress: 'ada@example.com' },
      phoneNumbers: [{ number: '+44 20 7946 0000', type: 'MOBILE' }],
      websites: [{ url: 'https://ada.example', category: 'PERSONAL' }, { url: 'https://engines.example' }],
      twitterHandles: [{ name: 'ada' }],
      birthDateOn: { month: 12, day: 10 },
      address: '12 Analytical Row'
    }]
  });
  eq(c.email, 'ada@example.com');
  eq(c.phone, '+44 20 7946 0000');
  eq(c.websites, ['https://ada.example', 'https://engines.example']);
  eq(c.twitter, 'ada');
  eq(c.birthday, 'Dec 10');
  eq(c.address, '12 Analytical Row');
});

check('the pronoun enum reads as words', () => {
  eq(E.pronounText('SHE_HER'), 'she/her');
  eq(E.pronounText({ text: 'THEY_THEM' }), 'they/them');
  eq(E.pronounText(''), '');
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);

/*
 * Exit explicitly. Anything above that logs — PageTracker's decline warning
 * does — goes through the real emit path, which opens a port and starts the
 * 15-second heartbeat that keeps the service worker alive. That is correct in
 * a browser and holds Node's event loop open forever here.
 */
process.exit(failures.length ? 1 : 0);
