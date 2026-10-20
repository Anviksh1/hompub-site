// Shared types and pure helpers for HomPub Quiz. Everything here is
// deterministic and side-effect free so it can be unit-tested in isolation.
// The authoritative description of these shapes is ../PROTOCOL.md.

export interface Question {
  text: string;
  options: string[];
  correct: number;
  timeLimit: number; // seconds
  points: number;    // 0 | 1000 | 2000
}

export interface Quiz {
  title: string;
  questions: Question[];
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
  textChars: 200,
  optionChars: 80,
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
} as const;

// ---------------------------------------------------------------- validation

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

function isPlainString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

/** Validate an untrusted quiz object from POST /api/room. Returns a cleaned copy. */
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
    if (!isPlainString(r.text, LIMITS.textChars)) return { ok: false, error: `${where}: text must be 1-${LIMITS.textChars} characters` };
    if (!Array.isArray(r.options) || r.options.length < LIMITS.minOptions || r.options.length > LIMITS.maxOptions) {
      return { ok: false, error: `${where}: options must have ${LIMITS.minOptions}-${LIMITS.maxOptions} entries` };
    }
    const options: string[] = [];
    for (const o of r.options) {
      if (!isPlainString(o, LIMITS.optionChars)) return { ok: false, error: `${where}: each option must be 1-${LIMITS.optionChars} characters` };
      options.push(o.trim());
    }
    if (typeof r.correct !== 'number' || !Number.isInteger(r.correct) || r.correct < 0 || r.correct >= options.length) {
      return { ok: false, error: `${where}: correct must index an option` };
    }
    const timeLimit = typeof r.timeLimit === 'number' ? r.timeLimit : 20;
    if (!TIME_LIMITS.includes(timeLimit)) return { ok: false, error: `${where}: timeLimit must be one of ${TIME_LIMITS.join(', ')}` };
    const points = typeof r.points === 'number' ? r.points : 1000;
    if (!POINT_VALUES.includes(points)) return { ok: false, error: `${where}: points must be one of ${POINT_VALUES.join(', ')}` };
    questions.push({ text: r.text.trim(), options, correct: r.correct, timeLimit, points });
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
 * 'either'.
 */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (r.mode === 'speed' || r.mode === 'accuracy' || r.mode === 'coarse') out.mode = r.mode;
  if (typeof r.showOnDevices === 'boolean') out.showOnDevices = r.showOnDevices;
  if (typeof r.lateJoin === 'boolean') out.lateJoin = r.lateJoin;
  if (typeof r.earlyClose === 'boolean') out.earlyClose = r.earlyClose;
  if (typeof r.allowRename === 'boolean') out.allowRename = r.allowRename;
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

/** Trim, strip control characters, collapse whitespace, cap length. May return ''. */
export function sanitizeNick(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[=+\-@]+/, '') // a name may not start with a spreadsheet formula trigger
    .trim();
  return Array.from(cleaned).slice(0, LIMITS.nickChars).join('').trim();
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
  const norm = deleet(nick.normalize('NFD').replace(/\p{M}/gu, ''));
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

export interface NameNote { reason: 'duplicate' | 'stripped' | 'shortened'; message: string }

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
  | { kind: 'random' }
  | { kind: 'typed'; nick: string; note: NameNote | null }
  | { kind: 'reject'; reason: 'empty' | 'filtered' | 'random_off'; message: string };

/**
 * The name a joining player gets. A version-1 page (v2 = false) keeps the old
 * behaviour: its Spin is honoured in every mode, and an empty or filtered name
 * becomes a spun one. A version-2 page is told why instead.
 */
export function joinName(i: { nameMode: NameMode; v2: boolean; nick: unknown; spin: boolean }): JoinName {
  if (i.nameMode === 'random') return { kind: 'random' };
  if (i.spin) {
    if (i.v2 && i.nameMode === 'typed') return { kind: 'reject', reason: 'random_off', message: NAME_MESSAGES.random_off };
    return { kind: 'random' };
  }
  const nick = sanitizeNick(i.nick);
  if (nick.length === 0) return i.v2 ? { kind: 'reject', reason: 'empty', message: NAME_MESSAGES.empty } : { kind: 'random' };
  if (isProfane(nick)) return i.v2 ? { kind: 'reject', reason: 'filtered', message: NAME_MESSAGES.filtered } : { kind: 'random' };
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
