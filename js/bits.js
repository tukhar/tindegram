// Turns Wikipedia plain text into short "bits": a hook for the front of a card
// and a handful of deeper facts, one per article section.

const SKIP_SECTION = /^(see also|references|notes|footnotes|citations|sources|bibliography|further reading|external links|gallery|works cited|explanatory notes|notes and references|discography|filmography|selected works|selected publications|publications|works|awards and nominations|awards|accolades|track listing|personnel|charts|certifications|release history|cast|honours|honors)$/i;

// A sentence that ends in one of these has not really ended.
const ABBREVIATION_END = /(?:\b(?:c|ca|cf|vs|etc|approx|St|Dr|Mr|Mrs|Ms|Prof|Sr|Jr|Mt|Ft|No|Nos|Vol|pp|pl|lit|fl|Gen|Col|Lt|Capt|Sgt|Cmdr|Rev|Hon|Gov|Sen|Rep|Inc|Ltd|Co|Corp|Bros|sp|spp|var|subsp|e\.g|i\.e|U\.S|U\.K|a\.k\.a)\.|(?:^|[\s(])[A-Z]\.)\s*$/;

// Words that tend to show up in the sentence people repeat to a friend.
const SPARK = /\b(first|last|only|largest|smallest|oldest|youngest|longest|shortest|tallest|fastest|slowest|deepest|highest|lowest|heaviest|biggest|rarest|earliest|most|least|record|unique|never|unusual|famous|infamous|notorious|mysterious|mystery|unknown|secret|accident(?:al|ally)?|discover(?:ed|y)|invent(?:ed|ion)|despite|although|surprising(?:ly)?|myth|legend(?:ary)?|controvers\w+|banned|illegal|forbidden|extinct|deadliest|world's|nicknamed?|so-called|named after|believed|thought to|rumou?r\w*|hoax|curse[ds]?|surviv\w+|escape[ds]?|stolen|vanish\w*|disappear\w*|billion|million|thousand|twice|no longer|even though|in fact|paradox\w*|strange|bizarre|remarkabl[ey])\b/gi;

const LEANS_ON_CONTEXT = /^(This|These|Those|However|But|Also|Additionally|Furthermore|Moreover|In addition|Thus|Therefore|Subsequently|Afterwards?|Later|Then|Such|Both|Other|Another|The latter|The former)\b/;
const PRONOUN_START = /^(He|She|It|They|His|Her|Its|Their)\b/;

export function cleanText(text) {
  return text
    .replace(/\s*\((?:[\s,;:]|listen\b)[^()]*\)/g, '') // "(, ok-TOP-ə-də)" left behind by stripped pronunciation
    .replace(/\s*\([A-Z][\w -]{1,24}:\s*\)/g, '') // "(English: )" with its pronunciation stripped
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function segment(text) {
  if (globalThis.Intl?.Segmenter) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return text.match(/[^.!?]+(?:[.!?]+["'”’)\]]*\s*|$)/g) || [text];
}

const count = (text, char) => text.split(char).length - 1;

export function sentences(text) {
  const out = [];
  let buffer = '';
  for (const piece of segment(text)) {
    buffer += piece;
    const trimmed = buffer.trim();
    if (!trimmed) {
      buffer = '';
      continue;
    }
    const unfinished = ABBREVIATION_END.test(trimmed) || count(trimmed, '(') > count(trimmed, ')');
    if (unfinished) continue;
    out.push(trimmed);
    buffer = '';
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

function score(sentence) {
  let value = 0;
  const sparks = sentence.match(SPARK);
  if (sparks) value += Math.min(3, sparks.length) * 1.2;
  if (/\d/.test(sentence)) value += 0.8;
  const length = sentence.length;
  if (length >= 70 && length <= 230) value += 1;
  else if (length > 320) value -= 2;
  else if (length < 45) value -= 2;
  if (LEANS_ON_CONTEXT.test(sentence)) value -= 1.2;
  else if (PRONOUN_START.test(sentence)) value -= 0.3;
  if (/[:;]$/.test(sentence)) value -= 2;
  return value;
}

function clip(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  // Prefer to stop at a clause break, but not at the comma inside "January 27, 1967".
  let cut = -1;
  for (const match of head.matchAll(/[,;:] (?=\D)| [–—] /g)) cut = match.index;
  const end = cut > max * 0.55 ? cut : head.lastIndexOf(' ');
  return head.slice(0, end).replace(/[,;:\s–—-]+$/, '') + '…';
}

function bestChunk(list, taken, floor) {
  let best = floor;
  let at = -1;
  list.forEach((sentence, i) => {
    if (taken.has(i)) return;
    const value = score(sentence) - i * 0.06; // earlier sentences set up later ones
    if (value > best) {
      best = value;
      at = i;
    }
  });
  if (at < 0) return null;
  taken.add(at);
  let text = list[at];
  const next = list[at + 1];
  if (text.length < 150 && next && !taken.has(at + 1) && text.length + next.length < 300) {
    text += ' ' + next;
    taken.add(at + 1);
  }
  return { text: clip(text, 320), score: best };
}

// Opening sentences often carry a bracket of native spellings and
// transliterations: "(Greek: Θεόδωρος Δούκας Λάσκαρις, romanized: ...; 1221 –
// 1258)". Keep the parts a reader can use (the dates) and drop the rest.
const NATIVE_NAME = /\b(romani[sz]ed|pronounced|pronunciation|translit\w*|lit\.|literally|IPA)\b|^[A-Z][\w-]+( [A-Z]?[\w-]+)?: /;
const NON_LATIN = /[^\u0000-ɏ -⁯]/;

function tidyLead(sentence) {
  return sentence.replace(/\s*\(([^()]{12,})\)/g, (whole, inner) => {
    const parts = inner.split(/;\s*/);
    const kept = parts.filter((part) => !NATIVE_NAME.test(part) && !NON_LATIN.test(part));
    if (kept.length === parts.length) return whole;
    return kept.length ? ` (${kept.join('; ')})` : '';
  });
}

// The front of the card: the opening sentence, plus the most striking other
// sentence of the introduction when there is one worth showing.
export function hookBits(extract) {
  const paragraphs = extract.split(/\n+/).map(cleanText).filter(Boolean);
  const list = sentences(paragraphs.join(' '));
  const lead = clip(tidyLead(list[0] || paragraphs[0] || ''), 250);
  let extra = null;
  let best = 1.6;
  for (let i = 1; i < Math.min(list.length, 12); i++) {
    const sentence = list[i];
    if (sentence.length > 200 || sentence.length < 50) continue;
    const value = score(sentence);
    if (value > best) {
      best = value;
      extra = sentence;
    }
  }
  return { lead, extra };
}

// Deeper pages: up to two more from the introduction, then the best chunk of
// each of the six most promising sections, in article order.
export function deepBits(fullText, alreadyShown) {
  const sections = [{ title: null, paragraphs: [] }];
  for (const line of fullText.split('\n')) {
    const heading = line.match(/^(={2,6})\s*(.+?)\s*\1\s*$/);
    if (heading) {
      if (heading[1].length === 2) sections.push({ title: heading[2], paragraphs: [] });
      continue;
    }
    const paragraph = cleanText(line);
    if (paragraph.length >= 60) sections[sections.length - 1].paragraphs.push(paragraph);
  }

  const bits = [];

  const intro = sentences(sections[0].paragraphs.join(' '))
    .slice(1, 14)
    .filter((sentence) => sentence !== alreadyShown);
  const taken = new Set();
  for (let round = 0; round < 2; round++) {
    const chunk = bestChunk(intro, taken, round === 0 ? -Infinity : 1.2);
    if (!chunk) break;
    bits.push({ label: null, text: chunk.text });
  }

  const candidates = [];
  sections.slice(1).forEach((section, order) => {
    if (SKIP_SECTION.test(section.title) || !section.paragraphs.length) return;
    const list = sentences(section.paragraphs.slice(0, 5).join(' ')).slice(0, 16);
    const chunk = bestChunk(list, new Set(), -Infinity);
    if (chunk) candidates.push({ label: section.title, text: chunk.text, score: chunk.score, order });
  });
  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates.slice(0, 6).sort((a, b) => a.order - b.order);
  for (const { label, text } of chosen) bits.push({ label, text });

  return bits;
}
