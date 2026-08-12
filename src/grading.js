/* ============================================================
   MOVE GRADING
   ------------------------------------------------------------
   Loaded via <script src="src/grading.js"> in the browser (classic
   script — declarations land in the shared page scope, same as if
   this code were still inline). Also require()-able from Node for
   testing, where `Chess` and `VALUES` are pulled in explicitly.
   ============================================================ */
// Assign onto the real global object rather than `var`-declaring these:
// in the browser all classic <script> tags share one top-level scope, so a
// hoisted `var Chess`/`var VALUES` here would collide with the `const`
// declarations in chess.js/fallback-engine.js and throw a hard
// "already been declared" SyntaxError — even though the assignment itself
// is guarded, the bare declaration is hoisted unconditionally. Assigning to
// global.Chess/global.VALUES only happens in Node (guarded by `require`
// existing) and never introduces a colliding declaration.
if(typeof Chess === 'undefined' && typeof require === 'function'){
  global.Chess = require('chess.js').Chess;
}
if(typeof VALUES === 'undefined' && typeof require === 'function'){
  global.VALUES = require('./fallback-engine.js').VALUES;
}

// Grading thresholds scale with the player's rating: the same 100-centipawn
// slip is a minor inaccuracy for a beginner and a real mistake for a 1900.
// ratingFactor > 1 tightens thresholds (stronger players held to a stricter bar);
// ratingFactor < 1 loosens them (beginners aren't blundered for normal noise).
function thresholdFactorForRating(rating){
  if(!rating) return 1;                 // no rating yet (diagnostic game) -> neutral
  const r = Math.max(600, Math.min(2400, rating));
  // 1000 rating -> factor ~0.6 (looser), 1800 -> factor 1.0, 2400 -> factor ~1.35
  return Math.max(0.55, Math.min(1.4, 0.6 + (r-1000)/1400*0.8));
}

// loss is in pawns, from the mover's perspective (positive = worse for mover)
// Thresholds are DIVIDED by ratingFactor, not multiplied: thresholdFactorForRating
// returns a smaller f for lower ratings, and dividing by a smaller f produces a
// LARGER effective threshold (looser grading). Multiplying (the original code)
// did the opposite — it shrank thresholds for beginners, grading them MORE
// harshly than strong players for an identical loss, backwards from the
// intent described in HANDOFF.md ("beginners aren't blundered for normal noise").
function classify(loss, wasTop, sacrificed, deliversMate, ratingFactor){
  const f = (ratingFactor===undefined || ratingFactor===null) ? 1 : ratingFactor;
  if(deliversMate) return 'brilliant';
  if(wasTop && sacrificed && loss<=0.2/f) return 'brilliant';
  if(loss<=0.05/f) return 'best';
  if(loss<=0.15/f) return 'great';
  if(loss<=0.35/f) return 'good';
  if(loss<=0.75/f) return 'inaccuracy';
  if(loss<=1.75/f) return 'mistake';
  return 'blunder';
}

function tagMistake(g, moverColor, opponentBestReply){
  if(opponentBestReply && opponentBestReply.captured){
    const v = VALUES[opponentBestReply.captured];
    if(v>=3) return 'Hanging a piece';
    return 'Dropped a pawn';
  }
  if(opponentBestReply && /\+/.test(opponentBestReply.san)) return 'King safety lapse';
  return 'Positional inaccuracy';
}

function pieceName(t){
  return {p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'}[t] || 'piece';
}

// What does the opponent threaten in the CURRENT position (after your move)?
function findThreats(g){
  const replies = g.moves({verbose:true});
  let bestCapture = null;
  let checkReply = null;
  for(const r of replies){
    if(r.captured){
      // is the capturing square defended by us? crude: simulate capture, see if we can recapture
      g.move(r.san);
      const recaptures = g.moves({verbose:true}).filter(m=>m.to===r.to);
      const bestRecapture = recaptures.length ? Math.max(...recaptures.map(m=>VALUES[g.get(m.to) ? g.get(m.to).type : 'p'])) : 0;
      g.undo();
      const gain = VALUES[r.captured] - (recaptures.length ? VALUES[r.piece] : 0);
      if(!bestCapture || gain > bestCapture.gain){
        bestCapture = {san:r.san, captured:r.captured, to:r.to, gain, defended:recaptures.length>0, piece:r.piece};
      }
    }
    if(/\+/.test(r.san) && !checkReply) checkReply = r;
  }
  return {bestCapture, checkReply};
}

// Describe what a move accomplishes, in plain terms
function describeMove(g, san){
  const test = new Chess(g.fen());
  const mv = test.move(san);
  if(!mv) return '';
  const parts = [];
  if(mv.san.includes('#')) return 'it delivers checkmate';
  if(mv.captured) parts.push(`it wins the ${pieceName(mv.captured)} on ${mv.to}`);
  if(mv.san.includes('+')) parts.push('it comes with check, forcing a response');
  if(mv.flags.includes('k') || mv.flags.includes('q')) parts.push('it castles, tucking the king to safety and connecting the rooks');

  // does it create a threat?
  const threats = findThreats(test);
  if(threats.bestCapture && threats.bestCapture.gain>0 && !mv.captured){
    parts.push(`it sets up a threat to win the ${pieceName(threats.bestCapture.captured)}`);
  }
  // central development
  const centralSquares = ['d4','e4','d5','e5','c4','f4','c5','f5'];
  if(!mv.captured && ['n','b'].includes(mv.piece) && parts.length===0){
    parts.push(`it develops the ${pieceName(mv.piece)} toward the center`);
  }
  if(!mv.captured && mv.piece==='p' && centralSquares.includes(mv.to) && parts.length===0){
    parts.push('it stakes out central space');
  }
  if(parts.length===0) parts.push('it improves the position without creating weaknesses');
  return parts.slice(0,2).join(', and ');
}

// Explain WHY the played move lost value
function explainLoss(preFEN, playedSan, bestSan, loss){
  const before = new Chess(preFEN);
  const after = new Chess(preFEN);
  after.move(playedSan);

  const threats = findThreats(after);
  let why = '';

  if(threats.bestCapture && threats.bestCapture.gain >= 1){
    const c = threats.bestCapture;
    if(!c.defended){
      why = `It leaves your ${pieceName(c.captured)} on ${c.to} undefended — the opponent can simply play ${c.san} and take it for free.`;
    } else {
      why = `It allows ${c.san}, winning material on ${c.to} even after you recapture.`;
    }
  } else if(threats.checkReply){
    why = `It exposes your king — the opponent has ${threats.checkReply.san}, and dealing with the check costs you time.`;
  } else {
    // did the played move miss an available capture?
    const availableCaptures = before.moves({verbose:true}).filter(m=>m.captured);
    const bestAvailable = availableCaptures.sort((a,b)=>VALUES[b.captured]-VALUES[a.captured])[0];
    if(bestAvailable && VALUES[bestAvailable.captured]>=3 && bestAvailable.san!==playedSan){
      why = `It passes up material that was on offer — the ${pieceName(bestAvailable.captured)} was available to take.`;
    } else {
      why = `It concedes ground positionally: the piece ends up less active, and the opponent gets a free hand to improve.`;
    }
  }

  const bestWhy = bestSan ? ` Better was ${bestSan}, because ${describeMove(before, bestSan)}.` : '';
  return why + bestWhy;
}

// Node/Vitest can require() this file directly; the browser (classic
// <script> tag, no `module` global) just skips this block.
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    thresholdFactorForRating, classify, tagMistake, pieceName, findThreats,
    describeMove, explainLoss
  };
}
