# HomPub Quiz — protocol and contract (v4, pilot)

This document is the single source of truth for every component in `quiz/`:
the Cloudflare Worker (`src/worker.ts`), the `Room` Durable Object
(`src/room.ts`), the `Directory` Durable Object (`src/directory.ts`), the
player page (`public/play.html`), the host page (`public/host.html`), the join
page (`public/index.html`) and the load harness (`test/load.mjs`). If code and
this document disagree, fix one of them in the same commit.

Protocol 2 added host sign-in, roster deltas, renames and the other Phase 1
changes. Protocol 3 added Focus check (§13); the synced quiz library (§12)
arrived with it. Protocol 4 (this version) adds question types (several right
answers, a typed answer, a poll), explanations, pictures (§14), per-phone
option order, and 400-character questions: quiz schema 2. What changed, and how
pages from before it keep working, is in §11.

## 1. Roles, pages, URLs

One **host** (the teacher, on a laptop connected to a projector, signed in with
the host passcode) and up to `MAX_PLAYERS` (400) **players** (students on their
phones). Everything
is served from one hostname by one Worker. Static files live in `public/` and
are served as Workers Static Assets (free, never counted against the request
budget). Only `/api/*` invokes the Worker.

| URL | What |
|---|---|
| `GET /` | Join page: enter a 6-digit PIN → navigates to `/play?pin=XXXXXX` |
| `GET /play?pin=XXXXXX` | Player page (phone). Also the target of the QR code. |
| `GET /host` | Host page (laptop): quiz editor, lobby, game control, results |
| `GET /api/health` | `200 {"ok":true,"now":<ms>,"version":"0.4.0","proto":4}` |
| `POST /api/session` | Sign in. Body `{"passcode": "...", "shared"?: true}`. `200 {"signedIn":true,"shared","expiresAt","library"}` and `Set-Cookie: __Host-hq_session=…; Path=/; Secure; HttpOnly; SameSite=Strict` (with `Max-Age`, except for a shared computer). `401 {"error":"wrong_passcode","remaining","message"}`. `429 {"error":"locked","retryAfter","message"}` + `Retry-After` after 5 wrong passcodes from one network in 15 minutes. `503 {"error":"not_configured"\|"passcode_too_short"\|"try_again","message"}`. |
| `GET /api/session` | `200 {"signedIn":true,…}` (renews the cookie when due) or `200 {"signedIn":false[,"problem","message"]}`. `?passive=1`: the host page's timer, not the teacher, is asking; a shared-computer session is then not renewed, so its 4-hour idle limit holds while the tab stays open (it is never renewed past 12 hours in any case). |
| `DELETE /api/session` | Sign out on this device: clears the cookie. `200 {"signedIn":false}`. |
| `GET /api/rooms` | Signed in: `200 {"rooms":[{"pin","title","phase","playerCount","createdAt"}]}`, this library's live games (at most 10, newest first). Never contains host tokens. `401` signed out. |
| `/api/library…` | Signed in only: the synced quiz library (§12). |
| `POST /api/images`, `GET /api/images/:key` | Question pictures (§14): upload signed in only; reading needs no sign-in. |
| `GET /api/echo` | WebSocket echo (handled in the Worker, no Durable Object). Used by the network preflight. Any text frame is echoed back verbatim. Closes after 60 s. |
| `POST /api/room` | Signed in only (`401 {"error":"sign_in"}` otherwise). Create a room. Body: `{"quiz": Quiz, "settings"?: Settings}`. Response `200 {"pin":"123456","hostToken":"<32 hex>","roomKey":"<16 hex>","joinUrl":"https://<host>/play?pin=123456&k=<roomKey>"}`. Errors: `400 {"error":"..."}` (invalid quiz), `413` (body > 200 KB), `429 {"error":"too_many_rooms"}` (whole-deployment daily cap; signed-in hosts skip the per-network cap), `503 {"error":"no_pin_available"\|"not_configured"\|…}`. |
| `GET /api/room/:pin[?k=<roomKey>]` | Room summary for the join page: `200 {"pin","phase","playerCount","locked","lateJoin","nicknameMode","nameMode","allowRename"}` or `404 {"error":"not_found"}`, or `429 {"error":"rate_limited","retryAfter","message"}` (§9). No quiz title: anyone who guesses a PIN could read it. |
| `GET /api/room/:pin/ws?role=host&v=4` | Host WebSocket. Needs the session cookie (checked by the Worker, which then vouches for the socket); otherwise the host token goes in a first `auth` frame (§4.2). A token in the URL is ignored. A version-1 page (no `v`) is refused with `4010` "This page is out of date…" because it cannot sign in; so is a version-3 page in a room whose quiz uses the protocol-4 types (§11). |
| `GET /api/room/:pin/ws?role=player&v=4[&k=<roomKey>][&token=<playerToken>]` | Player WebSocket. `token` present = reconnect attempt. `k` = the room key from the QR code / join link. `v=2` and `v=3` pages still play a quiz of one-right-answer questions (§11); a page without `v` (version 1) is refused with `4010` "This page is out of date. Reload it to join the game." |

`:pin` must match `^[1-9][0-9]{5}$`. Any other `/api/*` path → `404 {"error":"not_found"}`.
The join page treats a summary whose `phase` is `podium` or `ended` as too late to join, matching the Room, which refuses new players in both phases with `4004`.
Non-upgrade requests to a `/ws` URL → `426`.

**Origin check (Worker, all `/api/*`):** if an `Origin` header is present it
must equal the request's own origin (`scheme://host[:port]`) or be listed in
the `ALLOWED_ORIGINS` var (comma-separated). Otherwise `403`. Requests without
an `Origin` header (curl, the load harness) are allowed.

**Requests that use the session cookie** (`/api/session`, `/api/rooms`,
`/api/library…`, `/api/images…`, `POST /api/room`, the host socket) follow a stricter rule: POST, PUT, DELETE
and WebSocket upgrades need `Origin` equal to the page's origin, and a missing
Origin is refused; GET and HEAD refuse a foreign Origin and a `Sec-Fetch-Site`
that is present and not `same-origin`, but accept a missing Origin (browsers
send none on same-origin GETs; older Safari sends no `Sec-Fetch-Site`).

**Response headers:** every `/api/*` response and every static page carries
`X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`,
`Referrer-Policy: strict-origin-when-cross-origin` and
`X-Content-Type-Options: nosniff` (pages via `public/_headers`).

**Dev:** `npm run dev` → `http://localhost:8787`. WebSockets are `ws://` there
and `wss://` in production; clients derive the scheme from `location.protocol`.

## 2. Data shapes

### Quiz (authored on the host page, stored in the quiz library (§12) and cached in the host's localStorage, sent once in `POST /api/room`)

```jsonc
{
  "schema": 2,                             // 2 once the quiz uses anything below marked "schema 2"; missing = 1
  "title": "Cell biology — week 6",       // 1..80 chars
  "questions": [                           // 1..100 questions
    {
      "text": "Which organelle makes ATP?",  // 1..400 chars (a schema-1 quiz keeps to 200)
      "options": ["Ribosome", "Mitochondrion", "Golgi body", "Nucleus"], // 2..4 strings, each 1..80 chars
      "correct": 1,                          // index into options
      "timeLimit": 20,                       // seconds, one of 5,10,15,20,30,60,90,120,240
      "points": 1000,                        // 0 | 1000 | 2000  (0 = practice: nobody scores, the right answer is still shown)
      "explanation": "Mitochondria make ATP.",   // schema 2, optional, 1..400 chars: shown after the reveal
      "image": { "key": "<sha256>.webp", "alt": "A mitochondrion", "w": 1600, "h": 1067 }  // schema 2, optional (§14); alt 1..150 chars
    },
    // schema 2: other types. A question without "type" is the one-right-answer question above.
    { "type": "multi",  "text": "…", "options": ["…"], "correct": [0, 2], "partial": false, "timeLimit": 20, "points": 1000 },
    { "type": "typein", "text": "…", "accept": ["Kṛṣṇa", "Krishna"], "timeLimit": 20, "points": 1000 },
    { "type": "poll",   "text": "…", "options": ["…"], "timeLimit": 20, "points": 0 }
  ]
}
```

- `multi`: `correct` lists every right option (1 or more, sorted, no repeats);
  `partial` (default false) gives part of the points for a partly right
  answer (§3).
- `typein`: no options; `accept` lists 1..10 answers (each 1..80 chars) that
  count as right, compared as in §3.
- `poll`: no right answer and no points (`points` must be 0).

A stored quiz may also carry fields this version does not know; the library
keeps them. `schema` is 2 when a quiz uses a `type`, an `explanation`, an
`image` or text over 200 characters; a page never lowers it. A page that meets a
quiz with a newer `schema` opens it read-only and never saves, hosts or changes
it (§12): a Phase 2 page (schema 1) keeps schema-2 quizzes intact that way.

Option slots are fixed to Kahoot's shape/colour pairs so colour-blind players
can play by shape: index 0 = red triangle, 1 = blue diamond, 2 = yellow
circle, 3 = green square. Letters A–D are used in CSV and text.

### Settings (host may change until `start`; `showOnDevices`, `lateJoin` and `allowRename` may change any time; `focusCheck` and `shuffle` any time except during `intro` and `open`)

```jsonc
{
  "mode": "speed",          // "speed" (default, Kahoot formula) | "accuracy" (1 point per correct) | "coarse" (speed with elapsed rounded up to whole seconds)
  "showOnDevices": false,   // false = phones show only the four shapes; question text and options are on the projector
  "lateJoin": true,         // allow joining after start (joiners score 0 for past questions)
  "earlyClose": false,      // close the question as soon as every player who was connected when it opened has answered
  "nameMode": "typed",      // "typed" (default) = typed names only, no random-name button | "either" = typed or random | "random" = random two-word names only
  "allowRename": true,      // students may change their own name (rename frame). Switched off by the server at start; the host may switch it on again.
  "focusCheck": false,      // phones report leaving the page during a question (§13). Off by default.
  "shuffle": false,         // protocol 4: each phone shows the options in its own order (§3), only while showOnDevices is on
  "nicknameMode": "free"    // legacy, always derived: "spin" when nameMode is "random", else "free". Still written, so a server rolled back to protocol 2 reads stored rooms unchanged.
}
```

A settings object without `nameMode` (a room or a host page from before protocol 2)
maps `nicknameMode: "spin"` to `"random"` and `"free"` to `"either"` (those
pages offered a Spin button next to the name box).

### Phases

`lobby → intro → open → closed → intro → … → closed → podium → ended`

- `lobby`: players join. Host presses **Start**.
- `intro` (3 s, server-timed): "Question 4 of 20, get ready". Everyone learns `opensAt` before the clock starts, so broadcast order cannot favour anyone.
- `open`: answers accepted from `opensAt` until `deadline = opensAt + timeLimit*1000`, plus a 1,000 ms grace for frames in flight (a grace answer is scored as if `elapsed = timeLimit*1000`). Phones switch to the answer buttons at `opensAt` on the shared clock without waiting for the `open` frame; an `answer` that reaches the server at or after `opensAt` while it is still in `intro` opens the question on the spot. Closes on the server timer, on host **Close**, or (if `earlyClose`) when every eligible player has answered.
- `closed`: correct answer revealed; players see their own result and rank; host sees counts, fastest correct player and the top 10. Host presses **Next** (→ `intro` of the next question, or → `podium` after the last).
- `podium`: top 3 on the projector, everyone sees their own final rank. Host presses **End game**.
- `ended`: host receives the results CSV; players keep their final rank on screen and are told nothing about the game is kept (or, if the host ended it before any answer, that the host ended it). The room is wiped when the host sends `ack_results`, or by TTL.

Time is **always the server's clock**. Every frame that carries a time also
carries `serverNow`; clients compute `offset = serverNow - Date.now()` on
receipt and animate countdowns as `deadline - (Date.now() + offset)`.
Clients never send timestamps.

## 3. Scoring (server only)

For an answer frame arriving at server time `now` for the open question with
`T = timeLimit * 1000` and `P = points`:

```
elapsed = now - opensAt            // clamp to [0, T]; frames in the 1 s grace get elapsed = T
wrong or survey (P = 0)            → 0 points
mode "accuracy"                    → 1 point if correct
mode "coarse"                      → elapsed = ceil(elapsed / 1000) * 1000, then the speed formula
mode "speed" (Kahoot's published formula):
    elapsed < 500                  → P
    otherwise                      → round(P * (1 - (elapsed / T) / 2))
```

Worked check: 2 s on a 30 s, 1000-point question → 1000 × (1 − (2/30)/2) = 966.7 → **967**.

**Question types (protocol 4).** The formula above is unchanged; the types
decide whether an answer is right:

- `multi`: right only when the chosen options are exactly `correct`; it then
  scores as above. With `partial`, a partly right answer gets
  `round(that score × (rightPicks − wrongPicks) / rightOptions)`, never below 0;
  in mode `accuracy` only a fully right answer scores (1 point).
- `typein`: right when the typed text matches one of `accept` after
  normalising both: Unicode NFD, the Combining Diacritical Marks block
  (U+0300–U+036F) removed (so IAST "Kṛṣṇa" matches "Krsna"; Devanagari vowel
  signs, virama and anusvara are kept), zero-width joiners removed, NFC,
  lower case, runs of spaces made one, surrounding quotes and closing
  punctuation (`. ! ? , ; : । ॥`) removed. A leading sign stays ("-5" is not "5").
- `poll`: no right answer, 0 points; a poll neither extends nor breaks a streak.

"Fastest correct" (`reveal.fastest`) is given only for a question worth points
that has a right answer: null for a poll and for a 0-point question.

**Shuffle.** With `settings.shuffle` and `showOnDevices`, the question view
carries `"shuffle": true`. Each phone shows option `order[k]` in tile `k`,
where `order` is a Fisher–Yates shuffle driven by mulberry32 seeded with the
32-bit FNV-1a hash of `"<pid>:<q>"`, so the order is the same after a reload.
Tiles keep their position's shape and colour; the phone sends the option's own
index, so the server needs nothing to undo it.

Order: by `score` descending, then lower `elapsedTotal` (sum of `elapsed` over
*right* answers), then earlier `joinedAt`. This strict order decides the top
three and the CSV. The rank shown (`rank`, with `tied`) is by score alone:
equal scores share a place (1, 2, 2, 4) and are marked tied. `streak` counts
consecutive right answers (a partly right one breaks it) and is display-only
(no bonus points).

One answer per player per question: enforced in the Room by an in-memory set
for the open question and by the persisted `answers` JSON. A second tab or a
reconnect with the same token cannot answer twice (`ack.accepted=false,
reason="duplicate"`).

## 4. WebSocket framing

- Text frames containing one JSON object with a string field `t` (type).
- Exception: a player or host may send the literal text `ping`; the edge
  replies `pong` without waking the Room (auto-response, not billed). Pages
  send it every 10 s; when neither a `pong` nor any frame arrives within 10 s
  of a ping, the page treats the connection as dead and reconnects at once.
- Frame > 4,096 bytes → server closes with **1009**.
- More than 10 frames/s sustained (burst allowance 20) → server closes with **4008**.
- Server close codes: `4000` bad request (also `Join timed out` for a player socket that has not joined after 60 s without a `join` attempt, or 3 minutes in all) · `4001` bad host token · `4003` kicked · `4004` room not found / already ended / unknown player token · `4008` rate limited · `4009` room full · `4010` room locked / late join disabled / a version-1 page (out of date: reload) · `4011` host session missing or expired: sign in again · `4012` this player is now connected in another tab or device · `4013` replaced by a newer connection from the same tab (version 2; the page has normally abandoned that socket already and ignores it; on its live socket it means a duplicated tab id, so the page takes a new tab id and reconnects) · `4014` too many wrong PINs from this network (version 2) · `1009` frame too large. Clients **must not** auto-reconnect after 4001, 4003, 4004, 4009, 4010, 4011, 4012, 4014; show the message instead (a host page first checks its session after 4011, below). Any other close → reconnect with backoff; the backoff restarts only once a frame has arrived, so a server that accepts and closes at once is not retried at full speed.
- Before the Room closes a socket from another socket's event or an alarm (a second tab, the wipe, an expired host sign-in), it sends `{"t":"closing","code":4012,"reason":"…"}`; version-2 pages act on it as on the close itself. In local workerd the close handshake of a socket that has not sent a frame yet stalls in that case (a phone that reconnected and has not answered yet), and the frame does not depend on it.
- A close issued by a Room timer (the 10 s host sign-in limit, the join limits) is preceded by an `error` frame with code `auth_timeout` / `join_timeout`, because in local workerd such a close does not always reach the client; version-2 pages close the socket themselves on that frame.

### 4.1 Client → server (player)

| Frame | When | Notes |
|---|---|---|
| `{"t":"join","nick":"Priya","joinId":"<32 hex>"}` | first connection, no token | nick is trimmed, control chars stripped, a leading `= + - @` removed, max 20 characters; duplicate → numeric suffix (`Priya 2`) and `welcome.note`. Invisible characters (soft hyphens, zero-width and other format characters) are removed first, so the name shown is the name checked. Empty or profane (whole-word deny-list, §9) → `join_rejected`, the socket stays open for another try. `nameMode: "random"` → a spun name whatever was typed (`welcome.note` with reason `random` says so). `joinId` (optional): a join repeated with the same id within 60 s of its `welcome` (the welcome was lost) gets the same player back instead of a second one; if the host has removed that player meanwhile, it gets `kicked` and 4003. |
| `{"t":"join","spin":true,"joinId":"…"}` | first connection | a random two-word name (adjective + animal, e.g. `Brave Otter`). Refused with `join_rejected` (`random_off`) when `nameMode` is `"typed"`. A `join` after joining gets `error` `already_joined`; a new name goes through `rename`. |
| `{"t":"rename","nick":"Priya S"}` / `{"t":"rename","random":true}` | any phase while `settings.allowRename` | Same checks as joining (sanitising, deny-list, 20 characters, duplicate numbering). At most 3 renames per player, counted apart from spins. Typed names refused when `nameMode` is `"random"`, random ones when it is `"typed"`. Reply `renamed` or `rename_rejected` (old name kept); the host gets `player_updated`. |
| `{"t":"answer","q":3,"choice":1}` | phase `open` | `q` must equal the current question index; `choice` an integer in `[0, optionCount)`. Refusal reasons are checked in this order: wrong `q` or not open/closed → `closed`; phase `closed` → `late`; bad `choice` → `invalid`; already answered → `duplicate`. |
| `{"t":"answer","q":3,"choice":[0,2]}` | phase `open`, a `multi` question | 1..optionCount distinct option indices (any order); anything else → `invalid`. |
| `{"t":"answer","q":3,"text":"Krishna"}` | phase `open`, a `typein` question | 1..80 characters (code points) after control and bidi-control characters become spaces and spaces are collapsed; empty or longer → `invalid`. |
| `{"t":"away","q":3,"n":2,"ms":14000,"copies":1}` | version 3, a question checked by Focus check (§13) | running totals for question `q` from this page: times the student left the page, ms away, blocked copies. No reply. |

A reconnecting player (`?token=`) sends nothing; the server replies with `sync`.
Pages add `tab=<32 hex>` (one id per browser tab, kept in sessionStorage and
checked against other tabs over a BroadcastChannel, since a duplicated tab
copies it) and `seq=<n>` (how many connections this page has opened). A
reconnect closes the player's other open sockets: another tab's with `4012`
(one live page per player), the same tab's older one with `4013`; an upgrade
from the same tab with a lower `seq` than an open socket is one the page
already abandoned, and is itself closed with `4013`. The room-wide socket cap
is checked before anything is closed.

### 4.2 Client → server (host)

| Frame | Allowed in phase | Effect |
|---|---|---|
| `{"t":"auth","token":"<hostToken>"}` | first frame of a host socket | Authenticates a host socket the Worker did not vouch for (the Worker vouches for a signed-in host with a signed header, so normally the socket is ready at once and `auth` is ignored). Until then the socket receives nothing; a wrong token or another frame closes it with 4001; after 10 s it gets `error` `auth_timeout`. |
| `{"t":"start"}` | lobby | → `intro` of question 0 (allowed with 0 players, for testing). Switches `allowRename` off (a `settings` frame follows). |
| `{"t":"next"}` | closed | → `intro` of q+1, or `podium` after the last question |
| `{"t":"close"}` | open | close the question now |
| `{"t":"end"}` | podium (also allowed from any phase as an abort) | → `ended`; host receives `results_csv`; players receive `ended` |
| `{"t":"ack_results"}` | ended | host confirms it has the CSV → room wiped (`deleteAll`), host receives `wiped`, all sockets closed with 4004 |
| `{"t":"kick","pid":"...","lock"?:true}` | any | player's token is banned, their sockets closed with 4003, they are removed from the roster; their name stays reserved; their answers stay in the CSV, marked `removed`. `lock: true` also locks the room. A removed student can rejoin under another name unless the room is locked. If saving fails (`storage_full`), nothing changes, except that a removal whose lock could not be saved still removes the player. |
| `{"t":"rename_player","pid":"...","nick":"..."}` | any | the host renames anyone (also removed players, also after `end`). Sanitising and duplicate numbering apply; the deny-list does not. The phone gets `renamed` with `byHost`; after `end` the host gets `results_csv` again with `update: true`. |
| `{"t":"keep"}` | any but `ended` | counts as activity: postpones the idle wipe by 2 h ("Keep 2 more hours"); the host gets `expiry`. In `ended` the room is wiped 30 min after `end` whatever happens, so `keep` changes nothing there. |
| `{"t":"dev_stats"}` | any | dev only (`DEV_MODE` and `DEV_REPORT_ROWS` in `.dev.vars`): reply `dev_stats {statements, rowsWritten, alarms, players, wipeRows}` |
| `{"t":"lock","on":true}` | any | locked rooms reject new players with 4010 (reconnects still work) |
| `{"t":"settings","settings":{...partial...}}` | any (`mode`, `earlyClose`, `nameMode` only in lobby; `focusCheck` not during `intro` or `open`, which gets `error` `focus_mid_question` while the rest of the patch applies) | server replies with `settings` to host and, if `showOnDevices`, `nameMode`, `allowRename` or `focusCheck` changed, to players |

Anything not allowed in the current phase → `{"t":"error","code":"bad_phase","message":"..."}` in plain words (for example "This question is already closed."), no state change.

When a save fails (`storage_full`), `start`, `next`, `close`, `lock` and
`settings` change nothing, so memory and storage agree and the host can try
again. `next` to the podium and `end` are sent first and saved after: every
answer they show is already saved, and the results file must reach the host
even when nothing more can be saved.

A host socket the Worker vouched for carries the session's expiry; once it has
passed, the socket's next frame (or the Room's next alarm) closes it with
`4011`.

### 4.3 Server → client

Every frame has `t`. Frames with times carry `serverNow` (ms since epoch, server clock).

**`sync`** — full snapshot. Sent to every socket right after it is accepted (first join gets `welcome` *then* `sync`), and whenever the server prefers a snapshot over a delta. Clients should be able to render any screen from `sync` alone.

```jsonc
{
  "t": "sync", "proto": 4, "serverNow": 1760000000000,
  "role": "player" | "host",
  "pin": "123456", "title": "Cell biology — week 6",
  "phase": "open", "q": 3, "total": 20,
  "focusQs": [0, 1, 2, 3],                   // questions opened while Focus check was on (§13)
  "locked": false, "settings": { ...Settings... }, "playerCount": 97,
  "question": null | {                       // present in intro / open / closed
    "q": 3, "total": 20, "type": "single" | "multi" | "typein" | "poll", "optionCount": 4, "timeLimit": 20, "points": 1000,
    "opensAt": 1760000003000, "deadline": 1760000023000,
    "text": "...", "options": ["..."],       // host always; players only when settings.showOnDevices (a typein has options [], optionCount 0)
    "image": { "url": "/api/images/<key>", "alt": "...", "w": 1600, "h": 1067 },  // with the text, if the question has a picture
    "shuffle": true                          // with the text, when settings.shuffle (§3)
  },                                         // never the answer key, accepted answers or the explanation
  // ---- player only ----
  // During intro and open, score and rank are as before the current question, and streak is null once
  // the player has answered it: nothing a player gets may tell whether this answer was right before `closed`.
  "me": { "pid": "p_ab12", "nick": "Priya", "score": 2310, "rank": 12, "tied": false, "streak": 2,
          "answered": true, "choice": 1,       // answered/choice refer to the current question; choice is [..] for multi, null for typein
          "typed": "Krishna",                  // typein only, once answered
          "spins": 1,                          // name spins used so far (max 3)
          "renamesLeft": 3 },                  // student renames still allowed (max 3)
  "result": { ...same fields as the result frame, without t... },   // only in phase closed
  "recap": { "q": 2, "type": "single", "right": true, "choice": 1, "typed": "…", "points": 912, "survey": false, "closedAt": 1760000041000, "score": 2310, "rank": 12, "tied": false, "playerCount": 97 },
                                             // intro / open of question 2 onwards: the result of question q-1, for a phone away at its reveal.
                                             // `right`: true / false / null (no answer, or a poll). `survey`: a poll or a 0-point question.
                                             // No `correct`: players never get the answer key before `closed`.
  "podium": { "top": [{"nick":"...","score":1234,"rank":1,"tied":false}, ...], "you": {"score": 2310, "rank": 12, "tied": false} }, // podium / ended
  "played": true,                                                    // ended only: whether any question was answered
  // ---- host only ----
  "roster": [ {"pid":"p_ab12","nick":"Priya","connected":true,"score":2310,"answered":true}, ... ],
  "tally": { "counts": [12, 60, 3, 9], "answered": 84, "expected": 97 },          // intro/open/closed
  "reveal": { ...same fields as the reveal frame, without t... },                   // closed
  "leaderboard": [ {"pid":"...","nick":"...","score":2310,"delta":967,"rank":1,"tied":false}, ... ], // top 10, closed/podium/ended
  "focus": [ {"pid":"p_ab12","q":3,"n":2,"ms":14000,"copies":1,"old":false}, ... ], // Focus check records (§13), removed players included
  "hostToken": "<32 hex>",                                                          // so a resumed host can persist it
  "roomKey": "<16 hex>",                                                            // for the QR code / join link (&k=)
  "hostCount": 1,                                                                   // authenticated host sockets
  "expiry": {"wipeAt": 1760007200000, "warnAt": 1760006300000}                      // idle wipe, when results would be lost; nulls otherwise
}
```

**Player frames**

| Frame | Fields |
|---|---|
| `welcome` | `pid, token, nick, pin, note?` — store `{pin, token, pid, nick, savedAt}` in localStorage key `hompub-quiz:player:<pin>`; entries older than 6 h are swept on page load. `note: {reason: "duplicate"\|"stripped"\|"shortened"\|"random", message}` says why the name differs from what was typed. `token` is 48 hex for rooms created with secrets set (it carries a MAC the Worker can check, §9). |
| `join_rejected` | `reason: "empty"\|"filtered"\|"random_off"\|"unavailable", message, nameMode` — version 2 only; the socket stays open. `nameMode` is the room's current setting, so a join form drawn before the host changed it can redraw itself. `unavailable`: the player could not be saved (`storage_full`). |
| `renamed` | `nick, renamesLeft, note?, byHost?` — the name changed (the student's own rename, or the host's) |
| `rename_rejected` | `reason: "off"\|"limit"\|"empty"\|"filtered"\|"random_off"\|"typed_off"\|"same", message, renamesLeft` — the old name is kept |
| `lobby` | `playerCount, locked` (coalesced, ≤ 2/s) |
| `intro` | `question` (same object as in `sync`), `serverNow` |
| `open` | `q, deadline, serverNow` |
| `ack` | `q, accepted:boolean, reason?: "late" \| "duplicate" \| "closed" \| "invalid" \| "unavailable"` (`unavailable`: the answer could not be saved, see `storage_full`) |
| `result` | `q, type, correct, right:boolean\|null, choice, typed?, points:int, explanation?, score:int, rank:int, tied:boolean, streak:int, playerCount:int, closedAt` (sent to every player at close, including those who did not answer; `closedAt` is when the question closed, server time). `correct`: the right option's index; for `multi` the indices; for `typein` the accepted answers; null for a poll. `right`: whether this player's answer was right (null: no answer, or a poll); a partly right `multi` answer is `false` with points above 0. `choice`: as sent (an index, the sorted indices, or null for typein, whose text is `typed`). |
| `podium` | `top:[{nick,score,rank,tied}] (≤3), you:{score,rank,tied}, playerCount` |
| `ended` | `played:boolean` — clear the localStorage entry. `played: false`: the host ended the game before any answer. |
| `kicked` | — (then close 4003) |
| `settings` | `settings`, plus `question` (the same object as in `sync`, present in intro/open/closed, only when `showOnDevices` changed) — sent when the host changes `showOnDevices`, `nameMode`, `allowRename`, `focusCheck` or `shuffle`; clients update settings and question and keep any in-progress answer UI |
| `error` | `code, message` (also `join_timeout`: no successful join within 60 s) |

**Host frames**

| Frame | Fields |
|---|---|
| `player_joined` / `player_updated` | `players:[{pid,nick,connected,score,answered}], playerCount` — new players / players whose name or connection changed since the last frame (coalesced, ≤ 2/s). Scores and `answered` reach the host through `tally`, `reveal` and the leaderboard, and are fresh only in `sync`. After the Room wakes from hibernation the host gets a full `sync` instead, and a rename during `closed` or `podium` (where names also show in the leaderboard and the top three) sends every host a `sync`. |
| `player_left` | `pids:[...], playerCount` — removed players |
| `focus` | `records:[{pid,q,n,ms,copies,old}]` — Focus check records that changed (§13), coalesced, ≤ 2/s |
| `hosts` | `count` — authenticated host sockets (another device or tab took over too) |
| `expiry` | `wipeAt, warnAt, serverNow` — sent at `warnAt` (15 min before an idle wipe that would delete results), after `keep`, and on the first activity after a warning (the wipe has moved). A phase frame also means activity, so pages drop a shown warning on one. |
| `notice` | `code: "pin_limited", retryAfterMs, serverNow` — lookups for this PIN from some network are being refused because of the PIN-guess limit (§9), so typing the PIN does not work there for about `retryAfterMs`; scanning the QR code still does. At most once a minute. |
| `intro` | `question` (with text and options), `serverNow` |
| `open` | `q, deadline, serverNow` |
| `tally` | `q, counts:int[], answered, expected` (coalesced, ≤ 4/s while open; `counts` as in `reveal`) |
| `reveal` | `q, type, correct, counts:int[], answered, right, explanation?, expected, fastest:{nick, ms}\|null, leaderboard:[{pid,nick,score,delta,rank,tied}] (top 10), playerCount` — `correct` as in `result`; `counts`: answers per option (a `multi` answer counts once for each option chosen; `[]` for typein); `right`: how many answers were right. Typed answers are never sent to hosts in frames (only in the CSV), so nothing a student typed is put on the projector. |
| `podium` | `top:[{pid,nick,score,rank,tied}] (≤3), leaderboard (top 10), playerCount` |
| `results_csv` | `csv:string, filename:string, update?:true` (`update`: a player was renamed after `end`; replace the held file without downloading it again) |
| `wiped` | — (then close 4004) |
| `settings` | `settings, locked` |
| `error` | `code, message`. `storage_full`: the Room could not save (most likely Cloudflare's free daily write allowance is used up; it resets at 00:00 UTC, 05:30 IST); `auth_timeout`: no `auth` frame within 10 s; `focus_mid_question` / `shuffle_mid_question`: Focus check or shuffle cannot change during a question. |

Players never receive `correct` (or the accepted answers, or the explanation) before `closed`. The Room never sends the quiz's answer key to a player-tagged socket.

## 5. Reconnect and resume

- **Player:** keeps `{pin, token, pid, nick, title}` in localStorage. On socket close (except the no-retry codes), on `visibilitychange` → visible, and on `online`, reconnect to `/api/room/<pin>/ws?role=player&v=4&token=<token>` with backoff 500 ms → 8 s (×2, ±30 % jitter). The server replies `sync`. One page per player plays at a time (§4.1, `4012`); answers are de-duplicated per player in any case, so two tabs cannot answer twice. A student offline for a whole question scores 0 for it. Players also request a Screen Wake Lock after joining (ignored where unsupported).
- **Unknown or stale player token** (the room was wiped and the PIN reused, or storage is from another deployment): the server accepts the socket and closes it with `4004` and reason `Unknown player token; join again`. The player page clears its stored entry for that PIN and shows the join screen.
- **Host:** keeps `{pin, hostToken, title}` in localStorage key `hompub-quiz:host`. After a reload the page goes straight back to the stage (with "Not now"). Another signed-in browser or device lists the library's live games (`GET /api/rooms`) and can take over without the host token: the Worker vouches for its session. While the host is disconnected the server timers still close questions; phones show "Waiting for the host" only in `closed`. A host that connects while the phase is `ended` receives `sync` and then `results_csv` again, so the results file is never lost to a reload. A host socket closed with `4011` keeps its key: if the page's session is still valid (it was renewed since the socket opened) it reconnects at once, otherwise it asks for the passcode over the stage, still offering a results file it holds, and reconnects after sign-in. On a shared-computer session that has lapsed, and on "Sign out on this device", the page forgets the game screen and any results file it holds (asking first if the file was not downloaded); the game keeps running and can be resumed after signing in.
- **Deploys** restart every Durable Object and drop every socket; clients reconnect and resync within seconds. Deploy outside school hours.

## 6. Timers, hibernation, TTL (Room internals)

- `intro → open` and `open → closed` use `setTimeout` inside the Room plus `ctx.storage.setAlarm(deadline + 1500)` as a durable backstop. The alarm handler re-reads the room row and closes the question if it is still open and past its deadline; otherwise it handles TTL below.
- Between questions the Room has no pending timers and hibernates (WebSocket Hibernation API; sockets stay attached at the edge). Each socket's attachment holds only connection facts (`role, pid`, protocol version, whether a host socket is authenticated and when its sign-in expires, when it connected, a pending socket's last join attempt, a phone page's tab id and `seq`); all game state is in SQLite and reloaded in the constructor.
- TTL (alarm): wipe the room 2 h after the last frame (any direction; keepalive `ping`s do not count, and idle attached sockets do not extend it), or 30 min after `ended` without `ack_results`. Once a question has been played, connected hosts get `expiry` 15 minutes before an idle wipe ("Results deleted at HH:MM — Keep 2 more hours", which sends `keep`), and `results_csv` immediately before it, in any phase. "Wipe" = `deleteAll()`, release the PIN in the Directory (only if it still maps to this room), close all sockets with 4004.
- Auto-response: `ping` → `pong` is registered with `setWebSocketAutoResponse` so keepalives never wake the object.

## 7. Directory (PIN → room id)

A single `Directory` Durable Object (`idFromName("global")`) owns the PIN
table, so rooms can use `newUniqueId()` and therefore live in the data
center nearest the host that created them (a Durable Object never moves).

The Worker calls it over RPC; every newer parameter is optional, so either side
may run the previous version for a few seconds during a deploy.

- `allocate(roomId, ipHash, {library, skipPerIp}?)` → `{ok: true, pin}` · `{ok: false, status: 429, error: "too_many_rooms"}` (per-network cap `ROOM_CREATE_PER_IP_PER_DAY`, default 30, which signed-in hosts skip, so since protocol 2 it is never counted; and the whole-deployment cap `ROOM_CREATE_PER_DAY`, default 300) · `{ok: false, status: 503, error: "no_pin_available"}` after 20 tries.
- `lookup(pin, {ipKey, tokenless, bypass, missLimit, joinLimit}?)` → `{roomId, library}` · `{limited: true, retryAfterMs, notifyRoom?}` (§9; `notifyRoom` asks the Worker to send that room's hosts `notice`) · `null` (unknown or expired; entries older than 24 h count as expired).
- `noteMiss(ipKey)`: a miss found by a Room (an unknown token without a valid MAC). `liveRooms(library)`: the library's PINs for "Resume game". `authAttempt(ipKey, passcode)`: the passcode check with its limit (§9).
- `release(pin, roomId)`; a no-op if the PIN has since been re-issued to another room.
- Housekeeping: expired PINs, creation counters older than yesterday and passcode rows past their 15 minutes are deleted at most hourly on traffic and from an alarm: daily just after 00:00 UTC (so a counter written on day D is gone by 00:05 UTC on D+2), and when the earliest passcode row expires.

## 8. CSV

```
rank,nickname,score,correct,answered,q1,q2,...,qN
1,Priya,18345,19,20,B 967,A 1000,,C 812,...
```
`qN` = `<letter> <points>` for an answered question (letter A–D of the choice), empty if unanswered;
`A+C <points>` for several right answers; the typed text and the points, quoted
like any cell (a leading `= + - @` gets a `'`), for a typed answer; just the
letter for a poll. `correct` counts right answers (a poll is never right, a
partly right answer is not right).
When Focus check was on for at least one question (§13), the columns
`q1 left page … qN left page, times left page, seconds away, copies blocked`
follow: `2x 14 s` (left twice, 14 s away in all), `0`, `not checked` (the
player's page could not report), or empty for a question that was not checked.
Players the host removed follow, in join order, with `removed` in the rank column and the answers they gave.
The `rank` column is the strict order of §3 (1, 2, 3 … even for equal scores); the screens show equal scores sharing a place.
Filename: `hompub-quiz-<pin>-<YYYYMMDD>.csv`.

## 9. Limits (pilot defaults; all enforced server-side)

| Thing | Limit |
|---|---|
| Players per room | `MAX_PLAYERS` = 400 joined players (→ 4009); at most 2 × that many player sockets including not-yet-joined ones, plus 50 for reconnects |
| Sockets per player | one (another tab's is closed with 4012, the same tab's with 4013) |
| Not-yet-joined sockets | at most `MAX_PLAYERS` at once (→ 4009); each is closed 60 s after its last `join` attempt and 3 minutes after it connected (→ `join_timeout`, 4000) |
| Wrong host passcodes | 5 per network (IPv4 address, or IPv6 /64) per 15 minutes, then 15 minutes locked (→ 429). Checked in the Directory, reserved before the check, so parallel guesses cannot exceed it. The count is saved at the 4th wrong passcode and the lockout at the 5th, so a restart of the Directory does not reset them (up to 500 such rows a day; beyond that, memory only). There is no limit across all networks: one person could then block sign-in for everyone. |
| PIN guesses | per network per 10 minutes: `PIN_MISS_LIMIT` (100) lookups or joins of PINs that do not exist, unknown player tokens, or ended games; and 2 × `MAX_PLAYERS` + 100 new joins. Over either limit, every lookup and new join from that network is refused (→ 429 / 4014, or 4010 for version-1 pages) unless it carries the room key (`k`) or a valid player token for that PIN; such callers are not counted either (a phone reconnecting with its token after the game was wiped is not guessing). The host of a PIN whose lookups were refused gets `notice` `pin_limited`. |
| Quiz body | 200 KB, 100 questions, text 400 chars (200 in a schema-1 quiz), option 80 chars, title 80 chars, explanation 400 chars, 10 accepted answers of 80 chars, picture description 150 chars (to host; the library also stores drafts, §12) |
| Typed answer | 80 characters |
| Pictures | 1 MB each as uploaded (the host page shrinks pictures to 1,600 px and under 1 MB first); JPEG, PNG, WebP or GIF by their first bytes; 5,000 per library, used or not; removed 8 days after no quiz uses them (§14) |
| Quiz library | 500 quizzes, 1,000 counting the Trash; 50 quizzes per batch read; Trash kept 30 days |
| Focus check | a leave under 1 s is not counted; ms away clamped to the question's time limit + 1 s; 100 leaves and 1,000 blocked copies per report at most; 3 saved rows per player per question while it is open, the rest saved when it closes |
| Nickname | 20 characters after trim; a leading `= + - @` is removed |
| Name changes | 3 student renames per player; host renames unlimited |
| Frame size | 4,096 bytes of UTF-8 (→ 1009) |
| Frames per socket | 10/s sustained, burst 20 (→ 4008) |
| Rooms per IP per UTC day | 30 (→ 429); signed-in hosts skip this cap |
| Rooms per day (whole deployment) | 300 (→ 429) |
| Intro | 3,000 ms |
| Grace after deadline | 1,000 ms |
| Tally coalescing | ≤ 4 frames/s to host |
| Roster / lobby coalescing | ≤ 2 frames/s |

## 10. What is stored, and for how long

SQLite in the Room: one `room` row (pin, hostToken, phase, q, opensAt,
deadline, settings, quiz incl. answer key, locked, timestamps) and one
`players` row per player (pid, token, nick, joinedAt, kicked, score,
elapsedTotal, streak, answers JSON `{"3":{"c":1,"ms":1834,"p":967}}`,
renames, joinId), and, when Focus check is on (§13), one `away` row per
player and checked question that had something to report (times left, ms
away, blocked copies, whether the page was too old to report) plus the list of
checked questions on the `room` row.
Nothing else. No IPs, no user agents, no logs (observability stays off in
`wrangler.jsonc`). Everything is deleted at `ack_results` or by TTL. The
only lasting copy is the CSV the host downloads.

The Directory counts rooms created per UTC day for the whole deployment,
deleted within 48 hours (see §7). Before protocol 2 it also kept a per-network
count under a truncated SHA-256 of `<IP_HASH_KEY>|<UTC date>|<client IP>`;
creating a room now needs the passcode and signed-in hosts skip that cap, so
no such row is written any more. Nothing about players is ever hashed or kept.

Since protocol 2 the Directory also keeps, per PIN, which library (host
passcode) created the room. For wrong passcodes it keeps, only from the 4th
wrong passcode from one network until 15 minutes later, one row with a keyed
hash of the network (IPv4 address or IPv6 /64, keyed with `IP_HASH_KEY`, or
`SESSION_KEY` when that is not set, so it cannot be reversed by trying every
address) and the count or lockout end. An alarm deletes each row when its
15 minutes are over. PIN-guess counters are held in memory only and vanish
when the object restarts. The host's session is an HttpOnly cookie on the
host's browser (30 days, renewed while used, at most 90 days; or, on a shared
computer, until the browser closes, after 4 hours without use, or after 12
hours in all); the server stores no sessions.

Once a day, just after the free daily allowance resets (00:05 UTC), the
Directory asks every room that still holds a PIN to re-arm its idle-wipe
alarm if a failed save lost it, so the wipe still happens.

The quiz library (§12, D1) keeps every quiz the host saves (title, questions,
answer key, version, content hash, times) until it is deleted, and 30 days in
the Trash after that. It holds no student data: games, names and answers stay
in the Room and are deleted with it. The host page caches the library in its
localStorage (§12).

Question pictures (§14) are in an R2 bucket in the same Cloudflare account,
named by the SHA-256 of the file, with a D1 record of their size and type and
of which quizzes use them. A picture is deleted 8 days after the last quiz
(live or in the Trash) stopped using it. Students' phones load pictures from
`/api/images/…` on this site only; nothing about who loaded them is kept.
A typed answer is stored like any answer, in the Room, and deleted with it.

## 11. Protocol 4 and compatibility

Pages say which protocol they speak: `v=4` in the WebSocket URL; the server
puts `proto: 4` in every `sync`.

- **Version-3 pages** (cached from Phase 2, for the hour or so after a deploy)
  play a quiz of one-right-answer questions as before (they ignore `type`,
  `right`, `image`, `explanation`, `shuffle`). A room whose quiz uses another
  type refuses them, players and hosts, with `4010` "This page is out of
  date. Reload it …", since they could neither show nor answer those
  questions. They report for Focus check like version-4 pages.
- **Version-2 pages** (cached from Phase 1, for the hour or so after a deploy)
  work as before: they ignore `focus`, `focusQs`, `recap`, `played` and `tied`.
  They cannot send `away`, so while Focus check is on, a player on such a page
  is shown as "not checked" for each checked question (§13), never as clean.
- **Version-1 pages** (from before protocol 2) are no longer served: a player
  socket without `v` is closed with `4010` "This page is out of date. Reload it
  to join the game." (a code those pages do not retry, and they show the
  reason); a host socket without `v` gets the same, signed in or not. The name
  fallbacks they needed (silent spun names, re-spin by `join`, the 3-socket
  rule, full `roster` frames) are gone, so `nameMode` and `allowRename` hold
  for every player.
- **The host token is no longer accepted in the URL.** A host socket is ready
  when the Worker vouches for its session, or after an `auth` frame.
- **A version-4 page meeting an older server** (a rolled-back deployment):
  the host page sees `proto` below 4, says the server is older and hides
  shuffle; hosting a quiz with the new types fails with the server's readable
  `400` (an older server does not know them), and its pictures do not load.
  A phone never sends a `text` or list `choice` unless the question's `type`
  asks for one, which an older server never sends.
- **A version-3 page meeting an older server** (a rolled-back deployment):
  pages send `away` only for a question the room checked (listed in
  `focusQs`, or opened while `settings.focusCheck` was true), which a
  protocol-2 server never reports, so it never receives the frame. The
  host page sees `proto: 2` and hides Focus check. A 404 from `/api/library`
  means the library is not there: the host page keeps its local copy, saves
  nothing, and says the server is older (Export all still works).
- **New error codes and messages** read sensibly on old pages (old pages toast
  the message of an unknown `error`).
- **Deploys and rollbacks** use `--durable-objects-code-update-mode immediate`
  so the Worker and the Durable Objects switch together; for the few seconds a
  new Worker version propagates, every new RPC parameter is optional and the
  objects accept the previous Worker's calls. The Room trusts a host only with
  a valid signed header (HMAC, 60 s) or the host token, never with a header a
  client could send.

## 12. Quiz library

The signed-in teacher's quizzes live in D1 (binding `DB`, one database per
Cloudflare account; schema in `migrations/`, applied by the deploy workflows
before `wrangler deploy`). Every request needs the session cookie and the
stricter Origin rule (§1); `401 {"error":"sign_in"}` signed out. Every `200`,
`409` and `422` reply carries `generation` (below); errors about the request
itself (`400`, `404`, `405`, `413`) and the Worker's `401`/`403`/`503` do not. `503 {"error":"library_unavailable","message"}`
when D1 cannot be reached or its daily free allowance is used up; the page
keeps the change and retries.

| Request | Reply |
|---|---|
| `GET /api/library` | `200 {generation, quizzes:[Meta], trash:[Meta], limits:{maxLive, maxRows, trashDays}}`, newest first. Quizzes deleted more than 30 days ago are purged first. |
| `GET /api/library/quizzes?ids=a,b,…` | `200 {generation, quizzes:[Meta + body]}`, at most 50 ids (`400 bad_ids` otherwise). Unknown ids are left out. |
| `PUT /api/library/quizzes/:id` body `{baseVersion, generation, quiz}` | `baseVersion` 0 creates, otherwise it must be the version the change was made from (saving a quiz that is in the Trash takes it out, and counts against the 500-quiz limit like a restore). `200 {generation, quiz: Meta}`. `409 {error:"conflict", message, server: Meta + body}` when the server's version differs (another device saved first); `409 {error:"gone", server:null}` when the quiz was deleted for good; `409 {error:"newer_schema", server}` when the stored quiz has a newer `schema` (never lowered); `422 {error:"library_full"}`; `413` over 200 KB; `400 invalid_quiz` / `bad_base_version`. Saving unchanged content is not a write (the version stays). Saving a quiz that is in the Trash takes it out. |
| `DELETE /api/library/quizzes/:id?baseVersion=n&generation=g` | Moves it to the Trash (version + 1). `409 conflict` with the server copy if `n` is not current. Deleting again is harmless. |
| `DELETE /api/library/quizzes/:id?forever=1` | Removes a quiz that is in the Trash; `409 not_in_trash` if it is not (move it to the Trash first). Already gone: `200`. |
| `POST /api/library/quizzes/:id/restore` | Takes it out of the Trash (version + 1); `422 library_full` if there is no room. |

Every change (PUT, DELETE, restore) also names the `generation` the page's copy
is from (body field or query parameter; optional, but the host page always
sends it once it knows it). A different generation is refused with
`409 {error:"generation_changed", generation}`, so an edit made before a
restore from backup can never land on the restored library.

`Meta = {id, title, schema, questions, version, hash, updatedAt, deletedAt}`.
`id` matches `^[A-Za-z0-9_-]{1,64}$` (the page makes UUIDs; the sample quiz
has a fixed id). `body` is the quiz exactly as saved: the shape is checked
(title text, at most 100 question objects with text, a known `type`, up to 4
option texts or, for `typein`, up to 10 accepted answers, numeric `correct`
(a list for `multi`; none for `typein` and `poll`), `timeLimit`, `points`),
the content is not, so drafts with problems can be saved; `POST /api/room`
still checks everything before a game. A body using a schema-2 field must say
`schema: 2` (`400 invalid_quiz` otherwise), so a Phase 2 page can never edit it;
long text alone is allowed in schema 1, as Phase 2 pages saved such drafts.
Fields this version does not know are kept, and a body with a schema newer
than 2 is stored without looking inside. Each save also records which pictures
the quiz uses (§14), in the same transaction. `hash` is the SHA-256 (hex) of the stored
body text, `JSON.stringify(body)`; the page computes the same to match quizzes.

**Generation.** One number per library, in table `library`. It changes only
when the database is restored from a backup (the production workflow's
`d1-restore` sets it to the restore time). A page that sees a generation other
than the one its cache was built from copies its cache and unsent changes to
`hompub-quiz:backup:<time>`, drops them, reloads from the server and says so,
instead of re-applying edits made before the restore.

**The host page's cache** (localStorage): `hompub-quiz:lib:index`
(`{generation, ids, syncedAt}`), one `hompub-quiz:lib:q:<id>` per quiz
(`{id, version, hash, body, updatedAt, deletedAt, exportedAt}`, the last
version the server confirmed plus local edits), and `hompub-quiz:lib:outbox`
(unsent changes, at most one per quiz). The page works offline from the cache
and sends the outbox when it can, one tab at a time (Web Locks, with a
fallback), merging other tabs' changes through `storage` events. A `409` opens
"Keep mine / Use theirs / Save as copy"; nothing is overwritten silently.

**Moving quizzes from Phase 1.** The first time a signed-in Phase 2 page loads
in a browser whose `hompub-quiz:quizzes` key holds quizzes and has no
`hompub-quiz:lib:migrated` marker, it uploads them: by id (same content: skip;
different content: the conflict dialog; missing: create), entries without an id
by content hash. It shows what was imported, sets the marker only after the
server confirmed, and leaves the old key untouched.

## 13. Focus check

An optional setting (`settings.focusCheck`, off by default) that tells the
teacher when a student left the quiz page during a question. It is a signal,
not proof: nothing is automatic and scores never change.

- **Which questions:** only those opened while it was on (`focusQs` in `sync`).
  It cannot be switched during `intro` or `open`.
- **Phones (version 3):** while it is on, every screen says "Your teacher can
  see if you leave this page during a question." During an open checked
  question the page counts the times it was hidden (`visibilitychange`) or lost
  focus (`blur`) for 1 s or more and the time away, stopping when the question
  closed (`closedAt` in `result` and `recap`; never past the next question's intro),
  and, when questions are shown on phones, blocks selecting, copying and the
  long-press menu on the question and options, counting blocked copies. On
  return (or when it reconnects) it sends `away` with the running totals for
  that question; an unsent report is kept in sessionStorage.
- **Server:** accepts `away` only from a joined player, for a checked question
  that is open or just closed (or the previous one during the next `intro`,
  `open` or `closed`). Totals only go up and are clamped (§9). A player whose page is
  older than version 3 gets `old: true` for each checked question. Hosts get
  `focus` frames, the full list in `sync`, and the CSV columns (§8). The
  records live in the Room's `away` table and are deleted with the game.
- **Host:** All players marks each student ("left 2×, 14 s", "not checked");
  after a checked question the stage shows only a count ("3 students left the
  page during this question"), never names.
- **Limits:** it cannot see a second device, a photo of the projector or a
  friend's help; a screen lock, a call or a notification looks the same as
  switching app; some Android split-screen and floating-window modes are not
  detected; a page the browser closes entirely reports nothing; screenshots
  cannot be blocked.

## 14. Pictures

A question may show one picture (`image` in the quiz, §2): on the projector,
and on phones when the question is shown there. Files live in the R2 bucket
bound as `IMAGES` (one private bucket per Cloudflare account; no public URL),
recorded in D1 tables `images` and `quiz_images` (`migrations/0002_images.sql`).

| Request | Reply |
|---|---|
| `POST /api/images`, the body is the file | Signed in, page Origin (as §12). The format comes from the file's first bytes (JPEG, PNG, WebP, GIF; SVG and anything else → `415 not_an_image`); over 1 MB → `413 image_too_large`; a library that has 5,000 pictures → `422 images_full`. `200 {key, url, bytes, type}`. `key` is `<sha256 hex>.<webp\|jpg\|png\|gif>`, so the same file always gets the same key and is stored once. |
| `GET` / `HEAD /api/images/:key` | No sign-in (phones). `200` with the type from the key, `Cache-Control: public, max-age=31536000, immutable` (a key never changes), an `ETag`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'` and `Cross-Origin-Resource-Policy: same-origin`; `304` for a matching `If-None-Match`; `404` for an unknown or malformed key. |

A phone learns a picture's URL only from the question view, so not before the
question starts; the key says nothing about the picture to someone who does not
have the file.

**The host page** shrinks a chosen picture to at most 1,600 px on its longer
side and 1 MB (WebP, or JPEG on white where the browser cannot write WebP),
uploads it, and asks for a description (`alt`, read out to students who cannot
see it). Uploading needs sign-in. "Export" and "Export all" put each picture in
the file as a data URL beside its key; opening such a file uploads the
pictures again (signed in), or keeps the key when this server already has it.

**Which quizzes use a picture.** Every library save rewrites the quiz's
`quiz_images` rows in the same D1 transaction as the quiz (only if the stored
body is the one just written). At most once an hour, reading the list
(`GET /api/library`) removes the rows of quizzes deleted for good, marks
pictures no quiz uses (`images.unused_since`), clears the mark of pictures used
again, and deletes up to 90 pictures unused for more than 8 days: their rows
first, then the files. Eight days is longer than the 7 days a D1 Time Travel
restore can go back, so a restored quiz never lacks its picture. A new upload
counts as unused from then on, and an upload of a picture already stored starts
its 8 days again.
