// Unit tests for src/insights.js — pure aggregation over profile data
// (FEATURESPEC.md Layer 2). No engine calls, no persistence — these tests
// construct plain mistakeTags/mistakeCost objects directly.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { rankWeaknessesByLeverage, leverageCallout } = require('../src/insights.js');

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
