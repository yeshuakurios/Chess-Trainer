// Unit tests for src/tactics.js — tactical motif detection (Layer 1.1 of
// FEATURESPEC.md). Each detector is checked against a hand-built textbook
// position where the motif is unambiguous, plus at least one case where it
// must NOT fire. These positions caught three real bugs during development:
//   1. chess.js represents a check as a pseudo-legal "capture of the king",
//      but VALUES.k is 0 (material scoring, not motif significance), so
//      naive `VALUES[x] >= 3` checks silently excluded the most forcing
//      case — a fork/skewer/discovery that gives check. Fixed with a
//      motifValue() helper that treats the king as maximally significant.
//   2. detectSkewer originally didn't diff the "revealed" captures against
//      what the attacker could already capture — a queen attacking along
//      an unrelated ray got misattributed as "revealed" by removing the
//      front piece. Fixed by diffing against a `before` snapshot, same
//      technique detectPin already used correctly.
//   3. Kings got treated as ordinary "hanging"/"defended" pieces in
//      detectRemovingDefender and detectOverloadedDefender, producing
//      technically-true but useless noise (e.g. "the king is an overloaded
//      defender" in a normal opening position). Kings are now excluded as
//      dependents everywhere, and excluded as a *reported* overloaded
//      defender specifically, while still counting toward whether another
//      piece is genuinely "sole" defended.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const {
  pseudoLegalMoves, pseudoCaptures, defendersOfSquare,
  detectFork, detectPin, detectSkewer, detectDiscoveredAttack,
  detectRemovingDefender, detectOverloadedDefender, detectBackRankWeakness
} = require('../src/tactics.js');

describe('primitives', () => {
  it('pseudoLegalMoves generates moves for a color regardless of whose actual turn it is', () => {
    // White to move in the FEN, but ask for black's pseudo-legal moves.
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1';
    const blackMoves = pseudoLegalMoves(fen, 'b');
    expect(blackMoves.length).toBeGreaterThan(0);
    expect(blackMoves.every(m => m.color === 'b')).toBe(true);
  });

  it('pseudoCaptures only returns moves with a captured piece', () => {
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5';
    const caps = pseudoCaptures(fen, 'w');
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every(m => !!m.captured)).toBe(true);
  });

  it('defendersOfSquare excludes a pawn defending a square via a straight push', () => {
    // White pawn on e2 can push to e3 (not a defense) but does not
    // diagonally defend e3 the way it would defend d3/f3.
    const fen = '8/8/8/8/8/8/4P3/4K2k w - - 0 1';
    const defenders = defendersOfSquare(fen, 'e3', 'w');
    expect(defenders.find(d => d.piece === 'p')).toBeUndefined();
  });

  it('defendersOfSquare includes a pawn defending a square diagonally', () => {
    const fen = '8/8/8/8/8/8/4P3/4K2k w - - 0 1';
    const defenders = defendersOfSquare(fen, 'd3', 'w');
    expect(defenders.some(d => d.piece === 'p' && d.from === 'e2')).toBe(true);
  });
});

describe('detectFork', () => {
  const fen = '3q2k1/r7/8/8/1N6/8/8/4K3 w - - 0 1';

  it('finds a knight fork attacking a rook and queen simultaneously', () => {
    const result = detectFork(fen, 'Nc6');
    expect(result).not.toBeNull();
    expect(result.motif).toBe('fork');
    expect(result.attackerSquare).toBe('c6');
    const squares = result.targets.map(t => t.square).sort();
    expect(squares).toEqual(['a7', 'd8']);
  });

  it('does not fire for an ordinary developing move', () => {
    const g = new Chess();
    const opening = g.fen();
    expect(detectFork(opening, 'Nf3')).toBeNull();
  });

  it('does not count a single attacked piece as a fork', () => {
    // Knight attacks only the queen, nothing else of value.
    const fen1 = '3q4/8/8/8/1N6/8/8/4K2k w - - 0 1';
    expect(detectFork(fen1, 'Nc6')).toBeNull();
  });
});

describe('detectPin', () => {
  it('finds the Ruy-Lopez-style bishop pin of a knight to the king', () => {
    const fen = '4k3/8/2n5/1B6/8/8/8/4K3 b - - 0 1';
    const result = detectPin(fen, 'b');
    expect(result).not.toBeNull();
    expect(result.motif).toBe('pin');
    expect(result.pinnedSquare).toBe('c6');
    expect(result.attackerSquare).toBe('b5');
    expect(result.behindSquare).toBe('e8');
    expect(result.behindPiece).toBe('k');
  });

  it('does not fire when the line to the king is already blocked by another piece', () => {
    // Actual Ruy Lopez starting position: the d7 pawn still blocks the
    // b5-e8 diagonal, so the knight on c6 is not really pinned yet.
    const g = new Chess();
    g.move('e4'); g.move('e5'); g.move('Nf3'); g.move('Nc6'); g.move('Bb5');
    expect(detectPin(g.fen(), 'b')).toBeNull();
  });

  it('does not fire when nothing more valuable sits behind the piece', () => {
    const fen = '8/8/2n5/1B6/8/8/8/4K2k b - - 0 1'; // nothing behind c6 on that diagonal
    expect(detectPin(fen, 'b')).toBeNull();
  });
});

describe('detectSkewer', () => {
  it('finds a royal skewer (check) with a rook behind the king', () => {
    const fen = '4r3/8/8/4k3/8/8/8/4R1K1 w - - 0 1';
    const result = detectSkewer(fen, 'b');
    expect(result).not.toBeNull();
    expect(result.motif).toBe('skewer');
    expect(result.frontSquare).toBe('e5');
    expect(result.frontPiece).toBe('k');
    expect(result.behindSquare).toBe('e8');
    expect(result.behindPiece).toBe('r');
  });

  it('finds a material-only diagonal skewer (rook in front, bishop behind)', () => {
    const fen = 'k7/6b1/8/8/3r4/8/8/Q6K w - - 0 1';
    const result = detectSkewer(fen, 'b');
    expect(result).not.toBeNull();
    expect(result.frontSquare).toBe('d4');
    expect(result.frontPiece).toBe('r');
    expect(result.behindSquare).toBe('g7');
    expect(result.behindPiece).toBe('b');
  });

  it('does not misattribute a capture on a completely unrelated ray as a skewer', () => {
    // Same queen, same board, but the bishop is one rank off the true
    // diagonal (g6 instead of g7) — no real skewer exists here.
    const fen = 'k7/8/6b1/8/3r4/8/8/Q6K w - - 0 1';
    expect(detectSkewer(fen, 'b')).toBeNull();
  });
});

describe('detectDiscoveredAttack', () => {
  it('finds a discovered check when a blocking knight moves away', () => {
    const fen = '8/8/7k/8/8/4N3/8/2B3K1 w - - 0 1';
    const result = detectDiscoveredAttack(fen, 'Nf5');
    expect(result).not.toBeNull();
    expect(result.motif).toBe('discovered attack');
    expect(result.moverSquare).toBe('f5');
    expect(result.revealedFrom).toBe('c1');
    expect(result.targetSquare).toBe('h6');
    expect(result.targetPiece).toBe('k');
  });

  it('does not fire for an ordinary developing move', () => {
    const g = new Chess();
    expect(detectDiscoveredAttack(g.fen(), 'e4')).toBeNull();
  });
});

describe('detectRemovingDefender', () => {
  it('finds material hanging after the sole defender is captured', () => {
    const fen = '3r3k/8/8/B2r4/8/8/8/7K w - - 0 1';
    const result = detectRemovingDefender(fen, 'Bxd8', 'b');
    expect(result).not.toBeNull();
    expect(result.motif).toBe('removing the defender');
    expect(result.removedSquare).toBe('d8');
    expect(result.hangingSquare).toBe('d5');
    expect(result.hangingPiece).toBe('r');
  });

  it('never reports the king itself as a piece left hanging', () => {
    // The captured rook also happened to be able to reach the king's own
    // square in pseudo-legal terms — that must never be reported as
    // "the king is now hanging".
    const fen = '3r3k/8/8/B2r4/8/8/8/7K w - - 0 1';
    const result = detectRemovingDefender(fen, 'Bxd8', 'b');
    expect(result.hangingPiece).not.toBe('k');
  });

  it('does not fire on a capture that defended nothing else', () => {
    const g = new Chess();
    g.move('e4'); g.move('d5');
    expect(detectRemovingDefender(g.fen(), 'exd5', 'b')).toBeNull();
  });
});

describe('detectOverloadedDefender', () => {
  it('finds a knight overloaded defending two undefended rooks', () => {
    const fen = '7k/8/5r2/3n4/1r6/8/8/K7 w - - 0 1';
    const result = detectOverloadedDefender(fen, 'b');
    expect(result).not.toBeNull();
    expect(result.motif).toBe('overloaded defender');
    expect(result.defenderSquare).toBe('d5');
    expect(result.defenderPiece).toBe('n');
    expect(result.dependentSquares.sort()).toEqual(['b4', 'f6']);
  });

  it('does not fire when the two pieces defend each other too (not sole-dependent on a third piece)', () => {
    // Both rooks share the 6th rank, so each also defends the other —
    // neither is *solely* dependent on the knight.
    const fen = '7k/8/1r3r2/3n4/8/8/8/K7 w - - 0 1';
    const result = detectOverloadedDefender(fen, 'b');
    expect(result).toBeNull();
  });

  it('never reports the king as the overloaded piece', () => {
    const g = new Chess();
    g.move('e4'); g.move('e5'); g.move('Nf3'); g.move('Nc6');
    const result = detectOverloadedDefender(g.fen(), 'b');
    if (result) expect(result.defenderPiece).not.toBe('k');
  });
});

describe('detectBackRankWeakness', () => {
  it('flags a boxed-in king with an enemy rook and no back-rank defense', () => {
    const fen = '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1';
    const result = detectBackRankWeakness(fen, 'b');
    expect(result).not.toBeNull();
    expect(result.motif).toBe('back rank weakness');
    expect(result.kingSquare).toBe('g8');
  });

  it('does not fire when a rook defends the back rank', () => {
    const fen = '4r1k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1';
    expect(detectBackRankWeakness(fen, 'b')).toBeNull();
  });

  it('does not fire when the king has an escape square', () => {
    const fen = '6k1/6pp/8/8/8/8/8/R5K1 w - - 0 1';
    expect(detectBackRankWeakness(fen, 'b')).toBeNull();
  });

  it('does not fire when the king has already left the back rank', () => {
    // King on g6 instead of g8, still boxed by its own pawns on rank 7 —
    // detectBackRankWeakness only ever fires for a king still on its home rank.
    const offRank = '8/5ppp/6k1/8/8/8/8/R5K1 w - - 0 1';
    expect(detectBackRankWeakness(offRank, 'b')).toBeNull();
  });
});
