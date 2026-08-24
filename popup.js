/*
 * popup.js — thin view over the state the service worker owns.
 *
 * The popup holds no scrape state of its own: it asks for a snapshot on open
 * and re-renders on every STATE_UPDATE broadcast, so closing and reopening it
 * never affects a run in progress.
 */
(function () {
  'use strict';

  const U = globalThis.LIS;
  const MSG = U.MSG;
  const L = U.LIMITS;
  const $ = (id) => document.getElementById(id);

  const el = {
    statusPill: $('statusPill'),
    statusText: $('statusText'),
    publicId: $('publicId'),
    maxPosts: $('maxPosts'),
    optIncludePosts: $('optIncludePosts'),
    optIncludeComments: $('optIncludeComments'),
    optSkipVideos: $('optSkipVideos'),
    optIncludeProfileMedia: $('optIncludeProfileMedia'),
    optFullProfile: $('optFullProfile'),
    btnStart: $('btnStart'),
    startLabel: $('startLabel'),
    btnStop: $('btnStop'),
    alert: $('alert'),
    alertText: $('alertText'),
    btnResume: $('btnResume'),
    btnOpenTab: $('btnOpenTab'),
    progressText: $('progressText'),
    pct: $('pct'),
    eta: $('eta'),
    barFill: $('barFill'),
    statPosts: $('statPosts'),
    statMedia: $('statMedia'),
    statComments: $('statComments'),
    statFailed: $('statFailed'),
    budgetText: $('budgetText'),
    budgetBar: $('budgetBar'),
    paginationNote: $('paginationNote'),
    stageLine: $('stageLine'),
    profileBox: $('profileBox'),
    avatar: $('avatar'),
    pName: $('pName'),
    pHeadline: $('pHeadline'),
    pStats: $('pStats'),
    btnZip: $('btnZip'),
    zipLabel: $('zipLabel'),
    zipProgress: $('zipProgress'),
    zipBar: $('zipBar'),
    zipText: $('zipText'),
    btnZipCancel: $('btnZipCancel'),
    btnClear: $('btnClear'),
    log: $('log'),
    logCount: $('logCount')
  };

  const presets = [...document.querySelectorAll('.preset')];
  const inputs = [
    el.publicId,
    el.maxPosts,
    el.optIncludePosts,
    el.optIncludeComments,
    el.optSkipVideos,
    el.optIncludeProfileMedia,
    el.optFullProfile
  ].concat(presets);

  const BUSY = ['starting', 'running', 'stopping'];
  const STATUS_LABEL = {
    idle: 'Idle',
    starting: 'Starting',
    running: 'Scraping',
    paused: 'Paused',
    stopping: 'Stopping',
    stopped: 'Stopped',
    done: 'Done',
    error: 'Error',
    interrupted: 'Interrupted',
    session_limit_reached: 'Session cap'
  };

  // The pill is a glance, so it gets one word rather than the full label.
  const STAGE_SHORT = { detail: 'Detail', comments: 'Comments' };

  let lastState = null;

  /*
   * Messages the popup raised itself: a rejected profile id, a failed
   * Start, the comments warning.
   *
   * They used to be appended straight into the log element, which the very
   * next render() wiped — and every one of those call sites calls refresh()
   * immediately after, so "Could not start." was on screen for about a
   * hundred milliseconds. Holding them here means renderLog() can put them
   * back after each repaint.
   */
  let transient = [];
  const MAX_TRANSIENT = 5;

  /** The avatar URL currently assigned to the <img>, or null. */
  let shownAvatar = null;
  /** True between the Resume click and the worker's answer. */
  let resumeInFlight = false;

  const send = (message) =>
    chrome.runtime.sendMessage(message).catch((e) => ({ ok: false, error: e.message }));

  /* ------------------------------------------------------------- *
   * Form persistence
   * ------------------------------------------------------------- */
  function readForm() {
    return {
      publicId: el.publicId.value,
      maxPosts: el.maxPosts.value,
      options: {
        includePosts: el.optIncludePosts.checked,
        includeComments: el.optIncludeComments.checked,
        skipVideos: el.optSkipVideos.checked,
        includeProfileMedia: el.optIncludeProfileMedia.checked,
        fullProfile: el.optFullProfile.checked
      }
    };
  }

  function applyForm(f) {
    if (!f) return;
    if (f.publicId != null) el.publicId.value = f.publicId;
    if (f.maxPosts != null) el.maxPosts.value = f.maxPosts;
    const o = f.options || {};
    el.optIncludePosts.checked = o.includePosts !== false;
    // Comments stay opt-in: never restored as on unless explicitly saved on.
    el.optIncludeComments.checked = o.includeComments === true;
    el.optSkipVideos.checked = !!o.skipVideos;
    el.optIncludeProfileMedia.checked = o.includeProfileMedia !== false;
    el.optFullProfile.checked = o.fullProfile !== false;
  }

  const saveForm = () => chrome.storage.local.set({ [U.KEYS.FORM]: readForm() });

  /* ------------------------------------------------------------- *
   * Render
   * ------------------------------------------------------------- */
  function render(state) {
    if (!state) return;

    const busy = BUSY.includes(state.status);
    const paused = state.status === 'paused';
    // Packaging is not a scrape status, so a build in flight leaves the run
    // reading "done" — and Start was enabled straight over the top of it.
    const packaging = !!(state.zip && state.zip.building);
    const live = busy || paused;

    el.statusPill.className = 'pill ' + state.status;
    /*
     * Only while the run is actually running. `busy` includes 'stopping', and
     * the content script keeps emitting its stage after the flag is set, so
     * the stale stage word kept overwriting "Stopping" — pressing Stop during
     * the detail or comments pass changed nothing on screen for twelve
     * seconds, and STATUS_LABEL.stopping was dead code.
     */
    const stageWord = state.status === 'running' && STAGE[state.stage] ? STAGE_SHORT[state.stage] : null;
    el.statusText.textContent = stageWord || STATUS_LABEL[state.status] || state.status;

    el.btnStart.disabled = live || packaging;
    el.btnStart.classList.toggle('busy', busy);
    el.startLabel.textContent = busy
      ? 'Scraping…'
      : paused
        ? 'Paused'
        : packaging
          ? 'Packaging…'
          : 'Start scrape';
    // Not re-armed while the stop is being honoured: the next broadcast is
    // ~200ms away and a second click sends a second STOP into the same run.
    el.btnStop.disabled = !live || state.status === 'stopping';
    inputs.forEach((c) => (c.disabled = live));

    /* progress */
    const total = state.target || state.maxPosts || 0;
    const got = state.postsCount || 0;
    el.progressText.textContent = `${got} / ${total || '—'}`;

    /*
     * The bar follows whichever pass is running, not the collected count.
     *
     * Harvesting is the first of three. Once it hits the target the collected
     * ratio is pinned at 100% while the detail pass and then the comment pass
     * run — a quarter of an hour on a 100-post run with nothing on screen
     * moving, which reads as a run that has finished and will not stop.
     */
    const st = renderStage(state, busy);
    const ratio = st.ratio != null ? st.ratio : total ? Math.min(1, got / total) : 0;
    el.pct.textContent = st.ratio != null || total ? Math.round(ratio * 100) + '%' : '—';
    el.barFill.style.width = ratio * 100 + '%';
    el.barFill.classList.toggle('live', busy);
    el.eta.textContent = busy ? st.eta || etaText(state, got, total) : '';

    syncPresets();

    el.statPosts.textContent = got;
    el.statMedia.textContent = state.mediaCount || 0;
    el.statComments.textContent = state.commentsCount || 0;
    el.statFailed.textContent = state.failedCount || (state.failed || []).length;

    renderBudget(state);
    renderPaginationNote(state);

    /* attention banner (login / challenge / rate limit / interruption / error) */
    const resumable = paused || state.status === 'interrupted' || state.status === 'session_limit_reached';
    const isError = state.status === 'error';
    let banner = '';
    /*
     * Only while the run can still act on it. A checkpoint tears the content
     * script down, so C_DONE never arrives and the worker's settle timer flips
     * straight to 'stopped' with the attention message still set — leaving an
     * amber notice telling the user to press a Resume button that is hidden
     * one line below, and implying a run that is over is still recoverable.
     */
    if (state.attention && state.attention.message && (live || resumable)) banner = state.attention.message;
    // A paused run always carries an attention message, but a paused state
    // restored from storage may not — and an amber box with no text in it
    // says nothing about why the run stopped.
    else if (paused) banner = 'Paused. Check the LinkedIn tab, then Resume.';
    else if (state.status === 'interrupted') banner = 'Scrape was interrupted. Resume to continue where it stopped.';
    else if (state.status === 'session_limit_reached') {
      banner =
        `Stopped at the ${state.sessionCap || L.SESSION_MAX_REQUESTS}-request session budget with everything kept. ` +
        'Leave it a while before resuming — the budget exists because LinkedIn throttles cumulatively.';
    } else if (isError && state.error) banner = state.error;

    el.alert.classList.toggle('hidden', !banner && !resumable);
    // Red when the run failed, amber when it's paused waiting on the user.
    el.alert.classList.toggle('is-error', isError);
    el.alertText.textContent = banner;
    el.btnResume.classList.toggle('hidden', !resumable);
    // Not re-enabled unconditionally: a broadcast lands within ~200ms of the
    // click, so doing that put the button back before the worker had answered
    // and a second click sent a second RESUME into the same run.
    if (!resumeInFlight) el.btnResume.disabled = false;

    renderProfile(state.profile);

    /* export */
    const zip = state.zip || {};
    const hasData = got > 0 || !!state.profile;
    const canExport = hasData && !busy && !zip.building;
    el.btnZip.disabled = !canExport;
    // `live`, not `busy`: every other control here treats a paused run as
    // in-flight, and this one button wiped the cursor and every collected post
    // — with no confirmation — while the Resume button sat above it.
    el.btnClear.disabled = live || zip.building || (!hasData && state.status === 'idle');

    el.btnZip.classList.toggle('busy', !!zip.building);
    el.zipLabel.textContent = zip.building ? 'Packaging…' : 'Download everything as ZIP';
    el.zipProgress.classList.toggle('hidden', !zip.building);
    if (zip.building) {
      const pct = zip.total ? Math.round((zip.done / zip.total) * 100) : 0;
      el.zipBar.style.width = pct + '%';
      el.zipText.textContent =
        `${zip.done} / ${zip.total} files · ${U.fmtBytes(zip.bytes)}` +
        // Frames are entries the total never counted, so they are reported
        // separately rather than making the progress bar look wrong.
        (zip.frames ? ` · ${zip.frames} frames` : '') +
        (zip.failed ? ` · ${zip.failed} skipped` : '');
    }

    renderLog(state.log || []);
  }

  /*
   * What each pass is called, and what it is counting. `harvest` is the one
   * the "Collected x / y" figure above already describes, so it says nothing.
   */
  const STAGE = {
    detail: { label: 'Fetching post detail', unit: 'posts' },
    comments: { label: 'Fetching comments', unit: 'posts' }
  };

  /** Shows the running pass, and returns the ratio and ETA it implies. */
  function renderStage(state, busy) {
    const s = STAGE[state.stage];
    const total = state.stageTotal || 0;
    if (!s || !busy || !total) {
      el.stageLine.classList.add('hidden');
      el.stageLine.textContent = '';
      return { ratio: null, eta: '' };
    }

    const done = Math.min(total, state.stageDone || 0);
    const ratio = Math.min(1, done / total);

    let eta = '';
    if (state.stageStartedAt && done >= 3 && done < total) {
      const rate = done / ((Date.now() - state.stageStartedAt) / 1000);
      if (isFinite(rate) && rate > 0) eta = '~' + U.fmtDuration((total - done) / rate) + ' left';
    }

    el.stageLine.classList.remove('hidden');
    el.stageLine.textContent = '';
    const what = document.createElement('span');
    what.textContent = s.label;
    const count = document.createElement('b');
    count.textContent = `${done} / ${total} ${s.unit}`;
    el.stageLine.appendChild(what);
    el.stageLine.appendChild(count);
    return { ratio, eta };
  }

  /**
   * The session request meter.
   *
   * Shown at all times rather than only when close to the ceiling: knowing a
   * run has spent 240 of 300 requests is what tells you whether to start
   * another one today.
   */
  function renderBudget(state) {
    const cap = state.sessionCap || L.SESSION_MAX_REQUESTS;
    const used = state.requests || 0;
    const ratio = cap ? Math.min(1, used / cap) : 0;
    el.budgetText.textContent = `${used} / ${cap}`;
    el.budgetBar.style.width = ratio * 100 + '%';
    el.budgetBar.classList.toggle('warn', ratio >= 0.75 && ratio < 1);
    el.budgetBar.classList.toggle('full', ratio >= 1);
  }

  /**
   * Says plainly that LinkedIn stopped, rather than letting a finished run
   * imply the account was exhausted.
   */
  function renderPaginationNote(state) {
    const p = state.pagination;
    const done = ['done', 'stopped', 'session_limit_reached', 'interrupted'].includes(state.status);
    if (!p || !p.stoppedEarly || !done) {
      el.paginationNote.classList.add('hidden');
      el.paginationNote.textContent = '';
      return;
    }
    el.paginationNote.classList.remove('hidden');
    el.paginationNote.textContent =
      `Collected ${state.postsCount || 0} posts — LinkedIn stopped returning more` +
      (p.pages ? ` after ${p.pages} page${p.pages === 1 ? '' : 's'}` : '') +
      '. This is not the same as the account having no more posts.';
  }

  function renderProfile(p) {
    if (!p || !p.publicId) {
      el.profileBox.classList.add('hidden');
      return;
    }
    el.profileBox.classList.remove('hidden');

    /*
     * LinkedIn's CDN sometimes refuses hotlinked avatars — collapse the slot
     * rather than leaving a hole next to the name.
     *
     * Guarded on the URL actually changing. render() runs on every broadcast
     * — several times a second during a live run — and assigning `src` re-runs
     * the image load algorithm every time, so an unguarded write re-requested
     * the avatar continuously and re-armed the error handler on a URL that had
     * already failed, flickering the slot open and shut.
     */
    if (p.photoUrl !== shownAvatar) {
      shownAvatar = p.photoUrl || null;
      if (p.photoUrl) {
        // Handler first: a URL that has already failed once errors the moment
        // src is assigned, and attaching afterwards misses it — leaving exactly
        // the hole this is here to avoid.
        el.avatar.onerror = () => {
          el.avatar.removeAttribute('src');
          el.profileBox.classList.add('no-avatar');
        };
        el.profileBox.classList.remove('no-avatar');
        el.avatar.src = p.photoUrl;
      } else {
        el.avatar.onerror = null;
        el.avatar.removeAttribute('src');
        el.profileBox.classList.add('no-avatar');
      }
    }

    el.pName.textContent = '';
    const nm = document.createElement('span');
    nm.textContent = p.fullName || p.publicId;
    el.pName.appendChild(nm);
    if (p.source && p.source !== 'voyager') el.pName.appendChild(badge(p.source.replace(/-/g, ' ')));

    el.pHeadline.textContent = p.headline || '';
    el.pHeadline.classList.toggle('hidden', !p.headline);

    const bits = [];
    if (p.currentPosition && p.currentPosition.company) {
      bits.push(
        [p.currentPosition.title, p.currentPosition.company].filter(Boolean).join(' · ')
      );
    }
    if (p.location) bits.push(p.location);
    if (p.followers != null) bits.push(`${U.formatCount(p.followers)} followers`);
    if (p.connections != null) bits.push(`${U.formatCount(p.connections)} connections`);
    el.pStats.textContent = bits.join('  ·  ');
  }

  /** Rough time-remaining from the observed rate since the run started. */
  function etaText(state, got, total) {
    if (!state.startedAt || !total || got < 10 || got >= total) return '';
    const rate = got / ((Date.now() - state.startedAt) / 1000);
    if (!isFinite(rate) || rate <= 0) return '';
    return '~' + U.fmtDuration((total - got) / rate) + ' left';
  }

  function syncPresets() {
    const v = parseInt(el.maxPosts.value, 10);
    presets.forEach((b) => {
      const n = Number(b.dataset.n);
      // "All" is the cap, so anything at or above it counts as selected.
      const on = n >= L.MAX_POSTS ? v >= n : n === v;
      b.classList.toggle('on', on);
    });
  }

  function badge(text) {
    const b = document.createElement('span');
    b.className = 'badge neutral';
    b.textContent = text;
    return b;
  }

  function renderLog(entries) {
    /*
     * Whether to follow the tail is decided *before* the rebuild. The list is
     * repainted several times a second during a run, and scrolling to the
     * bottom unconditionally meant reading anything further up was impossible
     * — the view snapped back on the next broadcast.
     */
    const follow = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 24;

    el.log.textContent = '';
    if (!entries.length && !transient.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No activity yet.';
      el.log.appendChild(li);
      el.logCount.textContent = '';
      return;
    }
    const total = entries.length + transient.length;
    el.logCount.textContent = `${total} event${total === 1 ? '' : 's'}`;
    for (const e of entries.slice(-40)) el.log.appendChild(logRow(e));
    for (const e of transient) el.log.appendChild(logRow(e, true));
    if (follow) el.log.scrollTop = el.log.scrollHeight;
  }

  function logRow(e, isTransient) {
    const li = document.createElement('li');
    li.className = (e.level || 'info') + (isTransient ? ' transient' : '');

    const dot = document.createElement('span');
    dot.className = 'lv';
    li.appendChild(dot);

    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = e.message;
    li.appendChild(msg);

    if (e.t) {
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = new Date(e.t).toLocaleTimeString([], { hour12: false });
      li.appendChild(t);
    }
    return li;
  }

  /**
   * Shows a message the popup raised itself, without touching worker state.
   *
   * It is kept in `transient` rather than appended to the DOM, so the render
   * that every caller triggers immediately afterwards puts it back instead of
   * erasing it. Also mirrored to a toast: the Activity view is not the one
   * on screen when Start is rejected, and a message nobody sees is not a
   * message.
   */
  function flash(message, level) {
    transient.push({ t: Date.now(), level: level || 'info', message });
    if (transient.length > MAX_TRANSIENT) transient = transient.slice(-MAX_TRANSIENT);
    if (lastState) render(lastState);
    else renderLog([]);
    if (typeof globalThis.LISToast === 'function') {
      globalThis.LISToast(message, level === 'error' ? 'danger' : level === 'warn' ? 'warning' : 'success');
    }
  }

  /* ------------------------------------------------------------- *
   * Wiring
   * ------------------------------------------------------------- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.STATE_UPDATE) {
      lastState = msg.state;
      render(msg.state);
    }
  });

  async function refresh() {
    const res = await send({ type: MSG.GET_STATE });
    if (res && res.ok) {
      lastState = res.state;
      render(res.state);
    }
  }

  el.btnStart.addEventListener('click', async () => {
    const form = readForm();
    const publicId = U.normalisePublicId(form.publicId);
    if (!publicId) {
      flash('Enter a LinkedIn profile URL or its public identifier (the bit after /in/).', 'error');
      el.publicId.focus();
      return;
    }
    // Show the normalised form so it is obvious what will actually be scraped.
    el.publicId.value = publicId;
    saveForm();
    // A new run starts with a clean slate of popup-side notices; anything from
    // the previous attempt is about a run that no longer exists.
    transient = [];

    if (form.options.includeComments) {
      flash('Comments are on — the export will contain third-party personal data.', 'warn');
    }

    el.btnStart.disabled = true;
    const res = await send({
      type: MSG.START_SCRAPE,
      publicId,
      maxPosts: form.maxPosts,
      options: form.options
    });
    if (!res || !res.ok) flash((res && res.error) || 'Could not start.', 'error');
    refresh();
  });

  el.btnStop.addEventListener('click', async () => {
    el.btnStop.disabled = true;
    await send({ type: MSG.STOP_SCRAPE });
    refresh();
  });

  el.btnResume.addEventListener('click', async () => {
    if (resumeInFlight) return;
    resumeInFlight = true;
    el.btnResume.disabled = true;
    try {
      const res = await send({ type: MSG.RESUME_SCRAPE });
      if (!res || !res.ok) flash((res && res.error) || 'Could not resume.', 'error');
    } finally {
      resumeInFlight = false;
      el.btnResume.disabled = false;
    }
    refresh();
  });

  el.btnOpenTab.addEventListener('click', async () => {
    const res = await send({ type: MSG.FOCUS_TAB });
    if (res && res.ok) window.close();
    else flash('No LinkedIn tab is open.', 'warn');
  });

  el.btnZip.addEventListener('click', async () => {
    el.btnZip.disabled = true;
    // Long-running: the worker keeps going even if the popup is closed.
    const res = await send({ type: MSG.BUILD_ZIP });
    if (!res || !res.ok) {
      if (!res || res.error !== 'cancelled') flash((res && res.error) || 'Packaging failed.', 'error');
    }
    refresh();
  });

  el.btnZipCancel.addEventListener('click', async () => {
    el.btnZipCancel.disabled = true;
    await send({ type: MSG.CANCEL_ZIP });
    el.btnZipCancel.disabled = false;
    refresh();
  });

  el.btnClear.addEventListener('click', async () => {
    await send({ type: MSG.CLEAR });
    refresh();
  });

  presets.forEach((b) =>
    b.addEventListener('click', () => {
      el.maxPosts.value = b.dataset.n;
      syncPresets();
      saveForm();
    })
  );

  [
    el.publicId,
    el.maxPosts,
    el.optIncludePosts,
    el.optIncludeComments,
    el.optSkipVideos,
    el.optIncludeProfileMedia,
    el.optFullProfile
  ].forEach((c) => c.addEventListener('change', saveForm));

  el.maxPosts.addEventListener('input', syncPresets);
  el.publicId.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !el.btnStart.disabled) el.btnStart.click();
  });

  /* ------------------------------------------------------------- *
   * Boot
   * ------------------------------------------------------------- */
  (async () => {
    // The Settings view quotes the live limits rather than hardcoding them,
    // so raising a floor in utils.js is reflected without editing markup.
    const gap = $('kbdGap');
    if (gap) gap.textContent = L.MIN_REQUEST_GAP_MS / 1000 + 's';
    const budget = $('kbdBudget');
    if (budget) budget.textContent = String(L.SESSION_MAX_REQUESTS);
    const comments = $('kbdComments');
    if (comments) comments.textContent = String(L.MAX_COMMENTS_PER_POST);
    el.maxPosts.max = String(L.MAX_POSTS);

    const got = await chrome.storage.local.get(U.KEYS.FORM);
    applyForm(got[U.KEYS.FORM]);
    syncPresets();
    await refresh();

    // Fall back to polling while a run is live, in case a broadcast is missed.
    setInterval(() => {
      if (!lastState) return;
      const live = BUSY.includes(lastState.status) || lastState.status === 'paused';
      if (live || (lastState.zip && lastState.zip.building)) refresh();
    }, 1000);
  })();
})();
