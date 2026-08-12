// Unit tests for classify() and thresholdFactorForRating() (src/grading.js).
//
// This test suite caught a real inversion bug: classify() originally
// multiplied its thresholds by ratingFactor, but thresholdFactorForRating()
// returns a SMALLER factor for lower ratings — multiplying by a smaller
// factor shrinks the threshold, which made beginners grade MORE harshly
// than strong players for an identical loss, backwards from the documented
// intent ("beginners aren't blundered for normal noise", HANDOFF.md). Fixed
// by dividing instead of multiplying. The "grading direction" describe
// block below exists specifically to guard against that inversion recurring.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { Chess } from 'chess.js';

const require = createRequire(import.meta.url);
const {
  classify, thresholdFactorForRating, tagMistake, classifyTacticalMotif, explainLoss,
  detectSacrifice, materialDiff, sacrificeTier
} = require('../src/grading.js');

describe('thresholdFactorForRating', () => {
  it('returns the neutral factor (1) when no rating is set yet', () => {
    expect(thresholdFactorForRating(null)).toBe(1);
    expect(thresholdFactorForRating(undefined)).toBe(1);
    expect(thresholdFactorForRating(0)).toBe(1);
  });

  it('returns exactly 0.6 at rating 1000 (the formula\'s own reference point)', () => {
    expect(thresholdFactorForRating(1000)).toBeCloseTo(0.6, 10);
  });

  it('clamps to 0.55 at and below rating 600', () => {
    expect(thresholdFactorForRating(600)).toBeCloseTo(0.55, 10);
    expect(thresholdFactorForRating(300)).toBeCloseTo(0.55, 10);
  });

  it('clamps to 1.4 at and above rating 2400', () => {
    expect(thresholdFactorForRating(2400)).toBeCloseTo(1.4, 10);
    expect(thresholdFactorForRating(3000)).toBeCloseTo(1.4, 10);
  });

  it('increases monotonically with rating between the clamps', () => {
    // 600 and below floor-clamp to 0.55 (stays flat until ~913), so start
    // sampling just above that so each step is a genuine strict increase.
    const ratings = [950, 1200, 1500, 1800, 2100, 2400];
    const factors = ratings.map(thresholdFactorForRating);
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeGreaterThan(factors[i - 1]);
    }
  });
});

describe('classify (neutral ratingFactor)', () => {
  it('always grades a mate-delivering move as brilliant, regardless of loss', () => {
    expect(classify(5, false, false, true, 1)).toBe('brilliant');
  });

  it('grades a top-choice sacrifice as brilliant when loss is within the sacrifice bonus band', () => {
    expect(classify(0.1, true, true, false, 1)).toBe('brilliant');
    expect(classify(0.2, true, true, false, 1)).toBe('brilliant'); // boundary, inclusive
  });

  it('does not grant the sacrifice bonus without both wasTop and sacrificed', () => {
    expect(classify(0.1, false, true, false, 1)).not.toBe('brilliant');
    expect(classify(0.1, true, false, false, 1)).not.toBe('brilliant');
  });

  const cases = [
    [0.00, 'best'],
    [0.05, 'best'],       // boundary, inclusive
    [0.06, 'great'],
    [0.15, 'great'],      // boundary, inclusive
    [0.16, 'good'],
    [0.35, 'good'],       // boundary, inclusive
    [0.36, 'inaccuracy'],
    [0.75, 'inaccuracy'], // boundary, inclusive
    [0.76, 'mistake'],
    [1.75, 'mistake'],    // boundary, inclusive
    [1.76, 'blunder'],
    [5.00, 'blunder'],
  ];
  for (const [loss, expected] of cases) {
    it(`classifies a ${loss}-pawn loss as "${expected}" at ratingFactor 1`, () => {
      expect(classify(loss, false, false, false, 1)).toBe(expected);
    });
  }

  it('treats an omitted ratingFactor the same as ratingFactor 1', () => {
    expect(classify(0.5, false, false, false, undefined)).toBe(classify(0.5, false, false, false, 1));
    expect(classify(0.5, false, false, false, null)).toBe(classify(0.5, false, false, false, 1));
  });
});

describe('grading direction across ratingFactor (regression guard for the inversion bug)', () => {
  // For the exact same loss, a higher-rated player must never grade MILDER
  // (lower severity) than a lower-rated player — i.e. severity must be
  // non-decreasing as rating rises. The original bug had this backwards:
  // beginners graded stricter (higher severity) than strong players.
  const GRADE_SEVERITY = ['brilliant', 'best', 'great', 'good', 'inaccuracy', 'mistake', 'blunder'];
  const severityOf = (grade) => GRADE_SEVERITY.indexOf(grade);

  const LOSSES = [0.1, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0];
  const RATINGS = [600, 1000, 1400, 1800, 2200, 2400];

  for (const loss of LOSSES) {
    it(`never grades a higher-rated player milder than a lower-rated player for a ${loss}-pawn loss`, () => {
      const factors = RATINGS.map(thresholdFactorForRating);
      const grades = factors.map((f) => classify(loss, false, false, false, f));
      const severities = grades.map(severityOf);
      for (let i = 1; i < severities.length; i++) {
        expect(severities[i]).toBeGreaterThanOrEqual(severities[i - 1]);
      }
    });
  }

  it('grades the beginner reference point (1000) no stricter than neutral (ratingFactor 1) for a mid-size loss', () => {
    const loss = 0.5;
    const neutralGrade = classify(loss, false, false, false, 1);
    const beginnerGrade = classify(loss, false, false, false, thresholdFactorForRating(1000));
    expect(severityOf(beginnerGrade)).toBeLessThanOrEqual(severityOf(neutralGrade));
  });
});

// Integration coverage for the Layer 1.1 wiring: tagMistake() and
// explainLoss() now consult src/tactics.js's motif detectors via
// classifyTacticalMotif() instead of only recognizing generic
// captures/checks. src/tactics.test.js already covers each detector in
// depth against textbook positions — this just confirms grading.js wires
// them through correctly end to end.
describe('classifyTacticalMotif / tagMistake / explainLoss (Layer 1.1 wiring)', () => {
  // Same knight-fork position as src/tactics.test.js, extended one ply
  // earlier: Black plays a harmless waiting move (h6), then White's Nc6
  // forks the rook on a7 and the queen on d8.
  const preBlunderFen = '3q2k1/r6p/8/8/1N6/8/8/4K3 b - - 0 1';
  const blunderSan = 'h6';
  const replySan = 'Nc6';

  it('classifyTacticalMotif identifies the fork from the pre-blunder position and the reply alone', () => {
    const g = new Chess(preBlunderFen);
    g.move(blunderSan);
    const fenBeforeReply = g.fen();
    const motif = classifyTacticalMotif(preBlunderFen, fenBeforeReply, replySan, 'b');
    expect(motif).not.toBeNull();
    expect(motif.motif).toBe('fork');
  });

  it('tagMistake reports the specific motif instead of a generic bucket', () => {
    const g = new Chess(preBlunderFen);
    g.move(blunderSan);
    const tag = tagMistake(preBlunderFen, g.fen(), replySan, 'b');
    expect(tag).toBe('Walked into a fork');
  });

  it('tagMistake falls back to a generic bucket when no reply is available', () => {
    const g = new Chess(preBlunderFen);
    g.move(blunderSan);
    expect(tagMistake(preBlunderFen, g.fen(), null, 'b')).toBe('Positional inaccuracy');
  });

  it('explainLoss names the exact mechanism when a reply is supplied', () => {
    const explanation = explainLoss(preBlunderFen, blunderSan, null, 0.5, replySan);
    expect(explanation).toMatch(/fork/i);
    expect(explanation).toMatch(/knight/i);
  });

  it('explainLoss falls back to the older generic explanation when no reply is supplied (backward compatible)', () => {
    const explanation = explainLoss(preBlunderFen, blunderSan, null, 0.5);
    expect(explanation).not.toMatch(/fork/i);
  });
});

// Layer 1.2: detectSacrifice() was previously a hardcoded `false` at the
// classify() call site in makePlayerMove() — dead code. Every case below
// double-checks the moves are actually legal on the position before
// asserting anything: several first-draft FENs here referenced an illegal
// move or a piece that didn't exist (e.g. "Nxc6" from a square that can't
// reach c6, or "Qxd5" for a black queen that was never placed on the
// board), and detectSacrifice's own defensive null-move guard silently
// returns `sacrificed:false` for those — output that's indistinguishable
// from a genuinely correct "not a sacrifice" result unless the move
// legality is checked independently first.
describe('detectSacrifice / materialDiff / sacrificeTier (Layer 1.2)', () => {
  it('does not flag an ordinary even trade as a sacrifice', () => {
    // Nxc6 takes a knight for a knight; dxc6 is the natural recapture.
    const preMoveFEN = '4k3/3p4/2n5/4N3/8/8/8/4K3 w - - 0 1';
    const check = new Chess(preMoveFEN);
    expect(check.move('Nxc6')).toBeTruthy();
    expect(check.move('dxc6')).toBeTruthy();

    const result = detectSacrifice(preMoveFEN, 'Nxc6', 'dxc6', 'w');
    expect(result.sacrificed).toBe(false);
    expect(result.materialLost).toBe(0);
  });

  it('flags a clean, uncompensated minor-piece sacrifice as "brilliant" tier', () => {
    const fen = 'r6k/8/8/8/2N5/8/8/4K3 w - - 0 1';
    const check = new Chess(fen);
    expect(check.move('Na5')).toBeTruthy();
    expect(check.move('Rxa5')).toBeTruthy();

    const result = detectSacrifice(fen, 'Na5', 'Rxa5', 'w');
    expect(result.sacrificed).toBe(true);
    expect(result.materialLost).toBe(3);
    expect(sacrificeTier(result.materialLost)).toBe('brilliant');
  });

  it('flags a clean, uncompensated pawn sacrifice as the lesser "great_sacrifice" tier', () => {
    const fen = 'r6k/8/8/8/8/8/P7/4K3 w - - 0 1';
    const check = new Chess(fen);
    expect(check.move('a4')).toBeTruthy();
    expect(check.move('Rxa4')).toBeTruthy();

    const result = detectSacrifice(fen, 'a4', 'Rxa4', 'w');
    expect(result.sacrificed).toBe(true);
    expect(result.materialLost).toBe(1);
    expect(sacrificeTier(result.materialLost)).toBe('great_sacrifice');
  });

  it('does not flag a favorable combination (rook sac, queen recaptures the recapture) as a sacrifice', () => {
    const fen = '3q3k/8/8/3n4/3R4/8/8/3QK3 w - - 0 1';
    const check = new Chess(fen);
    expect(check.move('Rxd5')).toBeTruthy();
    expect(check.move('Qxd5')).toBeTruthy();

    const result = detectSacrifice(fen, 'Rxd5', 'Qxd5', 'w');
    expect(result.sacrificed).toBe(false);
    // Strongly favorable for white once the follow-up recapture is found
    // (+3 knight, -5 rook, +9 queen = +7 net), not merely break-even.
    expect(result.materialLost).toBeLessThan(0);
  });

  it('returns sacrificed:false without throwing when no reply is supplied', () => {
    const fen = 'r6k/8/8/8/2N5/8/8/4K3 w - - 0 1';
    const result = detectSacrifice(fen, 'Na5', null, 'w');
    expect(result).toEqual({sacrificed:false, materialLost:0});
  });

  it('materialDiff nets out both sides rather than counting one side in isolation', () => {
    const g = new Chess(); // starting position: perfectly balanced
    expect(materialDiff(g, 'w')).toBe(0);
    expect(materialDiff(g, 'b')).toBe(0);
  });
});

// Layer 1.3: "once a move is graded and stored, that grade is permanent" —
// directly answers the #1-ranked complaint from the competitive research
// (Chess.com's move labels changing on re-analysis, eroding trust in
// "Brilliant"). classify() and tagMistake() are pure functions with no
// persistence of their own; the app enforces stability by calling them
// exactly once per move (verified by inspecting chess-coach.html: classify(
// is called from a single call site in makePlayerMove(), tagMistake( from
// two call sites that both run at grading/save time, never on
// already-stored data) and storing the returned string as plain data
// (sessionMoves[].grade, profile.savedMistakes[].tag) rather than storing
// the inputs and re-deriving the label on every render. These tests exist
// to demonstrate WHY that storage pattern matters: classify() itself is
// deterministic given fixed inputs, but ratingFactor legitimately changes
// as profile.rating changes between games — so if a caller ever "helpfully"
// re-ran classify() against a historical move using the CURRENT
// ratingFactor instead of reading the stored grade, the label really would
// shift under the user, exactly like the complaint this layer answers.
describe('grade stability (Layer 1.3)', () => {
  it('classify() is deterministic: identical inputs always produce the identical grade', () => {
    const args = [0.4, false, false, false, 0.8];
    const first = classify(...args);
    for (let i = 0; i < 20; i++) {
      expect(classify(...args)).toBe(first);
    }
  });

  it('demonstrates the real risk this layer guards against: the SAME loss legitimately grades differently under a different ratingFactor', () => {
    // This is exactly why a stored grade must never be recomputed against
    // a later ratingFactor — if it were, this is the kind of shift a user
    // would see happen to an already-shown "Blunder" or "Brilliant" label.
    const loss = 0.5;
    const gradeAsBeginner = classify(loss, false, false, false, thresholdFactorForRating(1000));
    const gradeAsExpert = classify(loss, false, false, false, thresholdFactorForRating(2200));
    expect(gradeAsBeginner).not.toBe(gradeAsExpert);
  });

  it('a grade computed and "stored" at move time is unaffected by a later rating change (simulated)', () => {
    const loss = 0.5;
    const ratingAtGradingTime = 1000;
    const storedGrade = classify(loss, false, false, false, thresholdFactorForRating(ratingAtGradingTime));

    // Simulate the rating updating after the game, as it does in
    // finishGame() — the already-stored grade must not be touched by this.
    const ratingAfterUpdate = 1600;
    expect(thresholdFactorForRating(ratingAfterUpdate)).not.toBe(thresholdFactorForRating(ratingAtGradingTime));
    expect(storedGrade).toBe(classify(loss, false, false, false, thresholdFactorForRating(ratingAtGradingTime)));
  });
});
