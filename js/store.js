// The reader's tree and history, kept in this browser's localStorage.

const KEY = 'tindegram.v1';
const HISTORY_LIMIT = 3000;

const blank = () => ({ nodes: {}, passed: [], seen: [], topics: null, hinted: false });

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && typeof saved === 'object' && saved.nodes) return { ...blank(), ...saved };
  } catch {
    // Storage can be unavailable (private windows) or hold something unreadable.
  }
  return blank();
}

let data = load();
let passed = new Set(data.passed);
let seen = new Set(data.seen);

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // The session still works without persistence.
  }
}

function remember(list, set, title) {
  if (set.has(title)) return;
  set.add(title);
  list.push(title);
  if (list.length > HISTORY_LIMIT) set.delete(list.shift());
}

export const store = {
  get nodes() {
    return data.nodes;
  },

  // Add a subject to the tree under `parentId` (null for a new root). A subject
  // already in the tree stays where it was first kept.
  keep(subject, parentId) {
    if (!data.nodes[subject.id]) {
      data.nodes[subject.id] = {
        id: subject.id,
        title: subject.title,
        description: subject.description,
        thumb: subject.thumb,
        url: subject.url,
        parent: parentId && data.nodes[parentId] ? parentId : null,
        at: Date.now(),
      };
      save();
    }
    return data.nodes[subject.id];
  },

  pass(title) {
    remember(data.passed, passed, title);
    save();
  },

  markSeen(title) {
    remember(data.seen, seen, title);
    save();
  },

  isKept: (title) => Boolean(data.nodes[title]),
  isPassed: (title) => passed.has(title),
  isSeen: (title) => seen.has(title),
  passedTitles: () => data.passed,

  depthOf(id) {
    let depth = 0;
    let node = data.nodes[id];
    while (node?.parent && data.nodes[node.parent] && depth < 500) {
      depth++;
      node = data.nodes[node.parent];
    }
    return depth;
  },

  // Roots newest first; children in the order they were kept.
  roots() {
    return Object.values(data.nodes)
      .filter((node) => !node.parent)
      .sort((a, b) => b.at - a.at);
  },
  childrenOf(id) {
    return Object.values(data.nodes)
      .filter((node) => node.parent === id)
      .sort((a, b) => a.at - b.at);
  },

  // Enabled topic keys, or null when every topic is on.
  get topics() {
    return data.topics;
  },
  set topics(keys) {
    data.topics = keys;
    save();
  },

  get hinted() {
    return data.hinted;
  },
  set hinted(value) {
    data.hinted = value;
    save();
  },

  reset() {
    const { topics } = data;
    data = { ...blank(), topics, hinted: true };
    passed = new Set();
    seen = new Set();
    save();
  },
};
