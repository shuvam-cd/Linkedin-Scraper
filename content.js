/*
 * content.js — runs on https://www.linkedin.com/*
 *
 * Does the actual scraping. Every network call is a same-origin fetch from the
 * page, so it carries the user's normal session cookies; nothing here handles
 * or stores credentials, and no header is sent that the page would not send
 * itself.
 *
 * Results stream back to the service worker over a long-lived port as they are
 * produced, so partial data survives a failure part-way through and the popup
 * can show live progress.
 *
 * Three collection strategies, tried in order and each able to carry the run
 * on its own:
 *
 *   A  Voyager API      richest, and the first thing to break. Off until the
 *                       endpoints in CFG are filled in — see ENDPOINTS.md.
 *   B  Embedded JSON    the normalized payloads LinkedIn server-renders into
 *                       <code> blocks. No endpoint knowledge needed.
 *   C  DOM harvest      reads the rendered page. Slowest and shallowest, and
 *                       the only one that keeps working when the other two rot.
 */
(function () {
  'use strict';

  // The script is in the manifest AND may be re-injected via chrome.scripting.
  if (window.__LIS_CONTENT_LOADED__) return;
  window.__LIS_CONTENT_LOADED__ = true;

  const U = globalThis.LIS;
  const VY = globalThis.LISVoyager;
  const MSG = U.MSG;
  const L = U.LIMITS;
  const ORIGIN = U.ORIGIN;

  /* ================================================================== *
   * CFG — every version-specific value, in one place.
   *
   * LinkedIn rotates Voyager paths, `queryId` values and `decorationId`
   * values without notice, and a stale value fails in a way that looks
   * exactly like a rate limit. So nothing here is guessed: Strategy A stays
   * switched off until you paste in values captured from a live request.
   *
   * ENDPOINTS.md walks through the capture, one capability at a time. The
   * shape below is what it tells you to fill in:
   *
   *   posts: {
   *     enabled: true,
   *     path: '/identity/profileUpdatesV2',
   *     params: {
   *       profileUrn: '{profileUrn}',
   *       q: 'memberShareFeed',
   *       count: '{count}',
   *       start: '{start}',
   *       moduleKey: '…'
   *     }
   *   }
   *
   * Placeholders substituted into `path` and `params`:
   *   {publicId} {profileUrn} {profileId} {activityUrn} {activityId}
   *   {start} {count} {paginationToken}
   *
   * Paste values *decoded* — the Rest.li encoder re-escapes them correctly,
   * and List(...) / (key:value) syntax is preserved rather than mangled.
   * ================================================================== */
  const CFG = {
    // Stable. The version lives in the path segments below it, not here.
    voyagerBase: `${ORIGIN}/voyager/api`,

    profile: { enabled: false, path: '', params: {} },

    posts: {
      enabled: false,
      path: '',
      params: {},
      pageSize: 20,
      // Rest.li offset paging is the norm; a few finders hand back an opaque
      // token instead. Set this when {paginationToken} appears in `params`.
      usePaginationToken: false
    },

    comments: { enabled: false, path: '', params: {}, pageSize: 20 },

    // Reaction breakdown by type. The summary counts usually ride along with
    // the post itself, so this is only needed for a per-type split.
    reactions: { enabled: false, path: '', params: {}, pageSize: 50 },

    /*
     * Re-fetch every post's permalink even when the list response already
     * looked complete. Off by default: on LinkedIn each detail fetch is a
     * separate page load against the session budget.
     */
    alwaysFetchDetail: false,

    /*
     * Strategy B reads whatever the server rendered into the page. Nothing
     * here is version-specific — it scans every <code> block and keeps what
     * parses as JSON — so it needs no maintenance when A breaks.
     */
    embeddedJson: { enabled: true },

    // Strategy C. Selectors are probed in order and the first hit wins.
    dom: { enabled: true, maxScrollRounds: 60, idleRoundsBeforeStop: 4 }
  };

  /* ------------------------------------------------------------------ *
   * Run state
   * ------------------------------------------------------------------ */
  const S = {
    active: false,
    stop: false,
    paused: false,
    cfg: null,
    port: null,
    heartbeat: null,
    seen: new Set(),
    posts: [],
    collected: 0,
    target: 0,
    skippedVideos: 0,
    requests: 0,
    startedAt: 0,
    /*
     * Which pass is running, and how far through it.
     *
     * Harvesting is only the first of three. Once it reaches the target the
     * "Collected x / y" bar is pinned at 100% while the detail pass and then
     * the comment pass run — which on a 100-post run is another quarter of an
     * hour with nothing on screen moving. That reads exactly like a run that
     * has finished and refuses to stop, so the pass and its own progress are
     * reported rather than left to the log.
     */
    stage: 'harvest',
    stageDone: 0,
    stageTotal: 0,
    stageStartedAt: 0,
    profile: null,
    // "Show all" links seen while reading the profile, so the full-history
    // pass costs no extra page fetch to find them.
    detailLinks: null,
    pagination: null // { stoppedEarly, reason, pages }
  };

  const limiter = new U.RateLimiter(L.MIN_REQUEST_GAP_MS);

  /** Thrown to unwind the whole run without being treated as a failure. */
  class Abort extends Error {
    constructor(reason, message) {
      super(message || reason);
      this.reason = reason;
    }
  }

  /* ------------------------------------------------------------------ *
   * Messaging
   * ------------------------------------------------------------------ */
  /*
   * One heartbeat, ever.
   *
   * emit() reconnects whenever the port has dropped, so a naive
   * `S.heartbeat = setInterval(...)` inside connectPort() orphans the previous
   * timer on every reconnect. Each orphan keeps calling emit(), which
   * reconnects, which starts another one — a leak that ends up holding the
   * service worker awake indefinitely.
   */
  function startHeartbeat() {
    stopHeartbeat();
    // Traffic on the port also keeps the service worker from being evicted.
    S.heartbeat = setInterval(() => emit(MSG.C_HEARTBEAT, {}), 15000);
  }

  function stopHeartbeat() {
    if (S.heartbeat) {
      clearInterval(S.heartbeat);
      S.heartbeat = null;
    }
  }

  function connectPort() {
    if (S.port) return S.port;
    S.port = chrome.runtime.connect({ name: U.PORT_NAME });
    S.port.onDisconnect.addListener(() => {
      S.port = null;
      // Service worker went away mid-run; stop rather than scrape into the void.
      if (S.active) {
        S.stop = true;
        abortInFlight();
      }
      else stopHeartbeat(); // nothing left to report — don't reconnect forever
    });
    startHeartbeat();
    return S.port;
  }

  function emit(type, payload) {
    try {
      if (!S.port) connectPort();
      S.port.postMessage(Object.assign({ type }, payload));
    } catch (_) {
      S.port = null;
    }
  }

  const log = (level, message) => emit(MSG.C_LOG, { level, message });

  let lastProgress = 0;
  function emitProgress(force) {
    const now = Date.now();
    if (!force && now - lastProgress < 400) return;
    lastProgress = now;
    emit(MSG.C_PROGRESS, {
      collected: S.collected,
      target: S.target,
      skippedVideos: S.skippedVideos,
      requests: S.requests,
      stage: S.stage,
      stageDone: S.stageDone,
      stageTotal: S.stageTotal,
      stageStartedAt: S.stageStartedAt
    });
  }

  /** Moves to a pass and publishes it immediately. */
  function setStage(stage, total) {
    S.stage = stage;
    S.stageDone = 0;
    S.stageTotal = total || 0;
    S.stageStartedAt = Date.now();
    emitProgress(true);
  }

  /** One unit of the current pass done. */
  function bumpStage(n) {
    S.stageDone += n == null ? 1 : n;
    emitProgress();
  }

  /** Cursor handed back by the worker when a run is being continued. */
  function resumeCursor(kind) {
    const c = S.cfg && S.cfg.startCursor;
    return c && c.kind === kind && c.value != null ? c.value : null;
  }

  function fmtDuration(sec) {
    return U.fmtDuration(sec);
  }

  /** Halt the run and ask the user to intervene in the visible tab. */
  function requireAttention(kind, message) {
    S.paused = true;
    emit(MSG.C_ATTENTION, { kind, message, url: location.href });
  }

  /**
   * A sleep that Stop can cut short.
   *
   * The pacing delays run to nine seconds and the scroll pauses to seven, so a
   * plain sleep meant Stop was not noticed for that long — long enough that
   * the worker's twelve-second settle fired first and the popup said
   * "Stopped" while the tab was visibly still working. Same total wait when
   * nothing interrupts it; the politeness floors are untouched.
   */
  async function pause(ms) {
    const until = Date.now() + ms;
    for (;;) {
      if (S.stop) return;
      const left = until - Date.now();
      if (left <= 0) return;
      await U.sleep(Math.min(400, left));
    }
  }

  async function waitWhilePaused() {
    while (S.paused && !S.stop) await U.sleep(500);
    if (S.stop) throw new Abort('stopped', 'Stopped by user');
  }

  /**
   * Stop, as an unwind rather than a flag the next step might notice.
   *
   * Every long pass breaks out of its own loop when S.stop is set and then
   * returns normally — which, to its caller, is indistinguishable from "this
   * pass finished". run() therefore moved on to the next step, and one of
   * those steps navigates the tab to the activity feed and has the worker
   * start the run again, where S.stop begins life false. A Stop pressed during
   * the profile read was erased that way: the popup settled to "Stopped" while
   * the tab carried on scraping. Stop has to leave the run, not just a loop.
   */
  function throwIfStopped() {
    if (S.stop) throw new Abort('stopped', 'Stopped by user');
  }

  /* ------------------------------------------------------------------ *
   * Request deadlines
   *
   * fetch() has no timeout of its own. A connection that is accepted and then
   * held — a throttled response, a proxy stall, the machine sleeping mid-fetch
   * — parks the run at an await that no flag check can reach: progress freezes,
   * `finally { S.active = false }` never runs, and the tab then refuses every
   * later run with "A scrape is already running in this tab." until the page is
   * reloaded. Every request gets a deadline, and Stop tears down whatever is in
   * flight instead of waiting it out.
   * ------------------------------------------------------------------ */
  const REQUEST_TIMEOUT_MS = 45000;
  const inFlight = new Set();

  function startDeadline(dl) {
    clearDeadline(dl);
    dl.ctl = new AbortController();
    dl.timer = setTimeout(() => {
      try {
        dl.ctl.abort();
      } catch (_) {
        /* already settled */
      }
    }, REQUEST_TIMEOUT_MS);
    inFlight.add(dl.ctl);
    return dl.ctl.signal;
  }

  function clearDeadline(dl) {
    if (dl.timer) clearTimeout(dl.timer);
    if (dl.ctl) inFlight.delete(dl.ctl);
    dl.timer = null;
    dl.ctl = null;
  }

  /** Tear down every in-flight request. Called the moment Stop arrives. */
  function abortInFlight() {
    for (const ctl of inFlight) {
      try {
        ctl.abort();
      } catch (_) {
        /* already settled */
      }
    }
    inFlight.clear();
  }

  /* ------------------------------------------------------------------ *
   * Session / page checks
   *
   * Detecting "is this browser logged in" is harder than it looks, and getting
   * it wrong in the strict direction is worse than getting it wrong in the
   * lenient direction:
   *
   *   - `li_at`, the actual session cookie, is HttpOnly. document.cookie never
   *     contains it. Requiring it reports "not logged in" for every valid
   *     session, which blocks the run before it makes a single request.
   *   - `JSESSIONID` is readable, but LinkedIn issues one to logged-out
   *     visitors too, so its presence proves nothing on its own.
   *   - The rendered page is the reliable signal: logged-out LinkedIn shows a
   *     sign-in form or a Join now / Sign in nav, and logged-in LinkedIn shows
   *     the member chrome.
   *
   * So the gate below refuses only when LinkedIn has actually put us on an
   * auth wall or is showing a sign-in call to action. Anything ambiguous is
   * allowed through: the cost of a false positive is one request that comes
   * back 401 and is handled properly there, while the cost of a false negative
   * is the user staring at a login banner they cannot clear.
   * ------------------------------------------------------------------ */

  /** A security check. Never solved here — the run pauses and hands the tab back. */
  const onChallengePage = (pathname) => /^\/checkpoint\//.test(pathname || location.pathname);

  /** A sign-in / join wall. Different from a challenge: this one needs a login. */
  const onLoginPage = (pathname) => /^\/(uas\/|authwall|login|signup)/.test(pathname || location.pathname);

  const onAuthWall = (pathname) => onChallengePage(pathname) || onLoginPage(pathname);

  function signInCtaPresent() {
    try {
      if (document.querySelector('form.login__form, form[action*="login-submit"], .authwall-join-form, .authwall')) {
        return true;
      }
      // The logged-out public profile chrome offers both of these together.
      const nav = document.querySelector('header, nav');
      const t = nav ? nav.textContent || '' : '';
      return /\bjoin now\b/i.test(t) && /\bsign in\b/i.test(t);
    } catch (_) {
      return false;
    }
  }

  function memberChromePresent() {
    try {
      return !!document.querySelector(
        '#global-nav, .global-nav__me, .global-nav__me-photo, [data-control-name="identity_welcome_message"], ' +
          'img.global-nav__me-photo, [data-test-global-nav]'
      );
    } catch (_) {
      return false;
    }
  }

  /**
   * Returns a verdict *and* the signal that produced it, so a failure says
   * something more useful than "log in first" when the user already has.
   */
  function sessionState() {
    const c = VY.sessionCookies(document.cookie);

    if (onChallengePage()) return { ok: false, why: 'LinkedIn is showing a security check.' };
    if (onLoginPage()) return { ok: false, why: 'LinkedIn redirected this tab to its sign-in page.' };
    if (signInCtaPresent()) {
      return { ok: false, why: 'This page is showing LinkedIn\'s signed-out view (Join now / Sign in).' };
    }

    if (c.liAt) return { ok: true, why: 'li_at cookie visible' };
    if (memberChromePresent()) return { ok: true, why: 'signed-in page chrome' };
    // li_at is HttpOnly, so this is the normal healthy case: a JSESSIONID we
    // can read, and no sign of a logged-out page.
    if (c.csrf) return { ok: true, why: 'JSESSIONID present, no signed-out markers' };

    return { ok: false, why: 'No LinkedIn cookies in this browser at all.' };
  }

  const isLoggedIn = () => sessionState().ok;

  /** The `CHALLENGE` marker LinkedIn returns in a JSON body instead of a page. */
  function looksLikeChallenge(text) {
    if (!text) return false;
    return (
      /"status"\s*:\s*"?CHALLENGE"?/i.test(text) ||
      /"challengeUrl"\s*:/i.test(text) ||
      /checkpoint\/challenge/i.test(text)
    );
  }

  const CHALLENGE_MSG =
    'LinkedIn is asking for a security check. Open the tab, complete it yourself, then press Resume. ' +
    'Nothing here will try to solve it.';

  const LOGIN_MSG = 'Log into LinkedIn in this tab, then press Resume.';

  /* ------------------------------------------------------------------ *
   * Rate-limited fetch
   *
   * One limiter for the whole run, so the 3 s floor holds across strategies
   * and passes rather than per call site. The session counter is checked here
   * too — it is the only place every request funnels through.
   * ------------------------------------------------------------------ */

  /** Countdown that logs progress and can be cut short by Stop. */
  async function coolOff(ms, why) {
    const until = Date.now() + ms;
    let left = ms;
    while (left > 0) {
      throwIfStopped();
      log('warn', `${why} — waiting ${Math.ceil(left / 1000)}s...`);
      // Slept in 400 ms slices (pause), logged every ten seconds. A raw ten
      // second sleep meant a Stop pressed during a three-minute 429 back-off
      // was not seen for up to ten seconds.
      await pause(Math.min(10000, left));
      left = until - Date.now();
    }
    throwIfStopped();
  }

  function spendRequest() {
    S.requests++;
    if (S.requests % 10 === 0) emit(MSG.C_REQUESTS, { requests: S.requests });
    if (S.requests > L.SESSION_MAX_REQUESTS) {
      throw new Abort(
        'session_limit',
        `Session request budget reached (${L.SESSION_MAX_REQUESTS}). Stopping cleanly with everything collected.`
      );
    }
  }

  /**
   * A single GET, rate-limited, with LinkedIn's specific failure modes.
   *
   *   429  standard rate limit  -> cool off 3 min, retry up to MAX_RETRIES
   *   999  LinkedIn's own block -> never retried into; pause and hand back
   *   403  usually a dead CSRF token or a rotated endpoint -> fail fast
   *   redirect to /checkpoint   -> pause and hand back
   */
  async function apiGet(url, opts) {
    // The deadline lives out here so it is torn down on every exit path —
    // a return, a throw, or an Abort unwinding the whole run.
    const dl = { ctl: null, timer: null };
    try {
      return await apiRequest(url, opts, dl);
    } finally {
      clearDeadline(dl);
    }
  }

  async function apiRequest(url, opts, dl) {
    const { retries = L.MAX_RETRIES, expectJson = true, voyager = false } = opts || {};
    let attempt = 0;
    let pauses = 0;

    for (;;) {
      await waitWhilePaused();
      if (S.stop) throw new Abort('stopped', 'Stopped by user');

      if (onAuthWall()) {
        if (++pauses > 6) throw new Error('the tab did not get past LinkedIn\'s auth page');
        if (onChallengePage()) requireAttention('challenge', CHALLENGE_MSG);
        else requireAttention('login', LOGIN_MSG);
        await waitWhilePaused();
        continue;
      }

      await limiter.wait(0, () => S.stop);
      // A Stop that landed in the gap must not issue one more request — the
      // deadline is 45 s and nothing else would have cut it short.
      throwIfStopped();
      spendRequest();

      let res;
      try {
        res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: voyager ? VY.headers(document.cookie) : { accept: 'text/html,application/xhtml+xml' },
          redirect: 'follow',
          signal: startDeadline(dl)
        });
      } catch (err) {
        // Stop aborts in-flight requests, so distinguish that from a timeout
        // and both from a genuine network error before deciding to retry.
        throwIfStopped();
        const why =
          dl.ctl && dl.ctl.signal.aborted
            ? `no response within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`
            : err.message;
        if (attempt >= retries) throw new Error(`Network error: ${why}`);
        attempt++;
        await coolOff(L.BACKOFF_MS * attempt, `Network error (${why})`);
        continue;
      }

      // A follow-through to the checkpoint flow is the clearest challenge
      // signal there is — clearer than anything in the body.
      let landed = '';
      try {
        landed = new URL(res.url).pathname;
      } catch (_) {
        /* opaque URL; fall through to the body checks */
      }
      if (landed && onAuthWall(landed)) {
        if (++pauses > 6) throw new Error('redirected to an auth page repeatedly');
        if (onChallengePage(landed)) requireAttention('challenge', CHALLENGE_MSG);
        else requireAttention('login', LOGIN_MSG);
        await waitWhilePaused();
        continue;
      }

      /*
       * 999 is LinkedIn's own non-standard block response. Retrying into it
       * is what turns a soft throttle into a restriction, so it is never
       * retried automatically — the run pauses and waits for a human.
       */
      if (res.status === 999) {
        if (++pauses > 3) throw new Error('HTTP 999 — LinkedIn is refusing requests');
        requireAttention(
          'rate-limit',
          'LinkedIn returned HTTP 999 — it is refusing automated requests from this session. ' +
            'Leave the tab idle for a while, browse normally for a few minutes, then press Resume. ' +
            'Everything collected so far is kept.'
        );
        await waitWhilePaused();
        continue;
      }

      if (res.status === 429) {
        if (attempt >= retries) throw new Error(`Rate limited (HTTP 429) after ${retries} retries`);
        attempt++;
        await coolOff(L.RATE_LIMIT_PAUSE_MS, 'Rate limited (HTTP 429)');
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        const body = await res.text().catch(() => '');
        // An empty body here is indistinguishable from an aborted read.
        throwIfStopped();
        if (looksLikeChallenge(body)) {
          if (++pauses > 6) throw new Error('challenge response did not clear');
          requireAttention('challenge', CHALLENGE_MSG);
          await waitWhilePaused();
          continue;
        }
        /*
         * 401 means the session was rejected outright. 403 with no readable
         * JSESSIONID means the csrf-token header went out empty, which is the
         * same problem wearing a different number. Either way it is auth, not
         * a rotated endpoint — asking the user to re-check their login is the
         * useful move.
         */
        const sess = sessionState();
        if (res.status === 401 || !sess.ok || !VY.csrfFromCookie(document.cookie)) {
          if (++pauses > 6) throw new Error(`not authenticated (HTTP ${res.status})`);
          requireAttention('login', `${LOGIN_MSG} (HTTP ${res.status} — ${sess.why})`);
          await waitWhilePaused();
          continue;
        }
        // Authenticated and not challenged: the endpoint or the request shape
        // has moved. Retrying cannot fix that — fail fast so the caller falls
        // through to the next strategy.
        throw new Error(`HTTP ${res.status} (endpoint or request shape may have changed — see ENDPOINTS.md)`);
      }

      if (res.status === 404) throw new Error('HTTP 404 (not found, removed, or not visible to you)');

      if (!res.ok) {
        if (res.status < 500) throw new Error(`HTTP ${res.status} (endpoint may have changed)`);
        if (attempt >= retries) throw new Error(`HTTP ${res.status}`);
        attempt++;
        await coolOff(L.BACKOFF_MS * attempt, `HTTP ${res.status}`);
        continue;
      }

      /*
       * The deadline covers the body read too — headers arriving and the body
       * then stalling is the same hang — so it is only released once the whole
       * response is in hand, and an abort here is classified exactly as one on
       * the fetch is. Left bare, it rejected with a raw AbortError that no
       * caller recognised: Stop marked the post being fetched as failed, and a
       * timeout was reported as "The operation was aborted." and never retried.
       */
      let text;
      try {
        text = await res.text();
      } catch (err) {
        throwIfStopped();
        const why =
          dl.ctl && dl.ctl.signal.aborted
            ? `no response within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`
            : err.message;
        if (attempt >= retries) throw new Error(`Network error: ${why}`);
        attempt++;
        await coolOff(L.BACKOFF_MS * attempt, `Network error (${why})`);
        continue;
      }
      clearDeadline(dl);
      if (looksLikeChallenge(text)) {
        if (++pauses > 6) throw new Error('challenge response did not clear');
        requireAttention('challenge', CHALLENGE_MSG);
        await waitWhilePaused();
        continue;
      }
      if (!expectJson) return text;
      try {
        return JSON.parse(text);
      } catch (_) {
        throw new Error('Unexpected non-JSON response (endpoint may have changed)');
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Voyager request wrapper
   * ------------------------------------------------------------------ */
  function fillTemplate(v, vars) {
    if (typeof v === 'string') {
      return v.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
    }
    if (Array.isArray(v)) return v.map((x) => fillTemplate(x, vars));
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = fillTemplate(v[k], vars);
      return out;
    }
    return v;
  }

  /** Assembles a Voyager URL from a CFG block, or null when it isn't configured. */
  function voyagerUrl(spec, vars) {
    if (!spec || !spec.enabled || !spec.path) return null;
    const path = fillTemplate(spec.path, vars);
    const qs = VY.restliQuery(fillTemplate(spec.params || {}, vars));
    return CFG.voyagerBase + (path.charAt(0) === '/' ? path : '/' + path) + (qs ? '?' + qs : '');
  }

  /**
   * A Voyager GET, resolved out of the normalized envelope.
   *
   * Returns `{ raw, data }` — `raw` keeps `included[]` so a caller can fall
   * back to scanning by `$type` when the `data` graph has changed shape,
   * which is what actually breaks first.
   */
  async function voyagerGet(spec, vars, opts) {
    const url = voyagerUrl(spec, vars);
    if (!url) throw new Error('endpoint not configured');
    const raw = await apiGet(url, Object.assign({ voyager: true }, opts));
    const resolved = VY.resolveNormalized(raw, { withMeta: true });
    if (resolved.truncated) {
      log('warn', 'A response was larger than the resolver budget — some nested detail was left unresolved.');
    }
    return { raw, data: resolved.value };
  }

  /* ------------------------------------------------------------------ *
   * Strategy B plumbing — payloads embedded in a server-rendered page
   *
   * LinkedIn ships the data its React app needs inside hidden <code> blocks.
   * Nothing below keys off the block ids (they are per-response GUIDs) or off
   * a payload path: every <code> is tried, whatever parses as JSON is kept,
   * and the `included[]` arrays are merged into one pool to read by type.
   * That makes this the strategy that survives an API change untouched.
   * ------------------------------------------------------------------ */
  function payloadsFromRoot(root) {
    const out = [];
    let nodes;
    try {
      nodes = root.querySelectorAll('code');
    } catch (_) {
      return out;
    }
    for (const el of nodes) {
      const t = (el.textContent || '').trim();
      if (t.length < 2) continue;
      const c = t.charAt(0);
      if (c !== '{' && c !== '[') continue;
      try {
        out.push(JSON.parse(t));
      } catch (_) {
        /* datalet blocks and non-JSON payloads are expected here */
      }
    }
    return out;
  }

  /**
   * Parses fetched HTML without loading a single subresource or running a
   * script — DOMParser builds an inert document, which is the whole reason
   * this is safe to point at arbitrary markup.
   */
  function payloadsFromHtml(html) {
    try {
      return payloadsFromRoot(new DOMParser().parseFromString(html, 'text/html'));
    } catch (_) {
      return [];
    }
  }

  /** One pooled envelope, so byType() can see every entity the page shipped. */
  function mergePayloads(list) {
    const included = [];
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      if (Array.isArray(p.included)) included.push(...p.included);
      if (p.data && Array.isArray(p.data.included)) included.push(...p.data.included);
    }
    return { data: {}, included };
  }

  async function fetchPagePayloads(url) {
    const html = await apiGet(url, { expectJson: false });
    return mergePayloads(payloadsFromHtml(html));
  }

  /*
   * Entities pulled straight out of `included[]` are *flat*: their nested
   * media, actor and social counts are still `*`-prefixed URN references
   * pointing elsewhere in the same pool. Mapping one without resolving it
   * first yields a post with no images, no video and no counts — which looks
   * exactly like a post that genuinely had none. Everything read by type goes
   * through here first.
   */
  function resolveAgainst(pool, entity, index) {
    if (!entity || typeof entity !== 'object') return entity;
    if (typeof entity.entityUrn !== 'string') return entity;
    return VY.resolveEntity(pool, entity.entityUrn, { index: index || VY.buildIndex(pool) }) || entity;
  }

  /** Every entity of a type in a pool, each resolved against that pool. */
  function resolvedOfType(pool, match) {
    const index = VY.buildIndex(pool);
    return VY.byType(pool, match).map((e) => resolveAgainst(pool, e, index));
  }

  /* ------------------------------------------------------------------ *
   * Entity readers
   *
   * LinkedIn wraps almost every string in one of several envelopes and moves
   * between them across model versions, so nothing reads a field directly.
   * ------------------------------------------------------------------ */

  /** Unwraps TextViewModel, AttributedText, localized maps and bare strings. */
  function textOf(v, depth) {
    depth = depth || 0;
    if (v == null || depth > 6) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) return v.map((x) => textOf(x, depth + 1)).filter(Boolean).join(' ');
    if (typeof v !== 'object') return '';

    if (typeof v.text === 'string') return v.text;
    if (typeof v.rawText === 'string') return v.rawText;
    // A comment body arrives as { values: [{ value: "…" }, …] } in one of the
    // two shapes LinkedIn uses; neither branch below reached it, and the
    // fallback then dropped the comment for having no text.
    if (Array.isArray(v.values)) return v.values.map((x) => textOf(x && x.value != null ? x.value : x, depth + 1)).join('');
    if (typeof v.defaultLocalizedName === 'string') return v.defaultLocalizedName;
    if (typeof v.name === 'string') return v.name;
    if (v.text && typeof v.text === 'object') return textOf(v.text, depth + 1);
    if (v.localized && typeof v.localized === 'object') {
      const vals = Object.values(v.localized);
      if (vals.length) return textOf(vals[0], depth + 1);
    }
    if (v.attributedText) return textOf(v.attributedText, depth + 1);
    return '';
  }

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** "Mar 2019" from a Rest.li Date. */
  function monthYear(d) {
    if (!d || typeof d !== 'object') return '';
    const y = d.year ? String(d.year) : '';
    const m = d.month && MONTHS[d.month] ? MONTHS[d.month] : '';
    return [m, y].filter(Boolean).join(' ');
  }

  /** "Mar 2019 – Present" from a Rest.li DateRange. */
  function dateRangeText(r) {
    if (!r || typeof r !== 'object') return '';
    const a = monthYear(r.start);
    const b = monthYear(r.end);
    if (a && b) return `${a} – ${b}`;
    if (a) return `${a} – Present`;
    return b || '';
  }

  /**
   * One date rather than a span.
   *
   * A certificate, an award, a course and a publication all happen *on* a
   * date; they are not held from one to another. Running them through
   * dateRangeText printed "Apr 2023 – Present" for a certificate, which reads
   * as an ongoing engagement and is simply not what the profile said.
   */
  function datePointText(r) {
    if (!r || typeof r !== 'object') return '';
    return monthYear(r.start || r);
  }

  /**
   * The creation time encoded in an activity id.
   *
   * LinkedIn's ids are snowflake-shaped: the high bits are a millisecond
   * epoch. It is the only way to date a post harvested from the DOM, where
   * the page shows nothing but "2w". Range-checked before use, so if the id
   * format ever changes this returns null instead of a nonsense date.
   */
  function timestampFromActivityId(id) {
    if (!id || !/^\d+$/.test(String(id))) return null;
    let ms;
    try {
      ms = Number(BigInt(String(id)) >> 22n);
    } catch (_) {
      return null;
    }
    const floor = Date.UTC(2010, 0, 1);
    const ceil = Date.now() + 86400000;
    return ms > floor && ms < ceil ? ms : null;
  }

  /* ------------------------------------------------------------------ *
   * Media
   *
   * An update carries far more images than the post attached. The author's
   * avatar hangs off `actor`, a reshared post brings its own author's avatar,
   * articles carry a publisher logo, and the social summary carries commenter
   * photos. Walking the whole graph for anything with `artifacts` collected all
   * of them, which meant:
   *
   *   - every post folder opened with the poster's profile picture as
   *     media_01.jpg, ahead of the actual photos;
   *   - a text-only post came back with one image, so classifyPost() filed it
   *     as an image post — wrong `type` in posts.csv, and a junk file on disk;
   *   - media_count was inflated on every single row;
   *   - the packager re-downloaded the same avatar once per post.
   *
   * So media is collected from the *content* subtrees only. The skip list is
   * keyed on the containers LinkedIn hangs identity and chrome off, which move
   * far less often than the model class names do. `resharedUpdate` is
   * deliberately absent: a repost's media is the original's media, and only its
   * `actor` needs skipping — which the walk does at any depth.
   * ------------------------------------------------------------------ */
  const CHROME_KEYS = new Set([
    // who posted / who reacted — never post content
    'actor', 'author', 'commenter', 'miniProfile', 'miniCompany',
    'profilePicture', 'nonEntityProfilePicture', 'profilePictureDisplayImage',
    'companyLogo', 'entityLogo', 'logo',
    // engagement furniture
    'socialDetail', 'socialProof', 'socialProofText', 'socialActivityCounts',
    'comments', 'comment', 'likes', 'reactions',
    // page chrome and telemetry
    'header', 'footer', 'updateMetadata', 'trackingData',
    'contextualHeader', 'contextualDescription',
    'navigationBar', 'controlMenu', 'overflowActions'
  ]);

  /** Video posters are recorded by videosFrom(); they are not separate images. */
  const IMAGE_SKIP_KEYS = new Set([...CHROME_KEYS, 'thumbnail', 'posterImage']);

  /**
   * VY.collect, but it refuses to descend into the containers above.
   *
   * A `*`-prefixed key names the same thing as its resolved twin, so both
   * forms are tested against the skip list.
   */
  function collectContent(node, pred, opts) {
    const o = Object.assign({ limit: Infinity, maxNodes: 60000, skip: CHROME_KEYS }, opts || {});
    const out = [];
    const seen = new Set();
    let left = o.maxNodes;

    (function visit(n) {
      if (out.length >= o.limit || left <= 0) return;
      if (!n || typeof n !== 'object') return;
      if (seen.has(n)) return;
      seen.add(n);
      left--;

      if (Array.isArray(n)) {
        for (const v of n) visit(v);
        return;
      }
      try {
        if (pred(n)) out.push(n);
      } catch (_) {
        /* a predicate must never take the walk down with it */
      }
      for (const k of Object.keys(n)) {
        if (o.skip.has(k.charCodeAt(0) === 42 /* '*' */ ? k.slice(1) : k)) continue;
        visit(n[k]);
      }
    })(node);

    return out;
  }

  /** Every image URL reachable from a node's content, widest artifact per image. */
  function imagesFrom(node) {
    const out = [];
    const seen = new Set();
    const push = (u, alt) => {
      if (u && /^https?:/i.test(u) && !seen.has(u)) {
        seen.add(u);
        out.push({ type: 'image', url: u, alt: alt || '' });
      }
    };
    /*
     * The alt text lives on the image's parent — the ImageViewModel that
     * wraps the vectorImage — as accessibilityText. Read the wrapper first
     * so the caption travels with the picture; a bare vectorImage with no
     * wrapper still gets its URL.
     */
    const isWrapper = (n) =>
      n.accessibilityText != null ||
      (Array.isArray(n.attributes) && n.attributes.some((a) => a && a.detailData && (a.detailData.vectorImage || a.detailData.imageUrl)));
    const isVectorImage = (n) => Array.isArray(n.artifacts) && (n.rootUrl || n.root);
    for (const w of collectContent(node, isWrapper, { skip: IMAGE_SKIP_KEYS })) {
      const alt = textOf(w.accessibilityText) || textOf(w.altText) || '';
      for (const vi of collectContent(w, isVectorImage, { skip: IMAGE_SKIP_KEYS })) push(VY.vectorImageUrl(vi), alt);
    }
    for (const vi of collectContent(node, isVectorImage, { skip: IMAGE_SKIP_KEYS })) push(VY.vectorImageUrl(vi), '');
    return out;
  }

  /**
   * Video, honestly.
   *
   * LinkedIn serves adaptive DASH/HLS behind expiring signed URLs. Where a
   * progressive variant exists it is a plain file and can be downloaded;
   * where only a manifest exists, the manifest URL is recorded and the
   * archive gets a note saying why there is no file. There is deliberately no
   * stream muxer here — it would be a large dependency that ages badly.
   */
  function videosFrom(node) {
    const out = [];
    const metas = collectContent(
      node,
      (n) => Array.isArray(n.progressiveStreams) || Array.isArray(n.adaptiveStreams)
    );

    for (const m of metas) {
      const prog = Array.isArray(m.progressiveStreams) ? m.progressiveStreams : [];
      let best = null;
      for (const s of prog) {
        const url =
          (Array.isArray(s.streamingLocations) && s.streamingLocations[0] && s.streamingLocations[0].url) ||
          s.url ||
          null;
        if (!url || !/^https?:/i.test(url)) continue;
        const score = s.bitRate || s.width || 0;
        if (!best || score > best.score) {
          best = { url, score, width: s.width || null, height: s.height || null, size: s.size || null, mime: s.mediaType || null };
        }
      }

      let manifest = null;
      let protocol = null;
      for (const s of Array.isArray(m.adaptiveStreams) ? m.adaptiveStreams : []) {
        const url =
          (Array.isArray(s.masterPlaylists) && s.masterPlaylists[0] && s.masterPlaylists[0].url) || s.url || null;
        if (url && /^https?:/i.test(url)) {
          manifest = url;
          protocol = s.protocol || s.mediaType || null;
          break;
        }
      }

      if (!best && !manifest) continue;
      out.push({
        type: 'video',
        url: best ? best.url : null,
        manifestUrl: manifest,
        protocol,
        width: best ? best.width : null,
        height: best ? best.height : null,
        bytes: best ? best.size : null,
        mime: best ? best.mime : null,
        durationMs: num(m.duration) || num(m.durationMs),
        thumbnail: VY.vectorImageUrl(m.thumbnail) || null,
        downloadable: !!best
      });
    }
    return out;
  }

  /**
   * Whether the update *claims* to carry media, whatever we managed to read.
   *
   * A feed-list response routinely declares the component and ships an empty
   * payload — the image or the stream only materialises on the permalink page.
   * Such a post used to look finished from every angle: it had body text, it
   * had its counts, mapUpdate stamped `detailFetched: true`, and classifyPost
   * called it `text` precisely *because* no media was found. So needsDetail()
   * said no, the detail pass skipped it, and its photos were never fetched at
   * all. That is the "media missing on some posts" case.
   */
  function declaresMedia(node) {
    return (
      collectContent(
        node,
        (n) =>
          !!n.imageComponent ||
          !!n.linkedInVideoComponent ||
          !!n.videoComponent ||
          !!n.externalVideoComponent ||
          !!n.videoPlayMetadata ||
          !!n.documentComponent ||
          !!n.carouselComponent ||
          !!n.celebrationComponent ||
          Array.isArray(n.images) ||
          Array.isArray(n.progressiveStreams) ||
          Array.isArray(n.adaptiveStreams),
        { limit: 1 }
      ).length > 0
    );
  }

  /** Avatars, logos and placeholders, by CDN path. Shared by both DOM readers. */
  const NON_CONTENT_IMAGE =
    /profile-displayphoto|profile-framedphoto|profile-displaybackgroundimage|company-logo|ghost-person|ghost-company/;

  /* ------------------------------------------------------------------ *
   * Profile media, by CDN path
   *
   * The same path segments the line above uses to *reject* an image are what
   * identify the profile's own picture and cover, so both readers key on them
   * rather than on markup.
   *
   * That is the fix for a photo that went missing. The DOM reader looked for
   * `img.pv-top-card-profile-picture__image`, and LinkedIn ships that image as
   * `pv-top-card-profile-picture__image--show`. A class selector matches whole
   * tokens, so the two do not match, and the read fell through to og:image —
   * which on a signed-in profile page is frequently LinkedIn's own artwork
   * rather than the member's face. Class names churn; `/profile-displayphoto/`
   * has been in the CDN path for as long as the CDN has existed.
   * ------------------------------------------------------------------ */
  const PROFILE_PHOTO_PATH = /\/profile-(?:displayphoto|framedphoto)/i;
  const PROFILE_BANNER_PATH = /\/profile-displaybackgroundimage/i;

  /** First URL on the wanted CDN path. Pure, so the rule itself is testable. */
  function pickImageByPath(urls, re) {
    for (const u of urls || []) {
      if (typeof u === 'string' && /^https?:/i.test(u) && re.test(u)) return u;
    }
    return null;
  }

  /**
   * Every image URL an element subtree references, in document order.
   *
   * `data-delayed-url` matters here for the same reason it does in the feed:
   * LinkedIn parks the real URL there until the image scrolls into view, and
   * a cover photo below the fold has no `src` yet.
   */
  function imageUrlsIn(root) {
    const out = [];
    try {
      for (const img of root.querySelectorAll('img')) {
        const u =
          img.currentSrc ||
          img.getAttribute('src') ||
          img.getAttribute('data-delayed-url') ||
          img.getAttribute('data-li-src') ||
          '';
        if (u) out.push(u);
      }
    } catch (_) {
      /* a selector the parser dislikes must not lose what was already read */
    }
    return out;
  }

  /**
   * Every image URL reachable from an entity — chrome included, unlike
   * imagesFrom(), because on a profile the avatar *is* the content.
   */
  function allImageUrls(node) {
    const out = [];
    for (const vi of VY.collect(node, (n) => Array.isArray(n.artifacts) && (n.rootUrl || n.root))) {
      const u = VY.vectorImageUrl(vi);
      if (u) out.push(u);
    }
    for (const n of VY.collect(node, (x) => typeof x.rootUrl === 'string' || typeof x.url === 'string')) {
      const u = typeof n.url === 'string' ? n.url : n.rootUrl;
      if (typeof u === 'string') out.push(u);
    }
    return out;
  }

  /**
   * "18,432 followers", "1.2K followers", "500+ connections".
   *
   * Read out of the rendered text rather than off a class name. The follower
   * count used to come from `main span:has(+ span)` — the first span in the
   * page with a sibling span, which on a modern profile is not the follower
   * count and on many profiles is not a number at all.
   */
  function countFromText(text, word) {
    const m = String(text == null ? '' : text)
      .replace(/,/g, '')
      .match(new RegExp('([\\d.]+\\s*[KMB]?)\\s*\\+?\\s*' + word, 'i'));
    return m ? parseCompact(m[1]) : null;
  }

  /**
   * Media read straight out of a fetched permalink page's markup.
   *
   * The detail pass reads the embedded JSON payloads, and when LinkedIn does
   * not server-render those for a given post there is nothing to map — the
   * fetch "succeeded" and produced no media. The rendered markup is still
   * right there in the same response, so read it rather than giving up.
   */
  function mediaFromHtml(html) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(html, 'text/html');
    } catch (_) {
      return [];
    }
    const out = [];
    const seen = new Set();
    const push = (m) => {
      const key = m.url || m.manifestUrl;
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(m);
    };

    try {
      // og:image is the post's own image, server-rendered and stable for years.
      for (const el of doc.querySelectorAll('meta[property="og:image"], meta[name="og:image"]')) {
        const u = el.getAttribute('content') || '';
        if (/^https?:/i.test(u) && !NON_CONTENT_IMAGE.test(u)) push({ type: 'image', url: u });
      }
      for (const img of doc.querySelectorAll('img')) {
        const u = img.getAttribute('src') || img.getAttribute('data-delayed-url') || img.getAttribute('data-li-src') || '';
        if (!/licdn\.com\/dms\/image/.test(u) || NON_CONTENT_IMAGE.test(u)) continue;
        push({ type: 'image', url: u });
      }
      for (const el of doc.querySelectorAll('[data-sources]')) {
        try {
          for (const s of JSON.parse(el.getAttribute('data-sources') || '[]')) {
            if (!s || !s.src || !/^https?:/i.test(s.src)) continue;
            const adaptive = /\.m3u8|\.mpd/.test(s.src);
            push({
              type: 'video',
              url: adaptive ? null : s.src,
              manifestUrl: adaptive ? s.src : null,
              protocol: s.type || null,
              downloadable: !adaptive
            });
          }
        } catch (_) {
          /* attribute shape changed; the other readers still ran */
        }
      }
      for (const v of doc.querySelectorAll('video[src], video source[src]')) {
        const u = v.getAttribute('src') || '';
        if (/^https?:/i.test(u)) push({ type: 'video', url: u, downloadable: true });
      }
    } catch (_) {
      /* a selector the parser dislikes must not lose what was already read */
    }
    return out;
  }

  /** Carousel / PDF posts. `transcribedDocumentUrl` is the flattened PDF. */
  function documentsFrom(node) {
    const out = [];
    const docs = collectContent(
      node,
      (n) =>
        typeof n.transcribedDocumentUrl === 'string' ||
        (typeof n.manifestUrl === 'string' && (n.totalPageCount != null || n.title != null))
    );
    for (const d of docs) {
      const url = typeof d.transcribedDocumentUrl === 'string' ? d.transcribedDocumentUrl : null;
      out.push({
        type: 'document',
        url: url && /^https?:/i.test(url) ? url : null,
        manifestUrl: typeof d.manifestUrl === 'string' ? d.manifestUrl : null,
        title: textOf(d.title) || '',
        pages: num(d.totalPageCount),
        downloadable: !!(url && /^https?:/i.test(url))
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The kinds that carry more than media
   *
   * classifyPost() below already recognises articles, polls and reposts — it
   * has to, to file them — but nothing ever read what makes them what they
   * are. So an article post exported with no link to the article, a poll with
   * no question and no result, and a repost with no trace of whose post it
   * was: three of the seven post types reached the archive as an empty shell
   * with a type label on it.
   * ------------------------------------------------------------------ */

  /**
   * A link-out card: a navigation target plus a headline. `navigationContext`
   * on its own is far too common to key off, so the subtitle-or-image test is
   * part of the identity — and classifyPost shares this predicate, so the type
   * and the record can never disagree about what an article is.
   */
  const isArticleCard = (n) =>
    !!n.articleComponent ||
    !!(
      n.navigationContext &&
      n.navigationContext.actionTarget &&
      n.title != null &&
      (n.subtitle != null || n.largeImage != null)
    );

  function articleFrom(node) {
    const found = collectContent(node, isArticleCard, { limit: 1 })[0];
    if (!found) return null;
    const c = found.articleComponent || found;
    const nav = c.navigationContext || found.navigationContext || {};
    const url = typeof nav.actionTarget === 'string' && /^https?:/i.test(nav.actionTarget) ? nav.actionTarget : null;
    const title = textOf(c.title) || textOf(found.title);
    if (!url && !title) return null;

    let domain = '';
    if (url) {
      try {
        domain = new URL(url).hostname.replace(/^www\./, '');
      } catch (_) {
        /* a malformed target still leaves the title worth keeping */
      }
    }
    return {
      title,
      subtitle: textOf(c.subtitle) || textOf(found.subtitle) || '',
      url,
      domain,
      thumbnail: VY.vectorImageUrl(c.largeImage || c.smallImage || found.largeImage) || null
    };
  }

  /** Question, options and the vote split. The result *is* the post. */
  function pollFrom(node) {
    const found = collectContent(
      node,
      (n) => Array.isArray(n.pollOptions) || !!n.pollComponent || !!n.pollSummary,
      { limit: 1 }
    )[0];
    if (!found) return null;

    const c = found.pollComponent || found;
    const summary = c.pollSummary || found.pollSummary || {};
    const raw = Array.isArray(c.pollOptions) ? c.pollOptions : Array.isArray(found.pollOptions) ? found.pollOptions : [];
    const options = raw
      .map((o) => ({
        text: textOf(o.option) || textOf(o.optionText) || textOf(o.text) || '',
        votes: num(o.voteCount) ?? num(o.numVotes) ?? null
      }))
      .filter((o) => o.text);

    const counted = options.reduce((a, b) => a + (b.votes || 0), 0);
    const total = num(summary.totalVotes) ?? num(summary.voteCount) ?? (counted || null);
    if (!options.length && total == null) return null;

    return {
      question: textOf(c.question) || textOf(found.question) || '',
      options,
      totalVotes: total,
      // `null` where LinkedIn did not say, which is not the same as "open".
      closed: summary.pollClosed === true || c.pollClosed === true ? true : null
    };
  }

  /**
   * Who wrote the post this one reshares.
   *
   * A repost's media and body already come through, because `resharedUpdate`
   * is deliberately absent from CHROME_KEYS — the original's photos are the
   * repost's photos. What was missing is provenance: without it a repost row
   * in posts.csv is indistinguishable from something the profile wrote.
   */
  function repostFrom(node) {
    let reshared = linked(node, 'resharedUpdate');
    if (!reshared) {
      const holder = collectContent(node, (n) => n.resharedUpdate != null || n['*resharedUpdate'] != null, { limit: 1 })[0];
      if (holder) reshared = linked(holder, 'resharedUpdate');
    }
    if (!reshared) return null;

    // Unresolved it is just the URN, which is still enough for a permalink.
    if (typeof reshared === 'string') {
      const id = VY.activityId(reshared);
      return id ? { author: '', authorHeadline: '', authorUrl: null, activityId: id, postUrl: U.postUrlFromActivityId(id), text: '' } : null;
    }
    if (typeof reshared !== 'object') return null;

    const actor = reshared.actor || reshared.author || {};
    const author =
      textOf(actor.name) ||
      textOf(actor.title) ||
      [textOf(actor.firstName), textOf(actor.lastName)].filter(Boolean).join(' ');
    const publicId = actor.publicIdentifier || (actor.miniProfile && actor.miniProfile.publicIdentifier) || '';
    const navTarget = actor.navigationContext && actor.navigationContext.actionTarget;

    const own = VY.activityId(reshared.entityUrn || reshared['*entityUrn'] || '');
    const scanned = VY.findUrns(reshared, 'urn:li:activity:');
    const id = own || (scanned.length ? VY.activityId(scanned[0]) : null);

    return {
      author,
      authorHeadline: textOf(actor.description) || textOf(actor.headline) || '',
      authorUrl: publicId ? U.profileUrl(publicId) : typeof navTarget === 'string' ? navTarget : null,
      activityId: id,
      postUrl: id ? U.postUrlFromActivityId(id) : null,
      // The original's body, read with the chrome skipped as everywhere else.
      text: postTextFrom(reshared)
    };
  }

  /*
   * Hashtags are how a LinkedIn post is found, so they are worth a column of
   * their own rather than being left buried in the body text. Unicode-aware:
   * #ContentStrategy and #содержание are both tags.
   */
  const HASHTAG = /(?:^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_]{2,60})/gu;

  function hashtagsFrom(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text == null ? '' : text).matchAll(HASHTAG)) {
      const key = m[1].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m[1]);
    }
    return out;
  }

  /**
   * Post kind, decided from the shapes present rather than from a $type
   * whitelist — LinkedIn renames model classes far more often than it changes
   * what a video or a document looks like.
   */
  function classifyPost(node, media) {
    // Scoped like the media readers: an actor's own title/subtitle pair used to
    // be enough to make a plain text post look like an article card.
    const has = (pred) => collectContent(node, pred, { limit: 1 }).length > 0;

    if (has((n) => n.resharedUpdate || n['*resharedUpdate'] || n.reshareContext)) return 'repost';
    if (media.some((m) => m.type === 'document')) return 'document';
    if (media.some((m) => m.type === 'video')) return 'video';
    if (has((n) => Array.isArray(n.pollOptions) || n.pollSummary || n.pollComponent)) return 'poll';
    // An article card is a link-out: a navigation target plus a headline.
    // `navigationContext` alone is far too common to key off. Shared with
    // articleFrom() so the type and the record cannot disagree.
    if (has(isArticleCard)) return 'article';
    if (media.some((m) => m.type === 'image')) return 'image';
    return 'text';
  }

  /**
   * Reaction counts by type.
   *
   * The per-type split rides along with the post on some responses and not
   * others. Unknown reaction names are carried through rather than dropped,
   * so a new one shows up in the export instead of vanishing.
   */
  /** Containers whose counts belong to another post or to a comment. */
  const OTHER_COUNT_KEYS = new Set(['resharedUpdate', 'comments', 'comment', 'commentsPreview', 'replies']);

  function reactionsFrom(node) {
    const byType = {};
    let total = null;

    /*
     * The breakdown comes from ONE socialDetail — the first in walk order
     * that is the post's own. Summing every nested one added the reshared
     * original's reactions and each comment's to the post's, so a repost's
     * per-type split came out far past its own total.
     */
    const own = collectContent(node, (n) => Array.isArray(n.reactionTypeCounts), { skip: OTHER_COUNT_KEYS, limit: 1 })[0];
    if (own) {
      for (const r of own.reactionTypeCounts) {
        const kind = String(r.reactionType || r.type || '').toUpperCase();
        const c = num(r.count);
        if (kind && c != null) byType[kind] = (byType[kind] || 0) + c;
      }
      total = num(own.numLikes) ?? num(own.numReactions) ?? null;
    }

    if (total == null) {
      for (const s of collectContent(node, (n) => n.numLikes != null || n.numReactions != null, { skip: OTHER_COUNT_KEYS })) {
        total = num(s.numLikes) ?? num(s.numReactions);
        if (total != null) break;
      }
    }
    const summed = Object.values(byType).reduce((a, b) => a + b, 0);
    if (total == null && summed) total = summed;
    return { total, byType };
  }

  function socialCountsFrom(node) {
    const r = reactionsFrom(node);
    let comments = null;
    let reposts = null;
    for (const s of VY.collect(node, (n) => n.numComments != null || n.numShares != null)) {
      if (comments == null) comments = num(s.numComments);
      if (reposts == null) reposts = num(s.numShares);
      if (comments != null && reposts != null) break;
    }
    return { reactions: r.total, reactionsByType: r.byType, comments, reposts };
  }

  /* ------------------------------------------------------------------ *
   * Mapping — profile
   * ------------------------------------------------------------------ */
  /** Reads a field that may be inline or still a `*`-prefixed reference. */
  const linked = (n, key) => (n[key] !== undefined ? n[key] : n['*' + key]);

  /** LinkedIn's pronoun enum, as the words it stands for. */
  function pronounText(v) {
    const s = String(textOf(v) || '').toUpperCase();
    if (!s) return '';
    const map = { HE_HIM: 'he/him', SHE_HER: 'she/her', THEY_THEM: 'they/them' };
    return map[s] || s.toLowerCase().replace(/_/g, '/');
  }

  function mapProfileEntity(rawProfile, pool) {
    if (!rawProfile) return null;
    const index = VY.buildIndex(pool || {});
    // The profile entity itself has to be resolved before its picture, banner
    // and geo can be read — they are all references in the flat form.
    const p = resolveAgainst(pool || {}, rawProfile, index);

    const first = textOf(p.firstName);
    const last = textOf(p.lastName);
    const fullName = [first, last].filter(Boolean).join(' ') || textOf(p.name) || textOf(p.title);

    const geo =
      textOf(p.geoLocationName) ||
      textOf(p.locationName) ||
      textOf(p.geoLocation && (p.geoLocation.geo || p.geoLocation)) ||
      textOf(p.location);

    let photo = null;
    let banner = null;
    const pic = p.profilePicture || p.picture;
    if (pic) {
      photo =
        VY.vectorImageUrl(pic.displayImageReference && pic.displayImageReference.vectorImage) ||
        VY.vectorImageUrl(pic.displayImage) ||
        VY.vectorImageUrl(pic.vectorImage) ||
        (imagesFrom(pic)[0] || {}).url ||
        null;
    }
    const bg = p.backgroundImage || p.backgroundPicture || p.backgroundCoverImage;
    if (bg) {
      banner =
        VY.vectorImageUrl(bg.displayImageReference && bg.displayImageReference.vectorImage) ||
        VY.vectorImageUrl(bg.vectorImage) ||
        (imagesFrom(bg)[0] || {}).url ||
        null;
    }

    /*
     * Last resort: the entity carries the image somewhere the named fields
     * above do not reach. LinkedIn moves these between `profilePicture`,
     * `picture`, `profilePictureOriginalImage` and the dash resolution-result
     * wrappers, and each move silently blanks the photo. Scanning the entity's
     * own subtree for the avatar CDN path survives all of them, and it is
     * scoped to this profile so it cannot pick up somebody else's face.
     */
    if (!photo || !banner) {
      const urls = allImageUrls(p);
      if (!photo) photo = pickImageByPath(urls, PROFILE_PHOTO_PATH);
      if (!banner) banner = pickImageByPath(urls, PROFILE_BANNER_PATH);
    }

    return Object.assign(readProfileSections(pool || p, index), {
      publicId: p.publicIdentifier || '',
      profileUrn: p.entityUrn || null,
      fullName,
      firstName: first,
      lastName: last,
      headline: textOf(p.headline),
      location: geo,
      industry:
        textOf(p.industryName) ||
        textOf(p.industry) ||
        textOf(linked(p, 'industryV2Taxonomy')) ||
        textOf(linked(p, 'industryV2')) ||
        '',
      about: textOf(p.summary) || textOf(p.about),
      /*
       * Fields the entity carries that were being dropped on the floor:
       * the pronoun (an enum or a custom string), the birthday, the address,
       * the maiden name, and the two states a profile can be in that change
       * how everything else should be read.
       */
      pronouns: textOf(p.customPronoun) || pronounText(p.pronoun),
      birthday: p.birthDateOn ? (p.birthDateOn.month && MONTHS[p.birthDateOn.month] ? `${MONTHS[p.birthDateOn.month]} ${p.birthDateOn.day || ''}`.trim() : textOf(p.birthDateOn)) : '',
      address: textOf(p.address),
      maidenName: textOf(p.maidenName),
      memorialized: !!p.memorialized,
      tempStatus: textOf(p.tempStatus),
      creator: !!(p.creator || p.influencer),
      followers: num(p.followerCount) ?? num(p.followersCount),
      connections: num(p.connectionsCount) ?? num(p.connections),
      photoUrl: photo,
      bannerUrl: banner,
      experience: readExperience(pool || p, index),
      education: readEducation(pool || p, index),
      skills: readSkills(pool || p),
      currentPosition: null, // filled in below
      profileUrl: p.publicIdentifier ? U.profileUrl(p.publicIdentifier) : null,
      scrapedAt: new Date().toISOString()
    });
  }

  /*
   * Position and Education entities are matched on the fields they carry
   * rather than on `$type`: LinkedIn runs two profile models side by side
   * (`…voyager.identity.profile.Position` and `…voyager.dash.identity.profile.Position`)
   * and moves profiles between them, but a role has always been a title plus
   * a company and a school has always been a name.
   */
  function readExperience(pool, index) {
    const rows = [];
    const seen = new Set();
    /*
     * Widened deliberately. A role LinkedIn ships without a resolvable company
     * — self-employed, a company that has since been deleted, a freelance
     * entry — used to be dropped entirely, because the predicate demanded a
     * company alongside the title. A title plus a date range is a job.
     */
    const isPosition = (x) =>
      x.title != null &&
      (x.companyName != null ||
        x.company != null ||
        x['*company'] != null ||
        x.companyUrn != null ||
        x.dateRange != null ||
        x.timePeriod != null);

    for (const raw of VY.collect(pool, isPosition)) {
      const n = resolveAgainst(pool, raw, index);
      const title = textOf(n.title);
      const company = textOf(n.companyName) || textOf(linked(n, 'company'));
      if (!title && !company) continue;

      const key = `${title}|${company}|${JSON.stringify(n.dateRange || n.timePeriod || '')}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const companyRef = n.companyUrn || rawUrnOf(raw, 'company');
      rows.push({
        title,
        company,
        companyUrl: companyRef ? `${ORIGIN}/company/${VY.urnId(companyRef)}/` : null,
        location: textOf(n.locationName) || textOf(n.geoLocationName) || '',
        dates: dateRangeText(n.dateRange || n.timePeriod),
        current: !!((n.dateRange && !n.dateRange.end) || (n.timePeriod && !n.timePeriod.endDate)),
        description: textOf(n.description)
      });
    }
    return rows;
  }

  /** The raw URN behind a `*`-prefixed key, when there is one. */
  function rawUrnOf(node, key) {
    const v = node['*' + key];
    return typeof v === 'string' && VY.isUrn(v) ? v : null;
  }

  function readEducation(pool, index) {
    const rows = [];
    const seen = new Set();
    /*
     * Widened to match the mapper below, which already resolves a linked
     * school. A school picked from the typeahead with no degree recorded ships
     * as `{entityUrn, '*school': …, dateRange}` and matched neither clause, so
     * it was dropped before the mapper ever saw it — the same failure
     * isPosition was widened for, left in place here.
     */
    const isEducation = (x) =>
      x.schoolName != null ||
      x.school != null ||
      x['*school'] != null ||
      (x.degreeName != null && (x.dateRange != null || x.timePeriod != null));

    for (const raw of VY.collect(pool, isEducation)) {
      const n = resolveAgainst(pool, raw, index);
      const school = textOf(n.schoolName) || textOf(linked(n, 'school'));
      if (!school) continue;

      const key = `${school}|${textOf(n.degreeName)}|${textOf(n.fieldOfStudy)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        school,
        degree: textOf(n.degreeName),
        field: textOf(n.fieldOfStudy),
        dates: dateRangeText(n.dateRange || n.timePeriod),
        description: textOf(n.description)
      });
    }
    return rows;
  }

  function readSkills(pool) {
    const out = [];
    const seen = new Set();
    for (const n of VY.collect(pool, (x) => typeof x.$type === 'string' && /\.Skill$/.test(x.$type))) {
      const name = textOf(n.name);
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The rest of the profile
   *
   * Experience, education and skills were the only three sections read, so a
   * profile's certifications, languages, volunteering, projects, awards,
   * courses and publications were all on screen and none of them reached the
   * export.
   *
   * One table drives both strategies: `type` matches the entity in an embedded
   * payload, `anchor` is the section id the profile's own in-page navigation
   * targets. Neither needs a per-section reader, because every one of these
   * sections is the same shape — a name, a qualifier, a date range and some
   * prose.
   * ------------------------------------------------------------------ */
  const PROFILE_SECTIONS = [
    // `point` marks the sections that happen *on* a date rather than spanning
    // one — a certificate is issued, an award is given.
    { key: 'certifications', type: /\.Certification$/,       anchor: 'licenses_and_certifications', point: true },
    { key: 'languages',      type: /\.Language$/,            anchor: 'languages' },
    { key: 'volunteering',   type: /\.VolunteerExperience$/, anchor: 'volunteering_experience' },
    { key: 'projects',       type: /\.Project$/,             anchor: 'projects' },
    { key: 'honors',         type: /\.Honor$/,               anchor: 'honors_and_awards', point: true },
    { key: 'courses',        type: /\.Course$/,              anchor: 'courses', point: true },
    { key: 'publications',   type: /\.Publication$/,         anchor: 'publications', point: true },
    /*
     * The rest of what a profile can carry. These were simply never read —
     * a profile with patents, recommendations or an Interests panel exported
     * as though it had none, which is the failure this scraper is otherwise
     * written to avoid: silence that looks like absence.
     */
    { key: 'patents',        type: /\.Patent$/,              anchor: 'patents', point: true },
    { key: 'testScores',     type: /\.TestScore$/,           anchor: 'test_scores', point: true },
    { key: 'organizations',  type: /\.Organization$/,        anchor: 'organizations' },
    { key: 'causes',         type: /\.VolunteerCause$/,      anchor: 'volunteer_causes' },
    { key: 'recommendations', type: /\.Recommendation$/,     anchor: 'recommendations' },
    { key: 'interests',      type: /\.Interest(Company|Group|School|Newsletter)?$/, anchor: 'interests' },
    { key: 'featured',       type: /\.Featured/,             anchor: 'featured' }
  ];

  /** The fields these sections share, whichever one an entity belongs to. */
  function sectionEntry(n, section) {
    /*
     * `role` sits ahead of `companyName` because a volunteer entry is
     * "Mentor — STEM India", not "STEM India — Mentor": the thing the person
     * did is the heading, and the organisation qualifies it. Every other
     * section names itself through `name` or `title`.
     */
    /*
     * A recommendation has no name of its own: it is who wrote it, how they
     * knew the person, and what they said. Read that shape first, or every
     * recommendation was discarded for want of a `name`.
     */
    if (n.recommendationText != null || n.recommender != null || n['*recommender'] != null) {
      const who = n.recommender && typeof n.recommender === 'object' ? n.recommender : null;
      const byName =
        (who && [textOf(who.firstName), textOf(who.lastName)].filter(Boolean).join(' ')) ||
        textOf(n.recommenderName) ||
        textOf(who && who.name) ||
        '';
      if (byName || textOf(n.recommendationText)) {
        return {
          name: byName || '(name not returned)',
          detail: textOf(n.relationship) || (who && textOf(who.headline)) || '',
          dates: datePointText(n.createdAt || n.created || n.dateRange) || '',
          url: who && who.publicIdentifier ? U.profileUrl(who.publicIdentifier) : null,
          description: textOf(n.recommendationText) || textOf(n.text)
        };
      }
    }

    const name = textOf(n.name) || textOf(n.title) || textOf(n.role) || textOf(n.schoolName) || textOf(n.companyName);
    if (!name) return null;
    const range = n.dateRange || n.timePeriod || n.issuedOn || n.issueDate;
    return {
      name,
      detail:
        textOf(n.authority) ||
        textOf(n.proficiency) ||
        textOf(n.publisher) ||
        textOf(n.companyName) ||
        textOf(n.issuer) ||
        textOf(n.occupation) ||
        // Patents, test scores and organizations qualify themselves differently.
        textOf(n.patentNumber ? `${n.filingState || ''} ${n.patentNumber}`.trim() : '') ||
        textOf(n.score) ||
        textOf(n.position) ||
        textOf(n.licenseNumber) ||
        '',
      dates: (section && section.point ? datePointText(range) : dateRangeText(range)) || '',
      url: typeof n.url === 'string' && /^https?:/i.test(n.url) ? n.url : null,
      description: textOf(n.description)
    };
  }

  function readProfileSections(pool, index) {
    const out = {};
    for (const s of PROFILE_SECTIONS) {
      const rows = [];
      const seen = new Set();
      for (const raw of VY.collect(pool, (x) => typeof x.$type === 'string' && s.type.test(x.$type))) {
        const e = sectionEntry(resolveAgainst(pool, raw, index), s);
        if (!e) continue;
        const key = `${e.name}|${e.detail}|${e.dates}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(e);
      }
      out[s.key] = rows;
    }
    return out;
  }

  /** The same seven sections, read off the rendered page. */
  function profileSectionsFromDom(doc) {
    const out = {};
    for (const s of PROFILE_SECTIONS) out[s.key] = entriesFromRows(sectionRows(s.anchor, 60, doc));
    return out;
  }

  function withCurrentPosition(profile) {
    if (!profile) return profile;
    const cur = (profile.experience || []).find((e) => e.current) || (profile.experience || [])[0] || null;
    profile.currentPosition = cur
      ? { title: cur.title, company: cur.company, dates: cur.dates, location: cur.location }
      : null;
    return profile;
  }

  /* ------------------------------------------------------------------ *
   * Mapping — posts
   * ------------------------------------------------------------------ */

  /**
   * Post body text: the longest text-bearing node under the update's content.
   *
   * Scoped for the same reason the media readers are — an author's headline is
   * a `description` too, and on a short post it is the *longer* string, so the
   * unscoped walk handed back the poster's job title as the post body.
   */
  /** Containers whose text belongs to somebody else's post, or to the chrome. */
  const OTHER_TEXT_KEYS = new Set([...CHROME_KEYS, 'resharedUpdate', 'articleComponent', 'comments', 'commentsPreview', 'socialDetail', 'actor', 'header']);

  function postTextFrom(node) {
    if (!node || typeof node !== 'object') return '';
    /*
     * The update's own commentary, when it has one. The longest-string scan
     * below is only for shapes without it — left as the rule, it handed a
     * reshare the original's body and an article post its summary, because
     * both are longer than the poster's own words.
     */
    const own = textOf(node.commentary) || (node.commentary && textOf(node.commentary.text)) || '';
    if (own) return own;
    let best = '';
    for (const n of collectContent(
      node,
      (x) => x.commentary || x.text != null || x.attributedText != null || x.description != null,
      { skip: OTHER_TEXT_KEYS }
    )) {
      const t = textOf(n.commentary) || textOf(n.text) || textOf(n.attributedText) || textOf(n.description);
      if (t && t.length > best.length) best = t;
    }
    return best;
  }

  /**
   * @mentions and links, with where they point.
   *
   * LinkedIn keeps a post's mentions as attributes over the text — a start,
   * a length, and the profile or company mentioned. Reading the text alone
   * flattened "Ada Lovelace" to plain words and lost the URL entirely.
   */
  function mentionsFrom(node) {
    const out = [];
    const seen = new Set();
    const c = node && node.commentary;
    const textObj = c && (c.text && typeof c.text === 'object' ? c.text : c);
    const full = textOf(c) || '';
    const attrs = (textObj && (textObj.attributesV2 || textObj.attributes)) || [];
    for (const a of Array.isArray(attrs) ? attrs : []) {
      const d = (a && (a.detailData || a.value || a)) || {};
      const start = num(a.start);
      const length = num(a.length);
      const shown = start != null && length != null ? full.substr(start, length) : '';
      let kind = '';
      let target = null;
      if (d.profileMention || d['*profileMention'] || d.miniProfile || d['*miniProfile']) {
        kind = 'person';
        target = d.profileMention || d.miniProfile || null;
      } else if (d.companyMention || d['*companyMention'] || d.miniCompany || d['*miniCompany']) {
        kind = 'company';
        target = d.companyMention || d.miniCompany || null;
      } else if (d.hyperlink || d.url) {
        kind = 'link';
      } else if (d.hashtag || d['*hashtag']) {
        continue; // hashtags are read elsewhere
      } else {
        continue;
      }
      const id = (target && (target.publicIdentifier || target.universalName)) || '';
      const url =
        kind === 'link'
          ? String((d.hyperlink && (d.hyperlink.url || d.hyperlink)) || d.url || '')
          : kind === 'person' && id
            ? U.profileUrl(id)
            : kind === 'company' && id
              ? `${ORIGIN}/company/${encodeURIComponent(id)}/`
              : '';
      // The span covers the name; if a shape ever includes the @, drop it.
      const name = (shown || (target && [textOf(target.firstName), textOf(target.lastName)].filter(Boolean).join(' ')) || textOf(target && target.name) || '').replace(/^@/, '').trim();
      if (!name && !url) continue;
      const key = `${kind}|${name}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, name, url: url || null });
    }
    return out;
  }

  function mapUpdate(node) {
    /*
     * The entity's own URN wins over a deep scan.
     *
     * A repost carries two activity URNs — its own and the one it resharded —
     * and findUrns returns them in walk order, so the deep scan can file the
     * repost under the *original* post's id. That yields a post whose permalink
     * points at somebody else's content, and it collides with the original if
     * that was collected too. The update's entityUrn is unambiguous:
     * urn:li:fsd_update:(urn:li:activity:<own>,FEED,EMPTY).
     */
    const urns = VY.findUrns(node, 'urn:li:activity:');
    const activityId =
      VY.activityId(node.entityUrn || node['*entityUrn'] || '') || (urns.length ? VY.activityId(urns[0]) : null);
    if (!activityId) return null;
    const ownUrn = urns.find((u) => VY.activityId(u) === activityId) || `urn:li:activity:${activityId}`;

    const media = []
      .concat(documentsFrom(node))
      .concat(videosFrom(node))
      .concat(imagesFrom(node));

    // A video's own poster frame is not a separate media item.
    const posters = new Set(media.filter((m) => m.type === 'video').map((m) => m.thumbnail).filter(Boolean));
    const cleaned = media.filter((m) => !(m.type === 'image' && posters.has(m.url)));

    const social = socialCountsFrom(node);
    const type = classifyPost(node, cleaned);

    let publishedAt = null;
    for (const n of VY.collect(node, (x) => x.createdAt != null || x.publishedAt != null || x.firstPublishedAt != null)) {
      publishedAt = num(n.createdAt) || num(n.publishedAt) || num(n.firstPublishedAt);
      if (publishedAt) break;
    }
    const derived = timestampFromActivityId(activityId);
    const timestampSource = publishedAt ? 'api' : derived ? 'derived-from-urn' : 'unknown';
    const incomplete = cleaned.length === 0 && declaresMedia(node);
    const text = postTextFrom(node);

    return {
      activityId,
      urn: ownUrn,
      postUrl: U.postUrlFromActivityId(activityId),
      type,
      text,
      // Present only where the post actually is one of these, so a text post
      // does not carry three nulls into every export.
      article: articleFrom(node),
      poll: pollFrom(node),
      repost: repostFrom(node),
      hashtags: hashtagsFrom(text),
      mentions: mentionsFrom(node),
      edited: !!(node.edited || (node.commentary && node.commentary.edited) || num(node.lastModifiedAt) || num(node.editedAt)),
      publishedAt: publishedAt || derived || null,
      timestampSource,
      reactions: social.reactions,
      reactionsByType: social.reactionsByType,
      comments: social.comments,
      reposts: social.reposts,
      media: cleaned,
      mediaCount: cleaned.length,
      // Declared but not delivered: the permalink page still owes us this one.
      mediaIncomplete: incomplete,
      detailFetched: !incomplete
    };
  }

  /* ------------------------------------------------------------------ *
   * Profile — three strategies
   * ------------------------------------------------------------------ */
  /**
   * The profile, then the pages the profile card only links to.
   *
   * readProfile() reads the card — which is a preview. Whatever it produces,
   * the "Show all" pages are then followed and merged in, so `experience` is
   * the whole history rather than the two roles that fitted on screen.
   */
  async function getProfile(publicId) {
    // Up to a page, seventeen "Show all" pages and their tabs, and the contact
    // overlay come before the first post. Without a stage of their own the
    // popup sat on "Scraping 0 / N · 0%" for minutes with an empty card.
    setStage('profile', 0);
    const profile = await readProfile(publicId);
    if (!profile) return profile;
    if (S.cfg && S.cfg.fullProfile === false) {
      setStage('harvest', (S.cfg && S.cfg.maxPosts) || 0);
      return withCurrentPosition(profile);
    }

    // Collected while the profile was being read, off whichever document that
    // read used — fetching the page a second time just to look at its links
    // would spend a request for something already in hand.
    const full = await enrichFromDetailPages(publicId, profile, S.detailLinks || new Set());
    setStage('harvest', (S.cfg && S.cfg.maxPosts) || 0);

    /*
     * Recomputed here, after enrichment, and not only at the end of the read.
     *
     * The "Show all" pass exists precisely for the profile whose card yields
     * no roles — that is the condition it forces the experience page on. So
     * the case it was built for was also the case that left currentPosition
     * null forever: it was frozen off the card, before the roles arrived. The
     * export then printed a full experience list beside "currentPosition":
     * null, which is the one field that answers "where does he work".
     */
    return withCurrentPosition(full);
  }

  /** The profile page as a document, fetched and parsed. Null if either fails. */
  async function fetchProfileDocument(publicId) {
    try {
      const html = await apiGet(U.profileUrl(publicId), { expectJson: false });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      rememberDetailLinks(doc);
      return doc;
    } catch (err) {
      if (err instanceof Abort) throw err;
      log('warn', `Could not fetch the profile page to read (${err.message}).`);
      return null;
    }
  }

  /**
   * Merges one profile read over another.
   *
   * Scalars: the first non-empty value wins, so an earlier, richer source is
   * never overwritten by a later, thinner one. Lists: unioned by identity, so
   * every source can only ever add rows.
   */
  function mergeProfiles(base, extra) {
    if (!base) return extra;
    if (!extra) return base;

    const LISTS = {
      experience: (r) => `${r.title}|${r.company}|${r.dates}`,
      education: (r) => `${r.school}|${r.degree}|${r.dates}`,
      skills: (r) => String(r)
    };
    for (const s of PROFILE_SECTIONS) LISTS[s.key] = entryKey;

    const out = Object.assign({}, base);
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (LISTS[k]) {
        out[k] = mergeById(base[k], v, LISTS[k]);
        continue;
      }
      const cur = out[k];
      const empty = cur == null || cur === '' || (Array.isArray(cur) && !cur.length);
      if (empty && v != null && v !== '') out[k] = v;
    }
    return out;
  }

  /**
   * Every source of profile data, merged — not the first one that answers.
   *
   * This used to `return` on the first strategy that produced a Profile
   * entity, and that is why a real profile came back with a name, a headline
   * and a photo but no job history. LinkedIn still ships the Profile entity in
   * the page payload, so strategy B always "succeeded" — but it no longer
   * ships typed Position/Education entities beside it, so the lists that entity
   * produced were empty, and the DOM reader that *can* see the rendered rows
   * was never reached because it only ran when B had failed outright.
   *
   * A partial answer is not a failure to be fallen back from, it is a
   * contribution. So every strategy runs and the results are unioned.
   */
  async function readProfile(publicId) {
    let profile = null;
    const sources = [];

    const contribute = (candidate, name) => {
      if (!candidate) return;
      const before = profile ? (profile.experience || []).length : 0;
      profile = mergeProfiles(profile, candidate);
      const added = (profile.experience || []).length - before;
      // The count goes in the log, where it is diagnostic; `source` stays a
      // clean list of names because it is also a badge in the popup and a
      // line in profile.txt.
      sources.push(name);
      if (added) log('info', `${name} contributed ${added} role(s).`);
    };

    // A — Voyager, when its endpoints have been filled in.
    if (CFG.profile.enabled) {
      try {
        const { raw } = await voyagerGet(CFG.profile, { publicId });
        const p = pickProfileEntity(raw, publicId);
        if (p) contribute(mapProfileEntity(p, raw), 'voyager');
      } catch (err) {
        if (err instanceof Abort) throw err;
        log('warn', `Voyager profile failed (${err.message}) — the other readers still run.`);
      }
    }

    // B — the payload the server rendered into the page, plus that same page's
    //     markup. One fetch, read both ways.
    let fetched = null;
    if (CFG.embeddedJson.enabled) {
      try {
        let pool;
        if (onProfilePageFor(publicId)) {
          pool = mergePayloads(payloadsFromRoot(document));
          rememberDetailLinks(document);
        } else {
          const html = await apiGet(U.profileUrl(publicId), { expectJson: false });
          pool = mergePayloads(payloadsFromHtml(html));
          try {
            fetched = new DOMParser().parseFromString(html, 'text/html');
            rememberDetailLinks(fetched);
          } catch (_) {
            /* the payload read still stands */
          }
        }
        const p = pickProfileEntity(pool, publicId);
        if (p) contribute(mapProfileEntity(p, pool), 'embedded-json');
      } catch (err) {
        if (err instanceof Abort) throw err;
        log('warn', `Embedded payload read failed (${err.message}) — the DOM reader still runs.`);
      }
    }

    // C — the rendered markup. Not a fallback: on a modern profile this is the
    //     only reader that sees the job history at all, because the rows are
    //     rendered from components the typed readers do not recognise.
    if (CFG.dom.enabled) {
      try {
        if (onProfilePageFor(publicId)) {
          rememberDetailLinks(document);
          contribute(profileFromDom(publicId, document), 'dom');
        } else {
          /*
           * `fetched` is strategy B's parse of its own fetch, so when that
           * fetch failed there was no document here and this reader — the only
           * one that sees a component-rendered job history — quietly did
           * nothing, directly under a log line promising it still ran. Fetch
           * the page for it rather than skip it.
           */
          if (!fetched) fetched = await fetchProfileDocument(publicId);
          if (fetched) contribute(profileFromDom(publicId, fetched), 'dom-fetched');
        }
      } catch (err) {
        if (err instanceof Abort) throw err;
        log('warn', `Reading the rendered profile failed (${err.message}).`);
      }
    }

    if (!profile) {
      log('warn', 'No reader produced a profile — falling back to the identifier alone.');
      try {
        /*
         * Only when the tab is actually showing this profile. Reading the live
         * document otherwise harvests whatever page the tab happens to be on
         * and files a stranger's name and photo under the target's id, which
         * is worse than the thin fallback below.
         */
        profile = onProfilePageFor(publicId) ? profileFromDom(publicId, document) : null;
        if (profile) sources.push('dom');
      } catch (_) {
        /*
         * Never throw out of here. A run with a thin profile is still a run —
         * the posts are the point — and a profile read that fails must not be
         * the thing that ends it.
         */
        profile = null;
      }
      if (!profile) {
        profile = {
          publicId,
          fullName: publicId,
          experience: [], education: [], skills: [],
          profileUrl: U.profileUrl(publicId),
          scrapedAt: new Date().toISOString()
        };
        for (const sec of PROFILE_SECTIONS) profile[sec.key] = [];
        sources.push('identifier-only');
      }
    }

    profile.source = sources.join(' + ') || 'unknown';
    log(
      (profile.experience || []).length ? 'success' : 'warn',
      `Profile read via ${profile.source} — ` +
        `${(profile.experience || []).length} role(s), ${(profile.education || []).length} school(s), ` +
        `${(profile.skills || []).length} skill(s).`
    );
    return withCurrentPosition(profile);
  }

  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * Whether the tab is already showing this profile.
   *
   * `publicId` has been percent-*decoded* by normalisePublicId, while
   * location.pathname stays encoded — so a non-ASCII slug never matched and the
   * page was re-fetched over the network even though it was already open,
   * spending a request from the session budget for nothing. Decode both.
   */
  function onProfilePageFor(publicId) {
    let path = location.pathname;
    try {
      path = decodeURIComponent(path);
    } catch (_) {
      /* malformed escape; compare the raw form rather than throwing */
    }
    return new RegExp(`^/in/${escapeRe(publicId)}/?$`, 'i').test(path);
  }

  function pickProfileEntity(pool, publicId) {
    const candidates = VY.byType(pool, /\.Profile$/);
    if (!candidates.length) return null;
    const exact = candidates.find(
      (p) => String(p.publicIdentifier || '').toLowerCase() === String(publicId).toLowerCase()
    );
    // Several profiles ride along in a feed payload — "People also viewed",
    // a commenter — and the richest of them is not the target. An exact id
    // match, or the only candidate there is; anything else files a stranger
    // under the target's id, and the DOM reader carries the read instead.
    if (exact) return exact;
    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * Best-effort profile read straight off the rendered page.
   *
   * og: meta tags are the durable part — server-rendered and stable for
   * years. Class names are not, so every DOM lookup below is a list of
   * candidates and the structural fallbacks come last.
   */
  /**
   * Reads a profile out of rendered markup.
   *
   * `doc` is the live document when the tab is showing the profile, and a
   * DOMParser document over fetched HTML when it is not — the readers are the
   * same either way, so the rendered rows are available whether or not the
   * user happens to be sitting on the page.
   */
  function profileFromDom(publicId, doc) {
    const d = doc || document;
    const meta = (sel, attr) => {
      try {
        const el = d.querySelector(sel);
        return el ? el.getAttribute(attr || 'content') || '' : '';
      } catch (_) {
        return '';
      }
    };
    const pick = (sels) => {
      for (const s of sels) {
        try {
          const el = d.querySelector(s);
          const t = el && (el.textContent || '').trim();
          if (t) return t;
        } catch (_) {
          /* a selector may be invalid on an older Chrome; keep going */
        }
      }
      return '';
    };

    const ogTitle = meta('meta[property="og:title"]');
    const ogDesc = meta('meta[property="og:description"]');

    const name =
      pick(['main h1', 'h1.text-heading-xlarge', 'h1']) || ogTitle.split(' - ')[0].split(' | ')[0].trim();

    const headline =
      pick([
        '.text-body-medium.break-words',
        'main h1 + div',
        '[data-generated-suggestion-target] ~ div .text-body-medium'
      ]) || (ogTitle.includes(' - ') ? ogTitle.split(' - ').slice(1).join(' - ').split(' | ')[0].trim() : '');

    const location = pick([
      '.text-body-small.inline.t-black--light.break-words',
      'main .pv-text-details__left-panel .text-body-small',
      'span.text-body-small:not(.inline-show-more-text)'
    ]);

    const about = pick([
      '#about ~ div .inline-show-more-text',
      'section:has(#about) .display-flex.full-width span[aria-hidden="true"]',
      '[data-section="summary"]'
    ]);

    /*
     * The avatar and cover, by CDN path. `main` first so a commenter's or a
     * "People also viewed" avatar in the sidebar can never win — the top card
     * is the first thing in `main` — then the whole document, then og:image as
     * the last resort it always should have been.
     */
    let root = null;
    try {
      root = d.querySelector('main');
    } catch (_) {
      /* ignore */
    }
    const scoped = root ? imageUrlsIn(root) : [];
    const everywhere = imageUrlsIn(d);

    /*
     * Never the whole document for the photo: the signed-in viewer's own
     * avatar sits in the nav bar on the same CDN path, and falling back to it
     * filed the operator's face as the target's. An <img> whose alt is the
     * profile's name is the surest read; the top card's CDN-path image next;
     * then og:image, which is at least this profile's.
     */
    let byAlt = '';
    try {
      const img = name && root ? root.querySelector(`img[alt="${name.replace(/"/g, '\\"')}"]`) : null;
      byAlt = (img && (img.currentSrc || img.src || img.getAttribute('data-delayed-url'))) || '';
    } catch (_) {
      byAlt = '';
    }
    const photo =
      (byAlt && /licdn\.com/.test(byAlt) ? byAlt : '') ||
      pickImageByPath(scoped, PROFILE_PHOTO_PATH) ||
      meta('meta[property="og:image"]');

    const banner =
      pickImageByPath(scoped, PROFILE_BANNER_PATH) ||
      pickImageByPath(everywhere, PROFILE_BANNER_PATH) ||
      '';

    // The top card carries both counts as plain text. Bounded, because further
    // down the page other people's follower counts appear too.
    const topText = textOfNode(root || (d && d.body)).slice(0, 3000);
    const extra = topCardExtras(d, root, topText);

    return Object.assign(profileSectionsFromDom(d), extra, {
      publicId,
      profileUrn: null,
      fullName: name,
      firstName: name.split(' ')[0] || '',
      lastName: name.split(' ').slice(1).join(' '),
      headline,
      location,
      industry: '',
      about: about || sectionText('about', d) || ogDesc,
      followers: countFromText(topText, 'followers?'),
      connections: countFromText(topText, 'connections?'),
      // Set by topCardExtras above when the page carries them; declared here so
      // the shape of a profile never depends on which reader produced it.
      pronouns: extra.pronouns || '',
      verified: !!extra.verified,
      openTo: extra.openTo || '',
      currentCompany: extra.currentCompany || '',
      currentSchool: extra.currentSchool || '',
      websites: extra.websites || [],
      contact: extra.contact || {},
      photoUrl: photo || null,
      bannerUrl: banner || null,
      experience: experienceFromDom(d),
      education: educationFromDom(d),
      skills: skillsFromDom(d),
      currentPosition: null,
      profileUrl: U.profileUrl(publicId),
      scrapedAt: new Date().toISOString(),
      source: 'dom'
    });
  }

  /**
   * The parts of the top card nothing was reading.
   *
   * Pronouns, the verification badge, an Open-to-work banner, the company and
   * school the card links to, and any personal site listed on it — all of it
   * is on the page the reader was already holding, and none of it was being
   * written down. Every lookup is guarded on its own: this runs against markup
   * that changes without notice, and one bad selector must not cost the rest.
   */
  function topCardExtras(d, root, topText) {
    const out = { websites: [], contact: {} };
    /*
     * The top card only — the section holding the <h1>. Scanning all of
     * <main> made the first /company/ link anywhere on the page (a past
     * employer, an interest) the current company, and every outbound link
     * in every post a "website" of the profile's.
     */
    let scope = null;
    try {
      const h1 = (root || d).querySelector('h1');
      scope = (h1 && (h1.closest('section, .artdeco-card, .pv-top-card, [class*="top-card"]') || h1.parentElement)) || null;
      if (!scope || scope === root || scope === d.body) scope = (root || d).querySelector('section') || null;
    } catch (_) {
      scope = null;
    }
    if (!scope) return out;
    // The top card's own text, not the first 3000 characters of the page.
    try {
      topText = String(scope.innerText || scope.textContent || topText || '').slice(0, 1500);
    } catch (_) {
      topText = String(topText || '').slice(0, 1500);
    }

    const q = (sel) => {
      try {
        return scope.querySelector(sel);
      } catch (_) {
        return null;
      }
    };
    const qa = (sel) => {
      try {
        return [...scope.querySelectorAll(sel)];
      } catch (_) {
        return [];
      }
    };
    const txt = (el) => ((el && (el.textContent || '')) || '').trim();

    // "(she/her)" sits beside the name; the parentheses are LinkedIn's, not ours.
    const pronounNode = q('main h1 ~ span, .pv-text-details__left-panel span.text-body-small');
    const pronounRaw = txt(pronounNode);
    if (/^\(?\s*(he|she|they|ze|xe)\b/i.test(pronounRaw) && pronounRaw.length <= 40) {
      out.pronouns = pronounRaw.replace(/^\(|\)$/g, '').trim();
    }
    if (!out.pronouns) {
      const m = topText.match(/\((he\/him|she\/her|they\/them)[^)]*\)/i);
      if (m) out.pronouns = m[1];
    }

    // The badge is an element beside the name, not a word — "Verified" can
    // appear in a headline ("Verified Meta Partner").
    out.verified = !!q('[data-test-icon*="verified"], svg[data-test-icon="verified-small"], [aria-label="Verified"], [class*="verified-badge"]');

    /*
     * The Open-to-work / Hiring banner is a frame around the photo. LinkedIn
     * serves a framed avatar from a distinct CDN path, and the frame names
     * itself in the image's alt or aria-label; the text of the card is only a
     * last resort, because "hiring" is a common word in a headline.
     */
    const framed = q('img[src*="profile-framedphoto"], img[alt*="#OPEN_TO_WORK" i], img[alt*="#HIRING" i], [aria-label*="Open to work" i], [aria-label*="hiring" i]');
    if (framed) {
      const label = String(framed.getAttribute('alt') || framed.getAttribute('aria-label') || '');
      out.openTo = /open.?to.?work/i.test(label) ? 'Open to work' : /hiring/i.test(label) ? 'Hiring' : 'Open to work';
    } else {
      const m = topText.match(/^\s*(Open to work|Hiring)\b[^\n]{0,80}/im);
      if (m) out.openTo = m[0].trim();
    }

    // The card links to the current employer and the most recent school.
    for (const a of qa('a[href*="/company/"]')) {
      const t = txt(a);
      if (t && !out.currentCompany) out.currentCompany = t;
    }
    for (const a of qa('a[href*="/school/"]')) {
      const t = txt(a);
      if (t && !out.currentSchool) out.currentSchool = t;
    }

    /*
     * Anything the profile links out to. LinkedIn's own URLs are excluded, and
     * so is anything that is not http(s) — a `mailto:` belongs in contact, not
     * in a list of sites.
     */
    const sites = new Set();
    for (const a of qa('a[href^="http"]')) {
      let href = '';
      try {
        href = a.getAttribute('href') || '';
      } catch (_) {
        continue;
      }
      if (/^https?:\/\/([a-z0-9-]+\.)*(linkedin\.com|licdn\.com)/i.test(href)) continue;
      sites.add(href.split('?')[0]);
      if (sites.size >= 10) break;
    }
    out.websites = [...sites];

    return out;
  }

  /**
   * The contact-info overlay: websites, email, phone, birthday, address and
   * whatever else the profile chose to publish. It is its own URL rather than
   * part of the card, which is why nothing here had ever seen it.
   */
  function contactFromDoc(doc) {
    const out = {};
    if (!doc) return out;
    let rows = [];
    try {
      rows = [...doc.querySelectorAll('section, li, .pv-contact-info__contact-type')];
    } catch (_) {
      return out;
    }
    // Leaf rows only: a section that contains sections is the overlay itself,
    // and matching its whole text filed the profile URL as "email".
    rows = rows.filter((r) => {
      try {
        return !r.querySelector('section, .pv-contact-info__contact-type');
      } catch (_) {
        return true;
      }
    });
    const LABELS = [
      [/e-?mail/i, 'email'],
      [/phone/i, 'phone'],
      [/birthday/i, 'birthday'],
      [/address/i, 'address'],
      [/websites?/i, 'websites'],
      [/twitter|^x$/i, 'twitter'],
      [/^im$|instant message/i, 'im'],
      [/^connected/i, 'connectedOn'],
      [/profile url|^profile$|^your profile/i, 'profileUrl']
    ];
    for (const row of rows) {
      const text = ((row.textContent || '') + '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 400) continue;
      // The label is the row's heading when it has one; the whole row's text
      // matched "profile" and "im" far too readily.
      let label = text;
      try {
        const h = row.querySelector('h3, h2, dt, .pv-contact-info__header, [class*="header"]');
        if (h && (h.textContent || '').trim()) label = (h.textContent || '').trim();
      } catch (_) {
        /* the row's text stands */
      }
      for (const [re, key] of LABELS) {
        if (!re.test(label)) continue;
        const links = [];
        try {
          for (const a of row.querySelectorAll('a[href]')) {
            const h = a.getAttribute('href') || '';
            if (h) links.push(h.replace(/^mailto:/, ''));
          }
        } catch (_) {
          /* text is enough */
        }
        const value = links.length ? (key === 'websites' ? links : links[0]) : text;
        if (out[key] == null) out[key] = value;
        break;
      }
    }
    return out;
  }

  /**
   * The contact-info overlay's embedded payload. The page carries a
   * ProfileContactInfo entity — email, phone numbers, websites, Twitter
   * handles, birthday, address — and reading only the rendered markup meant
   * a redesign of the overlay lost all of it. Both are read and merged.
   */
  function contactFromPayload(pool) {
    const out = {};
    if (!pool) return out;
    const isContact = (n) =>
      n.emailAddress != null ||
      Array.isArray(n.phoneNumbers) ||
      Array.isArray(n.websites) ||
      Array.isArray(n.twitterHandles) ||
      n.birthDateOn != null ||
      n.address != null ||
      Array.isArray(n.ims);
    for (const n of VY.collect(pool, isContact)) {
      const email = n.emailAddress && (typeof n.emailAddress === 'object' ? n.emailAddress.emailAddress : n.emailAddress);
      if (email && !out.email) out.email = String(email);
      if (Array.isArray(n.phoneNumbers) && n.phoneNumbers.length && !out.phone) {
        out.phone = n.phoneNumbers.map((ph) => (ph && (ph.number || ph.phoneNumber)) || textOf(ph)).filter(Boolean).join(', ');
      }
      if (Array.isArray(n.websites) && n.websites.length) {
        const sites = n.websites.map((w) => (w && (w.url || w.website)) || textOf(w)).filter(Boolean);
        out.websites = mergeById(out.websites, sites, (u) => String(u));
      }
      if (Array.isArray(n.twitterHandles) && n.twitterHandles.length && !out.twitter) {
        out.twitter = n.twitterHandles.map((t) => (t && (t.name || t.handle)) || textOf(t)).filter(Boolean).join(', ');
      }
      if (Array.isArray(n.ims) && n.ims.length && !out.im) {
        out.im = n.ims.map((im) => (im && im.id ? `${textOf(im.provider) || ''} ${im.id}`.trim() : textOf(im))).filter(Boolean).join(', ');
      }
      if (n.birthDateOn && !out.birthday) {
        const b = n.birthDateOn;
        out.birthday = b.month && MONTHS[b.month] ? `${MONTHS[b.month]} ${b.day || ''}`.trim() : textOf(b);
      }
      if (n.address && !out.address) out.address = textOf(n.address);
      if (n.connectedAt && !out.connectedOn) out.connectedOn = new Date(Number(n.connectedAt)).toISOString().slice(0, 10);
    }
    return out;
  }

  /** innerText where the page offers it, textContent otherwise. */
  function textOfNode(el) {
    try {
      return (el && (el.innerText || el.textContent)) || '';
    } catch (_) {
      return '';
    }
  }

  /* ------------------------------------------------------------------ *
   * The "Show all" pages
   *
   * A LinkedIn profile card is a *preview*. It renders two or three roles and
   * a couple of schools and puts the rest behind "Show all 12 experiences",
   * which is its own URL: /in/<id>/details/experience/. Reading only the card
   * meant the export carried whatever happened to fit above the fold and
   * silently called it the full history — the one failure mode this scraper
   * is otherwise written to avoid.
   *
   * Which pages exist is not guessed. The card links to exactly the ones the
   * profile has, so the links are collected and followed, and nothing is
   * spent on a section the profile does not have.
   * ------------------------------------------------------------------ */
  const DETAILS_PAGES = [
    { key: 'experience',    path: 'experience',              map: experienceFromRows, id: (r) => `${r.title}|${r.company}|${r.dates}` },
    { key: 'education',     path: 'education',               map: educationFromRows,  id: (r) => `${r.school}|${r.degree}|${r.dates}` },
    // Skills are bare names rather than records, so the row's first span is
    // the whole thing and the name is its own identity.
    { key: 'skills',        path: 'skills',                  map: (rows) => rows.map((s) => s[0]).filter(Boolean), id: (r) => String(r) },
    { key: 'certifications', path: 'certifications',         map: entriesFromRows,    id: entryKey },
    { key: 'volunteering',  path: 'volunteering-experiences', map: entriesFromRows,   id: entryKey },
    { key: 'projects',      path: 'projects',                map: entriesFromRows,    id: entryKey },
    { key: 'honors',        path: 'honors',                  map: entriesFromRows,    id: entryKey },
    { key: 'languages',     path: 'languages',               map: entriesFromRows,    id: entryKey },
    { key: 'courses',       path: 'courses',                 map: entriesFromRows,    id: entryKey },
    { key: 'publications',  path: 'publications',            map: entriesFromRows,    id: entryKey },
    { key: 'patents',       path: 'patents',                 map: entriesFromRows,    id: entryKey },
    { key: 'testScores',    path: 'test-scores',             map: entriesFromRows,    id: entryKey },
    { key: 'organizations', path: 'organizations',           map: entriesFromRows,    id: entryKey },
    { key: 'causes',        path: 'volunteering-causes',     map: entriesFromRows,    id: entryKey },
    /*
     * Two pages are tabbed, and a fetch returns only the default tab —
     * recommendations received but not given, interests' top voices but not
     * the companies, groups, newsletters or schools. Each tab is its own
     * fetch, by index, and the rows say which tab they came from.
     */
    { key: 'recommendations', path: 'recommendations',       map: entriesFromRows,    id: entryKey,
      tabs: [{ index: 0, label: 'received' }, { index: 1, label: 'given' }] },
    { key: 'interests',     path: 'interests',               map: entriesFromRows,    id: entryKey,
      tabs: [{ index: 0, label: 'top voices' }, { index: 1, label: 'companies' }, { index: 2, label: 'groups' }, { index: 3, label: 'newsletters' }, { index: 4, label: 'schools' }] },
    { key: 'featured',      path: 'featured',                map: entriesFromRows,    id: entryKey }
  ];

  function entryKey(r) {
    return `${r.name}|${r.detail}|${r.dates}`;
  }

  /*
   * A hard ceiling on what this costs: one request per page, at most, and only
   * for a section the profile actually links to. The list below it is longer
   * now, so the ceiling is the list's length rather than a number that would
   * silently drop the sections at the end of it.
   */
  const MAX_DETAILS_PAGES = 17;

  /**
   * Rows out of a details page's *embedded* payload.
   *
   * Modern LinkedIn ships profile sections as generic components rather than
   * typed Position/Education entities — a title, a subtitle, a caption and a
   * metadata line, which is the same four fields in the same order the markup
   * prints. On a details page the URL already says which section it is, so
   * there is no ambiguity about what those rows are.
   */
  function componentRows(pool) {
    const out = [];
    for (const n of VY.collect(pool, (x) => !!x.entityComponent || (x.components && x.components.entityComponent))) {
      const c = n.entityComponent || (n.components && n.components.entityComponent);
      if (!c || typeof c !== 'object') continue;
      /*
       * Positions preserved, not compacted.
       *
       * These four slots are known by name, and every consumer reads them by
       * position — company is spans[1], dates spans[2], location spans[3].
       * Dropping an empty one slid every later field a column left, so a
       * self-employed role with no company line came out with its date range
       * filed as the company and `current` computed from the location.
       * Only trailing blanks go, so `spans.slice(3)` stays clean.
       */
      const spans = [
        textOf(c.titleV2) || textOf(c.title),
        textOf(c.subtitle),
        textOf(c.caption),
        textOf(c.metadata)
      ].map((v) => v || '');
      while (spans.length && !spans[spans.length - 1]) spans.pop();
      if (spans.length) out.push(spans);
    }
    return out;
  }

  /** Records the "Show all" links seen while reading a profile document. */
  function rememberDetailLinks(root) {
    if (!S.detailLinks) S.detailLinks = new Set();
    for (const name of linkedDetailPages(root)) S.detailLinks.add(name);
  }

  /** The /details/<name>/ pages this profile actually links to. */
  function linkedDetailPages(root) {
    const found = new Set();
    let anchors;
    try {
      anchors = (root || document).querySelectorAll('a[href*="/details/"]');
    } catch (_) {
      return found;
    }
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/details\/([a-z-]+)/i);
      if (m) found.add(m[1].toLowerCase());
    }
    return found;
  }

  /**
   * Follows those pages and merges what they hold into the profile.
   *
   * Additive by construction: a details page is a superset of the card, so
   * merging can only ever grow a list. Nothing the card already found is
   * dropped if a page fails to load.
   */
  async function enrichFromDetailPages(publicId, profile, linked) {
    if (!profile) return profile;

    const wanted = DETAILS_PAGES.filter((d) => {
      if (linked.has(d.path)) return true;
      // Follow the two that matter even when no link was seen — a card that
      // renders everything inline has no "Show all", and so does one whose
      // markup we failed to read.
      return (d.key === 'experience' || d.key === 'education') && !(profile[d.key] || []).length;
    }).slice(0, MAX_DETAILS_PAGES);

    if (!wanted.length) return profile;
    log('info', `Following ${wanted.length} "Show all" page(s) for the full profile history.`);

    // One fetch per page, or per tab of a tabbed page.
    const fetches = [];
    for (const d of wanted) {
      for (const tab of d.tabs || [null]) fetches.push({ d, tab });
    }
    // The pages, plus the contact overlay that follows them.
    setStage('profile', fetches.length + 1);

    let added = 0;
    for (const { d, tab } of fetches) {
      if (S.stop) break;
      await waitWhilePaused();
      const url =
        `${ORIGIN}/in/${encodeURIComponent(publicId)}/details/${d.path}/` +
        (tab ? `?detailScreenTabIndex=${tab.index}` : '');
      try {
        const html = await apiGet(url, { expectJson: false });
        let doc = null;
        try {
          doc = new DOMParser().parseFromString(html, 'text/html');
        } catch (_) {
          /* fall through to the payload read */
        }

        /*
         * Both readings, merged — not the first that answers.
         *
         * A fetched page is server-rendered, so which of the two carries the
         * rows depends on how much LinkedIn chose to render for this section:
         * sometimes the markup, sometimes only the component payload, and
         * sometimes each holds rows the other does not. Taking whichever
         * answered first threw away the difference.
         */
        const marked = doc ? rowsFrom(doc.querySelector('main') || doc.body, 200) : [];
        const components = componentRows(mergePayloads(payloadsFromHtml(html)));
        const rows = mergeById(marked, components, (r) => r.join('|'));
        if (!rows.length) continue;

        const before = (profile[d.key] || []).length;
        const mapped = d.map(rows);
        if (tab) for (const r of mapped) if (r && typeof r === 'object') r.tab = tab.label;
        profile[d.key] = mergeById(profile[d.key], mapped, d.id);
        added += profile[d.key].length - before;
      } catch (err) {
        if (err instanceof Abort) throw err;
        log('warn', `Could not read the full ${d.key} list (${err.message}) — keeping what the profile card showed.`);
      }
      bumpStage();
      await pause(U.randOf(L.PAGE_DELAY));
    }

    if (added) log('success', `Full profile history added ${added} row(s) the profile card did not show.`);

    /*
     * The contact-info overlay is not a details page — it is its own URL —
     * but it is the only place the profile's email, phone, birthday, address
     * and listed websites appear. One request, guarded like the rest.
     */
    if (!S.stop) {
      await waitWhilePaused();
      const url = `${ORIGIN}/in/${encodeURIComponent(publicId)}/overlay/contact-info/`;
      try {
        const html = await apiGet(url, { expectJson: false });
        const doc = new DOMParser().parseFromString(html, 'text/html');
        // Markup and payload, merged: the payload's fields win where both
        // answer, because they are structured rather than read off a label.
        const fromDoc = contactFromDoc(doc);
        const fromPayload = contactFromPayload(mergePayloads(payloadsFromHtml(html)));
        const contact = Object.assign({}, fromDoc, fromPayload);
        if (Array.isArray(fromDoc.websites) || Array.isArray(fromPayload.websites)) {
          contact.websites = mergeById(fromDoc.websites, fromPayload.websites, (u) => String(u));
        }
        bumpStage();
        if (Object.keys(contact).length) {
          profile.contact = Object.assign({}, profile.contact || {}, contact);
          if (Array.isArray(contact.websites)) {
            profile.websites = mergeById(profile.websites, contact.websites, (u) => String(u));
          }
          log('info', `Contact info read: ${Object.keys(contact).join(', ')}.`);
        }
      } catch (err) {
        if (err instanceof Abort) throw err;
        log('warn', `Could not read the contact-info overlay (${err.message}).`);
      }
    }
    return profile;
  }

  /** Union of two row lists, keyed on identity, first occurrence winning. */
  function mergeById(existing, incoming, id) {
    const out = [];
    const seen = new Set();
    for (const r of [].concat(Array.isArray(existing) ? existing : [], Array.isArray(incoming) ? incoming : [])) {
      if (!r) continue;
      let key;
      try {
        key = id(r);
      } catch (_) {
        key = JSON.stringify(r);
      }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  function parseCompact(s) {
    if (!s) return null;
    const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return null;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    const n = Math.round(parseFloat(m[1]) * mult);
    return isFinite(n) ? n : null;
  }

  /**
   * The rows of one profile section, as LinkedIn renders them.
   *
   * Every section hangs off an anchor div whose id is what the profile's own
   * in-page navigation targets — `#experience`, `#education`, `#skills` — so
   * those ids are the durable handle on the rendered page. Inside, each entry
   * is an <li> that prints every field twice: once visible with aria-hidden,
   * once for a screen reader. Taking only the aria-hidden spans avoids
   * doubling every string.
   *
   * Returns the raw span lists; each caller knows its own field order.
   */
  /**
   * The element that holds a section's rows.
   *
   * The anchor is an empty div LinkedIn drops in for its own in-page
   * navigation; the rows live in the card around it. `closest('section')` is
   * right today, but if that card ever stops being a `<section>` every section
   * reads as empty — and an empty education list is indistinguishable from a
   * profile with no education. So the walk up settles for whatever ancestor
   * actually contains a list.
   */
  /** Every anchor LinkedIn drops in for its own in-page navigation. */
  const SECTION_ANCHORS = ['experience', 'education', 'skills'].concat(
    PROFILE_SECTIONS.map((sec) => sec.anchor).filter(Boolean)
  );

  /*
   * What each section is called on the page — the second way to find it.
   * The anchor div is LinkedIn's own navigation aid and has survived every
   * redesign so far, but a reader that has only one way to find a section
   * returns nothing the day that changes. A heading is the other way.
   */
  /*
   * The anchor ids are the same in every locale; the headings are not. The
   * fallback carries the big three in the languages LinkedIn's interface is
   * most often set to, so a page with no anchors is still readable off its
   * headings for a French or Spanish or German user.
   */
  const SECTION_TITLES = {
    experience: /^(experience|expérience|experiencia|erfahrung|berufserfahrung|experiência|esperienza|ervaring|経歴|职业经历)$/i,
    education: /^(education|formation|educación|ausbildung|formação|formazione|opleiding|学歴|教育经历)$/i,
    skills: /^(skills|compétences|aptitudes|kenntnisse|competências|competenze|vaardigheden|スキル|技能)$/i,
    licenses_and_certifications: /^licen[cs]es\s*&?\s*(and\s*)?certifications$/i,
    languages: /^languages$/i,
    volunteering_experience: /^volunteering( experience)?$/i,
    projects: /^projects$/i,
    honors_and_awards: /^hono(u)?rs\s*&?\s*(and\s*)?awards$/i,
    courses: /^courses$/i,
    publications: /^publications$/i,
    patents: /^patents$/i,
    test_scores: /^test scores$/i,
    organizations: /^organi[sz]ations$/i,
    volunteer_causes: /^(volunteer )?causes$/i,
    recommendations: /^recommendations$/i,
    interests: /^interests$/i,
    featured: /^featured$/i
  };

  /** Selectors that mean "one entry" on a profile, across LinkedIn's designs. */
  const ROW_SEL = 'li, .pvs-entity, .pvs-list__item--line-separated, .artdeco-list__item, [data-view-name*="entity"]';

  const safeQueryAll = (el, sel) => {
    try {
      return el && el.querySelectorAll ? [...el.querySelectorAll(sel)] : [];
    } catch (_) {
      return [];
    }
  };
  const safeClosest = (el, sel) => {
    try {
      return el && el.closest ? el.closest(sel) : null;
    } catch (_) {
      return null;
    }
  };

  /** The visible text of a heading, without the screen-reader duplicate. */
  function headingText(h) {
    const aria = safeQueryAll(h, 'span[aria-hidden="true"]');
    const t = aria.length ? aria[0].textContent : h.textContent;
    return String(t || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * The element that holds a section's rows.
   *
   * Two ways in: the anchor div LinkedIn drops in for its in-page navigation,
   * and failing that a heading that reads as the section's title. Either way
   * the walk up settles for the nearest ancestor that actually contains rows —
   * and never one that also contains another section, because that ancestor
   * is `<main>`, and reading it under this section's name filed the education
   * list as the job history.
   */
  function sectionContainer(anchorId, root) {
    const doc = root || document;
    let anchor = null;
    try {
      anchor = doc.getElementById ? doc.getElementById(anchorId) : doc.querySelector('#' + anchorId);
    } catch (_) {
      anchor = null;
    }

    const foreign = SECTION_ANCHORS.filter((id) => id !== anchorId)
      .map((id) => '#' + id)
      .join(', ');
    const otherTitles = Object.keys(SECTION_TITLES).filter((k) => k !== anchorId).map((k) => SECTION_TITLES[k]);
    const reachesAnotherSection = (el) => {
      if (!el || !el.querySelector) return false;
      try {
        if (foreign && el.querySelector(foreign)) return true;
      } catch (_) {
        /* fall through to the heading check */
      }
      for (const h of safeQueryAll(el, 'h2, h3, [role="heading"], .pvs-header__title')) {
        const t = headingText(h);
        if (t && otherTitles.some((re) => re.test(t))) return true;
      }
      return false;
    };
    const hasRows = (el) => {
      try {
        return !!(el && el.querySelector && el.querySelector(ROW_SEL));
      } catch (_) {
        return false;
      }
    };
    const settle = (from, section) => {
      if (section && hasRows(section) && !reachesAnotherSection(section)) return section;
      let el = from && from.parentElement;
      for (let i = 0; el && i < 4; i++) {
        if (hasRows(el) && !reachesAnotherSection(el)) return el;
        el = el.parentElement;
      }
      // A container that spans other sections is worse than none: it yields
      // their rows under this section's name.
      return section && !reachesAnotherSection(section) ? section : null;
    };

    if (anchor) return settle(anchor, safeClosest(anchor, 'section, .artdeco-card, .pv-profile-card'));

    // No anchor — find the section by what it is called.
    const want = SECTION_TITLES[anchorId];
    if (!want) return null;
    for (const h of safeQueryAll(doc, 'h2, h3, [role="heading"], .pvs-header__title')) {
      if (!want.test(headingText(h))) continue;
      const found = settle(h, safeClosest(h, 'section, .artdeco-card, .pv-profile-card'));
      if (found) return found;
    }
    return null;
  }

  /**
   * The visible strings of one entry, in reading order.
   *
   * Three ways, tried in turn: the aria-hidden spans LinkedIn prints beside
   * every screen-reader copy; the screen-reader copies themselves when the
   * visible ones are missing; and finally the leaf text of the row, for markup
   * that renders each string once. Strings that belong to a *nested* entry —
   * a role under a grouped company, an endorsement under a skill — are not
   * this entry's and are left for their own row.
   */
  function rowSpans(row) {
    const own = (el) => safeClosest(el, ROW_SEL) === row;
    const clean = (list) => {
      const out = [];
      for (const raw of list) {
        const t = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (out.length && out[out.length - 1] === t) continue; // aria + hidden copy
        out.push(t);
      }
      return out;
    };

    const aria = safeQueryAll(row, 'span[aria-hidden="true"]').filter(own).map((el) => el.textContent);
    if (aria.length) return clean(aria);

    const hidden = safeQueryAll(row, '.visually-hidden').filter(own).map((el) => el.textContent);
    if (hidden.length) return clean(hidden);

    /*
     * Leaf text, per block. Inline markup — <strong>Skills:</strong> beside
     * its words, a name inside an <a> — is part of the line it sits in, not a
     * line of its own; walking element children only threw the surrounding
     * text nodes away. Text is gathered per block-level element instead.
     */
    const INLINE = /^(A|STRONG|EM|B|I|U|SPAN|SMALL|MARK|ABBR|CODE|TIME|LABEL)$/i;
    const leaves = [];
    const gather = (el, into) => {
      // An inline element is part of its parent's line only when the parent
      // has words of its own beside it. A row made of bare <span>s, one per
      // field, has no such words, and each span is then a line of its own.
      let directText = false;
      for (const c of el.childNodes || []) {
        if (c.nodeType === 3 && String(c.data || '').trim()) {
          directText = true;
          break;
        }
      }
      for (const c of el.childNodes || []) {
        if (c.nodeType === 3) {
          into.push(c.data);
        } else if (c.nodeType === 1) {
          if (/^(BUTTON|SVG|IMG|SCRIPT|STYLE)$/i.test(c.tagName)) continue;
          if (c !== row && safeClosest(c, ROW_SEL) !== row) continue; // nested entry
          if (INLINE.test(c.tagName) && directText) gather(c, into);
          else {
            const own = [];
            gather(c, own);
            const t = own.join('').replace(/\s+/g, ' ').trim();
            if (t) leaves.push(t);
          }
        }
      }
    };
    const top = [];
    gather(row, top);
    const rowOwn = top.join('').replace(/\s+/g, ' ').trim();
    if (rowOwn) leaves.unshift(rowOwn);
    return clean(leaves);
  }

  /** The nested entries directly under a row — a grouped company's roles. */
  function nestedRows(row) {
    return safeQueryAll(row, ROW_SEL).filter((el) => {
      const parentRow = safeClosest(el.parentElement, ROW_SEL);
      return parentRow === row;
    });
  }

  /**
   * The entry itself, under LinkedIn's wrapping.
   *
   * On the live page every <li> holds one entity <div> that carries all of
   * the item's text, and both match ROW_SEL. Read as row-and-group, the
   * <li> owned no spans and the <div> became a nested "role" — a flat entry
   * survived by accident, a grouped company lost its roles, and a skill lost
   * its name. A row that has exactly one row-child holding all its text is a
   * wrapper: step through it.
   */
  function unwrap(row) {
    let el = row;
    for (let i = 0; i < 4; i++) {
      const kids = nestedRows(el);
      if (kids.length !== 1) return el;
      const inner = kids[0];
      const outerText = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      const innerText = String(inner.textContent || '').replace(/\s+/g, ' ').trim();
      if (!outerText || innerText !== outerText) return el;
      el = inner;
    }
    return el;
  }

  /**
   * Whether a nested row reads as a role — a title with a date *range*
   * beside it. A bare duration is not enough: a grouped company's header
   * carries one ("2 yrs 2 mos"), and taking that as a role read the header
   * as the entry and its roles as its tail.
   */
  function looksLikeRole(spans) {
    return spans.length >= 2 && (isDateRange(spans[1]) || isDateRange(spans[2]));
  }

  /** Outbound links inside an entry, excluding LinkedIn's own. */
  function rowLinks(row) {
    const out = [];
    for (const a of safeQueryAll(row, 'a[href]')) {
      if (safeClosest(a, ROW_SEL) !== row) continue;
      const href = a.getAttribute('href') || '';
      if (!/^https?:/i.test(href)) continue;
      if (/^https?:\/\/([a-z0-9-]+\.)*(linkedin\.com|licdn\.com)\//i.test(href) && !/\/redir\/|\/safety\/go/i.test(href)) continue;
      out.push(href);
    }
    return out;
  }

  /**
   * Every entry under a root, as span lists — the leaf entries, with a
   * grouped company's name handed down to each role beneath it.
   *
   * LinkedIn renders several roles at one employer as a company header with
   * the roles nested inside it. Reading every descendant row flat turned the
   * header into a job with no company and each role into a job whose company
   * was its employment type. A row that contains rows is a group, not an
   * entry; its first string is the company and it is spliced into each role
   * where the company would have been.
   */
  function rowsFrom(root, limit) {
    const rows = [];
    if (!root) return rows;
    const cap = limit || 40;

    const all = safeQueryAll(root, ROW_SEL);
    const topLevel = all.filter((el) => {
      const parentRow = safeClosest(el.parentElement, ROW_SEL);
      return !parentRow || !root.contains(parentRow);
    });

    const push = (spans, el) => {
      if (!spans.length) return;
      spans.links = rowLinks(el);
      rows.push(spans);
    };

    /*
     * One entry, or a group of them. A group is a company header whose
     * nested rows read as roles — a title with a date beside it. Anything
     * else nested under an entry (an endorsement count under a skill, a
     * "Skills:" line or a description under a role) is part of that entry
     * and is appended to its own strings, where tailFields sorts it out.
     * Treating "has nested text" as "is a group" threw the parent's own
     * strings away and filed the nested line as an entry of its own.
     */
    const readEntry = (raw, inheritedCompany, depth) => {
      if (rows.length >= cap || depth > 3) return;
      const row = unwrap(raw);
      const spans = rowSpans(row);
      const children = nestedRows(row).map(unwrap);
      const childSpans = children.map((c) => rowSpans(c));
      const roles = children.filter((c, i) => looksLikeRole(childSpans[i]) || nestedRows(c).some((g) => looksLikeRole(rowSpans(unwrap(g)))));

      if (roles.length && !looksLikeRole(spans)) {
        // A company header with roles beneath it. Its first string names the
        // company; each role is read as its own entry with that name.
        const company = spans[0] || inheritedCompany || '';
        for (const sub of roles) readEntry(sub, company, depth + 1);
        return;
      }

      const merged = spans.slice();
      if (inheritedCompany) {
        // The role's own second string is its employment type, or repeats the
        // company; either way the result is the "Company · Type" form a flat
        // row uses, and never the company twice.
        const second = merged[1] || '';
        const names = second && second.split('·')[0].trim().toLowerCase() === inheritedCompany.toLowerCase();
        if (!names) {
          const type = second && !looksLikeDateRange(second) ? second : '';
          merged.splice(1, type ? 1 : 0, type ? `${inheritedCompany} · ${type}` : inheritedCompany);
        }
      }
      // Whatever else sits under the entry belongs to it.
      children.forEach((c, i) => {
        if (roles.includes(c)) return;
        for (const t of childSpans[i]) merged.push(t);
      });
      push(merged, row);
    };

    for (const row of topLevel) readEntry(row, '', 0);
    return rows;
  }

  const sectionRows = (anchorId, limit, doc) => rowsFrom(sectionContainer(anchorId, doc), limit);

  /** The longest string in a section — its body copy rather than its chrome. */
  function sectionText(anchorId, doc) {
    let best = '';
    for (const spans of sectionRows(anchorId, 8, doc)) {
      for (const s of spans) if (s.length > best.length) best = s;
    }
    return best;
  }

  /*
   * The row mappers are separate from where the rows came from, because the
   * profile card and the "Show all" page render the same fields in the same
   * order — so both feed these, and so does the generic component payload.
   */
  /*
   * Declarations, not `const` arrows: DETAILS_PAGES is built at load time and
   * names all three, so an arrow assigned further down the file is still in
   * its temporal dead zone when that table is evaluated — which throws before
   * the content script has registered a single listener.
   */
  // The same month names the date formatter already keeps, as an alternation.
  const MONTH_ALT = MONTHS.slice(1).join('|');
  const DATE_RANGE_RE = new RegExp(
    `^(?:(?:${MONTH_ALT})[a-z]*\\.?\\s*)?\\d{4}\\s*[–—-]\\s*(?:present|(?:(?:${MONTH_ALT})[a-z]*\\.?\\s*)?\\d{4})` +
      `|^present\\b|^\\d+\\s*(?:yrs?|mos?|years?|months?)\\b`,
    'i'
  );

  /** "Jan 2020 - Present", "2019 - 2023", "2 yrs 3 mos" — a date, not a name. */
  function looksLikeDateRange(s) {
    return DATE_RANGE_RE.test(String(s == null ? '' : s).trim());
  }

  const DURATION_ONLY_RE = /^(?:present\b|\d+\s*(?:yrs?|mos?|years?|months?)\b)/i;
  /** A range — two ends, or an end and "Present" — and not merely a length. */
  function isDateRange(s) {
    const t = String(s == null ? '' : s).trim();
    return DATE_RANGE_RE.test(t) && !DURATION_ONLY_RE.test(t);
  }

  /**
   * Restores a column the markup never rendered.
   *
   * Unlike the component payload, rendered rows are unlabelled spans — an
   * absent field is simply not there, so a role with no company line arrives
   * as [title, dates] and every positional read is one column out. A date
   * range sitting where a company belongs is unambiguous enough to correct:
   * put the blank back and the rest of the row lines up again.
   */
  function realignDates(spans, at) {
    const cols = spans.slice();
    if (cols[at] && looksLikeDateRange(cols[at]) && !looksLikeDateRange(cols[at + 1] || '')) {
      cols.splice(at, 0, '');
    }
    return cols;
  }

  const LOCATION_TYPE_RE = /\b(remote|hybrid|on-site|onsite)\b/i;
  /** Short, no sentence punctuation, and either a comma, a dot or a place word. */
  function looksLikeLocation(s) {
    const t = String(s || '').trim();
    if (!t || t.length > 80) return false;
    if (/[.!?]\s/.test(t)) return false;
    return /,|·/.test(t) || LOCATION_TYPE_RE.test(t) || /^[A-Z][\w' .-]+(?:, [A-Z][\w' .-]+)*$/.test(t);
  }

  /**
   * The tail of a row — everything after the four positional fields — sorted
   * into what it is: a "Skills:" line, a "Grade:" line, an "Activities and
   * societies:" line, and the prose that is the description.
   */
  function tailFields(spans) {
    const out = { skills: [], grade: '', activities: '', description: [] };
    for (const raw of spans) {
      const t = String(raw || '').trim();
      if (!t) continue;
      let m;
      if ((m = t.match(/^Skills?:\s*(.+)$/i))) {
        out.skills.push(...m[1].split(/\s*·\s*|\s*,\s*/).map((x) => x.trim()).filter(Boolean));
      } else if ((m = t.match(/^Grade:\s*(.+)$/i))) {
        out.grade = m[1].trim();
      } else if ((m = t.match(/^Activities( and societies)?:\s*(.+)$/i))) {
        out.activities = m[2].trim();
      } else {
        out.description.push(t);
      }
    }
    return out;
  }

  function experienceFromRows(rows) {
    return rows.map((row) => {
      const spans = realignDates(row, 1);
      // "Content Daddy · Full-time" — the employment type rides on the company line.
      const companyParts = String(spans[1] || '').split('·').map((x) => x.trim()).filter(Boolean);
      // A location is short and place-like; a description that happens to sit
      // fourth is neither, and used to be filed as the location while the
      // description came out empty.
      const hasLocation = looksLikeLocation(spans[3]);
      const location = hasLocation ? spans[3] : '';
      const tail = tailFields(spans.slice(hasLocation ? 4 : 3));
      const locParts = location.split('·').map((x) => x.trim()).filter(Boolean);
      const locationType = locParts.find((x) => LOCATION_TYPE_RE.test(x)) || '';
      return {
        title: spans[0] || '',
        company: companyParts[0] || '',
        employmentType: companyParts.slice(1).join(' · '),
        location: locParts.filter((x) => x !== locationType).join(', '),
        locationType,
        dates: spans[2] || '',
        current: /present/i.test(spans[2] || ''),
        skills: tail.skills,
        url: (row.links || [])[0] || null,
        description: tail.description.join('\n')
      };
    });
  }

  function educationFromRows(rows) {
    return rows
      .filter((row) => row[0])
      .map((row) => {
        const spans = realignDates(row, 1);
        // "Bachelor of Commerce, Accounting and Finance" is one span.
        const parts = (spans[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
        const tail = tailFields(spans.slice(3));
        return {
          school: spans[0],
          degree: parts[0] || '',
          field: parts.slice(1).join(', '),
          dates: spans[2] || '',
          grade: tail.grade,
          activities: tail.activities,
          skills: tail.skills,
          url: (row.links || [])[0] || null,
          description: tail.description.join('\n')
        };
      });
  }

  function entriesFromRows(rows) {
    return rows
      .filter((spans) => spans[0])
      .map((spans) => {
        const tail = tailFields(spans.slice(3));
        return {
          name: spans[0],
          detail: spans[1] || '',
          dates: spans[2] || '',
          // Was hard-coded to null on the only live path, so every credential,
          // publication and featured card lost the one thing worth keeping.
          url: (spans.links || [])[0] || null,
          skills: tail.skills,
          description: tail.description.join('\n')
        };
      });
  }

  function experienceFromDom(doc) {
    return experienceFromRows(sectionRows('experience', 40, doc));
  }

  function educationFromDom(doc) {
    return educationFromRows(sectionRows('education', 40, doc));
  }

  /** Rows a skills section carries that are not skills. */
  const NOT_A_SKILL = /^\d+\s+endorsements?$|^endorsed by\b|\d+\s+experiences? across|^show all/i;

  function skillsFromDom(doc) {
    const out = [];
    const seen = new Set();
    // Nested <li>s (a skill's endorsement list) repeat the name; dedupe.
    for (const spans of sectionRows('skills', 80, doc)) {
      const name = spans[0];
      if (!name || seen.has(name) || NOT_A_SKILL.test(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  }


  /* ------------------------------------------------------------------ *
   * Pagination health
   *
   * LinkedIn's activity pagination degrades and then stops well before an
   * account's full history. This tracks that honestly so the popup can say
   * "LinkedIn stopped returning more" rather than implying the account was
   * exhausted.
   * ------------------------------------------------------------------ */
  class PageTracker {
    constructor(label) {
      this.label = label;
      this.pages = 0;
      this.yields = [];
      this.declineStreak = 0;
      this.warned = false;
      this.stoppedEarly = false;
      this.reason = '';
    }

    /** Returns 'stop' when the page carried nothing new. */
    record(fresh) {
      const prev = this.yields.length ? this.yields[this.yields.length - 1] : null;
      this.pages++;
      this.yields.push(fresh);

      if (fresh === 0) {
        this.stoppedEarly = true;
        this.reason = `${this.label} returned a page with no new posts after ${this.pages} page(s).`;
        return 'stop';
      }

      if (prev != null && fresh < prev) this.declineStreak++;
      else this.declineStreak = 0;

      if (this.declineStreak >= L.DECLINE_WARN_STREAK && !this.warned) {
        this.warned = true;
        log(
          'warn',
          `Yield is falling off (${this.yields.slice(-4).join(' → ')} per page). LinkedIn usually stops ` +
            'returning older posts well before an account runs out.'
        );
      }
      return 'continue';
    }

    summary(collected) {
      if (this.stoppedEarly) {
        return `Collected ${collected} posts — LinkedIn stopped returning more.`;
      }
      return `Collected ${collected} posts.`;
    }
  }

  /* ------------------------------------------------------------------ *
   * Strategy A — Voyager activity feed
   * ------------------------------------------------------------------ */
  async function harvestViaVoyager(profile, add) {
    if (!CFG.posts.enabled) throw new Error('endpoint not configured');

    const tracker = new PageTracker('Voyager feed');
    S.pagination = tracker; // published now so an abort still reports its page history
    const size = CFG.posts.pageSize || 20;
    let start = Number(resumeCursor('voyager') || 0) || 0;
    let token = resumeCursor('token');
    if (start || token) log('info', 'Resuming pagination from the saved cursor.');

    while (S.collected < S.cfg.maxPosts) {
      if (S.stop) throw new Abort('stopped');

      const { raw, data } = await voyagerGet(CFG.posts, {
        publicId: profile.publicId,
        profileUrn: profile.profileUrn || '',
        profileId: profile.profileUrn ? VY.urnId(profile.profileUrn) : '',
        start,
        count: size,
        paginationToken: token || ''
      });

      // Prefer the resolved element list; fall back to scanning included[]
      // by type, which survives a change in how `data` links to its elements.
      // The fallback entities are flat, so they get resolved on the way out.
      let elements = firstArray(data, ['elements', 'items', 'updates']) || [];
      if (!elements.length) elements = resolvedOfType(raw, /Update$|UpdateV2$/);

      const before = S.collected;
      for (const el of elements) {
        const post = mapUpdate(el);
        if (post) add(post);
        if (S.collected >= S.cfg.maxPosts) break;
      }
      const fresh = S.collected - before;

      if (tracker.record(fresh) === 'stop') break;
      pageLog(tracker.pages, 'Page');
      if (S.collected >= S.cfg.maxPosts) break;

      // Advance the cursor.
      if (CFG.posts.usePaginationToken) {
        const next = deepFind(data, 'paginationToken') || deepFind(raw, 'paginationToken');
        if (!next || next === token) {
          tracker.stoppedEarly = true;
          tracker.reason = 'LinkedIn stopped issuing a pagination token.';
          break;
        }
        token = next;
        emit(MSG.C_CURSOR, { kind: 'token', value: token });
      } else {
        const paging = deepFindObject(data, (n) => n.start != null && n.count != null);
        const total = paging ? num(paging.total) : null;
        start += size;
        if (total != null && start >= total) {
          log('info', `Reached the end of the feed (${total} reported).`);
          break;
        }
        emit(MSG.C_CURSOR, { kind: 'voyager', value: start });
      }

      await pause(U.randOf(L.PAGE_DELAY));
    }

    return S.collected > 0;
  }

  function firstArray(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) if (Array.isArray(obj[k]) && obj[k].length) return obj[k];
    for (const k of keys) {
      if (obj.data && Array.isArray(obj.data[k]) && obj.data[k].length) return obj.data[k];
    }
    return null;
  }

  function deepFind(node, key) {
    const hit = VY.collect(node, (n) => typeof n[key] === 'string' && n[key], { limit: 1 })[0];
    return hit ? hit[key] : null;
  }

  const deepFindObject = (node, pred) => VY.collect(node, pred, { limit: 1 })[0] || null;

  /* ------------------------------------------------------------------ *
   * Strategy B — the activity page's embedded payload
   *
   * The server renders the first page of activity into the document. There is
   * no public offset parameter, so this yields exactly one page — which is
   * reported as such rather than dressed up as the whole history.
   * ------------------------------------------------------------------ */
  async function harvestViaEmbedded(profile, add) {
    // On the activity page the payload comes straight out of the document, so
    // this strategy can run start to finish without a single request — and
    // apiGet is where the stop check used to live.
    throwIfStopped();
    const tracker = new PageTracker('Embedded payload');
    S.pagination = tracker;
    const url = U.activityUrl(profile.publicId);
    const onActivityPage = /\/recent-activity\//.test(location.pathname);

    const pool = onActivityPage ? mergePayloads(payloadsFromRoot(document)) : await fetchPagePayloads(url);

    let updates = resolvedOfType(pool, /Update$|UpdateV2$/);
    if (!updates.length) {
      // Nothing matched by type — fall back to any entity carrying an
      // activity URN, which is the one thing every update shape has. These
      // are URN-only stubs; the detail pass fills them in.
      updates = VY.findUrns(pool, 'urn:li:activity:').map((u) => ({ entityUrn: u }));
    }

    const before = S.collected;
    for (const el of updates) {
      const post = mapUpdate(el);
      if (post) add(post);
      if (S.collected >= S.cfg.maxPosts) break;
    }
    const fresh = S.collected - before;
    tracker.record(fresh);

    if (fresh && S.collected < S.cfg.maxPosts) {
      tracker.stoppedEarly = true;
      tracker.reason = 'Only the server-rendered first page is available without the Voyager feed endpoint.';
      log(
        'warn',
        `The page payload held ${fresh} post(s) — that is the first page only. ` +
          'Configure the Voyager feed endpoint (ENDPOINTS.md) to page further back.'
      );
    }

    return fresh > 0;
  }

  /* ------------------------------------------------------------------ *
   * Strategy C — scroll the rendered activity feed
   *
   * Anchored on `urn:li:activity:` appearing in an element attribute rather
   * than on any class name: the URN is the one thing that has to stay put for
   * LinkedIn's own code to work.
   * ------------------------------------------------------------------ */
  const URN_ATTRS = ['data-urn', 'data-id', 'data-entity-urn', 'data-activity-urn'];
  const URN_SEL = URN_ATTRS.map((a) => `[${a}*="urn:li:activity:"]`).join(',');

  /** The activity URN an element carries in any of the attributes LinkedIn uses. */
  function activityUrnOf(el) {
    for (const a of URN_ATTRS) {
      let v = '';
      try {
        v = el.getAttribute(a) || '';
      } catch (_) {
        continue;
      }
      // The post's own URN, not a comment or reaction URN that embeds it:
      // those sit inside the card and would read as a second post.
      if (/^urn:li:activity:\d+/.test(v)) return v;
    }
    return '';
  }

  /**
   * The card that owns a URN node.
   *
   * The attribute is not always on the card's root — sometimes it sits on an
   * inner element, and reading from there meant the text, media and counts
   * (its siblings) were never found. Climb until the next step up would take
   * in another post.
   */
  function cardOf(el, urnCount) {
    const top = document.querySelector('main') || document.body;
    // How many distinct posts each ancestor holds, counted once per harvest.
    // Asking each ancestor with querySelectorAll instead was quadratic: a
    // thousand-card feed cost a second per round on four cores, and rounds
    // repeat for the length of the scroll.
    const counts = urnCount || countUrnsPerAncestor([el], top);
    let card = el;
    for (let i = 0; i < 12; i++) {
      const parent = card.parentElement;
      if (!parent || parent === top || parent === document.body || parent === document.documentElement) break;
      if ((counts.get(parent) || 0) > 1) break; // the next step up takes in another post
      card = parent;
    }
    return card;
  }

  /** For every ancestor of the given URN nodes, how many of them it contains. */
  function countUrnsPerAncestor(nodes, top) {
    const counts = new Map();
    const counted = new Map(); // ancestor -> set of activity ids beneath it
    for (const n of nodes) {
      // A reshare's inner URN belongs to its outer card; count the pair once.
      let outerMost = n;
      for (let a = n.parentElement; a && a !== top; a = a.parentElement) {
        if (activityUrnOf(a)) outerMost = a;
      }
      if (outerMost !== n) continue;
      const id = VY.activityId(activityUrnOf(n));
      for (let a = n.parentElement; a && a !== top && a !== document.body; a = a.parentElement) {
        // The same post's URN on two nested elements is one post, not two.
        let ids = counted.get(a);
        if (!ids) counted.set(a, (ids = new Set()));
        if (ids.has(id)) continue;
        ids.add(id);
        counts.set(a, (counts.get(a) || 0) + 1);
      }
    }
    return counts;
  }

  /**
   * Every post card on the page, once each.
   *
   * A reshare renders the original post *inside* the resharer's card, with
   * its own URN. Reading every URN node flat counted that inner post as a
   * second post of the profile's — which it is not — and gave the outer one
   * the original's text, because the original's body is the longer string.
   * A URN node with a URN ancestor is the inner card: it is recorded on the
   * outer as what was reshared, and not as a post.
   */
  function harvestFeedCards(alreadySeen) {
    const found = [];
    const seen = new Set();
    const nodes = safeQueryAll(document, URN_SEL);

    const innerOf = new Map(); // outer activityId -> inner node
    const inner = new Set();
    for (const el of nodes) {
      const ownId = VY.activityId(activityUrnOf(el));
      // The nearest URN ancestor that is a *different* post. LinkedIn wraps a
      // card in a data-id holder carrying the same URN as the data-urn inside
      // it; read as a reshare of itself, the card's text and media were
      // emptied into `repost`.
      let outer = safeClosest(el.parentElement, URN_SEL);
      while (outer && VY.activityId(activityUrnOf(outer)) === ownId) outer = safeClosest(outer.parentElement, URN_SEL);
      if (!outer) continue;
      const outerId = VY.activityId(activityUrnOf(outer));
      if (!outerId || outerId === ownId) continue;
      inner.add(el);
      if (!innerOf.has(outerId)) innerOf.set(outerId, el);
    }

    const top = document.querySelector('main') || document.body;
    const urnCount = countUrnsPerAncestor(nodes, top);
    for (const el of nodes) {
      if (inner.has(el)) continue;
      const activityId = VY.activityId(activityUrnOf(el));
      if (!activityId || seen.has(activityId)) continue;
      // An inner node carrying the same URN as its holder: read from the
      // holder, which is the outermost element of this post.
      let holder = safeClosest(el.parentElement, URN_SEL);
      if (holder && VY.activityId(activityUrnOf(holder)) === activityId) continue;
      seen.add(activityId);
      // Every round re-read every card on the page and then threw away the
      // ones already collected. Reading only the new ones keeps a round's
      // cost proportional to what it adds, not to the length of the feed.
      if (alreadySeen && alreadySeen.has(activityId)) continue;
      found.push(readCard(el, activityId, innerOf.get(activityId) || null, urnCount));
    }
    return found;
  }

  /** "…see more" / "see less" and the ellipsis LinkedIn prints before it. */
  const SEE_MORE_RE = /\s*(?:…|\.\.\.)?\s*(?:see|show)\s+(?:more|less)\s*$/i;
  const CARD_CHROME = '.social-details-social-counts, .feed-shared-social-action-bar, .update-components-header, .update-components-actor, .feed-shared-actor, .comments-comments-list';

  /**
   * The post's own words.
   *
   * Tried in order of how specifically the selector names the body, and the
   * longest candidate wins — but only among candidates that are neither the
   * card's chrome (author block, social bar) nor a reshared inner card. The
   * text of any button inside is removed, which is how "…see more" stopped
   * being part of the post.
   */
  function cardText(card, exclude) {
    const SELS = [
      '.update-components-text',
      '.feed-shared-update-v2__description',
      '.feed-shared-inline-show-more-text',
      '[class*="update-components-text"]',
      '.feed-shared-text',
      '.break-words',
      '[dir="ltr"]'
    ];
    let best = '';
    for (const sel of SELS) {
      for (const n of safeQueryAll(card, sel)) {
        if (exclude && exclude.contains(n)) continue;
        if (safeClosest(n, CARD_CHROME)) continue;
        let t = String(n.innerText || n.textContent || '');
        for (const b of safeQueryAll(n, 'button')) {
          const bt = String(b.textContent || '').trim();
          if (!bt) continue;
          // The button sits at the end of the text, so remove the *last*
          // occurrence — a post that itself says "see more" keeps its words.
          const at = t.lastIndexOf(bt);
          if (at >= 0) t = t.slice(0, at) + t.slice(at + bt.length);
        }
        t = t.replace(SEE_MORE_RE, '').replace(/[ \t]+\n/g, '\n').trim();
        if (t.length > best.length) best = t;
      }
      // The most specific selector that answered is the answer; the generic
      // ones below it are only for markup where the specific ones are absent.
      if (best && sel !== '[dir="ltr"]' && sel !== '.break-words') break;
    }
    return best;
  }

  /** Content images and videos under a card, however the markup carries them. */
  function cardMedia(card, exclude) {
    const media = [];
    const seenUrl = new Set();
    const addImage = (src, alt) => {
      if (!src || !/licdn\.com\/dms\/image/.test(src)) return;
      if (NON_CONTENT_IMAGE.test(src)) return;
      if (seenUrl.has(src)) return;
      seenUrl.add(src);
      media.push({ type: 'image', url: src, alt: alt || '' });
    };
    for (const img of safeQueryAll(card, 'img')) {
      if (exclude && exclude.contains(img)) continue;
      /*
       * A feed image below the fold has no `src` yet — LinkedIn parks the
       * real URL on data-delayed-url until the image scrolls into view.
       */
      const src = img.currentSrc || img.src || img.getAttribute('data-delayed-url') || img.getAttribute('data-li-src') || '';
      addImage(src, img.getAttribute('alt') || '');
    }
    // An image painted as a CSS background is still an image.
    for (const el of safeQueryAll(card, '[style*="background-image"]')) {
      if (exclude && exclude.contains(el)) continue;
      const m = String(el.getAttribute('style') || '').match(/url\((['"]?)(.*?)\1\)/i);
      if (m) addImage(m[2].replace(/&quot;/g, ''), el.getAttribute('aria-label') || '');
    }
    /*
     * LinkedIn's video player carries its source list as JSON in a
     * data-sources attribute — the only place a progressive URL is visible
     * from the DOM at all.
     */
    for (const v of safeQueryAll(card, 'video,[data-sources]')) {
      if (exclude && exclude.contains(v)) continue;
      const raw = v.getAttribute('data-sources');
      const poster = v.getAttribute('poster') || v.getAttribute('data-poster-url') || '';
      if (raw) {
        try {
          for (const sSrc of JSON.parse(raw)) {
            if (sSrc && sSrc.src && /^https?:/i.test(sSrc.src)) {
              const adaptive = /\.m3u8|\.mpd/.test(sSrc.src);
              media.push({
                type: 'video',
                url: adaptive ? null : sSrc.src,
                manifestUrl: adaptive ? sSrc.src : null,
                protocol: sSrc.type || null,
                thumbnail: poster || null,
                downloadable: !adaptive
              });
            }
          }
        } catch (_) {
          /* attribute shape changed; the post is still recorded */
        }
      } else if (v.src && /^https?:/i.test(v.src)) {
        media.push({ type: 'video', url: v.src, thumbnail: poster || null, downloadable: true });
      }
    }
    return media;
  }

  function readCard(el, activityId, innerNode, urnCount) {
    const card = cardOf(el, urnCount);
    const exclude = innerNode && card.contains(innerNode) ? innerNode : null;

    let text = '';
    let media = [];
    let repost = null;
    try {
      text = cardText(card, exclude);
      media = cardMedia(card, exclude);
      if (exclude) {
        const innerId = VY.activityId(activityUrnOf(exclude));
        repost = {
          activityId: innerId || null,
          urn: innerId ? `urn:li:activity:${innerId}` : null,
          postUrl: innerId ? U.postUrlFromActivityId(innerId) : null,
          text: cardText(exclude, null),
          media: cardMedia(exclude, null)
        };
      }
    } catch (_) {
      /* a card that will not read is still worth recording by URN */
    }

    const counts = readCounts(card, exclude);
    const derived = timestampFromActivityId(activityId);

    /*
     * A card that still shows a "…see more" is showing the first lines, not
     * the post. expandSeeMore() opens them before each read; one that stays
     * closed (LinkedIn re-renders, the click landed on a detached button) is
     * recorded as truncated so the detail pass fetches the whole body.
     */
    let textTruncated = false;
    for (const b of safeQueryAll(card, 'button')) {
      if (exclude && exclude.contains(b)) continue;
      if (/^(?:…|\.\.\.)?\s*(?:see|show)\s+more$/i.test(String(b.textContent || '').trim())) {
        textTruncated = true;
        break;
      }
    }

    return {
      activityId,
      urn: `urn:li:activity:${activityId}`,
      postUrl: U.postUrlFromActivityId(activityId),
      type: media.some((m) => m.type === 'video') ? 'video' : media.length ? 'image' : repost ? 'repost' : 'text',
      text,
      textTruncated,
      repost,
      publishedAt: derived,
      timestampSource: derived ? 'derived-from-urn' : 'unknown',
      reactions: counts.reactions,
      reactionsByType: {},
      comments: counts.comments,
      reposts: counts.reposts,
      media,
      mediaCount: media.length,
      // The DOM never carries the full picture: the detail pass fills it in.
      detailFetched: false
    };
  }

  /**
   * The three counts under a card. Known selectors first; failing those, the
   * words themselves — "1,234 reactions", "56 comments" — wherever they sit.
   */
  function readCounts(el, exclude) {
    const out = { reactions: null, comments: null, reposts: null };
    const NUM = /([\d.,]+[KMB]?)/i;
    const grab = (sels, key) => {
      for (const sel of sels) {
        for (const n of safeQueryAll(el, sel)) {
          if (exclude && exclude.contains(n)) continue;
          const label = n.getAttribute('aria-label') || n.innerText || n.textContent || '';
          const m = label.replace(/,/g, '').match(NUM);
          if (m) {
            out[key] = parseCompact(m[1]);
            return true;
          }
        }
      }
      return false;
    };
    grab(['[class*="social-details-social-counts__reactions-count"]', '[aria-label*="reaction" i]', '[data-reaction-details]'], 'reactions');
    grab(['[class*="social-details-social-counts__comments"]', '[aria-label*="comments" i]'], 'comments');
    grab(['[class*="social-details-social-counts__reposts"]', '[aria-label*="reposts" i]'], 'reposts');

    /*
     * The words themselves — but only the strip's words. Scanning the whole
     * card found "3 comments" in a post body, or a comment's own count. And a
     * strip that exists but lacks a counter means that count is zero:
     * LinkedIn omits the comments and reposts counters entirely at zero.
     */
    const strips = safeQueryAll(el, '.social-details-social-counts, .feed-shared-social-action-bar, [class*="social-counts"]').filter(
      (n) => !(exclude && exclude.contains(n))
    );
    if (strips.length) {
      let text = strips.map((n) => String(n.textContent || '') + ' ' + safeQueryAll(n, '[aria-label]').map((a) => a.getAttribute('aria-label')).join(' ')).join(' ');
      const words = (re) => {
        const m = text.replace(/,/g, '').match(re);
        return m ? parseCompact(m[1]) : null;
      };
      if (out.reactions == null) out.reactions = words(/([\d.]+[KMB]?)\s*(?:reactions?|likes?)\b/i);
      if (out.comments == null) out.comments = words(/([\d.]+[KMB]?)\s*comments?\b/i);
      if (out.reposts == null) out.reposts = words(/([\d.]+[KMB]?)\s*reposts?\b/i);
      if (out.comments == null) out.comments = 0;
      if (out.reposts == null) out.reposts = 0;
    }
    return out;
  }

  /**
   * Opens every "…see more" on the page, so the harvested text is the post
   * and not its first two lines. Only ever expands — never collapses — and is
   * bounded per round, because it is a click on the page like any other.
   */
  function expandSeeMore(limit) {
    let n = 0;
    for (const b of safeQueryAll(document, 'button')) {
      if (n >= (limit || 40)) break;
      // textContent, not innerText: innerText forces a layout per button, and
      // this runs over every button on the page every round.
      const t = String(b.textContent || '').trim();
      const cls = String(b.className || '');
      const isSeeMore = /^(?:…|\.\.\.)?\s*(?:see|show)\s+more$/i.test(t) || (/see-more/.test(cls) && !/less/i.test(t));
      if (!isSeeMore) continue;
      try {
        b.click();
        n++;
      } catch (_) {
        /* a detached button */
      }
    }
    return n;
  }

  async function harvestViaDom(add) {
    if (!/\/recent-activity\//.test(location.pathname)) {
      throw new Error('not on the activity page');
    }
    log('info', 'Scrolling the activity feed. This is the slow path.');

    const tracker = new PageTracker('Feed scroll');
    S.pagination = tracker;
    let idleRounds = 0;
    let lastHeight = 0;
    let round = 0;

    while (S.collected < S.cfg.maxPosts && round < CFG.dom.maxScrollRounds) {
      if (S.stop) throw new Abort('stopped');
      await waitWhilePaused();

      const before = S.collected;
      // The card renders the first lines and a "…see more"; the post is
      // behind the button. Opened before reading, so the text is the post.
      expandSeeMore();
      for (const p of harvestFeedCards(S.seen)) {
        add(p);
        if (S.collected >= S.cfg.maxPosts) break;
      }
      const fresh = S.collected - before;
      round++;

      if (S.collected >= S.cfg.maxPosts) break;

      // Randomised pauses: a metronome-steady scroll is the single most
      // obvious automation tell there is.
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await pause(U.randOf(L.PAGE_DELAY));
      await clickShowMore();

      /*
       * A round that produced no new post is an idle round, full stop.
       *
       * This used to also require `document.body.scrollHeight` to be exactly
       * unchanged, and a LinkedIn feed's height is never exactly unchanged —
       * lazy images resolve, skeletons collapse, the "Show more results"
       * button comes and goes. So the counter reset on almost every round, the
       * loop never reached its idle ceiling, and a feed that had run out kept
       * scrolling for the full 60 rounds at six to fourteen seconds each.
       * That is the run that "does not stop" once the posts have ended.
       *
       * Height is still read, but only to stop sooner: a page that has also
       * stopped growing is done twice over.
       */
      const h = document.body.scrollHeight;
      if (fresh === 0) idleRounds += h === lastHeight ? 2 : 1;
      else idleRounds = 0;
      lastHeight = h;

      if (fresh > 0) {
        tracker.record(fresh);
        pageLog(tracker.pages, 'Scroll');
      }
      if (idleRounds >= CFG.dom.idleRoundsBeforeStop) {
        tracker.stoppedEarly = true;
        tracker.reason = 'The feed stopped loading new posts.';
        log('info', `The feed stopped producing new posts — ending the scroll after ${round} round(s).`);
        break;
      }
    }

    if (round >= CFG.dom.maxScrollRounds) {
      tracker.stoppedEarly = true;
      tracker.reason = 'Reached the scroll-round ceiling.';
    }
    return S.collected > 0;
  }

  /** LinkedIn paginates the activity feed behind a "Show more results" button. */
  async function clickShowMore() {
    try {
      const buttons = [...document.querySelectorAll('button')].filter((b) => {
        const t = (b.innerText || '').trim().toLowerCase();
        return t === 'show more results' || t === 'load more' || t === 'show more';
      });
      if (buttons.length) {
        buttons[buttons.length - 1].click();
        await pause(U.randOf(L.PAGE_DELAY));
      }
    } catch (_) {
      /* the button is optional; infinite scroll usually carries it */
    }
  }

  /* ------------------------------------------------------------------ *
   * Per-post detail
   * ------------------------------------------------------------------ */
  /** What a media item points at — the identity two passes must agree on. */
  const mediaKey = (m) => `${m.type}|${m.url || m.manifestUrl || m.title || ''}`;

  /**
   * Union of two media lists, richer record winning on a collision.
   *
   * The detail pass used to replace `media` outright. Whenever the permalink
   * page returned fewer items than the harvest had already found — a carousel
   * that renders lazily, a video whose progressive variant appears on only one
   * of the two responses — that quietly deleted media the run had in hand.
   * Adding can only improve the archive; replacing could shrink it.
   */
  function mergeMedia(a, b) {
    const out = [];
    const at = new Map();
    for (const m of [].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])) {
      if (!m || typeof m !== 'object') continue;
      const k = mediaKey(m);
      if (at.has(k)) {
        const i = at.get(k);
        if (Object.keys(m).length > Object.keys(out[i]).length) out[i] = m;
        continue;
      }
      at.set(k, out.length);
      out.push(m);
    }
    return out;
  }

  /**
   * Applies the "Skip video" option to one post. Returns true if it removed
   * anything.
   *
   * This has to run at both ends of the pipeline. The harvest strips the
   * video, but the detail pass then merges in a fresh media list read from the
   * permalink page — which puts the video straight back. Stripping only on the
   * way in meant the option worked right up until the post got enriched.
   */
  function stripVideos(post) {
    if (!S.cfg || !S.cfg.skipVideos) return false;
    if (!Array.isArray(post.media) || !post.media.some((m) => m.type === 'video')) return false;
    post.media = post.media.filter((m) => m.type !== 'video');
    post.mediaCount = post.media.length;
    post.videosSkipped = true;
    /*
     * Re-typed by the same rule the detail pass uses, so both paths agree.
     * The old rule here called whatever survived an image if the list was not
     * empty — so a post carrying a video *and* a document filed under
     * Posts/Photos/ with a PDF in it, and posts.csv said `image`.
     */
    if (post.type === 'video') post.type = classifyByMedia(post.media, 'text');
    return true;
  }

  // The rule itself lives in utils.js because the worker has to apply the same
  // one when it decides which posts to hand back to a re-hosted run.
  function needsDetail(post) {
    return CFG.alwaysFetchDetail || U.postNeedsDetail(post);
  }

  async function fetchPostDetail(post) {
    const html = await apiGet(post.postUrl, { expectJson: false });
    const pool = mergePayloads(payloadsFromHtml(html));
    let updates = resolvedOfType(pool, /Update$|UpdateV2$/);
    if (!updates.length) updates = [pool];

    // The permalink page carries the post plus its comment thread; the update
    // whose URN matches is the one wanted.
    let best = null;
    for (const u of updates) {
      const mapped = mapUpdate(u);
      if (!mapped) continue;
      if (mapped.activityId === post.activityId) {
        best = mapped;
        break;
      }
      if (!best) best = mapped;
    }

    /*
     * The rendered markup is the backstop. When LinkedIn does not server-render
     * an embedded payload for a post, the mapping above finds nothing and the
     * fetch reports success with no media — the post's photos are right there
     * in the same HTML response. Read them rather than returning empty-handed.
     */
    if (!best || !best.media.length) {
      const fromHtml = mediaFromHtml(html);
      if (fromHtml.length) {
        if (!best) {
          best = {
            activityId: post.activityId,
            urn: post.urn,
            postUrl: post.postUrl,
            type: post.type,
            text: post.text || '',
            publishedAt: post.publishedAt || null,
            timestampSource: post.timestampSource || 'unknown',
            reactions: post.reactions,
            reactionsByType: post.reactionsByType || {},
            comments: post.comments,
            reposts: post.reposts,
            media: [],
            mediaCount: 0,
            mediaIncomplete: false,
            detailFetched: true
          };
        }
        best.media = mergeMedia(best.media, fromHtml);
        best.mediaCount = best.media.length;
        best.mediaIncomplete = false;
        best.type = classifyByMedia(best.media, best.type);
        log('info', `Read ${fromHtml.length} media item(s) off the rendered post page.`);
      }
    }

    if (!best) throw new Error('no update entity on the permalink page');
    return { mapped: best, pool };
  }

  /** Re-derive a post type once media arrives from a source that had none. */
  function classifyByMedia(media, current) {
    if (current === 'repost' || current === 'poll' || current === 'article') return current;
    if (media.some((m) => m.type === 'document')) return 'document';
    if (media.some((m) => m.type === 'video')) return 'video';
    if (media.some((m) => m.type === 'image')) return 'image';
    return current || 'text';
  }

  async function detailPass() {
    const pending = S.posts.filter(needsDetail);
    if (!pending.length) {
      log('success', 'Full detail already captured — no extra requests needed.');
      return;
    }

    const perPost = (L.DETAIL_DELAY[0] + L.DETAIL_DELAY[1]) / 2000 + L.MIN_REQUEST_GAP_MS / 1000;
    const affordable = Math.max(0, L.SESSION_MAX_REQUESTS - S.requests);
    if (pending.length > affordable) {
      log(
        'warn',
        `${pending.length} post(s) need a detail fetch but only ~${affordable} requests remain in the session ` +
          'budget. The pass will stop cleanly when it runs out.'
      );
    }
    log(
      'info',
      `Fetching detail for ${pending.length} post(s) — roughly ${fmtDuration(pending.length * perPost)}. ` +
        'Stop at any point and export what has been collected.'
    );

    let done = 0;
    let failed = 0;
    let streak = 0;
    const start = Date.now();
    setStage('detail', pending.length);

    for (const post of pending) {
      if (S.stop) break;
      await waitWhilePaused();
      try {
        const { mapped } = await fetchPostDetail(post);
        // Identity comes from the harvest pass; detail only fills content in,
        // and never replaces a value we already have with a null.
        for (const k of Object.keys(mapped)) {
          const v = mapped[k];
          if (k === 'activityId' || k === 'postUrl' || k === 'urn') continue;
          if (k === 'media') {
            post.media = mergeMedia(post.media, v);
            post.mediaCount = post.media.length;
            // The permalink response carries the video the harvest stripped.
            stripVideos(post);
            continue;
          }
          if (k === 'mediaCount') continue; // derived from the merge above
          if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
          /*
           * A nested record is merged field by field, not replaced. The
           * permalink's `repost` carries the original's author and text; the
           * feed's carried the original's media. Replacing wholesale threw
           * the media away, and the reshared_NN files were never written.
           */
          if ((k === 'repost' || k === 'article' || k === 'poll') && v && typeof v === 'object' && post[k] && typeof post[k] === 'object') {
            const merged = Object.assign({}, post[k]);
            for (const f of Object.keys(v)) {
              const fv = v[f];
              if (fv == null || fv === '' || (Array.isArray(fv) && !fv.length)) continue;
              merged[f] = f === 'media' ? mergeMedia(merged.media, fv) : fv;
            }
            post[k] = merged;
            continue;
          }
          post[k] = v;
        }
        post.detailFetched = true;
        /*
         * The permalink page is the authoritative source. If the media was not
         * there either, it is not obtainable — recording that keeps the post
         * from being re-fetched on every subsequent resume, while metadata.txt
         * can still say the post declared media that never arrived.
         */
        if (post.mediaIncomplete) {
          post.mediaIncomplete = false;
          if (!post.media || !post.media.length) post.mediaUnavailable = true;
        }
        /*
         * Cleared, not deleted. The worker merges an update over the stored
         * post with Object.assign, and a key that is simply absent from the
         * incoming object cannot un-set the one already there — so a post that
         * failed a detail fetch and then succeeded on a resume kept its old
         * error forever, and metadata.txt reported "Detail error" for a post
         * that had in fact been captured perfectly.
         */
        post.error = '';
        emit(MSG.C_POST_UPDATE, { post });
        done++;
        streak = 0;
      } catch (err) {
        if (err instanceof Abort) throw err;
        post.error = err.message;
        failed++;
        streak++;
        emit(MSG.C_FAILED, { activityId: post.activityId, error: err.message });
        emit(MSG.C_POST_UPDATE, { post });
        if (streak >= 5) {
          log('warn', `Detail fetches are failing repeatedly (${err.message}) — skipping the rest of the pass.`);
          break;
        }
      }

      const seen = done + failed;
      bumpStage();
      if (seen % 10 === 0) {
        const rate = seen / ((Date.now() - start) / 1000);
        const left = rate > 0 ? ` · ~${fmtDuration((pending.length - seen) / rate)} left` : '';
        log('info', `Detail ${seen}/${pending.length}${left}`);
      }
      if (seen < pending.length) await pause(U.randOf(L.DETAIL_DELAY));
    }
    log(failed ? 'warn' : 'success', `Detail pass finished — ${done} ok, ${failed} failed.`);
  }

  /* ------------------------------------------------------------------ *
   * Comments
   *
   * Off by default. When on, this is the only part of the run that collects
   * other people's personal data, so it is hard-capped twice over and never
   * follows a commenter's profile link.
   * ------------------------------------------------------------------ */
  function mapComment(c) {
    const author =
      deepFindObject(c, (n) => n.firstName != null || n.publicIdentifier != null || n.headline != null) || {};
    const name =
      [textOf(author.firstName), textOf(author.lastName)].filter(Boolean).join(' ') ||
      textOf(author.name) ||
      textOf(c.commenterName) ||
      '';
    const publicId = author.publicIdentifier || '';

    let at = null;
    for (const n of VY.collect(c, (x) => x.createdAt != null || x.createdTime != null)) {
      at = num(n.createdAt) || num(n.createdTime);
      if (at) break;
    }

    const r = reactionsFrom(c);
    /*
     * The body in either of LinkedIn's Comment shapes: the newer `commentary`
     * (an attributed-text object) or the older `comment` (a values[] list).
     * The actor of the newer shape is a `commenter` with a title.
     */
    const commenter = c.commenter && typeof c.commenter === 'object' ? c.commenter : null;
    const cName = name || (commenter && (textOf(commenter.title) || textOf(commenter.name))) || '';
    const cHeadline = textOf(author.occupation) || textOf(author.headline) || (commenter && textOf(commenter.subtitle)) || '';
    const cUrl =
      (publicId && U.profileUrl(publicId)) ||
      (commenter && commenter.navigationUrl && /^https?:/i.test(commenter.navigationUrl) ? commenter.navigationUrl : null);
    let replyCount = null;
    for (const sd of collectContent(c, (n) => n.numComments != null, { skip: new Set(['replies']), limit: 1 })) {
      replyCount = num(sd.numComments);
    }
    return {
      urn: c.entityUrn || c.urn || null,
      parentUrn: c.parentCommentUrn || c['*parentComment'] || (c.parentComment && c.parentComment.entityUrn) || null,
      author: cName,
      headline: cHeadline,
      profileUrl: cUrl,
      text: textOf(c.commentary) || textOf(c.comment) || textOf(c.commentV2) || textOf(c.message) || textOf(c.text) || '',
      at,
      reactions: r.total,
      replyCount
    };
  }

  /** Identity for de-duping. Comments carry no stable id in every shape. */
  const commentKey = (c) => `${c.author}|${c.at || ''}|${(c.text || '').slice(0, 120)}`;

  async function fetchComments(post) {
    let list = [];
    let truncated = false;

    // A — the Voyager comments finder, paged.
    if (CFG.comments.enabled) {
      const seen = new Set();
      const size = CFG.comments.pageSize || 20;
      let start = 0;
      try {
        for (let page = 0; page < L.MAX_COMMENT_PAGES; page++) {
          const { raw, data } = await voyagerGet(
            CFG.comments,
            {
              activityId: post.activityId,
              activityUrn: post.urn,
              start,
              count: size
            },
            { retries: 0 } // a 4xx here must fail fast, not sit through a 3-min pause per post
          );

          /*
           * The by-type fallback reads the whole payload, so unlike
           * `data.elements` it is not a page — asking for it again returns the
           * same comments. Left in the paging loop it filled the list with
           * duplicates until it hit the 150 cap. Use it once, then stop.
           */
          let batch = firstArray(data, ['elements']);
          let unpaged = false;
          if (!batch) {
            batch = resolvedOfType(raw, /\.Comment$/);
            unpaged = true;
          }
          if (!batch.length) break;

          let fresh = 0;
          for (const c of batch) {
            const m = mapComment(c);
            const key = commentKey(m);
            if (seen.has(key)) continue;
            seen.add(key);
            list.push(m);
            fresh++;
            if (list.length >= L.MAX_COMMENTS_PER_POST) break;
          }

          if (list.length >= L.MAX_COMMENTS_PER_POST) {
            truncated = post.comments != null && post.comments > list.length;
            break;
          }
          // Nothing new on this page means paging has stopped advancing, and
          // another round would only re-read the same thread.
          if (unpaged || fresh === 0) break;

          start += size;
          if (post.comments != null && start >= post.comments) break;
          if (page + 1 >= L.MAX_COMMENT_PAGES) truncated = post.comments != null && post.comments > list.length;
          await pause(U.randOf(L.PAGE_DELAY));
        }
        // A configured endpoint's answer is final, including "no comments" —
        // re-scraping the post page after it would only spend another request.
        return { list, truncated };
      } catch (err) {
        if (err instanceof Abort) throw err;
        log('warn', `Comment finder failed (${err.message}) — reading the post page instead.`);
        list = [];
        truncated = false;
      }
    }

    // B — whatever the permalink page server-rendered. First page only.
    const pool = await fetchPagePayloads(post.postUrl);
    const seen = new Set();
    for (const c of resolvedOfType(pool, /\.Comment$/)) {
      const m = mapComment(c);
      if (!m.text && !m.author) continue;
      const key = commentKey(m);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(m);
      if (list.length >= L.MAX_COMMENTS_PER_POST) break;
    }
    if (list.length && post.comments != null && post.comments > list.length) truncated = true;
    return { list, truncated };
  }

  async function commentPass() {
    const pending = S.posts.filter(U.postNeedsComments);

    /*
     * A post with no comments is finished, and has to be recorded as finished.
     * Skipping it silently left `commentList` undefined, which the worker reads
     * as "still outstanding" — so every resume re-shipped the same finished
     * posts, and once more than the handoff limit were in that state the posts
     * that genuinely needed work sat past the slice boundary and were never
     * handed over at all.
     */
    for (const p of S.posts) {
      if (p.comments === 0 && !Array.isArray(p.commentList)) {
        p.commentList = [];
        p.commentsTruncated = false;
        p.commentsFetchedAt = new Date().toISOString();
        emit(MSG.C_POST_UPDATE, { post: p });
      }
    }

    if (!pending.length) {
      log('info', 'No posts with comments to fetch.');
      return;
    }
    if (!CFG.comments.enabled) {
      log(
        'warn',
        'The Voyager comments endpoint is not configured — only the first page rendered into each ' +
          'post page can be read. See ENDPOINTS.md.'
      );
    }

    const perPost = (L.DETAIL_DELAY[0] + L.DETAIL_DELAY[1]) / 2000 + L.MIN_REQUEST_GAP_MS / 1000;
    log(
      'info',
      `Fetching comments for ${pending.length} post(s) — roughly ${fmtDuration(pending.length * perPost)}. ` +
        `Capped at ${L.MAX_COMMENTS_PER_POST} per post.`
    );

    let done = 0;
    let failed = 0;
    let streak = 0;
    setStage('comments', pending.length);

    for (const post of pending) {
      if (S.stop) break;
      await waitWhilePaused();
      try {
        const r = await fetchComments(post);
        post.commentList = r.list;
        post.commentsTruncated = r.truncated;
        post.commentError = ''; // same merge rule as post.error above
        /*
         * That the pass ran, as a fact and not an inference. A successful fetch
         * that returns nothing left exactly the state of a post the pass never
         * reached — empty list, no error, a non-zero count — so comments.txt
         * told the user "the run ended before the comment pass" for a post the
         * pass had finished, and sent them to re-run the whole scrape for
         * comments already established to be unobtainable.
         */
        post.commentsFetchedAt = new Date().toISOString();
        emit(MSG.C_POST_UPDATE, { post });
        done++;
        streak = 0;
      } catch (err) {
        if (err instanceof Abort) throw err;
        // No list: an empty one read as "fetched, none", and the post was
        // never handed back to a Resume, so its comments stayed uncollected
        // for good. The error is recorded; the list stays outstanding.
        delete post.commentList;
        post.commentError = err.message;
        emit(MSG.C_POST_UPDATE, { post });
        failed++;
        streak++;
        // LinkedIn gates this for some sessions. If it refuses repeatedly it
        // will refuse for every post, so stop rather than burn the budget.
        if (streak >= 3) {
          log('warn', `Comments unavailable (${err.message}) — skipping the rest of the comment pass.`);
          break;
        }
      }
      bumpStage();
      if (done + failed < pending.length) await pause(U.randOf(L.DETAIL_DELAY));
    }
    log(failed ? 'warn' : 'success', `Comment pass finished — ${done} ok, ${failed} failed.`);
  }

  /* ------------------------------------------------------------------ *
   * Logging helpers
   * ------------------------------------------------------------------ */
  function pageLog(page, label) {
    if (page <= 3 || page % 3 === 0) {
      log('info', `${label} ${page}: ${S.collected}/${S.target} collected${etaSuffix()}`);
    }
  }

  function etaSuffix() {
    const done = S.collected - (S.cfg.alreadyCollected || 0);
    const left = S.target - S.collected;
    if (done < 10 || left <= 0) return '';
    const rate = done / ((Date.now() - S.startedAt) / 1000);
    if (!isFinite(rate) || rate <= 0) return '';
    return ` · ~${fmtDuration(left / rate)} left`;
  }

  /* ------------------------------------------------------------------ *
   * Orchestration
   * ------------------------------------------------------------------ */
  async function tryStrategy(name, fn) {
    const before = S.collected;
    try {
      const ok = await fn();
      return ok || S.collected > before;
    } catch (err) {
      if (err instanceof Abort) throw err;
      log('warn', `${name} failed: ${err.message}`);
      return S.collected > before;
    }
  }

  /**
   * The run, with nothing outside a `finally`.
   *
   * `S.active` is set in runToCompletion's prologue — before the `try` that
   * owns the cleanup — so a throw up there (a malformed cfg, or
   * chrome.runtime.connect against an invalidated extension context) left
   * S.active true with nothing to clear it. The listener starts the run
   * without awaiting it, so the rejection was unhandled: no DONE, no error
   * line, the worker waiting in `running` forever, and every later Start in
   * that tab refused with "A scrape is already running in this tab." until the
   * page was reloaded. This wrapper is the outermost guarantee.
   */
  async function run(cfg) {
    try {
      await runToCompletion(cfg);
    } catch (err) {
      const message = (err && err.message) || String(err);
      log('error', message);
      try {
        finish('error', message);
      } catch (_) {
        /* the port is gone too; nothing more to report through */
      }
    } finally {
      S.active = false;
      stopHeartbeat();
    }
  }

  async function runToCompletion(cfg) {
    S.active = true;
    S.stop = false;
    S.paused = false;
    S.cfg = cfg;
    S.seen = new Set(cfg.knownActivityIds || []);
    /*
     * Seeded with posts the worker already holds that still need a detail or
     * comment pass — a run continued in a new tab, or resumed after an
     * interruption, has to finish what the previous instance started. They are
     * already in `seen`, so pagination walks past them rather than re-adding.
     */
    S.posts = Array.isArray(cfg.pendingPosts) ? cfg.pendingPosts.map((p) => Object.assign({}, p)) : [];
    S.collected = cfg.alreadyCollected || 0;
    S.skippedVideos = 0;
    /*
     * Carried, not reset. The DOM strategy re-hosts this same run in a freshly
     * navigated tab, and zeroing here would hand one sitting a second full
     * request allowance — the exact thing SESSION_MAX_REQUESTS exists to stop —
     * while the popup's meter jumped backwards mid-run. A genuine user Resume
     * does start over, and passes 0.
     */
    S.requests = Number(cfg.requestsSoFar) || 0;
    S.target = cfg.maxPosts;
    S.startedAt = Date.now();
    S.pagination = null;
    S.detailLinks = new Set();
    S.stage = 'harvest';
    S.stageDone = 0;
    S.stageTotal = cfg.maxPosts || 0;
    S.stageStartedAt = Date.now();
    connectPort();
    emitProgress(true); // publish the carried-over request count immediately

    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      emit(MSG.C_POSTS, { posts: pending });
      pending = [];
    };
    const add = (post) => {
      if (!post || !post.activityId || S.seen.has(post.activityId)) return false;
      /*
       * "Skip video" drops the video, not the post.
       *
       * It used to discard the whole update — losing the body text, the
       * engagement counts and the permalink along with the stream, with no way
       * to recover them short of re-running. Nothing about a checkbox sitting
       * beside "Profile media" suggests it deletes posts, and the row still
       * belongs in posts.csv either way. The video is stripped, the post stays.
       */
      if (stripVideos(post)) S.skippedVideos++;
      S.seen.add(post.activityId);
      post.index = S.collected;
      post.publicId = cfg.publicId;
      S.posts.push(post);
      S.collected++;
      if (S.stage === 'harvest') S.stageDone = S.collected;
      pending.push(post);
      if (pending.length >= 5) flush();
      emitProgress();
      return true;
    };

    try {
      const phase = cfg.phase || 'main';
      log('info', `Starting ${phase === 'posts-dom' ? 'the feed scroll for' : 'scrape of'} /in/${cfg.publicId}.`);

      const sess = sessionState();
      if (!sess.ok) {
        if (onChallengePage()) requireAttention('challenge', CHALLENGE_MSG);
        else requireAttention('login', `${LOGIN_MSG} — ${sess.why}`);
        await waitWhilePaused();
      }

      /* ---- profile ---- */
      let profile = cfg.profile || null;
      if (phase !== 'posts-dom') {
        profile = await getProfile(cfg.publicId);
        S.profile = profile;
        emit(MSG.C_PROFILE, { profile });
        log(
          'success',
          `${profile.fullName || cfg.publicId}${profile.headline ? ' — ' + profile.headline.slice(0, 60) : ''}`
        );
        emitProgress(true);
      } else {
        S.profile = profile;
      }

      /*
       * The profile is published above, so unwinding here still exports it.
       * Without this the run walked into the posts phase carrying a Stop that
       * the profile passes had only used to break their own loops.
       */
      throwIfStopped();

      /* ---- posts ---- */
      if (cfg.includePosts) {
        let via = null;

        if (phase !== 'posts-dom') {
          if (CFG.posts.enabled) {
            if (await tryStrategy('Voyager feed', () => harvestViaVoyager(profile, add))) via = 'voyager';
          } else {
            log('info', 'Voyager feed endpoint is not configured — see ENDPOINTS.md.');
          }
          if (!via && CFG.embeddedJson.enabled) {
            if (await tryStrategy('Embedded payload', () => harvestViaEmbedded(profile, add))) via = 'embedded';
          }

          /*
           * Escalate to the rendered feed when the run is still short of what
           * was asked for. Strategy B is first-page-only by construction, so
           * reaching a target of 100 through it alone is impossible — but
           * Strategy A pages properly, so if *it* ran and stopped, that is
           * LinkedIn's answer and re-scrolling would only spend the request
           * budget to rediscover the same posts.
           */
          /*
           * Checked again right here, and not only at the top of the phase:
           * everything between the two can set it, and this is the branch that
           * hands the run to a fresh page. Escalating with a Stop pending is
           * what made Stop look like it did nothing.
           */
          throwIfStopped();

          const onActivityPage = /\/recent-activity\//.test(location.pathname);
          if (CFG.dom.enabled && via !== 'voyager' && S.collected < cfg.maxPosts) {
            if (onActivityPage) {
              /*
               * Already where the feed lives, so scroll it here.
               *
               * This used to be `!onActivityPage &&` on the condition above,
               * which skipped the escalation whenever the tab was already on
               * the activity page — and since `phase` is still 'main' at that
               * point, the feed-scroll branch below never ran either. Starting
               * a run from the target's own activity page therefore collected
               * Strategy B's one server-rendered page and stopped, which is
               * indistinguishable from "this profile only has 20 posts".
               */
              log('info', `Have ${S.collected} of ${cfg.maxPosts} — scrolling this activity feed for more.`);
              await tryStrategy('Feed scroll', () => harvestViaDom(add));
            } else {
              // The activity feed lives at its own URL, so the DOM strategy
              // needs the tab moved. The worker restarts the run there,
              // carrying everything collected so far so nothing is re-fetched.
              flush();
              log(
                'info',
                `Have ${S.collected} of ${cfg.maxPosts} — moving the tab to the activity feed to scroll for more.`
              );
              emit(MSG.C_NAVIGATE, {
                url: U.activityUrl(cfg.publicId),
                phase: 'posts-dom',
                profile
              });
              throw new Abort('navigating');
            }
          }
        }

        if (phase === 'posts-dom' && CFG.dom.enabled) {
          throwIfStopped();
          await tryStrategy('Feed scroll', () => harvestViaDom(add));
        }

        flush();
        emitProgress(true);

        if (S.collected === 0) {
          throw new Error(
            'No posts found. The profile may have no public activity, or all three strategies are out of date.'
          );
        }
        if (S.skippedVideos) {
          log('info', `Dropped the video from ${S.skippedVideos} post(s) per your settings — the posts were kept.`);
        }
        log('info', S.pagination ? S.pagination.summary(S.collected) : `Collected ${S.collected} posts.`);

        if (!S.stop) await detailPass();
        if (!S.stop && cfg.includeComments) await commentPass();
      }

      flush();
      setStage('done', 0);
      finish(S.stop ? 'stopped' : 'done');
    } catch (err) {
      flush();
      emitProgress(true);
      if (err instanceof Abort) {
        // A navigation is not the end of the run — the worker picks it back up
        // in the new page, so no DONE is sent.
        if (err.reason === 'navigating') return;
        if (err.reason === 'session_limit') {
          log('warn', err.message);
          finish('session_limit_reached', err.message);
        } else {
          finish(err.reason === 'stopped' ? 'stopped' : 'error', err.message);
        }
      } else {
        log('error', err.message);
        finish('error', err.message);
      }
    } finally {
      S.active = false;
      stopHeartbeat();
    }
  }

  function finish(status, message) {
    emit(MSG.C_DONE, {
      status,
      message: message || '',
      collected: S.collected,
      requests: S.requests,
      pagination: S.pagination
        ? { stoppedEarly: S.pagination.stoppedEarly, reason: S.pagination.reason, pages: S.pagination.pages }
        : null
    });
  }

  /* ------------------------------------------------------------------ *
   * Commands from the service worker
   * ------------------------------------------------------------------ */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case MSG.PING:
        sendResponse({ ok: true, url: location.href, loggedIn: isLoggedIn(), active: S.active });
        return true;

      case MSG.START: {
        if (S.active) {
          sendResponse({ ok: false, error: 'A scrape is already running in this tab.' });
          return true;
        }
        if (onChallengePage()) {
          sendResponse({ ok: false, error: 'challenge' });
          return true;
        }
        {
          // `why` travels with the refusal so the popup can say what was
          // actually observed rather than assuming the user forgot to log in.
          const sess = sessionState();
          if (!sess.ok) {
            sendResponse({ ok: false, error: 'not-logged-in', why: sess.why });
            return true;
          }
        }
        sendResponse({ ok: true });
        // Deliberately not awaited — it streams back over the port. run()
        // cannot reject, but a floating promise with no handler is how the
        // last one of these went unnoticed.
        run(msg.cfg).catch(() => {});
        return true;
      }

      case MSG.STOP:
        S.stop = true;
        S.paused = false;
        // Don't wait out a request that may never answer — cut it now, and let
        // the retry path see the stop flag rather than a network error.
        abortInFlight();
        sendResponse({ ok: true });
        return true;

      case MSG.RESUME:
        if (S.paused) {
          S.paused = false;
          log('info', 'Resumed.');
        }
        sendResponse({ ok: true, active: S.active });
        return true;
    }
    return false;
  });

  /*
   * Test hook. Populated only when a harness has declared __LIS_TEST__ before
   * this script is evaluated, which nothing in the extension ever does — so in
   * a real browser this branch does not run and nothing is exported.
   *
   * It exists because the session check and the entity mappers are pure
   * functions that used to be reachable only through a live LinkedIn session,
   * and one of them shipped a bug that a two-line test would have caught.
   */
  if (globalThis.__LIS_TEST__) {
    Object.assign(globalThis.__LIS_TEST__, {
      sessionState,
      onChallengePage,
      onLoginPage,
      onAuthWall,
      signInCtaPresent,
      memberChromePresent,
      textOf,
      dateRangeText,
      timestampFromActivityId,
      classifyPost,
      reactionsFrom,
      socialCountsFrom,
      videosFrom,
      documentsFrom,
      imagesFrom,
      mapUpdate,
      mapProfileEntity,
      PageTracker,
      onProfilePageFor,
      commentKey,
      collectContent,
      mergeMedia,
      postTextFrom,
      declaresMedia,
      needsDetail,
      mediaFromHtml,
      classifyByMedia,
      articleFrom,
      pollFrom,
      repostFrom,
      hashtagsFrom,
      readProfileSections,
      PROFILE_SECTIONS,
      pickImageByPath,
      allImageUrls,
      imageUrlsIn,
      countFromText,
      parseCompact,
      /*
       * Needs a real document rather than the fake one engine-test.mjs
       * builds, so the suite covers the rules it is made of — pickImageByPath,
       * countFromText, allImageUrls — and this export exists so the whole
       * reader can be run against a saved profile page in a browser.
       */
      profileFromDom,
      getProfile,
      mergeProfiles,
      /*
       * The run itself, and the state it turns on. Exported so a harness can
       * start a run in a real page and press Stop part-way through it — the
       * one behaviour that source-level checks cannot prove, and the one that
       * shipped broken: Stop set a flag that the next phase walked straight
       * past into a tab navigation that started the run over.
       */
      run,
      S,
      CFG,
      // The feed reader, so page shapes it has never seen can be put to it.
      harvestFeedCards,
      readCard,
      readCounts,
      expandSeeMore,
      // The rewritten payload mappers, pure and therefore testable here.
      contactFromPayload,
      mentionsFrom,
      reactionsFrom,
      postTextFrom,
      pronounText,
      mapComment,
      linkedDetailPages,
      rowsFrom,
      componentRows,
      experienceFromRows,
      educationFromRows,
      mergeById,
      DETAILS_PAGES,
      PROFILE_PHOTO_PATH,
      PROFILE_BANNER_PATH
    });
  }
})();
