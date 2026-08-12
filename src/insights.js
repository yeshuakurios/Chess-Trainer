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

/* ---------- 2.3 / 2.4: Sessions, time-of-day, session review ---------- */
// FEATURESPEC.md: "define a session as games with <30-60 min gaps" — 45
// minutes is the midpoint of that stated range.
const DEFAULT_SESSION_GAP_MINUTES = 45;

// Splits profile.gameLog into sessions: consecutive games (sorted by date)
// where the gap between one game ending and the next starting is below the
// threshold. Returns an array of games-arrays, oldest session first.
function groupIntoSessions(gameLog, gapMinutes){
  const gapMs = (gapMinutes || DEFAULT_SESSION_GAP_MINUTES) * 60 * 1000;
  const sorted = [...(gameLog || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
  const sessions = [];
  let lastTime = null;
  for(const g of sorted){
    const t = new Date(g.date).getTime();
    if(lastTime === null || (t - lastTime) > gapMs){
      sessions.push([]);
    }
    sessions[sessions.length - 1].push(g);
    lastTime = t;
  }
  return sessions;
}

function ordinal(n){
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Aggregate summary for one session's worth of games: net rating change,
// and the "common thread" — a mistake tag that showed up in at least two
// different games in the session (not just multiple times in one game),
// since that's what makes it a recurring thread across the sitting rather
// than a single bad moment.
function sessionSummary(sessionGames){
  const games = sessionGames || [];
  const netRatingChange = games.reduce((sum, g) => sum + (g.delta || 0), 0);
  const avgLosses = games.map(g => g.avgCpLoss).filter(v => typeof v === 'number');

  const tagGameCounts = {};
  for(const g of games){
    for(const tag of Object.keys(g.mistakeTagsThisGame || {})){
      tagGameCounts[tag] = (tagGameCounts[tag] || 0) + 1;
    }
  }
  let commonThreadTag = null;
  let bestGameCount = 1; // must appear in at least 2 games to count as a "thread"
  for(const [tag, gameCount] of Object.entries(tagGameCounts)){
    if(gameCount > bestGameCount){ bestGameCount = gameCount; commonThreadTag = tag; }
  }

  return {
    gameCount: games.length,
    netRatingChange,
    avgLossPerGame: avgLosses,
    commonThreadTag,
  };
}

// For each position within a session (1st game, 2nd game, ...), the
// average accuracy (avgCpLoss) of games played at that position, pooled
// across every session in gameLog. This is the raw material for spotting
// a fatigue pattern — it does NOT itself claim there is one.
function accuracyByPositionInSession(gameLog, gapMinutes){
  const sessions = groupIntoSessions(gameLog, gapMinutes);
  const byPosition = {};
  for(const games of sessions){
    games.forEach((g, i) => {
      if(typeof g.avgCpLoss !== 'number') return;
      const pos = i + 1;
      if(!byPosition[pos]) byPosition[pos] = [];
      byPosition[pos].push(g.avgCpLoss);
    });
  }
  return Object.entries(byPosition)
    .map(([pos, losses]) => ({
      position: Number(pos),
      avgLoss: losses.reduce((a, b) => a + b, 0) / losses.length,
      gameCount: losses.length,
    }))
    .sort((a, b) => a.position - b.position);
}

// "Accuracy drops noticeably after your 3rd game in a sitting" — only
// surfaced with a reasonably sampled baseline (>=3 first-games observed)
// and a position with its own reasonable sample (>=2 games) that's at
// least 40% worse than that baseline. Sparse personal data makes false
// patterns easy to see by accident; both sample-size gates exist so this
// doesn't claim a fatigue pattern from two or three total games played.
function fatigueCallout(gameLog, gapMinutes){
  const byPosition = accuracyByPositionInSession(gameLog, gapMinutes);
  if(byPosition.length < 2) return null;
  const baseline = byPosition[0];
  if(baseline.gameCount < 3) return null;
  for(const entry of byPosition.slice(1)){
    if(entry.gameCount < 2) continue;
    if(entry.avgLoss >= baseline.avgLoss * 1.4){
      return `Accuracy drops noticeably after your ${ordinal(entry.position - 1)} game in a sitting.`;
    }
  }
  return null;
}

/* ---------- 2.5: Calibration drift check ---------- */
const CALIBRATION_WINDOW = 10;
const CALIBRATION_MIN_GAMES = 6;
const CALIBRATION_DRIFT_THRESHOLD = 0.25; // 25 percentage points

// Standard Elo expected-score formula, same one finishGame() already uses.
function expectedScore(rating, opponentElo){
  return 1 / (1 + Math.pow(10, (opponentElo - rating) / 400));
}

// Compares actual win rate over the most recent post-diagnostic games
// against what the Elo formula expected, using each game's OWN opponent
// and pre-game rating (reconstructed as rating - delta) rather than
// assuming a flat 50% — since ratingGap deliberately pitches opponents
// above the player, true "expected" is usually somewhat under 50% already.
function calibrationDrift(ratingHistory, windowSize){
  const window = windowSize || CALIBRATION_WINDOW;
  const postDiagnostic = (ratingHistory || []).filter(g => g.delta !== null && g.delta !== undefined);
  const recent = postDiagnostic.slice(-window);
  if(recent.length < CALIBRATION_MIN_GAMES) return null;

  let actualSum = 0, expectedSum = 0;
  for(const g of recent){
    const preRating = g.rating - g.delta;
    actualSum += g.result;
    expectedSum += expectedScore(preRating, g.opponent);
  }
  const actualRate = actualSum / recent.length;
  const expectedRate = expectedSum / recent.length;
  return {gameCount: recent.length, actualRate, expectedRate, deviation: actualRate - expectedRate};
}

// "If someone's winning 80% of recent games, the rating may be stale-low.
// Prompt: 'Want to re-run a calibration game?'" — only fires past a real
// deviation threshold, in either direction (badly underperforming a
// recalibrated rating is just as informative as badly overperforming one).
function calibrationCallout(ratingHistory, windowSize){
  const drift = calibrationDrift(ratingHistory, windowSize);
  if(!drift) return null;
  if(Math.abs(drift.deviation) < CALIBRATION_DRIFT_THRESHOLD) return null;
  const actualPct = Math.round(drift.actualRate * 100);
  const expectedPct = Math.round(drift.expectedRate * 100);
  const staleDirection = drift.deviation > 0 ? 'stale-low' : 'stale-high';
  return `You're winning ${actualPct}% of your last ${drift.gameCount} games (expected ~${expectedPct}%) — your rating may be ${staleDirection}. Want to re-run a calibration game?`;
}

// Node/Vitest can require() this file directly; the browser (classic
// <script> tag, no `module` global) just skips this block.
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    rankWeaknessesByLeverage, leverageCallout,
    phaseForMoveNumber, phaseBreakdown, phaseCallout,
    rankPiecesByLeverage, pieceCallout,
    groupIntoSessions, sessionSummary, accuracyByPositionInSession, fatigueCallout,
    expectedScore, calibrationDrift, calibrationCallout
  };
}
