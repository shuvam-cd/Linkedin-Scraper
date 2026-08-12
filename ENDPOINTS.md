# Endpoints

Everything version-specific lives in one object: `CFG`, at the top of
`content.js`. This file is how you fill it in, and how you repair it when
LinkedIn moves something.

**There are no endpoint values committed to this repository.** Not the paths,
not the `queryId` values, not the `decorationId` values. That is deliberate.
LinkedIn rotates all three without notice, a stale value fails in a way that
looks exactly like a rate limit, and a value written down from memory is stale
the day it is written. So Strategy A ships switched off, and the extension runs
on Strategies B and C until you capture the real thing.

`tools/wiring-check.mjs` enforces this — it fails the build if any `CFG` block
ships with `enabled: true` or if a `queryId` / `decorationId` literal appears in
`content.js`.

---

## What Voyager is

LinkedIn's web app talks to an internal API under:

```
https://www.linkedin.com/voyager/api/
```

It is [Rest.li](https://linkedin.github.io/rest.li/). Three things follow from
that, and all three are non-negotiable:

| Header | Value | If you get it wrong |
|---|---|---|
| `csrf-token` | the `JSESSIONID` cookie value, **quotes stripped** | 403 with an empty body |
| `x-restli-protocol-version` | `2.0.0` | 400, or a differently-shaped response |
| `accept` | `application/vnd.linkedin.normalized+json+2.1` | you get a nested graph instead of the normalized envelope |

### The quoted cookie

`JSESSIONID` arrives wrapped in literal double quotes:

```
JSESSIONID="ajax:1234567890123456789"
```

The header must carry `ajax:1234567890123456789` — the quotes have to come off.
Some cookie jars hand it back percent-encoded (`%22ajax%3A…%22`) instead, which
also has to survive. `csrfFromCookie()` in `voyager.js` handles both, and
`tools/resolver-test.mjs` covers both.

This extension sends **only** those three headers. No user agent, no
`x-li-track`, no client fingerprint — nothing a normal same-origin page request
would not already send. `wiring-check.mjs` asserts that too.

---

## The normalized envelope

`normalized+json+2.1` does not return an object graph. It returns a thin `data`
object holding URN *references*, plus a flat `included[]` array holding the
actual entities:

```json
{
  "data": {
    "*elements": ["urn:li:fsd_update:(urn:li:activity:71…,FEED,EMPTY)"],
    "paging": { "start": 0, "count": 20, "total": 143 }
  },
  "included": [
    { "entityUrn": "urn:li:fsd_update:(urn:li:activity:71…,FEED,EMPTY)",
      "$type": "com.linkedin.voyager.feed.render.UpdateV2",
      "*actor": "urn:li:fsd_profile:ACoAAA…",
      "commentary": { "text": "…" } },
    { "entityUrn": "urn:li:fsd_profile:ACoAAA…",
      "$type": "com.linkedin.voyager.dash.identity.profile.Profile",
      "firstName": "Ada" }
  ]
}
```

Two rules re-stitch it:

1. **A key beginning with `*` is a reference** — a URN string, or an array of
   them — to be looked up in `included[]`.
2. **Entities are keyed by `entityUrn`**, or occasionally by `$id`.

`voyager.js` does this. Three details in it matter more than they look:

- **Cycle detection is per-path, not global.** The graph genuinely loops
  (profile → position → company → … → profile). A global visited set would
  break the loops *and* silently blank the second occurrence of any legitimately
  repeated entity — the same company on two positions, the same author on twenty
  posts. Loops close with a `{ $ref: urn }` marker instead.
- **Nothing is dropped silently.** A dangling reference becomes
  `{ $missing: urn }`; a guard-rail stop becomes `{ $truncated: urn }`; an array
  never gets shorter than it arrived. A resolver that quietly loses elements is
  indistinguishable from LinkedIn returning fewer, and telling those two apart
  is the whole job of the pagination logic.
- **Only `*` keys are dereferenced.** Resolving every URN-shaped string would
  recurse into `entityUrn` immediately.

### Test it before you trust it

```
node tools/resolver-test.mjs
```

53 assertions over the format's invariants — star refs, arrays, cycles, `$id`
keying, dangling refs, depth and node budgets, Rest.li list encoding. The
fixtures are written to the *shape* of the format, not copied from a capture, so
they stay valid when LinkedIn's payloads change. If this suite is green and a
real response still comes out wrong, the problem is `CFG`, not the resolver.

---

## Capturing a request

Same six steps for every capability below.

1. Open a normal LinkedIn tab, logged in, on the page that shows the data you
   want.
2. DevTools → **Network**. Filter to **Fetch/XHR**.
3. Type `voyager` in the filter box.
4. Do the thing that loads the data — open the profile, scroll the activity
   feed, expand a comment thread.
5. Find the request whose **response** contains what you want. Sort by size; the
   interesting one is usually among the largest. Check the **Response** tab, not
   the name — LinkedIn's path names are not descriptive.
6. Right-click → **Copy** → **Copy as cURL**, and paste it somewhere you can
   read the URL.

### Reading the URL into `CFG`

A Voyager URL decomposes like this:

```
https://www.linkedin.com/voyager/api/SOME/PATH?q=finderName&someParam=value&count=20&start=0&queryId=…&decorationId=…
└──────────── voyagerBase ──────────┘└── path ─┘└────────────────── params ──────────────────────────────────────┘
```

So:

```js
posts: {
  enabled: true,
  path: '/SOME/PATH',
  params: {
    q: 'finderName',
    someParam: '{profileUrn}',   // substitute the placeholder for the captured value
    count: '{count}',
    start: '{start}',
    queryId: '…',
    decorationId: '…'
  },
  pageSize: 20
}
```

Placeholders substituted into `path` and `params`:

| Placeholder | Value |
|---|---|
| `{publicId}` | the slug from `/in/slug` |
| `{profileUrn}` | the target's full profile URN |
| `{profileId}` | the id portion of that URN |
| `{activityUrn}` | `urn:li:activity:…` for one post |
| `{activityId}` | the numeric part of it |
| `{start}` / `{count}` | offset paging, managed by the loop |
| `{paginationToken}` | set `usePaginationToken: true` if the finder uses one |

**Paste values decoded.** Take `urn:li:fsd_profile:ABC` from the URL bar, not
`urn%3Ali%3Afsd_profile%3AABC`. `restliQuery()` re-encodes correctly, and it
knows to leave Rest.li's structural `List(a,b)` and `(key:value)` syntax alone —
which a plain `encodeURIComponent()` would corrupt.

---

## Per capability

### Profile → `CFG.profile`

- **Look for:** load `linkedin.com/in/<someone>/` with the Network tab open. The
  request whose response holds `firstName`, `lastName`, `headline` and
  `publicIdentifier`. There are usually several profile-ish calls; you want the
  one with the *identity* fields, not the one with the contact card or the
  "people also viewed" rail.
- **Volatile:** the whole path, `decorationId` (this one changes most often),
  and the finder name in `q`. The *field names* — `firstName`, `headline`,
  `publicIdentifier` — are stable across years.
- **Not needed for a working extension.** Strategy B reads the profile out of
  the page LinkedIn already server-rendered. Configure this only if you want the
  richer field set.

### Posts → `CFG.posts`

- **Look for:** open `/in/<someone>/recent-activity/all/` and scroll. The
  request that fires *as you scroll* and returns an `*elements` array of update
  URNs. The first page is server-rendered, so watch for the **second** page —
  the one triggered by scrolling — because that is the one with the paging
  parameters you need.
- **Volatile:** path, `q`, the parameter that carries the profile URN, and the
  paging style. Some finders use `start`/`count`, others hand back an opaque
  `paginationToken`. Set `usePaginationToken: true` for the latter.
- **Check the response for `paging`:** if you see `{"start":…,"count":…,"total":…}`
  it is offset paging. If you see a token in `metadata`, it is token paging.
- **This is the one worth configuring.** Without it you get the server-rendered
  first page only — typically 10–20 posts.

### Comments → `CFG.comments`

- **Look for:** open a single post's permalink and click *Load more comments*.
  The request returning an array of entities with `$type` ending in `.Comment`.
- **Volatile:** path, `q`, and how the post is identified — some versions take
  `urn:li:activity:…`, others take a `urn:li:ugcPost:…` or a socialDetail URN.
  If `{activityUrn}` does not work, capture what the real request sends and add
  a placeholder for it.
- **Capped regardless:** `MAX_COMMENTS_PER_POST` (150) across at most
  `MAX_COMMENT_PAGES` (8) requests, enforced in `utils.js`, not here.
- Leave this unconfigured and the comment pass falls back to whatever the post
  page server-rendered — the first page, roughly ten comments.

### Reactions → `CFG.reactions`

- **Look for:** click the reaction pile under a post. The request returning
  reaction entities grouped by type.
- **Usually unnecessary.** The per-type breakdown normally rides along with the
  post itself in a `reactionTypeCounts` array, which `reactionsFrom()` finds by
  shape wherever it sits. Configure this only if `metadata.txt` keeps reporting
  `by type: not returned for this post`.

---

## How you will know it broke

In the activity log, in rough order of what it means:

| Log line | Meaning | Fix |
|---|---|---|
| `HTTP 403 (endpoint or CSRF header may have changed…)` | logged in, not challenged, endpoint refused | re-capture the request; check the `csrf-token` first |
| `HTTP 404` | the path moved | re-capture `path` |
| `Unexpected non-JSON response` | you were served HTML — usually a login wall | check you are still logged in |
| `Voyager … response held no profile entity` | the request worked, the shape changed | re-capture `decorationId`, or just leave Strategy A off |
| `Voyager feed failed … falling back` | Strategy A is dead, B took over | re-capture when convenient; nothing is lost meanwhile |
| `HTTP 999` | LinkedIn is blocking this session | **not an endpoint problem.** Stop for the day. |

**999 is never an endpoint problem.** It is LinkedIn's non-standard block
response. The scraper pauses and waits for you rather than retrying into it,
because retrying into a 999 is how a soft throttle becomes a restricted account.

## The strategies below A

Strategy A is the one that rots. The other two are why the extension keeps
working while you get around to fixing it.

**Strategy B — embedded JSON.** LinkedIn server-renders the data its app needs
into hidden `<code>` blocks. The extension reads *every* `<code>` element, keeps
whatever parses as JSON, and pools all the `included[]` arrays into one index it
can read by `$type`. It keys off no block id (they are per-response GUIDs) and
no payload path, so an API change does not touch it. Its limit is real: no
pagination, so you get the first page of activity and nothing older.

**Strategy C — DOM harvest.** Scrolls the rendered activity feed. Anchored on
`urn:li:activity:` appearing in an element attribute rather than on any class
name, because the URN has to stay put for LinkedIn's own code to work while
class names change every few weeks. Shallowest of the three — often only a post
URN and its text — but the detail pass fills the rest in from each permalink,
and post dates are recovered from the timestamp encoded in the activity id.

C reaching the feed requires the tab to move to
`/in/<id>/recent-activity/all/`, which tears down the content script. The worker
handles that: it navigates, re-injects, and restarts the run with everything
collected so far handed back, so nothing is re-fetched.
