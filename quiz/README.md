# HomPub Quiz (pilot)

A live classroom quiz in the Kahoot style. The teacher runs it from a laptop
plugged into the projector; students answer on their own phones, a whole class
at once. Students join by typing a 6-digit PIN or scanning a QR code, pick a
nickname (or spin a random two-word one), and tap one of four fixed
shape-and-colour tiles — red triangle, blue diamond, yellow circle, green
square — before the timer runs out. One host, up to 250 players.

It follows the HomPub rule: no accounts, no ads, no analytics. A student is a
nickname and a score for the length of one lesson; the small server that keeps
score — we call it the referee — deletes everything when the teacher confirms
the results download, or on a timer if the teacher forgets. The only lasting
copy of a game is the CSV the teacher downloads. The referee is open source
(MIT) so a school can run its own copy and own the data end to end.

## Architecture in five lines

1. The join, player and host pages are plain HTML/CSS/JS served as
   [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
   — free, unlimited, never counted against the request budget.
2. One Cloudflare Worker (`src/worker.ts`) handles only `/api/*`: it validates
   input, rejects what it can cheaply, and routes the rest.
3. One SQLite-backed Durable Object per game (`src/room.ts`, the `Room`) is the
   referee: it owns the phase, the clock, the answers and the scores.
4. A single `Directory` Durable Object (`src/directory.ts`) maps PINs to rooms
   and enforces the rooms-per-day caps.
5. Nothing persists after a wipe: `deleteAll()` on the room, PIN released,
   every socket closed. No database, no logs, nothing to back up.

Everything the pieces agree on — URLs, frames, phases, scoring, reconnect rules,
limits — is in [PROTOCOL.md](PROTOCOL.md). If code and that document disagree,
one of them is wrong and gets fixed in the same commit.

## Where it runs, and why not GitHub Pages

The rest of this repository is a static site on GitHub Pages. The quiz cannot
be: a live game is a WebSocket connection per phone that stays open for the
whole lesson, and a server has to hold those connections and keep score. GitHub
Pages serves files only.

So the code lives on GitHub, deploys *from* GitHub (see
[Deploying through GitHub](#deploying-through-github)), and *runs* on
Cloudflare Workers, whose Free plan is enough for a pilot (numbers in
[What the free plan gives you](#what-the-free-plan-gives-you)). Hosting costs
$0. The one optional cost is a domain, which the site already plans to buy.

## Repository layout

```
quiz/
  PROTOCOL.md        the contract every piece is built against
  wrangler.jsonc     Cloudflare config: assets, Durable Objects, vars, observability off
  src/worker.ts      edge entry point: /api/* routing, origin check, echo endpoint
  src/room.ts        Room Durable Object: one game, SQLite-backed, the referee
  src/directory.ts   Directory Durable Object: PIN table and daily caps
  src/shared.ts      validation, scoring, nickname filter (pure functions, unit-tested)
  src/env.ts         the Env binding types
  public/            index.html (join), play.html/.js/.css (phone), host.html/.js/.css (laptop)
  public/vendor/     qrcode.js (qrcode-generator, MIT) — the only vendored library
  test/              shared.test.ts (unit tests), load.mjs (150-client load harness), sample-quiz.json
```

## Running locally

You need [Node.js](https://nodejs.org/) 22.18 or newer (the unit tests use Node's
built-in TypeScript support) and a terminal.

```
cd quiz
npm install
npm run dev
```

`npm run dev` starts Wrangler's local runtime at <http://localhost:8787>, with
Durable Objects emulated on your machine. Nothing talks to Cloudflare and no
account is needed.

- Open <http://localhost:8787/host> for the host page.
- To join from a phone, both devices must be on the same Wi-Fi. Find the
  laptop's LAN address (`ipconfig` on Windows, `ifconfig` or `ip addr` on
  macOS/Linux — something like `192.168.1.23`), then open
  `http://192.168.1.23:8787/play?pin=XXXXXX` on the phone. Plain `http://` and
  `ws://` are fine here; the pages pick the WebSocket scheme from the page's
  own protocol, so the same code runs over `https://` + `wss://` in production.
  If the phone cannot connect, your laptop firewall is probably blocking port
  8787 or the Wi-Fi isolates clients from each other.
- `npm run test:load` runs `test/load.mjs`: it creates a room against the dev
  server and drives 150 simulated players through a 20-question game, with a
  fifth of them dropping and reconnecting during every question and a few
  deliberately answering twice. It checks one welcome per player, a result for
  every connected player on every question, the points formula, that no frame
  carries the correct answer before reveal, duplicate refusals, tally sums,
  rankings and the CSV, and exits non-zero on any violation. Flags:
  `--url --players --questions --time-limit --answer-window --drop --join-burst
  --seed --quiz <file> --verbose --help` (e.g. `node test/load.mjs --players 12 --questions 2` for a
  30-second smoke run). The Directory's per-IP cap of 30 rooms per UTC day
  applies locally too; delete `.wrangler/state/` to reset it.
- `npm run typecheck` runs the TypeScript compiler over `src/`.
  `npm test` runs the unit tests for scoring, validation and the nickname filter.
  `npm run check` does both. The deploy workflow runs them before every deploy.

Rooms created locally live in `.wrangler/state/` (git-ignored) and vanish when
you delete that folder.

## Deploying to your own free Cloudflare account

Step by step, assuming you have never used Cloudflare.

### 1. Create the account

Sign up at <https://dash.cloudflare.com/sign-up> with an email address and a
password, then confirm the email. **No payment method is needed** for the
Workers Free plan, and nothing in this project requires a paid feature:

- Durable Objects have been available on the Free plan since April 2025, but
  only *SQLite-backed* classes. This project uses exactly those
  (`new_sqlite_classes` in `wrangler.jsonc`), so it deploys on Free.
- Static assets, WebSockets and the Durable Object alarm API are all included.

The first time you open **Workers & Pages** in the dashboard it asks you to
choose a `workers.dev` subdomain — a name like `yourname`. Pick one; every
Worker you deploy gets a free hostname under it.

### 2. Log in from the terminal

```
cd quiz
npm install
npx wrangler login
```

A browser tab opens asking you to allow Wrangler (Cloudflare's command-line
tool) to act on your account. Allow it and close the tab. The token is stored
in your user profile; you do not need to repeat this.

### 3. Deploy

```
npx wrangler deploy
```

The first deploy creates a Worker called `hompub-quiz`, uploads the pages in
`public/` as static assets, and runs the `v1` migration that registers the
`Room` and `Directory` Durable Object classes. It prints the URL:

```
https://hompub-quiz.<yourname>.workers.dev
```

That is the live referee. Later deploys are the same command; each one takes
about half a minute.

### 4. Try it

Open `https://hompub-quiz.<yourname>.workers.dev/host`, press **Check my
network**, create a quiz, start a game and join it from a phone on mobile data.
Students join at `https://hompub-quiz.<yourname>.workers.dev/` by typing the
PIN, or scan the QR code on the projector.

### 5. Put it on your own subdomain before a real class

`*.workers.dev` hostnames are often blocked outright by school web filters,
which categorise the whole domain as "hosting" or "unknown". A game that works
on your phone at home can be unreachable in the classroom. Before a real class,
give the referee a name under a domain you own, for example `quiz.hompub.com`:

1. The domain's DNS must be on Cloudflare. Either register it through
   [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/)
   (sold at cost, ~$10/yr — the same purchase the
   [site README](../README.md#custom-domain-hompubcom-or-similar--1011year-the-only-cost)
   already plans) or add an existing domain with **Add a site** (free plan) and
   point its nameservers at Cloudflare.
2. In the dashboard: **Workers & Pages → hompub-quiz → Settings → Domains &
   Routes → Add → Custom Domain**, type `quiz.hompub.com`, save. Cloudflare
   creates the DNS record and the TLS certificate itself; it is live within a
   few minutes. No code change is needed — the pages use whatever hostname they
   are served from.
3. If the main site stays on GitHub Pages, its `A` and `CNAME` records from the
   site README now live in Cloudflare's DNS panel instead of the registrar's.
   Set them to **DNS only** (grey cloud) so GitHub can issue its certificate.

The domain is the only cost. The referee itself stays on the Free plan.

### Configuration

Four variables in `wrangler.jsonc` → `vars`, read at request time:

| Var | Default | Meaning |
|---|---|---|
| `MAX_PLAYERS` | `250` | players per room; the 251st gets close code 4009 |
| `ROOM_CREATE_PER_IP_PER_DAY` | `30` | rooms one public IP may create per UTC day. A school usually has **one** public IP shared by every teacher — raise this if several classes run on the same day. |
| `ROOM_CREATE_PER_DAY` | `300` | rooms the whole deployment may create per UTC day |
| `ALLOWED_ORIGINS` | *(empty)* | extra origins allowed to call `/api/*`. Empty is correct when pages and API share a hostname, which they do here. |

Change a value, redeploy. Keep `observability.enabled` at `false`; see
[Privacy](#privacy-commitments-the-code-keeps).

### Optional secret: `IP_HASH_KEY`

The per-IP room-creation cap stores a truncated SHA-256 of
`<IP_HASH_KEY>|<UTC date>|<IP>` for up to 48 hours. Without the key that value
is a pseudonym HomPub never links back; with it, it cannot be brute-forced
back to an address. Set it once per deployment from a laptop:

```
npx wrangler secret put IP_HASH_KEY     # paste any long random string
```

## Deploying through GitHub

Once the secrets below are in place, every push to `main` that changes a file
under `quiz/` (other than Markdown) deploys automatically through
[`.github/workflows/deploy-quiz.yml`](../.github/workflows/deploy-quiz.yml).
You can also start a deploy by hand: repository **Actions → Deploy quiz → Run
workflow**.

The workflow checks out the repository, installs Node 22, runs `npm ci` in
`quiz/`, then `npm run typecheck` and `npm test`, and only if those pass runs
`cloudflare/wrangler-action@v3` with `workingDirectory: quiz`, which executes
`wrangler deploy` with your account's credentials. The Wrangler version is the
one pinned in `package-lock.json`, so the workflow and your laptop deploy with
the same tool.

**Do the first deploy from your laptop** (previous section). It registers your
`workers.dev` subdomain interactively, which a non-interactive workflow cannot
do. After that the workflow handles every deploy.

### Create the API token

1. Open <https://dash.cloudflare.com/profile/api-tokens> (dashboard → profile
   icon, top right → **My Profile → API Tokens**).
2. **Create Token**, then **Use template** next to **Edit Cloudflare Workers**.
3. Under *Account Resources* choose your account. Under *Zone Resources* choose
   the domain you attached in step 5 above, or *All zones* — the token only
   needs zone access to manage a custom domain; `workers.dev` alone needs none.
4. **Continue to summary → Create Token.** Copy the token now; it is shown
   exactly once. Treat it like a password: it can deploy and delete Workers on
   your account.

### Find the account ID

In the dashboard, open **Workers & Pages**: the **Account ID** is in the
right-hand column of the overview page. It is also the first path segment of
every dashboard URL (`dash.cloudflare.com/<account id>/...`), and
`npx wrangler whoami` prints it. It is an identifier, not a secret, but the
workflow reads it from a secret for tidiness.

### Add both as repository secrets

GitHub repository → **Settings → Secrets and variables → Actions → New
repository secret**:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token you copied |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID |

Then push a change under `quiz/` to `main`, or run the workflow by hand, and
watch it under **Actions**. If it fails on the deploy step, the message names
which of the two is wrong.

### Deploys interrupt live games

A deploy restarts every Durable Object and drops every open WebSocket. Phones
and the host page reconnect on their own within a few seconds and the server
timers keep running meanwhile, but a question that was open loses those seconds
for everyone. **Merge to `main` outside school hours.** For the same reason the
workflow runs only on `main`, never on pull-request branches: a branch push can
never touch the live referee. Leave `concurrency` in the workflow as it is, so
two pushes in a row deploy one after the other rather than at once.

## What the free plan gives you

As of **2026-10-19**. Cloudflare changes these figures several times a year;
the current ones are at
[developers.cloudflare.com/workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/)
and
[developers.cloudflare.com/durable-objects/platform/pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

| Workers Free | Daily cap |
|---|---|
| Worker requests (`/api/*` only; static pages are free) | 100,000 |
| Durable Object requests | 100,000 |
| Durable Object duration | 13,000 GB-s |
| SQLite rows written | 100,000 |
| SQLite rows read | 5,000,000 |
| SQLite storage | 5 GB total |
| Inbound WebSocket messages | billed 20 : 1 — 20 incoming messages count as one request |
| Outbound WebSocket messages | free |

Our estimate for one full game, **100 students × 20 questions**:

| Per game | Estimate | Games/day at the cap |
|---|---|---|
| Worker requests | ~250 | ~400 |
| Durable Object requests | ~380 | ~260 |
| SQLite rows written | ~2,500 | **~40** |
| Durable Object duration | 160–340 GB-s | **~40–80** |

So the Free plan carries **roughly 40 full games a day**, bounded by rows
written and object duration, not by requests. Smaller classes and shorter
quizzes cost proportionally less. Keepalive `ping`s are answered at the edge
without waking the room, and the static pages are not metered at all.

If a cap is hit, that operation fails until 00:00 UTC — a room creation returns
an error, or an open question's writes fail — and **nothing is billed**; the
Free plan has no overage. If the pilot ever outgrows it, Workers Paid is
$5/month and raises every cap above.

These are estimates from reasoning about the protocol and from the load
harness. After the first real sessions, replace them with the numbers under
**Workers & Pages → hompub-quiz → Metrics** and **Durable Objects → Metrics**
in the dashboard.

### Measured in the load harness (local Wrangler runtime, 2026-10-19)

`node test/load.mjs --players 150 --questions 20 --time-limit 5 --drop 0.2`,
150 simulated phones against `wrangler dev` on one laptop-class machine:

| | |
|---|---|
| Join, connect → welcome | p50 12 ms · p95 25 ms · max 37 ms |
| Answer, send → ack | p50 2.4 ms · p95 4.9 ms · max 23 ms (2,773 answers) |
| Reconnect → sync | p50 8 ms · p95 12 ms (599 reconnects) |
| Accepted answers per question | 135–142 of 150 (30 phones dropped mid-question each time) |
| Frames | 3,850 sent by clients, 15,470 received, 5.2 MB down for the whole game |
| Checks | all pass: no answer key before reveal, 150/150 duplicates refused, CSV and ranks consistent |

Local numbers say nothing about Cloudflare's network latency or billing, but
they do show the single-threaded room has two orders of magnitude of headroom
over a real class answering within two seconds.

## Privacy commitments the code keeps

The policy students and parents read is
[apps/hompub-quiz/privacy.html](../apps/hompub-quiz/privacy.html). The code
holds it up as follows:

- **Observability off.** `wrangler.jsonc` sets `observability.enabled: false`,
  so Cloudflare keeps no request logs or traces for this Worker. Nothing in
  `src/` calls `console.log`.
- **No IPs, no nicknames logged.** The Room stores no IP address, user agent or
  device detail. The only IP-derived value anywhere is the one the
  room-creation cap needs: a truncated SHA-256 of `<UTC day>|<host's IP>`,
  kept by the Directory and deleted after 48 hours. Students' IPs are never
  read.
- **Wipe on ack or TTL.** The room is `deleteAll()`-ed when the host confirms
  the CSV (`ack_results`), or 2 h after the last frame (idle sockets do not
  extend it), or 30 min after End game if the host never confirms. A room left
  on the podium stays on the 2 h clock and the host receives the CSV before it
  is wiped, so results are never destroyed unsent.
  The PIN is released at the same moment.
- **No third-party requests from the student page.** `index.html` and
  `play.html` load no fonts, scripts or images from anywhere but the referee;
  the QR library is vendored. (The host page still loads fonts from Google —
  see the roadmap.)
- **The answer key never reaches a player.** Players receive the correct option
  only in the `result` frame after a question closes; `sync` frames to a
  player-tagged socket carry neither the key nor the other players' answers.
- **What is kept on devices** is in the host's and students' own browser
  storage only: the host's quizzes, PIN and host token; a student's reconnect
  token for the current PIN, cleared when the game ends.

## Operating notes for a teacher

- **The day before, on the classroom Wi-Fi:** open the host page and press
  **Check my network**. It opens a WebSocket to `/api/echo` and reports whether
  the school network lets live connections through. Then join a game from a
  phone on the school Wi-Fi too. Find out in the staff room, not in front of
  the class.
- **Keep the laptop plugged in** and set it not to sleep. The host page asks
  the browser to keep the screen awake, but the operating system's power
  settings win.
- **Export your quizzes as `.json`.** Quizzes live only in the browser's
  localStorage on that one laptop. School laptops lose it — profile resets,
  "clear data on exit" policies, shared sign-ins. Export after every edit;
  import on the day. The host page nags about this for a reason.
- **If WebSockets are blocked:** connect the **host laptop only** to the guest
  network or to your phone's hotspot. Students do not connect to the laptop,
  they connect to the referee on the internet, so they can stay on the school
  Wi-Fi — or use their own data if that is blocked too; the pages are a few
  tens of kilobytes. Also ask IT to allow WebSocket connections to the quiz
  hostname: a request for `quiz.yourschool.example` is easy to grant, one for
  `*.workers.dev` usually is not.
- **Scoring on a slow network.** In speed mode a phone on bad Wi-Fi loses a few
  points per question because its answer arrives later. Accuracy mode (one
  point per correct answer) or coarse mode (speed rounded to whole seconds)
  removes most of that effect. Choose in the lobby.
- **Results are a CSV download.** After the podium, press **End game**; the
  CSV (`hompub-quiz-<pin>-<date>.csv`: rank, nickname, score, correct count,
  one column per question) downloads to the laptop. Save it somewhere before
  confirming the wipe. If you never confirm, the room deletes itself 30 minutes
  after End game; the file has already been downloaded by then. A room left on
  the podium screen is kept for 2 hours, and the CSV is sent to the host page
  before it is deleted.
- **If the laptop dies mid-game**, open the host page in any browser and press
  **Resume game**; the room keeps closing questions on its own timers
  meanwhile. Students see "Waiting for the host" only between questions.
- **Several teachers, one school:** the per-IP cap of 30 rooms per day is
  shared by everyone behind the school's public IP. Raise
  `ROOM_CREATE_PER_IP_PER_DAY` if that bites.

## Protocol

[PROTOCOL.md](PROTOCOL.md) is the full contract: URLs, JSON frames, phases,
the scoring formula, reconnect and resume rules, timers and TTLs, the CSV
format, limits, and exactly what is stored. Read it before changing anything
in `src/` or `public/`.

## Not yet (roadmap)

- Turnstile on room creation, so a script cannot burn the daily room budget.
- A WAF rate-limit rule in front of `/api/room` as a second line of defence.
- Self-hosted fonts on the host page (the student page already loads nothing
  external).
- A LAN transport, so a room can run fully offline on a classroom hotspot.
- A native Android host app.

## License

MIT — see [LICENSE](LICENSE). The vendored `public/vendor/qrcode.js`
(qrcode-generator) is MIT as well.
