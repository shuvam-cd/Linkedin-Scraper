# LinkedIn Scraper

A Manifest V3 Chrome extension that collects a LinkedIn profile and its posts
using the session you're **already** logged into. There is no login flow, no
credential handling, and no stored tokens — every request is a same-origin
`fetch` made from a content script running on `linkedin.com`, so the browser
attaches your normal cookies automatically.

It is the same machine as [IG Post Scraper By Sumon](#) with a different engine
bolted in: same messaging model, same state machine, same chunked storage, same
resume logic, same ZIP writer, same popup shell. What changed is everything
below the API boundary, because LinkedIn is a harder target than Instagram in
three specific ways — and the design answers each one.

## File structure

```
linkedin-post-scraper/
├── manifest.json       Manifest V3 declaration
├── utils.js            Shared helpers (messages, rate limiter, CSV, formatting)
├── voyager.js          Rest.li layer: the URN resolver and session headers
├── ui/tokens.css       Design tokens — colour, type, space, radius, shadow, motion
├── ui/components.css   Reusable components (button, input, segmented, toast, …)
├── ui/app.css          Workspace shell + views
├── ui/shell.js         Navigation, command palette, toasts, theme
├── ui/fonts/           Montserrat + DM Sans (variable, latin) — see its README
├── zipwriter.js        Dependency-free ZIP writer (STORE + ZIP64)
├── background.js       Service worker: state, storage, export layout, downloads
├── content.js          Scraping engine, injected on https://www.linkedin.com/*
├── popup.html          Workspace markup
├── popup.js            Popup controller (a pure view over worker state)
├── offscreen.html      Packaging worker document
├── offscreen.js        Fetches media, packs the .zip, mints blob URLs
├── icons/              16/32/48/128 px toolbar icons (LinkedIn blue "in")
├── tools/              Tests, plus make-icons.mjs (regenerates the PNGs)
├── ENDPOINTS.md        How to capture and repair the Voyager endpoints
└── README.md
```

`zipwriter.js` is carried over from the Instagram build unchanged apart from its
global's name (`IGSZip` → `LISZip`). It was already dependency-free and already
handled ZIP64; there was nothing to improve.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `linkedin-post-scraper` folder.
4. Log into LinkedIn in a normal tab if you haven't already.
5. Click the extension icon, paste a profile URL, press **Start scrape**.

No build step, no dependencies — plain ES2020 that Chrome runs directly.

It works on install. Strategy A (the Voyager API) ships switched off because
there are no endpoint values in this repository on purpose — see
**[ENDPOINTS.md](ENDPOINTS.md)**. Strategies B and C need no configuration and
carry the run until you fill A in.

## What it collects

**The profile, always.** Full name, headline, public identifier, location,
industry, current position, full experience history, education, skills, about
text, follower and connection counts, profile photo, banner — plus licences and
certifications, languages, volunteering, projects, honours and awards, courses
and publications. Read from the embedded payload where LinkedIn ships one, and
off the rendered page otherwise.

**That profile's posts.** Per post: the activity URN, permalink, body text,
publish timestamp, type (text / image / document / video / article / repost /
poll), reaction count broken down by type where LinkedIn returns it, comment
count, repost count, hashtags, and every attached media URL. Images and
documents are fetched into the archive.

And what makes each kind that kind, which used to be dropped: an **article**'s
headline, subtitle, link, domain and cover image; a **poll**'s question, every
option, the votes on each and whether it closed; a **reshare**'s original
author, their headline and profile, the original permalink and its body. Three
of the seven types used to reach the archive as a type label on an empty shell.

**Comments, off by default, behind a chip.** Per comment: author display name,
headline, profile URL, text, timestamp, reaction count. Hard-capped at
**150 comments per post** across at most **8 pages**. Commenter profile links are
never followed and there is deliberately no "hydrate commenters" feature. Turn
this on and the export's `README.txt` says, in as many words, that it contains
third-party personal data and that retention is your problem.

## Three ways LinkedIn is harder than Instagram

### 1. The API answers in pieces

Voyager returns a *normalized* envelope: a thin `data` object holding URN
references, plus a flat `included[]` array holding the actual entities. Nothing
is usable until it is re-stitched.

That resolver is the highest-risk code here — everything Strategy A produces
passes through it, and a subtle bug in it looks exactly like "LinkedIn changed
their API" from the outside. So it lives in its own file, has no DOM or
`chrome.*` dependency, and is tested in isolation:

```
node tools/test.mjs               368 assertions, no dependencies

  resolver-test.mjs   58   URN resolution, session cookies, Rest.li encoding
  utils-test.mjs      33   public-id normalisation, CSV escaping
  engine-test.mjs     76   session detection, entity mapping, post kinds, profile
  export-test.mjs     62   archive tree, CSV, JSON, README, path collisions
  wiring-check.mjs    34   manifest / popup / message wiring, safety limits
  regression-test.mjs 105  tab navigation, timers, media scope, strategy escalation
```

None of it can talk to LinkedIn, which is the point — it covers exactly the
things a live smoke test is worst at catching. `export-test.mjs` evaluates
`background.js` with `chrome` stubbed and drives the layout functions over every
post shape; `engine-test.mjs` does the same for `content.js` against a fake DOM;
`wiring-check.mjs` catches the mistakes a project with no build step otherwise
finds at runtime, like an element id that exists in `popup.js` but not in
`popup.html`.

`regression-test.mjs` is newer and exists because of an uncomfortable result:
the first five suites were **fully green while the extension could not start a
run**, and green again while it was filing the author's profile picture as the
first photo of every post. Everything they covered was a pure function called
with tidy arguments. The bugs were in the async glue — tab navigation, port
lifetime, timers, service-worker eviction — and in the *scope* the pure
functions were handed, which is not something a function can be asked about in
isolation. Where a race genuinely cannot be reproduced outside Chrome, that
suite pins the shape of the code that caused it, the same way
`wiring-check.mjs` pins the `li_at` rule. Everything else in it is a real call:
it decodes frames against a stubbed `<video>`, and maps real update payloads.

The one that matters most: **cycle detection is per-path, not global.** The
entity graph genuinely loops. A global visited set breaks the loops and also
silently blanks the second occurrence of any legitimately repeated entity — the
same company on two positions, the same author on twenty posts. That bug
produces plausible-looking output with holes in it, which is the worst kind.

The second: **the resolver never silently shortens an array.** Losing elements
would be indistinguishable from LinkedIn returning fewer, and telling those two
apart is the entire job of the pagination logic below.

### 2. Detection is behavioural, not just rate-based

Every floor is slower than the Instagram build's, and every one of them is a
floor rather than a default. In `utils.js`, `LIMITS`:

```js
MIN_REQUEST_GAP_MS   3000            // <= 1 request / 3 s, whole run
PAGE_DELAY           [3000, 7000]    // randomised, between pages
DETAIL_DELAY         [4000, 9000]    // randomised, between per-post fetches
RATE_LIMIT_PAUSE_MS  180000          // 3 minutes on a 429
MAX_RETRIES          2
MAX_POSTS            500
SESSION_MAX_REQUESTS 300             // ends the run cleanly when hit
```

The delays are randomised because a metronome-steady request train is a stronger
signal than the rate itself.

**`SESSION_MAX_REQUESTS` has no Instagram equivalent.** LinkedIn throttles
cumulatively across a session, so a run that keeps going past a few hundred
requests is walking into a restriction no matter how politely it is paced. Every
request in the extension funnels through one counter; when it hits the ceiling
the run ends in state `session_limit_reached` — everything collected is kept,
the pagination cursor is saved, and **Resume** picks it up later. That is a clean
stop, not an error, and the popup says so. The counter resets on resume, which
is the point: it paces one sitting, not your whole life.

The popup shows the meter at all times, not just when it is nearly full.
Knowing a run spent 240 of 300 requests is what tells you whether to start
another one today.

**HTTP 999** is LinkedIn's own non-standard block response. It is treated as a
rate-limit signal alongside 429, with one difference: it is **never retried
automatically**. Retrying into a 999 is how a soft throttle becomes a restricted
account. The run pauses, the popup tells you what happened, and nothing else
moves until you press Resume.

**Challenges are never touched.** If LinkedIn serves a checkpoint, a captcha or a
`CHALLENGE` response — detected by the redirect landing on `/checkpoint/`, which
is a far more reliable signal than anything in the body — the run pauses, the
popup shows an amber banner, and you clear it yourself in the tab. No solving,
no proxying, no fingerprint spoofing. The only headers sent are `csrf-token`,
`x-restli-protocol-version` and `accept`, which is exactly what the page itself
sends. `tools/wiring-check.mjs` fails the build if a user agent or tracking
header ever appears in `voyager.js`.

### 3. Pagination lies

This is the part most scrapers get wrong, so it is worth being blunt: **this
extension does not promise "all posts", because LinkedIn will not give them to
you.** Profile-activity pagination degrades and then silently stops returning
new items well before an account's full history, and it does so without an
end-of-list signal.

The loop is built to notice:

- a page returning **zero new URNs** stops the run cleanly;
- **three consecutive pages of declining yield** log a warning naming the actual
  per-page numbers (`20 → 14 → 9 → 5`);
- the finish line reads **"Collected N posts — LinkedIn stopped returning
  more"**, never anything implying the account was exhausted.

That distinction is repeated in the popup, in the activity log, and in the
export's `README.txt`, because it is the difference between "this person posts
rarely" and "we got cut off" — and those lead to opposite decisions.

The **Target** row offers `50`, `100`, `250`, and **All**, where All means the
500 cap or wherever LinkedIn stops, whichever comes first.

## How it works

**Popup → service worker → content script.** The popup owns no state; it asks the
worker for a snapshot on open and re-renders on broadcast. Close it mid-scrape
and progress keeps going.

**Tab handling.** The worker reuses an existing LinkedIn tab or opens a new one,
navigates to the profile, waits for load, injects the content script
(idempotently — it short-circuits if already present), then sends `CS_START`.
Everything happens in a real, focused, visible tab.

**Collection, three strategies, tried in order:**

| # | Strategy | Notes |
|---|----------|-------|
| A | Voyager API | Richest and first to break. Off until you fill in `CFG` from a live capture. Pages properly, so it is the only one that reaches deep history. |
| B | Embedded JSON | Reads the normalized payloads LinkedIn server-renders into hidden `<code>` blocks. Needs no endpoint knowledge at all, so it survives an API change untouched. No pagination: first page only. |
| C | DOM harvest | Scrolls the rendered feed with randomised pauses. Anchored on `urn:li:activity:` in element attributes, not class names — the URN has to stay put for LinkedIn's own code to work, class names change every few weeks. |

B and C are not decoration. A *will* break, and when it does the log says so and
the run carries on at reduced depth rather than failing.

Strategy C needs the tab at `/in/<id>/recent-activity/all/`, which tears down the
content script. The worker handles that handshake — it navigates, re-injects, and
restarts the run with everything already collected handed back, so nothing is
re-fetched and the port disconnect is not misreported as an interruption.

**Per-post detail** runs only for posts still missing something. It reads each
permalink page through the same Strategy B machinery. Set
`CFG.alwaysFetchDetail = true` to force it for every post — at 4–9 s each,
against a 300-request budget, think about it first.

**Dates without a timestamp.** A post harvested from the DOM shows "2w", not a
date. LinkedIn's activity ids are snowflake-shaped — the high bits are a
millisecond epoch — so the publish time is recovered from the id itself. The
result is range-checked before use, and `metadata.txt` labels it *derived from
the post id* rather than passing it off as exact.

**Streaming.** The content script opens a long-lived port and pushes posts in
batches of five as they're produced, plus `POST_UPDATE` messages when the detail
pass enriches one. The worker upserts by activity id and writes to
`chrome.storage.local` on a 1.5 s throttle — a throttle, not a debounce, so a
continuous stream still flushes rather than never writing until the end.

## Video, honestly

LinkedIn does not serve a plain `.mp4`. It serves adaptive DASH/HLS behind
expiring signed URLs.

- Where a **progressive** variant exists, the highest-bitrate one is downloaded
  as an ordinary file, **and decoded into one still per second** into
  `video_NN_frames/`. Frames are JPEG, capped at 1280 px on the long edge and
  900 frames per video (15 minutes) — a hard stop, not a target.
- Where only an **adaptive** stream exists, the post gets
  `video_not_downloaded.txt` carrying the manifest URL, the protocol, the
  duration and a plain explanation.
- Either way the **poster frame** LinkedIn returned is saved as `poster_NN.jpg`,
  so even a stream that cannot be downloaded leaves one still behind.

Frame extraction runs in the offscreen document, through a real `<video>`
element painting onto a `<canvas>` — Chrome's own decoder does the work, so
nothing is bundled. Decoding is **serialised**: the media fetches run four wide,
but four videos decoding at once multiplies peak memory by four for no
throughput gain. Frames are streamed into the archive as they are produced
rather than collected first, because 900 live `Blob`s is a few hundred megabytes
held for the length of the video.

It is the slow part of an export. A ten-minute video is 600 seeks.

There is deliberately **no stream muxer**. Reassembling DASH means bundling a
demuxer, and that is a large dependency that ages badly for something outside the
point of this tool — so an adaptive-only video gets its poster and its manifest
URL, and no frames, because there is no decodable file to extract them from. Any
external downloader that speaks HLS takes the manifest URL directly — but soon,
because those URLs expire in hours.

## One ZIP, not thousands of files

**Download everything as ZIP** is the main button. The offscreen document fetches
every image and document itself, streams each into the ZIP writer, and hands
`chrome.downloads` a single archive.

Posts are grouped by kind, so "show me the photos" is one folder rather than a
walk through every numbered post. **Post numbers are global** — `Post_007`
exists exactly once, whichever group it landed in — so a row in `posts.csv`
names exactly one folder.

```
<publicId>.zip
└── <publicId>/
    ├── Profile/
    │   ├── profile.txt          human-readable summary
    │   ├── profile.json         full structured record
    │   ├── experience.txt
    │   ├── education.txt
    │   ├── profile_picture.jpg
    │   └── banner.jpg
    ├── Posts/
    │   ├── Photos/
    │   │   └── Post_002/
    │   │       ├── post.txt     post body text
    │   │       ├── metadata.txt date, reactions by type, comments, reposts
    │   │       └── media_01.jpg …
    │   ├── Videos/
    │   │   └── Post_004/
    │   │       ├── video_01.mp4
    │   │       ├── video_01_frames/
    │   │       │   ├── frame_0000s.jpg   one still per second
    │   │       │   ├── frame_0001s.jpg
    │   │       │   └── frames.txt        duration, interval, count
    │   │       ├── poster_01.jpg         the thumbnail LinkedIn returned
    │   │       ├── post.txt
    │   │       └── metadata.txt
    │   ├── Documents/           carousel / PDF posts — the PDF sits in the
    │   │   └── Post_009/        post folder, with document.txt beside it
    │   ├── Articles/
    │   ├── Reposts/
    │   ├── Polls/
    │   └── Text/
    ├── Comments/                only when the option is on
    │   └── Post_002_comments.txt
    ├── posts.csv                flat export for spreadsheet work
    ├── skipped.txt              only if something could not be fetched
    └── README.txt               what's inside + the data-handling note
```

Comments are kept in **one top-level folder** rather than scattered through the
post tree. That is deliberate: it is the only third-party personal data in the
export, and having it in one place makes it reviewable — and deletable —
without touching anything else.

Entries are STOREd rather than deflated — images and PDFs are already
compressed. ZIP64 headers appear automatically once a size, offset or entry count
outgrows the classic 32-bit limits. Nothing is held in RAM as bytes: each entry
keeps its `Blob` and only its CRC is streamed, and the archive is assembled as
one `Blob` that Chrome spills to disk. A media file that 404s — an expired signed
link — is skipped, counted, and the archive still completes.

`metadata.txt` distinguishes **`unknown`** from **`0`**. A count LinkedIn did not
return is not zero engagement, and when these rows feed an outreach decision that
difference matters.

### posts.csv

New here; the Instagram build has no equivalent. Columns:
`post_url, date, type, folder, text, reactions, comments, reposts, media_count`

`folder` is what makes the grouped tree navigable from a spreadsheet: sort or
filter on any column and the path to that post's files is on the row..

Every field is quoted, newlines inside a post body become a literal `\n`, and a
UTF-8 BOM is written so Excel opens it without mangling accents. A cell starting
`=`, `+`, `-` or `@` is prefixed with an apostrophe so a spreadsheet does not
execute it as a formula. A null count is an **empty cell**, not `0` — so
averaging a column doesn't quietly count unobtainable values as zero engagement.

## The popup

480 px wide, laid out so the controls, live progress and export buttons all sit
above Chrome's 600 px popup cut-off — only the activity log scrolls. (The
Instagram build's README says 396 px; its `tokens.css` has always said 480. This
carries the file over unchanged. One token, `--popup-w`, changes it.)

- **Status pill** tracks the run (`Idle → Scraping → Done`) with a pulsing lamp
  while live, plus a `Session cap` state.
- **Target row** takes a full profile URL *or* a bare public identifier and
  normalises it — `/in/slug`, trailing slashes, `?trk=…` query strings, locale
  subdomains like `uk.linkedin.com`, percent-encoded non-ASCII slugs. It rejects
  `/company/` and `/school/` URLs rather than treating them as people. On Start
  the field rewrites itself to the normalised form, so what will be scraped is
  never a guess.
- **Option chips** — Posts · Comments (off) · Skip video · Profile media.
- **Progress** shows `x / y`, a percentage, a time estimate, a bar, four tiles
  (posts · media · comments · failed), and the session request meter.
- **Amber banner** when the run pauses for a login, a challenge or a 999, with
  *Open tab* and *Resume*. Red for a hard error.
- **Activity log** colour-codes info / warning / error / success with timestamps.

Both themes are driven by `prefers-color-scheme`, with an explicit override in
Settings. The palette and the type are Content Daddy's — see **[Brand](#brand)**.

## Brand

The shell is built to *Brand Guidelines · 2026*. Everything lives in
`ui/tokens.css`; no other file names a colour or a face.

| Guideline | Token | Where it lands |
|---|---|---|
| Navy `#1A1A64` | `--navy`, `--brand` (light) | Primary buttons, checked boxes, the mark's plate, the active rail item |
| Indigo `#2F2DB4` | `--indigo`, `--brand-2`, `--brand` (dark) | Hover, focus rings, the running lamp, the far end of the progress gradient |
| White `#FFFFFF` | `--surface`, `--card` | Every panel. The app ground under them is white carrying a trace of navy, not grey |
| Near-black `#0A0A0A` | `--near-black`, `--text` | Body copy on white — and the whole ground in dark mode, which is what the deck's full-bleed bands use |
| Montserrat | `--font-display` | Headlines at 700, panel titles at 600, eyebrows in wide-tracked caps. Never body copy |
| Google Sans | `--font` | Body at 400, labels and emphasis at 500 |

Three things follow from the guideline rather than from taste:

- **Navy carries the light theme, indigo carries the dark one.** Navy on
  near-black is a control you cannot find; indigo is legible against both.
- **The mark is flat.** Misuse rule 03 rules out drop shadows, glows and bevels
  on the logo, so `.brand-mark` is the one raised-looking surface in the shell
  with no elevation on it.
- **Status colours are not brand colours.** Amber and green are functional, and
  each has two tokens: the saturated value is a *fill* (a 6px lamp, a meter),
  and a darker `-ink` value is what text may use. The old palette used one
  value for both, which put the `Done` and `Paused` labels at roughly 2:1
  against white.

Google Sans is proprietary and cannot be redistributed, so the body face is
declared `local("Google Sans"), … , url(dmsans…)`: a machine with the licensed
font installed renders the real thing, everywhere else gets DM Sans. Montserrat
is OFL and ships in full. `ui/fonts/README.md` has the details and how to swap
in a licensed Google Sans webfont build.

**One deliberate exception.** The toolbar icon and the shell's brand mark are
LinkedIn's "in" on LinkedIn blue, which is not a Content Daddy colour. It has
its own token, `--linkedin`, and nothing else in the stylesheet may reference
it. Reproducing another company's logo as they publish it is defensible;
recolouring it into your own palette is not, so the mark keeps its blue and
the rest of the shell keeps navy. See **[The icon](#the-icon)** for the
trademark position.

## Options

| Option | Effect |
|---|---|
| Posts | Off collects the profile only — a fast, cheap way to build a prospect list. |
| Comments | Off by default. On, adds `comments.txt` per post and the data-handling note to `README.txt`. Roughly doubles the run's cost. |
| Full history | On by default. Follows LinkedIn's "Show all" pages so experience, education and skills are the whole list rather than the two or three rows the profile card previews. One request per section, only for sections the profile actually links to — typically three. Off, the export carries whatever the card showed. |
| Skip video | Drops the **video**, not the post. The body text, counts and permalink are kept; the post re-files under Photos or Text depending on what is left, and `metadata.txt` says the video was skipped. (Before 1.0.4 this discarded the whole post.) |
| Profile media | Off skips the profile picture and banner; the text files are still written. |

Comments never restore as *on* from saved form state — turning them on is always
a deliberate act.

## Troubleshooting

### Media is still missing on some posts

Fixed in 1.0.4, and it was a second, separate cause from the avatar bug below.

A feed-list response routinely **declares** a media component and ships it
empty — the actual image only materialises on the permalink page. Such a post
looked finished from every angle: body text present, counts present,
`detailFetched` stamped true, and `classifyPost` calling it `text` *precisely
because* no media had been found. So `needsDetail()` said no, the detail pass
skipped it, and its photos were never fetched at all.

Posts now carry `mediaIncomplete` when they declared media and delivered none,
and that alone sends them to the detail pass.

The detail pass also gained a backstop. It reads the embedded JSON payloads on
the permalink page, and when LinkedIn does not server-render those for a given
post the mapping found nothing and the fetch "succeeded" with no media — while
the photos sat in the rendered markup of the very same response. That markup is
now read as a fallback: `og:image`, content `<img>` tags including their
lazy-loaded `data-delayed-url`, and `data-sources` for video.

If a post is *still* empty after this, `metadata.txt` now says which kind of
nothing it is — genuinely no attachment, declared-but-never-returned, or
dropped by the Skip video option.

### The export is lighter than expected and nothing says why

Fixed in 1.0.4. LinkedIn signs its media URLs with a short expiry, so a long
gap between scraping and exporting means the CDN starts returning 403 and those
files are skipped. The archive still completed, quietly missing them.

There is now a `skipped.txt` at the root of the archive listing every entry
that could not be written, with the reason and the URL. If you see one, re-run
the scrape and export straight after.

### Every post folder contains the poster's profile picture, and text posts show up as image posts

Fixed in 1.0.3. This was one bug with a lot of faces, and it is the reason the
media in an export looked wrong.

A resolved update does not only describe the post. Hanging off the same object
graph are the author's avatar, a reshared post's *original* author's avatar, the
publisher logo on an article card, and commenter photos in the social summary.
`imagesFrom()` walked the whole graph collecting anything that looked like an
image, so it picked up all of them. What that produced:

- the author's profile picture as **`media_01.jpg` in every post folder**, ahead
  of the real photos;
- **text-only posts classified as `image`**, because their media list was not
  empty — wrong `type` in `posts.csv` and a junk file on disk;
- **`media_count` inflated on every row**, by one per post and by two on a
  repost;
- the packager re-downloading the same avatar once per post, against the session
  budget.

Media is now read from the post's *content* subtrees only, skipping the
containers LinkedIn hangs identity and chrome off. Those container names move
much less often than model class names do, which is the same reasoning the rest
of this engine uses. A repost is deliberately still followed into — its media is
the original's media; only the two `actor` branches are skipped.

The same scoping fixed the post body: an author's headline is a `description`
too, and on a short post it was the *longer* string, so the unscoped walk had
been writing the poster's job title into `post.txt`.

**Anything scraped before 1.0.3 still carries the bad media in storage.** Press
**Clear** and run it again — re-exporting old data will reproduce the old
archive.

### Photos are missing from posts further down the feed

Fixed in 1.0.3. LinkedIn lazy-loads feed images: below the fold an `<img>` has
no `src` yet and parks the real URL on `data-delayed-url`. The DOM harvest only
read `src`, so posts past the first screen came back with their text and URN
intact and no media at all. Both attributes are read now.

### Media disappeared between the scrape finishing and the export

Fixed in 1.0.3. The detail pass replaced `media` wholesale with whatever the
permalink page returned. When that page yielded fewer items than the harvest had
already found — a carousel that renders lazily, a video whose progressive
variant appears on only one of the two responses — the extra items were dropped.
The two lists are now unioned, keyed on the URL, with the richer record winning.

### "Could not reach the page. Reload the LinkedIn tab and try again."

Fixed in 1.0.2, and worth knowing because it is a general Chrome-extension trap.

`chrome.tabs.update(tabId, {url})` does **not** flip the tab's status to
`loading` before it returns. Code that navigates and then immediately checks
`tab.status === 'complete'` is reading the *previous* page's state. 1.0.1 did
exactly that, waited its 900 ms settle, and then injected the content script
into a document that was already being torn down by the navigation it had
itself started. The `CS_START` message went nowhere and surfaced as the error
above.

It was intermittent — whether it broke depended on whether the new page
happened to finish loading inside that 900 ms — which is what made it look like
LinkedIn being flaky rather than a bug here. It hit two places: starting a run,
and the profile → activity-feed handoff that Strategy C needs.

The wait now only accepts `complete` when the tab is also **showing the page
that was asked for**, and a tab already sitting on that page is not navigated at
all. `tools/regression-test.mjs` reproduces the race against a fake tab.

### The run stops and the popup sticks on "Stopping" or "Packaging…"

Fixed in 1.0.2. An MV3 service worker is evicted after roughly 30 seconds
without an extension API call, and **a pending `setTimeout` does not count as
activity**. During a scrape the content script's heartbeat holds the worker up,
but packaging a large archive, waiting on a long download, and the 12-second
stop-settle timer all had nothing keeping them alive. If the worker died the
state never advanced.

There is now a reference-counted keep-alive around those three operations.

### The request meter jumps backwards mid-run

Fixed in 1.0.2. The DOM strategy re-hosts the same run in a freshly navigated
tab, and the content script was resetting its request counter on every start —
so one sitting silently got a second full 300-request allowance, which is the
exact thing the budget exists to prevent. The count is now carried across the
handoff. A deliberate **Resume** still starts a fresh budget, as documented.

### "Log into LinkedIn in this browser first" — but you are logged in

Fixed in 1.0.1. The cause is worth knowing because it will bite anything else
you build against LinkedIn:

**`li_at` — LinkedIn's actual session cookie — is HttpOnly.** `document.cookie`
never contains it, no matter how logged in you are. Any check written as
`if (!getCookie('li_at')) return notLoggedIn` refuses every valid session. That
is exactly what 1.0.0 did.

What a page script *can* see:

| Signal | Visible? | Sufficient? |
|---|---|---|
| `li_at` | no — HttpOnly | — |
| `JSESSIONID` | yes (the app reads it for `csrf-token`) | no — also issued to logged-out visitors |
| the rendered page | yes | yes — signed-out LinkedIn looks completely different |

`sessionState()` in `content.js` layers those and, importantly, **leans
lenient**: it refuses only when LinkedIn has actually put the tab on an auth
wall or is showing a Join now / Sign in view. Anything ambiguous is allowed
through, because a false positive costs one request that comes back 401 and is
handled properly, while a false negative strands you behind a banner you cannot
clear. It also returns the signal that produced its verdict, so a refusal says
what was observed rather than assuming you forgot to log in.

`wiring-check.mjs` now fails the build if anything gates the run on `li_at`
again.

### It starts, then immediately pauses on a security check

That is working as intended — clear it in the tab and press **Resume**. Nothing
here will try to solve it.

### It collects 10–20 posts and stops

Expected until you configure the Voyager feed endpoint. Strategy B reads the
server-rendered first page and there is no public offset parameter to page
further. See [ENDPOINTS.md](ENDPOINTS.md).

### HTTP 999

Not an endpoint problem and not something to retry. LinkedIn is refusing
automated requests from the session. Stop for the day.

## The profile photo, and everything else that was missing from a profile

Symptom: no profile picture, no follower or connection count, `education.txt`
saying "(no education captured)" and no skills — for a profile that plainly
shows all of it on screen.

That is the DOM strategy, which runs whenever the embedded payload does not
carry a `.Profile` entity. It was written against class names, and LinkedIn
renamed them. Running the same saved profile page through the reader before and
after:

| Field | Before | After |
|---|---|---|
| `photoUrl` | `static.licdn.com/…/og-generic.png` | the member's 400×400 avatar |
| `bannerUrl` | `null` | the cover image |
| `followers` | `null` | `18432` |
| `connections` | `null` | `500` |
| `education` | `[]` | every row on the page |
| `skills` | `[]` | every skill on the page |

Four separate causes:

- **The photo selector could not match.** It asked for
  `img.pv-top-card-profile-picture__image`; LinkedIn ships that image as
  `pv-top-card-profile-picture__image--show`. A class selector matches whole
  tokens, so those are different classes and the read fell through to
  `og:image` — which on a signed-in profile page is LinkedIn's own generic
  artwork. Worse than nothing: the popup showed a picture, the export wrote a
  `profile_picture.png`, and neither was the person.
- **The cover was never lazy-aware.** It read `el.src`, and a cover below the
  fold has its URL parked on `data-delayed-url` until it scrolls into view.
- **Counts came from `main span:has(+ span)`** — the first span in the page
  with a sibling span, which is not the follower count on any profile.
- **Education and skills were hardcoded `[]`.**

The replacement keys on things that do not churn: the CDN path
(`/profile-displayphoto/`, `/profile-displaybackgroundimage/`) for the images,
scoped to `<main>` first so a "People also viewed" avatar cannot win; the
rendered text for the counts; and the `#experience` / `#education` / `#skills`
anchor ids, which are what the profile's own in-page navigation targets. The
embedded-JSON reader got the same CDN-path fallback, so a shape change that
moves `profilePicture` no longer blanks the photo there either.

## The profile card is a preview, and it was being read as the history

Symptom: two jobs in `experience.txt` for someone with twelve, one school for
someone with four, two skills out of thirty-one. Or nothing at all.

A LinkedIn profile card **is a preview**. It renders two or three roles and
puts the rest behind *Show all 12 experiences*, which is its own URL:
`/in/<id>/details/experience/`. The scraper read only the card, and
`experience.txt` said so in as many words — "LinkedIn renders the full history
behind a 'Show all' page that this scraper does not follow". That is an honest
note about a hole, and it was still a hole.

Those pages are followed now. Which ones exist is not guessed: the card links
to exactly the sections the profile has, so the links are collected while the
profile is being read — off the document already in hand, so finding them costs
no request — and only those are fetched. A profile with three "Show all" links
costs three extra requests out of the 300-request session budget.

Driven end to end against a card showing 2 roles, 1 school and 2 skills, with
the full lists behind their pages:

```
experience: 12    education: 4    skills: 10
pages fetched: /in/sumon/  …/details/experience/  …/details/education/  …/details/skills/
```

Merging is additive and keyed on identity, so a role that appears on both the
card and the page is counted once, and a page that fails to load leaves what
the card found intact. Three other things came out of building it:

- **The section container is no longer only `closest('section')`.** The anchor
  is an empty div LinkedIn drops in for its own navigation; if the card around
  it ever stops being a `<section>`, every section reads as empty — and an
  empty education list is indistinguishable from a profile with no education.
  The walk up now settles for whatever ancestor actually contains a list.
- **Generic profile components are read.** Modern LinkedIn ships sections as
  components rather than typed `Position`/`Education` entities — a title, a
  subtitle, a caption and a metadata line, which is the same four fields in the
  same order the markup prints. On a details page the URL already says which
  section it is, so those rows feed the same mappers with no ambiguity.
- **A load-order bug the tests caught.** The page table is built at load time
  and names the row mappers, which were `const` arrows declared further down —
  so the table hit their temporal dead zone and threw before the content script
  registered a single listener. They are function declarations now, and
  `regression-test.mjs` pins that.

**Full history** is a chip in the popup, on by default. Turn it off and the
export carries what the card showed, at three fewer requests.

Recommendations and interests have "Show all" pages too and are deliberately
not followed: both are other people's words and identities, and this archive
keeps all third-party data under `Comments/` so it can be reviewed or deleted
in one place. Adding them would quietly break that.

## What the export gained, and how the saving was checked

Three of the seven post types were recognised but never read. `classifyPost`
had to spot an article, a poll and a reshare in order to file them — and then
nothing looked at what it had found, so those posts reached the archive as a
type label on an empty shell. All three are recorded now:

| Kind | What is captured |
| --- | --- |
| Article | headline, subtitle, link, domain, and the cover image, downloaded into the post folder |
| Poll | question, every option, votes per option and the share of the total, whether it closed |
| Reshare | original author, their headline and profile URL, the original permalink, and the original body |

Plus **hashtags** on every post, and the seven profile sections that were never
read at all — licences and certifications, languages, volunteering, projects,
honours and awards, courses, publications. One table in `content.js` drives
both strategies: a `$type` for the embedded payload, a section anchor id for
the rendered page. Two details that only show up in the output: a certificate
is *issued on* a date rather than held until Present, and a volunteer entry
leads with the role rather than the organisation.

**`posts.json` is new.** `posts.csv` is for a spreadsheet, so it flattens —
one row per post, a media *count* rather than the URLs, a vote total rather
than the split. The article card, the poll breakdown, the reshare provenance
and every media URL are structure, and structure does not survive a CSV. The
CSV also gained `hashtags`, `article_url`, `poll_votes`, `reshared_from` and
`reshared_url` as flat projections. `commentList` is deliberately *not* in
`posts.json`: comments are third-party personal data and the archive keeps all
of it under `Comments/` so it can be reviewed or deleted in one place.

### The saving process, checked end to end

Not by reading it. `zipwriter.js` was loaded into Chromium, driven with the
real `zipEntries()` output, and the archive it produced was written to disk and
opened with standard `unzip`:

```
unzip -t roundtrip.zip     No errors detected in compressed data
18 entries, every one extracting with its CRC intact
```

Then the case that actually worries me. The classic end-of-central-directory
record counts entries in 16 bits, so an archive of more than 65,535 files needs
the ZIP64 record and its locator — code that had never run. That is not a
hypothetical here: frame extraction writes one still per second, capped at 900
per video, so roughly 73 videos is enough to cross it. Built with 70,000
entries:

```
unzip -l zip64.zip         70000 files
unzip -t zip64.zip         No errors detected in compressed data
unzip -p … frame_069999    f69999
```

The ZIP64 path is correct, and an entry past the 16-bit ceiling extracts with
the right bytes.

## Four more, found by probing rather than reading

- **The archive could silently lose a file.** Every entry a post's documents
  produced was written to one fixed path — `document.txt` — so a post carrying
  two documents wrote it twice. A ZIP holds duplicate paths happily and every
  extractor keeps whichever it reads last, so the archive completed one file
  short with nothing to say so. Two documents sharing a title collided the same
  way, and a document actually titled *post* or *metadata* landed on the post
  body or its engagement record. Documents are numbered now, and `zipEntries()`
  returns through a final pass that guarantees uniqueness — renaming a
  collision rather than dropping it, because a `_2` suffix is a worse filename
  and a missing file is a worse archive.
- **A post that failed and then succeeded stayed failed.** The detail pass did
  `delete post.error` on a retry, but the worker merges updates over the stored
  post with `Object.assign`, and a key that is simply *absent* from the incoming
  object cannot un-set the one already there. So `metadata.txt` reported
  "Detail error: HTTP 500" for posts that had been captured perfectly, and the
  popup's Failed tile counted them forever. The error is cleared explicitly
  now, and the worker drops the post from its failure list when it arrives
  clean.
- **Starting a run on the activity page collected one page and stopped.** The
  escalation to the feed scroll was guarded on the tab *not* already being on
  the activity page — because the branch's job was to move the tab there. But
  the run's phase is still `main` at that point, so the feed-scroll branch
  further down never ran either: the DOM strategy was skipped entirely, and the
  run kept whatever the server-rendered first page held. Which is
  indistinguishable from "this profile only has 20 posts". Where the tab is now
  chooses *scroll here* versus *move there*, not whether to scroll at all.
- **"Skip video" could file a document under Photos.** Re-typing a stripped
  post called anything left over an image, so a post carrying a video *and* a
  document ended up in `Posts/Photos/` with a PDF in it and `image` in
  posts.csv. It uses `classifyByMedia` now — the same rule the detail pass
  already used, so the two paths agree.

All four are covered: the archive ones by real calls into `zipEntries` in
`export-test.mjs`, the other two by `regression-test.mjs`, which pins the shape
of code whose failure mode needs a live Chrome tab to reproduce.

## Fixed alongside the rebrand

Six defects found while reworking the shell. Each is reproducible; the first
four were visible in the popup.

- **A tooltip that could never be read.** `[data-tip]::after` always opened to
  the right of its trigger. The rail is at the left edge so that was correct
  there — but the *Appearance* button sits against the right edge, and its tip
  rendered from x=474 to x=554 in a 480 px popup: clipped away entirely by
  `body { overflow: hidden }`, while still stretching the document to 554 px
  wide, which is the width Chrome sizes a popup to. Tooltips now declare a
  placement; topbar controls use `data-tip-at="below-end"`.
- **Status labels below 2:1 contrast.** `Done` was `#16C784` on white and
  `Paused` was `#FFB020` — fine as a 6 px lamp, unreadable as text. Split into
  fill and `-ink` tokens.
- **The Activity empty state depended on script order.** `shell.js` dressed the
  bare `<li class="empty">` from a `MutationObserver` alone, so if `popup.js`
  rendered before `shell.js` executed there was no mutation left to observe and
  the panel kept the undressed placeholder. Same race left the footer's post
  count stuck at 0. Both now prime once at boot as well as observing.
- **Popup-raised messages vanished in about 100 ms.** `flash()` appended
  straight to the log element, and every one of its callers triggers a render
  immediately afterwards, which rebuilds that list from worker state —
  so "Could not start." was drawn and erased within a frame. They are now held
  in the popup and re-emitted after each render, and mirrored to a toast, since
  the Activity view is not the one on screen when Start is rejected.
- **The avatar was re-requested several times a second.** `renderProfile()`
  assigned `img.src` on every broadcast, which re-runs the image load algorithm
  and re-arms the error handler on a URL that had already failed. Guarded on the
  URL changing.
- **`vectorImageUrl()` dropped URLs it was written to accept.** The string
  branch sat behind `typeof vi !== 'object' → null`, so it was unreachable: a
  field LinkedIn had already flattened to a plain URL — a video's `thumbnail`,
  an older `displayImage` — resolved to `null` and the poster or profile picture
  was left out of the export with the URL in hand. Covered by two new cases in
  `tools/resolver-test.mjs`.

Two smaller ones: the *Switch section* row in Settings still documented only
`1` and `2` after `3 → Settings` was added, contradicting the rail's own
tooltip; and Resume re-enabled itself on the next broadcast, ~200 ms after the
click, so a second click sent a second `RESUME` into the same run.

## When it breaks

Everything version-specific is in one place: the `CFG` object at the top of
`content.js`. **[ENDPOINTS.md](ENDPOINTS.md)** documents, per capability, the
exact request to look for in DevTools, which fields are volatile, and how to
patch `CFG`.

Repeat of the important bit: there are no endpoint values in this repository,
and that is deliberate. Any value written from memory is stale on arrival, and a
stale one fails in a way that looks exactly like a rate limit — which sends you
debugging the wrong thing. Capture them live or leave Strategy A off.

## The icon

The toolbar icon and the shell's brand mark are LinkedIn's "in" in white on
LinkedIn blue, reproduced as LinkedIn publishes it rather than recoloured into
the Content Daddy palette — recolouring somebody else's logo to match your own
is worse than leaving it alone. It is drawn from geometry in
`tools/make-icons.mjs` rather than traced from a font, which is what keeps it
readable at 16 px where hinting would otherwise close up the counters. Node's
`zlib` is the only thing it needs; the PNG encoder is thirty lines and this
project still has no `package.json`.

Regenerate with `node tools/make-icons.mjs`. The PNGs are committed, so a normal
install remains build-step-free.

**The "in" glyph and that blue are LinkedIn Corporation's trademarks.** Using
them on a locally loaded build for your own use is unremarkable. Publishing or
distributing the extension wearing them is not: it asserts an affiliation that
does not exist, with the company whose User Agreement this tool already
contravenes, and it is grounds for removal from the Chrome Web Store on its own.
Swap the mark before it leaves your machine — `tools/make-icons.mjs` is thirty
lines of geometry and `.brand-mark` in `popup.html` is one `<svg>`.

## Permissions

`storage`, `downloads`, `scripting`, `activeTab`, `unlimitedStorage`,
`offscreen`, plus `host_permissions` for `https://www.linkedin.com/*` and
`https://*.licdn.com/*` (LinkedIn's media CDN — where the images and PDFs
actually live).

`unlimitedStorage` and `offscreen` are both silent (no install prompt).
`unlimitedStorage` keeps a large run inside quota; `offscreen` is what makes the
single-archive export possible at all, since an MV3 service worker has no
`URL.createObjectURL`.

## A note on terms

**LinkedIn's User Agreement prohibits automated collection.** Not "discourages",
not "rate-limits" — [section 8.2](https://www.linkedin.com/legal/user-agreement)
explicitly bars using bots or other automated methods to access the service,
scraping or copying profiles and data through any means not provided by
LinkedIn, and it does not carve out an exception for doing it slowly or from
your own browser. This extension does it slowly and from your own browser
anyway. That is a real reduction in risk and load. It is not permission.

**Account restriction is a realistic outcome, not a tail risk.** LinkedIn is
considerably more aggressive about this than Instagram. Their detection is
behavioural and cumulative, and it acts on the *account*, not the IP or the
session: a temporary restriction, a permanent one, or in the worst case a
closure that also takes your network and message history with it. There is no
appeals process worth relying on. The pacing floors, the session budget, the
999 handling and the hands-off challenge behaviour exist to keep you on the
right side of that line — they do not guarantee anything, and no setting in this
extension can.

**A secondary account is worth considering.** If these results feed an outreach
pipeline, the account doing the collecting does not have to be the account
carrying your professional identity, your network and ten years of history. Use
one you can afford to lose. That is the single highest-leverage risk decision
available here, and it costs nothing.

**On other people's data.** The target profile is one person's published
information. Turn comments on and you are also collecting names, headlines,
profile URLs and written words from people who have no idea. That may be
perfectly lawful for your purpose and it may not — GDPR, UK GDPR, CCPA and their
relatives all have opinions about scraped personal data used for outreach, and
"it was publicly visible" is not the defence people assume. Retention,
minimisation and deletion are yours to get right. The extension does what it can:
comments are off by default, hard-capped when on, commenter profiles are never
followed, and the export says plainly what it contains.

Scrape profiles you own or have permission to collect from, keep what you pull in
line with whatever privacy rules apply to you, and assume the account you run
this from is expendable.
