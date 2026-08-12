/*
 * export-test.mjs — exercises the export layout without a browser.
 *
 *   node tools/export-test.mjs
 *
 * The archive is the actual deliverable, and it is built from several hundred
 * lines of string assembly that nothing else executes until a real run is
 * already finished. This drives background.js's layout functions over a
 * hand-built result set covering every post shape — text, image, progressive
 * video, adaptive-only video, document, comments — and asserts the tree, the
 * CSV and the data-handling note.
 *
 * background.js is a service worker, so it is evaluated here with `chrome` and
 * `importScripts` stubbed. Only the pure layout functions are called; nothing
 * touches the network, storage or downloads.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/* ---------------- harness ---------------- */
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const note = fn();
    passed++;
    process.stdout.write(`  ok   ${name}${note ? ` (${note})` : ''}\n`);
  } catch (err) {
    failures.push(name);
    process.stdout.write(`  FAIL ${name}\n       ${err.message}\n`);
  }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what || 'value'}\n       expected ${JSON.stringify(b)}\n       actual   ${JSON.stringify(a)}`);
  }
}
const ok = (c, w) => {
  if (!c) throw new Error(w || 'expected truthy');
};
const group = (t) => process.stdout.write(`\n${t}\n`);

/* ---------------- stub the worker environment ---------------- */
const noop = () => {};
const ev = () => ({ addListener: noop, removeListener: noop });
const chromeStub = {
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  tabs: { onRemoved: ev(), onUpdated: ev(), get: async () => null, query: async () => [], create: async () => ({ id: 1 }), update: async () => {}, sendMessage: async () => ({}) },
  windows: { update: async () => {} },
  runtime: { onConnect: ev(), onMessage: ev(), onInstalled: ev(), onStartup: ev(), sendMessage: async () => {} },
  downloads: { onCreated: ev(), onChanged: ev(), onDeterminingFilename: ev(), search: async () => [], download: async () => 1 },
  scripting: { executeScript: async () => {} },
  offscreen: { hasDocument: async () => false, createDocument: async () => {}, closeDocument: async () => {} }
};

const importScriptsStub = () => {
  new Function(read('utils.js'))();
};

const factory = new Function(
  'importScripts',
  'chrome',
  `${read('background.js')}
   return {
     zipEntries, postsCsv, readmeFileText, metadataFileText, profileFileText,
     commentsFileText, videoNoteText, experienceFileText, educationFileText,
     blankState,
     load: (s, p) => { state = s; posts = p; reindex(); }
   };`
);
const BG = factory(importScriptsStub, chromeStub);
const U = globalThis.LIS;

/* ---------------- fixture ---------------- */
const PROFILE = {
  publicId: 'ada-lovelace',
  profileUrn: 'urn:li:fsd_profile:ACoAAAExample',
  fullName: 'Ada Lovelace',
  firstName: 'Ada',
  lastName: 'Lovelace',
  headline: 'Analytical Engine · Founder',
  location: 'London, England, United Kingdom',
  industry: 'Software Development',
  about: 'First programmer.\nStill shipping.',
  followers: 12500,
  connections: 500,
  photoUrl: 'https://media.licdn.com/dms/image/ABC/800_800/photo.jpg',
  bannerUrl: 'https://media.licdn.com/dms/image/DEF/1584_396/banner.png',
  experience: [
    { title: 'Founder', company: 'Analytical Engines Ltd', location: 'London', dates: 'Jan 2020 – Present', current: true, description: 'Building things.' },
    { title: 'Mathematician', company: 'Independent', location: '', dates: 'Jan 1840 – Dec 1850', current: false, description: '' }
  ],
  education: [{ school: 'Home tuition', degree: '', field: 'Mathematics', dates: '1830 – 1835', description: '' }],
  skills: ['Mathematics', 'Programming'],
  currentPosition: { title: 'Founder', company: 'Analytical Engines Ltd', dates: 'Jan 2020 – Present', location: 'London' },
  profileUrl: 'https://www.linkedin.com/in/ada-lovelace/',
  scrapedAt: '2026-08-06T10:00:00.000Z',
  source: 'embedded-json'
};

const POSTS = [
  {
    activityId: '7100000000000000001',
    urn: 'urn:li:activity:7100000000000000001',
    postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/',
    type: 'text',
    text: 'Line one\nLine two, with a "quote" and a comma.',
    publishedAt: 1700000000000,
    timestampSource: 'api',
    reactions: 42,
    reactionsByType: { LIKE: 30, PRAISE: 8, EMPATHY: 4 },
    comments: 3,
    reposts: 1,
    media: [],
    commentList: [
      { author: 'Grace Hopper', headline: 'Rear Admiral', profileUrl: 'https://www.linkedin.com/in/grace/', text: 'Nice.', at: 1700000100000, reactions: 2 }
    ],
    commentsTruncated: false
  },
  {
    activityId: '7100000000000000002',
    urn: 'urn:li:activity:7100000000000000002',
    postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000002/',
    type: 'image',
    text: 'Two photos.',
    publishedAt: 1700100000000,
    timestampSource: 'api',
    reactions: 10,
    reactionsByType: {},
    comments: 0,
    reposts: null,
    media: [
      { type: 'image', url: 'https://media.licdn.com/dms/image/A/1.jpg' },
      { type: 'image', url: 'https://media.licdn.com/dms/image/A/2.png' }
    ]
  },
  {
    activityId: '7100000000000000003',
    urn: 'urn:li:activity:7100000000000000003',
    postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000003/',
    type: 'video',
    text: 'Progressive video.',
    publishedAt: 1700200000000,
    timestampSource: 'api',
    reactions: 5,
    reactionsByType: { LIKE: 5 },
    comments: 1,
    reposts: 0,
    media: [{ type: 'video', url: 'https://dms.licdn.com/playlist/vid/clip.mp4', manifestUrl: null, downloadable: true, durationMs: 30000 }]
  },
  {
    activityId: '7100000000000000004',
    urn: 'urn:li:activity:7100000000000000004',
    postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000004/',
    type: 'video',
    text: 'Adaptive only.',
    publishedAt: null,
    timestampSource: 'derived-from-urn',
    reactions: null,
    reactionsByType: {},
    comments: null,
    reposts: null,
    media: [{ type: 'video', url: null, manifestUrl: 'https://dms.licdn.com/playlist/vid/master.m3u8', protocol: 'HLS', downloadable: false, durationMs: 62000 }]
  },
  {
    activityId: '7100000000000000005',
    urn: 'urn:li:activity:7100000000000000005',
    postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000005/',
    type: 'document',
    text: 'A carousel.',
    publishedAt: 1700400000000,
    timestampSource: 'api',
    reactions: 99,
    reactionsByType: { LIKE: 99 },
    comments: 12,
    reposts: 4,
    media: [{ type: 'document', url: 'https://media.licdn.com/dms/document/X/deck.pdf', title: 'Q3 Deck', pages: 12, downloadable: true }]
  }
];

function loadFixture(opts) {
  const s = BG.blankState();
  s.publicId = 'ada-lovelace';
  s.maxPosts = 100;
  s.profile = PROFILE;
  s.requests = 87;
  s.status = (opts && opts.status) || 'done';
  s.pagination = (opts && opts.pagination) || { stoppedEarly: true, reason: 'Voyager feed returned a page with no new posts after 4 page(s).', pages: 4 };
  s.failedCount = (opts && opts.failedCount) || 0;
  s.options = Object.assign({ includePosts: true, includeComments: false, skipVideos: false, includeProfileMedia: true }, (opts && opts.options) || {});
  BG.load(s, POSTS.map((p) => Object.assign({}, p)));
  return s;
}

const pathsOf = (items) => items.map((i) => i.path);
const find = (items, frag) => items.find((i) => i.path.includes(frag));

/* ================================================================== */
group('archive tree');

check('the top-level layout matches the specified structure', () => {
  loadFixture();
  const paths = pathsOf(BG.zipEntries());
  for (const want of [
    'ada-lovelace/Profile/profile.txt',
    'ada-lovelace/Profile/profile.json',
    'ada-lovelace/Profile/experience.txt',
    'ada-lovelace/Profile/education.txt',
    'ada-lovelace/Profile/profile_picture.jpg',
    'ada-lovelace/Profile/banner.png',
    'ada-lovelace/Posts/Text/Post_001/post.txt',
    'ada-lovelace/Posts/Text/Post_001/metadata.txt',
    'ada-lovelace/posts.csv',
    'ada-lovelace/README.txt'
  ]) {
    if (!paths.includes(want)) throw new Error(`missing ${want}\n       got: ${paths.slice(0, 8).join(', ')}…`);
  }
  return `${paths.length} entries`;
});

check('each post files under the folder for its type', () => {
  loadFixture();
  const paths = pathsOf(BG.zipEntries());
  const at = (n) => paths.find((p) => p.includes(`Post_${n}/post.txt`));
  eq(at('001'), 'ada-lovelace/Posts/Text/Post_001/post.txt', 'text');
  eq(at('002'), 'ada-lovelace/Posts/Photos/Post_002/post.txt', 'image');
  eq(at('003'), 'ada-lovelace/Posts/Videos/Post_003/post.txt', 'video');
  eq(at('004'), 'ada-lovelace/Posts/Videos/Post_004/post.txt', 'adaptive video');
  eq(at('005'), 'ada-lovelace/Posts/Documents/Post_005/post.txt', 'document');
});

check('post numbers stay global across the type folders', () => {
  loadFixture();
  const nums = pathsOf(BG.zipEntries())
    .map((p) => (p.match(/Posts\/\w+\/Post_(\d+)\//) || [])[1])
    .filter(Boolean);
  // Numbering must not restart per folder, or posts.csv could not name one.
  eq([...new Set(nums)].sort(), ['001', '002', '003', '004', '005']);
});

check('media is numbered per post and keeps its original extension', () => {
  loadFixture();
  const paths = pathsOf(BG.zipEntries());
  ok(paths.includes('ada-lovelace/Posts/Photos/Post_002/media_01.jpg'), 'media_01.jpg');
  ok(paths.includes('ada-lovelace/Posts/Photos/Post_002/media_02.png'), 'media_02.png');
  ok(paths.includes('ada-lovelace/Posts/Videos/Post_003/video_01.mp4'), 'progressive video downloads');
});

check('a downloadable video is flagged for frame extraction', () => {
  loadFixture();
  const v = find(BG.zipEntries(), 'Post_003/video_01.mp4');
  ok(v.video, 'the item carries frame instructions');
  eq(v.video.intervalSec, 1, 'one frame per second');
  eq(v.video.framesDir, 'ada-lovelace/Posts/Videos/Post_003/video_01_frames');
});

check('an adaptive-only video produces a note instead of a media file', () => {
  loadFixture();
  const paths = pathsOf(BG.zipEntries());
  ok(paths.includes('ada-lovelace/Posts/Videos/Post_004/video_not_downloaded.txt'), 'note is written');
  ok(!paths.some((p) => /Post_004\/(media_|video_0)/.test(p)), 'no phantom media file');
  ok(!paths.some((p) => p.includes('Post_004') && p.includes('_frames/')), 'nothing to decode, so no frames');
});

check('the note carries the manifest URL and says why there is no file', () => {
  loadFixture();
  const note = find(BG.zipEntries(), 'Post_004/video_not_downloaded.txt').text;
  ok(note.includes('master.m3u8'), 'manifest URL present');
  ok(/HLS/.test(note), 'protocol named');
  ok(/muxer/i.test(note), 'explains the omission');
  ok(/expire/i.test(note), 'warns the URL expires');
});

check('a downloadable video gets no note', () => {
  loadFixture();
  ok(!pathsOf(BG.zipEntries()).some((p) => p.includes('Post_003/video_not_downloaded.txt')));
});

check('a video poster is written when LinkedIn returned one', () => {
  loadFixture();
  const s = BG.blankState();
  Object.assign(s, { publicId: 'ada-lovelace', profile: PROFILE, options: { includePosts: true, includeComments: false, skipVideos: false, includeProfileMedia: true } });
  BG.load(s, [
    {
      activityId: '1', postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/', type: 'video', text: 'x',
      media: [{ type: 'video', url: 'https://dms.licdn.com/v.mp4', thumbnail: 'https://media.licdn.com/poster.jpg', downloadable: true }]
    }
  ]);
  const paths = pathsOf(BG.zipEntries());
  ok(paths.includes('ada-lovelace/Posts/Videos/Post_001/poster_01.jpg'), 'poster saved beside the video');
});

check('a stranded video and a real one do not collide on poster numbers', () => {
  const s = BG.blankState();
  Object.assign(s, {
    publicId: 'ada-lovelace',
    profile: PROFILE,
    options: { includePosts: true, includeComments: false, skipVideos: false, includeProfileMedia: true }
  });
  BG.load(s, [
    {
      activityId: '1',
      postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
      type: 'video',
      text: 'two clips',
      media: [
        // Adaptive-only: gets a poster but never a video file, so it must not
        // leave the video counter behind for the next poster to reuse.
        { type: 'video', url: null, manifestUrl: 'https://dms.licdn.com/m.m3u8', thumbnail: 'https://media.licdn.com/p1.jpg' },
        { type: 'video', url: 'https://dms.licdn.com/v.mp4', thumbnail: 'https://media.licdn.com/p2.jpg' }
      ]
    }
  ]);
  const paths = pathsOf(BG.zipEntries());
  const posters = paths.filter((p) => p.includes('/poster_'));
  eq(posters.length, 2, 'one per video');
  eq([...new Set(posters)].length, 2, 'and they are distinct paths');
});

check('document posts keep the PDF in their own folder', () => {
  loadFixture();
  const items = BG.zipEntries();
  const paths = pathsOf(items);
  ok(paths.includes('ada-lovelace/Posts/Documents/Post_005/Q3 Deck.pdf'), 'the PDF itself');
  const src = find(items, 'Post_005/document.txt');
  ok(src, 'document.txt exists');
  ok(src.text.includes('7100000000000000005'), 'records the post URL');
  ok(src.text.includes('12'), 'records the page count');
});

check('a document post still gets its own post.txt and metadata.txt', () => {
  loadFixture();
  const paths = pathsOf(BG.zipEntries());
  ok(paths.includes('ada-lovelace/Posts/Documents/Post_005/post.txt'));
  ok(paths.includes('ada-lovelace/Posts/Documents/Post_005/metadata.txt'));
});

/* ================================================================== */
group('options');

check('comments go to one top-level folder, only when the option is on', () => {
  loadFixture({ options: { includeComments: false } });
  ok(!pathsOf(BG.zipEntries()).some((p) => p.includes('/Comments/')), 'absent when off');

  loadFixture({ options: { includeComments: true } });
  const on = pathsOf(BG.zipEntries()).filter((p) => p.includes('/Comments/'));
  eq(on.length, 5, 'one per post when on');
  ok(on.includes('ada-lovelace/Comments/Post_001_comments.txt'), 'named for its post number');
  // Kept out of the post tree so the third-party data sits in one place.
  ok(!pathsOf(BG.zipEntries()).some((p) => /Posts\/.*comments\.txt/.test(p)), 'not scattered through Posts/');
});

check('profile media is skipped when the option is off', () => {
  loadFixture({ options: { includeProfileMedia: false } });
  const paths = pathsOf(BG.zipEntries());
  ok(!paths.some((p) => p.includes('profile_picture')), 'no photo');
  ok(!paths.some((p) => p.includes('banner')), 'no banner');
  ok(paths.includes('ada-lovelace/Profile/profile.txt'), 'text files still written');
});

/* ================================================================== */
group('posts.csv');

function csvRows(text) {
  // Fields are always quoted and newlines are escaped, so a line split is safe.
  return text.replace(/^﻿/, '').trim().split('\r\n');
}

/** Splits one row on top-level commas and unquotes each field. */
function csvFields(row) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '"') {
      if (inQ && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

check('has a BOM so Excel reads UTF-8 correctly', () => {
  loadFixture();
  ok(BG.postsCsv(POSTS).charCodeAt(0) === 0xfeff);
});

check('header is exactly the specified columns', () => {
  loadFixture();
  eq(
    csvRows(BG.postsCsv(POSTS))[0],
    '"post_url","date","type","folder","text","reactions","comments","reposts","media_count"'
  );
});

check('one row per post, plus the header', () => {
  loadFixture();
  eq(csvRows(BG.postsCsv(POSTS)).length, POSTS.length + 1);
});

check('a multi-line post body never splits a row', () => {
  loadFixture();
  const rows = csvRows(BG.postsCsv(POSTS));
  ok(rows[1].includes('Line one\\nLine two'), 'newline escaped to \\n');
  ok(rows[1].includes('""quote""'), 'quotes doubled');
  eq(rows.length, 6, 'row count is unaffected by the embedded newline');
});

check('every row has exactly nine fields', () => {
  loadFixture();
  for (const row of csvRows(BG.postsCsv(POSTS))) {
    const n = csvFields(row).length;
    if (n !== 9) throw new Error(`${n} fields in: ${row.slice(0, 70)}…`);
  }
});

check('the folder column names the post’s folder in this archive', () => {
  loadFixture();
  const rows = csvRows(BG.postsCsv(POSTS));
  eq(csvFields(rows[1])[3], 'Posts/Text/Post_001');
  eq(csvFields(rows[2])[3], 'Posts/Photos/Post_002');
  eq(csvFields(rows[5])[3], 'Posts/Documents/Post_005');
  // Every row must point at a folder the archive actually contains.
  const paths = pathsOf(BG.zipEntries());
  for (const r of rows.slice(1)) {
    const f = csvFields(r)[3];
    ok(paths.some((p) => p.includes(f + '/')), `no such folder: ${f}`);
  }
});

check('a missing count is an empty cell, not a zero', () => {
  loadFixture();
  // The adaptive-only post has null reactions, comments and reposts. They must
  // arrive empty so a spreadsheet treats them as absent rather than averaging
  // them in as real zeros.
  const f = csvFields(csvRows(BG.postsCsv(POSTS))[4]);
  eq([f[5], f[6], f[7]], ['', '', ''], 'reactions/comments/reposts');
  // A genuine zero must still be a zero.
  const img = csvFields(csvRows(BG.postsCsv(POSTS))[2]);
  eq(img[6], '0', 'a real zero comment count');
});

check('media_count reflects the media list', () => {
  loadFixture();
  const rows = csvRows(BG.postsCsv(POSTS));
  eq(csvFields(rows[2])[8], '2', 'image post has two media');
  eq(csvFields(rows[1])[8], '0', 'text post has none');
});

check('the post URL and type survive round-trip unaltered', () => {
  loadFixture();
  const f = csvFields(csvRows(BG.postsCsv(POSTS))[1]);
  eq(f[0], 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/');
  eq(f[2], 'text');
  eq(f[1], '2023-11-14 22:13:20');
  eq(f[4], 'Line one\\nLine two, with a "quote" and a comma.', 'text unescapes to the escaped form');
});

/* ================================================================== */
group('metadata.txt');

check('reactions are broken down by type with readable labels', () => {
  loadFixture();
  const md = find(BG.zipEntries(), 'Post_001/metadata.txt').text;
  ok(/Reactions\s*:\s*42/.test(md), 'total');
  ok(/Like\s*:\s*30/.test(md), 'LIKE -> Like');
  ok(/Celebrate\s*:\s*8/.test(md), 'PRAISE -> Celebrate');
  ok(/Love\s*:\s*4/.test(md), 'EMPATHY -> Love');
});

check('a post with no breakdown says so rather than showing nothing', () => {
  loadFixture();
  const md = find(BG.zipEntries(), 'Post_002/metadata.txt').text;
  ok(/by type\s*:\s*not returned/.test(md));
});

check('an unobtainable count reads "unknown", never 0', () => {
  loadFixture();
  const md = find(BG.zipEntries(), 'Post_004/metadata.txt').text;
  ok(/Reactions\s*:\s*unknown/.test(md), 'null reactions');
  ok(/Comments\s*:\s*unknown/.test(md), 'null comments');

  const zero = find(BG.zipEntries(), 'Post_002/metadata.txt').text;
  ok(/Comments\s*:\s*0\b/.test(zero), 'a real zero still reads 0');
});

check('a derived timestamp is labelled as derived', () => {
  loadFixture();
  const md = find(BG.zipEntries(), 'Post_004/metadata.txt').text;
  ok(/derived from the post id/i.test(md));
  const exact = find(BG.zipEntries(), 'Post_001/metadata.txt').text;
  ok(!/derived from the post id/i.test(exact), 'an API timestamp is not labelled');
});

check('dates render as UTC', () => {
  loadFixture();
  const md = find(BG.zipEntries(), 'Post_001/metadata.txt').text;
  ok(/2023-11-14 22:13:20 UTC/.test(md), md.split('\r\n').find((l) => l.includes('Date')));
});

/* ================================================================== */
group('profile files');

check('profile.txt carries headline, location, current position and about', () => {
  loadFixture();
  const t = find(BG.zipEntries(), 'Profile/profile.txt').text;
  for (const frag of ['Ada Lovelace', 'Analytical Engine', 'London', 'CURRENT POSITION', 'Analytical Engines Ltd', 'First programmer']) {
    ok(t.includes(frag), `missing: ${frag}`);
  }
});

check('profile.json round-trips as valid JSON', () => {
  loadFixture();
  const parsed = JSON.parse(find(BG.zipEntries(), 'Profile/profile.json').text);
  eq(parsed.publicId, 'ada-lovelace');
  eq(parsed.experience.length, 2);
});

check('experience.txt lists every role and marks the current one', () => {
  loadFixture();
  const t = find(BG.zipEntries(), 'Profile/experience.txt').text;
  ok(t.includes('Founder'), 'role 1');
  ok(t.includes('Mathematician'), 'role 2');
  ok(t.includes('[current]'), 'current marker');
});

check('an empty education list explains itself instead of rendering blank', () => {
  const s = loadFixture();
  s.profile = Object.assign({}, PROFILE, { education: [] });
  BG.load(s, POSTS);
  ok(find(BG.zipEntries(), 'Profile/education.txt').text.includes('(no education captured)'));
});

/* ================================================================== */
group('README.txt — the honesty file');

check('says LinkedIn stopped rather than implying the account was exhausted', () => {
  loadFixture();
  const r = find(BG.zipEntries(), 'README.txt').text;
  ok(/LinkedIn stopped returning more posts after 4 page\(s\)/.test(r), 'names the stop');
  ok(/not everything the account has ever posted/i.test(r), 'states the caveat plainly');
});

check('carries the third-party personal data note when comments are on', () => {
  loadFixture({ options: { includeComments: true } });
  const r = find(BG.zipEntries(), 'README.txt').text;
  ok(/third-party personal data/i.test(r), 'note present');
  ok(/retention/i.test(r) && /responsibility/i.test(r), 'names the operator duty');
  ok(/No commenter profile was fetched/i.test(r), 'states what was not done');
});

check('states the opposite when comments are off', () => {
  loadFixture({ options: { includeComments: false } });
  const r = find(BG.zipEntries(), 'README.txt').text;
  ok(/no third-party\s+personal data/i.test(r.replace(/\r\n/g, ' ')), 'says none was collected');
  ok(!/\*\*\* This export contains/.test(r), 'no warning banner');
});

check('reports the session budget spend', () => {
  loadFixture();
  ok(/87 of 300/.test(find(BG.zipEntries(), 'README.txt').text));
});

check('explains a session-cap stop when that is how the run ended', () => {
  loadFixture({ status: 'session_limit_reached' });
  ok(/session request budget/i.test(find(BG.zipEntries(), 'README.txt').text));
});

check('counts undownloaded videos', () => {
  loadFixture();
  const r = find(BG.zipEntries(), 'README.txt').text;
  ok(/1 video\(s\) were served as adaptive streams/.test(r));
});

check('mentions Documents/ only when there are documents', () => {
  loadFixture();
  ok(find(BG.zipEntries(), 'README.txt').text.includes('Documents/'), 'present with a doc post');

  const s = loadFixture();
  BG.load(s, POSTS.filter((p) => p.type !== 'document'));
  ok(!find(BG.zipEntries(), 'README.txt').text.includes('Documents/      '), 'absent without one');
});

/* ================================================================== */
group('comments.txt');

check('renders author, headline, profile URL and text', () => {
  loadFixture({ options: { includeComments: true } });
  const c = find(BG.zipEntries(), 'Comments/Post_001_comments.txt').text;
  for (const frag of ['Grace Hopper', 'Rear Admiral', 'linkedin.com/in/grace', 'Nice.']) {
    ok(c.includes(frag), `missing: ${frag}`);
  }
});

check('a post with no comments says which kind of nothing it is', () => {
  loadFixture({ options: { includeComments: true } });
  ok(find(BG.zipEntries(), 'Comments/Post_002_comments.txt').text.includes('(no comments)'), 'zero comments');
  ok(find(BG.zipEntries(), 'Comments/Post_003_comments.txt').text.includes('(not captured'), 'uncollected but non-zero');
});

/* ================================================================== */
group('edge cases');

check('a profile-only run still produces a valid archive', () => {
  const s = loadFixture();
  BG.load(s, []);
  const paths = pathsOf(BG.zipEntries());
  ok(paths.includes('ada-lovelace/Profile/profile.txt'));
  ok(paths.includes('ada-lovelace/posts.csv'), 'header-only CSV is still written');
  ok(paths.includes('ada-lovelace/README.txt'));
});

check('a posts-only run (no profile) does not crash the layout', () => {
  const s = loadFixture();
  s.profile = null;
  BG.load(s, POSTS);
  const paths = pathsOf(BG.zipEntries());
  ok(!paths.some((p) => p.includes('/Profile/')), 'no profile files');
  ok(paths.includes('ada-lovelace/Posts/Text/Post_001/post.txt'), 'posts still written');
});

check('a post with no text renders a placeholder rather than an empty file', () => {
  const s = loadFixture();
  BG.load(s, [Object.assign({}, POSTS[0], { text: '' })]);
  eq(find(BG.zipEntries(), 'Post_001/post.txt').text, '(no text)\r\n');
});

check('every entry has either text or a URL — never both, never neither', () => {
  loadFixture({ options: { includeComments: true } });
  for (const i of BG.zipEntries()) {
    const hasText = typeof i.text === 'string';
    const hasUrl = typeof i.url === 'string';
    if (hasText === hasUrl) throw new Error(`${i.path}: text=${hasText} url=${hasUrl}`);
  }
});

check('no archive path escapes the root folder', () => {
  loadFixture({ options: { includeComments: true } });
  for (const i of BG.zipEntries()) {
    if (!i.path.startsWith('ada-lovelace/')) throw new Error(`escapes root: ${i.path}`);
    if (i.path.includes('..')) throw new Error(`traversal: ${i.path}`);
  }
});

check('a hostile public identifier cannot break out of the archive', () => {
  const s = loadFixture();
  s.publicId = '../../etc/passwd';
  BG.load(s, POSTS.slice(0, 1));
  for (const i of BG.zipEntries()) {
    if (i.path.includes('..')) throw new Error(`traversal survived sanitisation: ${i.path}`);
  }
  return U.sanitizeSegment('../../etc/passwd');
});

check('archive paths are unique — nothing silently overwrites', () => {
  loadFixture({ options: { includeComments: true } });
  const paths = pathsOf(BG.zipEntries());
  const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
  if (dupes.length) throw new Error(`duplicates: ${[...new Set(dupes)].join(', ')}`);
  return `${paths.length} unique`;
});

/* ================================================================== */
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
