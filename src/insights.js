/* ============================================================
   PROGRESS INSIGHTS
   ------------------------------------------------------------
   Pure aggregation over data already being stored in `profile` — no
   new engine calls, no LLM. FEATURESPEC.md Layer 2.

   Loaded via <script src="src/insights.js"> in the browser (classic
   script — declarations land in the shared page scope). Also
   require()-able from Node for testing.
   ============================================================ */

/* ---------- 2.1: Leverage-ranked weaknesses ----------
   profile.mistakeTags counts frequency per tag; profile.mistakeCost
   sums centipawn loss per tag (both keyed by the same tag strings
   tagMistake() returns). Ranking by frequency x average_cost is
   mathematically the same as ranking by total accumulated cost
   (count x (totalCost/count) = totalCost) — the multiplication is
   kept as separate displayed fields (count, avgCost) so the UI can
   still say "not your most frequent, but your costliest", while the
   actual sort just uses the total directly rather than recomputing
   a product that could introduce floating-point sort-order noise. */
function rankWeaknessesByLeverage(mistakeTags, mistakeCost){
  const cost = mistakeCost || {};
  const entries = Object.entries(mistakeTags || {}).map(([tag, count]) => {
    const totalCost = cost[tag] || 0;
    const avgCost = count > 0 ? totalCost / count : 0;
    return {tag, count, avgCost, totalCost};
  });
  entries.sort((a, b) => b.totalCost - a.totalCost);
  return entries;
}

// A one-line callout naming the costliest weakness, but only when that's a
// genuinely non-obvious insight — i.e. the costliest tag isn't simply the
// most frequent one, which anyone could already see from the raw counts.
function leverageCallout(ranked){
  if(!ranked || ranked.length < 2) return null;
  const costliest = ranked[0];
  if(costliest.totalCost <= 0) return null;
  const mostFrequent = [...ranked].sort((a, b) => b.count - a.count)[0];
  if(costliest.tag === mostFrequent.tag) return null;
  return `Fixing "${costliest.tag}" would likely be worth more than anything else on this list — it's not your most frequent mistake, but it's your costliest.`;
}

/* ---------- 2.2: Weakness heatmap by phase and piece ---------- */
const INSIGHTS_PIECE_NAMES = {p:'pawn', n:'knight', b:'bishop', r:'rook', q:'queen', k:'king'};

// Per FEATURESPEC.md's own bucket boundaries: "opening <10, middlegame
// 10-30, endgame 30+", in full move numbers (not plies).
function phaseForMoveNumber(moveNumber){
  if(moveNumber < 10) return 'opening';
  if(moveNumber <= 30) return 'middlegame';
  return 'endgame';
}

function phaseBreakdown(mistakesByPhase){
  const phases = mistakesByPhase || {};
  const total = Object.values(phases).reduce((sum, n) => sum + n, 0);
  const entries = ['opening', 'middlegame', 'endgame'].map((phase) => {
    const count = phases[phase] || 0;
    return {phase, count, pct: total > 0 ? Math.round(100 * count / total) : 0};
  });
  return {total, entries};
}

// "73% of blunders happen after move 30" — only surfaced once there's
// enough data to say something meaningful, and only when one phase clearly
// dominates rather than mistakes being spread fairly evenly.
function phaseCallout(mistakesByPhase){
  const {total, entries} = phaseBreakdown(mistakesByPhase);
  if(total < 4) return null;
  const top = [...entries].sort((a, b) => b.count - a.count)[0];
  if(top.pct < 50) return null;
  const phaseLabel = {
    opening: 'the opening',
    middlegame: 'the middlegame',
    endgame: 'the endgame (after move 30)',
  }[top.phase];
  return `${top.pct}% of your mistakes happen in ${phaseLabel}.`;
}

// Same shape as rankWeaknessesByLeverage (count + cost maps keyed by a
// string), so it's reused directly rather than reimplemented — here the
// keys are piece letters (p/n/b/r/q/k) instead of tag names.
function rankPiecesByLeverage(mistakesByPiece, mistakePieceCost){
  return rankWeaknessesByLeverage(mistakesByPiece, mistakePieceCost);
}

// "Knights are your costliest piece" — only surfaced once there's an
// actual cost recorded; a piece with mistakes but zero recorded cost
// (e.g. cost data predates this feature) has nothing meaningful to report.
function pieceCallout(mistakesByPiece, mistakePieceCost){
  const ranked = rankPiecesByLeverage(mistakesByPiece, mistakePieceCost);
  if(ranked.length === 0 || ranked[0].totalCost <= 0) return null;
  const top = ranked[0];
  const name = INSIGHTS_PIECE_NAMES[top.tag] || top.tag;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}s are your costliest piece — ${top.count} mistake${top.count===1?'':'s'} involving them, averaging ${Math.round(top.avgCost)} centipawns.`;
}

// Node/Vitest can require() this file directly; the browser (classic
// <script> tag, no `module` global) just skips this block.
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    rankWeaknessesByLeverage, leverageCallout,
    phaseForMoveNumber, phaseBreakdown, phaseCallout,
    rankPiecesByLeverage, pieceCallout
  };
}
