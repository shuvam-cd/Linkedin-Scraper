/*
 * voyager.js — the Rest.li / normalized-JSON layer.
 *
 * LinkedIn's internal API answers `accept: application/vnd.linkedin.normalized+json+2.1`
 * with a *normalized* envelope rather than a plain object graph:
 *
 *   {
 *     "data": {                                    <- thin: mostly URN references
 *       "*elements": ["urn:li:fsd_update:(x,y)", …],
 *       "paging": { "start": 0, "count": 20, … }
 *     },
 *     "included": [                                <- flat: the actual entities
 *       { "entityUrn": "urn:li:fsd_update:(x,y)", "$type": "…FeedUpdate", "*actor": "urn:li:fsd_profile:ABC", … },
 *       { "entityUrn": "urn:li:fsd_profile:ABC",  "$type": "…Profile", "firstName": "Ada", … }
 *     ]
 *   }
 *
 * Two rules do all the work:
 *   1. A key beginning with `*` holds a URN reference (or an array of them)
 *      that must be looked up in `included[]`.
 *   2. Entities are keyed by `entityUrn` — sometimes by `$id` instead.
 *
 * The graph is genuinely cyclic (a profile links a position, which links a
 * company, whose recruiter links the profile again), so resolution tracks the
 * URNs on the *current path* rather than a global visited set: a legitimately
 * repeated entity still expands, a loop does not.
 *
 * This file is deliberately free of any DOM or chrome.* dependency so it can be
 * loaded and exercised outside the browser — see tools/resolver-test.mjs, which
 * is the only test that can be run without a live LinkedIn session.
 */
(function () {
  'use strict';
  if (globalThis.LISVoyager) return;

  /* ------------------------------------------------------------------ *
   * Limits
   *
   * A resolved profile graph is a few thousand nodes; a 20-item feed page
   * with comments can be tens of thousands. The caps below stop a malformed
   * or unexpectedly dense payload from locking the content script's thread —
   * they are a guard rail, not a tuning knob.
   * ------------------------------------------------------------------ */
  const DEFAULTS = {
    maxDepth: 14,
    maxNodes: 60000
  };

  /* ------------------------------------------------------------------ *
   * URNs
   * ------------------------------------------------------------------ */
  const isUrn = (v) => typeof v === 'string' && v.slice(0, 4) === 'urn:';

  /**
   * The entity type of a URN — `fsd_profile` in `urn:li:fsd_profile:ACoAAA…`.
   * Returns '' for anything that is not a URN.
   */
  function urnType(urn) {
    if (!isUrn(urn)) return '';
    const parts = urn.split(':');
    return parts.length >= 3 ? parts[2] : '';
  }

  /**
   * The id portion of a URN — everything after the third colon, so compound
   * ids survive intact: `urn:li:fsd_update:(urn:li:activity:123,FEED,…)`
   * yields `(urn:li:activity:123,FEED,…)`, not a truncated fragment.
   */
  function urnId(urn) {
    if (!isUrn(urn)) return '';
    const parts = urn.split(':');
    return parts.length >= 4 ? parts.slice(3).join(':') : '';
  }

  /** The numeric activity id inside any URN shape that carries one. */
  function activityId(urn) {
    const m = String(urn == null ? '' : urn).match(/urn:li:activity:(\d+)/);
    return m ? m[1] : null;
  }

  /* ------------------------------------------------------------------ *
   * Session headers
   *
   * Exactly the three headers a normal page request already sends. Nothing
   * here forges a user agent, a tracking header or a client fingerprint.
   * ------------------------------------------------------------------ */

  /**
   * The CSRF token is the JSESSIONID cookie value, which LinkedIn stores
   * wrapped in literal double quotes — `JSESSIONID="ajax:1234567890"`. Some
   * cookie jars hand it back percent-encoded instead. Both forms have to
   * survive down to `ajax:1234567890`, because the API rejects the quotes.
   */
  function csrfFromCookie(cookieHeader) {
    const m = String(cookieHeader == null ? '' : cookieHeader).match(/(?:^|;\s*)JSESSIONID=([^;]*)/);
    if (!m) return '';
    let v = m[1].trim();
    if (v.indexOf('%') >= 0) {
      try {
        v = decodeURIComponent(v);
      } catch (_) {
        /* leave it as-is; the strip below still helps */
      }
    }
    return v.replace(/^"+|"+$/g, '').trim();
  }

  /** Reads one cookie out of a `document.cookie`-style string. */
  function cookieValue(cookieHeader, name) {
    const m = String(cookieHeader == null ? '' : cookieHeader).match(
      new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)')
    );
    if (!m) return '';
    try {
      return decodeURIComponent(m[1]);
    } catch (_) {
      return m[1];
    }
  }

  /**
   * The header set for a Voyager call. `csrf-token` and
   * `x-restli-protocol-version` are mandatory — without either, the API
   * answers 403 with an empty body, which reads exactly like a rate limit.
   */
  function headers(cookieHeader, extra) {
    const h = {
      accept: 'application/vnd.linkedin.normalized+json+2.1',
      'x-restli-protocol-version': '2.0.0'
    };
    const csrf = csrfFromCookie(cookieHeader);
    if (csrf) h['csrf-token'] = csrf;
    return Object.assign(h, extra || {});
  }

  /**
   * What a page script can actually observe of the session.
   *
   * `li_at` is LinkedIn's real session cookie and it is **HttpOnly**, so
   * `document.cookie` does not contain it no matter how logged in the user is.
   * Treating its absence as "not logged in" blocks every run against a
   * perfectly good session. It is reported here because an extension context
   * can occasionally see it, but nothing may *require* it.
   *
   * `JSESSIONID` is not HttpOnly — the app itself reads it to set
   * `csrf-token` — but LinkedIn also issues one to logged-out visitors. It is
   * necessary for a Voyager call and not sufficient to prove a session.
   *
   * This returns signals, not a verdict. The verdict needs the DOM, so it
   * lives in content.js.
   */
  function sessionCookies(cookieHeader) {
    return {
      liAt: !!cookieValue(cookieHeader, 'li_at'),
      liap: !!cookieValue(cookieHeader, 'liap'),
      csrf: csrfFromCookie(cookieHeader)
    };
  }

  /* ------------------------------------------------------------------ *
   * Rest.li query strings
   *
   * Rest.li 2.0 encodes lists as `List(a,b,c)` and nested records as
   * `(key:value)`. The parentheses and commas are structural and must reach
   * the server unescaped, so a plain encodeURIComponent() over the whole
   * value corrupts the request. Values inside are still escaped.
   * ------------------------------------------------------------------ */
  function restliValue(v) {
    if (Array.isArray(v)) return 'List(' + v.map(restliValue).join(',') + ')';
    if (v && typeof v === 'object') {
      return '(' + Object.keys(v).map((k) => `${k}:${restliValue(v[k])}`).join(',') + ')';
    }
    // Escape only what would otherwise be read as Rest.li syntax or a URL break.
    return encodeURIComponent(String(v)).replace(/[()',]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }

  /** `{a: 1, b: ['x','y']}` -> `a=1&b=List(x,y)`, skipping null/undefined. */
  function restliQuery(params) {
    const out = [];
    for (const k of Object.keys(params || {})) {
      const v = params[k];
      if (v === null || v === undefined || v === '') continue;
      out.push(`${k}=${restliValue(v)}`);
    }
    return out.join('&');
  }

  /* ------------------------------------------------------------------ *
   * The index
   * ------------------------------------------------------------------ */

  /**
   * Maps every entity in `included[]` by both of the keys LinkedIn uses.
   * `included` sits at the top level on most endpoints and under `data` on a
   * few, so both are scanned — a payload that puts it in the unexpected place
   * would otherwise resolve to nothing but dangling references.
   */
  function buildIndex(payload) {
    const byUrn = new Map();
    /*
     * The richer projection wins, not the last one seen.
     *
     * A page's payloads are concatenated before indexing, and the same
     * entityUrn routinely appears in several of them under different
     * projections — one full, one a `{entityUrn, $type}` stub. Overwriting
     * unconditionally meant a reader could find the full Position entity, hand
     * it to the resolver, and get the stub back: no title, no company, and the
     * row discarded as empty. The `$id` line beside this one already had the
     * rule right.
     */
    const add = (e) => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return;
      if (typeof e.entityUrn === 'string') {
        const prev = byUrn.get(e.entityUrn);
        if (!prev || Object.keys(e).length > Object.keys(prev).length) byUrn.set(e.entityUrn, e);
      }
      if (typeof e.$id === 'string' && !byUrn.has(e.$id)) byUrn.set(e.$id, e);
    };
    if (payload && typeof payload === 'object') {
      if (Array.isArray(payload.included)) payload.included.forEach(add);
      if (payload.data && Array.isArray(payload.data.included)) payload.data.included.forEach(add);
    }
    return byUrn;
  }

  /* ------------------------------------------------------------------ *
   * The resolver
   * ------------------------------------------------------------------ */

  /**
   * Re-stitches a normalized envelope into a plain object graph.
   *
   * Only `*`-prefixed keys are dereferenced. Resolving every URN-shaped
   * string would be wrong: `entityUrn` points at the entity being expanded,
   * so it would recurse into itself immediately, and plenty of fields carry a
   * URN as data rather than as a link.
   *
   * Markers left in the output, all deliberately visible rather than silently
   * dropped — a resolver that quietly loses elements is indistinguishable from
   * LinkedIn deciding to return fewer, which is the one failure mode this
   * scraper must never misreport:
   *   { $missing: urn }    the reference had no entity in `included[]`
   *   { $ref: urn }        the reference closed a cycle on this path
   *   { $truncated: urn }  a guard rail stopped before this one; the URN is
   *                        still usable for a permalink or a retry
   */
  function resolveNormalized(payload, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const byUrn = o.index || buildIndex(payload);
    const budget = { left: o.maxNodes, truncated: false };
    const root = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
    const value = walk(root, byUrn, new Set(), 0, o, budget);
    return o.withMeta ? { value, truncated: budget.truncated, entities: byUrn.size } : value;
  }

  /** Resolves one entity by URN, with the same cycle and budget rules. */
  function resolveEntity(payload, urn, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const byUrn = o.index || buildIndex(payload);
    const ent = byUrn.get(urn);
    if (!ent) return null;
    const budget = { left: o.maxNodes, truncated: false };
    return walk(ent, byUrn, new Set([urn]), 0, o, budget);
  }

  function walk(node, byUrn, onPath, depth, o, budget) {
    if (node === null || typeof node !== 'object') return node;
    if (budget.left <= 0 || depth > o.maxDepth) {
      budget.truncated = true;
      return node;
    }

    if (Array.isArray(node)) {
      // Length is preserved even once the budget is gone: for a feed page the
      // array length *is* the page size, and shortening it here would look
      // like LinkedIn returning fewer posts. Past the budget, entries are
      // carried through unresolved rather than discarded.
      const out = [];
      for (const v of node) {
        if (budget.left <= 0) {
          budget.truncated = true;
          out.push(v);
          continue;
        }
        budget.left--;
        out.push(walk(v, byUrn, onPath, depth + 1, o, budget));
      }
      return out;
    }

    const out = {};
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (key.charCodeAt(0) === 42 /* '*' */ && key.length > 1) {
        const plain = key.slice(1);
        // A resolved value never overwrites a real one of the same name.
        if (!(plain in node)) out[plain] = deref(val, byUrn, onPath, depth + 1, o, budget);
        out[key] = val; // keep the raw reference; permalinks are built from it
      } else {
        out[key] = walk(val, byUrn, onPath, depth + 1, o, budget);
      }
    }
    return out;
  }

  function deref(ref, byUrn, onPath, depth, o, budget) {
    if (Array.isArray(ref)) return ref.map((r) => deref(r, byUrn, onPath, depth, o, budget));
    if (!isUrn(ref)) return walk(ref, byUrn, onPath, depth, o, budget); // already inlined

    const ent = byUrn.get(ref);
    if (!ent) return { $missing: ref };
    if (onPath.has(ref)) return { $ref: ref };
    if (budget.left <= 0 || depth > o.maxDepth) {
      // Distinct from $ref on purpose: a cycle is expected and structural, a
      // guard-rail stop means the caller is looking at partial data.
      budget.truncated = true;
      return { $truncated: ref };
    }

    onPath.add(ref);
    budget.left--;
    const out = walk(ent, byUrn, onPath, depth + 1, o, budget);
    onPath.delete(ref);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Escape hatches
   *
   * When the shape of `data` changes — which is what actually breaks first —
   * the entities are usually still present in `included[]` under the same
   * `$type`. Reading them directly keeps a capability alive through a
   * response-shape change that would otherwise need a code edit.
   * ------------------------------------------------------------------ */

  /** Every `included[]` entity whose `$type` matches. Accepts a RegExp. */
  function byType(payload, match) {
    const test =
      match instanceof RegExp
        ? (t) => match.test(t)
        : (t) => t === match || t.endsWith('.' + match) || t.endsWith(match) || t.indexOf(match) >= 0;

    const list = [];
    const push = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const e of arr) {
        if (e && typeof e.$type === 'string' && test(e.$type)) list.push(e);
      }
    };
    if (payload && typeof payload === 'object') {
      push(payload.included);
      if (payload.data) push(payload.data.included);
    }
    return list;
  }

  const firstOfType = (payload, match) => byType(payload, match)[0] || null;

  /**
   * Depth-first walk collecting every node the predicate accepts. Used to
   * find things by their own shape — a video's `progressiveStreams`, an
   * image's `artifacts` — rather than by a path that rots.
   */
  function collect(node, pred, opts) {
    const o = Object.assign({ maxNodes: DEFAULTS.maxNodes, limit: Infinity }, opts || {});
    const out = [];
    const seen = new Set();
    let left = o.maxNodes;

    (function visit(n) {
      if (out.length >= o.limit || left <= 0) return;
      if (!n || typeof n !== 'object') return;
      if (seen.has(n)) return; // shared sub-objects are common after resolution
      seen.add(n);
      left--;

      if (!Array.isArray(n)) {
        try {
          if (pred(n)) out.push(n);
        } catch (_) {
          /* a predicate must never take the walk down with it */
        }
      }
      const keys = Array.isArray(n) ? n.keys() : Object.keys(n);
      for (const k of keys) visit(n[k]);
    })(node);

    return out;
  }

  /** Deep-collects URN strings with the given prefix, deduped, in walk order. */
  function findUrns(node, prefix) {
    const out = [];
    const seen = new Set();
    const objs = new Set();
    const want = prefix || 'urn:';

    (function visit(n) {
      if (typeof n === 'string') {
        if (n.slice(0, want.length) === want && !seen.has(n)) {
          seen.add(n);
          out.push(n);
        }
        return;
      }
      if (!n || typeof n !== 'object' || objs.has(n)) return;
      objs.add(n);
      const keys = Array.isArray(n) ? n.keys() : Object.keys(n);
      for (const k of keys) visit(n[k]);
    })(node);

    return out;
  }

  /**
   * Resolves a LinkedIn vectorImage into a concrete URL.
   *
   * Images arrive as a CDN root plus a list of pre-rendered artifacts:
   *   { rootUrl: 'https://media.licdn.com/dms/image/…/',
   *     artifacts: [ { fileIdentifyingUrlPathSegment: '800_800/x.jpg', width: 800 }, … ] }
   *
   * The widest artifact is the closest thing to an original; there is no
   * endpoint that returns the true source file.
   */
  function vectorImageUrl(vi) {
    /*
     * The string case has to be tested first. Behind the object guard it was
     * unreachable, so a field LinkedIn had already flattened to a plain URL —
     * a video's `thumbnail`, an older `displayImage` — returned null and the
     * poster or profile picture was dropped from the export even though the
     * URL was right there. URN strings are not URLs and stay rejected.
     */
    if (typeof vi === 'string') return /^https?:/i.test(vi) ? vi : null;
    if (!vi || typeof vi !== 'object') return null;

    const root = vi.rootUrl || vi.root || '';
    const arts = Array.isArray(vi.artifacts) ? vi.artifacts : [];
    if (root && arts.length) {
      const best = arts
        .slice()
        .sort((a, b) => (b.width || b.height || 0) - (a.width || a.height || 0))[0];
      const seg = best && (best.fileIdentifyingUrlPathSegment || best.filePathSegment);
      if (seg) return /^https?:/i.test(seg) ? seg : root + seg;
    }
    if (typeof vi.url === 'string') return vi.url;
    if (root && !arts.length) return root;
    return null;
  }

  globalThis.LISVoyager = {
    DEFAULTS,
    isUrn,
    urnType,
    urnId,
    activityId,
    csrfFromCookie,
    cookieValue,
    headers,
    sessionCookies,
    restliValue,
    restliQuery,
    buildIndex,
    resolveNormalized,
    resolveEntity,
    byType,
    firstOfType,
    collect,
    findUrns,
    vectorImageUrl
  };
})();
