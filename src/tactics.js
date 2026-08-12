/* ============================================================
   TACTICAL MOTIF DETECTION
   ------------------------------------------------------------
   Deterministic board scans — no LLM, no external service. Detects,
   for a given "opponent's best reply" after a player mistake/blunder:
   fork, pin, skewer, discovered attack, removing the defender,
   overloaded defender, and back rank weakness.

   Everything here is built on two primitives:
     - pseudoLegalMoves(fen, color): every move `color` could make,
       ignoring whether it would leave that color's own king in check
       (chess.js's `legal:false` option). This is what lets us ask
       "what does this piece attack" independent of whose actual turn
       it is, and independent of pins on the attacker itself.
     - defendersOfSquare(fen, square, color): which of `color`'s
       pieces could recapture on `square`, found by temporarily
       emptying the square (chess.js won't generate a "move" onto a
       square occupied by your own piece, which is otherwise exactly
       what a defended square looks like).

   Loaded via <script src="src/tactics.js"> in the browser (classic
   script — declarations land in the shared page scope). Also
   require()-able from Node for testing, where `Chess` and `VALUES`
   are pulled in explicitly, same pattern as src/grading.js.
   ============================================================ */
if(typeof Chess === 'undefined' && typeof require === 'function'){
  global.Chess = require('chess.js').Chess;
}
if(typeof VALUES === 'undefined' && typeof require === 'function'){
  global.VALUES = require('./fallback-engine.js').VALUES;
}

const TACTICS_FILES = ['a','b','c','d','e','f','g','h'];

function oppositeColor(c){ return c==='w' ? 'b' : 'w'; }

// chess.js .board() is indexed [rank 0=8th..7=1st][file 0=a..7=h];
// this mirrors the same square-naming used throughout chess-coach.html.
function squareNameAt(r, f){ return TACTICS_FILES[f] + (8-r); }

function fileIndex(square){ return TACTICS_FILES.indexOf(square[0]); }
function rankOf(square){ return square[1]; }

// Force a FEN to a given side to move, for pseudo-legal generation from
// that side's perspective regardless of the actual game state. Clears the
// en-passant target since it's only ever valid for the side that just
// became "to move" for real, and a stale one can make chess.js reject the FEN.
function withTurn(fen, color){
  const parts = fen.split(' ');
  if(parts[1] !== color){
    parts[1] = color;
    parts[3] = '-';
  }
  return parts.join(' ');
}

function pseudoLegalMoves(fen, color){
  const g = new Chess(withTurn(fen, color));
  return g.moves({legal:false, verbose:true});
}

function pseudoCaptures(fen, color){
  return pseudoLegalMoves(fen, color).filter(m => m.captured);
}

function sameMove(a, b){ return a.from===b.from && a.to===b.to; }

// VALUES.k is 0 (checkmate is scored as a terminal state elsewhere, not
// material), but chess.js's pseudo-legal generator happily represents a
// check as "capturing the king" — a real and often the MOST forcing case
// for fork/skewer/discovered-attack detection. Treat the king as maximally
// valuable for "is this target significant" checks without touching the
// real VALUES table used for material scoring elsewhere.
function motifValue(pieceType){
  return pieceType==='k' ? Infinity : VALUES[pieceType];
}

// Which of `color`'s pieces defend `square` (would recapture/cover it if an
// enemy piece stood there)? Works whether or not something currently
// occupies `square`: a dummy enemy piece (a knight — arbitrary choice, its
// type doesn't matter) is placed there rather than leaving it empty, because
// chess.js's pawn move generator only produces a diagonal move when there's
// an actual piece to capture — an EMPTY diagonal square never generates one,
// so a pawn's real defensive coverage would otherwise be invisible here.
// Occupying the square this way also means a friendly pawn's straight push
// is correctly never generated onto it (pushes require an empty target),
// so no extra pawn-specific filtering is needed afterward.
function defendersOfSquare(fen, square, color){
  const g = new Chess(fen);
  g.remove(square);
  g.put({type:'n', color: oppositeColor(color)}, square);
  return pseudoLegalMoves(g.fen(), color).filter(m => m.to === square);
}

function kingSquareOf(g, color){
  const board = g.board();
  for(let r=0;r<8;r++) for(let f=0;f<8;f++){
    const pc = board[r][f];
    if(pc && pc.color===color && pc.type==='k') return squareNameAt(r,f);
  }
  return null;
}

/* ---------- FORK ----------
   The piece that just moved attacks 2+ of the opponent's pieces
   (value >= 3) simultaneously. */
function detectFork(fenBeforeReply, replySan){
  const g = new Chess(fenBeforeReply);
  const mv = g.move(replySan);
  if(!mv) return null;
  const targetColor = oppositeColor(mv.color);
  const attacks = pseudoLegalMoves(g.fen(), mv.color)
    .filter(m => m.from===mv.to && m.captured);
  const seen = new Map();
  for(const a of attacks){
    if(motifValue(a.captured) >= 3) seen.set(a.to, a);
  }
  const targets = [...seen.values()];
  if(targets.length >= 2){
    return {
      motif:'fork',
      attackerSquare: mv.to, attackerPiece: mv.piece,
      targets: targets.map(t => ({square:t.to, piece:t.captured}))
    };
  }
  return null;
}

/* ---------- PIN ----------
   A defender's piece can't move without exposing a more valuable piece
   (or the king) behind it on the same line to an enemy slider. Found by
   temporarily removing each candidate piece and checking whether that
   *creates* a capture on something more valuable — a discovered-attack
   diff, just via removal instead of a move. */
function detectPin(fenAfterReply, defenderColor){
  const g = new Chess(fenAfterReply);
  const attackerColor = oppositeColor(defenderColor);
  const before = pseudoCaptures(fenAfterReply, attackerColor);
  const board = g.board();
  for(let r=0;r<8;r++) for(let f=0;f<8;f++){
    const pc = board[r][f];
    if(!pc || pc.color!==defenderColor || pc.type==='k') continue;
    const sq = squareNameAt(r,f);
    const g2 = new Chess(fenAfterReply);
    g2.remove(sq);
    const after = pseudoCaptures(g2.fen(), attackerColor);
    const revealed = after.filter(a => !before.some(b => sameMove(a,b)));
    for(const cap of revealed){
      if(motifValue(cap.captured) > motifValue(pc.type)){
        return {
          motif:'pin',
          pinnedSquare: sq, pinnedPiece: pc.type,
          attackerSquare: cap.from, attackerPiece: cap.piece,
          behindSquare: cap.to, behindPiece: cap.captured
        };
      }
    }
  }
  return null;
}

/* ---------- SKEWER ----------
   Same line-based mechanic as a pin, but the more valuable piece is hit
   FIRST (directly attacked) and a lesser piece sits behind it, exposed
   once the front piece is forced to move. */
function detectSkewer(fenAfterReply, defenderColor){
  const attackerColor = oppositeColor(defenderColor);
  // `before` doubles as "all of the attacker's current direct captures" AND
  // the baseline for the reveal diff below — a queen/rook/bishop can attack
  // along several independent rays from one square, so without diffing
  // against what it could already capture, an unrelated capture on a
  // completely different ray gets misattributed as "revealed" by removing
  // the front piece, even though it had nothing to do with that line.
  const before = pseudoCaptures(fenAfterReply, attackerColor);
  for(const atk of before){
    if(motifValue(atk.captured) < 3) continue; // front piece must be worth skewering
    const g2 = new Chess(fenAfterReply);
    g2.remove(atk.to);
    const after = pseudoCaptures(g2.fen(), attackerColor);
    const revealed = after.filter(a =>
      a.from === atk.from && !before.some(b => sameMove(a,b))
    );
    for(const ext of revealed){
      if(motifValue(ext.captured) < motifValue(atk.captured)){
        return {
          motif:'skewer',
          frontSquare: atk.to, frontPiece: atk.captured,
          attackerSquare: atk.from, attackerPiece: atk.piece,
          behindSquare: ext.to, behindPiece: ext.captured
        };
      }
    }
  }
  return null;
}

/* ---------- DISCOVERED ATTACK ----------
   Compare the enemy's attacked squares immediately before vs. after their
   move; if a piece OTHER than the one that moved gained a new attack on
   something valuable, that's the discovery. */
function detectDiscoveredAttack(fenBeforeReply, replySan){
  const g = new Chess(fenBeforeReply);
  const mv = g.move(replySan);
  if(!mv) return null;
  const enemyColor = mv.color;
  const before = pseudoCaptures(fenBeforeReply, enemyColor);
  const after = pseudoCaptures(g.fen(), enemyColor);
  const newCaptures = after.filter(a =>
    a.from !== mv.to && !before.some(b => sameMove(a,b))
  );
  const valuable = newCaptures.find(c => motifValue(c.captured) >= 3);
  if(valuable){
    return {
      motif:'discovered attack',
      moverSquare: mv.to, moverPiece: mv.piece,
      revealedFrom: valuable.from, revealedPiece: valuable.piece,
      targetSquare: valuable.to, targetPiece: valuable.captured
    };
  }
  return null;
}

/* ---------- REMOVING THE DEFENDER ----------
   The opponent's move captures a piece that was the SOLE defender of
   something else, which is now hanging as a result. (Deflection — forcing
   the defender away without capturing it — isn't attempted here; it needs
   a "was this move forced" judgment this scan doesn't make.) */
function detectRemovingDefender(fenBeforeReply, replySan, defenderColor){
  const g = new Chess(fenBeforeReply);
  const mv = g.move(replySan);
  if(!mv || !mv.captured) return null;
  const removedSquare = mv.to;
  const before = new Chess(fenBeforeReply);
  const board = before.board();
  for(let r=0;r<8;r++) for(let f=0;f<8;f++){
    const pc = board[r][f];
    // Kings aren't "hanging pieces" in the material sense this motif is
    // about — being newly reachable by the enemy is a checkmate concern,
    // handled by classify()'s own deliversMate/checkReply logic, not this scan.
    if(!pc || pc.color!==defenderColor || pc.type==='k') continue;
    const sq = squareNameAt(r,f);
    if(sq === removedSquare) continue;
    const defenders = defendersOfSquare(fenBeforeReply, sq, defenderColor);
    if(defenders.length===1 && defenders[0].from===removedSquare){
      return {
        motif:'removing the defender',
        removedSquare, removedPiece: mv.captured,
        hangingSquare: sq, hangingPiece: pc.type
      };
    }
  }
  return null;
}

/* ---------- OVERLOADED DEFENDER ----------
   A pre-existing structural weakness rather than something the reply
   creates: a piece that is the sole defender of 2+ other pieces is being
   asked to do too much, and a mistake often stems from that. Evaluated on
   the position BEFORE the player's move, since it's a diagnosis of what
   led to the mistake, not a consequence of the opponent's reply. */
function detectOverloadedDefender(fenBeforePlayerMove, defenderColor){
  const g = new Chess(fenBeforePlayerMove);
  const board = g.board();
  const dependents = new Map(); // defenderSquare -> [dependentSquare, ...]
  for(let r=0;r<8;r++) for(let f=0;f<8;f++){
    const pc = board[r][f];
    // Same reasoning as detectRemovingDefender: a king isn't a "dependent"
    // piece in the material-overload sense.
    if(!pc || pc.color!==defenderColor || pc.type==='k') continue;
    const sq = squareNameAt(r,f);
    const defenders = defendersOfSquare(fenBeforePlayerMove, sq, defenderColor);
    // A king covering a square still counts toward whether it's genuinely
    // "sole"-defended by something else (don't ignore it there, or a piece
    // the king also defends looks falsely sole-responsible). But the king
    // itself should never be reported as the overloaded piece — it isn't
    // one that can be distracted away to win material the way a
    // knight/bishop/rook can, so skip promoting it as a defenderSquare.
    if(defenders.length===1 && defenders[0].piece !== 'k'){
      const d = defenders[0].from;
      if(!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(sq);
    }
  }
  for(const [defenderSquare, deps] of dependents){
    if(deps.length >= 2){
      const piece = g.get(defenderSquare);
      return {
        motif:'overloaded defender',
        defenderSquare, defenderPiece: piece.type,
        dependentSquares: deps
      };
    }
  }
  return null;
}

/* ---------- BACK RANK WEAKNESS ----------
   The defender's king is still on the back rank, boxed in with no escape
   square, while the attacker still has a rook or queen and the defender
   has nothing covering the back rank near the king. A heuristic, not a
   forced-mate prover — real back-rank danger also depends on tempo and
   whose move it is, which this scan doesn't try to resolve. */
function detectBackRankWeakness(fen, defenderColor){
  const g = new Chess(fen);
  const kingSquare = kingSquareOf(g, defenderColor);
  if(!kingSquare) return null;
  const homeRank = defenderColor==='w' ? '1' : '8';
  if(rankOf(kingSquare) !== homeRank) return null;

  const escapeRank = defenderColor==='w' ? '2' : '7';
  const kf = fileIndex(kingSquare);
  let hasEscape = false;
  for(let f = Math.max(0,kf-1); f <= Math.min(7,kf+1); f++){
    const sq = TACTICS_FILES[f] + escapeRank;
    if(!g.get(sq)){ hasEscape = true; break; }
  }
  if(hasEscape) return null;

  const attackerColor = oppositeColor(defenderColor);
  const board = g.board();
  let attackerHasHeavyPiece = false;
  let defenderCoversBackRank = false;
  for(let r=0;r<8;r++) for(let f=0;f<8;f++){
    const pc = board[r][f];
    if(!pc) continue;
    if(pc.color===attackerColor && (pc.type==='r' || pc.type==='q')) attackerHasHeavyPiece = true;
    if(pc.color===defenderColor && (pc.type==='r' || pc.type==='q') && rankOf(squareNameAt(r,f))===homeRank){
      defenderCoversBackRank = true;
    }
  }
  if(attackerHasHeavyPiece && !defenderCoversBackRank){
    return { motif:'back rank weakness', kingSquare };
  }
  return null;
}

// Node/Vitest can require() this file directly; the browser (classic
// <script> tag, no `module` global) just skips this block.
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    oppositeColor, squareNameAt, pseudoLegalMoves, pseudoCaptures,
    defendersOfSquare, kingSquareOf,
    detectFork, detectPin, detectSkewer, detectDiscoveredAttack,
    detectRemovingDefender, detectOverloadedDefender, detectBackRankWeakness
  };
}
