/*
 * shapes-test.mjs — the DOM readers against pages shaped differently from
 * the fixture they were written against.
 *
 *   node tools/shapes-test.mjs            (needs Playwright + a Chromium)
 *
 * Every other suite runs without a browser. This one cannot: the readers
 * are querySelector and innerText, and a fake DOM would only re-encode the
 * same assumptions. One profile is rendered eight ways, its "Show all" page
 * six ways, and one feed card eight ways — same facts, different markup —
 * and each reader has to produce the same answer from all of them. Before
 * this existed the readers passed 10 of the 22.
 *
 * Opt-in because it needs `npm i -D playwright` and a browser; set
 * PW_CHROMIUM to a Chromium binary if Playwright's own is not installed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (_) {
  console.log('shapes-test: playwright is not installed — `npm i -D playwright` to run the browser shapes.');
  process.exit(0);
}

const launch = () =>
  chromium.launch(Object.assign({ args: ['--no-sandbox'] }, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}));

const STUB = `globalThis.__LIS_TEST__={};globalThis.chrome={runtime:{connect:()=>({postMessage(){},onDisconnect:{addListener(){}},onMessage:{addListener(){}},disconnect(){}}),onMessage:{addListener(){}},sendMessage:()=>Promise.resolve({ok:true}),id:'t',lastError:null}};`;

async function pageWith(browser, url, html) {
  const page = await browser.newPage();
  await page.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  await page.setContent(html);
  await page.addScriptTag({ content: STUB });
  for (const f of ['utils.js', 'voyager.js', 'content.js']) await page.addScriptTag({ content: read(f) });
  return page;
}

let passed = 0;
const failures = [];
const report = (label, ok, detail) => {
  if (ok) passed++;
  else failures.push(label);
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}\n`);
};

/* ---------------- one profile, eight ways ---------------- */
const { FACTS, VARIANTS } = (() => {
const FACTS = {
  name: 'Sumon Chowdhury',
  headline: 'Podcast growth partner for founders',
  exp: [
    ['Founder', 'Content Daddy · Full-time', 'Jan 2023 - Present · 2 yrs', 'Kolkata, India'],
    ['Video Editor', 'Freelance · Self-employed', 'Mar 2019 - Dec 2022 · 3 yrs 10 mos', 'Remote'],
    ['Junior Editor', 'Studio Nine · Full-time', 'Jun 2017 - Feb 2019 · 1 yr 9 mos', 'Kolkata, India']
  ],
  edu: [
    ['University of Calcutta', 'Bachelor of Commerce, Accounting and Finance', '2015 - 2018'],
    ['Delhi Public School', 'Higher Secondary', '2013 - 2015']
  ],
  skills: ['Video Editing', 'Content Strategy', 'Podcast Production']
};

/* ---- span renderers ---- */
const ariaPair = (t) => `<span aria-hidden="true">${t}</span><span class="visually-hidden">${t}</span>`;
const hiddenFirst = (t) => `<span class="visually-hidden">${t}</span><div class="display-flex"><span aria-hidden="true">${t}</span></div>`;
const plain = (t) => `<span>${t}</span>`;
const bareText = (t) => `<div class="t-14">${t}</div>`;

/* ---- section renderers ---- */
const anchored = (id, inner) => `<section><div id="${id}"></div>${inner}</section>`;
const artdeco = (id, inner) => `<div class="artdeco-card pv-profile-card"><div id="${id}" class="pv-profile-card__anchor"></div>${inner}</div>`;
const headingOnly = (title, inner) => `<section><h2 class="pvs-header__title"><span aria-hidden="true">${title}</span></h2>${inner}</section>`;

const ul = (rows, span) => `<ul>${rows.map((r) => `<li>${r.map(span).join('')}</li>`).join('')}</ul>`;
const divs = (rows, span) => `<div class="pvs-list__container">${rows.map((r) => `<div class="pvs-list__item--line-separated pvs-entity">${r.map(span).join('')}</div>`).join('')}</div>`;

// LinkedIn's grouped experience: a company header, then nested positions.
const grouped = (span) => `<ul>
  <li class="pvs-entity--with-path">
    ${span('Content Daddy')}${span('Full-time · 2 yrs')}
    <ul class="pvs-list">
      <li>${span('Founder')}${span('Jan 2023 - Present · 2 yrs')}${span('Kolkata, India')}</li>
    </ul>
  </li>
  <li>${FACTS.exp[1].map(span).join('')}</li>
  <li>${FACTS.exp[2].map(span).join('')}</li>
</ul>`;

const head = (name, headline) => `<!doctype html><html><head><meta charset="utf-8">
<meta property="og:title" content="${name} - Content Daddy | LinkedIn"></head><body><nav id="global-nav"></nav><main>
<section><h1 class="text-heading-xlarge">${name}</h1><div class="text-body-medium break-words">${headline}</div>
<ul><li><span class="t-bold">18,432 followers</span></li><li><span class="t-bold">500+ connections</span></li></ul></section>`;

const tail = `</main></body></html>`;

const VARIANTS = {
  'V1 baseline (aria-hidden spans, <li>, anchor div)': (F) => head(F.name, F.headline) +
    anchored('experience', ul(F.exp, ariaPair)) + anchored('education', ul(F.edu, ariaPair)) + anchored('skills', ul(F.skills.map((s) => [s]), ariaPair)) + tail,

  'V2 no aria-hidden (plain spans)': (F) => head(F.name, F.headline) +
    anchored('experience', ul(F.exp, plain)) + anchored('education', ul(F.edu, plain)) + anchored('skills', ul(F.skills.map((s) => [s]), plain)) + tail,

  'V3 rows are <div>, not <li>': (F) => head(F.name, F.headline) +
    anchored('experience', divs(F.exp, ariaPair)) + anchored('education', divs(F.edu, ariaPair)) + anchored('skills', divs(F.skills.map((s) => [s]), ariaPair)) + tail,

  'V4 no anchor id, heading text only': (F) => head(F.name, F.headline) +
    headingOnly('Experience', ul(F.exp, ariaPair)) + headingOnly('Education', ul(F.edu, ariaPair)) + headingOnly('Skills', ul(F.skills.map((s) => [s]), ariaPair)) + tail,

  'V5 positions grouped under a company': (F) => head(F.name, F.headline) +
    anchored('experience', grouped(ariaPair)) + anchored('education', ul(F.edu, ariaPair)) + anchored('skills', ul(F.skills.map((s) => [s]), ariaPair)) + tail,

  'V6 artdeco cards, not <section>': (F) => head(F.name, F.headline) +
    artdeco('experience', ul(F.exp, ariaPair)) + artdeco('education', ul(F.edu, ariaPair)) + artdeco('skills', ul(F.skills.map((s) => [s]), ariaPair)) + tail,

  'V7 screen-reader span first, aria span wrapped': (F) => head(F.name, F.headline) +
    anchored('experience', ul(F.exp, hiddenFirst)) + anchored('education', ul(F.edu, hiddenFirst)) + anchored('skills', ul(F.skills.map((s) => [s]), hiddenFirst)) + tail,

  'V8 no spans at all — text in divs': (F) => head(F.name, F.headline) +
    anchored('experience', ul(F.exp, bareText)) + anchored('education', ul(F.edu, bareText)) + anchored('skills', ul(F.skills.map((s) => [s]), bareText)) + tail,

  // The anchor ids are locale-independent; the headings are not. With no
  // anchors at all, a French interface still has to be readable.
  'V9 French headings, no anchor ids': (F) => head(F.name, F.headline) +
    headingOnly('Expérience', ul(F.exp, ariaPair)) + headingOnly('Formation', ul(F.edu, ariaPair)) + headingOnly('Compétences', ul(F.skills.map((s) => [s]), ariaPair)) + tail,

  // Everything a top card can carry — and, below it, a section full of links
  // that belong to posts and past employers, none of which is the profile's.
  'V10 a full top card, with a linky section beneath it': (F) => `<!doctype html><html><head><meta charset="utf-8"></head><body><nav id="global-nav"><img src="https://media.licdn.com/dms/image/v2/D56/profile-displayphoto-shrink_100_100/0/99?e=1" alt="Viewer"></nav><main>
<section class="pv-top-card">
  <img class="pv-top-card-profile-picture__image--show" src="https://media.licdn.com/dms/image/v2/D56/profile-displayphoto-shrink_400_400/0/17?e=1" alt="${F.name}">
  <img src="https://media.licdn.com/dms/image/v2/D56/profile-framedphoto-shrink_400_400/0/18?e=1" alt="${F.name}, #OPEN_TO_WORK">
  <h1 class="text-heading-xlarge">${F.name}</h1><span class="text-body-small">(she/her)</span>
  <svg data-test-icon="verified-small"></svg>
  <div class="text-body-medium break-words">${F.headline}</div>
  <a href="https://www.linkedin.com/company/content-daddy/">Content Daddy</a>
  <a href="https://www.linkedin.com/school/calcutta/">University of Calcutta</a>
  <a href="https://contentdaddy.example/">contentdaddy.example</a>
  <ul><li><span class="t-bold">18,432 followers</span></li><li><span class="t-bold">500+ connections</span></li></ul>
</section>
${anchored('experience', ul(F.exp, ariaPair))}${anchored('education', ul(F.edu, ariaPair))}${anchored('skills', ul(F.skills.map((s) => [s]), ariaPair))}
<section><h2>Activity</h2><a href="https://www.linkedin.com/company/old-employer/">Old Employer</a><a href="https://somebodyelse.example/post/1">a post link</a><a href="https://another.example/">another</a></section>
</main></body></html>`
};

  return { FACTS, VARIANTS };
})();

async function profileShapes(browser) {
  process.stdout.write('\nprofile page shapes\n');
  for (const [label, render] of Object.entries(VARIANTS)) {
    const page = await pageWith(browser, 'https://www.linkedin.com/in/sumon/', render(FACTS));
    const r = await page.evaluate(() => {
      const p = globalThis.__LIS_TEST__.profileFromDom('sumon', document);
      const e0 = (p.experience || [])[0] || {};
      return { name: p.fullName, exp: (p.experience || []).length, edu: (p.education || []).length, skills: (p.skills || []).length, first: `${e0.title || '?'} @ ${e0.company || '?'}`,
               pronouns: p.pronouns, verified: p.verified, openTo: p.openTo, company: p.currentCompany, school: p.currentSchool, websites: p.websites, photo: p.photoUrl };
    });
    let ok = r.name === FACTS.name && r.exp === 3 && r.edu === 2 && r.skills === 3 && r.first === 'Founder @ Content Daddy';
    if (label.startsWith('V10')) {
      // The card's own facts, and none of the section-below's links.
      ok = ok && r.pronouns === 'she/her' && r.verified === true && r.openTo === 'Open to work' && r.company === 'Content Daddy' && r.school === 'University of Calcutta'
        && JSON.stringify(r.websites) === JSON.stringify(['https://contentdaddy.example/'])
        && /profile-displayphoto-shrink_400_400\/0\/17/.test(r.photo || '');
    }
    report(label, ok, ok ? '' : JSON.stringify(r));
    await page.close();
  }
}

/* ---------------- one "Show all" page, six ways ---------------- */
const { DETAIL_VARIANTS } = (() => {
const ROLES = [
  ['Founder', 'Content Daddy · Full-time', 'Jan 2023 - Present · 2 yrs', 'Kolkata, India'],
  ['Video Editor', 'Freelance · Self-employed', 'Mar 2019 - Dec 2022 · 3 yrs 10 mos', 'Remote'],
  ['Junior Editor', 'Studio Nine · Full-time', 'Jun 2017 - Feb 2019 · 1 yr 9 mos', 'Kolkata, India'],
  ['Intern', 'Studio Nine · Internship', 'Jan 2017 - May 2017 · 5 mos', 'Kolkata, India']
];
const ariaPair = (t) => `<span aria-hidden="true">${t}</span><span class="visually-hidden">${t}</span>`;
const plain = (t) => `<span>${t}</span>`;
const wrap = (inner) => `<!doctype html><html><body><nav id="global-nav"></nav><main>${inner}</main></body></html>`;
const ul = (rows, span) => `<ul>${rows.map((r) => `<li>${r.map(span).join('')}</li>`).join('')}</ul>`;
const comp = (rows) => `<code style="display:none">${JSON.stringify({ included: rows.map((r, i) => ({
  entityUrn: `urn:li:fsd_profilePosition:${i}`,
  components: { entityComponent: { titleV2: { text: r[0] }, subtitle: { text: r[1] }, caption: { text: r[2] }, metadata: r[3] ? { text: r[3] } : null } }
})) })}</code>`;

const DETAIL_VARIANTS = {
  'D1 baseline markup rows': wrap(ul(ROLES, ariaPair)),
  'D2 payload only, no markup rows': wrap('<ul></ul>' + comp(ROLES)),
  'D3 markup for two, payload for all four': wrap(ul(ROLES.slice(0, 2), ariaPair) + comp(ROLES)),
  'D4 plain spans, no aria-hidden': wrap(ul(ROLES, plain)),
  'D5 grouped: two roles under Studio Nine': wrap(`<ul>
    <li>${ROLES[0].map(ariaPair).join('')}</li>
    <li>${ROLES[1].map(ariaPair).join('')}</li>
    <li class="pvs-entity--with-path">${ariaPair('Studio Nine')}${ariaPair('2 yrs 2 mos')}
      <ul><li>${ariaPair('Junior Editor')}${ariaPair('Full-time')}${ariaPair('Jun 2017 - Feb 2019 · 1 yr 9 mos')}${ariaPair('Kolkata, India')}</li>
          <li>${ariaPair('Intern')}${ariaPair('Internship')}${ariaPair('Jan 2017 - May 2017 · 5 mos')}${ariaPair('Kolkata, India')}</li></ul>
    </li></ul>`),
  'D6 rows with a description paragraph and skills line': wrap(`<ul>${ROLES.map((r) => `<li>${r.map(ariaPair).join('')}${ariaPair('Built the studio from zero to a team of six.')}${ariaPair('Skills: Editing · Strategy')}</li>`).join('')}</ul>`)
};

  return { DETAIL_VARIANTS };
})();

async function detailShapes(browser) {
  process.stdout.write('\n"Show all" page shapes\n');
  const want = ['Founder @ Content Daddy', 'Video Editor @ Freelance', 'Junior Editor @ Studio Nine', 'Intern @ Studio Nine'];
  for (const [label, html] of Object.entries(DETAIL_VARIANTS)) {
    const page = await pageWith(browser, 'https://www.linkedin.com/in/sumon/details/experience/', html);
    const r = await page.evaluate((html) => {
      const T = globalThis.__LIS_TEST__;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const marked = T.rowsFrom(doc.querySelector('main') || doc.body, 200);
      let comps = [];
      try {
        const codes = [...doc.querySelectorAll('code')].map((c) => JSON.parse(c.textContent));
        comps = codes.length ? T.componentRows({ included: codes.flatMap((c) => c.included || []) }) : [];
      } catch (_) {}
      const mapped = T.experienceFromRows(T.mergeById(marked, comps, (x) => x.join('|')));
      return T.mergeById([], mapped, (x) => `${x.title}|${x.company}|${x.dates}`).map((e) => `${e.title} @ ${e.company}`);
    }, html);
    const ok = r.length === 4 && want.every((w) => r.includes(w));
    report(label, ok, ok ? '' : r.join(' | '));
    await page.close();
  }
}

/* ---------------- one feed card, eight ways ---------------- */
const { TEXT, TEXT9, FEED_VARIANTS } = (() => {
const URN = 'urn:li:activity:7100000000000000001';
const TEXT = 'Post number 1 about repurposing podcast footage into a month of clips.';
const TEXT9 = 'If you want to see more of this, say so — see more posts like it every week.';
const IMG = 'https://media.licdn.com/dms/image/v2/D56/feedshare-shrink_800/0/17?e=1';
const wrap = (inner) => `<!doctype html><html><body><nav id="global-nav"></nav><main>${inner}</main></body></html>`;
const social = `<div class="social-details-social-counts"><button aria-label="1,234 reactions"><span>1,234</span></button><button aria-label="56 comments">56 comments</button><button aria-label="7 reposts">7 reposts</button></div>`;

const FEED_VARIANTS = {
  'F1 baseline (data-urn, .update-components-text, img src)':
    wrap(`<div data-urn="${URN}"><div class="update-components-text">${TEXT}</div><img src="${IMG}">${social}</div>`),

  'F2 text truncated behind "…see more"':
    wrap(`<div data-urn="${URN}"><div class="update-components-text"><span class="break-words"><span dir="ltr" id="tt">${TEXT.slice(0, 30)}…</span></span><button class="feed-shared-inline-show-more-text__see-more-less-toggle" onclick="document.getElementById('tt').textContent='${TEXT}';this.textContent='see less'">…see more</button></div><img src="${IMG}">${social}</div>`),

  'F3 unknown text class (feed-shared-text / dir=ltr span)':
    wrap(`<div data-urn="${URN}"><div class="feed-shared-text"><span dir="ltr">${TEXT}</span></div><img src="${IMG}">${social}</div>`),

  'F4 data-id on a nested node, not the card root':
    wrap(`<div class="feed-shared-update-v2"><div data-id="${URN}" class="inner"></div><div class="update-components-text">${TEXT}</div><img src="${IMG}">${social}</div>`),

  'F5 lazy image (data-delayed-url only)':
    wrap(`<div data-urn="${URN}"><div class="update-components-text">${TEXT}</div><img data-delayed-url="${IMG}">${social}</div>`),

  'F6 repost wrapping an inner card with its own URN':
    wrap(`<div data-urn="${URN}"><div class="update-components-header">Sumon reposted this</div><div data-urn="urn:li:activity:7100000000000000009" class="feed-shared-update-v2__content"><div class="update-components-text">${TEXT}</div><img src="${IMG}"></div>${social}</div>`),

  'F7 counts as bare text, no aria-label':
    wrap(`<div data-urn="${URN}"><div class="update-components-text">${TEXT}</div><img src="${IMG}"><div class="social-details-social-counts"><span class="social-details-social-counts__reactions-count">1,234</span><span class="social-details-social-counts__comments">56 comments</span><span class="social-details-social-counts__reposts">7 reposts</span></div></div>`),

  'F8 image as CSS background, not <img>':
    wrap(`<div data-urn="${URN}"><div class="update-components-text">${TEXT}</div><div class="update-components-image__image" style="background-image:url(&quot;${IMG}&quot;)"></div>${social}</div>`),

  // The post itself says "see more". Removing the button's text by first
  // occurrence would cut the post; only the trailing button may go.
  'F9 the post text itself contains "see more"':
    wrap(`<div data-urn="${URN}"><div class="update-components-text"><span dir="ltr" id="tt9">${TEXT9}</span><button class="feed-shared-inline-show-more-text__see-more-less-toggle">see less</button></div><img src="${IMG}">${social}</div>`)
};

  return { TEXT, TEXT9, FEED_VARIANTS };
})();

async function feedShapes(browser) {
  process.stdout.write('\nfeed card shapes\n');
  for (const [label, html] of Object.entries(FEED_VARIANTS)) {
    const page = await pageWith(browser, 'https://www.linkedin.com/in/sumon/recent-activity/all/', html);
    const r = await page.evaluate(() => {
      const T = globalThis.__LIS_TEST__;
      T.expandSeeMore();
      const cards = T.harvestFeedCards();
      const c = cards[0] || {};
      return { n: cards.length, id: c.activityId, text: c.text || '', media: (c.media || []).length, reactions: c.reactions, comments: c.comments, reposts: c.reposts, type: c.type, truncated: !!c.textTruncated, repostText: c.repost ? c.repost.text : null, repostMedia: c.repost ? c.repost.media.length : null };
    });
    const counts = r.reactions === 1234 && r.comments === 56 && r.reposts === 7;
    const ok = label.startsWith('F6')
      ? r.n === 1 && r.type === 'repost' && r.text === '' && r.media === 0 && r.repostText === TEXT && r.repostMedia === 1 && counts
      : label.startsWith('F9')
        ? r.n === 1 && r.text === TEXT9 && r.media === 1 && counts && !r.truncated
        : r.n === 1 && r.id === '7100000000000000001' && r.text === TEXT && r.media === 1 && counts && !r.truncated;
    report(label, ok, ok ? '' : JSON.stringify(r));
    await page.close();
  }
}

const browser = await launch();
try {
  await profileShapes(browser);
  await detailShapes(browser);
  await feedShapes(browser);
} finally {
  await browser.close();
}
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
