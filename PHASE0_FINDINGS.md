# HomPub Quiz — Phase 0 walkthrough findings

This walkthrough was run on 2026-10-20 against main @ 0198fcd plus the plan commit (d5e6878), server version 0.1.1. Six auditors drove the app on local `wrangler dev` with Playwright Chromium: the student at 360×640 and 390×844, plus 320×568, landscape 640×360 and 844×390, a 24 px font, 150 % zoom, dark mode and high contrast; the host at 1440×812 and the projector at 1280×720 and 1920×1080. A code-level review added node probes against the server. Findings only; no code was changed (screenshot and probe names below refer to the auditors' scratch folders, which are not in the repo).

## Architecture in brief

1. One Cloudflare Worker, `hompub-quiz` (`quiz/src/worker.ts`). The pages in `quiz/public` are Workers static assets (free, not metered); only `/api/*` runs Worker code.
2. Routes: `GET /api/health`; `WS /api/echo` (the "Check my network" test); `POST /api/room` (validate the quiz, apply the daily caps, create a room); `GET /api/room/:pin` (public summary); `WS /api/room/:pin/ws?role=host|player&token=…`.
3. Directory Durable Object (a single one): maps PIN → room id and enforces the room-creation caps (30 per network and 300 per day, set in `wrangler.jsonc`, counted by a day-salted IP hash).
4. Room Durable Object (one per game, SQLite storage, hibernating WebSockets tagged host or player) is the referee: one `room` row, one `players` row per player, each player's answers as JSON on that row, written once per answer before the ack.
5. Game loop: lobby → intro (3 s) → open → closed → … → podium → ended. Scoring runs on the server clock in speed, accuracy or coarse mode; timers have an alarm backstop; the room is wiped on `ack_results` or by an idle timeout. The 4009 "full" cap is `MAX_PLAYERS` (250).
6. Host page (`host.js`, ~1,870 lines): one state object and a `render()` that rebuilds the stage on every frame. Quizzes live only in the browser's localStorage (`hompub-quiz:quizzes`); the live game's key is in `hompub-quiz:host`.
7. Editor and import: .json import and export; Word, text and paste import through `import-text.js`, which reads .docx files in the browser.
8. Player page (`play.js`): a reconnecting socket holding a token in `hompub-quiz:player:<pin>`, rendering `sync` and delta frames into a fixed DOM. `index.html` is the PIN page.
9. CSV: built by the Room (`csv()`), sent to the host in a `results_csv` frame at End (again to a host that reconnects afterwards); the host page adds a BOM and downloads it, then the teacher confirms the wipe.
10. Deploy: GitHub Actions on every push to `main` that touches `quiz/` runs the type-check and tests, then `wrangler deploy` straight to production. There is no staging, no D1, no R2 and no host sign-in: anyone with the URL can host a game.
11. Tests: 9 unit tests (scoring, validation, names), 44 for the import parser, and a load harness (`quiz/test/load.mjs`).

## Summary

98 raw findings from six auditors, merged into 76.

| Severity | Count |
|---|---|
| High | 9 |
| Medium | 32 |
| Low | 35 |
| **Total** | **76** |

| Area | High | Medium | Low |
|---|---|---|---|
| Student — PIN entry | 0 | 2 | 1 |
| Student — Nickname | 0 | 3 | 0 |
| Student — Joining, locked, full, kicked, ended | 1 | 2 | 1 |
| Student — Connection and device | 1 | 3 | 2 |
| Student — Answering and results | 1 | 2 | 3 |
| Student — Display and accessibility | 0 | 4 | 5 |
| Host — Creating and editing quizzes | 2 | 5 | 4 |
| Host — Import | 0 | 3 | 5 |
| Host — Hosting a game | 2 | 3 | 6 |
| Host — Projector | 1 | 2 | 2 |
| Host — Results and CSV | 1 | 1 | 3 |
| Security, capacity and robustness | 0 | 2 | 3 |
| **Total** | **9** | **32** | **35** |

High findings:

- P0-07 — Kick does not keep the student out, but the dialog says "They cannot rejoin".
- P0-11 — A dead connection still shows "Connected" on the phone and on the host.
- P0-17 — "Answer sent" appears before the server confirms, and a lost answer is never noticed.
- P0-32 — A second host tab erases quizzes made in the first.
- P0-33 — Damaged saved data is overwritten, and a blank page hides Resume.
- P0-51 — A double-click or double Space skips the reveal.
- P0-52 — A live game cannot be resumed from another browser or device.
- P0-62 — Stage screens do not fit a 1280×720 projector (podium not even at 1080p).
- P0-67 — The 2-hour idle wipe deletes a live game without sending the results.

## Findings

### Student — PIN entry

**P0-01 · Medium · A pasted PIN with a space or dash is cut short**
PIN entry, pasting "123 456", "123-456", " 123456" or "PIN: 123456" → `maxlength="6"` cuts the pasted text to 6 characters before the digit filter runs, so 5 digits or fewer remain and the student is told "Enter all 6 digits of the PIN." → any common PIN format should land as 6 digits and auto-submit.
- Evidence: public/index.html:144 (maxlength), :177-185 (filter); s360-t1-06b-paste-space-join.png.
- Sources: student-join/F2

**P0-02 · Medium · A finished or wiped game reads like a mistyped PIN**
PIN of an ended game, or reopening /play after the wipe → before the wipe the page says "That game has already finished." with no next step. After the wipe it says "No game with that PIN.", the same as a typo. On /play a stale token gives "Your earlier session was not recognised", then "No game with that PIN" under a red "Disconnected" pill. A re-issued PIN lands on another teacher's join screen → say the game is over and what to do ("Ask your teacher for the new PIN"), keep the pill neutral, and warn when a reused PIN has a different title. (Medium although both sources rated it Low: the brief's rubric puts confusing wording and screens with no next step at Medium.)
- Evidence: public/index.html:218-235; public/play.js:126-136, :302-311; s360-t1-12-wiped-pin.png.
- Sources: student-join/F11, code-review-ux/CODE-25

**P0-03 · Low · A link with a bad PIN says the PIN is "missing"**
Deep link /play?pin=12 or /play?pin=abc → "No game PIN — This link is missing its 6-digit game PIN." → "This link's PIN isn't valid", with the "Enter a PIN" button (also noted in P0-08).
- Evidence: public/play.js:161, :545; s360-t1-09-deep-short.png.
- Sources: student-join/F12

### Student — Nickname

**P0-04 · Medium · The typed name is replaced without telling the student**
Nickname, typing a filtered name ("fuck", "Sh1t"), nothing, only spaces, "@@@", "+91 Priya", a duplicate, or 30 characters → the server silently swaps in a random name ("You're in, Calm Hedgehog!"), strips leading = + - @ ("91 Priya"), adds " 2" to a duplicate (which can make a 24-character name), and the field stops at 20 characters with no hint; the welcome frame carries no reason → the phone says why ("That name isn't allowed, so you're Calm Hedgehog — tap Spin for another", "Someone is already Priya, so you are Priya 2"), an empty field keeps the student on the form, and the field says "Up to 20 characters".
- Evidence: src/room.ts:332-342, :832-841; src/shared.ts:163-172, :194-200; public/play.js:474-483; public/play.html:52; s360-t2-03-profane.png.
- Sources: student-join/F5, code-review-ux/CODE-11, student-join/F13

**P0-05 · Medium · A student cannot get their own name back**
Nickname after joining → the lobby has no name field; the only control is "Spin a new name", shown to typed-name players too, and one tap replaces "Priya" for good with no confirm; "Spin a name" on the join form joins at once with an unseen name, and a typed name sent later is refused (`already_joined`, shown as "No spins left") → a student can preview spins and go back to typing before committing, and a typed name is never one tap from being lost. This is the owner's example in the brief.
- Evidence: public/play.js:474-483, :497-502, :681-683; src/room.ts:315-327; s360-t2-05-typed-after-respin.png.
- Sources: student-join/F6, code-review-ux/CODE-12

**P0-06 · Medium · A respin is not announced to screen readers**
Nickname, respinning in the lobby with TalkBack or VoiceOver → the heading changes, but the live region is written only when the screen changes, so nothing is read out ("You're in, Priya!" stays after a respin to "Curious Eagle") → announce "You are now Quick Iguana. 1 spin left."
- Evidence: public/play.js:557-576, :677-684; t2 output (announcer text vs nick).
- Sources: student-join/F7

### Student — Joining, locked, full, kicked, ended

**P0-07 · High · Kick does not keep the student out, but the dialog says it does**
Host kicks a student → the server bans only that player token and frees the nickname; the phone clears its token, so "Back to the PIN page" plus the same PIN and name puts the student straight back in the lobby, while the host's confirm said "Remove X from the game? They cannot rejoin." → the dialog tells the truth ("They can rejoin under another name unless you lock the room") and offers "Remove and lock"; the kicked nickname stays reserved for the room.
- Evidence: public/host.js:1168; src/room.ts:435-451, :832-835; public/play.js:326, :414-418; s360-t3-D3-kicked-rejoined.png; probe p1 ("Rude Kid" rejoined).
- Sources: student-join/F1, host-game/M2, code-review-ux/CODE-09

**P0-08 · Medium · Refusal screens have the wrong title, repeat themselves and give no next step**
Joining when late join is off, the room is full, the game has ended, or after a kick → late join off shows "This game is locked / Late joining is off for this game" (both refusals share 4010); a server reason replaces the client's fallback, so "This game is full" and "This game has ended" appear as both title and body; the kicked screen has an empty body; spin-only mode says "spun name"; the Rejoining hint is a 41 px inline link → each screen names the situation once and says what to do ("This game is full. Ask your teacher to make room, then tap Try again.", "The game has already started…"), in plain words ("random name"), with a full-size button.
- Evidence: public/play.js:173-179, :328-329; src/room.ts:259-265; e-latejoin-off-fatal.png, e-full-fatal.png.
- Sources: student-join/F3, code-review-ux/CODE-17, student-display/F7

**P0-09 · Medium · The join form stays usable when the notice says you cannot join**
Join form while the room is locked or late join is off → the notice shows but the name field, Join and Spin stay enabled; Join leads to the 4010 screen and "Try again" reloads into the same form, a loop; a form loaded before the lock shows no notice at all; the / page sends locked PINs through with no warning → disable the controls with one instruction ("Ask your teacher to unlock the game, then tap Try again"), re-fetch the summary instead of reloading, and warn on /.
- Evidence: public/play.js:518-538, :654-664, :871; public/index.html:231-238; s360-t3-C2-locked-form.png.
- Sources: student-join/F4

**P0-10 · Low · The ended screen replaces the final rank; a cancelled game says "Game over"**
Host presses End after the podium, or Cancel game in the lobby → the phone replaces "You finished 12th of 30 · 2,310 points" with "Game over. Nothing about this game is kept.", and a game cancelled before any question also says "Game over" → keep the rank and score on the ended screen (in memory only), and say "The host cancelled the game. Wait for a new PIN." when no question was played.
- Evidence: public/play.js:407-412, :547; public/play.html:157-161; src/room.ts:582-593; s390-t3-E1-cancelled-lobby.png.
- Sources: code-review-ux/CODE-22, student-join/F10

### Student — Connection and device

**P0-11 · High · A dead connection still shows "Connected" (phone and host)**
Connection silently lost (Wi-Fi roam, NAT drop, airplane mode) with the page open → both clients ping every 25 s but never check for the pong; the phone probes only on visibilitychange, online and pageshow and ignores the `offline` event; the host never probes, and Next, Close and End "succeed" into the dead socket with no message; the pill says "Connected" until TCP gives up, which can take minutes → every ping has a deadline (no message within ~6 s means close and reconnect), `offline` turns the pill to "No connection", and the host gets the same probe. (High although the sources rated it Medium or Low: it causes P0-17 and also freezes the projector.)
- Evidence: public/play.js:39-42, :62, :101-115; public/host.js:1663-1666, :1696-1705; evidence-offline-pill.txt and the silent-socket probe in P0-17.
- Sources: code-review-ux/CODE-08, student-display/F4, student-play/SC-10

**P0-12 · Medium · Waking the phone takes about 5 s to recover a dead socket**
Phone locked while its socket died, then unlocked during a question → the page pings and waits 4 s before reconnecting (~4.8 s in all); meanwhile the pill says "Connected", the tiles are live, and a tap says "Answer sent" but is lost ("No answer") → recover in well under a second: open a fresh connection in parallel with the probe and show "Reconnecting…" until a frame arrives.
- Evidence: public/play.js:105-113; s2d_unlock_dead_360.png. Chromium can take up to ~60 s to fire `close` on a black-holed link, so real recovery may be slower.
- Sources: student-play/SC-2

**P0-13 · Medium · After Back, the PIN page ignores the game the phone is in**
Back pressed during a game, or from the podium → / opens with an empty PIN field and no hint of the live game (a QR joiner leaves the browser); retyping the PIN after the podium gives "That game has already finished." and refuses, although the stored token would show the final rank → / offers "Back to your game — PIN 123456" when a token is stored, and always lets a token holder through to /play.
- Evidence: public/index.html:158-246 (no lookup of hompub-quiz:player:*), :232-235; s2c_back_from_question_390.png, s5_back_podium_retype_360.png.
- Sources: student-play/SC-6, student-play/SC-7

**P0-14 · Medium · Same student in two tabs: the other tab shows the wrong state**
A second tab with the same stored token → the ack goes only to the socket that answered; the other tab keeps live tiles, a tap there shows a red "Already answered" and highlights the tile it tapped, not the recorded one, for the rest of the question (the result screen is right) → every socket of the player learns the recorded choice and shows "Answer sent" on that tile. Phase 1 also plans to close the older socket.
- Evidence: src/room.ts:373; public/play.js:374-387, :706, :722; s2c_tab1_duplicate_360.png.
- Sources: student-play/SC-4, code-review-ux/CODE-26

**P0-15 · Low · The join form says "Connecting…" before anything connects**
Opening /play?pin= → the pill shows an amber "Connecting…" although the socket opens only on Join → hide the pill, or show a neutral state, until Join is tapped.
- Evidence: public/play.js:181, :195, :289-335; s360-t1-09-deep-valid.png.
- Sources: student-join/F9

**P0-16 · Low · In-app browsers: no keep-screen-on hint, and switching browser makes a new player**
Joining from the QR inside WhatsApp or Instagram (by inspection) → Wake Lock is missing, so the phone dims mid-question with no hint; storage is per app, so opening the link in Safari later creates "Name 2" with 0 points; with storage blocked, a reload joins as a new player → show "Keep your screen on" when Wake Lock is unavailable, suggest "Open in browser" for in-app user agents, and give a way to resume the same player.
- Evidence: public/play.js:227-258 (storage fallback), :270-276 (Wake Lock).
- Sources: student-display/F13

### Student — Answering and results

**P0-17 · High · "Answer sent" appears before the server confirms, and a lost answer is never noticed**
Tapping an answer on a silently dead socket → the phone shows "Answer sent — waiting for the others" at once (a pending tap counts as answered), there is no ack timer, the pill stays "Connected", and after Next the phone stays on the old question indefinitely; the answer is scored "No answer" → show "Sending…" until `ack.accepted`; with no ack in ~2 s, say "Not getting through — reconnecting…", reconnect and resend while the question is open (the server already de-duplicates).
- Evidence: public/play.js:374-387, :513-515, :704-726; s2d_silent_dead_stuck_390.png (still on Q2 12 s after Next). The missing pong check is P0-11.
- Sources: student-play/SC-1, code-review-ux/CODE-03

**P0-18 · Medium · Offline at the reveal, back during the next intro: the result is never shown**
Phone offline at the reveal, reconnecting during the next intro → the sync has no result, so the student goes straight to "Question 2 of 3 · Get ready…" and their score jumps with no explanation (reconnecting during "closed" works) → a short recap ("Question 1: Correct, +912") as a toast or on the intro.
- Evidence: src/room.ts:696 (result sent in sync only when closed); public/play.js:448-470; s2b_reconnect_in_intro_390.png.
- Sources: student-play/SC-3

**P0-19 · Medium · Tied scores get different ranks by join order**
Result and podium screens with equal scores → equal scores are ordered by total answer time and then by join time, so two students on 0 points read "2nd of 3" and "3rd of 3" → show ties ("Tied 2nd of 3") on phones, podium and host leaderboard; display only, scores unchanged; the CSV may keep strict order.
- Evidence: src/room.ts:812-821; public/play.js:768, :779; s3_tie_podium_C_360.png.
- Sources: student-play/SC-5

**P0-20 · Low · A tap during "Reconnecting…" is dropped**
Tapping while the socket reconnects → the tap is discarded, and its "Not connected" toast is replaced a moment later by "Reconnected", so the student sees "Tap your answer" and may think it counted → queue the tap and send it on reconnect if the question is still open, showing "Sending…".
- Evidence: public/play.js:260-266, :295, :507-511.
- Sources: student-play/SC-11

**P0-21 · Low · "+0 points" and a broken "2nd of 2" on the result screen**
Result after a wrong or missing answer → "+0 points" reads like a gain, and at 390 px "You are 2nd of 2" wraps as "2nd of / 2" → "No points", and a non-breaking space in "of 2".
- Evidence: public/play.js:742-753, :768; s1_result_q3_wrong_last_390.png.
- Sources: student-play/SC-13

**P0-22 · Low · The "Answer sent" status is not styled as positive**
Answered and waiting → the status has `data-kind="ok"` but play.css has no rule for it, so it shows in plain ink → green, as on the result screen (and, after P0-17, only once the ack arrives).
- Evidence: public/play.css (.status rules exist only for bad and muted); p360-q1-answered.png.
- Sources: student-display/F8

### Student — Display and accessibility

**P0-23 · Medium · Landscape: half the answer tiles and the status are off-screen**
Open question with the phone rotated (640×360, 844×390) → the 2×2 grid keeps a 300 px minimum height, the page is 471 px tall, and the yellow and green tiles and "Tap your answer" are below the fold (150 % zoom at 360 px does the same) → all tiles and the status fit in landscape, e.g. one row of four with no fixed minimum height.
- Evidence: public/play.css:311-318 (.grid min-height 300px); s4_open_rotated_640x360.png.
- Sources: student-display/F1, student-play/SC-8

**P0-24 · Medium · Long question text pushes the answers off-screen**
"Show question on phones" with a 200-character question and 80-character options → at 360×640 options 3 and 4 are mostly below the fold, at 320×568 only the top row shows, and the status is off-screen → answers and status always fit one viewport: clamp the question text (the projector shows it in full) and put the status above the grid.
- Evidence: public/play.css (.qtext 1.25rem, .grid min-height 300px); p320-q4-open.png.
- Sources: student-display/F2

**P0-25 · Medium · The header pill covers the wordmark at 320 px or with large text**
Any screen at 320 px, with a 24 px system font, or at 150 % zoom → `.mark-text` and `.pill` are both nowrap and cannot shrink, so "Connecting…" or "Reconnecting…" sits on "HomPub QUIZ" (30 px overlap at 320 px, unreadable at 150 %) → header items never overlap: hide "QUIZ" when narrow, truncate the wordmark, and let the pill fall back to its dot plus a short label.
- Evidence: public/play.css:164-189; crops/r320-header-reconnecting.png, s360-t3-G1-bigfont-join.png.
- Sources: student-display/F3, student-join/F8, student-play/SC-12

**P0-26 · Low · The toast covers the status line and the lower answer tiles**
A toast ("Reconnected", "Not connected — reconnecting…") during an open question → the fixed toast at the bottom covers the status line and the bottom 12–13 px of the lower tiles for 2.5 s → on the question screen, show toasts at the top or write connection messages into the status line. (Low although the source rated it Medium: the tiles stay tappable and the overlap lasts 2.5 s, so it is polish.)
- Evidence: public/play.css (.toast fixed, bottom 24px); e-open-reconnected.png.
- Sources: student-display/F5

**P0-27 · Medium · The countdown and small labels are hard to read**
Open question in daylight or at arm's length → once the tiles appear, the only countdown is a 16–17 px grey number and a 6 px bar that do not change in the last seconds; eyebrow labels (including "Question 4 of 7"), scoreboard labels, the pill and "QUIZ" are 11–12 px; contrast passes, size does not → larger bold seconds in ink colour that turn red in the last 3 s, a 10–12 px bar, and no informational text under 13 px.
- Evidence: public/play.css:222 (.timebar 6px), :309 (.secs 1rem); s4_open_4s_left_360.png.
- Sources: student-play/SC-9, student-display/F6

**P0-28 · Low · Very large text breaks the layout beyond the header**
A 24 px font plus 150 % zoom → focusing the name field scrolls the header away, "You are 2nd of 9" wraps onto four lines, the long-text question page is 3213 px tall, and podium and ended need scrolling (24 px alone is fine) → a single-column scoreboard, row minimums in rem or vh, and a reachable header.
- Evidence: big360-q1-result.png, big360-q4-open.png.
- Sources: student-display/F11

**P0-29 · Low · On a notched phone in landscape, controls sit under the notch**
Landscape with `viewport-fit=cover` (by inspection) → only the top and bottom safe-area insets are used, so the wordmark, the contrast toggle and the outer 16 px of the tiles fall under the notch → `max(16px, env(safe-area-inset-left/right))` padding on the header and main.
- Evidence: public/play.css (.bar and main padding); public/play.html (viewport-fit=cover).
- Sources: student-display/F9

**P0-30 · Low · Forced-colours mode hides the countdown bar**
Windows High Contrast during a question → the tiles become outlined boxes (still playable by shape) but the countdown bar disappears → keep the bar visible with system colours under `forced-colors: active`.
- Evidence: e-forcedcolors-open.png.
- Sources: student-display/F10

**P0-31 · Low · Green tile text is exactly 4.5:1; the yellow tile edge is faint**
Default tile colours in bright light → white on green #26890c is exactly 4.50:1 and the yellow tile's edge is 2.07:1 against the page (high contrast fixes both) → a darker green (about 5.1:1) and a light tile border.
- Evidence: public/play.css (--opt-3, --opt-2); contrast.mjs output.
- Sources: student-display/F12

### Host — Creating and editing quizzes

**P0-32 · High · A second host tab erases quizzes made in the first**
Two host tabs, e.g. one hosting and one preparing the next quiz → every edit writes that tab's whole in-memory list to `hompub-quiz:quizzes`, and the storage listener reloads only on the home screen with no game, so a stale tab silently deletes quizzes made in the other → re-read and merge by quiz id before each write (or one key per quiz), and handle storage events on every screen. Inferred from code; Phase 2's sync must cover it too.
- Evidence: public/host.js:197-202 (writes the whole list), :1066-1073 (editQuiz saves), :1403-1410 (Export saves too), :1612-1619 (leaving a game does not reload the list), :1858-1860 (storage listener only on home).
- Sources: code-review-ux/CODE-04

**P0-33 · High · Damaged saved data blanks the page or gets overwritten**
Host page load with corrupted localStorage → unparseable JSON loads as an empty list and the next save overwrites the raw text; entries without a string id are dropped and then erased; one null question makes validation throw, the page stays blank and the Resume card for a live game never appears → keep a raw backup with a banner and never overwrite; normalise each entry; draw Resume before the list, outside the failing code. (High although the source rated it Medium: the saved quizzes are lost, and a live game cannot be resumed from this page. The trigger is rare.)
- Evidence: public/host.js:178-180, :192-202, :267-270, :393-394, :426-428; probe p4-storage.cjs.
- Sources: code-review-ux/CODE-05

**P0-34 · Medium · With storage blocked, the home list looks saved and closing the tab loses everything**
Editing while localStorage writes fail → the editor says "Not saved…", but home shows the new title and a fresh "edited" time with no warning, and there is no leave-page warning outside a live game, so a reload drops every edit → a lasting banner on home, "unsaved" on the affected rows, a leave-page warning, and Export offered as the way out.
- Evidence: public/host.js:197-201, :400-424, :1845-1847; shots/24-home-storage-blocked.png.
- Sources: host-editor/HE-05

**P0-35 · Medium · Every "New quiz" press saves a blank draft**
New quiz, then back without typing → an "Untitled quiz · 6 problems · not exported" row is saved each time and never cleaned up → save only after the first edit, or reopen the untouched blank draft.
- Evidence: public/host.js:1078-1080; shots/03b-home-four-blank-drafts.png.
- Sources: host-editor/HE-01

**P0-36 · Medium · Delete has no undo**
Deleting a quiz → a native confirm, then the row is gone with no toast and no undo, and the confirm does not suggest exporting first → an Undo toast for about 10 s, and the confirm mentions "not exported" when that is true. Phase 2 plans a Trash.
- Evidence: public/host.js:1102-1108; shots/08-home-after-delete.png.
- Sources: host-editor/HE-02

**P0-37 · Medium · Keyboard focus is lost after moving, removing or adding**
Editor, pressing Move ↓, Remove, × or + Add option from the keyboard → the editor is rebuilt and these buttons have no id, so focus falls to the page body; New quiz and Load sample also leave focus on the body; nothing announces the change → focus stays on the same control of the moved card, New quiz focuses the title, and "Question 3 moved to position 4" is announced.
- Evidence: public/host.js:345-382, :612-626, :1063; t2.log ("activeElement after move: BODY").
- Sources: host-editor/HE-03

**P0-38 · Medium · Validation appears only at the top of the page**
Editing question 81 of 100 → the message "Question 81, option A: 1–80 characters." appears in a box 44,000 px above the field, with no inline marker, no `aria-invalid` and no live region → mark the field inline, keep a short status in view, and announce changes.
- Evidence: public/host.js:591-603, :638-643; shots/22-editor-100q-at-q81.png.
- Sources: host-editor/HE-04

**P0-39 · Low · The disabled "Host this quiz" button gives no reason**
Setup screen for a quiz with problems → the reason is at the top and the greyed button ~1,300 px lower → a one-line reason and "Fix in editor" next to the button.
- Evidence: public/host.js:658-662, :688; shots/20-setup-mixed-validity.png.
- Sources: host-editor/HE-13

**P0-40 · Low · The home screen has no clear first step**
First visit to /host → five equal buttons ("Import .json" is jargon), the Word template is a small link in fine print, and "Check my network" falls below the fold once there are four quizzes → one clear first step, the template as a button, and a visible "Before class: check the network".
- Evidence: public/host.js:406-424, :444-452; shots/01-home-first-1280.png.
- Sources: host-editor/HE-14

**P0-41 · Low · Duplicate and Export have rough edges**
Duplicate and Export → no toast after Duplicate, a copy of a copy is called "X (copy) (copy)", and a blank quiz exports as hompub-quiz-quiz.json → a "Copy created" toast, "(copy 2)" naming, and "untitled" in the file name.
- Evidence: public/host.js:1096-1100, :1403-1407.
- Sources: host-editor/HE-15

**P0-42 · Low · "Set all timers" does not apply to questions added afterwards**
Set all timers to 5 s, then + Add question → the new question gets 20 s while the select still shows 5 s → new questions take the chosen value, or the label says "existing questions".
- Evidence: public/host.js:207 (newQuestion uses 20 s), :1110 (+ Add question), :1138-1144 (Apply to all changes existing questions only).
- Sources: host-editor/HE-17

### Host — Import

**P0-43 · Medium · A .json from another app imports as blank questions**
Import .json with another app's shape (`{question, choices}`) → it passes because it has a `questions` array, and the result is a quiz of empty questions with "Imported 1 quiz — 8 things to fix." → when no question has text or options, refuse with "This file is not a HomPub export; use Paste questions or Import Word or text".
- Evidence: public/host.js:221-236, :1242-1261; shots/34-json-kahoot-like.png.
- Sources: host-editor/HE-06

**P0-44 · Medium · Skipped blocks vanish after "Add to my quizzes"**
Word or paste import that half-fails → the preview says "1 block skipped" and quotes it, but after Add the toast and the editor mention only the other problem and the skipped question is gone → name the skipped blocks after import, or add them as placeholder questions so validation keeps them visible.
- Evidence: public/host.js:1343-1349, :1386-1401; public/import-text.js:405; shots/43-word-mixed-editor.png.
- Sources: host-editor/HE-07

**P0-45 · Medium · A failed .json import is a 4.5 s toast with no next step**
Import .json with a trailing comma, an empty file, or a .txt picked by mistake → "That file is not valid JSON." for 4.5 s, then nothing → a dialog that stays, with the reason and "Choose another file", and .txt or .docx handed to the text importer.
- Evidence: public/host.js:1240, :1251, :1795-1800; shots/32-json-invalid-syntax.png.
- Sources: host-editor/HE-08

**P0-46 · Low · Import warnings say "Question 1: Question 1:"**
Import preview with warnings → the "Question N:" prefix is added twice → once.
- Evidence: public/host.js:535; public/import-text.js:450.
- Sources: host-editor/HE-09

**P0-47 · Low · "Nothing recognised" still promises the editor**
Importing a prose-only document → "2 things to check — the editor opens next…" while Add is disabled and the editor will not open → a separate "Nothing to import yet" state with the format hint and the recovery buttons.
- Evidence: public/host.js:509-512, :541; shots/45-word-prose-nothing.png.
- Sources: host-editor/HE-10

**P0-48 · Low · Out-of-range values in a .json are changed silently**
Import .json with timeLimit 25 or points 500 → silently reset to 20 s and 1000 points (the Word importer warns in the same case) → report the change in the toast.
- Evidence: public/host.js:231-232, :1255-1258.
- Sources: host-editor/HE-11

**P0-49 · Low · Bold marks the answer in Word, but the docs say it does not**
Word import with one option bold, underlined or highlighted → it is ticked as correct, while README says "Bold does not count" and the paste dialog hint mentions only * and "Answer:". Bold used for emphasis gives a wrong tick; the preview does show it → state the real rule in README and the dialog hint.
- Evidence: README.md:460-462; public/host.js:477 (dialog hint); public/import-text.js:616-680.
- Sources: host-editor/HE-12

**P0-50 · Low · The template's heading becomes the quiz title**
Importing template-questions.docx with only the questions changed → the title is "HomPub Quiz — question template", which then shows on the podium and the Resume card → treat that heading as a placeholder (use the file name) or ask for a title.
- Evidence: test/make-template-docx.py:27; public/host.js:1366-1374; shots/75-home-resume-card.png.
- Sources: host-editor/HE-16

### Host — Hosting a game

**P0-51 · High · A double-click or double Space skips the reveal**
Close now and Next, pressed twice quickly → "Close now", "Next question ▸" and "Get ready…" share one button slot and nothing guards the step from close to next, so a second click ~220 ms later, or two Space presses, jumps to the next intro and the reveal is never shown and cannot be brought back; a faster double-click shows raw server text such as "Cannot close during closed" or "Cannot go to the next question during intro" → ignore Next for ~800 ms after the reveal (and Close for ~500 ms after open), disable the button until the phase frame arrives, and drop or reword these toasts ("Already closed").
- Evidence: public/host.js:864-866, :906, :1158-1159, :1584-1586, :1835-1842; src/room.ts:412; t2-d-after-slow-dblclick.png.
- Sources: host-game/H1, code-review-ux/CODE-19, host-game/L1

**P0-52 · High · A live game cannot be resumed from another browser or device**
Laptop dies, or the teacher opens /host on another device or in a private window → "Resume game" appears only if this browser's localStorage holds the host key; there is no link, code or token entry, so the class is stranded (no one can press Next or End) and the results are lost at the TTL; a failed save of the key is ignored too → a "Continue on another device" link or QR behind Options, a resume code that can be pasted on home, and a warning when the key cannot be saved. README and PROTOCOL §5 promise this.
- Evidence: public/host.js:186-190, :393-403, :1147; README.md:399-401; PROTOCOL.md:224.
- Sources: code-review-ux/CODE-01

**P0-53 · Medium · After a refresh the projector shows the quiz library until Resume is clicked**
Host laptop refreshed mid-game → the page draws home: the "A game is still live" card plus the teacher's whole quiz list (titles such as "…cell test (answers)") on the projector, and nothing reconnects until Resume is clicked; a stale key is found only after the click ("Close code 4004") → with a stored key, check the room and go straight back to the stage (with a "Not now" option), or clear an expired key with a short message.
- Evidence: public/host.js:393-423, :1021-1032, :1147, :1862-1865; t2-a-after-reload-projector-shows.png.
- Sources: host-game/M1, code-review-ux/CODE-13

**P0-54 · Medium · Players cannot be removed after Start**
A disruptive student, or an offensive name the filter missed, during a question, reveal or podium → the roster with Remove exists only in the lobby and the Options menu has none, so the name stays on the leaderboard and podium (the server allows kick in any phase) → a "Players (N)" list with Remove in the Options menu in every phase.
- Evidence: public/host.js:724-736, :754-788, :847-933; PROTOCOL.md:148.
- Sources: host-game/M3, code-review-ux/CODE-10

**P0-55 · Medium · On a network that blocks WebSockets, the host waits on "Connecting…" forever**
Hosting where wss is blocked → POST /api/room succeeds (using up a daily room), then "Connecting…" and "Reconnecting in N s…" repeat with no diagnosis; the blocked-network message is used only by "Check my network" → after ~3 failed handshakes, say WebSockets look blocked, suggest a hotspot, and show the PIN so the room resumes after switching.
- Evidence: public/host.js:56, :742-750, :1434-1438, :1646-1693.
- Sources: code-review-ux/CODE-06

**P0-56 · Low · "End game now" promises results when there are none**
End game now during question 1 with no answers → the menu and the confirm say it "downloads the results so far", then the screen says "Game cancelled… no results to keep" → match the wording to the outcome when nothing has been answered.
- Evidence: public/host.js:733-735, :944-953, :1164; t1-d-ended-from-question.png.
- Sources: host-game/L2

**P0-57 · Low · Host offline past the deadline: the ring shows "…" and Close stays enabled**
Laptop offline during a question → the ring shows "…", Close now stays enabled, and only the small pill says "Offline" (students see "Waiting for the host…") → "Time's up — results appear when the connection returns", and Close disabled while offline.
- Evidence: public/host.js:1742; t2-b-offline-30s.png.
- Sources: host-game/L4

**P0-58 · Low · A second host tab or device is never shown**
Two host tabs or devices with the same host key → both control the game with no sign of the other (the first host gets no frame when the second connects), and both download the CSV at the end ("(1).csv") → "Also open in another tab or device" on the stage with "Disconnect other devices", and only the tab that pressed End downloads.
- Evidence: src/room.ts:209-216; public/host.js:1562-1575; probe p1 twoHosts.
- Sources: host-game/L5 (the second-host part of CODE-16 is merged here; that id is listed once, under P0-76)

**P0-59 · Low · Lock and Show-on-phones show the new state even when sending failed**
Toggling Lock room while the socket is reconnecting → the local state changes first; on failure a brief toast appears but the button stays "Locked" while the server is still unlocked → revert on failure, or change the button only when the server's settings frame confirms.
- Evidence: public/host.js:1497-1511, :1580-1583.
- Sources: code-review-ux/CODE-23

**P0-60 · Low · The counter can read "3 of 2 answered"**
A late joiner or a phone that reconnected after open answers → "expected" counts only players connected when the question opened → add such players to the expected count.
- Evidence: src/room.ts:514, :746, :769; public/host.js:861, :899; probe p3.
- Sources: code-review-ux/CODE-18

**P0-61 · Low · Scoring mode, early close and nickname mode cannot be changed in the lobby**
Looking for the scoring mode in the lobby, as README says → the lobby and the Options menu offer only Lock, Show on phones, late join and End, although the server accepts these settings in the lobby → add them to the lobby Options (Phase 1's name setting needs this anyway) or fix README.
- Evidence: README.md:391; public/host.js:724-736, :782-786; src/room.ts:459-461.
- Sources: code-review-ux/CODE-24

### Host — Projector

**P0-62 · High · Stage screens do not fit a 1280×720 projector**
Projector at 1280×720 in fullscreen → every stage screen scrolls: lobby 877 px (bottom of the QR cut, Start off-screen), question 820 px (Close now off-screen; with the browser toolbar, options C and D are cut), reveal 1150 px (5 of 10 rows), podium 1504 px (End off-screen); at 1920×1080 the podium is still 1519 px; clicking a control scrolls the PIN out of view → every screen fits 720p and 1080p without scrolling, with the main control always visible (viewport-height stage, sticky controls, QR, ring and rows sized by screen height).
- Evidence: public/host.css:359-362, :392, :403-406, :472-496; t5-720p-lobby-top.png.
- Sources: host-game/H2

**P0-63 · Medium · Toggling an Options checkbox by keyboard drops focus, and the next Space closes the question**
Keyboard or clicker control, Space on "Show question on phones" → render() restores focus before it reopens the menu, so focus falls to the page body; after the 500 ms mute, the next Space fires the phase's main action, and in the test it closed the question for the class → reopen the menu before restoring focus, and let the Space/Enter shortcut act only when the stage itself has focus.
- Evidence: public/host.js:372-384, :1835-1842; t5-space-after-checkbox.png.
- Sources: host-game/M4

**P0-64 · Medium · PIN, join URL, counter and leaderboard are too small for the back row**
Projector at 1080p seen from ~8 m → question text and option labels are fine, but size caps keep the PIN at 30 px, the join URL at 18 px in pale lavender (no scheme, no PIN), the question counter at 22 px, "answered" at 12 px and leaderboard rows at 29 px; the QR shows only in the lobby → sizes that grow with screen height, the full join URL next to the PIN, and a small QR while late joining is on.
- Evidence: public/host.css:365, :370, :421, :427-428, :475, :488; public/host.js:717-719; t2-d-question-pin-header.png.
- Sources: host-game/M5

**P0-65 · Low · Space on the podium ends the game with no confirm**
Podium, a single Space or Enter with nothing focused → the game ends, the CSV downloads, and the podium cannot be shown again → confirm a keyboard End, or add "Show podium again" on the ended screen.
- Evidence: public/host.js:1160, :1818-1825.
- Sources: host-game/L6

**P0-66 · Low · Reveal labels break in the middle of a word**
Reveal with a long one-word answer → the correct tile's label column is 139–160 px wide with `overflow-wrap: anywhere`, so "Mitochondrion" breaks as "Mitochon / drion" → break between words or hyphenate, and move the count below the label when the tile is narrow.
- Evidence: public/host.css:451, :543; t5-720p-reveal-top.png.
- Sources: host-game/L7

### Host — Results and CSV

**P0-67 · High · The idle wipe deletes a live game without sending the results**
Game left mid-question or on a reveal for over 2 h (the bell rings, the teacher comes back later) → the TTL alarm wipes the room, and results_csv is sent only in the podium phase, so in any other phase the results are deleted even with the host tab connected (and a host not connected at the podium gets nothing); the docs say results are "never destroyed unsent" → send the results to hosts whenever a question has been played, do not wipe (or extend the TTL) while a host is attached, and show when auto-deletion will happen. Inferred from code; not run for 2 h.
- Evidence: src/room.ts:603-623, :634-649; PROTOCOL.md:231; README.md:354.
- Sources: code-review-ux/CODE-02

**P0-68 · Medium · A kicked player's answers vanish from the CSV**
Kicking a player who has already answered → kicked players are left out of the active list, so their rows disappear from the CSV, the ranks and the podium, and the confirm does not say so → keep them in the CSV marked "removed", or warn in the dialog. (Medium although the source rated it Low: recorded answers are dropped without a warning. Not High, because the teacher chose to remove the player.)
- Evidence: src/room.ts:786, :805-809; public/host.js:1168; probe p3 csvAfterKick.
- Sources: code-review-ux/CODE-20

**P0-69 · Low · The CSV does not say which column is which question**
Opening the CSV a week later → the columns are only q1…qN ("B 947") with no question text, correct letter or quiz title; a nickname typed as " =1+1" passes the join-time strip (it runs before the trim) and shows as "'=1+1"; locales that use ";" open everything in one column → add a question key and the title, strip after trimming, keep the CSV escaping. Phase 4 plans the CSV redesign.
- Evidence: src/room.ts:780-801; src/shared.ts:163-171 (strip runs before trim), :225-229 (CSV escaping).
- Sources: host-game/L8

**P0-70 · Low · Resuming after Game over shows a misleading card and downloads the CSV again**
Closing the tab on Game over, then reopening /host → the card says "Students who are connected are waiting for you" though they see "Game over", and Resume re-sends the results so a second "(1).csv" downloads → say the game has ended and the file can be downloaded again, and skip the automatic download if it already happened.
- Evidence: public/host.js:190, :397-403, :1562-1575; t4-resume-card-after-ended.png.
- Sources: host-game/L3

**P0-71 · Low · No way to keep the results where downloads do not work**
Hosting from a phone or an in-app browser (by inspection) → the CSV comes only through a Blob URL with `download`, revoked after 30 s; iOS WebViews ignore it and there is no copy or share fallback; the fullscreen toast suggests F11 on phones → "Copy results" and "Share…" on the final screens, keep the URL until leaving, and hide the F11 hint on touch screens.
- Evidence: public/host.js:1766-1780, :1804-1815.
- Sources: host-game/L9

### Security, capacity and robustness

**P0-72 · Medium · PIN lookups and joins have no rate limit, and the summary shows the quiz title**
Scripted PIN guessing → 2000 lookups in 4.96 s (403 per second) never got a 429; a hit returns the title, phase, player count and lock state; a script can then add up to 250 bots (late join is on by default) until real students get 4009; every lookup goes through the single Directory object → per-IP limits on lookups and token-less joins, and no teacher-identifying title in the public summary. Phase 1 covers the limit.
- Evidence: src/worker.ts:122-136; src/room.ts:178-185, :257-266; src/directory.ts:74-83; probe p3-enum-midq.mjs.
- Sources: code-review-ux/CODE-14

**P0-73 · Medium · The host stage is rebuilt on every frame, so clicks can be lost**
Host lobby with many joiners, or the controls while students answer → every roster, tally, settings and error frame replaces the whole stage (Start, Close now, the Options menu, up to 250 chips, a 15 KB QR) every 250–500 ms, so a click whose press spans a rebuild is dropped and focus and screen-reader position reset → build each stage once per phase and update counters, chips and checkboxes in place. Measured: 6 roster frames of ~17 KB for 200 joins in 4.9 s, so bandwidth is not the problem. Lost clicks are inferred from code, not yet seen in a browser.
- Evidence: public/host.js:366, :754-811, :1529-1546, :1590; probes p2-roster-cap.mjs, p6-qr.cjs.
- Sources: code-review-ux/CODE-07

**P0-74 · Low · Reconnects with a token bypass the socket cap**
Room full at 250 players → new players correctly get 4009, but token reconnects skip the 500-socket cap and old sockets for the same player are never closed: 300 extra sockets on one token were accepted (550 in all), and players who left for good still hold slots → a per-player socket limit (about 3, closing the oldest) and the global cap applied to every player socket.
- Evidence: src/room.ts:221-236 vs :262-265; PROTOCOL.md:258; probe p2.
- Sources: code-review-ux/CODE-15

**P0-75 · Low · A lost welcome frame creates a ghost duplicate player**
Joining on flaky Wi-Fi → if the socket drops after the server created the player but before the welcome arrives, the phone replays its join and becomes "Priya 2" next to "Priya (offline)"; the ghost counts toward the cap, the player count and the CSV → make joins idempotent with a one-time join id from the phone.
- Evidence: public/play.js:293-298; src/room.ts:341-356; probe p7-ghost.mjs.
- Sources: code-review-ux/CODE-21

**P0-76 · Low · Host and player tokens travel in the WebSocket URL**
Connecting through a school proxy that inspects TLS → the tokens are in the query string, which such proxies log → send them in a first `{t:'auth'}` frame (Phase 1 plans this for the host token).
- Evidence: public/host.js:1491; public/play.js:285; PROTOCOL.md:27-28.
- Sources: code-review-ux/CODE-16 (token part here; its second-host part is in P0-58)

## Wording, dead ends and error messages

Confusing wording:
- P0-07 — the kick dialog says "They cannot rejoin"; they can.
- P0-08 — "This game is locked" for late join off; "spun name"; an empty body on the kicked screen.
- P0-03 — "This link is missing its 6-digit game PIN" for a link with a bad PIN.
- P0-10 — "Game over" for a game cancelled in the lobby.
- P0-15 — "Connecting…" on the idle join form; P0-02 — a red "Disconnected" pill on the join form after a wipe.
- P0-11, P0-17 — "Connected" and "Answer sent" shown when neither is true.
- P0-19 — "3rd of 3" for a tie; P0-21 — "+0 points".
- P0-20 — "Reconnected" replaces "Not connected" after a dropped tap.
- P0-56 — "downloads the results so far" when there are none.
- P0-70 — "Students who are connected are waiting for you" after Game over.
- P0-60 — "3 of 2 answered".
- P0-43 — "Imported 1 quiz — 8 things to fix" for a file that was not recognised.
- P0-46 — "Question 1: Question 1:"; P0-47 — "the editor opens next" when it will not.
- P0-49 — "Bold does not count" (it does); P0-61 — README's "Choose in the lobby" for scoring mode.
- P0-40 — "Import .json" is jargon for teachers; P0-42 — the "Set all timers" label.
- P0-69 — CSV columns q1…qN with no question key.

Dead ends:
- P0-09 — locked or late join off: "Try again" reloads into the same enabled form.
- P0-08 — the full, late-join-off and kicked screens give no next step.
- P0-13 — Back from the podium: "That game has already finished." turns away a student who holds a token.
- P0-17 — on a dead socket the phone stays on the old question with "Answer sent" after Next.
- P0-52 — another device has no way to take over a live game.
- P0-55 — "Connecting…" forever on a network that blocks WebSockets.
- P0-33 — one damaged saved quiz blanks the host page and hides Resume.
- P0-54 — no control to remove a player after Start.
- P0-65 — after Space on the podium there is no way back to the podium.
- P0-47 — prose-only import: Add is disabled under a heading that promises the editor.
- P0-71 — CSV on a phone or in-app browser: no copy or share fallback.
- P0-67 — "Nothing about this game remains." after an idle wipe, with no results sent.

Error messages that do not say what to do next:
- P0-51 — raw "Cannot close during closed" and "Cannot go to the next question during intro".
- P0-08 — "This game is full" over "This game is full"; "This game has ended" over "This game has ended".
- P0-02 — "That game has already finished." and "No game with that PIN." without "ask your teacher for the PIN".
- P0-01 — "Enter all 6 digits of the PIN." after the page itself cut the pasted PIN.
- P0-45 — "That file is not valid JSON." for 4.5 s, then nothing.
- P0-53 — a stale resume key gives "Connection closed / Room not found / Close code 4004".
- P0-04 — no message at all when a name is replaced.
- P0-34 — blocked storage is reported only inside the editor.
- P0-39 — the disabled Host button's reason is 1,300 px away.
- P0-57 — host offline: only the small pill, and the ring shows "…".
- P0-59 — a failed Lock shows a brief toast while the button says "Locked".

## What already works (do not change)

- Scoring and timing: a tap 50 ms before the deadline is accepted and scored (504 points on a 5 s question); a tap 50 ms after is blocked as "Time's up"; the server's 1 s grace covers frames in flight, as PROTOCOL says.
- Answer validation: answers are de-duplicated per player, late answers get "late", and answers are stored before they are acknowledged; a quiz with invalid questions cannot be hosted, and the server rejects a bad room POST with 400 on its own.
- No answer leakage: the settings frame sent mid-question carries the text and options but no `correct` field.
- De-duplication of Next: pressing Next 8 times cannot skip a question; the server rejects out-of-phase frames and the intro shows a disabled "Get ready…". (The reveal skip in P0-51 is the Close-then-Next path.)
- Profanity filter: it catches "fuck" and "Sh1t" and passes "Dickens" and "Akshit"; duplicate names are matched case-insensitively.
- CSV safety: formula characters are stripped at join and prefixed with an apostrophe when writing the CSV; the file already has a UTF-8 BOM, CRLF line ends, correct quoting and intact Devanagari, and is named hompub-quiz-<pin>-<yyyymmdd>.csv (Phase 4's BOM item is already done).
- Results handling: results are kept outside the snapshot, "Download again" is on every final screen, the "results so far" file after an early End includes the open question, a cancelled game skips the CSV and says so, and the wipe clears the host key so the PIN returns 404.
- Join page: it advances on the 6th digit, strips non-digits, checks the PIN before leaving the page, gives clear messages for 5 digits, an unknown PIN, a finished game and no network, resets after Back, and prefills /?pin= without submitting.
- Names in Devanagari, IAST and emoji are accepted and shown correctly on the phone and in the host roster; the 20-character limit does not split an emoji.
- Spin flow: "Spin again (2 left)", then "(1 left)", then the button hides; spin-only mode hides the name field and explains why.
- Late join on: an honest notice, then the student lands on the live question with the right countdown, or on the result.
- Joining offline: "Joining…", a hint with Cancel after ~3 failures, and the join completes by itself when the network returns; the join-timeout and stale-token paths hand the form back instead of looping.
- Reconnect: a hard drop recovers in ~0.7 s with "Reconnecting…" and "Reconnected"; a refresh resumes from the stored token in ~150 ms in every phase; a live socket survives a hidden page; reconnecting during the intro or a closed question restores the right screen.
- Answering: 2×2 tiles at least 44 px tall, the first tap locks (a second tap 30 ms later is ignored), the picked tile is ringed; "Time's up", "No answer" and survey wording are clear; the 3-2-1 intro is large and synced to the server clock.
- Phone accessibility: each screen moves focus to its heading and is announced through one polite live region; tiles carry a shape, a colour and labels such as "Red triangle: …"; all text passes WCAG AA in light and dark mode; high contrast persists and turns on with `prefers-contrast: more`; dark mode is complete; reduced motion changes nothing essential.
- The player page updates a fixed DOM instead of rebuilding it, and both clients insert server text as text nodes (no innerHTML), so names cannot inject markup.
- Player storage is wrapped in try/catch with an in-memory fallback, stale entries are swept on load, and tokens are cleared on kick and at the end.
- A quiz with only 1 valid question among invalid ones cannot be hosted: Host is disabled, every problem is listed, and the server rejects a direct POST with 400. A 1-question quiz that is valid plays through to the end (the join auditor used one). The gap is where the reason is shown (P0-39).
- Editor: removing the ticked option clears the tick; reordering keeps the scroll position and works by keyboard; a 100-question quiz opens in ~185 ms with under 2 ms per keystroke; Set all timers, the export reminder and a lossless export round trip all work.
- Import: the shipped Word template imports with nothing to fix; the preview shows unmarked, dropped and skipped items; .doc, .pdf and truncated .docx files get specific messages with "Choose another file"; paste handles questions without blank lines and one-line options; the preview is a true modal with sensible focus.
- Hosting: Start with 0 players asks first; Options toggles work mid-question and push the text to phones without losing a pending tap; Cancel and End have confirms with distinct wording.
- Host resilience: a page hidden for 60 s keeps its socket; 30 s offline shows "Offline — waiting for network" and resyncs ~250 ms after the network returns; Resume restores the exact screen, including a running countdown; a leave-page warning fires while live; two host tabs stay in sync.
- Projector: question text (57.6 px) and option labels (33–42 px) read well at both resolutions; reveal counts have 5–12:1 contrast; high contrast, fullscreen (button and F key) and keyboard order work, Escape closes Options, the wipe can be done by keyboard, and the focus ring is visible.
- Server: frame coalescing works (6 roster frames for 200 joins, 2 for a 40-phone reconnect storm); 4009 at the 251st player, 4010 when locked, 403 for a foreign Origin, and 4003 plus "kicked" for a kicked token; the edge answers ping in ~3 ms without waking the Room.
- A phone used as an emergency host shows every stage screen within 390×844, and the Game over card stays usable with dark mode, a 24 px font and 150 % zoom.

## Raw findings not carried forward

None. All 98 raw findings are merged into the 76 above, and each raw id is listed in exactly one Sources line.

## Not testable here

- In-app browsers (WhatsApp, Instagram) — cannot be launched here — by inspection join and play should work (100dvh override, guarded storage, no window.open); Wake Lock is missing and storage is per app (P0-16); the host CSV download likely fails in iOS WebViews (P0-71).
- Real paste from a phone keyboard — simulated with Ctrl+V in headless Chromium — `maxlength` cuts pasted text before the input event in Chrome and Safari, so P0-01 applies on phones.
- A real Hindi/Devanagari keyboard — names were entered by Playwright, not through a phone keyboard — Devanagari and IAST display and storage were correct; keyboard composition itself was not exercised.
- Real phone lock and iOS socket behaviour — only headless Chromium; simulated with visibilitychange and a cut connection — a live socket is fine; a dead one recovered in 4.8 s (P0-12).
- Browser close timeout on a black-holed connection — not reproduced; the test connection closed promptly — Chromium can take up to ~60 s to fire `close`, and locally a page-initiated close stayed "closing" for 10+ s, so real recovery may be slower than measured (P0-11, P0-12).
- Real network changes (Wi-Fi to mobile data, roaming between access points) — simulated with online/offline events and cut or closed connections — whether the OS closes the socket decides between fast recovery (~0.7 s) and P0-11.
- Laptop sleep — simulated with a hidden page for 60 s and 30 s offline — if sleep closes the socket the host resyncs in ~250 ms; if it leaves it half-open, P0-11 applies.
- Sunlight — judged from computed colours only — contrast passes AA; size is the weak point (P0-27, P0-31).
- Notch safe areas — Playwright cannot set `env(safe-area-inset-*)` — side insets are not used (P0-29).
- Real Safari toolbar and 100vh — only Chromium; a 360×560 viewport was used instead — the shapes-only grid fits, long text does not (P0-24).
- Screen readers — no assistive technology in the container — DOM checks show the right patterns (focus to the heading, one polite live region, labelled tiles); P0-06 and P0-37 are the gaps.
- "Too late — not counted" status — needs a tap inside the 1 s grace — the wording exists and matches the other statuses.
- Real projector and browser window — headless; 1280×635 stood in for 720p with the toolbar — the fullscreen API works (P0-62).
- Real browser zoom and OS large font on the host — simulated as 853×480 at 1.5× pixel ratio plus a 24 px font — the editor and the import dialog stayed usable.
- Word-authored .docx files (numbered lists, tables, text boxes) — only hand-built files could be made — the parser code and unit tests cover these; plain paragraphs, bold runs and the template were verified.
- A full localStorage quota — simulated by making writes throw — same code path as a real quota error (P0-34).
- The real web fonts — Google Fonts were blocked; fallback fonts rendered — no finding depends on exact glyph widths.
- Excel and a phone CSV viewer — not available — the bytes are right (BOM, CRLF, quoting), so Excel should show Devanagari; an apostrophe-prefixed name shows the apostrophe (P0-69).
- A download blocked by the browser — needs a real download manager — the page reports "download started" even if Chrome blocks it; "Check your Downloads folder" and Download again cover this.
- The TTL paths (2 h idle, 30 min after End) — need hours of real time — inferred from code (P0-67).
- Double-click races at real latency — the local server answers in ~1 ms — both outcomes were reproduced; at 50–150 ms round trip a normal double-click lands in the bad window (P0-51).
- Clicks lost while the host page rebuilds — the code review had no browser — the code review estimates that a normal click (80–150 ms press) is dropped 20–40 % of the time while students answer or join; this needs a browser to confirm (P0-73).
- Two host tabs editing quizzes — browser-only — inferred from code (P0-32).
- Production rate limiting or WAF — only the code and the dev server were visible — no limiter in the code, and README lists the WAF as "Not yet" (P0-72).
- A room filled by real phones — the join auditor did not fill a room; the display auditor (250 bots) and the code probe confirmed 4009 at the 251st player (MAX_PLAYERS 250) — pending and second-tab sockets count toward the 500-socket cap, so a class that refreshes a lot could hit it earlier (P0-74).
