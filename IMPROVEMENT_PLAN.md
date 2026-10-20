# HomPub Quiz — improvement pass

HomPub Quiz is my Kahoot-like live quiz on Cloudflare Workers. The projector uses /host and students use their phones at /play. Client files are host.html/js/css, index.html, play.html/js, and import-text.js. The protocol is in quiz/PROTOCOL.md.

## How to work
1. Read the repo: routes, Durable Object/room logic, editor, storage, import, CSV export. Summarise the architecture in under 15 lines.
2. Do Phase 0 (no code). Then enter plan mode and propose a plan for Phases 1–5 that includes whatever Phase 0 found. Wait for my approval before writing code, and again before each later phase.
3. Make one commit per phase. Run the type-check and tests (add tests where a setup exists). End each phase with:
   - what changed;
   - what I should check by hand on a phone;
   - any risks.
4. Do not break existing flows: hosting, joining, all 3 scoring modes, late joiners, lock room, kick, resume host, .json/Word import/export, and CSV-then-wipe. Existing localStorage quizzes and .json exports must still load.
5. Never invent APIs; check Cloudflare docs or the installed types. Keep PROTOCOL.md in sync, and version the protocol if old clients could break mid-game.
6. A live test with 200 bots already showed that scoring, answer validation, no answer leakage, de-duplication of "next", the profanity filter, and CSV `=` stripping all work. Do not rewrite them.
7. **Deploy safely.** I use this app in live classes.
   - Set up a staging Worker (a separate wrangler environment with its own D1 database and secrets) and deploy every phase there first. I test on staging before anything goes to production.
   - Never deploy to production without asking me.
   - All D1 schema changes go through wrangler migrations.
   - For each phase, write down how to roll back: the previous Worker version and how to undo the database change. Check D1's backup/restore options in the Cloudflare docs and tell me what we can rely on.

## Phase 0 — Walkthrough audit (findings only, no code)
Small UX gaps matter as much as big features. Example: a student who got a random name could never switch back to their typed name. Run the app locally. Walk through every flow as a host on a laptop and as a student at 360×640 and 390×844. List each gap as: flow → what happens → what should happen → severity.

**Student flows — check at least:**
- PIN entry:
  - a wrong PIN;
  - a PIN pasted with spaces or dashes;
  - a PIN for a game that has ended;
  - opening the join link from a QR scan inside the WhatsApp or Instagram in-app browser.
- Nickname:
  - typed, random, filtered and duplicate names;
  - changing the name afterwards;
  - typing on a Hindi or Devanagari keyboard;
  - very long names.
- Joining:
  - joining late;
  - joining when the room is locked or full;
  - being kicked;
  - the game ending while still in the lobby.
- Connection and device:
  - phone locked, app switched away or network lost mid-question, then coming back;
  - page refreshed;
  - Back button pressed;
  - a second tab opened.
- Answering:
  - tapping twice;
  - tapping just as the timer ends;
  - what the screen says after the timer runs out with no answer;
  - what happens if the student is not connected at the reveal.
- Display:
  - screen rotation;
  - very small phones;
  - large system font / zoom;
  - light versus dark mode;
  - text readable in sunlight.

**Host flows — check at least:**
- Creating a quiz:
  - new quiz, edit, duplicate and delete;
  - undoing an accidental delete;
  - reordering questions;
  - an option removed after it was marked correct;
  - a quiz with only 1 valid question.
- Import:
  - .json, Word and paste;
  - an import that half-fails.
- Hosting:
  - starting with 0 players;
  - pressing Next/Close quickly;
  - changing settings mid-game;
  - ending early;
  - a laptop refresh or sleep mid-game.
- Projector:
  - readability from the back row at 1280×720 and 1920×1080;
  - fullscreen;
  - high contrast;
  - keyboard-only control (clicker).
- Results:
  - getting the CSV;
  - the CSV opened in Excel;
  - the CSV opened on a phone;
  - closing the tab before the wipe.

Also note any wording that is confusing, any dead-end screen with no way forward, and any error message that doesn't say what to do next.

## Phase 1 — Capacity, access and nicknames (needed for 300-player lectures)
- **Host passcode.** Add a host passcode as a Worker secret. Require it for POST /api/room, the host socket, and the quiz API (Phase 2). The passcode is also the account for the synced quiz library.
  - After it is entered, keep the session in an HttpOnly, Secure, SameSite=Strict cookie, not localStorage.
  - Add a "Sign out on this device" button.
  - **Limit wrong guesses:** about 5 failed attempts per IP per 15 minutes, then a lockout with a clear message. Compare passcodes in constant time.
  - **Changing the passcode:** when I change the secret, every existing session must stop working. Document the steps for changing it.
  - Compare it with Cloudflare Access in one paragraph and recommend one.
- **Daily quota.** Holders of the passcode skip the per-network quota (currently 30/network, 300/day). Find where it is enforced and ask me before changing the numbers.
- **Room size.** Find the room cap behind close code 4009. Make it at least 400 and document it. Also check that my Cloudflare plan's limits (Durable Object, WebSocket and D1 usage) cover a 300-player, 30-question game, and tell me if they don't.
- **Roster traffic.** Each join sends the full roster to the host: 200 joins produced 106 messages totaling 928 KB.
  - Add delta frames (`player_joined` / `player_left` / `player_updated`), with the full roster sent only on `sync`.
  - The lobby shows the player count, the last ~30 names, and a searchable "all players" panel for kick and rename.
- **Nicknames.**
  - **Name setting:** replace the current two options with a three-way host setting, changeable in the lobby:
    - "Typed names only" (default): the phone shows no random-name button.
    - "Typed or random".
    - "Random only".
  - **Student rename toggle:** "Students can change their name", on by default.
    - While it's on, the lobby screen on the phone shows the current name with an "Edit" button.
    - Renaming is allowed only in the lobby. Once the game starts it is locked unless the host turns the setting on again.
    - A student who got a random name, or whose typed name was filtered out, can type their own name again.
  - **Host rename:** the host can rename any player at any time from the player panel, including fixing names before the CSV.
  - **Server-side checks** (`{t:'rename', nick}`):
    - run the same profanity filter, 20-character limit and duplicate numbering as joining;
    - allow at most 3 student renames per player;
    - reply with a clear reason if a name is rejected, and keep the old name;
    - announce the change to the host with `player_updated`;
    - the CSV and leaderboard use the latest name.
  - **Profanity filter:**
    - match whole words, not substrings;
    - test that common Indian names pass, including Dikshit, Shital, Sushil, Kumari, Ashish, Harshita, Babita, Devanagari names and IAST spellings;
    - when a typed name is rejected, tell the student "Please choose another name" instead of silently giving them a random one.
- **Redrawing.** `render()` rebuilds the whole stage on every frame (`replaceChildren`). During a question, update only the counter, bars, and timer in place.
- **Connection checks.** The host ignores `pong`. If no pong arrives within ~10 s, reconnect. Check that play.js does the same.
- **Host resume.** After a refresh mid-game, resume the room automatically (it is currently a manual "Resume game" button).
- **PIN guessing.** Rate-limit `GET /api/room/:pin` and join attempts per IP.
- **Host token.** Move the host token out of the WebSocket URL into a first `{t:'auth'}` frame. Keep the old way working for one release.
- **Duplicate player sessions.** A player token used on a second device must close the first socket with a clear reason.

## Phase 2 — Synced quiz library and bugs
- **Database:** sync quizzes through the Worker using D1, not KV. KV can take up to ~60 s to show an edit made on another device; D1 reads are consistent and can list quizzes by updated time. If you disagree after reading the repo, say why before building.
- **Table:** `quizzes(id TEXT PK, title, body JSON, version INT, content_hash, updated_at, deleted_at)`. One library per passcode. Deletion is soft: deleted quizzes go to Trash and are purged after 30 days.
- **Conflicts:** every save sends the `version` it started from. If the server holds a newer one, reject with 409. The editor then offers "Keep mine / Use theirs / Save as copy". Never overwrite silently.
- **Offline cache:**
  - Keep a localStorage copy of the library, one key per quiz plus an index key.
  - Edits made offline go into a queue and sync on reconnect, using the same conflict rule.
  - Show a small status: "Synced" / "Saving…" / "Offline — will sync".
  - If a cached entry fails to parse, copy the raw text to `hompub-quiz:backup:<timestamp>` and show a banner. It must never turn into an empty list that gets saved back over the data.
  - Two open tabs must not overwrite each other.
- **Migration:** On first sign-in, upload the existing localStorage quizzes (`hompub-quiz:quizzes`) and skip any that already exist (match by content hash). Show what was imported. Keep the local copies until the upload is confirmed.
- **Hosting:** the room is still created from the quiz body as today. Game data remains temporary and is wiped after the CSV, exactly as it is now.
- **Wording:** update the "nothing kept" text on the host page and the join page. Quizzes are now stored on the server; games and student answers are still not kept.
- **Limits:** cap at about 500 quizzes per library and the existing size limit per quiz.
- **Export all / Import all** (.json) on the dashboard, as a backup independent of the server.
- **Load sample** must not create duplicates (use a sample ID).
- **New quiz** must not save a blank draft until the first edit.
- **Dialogs.** Replace every `window.confirm()` with an accessible in-page `<dialog>`, because native dialogs freeze the projector tab.
- **Page margin.** host.css `.page { padding: 24px 0 72px }` overrides `.wrap`'s 16 px side padding. Change it to `padding-block`, and check at 375 px and 1440 px.
- **Lobby layout at 1440×812.** Start must be visible without scrolling: use a sticky action bar and arrange the PIN, QR, and roster sensibly. The QR should be readable from the back of a hall, about 30–40 vh.
- Fix every Phase 0 finding marked High or Medium that is not covered elsewhere.

## Phase 3 — Question model (versioned schema, backward compatible with .json and Word/text import)
- **Optional fields:** an explanation, and an image with alt text (stored in R2, with size and type limits).
- **New types:**
  - multi-select (all-or-nothing or partial credit, as a setting);
  - type-in answer (several accepted answers, case- and diacritic-insensitive);
  - poll with no correct answer. Today points = 0 still requires a ✓ and shows "fastest" — fix this.
- **Update everything that touches questions:** editor, validation, host view, phone view, scoring and CSV.
- **Option order.** Optionally shuffle option order per player; the server maps choices back.
- **Sanskrit/Devanagari:**
  - Load Noto Serif/Sans Devanagari in every font stack.
  - import-text.js `clean()` must stop stripping U+200C/U+200D (ZWNJ/ZWJ).
  - Truncate with `Intl.Segmenter` so a cut never leaves a dangling virama or matra.
  - Raise the question limit from 200 to about 400 characters.
  - Check that IAST (ā ī ū ṛ ṣ ṇ ś ṃ) renders on the projector, on phones, and in the CSV.
- **Import parser:**
  - recognize `(क)` and `अ/ब/स/द` labels, `a)text` with no space, `A - text`, and `I.`–`IV.`;
  - keep a blank line inside a question;
  - handle Word tables;
  - warn when equations or images are dropped.
  - Add test fixtures for each case.

## Phase 4 — Teaching feedback and analytics
- After each reveal, show the explanation on the projector and on phones.
- Before the wipe, show a summary screen: % correct per question, average time, hardest questions, and the spread of answers per option.
- CSV changes:
  - UTF-8 with a BOM so Excel shows Devanagari correctly;
  - one row per player;
  - per-question columns for answer, correct, points, and time, plus totals;
  - a per-question summary section.
- Optional: a countdown/reveal sound (off by default), and the join URL shown under the PIN.

## Phase 5 — Hardening and re-check
- **Security headers:** add a CSP (self, Google Fonts, the origin's wss:), nosniff, and HSTS. Keep the existing X-Frame-Options and Referrer-Policy.
- **Screen readers:** announce "X of Y answered" and the reveal through aria-live at sensible intervals, and stop the connection pill from announcing again on every retry.
- **Load-test script** (Node, run locally against staging): host a room, join N bots, play 3 questions, check every bot gets a `result`, then wipe the room.
  - Cloudflare's Browser Integrity Check blocks non-browser clients (Error 1010). Do not spoof a user-agent. Add a WAF skip rule tied to a secret header that I control, and document it.
- **Re-run Phase 0.** Repeat the full walkthrough on the finished build, including the new question types, renaming and sync. Report anything still open.
