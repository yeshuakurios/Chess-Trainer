// Unit tests for src/insights.js — pure aggregation over profile data
// (FEATURESPEC.md Layer 2). No engine calls, no persistence — these tests
// construct plain mistakeTags/mistakeCost objects directly.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  rankWeaknessesByLeverage, leverageCallout,
  phaseForMoveNumber, phaseBreakdown, phaseCallout,
  rankPiecesByLeverage, pieceCallout,
  groupIntoSessions, sessionSummary, accuracyByPositionInSession, fatigueCallout,
  expectedScore, calibrationDrift, calibrationCallout,
  milestoneForRating, crossedMilestones, diffMistakeTags, compareToPastSelfCallout
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

describe('groupIntoSessions (Layer 2.3/2.4)', () => {
  it('groups games with small gaps into one session', () => {
    const gameLog = [
      {date: '2026-01-01T10:00:00.000Z'},
      {date: '2026-01-01T10:20:00.000Z'}, // 20 min later, within the default 45min gap
    ];
    const sessions = groupIntoSessions(gameLog);
    expect(sessions.length).toBe(1);
    expect(sessions[0].length).toBe(2);
  });

  it('splits games with a large gap into separate sessions', () => {
    const gameLog = [
      {date: '2026-01-01T10:00:00.000Z'},
      {date: '2026-01-01T12:00:00.000Z'}, // 2 hours later
    ];
    const sessions = groupIntoSessions(gameLog);
    expect(sessions.length).toBe(2);
    expect(sessions[0].length).toBe(1);
    expect(sessions[1].length).toBe(1);
  });

  it('respects a custom gap threshold', () => {
    const gameLog = [
      {date: '2026-01-01T10:00:00.000Z'},
      {date: '2026-01-01T10:20:00.000Z'}, // 20 min later
    ];
    expect(groupIntoSessions(gameLog, 45).length).toBe(1); // default-equivalent: same session
    expect(groupIntoSessions(gameLog, 10).length).toBe(2); // tighter threshold: separate sessions
  });

  it('sorts out-of-order input by date before grouping', () => {
    const gameLog = [
      {date: '2026-01-01T12:00:00.000Z', label:'later'},
      {date: '2026-01-01T10:00:00.000Z', label:'earlier'},
    ];
    const sessions = groupIntoSessions(gameLog);
    expect(sessions[0][0].label).toBe('earlier');
  });

  it('returns an empty array for an empty gameLog', () => {
    expect(groupIntoSessions([])).toEqual([]);
  });
});

describe('sessionSummary (Layer 2.4)', () => {
  it('sums delta across the session, treating a null delta (diagnostic game) as zero', () => {
    const games = [{delta: 20}, {delta: null}, {delta: -5}];
    expect(sessionSummary(games).netRatingChange).toBe(15);
  });

  it('identifies a common thread tag that recurs across at least two games', () => {
    const games = [
      {mistakeTagsThisGame: {'Walked into a fork': 2, 'Dropped a pawn': 1}},
      {mistakeTagsThisGame: {'Walked into a fork': 1}},
      {mistakeTagsThisGame: {}},
    ];
    expect(sessionSummary(games).commonThreadTag).toBe('Walked into a fork');
  });

  it('does not call a tag a "thread" if it only ever appeared within a single game', () => {
    // "Dropped a pawn" happened 5 times, but all in the same game — that's
    // a bad game, not a thread across the session.
    const games = [
      {mistakeTagsThisGame: {'Dropped a pawn': 5}},
      {mistakeTagsThisGame: {}},
    ];
    expect(sessionSummary(games).commonThreadTag).toBeNull();
  });

  it('handles an empty session without throwing', () => {
    expect(sessionSummary([])).toEqual({
      gameCount: 0, netRatingChange: 0, avgLossPerGame: [], commonThreadTag: null
    });
  });
});

describe('accuracyByPositionInSession / fatigueCallout (Layer 2.3)', () => {
  // Three independent sessions (gapped a full day apart so they never
  // merge), each with 4 games at increasing avgCpLoss — a clear, sampled
  // fatigue pattern starting at the 4th game of a sitting.
  function buildFatigueGameLog(){
    const gameLog = [];
    const perSessionLosses = [30, 35, 40, 85]; // pawn-ish -> clear jump at position 4
    for(let day = 0; day < 3; day++){
      perSessionLosses.forEach((loss, i) => {
        const d = new Date(Date.UTC(2026, 0, 1 + day, 10, i * 10, 0));
        gameLog.push({date: d.toISOString(), avgCpLoss: loss});
      });
    }
    return gameLog;
  }

  it('buckets average accuracy by position within a session, pooled across sessions', () => {
    const byPosition = accuracyByPositionInSession(buildFatigueGameLog());
    expect(byPosition.map(p => p.position)).toEqual([1, 2, 3, 4]);
    expect(byPosition.every(p => p.gameCount === 3)).toBe(true);
    expect(byPosition[0].avgLoss).toBe(30);
    expect(byPosition[3].avgLoss).toBe(85);
  });

  it('surfaces a fatigue callout naming the position where accuracy clearly drops', () => {
    const callout = fatigueCallout(buildFatigueGameLog());
    expect(callout).toMatch(/3rd game/);
  });

  it('returns null without enough baseline (1st-game) samples', () => {
    const gameLog = [
      {date: '2026-01-01T10:00:00.000Z', avgCpLoss: 30},
      {date: '2026-01-01T10:10:00.000Z', avgCpLoss: 90},
    ];
    expect(fatigueCallout(gameLog)).toBeNull();
  });

  it('returns null when accuracy stays roughly flat across a session', () => {
    const gameLog = [];
    for(let day = 0; day < 3; day++){
      [30, 32, 31, 33].forEach((loss, i) => {
        const d = new Date(Date.UTC(2026, 0, 1 + day, 10, i * 10, 0));
        gameLog.push({date: d.toISOString(), avgCpLoss: loss});
      });
    }
    expect(fatigueCallout(gameLog)).toBeNull();
  });

  it('returns an empty array for an empty gameLog', () => {
    expect(accuracyByPositionInSession([])).toEqual([]);
  });
});

describe('expectedScore / calibrationDrift / calibrationCallout (Layer 2.5)', () => {
  it('expectedScore matches the standard Elo formula (0.5 at equal ratings)', () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5, 10);
    expect(expectedScore(1600, 1500)).toBeGreaterThan(0.5);
    expect(expectedScore(1400, 1500)).toBeLessThan(0.5);
  });

  function winStreakHistory(n, {rating=1000, opponent=1025, result=1} = {}){
    const history = [];
    for(let i=0;i<n;i++){
      history.push({rating, delta:0, opponent, result, date: `2026-01-0${(i%9)+1}T10:00:00.000Z`});
    }
    return history;
  }

  it('flags a sustained overperforming win streak as likely stale-low', () => {
    const history = winStreakHistory(8); // 8 straight wins vs a +25 gap opponent, expected ~46%
    const drift = calibrationDrift(history);
    expect(drift.gameCount).toBe(8);
    expect(drift.actualRate).toBe(1);
    expect(drift.expectedRate).toBeCloseTo(expectedScore(1000, 1025), 10);
    expect(drift.deviation).toBeGreaterThan(0.25);

    const callout = calibrationCallout(history);
    expect(callout).toMatch(/stale-low/);
    expect(callout).toMatch(/re-run a calibration game/i);
  });

  it('flags a sustained underperforming streak as likely stale-high', () => {
    const history = winStreakHistory(8, {result: 0});
    const callout = calibrationCallout(history);
    expect(callout).toMatch(/stale-high/);
  });

  it('does not flag performance that roughly matches expectation', () => {
    // Alternating win/loss against an even-strength opponent: actual ~50%,
    // expected ~50% — no meaningful drift.
    const history = [];
    for(let i=0;i<8;i++){
      history.push({rating:1000, delta:0, opponent:1000, result: i%2===0?1:0, date:`2026-01-0${(i%9)+1}T10:00:00.000Z`});
    }
    expect(calibrationCallout(history)).toBeNull();
  });

  it('returns null with fewer than the minimum number of recent games', () => {
    const history = winStreakHistory(5);
    expect(calibrationDrift(history)).toBeNull();
    expect(calibrationCallout(history)).toBeNull();
  });

  it('excludes the diagnostic game (delta: null) from the window', () => {
    const diagnostic = [{rating:1000, delta:null, opponent:1200, result:1, date:'2026-01-01T09:00:00.000Z'}];
    const history = diagnostic.concat(winStreakHistory(5));
    // Only 5 post-diagnostic games qualify, still below the minimum of 6.
    expect(calibrationDrift(history)).toBeNull();
  });

  it('only looks at the most recent windowSize games, not the entire history', () => {
    const oldBadStreak = winStreakHistory(20, {result: 0}); // ancient underperformance
    const recentGoodForm = winStreakHistory(8, {result: 1}); // recent overperformance
    const history = oldBadStreak.concat(recentGoodForm);
    const drift = calibrationDrift(history, 10);
    expect(drift.gameCount).toBe(10);
    // The window should be dominated by the recent win streak, not the old one.
    expect(drift.actualRate).toBeGreaterThan(0.5);
  });
});

describe('milestoneForRating / crossedMilestones (Layer 2.6)', () => {
  it('floors a rating to its 100-point band', () => {
    expect(milestoneForRating(1547)).toBe(1500);
    expect(milestoneForRating(1500)).toBe(1500);
    expect(milestoneForRating(1499)).toBe(1400);
  });

  it('lists every milestone newly crossed while climbing', () => {
    expect(crossedMilestones(1470, 1512)).toEqual([1500]);
    expect(crossedMilestones(1470, 1620)).toEqual([1500, 1600]);
  });

  it('returns an empty list when the rating did not climb', () => {
    expect(crossedMilestones(1500, 1500)).toEqual([]);
    expect(crossedMilestones(1550, 1480)).toEqual([]); // fell, doesn't count
  });

  it('returns an empty list when climbing without reaching a new 100-band', () => {
    expect(crossedMilestones(1510, 1540)).toEqual([]);
  });
});

describe('diffMistakeTags / compareToPastSelfCallout (Layer 2.6)', () => {
  it('computes before/after/delta per tag, sorted by size of change', () => {
    const current = {'Walked into a fork': 1, 'Dropped a pawn': 8};
    const snapshot = {'Walked into a fork': 5, 'Dropped a pawn': 6};
    const diff = diffMistakeTags(current, snapshot);
    // fork: 5->1 (delta -4), pawn: 6->8 (delta +2) — fork's swing is larger.
    expect(diff[0].tag).toBe('Walked into a fork');
    expect(diff[0].delta).toBe(-4);
    expect(diff[1].tag).toBe('Dropped a pawn');
    expect(diff[1].delta).toBe(2);
  });

  it('includes a tag that is new since the snapshot (before: 0)', () => {
    const diff = diffMistakeTags({'Walked into a pin': 3}, {});
    expect(diff[0]).toEqual({tag:'Walked into a pin', before:0, after:3, delta:3});
  });

  it('includes a tag that disappeared since the snapshot (after: 0)', () => {
    const diff = diffMistakeTags({}, {'Walked into a pin': 3});
    expect(diff[0]).toEqual({tag:'Walked into a pin', before:3, after:0, delta:-3});
  });

  it('callout reports the exact-same-profile case when nothing changed', () => {
    const diff = diffMistakeTags({'Dropped a pawn': 4}, {'Dropped a pawn': 4});
    expect(compareToPastSelfCallout(1500, diff)).toMatch(/exact same weakness profile/i);
  });

  it('callout names both an improved and a worsened tag when both exist', () => {
    const diff = diffMistakeTags(
      {'Walked into a fork': 1, 'Dropped a pawn': 8},
      {'Walked into a fork': 5, 'Dropped a pawn': 6}
    );
    const callout = compareToPastSelfCallout(1500, diff);
    expect(callout).toContain('1500');
    expect(callout).toMatch(/"Walked into a fork" is down from 5 to 1/);
    expect(callout).toMatch(/"Dropped a pawn" is up from 6 to 8/);
  });
});
