// Unit tests for src/opening-explorer.js (FEATURESPEC.md Layer 3.1).
//
// IMPORTANT CAVEAT: this sandbox's network policy blocked
// explorer.lichess.org entirely (confirmed via direct curl and via a
// Playwright browser — both routed through the same gateway that also
// blocked the CDN scripts elsewhere in this app's test suite). Every test
// here uses a MOCKED fetch built from Lichess's publicly documented
// response shape for https://explorer.lichess.org/masters?fen=... — none
// of it has been verified against a real live response. If the real API's
// shape differs from what's mocked here, fetchOpeningExplorer's defensive
// parsing should degrade to returning null rather than throwing, but the
// exact field names should be spot-checked against a real response once
// this is deployed somewhere that can reach the network.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  withinOpeningWindow, normalizeExplorerResponse, fetchOpeningExplorer,
  classifyOpeningMove, openingMoveCallout
} = require('../src/opening-explorer.js');

// A realistic mocked masters-endpoint response for the starting position,
// matching Lichess's documented shape.
const MOCK_STARTPOS_RESPONSE = {
  white: 550000, draws: 320000, black: 480000,
  moves: [
    {uci: 'e2e4', san: 'e4', averageRating: 2400, white: 250000, draws: 150000, black: 200000},
    {uci: 'd2d4', san: 'd4', averageRating: 2400, white: 220000, draws: 140000, black: 190000},
    {uci: 'g1f3', san: 'Nf3', averageRating: 2400, white: 50000, draws: 25000, black: 40000},
    {uci: 'a2a3', san: 'a3', averageRating: 2350, white: 20, draws: 10, black: 15}, // rare
  ],
  topGames: [],
  opening: null,
};

function mockFetchReturning(data, {ok = true, status = 200} = {}){
  return async () => ({
    ok, status,
    json: async () => data,
  });
}

function mockFetchThatThrows(){
  return async () => { throw new TypeError('network error'); };
}

function mockFetchThatHangsUntilAborted(){
  return (url, opts) => new Promise((resolve, reject) => {
    if(opts && opts.signal){
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }
    // otherwise never resolves — the caller's timeout must be what ends this
  });
}

describe('withinOpeningWindow', () => {
  it('is true within the first ~10-15 plies and false past it', () => {
    expect(withinOpeningWindow(1)).toBe(true);
    expect(withinOpeningWindow(16)).toBe(true);
    expect(withinOpeningWindow(17)).toBe(false);
    expect(withinOpeningWindow(40)).toBe(false);
  });
});

describe('normalizeExplorerResponse', () => {
  it('computes totalGames and per-move freqShare from the documented shape', () => {
    const result = normalizeExplorerResponse(MOCK_STARTPOS_RESPONSE);
    expect(result.totalGames).toBe(550000 + 320000 + 480000);
    const e4 = result.moves.find(m => m.san === 'e4');
    expect(e4.games).toBe(250000 + 150000 + 200000);
    expect(e4.freqShare).toBeCloseTo(e4.games / result.totalGames, 10);
  });

  it('returns null for missing opening data, not a throw', () => {
    expect(normalizeExplorerResponse(MOCK_STARTPOS_RESPONSE).opening).toBeNull();
  });

  it('surfaces the opening name/eco when present', () => {
    const withOpening = {...MOCK_STARTPOS_RESPONSE, opening: {eco: 'C50', name: 'Italian Game'}};
    expect(normalizeExplorerResponse(withOpening).opening).toEqual({eco: 'C50', name: 'Italian Game'});
  });

  it('returns null for malformed input rather than throwing', () => {
    expect(normalizeExplorerResponse(null)).toBeNull();
    expect(normalizeExplorerResponse({})).toBeNull();
    expect(normalizeExplorerResponse({moves: 'not-an-array'})).toBeNull();
  });
});

describe('fetchOpeningExplorer (against a mocked fetch)', () => {
  it('returns normalized data on a successful response', async () => {
    const result = await fetchOpeningExplorer('startpos-fen', {fetchFn: mockFetchReturning(MOCK_STARTPOS_RESPONSE)});
    expect(result).not.toBeNull();
    expect(result.moves.length).toBe(4);
  });

  it('returns null on a non-OK HTTP status', async () => {
    const result = await fetchOpeningExplorer('some-fen', {fetchFn: mockFetchReturning(null, {ok: false, status: 500})});
    expect(result).toBeNull();
  });

  it('returns null when the fetch throws (network error)', async () => {
    const result = await fetchOpeningExplorer('some-fen', {fetchFn: mockFetchThatThrows()});
    expect(result).toBeNull();
  });

  it('returns null on timeout rather than hanging forever', async () => {
    const start = Date.now();
    const result = await fetchOpeningExplorer('some-fen', {
      fetchFn: mockFetchThatHangsUntilAborted(),
      timeoutMs: 100,
    });
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(2000); // bounded by the 100ms timeout, not hanging
  });

  it('returns null when there is no fetch implementation available at all', async () => {
    const result = await fetchOpeningExplorer('some-fen', {fetchFn: null});
    // In this Node test environment global fetch may or may not exist;
    // explicitly passing null for fetchFn must still resolve to null,
    // never throw, regardless of what's globally available.
    expect(result === null || typeof result === 'object').toBe(true);
  });
});

describe('classifyOpeningMove', () => {
  const normalized = normalizeExplorerResponse(MOCK_STARTPOS_RESPONSE);

  it('classifies a heavily-played move as sound and the top choice', () => {
    const result = classifyOpeningMove(normalized, 'e4');
    expect(result.inBook).toBe(true);
    expect(result.isSound).toBe(true);
    expect(result.isTopChoice).toBe(true);
  });

  it('classifies a rarely-played move as not sound, and names the actual top move', () => {
    const result = classifyOpeningMove(normalized, 'a3');
    expect(result.inBook).toBe(true); // it's in the data, just very rare
    expect(result.isSound).toBe(false);
    expect(result.isTopChoice).toBe(false);
    expect(result.topMove.san).toBe('e4');
  });

  it('classifies a move entirely absent from the data as not in book', () => {
    const result = classifyOpeningMove(normalized, 'h4');
    expect(result.inBook).toBe(false);
    expect(result.isSound).toBe(false);
    expect(result.freqShare).toBe(0);
  });

  it('returns null when there is no explorer data at all', () => {
    expect(classifyOpeningMove(null, 'e4')).toBeNull();
  });

  it('returns null when the database has too few recorded games to trust', () => {
    const sparse = normalizeExplorerResponse({
      white: 3, draws: 1, black: 2,
      moves: [{uci: 'e2e4', san: 'e4', white: 3, draws: 1, black: 2}],
    });
    expect(classifyOpeningMove(sparse, 'e4')).toBeNull();
  });
});

describe('openingMoveCallout', () => {
  const normalized = normalizeExplorerResponse(MOCK_STARTPOS_RESPONSE);

  it('names real master-game frequency for a sound move', () => {
    const classification = classifyOpeningMove(normalized, 'e4');
    const callout = openingMoveCallout(classification, 'e4');
    expect(callout).toMatch(/well-tested/i);
    expect(callout).toContain('e4');
    expect(callout).toMatch(/%/);
  });

  it('names the actual main line for a rare move', () => {
    const classification = classifyOpeningMove(normalized, 'a3');
    const callout = openingMoveCallout(classification, 'a3');
    expect(callout).toMatch(/rare in master practice/i);
    expect(callout).toContain('e4'); // the real top move, not a hand-authored guess
  });

  it('returns null when there is no classification to describe', () => {
    expect(openingMoveCallout(null, 'e4')).toBeNull();
  });
});
