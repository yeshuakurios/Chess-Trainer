// Priority-zero smoke test (see HANDOFF.md): confirms Stockfish actually
// loads and returns a legal move within a time budget. This is the single
// test that would have caught the app silently running on "Basic engine"
// in production (HANDOFF.md Known Issue #1) — if this test goes red, the
// real app's engine status chip is almost certainly also broken.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// engine.js expects a global STOCKFISH/Stockfish factory, exactly like the
// CDN <script> tag provides it in the browser. Wire up the same npm
// package version (10.0.2) pinned by the CDN URL in chess-coach.html.
global.STOCKFISH = require('stockfish');

const engine = require('../src/engine.js');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Fool's mate: Black to move, Qh4# is the only mating move.
const MATE_IN_1_FEN = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2';

const TIME_BUDGET_MS = 5000;

describe('Stockfish engine wrapper (src/engine.js)', () => {
  let ready;

  beforeAll(async () => {
    ready = await engine.initEngine();
  }, 10000);

  it('completes the UCI handshake and reports ready', () => {
    expect(ready).toBe(true);
    expect(engine.isEngineReady()).toBe(true);
  });

  it('returns a legal move for the start position within the time budget', async () => {
    const start = Date.now();
    const res = await engine.sfAnalyze(START_FEN, 12);
    const elapsed = Date.now() - start;

    expect(res).not.toBeNull();
    expect(res.bestmove).toBeTruthy();
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);

    const mv = engine.uciToMove(START_FEN, res.bestmove);
    expect(mv).toBeTruthy();
  }, TIME_BUDGET_MS + 2000);

  it('finds the only mating move in a mate-in-1 position', async () => {
    const start = Date.now();
    const res = await engine.sfAnalyze(MATE_IN_1_FEN, 10);
    const elapsed = Date.now() - start;

    expect(res).not.toBeNull();
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);

    const mv = engine.uciToMove(MATE_IN_1_FEN, res.bestmove);
    expect(mv).toBeTruthy();
    expect(mv.san).toBe('Qh4#');
  }, TIME_BUDGET_MS + 2000);

  // Documents a real, currently-unresolved production bug (HANDOFF.md Known
  // Issue #1): this exact engine build (stockfish@10.0.2, same version as
  // the CDN URL in chess-coach.html) does NOT advertise UCI_LimitStrength
  // or UCI_Elo among its supported options, so engineTurn()'s attempt to
  // weaken the opponent toward a target Elo silently does nothing — the
  // bot always plays at full Skill Level 20 regardless of gameOpponentElo.
  // Using it.fails here (rather than a normal assertion) means: this test
  // is expected to fail right now, so it doesn't turn the whole suite red
  // for a known issue, but the moment someone upgrades the engine build to
  // one that supports these options, this test starts passing — which
  // vitest reports as a FAILURE, flagging that this comment (and Known
  // Issue #1) needs updating.
  it.fails('advertises UCI_LimitStrength and UCI_Elo as supported options', async () => {
    const raw = await new Promise((resolve) => {
      const probe = STOCKFISH();
      const lines = [];
      probe.onmessage = (e) => {
        const line = typeof e === 'string' ? e : e.data;
        lines.push(line);
        if (line === 'uciok') resolve(lines);
      };
      probe.postMessage('uci');
    });
    const optionNames = raw
      .filter((l) => l.startsWith('option name'))
      .map((l) => l.split(' ')[2]);
    expect(optionNames).toContain('UCI_LimitStrength');
    expect(optionNames).toContain('UCI_Elo');
  }, TIME_BUDGET_MS);
});
