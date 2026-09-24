'use strict';

/* HomPub Routine — everything lives in this browser's localStorage.
   Nothing is sent anywhere. */

const STORE_KEY = 'hompub-routine-v1';
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const REMINDER_WINDOW_MIN = 10; // still fire a reminder if we're at most this late past the start

const STARTER_ROUTINE = [
  { title: 'Wake up & drink water', time: '06:30', duration: 10, days: [0, 1, 2, 3, 4, 5, 6], lead: 0 },
  { title: 'Stretch or morning walk', time: '06:45', duration: 20, days: [0, 1, 2, 3, 4, 5, 6], lead: 5 },
  { title: 'Breakfast', time: '07:30', duration: 20, days: [0, 1, 2, 3, 4, 5, 6], lead: 5 },
  { title: 'Plan the day', time: '08:00', duration: 10, days: [1, 2, 3, 4, 5], lead: 0, note: 'Pick your top 3 for today' },
  { title: 'Deep work', time: '09:00', duration: 120, days: [1, 2, 3, 4, 5], lead: 5 },
  { title: 'Lunch & a short break', time: '13:00', duration: 45, days: [0, 1, 2, 3, 4, 5, 6], lead: 5 },
  { title: 'Exercise', time: '18:00', duration: 45, days: [1, 3, 5], lead: 15 },
  { title: 'Dinner', time: '19:30', duration: 30, days: [0, 1, 2, 3, 4, 5, 6], lead: 10 },
  { title: 'Screens off, wind down', time: '22:00', duration: 30, days: [0, 1, 2, 3, 4, 5, 6], lead: 10, note: 'Read, journal, or stretch' },
  { title: 'Sleep', time: '22:30', duration: 480, days: [0, 1, 2, 3, 4, 5, 6], lead: 0 }
];

/* ---------- state ---------- */

function freshState() {
  return { v: 1, routine: [], events: [], done: {}, fired: {}, settings: { sound: true } };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return sanitizeState(JSON.parse(raw));
  } catch (e) { /* storage blocked or corrupt — start fresh */ }
  return freshState();
}

function sanitizeState(s) {
  const out = freshState();
  if (!s || typeof s !== 'object') return out;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
  const time = v => (/^\d{2}:\d{2}$/.test(v) ? v : '07:00');
  const base = x => ({
    id: str(x.id, 40) || uid(),
    title: str(x.title, 80) || 'Untitled',
    time: time(x.time),
    duration: num(x.duration, 1, 1440, 30),
    lead: num(x.lead, -1, 1440, 5),
    note: str(x.note, 140)
  });
  if (Array.isArray(s.routine)) {
    out.routine = s.routine.filter(x => x && typeof x === 'object').map(x => Object.assign(base(x), {
      days: Array.isArray(x.days) ? [...new Set(x.days.map(Number).filter(d => d >= 0 && d <= 6))].sort() : [0, 1, 2, 3, 4, 5, 6],
      created: /^\d{4}-\d{2}-\d{2}$/.test(x.created) ? x.created : '2000-01-01'
    }));
  }
  if (Array.isArray(s.events)) {
    out.events = s.events.filter(x => x && typeof x === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(x.date))
      .map(x => Object.assign(base(x), { date: x.date }));
  }
  if (s.done && typeof s.done === 'object') {
    for (const [k, v] of Object.entries(s.done)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Array.isArray(v)) out.done[k] = v.filter(i => typeof i === 'string');
    }
  }
  if (s.fired && typeof s.fired === 'object') out.fired = s.fired;
  if (s.settings && typeof s.settings === 'object') out.settings.sound = s.settings.sound !== false;
  return out;
}

let state = loadState();

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('Couldn’t save', 'Your browser is blocking storage for this page, so changes won’t survive a reload.');
  }
}

/* ---------- helpers ---------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
const pad = n => String(n).padStart(2, '0');
function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(k, n) { const d = fromKey(k); d.setDate(d.getDate() + n); return dateKey(d); }
function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function nowMin(d = new Date()) { return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; }
function todayKey() { return dateKey(new Date()); }

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
function fmtTime(min) {
  const d = new Date(2000, 0, 1, Math.floor(min / 60) % 24, Math.round(min % 60));
  return timeFmt.format(d).replace(/\s?([AP])\.?M\.?/i, (_, a) => a.toLowerCase() + 'm');
}
function fmtDur(min) {
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : (h === 1 ? '1 hour' : h + ' hours');
}
function fmtIn(min) {
  min = Math.max(0, Math.round(min));
  if (min < 1) return 'now';
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function fmtLead(lead) {
  if (lead < 0) return 'No reminder';
  if (lead === 0) return 'At start';
  return fmtDur(lead) + ' before';
}
function fmtDayLong(k) {
  return fromKey(k).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
function relDay(k) {
  const t = todayKey();
  if (k === t) return 'Today';
  if (k === addDays(t, 1)) return 'Tomorrow';
  if (k === addDays(t, -1)) return 'Yesterday';
  return null;
}
function daysLabel(days) {
  const s = days.join('');
  if (s === '0123456') return 'Every day';
  if (s === '12345') return 'Weekdays';
  if (s === '06') return 'Weekends';
  if (!days.length) return 'Never';
  return days.map(d => DAY_SHORT[d]).join(', ');
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
};

/* ---------- schedule model ---------- */

// Everything that happens on a given day, routine steps and one-off events together.
function itemsFor(k) {
  const dow = fromKey(k).getDay();
  const out = [];
  for (const r of state.routine) {
    // Routine steps don't reach back before the day they were added, so they
    // can't retroactively break a streak.
    if (r.days.includes(dow) && r.created <= k) out.push(occurrence(r, 'routine'));
  }
  for (const e of state.events) {
    if (e.date === k) out.push(occurrence(e, 'event'));
  }
  return out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}
function occurrence(x, kind) {
  const start = toMin(x.time);
  return { id: x.id, kind, title: x.title, note: x.note, start, end: start + x.duration, duration: x.duration, lead: x.lead };
}
function doneSet(k) { return new Set(state.done[k] || []); }

function toggleDone(k, id) {
  const set = doneSet(k);
  set.has(id) ? set.delete(id) : set.add(id);
  if (set.size) state.done[k] = [...set]; else delete state.done[k];
  save();
}

function streak() {
  let n = 0;
  let k = todayKey();
  for (let i = 0; i < 1000; i++) {
    const items = itemsFor(k).filter(x => x.kind === 'routine');
    if (items.length) {
      const done = doneSet(k);
      if (items.every(x => done.has(x.id))) n++;
      else if (i > 0) break; // today not finished yet doesn't break the streak
    } else if (!state.routine.some(r => r.created <= k)) {
      break; // before the routine existed
    }
    k = addDays(k, -1);
  }
  return n;
}

/* ---------- views ---------- */

const main = document.getElementById('main');
const fab = document.getElementById('fab');
let view = 'today';
let viewDay = todayKey();

function setView(v, focus) {
  view = v;
  document.querySelectorAll('.tab').forEach(t => {
    if (t.dataset.view === v) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  try { sessionStorage.setItem('hompub-routine-view', v); } catch (e) {}
  render();
  if (focus) main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function render() {
  fab.hidden = view === 'settings';
  fab.setAttribute('aria-label', view === 'schedule' ? 'Add event' : 'Add routine step');
  if (view === 'today') renderToday();
  else if (view === 'routine') renderRoutine();
  else if (view === 'schedule') renderSchedule();
  else renderSettings();
}

function notifBanner() {
  if (!('Notification' in window) || Notification.permission !== 'default') return '';
  if (!state.routine.length && !state.events.length) return '';
  return `<div class="banner"><span>Turn on notifications so reminders reach you even when this tab is in the background.</span>
    <button class="btn small primary" data-action="enable-notifs">Turn on</button></div>`;
}

function renderToday() {
  const k = viewDay;
  const tk = todayKey();
  const isToday = k === tk;
  const items = itemsFor(k);
  const done = doneSet(k);
  const now = nowMin();
  const doneCount = items.filter(i => done.has(i.id)).length;
  const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0;
  const C = 2 * Math.PI * 32;
  const rel = relDay(k);
  const st = streak();

  let html = notifBanner();
  html += `<div class="view-head">
    <div>
      <h1>${esc(rel || fromKey(k).toLocaleDateString(undefined, { weekday: 'long' }))}</h1>
      <p class="sub">${esc(fmtDayLong(k))}</p>
    </div>
    <div class="day-nav">
      <button class="icon-btn" data-action="day" data-n="-1" aria-label="Previous day">${ICON.left}</button>
      ${isToday ? '' : '<button class="btn small" data-action="day" data-n="0">Today</button>'}
      <button class="icon-btn" data-action="day" data-n="1" aria-label="Next day">${ICON.right}</button>
    </div>
  </div>`;

  if (!items.length) {
    const noRoutine = !state.routine.length;
    html += `<div class="card empty">
      <h2>${noRoutine ? 'Build your daily routine' : 'Nothing planned'}</h2>
      <p>${noRoutine
        ? 'Add the things you do every day — wake up, workouts, meals, focus time — and you’ll get a reminder before each one.'
        : 'No routine steps or events on this day.'}</p>
      <div class="actions">
        ${noRoutine ? '<button class="btn primary" data-action="starter">Start with a sample routine</button>' : ''}
        <button class="btn${noRoutine ? '' : ' primary'}" data-action="add-routine">Add a routine step</button>
        <button class="btn" data-action="add-event">Add an event</button>
      </div>
    </div>`;
    main.innerHTML = html;
    return;
  }

  const stats = [];
  if (st > 0) stats.push(`<span class="stat good">${st}-day streak</span>`);
  const remaining = items.filter(i => !done.has(i.id) && (!isToday || i.end > now)).length;
  if (isToday && remaining) stats.push(`<span class="stat">${remaining} still ahead</span>`);

  html += `<div class="card summary">
    <div class="ring${pct === 100 ? ' complete' : ''}" role="img" aria-label="${pct}% done">
      <svg viewBox="0 0 76 76"><circle class="track" cx="38" cy="38" r="32"/>
        <circle class="fill" cx="38" cy="38" r="32" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/></svg>
      <span class="pct">${pct}%</span>
    </div>
    <div>
      <h2>${pct === 100 ? 'All done. Nice work.' : `${doneCount} of ${items.length} done`}</h2>
      <p>${isToday ? 'Tap the circle on each step when you finish it.' : k < tk ? 'Looking back.' : 'Looking ahead.'}</p>
      ${stats.length ? `<div class="stats">${stats.join('')}</div>` : ''}
    </div>
  </div>`;

  if (isToday) {
    const current = items.find(i => i.start <= now && now < i.end && !done.has(i.id));
    const next = items.find(i => i.start > now && !done.has(i.id));
    if (current || next) {
      html += '<div class="card now-card">';
      if (current) {
        const p = Math.min(100, ((now - current.start) / current.duration) * 100);
        html += `<div class="now-row"><span class="tag">Now</span><span class="what">${esc(current.title)}</span>
          <span class="when">${fmtIn(current.end - now)} left</span></div>
          <div class="bar" aria-hidden="true"><span style="width:${p.toFixed(1)}%"></span></div>`;
      }
      if (next) {
        html += `<div class="now-row"><span class="tag">Next</span><span class="what">${esc(next.title)}</span>
          <span class="when">${fmtTime(next.start)} · in ${fmtIn(next.start - now)}</span></div>`;
      }
      html += '</div>';
    }
  }

  html += '<p class="section-label">Timeline</p><ol class="timeline">';
  let nowDrawn = !isToday;
  for (const it of items) {
    if (!nowDrawn && it.start > now) {
      html += nowLine(now);
      nowDrawn = true;
    }
    const isDone = done.has(it.id);
    const cls = ['t-item'];
    if (isDone) cls.push('done');
    else if (isToday && it.start <= now && now < it.end) cls.push('current');
    else if ((isToday && it.end <= now) || k < tk) cls.push('missed');
    const meta = [`<span class="kind${it.kind === 'event' ? ' event' : ''}">${it.kind}</span>`, fmtDur(it.duration)];
    if (it.lead >= 0) meta.push('🔔 ' + fmtLead(it.lead).toLowerCase());
    html += `<li class="${cls.join(' ')}">
      <span class="t-time">${fmtTime(it.start)}</span>
      <span class="t-dot" aria-hidden="true"></span>
      <button class="t-body" data-action="edit" data-kind="${it.kind}" data-id="${esc(it.id)}">
        <div class="t-title">${esc(it.title)}</div>
        <div class="t-meta">${meta.join('<span aria-hidden="true">·</span>')}</div>
        ${it.note ? `<div class="t-note">${esc(it.note)}</div>` : ''}
      </button>
      <button class="check" data-action="toggle" data-id="${esc(it.id)}" aria-pressed="${isDone}"
        aria-label="${isDone ? 'Mark not done' : 'Mark done'}: ${esc(it.title)}">${ICON.check}</button>
    </li>`;
  }
  if (!nowDrawn) html += nowLine(now);
  html += '</ol>';
  main.innerHTML = html;
}

function nowLine(now) {
  return `<li class="now-line" aria-label="Current time"><span class="t-time">${fmtTime(now)}</span><span class="pip"></span><span class="rule"></span></li>`;
}

function renderRoutine() {
  const items = [...state.routine].sort((a, b) => toMin(a.time) - toMin(b.time));
  let html = `<div class="view-head"><div><h1>Your routine</h1>
    <p class="sub">Steps that repeat every week. Each one shows up on the days you pick.</p></div></div>`;

  if (!items.length) {
    html += `<div class="card empty">
      <h2>No routine yet</h2>
      <p>Start from a sensible sample day and edit it to fit you, or build your own step by step.</p>
      <div class="actions">
        <button class="btn primary" data-action="starter">Use the sample routine</button>
        <button class="btn" data-action="add-routine">Add a step</button>
      </div></div>`;
    main.innerHTML = html;
    return;
  }

  const totalDaily = items.filter(r => r.days.length === 7).reduce((s, r) => s + r.duration, 0);
  html += `<p class="section-label">${items.length} step${items.length === 1 ? '' : 's'}${totalDaily ? ` · ${fmtDur(totalDaily)} of it every day` : ''}</p><ul class="list">`;
  for (const r of items) {
    const start = toMin(r.time);
    html += `<li><button class="row" data-action="edit" data-kind="routine" data-id="${esc(r.id)}">
      <span class="r-time">${fmtTime(start)}<small>${fmtDur(r.duration)}</small></span>
      <span>
        <span class="r-title">${esc(r.title)}</span>
        <span class="r-sub"> · ${esc(daysLabel(r.days))} · ${r.lead >= 0 ? '🔔 ' + esc(fmtLead(r.lead).toLowerCase()) : 'no reminder'}</span>
        <span class="days" aria-hidden="true">${DAY_LETTER.map((l, i) => `<span class="${r.days.includes(i) ? 'on' : ''}">${l}</span>`).join('')}</span>
      </span>
      <span class="chev">${ICON.chev}</span>
    </button></li>`;
  }
  html += '</ul>';
  main.innerHTML = html;
}

function renderSchedule() {
  const tk = todayKey();
  const now = nowMin();
  const sorted = [...state.events].sort((a, b) => a.date.localeCompare(b.date) || toMin(a.time) - toMin(b.time));
  const isPast = e => e.date < tk || (e.date === tk && toMin(e.time) + e.duration <= now);
  const upcoming = sorted.filter(e => !isPast(e));
  const past = sorted.filter(isPast).reverse();

  let html = notifBanner();
  html += `<div class="view-head"><div><h1>Schedule</h1>
    <p class="sub">One-off appointments, meetings and deadlines.</p></div></div>`;

  if (!sorted.length) {
    html += `<div class="card empty"><h2>Nothing scheduled</h2>
      <p>Add appointments and plans with a date and time — they’ll appear on that day’s timeline, with a reminder.</p>
      <div class="actions"><button class="btn primary" data-action="add-event">Add an event</button></div></div>`;
    main.innerHTML = html;
    return;
  }

  const group = (list, pastList) => {
    let out = '';
    let lastDate = null;
    for (const e of list) {
      if (e.date !== lastDate) {
        if (lastDate !== null) out += '</ul>';
        const rel = relDay(e.date);
        out += `<p class="section-label">${esc(rel ? rel + ' · ' : '')}${esc(fmtDayLong(e.date))}</p><ul class="list">`;
        lastDate = e.date;
      }
      const start = toMin(e.time);
      const done = doneSet(e.date).has(e.id);
      out += `<li><button class="row${pastList ? ' past' : ''}" data-action="edit" data-kind="event" data-id="${esc(e.id)}">
        <span class="r-time">${fmtTime(start)}<small>${fmtDur(e.duration)}</small></span>
        <span><span class="r-title">${esc(e.title)}</span>
          <span class="r-sub"> · ${done ? 'done' : e.lead >= 0 ? '🔔 ' + esc(fmtLead(e.lead).toLowerCase()) : 'no reminder'}</span>
          ${e.note ? `<br><span class="r-sub">${esc(e.note)}</span>` : ''}</span>
        <span class="chev">${ICON.chev}</span>
      </button></li>`;
    }
    if (lastDate !== null) out += '</ul>';
    return out;
  };

  html += upcoming.length ? group(upcoming, false) : '<div class="card empty"><p>No upcoming events.</p></div>';
  if (past.length) {
    html += `<details style="margin-top:26px"><summary class="section-label" style="cursor:pointer;display:list-item">Past (${past.length})</summary>
      ${group(past.slice(0, 50), true)}
      <p style="margin-top:14px"><button class="btn small danger" data-action="clear-past">Delete past events</button></p></details>`;
  }
  main.innerHTML = html;
}

function renderSettings() {
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  const permLabel = { granted: ['on', 'On'], denied: ['off', 'Blocked'], default: ['', 'Off'], unsupported: ['off', 'Not supported'] }[perm];
  let permHelp = 'Pop-up notifications from your browser, even when this tab isn’t in front.';
  if (perm === 'denied') permHelp = 'Your browser is blocking notifications for this site. Allow them in the site settings (the icon left of the address bar), then reload.';
  if (perm === 'unsupported') permHelp = 'This browser can’t show notifications. On iPhone, add this page to your Home Screen first (Share → Add to Home Screen). In-app alerts and sound still work.';

  main.innerHTML = `<div class="view-head"><div><h1>Reminders</h1>
    <p class="sub">How and when you get nudged.</p></div></div>

  <div class="card">
    <div class="setting">
      <div><h3>Notifications <span class="status ${permLabel[0]}">${permLabel[1]}</span></h3><p>${permHelp}</p></div>
      ${perm === 'default' ? '<button class="btn primary" data-action="enable-notifs">Turn on</button>' : ''}
    </div>
    <div class="setting">
      <div><h3>Chime</h3><p>Play a short sound with each reminder while the page is open.</p></div>
      <label class="switch"><input type="checkbox" data-action="sound" ${state.settings.sound ? 'checked' : ''} aria-label="Chime"><span></span></label>
    </div>
    <div class="setting">
      <div><h3>Try it</h3><p>Send a test reminder right now.</p></div>
      <button class="btn" data-action="test">Test reminder</button>
    </div>
  </div>

  <p class="section-label">How reminders work</p>
  <div class="card fine">
    Reminders are checked by this page, on your device. To make sure they fire:
    <ul>
      <li><strong>Keep the page open</strong> — a pinned tab or a background tab is fine.</li>
      <li><strong>Install it</strong> as an app (browser menu → “Install app” or “Add to Home Screen”) so it’s one tap away and works offline.</li>
      <li>If your computer sleeps or the browser is closed, reminders missed by more than ${REMINDER_WINDOW_MIN} minutes are skipped rather than arriving late.</li>
    </ul>
  </div>

  <p class="section-label">Your data</p>
  <div class="card">
    <div class="setting">
      <div><h3>Back up</h3><p>Download your routine, schedule and history as a file — use it to move to another device.</p></div>
      <div class="btn-group">
        <button class="btn" data-action="export">Export</button>
        <button class="btn" data-action="import">Import</button>
      </div>
    </div>
    <div class="setting">
      <div><h3>Privacy</h3><p>Everything is stored only in this browser. There’s no account, no server, and no analytics — clearing your browser data erases it, so export a backup now and then.</p></div>
    </div>
    <div class="setting">
      <div><h3>Start over</h3><p>Delete your routine, events and history from this browser.</p></div>
      <button class="btn danger" data-action="reset">Erase all</button>
    </div>
  </div>
  <input type="file" id="import-file" accept="application/json,.json" hidden>`;
}

/* ---------- editor dialog ---------- */

const dlg = document.getElementById('editor');
const form = document.getElementById('editor-form');
const dayPicker = document.getElementById('day-picker');
const formError = document.getElementById('form-error');
const deleteBtn = document.getElementById('delete-btn');
let editing = null; // { kind, id|null }

dayPicker.innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d =>
  `<label><input type="checkbox" name="day" value="${d}" aria-label="${DAY_SHORT[d]}"><span>${DAY_SHORT[d].slice(0, 2)}</span></label>`
).join('');

function openEditor(kind, id) {
  const list = kind === 'routine' ? state.routine : state.events;
  const item = id ? list.find(x => x.id === id) : null;
  editing = { kind, id: item ? item.id : null };
  form.reset();
  formError.hidden = true;
  document.getElementById('editor-title').textContent =
    (item ? 'Edit ' : 'New ') + (kind === 'routine' ? 'routine step' : 'event');
  form.querySelectorAll('[data-for]').forEach(el => { el.hidden = el.dataset.for !== kind; });
  deleteBtn.hidden = !item;

  const src = item || {
    title: '', time: suggestTime(), duration: 30, lead: 5, note: '',
    days: [0, 1, 2, 3, 4, 5, 6], date: view === 'today' && viewDay >= todayKey() ? viewDay : todayKey()
  };
  form.title.value = src.title;
  form.time.value = src.time;
  setSelect(form.duration, src.duration);
  setSelect(form.lead, src.lead);
  form.note.value = src.note || '';
  if (kind === 'routine') setDays(src.days);
  else form.date.value = src.date;

  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  form.title.focus();
}

// Pick a sensible default start: the next half hour for events, just after the last step for routine.
function suggestTime() {
  const n = new Date();
  let m = Math.ceil((n.getHours() * 60 + n.getMinutes() + 1) / 30) * 30;
  if (m >= 1440) m = 9 * 60;
  return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
}

function setSelect(sel, value) {
  const v = String(value);
  if (![...sel.options].some(o => o.value === v)) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = sel.name === 'lead' ? fmtLead(+v) : fmtDur(+v);
    sel.appendChild(o);
  }
  sel.value = v;
}

function setDays(days) {
  form.querySelectorAll('input[name="day"]').forEach(cb => { cb.checked = days.includes(+cb.value); });
}

function closeEditor() {
  if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  editing = null;
}

form.addEventListener('submit', ev => {
  ev.preventDefault();
  if (!editing) return;
  const title = form.title.value.trim();
  const time = form.time.value;
  const err = msg => { formError.textContent = msg; formError.hidden = false; };
  if (!title) return err('Give it a name.');
  if (!/^\d{2}:\d{2}$/.test(time)) return err('Pick a start time.');
  const data = {
    title, time,
    duration: +form.duration.value,
    lead: +form.lead.value,
    note: form.note.value.trim()
  };
  if (editing.kind === 'routine') {
    data.days = [...form.querySelectorAll('input[name="day"]:checked')].map(cb => +cb.value).sort();
    if (!data.days.length) return err('Pick at least one day.');
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date.value)) return err('Pick a date.');
    data.date = form.date.value;
  }

  const list = editing.kind === 'routine' ? state.routine : state.events;
  if (editing.id) {
    const item = list.find(x => x.id === editing.id);
    Object.assign(item, data);
    clearFired(item.id); // time or reminder may have changed — let it fire again
  } else {
    const item = Object.assign({ id: uid() }, data);
    if (editing.kind === 'routine') item.created = todayKey();
    list.push(item);
  }
  save();
  const kind = editing.kind;
  closeEditor();
  render();
  toast(kind === 'routine' ? 'Routine saved' : 'Event saved');
  checkReminders();
});

deleteBtn.addEventListener('click', () => {
  if (!editing || !editing.id) return;
  const key = editing.kind === 'routine' ? 'routine' : 'events';
  const item = state[key].find(x => x.id === editing.id);
  if (!item || !confirm(`Delete “${item.title}”?`)) return;
  state[key] = state[key].filter(x => x.id !== editing.id);
  save();
  closeEditor();
  render();
  toast('Deleted', null, [{ label: 'Undo', run: () => { state[key].push(item); save(); render(); } }]);
});

document.getElementById('cancel-btn').addEventListener('click', closeEditor);
dlg.addEventListener('close', () => { editing = null; });
dlg.addEventListener('click', ev => { if (ev.target === dlg) closeEditor(); }); // click on backdrop

form.querySelector('.day-presets').addEventListener('click', ev => {
  const p = ev.target.dataset.preset;
  if (p) setDays({ all: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] }[p]);
});

/* ---------- actions ---------- */

document.querySelector('.tabs').addEventListener('click', ev => {
  const t = ev.target.closest('.tab');
  if (t) setView(t.dataset.view, true);
});

fab.addEventListener('click', () => { unlockAudio(); openEditor(view === 'schedule' ? 'event' : 'routine'); });

main.addEventListener('click', ev => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  unlockAudio();
  const a = el.dataset.action;
  if (a === 'toggle') {
    toggleDone(viewDay, el.dataset.id);
    render();
  } else if (a === 'edit') {
    openEditor(el.dataset.kind, el.dataset.id);
  } else if (a === 'day') {
    const n = +el.dataset.n;
    viewDay = n === 0 ? todayKey() : addDays(viewDay, n);
    render();
  } else if (a === 'add-routine') {
    openEditor('routine');
  } else if (a === 'add-event') {
    openEditor('event');
  } else if (a === 'starter') {
    const created = todayKey();
    state.routine.push(...STARTER_ROUTINE.map(s => Object.assign({ id: uid(), note: '', created }, s)));
    save();
    render();
    toast('Sample routine added', 'Tap any step to change its time, days or reminder.');
  } else if (a === 'enable-notifs') {
    requestNotifs();
  } else if (a === 'test') {
    fireReminder({ title: 'Test reminder', note: 'This is what your reminders will look like.', start: nowMin(), lead: 0, kind: 'test' }, 'test-' + Date.now());
  } else if (a === 'export') {
    exportData();
  } else if (a === 'import') {
    document.getElementById('import-file').click();
  } else if (a === 'reset') {
    if (confirm('Erase your whole routine, schedule and history from this browser? This can’t be undone.')) {
      state = freshState();
      save();
      render();
      toast('Everything erased');
    }
  } else if (a === 'clear-past') {
    const tk = todayKey(), now = nowMin();
    const before = state.events.length;
    state.events = state.events.filter(e => !(e.date < tk || (e.date === tk && toMin(e.time) + e.duration <= now)));
    save();
    render();
    toast(`Deleted ${before - state.events.length} past event${before - state.events.length === 1 ? '' : 's'}`);
  }
});

main.addEventListener('change', ev => {
  if (ev.target.dataset.action === 'sound') {
    state.settings.sound = ev.target.checked;
    save();
  } else if (ev.target.id === 'import-file') {
    const file = ev.target.files[0];
    if (file) importData(file);
    ev.target.value = '';
  }
});

document.addEventListener('keydown', ev => {
  if (ev.key === 'n' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !dlg.open &&
      !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && view !== 'settings') {
    ev.preventDefault();
    openEditor(view === 'schedule' ? 'event' : 'routine');
  }
});

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hompub-routine-${todayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || (!Array.isArray(data.routine) && !Array.isArray(data.events))) throw new Error('shape');
      if (!confirm('Replace your current routine and schedule with the one in this file?')) return;
      state = sanitizeState(data);
      save();
      render();
      toast('Backup restored', `${state.routine.length} routine steps, ${state.events.length} events.`);
    } catch (e) {
      toast('That file isn’t a HomPub Routine backup');
    }
  };
  reader.readAsText(file);
}

/* ---------- toasts ---------- */

const toasts = document.getElementById('toasts');
function toast(title, body, actions = [], ms = 4500) {
  const el = document.createElement('div');
  el.className = 'toast' + (ms === 0 ? ' reminder' : '');
  el.setAttribute('role', ms === 0 ? 'alert' : 'status');
  el.innerHTML = `<strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ''}<div class="toast-actions"></div>`;
  const box = el.querySelector('.toast-actions');
  const close = () => el.remove();
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.addEventListener('click', () => { a.run(); close(); });
    box.appendChild(b);
  }
  if (ms === 0 || actions.length) {
    const b = document.createElement('button');
    b.textContent = actions.length ? '✕' : 'OK';
    b.setAttribute('aria-label', 'Dismiss');
    b.addEventListener('click', close);
    box.appendChild(b);
  }
  toasts.appendChild(el);
  if (ms) setTimeout(close, actions.length ? ms * 1.5 : ms);
  while (toasts.children.length > 4) toasts.firstChild.remove();
}

/* ---------- reminders ---------- */

let swReg = null;
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', ev => {
    // "Done" pressed on a notification
    if (ev.data && ev.data.type === 'done' && ev.data.id && ev.data.date) {
      if (!doneSet(ev.data.date).has(ev.data.id)) toggleDone(ev.data.date, ev.data.id);
      render();
    }
  });
}

function requestNotifs() {
  if (!('Notification' in window)) { setView('settings'); return; }
  Notification.requestPermission().then(p => {
    render();
    if (p === 'granted') toast('Notifications on', 'You’ll get a notification for each reminder.');
    else if (p === 'denied') toast('Notifications blocked', 'You’ll still see reminders here while the page is open.');
  });
}

function clearFired(id) {
  for (const k of Object.keys(state.fired)) if (k.endsWith('|' + id)) delete state.fired[k];
}

function checkReminders() {
  const d = new Date();
  const k = dateKey(d);
  const now = nowMin(d);
  const done = doneSet(k);
  let changed = false;

  for (const it of itemsFor(k)) {
    if (it.lead < 0 || done.has(it.id)) continue;
    const fk = k + '|' + it.id;
    if (state.fired[fk]) continue;
    const at = it.start - it.lead;
    if (now >= at && now <= it.start + REMINDER_WINDOW_MIN) {
      state.fired[fk] = 1;
      changed = true;
      fireReminder(it, fk, k);
    }
  }
  // Early-morning items whose reminder falls before midnight (e.g. 00:15 with a 30-min lead)
  const tomorrow = addDays(k, 1);
  for (const it of itemsFor(tomorrow)) {
    if (it.lead < 0 || it.start - it.lead >= 0) continue;
    const fk = tomorrow + '|' + it.id;
    if (state.fired[fk] || doneSet(tomorrow).has(it.id)) continue;
    if (now >= 1440 + it.start - it.lead) {
      state.fired[fk] = 1;
      changed = true;
      fireReminder(Object.assign({}, it, { start: it.start + 1440 }), fk, tomorrow);
    }
  }
  // Forget fired-markers older than yesterday
  const cutoff = addDays(k, -1);
  for (const key of Object.keys(state.fired)) {
    if (key.slice(0, 10) < cutoff) { delete state.fired[key]; changed = true; }
  }
  if (changed) save();
}

function fireReminder(it, tag, date) {
  const mins = Math.round(it.start - nowMin());
  const title = it.kind === 'test' ? it.title : mins > 0 ? `${it.title} — in ${fmtIn(mins)}` : `Time for: ${it.title}`;
  const body = [it.kind === 'test' ? '' : fmtTime(it.start % 1440) + (it.duration ? ' · ' + fmtDur(it.duration) : ''), it.note]
    .filter(Boolean).join(' — ');

  const actions = [];
  if (date && it.id) {
    actions.push({
      label: 'Done',
      run: () => { if (!doneSet(date).has(it.id)) toggleDone(date, it.id); render(); }
    });
  }
  toast(title, body, actions, 0);
  if (state.settings.sound) chime();

  if ('Notification' in window && Notification.permission === 'granted') {
    const opts = {
      body, tag, renotify: true, requireInteraction: true,
      icon: '../../icon-192.png', badge: '../../favicon-32.png',
      data: { id: it.id, date }
    };
    if (swReg && swReg.showNotification) {
      if (date && it.id) opts.actions = [{ action: 'done', title: 'Mark done' }];
      swReg.showNotification(title, opts).catch(() => plainNotification(title, opts));
    } else {
      plainNotification(title, opts);
    }
  }
}

function plainNotification(title, opts) {
  try {
    const n = new Notification(title, { body: opts.body, tag: opts.tag, icon: opts.icon });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) { /* e.g. Android Chrome requires the service worker path */ }
}

/* Short two-note chime via Web Audio (no audio files to download). */
let audioCtx = null;
function unlockAudio() {
  if (audioCtx || !(window.AudioContext || window.webkitAudioContext)) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
}
function chime() {
  unlockAudio();
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  const t0 = audioCtx.currentTime + 0.02;
  [[659.25, 0], [987.77, 0.18]].forEach(([f, dt]) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.9);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + 1);
  });
}

/* ---------- boot ---------- */

try {
  const v = sessionStorage.getItem('hompub-routine-view');
  if (['today', 'routine', 'schedule', 'settings'].includes(v)) view = v;
} catch (e) {}
setView(view);
checkReminders();

let lastDay = todayKey();
setInterval(() => {
  checkReminders();
  const t = todayKey();
  if (t !== lastDay) { // midnight rolled over
    if (viewDay === lastDay) viewDay = t;
    lastDay = t;
  }
  if (view === 'today' && !dlg.open) render();
}, 20000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkReminders();
    if (!dlg.open) render();
  }
});
// Another tab changed the data
window.addEventListener('storage', ev => {
  if (ev.key === STORE_KEY) { state = loadState(); if (!dlg.open) render(); }
});
