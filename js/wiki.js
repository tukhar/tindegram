// Everything that talks to Wikipedia. The MediaWiki API allows anonymous
// cross-origin reads when origin=* is set, so no backend is needed.
import { cleanText } from './bits.js';

const API = 'https://en.wikipedia.org/w/api.php';

// Fresh subjects are drawn from Featured and Good articles, the two sets
// Wikipedia's own reviewers have vetted for quality.
const QUALITY = 'incategory:Featured_articles|Good_articles';

// `q` is the search engine's articletopic keyword.
export const TOPICS = [
  { key: 'space', name: 'Space', q: 'space' },
  { key: 'nature', name: 'Animals and plants', q: 'biology' },
  { key: 'science', name: 'Physics and chemistry', q: 'physics|chemistry' },
  { key: 'earth', name: 'Earth and climate', q: 'earth-and-environment' },
  { key: 'body', name: 'Medicine and the body', q: 'medicine-and-health' },
  { key: 'tech', name: 'Technology', q: 'technology|computing|engineering' },
  { key: 'math', name: 'Mathematics', q: 'mathematics' },
  { key: 'history', name: 'History', q: 'history' },
  { key: 'ideas', name: 'Philosophy and religion', q: 'philosophy-and-religion' },
  { key: 'art', name: 'Art and architecture', q: 'visual-arts|architecture' },
  { key: 'words', name: 'Books and language', q: 'literature|linguistics' },
  { key: 'music', name: 'Music', q: 'music' },
  { key: 'screen', name: 'Film and TV', q: 'films|television' },
  { key: 'food', name: 'Food and drink', q: 'food-and-drink' },
  { key: 'society', name: 'Society and politics', q: 'society|politics-and-government' },
  { key: 'money', name: 'Business and economics', q: 'business-and-economics' },
  { key: 'games', name: 'Video games', q: 'video-games' },
  { key: 'war', name: 'Military', q: 'military-and-warfare' },
  { key: 'sports', name: 'Sports', q: 'sports' },
  { key: 'travel', name: 'Transport', q: 'transportation' },
];

const DETAIL = {
  prop: 'pageimages|description|extracts|pageprops',
  ppprop: 'disambiguation',
  piprop: 'thumbnail',
  pithumbsize: '960',
  pilimit: 'max',
  exintro: '1',
  explaintext: '1',
  exlimit: 'max',
};

// Titles that make a weak first impression as a random subject: single
// seasons and annual events, individual storms, ships and numbered roads.
// They can still turn up as branches when a subject links to them.
const DULL = [
  /^\d{4}\b/,
  /\b\d{4}[–-]\d{2,4}\b/,
  /^(Hurricane|Tropical Storm|Typhoon|Cyclone|Tropical Depression) /,
  /^(HMS|USS|SMS|HMAS|HMCS|USCGC|INS|RMS|SS|MV) /,
  /^(U\.S\. Route|Interstate|State Route|Highway|Route|M-|[A-Z]{2}-)\s?\d/,
  /\b(State Route|State Highway|Highway|Route) \d+/,
  /\b(season|discography|filmography)\b/i,
  / at the \d{4} /,
  /^List of /,
];

const NAMESPACE = /^(Help|Wikipedia|WP|File|Image|Template|Category|Portal|Special|Talk|User|Draft|Module|MediaWiki|Book):/i;
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
// Links that are in almost every introduction and rarely lead anywhere fun:
// dates, lists, and the languages named in etymologies.
const TONGUES = 'Latin|Greek|French|German|Spanish|Italian|Arabic|Chinese|Japanese|Russian|Sanskrit|Hebrew|Persian|Portuguese|Dutch|Turkish|Korean|Hindi|English|Irish|Welsh';
const WEAK_LINK = new RegExp(
  `^(\\d{1,4}s?( BC| AD| BCE| CE)?|\\d{1,2}(st|nd|rd|th) (century|millennium).*|(${MONTHS})( \\d{1,2})?|\\d{1,2} (${MONTHS})|List of .*|Lists of .*|Index of .*|Outline of .*|.* \\(disambiguation\\)|(${TONGUES}) language|Latin|Ancient Greek|Old English|Middle English|Old Norse|Romanization of .*|.* romanization|International Phonetic Alphabet|Pinyin|Common Era|Anno Domini)$`,
  'i',
);

export const isDull = (title) => DULL.some((pattern) => pattern.test(title));

async function api(params) {
  const url = new URL(API);
  const all = { format: 'json', formatversion: '2', origin: '*', ...params };
  for (const [key, value] of Object.entries(all)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Wikipedia responded with ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.info || 'Wikipedia API error');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : '');

function toSubject(page) {
  if (!page || page.missing || page.invalid) return null;
  if (page.pageprops && 'disambiguation' in page.pageprops) return null;
  const extract = cleanText(page.extract || '');
  if (extract.length < 120) return null;
  return {
    id: page.title,
    title: page.title,
    pageid: page.pageid,
    description: capitalize(page.description || ''),
    extract,
    thumb: page.thumbnail ? { src: page.thumbnail.source, w: page.thumbnail.width, h: page.thumbnail.height } : null,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
  };
}

// Up to 20 random vetted articles within a topic (20 is the API's ceiling
// for intro extracts in one request).
export async function randomByTopic(topic, limit = 14) {
  const data = await api({
    action: 'query',
    generator: 'search',
    gsrsearch: `${QUALITY} articletopic:${topic.q}`,
    gsrsort: 'random',
    gsrlimit: String(Math.min(limit, 20)),
    gsrnamespace: '0',
    ...DETAIL,
  });
  return (data.query?.pages || []).map(toSubject).filter(Boolean);
}

// Views over the last week, keyed by page id. The API answers in instalments,
// so follow its continuation a few times.
export async function pageviews(pageids) {
  const views = new Map();
  let next = {};
  for (let round = 0; round < 6; round++) {
    const data = await api({
      action: 'query',
      pageids: pageids.slice(0, 50).join('|'),
      prop: 'pageviews',
      pvipdays: '7',
      ...next,
    });
    for (const page of data.query?.pages || []) {
      if (!page.pageviews) continue;
      const total = Object.values(page.pageviews).reduce((sum, n) => sum + (n || 0), 0);
      views.set(page.pageid, total);
    }
    if (!data.continue) break;
    next = data.continue;
  }
  return views;
}

async function details(titles) {
  if (!titles.length) return [];
  const data = await api({
    action: 'query',
    titles: titles.slice(0, 20).join('|'),
    redirects: '1',
    ...DETAIL,
  });
  const query = data.query || {};
  const alias = new Map();
  for (const { from, to } of query.normalized || []) alias.set(from, to);
  for (const { from, to } of query.redirects || []) alias.set(from, to);
  const pages = new Map((query.pages || []).map((page) => [page.title, page]));

  // Give results back in the order they were asked for.
  const out = [];
  const used = new Set();
  for (const title of titles) {
    let final = title;
    for (let hop = 0; hop < 3 && alias.has(final); hop++) final = alias.get(final);
    const subject = toSubject(pages.get(final));
    if (subject && !used.has(subject.title)) {
      used.add(subject.title);
      out.push(subject);
    }
  }
  return out;
}

// Titles linked from the prose of the introduction, in reading order. These
// are the links an editor thought you needed to understand the subject, which
// makes them better tangents than the hundreds of links further down.
async function leadLinks(title) {
  const data = await api({
    action: 'parse',
    page: title,
    prop: 'text',
    section: '0',
    redirects: '1',
    disableeditsection: '1',
    disabletoc: '1',
  });
  const doc = new DOMParser().parseFromString(data.parse?.text || '', 'text/html');
  const seen = new Set();
  const out = [];
  for (const anchor of doc.querySelectorAll('p a[href]')) {
    if (anchor.closest('sup, table, .reference, .IPA, .noprint, .ext-phonos')) continue;
    if (anchor.classList.contains('new') || anchor.classList.contains('external')) continue;
    const match = anchor.getAttribute('href').match(/^(?:\/wiki\/|\.\/)([^#?]+)/);
    if (!match) continue;
    let linked;
    try {
      linked = decodeURIComponent(match[1]).replace(/_/g, ' ');
    } catch {
      continue;
    }
    if (NAMESPACE.test(linked) || WEAK_LINK.test(linked) || seen.has(linked)) continue;
    seen.add(linked);
    out.push(linked);
  }
  return out;
}

async function similar(title, limit) {
  const data = await api({
    action: 'query',
    generator: 'search',
    gsrsearch: `morelike:${title}`,
    gsrlimit: String(limit),
    gsrnamespace: '0',
    ...DETAIL,
  });
  return (data.query?.pages || [])
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map(toSubject)
    .filter(Boolean);
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Where a kept subject can lead next. `exclude` is a Set of titles the reader
// has already kept or passed on.
export async function branches(title, exclude) {
  const linked = (await leadLinks(title)).filter((t) => t !== title && !exclude.has(t));
  const candidates = [...linked.slice(0, 12), ...shuffle(linked.slice(12)).slice(0, 8)];
  let subjects = (await details(candidates)).filter((s) => s.title !== title && !exclude.has(s.title));

  // Short introductions link to little; top up with similar articles. That
  // search is slow, so only reach for it when the choices would run thin.
  if (subjects.length < 4) {
    const have = new Set(subjects.map((s) => s.title));
    const extra = (await similar(title, 10)).filter(
      (s) => s.title !== title && !exclude.has(s.title) && !have.has(s.title),
    );
    subjects = [...subjects, ...extra];
  }

  // Earlier links and richer entries first, with enough chance mixed in that
  // returning to a subject shows a different set.
  const total = subjects.length || 1;
  return subjects
    .map((subject, i) => ({
      subject,
      rank: (1 - i / total) + (subject.thumb ? 0.9 : 0) + (subject.description ? 0.3 : 0) + Math.random() * 0.7,
    }))
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.subject);
}

// The whole article as plain text with == Section == headings.
export async function fullText(title) {
  const data = await api({
    action: 'query',
    titles: title,
    redirects: '1',
    prop: 'extracts',
    explaintext: '1',
    exsectionformat: 'wiki',
  });
  return data.query?.pages?.[0]?.extract || '';
}

// A thumbnail URL at a smaller standard width, for list rows.
export function smallThumb(thumb, width = 250) {
  if (!thumb) return null;
  const match = thumb.src.match(/\/(\d+)px-[^/]+$/);
  if (!match || Number(match[1]) <= width) return thumb.src;
  return thumb.src.replace(/\/\d+px-([^/]+)$/, `/${width}px-$1`);
}
