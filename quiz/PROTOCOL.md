# HomPub Quiz — protocol and contract (v1, pilot)

This document is the single source of truth for every component in `quiz/`:
the Cloudflare Worker (`src/worker.ts`), the `Room` Durable Object
(`src/room.ts`), the `Directory` Durable Object (`src/directory.ts`), the
player page (`public/play.html`), the host page (`public/host.html`), the join
page (`public/index.html`) and the load harness (`test/load.mjs`). If code and
this document disagree, fix one of them in the same commit.

## 1. Roles, pages, URLs

One **host** (the teacher, on a laptop connected to a projector) and up to
`MAX_PLAYERS` (default 250) **players** (students on their phones). Everything
is served from one hostname by one Worker. Static files live in `public/` and
are served as Workers Static Assets (free, never counted against the request
budget). Only `/api/*` invokes the Worker.

| URL | What |
|---|---|
| `GET /` | Join page: enter a 6-digit PIN → navigates to `/play?pin=XXXXXX` |
| `GET /play?pin=XXXXXX` | Player page (phone). Also the target of the QR code. |
| `GET /host` | Host page (laptop): quiz editor, lobby, game control, results |
| `GET /api/health` | `200 {"ok":true,"now":<ms>,"version":"0.1.1"}` |
| `GET /api/echo` | WebSocket echo (handled in the Worker, no Durable Object). Used by the network preflight. Any text frame is echoed back verbatim. Closes after 60 s. |
| `POST /api/room` | Create a room. Body: `{"quiz": Quiz, "settings"?: Settings}`. Response `200 {"pin":"123456","hostToken":"<32 hex>","joinUrl":"https://<host>/play?pin=123456"}`. Errors: `400 {"error":"..."}` (invalid quiz), `413` (body > 200 KB), `429 {"error":"too_many_rooms"}` (per-IP or global daily cap), `503 {"error":"no_pin_available"}`. |
| `GET /api/room/:pin` | Room summary for the join page: `200 {"pin","phase","playerCount","locked","lateJoin","nicknameMode","title"}` or `404 {"error":"not_found"}`. |
| `GET /api/room/:pin/ws?role=host&token=<hostToken>` | Host WebSocket |
| `GET /api/room/:pin/ws?role=player[&token=<playerToken>]` | Player WebSocket. `token` present = reconnect attempt. |

`:pin` must match `^[1-9][0-9]{5}$`. Any other `/api/*` path → `404 {"error":"not_found"}`.
Non-upgrade requests to a `/ws` URL → `426`.

**Origin check (Worker, all `/api/*`):** if an `Origin` header is present it
must equal the request's own origin (`scheme://host[:port]`) or be listed in
the `ALLOWED_ORIGINS` var (comma-separated). Otherwise `403`. Requests without
an `Origin` header (curl, the load harness) are allowed.

**Dev:** `npm run dev` → `http://localhost:8787`. WebSockets are `ws://` there
and `wss://` in production; clients derive the scheme from `location.protocol`.

## 2. Data shapes

### Quiz (authored on the host page, stored in the host's localStorage, sent once in `POST /api/room`)

```jsonc
{
  "title": "Cell biology — week 6",       // 1..80 chars
  "questions": [                           // 1..100 questions
    {
      "text": "Which organelle makes ATP?",  // 1..200 chars
      "options": ["Ribosome", "Mitochondrion", "Golgi body", "Nucleus"], // 2..4 strings, each 1..80 chars
      "correct": 1,                          // index into options
      "timeLimit": 20,                       // seconds, one of 5,10,15,20,30,60,90,120,240
      "points": 1000                         // 0 | 1000 | 2000  (0 = survey question, nobody scores)
    }
  ]
}
```

Option slots are fixed to Kahoot's shape/colour pairs so colour-blind players
can play by shape: index 0 = red triangle, 1 = blue diamond, 2 = yellow
circle, 3 = green square. Letters A–D are used in CSV and text.

### Settings (host may change until `start`; `showOnDevices` and `lateJoin` may change any time)

```jsonc
{
  "mode": "speed",          // "speed" (default, Kahoot formula) | "accuracy" (1 point per correct) | "coarse" (speed with elapsed rounded up to whole seconds)
  "showOnDevices": false,   // false = phones show only the four shapes; question text and options are on the projector
  "lateJoin": true,         // allow joining after start (joiners score 0 for past questions)
  "earlyClose": false,      // close the question as soon as every player who was connected when it opened has answered
  "nicknameMode": "free"    // "free" = players type a nickname (filtered) | "spin" = players must use the two-word name spinner
}
```

### Phases

`lobby → intro → open → closed → intro → … → closed → podium → ended`

- `lobby`: players join. Host presses **Start**.
- `intro` (3 s, server-timed): "Question 4 of 20, get ready". Everyone learns `opensAt` before the clock starts, so broadcast order cannot favour anyone.
- `open`: answers accepted from `opensAt` until `deadline = opensAt + timeLimit*1000`, plus a 1,000 ms grace for frames in flight (a grace answer is scored as if `elapsed = timeLimit*1000`). Phones switch to the answer buttons at `opensAt` on the shared clock without waiting for the `open` frame; an `answer` that reaches the server at or after `opensAt` while it is still in `intro` opens the question on the spot. Closes on the server timer, on host **Close**, or (if `earlyClose`) when every eligible player has answered.
- `closed`: correct answer revealed; players see their own result and rank; host sees counts, fastest correct player and the top 10. Host presses **Next** (→ `intro` of the next question, or → `podium` after the last).
- `podium`: top 3 on the projector, everyone sees their own final rank. Host presses **End game**.
- `ended`: host receives the results CSV; players see "Game over, nothing about this game is kept". The room is wiped when the host sends `ack_results`, or by TTL.

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

Rank: by `score` descending, ties broken by lower `elapsedTotal` (sum of
`elapsed` over *correct* answers), then by earlier `joinedAt`. `streak` counts
consecutive correct answers and is display-only (no bonus points).

One answer per player per question: enforced in the Room by an in-memory set
for the open question and by the persisted `answers` JSON. A second tab or a
reconnect with the same token cannot answer twice (`ack.accepted=false,
reason="duplicate"`).

## 4. WebSocket framing

- Text frames containing one JSON object with a string field `t` (type).
- Exception: a player or host may send the literal text `ping`; the edge
  replies `pong` without waking the Room (auto-response). Clients send it
  every 25 s to keep NATs and proxies happy.
- Frame > 4,096 bytes → server closes with **1009**.
- More than 10 frames/s sustained (burst allowance 20) → server closes with **4008**.
- Server close codes: `4000` bad request (also `Join timed out` for a player socket that sends no `join` within 60 s) · `4001` bad host token · `4003` kicked · `4004` room not found / already ended / unknown player token · `4008` rate limited · `4009` room full · `4010` room locked / late join disabled · `1009` frame too large. Clients **must not** auto-reconnect after 4001, 4003, 4004, 4009, 4010; show the message instead. Any other close → reconnect with backoff.

### 4.1 Client → server (player)

| Frame | When | Notes |
|---|---|---|
| `{"t":"join","nick":"Priya"}` | first connection, no token | nick is trimmed, control chars stripped, max 20 chars; empty → server assigns a spun name; profanity (deny-list) → silently replaced by a spun name; duplicate → numeric suffix (`Priya 2`). If `settings.nicknameMode == "spin"` the nick field is ignored and a spun name is assigned. |
| `{"t":"join","spin":true}` | first connection | player asked for a random two-word name (adjective + animal, e.g. `Brave Otter`). Up to 3 spins: each further `join` with `spin` before the first `answer` replaces the name. |
| `{"t":"answer","q":3,"choice":1}` | phase `open` | `q` must equal the current question index; `choice` an integer in `[0, optionCount)`. Refusal reasons are checked in this order: wrong `q` or not open/closed → `closed`; phase `closed` → `late`; bad `choice` → `invalid`; already answered → `duplicate`. |

A reconnecting player (`?token=`) sends nothing; the server replies with `sync`.

### 4.2 Client → server (host)

| Frame | Allowed in phase | Effect |
|---|---|---|
| `{"t":"start"}` | lobby | → `intro` of question 0 (allowed with 0 players, for testing) |
| `{"t":"next"}` | closed | → `intro` of q+1, or `podium` after the last question |
| `{"t":"close"}` | open | close the question now |
| `{"t":"end"}` | podium (also allowed from any phase as an abort) | → `ended`; host receives `results_csv`; players receive `ended` |
| `{"t":"ack_results"}` | ended | host confirms it has the CSV → room wiped (`deleteAll`), host receives `wiped`, all sockets closed with 4004 |
| `{"t":"kick","pid":"..."}` | any | player's token is banned, their sockets closed with 4003, they are removed from the roster |
| `{"t":"lock","on":true}` | any | locked rooms reject new players with 4010 (reconnects still work) |
| `{"t":"settings","settings":{...partial...}}` | any (`mode`, `earlyClose`, `nicknameMode` only in lobby) | server replies with `settings` to host and, if `showOnDevices` changed, to players |

Anything not allowed in the current phase → `{"t":"error","code":"bad_phase","message":"..."}`, no state change.

### 4.3 Server → client

Every frame has `t`. Frames with times carry `serverNow` (ms since epoch, server clock).

**`sync`** — full snapshot. Sent to every socket right after it is accepted (first join gets `welcome` *then* `sync`), and whenever the server prefers a snapshot over a delta. Clients should be able to render any screen from `sync` alone.

```jsonc
{
  "t": "sync", "serverNow": 1760000000000,
  "role": "player" | "host",
  "pin": "123456", "title": "Cell biology — week 6",
  "phase": "open", "q": 3, "total": 20,
  "locked": false, "settings": { ...Settings... }, "playerCount": 97,
  "question": null | {                       // present in intro / open / closed
    "q": 3, "total": 20, "optionCount": 4, "timeLimit": 20, "points": 1000,
    "opensAt": 1760000003000, "deadline": 1760000023000,
    "text": "...", "options": ["..."]        // host always; players only when settings.showOnDevices
  },
  // ---- player only ----
  "me": { "pid": "p_ab12", "nick": "Priya", "score": 2310, "rank": 12, "streak": 2,
          "answered": true, "choice": 1,       // answered/choice refer to the current question
          "spins": 1 },                        // name spins used so far (max 3)
  "result": { ...same fields as the result frame, without t... },   // only in phase closed
  "podium": { "top": [{"nick":"...","score":1234}, ...], "you": {"score": 2310, "rank": 12} }, // podium / ended
  // ---- host only ----
  "roster": [ {"pid":"p_ab12","nick":"Priya","connected":true,"score":2310,"answered":true}, ... ],
  "tally": { "counts": [12, 60, 3, 9], "answered": 84, "expected": 97 },          // intro/open/closed
  "reveal": { ...same fields as the reveal frame, without t... },                   // closed
  "leaderboard": [ {"pid":"...","nick":"...","score":2310,"delta":967}, ... ],      // top 10, closed/podium/ended
  "hostToken": "<32 hex>"                                                           // so a resumed host can persist it
}
```

**Player frames**

| Frame | Fields |
|---|---|
| `welcome` | `pid, token, nick, pin` — store `{pin, token, pid, nick}` in localStorage key `hompub-quiz:player:<pin>` |
| `lobby` | `playerCount, locked` (coalesced, ≤ 2/s) |
| `intro` | `question` (same object as in `sync`), `serverNow` |
| `open` | `q, deadline, serverNow` |
| `ack` | `q, accepted:boolean, reason?: "late" \| "duplicate" \| "closed" \| "invalid"` |
| `result` | `q, correct:int, choice:int\|null, points:int, score:int, rank:int, streak:int, playerCount:int` (sent to every player at close, including those who did not answer) |
| `podium` | `top:[{nick,score}] (≤3), you:{score,rank}, playerCount` |
| `ended` | — (clear the localStorage entry; show "Game over. Nothing about this game is kept.") |
| `kicked` | — (then close 4003) |
| `settings` | `settings`, plus `question` (the same object as in `sync`, present in intro/open/closed) — sent when the host changes `showOnDevices`; clients update settings and question and keep any in-progress answer UI |
| `error` | `code, message` |

**Host frames**

| Frame | Fields |
|---|---|
| `roster` | `players:[{pid,nick,connected,score,answered}], playerCount` (coalesced, ≤ 2/s) |
| `intro` | `question` (with text and options), `serverNow` |
| `open` | `q, deadline, serverNow` |
| `tally` | `q, counts:int[], answered, expected` (coalesced, ≤ 4/s while open) |
| `reveal` | `q, correct, counts:int[], answered, expected, fastest:{nick, ms}\|null, leaderboard:[{pid,nick,score,delta}] (top 10), playerCount` |
| `podium` | `top:[{pid,nick,score}] (≤3), leaderboard (top 10), playerCount` |
| `results_csv` | `csv:string, filename:string` |
| `wiped` | — (then close 4004) |
| `settings` | `settings, locked` |
| `error` | `code, message` |

Players never receive `correct` before `closed`. The Room never sends the quiz's answer key to a player-tagged socket.

## 5. Reconnect and resume

- **Player:** keeps `{pin, token, pid, nick}` in localStorage. On socket close (except the no-retry codes), on `visibilitychange` → visible, and on `online`, reconnect to `/api/room/<pin>/ws?role=player&token=<token>` with backoff 500 ms → 8 s (×2, ±30 % jitter). The server replies `sync`. Older sockets for the same `pid` (a second tab) keep receiving frames; answers are de-duplicated per player, so a second tab cannot answer twice. A student offline for a whole question scores 0 for it. Players also request a Screen Wake Lock after joining (ignored where unsupported).
- **Unknown or stale player token** (the room was wiped and the PIN reused, or storage is from another deployment): the server accepts the socket and closes it with `4004` and reason `Unknown player token; join again`. The player page clears its stored entry for that PIN and shows the join screen.
- **Host:** keeps `{pin, hostToken, title}` in localStorage key `hompub-quiz:host`. The host page offers **Resume game** when that key exists. While the host is disconnected the server timers still close questions; phones show "Waiting for the host" only in `closed`. Any browser with the hostToken can take over; a host that connects while the phase is `ended` receives `sync` and then `results_csv` again, so the results file is never lost to a reload.
- **Deploys** restart every Durable Object and drop every socket; clients reconnect and resync within seconds. Deploy outside school hours.

## 6. Timers, hibernation, TTL (Room internals)

- `intro → open` and `open → closed` use `setTimeout` inside the Room plus `ctx.storage.setAlarm(deadline + 1500)` as a durable backstop. The alarm handler re-reads the room row and closes the question if it is still open and past its deadline; otherwise it handles TTL below.
- Between questions the Room has no pending timers and hibernates (WebSocket Hibernation API; sockets stay attached at the edge). Each socket's attachment is `{pid, role}` only; all authoritative state is in SQLite and reloaded in the constructor.
- TTL (alarm): wipe the room 2 h after the last frame (any direction; keepalive `ping`s do not count, and idle attached sockets do not extend it), or 30 min after `ended` without `ack_results`. A room left on `podium` stays on the 2 h clock, and if that expires the host sockets receive `results_csv` immediately before the wipe, so results are never destroyed unsent. "Wipe" = `deleteAll()`, release the PIN in the Directory (only if it still maps to this room), close all sockets with 4004.
- Auto-response: `ping` → `pong` is registered with `setWebSocketAutoResponse` so keepalives never wake the object.

## 7. Directory (PIN → room id)

A single `Directory` Durable Object (`idFromName("global")`) owns the PIN
table, so rooms can use `newUniqueId()` and therefore live in the data
center nearest the host that created them (a Durable Object never moves).

- `POST /allocate {"roomId": "<hex>", "ipHash": "<hex>"}` → `200 {"pin":"123456"}` · `429 {"error":"too_many_rooms"}` (per-IP cap `ROOM_CREATE_PER_IP_PER_DAY`, default 30, or global cap `ROOM_CREATE_PER_DAY`, default 300) · `503` no free PIN after 20 tries.
- `GET /lookup/:pin` → `200 {"roomId": "<hex>"}` · `404`. Entries older than 24 h are treated as expired.
- `POST /release {"pin": "123456", "roomId": "<hex>"}` → `200`; a no-op if the PIN has since been re-issued to another room.
- Housekeeping: expired PINs and creation counters older than yesterday are deleted at most hourly on traffic and from a daily alarm just after 00:00 UTC, so a counter written on day D is gone by 00:05 UTC on D+2.

## 8. CSV

```
rank,nickname,score,correct,answered,q1,q2,...,qN
1,Priya,18345,19,20,B 967,A 1000,,C 812,...
```
`qN` = `<letter> <points>` for an answered question (letter A–D of the choice), empty if unanswered.
Filename: `hompub-quiz-<pin>-<YYYYMMDD>.csv`.

## 9. Limits (pilot defaults; all enforced server-side)

| Thing | Limit |
|---|---|
| Players per room | `MAX_PLAYERS` = 250 joined players; at most 2 × that many player sockets including not-yet-joined ones and second tabs (→ 4009) |
| Join timeout | a player socket that sends no `join` within 60 s is closed with 4000 |
| Quiz body | 200 KB, 100 questions, text 200 chars, option 80 chars, title 80 chars |
| Nickname | 20 chars after trim |
| Frame size | 4,096 bytes of UTF-8 (→ 1009) |
| Frames per socket | 10/s sustained, burst 20 (→ 4008) |
| Rooms per IP per UTC day | 30 (→ 429) |
| Rooms per day (whole deployment) | 300 (→ 429) |
| Intro | 3,000 ms |
| Grace after deadline | 1,000 ms |
| Tally coalescing | ≤ 4 frames/s to host |
| Roster / lobby coalescing | ≤ 2 frames/s |

## 10. What is stored, and for how long

SQLite in the Room: one `room` row (pin, hostToken, phase, q, opensAt,
deadline, settings, quiz incl. answer key, locked, timestamps) and one
`players` row per player (pid, token, nick, joinedAt, kicked, score,
elapsedTotal, streak, answers JSON `{"3":{"c":1,"ms":1834,"p":967}}`).
Nothing else. No IPs, no user agents, no logs (observability stays off in
`wrangler.jsonc`). Everything is deleted at `ack_results` or by TTL. The
only lasting copy is the CSV the host downloads.

The Directory keeps one IP-derived value for abuse limiting: a truncated
SHA-256 of `<IP_HASH_KEY secret>|<UTC date>|<client IP>`, with a per-day
creation count. With the optional `IP_HASH_KEY` secret set (`wrangler secret
put IP_HASH_KEY`) it cannot be brute-forced back to an address; without it,
it is a pseudonym that HomPub never links back. It cannot be linked across
days, and counters are deleted within 48 hours (see §7). Nothing about
players is ever hashed or kept.
