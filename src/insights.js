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

// Node/Vitest can require() this file directly; the browser (classic
// <script> tag, no `module` global) just skips this block.
if(typeof module !== 'undefined' && module.exports){
  module.exports = { rankWeaknessesByLeverage, leverageCallout };
}
