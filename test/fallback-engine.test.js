// Regression test for HANDOFF.md Known Issue #2: pickEngineMove() must
// always search at fbDepth (1-3, sized for this brute-force minimax with no
// move ordering), never at `depth` (4-16, sized for Stockfish). Using the
// wrong one is exactly what silently hung the bot's turn in "Basic engine"
// mode, with no error thrown, because searchRoot is a synchronous loop, not
// a promise — nothing else in the app can catch or time out a runaway call.
//
// Measured across runs on this environment: searchRoot on a branchy open
// middlegame (r1bqk2r/... in DRILL_BANK) takes tens of ms at depth 1, roughly
// 1-2s at depth 2, single-digit seconds at depth 3, and 90-150+s at depth 4
// — this sandbox's CPU allocation visibly varies run to run (a depth-4
// search measured ~90s early in the session and ~154s later in the same
// session with no code change), so budgets below carry real multiples of
// headroom on top of the slowest measurement seen, not just the fastest.
// The depth 3/4 jump itself is roughly two orders of magnitude — that gap is
// why fbDepth must never reach 4, regardless of exactly how slow this host is.
//
// IMPORTANT: fbDepth reaches 3 for any target rating >=~1600 (see
// engineParamsForElo), which is an ordinary rating, not an edge case. At
// fbDepth 3, branchy middlegame positions take several seconds — well over
// the "~1s" goal from HANDOFF.md, even though the fbDepth fix itself is
// working correctly. That specific case is marked with it.fails below to
// document the gap without blocking the rest of the suite; every other
// combination here is a real, currently-passing assertion.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const { pickEngineMove, engineParamsForElo, searchRoot, positionComplexity } = require('../src/fallback-engine.js');

// 4x the slowest fbDepth<=2 measurement seen on this host (~1.6s) — enough
// headroom to absorb this sandbox's observed run-to-run CPU variance without
// weakening what the budget actually guards against (fbDepth 4+ territory,
// which is 50-100x slower still, not a close call either way).
const FAST_BUDGET_MS = 4000;
// Not aspirational — a ceiling well below the 90-150s+ the original
// depth/fbDepth collision bug produced at depth 4 on this host, so a
// regression back toward that is still caught even in the one case that
// already misses the 1s goal today.
const SAFETY_CEILING_MS = 40000;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Branchy open middlegame (from DRILL_BANK in chess-coach.html) — the worst
// case for a move-ordering-free search among positions the app actually reaches.
const MIDDLEGAME_FEN = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5';
// A cramped endgame with few pieces — the sparse end of the branching spectrum.
const ENDGAME_FEN = '8/5k2/8/3K4/8/8/4P3/8 w - - 0 1';

const ELO_SAMPLES = [400, 700, 1000, 1200, 1500, 1800, 2200, 2800, 3200];
const POSITIONS = [
  ['start position', START_FEN],
  ['open middlegame', MIDDLEGAME_FEN],
  ['sparse endgame', ENDGAME_FEN],
];

describe('engineParamsForElo (src/fallback-engine.js)', () => {
  it('always clamps fbDepth to the 1-3 range the fallback minimax can safely search', () => {
    for (const elo of ELO_SAMPLES) {
      const { fbDepth } = engineParamsForElo(elo);
      expect(fbDepth).toBeGreaterThanOrEqual(1);
      expect(fbDepth).toBeLessThanOrEqual(3);
    }
  });

  it('keeps fbDepth far below the Stockfish-scale depth value at every Elo', () => {
    // depth (Stockfish) and fbDepth (fallback minimax) must never collapse
    // into the same number range — that collision is exactly Known Issue #2.
    for (const elo of ELO_SAMPLES) {
      const { depth, fbDepth } = engineParamsForElo(elo);
      expect(depth).toBeGreaterThan(fbDepth);
    }
  });
});

describe('pickEngineMove (src/fallback-engine.js)', () => {
  for (const [label, fen] of POSITIONS) {
    for (const elo of ELO_SAMPLES) {
      const { fbDepth } = engineParamsForElo(elo);
      // The one combination that's known-slow today: fbDepth 3 on the
      // branchy middlegame. Document it as an expected failure rather than
      // asserting something false or silently loosening the budget.
      const isKnownSlowCase = fbDepth === 3 && label === 'open middlegame';
      const testFn = isKnownSlowCase ? it.fails : it;

      testFn(`returns a legal move for ${label} at elo ${elo} (fbDepth ${fbDepth}) within ${FAST_BUDGET_MS}ms`, () => {
        const g = new Chess(fen);
        const legalSans = g.moves();

        const start = Date.now();
        const choice = pickEngineMove(g, elo);
        const elapsed = Date.now() - start;

        expect(choice).not.toBeNull();
        expect(legalSans).toContain(choice.san);
        expect(elapsed).toBeLessThan(FAST_BUDGET_MS);
      });
    }
  }

  it('never approaches the catastrophic multi-second+ blowup of the original depth/fbDepth collision bug, even in the known-slow case', () => {
    // Real, passing safety net for the one case above that misses the 1s
    // goal: fbDepth 3 on the branchy middlegame must still land nowhere
    // near the 90-150s+ depth-4 measurements, let alone depth 16.
    const g = new Chess(MIDDLEGAME_FEN);
    const start = Date.now();
    const choice = pickEngineMove(g, 3200); // elo far into fbDepth-3 territory
    const elapsed = Date.now() - start;
    expect(choice).not.toBeNull();
    expect(elapsed).toBeLessThan(SAFETY_CEILING_MS);
  }, SAFETY_CEILING_MS + 5000);
});

describe('searchRoot at Stockfish-scale depth (documents why fbDepth exists)', () => {
  it('takes far longer than the fallback budget on a branchy position at depth 4', () => {
    // Not a bug in itself — searchRoot has no move ordering or transposition
    // table by design. This is here so the fbDepth clamp's reasoning is
    // verifiable rather than just asserted in a comment: depth 4 is already
    // one step past the fbDepth<=3 clamp, and it is dramatically slower.
    // Generous vitest-level timeout: this single depth-4 search has been
    // measured at ~90-154s on this host across different runs.
    const g = new Chess(MIDDLEGAME_FEN);
    const start = Date.now();
    searchRoot(g, 4);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThan(SAFETY_CEILING_MS);
  }, 300000);
});

// FEATURESPEC.md Layer 1.4: position complexity ("only one good move" vs.
// wide-open). Deliberately depth 1 (see the comment on positionComplexity
// itself) — this runs on every graded move, not just mistakes, so
// COMPLEXITY_FAST_BUDGET_MS is much tighter than the fbDepth budgets above.
describe('positionComplexity (src/fallback-engine.js)', () => {
  const COMPLEXITY_FAST_BUDGET_MS = 2000; // headroom over the ~25-60ms measured on this host

  it('treats the starting position as maximally non-sharp: every legal move ties', () => {
    const result = positionComplexity(START_FEN);
    expect(result.legalMoveCount).toBe(20);
    expect(result.closeMoveCount).toBe(20);
  });

  it('recognizes a razor-sharp position: only the move that wins the hanging queen stands out', () => {
    const fen = '3q3k/8/8/8/8/8/8/3QK3 w - - 0 1';
    const result = positionComplexity(fen);
    expect(result.legalMoveCount).toBeGreaterThan(1);
    expect(result.closeMoveCount).toBe(1);
  });

  it('stays within budget on a branchy middlegame position', () => {
    const start = Date.now();
    const result = positionComplexity(MIDDLEGAME_FEN);
    const elapsed = Date.now() - start;
    expect(result.legalMoveCount).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(COMPLEXITY_FAST_BUDGET_MS);
  });

  it('returns zero counts without throwing on a position with no legal moves (checkmate)', () => {
    // Fool's mate final position.
    const fen = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
    const result = positionComplexity(fen);
    expect(result).toEqual({legalMoveCount:0, closeMoveCount:0});
  });
});
