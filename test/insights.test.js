// Unit tests for src/insights.js — pure aggregation over profile data
// (FEATURESPEC.md Layer 2). No engine calls, no persistence — these tests
// construct plain mistakeTags/mistakeCost objects directly.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  rankWeaknessesByLeverage, leverageCallout,
  phaseForMoveNumber, phaseBreakdown, phaseCallout,
  rankPiecesByLeverage, pieceCallout
} = require('../src/insights.js');

describe('rankWeaknessesByLeverage (Layer 2.1)', () => {
  it('ranks by total accumulated cost, not raw frequency', () => {
    // "Dropped a pawn" happens twice as often but costs far less overall
    // than "Walked into a fork", which should rank first despite being
    // less frequent — this is the whole point of the feature.
    const mistakeTags = { 'Dropped a pawn': 10, 'Walked into a fork': 2 };
    const mistakeCost = { 'Dropped a pawn': 10 * 60, 'Walked into a fork': 2 * 400 };
    const ranked = rankWeaknessesByLeverage(mistakeTags, mistakeCost);
    expect(ranked[0].tag).toBe('Walked into a fork');
    expect(ranked[1].tag).toBe('Dropped a pawn');
  });

  it('computes count, avgCost, and totalCost correctly per tag', () => {
    const mistakeTags = { 'Walked into a fork': 4 };
    const mistakeCost = { 'Walked into a fork': 1200 };
    const [entry] = rankWeaknessesByLeverage(mistakeTags, mistakeCost);
    expect(entry.count).toBe(4);
    expect(entry.totalCost).toBe(1200);
    expect(entry.avgCost).toBe(300);
  });

  it('treats a tag with no recorded cost as zero cost, not a crash', () => {
    const mistakeTags = { 'Positional inaccuracy': 3 };
    const ranked = rankWeaknessesByLeverage(mistakeTags, {});
    expect(ranked[0].totalCost).toBe(0);
    expect(ranked[0].avgCost).toBe(0);
  });

  it('returns an empty array for an empty profile', () => {
    expect(rankWeaknessesByLeverage({}, {})).toEqual([]);
  });

  it('handles missing mistakeCost entirely (undefined) without throwing', () => {
    const mistakeTags = { 'Dropped a pawn': 2 };
    expect(() => rankWeaknessesByLeverage(mistakeTags, undefined)).not.toThrow();
  });
});

describe('leverageCallout (Layer 2.1)', () => {
  it('names the costliest tag when it differs from the most frequent one', () => {
    const ranked = rankWeaknessesByLeverage(
      { 'Dropped a pawn': 10, 'Walked into a fork': 2 },
      { 'Dropped a pawn': 600, 'Walked into a fork': 800 }
    );
    const callout = leverageCallout(ranked);
    expect(callout).toContain('Walked into a fork');
    expect(callout).toMatch(/costliest/i);
  });

  it('returns null when the costliest tag is also the most frequent one (no contrast to highlight)', () => {
    const ranked = rankWeaknessesByLeverage(
      { 'Dropped a pawn': 10 },
      { 'Dropped a pawn': 600 }
    );
    expect(leverageCallout(ranked)).toBeNull();
  });

  it('returns null for fewer than two tags', () => {
    expect(leverageCallout([])).toBeNull();
    expect(leverageCallout([{tag:'x', count:1, avgCost:10, totalCost:10}])).toBeNull();
  });

  it('returns null when nothing has any recorded cost yet', () => {
    const ranked = rankWeaknessesByLeverage(
      { 'Dropped a pawn': 3, 'Positional inaccuracy': 1 },
      {}
    );
    expect(leverageCallout(ranked)).toBeNull();
  });
});

describe('phaseForMoveNumber (Layer 2.2)', () => {
  it('buckets per FEATURESPEC.md\'s own boundaries: opening <10, middlegame 10-30, endgame 30+', () => {
    expect(phaseForMoveNumber(1)).toBe('opening');
    expect(phaseForMoveNumber(9)).toBe('opening');
    expect(phaseForMoveNumber(10)).toBe('middlegame');
    expect(phaseForMoveNumber(30)).toBe('middlegame');
    expect(phaseForMoveNumber(31)).toBe('endgame');
    expect(phaseForMoveNumber(60)).toBe('endgame');
  });
});

describe('phaseBreakdown / phaseCallout (Layer 2.2)', () => {
  it('computes percentages that sum to (approximately) 100', () => {
    const {total, entries} = phaseBreakdown({opening:1, middlegame:2, endgame:1});
    expect(total).toBe(4);
    const pctSum = entries.reduce((s,e)=>s+e.pct, 0);
    expect(pctSum).toBeGreaterThanOrEqual(99);
    expect(pctSum).toBeLessThanOrEqual(101);
  });

  it('always returns all three phases even when some have zero mistakes', () => {
    const {entries} = phaseBreakdown({endgame: 3});
    const phases = entries.map(e => e.phase).sort();
    expect(phases).toEqual(['endgame', 'middlegame', 'opening']);
    expect(entries.find(e => e.phase==='opening').count).toBe(0);
  });

  it('surfaces a callout when one phase clearly dominates with enough data', () => {
    const callout = phaseCallout({opening:0, middlegame:1, endgame:6});
    expect(callout).toMatch(/86%/);
    expect(callout).toMatch(/endgame/i);
  });

  it('returns null with too little data to say anything meaningful', () => {
    expect(phaseCallout({opening:0, middlegame:1, endgame:2})).toBeNull();
  });

  it('returns null when mistakes are spread fairly evenly across phases', () => {
    expect(phaseCallout({opening:3, middlegame:3, endgame:3})).toBeNull();
  });

  it('handles an entirely empty phase profile without throwing', () => {
    expect(phaseBreakdown({})).toEqual({
      total: 0,
      entries: [
        {phase:'opening', count:0, pct:0},
        {phase:'middlegame', count:0, pct:0},
        {phase:'endgame', count:0, pct:0},
      ]
    });
    expect(phaseCallout({})).toBeNull();
  });
});

describe('rankPiecesByLeverage / pieceCallout (Layer 2.2)', () => {
  it('ranks pieces by total cost, same as rankWeaknessesByLeverage', () => {
    const ranked = rankPiecesByLeverage({n:4, p:10}, {n:1200, p:400});
    expect(ranked[0].tag).toBe('n');
    expect(ranked[0].totalCost).toBe(1200);
  });

  it('names the costliest piece in plain English, pluralized', () => {
    const callout = pieceCallout({n:4, p:10}, {n:1200, p:400});
    expect(callout).toMatch(/^Knights are your costliest piece/);
    expect(callout).toContain('4 mistakes');
    expect(callout).toContain('300 centipawns');
  });

  it('uses singular phrasing for exactly one mistake', () => {
    const callout = pieceCallout({q:1}, {q:900});
    expect(callout).toContain('1 mistake ');
    expect(callout).not.toContain('1 mistakes');
  });

  it('returns null when there is no recorded cost yet', () => {
    expect(pieceCallout({n:3}, {})).toBeNull();
  });

  it('returns null for an empty profile', () => {
    expect(pieceCallout({}, {})).toBeNull();
  });
});
