/* ============================================================
   LICHESS OPENING EXPLORER INTEGRATION
   ------------------------------------------------------------
   FEATURESPEC.md Layer 3.1. Replaces the tiny hand-written
   OPENING_BOOK (~12 lines) with live data on what masters actually
   play from a given position, via Lichess's free, keyless API
   (https://explorer.lichess.org/masters?fen=...). Grades opening
   moves as "sound and well-tested" vs. "rare/dubious in practice",
   rather than solely against Stockfish's single top line.

   IMPORTANT — this file's live network call was never tested against
   the real API from the development session that wrote it: the
   sandbox's network policy blocked explorer.lichess.org entirely
   (confirmed via direct curl and via a Playwright browser, both
   routed through the same blocking proxy that also blocked the CDN
   scripts elsewhere in this app). Every function here is built and
   unit-tested against a MOCKED fetch matching Lichess's documented
   response shape, not a verified real response. Everything fails
   soft (returns null) on any network error, timeout, non-OK status,
   or unexpected shape, so a wrong assumption about the exact response
   format degrades to "no opening data this move" rather than breaking
   anything — but the exact field names/shape should be spot-checked
   against a real response once this is actually deployed and
   reachable.

   Loaded via <script src="src/opening-explorer.js"> in the browser
   (classic script — declarations land in the shared page scope).
   Also require()-able from Node for testing, where a mock fetch is
   passed in explicitly rather than hitting the real network.
   ============================================================ */

// Only the first ~10-15 plies, per FEATURESPEC.md — deep middlegame
// positions aren't meaningfully "opening theory" anymore, and the
// explorer's master database thins out fast past this point anyway.
const OPENING_EXPLORER_MAX_PLIES = 16;
// Skip the API call at positions too far past named-opening territory
// even within the ply window (a transposed/unusual position that still
// happens to be ply 15 isn't worth a network round trip to look up).
const OPENING_EXPLORER_MIN_GAMES = 50; // don't trust a database of only a handful of games
const OPENING_EXPLORER_SOUND_THRESHOLD = 0.03; // played in >=3% of master games from this position
const OPENING_EXPLORER_DEFAULT_TIMEOUT_MS = 4000;

function withinOpeningWindow(plyIndex){
  return plyIndex <= OPENING_EXPLORER_MAX_PLIES;
}

// Normalizes Lichess's documented masters/lichess explorer response
// shape into {totalGames, moves: [{san, uci, games, freqShare}], opening}.
// Returns null if the shape doesn't look like what's expected, rather
// than throwing — a malformed or future-changed API response should
// degrade to "no data", not crash move grading.
function normalizeExplorerResponse(data){
  if(!data || !Array.isArray(data.moves)) return null;
  const totalGames = (data.white||0) + (data.draws||0) + (data.black||0);
  const moves = data.moves.map((m) => {
    const games = (m.white||0) + (m.draws||0) + (m.black||0);
    return {
      san: m.san,
      uci: m.uci,
      games,
      freqShare: totalGames > 0 ? games / totalGames : 0,
    };
  });
  return {
    totalGames,
    moves,
    opening: (data.opening && data.opening.name) ? {eco: data.opening.eco, name: data.opening.name} : null,
  };
}

// Fetches and normalizes explorer data for a position. `options.fetchFn`
// lets tests (and any environment without a global fetch) inject a mock;
// defaults to the real global fetch when available. Always resolves —
// never rejects — with either the normalized data or null.
async function fetchOpeningExplorer(fen, options){
  const opts = options || {};
  const fetchFn = opts.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if(!fetchFn) return null;

  const database = opts.database || 'masters';
  const timeoutMs = opts.timeoutMs || OPENING_EXPLORER_DEFAULT_TIMEOUT_MS;
  const hasAbort = typeof AbortController !== 'undefined';
  const controller = hasAbort ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try{
    const url = `https://explorer.lichess.org/${database}?fen=${encodeURIComponent(fen)}`;
    const res = await fetchFn(url, controller ? {signal: controller.signal} : undefined);
    if(!res || !res.ok) return null;
    const data = await res.json();
    return normalizeExplorerResponse(data);
  }catch(e){
    // Network error, timeout (abort rejects the fetch), bad JSON — all
    // fail soft. This is a coaching enhancement, not a critical path;
    // it must never be the thing that breaks grading a move.
    return null;
  }finally{
    if(timeoutId) clearTimeout(timeoutId);
  }
}

// Where does the played move stand relative to what masters actually
// play from this position? Returns null when there isn't enough data
// to trust (either the fetch failed, or the database has too few games
// recorded for this exact position to mean anything).
function classifyOpeningMove(explorerData, playedSan){
  if(!explorerData || explorerData.totalGames < OPENING_EXPLORER_MIN_GAMES) return null;
  const played = explorerData.moves.find(m => m.san === playedSan) || null;
  const topMove = explorerData.moves[0] || null; // API already ranks by popularity
  return {
    inBook: !!played,
    freqShare: played ? played.freqShare : 0,
    gamesCount: played ? played.games : 0,
    isTopChoice: !!(played && topMove && played.san === topMove.san),
    isSound: !!(played && played.freqShare >= OPENING_EXPLORER_SOUND_THRESHOLD),
    topMove,
  };
}

// Human-readable line for the played move, naming real master-game
// frequency instead of a hand-authored note. Returns null when there's
// no classification to describe.
function openingMoveCallout(classification, playedSan){
  if(!classification) return null;
  if(classification.isSound){
    const pct = Math.round(classification.freqShare * 100);
    return `That's well-tested in practice — ${playedSan} is played in about ${pct}% of master games from this position.`;
  }
  if(classification.topMove){
    const pct = Math.round(classification.topMove.freqShare * 100);
    return `That's rare in master practice — the main line here is ${classification.topMove.san}, played in about ${pct}% of games from this position.`;
  }
  return `That's essentially unplayed in master games from this position.`;
}

// Node/Vitest can require() this file directly; the browser (classic
// <script> tag, no `module` global) just skips this block.
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    OPENING_EXPLORER_MAX_PLIES, OPENING_EXPLORER_MIN_GAMES, OPENING_EXPLORER_SOUND_THRESHOLD,
    withinOpeningWindow, normalizeExplorerResponse, fetchOpeningExplorer,
    classifyOpeningMove, openingMoveCallout
  };
}
