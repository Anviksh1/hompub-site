# HomPub Quiz (pilot)

A live classroom quiz in the Kahoot style. The teacher runs it from a laptop
plugged into the projector; students answer on their own phones, a whole class
at once. Students join by typing a 6-digit PIN or scanning a QR code, pick a
name (or take a random two-word one, if the teacher allows it), and tap one of
four fixed shape-and-colour tiles — red triangle, blue diamond, yellow circle,
green square — before the timer runs out. One host, up to 400 players.

It follows the HomPub rule: no student accounts, no ads, no analytics. The
teacher signs in with one host passcode; a student is a
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
  public/import-text.js         Word (.docx) and plain-text → quiz parser, no dependencies; used by the host page
  public/template-questions.docx  the Word template teachers download from the host page
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
- **Secrets for local runs:** copy `.dev.vars.example` to `.dev.vars`
  (git-ignored). It holds a local-only `HOST_PASSCODE` (`local test passcode`)
  and `SESSION_KEY`, plus dev-only switches that are ignored unless
  `DEV_MODE="1"`: `DEV_TTL_SCALE` (shrink the idle wipe, e.g. `0.002`),
  `DEV_REPORT_ROWS` (count rows written), `DEV_CLIENT_IP_HEADER` (one address
  per simulated phone), `DEV_FAIL_WRITES_AFTER` (make saving fail) and
  `DEV_SKIP_HOST_VOUCH` (test the host `auth` frame). They never go in
  `wrangler.jsonc`; a unit test checks.
- `HQ_PASSCODE='local test passcode' npm run test:load` runs `test/load.mjs`:
  it signs in, creates a room against the dev
  server and drives 150 simulated players through a 20-question game, with a
  fifth of them dropping and reconnecting during every question and a few
  deliberately answering twice. It checks one welcome per player, a result for
  every connected player on every question, the points formula, that no frame
  carries the correct answer before reveal, duplicate refusals, tally sums,
  rankings and the CSV, and exits non-zero on any violation. Flags:
  `--url --players (up to 400) --questions --time-limit --answer-window --drop
  --join-burst --seed --quiz <file> --passcode --v1 <share of version-1 phones>
  --ip-per-bot --dev-stats --verbose --help` (e.g.
  `node test/load.mjs --players 12 --questions 2` for a 30-second smoke run).
  Delete `.wrangler/state/` to reset local rooms, counters and lockouts.
- `npm run typecheck` runs the TypeScript compiler over `src/`.
  `npm test` runs the unit tests: scoring, validation, the name filter and
  name rules, sessions, the Origin rule, the guess limiters, the idle-wipe
  timing, and the staging config.
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

Five variables in `wrangler.jsonc` → `vars`, read at request time. The
`env.staging` block repeats them exactly (bindings and vars do not inherit;
`test/config.test.mjs` fails if the two drift apart).

| Var | Default | Meaning |
|---|---|---|
| `MAX_PLAYERS` | `400` | players per room; the 401st gets close code 4009 |
| `ROOM_CREATE_PER_IP_PER_DAY` | `30` | rooms one public IP may create per UTC day. Signed-in hosts skip this cap, so in practice only the next line applies. |
| `ROOM_CREATE_PER_DAY` | `300` | rooms the whole deployment may create per UTC day |
| `PIN_MISS_LIMIT` | `100` | wrong PINs (and unknown tokens) one network may try in 10 minutes before lookups from it are refused |
| `ALLOWED_ORIGINS` | *(empty)* | extra origins allowed to call `/api/*`. Empty is correct when pages and API share a hostname, which they do here. |

Change a value, redeploy. Keep `observability.enabled` at `false`; see
[Privacy](#privacy-commitments-the-code-keeps).

### Secrets: the host passcode

Hosting a game needs the **host passcode**. Editing quizzes does not. Three
secrets live on each Worker (production and staging separately), never in the
repository or the chat:

| Secret | What it is |
|---|---|
| `HOST_PASSCODE` | what you type on the host page to sign in. **At least 12 characters**; sign-in refuses to work with a shorter one and says so. A good one: `openssl rand -base64 18`, or four random words. |
| `SESSION_KEY` | 32 random bytes that sign every session cookie. Never typed. `openssl rand -base64 32` |
| `IP_HASH_KEY` | optional: keys the hashes kept for the abuse limits, so they cannot be brute-forced back to an address. Any long random string. |

Set them in the Cloudflare dashboard: **Workers & Pages → the Worker →
Settings → Variables and Secrets → Add → type Secret**. From a laptop the same
is `npx wrangler secret put HOST_PASSCODE` (add `--env staging` for staging).
Use a different passcode on staging.

After sign-in the host page keeps an HttpOnly, Secure, SameSite=Strict cookie
(`__Host-hq_session`) for 30 days, renewed while you use it, never longer than
90 days. **"This is a shared computer"** at sign-in makes it last only until
the browser closes, after 4 hours without use (the open page does not count as
use), and after 12 hours at most. **Sign out on this device** is in the
header and on the Game over screen; it clears this browser's cookie and the
game from this screen (the game itself keeps running; sign in to resume it).

**Changing the passcode** (for example after a laptop is lost):

1. Outside class time: changing a secret deploys a new version, which drops
   every live connection for a few seconds.
2. Dashboard → **hompub-quiz → Settings → Variables and Secrets** → the
   `HOST_PASSCODE` row → **Edit** → paste the new passcode → **Deploy**.
3. Every device is signed out at once, because the cookie's signing key is
   derived from the passcode. Sign in again on the host laptop.
4. To sign out every device **without** changing the passcode, change
   `SESSION_KEY` the same way.
5. Write down that you rotated it. A later "rollback-version" in the
   production workflow would bring back the secrets of that older version;
   "redeploy-ref" keeps the current ones (see below).

Five wrong passcodes from one network in 15 minutes lock sign-in from that
network for 15 minutes; a restart of the referee does not reset the count. A
student on the school network could trigger that; hosts already signed in are
not affected. There is deliberately no limit across all networks, so nobody can
lock out every teacher at once; a passcode of at least 12 random characters is
what makes guessing hopeless.

**Why a passcode and not Cloudflare Access.** Cloudflare Access could put an
email one-time-code login in front of the host page, and its free tier covers
50 users. But it protects whole hostnames or paths at the edge, so on
`workers.dev` it would also block the WebSocket upgrades students need unless
`/play`, `/api/room/*` and the static files are carved out by hand; it adds an
email round trip at the projector before every class; and it needs a Zero
Trust account set up. A single passcode checked by the Worker, with a
wrong-guess limit and an HttpOnly cookie, covers one teacher with none of that.
Access becomes the better choice if several staff need individual logins or an
audit trail.

## Deploying through GitHub: staging first, production on approval

Two workflows, two Cloudflare accounts:

| | Staging | Production |
|---|---|---|
| Workflow | `.github/workflows/deploy-quiz-staging.yml` | `.github/workflows/deploy-quiz.yml` |
| Runs | on every push to the work branch that changes `quiz/` (and by hand once the file is on `main`) | **only** from Actions → *Deploy quiz (production)* → **Run workflow**, then a reviewer presses **Approve** |
| Worker | `hompub-quiz-staging`, in a second free Cloudflare account | `hompub-quiz` |
| Credentials | GitHub Environment `staging` (branch-restricted) | GitHub Environment `production` (branch `main`, required reviewer, administrators may not bypass) |

A merge to `main` deploys nothing. The staging account is separate so staging
tests never spend the free daily allowance a live class needs, and so the
staging token cannot reach production. Each token is created **inside its own
account**, or lists only that account under *Account Resources*.

**Setting up** (once):

1. In each Cloudflare account: **My Profile → API Tokens → Create Token →
   Edit Cloudflare Workers**, add **Account → D1 → Edit**, restrict *Account
   Resources* and *Zone Resources* to that account only, and check the summary
   before creating it.
2. A new account needs its `workers.dev` subdomain chosen once in the
   dashboard (**Workers & Pages**); a non-interactive deploy cannot do it.
   Before deploying, the staging workflow reads that subdomain with the
   staging credentials and stops if it is missing or is the production
   account's, so a mixed-up token cannot deploy staging into production.
3. GitHub → repository **Settings → Environments**: create `production`
   (required reviewer: you; untick *Allow administrators to bypass*;
   deployment branch `main`) and `staging` (deployment branch: the work
   branch). Give each its own `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.
4. Delete the repository-level `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`: repository secrets reach every branch's workflows.
5. Set the Worker secrets (previous section) on both Workers.

**Production run.** Choose `deploy` and a release tag such as `quiz-phase-1`.
The job type-checks, tests, deploys with
`--durable-objects-code-update-mode immediate` (the Worker and the Durable
Objects switch together), prints the new version id in the run summary, and
tags the deployed commit.

**Rolling back.**

- `redeploy-ref` with the previous tag (or a 40-character commit id) deploys
  that code again and **keeps the current secrets**. This is the normal way.
  The code before Phase 1 is commit `0198fcdd705647ed59398d804d3c168f6968e47b`
  (Cloudflare version `45648569-84ab-48b2-a6e8-dc7653045895`).
- `rollback-version` with a version id is Cloudflare's own rollback. Each
  version keeps the secrets it was created with, so it can bring back an old
  passcode; it runs only with *accept_secret_revert* ticked.
- Without GitHub: dashboard → **Workers & Pages → hompub-quiz → Deployments**
  → the earlier version → **Rollback**.
- **Rolling back to before Phase 1** (commit `0198fcd…`) also brings back that
  version's storage rules: it keeps a per-network room-creation counter again
  (a hash of the date and the host's IP, keyed only if `IP_HASH_KEY` is set, so
  set it first), and it leaves any wrong-passcode rows from the last 15 minutes
  in place until the next deploy of Phase 1 deletes them. The privacy page
  (`apps/hompub-quiz/privacy.html`) describes Phase 1: for a rollback that
  lasts, put its previous text back too.
- Static pages roll back with the Worker version.

### Deploys interrupt live games

A deploy restarts every Durable Object and drops every open WebSocket. Phones
and the host page reconnect on their own within a few seconds and the server
timers keep running meanwhile, but a question that was open loses those seconds
for everyone. **Deploy outside school hours.** The same holds for changing a
secret.

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

So the Free plan carries **roughly 40 full games a day** of that size,
bounded by rows written and object duration, not by requests.

For a **300 × 30** lecture the binding cap is rows written: measured locally
at 9,323 rows up to the podium (one row per answer, three per join because of
the two indexes, one per phase change and per alarm), about **10,000–11,000
per game** with the wipe, so **about 8–9 such games a day** (6–7 at 400
players). Requests (~3–5k), duration (~340 GB-s) and WebSockets (at most 850
per room, against a limit of 32,768) are far from their caps. Running out of
writes stops the game until 00:00 UTC (05:30 IST); the host page then says so
in words instead of freezing. Staging is in its own account, so its tests do
not count against these. Smaller classes and shorter
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

### Measured in the load harness (local Wrangler runtime)

Phase 1, 2026-10-20 (`HQ_PASSCODE=… node test/load.mjs …`, 10 % of phones as
version-1 pages):

| Run | Result |
|---|---|
| 300 phones × 30 questions, 20 % drop per question, `--dev-stats` | PASS. Join p50 14 ms; ack p50 2.5 ms (8,329 answers); 1,798 reconnects; 9,323 rows written up to the podium; host roster deltas 364 KB |
| 400 phones from one address (a school network), 2 questions, no drops | PASS: no PIN-guess limit hit |
| 200 joins, host roster traffic | 10 frames, 17.2 KB with deltas, against 10 frames, 99.9 KB for the full roster before Phase 1 |

The 2026-10-19 figures below are for the code before Phase 1.

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
  so Cloudflare keeps no request logs or traces for this Worker. The only
  console output in `src/` is an unexpected-error message from a Room timer,
  which carries no player data and is kept nowhere.
- **No IPs, no nicknames logged.** The Room stores no IP address, user agent or
  device detail. Creating a room needs the passcode, so the daily room counter
  is kept for the whole site only, with no IP-derived key (deleted after 48
  hours). IP-derived values: from the
  4th wrong passcode from one network, one keyed hash of the network (keyed
  with `IP_HASH_KEY`, or `SESSION_KEY` without it), deleted by an alarm when
  its 15 minutes end; and the PIN-guess counters, which live in memory only
  and are never written down.
- **The host's session** is an HttpOnly cookie in the host's own browser; the
  server stores no sessions and students get no cookies.
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
- **If the laptop dies mid-game**, open the host page on any device, sign in,
  and press **Resume game NNNNNN** under "A game you started is still live";
  the room keeps closing questions on its own timers meanwhile. A refreshed
  host tab goes straight back to the stage on its own. Students see "Waiting
  for the host" only between questions.
- **Names.** "Typed names only" is the default; "Typed or random" and "Random
  only" are the alternatives, changeable in the lobby (Options). Students can
  change their own name up to three times in the lobby; it switches off at
  Start, and you can switch it on again from Options. You can rename anyone at
  any time from **All players** (in Options, and on the Game over screen), so
  the CSV has the right names.
- **Removing a student** keeps their answers so far in the CSV, marked
  `removed`. They could join again under another name unless you lock the
  room: use **Remove and lock**.
- **"Some students cannot join by typing the PIN"** on the stage means one
  network sent too many wrong PINs, so typed PINs from it are refused for a few
  minutes. Ask those students to scan the QR code, which always works.
- **Several teachers, one school:** hosting needs the passcode, and signed-in
  hosts skip the per-IP cap, so only the whole-site cap of 300 rooms a day
  applies.

## Writing questions in Word

You do not have to type a quiz into the host page. Write it in Microsoft Word,
Google Docs or any text editor, then on the host page press **Import Word or
text** and choose the file (`.docx` or `.txt`), or press **Paste questions**
and paste the text. A preview shows what was understood — the title, each
question, its options with the correct one ticked, the timer and the points,
and a list of anything to check — and **Add to my quizzes** opens the result in
the editor. Nothing is uploaded: the file is read inside the browser
(`public/import-text.js` unzips the `.docx` and reads its text itself), and the
quiz is stored in the browser like any other.

The quickest start is the **Download the Word template** link on the host page
(`public/template-questions.docx`): a document already laid out in the format
below, with two example questions to overwrite.

### The format

One question per block, a blank line between blocks. The first line of a block
is the question; the lines under it are the options. Numbers and letters are
optional but help. This is a complete two-question quiz:

```
Cell biology — week 6

1. Which organelle makes ATP?
A. Ribosome
B. Mitochondrion *
C. Golgi body
D. Nucleus

2. Water boils at 100 °C at sea level. (10s)
- True
- False
Answer: A
```

- **Title.** A first line that is not a question or an option (no `?`, no
  `1.`/`A.` prefix) is the quiz title. Without one, the file name is used, or
  "Pasted quiz".
- **Question line.** `1.`, `1)`, `(1)`, `Q1.`, `Q1:`, `Question 1:` and `Q.`
  prefixes are recognised and removed. A line ending in `?` is a question even
  without a number, and so is the first line of a block. Word's automatic
  numbering is read as well, so a numbered list in Word works without typing
  the numbers.
- **Option lines.** `A.` `A)` `(A)` `a.` `a)` `[A]`, or a bullet (`-` `•` `–` `*`
  `○`). Two to four options per question; a fifth is dropped with a warning.
  Word's bullet lists work too.
- **Marking the correct answer** — any one of these:
  - a `*` at the start or end of the option: `B. Mitochondrion *` or `B. *Mitochondrion`;
  - `✓`, `✔`, `(correct)`, `(right)`, `[x]`, `(x)` or `<-- correct` at the end of the option;
  - a line after the options: `Answer: B`, `Ans: b`, `Correct: B`, `Key: B`, or
    the option's text, `Answer: Mitochondrion` (case and punctuation do not matter).

  **Bold does not count** — bold is invisible once the text is extracted, so a
  question whose answer is only marked in bold comes through with no answer
  marked. That is not fatal: the preview lists it, the question is still
  imported, and the editor asks you to tick the correct option before hosting.
- **Time limit.** `(30s)` at the end of the question line, or a line `Time: 30`,
  `Timer: 30 s` or `30 seconds` after the options. Snapped to the nearest
  allowed value: 5, 10, 15, 20, 30, 60, 90, 120 or 240 seconds. Default 20.
- **Points.** A line `Points: 2000` or `double points` for 2000; `Points: 0`,
  `no points` or `survey` for a survey question nobody scores on. Default 1000.
- **Limits**, the same as the editor's: title up to 80 characters, question text
  200, each option 80 (longer text is cut, with a warning); up to 100 questions
  (extra ones are skipped, with a warning); a question with fewer than two
  options is skipped and named in the warnings. Files larger than 5 MB are
  refused — a quiz is text, so remove the pictures or paste the text instead.
- **Files.** `.docx` (Word 2007 or later, and Google Docs → Download → Word) and
  plain text (`.txt`, `.md`). Old `.doc` files, PDFs and `.pages` are not read:
  save as `.docx` first, or copy the text and use **Paste questions**. Tables are
  read cell by cell, one cell per line.

After importing, export a `.json` copy as usual: the Word file is not a backup
of the quiz as the editor sees it (it may lack the ticked answers), and the
`.json` is what the host page imports back losslessly.

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
