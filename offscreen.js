/*
 * offscreen.js — everything that needs a DOM-ish context.
 *
 * One job: build the single .zip archive — fetch each media URL, stream it
 * into the ZipWriter, and hand back one blob URL at the end.
 *
 * The worker cannot do this itself: it has no URL.createObjectURL and no way
 * to hold a multi-gigabyte archive.
 *
 * Unlike the Instagram build there is no frame-extraction step here. LinkedIn
 * video is usually an adaptive stream rather than a file, so decoding it would
 * need a demuxer — deliberately out of scope. Posts whose video could not be
 * downloaded get a video_not_downloaded.txt written by the worker instead.
 */
(function () {
  'use strict';

  // Looked up lazily, not destructured at load: if zipwriter.js ever fails to
  // load, only the archive breaks.
  function newZipWriter() {
    const lib = globalThis.LISZip;
    if (!lib || !lib.ZipWriter) throw new Error('zip writer unavailable');
    return new lib.ZipWriter();
  }

  let zip = null;
  const urls = new Set();

  /*
   * What this machine can carry.
   *
   * Measured before it was written: packing twenty one-minute videos with a
   * still per second held ~550 MB above Chrome's own floor and took 138 s on
   * four cores. That is fine on a workstation and a bad afternoon on a 4 GB
   * laptop with two cores — so the levers below scale with the machine rather
   * than assuming the one this was written on. navigator.deviceMemory is
   * coarse (2, 4, 8…) and absent on some browsers; absence reads as "modest".
   */
  const MACHINE = (() => {
    const mem = Number(navigator.deviceMemory) || 4;
    const cores = Number(navigator.hardwareConcurrency) || 2;
    const tier = mem <= 2 ? 'small' : mem <= 4 ? 'modest' : 'roomy';
    return {
      tier,
      mem,
      cores,
      // CDN fetches in flight at once. Each holds a Blob until it is written.
      fetchConcurrency: Math.max(1, Math.min(4, tier === 'small' ? 1 : tier === 'modest' ? 2 : cores - 1)),
      // Longest edge of an extracted frame.
      frameEdge: tier === 'small' ? 720 : tier === 'modest' ? 960 : 1280,
      // Stills across the whole export. Twenty long videos at one a second is
      // eighteen thousand JPEGs, which is a ten-minute pack on a slow disk.
      // Shared out per video at ZIP_INIT, so the first three do not take it all.
      maxFramesPerExport: tier === 'small' ? 600 : tier === 'modest' ? 1500 : 4000
    };
  })();

  /** Media comes from the CDN, so a few in parallel — same as a page load. */
  const FETCH_CONCURRENCY = MACHINE.fetchConcurrency;

  /**
   * Media URLs on media.licdn.com are signed and normally fetch anonymously.
   * A few — document PDFs in particular — are only served to the session that
   * was shown them, so a 401/403 gets one retry with cookies. licdn.com is
   * LinkedIn's own CDN and is declared in host_permissions; nothing is sent
   * to a third party either way.
   */
  /*
   * A media fetch had no deadline, and fetch() has none of its own. One CDN
   * connection that opens and then stalls parked one of the four workers
   * forever, so `Promise.all(workers)` never settled, ZIP_ADD never answered,
   * and buildZip's finally — the only thing that clears `zip.building` — never
   * ran. The popup sat on "Packaging…" with a frozen counter and every button
   * disabled, and the keep-alive dutifully kept the worker alive for it.
   */
  let FETCH_TIMEOUT_MS = 60000;

  /** Set by ZIP_CANCEL so a cancel is felt inside a batch, not after it. */
  let cancelled = false;

  async function fetchBlob(url) {
    if (cancelled) throw new Error('cancelled');
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const timedOut = () => new Error(`no bytes for ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`);
    try {
      let res = null;
      try {
        res = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: ctl.signal });
      } catch (err) {
        if (ctl.signal.aborted) throw timedOut();
        res = null;
      }
      if (!res || res.status === 401 || res.status === 403) {
        res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ctl.signal });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      /*
       * The body is read in chunks and the deadline restarts on each one.
       * As a single total-transfer timeout it dropped every large video on
       * a slow link — a 200 MB file at 2 MB/s is a hundred seconds — and
       * then blamed an expired CDN link. A stall is a *gap*: sixty seconds
       * with no bytes at all.
       */
      if (!res.body || typeof TransformStream !== 'function') return await res.blob();
      /*
       * Watched, not buffered. Draining the stream into an array held the
       * whole file on the JS heap — a 200 MB video, four at a time — and
       * then copied it into a Blob. Piping through a pass-through lets Blink
       * build the blob the way res.blob() does, in its disk-backed store,
       * while each chunk still restarts the deadline.
       */
      const watched = res.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            clearTimeout(timer);
            timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
            if (cancelled) throw new Error('cancelled');
            controller.enqueue(chunk);
          }
        })
      );
      return await new Response(watched, { headers: res.headers }).blob();
    } catch (err) {
      if (ctl.signal.aborted) throw timedOut();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------------- *
   * Frame extraction
   *
   * A still per second of every video that could actually be downloaded. This
   * is the one job that genuinely needs a document rather than a worker: it
   * decodes through a real <video> element and paints onto a <canvas>, so
   * Chrome's own decoder does the work and nothing has to be bundled.
   *
   * A stream that exists only as adaptive DASH/HLS cannot be decoded this way
   * — there is no single file to hand the element — so those get their poster
   * and a note instead, and are reported rather than quietly skipped.
   * ---------------------------------------------------------------- */
  const FRAMES = {
    MAX_PER_VIDEO: 900, // 15 minutes at one per second; a hard stop, not a target
    MAX_EDGE: MACHINE.frameEdge, // downscale big frames — 900 stills add up fast
    QUALITY: 0.82,
    SEEK_TIMEOUT_MS: 15000
  };

  /** Stills written so far in this archive — reset with it. */
  let framesThisExport = 0;
  /*
   * Each video's share of the export's frame budget. A first-come budget gave
   * the first three videos every still and the other seventeen an empty
   * _frames/ folder; the worker says how many videos the archive holds and
   * the budget is divided among them. Never below 30, so a short clip still
   * gets a usable sequence, and never above one per second.
   */
  let framesPerVideo = FRAMES.MAX_PER_VIDEO;

  /** Divides the archive's frame budget among its videos. */
  function shareFrameBudget(videoCount) {
    const videos = Math.max(1, Number(videoCount) || 1);
    // No floor: a floor of thirty times forty videos exceeded the ceiling,
    // and the videos at the tail of the archive got nothing at all. A small
    // share is still a sequence; an empty folder is not.
    framesPerVideo = Math.max(1, Math.floor(MACHINE.maxFramesPerExport / videos));
    return framesPerVideo;
  }

  /*
   * Decoding is serialised. The media fetches run four wide, but four videos
   * decoding at once multiplies peak memory by four for no throughput gain —
   * the decode, not the network, is the bottleneck.
   */
  let decodeChain = Promise.resolve();
  const serialiseDecode = (fn) => {
    const next = decodeChain.then(fn, fn);
    decodeChain = next.catch(() => {});
    return next;
  };

  function onceEvent(el, name, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer = null;
      let watch = null;
      // Every exit — the event, an error, the timeout, a cancel — clears
      // both timers. A watch left running after a timeout would hold the
      // event loop open for good.
      const clean = () => {
        el.removeEventListener(name, ok);
        el.removeEventListener('error', bad);
        clearTimeout(timer);
        clearInterval(watch);
      };
      const ok = () => {
        clean();
        resolve();
      };
      const bad = () => {
        clean();
        reject(new Error(`video ${name} failed`));
      };
      timer = setTimeout(() => {
        clean();
        reject(new Error(`video ${name} timed out`));
      }, timeoutMs);
      // Cancel is a flag, and a seek that never fires would otherwise hold
      // the worker for the full timeout before the flag was looked at.
      watch = setInterval(() => {
        if (!cancelled) return;
        clean();
        reject(new Error('cancelled'));
      }, 250);
      el.addEventListener(name, ok, { once: true });
      el.addEventListener('error', bad, { once: true });
    });
  }

  /**
   * Seeks and waits, tolerating the two ways this hangs otherwise.
   *
   * The listener is attached *before* currentTime is assigned: a seek that
   * resolves immediately would otherwise fire before anything was listening
   * and the wait would sit there until the timeout.
   *
   * And a seek to the position the video is already at does not reliably fire
   * `seeked` at all. That is the very first frame in every video — t=0 on a
   * freshly loaded element — so without the readyState check below, every
   * extraction stalled for the full timeout before producing anything.
   */
  async function seekTo(video, t) {
    if (Math.abs(video.currentTime - t) < 1e-3 && video.readyState >= 2) return;
    const settled = onceEvent(video, 'seeked', FRAMES.SEEK_TIMEOUT_MS);
    video.currentTime = t;
    await settled;
  }

  const canvasBlob = (canvas) =>
    new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('frame encode failed'))),
        'image/jpeg',
        FRAMES.QUALITY
      )
    );

  /**
   * Decodes `blob` and hands one JPEG per `intervalSec` to `onFrame`, in order.
   *
   * Frames are passed out as they are produced rather than collected and
   * returned. At the 900-frame ceiling a returned array would be a few hundred
   * megabytes of live Blob references held until the whole video finished;
   * streaming them lets each one reach the archive — and Chrome's on-disk blob
   * store — immediately.
   */
  async function extractFrames(blob, intervalSec, onFrame) {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;

    let count = 0;
    try {
      await onceEvent(video, 'loadedmetadata', FRAMES.SEEK_TIMEOUT_MS);
      let duration = Number(video.duration);
      /*
       * A file whose container carries no duration — a fragmented MP4, or
       * anything a recorder wrote — reports Infinity here, and Chrome only
       * learns the real length once it has been asked to seek past the end.
       * Giving up on Infinity threw away every frame of a video that would
       * have decoded fine.
       */
      if (!isFinite(duration)) {
        video.currentTime = 1e9;
        await onceEvent(video, 'durationchange', FRAMES.SEEK_TIMEOUT_MS).catch(() => {});
        duration = Number(video.duration);
        video.currentTime = 0;
        await onceEvent(video, 'seeked', FRAMES.SEEK_TIMEOUT_MS).catch(() => {});
      }
      if (!isFinite(duration) || duration <= 0) throw new Error('video reported no duration');

      /*
       * `loadedmetadata` only guarantees readyState 1 — dimensions and
       * duration, but no decoded picture. Drawing at that point paints
       * nothing, so the first frame of every video came out blank. Wait for
       * actual frame data before the loop touches the canvas.
       */
      if (video.readyState < 2) await onceEvent(video, 'loadeddata', FRAMES.SEEK_TIMEOUT_MS);

      const longest = Math.max(video.videoWidth || 1, video.videoHeight || 1);
      const scale = Math.min(1, FRAMES.MAX_EDGE / longest);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((video.videoWidth || 1) * scale));
      canvas.height = Math.max(1, Math.round((video.videoHeight || 1) * scale));
      const ctx = canvas.getContext('2d');

      /*
       * The step is whatever spreads this video's share of the budget across
       * its length — one a second when it fits, wider when it does not — so a
       * long video on a small machine gets a still every few seconds rather
       * than the first few minutes at full rate and nothing after.
       */
      const asked = Math.max(0.1, Number(intervalSec) || 1);
      const share = Math.max(1, Math.min(FRAMES.MAX_PER_VIDEO, framesPerVideo));
      const step = Math.max(asked, duration / share);
      /*
       * By index, and bounded by the share. Adding the step repeatedly lands
       * a hair short of the end — 100 s at a third-of-a-second step reached
       * 99.99999999999997 — and took one frame over the share, so every video
       * overshot and the last one was reported as cut by the ceiling.
       */
      const planned = Math.min(FRAMES.MAX_PER_VIDEO, share, Math.ceil(duration / step));
      let hitCeiling = false;
      for (let i = 0; i < planned; i++) {
        const t = i * step;
        if (cancelled) throw new Error('cancelled');
        if (framesThisExport >= MACHINE.maxFramesPerExport) {
          hitCeiling = true;
          break;
        }
        framesThisExport++;
        await seekTo(video, Math.min(t, Math.max(0, duration - 0.05)));
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (onFrame) await onFrame({ at: t, index: count, blob: await canvasBlob(canvas) });
        count++;
      }
      // A video that finished its own length exactly as the archive reached
      // its ceiling was not cut short; only a loop that stopped early was.
      return { count, duration, step, truncated: count >= FRAMES.MAX_PER_VIDEO || hitCeiling, exportCapped: hitCeiling };
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  }

  const pad = (n, w) => String(n).padStart(w, '0');

  function framesReadme(item, r) {
    const lines = [
      `Frames from ${item.path.split('/').pop()}`,
      '-'.repeat(70),
      `Duration       : ${r.duration.toFixed(1)}s`,
      `Interval       : ${r.step}s${r.step !== item.video.intervalSec ? ` (asked for ${item.video.intervalSec}s; widened for this machine)` : ''}`,
      `Frames written : ${r.count}`
    ];
    if (r.exportCapped) {
      lines.push(`Truncated      : yes — this archive reached its ${MACHINE.maxFramesPerExport}-frame ceiling for a ${MACHINE.mem} GB machine`);
    } else if (r.truncated) {
      lines.push(`Truncated      : yes — capped at ${FRAMES.MAX_PER_VIDEO} frames`);
    }
    lines.push('', 'Each file is named for its position in the video, in seconds.');
    return lines.join('\r\n') + '\r\n';
  }

  /**
   * Adds a batch of entries. Text is inlined by the worker; media is fetched
   * here. Order within the archive does not matter, so fetches run in parallel
   * and are appended as they land.
   */
  async function addBatch(items) {
    const failed = [];
    let bytes = 0;
    let extraEntries = 0;
    let framesWritten = 0;
    // Counted separately from `failed`, which now also holds frame-extraction
    // failures — those are not items, so subtracting them would misreport how
    // many of the batch actually landed.
    let itemFailures = 0;

    const queue = items.slice();
    const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        if (cancelled) {
          /*
           * Record what is being abandoned rather than returning a short batch
           * that looks complete. The worker reads `failed` to decide whether an
           * archive is whole, so an unreported drop is a silent truncation.
           */
          for (let item = queue.shift(); item; item = queue.shift()) {
            itemFailures++;
            failed.push({ kind: 'item', path: item.path, url: item.url || null, error: 'cancelled' });
          }
          return;
        }
        const item = queue.shift();
        if (!item) return;
        try {
          if (typeof item.text === 'string') {
            bytes += await zip.addText(item.path, item.text);
            continue;
          }

          const blob = await fetchBlob(item.url);
          bytes += await zip.addBlob(item.path, blob);
          if (!item.video) continue;

          /*
           * The video itself is already in the archive, so a decode failure
           * costs the frames and not the file. It is recorded as its own
           * failure rather than failing the video entry.
           */
          try {
            const used = new Set();
            const r = await serialiseDecode(() =>
              extractFrames(blob, item.video.intervalSec, async (f) => {
                /*
                 * Named for its position so the sequence reads at a glance.
                 * Two frames can only round to the same second at a sub-second
                 * interval, but a duplicate path would silently shadow an
                 * earlier entry, so fall back to the frame index rather than
                 * trusting the caller's interval.
                 */
                let name = `frame_${pad(Math.round(f.at), 4)}s.jpg`;
                if (used.has(name)) name = `frame_${pad(f.index + 1, 4)}.jpg`;
                used.add(name);
                bytes += await zip.addBlob(`${item.video.framesDir}/${name}`, f.blob);
                extraEntries++;
                framesWritten++;
              })
            );
            bytes += await zip.addText(`${item.video.framesDir}/frames.txt`, framesReadme(item, r));
            extraEntries++;
          } catch (err) {
            /*
             * Tagged, because this is not a missing archive entry. The video
             * itself landed; only its stills did not. Untagged, the worker
             * counted these into "skipped", so an export where every declared
             * file is present reported itself short — and sent the user to
             * re-run a scrape over an expired-CDN-link explanation that had
             * nothing to do with it.
             */
            failed.push({ kind: 'frames', path: `${item.video.framesDir}/`, url: null, error: err.message });
          }
        } catch (err) {
          itemFailures++;
          failed.push({ kind: 'item', path: item.path, url: item.url || null, error: err.message });
        }
      }
    });

    await Promise.all(workers);
    return { added: items.length - itemFailures, failed, bytes, extraEntries, framesWritten };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;

    (async () => {
      switch (msg.type) {
        case 'ZIP_INIT': {
          zip = newZipWriter();
          cancelled = false;
          framesThisExport = 0;
          return { ok: true, machine: MACHINE, framesPerVideo: shareFrameBudget(msg.videoCount) };
        }

        case 'ZIP_CANCEL':
          cancelled = true;
          return { ok: true };

        case 'ZIP_ADD': {
          if (!zip) return { ok: false, error: 'no archive in progress' };
          const r = await addBatch(msg.items || []);
          return {
            ok: true,
            added: r.added,
            failed: r.failed,
            bytes: zip.bytes,
            count: zip.count,
            // Frames are entries the worker never declared, so it cannot infer
            // them from the batch size — report them explicitly.
            extraEntries: r.extraEntries,
            framesWritten: r.framesWritten
          };
        }

        case 'ZIP_FINISH': {
          if (!zip) return { ok: false, error: 'no archive in progress' };
          const blob = zip.finish('application/zip');
          /*
           * A blob: URL's path is a bare UUID, and that is what Chrome writes
           * to disk — downloads.download()'s `filename` is only a suggestion
           * for blob URLs minted in another extension context, and it loses.
           * A File carries its own name through the object URL, so the
           * archive lands as <publicId>.zip instead of <uuid>.zip.
           */
          const payload = msg.name ? new File([blob], msg.name, { type: 'application/zip' }) : blob;
          const url = URL.createObjectURL(payload);
          urls.add(url);
          const out = { ok: true, url, bytes: blob.size, count: zip.count };
          zip = null;
          return out;
        }

        /*
         * Saving happens here rather than through chrome.downloads because an
         * anchor's `download` attribute is the only filename Chrome honours
         * for a blob: URL. The API writes the blob's UUID no matter what is
         * passed to it. The cost is that `download` cannot express a
         * subfolder, so the archive lands directly in the downloads folder.
         */
        case 'ZIP_SAVE': {
          if (!msg.url) return { ok: false, error: 'no archive to save' };
          const a = document.createElement('a');
          a.href = msg.url;
          a.download = msg.name || 'archive.zip';
          document.body.appendChild(a);
          a.click();
          a.remove();
          return { ok: true };
        }

        case 'ZIP_ABORT':
          cancelled = true;
          zip = null;
          return { ok: true };

        case 'REVOKE_BLOB_URL':
          if (msg.url) {
            URL.revokeObjectURL(msg.url);
            urls.delete(msg.url);
          }
          return { ok: true, remaining: urls.size };

        default:
          return { ok: false, error: `unknown message ${msg.type}` };
      }
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true; // async response
  });

  /*
   * Test hook, same contract as content.js: populated only when a harness has
   * declared __LIS_OFFSCREEN_TEST__ first, which nothing in the extension does.
   * The seek loop is worth covering — it is the one piece here with real
   * control flow, and it is otherwise reachable only by exporting an archive
   * that contains a video.
   */
  if (globalThis.__LIS_OFFSCREEN_TEST__) {
    Object.assign(globalThis.__LIS_OFFSCREEN_TEST__, { extractFrames, FRAMES, framesReadme, fetchBlob, MACHINE, shareFrameBudget, setFetchTimeout: (ms) => { FETCH_TIMEOUT_MS = ms; } });
  }
})();
