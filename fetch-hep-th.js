#!/usr/bin/env node
/**
 * Builds hep-th.json — the current arXiv hep-th "new submissions" listing.
 *
 * Runs on a GitHub Actions runner, i.e. server-side, so there is no CORS
 * involved and no third-party proxy. The app then reads ./hep-th.json from its
 * own origin.
 *
 * Primary source is the RSS feed, which is the same listing as
 * https://arxiv.org/list/hep-th/new but machine-readable and carrying an
 * explicit announce_type field. If the feed fails, the listing page itself is
 * scraped as a fallback.
 *
 * If BOTH sources fail the script exits non-zero and writes nothing, so the
 * last good hep-th.json stays in the repo and the Action turns red. It never
 * writes an empty or half-parsed file.
 *
 * Usage:  node scripts/fetch-hep-th.js
 * Env:    OUT  output path (default: hep-th.json in the repo root)
 */

'use strict';

const fs = require('fs');

const OUT = process.env.OUT || 'hep-th.json';
const RSS = 'https://rss.arxiv.org/rss/hep-th';
const PAGE = 'https://arxiv.org/list/hep-th/new';
const UA = 'work-to-do-listing-builder/1.0 (GitHub Actions; +https://github.com/kundusuman1994/work-to-do)';

/* ---------- small helpers ------------------------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => {
      const v = ENTITIES[n.toLowerCase()];
      return v === undefined ? m : v;
    });
}

/* strip tags, decode entities, collapse whitespace */
function clean(s) {
  return decode(String(s == null ? '' : s).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function uncdata(s) {
  return String(s == null ? '' : s).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}

/* first <name>...</name> inside a block, CDATA unwrapped, tags left intact */
function tag(block, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(block).match(
    new RegExp('<' + esc + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + esc + '>', 'i')
  );
  return m ? uncdata(m[1]) : '';
}

/* arXiv's calendar is Eastern — the listing flips at midnight New York time */
function etYMD(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

/* bare identifier: 2609.01706v2 -> 2609.01706, hep-th/0601001v1 -> hep-th/0601001 */
function bareId(s) {
  return String(s == null ? '' : s).trim().replace(/v\d+$/, '');
}

async function get(url) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        redirect: 'follow'
      });
      if (!res.ok) {
        last = new Error('HTTP ' + res.status + ' ' + res.statusText + ' from ' + url);
      } else {
        const body = await res.text();
        if (body && body.length > 500) return body;
        last = new Error('suspiciously short body (' + (body ? body.length : 0) + ' bytes) from ' + url);
      }
    } catch (err) {
      last = err;
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw last || new Error('could not fetch ' + url);
}

/* ---------- source 1: the RSS feed --------------------------------------- */

function fromRss(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  if (!blocks.length) throw new Error('feed contained no <item> elements');

  /* channel-level pubDate only — split the header off before the first item so
     an item's own pubDate cannot be picked up by mistake */
  const header = xml.split(/<item[\s>]/)[0];
  const pub = clean(tag(header, 'pubDate')) || clean(tag(header, 'lastBuildDate'));
  const pubDate = pub ? new Date(pub) : null;
  const listing = etYMD(pubDate && !isNaN(pubDate) ? pubDate : new Date());

  const items = [];
  for (const b of blocks) {
    const declared = clean(tag(b, 'arxiv:announce_type'));
    const inferred = (clean(tag(b, 'description')).match(/Announce Type:\s*([a-z-]+)/i) || [])[1] || '';
    const type = (declared || inferred).toLowerCase();
    if (type !== 'new') continue; /* drops cross-lists and replacements */

    const link = clean(tag(b, 'link'));
    const id = bareId((link.match(/abs\/(.+)$/) || [])[1] || '');
    if (!id) continue;

    /* older feed format appended "(arXiv:xxxx [hep-th])" to the title */
    const title = clean(tag(b, 'title')).replace(/\s*\(arXiv:[^)]*\)\s*$/i, '').trim();

    const desc = clean(tag(b, 'description'));
    const abstract = desc.split(/Abstract:\s*/i).pop().trim();

    items.push({
      id,
      key: id,
      title,
      authors: clean(tag(b, 'dc:creator')),
      abstract,
      link: 'https://arxiv.org/abs/' + id
    });
  }

  if (!items.length) throw new Error('feed had ' + blocks.length + ' items but none announced as new');
  return { source: 'rss', listing, items };
}

/* ---------- source 2: the listing page ----------------------------------- */

function fromPage(html) {
  /* find the New submissions section and stop at whatever heading follows it —
     if the headings are not where expected, give up rather than guess */
  const headings = [];
  const re = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let m;
  while ((m = re.exec(html)) !== null) headings.push({ at: m.index, text: clean(m[1]) });

  const startIdx = headings.findIndex(h => /new submissions/i.test(h.text));
  if (startIdx === -1) throw new Error('no "New submissions" heading on the listing page');

  const start = headings[startIdx].at;
  const next = headings.slice(startIdx + 1)
    .find(h => /cross|replacement/i.test(h.text));
  const section = html.slice(start, next ? next.at : html.length);

  const items = [];
  const pair = /<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/gi;
  let p;
  while ((p = pair.exec(section)) !== null) {
    const dt = p[1];
    const dd = p[2];

    const id = bareId((dt.match(/href="\/abs\/([^"?#]+)"/i) || [])[1] || '');
    if (!id) continue;

    /* primary subject must be hep-th, which is what excludes cross-lists */
    const primary = (dd.match(/class="primary-subject"[^>]*>([\s\S]*?)</i) || [])[1] || '';
    if (primary && !/\(hep-th\)/i.test(primary)) continue;

    const grab = cls => {
      const g = dd.match(new RegExp('class="' + cls + '[^"]*"[^>]*>([\\s\\S]*?)</div>', 'i'));
      /* the author list is a run of <a> tags, so stripping them leaves " ," */
      return g ? clean(g[1]).replace(/^(Title|Authors):\s*/i, '').replace(/\s+,/g, ',') : '';
    };

    const para = dd.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

    items.push({
      id,
      key: id,
      title: grab('list-title'),
      authors: grab('list-authors'),
      abstract: para ? clean(para[1]) : '',
      link: 'https://arxiv.org/abs/' + id
    });
  }

  if (!items.length) throw new Error('listing page parsed but yielded no entries');
  /* the page carries no machine-readable listing date; the runner fires after
     midnight ET, so the Eastern calendar date is the listing date */
  return { source: 'listing-page', listing: etYMD(new Date()), items };
}

/* ---------- main --------------------------------------------------------- */

(async function main() {
  const problems = [];
  let result = null;

  try {
    result = fromRss(await get(RSS));
  } catch (err) {
    problems.push('rss: ' + err.message);
    try {
      result = fromPage(await get(PAGE));
    } catch (err2) {
      problems.push('listing page: ' + err2.message);
    }
  }

  if (!result) {
    console.error('Both sources failed. hep-th.json left untouched.');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }

  for (const p of problems) console.warn('note: ' + p);

  /* sanity gate — never overwrite a good file with something malformed */
  const usable = result.items.filter(i => i.id && i.title);
  if (usable.length !== result.items.length) {
    console.warn('note: dropped ' + (result.items.length - usable.length) + ' entries with no id or title');
  }
  if (!usable.length) {
    console.error('Nothing usable after validation. hep-th.json left untouched.');
    process.exit(1);
  }

  const payload = {
    listing: result.listing,
    source: result.source,
    count: usable.length,
    items: usable
  };

  /* skip the write when only the timestamp would change, so the workflow does
     not commit an identical listing every few hours */
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (err) { /* no previous file — first run */ }

  if (previous) {
    const strip = o => JSON.stringify({ listing: o.listing, source: o.source, count: o.count, items: o.items });
    if (strip(previous) === strip(payload)) {
      console.log('listing ' + payload.listing + ' unchanged (' + payload.count + ' papers) — not rewriting ' + OUT);
      return;
    }
    if (previous.listing && payload.listing < previous.listing) {
      console.error('arXiv served listing ' + payload.listing + ', older than the stored ' + previous.listing + '. Keeping the stored one.');
      process.exit(1);
    }
  }

  payload.fetched_at = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n', 'utf8');
  console.log('wrote ' + OUT + ': listing ' + payload.listing + ', ' + payload.count + ' papers, via ' + payload.source);
})();
