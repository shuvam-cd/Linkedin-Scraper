/*
 * background.js — MV3 service worker.
 *
 * Owns all scrape state so the popup can be closed and reopened freely, brokers
 * messages between the popup and the content script, and persists results to
 * chrome.storage.local as they arrive.
 *
 * Nothing is written to disk while scraping. chrome.downloads is only called
 * when the user asks for output, and then it produces exactly one file: the
 * .zip archive.
 */
importScripts('utils.js');

const U = globalThis.LIS;
const MSG = U.MSG;
const L = U.LIMITS;

/* ---------------------------------------------------------------- *
 * State
 * ---------------------------------------------------------------- */
function blankState() {
  return {
    // idle|starting|running|paused|stopping|stopped|done|error|interrupted|session_limit_reached
    status: 'idle',
    publicId: '',
    maxPosts: 100,
    options: Object.assign({}, U.DEFAULT_OPTIONS),
    profile: null,
    collected: 0,
    target: 0,
    skippedVideos: 0,
    requests: 0,
    failed: [],
    failedCount: 0,
    attention: null, // {kind, message}
    error: '',
    tabId: null,
    cursor: null, // {kind:'voyager'|'token', value} — lets a resume skip re-paging
    // How pagination ended, so the UI can be honest about it rather than
    // implying the account was exhausted.
    pagination: null, // {stoppedEarly, reason, pages}
    // The pass the content script is on: harvest | detail | comments | done.
    stage: 'harvest',
    stageDone: 0,
    stageTotal: 0,
    stageStartedAt: null,
    phase: 'main',
    startedAt: null,
    finishedAt: null,
    zip: { building: false, done: 0, total: 0, bytes: 0, failed: 0, filename: '' },
    log: []
  };
}

let state = blankState();
let posts = [];
let postIndex = new Map(); // activityId -> position in `posts`
let loaded = false;

/*
 * True while the worker is deliberately moving the tab (profile page ->
 * activity page for the DOM strategy). Without this, the port disconnect that
 * navigation causes would be reported as an interrupted run.
 */
let navigating = false;

const CHUNK = L.CHUNK_SIZE;
const chunkOf = (i) => Math.floor(i / CHUNK);
const chunkCount = () => Math.ceil(posts.length / CHUNK);
const dirtyChunks = new Set();

/*
 * The load is memoised as a promise, not just flagged when it finishes.
 *
 * `loaded` only flips at the very end, after two awaits. Without the shared
 * promise, two callers that arrive during those awaits both run the whole load,
 * and the second one's `posts = []` throws away everything the first one
 * upserted in between — which during a live run is a batch of collected posts.
 */
let loadPromise = null;

function ensureLoaded() {
  if (loaded) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = loadFromStorage().finally(() => {
      // Cleared either way: on success `loaded` short-circuits future calls, on
      // failure the next caller gets a fresh attempt rather than a stuck reject.
      loadPromise = null;
    });
  }
  return loadPromise;
}

async function loadFromStorage() {
  if (loaded) return;
  const meta = await chrome.storage.local.get([U.KEYS.STATE, U.KEYS.INDEX]);
  if (loaded) return; // another caller finished while this one was awaiting
  if (meta[U.KEYS.STATE]) state = Object.assign(blankState(), meta[U.KEYS.STATE]);

  const fresh = [];
  const idx = meta[U.KEYS.INDEX];
  if (idx && idx.chunks > 0) {
    const keys = [];
    for (let i = 0; i < idx.chunks; i++) keys.push(U.KEYS.chunk(i));
    const buckets = await chrome.storage.local.get(keys);
    if (loaded) return;
    for (let i = 0; i < idx.chunks; i++) {
      const b = buckets[U.KEYS.chunk(i)];
      if (Array.isArray(b)) fresh.push(...b);
    }
  }
  posts = fresh;
  reindex();

  // A run can't survive a worker restart mid-flight unless the content script
  // is still streaming; mark it interrupted so the UI is honest about it.
  if (state.status === 'running' || state.status === 'starting') {
    state.status = 'interrupted';
    addLog('warn', 'Extension restarted mid-scrape — partial results kept.');
  }
  /*
   * The other flag that only a `finally` clears, and a dead worker never ran
   * one. A build cannot span a restart, so a loaded `building: true` is always
   * stale — and left standing it disabled the export permanently: every
   * BUILD_ZIP answered "Already packaging.", and Clear, the only other way
   * out, was disabled by the same flag.
   */
  if (state.zip && state.zip.building) {
    state.zip = Object.assign({}, state.zip, { building: false });
    addLog('warn', 'The export was interrupted by a restart — nothing was saved.');
  }
  loaded = true;
}

function reindex() {
  postIndex = new Map();
  posts.forEach((p, i) => postIndex.set(p.activityId, i));
}

let persistTimer = null;
let lastPersist = 0;

/**
 * Throttle, not debounce. Posts stream in continuously during a run, so a
 * debounce would keep resetting and never write until the run ended — which is
 * exactly when losing the data matters most.
 */
function schedulePersist(immediate) {
  if (immediate) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    return persist();
  }
  if (persistTimer) return; // one is already pending; don't push it back
  const due = Math.max(0, L.PERSIST_DEBOUNCE_MS - (Date.now() - lastPersist));
  persistTimer = setTimeout(persist, due);
}

const MAX_PERSIST_RETRIES = 5;
let persistFailures = 0;

async function persist() {
  persistTimer = null;
  lastPersist = Date.now();
  const writing = [...dirtyChunks];
  dirtyChunks.clear();

  const payload = {
    [U.KEYS.STATE]: state,
    [U.KEYS.INDEX]: { total: posts.length, chunks: chunkCount() }
  };
  for (const c of writing) payload[U.KEYS.chunk(c)] = posts.slice(c * CHUNK, (c + 1) * CHUNK);

  try {
    await chrome.storage.local.set(payload);
    persistFailures = 0;
  } catch (err) {
    // Most likely the quota; "unlimitedStorage" is requested to avoid this.
    /*
     * Marking the chunks dirty is not a retry — `dirtyChunks` is inert, and
     * only schedulePersist ever arms a write. The write most likely to fail is
     * the largest, and the one with no event behind it is the last one of the
     * run, so the failure mode was: the popup shows the full count, the data
     * only exists in memory, and the next eviction takes it.
     */
    writing.forEach((c) => dirtyChunks.add(c));
    console.warn('[LinkedIn Scraper] persist failed', err);
    persistFailures++;
    if (persistFailures <= MAX_PERSIST_RETRIES) {
      addLog('warn', `Could not save to local storage: ${err.message} — retrying.`);
      if (!persistTimer) persistTimer = setTimeout(persist, L.PERSIST_DEBOUNCE_MS * 4 * persistFailures);
    } else {
      addLog(
        'error',
        `Could not save to local storage after ${MAX_PERSIST_RETRIES} attempts (${err.message}). ` +
          'Results are held in memory only — export now.'
      );
    }
    return;
  }
}

/* ---------------------------------------------------------------- *
 * Logging + popup broadcast
 * ---------------------------------------------------------------- */
function addLog(level, message) {
  state.log.push({ t: Date.now(), level, message });
  if (state.log.length > L.MAX_LOG) state.log = state.log.slice(-L.MAX_LOG);
}

function countMedia() {
  let media = 0;
  let docs = 0;
  let comments = 0;
  let undownloadableVideos = 0;
  for (const p of posts) {
    const m = Array.isArray(p.media) ? p.media : [];
    media += m.length;
    docs += m.filter((x) => x.type === 'document').length;
    undownloadableVideos += m.filter((x) => x.type === 'video' && !x.url).length;
    comments += Array.isArray(p.commentList) ? p.commentList.length : 0;
  }
  return { media, docs, comments, undownloadableVideos };
}

function publicState() {
  const c = countMedia();
  return Object.assign({}, state, {
    postsCount: posts.length,
    mediaCount: c.media,
    docsCount: c.docs,
    commentsCount: c.comments,
    sessionCap: L.SESSION_MAX_REQUESTS,
    log: state.log.slice(-40)
  });
}

let broadcastTimer = null;
function broadcast(immediate) {
  if (broadcastTimer) clearTimeout(broadcastTimer);
  const fire = () => {
    broadcastTimer = null;
    chrome.runtime
      .sendMessage({ type: MSG.STATE_UPDATE, state: publicState() })
      .catch(() => {}); // no popup open — expected
  };
  if (immediate) fire();
  else broadcastTimer = setTimeout(fire, 200);
}

function setStatus(status, extra) {
  state.status = status;
  if (extra) Object.assign(state, extra);
  broadcast(true);
  schedulePersist(true);
}

/* ---------------------------------------------------------------- *
 * Tab handling — everything happens in a real, visible tab
 * ---------------------------------------------------------------- */
/** Same page, ignoring the query string and fragment LinkedIn appends. */
function samePage(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
  } catch (_) {
    return false;
  }
}

/*
 * `url` is only populated for tabs this extension holds a host permission for,
 * which is exactly the test wanted: a tab showing anything else reads as not
 * ours, so a tab the user has since repurposed is never navigated away.
 */
const isLinkedInTab = (t) => !!t && typeof t.url === 'string' && t.url.startsWith('https://www.linkedin.com/');

/**
 * Returns the tab to run in, and whether it actually had to navigate.
 *
 * A tab already sitting on the target page is left alone. Re-navigating it
 * would tear down a perfectly good content script and start a reload that the
 * load wait then has to race.
 */
async function ensureTab(url) {
  let tab = null;
  if (state.tabId != null) {
    const t = await chrome.tabs.get(state.tabId).catch(() => null);
    if (isLinkedInTab(t)) tab = t;
  }
  if (!tab) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (isLinkedInTab(active)) tab = active;
  }

  let navigated = true;
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: true });
  } else if (tab.status === 'complete' && samePage(tab.url, url)) {
    await chrome.tabs.update(tab.id, { active: true });
    navigated = false;
  } else {
    await chrome.tabs.update(tab.id, { url, active: true });
  }
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return { tabId: tab.id, navigated };
}

/**
 * Resolves once the tab has actually loaded `expectUrl`.
 *
 * chrome.tabs.update() does not flip the tab's status to `loading`
 * synchronously, so an immediate status check still sees the *previous* page
 * reported as `complete`. Accepting that resolves the wait before the
 * navigation has even started, and the injection that follows lands in a page
 * being torn down — which surfaces as "Could not reach the page".
 *
 * So `complete` is only believed when the tab is also showing the page that was
 * asked for.
 */
function waitForTabLoad(tabId, expectUrl, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      clearInterval(poll);
      fn(arg);
    };

    const atTarget = (t) => !!t && t.status === 'complete' && (!expectUrl || samePage(t.url || '', expectUrl));
    // LinkedIn hydrates after `complete`; the extra beat avoids injecting into
    // a shell that has not rendered its payload yet. Latched, so the poll and
    // the event listener between them only ever arm this once.
    let settling = false;
    const settle = () => {
      if (settling) return;
      settling = true;
      clearInterval(poll);
      setTimeout(() => done(resolve, true), 900);
    };

    const onUpdated = (id, info, tab) => {
      if (id !== tabId || info.status !== 'complete') return;
      if (atTarget(tab)) settle();
    };
    const onRemoved = (id) => {
      if (id === tabId) done(reject, new Error('The LinkedIn tab was closed.'));
    };
    const timer = setTimeout(() => done(reject, new Error('Timed out waiting for LinkedIn to load.')), timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    /*
     * A same-document navigation (LinkedIn is a single-page app in places)
     * can reach the target without ever firing `complete`, so poll as well.
     * Both paths funnel through the same one-shot `done`.
     */
    const poll = setInterval(() => {
      chrome.tabs
        .get(tabId)
        .then((t) => {
          if (atTarget(t)) settle();
        })
        .catch((e) => done(reject, e));
    }, 400);
  });
}

async function injectContent(tabId) {
  // content.js short-circuits if it is already present, so this is idempotent.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['utils.js', 'voyager.js', 'content.js']
  });
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch((err) => ({ ok: false, error: err.message }));
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.tabId === tabId && ['running', 'paused', 'starting'].includes(state.status)) {
    addLog('warn', 'LinkedIn tab closed — scrape interrupted. Partial results kept.');
    setStatus('interrupted', { finishedAt: Date.now() });
  }
});

/* ---------------------------------------------------------------- *
 * Start / stop / resume
 * ---------------------------------------------------------------- */
/**
 * A post the content script still has work to do on.
 *
 * The content script starts every run with an empty result set, so a run that
 * is re-hosted — either continued in a freshly navigated tab, or resumed after
 * an interruption — would otherwise never revisit posts collected before the
 * handoff. They would sit in storage forever with no text and no counts.
 */
function needsMoreWork(p) {
  // One definition, shared with the content script. These two predicates used
  // to be written out separately in each context and had drifted apart, so the
  // worker handed back fewer posts than the run would have worked on.
  if (U.postNeedsDetail(p)) return true;
  return state.options.includeComments && U.postNeedsComments(p);
}

// Bounded: this rides inside a single sendMessage, and a few hundred posts
// carrying media lists is already a multi-megabyte structured clone. Whatever
// does not fit is picked up by the next resume.
const HANDOFF_LIMIT = 200;

function runCfg(extra) {
  const needy = posts.filter(needsMoreWork);
  if (needy.length > HANDOFF_LIMIT) {
    // Silently dropping the overflow would leave posts sitting in storage with
    // no text and no counts, and nothing on screen to explain why.
    addLog(
      'warn',
      `${needy.length} posts still need a detail pass — carrying the first ${HANDOFF_LIMIT} into this one. ` +
        'Press Resume again when it finishes to pick up the rest.'
    );
  }
  return Object.assign(
    {
      publicId: state.publicId,
      maxPosts: state.maxPosts,
      includePosts: state.options.includePosts,
      includeComments: state.options.includeComments,
      skipVideos: state.options.skipVideos,
      includeProfileMedia: state.options.includeProfileMedia,
      fullProfile: state.options.fullProfile !== false,
      knownActivityIds: posts.map((p) => p.activityId),
      alreadyCollected: posts.length,
      pendingPosts: needy.slice(0, HANDOFF_LIMIT),
      startCursor: state.cursor,
      // Read from the state rather than hardcoded: continueAt still overrides
      // it, but a resume now picks up where the run actually was.
      phase: state.phase || 'main',
      profile: state.phase === 'posts-dom' ? state.profile : null,
      // A fresh sitting starts the budget over; continueAt overrides this.
      requestsSoFar: 0
    },
    extra || {}
  );
}

/* ---------------------------------------------------------------- *
 * Keeping the worker alive
 *
 * An MV3 service worker is evicted after ~30 s without an extension API call,
 * and a pending setTimeout does not count as activity. During a scrape the
 * content script's heartbeat holds the worker up; during packaging, a long
 * download, or the stop-settle window there is nothing, so those operations
 * could be killed part-way — leaving the UI stuck on "Packaging…" or
 * "Stopping" with no way back.
 *
 * A cheap API round-trip on a timer resets the idle countdown. Reference
 * counted, so overlapping operations do not clear each other's keep-alive.
 * ---------------------------------------------------------------- */
let keepAliveTimer = null;
let keepAliveDepth = 0;

function keepAliveStart() {
  keepAliveDepth++;
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}

function keepAliveStop() {
  keepAliveDepth = Math.max(0, keepAliveDepth - 1);
  if (keepAliveDepth === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

async function startScrape(payload, keepResults) {
  await ensureLoaded();

  const publicId = U.normalisePublicId(payload.publicId);
  if (!publicId) {
    return { ok: false, error: 'Enter a LinkedIn profile URL or public identifier.' };
  }

  /*
   * buildZip guards re-entry through `state.zip.building` — but `state` is
   * rebound to a fresh blankState() below, whose zip block is blank, so every
   * later write from the running build landed on an object nobody reads and
   * the guard went back to answering false. A second build could then start
   * over the first, reset the shared ZipWriter, and lose everything the first
   * had accumulated. Packaging finishes before a new run begins.
   */
  if (state.zip && state.zip.building) {
    return { ok: false, error: 'Still packaging the archive — wait for the export to finish.' };
  }

  const maxPosts = Math.max(1, Math.min(L.MAX_POSTS, parseInt(payload.maxPosts, 10) || 100));
  const options = Object.assign({}, U.DEFAULT_OPTIONS, payload.options || {});

  // Only keep prior results when continuing the same profile.
  const resuming = !!keepResults && state.publicId === publicId && posts.length > 0;
  const keepTab = state.tabId;
  const keepProfile = resuming ? state.profile : null;
  const keepLog = resuming ? state.log : [];
  const keepCursor = resuming ? state.cursor : null;
  /*
   * Where the run had got to. This was written on every handoff and persisted
   * faithfully, and then nothing ever read it — so a run interrupted during
   * the feed scroll resumed at 'main': back to the profile page, the whole
   * profile re-read (with Full history that is the card plus up to seven
   * "Show all" pages, each behind the request floor), the activity page
   * re-fetched, and only then back to the feed to scroll from the top. Around
   * ten requests of the budget spent getting back to where it already was, on
   * a run that was resumed because the budget ran out.
   */
  const keepPhase = resuming && state.phase === 'posts-dom' && keepProfile ? 'posts-dom' : 'main';

  state = blankState();
  state.tabId = keepTab;
  state.publicId = publicId;
  state.maxPosts = maxPosts;
  state.options = options;
  state.startedAt = Date.now();
  state.log = keepLog;
  state.profile = keepProfile;
  state.cursor = keepCursor;
  state.phase = keepPhase;

  if (!resuming) {
    posts = [];
    postIndex = new Map();
    dirtyChunks.clear();
    await chrome.storage.local.remove(await allChunkKeys());
  }
  state.collected = posts.length;

  addLog(
    'info',
    resuming
      ? `Continuing /in/${publicId} — ${posts.length} posts already saved. The session request budget starts fresh.`
      : `Opening linkedin.com/in/${publicId}/ ...`
  );
  setStatus('starting');

  try {
    // Resuming into the feed scroll means the feed is where the run belongs.
    const target = state.phase === 'posts-dom' ? U.activityUrl(publicId) : U.profileUrl(publicId);
    const { tabId, navigated } = await ensureTab(target);
    state.tabId = tabId;
    // Only wait when something is actually loading — a tab already on the
    // profile never fires another `complete`, so waiting would just time out.
    if (navigated) await waitForTabLoad(tabId, target);
    await injectContent(tabId);

    const res = await sendToTab(tabId, { type: MSG.START, cfg: runCfg() });
    return handleStartResponse(res);
  } catch (err) {
    addLog('error', err.message);
    setStatus('error', { error: err.message });
    return { ok: false, error: err.message };
  }
}

function handleStartResponse(res) {
  if (res && res.ok) {
    setStatus('running');
    return { ok: true };
  }
  if (res && res.error === 'not-logged-in') {
    // Say what was actually observed. "Log in first" to someone who is already
    // logged in is the least useful message an extension can produce.
    const m = res.why
      ? `${res.why} Log in on that tab and press Start again.`
      : 'Log into LinkedIn in this browser, then press Start again.';
    state.attention = { kind: 'login', message: m };
    addLog('error', res.why || 'Not logged in.');
    setStatus('error', { error: m });
    return { ok: false, error: m };
  }
  if (res && res.error === 'challenge') {
    const m = 'LinkedIn is showing a security check. Clear it in the tab, then press Start again.';
    state.attention = { kind: 'challenge', message: m };
    addLog('error', 'Blocked by a security check.');
    setStatus('error', { error: m });
    return { ok: false, error: m };
  }
  const msg = (res && res.error) || 'Could not reach the page. Reload the LinkedIn tab and try again.';
  addLog('error', msg);
  setStatus('error', { error: msg });
  return { ok: false, error: msg };
}

/**
 * Moves the tab and picks the run back up on the other side.
 *
 * The activity feed lives at its own URL, so the DOM strategy cannot reach it
 * without navigating — which tears down the content script. Everything already
 * collected is handed back in the new cfg so nothing is re-collected.
 */
async function continueAt(url, phase, profile) {
  navigating = true;
  try {
    if (state.tabId == null) throw new Error('no tab to continue in');
    if (profile) state.profile = profile;
    state.phase = phase;
    schedulePersist();

    /*
     * Moving the tab, waiting for it to load and injecting take seconds, and
     * waitForTabLoad alone allows up to a minute. A Stop landing anywhere in
     * that window reached a content script that was already being torn down,
     * so nothing carried the flag into the new page — and this function then
     * sent START regardless and began a brand-new run, while the popup's
     * settle timer flipped to "Stopped" over the top of it. Re-read the status
     * after every await instead of trusting the one read at entry.
     */
    const abandoned = () => {
      if (['starting', 'running', 'paused'].includes(state.status)) return false;
      addLog('info', 'Stop landed while the tab was moving — the run ends here.');
      if (state.status !== 'stopped') setStatus('stopped', { finishedAt: Date.now() });
      return true;
    };

    if (abandoned()) return;
    await chrome.tabs.update(state.tabId, { url, active: true });
    if (abandoned()) return;
    await waitForTabLoad(state.tabId, url);
    if (abandoned()) return;
    await injectContent(state.tabId);
    if (abandoned()) return;

    const res = await sendToTab(state.tabId, {
      type: MSG.START,
      cfg: runCfg({
        phase,
        profile: state.profile,
        /*
         * This is one sitting continued in a new page, not a fresh run, so the
         * session budget has to carry across. Resetting it here would hand the
         * same run a second full allowance and jump the popup's meter back to 0.
         */
        requestsSoFar: state.requests
      })
    });
    if (!res || !res.ok) handleStartResponse(res);
  } catch (err) {
    addLog('error', `Could not continue on the activity page: ${err.message}`);
    setStatus('error', { error: err.message, finishedAt: Date.now() });
  } finally {
    navigating = false;
  }
}

async function stopScrape() {
  await ensureLoaded();
  // The run may have finished between the popup rendering and the click.
  if (!['starting', 'running', 'paused'].includes(state.status)) return { ok: true, alreadyFinished: true };
  if (state.tabId != null) await sendToTab(state.tabId, { type: MSG.STOP });
  // Whatever the run was waiting on, it is not waiting any more — and a
  // checkpoint tears the content script down, so C_DONE may never arrive to
  // clear this.
  state.attention = null;
  addLog('info', 'Stop requested — finishing the current request.');
  setStatus('stopping');
  // If the content script is gone the DONE message never arrives; settle anyway.
  // The keep-alive is what guarantees this timer still has a worker to run in.
  keepAliveStart();
  setTimeout(() => {
    if (state.status === 'stopping') setStatus('stopped', { finishedAt: Date.now() });
    keepAliveStop();
  }, 12000);
  return { ok: true };
}

async function resumeScrape() {
  await ensureLoaded();
  if (state.tabId == null) return { ok: false, error: 'No LinkedIn tab to resume in.' };

  // If the content script was torn down (navigation, reload), restart the run
  // but keep everything already collected.
  const ping = await sendToTab(state.tabId, { type: MSG.PING });
  if (!ping || !ping.ok || !ping.active) {
    addLog('info', 'Content script is no longer running — continuing in a fresh page load.');
    return startScrape(
      { publicId: state.publicId, maxPosts: state.maxPosts, options: state.options },
      true
    );
  }

  await sendToTab(state.tabId, { type: MSG.RESUME });
  state.attention = null;
  addLog('info', 'Resumed.');
  setStatus('running');
  return { ok: true };
}

/* ---------------------------------------------------------------- *
 * Content script stream
 * ---------------------------------------------------------------- */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== U.PORT_NAME) return;

  port.onMessage.addListener(async (msg) => {
    await ensureLoaded();
    switch (msg.type) {
      case MSG.C_HEARTBEAT:
        return; // presence alone keeps the worker alive

      case MSG.C_PROFILE:
        state.profile = msg.profile;
        broadcast();
        schedulePersist();
        return;

      case MSG.C_POSTS:
        upsertPosts(msg.posts);
        return;

      case MSG.C_POST_UPDATE:
        upsertPosts([msg.post]);
        return;

      case MSG.C_PROGRESS:
        state.collected = msg.collected;
        state.target = msg.target || state.target;
        state.skippedVideos = msg.skippedVideos || 0;
        if (msg.requests != null) state.requests = msg.requests;
        // Which pass is running. Named `stage` rather than `phase` because
        // `state.phase` already means something else here — main vs posts-dom,
        // which is about where the tab is, not what the run is doing.
        if (msg.stage) {
          state.stage = msg.stage;
          state.stageDone = msg.stageDone || 0;
          state.stageTotal = msg.stageTotal || 0;
          state.stageStartedAt = msg.stageStartedAt || null;
        }
        broadcast();
        return;

      case MSG.C_REQUESTS:
        state.requests = msg.requests;
        broadcast();
        return;

      case MSG.C_LOG:
        addLog(msg.level || 'info', msg.message);
        broadcast();
        schedulePersist();
        return;

      case MSG.C_ATTENTION:
        state.attention = { kind: msg.kind, message: msg.message };
        addLog('warn', msg.message);
        setStatus('paused');
        return;

      case MSG.C_CURSOR:
        state.cursor = { kind: msg.kind, value: msg.value };
        schedulePersist();
        return;

      case MSG.C_NAVIGATE:
        // Not awaited: the port is about to close under us as the tab moves.
        continueAt(msg.url, msg.phase, msg.profile);
        return;

      case MSG.C_FAILED:
        state.failedCount++;
        if (state.failed.length < L.MAX_FAILED_KEPT) {
          state.failed.push({ activityId: msg.activityId, error: msg.error });
        }
        broadcast();
        return;

      case MSG.C_DONE: {
        state.collected = msg.collected != null ? msg.collected : state.collected;
        if (msg.requests != null) state.requests = msg.requests;
        if (msg.pagination) state.pagination = msg.pagination;
        state.finishedAt = Date.now();
        state.attention = null;
        if (msg.status === 'error') state.error = msg.message || 'Scrape failed';

        const tail = state.pagination && state.pagination.stoppedEarly
          ? ` — LinkedIn stopped returning more (${state.pagination.reason})`
          : '';

        if (msg.status === 'done') {
          addLog('success', `Finished — collected ${posts.length} posts${tail}.`);
        } else if (msg.status === 'stopped') {
          addLog('info', `Stopped — ${posts.length} posts kept.`);
        } else if (msg.status === 'session_limit_reached') {
          addLog(
            'warn',
            `Session request budget reached — stopped cleanly with ${posts.length} posts kept. ` +
              'Resume later to continue from the saved cursor.'
          );
        } else {
          addLog('error', `Failed — ${msg.message || 'unknown error'} (${posts.length} posts kept)`);
        }
        setStatus(msg.status);
        return;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    // A deliberate navigation drops the port; that is not an interruption.
    if (navigating) return;
    if (state.status === 'running') {
      addLog('warn', 'Lost contact with the LinkedIn tab (navigated or reloaded?).');
      setStatus('interrupted', { finishedAt: Date.now() });
    }
  });
});

/** Forgets a recorded failure once that post has been captured after all. */
function dropFailure(activityId) {
  const at = state.failed.findIndex((f) => f.activityId === activityId);
  if (at < 0) return;
  state.failed.splice(at, 1);
  state.failedCount = Math.max(0, state.failedCount - 1);
}

function upsertPosts(incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return;
  for (const p of incoming) {
    if (!p || !p.activityId) continue;
    const at = postIndex.get(p.activityId);
    if (at == null) {
      p.index = posts.length;
      postIndex.set(p.activityId, posts.length);
      posts.push(p);
      dirtyChunks.add(chunkOf(p.index));
    } else {
      // Media and counts usually only arrive with the detail fetch, so later
      // updates merge over the harvest pass's placeholder.
      posts[at] = Object.assign({}, posts[at], p, { index: posts[at].index });
      dirtyChunks.add(chunkOf(at));
      // A post that failed and then succeeded on a retry stops being a
      // failure, so the popup's Failed tile counts what is still broken
      // rather than every failure the run has ever seen.
      if (!posts[at].error) dropFailure(p.activityId);
    }
  }
  state.collected = posts.length;
  broadcast();
  schedulePersist();
}

/* ---------------------------------------------------------------- *
 * File layout
 *
 * Nothing here touches chrome.downloads. Scraped data stays in
 * chrome.storage.local, and these helpers only describe how it will be laid
 * out inside the .zip.
 * ---------------------------------------------------------------- */
const RULE = '-'.repeat(70);
const nOf = (v) => (v == null ? 'unknown' : Number(v).toLocaleString('en-US'));
const kv = (k, v) => `${(k + ' '.repeat(18)).slice(0, 18)}: ${v}`;
const crlf = (lines) => lines.join('\r\n') + '\r\n';

/** 3 digits — MAX_POSTS is 500, so that always sorts correctly. */
const padWidth = () => 3;

const mediaOf = (post) => (Array.isArray(post.media) ? post.media : []);
const postedAt = (post) => U.fmtTimestamp(post.publishedAt);

/*
 * The profile sections beyond experience/education/skills, and the headings
 * they print under. Kept in the same order the profile itself renders them.
 * The keys match PROFILE_SECTIONS in content.js — wiring-check pins that.
 */
const PROFILE_SECTION_LABELS = [
  ['certifications', 'LICENSES & CERTIFICATIONS'],
  ['languages', 'LANGUAGES'],
  ['volunteering', 'VOLUNTEERING'],
  ['projects', 'PROJECTS'],
  ['honors', 'HONORS & AWARDS'],
  ['courses', 'COURSES'],
  ['publications', 'PUBLICATIONS']
];

function profileFileText(p) {
  const out = [];
  out.push(p.fullName || p.publicId);
  out.push('='.repeat(70));
  if (p.headline) out.push(p.headline);
  out.push('');
  out.push(kv('Profile', p.profileUrl || U.profileUrl(p.publicId)));
  out.push(kv('Public ID', p.publicId || 'unknown'));
  if (p.location) out.push(kv('Location', p.location));
  if (p.industry) out.push(kv('Industry', p.industry));
  out.push(kv('Followers', nOf(p.followers)));
  out.push(kv('Connections', nOf(p.connections)));
  out.push('');

  if (p.currentPosition) {
    out.push('CURRENT POSITION');
    out.push(RULE);
    out.push(`${p.currentPosition.title || '(unknown title)'} — ${p.currentPosition.company || '(unknown company)'}`);
    if (p.currentPosition.dates) out.push(p.currentPosition.dates);
    if (p.currentPosition.location) out.push(p.currentPosition.location);
    out.push('');
  }

  out.push('ABOUT');
  out.push(RULE);
  out.push(p.about ? String(p.about).replace(/\r?\n/g, '\r\n') : '(no about section)');
  out.push('');

  if (p.skills && p.skills.length) {
    out.push(`SKILLS (${p.skills.length})`);
    out.push(RULE);
    out.push(p.skills.join(', '));
    out.push('');
  }

  /*
   * The rest of the profile. Every one of these sections is the same shape —
   * a name, a qualifier, a date range and some prose — so one loop renders
   * all of them, and a section the profile does not have prints nothing
   * rather than an empty heading.
   */
  for (const [key, label] of PROFILE_SECTION_LABELS) {
    const rows = Array.isArray(p[key]) ? p[key] : [];
    if (!rows.length) continue;
    out.push(`${label} (${rows.length})`);
    out.push(RULE);
    rows.forEach((r, i) => {
      out.push(`${String(i + 1).padStart(3)}. ${r.name}`);
      const line = [r.detail, r.dates].filter(Boolean).join('   ·   ');
      if (line) out.push(`     ${line}`);
      if (r.url) out.push(`     ${r.url}`);
      if (r.description) {
        for (const l of String(r.description).split(/\r?\n/)) out.push(`     ${l}`);
      }
    });
    out.push('');
  }

  out.push(kv('Read via', p.source || 'unknown'));
  out.push(kv('Scraped', p.scrapedAt || new Date().toISOString()));
  return crlf(out);
}

function experienceFileText(p) {
  const rows = p.experience || [];
  const out = [`EXPERIENCE — ${p.fullName || p.publicId}`, '='.repeat(70), ''];
  if (!rows.length) {
    out.push('(no experience captured)');
    out.push('');
    out.push('The profile card is a preview and the full history sits behind a');
    out.push('"Show all" page, which this scraper does follow — so an empty list');
    out.push('here means neither carried anything readable, not that it stopped at');
    out.push('the card. Turning off "Full history" also produces this.');
    return crlf(out);
  }
  rows.forEach((e, i) => {
    out.push(`${String(i + 1).padStart(3)}. ${e.title || '(unknown title)'}`);
    out.push(`     ${e.company || '(unknown company)'}${e.current ? '   [current]' : ''}`);
    if (e.dates) out.push(`     ${e.dates}`);
    if (e.location) out.push(`     ${e.location}`);
    if (e.companyUrl) out.push(`     ${e.companyUrl}`);
    if (e.description) {
      out.push('');
      for (const line of String(e.description).split(/\r?\n/)) out.push(`     ${line}`);
    }
    out.push('');
  });
  return crlf(out);
}

function educationFileText(p) {
  const rows = p.education || [];
  const out = [`EDUCATION — ${p.fullName || p.publicId}`, '='.repeat(70), ''];
  if (!rows.length) {
    out.push('(no education captured)');
    return crlf(out);
  }
  rows.forEach((e, i) => {
    out.push(`${String(i + 1).padStart(3)}. ${e.school}`);
    const line2 = [e.degree, e.field].filter(Boolean).join(', ');
    if (line2) out.push(`     ${line2}`);
    if (e.dates) out.push(`     ${e.dates}`);
    if (e.description) out.push(`     ${e.description}`);
    out.push('');
  });
  return crlf(out);
}

function postFileText(post) {
  return (post.text || '(no text)').replace(/\r?\n/g, '\r\n') + '\r\n';
}

/**
 * metadata.txt — the engagement record for one post.
 *
 * A count that LinkedIn did not return reads `unknown` rather than 0, because
 * the difference between "nobody reacted" and "not obtainable" matters when
 * these rows feed an outreach decision.
 */
function metadataFileText(post) {
  const out = [];
  out.push(kv('Post URL', post.postUrl || 'unknown'));
  out.push(kv('URN', post.urn || 'unknown'));
  out.push(kv('Type', post.type || 'unknown'));
  out.push(kv('Date posted', postedAt(post)));
  if (post.timestampSource === 'derived-from-urn') {
    out.push(kv('', '(derived from the post id — LinkedIn did not return an exact timestamp)'));
  }
  out.push('');
  out.push(kv('Reactions', nOf(post.reactions)));

  const byType = post.reactionsByType || {};
  const kinds = Object.keys(byType);
  if (kinds.length) {
    for (const k of kinds.sort((a, b) => byType[b] - byType[a])) {
      out.push(kv('  ' + U.reactionLabel(k), nOf(byType[k])));
    }
  } else {
    out.push(kv('  by type', 'not returned for this post'));
  }

  out.push(kv('Comments', nOf(post.comments)));
  out.push(kv('Reposts', nOf(post.reposts)));
  if (Array.isArray(post.hashtags) && post.hashtags.length) {
    out.push(kv('Hashtags', post.hashtags.map((h) => '#' + h).join(' ')));
  }
  out.push('');

  /*
   * What makes this post the kind of post it is. Three of the seven types
   * used to reach the archive as a type label and nothing else: an article
   * with no link, a poll with no result, a reshare with no idea whose post
   * it was.
   */
  if (post.repost) {
    out.push('RESHARED FROM');
    out.push(RULE);
    out.push(kv('Author', post.repost.author || '(not returned)'));
    if (post.repost.authorHeadline) out.push(kv('Headline', post.repost.authorHeadline));
    if (post.repost.authorUrl) out.push(kv('Profile', post.repost.authorUrl));
    out.push(kv('Original post', post.repost.postUrl || '(not returned)'));
    if (post.repost.text) {
      out.push('');
      for (const line of String(post.repost.text).split(/\r?\n/)) out.push(`  ${line}`);
    }
    out.push('');
  }

  if (post.article) {
    out.push('LINKED ARTICLE');
    out.push(RULE);
    out.push(kv('Title', post.article.title || '(untitled)'));
    if (post.article.subtitle) out.push(kv('Subtitle', post.article.subtitle));
    out.push(kv('URL', post.article.url || '(not returned)'));
    if (post.article.domain) out.push(kv('Domain', post.article.domain));
    out.push('');
  }

  if (post.poll) {
    const opts = Array.isArray(post.poll.options) ? post.poll.options : [];
    out.push(`POLL (${opts.length} option${opts.length === 1 ? '' : 's'})`);
    out.push(RULE);
    if (post.poll.question) out.push(post.poll.question);
    out.push(kv('Total votes', nOf(post.poll.totalVotes)));
    if (post.poll.closed) out.push(kv('Status', 'closed'));
    out.push('');
    opts.forEach((o, i) => {
      // A share only means something when the total is known, and a poll the
      // viewer has not voted in often reports neither.
      const share =
        o.votes != null && post.poll.totalVotes ? ` (${Math.round((o.votes / post.poll.totalVotes) * 100)}%)` : '';
      out.push(`${String(i + 1).padStart(3)}. ${o.text}`);
      out.push(`     ${nOf(o.votes)} vote(s)${share}`);
    });
    out.push('');
  }

  const media = mediaOf(post);
  out.push(`MEDIA (${media.length})`);
  out.push(RULE);
  if (!media.length) {
    // "None" and "we could not get it" are different facts, and only one of
    // them means the post genuinely had nothing attached.
    if (post.mediaUnavailable) {
      out.push('(this post declared media, but LinkedIn did not return it on');
      out.push(' either the feed response or the post page)');
    } else if (post.videosSkipped) {
      out.push('(video was dropped — "Skip video" was on for this run)');
    } else {
      out.push('(none)');
    }
  } else {
    media.forEach((m, i) => {
      const label = `${String(i + 1).padStart(3)}. ${m.type}`;
      if (m.type === 'video' && !m.url) {
        out.push(`${label} — adaptive stream only, not downloaded`);
        if (m.manifestUrl) out.push(`     manifest: ${m.manifestUrl}`);
        if (m.protocol) out.push(`     protocol: ${m.protocol}`);
      } else {
        out.push(`${label}`);
        if (m.url) out.push(`     ${m.url}`);
        if (m.type === 'document' && m.pages) out.push(`     pages: ${m.pages}`);
      }
    });
  }

  if (post.error) {
    out.push('');
    out.push(kv('Detail error', post.error));
  }
  return crlf(out);
}

function commentsFileText(post) {
  const list = Array.isArray(post.commentList) ? post.commentList : [];
  const out = [];
  out.push(`COMMENTS (${list.length})`);
  out.push(RULE);
  out.push('');

  if (!list.length) {
    if (post.commentError) out.push(`(could not be fetched: ${post.commentError})`);
    else if (post.comments) out.push('(not captured — the run ended before the comment pass)');
    else out.push('(no comments)');
    return crlf(out);
  }

  list.forEach((c, i) => {
    const when = c.at ? U.fmtTimestamp(c.at) : '';
    out.push(`${String(i + 1).padStart(4)}. ${c.author || '(unknown)'}${when ? '   [' + when + ']' : ''}`);
    if (c.headline) out.push(`      ${c.headline}`);
    if (c.profileUrl) out.push(`      ${c.profileUrl}`);
    if (c.reactions != null) out.push(`      reactions: ${nOf(c.reactions)}`);
    out.push('');
    for (const line of String(c.text || '(empty)').split(/\r?\n/)) out.push(`      ${line}`);
    out.push('');
  });

  if (post.commentsTruncated) {
    out.push(`(capped at ${list.length} of ${nOf(post.comments)} — see MAX_COMMENTS_PER_POST in utils.js)`);
  }
  return crlf(out);
}

/** The note that replaces a video the scraper deliberately did not download. */
function videoNoteText(videos) {
  const out = [];
  out.push('VIDEO NOT DOWNLOADED');
  out.push(RULE);
  out.push('');
  out.push('LinkedIn served this post\'s video as an adaptive stream (DASH or HLS)');
  out.push('rather than as a single downloadable file. An adaptive stream is a');
  out.push('manifest plus hundreds of separate media segments, and reassembling');
  out.push('one needs a muxer — deliberately out of scope here, because a bundled');
  out.push('muxer is a large dependency that breaks as formats move on.');
  out.push('');
  out.push('The manifest URLs are below. They are signed and expire, usually within');
  out.push('hours, so fetch them soon or re-run the scrape when you need them.');
  out.push('');
  out.push('The poster frame LinkedIn returned for this post has been saved beside');
  out.push('this file as poster_NN.jpg, so there is at least one still. Per-second');
  out.push('frames need a decodable file and there is none here.');
  out.push('');
  videos.forEach((v, i) => {
    out.push(`${i + 1}. ${v.protocol || 'stream'}`);
    out.push(`   ${v.manifestUrl || '(no manifest URL was returned either)'}`);
    if (v.durationMs) out.push(`   duration: ${Math.round(v.durationMs / 1000)}s`);
    if (v.thumbnail) out.push(`   poster:   ${v.thumbnail}`);
    out.push('');
  });
  out.push('Any external downloader that understands DASH/HLS will take the manifest');
  out.push('URL directly.');
  return crlf(out);
}

/**
 * posts.csv — the flat export.
 *
 * Exists because these results feed a spreadsheet pipeline. Every cell is
 * quoted and newlines inside a post body become a literal \n, so a multi-line
 * post can never split a row.
 */
function postsCsv(list) {
  // `folder` is what makes the type-grouped tree navigable from a spreadsheet:
  // sort or filter on any column and the path to that post's files is on the row.
  const head = [
    'post_url', 'date', 'type', 'folder', 'text', 'reactions', 'comments', 'reposts', 'media_count',
    // Everything past here is flat by necessity — the structured form of all
    // of it is in posts.json, which is what these columns point at.
    'hashtags', 'article_url', 'poll_votes', 'reshared_from', 'reshared_url'
  ];
  // A BOM so Excel opens UTF-8 correctly instead of mangling every accent.
  let out = '﻿' + U.csvRow(head);
  let n = 0;
  for (const p of list) {
    n++;
    out += U.csvRow([
      p.postUrl || '',
      p.publishedAt ? U.fmtTimestamp(p.publishedAt).replace(' UTC', '') : '',
      p.type || '',
      `Posts/${folderForType(p.type)}/Post_${U.pad(n, padWidth())}`,
      p.text || '',
      p.reactions == null ? '' : p.reactions,
      p.comments == null ? '' : p.comments,
      p.reposts == null ? '' : p.reposts,
      mediaOf(p).length,
      Array.isArray(p.hashtags) ? p.hashtags.map((h) => '#' + h).join(' ') : '',
      (p.article && p.article.url) || '',
      p.poll && p.poll.totalVotes != null ? p.poll.totalVotes : '',
      (p.repost && p.repost.author) || '',
      (p.repost && p.repost.postUrl) || ''
    ]);
  }
  return out;
}

/**
 * posts.json — the same posts with nothing flattened away.
 *
 * posts.csv is for a spreadsheet, so it carries one row per post and one
 * value per cell: a media *count* rather than the URLs, a vote total rather
 * than the split across options. The article card, the poll breakdown, the
 * reshare provenance and every media URL are structure, and structure does
 * not survive a CSV. This is the record the scraper actually holds.
 *
 * `commentList` is stripped deliberately. Comments are third-party personal
 * data and the archive keeps every one of them under Comments/ precisely so
 * they can be reviewed or deleted in one place; copying them in here would
 * quietly break that.
 */
function postsJson(list) {
  return JSON.stringify(
    list.map((p) => {
      const out = Object.assign({}, p);
      delete out.commentList;
      delete out.index; // an internal position, not part of the record
      return out;
    }),
    null,
    2
  );
}

function readmeFileText(stats) {
  const p = state.profile || {};
  const out = [];
  out.push(`LinkedIn export — ${p.fullName || state.publicId}`);
  out.push('='.repeat(70));
  out.push('');
  out.push(kv('Profile', U.profileUrl(state.publicId)));
  out.push(kv('Collected', `${posts.length} post(s)`));
  out.push(kv('Requested', `${state.maxPosts}`));
  out.push(kv('Scraped', new Date().toISOString()));
  out.push(kv('Requests used', `${state.requests} of ${L.SESSION_MAX_REQUESTS} in the session budget`));
  out.push('');

  out.push('WHAT IS IN HERE');
  out.push(RULE);
  out.push('Profile/        profile.txt (readable), profile.json (full record),');
  out.push('                experience.txt, education.txt, and the profile picture');
  out.push('                and banner where they were available.');
  out.push('Posts/          grouped by kind, then one folder per post. Every post');
  out.push('                folder holds post.txt (the body) and metadata.txt (the');
  out.push('                engagement record).');
  const groups = new Map();
  for (const p of posts) {
    const f = folderForType(p.type);
    groups.set(f, (groups.get(f) || 0) + 1);
  }
  for (const name of ['Photos', 'Videos', 'Documents', 'Articles', 'Reposts', 'Polls', 'Text']) {
    if (!groups.has(name)) continue;
    out.push(`  ${(name + '/' + ' '.repeat(12)).slice(0, 12)}  ${groups.get(name)} post(s)`);
  }
  out.push('');
  out.push('                Post numbers are global, so Post_007 appears exactly');
  out.push('                once no matter which group it landed in.');
  if (stats.undownloadableVideos || groups.has('Videos')) {
    out.push('                Videos: video_NN.mp4 is the file, video_NN_frames/');
    out.push('                holds one still per second, poster_NN.jpg is the');
    out.push('                thumbnail LinkedIn returned.');
  }
  if (state.options.includeComments) {
    out.push('Comments/       one file per post, named for its post number. Kept');
    out.push('                together deliberately — see DATA HANDLING below.');
  }
  out.push('posts.csv       one row per post, for spreadsheet work. The `folder`');
  out.push('                column points at that post\'s folder in this archive.');
  out.push('posts.json      the same posts with nothing flattened: every media URL,');
  out.push('                the poll breakdown, the article card, the reshare it came');
  out.push('                from. Comments are not duplicated here — see below.');
  out.push('');

  out.push('COMPLETENESS');
  out.push(RULE);
  if (state.pagination && state.pagination.stoppedEarly) {
    out.push(`LinkedIn stopped returning more posts after ${state.pagination.pages} page(s).`);
    out.push(`Reason recorded: ${state.pagination.reason}`);
    out.push('');
    out.push('This is normal. LinkedIn degrades profile-activity pagination and then');
    out.push('stops well before an account\'s full history. This export is what it was');
    out.push('willing to return, not everything the account has ever posted.');
  } else if (posts.length >= state.maxPosts) {
    out.push(`Stopped at the requested ceiling of ${state.maxPosts} posts.`);
  } else {
    out.push(`Collected ${posts.length} posts. Pagination ended without an explicit stop signal.`);
  }
  if (state.status === 'session_limit_reached') {
    out.push('');
    out.push(`The run also hit its session request budget (${L.SESSION_MAX_REQUESTS}) and ended early,`);
    out.push('deliberately, rather than pushing further into restriction territory.');
  }
  if (stats.undownloadableVideos) {
    out.push('');
    out.push(`${stats.undownloadableVideos} video(s) were served as adaptive streams only and were not`);
    out.push('downloaded. Each affected post has a video_not_downloaded.txt with the');
    out.push('manifest URL and an explanation.');
  }
  if (state.failedCount) {
    out.push('');
    out.push(`${state.failedCount} post(s) failed a detail fetch and may be missing text or counts.`);
  }
  out.push('');

  out.push('DATA HANDLING');
  out.push(RULE);
  if (state.options.includeComments) {
    out.push('*** This export contains third-party personal data. ***');
    out.push('');
    out.push('The comments.txt files hold other people\'s names, headlines, profile');
    out.push('URLs and written comments. Those people did not ask to be in a file on');
    out.push('your disk. Retention, lawful basis and deletion are your responsibility');
    out.push('as the operator — under GDPR, UK GDPR, CCPA or whatever applies to you.');
    out.push('Keep it only as long as you actually need it, and do not redistribute it.');
    out.push('');
    out.push('No commenter profile was fetched. Only what appeared beside the comment');
    out.push('itself is here — this scraper deliberately does not follow those links.');
  } else {
    out.push('Comments were not collected, so this export contains no third-party');
    out.push('personal data beyond what the target profile published itself.');
  }
  out.push('');
  out.push('Collected from an ordinary logged-in browser session. LinkedIn\'s User');
  out.push('Agreement prohibits automated collection — see the README in the');
  out.push('extension folder.');
  return crlf(out);
}

/* ---------------------------------------------------------------- *
 * Offscreen packaging
 * ---------------------------------------------------------------- */
let offscreenSetup = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('offscreen API not available');
  if (!offscreenSetup) {
    offscreenSetup = (async () => {
      const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
      if (!has) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['BLOBS'],
          justification: 'Package downloaded media into a single .zip and build large export files.'
        });
      }
    })().catch((err) => {
      offscreenSetup = null;
      throw err;
    });
  }
  return offscreenSetup;
}

const offscreenSend = (msg) => chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));

async function closeOffscreen() {
  if (chrome.offscreen && chrome.offscreen.closeDocument) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  offscreenSetup = null;
}

/* ---------------------------------------------------------------- *
 * Single-archive packaging
 * ---------------------------------------------------------------- */
let zipCancelled = false;

/*
 * Post type -> the folder it files under.
 *
 * Grouping by kind means "show me the photos" is one folder rather than a walk
 * through every numbered post. The number stays global across the groups, so a
 * row in posts.csv still names exactly one folder and nothing is renumbered
 * when a post changes type between runs.
 */
const TYPE_FOLDER = {
  image: 'Photos',
  video: 'Videos',
  document: 'Documents',
  article: 'Articles',
  repost: 'Reposts',
  poll: 'Polls',
  text: 'Text'
};
const folderForType = (t) => TYPE_FOLDER[t] || 'Text';

/** `Posts/Photos/Post_007` — the folder one post owns. */
function postFolder(root, post, n) {
  return `${root}/Posts/${folderForType(post.type)}/Post_${U.pad(n, padWidth())}`;
}

/** Every file that belongs in the archive, as paths plus a URL or literal text. */
function zipEntries() {
  const root = U.sanitizeSegment(state.publicId, 'profile');
  const items = [];
  const stats = countMedia();

  /* ---- Profile/ ---- */
  const p = state.profile;
  if (p && p.publicId !== undefined) {
    items.push({ path: `${root}/Profile/profile.txt`, text: profileFileText(p) });
    items.push({ path: `${root}/Profile/profile.json`, text: JSON.stringify(p, null, 2) });
    items.push({ path: `${root}/Profile/experience.txt`, text: experienceFileText(p) });
    items.push({ path: `${root}/Profile/education.txt`, text: educationFileText(p) });

    if (state.options.includeProfileMedia) {
      if (p.photoUrl && /^https?:/i.test(p.photoUrl)) {
        items.push({ path: `${root}/Profile/profile_picture.${U.extFromUrl(p.photoUrl)}`, url: p.photoUrl });
      }
      if (p.bannerUrl && /^https?:/i.test(p.bannerUrl)) {
        items.push({ path: `${root}/Profile/banner.${U.extFromUrl(p.bannerUrl)}`, url: p.bannerUrl });
      }
    }
  }

  /* ---- Posts/<Type>/ and Comments/ ---- */
  let postNo = 0;

  for (const post of posts) {
    const n = ++postNo;
    const folder = postFolder(root, post, n);
    const media = mediaOf(post);

    items.push({ path: `${folder}/post.txt`, text: postFileText(post) });
    items.push({ path: `${folder}/metadata.txt`, text: metadataFileText(post) });

    /*
     * Comments live in one top-level folder rather than scattered through the
     * post tree, so the third-party data this export contains is in a single
     * place — easy to review, and easy to delete without touching anything
     * else. The filename carries the post number so it maps back.
     */
    if (state.options.includeComments) {
      items.push({
        path: `${root}/Comments/Post_${U.pad(n, padWidth())}_comments.txt`,
        text: commentsFileText(post)
      });
    }

    /*
     * An article post's hero image is on the card, not in `media`, so nothing
     * ever downloaded it — the post folder held two text files and no picture
     * for a post that is visually a picture and a headline.
     */
    if (post.article && post.article.thumbnail && /^https?:/i.test(post.article.thumbnail)) {
      items.push({
        path: `${folder}/article_cover.${U.extFromUrl(post.article.thumbnail, 'jpg')}`,
        url: post.article.thumbnail
      });
    }

    let mediaNo = 0;
    let videoNo = 0;
    let docNo = 0;
    // Posters are numbered independently of videos: a stranded stream gets a
    // poster but never a video file, so sharing one counter made the next
    // video's poster reuse a number that was already taken.
    let posterNo = 0;
    const strandedVideos = [];

    for (const m of media) {
      if (m.type === 'document') {
        /*
         * Numbered like every other media kind. A post carrying two documents
         * wrote `document.txt` twice — the same path, so the second entry
         * shadowed the first on extraction and one document's record was lost.
         * The first keeps the plain name so the common single-document post
         * looks the way it always has.
         */
        docNo++;
        const stem = docNo === 1 ? 'document' : `document_${U.pad(docNo, 2)}`;
        if (m.url && /^https?:/i.test(m.url)) {
          items.push({
            path: `${folder}/${U.sanitizeSegment(m.title || stem)}.${U.extFromUrl(m.url, 'pdf')}`,
            url: m.url
          });
        }
        items.push({
          path: `${folder}/${stem}.txt`,
          text: crlf(
            [
              kv('From post', post.postUrl || 'unknown'),
              kv('Title', m.title || '(untitled)'),
              kv('Pages', m.pages == null ? 'unknown' : String(m.pages)),
              m.url ? kv('Source URL', m.url) : kv('Source URL', 'not returned — nothing to download'),
              m.manifestUrl ? kv('Manifest', m.manifestUrl) : ''
            ].filter(Boolean)
          )
        });
        continue;
      }

      if (m.type === 'video') {
        // The poster is worth having either way — it is the only still that
        // exists for a stream that cannot be downloaded.
        if (m.thumbnail && /^https?:/i.test(m.thumbnail)) {
          items.push({ path: `${folder}/poster_${U.pad(++posterNo, 2)}.jpg`, url: m.thumbnail });
        }
        if (!m.url || !/^https?:/i.test(m.url)) {
          strandedVideos.push(m);
          continue;
        }
        videoNo++;
        const stem = `video_${U.pad(videoNo, 2)}`;
        items.push({
          path: `${folder}/${stem}.${U.extFromUrl(m.url, 'mp4')}`,
          url: m.url,
          /*
           * Tells the offscreen document to decode this one after it lands and
           * write a still per second alongside it. It is the only item kind
           * that produces more entries than it declares, so the progress total
           * is a floor rather than an exact count.
           */
          video: { framesDir: `${folder}/${stem}_frames`, intervalSec: 1 }
        });
        continue;
      }

      if (!m.url || !/^https?:/i.test(m.url)) continue;
      items.push({ path: `${folder}/media_${U.pad(++mediaNo, 2)}.${U.extFromUrl(m.url, 'jpg')}`, url: m.url });
    }

    if (strandedVideos.length) {
      items.push({ path: `${folder}/video_not_downloaded.txt`, text: videoNoteText(strandedVideos) });
    }
  }

  /* ---- top level ---- */
  items.push({ path: `${root}/posts.csv`, text: postsCsv(posts) });
  items.push({ path: `${root}/posts.json`, text: postsJson(posts) });
  items.push({ path: `${root}/README.txt`, text: readmeFileText(stats) });

  return dedupePaths(items);
}

/**
 * Guarantees every entry lands on its own path.
 *
 * A ZIP will happily carry the same path twice and every extractor keeps
 * whichever it reads last, so a collision is silent data loss — the archive
 * completes, just missing a file, which is the failure mode this whole export
 * is written to avoid. The numbering above stops the collisions that are
 * predictable; this catches the ones that come from the data. Two documents on
 * one post sharing a title is the common case, and a document actually titled
 * "post" or "metadata" is the nasty one, because it lands on the post body or
 * its engagement record.
 *
 * Renamed rather than dropped: a `_2` suffix is a worse filename, and losing
 * the file is a worse archive.
 */
function dedupePaths(items) {
  const taken = new Set();
  for (const item of items) {
    if (!taken.has(item.path)) {
      taken.add(item.path);
      continue;
    }
    const slash = item.path.lastIndexOf('/');
    const dot = item.path.lastIndexOf('.');
    const stem = dot > slash ? item.path.slice(0, dot) : item.path;
    const ext = dot > slash ? item.path.slice(dot) : '';
    let n = 2;
    while (taken.has(`${stem}_${n}${ext}`)) n++;
    item.path = `${stem}_${n}${ext}`;
    taken.add(item.path);
  }
  return items;
}

async function buildZip() {
  await ensureLoaded();
  if (!posts.length && !state.profile) {
    return { ok: false, error: 'Nothing to package yet — run a scrape first.' };
  }
  if (state.zip && state.zip.building) return { ok: false, error: 'Already packaging.' };

  const items = zipEntries();
  const mediaCount = items.filter((i) => i.url).length;
  const videoCount = items.filter((i) => i.video).length;
  zipCancelled = false;
  const skippedEntries = [];
  state.zip = { building: true, done: 0, total: items.length, bytes: 0, failed: 0, frames: 0, filename: '' };
  if (videoCount) {
    addLog(
      'info',
      `${videoCount} video(s) will be decoded for one frame per second — this is the slow part of the export.`
    );
  }
  addLog('info', `Packaging ${posts.length} posts — ${items.length} files (${mediaCount} to download)...`);
  broadcast(true);

  // Fetching media and writing the archive can run for many minutes, and the
  // download wait that follows it is a bare timer. Hold the worker up for all
  // of it rather than losing a finished archive to an eviction.
  keepAliveStart();
  try {
    await ensureOffscreen();
    const init = await offscreenSend({ type: 'ZIP_INIT' });
    if (!init || !init.ok) throw new Error((init && init.error) || 'could not start the archive');

    const BATCH = 20;
    const groups = [];
    for (let i = 0; i < items.length; i += BATCH) groups.push(items.slice(i, i + BATCH));

    let sent = 0;
    for (const group of groups) {
      if (zipCancelled) {
        await offscreenSend({ type: 'ZIP_ABORT' }).catch(() => {});
        addLog('warn', 'Packaging cancelled.');
        return { ok: false, error: 'cancelled' };
      }
      const res = await offscreenSend({ type: 'ZIP_ADD', items: group });
      if (!res || !res.ok) throw new Error((res && res.error) || 'archive write failed');

      sent += group.length;
      state.zip.done = Math.min(items.length, sent);
      state.zip.bytes = res.bytes || 0;
      if (res.framesWritten) {
        state.zip.frames = (state.zip.frames || 0) + res.framesWritten;
        addLog('info', `Extracted ${res.framesWritten} video frame(s).`);
      }
      if (res.failed && res.failed.length) {
        state.zip.failed += res.failed.length;
        // Expired signed CDN links are the usual cause; name a couple, then count.
        for (const f of res.failed.slice(0, 2)) addLog('warn', `Skipped ${f.path}: ${f.error}`);
        // Everything, so a partial archive can be reconciled against the source.
        for (const f of res.failed) skippedEntries.push(f);
      }
      broadcast(true);
    }

    /*
     * Checked once more after the loop, not only at the top of it. With
     * twenty entries to a batch, a small export is a single group — so every
     * cancel fell straight through to ZIP_FINISH and saved a truncated
     * archive, reported as a success, with no record of what was left out.
     */
    if (zipCancelled) {
      await offscreenSend({ type: 'ZIP_ABORT' }).catch(() => {});
      addLog('warn', 'Packaging cancelled — nothing was saved.');
      return { ok: false, error: 'cancelled' };
    }

    /*
     * A manifest of what did not make it. An expired signed CDN link is the
     * usual cause and it is invisible otherwise — the archive completes, just
     * lighter than expected. Writing the list means a short export can be
     * reconciled against the source instead of guessed at.
     */
    if (skippedEntries.length) {
      const root = U.sanitizeSegment(state.publicId, 'profile');
      const lines = [
        `SKIPPED — ${skippedEntries.length} entr${skippedEntries.length === 1 ? 'y' : 'ies'}`,
        RULE,
        '',
        'These could not be written. LinkedIn signs its media URLs with a short',
        'expiry, so the most common cause is simply time passing between the',
        'scrape and this export — re-run the scrape and export straight after.',
        ''
      ];
      for (const f of skippedEntries) {
        lines.push(f.path);
        lines.push(`     reason: ${f.error}`);
        if (f.url) lines.push(`     url:    ${f.url}`);
        lines.push('');
      }
      await offscreenSend({
        type: 'ZIP_ADD',
        items: [{ path: `${root}/skipped.txt`, text: crlf(lines) }]
      }).catch(() => {});
    }

    // The name must be decided before the blob exists: it is baked into the
    // File the offscreen document creates, and that is what Chrome reads.
    const base = `${U.sanitizeSegment(state.publicId, 'profile')}.zip`;

    const fin = await offscreenSend({ type: 'ZIP_FINISH', name: base });
    if (!fin || !fin.ok) throw new Error((fin && fin.error) || 'could not finish the archive');

    pendingArchive = { url: fin.url, filename: base };
    let savedAs = base;

    let dlId = null;
    const noteDownload = (item) => {
      // onCreated fires for every download, so ignore anything the user might
      // start in this window — only the archive's own blob counts.
      if (dlId != null) return;
      if (item.url !== fin.url && !String(item.url || '').startsWith('blob:')) return;
      dlId = item.id;
    };
    chrome.downloads.onCreated.addListener(noteDownload);
    try {
      const saved = await offscreenSend({ type: 'ZIP_SAVE', url: fin.url, name: base });
      if (!saved || !saved.ok) throw new Error((saved && saved.error) || 'could not start the download');

      if (!(await waitUntil(() => dlId != null, 6000))) {
        addLog('warn', 'Anchor save did not start — falling back to the downloads API.');
        dlId = await chrome.downloads.download({
          url: fin.url,
          filename: base,
          conflictAction: 'uniquify',
          saveAs: false
        });
      }
      await waitForDownload(dlId, 1800000);
      savedAs = await writtenFilename(dlId, base);
    } finally {
      chrome.downloads.onCreated.removeListener(noteDownload);
      pendingArchive = null;
      await offscreenSend({ type: 'REVOKE_BLOB_URL', url: fin.url }).catch(() => {});
    }

    state.zip.filename = savedAs;
    addLog(
      'success',
      `Saved ${savedAs} — ${fin.count} files, ${U.fmtBytes(fin.bytes)}` +
        (state.zip.failed ? ` (${state.zip.failed} skipped)` : '')
    );
    return { ok: true, filename: savedAs, files: fin.count, bytes: fin.bytes, failed: state.zip.failed };
  } catch (err) {
    addLog('error', `Packaging failed: ${err.message}`);
    await offscreenSend({ type: 'ZIP_ABORT' }).catch(() => {});
    return { ok: false, error: err.message };
  } finally {
    state.zip.building = false;
    await closeOffscreen();
    broadcast(true);
    schedulePersist(true);
    keepAliveStop();
  }
}

function waitForDownload(id, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      fn(arg);
    };
    const onChanged = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') finish(resolve, true);
      else if (d.state.current === 'interrupted') finish(reject, new Error('download interrupted'));
    };
    const timer = setTimeout(() => finish(reject, new Error('download timed out')), timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
    // It may already have finished before the listener attached.
    chrome.downloads
      .search({ id })
      .then((r) => {
        const d = r && r[0];
        if (d && d.state === 'complete') finish(resolve, true);
        if (d && d.state === 'interrupted') finish(reject, new Error('download interrupted'));
      })
      .catch(() => {});
  });
}

/* ---------------------------------------------------------------- *
 * Archive naming
 *
 * Naming a blob download is unreliable from one angle alone, so three are
 * used together: the offscreen document wraps the archive in a named File
 * (the one that actually decides it), download() passes `filename`, and this
 * listener overrides whatever Chrome picked.
 * ---------------------------------------------------------------- */
let pendingArchive = null;

function waitUntil(pred, timeoutMs, stepMs = 150) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

/** The name Chrome actually gave a finished download, relative to Downloads/. */
async function writtenFilename(id, fallback) {
  try {
    const r = await chrome.downloads.search({ id });
    const full = r && r[0] && r[0].filename;
    if (!full) return fallback;
    const parts = full.split(/[\\/]/);
    return parts.length > 1 ? parts.slice(-2).join('/') : parts[0];
  } catch (_) {
    return fallback;
  }
}

if (chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const p = pendingArchive;
    if (!p) return; // not ours — leave the user's own downloads alone
    if (item.url !== p.url && !String(item.url || '').startsWith('blob:')) return;
    pendingArchive = null;
    suggest({ filename: p.filename, conflictAction: 'uniquify' });
  });
}

/** Every post-bucket key currently in storage, so nothing is orphaned. */
async function allChunkKeys() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => /^lis_posts_\d+$/.test(k));
}

async function clearAll() {
  await ensureLoaded();
  // Same reason as startScrape: the build writes into `state.zip`, and
  // replacing `state` underneath it strands the build and unlocks its guard.
  if (state.zip && state.zip.building) {
    return { ok: false, error: 'Still packaging the archive — wait for the export to finish.' };
  }
  const tabId = state.tabId;
  const keys = await allChunkKeys();
  state = blankState();
  state.tabId = tabId;
  posts = [];
  postIndex = new Map();
  dirtyChunks.clear();
  await chrome.storage.local.remove([U.KEYS.STATE, U.KEYS.INDEX].concat(keys));
  addLog('info', 'Cleared stored results.');
  setStatus('idle');
  return { ok: true };
}

/* ---------------------------------------------------------------- *
 * Popup messages
 * ---------------------------------------------------------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.target === 'offscreen') return; // not ours

  (async () => {
    await ensureLoaded();
    switch (msg.type) {
      case MSG.GET_STATE:
        return { ok: true, state: publicState() };
      case MSG.START_SCRAPE:
        return startScrape(msg);
      case MSG.STOP_SCRAPE:
        return stopScrape();
      case MSG.RESUME_SCRAPE:
        return resumeScrape();
      case MSG.BUILD_ZIP:
        return buildZip();
      case MSG.CANCEL_ZIP:
        zipCancelled = true;
        // The group loop only reads the flag between batches, and a batch is 20
        // media fetches — tell the packer directly so an in-flight batch stops
        // pulling from its queue instead of running to the end first.
        offscreenSend({ type: 'ZIP_CANCEL' }).catch(() => {});
        return { ok: true };
      case MSG.CLEAR:
        return clearAll();
      case MSG.FOCUS_TAB:
        if (state.tabId != null) {
          const t = await chrome.tabs.get(state.tabId).catch(() => null);
          if (t) {
            await chrome.tabs.update(t.id, { active: true });
            await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
            return { ok: true };
          }
        }
        return { ok: false, error: 'No LinkedIn tab.' };
      default:
        return { ok: false, error: `Unknown message: ${msg.type}` };
    }
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true; // async response
});

chrome.runtime.onInstalled.addListener(() => {
  ensureLoaded();
});
chrome.runtime.onStartup.addListener(() => {
  ensureLoaded();
});
