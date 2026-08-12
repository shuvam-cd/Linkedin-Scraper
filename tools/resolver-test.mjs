/*
 * resolver-test.mjs — isolation test for voyager.js.
 *
 * The URN resolver is the highest-risk piece of this extension: everything
 * Strategy A produces passes through it, and a subtle bug there looks exactly
 * like "LinkedIn changed their API" from the outside. It is also the only part
 * of the scraper that can be verified without a live session, because it is
 * pure data transformation.
 *
 *   node tools/resolver-test.mjs
 *
 * Fixtures below are hand-written to the *shape* of a normalized+json+2.1
 * envelope, not copied from a real capture. They exercise the rules the format
 * guarantees — star-prefixed references, entityUrn/$id keying, cycles, dangling
 * references — none of which are version-specific. Real payloads change; these
 * invariants do not.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// voyager.js is a browser IIFE that attaches to globalThis; it touches no DOM
// and no chrome.* API, so evaluating it here is all the setup required.
new Function(readFileSync(join(here, '..', 'voyager.js'), 'utf8'))();
const V = globalThis.LISVoyager;

/* ------------------------------------------------------------------ *
 * Tiny harness
 * ------------------------------------------------------------------ */
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'value'}\n       expected ${b}\n       actual   ${a}`);
}

function ok(cond, what) {
  if (!cond) throw new Error(what || 'expected truthy');
}

function group(title) {
  process.stdout.write(`\n${title}\n`);
}

/* ================================================================== *
 * CSRF token
 * ================================================================== */
group('csrfFromCookie — the quoted JSESSIONID');

check('strips the literal double quotes LinkedIn wraps the value in', () => {
  eq(V.csrfFromCookie('li_at=abc; JSESSIONID="ajax:1234567890123456789"; lang=v=2'), 'ajax:1234567890123456789');
});

check('handles a percent-encoded cookie jar', () => {
  eq(V.csrfFromCookie('JSESSIONID=%22ajax%3A987654321%22'), 'ajax:987654321');
});

check('handles an unquoted value', () => {
  eq(V.csrfFromCookie('JSESSIONID=ajax:555'), 'ajax:555');
});

check('returns empty when the cookie is absent', () => {
  eq(V.csrfFromCookie('li_at=abc; lang=v=2'), '');
  eq(V.csrfFromCookie(''), '');
  eq(V.csrfFromCookie(null), '');
});

check('does not match a cookie merely ending in JSESSIONID', () => {
  eq(V.csrfFromCookie('XJSESSIONID="ajax:nope"'), '');
});

check('picks JSESSIONID out of the middle of a long jar', () => {
  eq(V.csrfFromCookie('bcookie=v=2&x; JSESSIONID="ajax:42"; bscookie=v=1&y; li_at=z'), 'ajax:42');
});

group('headers — exactly what a page request sends');

check('sets the three Rest.li headers and nothing else', () => {
  const h = V.headers('JSESSIONID="ajax:42"');
  eq(Object.keys(h).sort(), ['accept', 'csrf-token', 'x-restli-protocol-version']);
  eq(h['csrf-token'], 'ajax:42');
  eq(h['x-restli-protocol-version'], '2.0.0');
  eq(h.accept, 'application/vnd.linkedin.normalized+json+2.1');
});

check('omits csrf-token entirely when there is no session', () => {
  ok(!('csrf-token' in V.headers('')), 'csrf-token must be absent, not empty');
});

group('sessionCookies — what a page script can actually see');

/*
 * The bug this guards against shipped once: `li_at` is HttpOnly, so
 * document.cookie never contains it, and a login check that required it
 * reported "not logged in" for every valid session. sessionCookies must
 * report signals only — never a verdict — precisely so no caller is tempted
 * to gate on li_at again.
 */
check('reports li_at, liap and csrf separately rather than a verdict', () => {
  const s = V.sessionCookies('li_at=AQED; liap=true; JSESSIONID="ajax:1"');
  eq(s, { liAt: true, liap: true, csrf: 'ajax:1' });
});

check('a real logged-in jar has no li_at, because it is HttpOnly', () => {
  // This is what document.cookie actually looks like on a signed-in session.
  const s = V.sessionCookies('bcookie="v=2&abc"; JSESSIONID="ajax:9876543210"; lang=v=2&lang=en-us; liap=true');
  eq(s.liAt, false, 'li_at is invisible to page scripts — this must not read as logged out');
  eq(s.csrf, 'ajax:9876543210', 'the readable signal is JSESSIONID');
  eq(s.liap, true);
});

check('an empty jar reports nothing rather than throwing', () => {
  eq(V.sessionCookies(''), { liAt: false, liap: false, csrf: '' });
  eq(V.sessionCookies(null), { liAt: false, liap: false, csrf: '' });
});

check('hasSession is gone — it encoded the li_at mistake in its name', () => {
  ok(V.hasSession === undefined, 'a boolean "is logged in" cannot be answered from cookies alone');
});

/* ================================================================== *
 * URN helpers
 * ================================================================== */
group('URN parsing');

check('splits a simple URN', () => {
  eq(V.urnType('urn:li:fsd_profile:ACoAAABcDeF'), 'fsd_profile');
  eq(V.urnId('urn:li:fsd_profile:ACoAAABcDeF'), 'ACoAAABcDeF');
});

check('keeps a compound id intact rather than truncating at its colons', () => {
  const u = 'urn:li:fsd_update:(urn:li:activity:7100000000000000000,FEED_DETAIL,EMPTY)';
  eq(V.urnType(u), 'fsd_update');
  eq(V.urnId(u), '(urn:li:activity:7100000000000000000,FEED_DETAIL,EMPTY)');
});

check('digs the activity id out of any URN shape carrying one', () => {
  eq(V.activityId('urn:li:activity:7100000000000000000'), '7100000000000000000');
  eq(V.activityId('urn:li:fsd_update:(urn:li:activity:7123,FEED,EMPTY)'), '7123');
  eq(V.activityId('urn:li:share:999'), null);
  eq(V.activityId(null), null);
});

/* ================================================================== *
 * The resolver
 * ================================================================== */
group('resolveNormalized — re-stitching the envelope');

check('resolves a single star reference', () => {
  const out = V.resolveNormalized({
    data: { '*profile': 'urn:li:fsd_profile:A' },
    included: [{ entityUrn: 'urn:li:fsd_profile:A', $type: 'x.Profile', firstName: 'Ada' }]
  });
  eq(out.profile.firstName, 'Ada');
});

check('resolves an array of star references in order', () => {
  const out = V.resolveNormalized({
    data: { '*elements': ['urn:li:x:1', 'urn:li:x:2'] },
    included: [
      { entityUrn: 'urn:li:x:2', n: 2 },
      { entityUrn: 'urn:li:x:1', n: 1 }
    ]
  });
  eq(out.elements.map((e) => e.n), [1, 2], 'order must follow the reference list, not included[]');
});

check('keeps the raw reference alongside the resolved value', () => {
  const out = V.resolveNormalized({
    data: { '*profile': 'urn:li:fsd_profile:A' },
    included: [{ entityUrn: 'urn:li:fsd_profile:A', firstName: 'Ada' }]
  });
  eq(out['*profile'], 'urn:li:fsd_profile:A', 'permalinks are built from the raw URN');
});

check('resolves references nested arbitrarily deep', () => {
  const out = V.resolveNormalized({
    data: { a: { b: [{ c: { '*who': 'urn:li:p:1' } }] } },
    included: [{ entityUrn: 'urn:li:p:1', name: 'deep' }]
  });
  eq(out.a.b[0].c.who.name, 'deep');
});

check('resolves references held by an entity, not just by data', () => {
  const out = V.resolveNormalized({
    data: { '*element': 'urn:li:update:1' },
    included: [
      { entityUrn: 'urn:li:update:1', '*actor': 'urn:li:profile:9', text: 'hello' },
      { entityUrn: 'urn:li:profile:9', firstName: 'Grace' }
    ]
  });
  eq(out.element.text, 'hello');
  eq(out.element.actor.firstName, 'Grace', 'transitive resolution must work');
});

check('marks a dangling reference instead of dropping the key', () => {
  const out = V.resolveNormalized({ data: { '*gone': 'urn:li:x:404' }, included: [] });
  eq(out.gone, { $missing: 'urn:li:x:404' });
});

check('marks a dangling reference inside an array element-wise', () => {
  const out = V.resolveNormalized({
    data: { '*elements': ['urn:li:x:1', 'urn:li:x:404'] },
    included: [{ entityUrn: 'urn:li:x:1', n: 1 }]
  });
  eq(out.elements[0].n, 1);
  eq(out.elements[1], { $missing: 'urn:li:x:404' });
});

check('breaks a two-node cycle without hanging', () => {
  const out = V.resolveNormalized({
    data: { '*root': 'urn:li:a:1' },
    included: [
      { entityUrn: 'urn:li:a:1', name: 'A', '*peer': 'urn:li:b:1' },
      { entityUrn: 'urn:li:b:1', name: 'B', '*peer': 'urn:li:a:1' }
    ]
  });
  eq(out.root.name, 'A');
  eq(out.root.peer.name, 'B');
  eq(out.root.peer.peer, { $ref: 'urn:li:a:1' }, 'the loop must close with a marker');
});

check('breaks a self-reference', () => {
  const out = V.resolveNormalized({
    data: { '*root': 'urn:li:a:1' },
    included: [{ entityUrn: 'urn:li:a:1', '*self': 'urn:li:a:1' }]
  });
  eq(out.root.self, { $ref: 'urn:li:a:1' });
});

check('expands a repeated entity on sibling paths — cycle detection is per-path', () => {
  // The same company on two positions must expand twice. A global visited set
  // would silently blank the second one, which is the classic bug here.
  const out = V.resolveNormalized({
    data: { '*positions': ['urn:li:pos:1', 'urn:li:pos:2'] },
    included: [
      { entityUrn: 'urn:li:pos:1', title: 'Engineer', '*company': 'urn:li:co:1' },
      { entityUrn: 'urn:li:pos:2', title: 'Senior Engineer', '*company': 'urn:li:co:1' },
      { entityUrn: 'urn:li:co:1', name: 'Acme' }
    ]
  });
  eq(out.positions[0].company.name, 'Acme');
  eq(out.positions[1].company.name, 'Acme', 'the second occurrence must not be blanked');
});

check('indexes entities keyed by $id as well as entityUrn', () => {
  const out = V.resolveNormalized({
    data: { '*a': 'urn:li:x:1', '*b': 'urn:li:y:2' },
    included: [
      { entityUrn: 'urn:li:x:1', v: 'by-entityUrn' },
      { $id: 'urn:li:y:2', v: 'by-$id' }
    ]
  });
  eq(out.a.v, 'by-entityUrn');
  eq(out.b.v, 'by-$id');
});

check('finds included[] when it is nested under data', () => {
  const out = V.resolveNormalized({
    data: {
      '*profile': 'urn:li:p:1',
      included: [{ entityUrn: 'urn:li:p:1', firstName: 'Nested' }]
    }
  });
  eq(out.profile.firstName, 'Nested');
});

check('leaves a star key holding an already-inlined object alone', () => {
  const out = V.resolveNormalized({
    data: { '*thing': { inline: true, '*inner': 'urn:li:z:1' } },
    included: [{ entityUrn: 'urn:li:z:1', deep: 1 }]
  });
  eq(out.thing.inline, true);
  eq(out.thing.inner.deep, 1, 'inlined objects still get their own refs resolved');
});

check('does not dereference a URN under a non-star key', () => {
  const out = V.resolveNormalized({
    data: { entityUrn: 'urn:li:p:1', someUrnField: 'urn:li:p:1' },
    included: [{ entityUrn: 'urn:li:p:1', firstName: 'Ada' }]
  });
  eq(out.entityUrn, 'urn:li:p:1', 'entityUrn must stay a string or resolution self-recurses');
  eq(out.someUrnField, 'urn:li:p:1');
});

check('a real value of the same name wins over the resolved one', () => {
  const out = V.resolveNormalized({
    data: { actor: { literal: true }, '*actor': 'urn:li:p:1' },
    included: [{ entityUrn: 'urn:li:p:1', literal: false }]
  });
  eq(out.actor.literal, true);
});

check('handles a payload with no data key by resolving the payload itself', () => {
  const out = V.resolveNormalized({
    '*top': 'urn:li:p:1',
    included: [{ entityUrn: 'urn:li:p:1', ok: 1 }]
  });
  eq(out.top.ok, 1);
});

check('survives null, primitives and empty objects', () => {
  eq(V.resolveNormalized(null), null);
  eq(V.resolveNormalized({ data: null, included: [] }), null);
  eq(V.resolveNormalized({ data: { a: 1, b: null, c: 'x', d: [] }, included: [] }), { a: 1, b: null, c: 'x', d: [] });
});

check('preserves a bare "*" key rather than producing an empty name', () => {
  const out = V.resolveNormalized({ data: { '*': 'urn:li:x:1' }, included: [] });
  eq(out['*'], 'urn:li:x:1');
});

group('resolver guard rails');

check('a depth cap stops runaway nesting and reports truncation', () => {
  // A chain 40 deep against a maxDepth of 5.
  const included = [];
  for (let i = 0; i < 40; i++) {
    included.push({ entityUrn: `urn:li:n:${i}`, i, '*next': `urn:li:n:${i + 1}` });
  }
  const r = V.resolveNormalized(
    { data: { '*head': 'urn:li:n:0' }, included },
    { maxDepth: 5, withMeta: true }
  );
  ok(r.truncated, 'truncation must be reported, not hidden');
  ok(JSON.stringify(r.value).length < 4000, 'output must stay bounded');
});

check('a node budget stops resolving but never shortens the array', () => {
  // Dropping elements here would be indistinguishable from LinkedIn returning
  // a shorter page, which is exactly the signal the pagination loop reads.
  const included = [];
  const refs = [];
  for (let i = 0; i < 500; i++) {
    included.push({ entityUrn: `urn:li:w:${i}`, a: 1, b: 2, c: 3 });
    refs.push(`urn:li:w:${i}`);
  }
  const r = V.resolveNormalized({ data: { '*elements': refs }, included }, { maxNodes: 50, withMeta: true });
  ok(r.truncated, 'truncation must be reported');
  eq(r.value.elements.length, 500, 'page size must survive the budget');
  eq(r.value.elements[0].a, 1, 'the head resolved normally');
  eq(r.value.elements[499], { $truncated: 'urn:li:w:499' }, 'the tail keeps its URN');
});

check('an over-budget array element is carried through, not dropped', () => {
  const r = V.resolveNormalized(
    { data: { rows: [{ a: 1 }, { b: 2 }, { c: 3 }] }, included: [] },
    { maxNodes: 1, withMeta: true }
  );
  eq(r.value.rows.length, 3);
  eq(r.value.rows[2], { c: 3 }, 'unresolved is still the original value');
});

check('a fan-out graph completes in reasonable time', () => {
  // 200 posts each pointing at one of 20 shared authors: exercises the
  // per-path expansion cost that a naive resolver turns exponential.
  const included = [];
  const refs = [];
  for (let a = 0; a < 20; a++) {
    included.push({ entityUrn: `urn:li:a:${a}`, name: `author ${a}`, '*co': 'urn:li:co:1' });
  }
  included.push({ entityUrn: 'urn:li:co:1', name: 'Shared Co' });
  for (let p = 0; p < 200; p++) {
    included.push({ entityUrn: `urn:li:u:${p}`, text: `post ${p}`, '*actor': `urn:li:a:${p % 20}` });
    refs.push(`urn:li:u:${p}`);
  }
  const t0 = Date.now();
  const out = V.resolveNormalized({ data: { '*elements': refs }, included });
  const ms = Date.now() - t0;
  eq(out.elements.length, 200);
  eq(out.elements[7].actor.co.name, 'Shared Co');
  ok(ms < 1500, `resolution took ${ms}ms — expected well under 1500ms`);
});

check('resolveEntity pulls one entity out by URN', () => {
  const payload = {
    data: {},
    included: [
      { entityUrn: 'urn:li:p:1', firstName: 'Ada', '*co': 'urn:li:co:1' },
      { entityUrn: 'urn:li:co:1', name: 'Acme' }
    ]
  };
  eq(V.resolveEntity(payload, 'urn:li:p:1').co.name, 'Acme');
  eq(V.resolveEntity(payload, 'urn:li:p:404'), null);
});

/* ================================================================== *
 * Escape hatches
 * ================================================================== */
group('byType / collect / findUrns — the shape-change escape hatches');

const typed = {
  data: {},
  included: [
    { entityUrn: 'urn:li:p:1', $type: 'com.linkedin.voyager.dash.identity.profile.Profile', firstName: 'Ada' },
    { entityUrn: 'urn:li:p:2', $type: 'com.linkedin.voyager.dash.identity.profile.Profile', firstName: 'Grace' },
    { entityUrn: 'urn:li:c:1', $type: 'com.linkedin.voyager.dash.organization.Company', name: 'Acme' }
  ]
};

check('byType matches on a trailing type name', () => {
  eq(V.byType(typed, 'Profile').map((e) => e.firstName), ['Ada', 'Grace']);
});

check('byType matches on the fully-qualified name', () => {
  eq(V.byType(typed, 'com.linkedin.voyager.dash.organization.Company').length, 1);
});

check('byType accepts a RegExp', () => {
  eq(V.byType(typed, /identity\.profile\.Profile$/).length, 2);
});

check('firstOfType returns null rather than undefined when nothing matches', () => {
  eq(V.firstOfType(typed, 'Nope'), null);
});

check('collect finds nodes by their own shape, at any depth', () => {
  const tree = {
    a: { b: { progressiveStreams: [{ bitRate: 1 }] } },
    c: [{ d: { progressiveStreams: [{ bitRate: 2 }] } }]
  };
  const hits = V.collect(tree, (n) => Array.isArray(n.progressiveStreams));
  eq(hits.length, 2);
});

check('collect does not loop on a cyclic object graph', () => {
  const a = { name: 'a' };
  const b = { name: 'b', a };
  a.b = b;
  eq(V.collect(a, (n) => typeof n.name === 'string').length, 2);
});

check('findUrns dedupes and preserves walk order', () => {
  const tree = {
    x: 'urn:li:activity:2',
    y: ['urn:li:activity:1', 'urn:li:activity:2'],
    z: { deep: 'urn:li:activity:3', other: 'urn:li:profile:9' }
  };
  eq(V.findUrns(tree, 'urn:li:activity:'), ['urn:li:activity:2', 'urn:li:activity:1', 'urn:li:activity:3']);
});

check('findUrns tolerates a cyclic graph', () => {
  const a = { u: 'urn:li:activity:1' };
  a.self = a;
  eq(V.findUrns(a, 'urn:li:activity:'), ['urn:li:activity:1']);
});

/* ================================================================== *
 * Rest.li encoding
 * ================================================================== */
group('Rest.li 2.0 query encoding');

check('encodes a list with structural parens intact', () => {
  eq(V.restliValue(['a', 'b']), 'List(a,b)');
});

check('encodes a nested record', () => {
  eq(V.restliValue({ start: 0, count: 20 }), '(start:0,count:20)');
});

check('escapes a URN value but leaves list syntax alone', () => {
  eq(V.restliValue(['urn:li:activity:1']), 'List(urn%3Ali%3Aactivity%3A1)');
});

check('escapes parens and commas inside a value so they are not read as syntax', () => {
  eq(V.restliValue('a(b,c)'), 'a%28b%2Cc%29');
});

check('builds a query string and skips empty params', () => {
  eq(
    V.restliQuery({ q: 'memberShareFeed', count: 20, start: 0, decorationId: null, empty: '' }),
    'q=memberShareFeed&count=20&start=0'
  );
});

check('start=0 is kept — it is meaningful, unlike null', () => {
  ok(V.restliQuery({ start: 0 }).includes('start=0'));
});

/* ================================================================== *
 * vectorImage
 * ================================================================== */
group('vectorImageUrl');

check('joins the root with the widest artifact', () => {
  eq(
    V.vectorImageUrl({
      rootUrl: 'https://media.licdn.com/dms/image/ABC/',
      artifacts: [
        { fileIdentifyingUrlPathSegment: '200_200/x.jpg', width: 200 },
        { fileIdentifyingUrlPathSegment: '800_800/x.jpg', width: 800 },
        { fileIdentifyingUrlPathSegment: '400_400/x.jpg', width: 400 }
      ]
    }),
    'https://media.licdn.com/dms/image/ABC/800_800/x.jpg'
  );
});

check('uses an absolute artifact segment as-is', () => {
  eq(
    V.vectorImageUrl({
      rootUrl: 'https://media.licdn.com/dms/image/ABC/',
      artifacts: [{ fileIdentifyingUrlPathSegment: 'https://cdn.example/x.jpg', width: 800 }]
    }),
    'https://cdn.example/x.jpg'
  );
});

check('falls back to a plain url field, then to the root', () => {
  eq(V.vectorImageUrl({ url: 'https://x/y.png' }), 'https://x/y.png');
  eq(V.vectorImageUrl({ rootUrl: 'https://x/y.png', artifacts: [] }), 'https://x/y.png');
});

check('returns null for junk rather than a broken URL', () => {
  eq(V.vectorImageUrl(null), null);
  eq(V.vectorImageUrl({}), null);
  eq(V.vectorImageUrl({ artifacts: [] }), null);
});

/*
 * The string case sat behind `typeof vi !== 'object' -> null`, so it never
 * ran: a field LinkedIn had already flattened to a plain URL — a video's
 * `thumbnail`, an older `displayImage` — resolved to null and the poster or
 * profile picture was dropped from the export with the URL in hand.
 */
check('accepts a field already flattened to a plain URL', () => {
  eq(V.vectorImageUrl('https://media.licdn.com/dms/image/ABC/poster.jpg'),
     'https://media.licdn.com/dms/image/ABC/poster.jpg');
  eq(V.vectorImageUrl('http://media.licdn.com/x.png'), 'http://media.licdn.com/x.png');
});

check('a URN string is not a URL and stays rejected', () => {
  eq(V.vectorImageUrl('urn:li:digitalmediaAsset:ABC123'), null);
  eq(V.vectorImageUrl(''), null);
  eq(V.vectorImageUrl('/dms/image/relative.jpg'), null);
});

/* ================================================================== *
 * Result
 * ================================================================== */
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
