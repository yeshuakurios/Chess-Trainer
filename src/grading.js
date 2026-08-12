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
if(typeof detectFork === 'undefined' && typeof require === 'function'){
  const tactics = require('./tactics.js');
  global.detectFork = tactics.detectFork;
  global.detectPin = tactics.detectPin;
  global.detectSkewer = tactics.detectSkewer;
  global.detectDiscoveredAttack = tactics.detectDiscoveredAttack;
  global.detectRemovingDefender = tactics.detectRemovingDefender;
  global.detectOverloadedDefender = tactics.detectOverloadedDefender;
  global.detectBackRankWeakness = tactics.detectBackRankWeakness;
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

function pieceName(t){
  return {p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'}[t] || 'piece';
}

// Runs the Layer-1.1 motif detectors in priority order and returns the
// first (most significant) match, or null if none apply. `playerColor` is
// the color of the player who just made the mistake — i.e. whose pieces
// might now be forked/pinned/skewered/etc. `replySan` is the opponent's
// actual best reply after that mistake (from Stockfish's bestmove, or the
// fallback search when Stockfish isn't available) — without a real reply
// to analyze, no motif can be identified.
function classifyTacticalMotif(fenBeforePlayerMove, fenBeforeReply, replySan, playerColor){
  if(!replySan || !fenBeforeReply) return null;
  const g = new Chess(fenBeforeReply);
  const mv = g.move(replySan);
  if(!mv) return null;
  const fenAfterReply = g.fen();

  const backRank = detectBackRankWeakness(fenAfterReply, playerColor);
  if(backRank) return backRank;
  const fork = detectFork(fenBeforeReply, replySan);
  if(fork) return fork;
  const skewer = detectSkewer(fenAfterReply, playerColor);
  if(skewer) return skewer;
  const pin = detectPin(fenAfterReply, playerColor);
  if(pin) return pin;
  const discovered = detectDiscoveredAttack(fenBeforeReply, replySan);
  if(discovered) return discovered;
  const removingDefender = detectRemovingDefender(fenBeforeReply, replySan, playerColor);
  if(removingDefender) return removingDefender;
  if(fenBeforePlayerMove){
    const overloaded = detectOverloadedDefender(fenBeforePlayerMove, playerColor);
    if(overloaded) return overloaded;
  }
  return null;
}

// Short label for the mistake ledger / drill tags.
function motifTagLabel(motif){
  switch(motif.motif){
    case 'fork': return 'Walked into a fork';
    case 'pin': return 'Walked into a pin';
    case 'skewer': return 'Walked into a skewer';
    case 'discovered attack': return 'Walked into a discovered attack';
    case 'removing the defender': return 'Left a piece undefended';
    case 'overloaded defender': return 'Overloaded a defender';
    case 'back rank weakness': return 'Back rank weakness';
    default: return 'Positional inaccuracy';
  }
}

// Full sentence naming the exact tactical mechanism, for explainLoss().
function describeMotif(motif){
  switch(motif.motif){
    case 'fork': {
      const targets = motif.targets.map(t => `your ${pieceName(t.piece)} on ${t.square}`).join(' and ');
      return `That walks into a fork — the opponent's ${pieceName(motif.attackerPiece)} on ${motif.attackerSquare} now attacks ${targets} at once.`;
    }
    case 'pin': {
      const behind = motif.behindPiece==='k' ? 'king' : pieceName(motif.behindPiece);
      return `That walks into a pin — your ${pieceName(motif.pinnedPiece)} on ${motif.pinnedSquare} can't move without exposing your ${behind} on ${motif.behindSquare} to the opponent's ${pieceName(motif.attackerPiece)} on ${motif.attackerSquare}.`;
    }
    case 'skewer': {
      const front = motif.frontPiece==='k' ? 'king' : pieceName(motif.frontPiece);
      return `That walks into a skewer — the opponent's ${pieceName(motif.attackerPiece)} on ${motif.attackerSquare} attacks your ${front} on ${motif.frontSquare}, and once it moves, your ${pieceName(motif.behindPiece)} on ${motif.behindSquare} falls too.`;
    }
    case 'discovered attack': {
      const target = motif.targetPiece==='k' ? 'king' : pieceName(motif.targetPiece);
      return `That walks into a discovered attack — moving the ${pieceName(motif.moverPiece)} to ${motif.moverSquare} uncovers the opponent's ${pieceName(motif.revealedPiece)} on ${motif.revealedFrom}, which now attacks your ${target} on ${motif.targetSquare}.`;
    }
    case 'removing the defender':
      return `That removes the defender — the opponent captured your ${pieceName(motif.removedPiece)} on ${motif.removedSquare}, which was the only piece defending your ${pieceName(motif.hangingPiece)} on ${motif.hangingSquare}. It's hanging now.`;
    case 'overloaded defender':
      return `Your ${pieceName(motif.defenderPiece)} on ${motif.defenderSquare} was overloaded — it was the sole defender of ${motif.dependentSquares.length} pieces (${motif.dependentSquares.join(', ')}), more than it could actually cover.`;
    case 'back rank weakness':
      return `Your king on ${motif.kingSquare} is boxed in on the back rank with no escape square and nothing covering it — a real back-rank danger.`;
    default:
      return '';
  }
}

// tagMistake identifies the specific tactical motif the opponent's reply
// exploited (fork, pin, skewer, ...), falling back to the older generic
// buckets (Hanging a piece / Dropped a pawn / King safety lapse /
// Positional inaccuracy) when no specific motif is detected — e.g. a slow
// positional slip rather than a concrete tactic.
function tagMistake(fenBeforePlayerMove, fenBeforeReply, replySan, playerColor){
  const motif = classifyTacticalMotif(fenBeforePlayerMove, fenBeforeReply, replySan, playerColor);
  if(motif) return motifTagLabel(motif);

  if(replySan && fenBeforeReply){
    const g = new Chess(fenBeforeReply);
    const mv = g.move(replySan);
    if(mv && mv.captured){
      return VALUES[mv.captured]>=3 ? 'Hanging a piece' : 'Dropped a pawn';
    }
    if(mv && /\+/.test(mv.san)) return 'King safety lapse';
  }
  return 'Positional inaccuracy';
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

// Explain WHY the played move lost value. `replySan` (optional) is the
// opponent's actual best reply — when present, prefer naming the exact
// tactical mechanism it exploits (fork, pin, skewer, ...) over the older,
// generic "undefended piece" / "exposes your king" framing below, which
// only sees captures and checks and can't name a specific motif.
function explainLoss(preFEN, playedSan, bestSan, loss, replySan){
  const before = new Chess(preFEN);
  const after = new Chess(preFEN);
  const playedMv = after.move(playedSan);

  if(playedMv && replySan){
    const motif = classifyTacticalMotif(preFEN, after.fen(), replySan, playedMv.color);
    if(motif){
      const bestWhy = bestSan ? ` Better was ${bestSan}, because ${describeMove(before, bestSan)}.` : '';
      return describeMotif(motif) + bestWhy;
    }
  }

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
    describeMove, explainLoss, classifyTacticalMotif, motifTagLabel, describeMotif
  };
}
