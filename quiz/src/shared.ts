// Shared types and pure helpers for HomPub Quiz. Everything here is
// deterministic and side-effect free so it can be unit-tested in isolation.
// The authoritative description of these shapes is ../PROTOCOL.md.

/** Question types (PROTOCOL.md §2). A question without `type` is a single-answer question. */
export type QuestionType = 'single' | 'multi' | 'typein' | 'poll';
export const QUESTION_TYPES: readonly QuestionType[] = ['single', 'multi', 'typein', 'poll'];

/** A picture in the image bucket (PROTOCOL.md §14); `w` and `h` are its pixel size, for layout. */
export interface QuestionImage { key: string; alt: string; w?: number; h?: number }

interface QuestionCommon {
  text: string;
  timeLimit: number; // seconds
  points: number;    // 0 | 1000 | 2000; always 0 for a poll
  explanation?: string;
  image?: QuestionImage;
}

export type Question = QuestionCommon & (
  | { type?: 'single'; options: string[]; correct: number }
  /** `correct`: every right option. `partial`: points for a partly right choice. */
  | { type: 'multi'; options: string[]; correct: number[]; partial: boolean }
  /** `accept`: answers counted right, compared by normalizeAnswer(). */
  | { type: 'typein'; accept: string[] }
  | { type: 'poll'; options: string[] }
);

export interface Quiz {
  title: string;
  questions: Question[];
}

export function questionType(q: { type?: unknown }): QuestionType {
  return q.type === 'multi' || q.type === 'typein' || q.type === 'poll' ? q.type : 'single';
}

/** The options a question shows (none for a typed answer). */
export function optionsOf(q: Question): string[] {
  return 'options' in q && Array.isArray(q.options) ? q.options : [];
}

/** Whether a quiz uses a field a schema-1 page does not know (a new type, an explanation, a picture). */
export function usesSchema2Fields(quiz: { questions?: unknown }): boolean {
  const qs = Array.isArray(quiz.questions) ? quiz.questions : [];
  for (const raw of qs) {
    if (!raw || typeof raw !== 'object') continue;
    const q = raw as Record<string, unknown>;
    if (q.type !== undefined && q.type !== 'single') return true;
    if (q.explanation !== undefined || q.image !== undefined) return true;
  }
  return false;
}

/**
 * The schema a page saves a quiz with: 2 once it uses a new field or text over
 * 200 characters, which a Phase 2 server cannot host. A Phase 2 page opens a
 * schema-2 quiz read-only and keeps it as it is.
 */
export function quizSchema(quiz: { questions?: unknown }): 1 | 2 {
  if (usesSchema2Fields(quiz)) return 2;
  const qs = Array.isArray(quiz.questions) ? quiz.questions : [];
  for (const raw of qs) {
    const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).text : undefined;
    if (typeof t === 'string' && t.length > LIMITS.textCharsV1) return 2;
  }
  return 1;
}

export type Mode = 'speed' | 'accuracy' | 'coarse';
/** Legacy two-way setting, still written so version-1 pages keep working (PROTOCOL.md §2). */
export type NicknameMode = 'free' | 'spin';
/** Who picks the name: typed names only (default), typed or random, or random only. */
export type NameMode = 'typed' | 'either' | 'random';

export interface Settings {
  mode: Mode;
  showOnDevices: boolean;
  lateJoin: boolean;
  earlyClose: boolean;
  nicknameMode: NicknameMode; // always legacyNicknameMode(nameMode)
  nameMode: NameMode;
  allowRename: boolean;       // students may change their own name (switched off at Start)
  focusCheck: boolean;        // phones report leaving the page during a question (PROTOCOL.md §13)
  shuffle: boolean;           // each phone shows the options in its own order (only with showOnDevices)
}

export type Phase = 'lobby' | 'intro' | 'open' | 'closed' | 'podium' | 'ended';

export const DEFAULT_SETTINGS: Settings = {
  mode: 'speed',
  showOnDevices: false,
  lateJoin: true,
  earlyClose: false,
  nicknameMode: 'free',
  nameMode: 'typed',
  allowRename: true,
  focusCheck: false,
  shuffle: false,
};

export function legacyNicknameMode(nameMode: NameMode): NicknameMode {
  return nameMode === 'random' ? 'spin' : 'free';
}

export const TIME_LIMITS = [5, 10, 15, 20, 30, 60, 90, 120, 240];
export const POINT_VALUES = [0, 1000, 2000];
export const PIN_RE = /^[1-9][0-9]{5}$/;

export const LIMITS = {
  quizBytes: 200 * 1024,
  questions: 100,
  titleChars: 80,
  textChars: 400,               // schema 2; a schema-1 quiz keeps to textCharsV1
  textCharsV1: 200,
  optionChars: 80,
  explanationChars: 400,
  acceptAnswers: 10,            // accepted answers of a typed-answer question
  acceptChars: 80,
  typedChars: 80,               // what a student may type as an answer
  altChars: 150,                // a picture's description
  minOptions: 2,
  maxOptions: 4,
  nickChars: 20,
  frameBytes: 4096,
  framesPerSecond: 10,
  frameBurst: 20,
  introMs: 3000,
  graceMs: 1000,
  tallyIntervalMs: 250,
  rosterIntervalMs: 500,
  ttlActiveMs: 2 * 60 * 60 * 1000,
  ttlFinishedMs: 30 * 60 * 1000,
  expiryWarnMs: 15 * 60 * 1000, // the host is warned this long before an idle wipe
  maxRenames: 3,                // student renames per player (re-spins are counted apart)
  socketsPerPlayer: 3,          // open sockets one player token may hold
  pendingHosts: 5,              // host sockets waiting for their auth frame
  hostAuthMs: 10_000,           // a host socket must authenticate within this long
  joinIdMs: 60_000,             // a repeated join id is honoured this long after the join
  awayMinMs: 1000,              // shorter trips away from the page are not counted
  awayMaxTimes: 100,            // Focus check: the most leaves one report may claim
  awayMaxCopies: 1000,          // ...and blocked copies
  awayWrites: 3,                // Focus check rows saved per player per question while it is open
} as const;

/**
 * Cut text to at most `max` (counted by `count`: UTF-16 units by default) at a
 * grapheme boundary, so a vowel sign or virama never loses its letter. A last
 * cluster ending in a virama or a zero-width joiner (half of a conjunct, where
 * the runtime's Unicode data splits conjuncts) is dropped too.
 */
export function cutText(raw: string, max: number, count: (s: string) => number = (s) => s.length): string {
  const s = String(raw);
  if (count(s) <= max) return s;
  let out = '';
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) {
    for (const { segment } of new Seg(undefined, { granularity: 'grapheme' }).segment(s)) {
      if (count(out + segment) > max) break;
      out += segment;
    }
  } else {
    for (const ch of s) { if (count(out + ch) > max) break; out += ch; }
    out = out.replace(/\p{M}+$/u, '');
  }
  return out.replace(/[\u0915-\u0939\u0958-\u095f\u0978-\u097f]?\u094d[\u200c\u200d]?$/u, '').replace(/[\u200c\u200d]+$/u, '');
}

/** Code points, as names are counted. */
export const codePoints = (s: string): number => Array.from(s).length;

// ---------------------------------------------------------------- validation

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

function isPlainString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

export const IMAGE_KEY_RE = /^[0-9a-f]{64}\.(?:webp|jpg|png|gif)$/;

function checkOptions(r: Record<string, unknown>, where: string): Ok<string[]> | Err {
  if (!Array.isArray(r.options) || r.options.length < LIMITS.minOptions || r.options.length > LIMITS.maxOptions) {
    return { ok: false, error: `${where}: options must have ${LIMITS.minOptions}-${LIMITS.maxOptions} entries` };
  }
  const options: string[] = [];
  for (const o of r.options) {
    if (!isPlainString(o, LIMITS.optionChars)) return { ok: false, error: `${where}: each option must be 1-${LIMITS.optionChars} characters` };
    options.push(o.trim());
  }
  return { ok: true, value: options };
}

function isIndex(v: unknown, n: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n;
}

/**
 * Validate an untrusted quiz object from POST /api/room. Returns a cleaned copy
 * holding only the fields the game uses. Schema-1 quizzes (no `type`) come out
 * exactly as before.
 */
export function validateQuiz(input: unknown): Ok<Quiz> | Err {
  if (!input || typeof input !== 'object') return { ok: false, error: 'quiz must be an object' };
  const q = input as Record<string, unknown>;
  if (!isPlainString(q.title, LIMITS.titleChars)) return { ok: false, error: `title must be 1-${LIMITS.titleChars} characters` };
  if (!Array.isArray(q.questions) || q.questions.length < 1 || q.questions.length > LIMITS.questions) {
    return { ok: false, error: `questions must have 1-${LIMITS.questions} entries` };
  }
  const questions: Question[] = [];
  for (let i = 0; i < q.questions.length; i++) {
    const raw = q.questions[i];
    const where = `question ${i + 1}`;
    if (!raw || typeof raw !== 'object') return { ok: false, error: `${where} must be an object` };
    const r = raw as Record<string, unknown>;
    if (r.type !== undefined && !QUESTION_TYPES.includes(r.type as QuestionType)) return { ok: false, error: `${where}: type must be one of ${QUESTION_TYPES.join(', ')}` };
    const type = questionType(r);
    if (!isPlainString(r.text, LIMITS.textChars)) return { ok: false, error: `${where}: text must be 1-${LIMITS.textChars} characters` };
    const timeLimit = typeof r.timeLimit === 'number' ? r.timeLimit : 20;
    if (!TIME_LIMITS.includes(timeLimit)) return { ok: false, error: `${where}: timeLimit must be one of ${TIME_LIMITS.join(', ')}` };
    const points = typeof r.points === 'number' ? r.points : type === 'poll' ? 0 : 1000;
    if (!POINT_VALUES.includes(points)) return { ok: false, error: `${where}: points must be one of ${POINT_VALUES.join(', ')}` };
    if (type === 'poll' && points !== 0) return { ok: false, error: `${where}: a poll gives no points` };

    const common: QuestionCommon = { text: r.text.trim(), timeLimit, points };
    if (r.explanation !== undefined && r.explanation !== '') {
      if (!isPlainString(r.explanation, LIMITS.explanationChars)) return { ok: false, error: `${where}: explanation must be 1-${LIMITS.explanationChars} characters` };
      common.explanation = r.explanation.trim();
    }
    if (r.image !== undefined && r.image !== null) {
      const img = r.image as Record<string, unknown>;
      if (typeof img !== 'object' || typeof img.key !== 'string' || !IMAGE_KEY_RE.test(img.key)) return { ok: false, error: `${where}: image must name a picture saved to this server` };
      if (!isPlainString(img.alt, LIMITS.altChars)) return { ok: false, error: `${where}: the picture needs a description of 1-${LIMITS.altChars} characters` };
      const image: QuestionImage = { key: img.key, alt: img.alt.trim() };
      for (const k of ['w', 'h'] as const) {
        if (img[k] === undefined) continue;
        if (typeof img[k] !== 'number' || !Number.isInteger(img[k]) || (img[k] as number) < 1 || (img[k] as number) > 10000) return { ok: false, error: `${where}: image ${k} must be a whole number of pixels` };
        image[k] = img[k] as number;
      }
      common.image = image;
    }

    if (type === 'typein') {
      if (Array.isArray(r.options) && r.options.length > 0) return { ok: false, error: `${where}: a typed-answer question has no options` };
      if (!Array.isArray(r.accept) || r.accept.length < 1 || r.accept.length > LIMITS.acceptAnswers) {
        return { ok: false, error: `${where}: accept must list 1-${LIMITS.acceptAnswers} answers` };
      }
      const accept: string[] = [];
      const seen = new Set<string>();
      for (const a of r.accept) {
        if (!isPlainString(a, LIMITS.acceptChars) || normalizeAnswer(a) === '') return { ok: false, error: `${where}: each accepted answer must be 1-${LIMITS.acceptChars} characters` };
        const n = normalizeAnswer(a);
        if (seen.has(n)) continue;
        seen.add(n);
        accept.push(a.trim());
      }
      questions.push({ ...common, type, accept });
      continue;
    }

    const opts = checkOptions(r, where);
    if (!opts.ok) return opts;
    const options = opts.value;
    if (type === 'poll') { questions.push({ ...common, type, options }); continue; }
    if (type === 'multi') {
      if (!Array.isArray(r.correct) || r.correct.length < 1 || !r.correct.every((c) => isIndex(c, options.length))) {
        return { ok: false, error: `${where}: correct must list the right options` };
      }
      const correct = [...new Set(r.correct as number[])].sort((a, b) => a - b);
      if (r.partial !== undefined && typeof r.partial !== 'boolean') return { ok: false, error: `${where}: partial must be true or false` };
      questions.push({ ...common, type, options, correct, partial: r.partial === true });
      continue;
    }
    if (!isIndex(r.correct, options.length)) return { ok: false, error: `${where}: correct must index an option` };
    questions.push({ text: common.text, options, correct: r.correct, timeLimit, points, ...(common.explanation ? { explanation: common.explanation } : {}), ...(common.image ? { image: common.image } : {}) });
  }
  return { ok: true, value: { title: q.title.trim(), questions } };
}

/**
 * Merge a partial, untrusted settings object onto `base`. Fields that only
 * make sense before the game starts are ignored unless `inLobby` is true.
 * Unknown fields and wrong types are silently dropped.
 */
export function mergeSettings(base: Settings, patch: unknown, inLobby: boolean): Settings {
  const out: Settings = normalizeSettings(base);
  if (!patch || typeof patch !== 'object') return out;
  const p = patch as Record<string, unknown>;
  if (typeof p.showOnDevices === 'boolean') out.showOnDevices = p.showOnDevices;
  if (typeof p.lateJoin === 'boolean') out.lateJoin = p.lateJoin;
  if (typeof p.allowRename === 'boolean') out.allowRename = p.allowRename;
  if (typeof p.focusCheck === 'boolean') out.focusCheck = p.focusCheck;   // the Room refuses it mid-question
  if (typeof p.shuffle === 'boolean') out.shuffle = p.shuffle;             // takes effect from the next question
  if (inLobby) {
    if (p.mode === 'speed' || p.mode === 'accuracy' || p.mode === 'coarse') out.mode = p.mode;
    if (typeof p.earlyClose === 'boolean') out.earlyClose = p.earlyClose;
    if (p.nameMode === 'typed' || p.nameMode === 'either' || p.nameMode === 'random') out.nameMode = p.nameMode;
    else if (p.nicknameMode === 'spin') out.nameMode = 'random';      // a version-1 host page
    else if (p.nicknameMode === 'free') out.nameMode = 'either';      // (it offered typed or spun names)
  }
  out.nicknameMode = legacyNicknameMode(out.nameMode);
  return out;
}

/**
 * Fill in fields a stored settings object may lack. A room created before
 * nameMode existed had a Spin button next to the name box, so its 'free' means
 * 'either'. A room stored before allowRename existed gets it on only while it is
 * still in the lobby (`phase`), because Start switches it off.
 */
export function normalizeSettings(raw: unknown, phase?: Phase): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (r.mode === 'speed' || r.mode === 'accuracy' || r.mode === 'coarse') out.mode = r.mode;
  if (typeof r.showOnDevices === 'boolean') out.showOnDevices = r.showOnDevices;
  if (typeof r.lateJoin === 'boolean') out.lateJoin = r.lateJoin;
  if (typeof r.earlyClose === 'boolean') out.earlyClose = r.earlyClose;
  if (typeof r.allowRename === 'boolean') out.allowRename = r.allowRename;
  else if (phase !== undefined) out.allowRename = phase === 'lobby';
  if (typeof r.focusCheck === 'boolean') out.focusCheck = r.focusCheck;
  if (typeof r.shuffle === 'boolean') out.shuffle = r.shuffle;
  if (r.nameMode === 'typed' || r.nameMode === 'either' || r.nameMode === 'random') out.nameMode = r.nameMode;
  else if (r.nicknameMode === 'spin') out.nameMode = 'random';
  else if (r.nicknameMode === 'free') out.nameMode = 'either';
  out.nicknameMode = legacyNicknameMode(out.nameMode);
  return out;
}

// ------------------------------------------------------------------- scoring

/**
 * Points for one answer. `elapsedMs` is measured on the server clock from
 * opensAt to the arrival of the answer frame. See PROTOCOL.md §3.
 */
export function scoreAnswer(correct: boolean, elapsedMs: number, timeLimitS: number, points: number, mode: Mode): number {
  if (!correct || points <= 0) return 0;
  if (mode === 'accuracy') return 1;
  const T = timeLimitS * 1000;
  let e = Math.min(Math.max(elapsedMs, 0), T);
  if (mode === 'coarse') e = Math.min(Math.ceil(e / 1000) * 1000, T);
  if (e < 500) return points;
  return Math.round(points * (1 - (e / T) / 2));
}

/**
 * A multi-select answer: right only when exactly the right options are chosen.
 * With partial credit, a partly right choice gets the share (right picks minus
 * wrong picks) / (right options) of what a right answer at that moment would
 * get, never below 0. Accuracy mode counts right answers only, so a partly
 * right choice scores 0 there. scoreAnswer() itself is unchanged.
 */
export function scoreMulti(picked: number[], correct: number[], partial: boolean, elapsedMs: number, timeLimitS: number, points: number, mode: Mode): { points: number; right: boolean } {
  const want = new Set(correct);
  let hits = 0;
  let wrong = 0;
  for (const c of new Set(picked)) { if (want.has(c)) hits += 1; else wrong += 1; }
  const right = wrong === 0 && hits === want.size;
  if (right) return { points: scoreAnswer(true, elapsedMs, timeLimitS, points, mode), right };
  if (!partial || mode === 'accuracy' || want.size === 0) return { points: 0, right };
  const share = (hits - wrong) / want.size;
  if (share <= 0) return { points: 0, right };
  return { points: Math.round(scoreAnswer(true, elapsedMs, timeLimitS, points, mode) * share), right };
}

/**
 * How typed answers are compared: case and Latin accents ignored (so IAST
 * "Kṛṣṇa" matches "Krsna"), spaces collapsed, closing punctuation and
 * surrounding quotes dropped. Only the Combining Diacritical Marks block is
 * removed: Devanagari vowel signs, virama and anusvara are kept, as are
 * leading signs ("-5" is not "5"). Zero-width joiners only shape the text and
 * are ignored.
 */
export function normalizeAnswer(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'\u201c\u201d\u2018\u2019\u00ab\u00bb]+|["'\u201c\u201d\u2018\u2019\u00ab\u00bb]+$/g, '')
    .replace(/[.!?,;:\u0964\u0965]+$/u, '')
    .trim();
}

/** Whether a typed answer matches one of the accepted answers. */
export function typedRight(typed: string, accept: string[]): boolean {
  const t = normalizeAnswer(typed);
  return t !== '' && accept.some((a) => normalizeAnswer(a) === t);
}

/** What a student typed, as stored: control and invisible characters removed, at most typedChars. Null if empty or too long. */
export function cleanTyped(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t === '' || Array.from(t).length > LIMITS.typedChars) return null;
  return t;
}

// --------------------------------------------------------------------- names

export const ADJECTIVES = [
  'Brave', 'Calm', 'Clever', 'Curious', 'Daring', 'Eager', 'Fuzzy', 'Gentle', 'Happy', 'Jolly',
  'Kind', 'Lively', 'Lucky', 'Merry', 'Mighty', 'Nimble', 'Noble', 'Proud', 'Quick', 'Quiet',
  'Rapid', 'Shiny', 'Silly', 'Smart', 'Snappy', 'Sunny', 'Swift', 'Tidy', 'Witty', 'Zesty',
];

export const ANIMALS = [
  'Otter', 'Panda', 'Koala', 'Falcon', 'Dolphin', 'Tiger', 'Rabbit', 'Badger', 'Heron', 'Lynx',
  'Moose', 'Newt', 'Owl', 'Parrot', 'Quokka', 'Robin', 'Seal', 'Toucan', 'Walrus', 'Yak',
  'Zebra', 'Beaver', 'Camel', 'Donkey', 'Eagle', 'Ferret', 'Gecko', 'Hedgehog', 'Iguana', 'Jaguar',
];

export function spinName(): string {
  const a = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const b = ANIMALS[randomInt(ANIMALS.length)];
  return `${a} ${b}`;
}

/**
 * Invisible characters: format characters (soft hyphen, word joiner, zero-width
 * joiners, bidi controls, tags) and other default-ignorable code points such as
 * the Hangul filler. Stripped so the name shown is the name the filter checks.
 * Emoji variation selectors (U+FE0E, U+FE0F) are kept.
 */
const INVISIBLE_RE = /(?![\uFE0E\uFE0F])[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** Trim, strip control and invisible characters, collapse whitespace, cap length. May return ''. */
export function sanitizeNick(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\ufeff]/g, '')
    .replace(INVISIBLE_RE, '')
    .replace(/\s+/g, ' ')
    .replace(/^[=+\-@]+/, '') // a name may not start with a spreadsheet formula trigger
    .trim();
  return cutText(cleaned, LIMITS.nickChars, codePoints).trim();
}

// A short, deliberately conservative deny-list. Hits are never shown to anyone:
// a typed name is refused with "Please choose another name" (a version-1 page
// gets a spun name instead). Matching is on whole words only, after folding
// accents (Dīkṣit → diksit), lower-casing and undoing leetspeak, so names that
// merely contain a listed word pass: Akshit, Dickens, Essex, Hancock, Nazir,
// Scunthorpe, and pairs like "Mohit Lerch" or "Vikas Shole" that the old
// letters-run-together check caught. Single letters in a row are joined first,
// so spacing a word out ("f u c k", "f.u.c.k") does not evade the filter.
// Trade-off: words run together ("fuckface") are no longer caught.
const DENY_TOKENS = new Set([
  'fuck', 'shit', 'cunt', 'bitch', 'asshole', 'bastard', 'dick', 'cock', 'pussy', 'whore', 'slut',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'rape', 'nazi', 'hitler', 'penis', 'vagina', 'wank',
  'twat', 'prick', 'bollock', 'motherfucker', 'douche', 'jerkoff', 'blowjob', 'handjob', 'porn', 'sex',
  'fucker', 'fucking', 'shithead', 'dickhead', 'wanker',
]);

function deleet(text: string): string {
  return text
    .toLowerCase()
    .replace(/[@4]/g, 'a').replace(/[3]/g, 'e').replace(/[1!|]/g, 'i').replace(/[0]/g, 'o').replace(/[5$]/g, 's').replace(/[7]/g, 't');
}

/** Words of a name as the filter sees them: accents folded, leetspeak undone, single letters joined. */
export function nameWords(nick: string): string[] {
  const norm = deleet(nick.normalize('NFD').replace(/\p{M}/gu, '').replace(INVISIBLE_RE, ''));
  const words: string[] = [];
  let run = '';
  for (const w of norm.split(/[^a-z]+/).filter(Boolean)) {
    if (w.length === 1) { run += w; continue; }
    if (run) { words.push(run); run = ''; }
    words.push(w);
  }
  if (run) words.push(run);
  return words;
}

export function isProfane(nick: string): boolean {
  return nameWords(nick).some(w => DENY_TOKENS.has(w));
}

// ------------------------------------------------------------ name choices

export interface NameNote { reason: 'duplicate' | 'stripped' | 'shortened' | 'random'; message: string }

export const NAME_MESSAGES = {
  empty: 'Type your name to join.',
  filtered: 'Please choose another name.',
  random_off: 'Random names are off for this game. Type your name.',
  typed_off: 'This game uses random names only.',
  off: 'Name changes are off right now.',
  limit: `You have used all ${LIMITS.maxRenames} name changes.`,
  same: 'That is already your name.',
  stripped: "Some characters can't be used in names, so they were left out.",
  shortened: `Names can be up to ${LIMITS.nickChars} characters, so yours was shortened.`,
} as const;

function typedNote(raw: unknown, clean: string): NameNote | null {
  const plain = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (plain === clean) return null;
  const chars = Array.from(plain);
  if (chars.length > LIMITS.nickChars && chars.slice(0, LIMITS.nickChars).join('').trim() === clean) {
    return { reason: 'shortened', message: NAME_MESSAGES.shortened };
  }
  return { reason: 'stripped', message: NAME_MESSAGES.stripped };
}

export type JoinName =
  /** replaced: the student typed a name, but this game gives random names only (the phone is told why). */
  | { kind: 'random'; replaced?: boolean }
  | { kind: 'typed'; nick: string; note: NameNote | null }
  | { kind: 'reject'; reason: 'empty' | 'filtered' | 'random_off'; message: string };

/** The name a joining player gets. A name that cannot be used is refused with a reason, never swapped silently. */
export function joinName(i: { nameMode: NameMode; nick: unknown; spin: boolean }): JoinName {
  if (i.nameMode === 'random') return !i.spin && sanitizeNick(i.nick) ? { kind: 'random', replaced: true } : { kind: 'random' };
  if (i.spin) {
    if (i.nameMode === 'typed') return { kind: 'reject', reason: 'random_off', message: NAME_MESSAGES.random_off };
    return { kind: 'random' };
  }
  const nick = sanitizeNick(i.nick);
  if (nick.length === 0) return { kind: 'reject', reason: 'empty', message: NAME_MESSAGES.empty };
  if (isProfane(nick)) return { kind: 'reject', reason: 'filtered', message: NAME_MESSAGES.filtered };
  return { kind: 'typed', nick, note: typedNote(i.nick, nick) };
}

export type RenameCheck =
  | { ok: true; kind: 'random' }
  | { ok: true; kind: 'typed'; nick: string; note: NameNote | null }
  | { ok: false; reason: 'off' | 'limit' | 'empty' | 'filtered' | 'random_off' | 'typed_off' | 'same'; message: string };

/** A student's own rename request (`{t:'rename'}`), before duplicate numbering. */
export function renameCheck(i: { allowRename: boolean; nameMode: NameMode; renames: number; current: string; nick?: unknown; random?: unknown }): RenameCheck {
  const no = (reason: Exclude<RenameCheck, { ok: true }>['reason']): RenameCheck => ({ ok: false, reason, message: NAME_MESSAGES[reason] });
  if (!i.allowRename) return no('off');
  if (i.renames >= LIMITS.maxRenames) return no('limit');
  if (i.random === true) return i.nameMode === 'typed' ? no('random_off') : { ok: true, kind: 'random' };
  if (i.nameMode === 'random') return no('typed_off');
  const nick = sanitizeNick(i.nick);
  if (nick.length === 0) return no('empty');
  if (isProfane(nick)) return no('filtered');
  if (nick.toLowerCase() === i.current.toLowerCase()) return no('same');
  return { ok: true, kind: 'typed', nick, note: typedNote(i.nick, nick) };
}

// --------------------------------------------------------------- idle wipe

/**
 * When an idle room is wiped, and when the host is warned first. Unchanged
 * rules (PROTOCOL.md §6): 2 h after the last frame, or 30 min after `ended`.
 * `scale` shortens every period for local tests only (DEV_TTL_SCALE).
 */
// ------------------------------------------------------------ Focus check

/** What one player did during one question: times they left, ms away, blocked copies. */
export interface AwayRecord { n: number; ms: number; copies: number }

/**
 * Fold a phone's report into what is already recorded. Reports are running
 * totals for the question from that page, so each field only ever goes up (a
 * reloaded page that lost its count cannot lower it), and each is clamped: time
 * away to the question's length plus the grace period, counts to sane maxima.
 * Returns null when the report is not usable at all.
 */
export function mergeAway(prev: AwayRecord | null, report: Record<string, unknown>, timeLimitS: number): AwayRecord | null {
  const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 0), max) : null);
  const n = num(report.n, LIMITS.awayMaxTimes);
  const ms = num(report.ms, timeLimitS * 1000 + LIMITS.graceMs);
  const copies = num(report.copies ?? 0, LIMITS.awayMaxCopies);
  if (n === null || ms === null || copies === null) return null;
  // A leave shorter than the minimum is noise; a report must carry a leave or a blocked copy.
  const left = n > 0 && ms >= LIMITS.awayMinMs;
  if (!left && copies === 0) return null;
  const base = prev ?? { n: 0, ms: 0, copies: 0 };
  return {
    n: Math.max(base.n, left ? n : 0),
    ms: Math.max(base.ms, left ? ms : 0),
    copies: Math.max(base.copies, copies),
  };
}

// ------------------------------------------------------------------ ranks

/**
 * Display ranks with ties: equal scores share the place of the first of them
 * (1, 2, 2, 4), and `tied` says another player has the same score. `sorted`
 * is the strict order (score, then speed, then join time), which the CSV keeps.
 */
export function displayRanks(sorted: { pid: string; score: number }[]): Map<string, { rank: number; tied: boolean }> {
  const out = new Map<string, { rank: number; tied: boolean }>();
  const count = new Map<number, number>();
  for (const p of sorted) count.set(p.score, (count.get(p.score) ?? 0) + 1);
  let rank = 0;
  let prevScore: number | null = null;
  sorted.forEach((p, i) => {
    if (p.score !== prevScore) { rank = i + 1; prevScore = p.score; }
    out.set(p.pid, { rank, tied: (count.get(p.score) ?? 0) > 1 });
  });
  return out;
}

export function idlePlan(i: { phase: Phase; lastActivity: number; phaseAt: number; scale?: number }): { wipeAt: number; warnAt: number | null } {
  const k = i.scale && i.scale > 0 ? i.scale : 1;
  if (i.phase === 'ended') return { wipeAt: i.phaseAt + LIMITS.ttlFinishedMs * k, warnAt: null };
  const wipeAt = i.lastActivity + LIMITS.ttlActiveMs * k;
  return { wipeAt, warnAt: wipeAt - LIMITS.expiryWarnMs * k };
}

/** Has at least one question been played, so an idle wipe would destroy results? */
export function hasResults(phase: Phase, q: number): boolean {
  if (phase === 'lobby' || phase === 'ended') return false;
  return q >= 1 || phase === 'open' || phase === 'closed' || phase === 'podium';
}

// --------------------------------------------------------------------- misc

export function randomInt(n: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

export function letterFor(index: number): string {
  return String.fromCharCode(65 + index);
}

/**
 * Quote a CSV cell. A text cell that starts with = + - @ or a tab/CR would be
 * evaluated as a formula by Excel, Sheets and LibreOffice; prefix it with an
 * apostrophe so it stays text (the OWASP recommendation).
 */
export function csvEscape(v: string | number): string {
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",'\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
