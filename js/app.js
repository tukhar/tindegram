import * as wiki from './wiki.js';
import { hookBits, deepBits } from './bits.js';
import { store } from './store.js';
import { attachSwipe } from './swipe.js';

const stage = document.getElementById('stage');
const trailEl = document.getElementById('trail');
const toastEl = document.getElementById('toast');
const sheetEl = document.getElementById('sheet');
const countEl = document.getElementById('treeCount');
const themeMeta = document.querySelector('meta[name="theme-color"]');

const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FLY_MS = calm ? 1 : 300;
const DEEPEST_GROUND = 6; // styles.css defines ground colours for depths 0-6
const CHOICES_SHOWN = 4;
const LETTER_TINTS = [
  ['#D5E0FA', '#2A56C6'],
  ['#E3D8F7', '#6A3DBA'],
  ['#DADFEA', '#3A4159'],
];

const state = {
  view: 'loading', // loading | card | fork | error
  card: null, // the subject on screen
  cardEl: null,
  parent: null, // id of the kept subject this card branches from; null at the surface
  siblings: [], // other branches of `parent`, shown when the reader passes
  pages: [], // bits of the current card: hook, deeper facts, closing page
  page: 0,
  deep: null, // promise for the deeper pages
  deepLoaded: false,
  waiting: false,
  pool: [], // fresh random subjects, ready to show
  poolEpoch: 0,
  refilling: null,
  fork: null, // { node, choices, at, bonus, failed } while choosing a branch
  branchTimer: 0,
  busy: false, // a card is flying off
  token: 0, // bumps on every navigation so stale async results are dropped
  swallowTap: false,
};

/* ---------- small helpers ---------- */

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

function icon(paths, size = 22) {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths}"/></svg>`;
  return span;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const initialOf = (title) => (title.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();

function hash(text) {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
}

function setDepth(depth) {
  document.body.dataset.depth = String(Math.min(depth, DEEPEST_GROUND));
  requestAnimationFrame(() => {
    const ground = getComputedStyle(document.body).getPropertyValue('--ground').trim();
    if (ground) themeMeta.content = ground;
  });
}

function paintTrail() {
  let depth = 0;
  let under = null;
  if (state.fork) {
    const { node } = state.fork;
    depth = store.depthOf(node.id);
    under = node.parent && store.nodes[node.parent]?.title;
  } else if (state.parent && store.nodes[state.parent]) {
    depth = store.depthOf(state.parent) + 1;
    under = store.nodes[state.parent].title;
  }
  trailEl.textContent = depth === 0 || !under ? 'At the surface' : `${depth} deep, under ${under}`;
}

function paintCount(bump) {
  countEl.textContent = String(Object.keys(store.nodes).length);
  if (!bump) return;
  countEl.classList.remove('bump');
  void countEl.offsetWidth; // restart the animation
  countEl.classList.add('bump');
}

/* ---------- the pool of fresh subjects ---------- */

function activeTopics() {
  const enabled = store.topics;
  const list = wiki.TOPICS.filter((topic) => !enabled || enabled.includes(topic.key));
  return list.length ? list : wiki.TOPICS;
}

const isFresh = (subject) =>
  !store.isSeen(subject.title) &&
  !store.isPassed(subject.title) &&
  !store.isKept(subject.title) &&
  !wiki.isDull(subject.title) &&
  !state.pool.some((pooled) => pooled.title === subject.title);

// Draw from three topics at once, then keep the few from each that people
// actually read (weekly page views) and that have a picture, with some luck
// mixed in so obscure gems still surface.
function refill() {
  if (state.refilling) return state.refilling;
  const epoch = state.poolEpoch;
  state.refilling = (async () => {
    const topics = shuffle(activeTopics()).slice(0, 3);
    const settled = await Promise.allSettled(topics.map((topic) => wiki.randomByTopic(topic, 14)));
    const batches = settled
      .map((result, i) =>
        result.status === 'fulfilled'
          ? result.value.filter(isFresh).map((subject) => ({ ...subject, topic: topics[i].name }))
          : null,
      )
      .filter(Boolean);
    if (!batches.length) throw settled[0].reason;

    let views = new Map();
    try {
      views = await wiki.pageviews(batches.flat().map((subject) => subject.pageid));
    } catch {
      // Ranking falls back to pictures and chance.
    }

    const picks = [];
    for (const batch of batches) {
      const ranked = batch
        .map((subject) => ({
          subject,
          rank: Math.log10((views.get(subject.pageid) || 0) + 10) + (subject.thumb ? 0.9 : 0) + Math.random() * 1.1,
        }))
        .sort((a, b) => b.rank - a.rank);
      picks.push(...ranked.slice(0, 4).map((entry) => entry.subject));
    }
    if (epoch !== state.poolEpoch) return; // topics changed while this was loading
    for (const subject of shuffle(picks)) {
      if (isFresh(subject)) state.pool.push(subject);
    }
  })().finally(() => {
    state.refilling = null;
  });
  return state.refilling;
}

// One light request so the very first card appears quickly.
async function quickStart() {
  const [topic] = shuffle(activeTopics());
  const list = (await wiki.randomByTopic(topic, 10))
    .filter(isFresh)
    .map((subject) => ({ ...subject, topic: topic.name }))
    .sort((a, b) => (b.thumb ? 1 : 0) - (a.thumb ? 1 : 0));
  state.pool.push(...list.slice(0, 2));
}

async function takeRoot() {
  if (!state.pool.length && state.refilling) {
    try {
      await state.refilling;
    } catch {
      // Try the quick path below.
    }
  }
  if (!state.pool.length) await quickStart();
  if (!state.pool.length) await refill();
  const subject = state.pool.shift();
  if (!subject) throw new Error('No subjects found');
  if (state.pool.length < 4) refill().catch(() => {});
  return subject;
}

function preload(subject) {
  if (subject?.thumb) new Image().src = subject.thumb.src;
}

/* ---------- branches of a subject ---------- */

const branchCache = new Map(); // title -> promise of subjects
const BRANCH_CACHE_LIMIT = 16;

const exclusionsFor = (title) => new Set([...store.passedTitles(), ...Object.keys(store.nodes), title]);

// Looking up branches takes a couple of round trips, so it starts while the
// reader is still on the card and the answer is reused when they dig in.
function branchesFor(title) {
  if (!branchCache.has(title)) {
    const lookup = wiki.branches(title, exclusionsFor(title));
    lookup.catch(() => branchCache.delete(title));
    branchCache.set(title, lookup);
    if (branchCache.size > BRANCH_CACHE_LIMIT) branchCache.delete(branchCache.keys().next().value);
  }
  return branchCache.get(title);
}

async function freshBranches(title) {
  const exclude = exclusionsFor(title);
  let list = (await branchesFor(title)).filter((subject) => !exclude.has(subject.title));
  if (list.length < 2) {
    // The remembered answer has been used up; ask again.
    branchCache.delete(title);
    list = (await branchesFor(title)).filter((subject) => !exclude.has(subject.title));
  }
  return list;
}

/* ---------- showing a card ---------- */

function buildMedia(subject) {
  const letter = () => {
    const [tint, ink] = LETTER_TINTS[hash(subject.title) % LETTER_TINTS.length];
    return el(
      'div',
      { class: 'media media--letter', style: `--tint:${tint};--tint-ink:${ink}` },
      el('span', { class: 'initial', 'aria-hidden': 'true', text: initialOf(subject.title) }),
    );
  };
  if (!subject.thumb) return letter();

  const { src } = subject.thumb;
  const fit = /\.(svg|png|gif)/i.test(src);
  const img = el('img', { src, alt: '', decoding: 'async', draggable: 'false' });
  const media = el(
    'div',
    { class: fit ? 'media media--fit' : 'media' },
    fit && el('div', { class: 'media-back', style: `background-image:url("${src.replace(/["\\]/g, '')}")` }),
    img,
  );
  img.addEventListener('load', () => img.classList.add('ready'), { once: true });
  img.addEventListener('error', () => media.replaceWith(letter()), { once: true });
  if (img.complete && img.naturalWidth) img.classList.add('ready');
  return media;
}

function bitContent(page) {
  if (page.kind === 'hook') {
    return [
      el('p', { class: 'bit-text', text: page.lead }),
      page.extra && el('p', { class: 'bit-text bit-text--extra', text: page.extra }),
    ];
  }
  if (page.kind === 'end') {
    const text = `That's the short tour of ${state.card.title}. Dig in to see where it leads, or pass for something else.`;
    return [el('p', { class: 'bit-text', text })];
  }
  return [page.label && el('p', { class: 'bit-label', text: page.label }), el('p', { class: 'bit-text', text: page.text })];
}

// The text area gives way before the picture does. If the hook does not fit,
// drop its second sentence; anything still too long fades out at the bottom.
function fitBit(bit, page) {
  const extra = bit.querySelector('.bit-text--extra');
  page.extraDropped = false;
  if (extra && bit.scrollHeight > bit.clientHeight + 1) {
    extra.remove();
    page.extraDropped = true;
  }
  bit.classList.toggle('bit--clipped', bit.scrollHeight > bit.clientHeight + 1);
}

function paintProgress() {
  const bar = state.cardEl?.querySelector('.progress');
  if (!bar) return;
  const marks = state.pages.map((_, i) => el('i', { class: i <= state.page ? 'on' : null }));
  if (!state.deepLoaded) marks.push(el('i', { class: 'pending' }));
  bar.replaceChildren(...marks);
}

function paintBit(direction) {
  const card = state.cardEl;
  const page = state.pages[state.page];
  const bit = card.querySelector('.bit');
  const media = card.querySelector('.media');
  const before = media.getBoundingClientRect().height;

  card.dataset.page = state.page === 0 ? 'hook' : 'deep';
  bit.classList.remove('bit--clipped');
  bit.replaceChildren(...bitContent(page).filter(Boolean));
  fitBit(bit, page);
  paintProgress();

  if (!direction || calm) return;
  const after = media.getBoundingClientRect().height;
  if (Math.abs(after - before) > 2) {
    media.animate(
      [
        { flex: 'none', minHeight: '0px', height: `${before}px` },
        { flex: 'none', minHeight: '0px', height: `${after}px` },
      ],
      { duration: 320, easing: 'cubic-bezier(.2, .8, .2, 1)' },
    );
  }
  bit.animate(
    [
      { opacity: 0, transform: `translateY(${direction === 'up' ? 20 : -20}px)` },
      { opacity: 1, transform: 'none' },
    ],
    { duration: 280, easing: 'ease-out' },
  );
}

function loadDeep(subject) {
  const hook = state.pages[0];
  return wiki
    .fullText(subject.title)
    .then((text) => deepBits(text, hook.extra && !hook.extraDropped ? hook.extra : null))
    .catch(() => [])
    .then((bits) => {
      if (state.card !== subject) return;
      state.pages.push(...bits.map((bit) => ({ kind: 'deep', ...bit })), { kind: 'end' });
      state.deepLoaded = true;
      paintProgress();
    });
}

function settle(card) {
  card.style.transition = `transform ${calm ? 1 : 320}ms cubic-bezier(.2, 1.3, .4, 1)`;
  card.style.transform = '';
  for (const name of ['--dig', '--pass', '--more']) card.style.removeProperty(name);
}

function wireCard(card) {
  attachSwipe(card, {
    onDrag(axis, dx, dy) {
      if (state.busy) return;
      card.style.transition = 'none';
      if (axis === 'x') {
        card.style.transform = `translate(${dx}px, ${dy * 0.12}px) rotate(${dx * 0.045}deg)`;
        const pull = Math.min(1, Math.abs(dx) / 110);
        card.style.setProperty('--dig', dx > 0 ? pull : 0);
        card.style.setProperty('--pass', dx < 0 ? pull : 0);
      } else {
        const shift = dy < 0 ? -Math.min(64, -dy * 0.4) : Math.min(36, dy * 0.3);
        card.style.transform = `translateY(${shift}px)`;
        card.style.setProperty('--more', dy < 0 ? Math.min(1, -dy / 90) : 0);
      }
    },
    onRelease(axis, dx, dy, vx, vy) {
      if (state.busy) return;
      if (axis === 'x') {
        if (dx > 100 || (vx > 0.55 && dx > 36)) return dig();
        if (dx < -100 || (vx < -0.55 && dx < -36)) return pass();
        return settle(card);
      }
      settle(card);
      if (dy < -64 || (vy < -0.5 && dy < -28)) more();
      else if (dy > 64 || (vy > 0.5 && dy > 28)) less();
    },
    // Like stories: tap the left edge to go back a fact, anywhere else for the next.
    onTap(ratio) {
      if (state.swallowTap) {
        state.swallowTap = false;
        return;
      }
      if (ratio < 0.3) less();
      else more();
    },
  });
}

function showCoach() {
  const row = (kind, path, name, line) =>
    el(
      'p',
      { class: 'coach-row' },
      el('span', { class: `coach-arrow coach-arrow--${kind}` }, icon(path)),
      el('span', null, el('b', { text: name }), line),
    );
  stage.append(
    el(
      'div',
      { class: 'coach' },
      row('pass', 'M19 12H5M11 6l-6 6 6 6', 'Pass', 'Swipe left to close a subject.'),
      row('more', 'M12 19V5M6 11l6-6 6 6', 'More', 'Swipe up for another fact.'),
      row('dig', 'M5 12h14M13 6l6 6-6 6', 'Dig in', 'Swipe right to keep it and branch out.'),
      el('p', { class: 'coach-foot', text: 'Tap anywhere to start.' }),
    ),
  );
}

function dismissCoach() {
  const coach = stage.querySelector('.coach:not(.gone)');
  if (!coach) return false;
  store.hinted = true;
  coach.classList.add('gone');
  setTimeout(() => coach.remove(), 260);
  return true;
}

function showCard(subject) {
  state.token++;
  state.card = subject;
  state.fork = null;
  state.busy = false;
  state.waiting = false;
  setView('card');
  setDepth(state.parent ? store.depthOf(state.parent) + 1 : 0);
  paintTrail();
  store.markSeen(subject.title);

  state.pages = [{ kind: 'hook', ...hookBits(subject.extract) }];
  state.page = 0;
  state.deepLoaded = false;

  const parent = state.parent && store.nodes[state.parent];
  const origin = parent ? `From ${parent.title}` : subject.topic;
  const card = el(
    'article',
    { class: 'card', 'data-page': 'hook', 'aria-label': subject.title },
    el('div', { class: 'progress', 'aria-hidden': 'true' }),
    buildMedia(subject),
    el(
      'div',
      { class: 'body' },
      origin && el('p', { class: parent ? 'origin origin--branch' : 'origin', text: origin }),
      el('h2', { class: subject.title.length > 34 ? 'headword headword--long' : 'headword', text: subject.title }),
      subject.description && el('p', { class: 'gloss', text: subject.description }),
      el('div', { class: 'bit', 'aria-live': 'polite' }),
      el('a', { class: 'source', href: subject.url, target: '_blank', rel: 'noopener', text: 'Full article on Wikipedia' }),
    ),
    el('span', { class: 'verdict verdict--dig', 'aria-hidden': 'true', text: 'Dig in' }),
    el('span', { class: 'verdict verdict--pass', 'aria-hidden': 'true', text: 'Pass' }),
    el('span', { class: 'verdict verdict--more', 'aria-hidden': 'true', text: 'More' }),
  );
  state.cardEl = card;
  stage.replaceChildren(card);
  if (!store.hinted) showCoach();
  paintBit(null);
  wireCard(card);
  if (!calm) {
    card.animate(
      [
        { transform: 'translateY(14px) scale(.95)', opacity: 0.4 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)' },
    );
  }

  state.deep = loadDeep(subject);
  preload(state.siblings[0] || state.pool[0]);
  clearTimeout(state.branchTimer);
  state.branchTimer = setTimeout(() => {
    if (state.card === subject) branchesFor(subject.title).catch(() => {});
  }, 900);
}

function renderGhost() {
  state.card = null;
  state.cardEl = null;
  stage.replaceChildren(
    el(
      'div',
      { class: 'card card--ghost', 'aria-busy': 'true', 'aria-label': 'Finding a subject' },
      el('div', { class: 'media' }),
      el(
        'div',
        { class: 'body' },
        el('div', { class: 'ghost-line' }),
        el('div', { class: 'ghost-line' }),
        el('div', { class: 'ghost-line' }),
        el('div', { class: 'ghost-line' }),
      ),
    ),
  );
}

function renderError() {
  setView('error');
  stage.replaceChildren(
    el(
      'div',
      { class: 'notice' },
      el('h2', { text: "Can't reach Wikipedia" }),
      el('p', { text: 'Check your connection, then try again.' }),
      el('button', { class: 'btn btn--solid', type: 'button', onclick: () => nextRoot(), text: 'Try again' }),
    ),
  );
}

// A fresh random subject, back at the surface.
async function nextRoot() {
  const token = ++state.token;
  state.parent = null;
  state.siblings = [];
  state.fork = null;
  state.busy = false;
  setView('loading');
  setDepth(0);
  paintTrail();
  renderGhost();
  try {
    const subject = await takeRoot();
    if (token !== state.token) {
      state.pool.unshift(subject); // the reader went elsewhere while this loaded
      return;
    }
    showCard(subject);
  } catch {
    if (token === state.token) renderError();
  }
}

/* ---------- the three moves ---------- */

function leave(direction) {
  const card = state.cardEl;
  state.busy = true;
  if (!card) return Promise.resolve();
  const side = direction === 'right' ? 1 : -1;
  card.style.setProperty(direction === 'right' ? '--dig' : '--pass', '1');
  card.style.transition = `transform ${FLY_MS}ms cubic-bezier(.5, 0, .9, .5), opacity ${FLY_MS}ms ease-in`;
  card.getBoundingClientRect(); // commit the starting position before animating
  card.style.transform = `translate(${side * 130}%, 6%) rotate(${side * 16}deg)`;
  card.style.opacity = '0';
  return wait(FLY_MS);
}

// Left: close this subject. Inside a hole the next card is another branch of
// the same parent; at the surface, or once the branches run out, a fresh one.
async function pass() {
  if (state.view !== 'card' || state.busy) return;
  dismissCoach();
  store.pass(state.card.title);
  await leave('left');
  if (state.siblings.length) {
    showCard(state.siblings.shift());
    return;
  }
  if (state.parent && store.nodes[state.parent]) {
    toast(`No more branches under ${store.nodes[state.parent].title}. Back at the surface.`);
  }
  nextRoot();
}

// Right: keep the subject in the tree and choose where to go from it.
async function dig() {
  if (state.view !== 'card' || state.busy) return;
  dismissCoach();
  const node = store.keep(state.card, state.parent);
  paintCount(true);
  const bonus = state.pages.slice(state.page + 1).find((page) => page.kind === 'deep') || null;
  await leave('right');
  openFork(node, bonus);
}

// Up: the next fact about the same subject.
async function more() {
  if (state.view !== 'card' || state.busy || state.waiting) return;
  const subject = state.card;
  if (state.page >= state.pages.length - 1 && !state.deepLoaded) {
    state.waiting = true;
    await state.deep;
    if (state.card !== subject) return;
    state.waiting = false;
    if (state.busy) return;
  }
  if (state.page >= state.pages.length - 1) {
    if (!calm) {
      state.cardEl.animate(
        [{ transform: 'none' }, { transform: 'translateX(-9px)' }, { transform: 'translateX(9px)' }, { transform: 'none' }],
        { duration: 260 },
      );
    }
    return;
  }
  state.page++;
  paintBit('up');
}

function less() {
  if (state.view !== 'card' || state.busy || state.page === 0) return;
  state.page--;
  paintBit('down');
}

/* ---------- the fork: where to go from a kept subject ---------- */

async function openFork(node, bonus = null) {
  const token = ++state.token;
  state.fork = { node, choices: null, at: 0, bonus, failed: false };
  state.card = null;
  state.cardEl = null;
  state.busy = false;
  setView('fork');
  setDepth(store.depthOf(node.id));
  paintTrail();
  renderFork();
  try {
    const choices = await freshBranches(node.title);
    if (token !== state.token) return;
    state.fork.choices = choices;
  } catch {
    if (token !== state.token) return;
    state.fork.failed = true;
  }
  renderFork();
}

function choiceRow(subject) {
  const thumb = subject.thumb
    ? el('img', {
        class: 'choice-thumb',
        src: wiki.smallThumb(subject.thumb),
        alt: '',
        onerror: (event) => {
          const img = event.currentTarget;
          if (img.src !== subject.thumb.src) img.src = subject.thumb.src;
        },
      })
    : el('span', { class: 'choice-thumb', 'aria-hidden': 'true', text: initialOf(subject.title) });
  return el(
    'li',
    null,
    el(
      'button',
      { class: 'choice', type: 'button', onclick: () => choose(subject) },
      thumb,
      el(
        'span',
        null,
        el('span', { class: 'choice-title', text: subject.title }),
        el('span', { class: 'choice-gloss', text: subject.description || subject.extract.slice(0, 160) }),
      ),
    ),
  );
}

function renderFork() {
  const { node, choices, at, bonus, failed } = state.fork;

  let list;
  if (failed) {
    list = el('p', { class: 'fork-note', text: "Couldn't load the branches. Check your connection, then try again." });
  } else if (!choices) {
    list = el(
      'ul',
      { class: 'choices', 'aria-busy': 'true' },
      Array.from({ length: CHOICES_SHOWN }, () =>
        el(
          'li',
          null,
          el(
            'div',
            { class: 'choice choice--ghost' },
            el('span', { class: 'choice-thumb' }),
            el('span', null, el('span', { class: 'ghost-line' }), el('span', { class: 'ghost-line' })),
          ),
        ),
      ),
    );
  } else if (!choices.length) {
    list = el('p', { class: 'fork-note', text: 'No branches left under this subject.' });
  } else {
    list = el('ul', { class: 'choices' }, choices.slice(at, at + CHOICES_SHOWN).map(choiceRow));
  }

  stage.replaceChildren(
    el(
      'section',
      { class: 'fork', 'aria-label': `Branches from ${node.title}` },
      el(
        'div',
        null,
        el('h2', { class: 'fork-title', text: node.title }),
        el('p', { class: 'fork-sub', text: 'In your tree. Pick a branch to go one level deeper.' }),
      ),
      bonus && el('p', { class: 'fork-bonus', text: bonus.text }),
      list,
      el(
        'div',
        { class: 'fork-actions' },
        failed && el('button', { class: 'btn btn--solid', type: 'button', onclick: () => openFork(node, bonus), text: 'Try again' }),
        choices && choices.length > CHOICES_SHOWN && el('button', { class: 'btn', type: 'button', onclick: otherBranches, text: 'Other branches' }),
        el('button', { class: 'btn', type: 'button', onclick: () => nextRoot(), text: 'Start somewhere new' }),
      ),
    ),
  );
}

function otherBranches() {
  const { choices, at } = state.fork;
  state.fork.at = at + CHOICES_SHOWN >= choices.length ? 0 : at + CHOICES_SHOWN;
  renderFork();
}

function choose(subject) {
  const { node, choices } = state.fork;
  state.parent = node.id;
  state.siblings = choices.filter((other) => other !== subject);
  showCard(subject);
}

/* ---------- sheets: the tree and the topic picker ---------- */

let returnFocus = null;

function openSheet(kind) {
  returnFocus = document.activeElement;
  sheetEl.replaceChildren(kind === 'tree' ? treePanel() : topicsPanel());
  sheetEl.hidden = false;
  sheetEl.querySelector('.sheet-close').focus();
}

function closeSheet() {
  sheetEl.hidden = true;
  sheetEl.replaceChildren();
  returnFocus?.focus?.();
}

function panel(title, sub, body, foot) {
  return el(
    'div',
    { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el(
      'div',
      { class: 'sheet-head' },
      el('h2', { text: title }),
      el('button', { class: 'sheet-close', type: 'button', 'aria-label': 'Close', onclick: closeSheet }, icon('M6 6l12 12M18 6L6 18', 18)),
    ),
    sub && el('p', { class: 'sheet-sub', text: sub }),
    el('div', { class: 'sheet-body' }, body),
    foot && el('div', { class: 'sheet-foot' }, foot),
  );
}

function treeNode(node) {
  const children = store.childrenOf(node.id);
  const thumb = node.thumb
    ? el('img', {
        class: 'tree-thumb',
        src: wiki.smallThumb(node.thumb, 120),
        alt: '',
        loading: 'lazy',
        onerror: (event) => {
          const img = event.currentTarget;
          if (img.src !== node.thumb.src) img.src = node.thumb.src;
        },
      })
    : el('span', { class: 'tree-thumb', 'aria-hidden': 'true', text: initialOf(node.title) });
  return el(
    'li',
    { class: 'tree-node' },
    el(
      'button',
      {
        class: 'tree-row',
        type: 'button',
        onclick: () => {
          closeSheet();
          openFork(node);
        },
      },
      thumb,
      el(
        'span',
        null,
        el('span', { class: 'tree-title', text: node.title }),
        node.description && el('span', { class: 'tree-gloss', text: node.description }),
      ),
    ),
    children.length ? el('ul', { class: 'tree tree--kids' }, children.map(treeNode)) : null,
  );
}

function treePanel() {
  const nodes = Object.values(store.nodes);
  if (!nodes.length) {
    return panel(
      'Your tree',
      null,
      el(
        'div',
        { class: 'empty' },
        el('h3', { text: 'Nothing kept yet' }),
        el('p', { text: 'Swipe right on a subject to keep it here. Each one becomes a branch you can come back to.' }),
      ),
    );
  }
  const levels = nodes.reduce((max, node) => Math.max(max, store.depthOf(node.id)), 0) + 1;
  const summary =
    `${nodes.length} ${nodes.length === 1 ? 'subject' : 'subjects'} kept` +
    (levels > 1 ? `, ${levels} levels at the deepest.` : '.') +
    ' Tap one to branch out from it.';
  return panel(
    'Your tree',
    summary,
    el('ul', { class: 'tree tree--root' }, store.roots().map(treeNode)),
    el('button', { class: 'btn', type: 'button', onclick: clearEverything, text: 'Clear tree and history' }),
  );
}

function clearEverything() {
  if (!confirm('Clear your tree and history? This cannot be undone.')) return;
  store.reset();
  state.pool = [];
  state.poolEpoch++;
  closeSheet();
  paintCount();
  nextRoot();
}

function topicsPanel() {
  const enabled = new Set(store.topics || wiki.TOPICS.map((topic) => topic.key));
  const chips = wiki.TOPICS.map((topic) => {
    const chip = el('button', {
      class: 'topic',
      type: 'button',
      'aria-pressed': String(enabled.has(topic.key)),
      text: topic.name,
    });
    chip.addEventListener('click', () => {
      if (enabled.has(topic.key)) {
        if (enabled.size === 1) {
          toast('Keep at least one topic on.');
          return;
        }
        enabled.delete(topic.key);
      } else {
        enabled.add(topic.key);
      }
      chip.setAttribute('aria-pressed', String(enabled.has(topic.key)));
      store.topics = enabled.size === wiki.TOPICS.length ? null : [...enabled];
      state.pool = [];
      state.poolEpoch++;
    });
    return chip;
  });
  return panel(
    'Topics',
    'Fresh subjects come from the topics you leave on. Branches can still lead anywhere.',
    el('div', { class: 'topics' }, chips),
  );
}

/* ---------- wiring ---------- */

document.getElementById('passBtn').addEventListener('click', () => pass());
document.getElementById('moreBtn').addEventListener('click', () => {
  dismissCoach();
  more();
});
document.getElementById('digBtn').addEventListener('click', () => dig());
document.getElementById('treeBtn').addEventListener('click', () => openSheet('tree'));
document.getElementById('topicsBtn').addEventListener('click', () => openSheet('topics'));

sheetEl.addEventListener('click', (event) => {
  if (event.target === sheetEl) closeSheet();
});

// The first touch on the stage only clears the gesture guide.
stage.addEventListener(
  'pointerdown',
  () => {
    if (!dismissCoach()) return;
    state.swallowTap = true;
    setTimeout(() => {
      state.swallowTap = false;
    }, 450);
  },
  true,
);

document.addEventListener('keydown', (event) => {
  if (!sheetEl.hidden) {
    if (event.key === 'Escape') closeSheet();
    return;
  }
  const moves = { ArrowLeft: pass, ArrowRight: dig, ArrowUp: more, ArrowDown: less };
  const move = moves[event.key];
  if (!move || event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  dismissCoach();
  move();
});

function refit() {
  if (state.view === 'card' && state.cardEl) paintBit(null);
}
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(refit, 120);
});
document.fonts?.ready.then(refit);

paintCount();
nextRoot();
