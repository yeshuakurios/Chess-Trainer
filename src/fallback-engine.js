/* ============================================================
   FALLBACK MINIMAX ENGINE
   ------------------------------------------------------------
   Brute-force alpha-beta search used when Stockfish fails to
   initialize. No move ordering, no quiescence search, no
   transposition table — depth MUST stay clamped to ~3 plies or
   this can hang the browser tab (see HANDOFF.md Known Issue #2).

   Loaded via <script src="src/fallback-engine.js"> in the browser
   (classic script — declarations land in the shared page scope,
   same as if this code were still inline). Also require()-able
   from Node for testing.
   ============================================================ */
// Assign onto the real global object rather than `var`-declaring it: see
// the identical note in src/grading.js for why a bare `var Chess` here
// would be unsafe even guarded. Only positionComplexity() below needs
// this — evaluate/minimax/searchRoot/pickEngineMove all operate on an
// already-constructed game object passed in by the caller.
if(typeof Chess === 'undefined' && typeof require === 'function'){
  global.Chess = require('chess.js').Chess;
}

const VALUES = {p:1,n:3,b:3,r:5,q:9,k:0};
const MATE_SCORE = 10000;

function evaluate(g){
  // Terminal positions dominate any material count.
  if(g.in_checkmate()){
    // Side to move is checkmated, so the OTHER side won.
    return g.turn()==='w' ? -MATE_SCORE : MATE_SCORE;
  }
  if(g.in_stalemate() || g.in_draw() || g.in_threefold_repetition() || g.insufficient_material()){
    return 0;
  }
  let score = 0;
  const b = g.board();
  for(let r=0;r<8;r++) for(let f=0;f<8;f++){
    const pc = b[r][f];
    if(pc){
      const v = VALUES[pc.type];
      score += pc.color==='w' ? v : -v;
    }
  }
  return score;
}

// Standard "simplified evaluation function" piece-square tables (Tomasz
// Michniewski), in centipawns, White's perspective, row0 = rank8. Used only
// by evaluatePositional (see below) — NOT by plain evaluate(), which stays
// pure material so positionComplexity (FEATURESPEC.md Layer 1.4) and the
// player's own move-grading fallback keep meaning exactly what they're
// tested and calibrated against.
const PST = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
};

// Material plus lightweight positional bonuses (development, king safety,
// central control). Used only for the engine's OWN move selection
// (pickEngineMove), never for grading. Without any positional signal, every
// quiet move in a position with no captures on the board scores identically
// under plain evaluate() — the depth-limited minimax (no move ordering) then
// has nothing to break ties with beyond move-generation order, which is
// exactly why the fallback bot was observed shuffling a rook back and forth
// (Rb8/Ra8/Rb8) instead of developing: every alternative looked exactly as
// good as that shuffle.
//
// PST_SCALE divides the standard centipawn table values down before adding
// them to material. This was originally /100 (i.e. the raw centipawn table
// values, just rescaled to pawn units) — a real, reported live bug: at that
// scale the summed positional bonus across the board can swing by close to
// a full pawn from a single reply, which is large enough to outweigh actual
// material at this engine's shallow 1-3 ply search depth. Concretely: after
// a queen recaptures a bishop (a clean +2 pawn material swing), the
// positional term alone moved the total eval by -0.9, enough that the
// search ranked "hang a bishop for a pawn" as Black's single best move,
// ahead of every quiet developing alternative. A deep search would
// self-correct this by finding a further refutation; this engine doesn't
// go deep enough for that, so the static eval itself has to keep material
// dominant. /1000 keeps the cumulative positional swing small enough
// (empirically under ~0.1 pawns per ply even in this exact position) to
// never approach the smallest real material difference (one pawn), while
// still being consistent enough to break ties between otherwise
// materially-equal quiet moves — which is all it was ever needed for.
const PST_SCALE = 1000;

function evaluatePositional(g){
  const base = evaluate(g);
  if(Math.abs(base) >= MATE_SCORE) return base; // terminal position, PST is meaningless
  let bonus = 0;
  const b = g.board();
  for(let r=0;r<8;r++) for(let f=0;f<8;f++){
    const pc = b[r][f];
    if(!pc) continue;
    const table = PST[pc.type];
    if(!table) continue;
    const idx = pc.color==='w' ? r*8+f : (7-r)*8+f;
    const v = table[idx]/PST_SCALE; // centipawns -> pawn units, heavily damped (see PST_SCALE)
    bonus += pc.color==='w' ? v : -v;
  }
  return base + bonus;
}

function minimax(g, depth, alpha, beta, maximizing, evalFn){
  const ef = evalFn || evaluate;
  if(depth===0 || g.game_over()) return ef(g);
  const moves = g.moves();
  if(maximizing){
    let maxEval = -Infinity;
    for(const m of moves){
      g.move(m);
      const ev = minimax(g, depth-1, alpha, beta, false, ef);
      g.undo();
      maxEval = Math.max(maxEval, ev);
      alpha = Math.max(alpha, ev);
      if(beta<=alpha) break;
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for(const m of moves){
      g.move(m);
      const ev = minimax(g, depth-1, alpha, beta, true, ef);
      g.undo();
      minEval = Math.min(minEval, ev);
      beta = Math.min(beta, ev);
      if(beta<=alpha) break;
    }
    return minEval;
  }
}

// Returns ranked list of {move, score} for every legal move at current
// position, from white's-perspective score. `evalFn` defaults to the plain
// material evaluate() — pass evaluatePositional explicitly (as
// pickEngineMove does) to rank by material+PST instead.
function searchRoot(g, depth, evalFn){
  const moves = g.moves({verbose:true});
  const ranked = [];
  for(const m of moves){
    g.move(m.san);
    const score = minimax(g, depth-1, -Infinity, Infinity, g.turn()==='w', evalFn);
    g.undo();
    ranked.push({san:m.san, from:m.from, to:m.to, flags:m.flags, captured:m.captured, score});
  }
  ranked.sort((a,b)=> g.turn()==='w' ? b.score-a.score : a.score-b.score);
  return ranked;
}

// How sharp is this position? Counts legal moves scoring within ~0.3 pawns
// of the best move, reusing searchRoot's ranked output. A razor-sharp
// position ("only one good move") and a wide-open one where several moves
// are roughly equally fine call for framing a blunder very differently —
// this is what makes that distinction possible.
//
// Deliberately depth 1, not the deeper depths used elsewhere in this file:
// this runs on every graded move (not just mistakes), so it has to stay
// cheap enough to never be felt — measured at depth 2 on a branchy
// middlegame, a single call already costs 1-1.6s on this host (see
// test/fallback-engine.test.js), which would be a visible per-move stall
// if it ran unconditionally. Depth 1 (tens of ms even on branchy
// positions) trades precision for a metric that's meant to be a coarse
// "how many roughly-similar options existed" signal, not primary grading.
const COMPLEXITY_CLOSE_MARGIN = 0.3;
const COMPLEXITY_DEPTH = 1;

function positionComplexity(fen){
  const g = new Chess(fen);
  const ranked = searchRoot(g, COMPLEXITY_DEPTH);
  if(ranked.length===0) return {legalMoveCount:0, closeMoveCount:0};
  const bestScore = ranked[0].score;
  const closeMoveCount = ranked.filter(r => Math.abs(r.score-bestScore) <= COMPLEXITY_CLOSE_MARGIN).length;
  return {legalMoveCount: ranked.length, closeMoveCount};
}

/* ============================================================
   ELO -> ENGINE STRENGTH MAPPING
   ============================================================ */
// Stockfish's own UCI_Elo strength limiter targets a real Elo directly,
// rather than us guessing at a Skill Level -> Elo mapping.
// UCI_Elo is honored roughly in the 1320-3190 range; below that we still
// enable UCua_LimitStrength but also drop Skill Level and depth hard,
// since UCI_Elo itself won't go low enough for true beginners.
function engineParamsForElo(elo){
  const clampedElo = Math.max(1320, Math.min(3190, Math.round(elo)));
  const depth = Math.max(4, Math.min(16, Math.round(4 + (elo-700)/140)));
  // legacy fallback params for the built-in minimax
  const fbDepth = Math.max(1, Math.min(3, 1 + Math.floor((elo-700)/450)));
  const blunderChance = Math.max(0.03, Math.min(0.45, 0.42 - (elo-600)/2600));
  return {uciElo: clampedElo, depth, fbDepth, blunderChance};
}

function pickEngineMove(g, elo){
  // IMPORTANT: use fbDepth here, not depth. `depth` is sized for Stockfish
  // (4-16 plies with proper pruning); this fallback is a brute-force minimax
  // with no move ordering, so anything past ~3 plies never finishes on a phone.
  // This mismatch is what caused the bot to hang silently in "Basic engine" mode.
  const {fbDepth, blunderChance} = engineParamsForElo(elo);
  // Hard clamp as a second line of defense — this fallback minimax must never
  // run past depth 3 or it can hang the tab regardless of what's passed in.
  const safeDepth = Math.max(1, Math.min(3, fbDepth));
  const ranked = searchRoot(g, safeDepth, evaluatePositional);
  if(ranked.length===0) return null;
  if(Math.random() < blunderChance && ranked.length>1){
    // Pick a suboptimal move to simulate a weaker player — but skewed
    // toward MILD slips rather than uniform across the whole worse half.
    // The old uniform pick treated "loses a whole piece for nothing" and
    // "a slightly less accurate developing move" as equally likely outcomes
    // of the same dice roll, which doesn't match how real human errors are
    // distributed: most mistakes are small, and dropping a full piece for
    // free is comparatively rare even for a ~1200-1250 player. The product
    // of two independent uniform draws is heavily weighted toward 0 (PDF
    // -ln(x)), so most rolls land just past the best move and only
    // occasionally reach deep into the ranked list.
    const skew = Math.random() * Math.random();
    const idx = Math.min(ranked.length-1, Math.floor(skew*ranked.length*0.7)+1);
    return ranked[idx];
  }
  return ranked[0];
}

// Node/Vitest can require() this file directly; the browser (classic
// <script> tag, no `module` global) just skips this block.
if(typeof module !== 'undefined' && module.exports){
  module.exports = { VALUES, MATE_SCORE, evaluate, evaluatePositional, minimax, searchRoot, engineParamsForElo, pickEngineMove, positionComplexity };
}
