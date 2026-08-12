/*
 * utils.js — shared helpers.
 *
 * Loaded four ways, so it must be safe to evaluate more than once in the same
 * global:
 *   - content script  : listed before content.js in manifest.json
 *   - service worker  : importScripts('utils.js')
 *   - popup           : <script src="utils.js">
 *   - offscreen doc   : <script src="utils.js">
 */
if (!globalThis.LIS) {
  globalThis.LIS = (function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Message names
     * ------------------------------------------------------------------ */
    const MSG = {
      // popup -> background (chrome.runtime.sendMessage)
      GET_STATE: 'GET_STATE',
      START_SCRAPE: 'START_SCRAPE',
      STOP_SCRAPE: 'STOP_SCRAPE',
      RESUME_SCRAPE: 'RESUME_SCRAPE',
      BUILD_ZIP: 'BUILD_ZIP',
      CANCEL_ZIP: 'CANCEL_ZIP',
      CLEAR: 'CLEAR',
      FOCUS_TAB: 'FOCUS_TAB',

      // background -> popup (broadcast)
      STATE_UPDATE: 'STATE_UPDATE',

      // background -> content script (chrome.tabs.sendMessage)
      START: 'CS_START',
      STOP: 'CS_STOP',
      RESUME: 'CS_RESUME',
      PING: 'CS_PING',

      // content script -> background (long-lived port)
      C_PROFILE: 'PROFILE',
      C_POSTS: 'POSTS',
      C_POST_UPDATE: 'POST_UPDATE',
      C_PROGRESS: 'PROGRESS',
      C_LOG: 'LOG',
      C_ATTENTION: 'ATTENTION',
      C_FAILED: 'FAILED',
      C_DONE: 'DONE',
      C_CURSOR: 'CURSOR',
      C_HEARTBEAT: 'HEARTBEAT',
      C_REQUESTS: 'REQUESTS',
      // Posts live at a different URL from the profile, so the DOM strategy
      // has to move the tab and pick the run back up on the other side.
      C_NAVIGATE: 'NAVIGATE'
    };

    const KEYS = {
      STATE: 'lis_state',
      INDEX: 'lis_index',
      FORM: 'lis_form',
      THEME: 'lis_theme',
      chunk: (n) => `lis_posts_${n}`
    };
    const PORT_NAME = 'lis-scrape';

    const ORIGIN = 'https://www.linkedin.com';

    /*
     * Scraped data lives in chrome.storage.local. Nothing is written to disk
     * until you ask for it, and then it is exactly one file: the .zip.
     * There is deliberately no per-file download path.
     */
    const DEFAULT_OPTIONS = {
      includePosts: true,
      includeComments: false, // third-party personal data — opt in explicitly
      skipVideos: false,
      includeProfileMedia: true
    };

    /*
     * Politeness / safety limits.
     *
     * These are deliberately slower than the Instagram build's. LinkedIn's
     * detection is behavioural rather than purely rate-based: a steady, fast,
     * perfectly-regular request train is a stronger signal than the raw count.
     * MIN_REQUEST_GAP_MS is a floor, not a default — raise it, never lower it.
     */
    const LIMITS = {
      MIN_REQUEST_GAP_MS: 3000,     // hard cap: <= 1 network request per 3 s
      PAGE_DELAY: [3000, 7000],     // between pagination pages
      DETAIL_DELAY: [4000, 9000],   // between per-post detail fetches
      RATE_LIMIT_PAUSE_MS: 180000,  // 3 min on HTTP 429 / 999
      BACKOFF_MS: 8000,             // base backoff for 5xx / network errors
      MAX_RETRIES: 2,
      MAX_POSTS: 500,               // realistic ceiling; pagination degrades first
      /*
       * Cumulative request budget for one run. LinkedIn throttles across a
       * session rather than per-endpoint, so a run that keeps going past a few
       * hundred requests is walking into a restriction regardless of pacing.
       * Hitting this ends the run cleanly with everything kept and Resume
       * available — it is not an error.
       */
      SESSION_MAX_REQUESTS: 300,
      MAX_LOG: 200,
      MAX_FAILED_KEPT: 300,
      PERSIST_DEBOUNCE_MS: 1500,
      // Posts persist in fixed-size buckets so a write costs O(changed) rather
      // than re-serialising the whole result set on every batch.
      CHUNK_SIZE: 100,
      // Comment paging is the most expensive thing the scraper does — one
      // request per page, per post — and it collects other people's personal
      // data. Both ceilings are hard.
      MAX_COMMENTS_PER_POST: 150,
      MAX_COMMENT_PAGES: 8,
      // Three pages in a row yielding less than the one before means
      // pagination is degrading, which is how LinkedIn tails off.
      DECLINE_WARN_STREAK: 3
    };

    /* ------------------------------------------------------------------ *
     * Timing
     * ------------------------------------------------------------------ */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
    const randOf = (pair) => rand(pair[0], pair[1]);

    /** Serialises callers so no two requests fire closer than `gap` ms apart. */
    class RateLimiter {
      constructor(gap) {
        this.gap = gap;
        this.next = 0;
      }
      async wait(extra = 0) {
        const now = Date.now();
        const at = Math.max(now, this.next);
        this.next = at + this.gap + extra;
        if (at > now) await sleep(at - now);
      }
    }

    /* ------------------------------------------------------------------ *
     * Strings / files
     * ------------------------------------------------------------------ */
    function sanitizeSegment(s, fallback = 'unknown') {
      const out = String(s == null ? '' : s)
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\.+/g, '.')
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .slice(0, 80);
      return out || fallback;
    }

    /**
     * Reduces anything that identifies a profile down to its public
     * identifier — the `slug` in linkedin.com/in/slug.
     *
     * Accepts a full URL, a locale subdomain (uk.linkedin.com, de.linkedin.com),
     * a deep link into a profile sub-page (/in/slug/details/experience/), a
     * bare /in/slug path, or the identifier on its own. Query strings and
     * fragments — LinkedIn appends ?trk=… to nearly every link it renders —
     * are dropped.
     *
     * Returns '' for anything that is not a profile, which is what the caller
     * treats as "not a valid target" rather than guessing.
     */
    function normalisePublicId(raw) {
      let s = String(raw == null ? '' : raw).trim();
      if (!s) return '';

      // A URL in any of the shapes LinkedIn hands out. The optional
      // `(?:[a-z]{2,3}\.)?` covers www. as well as the locale subdomains.
      const m =
        s.match(/(?:^|\/\/|\s)(?:[a-z]{2,3}\.)?linkedin\.com\/(?:[^/?#]+\/)*?in\/([^/?#]+)/i) ||
        s.match(/^\/?in\/([^/?#]+)/i);
      if (m) s = m[1];

      s = s.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '').trim();
      // Public ids may carry non-ASCII characters, which arrive percent-encoded
      // from a copied URL.
      if (s.indexOf('%') >= 0) {
        try {
          s = decodeURIComponent(s);
        } catch (_) {
          /* keep the encoded form rather than failing outright */
        }
      }
      s = s.replace(/^@+/, '').trim();

      if (!s || s.length > 100) return '';
      if (/[\s/\\?#]/.test(s)) return '';
      // Path segments that are LinkedIn's own, not somebody's profile.
      if (/^(feed|company|school|jobs|posts|pulse|groups|events|learning|mynetwork|messaging|notifications|checkpoint|uas|login|signup|help|legal|in)$/i.test(s)) {
        return '';
      }
      return s.toLowerCase();
    }

    const profileUrl = (publicId) => `${ORIGIN}/in/${encodeURIComponent(publicId)}/`;
    const activityUrl = (publicId) => `${ORIGIN}/in/${encodeURIComponent(publicId)}/recent-activity/all/`;

    /**
     * The canonical permalink for a post. This is the same URL the "Copy link
     * to post" menu item produces — a public page address, not an API path.
     */
    function postUrlFromActivityId(id) {
      return id ? `${ORIGIN}/feed/update/urn:li:activity:${id}/` : null;
    }

    function extFromUrl(url, fallback = 'jpg') {
      try {
        const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
        return m ? m[1].toLowerCase() : fallback;
      } catch (_) {
        return fallback;
      }
    }

    const pad = (n, width = 3) => String(n).padStart(width, '0');

    function formatCount(n) {
      if (n == null || Number.isNaN(Number(n))) return '—';
      n = Number(n);
      if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
      return String(n);
    }

    function fmtDuration(sec) {
      sec = Math.round(sec);
      if (sec < 90) return `${sec}s`;
      const m = Math.round(sec / 60);
      if (m < 90) return `${m} min`;
      const h = Math.floor(m / 60);
      return `${h}h ${m % 60}m`;
    }

    function fmtBytes(n) {
      n = Number(n) || 0;
      if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
      if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
      if (n >= 1024) return Math.round(n / 1024) + ' KB';
      return n + ' B';
    }

    /** ISO-ish, readable, always UTC — no local-timezone ambiguity in exports. */
    function fmtTimestamp(ms) {
      if (!ms) return 'unknown';
      const d = new Date(Number(ms));
      if (Number.isNaN(d.getTime())) return 'unknown';
      return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    }

    /* ------------------------------------------------------------------ *
     * CSV
     *
     * posts.csv feeds a spreadsheet, so a post body containing a comma, a
     * quote or — very commonly on LinkedIn — a dozen newlines must not be
     * able to break the row structure.
     * ------------------------------------------------------------------ */

    /**
     * One RFC 4180 field. Newlines become a literal \n rather than being
     * quoted through: a quoted multi-line cell is legal CSV but survives
     * almost no real-world import path intact.
     */
    function csvCell(v) {
      if (v == null) return '';
      let s = String(v)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
      // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
      if (/^[=+\-@]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    }

    const csvRow = (cells) => cells.map(csvCell).join(',') + '\r\n';

    /* ------------------------------------------------------------------ *
     * Post types and reactions
     * ------------------------------------------------------------------ */
    const POST_TYPES = ['text', 'image', 'document', 'video', 'article', 'repost', 'poll'];

    /*
     * LinkedIn's reaction enum. The names are what the API returns; the labels
     * are what the UI shows. Anything not listed here is carried through with
     * its raw enum name title-cased, so a new reaction type shows up in the
     * export rather than being silently dropped.
     */
    const REACTION_LABELS = {
      LIKE: 'Like',
      PRAISE: 'Celebrate',
      EMPATHY: 'Love',
      INTEREST: 'Insightful',
      APPRECIATION: 'Support',
      ENTERTAINMENT: 'Funny',
      MAYBE: 'Curious'
    };

    function reactionLabel(kind) {
      const k = String(kind || '').toUpperCase();
      if (REACTION_LABELS[k]) return REACTION_LABELS[k];
      return k ? k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, ' ') : 'Other';
    }

    return {
      MSG,
      KEYS,
      PORT_NAME,
      ORIGIN,
      DEFAULT_OPTIONS,
      LIMITS,
      RateLimiter,
      sleep,
      rand,
      randOf,
      sanitizeSegment,
      normalisePublicId,
      profileUrl,
      activityUrl,
      postUrlFromActivityId,
      extFromUrl,
      pad,
      formatCount,
      fmtDuration,
      fmtBytes,
      fmtTimestamp,
      csvCell,
      csvRow,
      POST_TYPES,
      REACTION_LABELS,
      reactionLabel
    };
  })();
}
