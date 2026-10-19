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
export type NicknameMode = 'free' | 'spin';

export interface Settings {
  mode: Mode;
  showOnDevices: boolean;
  lateJoin: boolean;
  earlyClose: boolean;
  nicknameMode: NicknameMode;
}

export type Phase = 'lobby' | 'intro' | 'open' | 'closed' | 'podium' | 'ended';

export const DEFAULT_SETTINGS: Settings = {
  mode: 'speed',
  showOnDevices: false,
  lateJoin: true,
  earlyClose: false,
  nicknameMode: 'free',
};

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
  const out: Settings = { ...base };
  if (!patch || typeof patch !== 'object') return out;
  const p = patch as Record<string, unknown>;
  if (typeof p.showOnDevices === 'boolean') out.showOnDevices = p.showOnDevices;
  if (typeof p.lateJoin === 'boolean') out.lateJoin = p.lateJoin;
  if (inLobby) {
    if (p.mode === 'speed' || p.mode === 'accuracy' || p.mode === 'coarse') out.mode = p.mode;
    if (typeof p.earlyClose === 'boolean') out.earlyClose = p.earlyClose;
    if (p.nicknameMode === 'free' || p.nicknameMode === 'spin') out.nicknameMode = p.nicknameMode;
  }
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
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, LIMITS.nickChars).join('').trim();
}

// A short, deliberately conservative deny-list. Matching is done on a
// lower-cased, letters-only, de-leeted form so spacing and digits do not
// evade it. Hits are replaced with a spun name, never shown to anyone.
const DENY = [
  'fuck', 'shit', 'cunt', 'bitch', 'asshole', 'bastard', 'dick', 'cock', 'pussy', 'whore', 'slut',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'rape', 'nazi', 'hitler', 'penis', 'vagina', 'wank',
  'twat', 'prick', 'bollock', 'motherfucker', 'douche', 'jerkoff', 'blowjob', 'handjob', 'porn', 'sex',
];

export function isProfane(nick: string): boolean {
  const norm = nick
    .toLowerCase()
    .replace(/[@4]/g, 'a').replace(/[3]/g, 'e').replace(/[1!|]/g, 'i').replace(/[0]/g, 'o').replace(/[5$]/g, 's').replace(/[7]/g, 't')
    .replace(/[^a-z]/g, '');
  return DENY.some(w => norm.includes(w));
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

export function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
