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
  // small castling bonus
  const hist = g.history();
  if(hist.includes('O-O') || hist.includes('O-O-O')){
    // can't tell which color easily post-hoc cheaply; skip fine-grained, use small flat nudge
  }
  return score;
}

function minimax(g, depth, alpha, beta, maximizing){
  if(depth===0 || g.game_over()) return evaluate(g);
  const moves = g.moves();
  if(maximizing){
    let maxEval = -Infinity;
    for(const m of moves){
      g.move(m);
      const ev = minimax(g, depth-1, alpha, beta, false);
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
      const ev = minimax(g, depth-1, alpha, beta, true);
      g.undo();
      minEval = Math.min(minEval, ev);
      beta = Math.min(beta, ev);
      if(beta<=alpha) break;
    }
    return minEval;
  }
}

// Returns ranked list of {move, score} for every legal move at current position, from white's-perspective score
function searchRoot(g, depth){
  const moves = g.moves({verbose:true});
  const ranked = [];
  for(const m of moves){
    g.move(m.san);
    const score = minimax(g, depth-1, -Infinity, Infinity, g.turn()==='w');
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
  const ranked = searchRoot(g, safeDepth);
  if(ranked.length===0) return null;
  if(Math.random() < blunderChance && ranked.length>1){
    // pick a suboptimal move to simulate a weaker player, biased toward the worse half
    const idx = Math.min(ranked.length-1, Math.floor(Math.random()*ranked.length*0.7)+1);
    return ranked[idx];
  }
  return ranked[0];
}

// Node/Vitest can require() this file directly; the browser (classic
// <script> tag, no `module` global) just skips this block.
if(typeof module !== 'undefined' && module.exports){
  module.exports = { VALUES, MATE_SCORE, evaluate, minimax, searchRoot, engineParamsForElo, pickEngineMove, positionComplexity };
}
