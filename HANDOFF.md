# Second Board — Handoff to Claude Code

## What this is
A self-hosted (Netlify) chess coaching web app. Single HTML file (`chess-coach.html`, ~1,820 lines) containing all HTML/CSS/JS inline. Uses chess.js for rules/move generation and Stockfish.js (WASM, via cdnjs) as the analysis/opponent engine, with a hand-rolled minimax as a fallback if Stockfish fails to load.

**Live deploy:** secondboard.netlify.app (note: an earlier deploy lived at a different auto-generated Netlify subdomain — see "Known issue: orphaned data" below)

## Why we're here
This was built entirely through conversational iteration with Claude (chat), which has no ability to execute the code — every bug so far was found by the user screenshotting the live app and reporting back, not by testing before shipping. That loop is too slow and unreliable for code this stateful (async engine calls chained together, a persistence layer, a grading pipeline where bugs compound across features). The immediate ask: get this into an environment where it can actually be run and tested before each change ships.

## Priority zero: add a test harness
There has never been a single automated test run against this code. The most valuable first task, before any feature work, is:
1. A smoke test that loads Stockfish, feeds it a known position, and confirms it returns a legal move within a time budget (this alone would have caught the most recent shipped bug — see below).
2. A basic test for the fallback minimax (`pickEngineMove`) confirming it returns a move in under ~1s at its configured depth — this exact class of bug has already shipped once.
3. Ideally, split the single HTML file into separate modules (engine wrapper, grading logic, storage, UI rendering, game state) so each can be unit tested in isolation. Right now everything is one inline `<script>` block, which makes testing anything require a full browser/DOM context.

## Architecture as it stands

**Chess rules/state:** `chess.js` (CDN, v0.10.3) — a single global `game` object holds the live game; `Chess(fen)` is used to spin up throwaway instances for analysis without touching the live game.

**Engine:** `stockfish.js` (CDN) wrapped in a hand-written UCI promise queue (`sfSend`, `initEngine`, `handleEngineLine`, `processQueue`, `sfAnalyze`). Key facts:
- `sfAnalyze(fen, depth, uciElo)` — omit `uciElo` for full-strength grading analysis; pass it to weaken the engine toward a target Elo via `UCI_LimitStrength` + `UCI_Elo` (added this session, unverified — see Known Issues).
- `sfAnalyze` now has a 6-second timeout (added this session) and always resolves, falling back to `null` rather than hanging forever.
- If Stockfish fails to initialize (`engineReady === false`), the app falls back to `pickEngineMove()`, a brute-force alpha-beta minimax (`minimax`, `searchRoot`) with **no move ordering, no quiescence search, no transposition table**. This fallback must never run past depth 3 or it can hang the browser tab (see Known Issues — this already caused a real bug this session).

**Grading:** `makePlayerMove()` runs a full-strength Stockfish analysis before and after every player move, computes centipawn loss, and classifies it (`classify()`) into Brilliant/Best/Great/Good/Inaccuracy/Mistake/Blunder. Thresholds now scale by the player's rating via `thresholdFactorForRating()` (added this session — beginners get looser thresholds, stronger players stricter). Checkmate is special-cased to always grade as a win, not by centipawn loss (this was a real shipped bug, now fixed — see below).

**Explanations:** `explainLoss()` and `describeMove()` generate plain-language reasoning by re-deriving tactical facts from the position (hanging pieces, checks, threats) rather than just reading a centipawn number — this was a deliberate response to competitive research showing "engine says X but doesn't explain why" is the #1 complaint across chess coaching apps (Aimchess, Dr. Wolf, Chess.com game review all draw this complaint — see Context section below).

**Rating system:**
- Diagnostic game (fixed ~1200 calibration opponent) sets an initial rating from result + average centipawn loss.
- Subsequent games target `profile.rating + profile.ratingGap` (dynamic, starts at 25, widens toward 50 on win streaks of 2+, narrows toward 0 on loss streaks of 2+, drifts back to 25 baseline otherwise — added this session).
- Standard Elo update on game end, with a provisional K-factor (48 for first 5 post-diagnostic games, 32 through 15, 24 after — added this session, intent: early games move the rating fast since the diagnostic estimate is rough, then it stabilizes).

**Mistake recycling (spaced repetition):** Every mistake/blunder is saved (`saveMistakeForRecycling`) with the exact FEN, played move, best move, and a generated explanation. Drills tab (`pickDrill`, `dueMistakes`, `scheduleNext`) serves these back on a Leitner-box schedule (`BOX_INTERVALS = [0,2,6,14,30,90]` days) before falling back to a small curated puzzle bank (`DRILL_BANK`, ~12 hardcoded positions).

**Opening deviation detection:** `OPENING_BOOK` is a small hand-authored object mapping move-sequence keys to good continuations with one-line explanations, covering common e4/d4/Sicilian/French/Caro-Kann/QGD/KID lines to ~4-6 ply. `checkOpeningBook()` flags when the player deviates with meaningful loss in the first 8 plies.

**Post-game review:** `openReview()` steps through the full move list with an eval graph (`drawEvalGraph`, canvas-based, plots real Stockfish evals when available, falls back to material-only) and per-move explanations.

**Persistence:** `detectStorage()` probes for `localStorage` (works on Netlify, blocked in Claude artifacts) and falls back to the Claude-artifact-only `window.storage` API if present, else shows a manual copy/paste backup-and-restore UI. **This session confirmed the user is on Netlify, so `localStorage` should be the active path** — but see Known Issue below re: orphaned data across domain renames.

**Sound/haptics:** Web Audio API synthesized tones (`tone()`, `playMoveSound`, `playGradeSound`, `playResultSound`) — no audio files. Haptics via `navigator.vibrate()` (`buzz()`) — **does not work on iOS Safari**, the app detects this and shows "Haptics n/a" rather than pretending it works.

## Known issues — fix these first

### 1. UNVERIFIED: does Stockfish actually load on the current deploy?
As of the last screenshot, the engine status chip read **"Basic engine"**, meaning Stockfish failed to initialize and the app is running on the fallback minimax. This was never root-caused. Possible causes to check:
- CDN script tag / network issue
- `UCI_LimitStrength` / `UCI_Elo` option names not supported by this specific WASM build (these are standard Stockfish UCI options, but WASM builds vary)
- Something in `initEngine()`'s handshake (`uci` → `uciok` → `isready` → `readyok`) not completing

**This is priority one to diagnose** — a huge amount of the app's value (accurate grading, believable opponent strength) depends on Stockfish actually running. The minimax fallback is explicitly a "better than nothing" safety net, not a real solution.

### 2. FIXED THIS SESSION, UNVERIFIED IN PRODUCTION: depth/fbDepth collision
`engineParamsForElo()` computes two different depth values: `depth` (4-16, sized for Stockfish with proper pruning) and `fbDepth` (1-3, sized for the brute-force fallback minimax). `pickEngineMove()` was mistakenly using `depth` instead of `fbDepth`, meaning whenever the app fell back to the basic engine, it tried to run brute-force minimax at Stockfish-scale depths — computationally infeasible on a phone, hangs the tab indefinitely with no error thrown (it's a synchronous loop, not a promise, so the timeout/try-catch safety nets added earlier in the session didn't catch it). Fixed by wiring in `fbDepth` correctly plus a hard clamp (`Math.max(1, Math.min(3, fbDepth))`) so this class of bug can't silently reappear. **Not yet confirmed working in production** since the fix shipped at the same time the user asked to move to Claude Code.

### 3. Orphaned localStorage data across domain rename
User renamed the Netlify project mid-session (from an auto-generated subdomain to `secondboard.netlify.app`). `localStorage` is scoped per-origin, so all rating/history/drill data saved under the old URL is invisible on the new one — not lost, just stranded. No migration path currently exists. Worth deciding whether this matters (probably not, given how early-stage the data was) or whether a one-time export reminder before domain changes would help.

### 4. Undo bug — fix shipped this session, never independently verified
Original `btnUndo` handler called `game.undo()` up to twice with no bounds/sync checking against the parallel `sessionMoves` array (used for post-game review and session stats). This caused a genuinely corrupted-looking board in one screenshot (pieces on impossible squares, no king visible). Rewrote to: compute exact plies to remove (2 normally, 1 if only one ply exists), pop matching entries off `sessionMoves` in lockstep, and roll back `sessionCpLossTotal`/`sessionMovesGraded` for undone player moves. **This has not been tested against the actual reported corruption scenario** — worth writing a regression test that reproduces the original bug (repeated undo near game start, undo after a bot move, undo after a blunder that was saved to the mistake queue) and confirms no desync.

### 5. Move-grading timing — user-requested rework, not yet built
Current flow per player turn: analyze position (full depth) → player moves → analyze again (full depth) → grade → bot moves. This is fully serial and slow. Agreed-upon design (see conversation, not yet implemented):
- Precompute the "before" eval the moment it becomes the player's turn (while they're still deciding), so it's ready instantly when they move.
- On move: only run the "after" eval, show the grade immediately.
- Let the bot's own search run concurrently during the pause where the player is reading their feedback, rather than waiting for that to finish first.
- Cache evals by FEN — the position after the player's move and the position before the bot's move are literally the same FEN and are currently being searched twice.

## Roadmap (agreed with user, in priority order)

**Phase 1 — Trust the numbers (this session, partially done):**
1. ✅ UCI_Elo for opponent strength (implemented, unverified — see Known Issue #1)
2. ✅ Rating-relative grading thresholds (implemented)
3. ✅ Dynamic rating gap + provisional K-factor (implemented)
4. ✅ Undo bug fix (implemented, unverified — see Known Issue #4)

**Phase 2 — Close the explanation gap (not started):**
5. Show the engine's actual continuation line (2-3 moves) alongside "X was better," not just the claim — this was identified via competitive research as the single biggest complaint across the category (see Context below)
6. The precompute/concurrent timing rework described in Known Issue #5
7. Cache evals by FEN to eliminate duplicate searches

**Phase 3 — Make recycling resist rote memorization (not started):**
8. Vary recycled drills — same weakness tag, different position, rather than replaying the identical FEN every time
9. Expand generated drills beyond the 12-item curated `DRILL_BANK`, built from the growing pool of actual saved user mistakes

**Phase 4 — Visible progress (partially exists):**
10. Progress tab already shows rating trend + mistake-tag counts; depends on Phase 1/2 grading being trustworthy to actually mean something

**Explicitly out of scope / acknowledged ceiling (per user discussion):**
- Fully human-like bot play — even Maia (the best-in-class human-mimicry neural net approach) has known flaws per competitive research (too-strong opening book, too-precise endgames relative to its rating label). Not worth chasing further than UCI_Elo currently provides.
- Complete opening *idea* explanations vs. move-by-move book notes — this is a content-authoring problem, not an engineering one.

## Context: why certain design decisions were made
A competitive research pass (chat conversation, not reproduced in full here — ask the user if the full report is needed) surveyed reviews of Aimchess, Chess.com, Lichess, Dr. Wolf, ChessKid, Magnus Trainer, Reality Check Chess, ChessMind AI/Maia, ChessTempo, and Chessable. Cross-cutting findings that shaped this app's priorities, ranked by frequency:
1. **"What, not why"** — engine feedback tells users what was wrong but not why or how to fix it in human terms. Biggest single complaint category. Drove the `explainLoss`/`describeMove` design and the Phase 2 continuation-line feature.
2. **Move classification feels arbitrary/inconsistent** — e.g. Chess.com's "Brilliant" being devalued, labels changing on re-analysis. Drove the decision to grade against fixed, rating-scaled thresholds rather than a black-box model, and to keep classifications stable once assigned.
3. **AI opponents don't match their stated strength** — bots "overrated by a few hundred points," detectably robotic blundering. Drove the move to UCI_Elo over a hand-guessed skill mapping. Acknowledged ceiling: even Maia doesn't fully solve this.
4. **Pricing/paywall friction** — not directly applicable since this is self-hosted rather than app-store distributed, but informs a bias toward not artificially gating features.
5. **Repetitive/poorly-tailored puzzles** — drove the mistake-recycling system as the core differentiator; Aimchess's "Retry Mistakes" and ChessTempo's mistake-sets were identified as the best-reviewed drill systems in the category and were the model to beat.
6. Technical/UX bugs, opening-training-as-memorization-without-understanding, and grinding-without-visible-improvement were the remaining lower-ranked themes.

## User preferences to carry forward
- **Do not build/code without explicit go-ahead first** — this was set as a standing instruction mid-session (saved to memory). Propose the plan, wait for approval, then build.
- User cares specifically about **user improvement** as the north star for feature tradeoffs (stated explicitly when choosing between a latency fix and a grading-accuracy fix — chose to preserve grading depth over speed).
- User is deploying via Netlify, self-hosted, not going through app stores.

## Files in this handoff
- `chess-coach.html` — the current full app, single file, as of this session's last edit (includes the depth/fbDepth fix, unverified in production)
- `HANDOFF.md` — this document
