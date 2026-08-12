/*
 * shell.js — the workspace shell.
 *
 * Owns navigation, theme, the command palette and toasts. It never touches
 * scrape state: popup.js remains the only writer for anything the service
 * worker owns, and this file reads the DOM popup.js renders (footer metrics,
 * log scrolling) rather than duplicating that state. Adding a view means adding a nav button, a <section>, and an
 * entry in VIEWS — nothing here needs to change shape.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = IS_MAC ? '⌘' : 'Ctrl';

  const VIEWS = {
    scrape:   { title: 'Scrape',       sub: 'Collect a profile and its posts' },
    activity: { title: 'Activity',     sub: 'Everything the worker reported' },
    settings: { title: 'Settings',     sub: 'Appearance and shortcuts' }
  };

  /* ═══════════════════════════════════════════════════════════════
   * Toasts
   * ═══════════════════════════════════════════════════════════════ */
  /*
   * A tick on every toast said "that worked" over the top of "Could not
   * start.", so the icon follows the kind.
   */
  const ICONS = {
    success: '<path d="M4.5 12.5l5 5 10-11"/>',
    warning: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.2v.1"/>',
    danger: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>'
  };

  function toast(message, kind) {
    const host = $('toasts');
    if (!host) return;
    const k = ICONS[kind] ? kind : 'success';
    const el = document.createElement('div');
    el.className = 'toast ' + k;
    el.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + ICONS[k] + '</svg>';
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, kind === 'danger' || kind === 'warning' ? 4200 : 1900);
  }

  // popup.js owns the worker conversation and has no toast host of its own;
  // this is the one thing the shell publishes to it.
  globalThis.LISToast = toast;

  /* ═══════════════════════════════════════════════════════════════
   * Theme — light | system | dark, applied by attribute so the flip
   * is a single repaint with no flash.
   * ═══════════════════════════════════════════════════════════════ */
  // Read from the shared key table where it is available, so the popup and the
  // worker can never drift onto two different storage keys.
  const THEME_KEY = (globalThis.LIS && globalThis.LIS.KEYS && globalThis.LIS.KEYS.THEME) || 'lis_theme';
  const THEMES = ['light', 'system', 'dark'];
  let theme = 'system';

  function applyTheme(next, persist) {
    theme = THEMES.includes(next) ? next : 'system';
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    syncSegment($('themeSeg'), (b) => b.dataset.themeOpt === theme);
    if (persist) chrome.storage.local.set({ [THEME_KEY]: theme });
  }

  function cycleTheme() {
    applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length], true);
    toast('Theme: ' + theme);
  }

  /* ═══════════════════════════════════════════════════════════════
   * Segmented control — one thumb mover shared by every instance
   * ═══════════════════════════════════════════════════════════════ */
  function syncSegment(seg, isOn) {
    if (!seg) return;
    const thumb = seg.querySelector('.thumb');
    const buttons = [...seg.querySelectorAll('button')];
    const active = buttons.find(isOn);
    buttons.forEach((b) => b.classList.toggle('on', b === active));
    if (!thumb || !active) {
      seg.classList.remove('ready');
      return;
    }
    seg.classList.add('ready');
    thumb.style.width = active.offsetWidth + 'px';
    thumb.style.transform = `translateX(${active.offsetLeft - seg.clientLeft}px)`;
  }

  // popup.js owns .on for the presets; mirror it onto the thumb.
  const presetSeg = $('presetSeg');
  const syncPresetThumb = () => syncSegment(presetSeg, (b) => b.classList.contains('on'));
  if (presetSeg) {
    const mo = new MutationObserver(syncPresetThumb);
    presetSeg.querySelectorAll('.preset').forEach((b) =>
      mo.observe(b, { attributes: true, attributeFilter: ['class'] })
    );
  }

  /* ═══════════════════════════════════════════════════════════════
   * Navigation
   * ═══════════════════════════════════════════════════════════════ */
  let current = 'scrape';

  function go(name) {
    if (!VIEWS[name]) return;
    current = name;

    document.querySelectorAll('.rail-btn').forEach((b) =>
      b.setAttribute('aria-current', String(b.dataset.nav === name))
    );
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.dataset.view === name));

    $('viewTitle').textContent = VIEWS[name].title;
    $('viewSub').textContent = VIEWS[name].sub;

    // Panels are display:none while inactive, so anything that depends on
    // layout has to be recomputed the moment it becomes visible.
    if (name === 'scrape') requestAnimationFrame(syncPresetThumb);
    if (name === 'settings') requestAnimationFrame(() => syncSegment($('themeSeg'), (b) => b.dataset.themeOpt === theme));
    if (name === 'activity') {
      const log = $('log');
      if (log) log.scrollTop = log.scrollHeight;
    }
  }

  document.querySelectorAll('.rail-btn').forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.nav))
  );

  /* ═══════════════════════════════════════════════════════════════
   * Command palette
   * ═══════════════════════════════════════════════════════════════ */
  const ACTIONS = [
    { group: 'Go to', name: 'Scrape',        run: () => go('scrape') },
    { group: 'Go to', name: 'Activity',      run: () => go('activity') },
    { group: 'Go to', name: 'Settings',      run: () => go('settings') },
    { group: 'Run',   name: 'Start scrape',  run: () => $('btnStart').click(), when: () => !$('btnStart').disabled },
    { group: 'Run',   name: 'Resume',        run: () => $('btnResume').click(), when: () => !$('btnResume').classList.contains('hidden') },
    { group: 'Run',   name: 'Stop scrape',   run: () => $('btnStop').click(),  when: () => !$('btnStop').disabled },
    { group: 'Run',   name: 'Download ZIP',  run: () => $('btnZip').click(),   when: () => !$('btnZip').disabled },
    { group: 'Run',   name: 'Clear stored results', run: () => $('btnClear').click(), when: () => !$('btnClear').disabled },
    { group: 'View',  name: 'Toggle theme',  run: cycleTheme }
  ];

  let paletteEl = null;
  let picks = [];
  let cursor = 0;

  function openPalette() {
    if (paletteEl) return;
    paletteEl = document.createElement('div');
    paletteEl.className = 'overlay';
    paletteEl.innerHTML =
      '<div class="palette" role="dialog" aria-label="Command palette">' +
      '<div class="palette-field">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>' +
      '<input type="text" placeholder="Search actions…" aria-label="Search actions" />' +
      '<span class="kbd">esc</span></div>' +
      '<div class="palette-list scroll"></div></div>';
    document.body.appendChild(paletteEl);

    paletteEl.addEventListener('mousedown', (e) => {
      if (e.target === paletteEl) closePalette();
    });
    const input = paletteEl.querySelector('input');
    input.addEventListener('input', () => filterPalette(input.value));
    input.addEventListener('keydown', paletteKeys);
    filterPalette('');
    input.focus();
  }

  function closePalette() {
    if (!paletteEl) return;
    paletteEl.remove();
    paletteEl = null;
  }

  function filterPalette(q) {
    const needle = q.trim().toLowerCase();
    picks = ACTIONS.filter((a) => (!a.when || a.when()) && a.name.toLowerCase().includes(needle));
    cursor = 0;
    paintPalette();
  }

  function paintPalette() {
    const list = paletteEl.querySelector('.palette-list');
    list.textContent = '';
    if (!picks.length) {
      const p = document.createElement('div');
      p.className = 'palette-empty';
      p.textContent = 'No matching action';
      list.appendChild(p);
      return;
    }
    let group = null;
    picks.forEach((a, i) => {
      if (a.group !== group) {
        group = a.group;
        const h = document.createElement('div');
        h.className = 'palette-group';
        h.textContent = group;
        list.appendChild(h);
      }
      const b = document.createElement('button');
      b.className = 'palette-item';
      b.setAttribute('aria-selected', String(i === cursor));
      b.innerHTML = '<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span><span class="name"></span>';
      b.querySelector('.name').textContent = a.name;
      b.addEventListener('mouseenter', () => {
        /*
         * Guarded, because paintPalette() rebuilds this list from scratch.
         * Repainting unconditionally destroys the button under the pointer and
         * builds a new one in the same place, which fires mouseenter again —
         * a repaint loop that flickers the palette for as long as the pointer
         * rests on an item.
         */
        if (cursor === i) return;
        cursor = i;
        paintPalette();
      });
      b.addEventListener('click', () => {
        closePalette();
        a.run();
      });
      list.appendChild(b);
    });
    const sel = list.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function paletteKeys(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor = Math.min(cursor + 1, picks.length - 1);
      paintPalette();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      paintPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const a = picks[cursor];
      if (a) {
        closePalette();
        a.run();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  }

  $('cmdkTrigger').addEventListener('click', openPalette);
  $('btnTheme').addEventListener('click', cycleTheme);

  /* ═══════════════════════════════════════════════════════════════
   * Global keys
   * ═══════════════════════════════════════════════════════════════ */
  document.addEventListener('keydown', (e) => {
    // `key` is absent on some synthetic and IME-composition events, and this
    // handler is on document — throwing here would take out every later
    // keydown listener on the page.
    const key = typeof e.key === 'string' ? e.key : '';
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (mod && key.toLowerCase() === 'k') {
      e.preventDefault();
      paletteEl ? closePalette() : openPalette();
      return;
    }
    // Escape closes the palette even when focus has left its input — clicking
    // the overlay or an item moves focus off, and the input's own handler is
    // the only other thing that closes it.
    if (paletteEl) {
      if (key === 'Escape') {
        e.preventDefault();
        closePalette();
      }
      return;
    }
    if (key === 'Escape') return;

    // Bare digits only when not typing into a field.
    const tag = ((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.altKey || e.ctrlKey || e.metaKey) return;
    // 3 was missing, so the rail's third view was the only one with no shortcut.
    const jump = { 1: 'scrape', 2: 'activity', 3: 'settings' }[key];
    if (jump) {
      e.preventDefault();
      go(jump);
    }
  });

  /* ═══════════════════════════════════════════════════════════════
   * Mirrors of popup.js-rendered state
   * ═══════════════════════════════════════════════════════════════ */
  const statPosts = $('statPosts');
  const footPosts = $('footPosts');
  let lastPosts = null;

  // Primed once for the same reason the empty state is: a first render that
  // beats this file leaves the footer showing the markup's placeholder 0
  // while the card above it shows the real count.
  function mirrorPosts() {
    const v = statPosts.textContent;
    if (v === lastPosts) return;
    lastPosts = v;
    footPosts.textContent = v;
  }

  new MutationObserver(mirrorPosts).observe(statPosts, {
    childList: true,
    characterData: true,
    subtree: true
  });
  mirrorPosts();

  /*
   * popup.js writes a bare <li class="empty"> — dress it as a real empty state.
   *
   * Called once up front as well as from the observer. Reacting to mutations
   * alone is a race with popup.js's own boot: both are classic scripts in one
   * document, and if popup.js's first render lands before this file has
   * executed there is no mutation left to observe and the panel keeps the
   * undressed placeholder for as long as the popup is open. The same happens
   * when the worker never answers GET_STATE, because then popup.js never
   * renders at all and the placeholder markup is all there is.
   */
  const logEl = $('log');

  function dressEmptyLog() {
    const li = logEl.querySelector('li.empty');
    if (!li || li.querySelector('.empty-state')) return;
    li.textContent = '';
    const w = document.createElement('div');
    w.className = 'empty-state';
    w.innerHTML =
      '<span class="art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6.5L14 19l2.5-7H21"/></svg></span>' +
      '<h3>Nothing yet</h3><p>Events from the worker land here as a run progresses.</p>';
    li.appendChild(w);
  }

  new MutationObserver(dressEmptyLog).observe(logEl, { childList: true });
  dressEmptyLog();

  /* ═══════════════════════════════════════════════════════════════
   * Boot
   * ═══════════════════════════════════════════════════════════════ */
  document.querySelectorAll('#themeSeg [data-theme-opt]').forEach((b) =>
    b.addEventListener('click', () => applyTheme(b.dataset.themeOpt, true))
  );

  $('cmdkHint').textContent = MOD + ' K';
  $('kbdPalette').textContent = MOD + ' K';

  chrome.storage.local.get(THEME_KEY).then((got) => applyTheme(got[THEME_KEY], false));
  requestAnimationFrame(syncPresetThumb);
  setTimeout(syncPresetThumb, 140);
  go('scrape');
})();
