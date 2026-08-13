/* ============================================================
   STOCKFISH (UCI) WRAPPER
   ------------------------------------------------------------
   Wraps the WASM engine in a promise-based queue. If the engine
   fails to load for any reason, engineReady stays false and the
   app transparently falls back to the built-in minimax.

   Loaded via <script src="src/engine.js"> in the browser (classic
   script — declarations land in the shared page scope, same as if
   this code were still inline). Also require()-able from Node for
   testing, where `Chess` is pulled in from the chess.js package.
   ============================================================ */
// Assign onto the real global object rather than `var`-declaring it: see
// the identical note in src/grading.js for why a bare `var Chess` here
// would be unsafe even guarded.
if(typeof Chess === 'undefined' && typeof require === 'function'){
  global.Chess = require('chess.js').Chess;
}

let sf = null;
let engineReady = false;
let sfQueue = [];
let sfCurrent = null;
let sfBuffer = {bestmove:null, cp:null, mate:null, depth:0};

function sfSend(cmd){
  if(!sf) return;
  try{
    if(typeof sf.postMessage === 'function') sf.postMessage(cmd);
    else if(typeof sf === 'function') sf(cmd);
  }catch(e){ console.warn('engine send failed', e); }
}

// How long to wait for the full UCI handshake (constructor -> uciok ->
// isready -> readyok) before giving up and falling back to the basic
// engine. This is a ONE-TIME startup cost, not a per-move budget (each
// individual analysis call is separately capped by sfAnalyze's own 6s
// timeout), so it can afford to be generous: constructing the WASM module
// involves an async compile step, and on a real phone — under load from
// the rest of the page still loading, and possibly a slower/throttled CPU
// than a dev machine — that compile can plausibly take longer than the 8s
// this used to be. If startup is still silently falling back after this,
// the next thing to check is the browser's own console for an uncaught
// error thrown asynchronously from inside the engine bundle itself (e.g.
// during WebAssembly instantiation) — that class of failure happens
// outside the try/catch below entirely, since it happens after STOCKFISH()
// has already returned.
const ENGINE_HANDSHAKE_TIMEOUT_MS = 15000;

function initEngine(){
  return new Promise((resolve)=>{
    let settled = false;
    const startedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const done = (ok)=>{
      if(settled) return;
      settled = true;
      engineReady = ok;
      const elapsed = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt);
      if(ok) console.info(`Stockfish ready after ${elapsed}ms`);
      else console.warn(`Stockfish unavailable after ${elapsed}ms — falling back to the basic engine.`);
      resolve(ok);
    };

    try{
      if(typeof STOCKFISH === 'function'){
        sf = STOCKFISH();
      } else if(typeof Stockfish === 'function'){
        sf = Stockfish();
      } else {
        console.warn('Stockfish global (STOCKFISH/Stockfish) not found — the CDN script may not have loaded.');
        return done(false);
      }
    }catch(e){
      console.warn('Stockfish constructor threw:', e);
      return done(false);
    }

    const handler = (event)=>{
      const line = (typeof event === 'string') ? event : (event && event.data);
      if(typeof line !== 'string') return;
      handleEngineLine(line, done);
    };

    if(sf.addEventListener) sf.addEventListener('message', handler);
    else sf.onmessage = handler;

    sfSend('uci');
    // If the engine never answers, fall back rather than hanging forever.
    setTimeout(()=>done(engineReady), ENGINE_HANDSHAKE_TIMEOUT_MS);
  });
}

function handleEngineLine(line, done){
  if(line.startsWith('uciok')){
    // Do NOT send "setoption name Threads value 1" here. This build reports
    // Threads min=max=1 (it's already fixed at 1), and "setting" it anyway
    // sends this specific Stockfish.js 10.0.2 build into an infinite loop —
    // it never responds to anything again, including isready. Reproduced
    // deterministically in Node; almost certainly the real cause of the
    // "Basic engine" fallback in production (HANDOFF.md Known Issue #1):
    // in-browser this hangs the dedicated Worker thread silently while the
    // main thread's own 8s fallback timer in initEngine() still fires,
    // producing what looks like a graceful "Stockfish failed to load"
    // rather than the hard hang it actually is.
    sfSend('isready');
    return;
  }
  if(line.startsWith('readyok')){
    if(done) done(true);
    processQueue();
    return;
  }
  if(line.startsWith('info')){
    // Track the deepest score seen for this search
    const dMatch = line.match(/ depth (\d+)/);
    const cpMatch = line.match(/score cp (-?\d+)/);
    const mateMatch = line.match(/score mate (-?\d+)/);
    const d = dMatch ? parseInt(dMatch[1],10) : 0;
    if(d >= sfBuffer.depth){
      sfBuffer.depth = d;
      if(cpMatch){ sfBuffer.cp = parseInt(cpMatch[1],10); sfBuffer.mate = null; }
      if(mateMatch){ sfBuffer.mate = parseInt(mateMatch[1],10); sfBuffer.cp = null; }
    }
    return;
  }
  if(line.startsWith('bestmove')){
    const parts = line.split(/\s+/);
    sfBuffer.bestmove = parts[1] && parts[1] !== '(none)' ? parts[1] : null;
    if(sfCurrent){
      sfCurrent.resolve({
        bestmove: sfBuffer.bestmove,
        cp: sfBuffer.cp,
        mate: sfBuffer.mate
      });
      sfCurrent = null;
    }
    processQueue();
    return;
  }
}

function processQueue(){
  if(sfCurrent || sfQueue.length===0 || !sf) return;
  sfCurrent = sfQueue.shift();
  sfBuffer = {bestmove:null, cp:null, mate:null, depth:0};
  sfSend('position fen ' + sfCurrent.fen);
  if(sfCurrent.uciElo !== null && sfCurrent.uciElo !== undefined){
    sfSend('setoption name UCI_LimitStrength value true');
    sfSend('setoption name UCI_Elo value ' + sfCurrent.uciElo);
    sfSend('setoption name Skill Level value 20');
  } else {
    // Full-strength grading pass: no limiter, no artificial weakening.
    sfSend('setoption name UCI_LimitStrength value false');
    sfSend('setoption name Skill Level value 20');
  }
  sfSend('go depth ' + sfCurrent.depth);
}

// Analyze a position. Returns {bestmove(uci), cp, mate} with score
// ALWAYS from the perspective of the side to move in that FEN.
// Pass uciElo to weaken the engine toward a target Elo (opponent moves).
// Omit it entirely for full-strength grading analysis.
// Times out after 6s so a stuck/misbehaving engine can never hang the app —
// this is what silently broke the bot's turn with no fallback triggering.
function sfAnalyze(fen, depth, uciElo){
  if(!engineReady) return Promise.resolve(null);
  return new Promise((resolve)=>{
    let settled = false;
    const done = (val)=>{
      if(settled) return;
      settled = true;
      resolve(val);
    };
    const timeoutId = setTimeout(()=>{
      // Engine never answered — drop it from the queue if it's still pending/current
      // so it doesn't block everything that comes after it, and fail soft.
      sfQueue = sfQueue.filter(q => q.resolve !== wrappedResolve);
      if(sfCurrent && sfCurrent.resolve === wrappedResolve){
        sfCurrent = null;
        processQueue();
      }
      console.warn('Engine analysis timed out — falling back.');
      done(null);
    }, 6000);
    const wrappedResolve = (val)=>{
      clearTimeout(timeoutId);
      done(val);
    };
    sfQueue.push({fen, depth, uciElo:(uciElo===undefined?null:uciElo), resolve:wrappedResolve});
    processQueue();
  });
}

// Convert a UCI move string (e2e4, e7e8q) into a SAN move on a given FEN
function uciToMove(fen, uci){
  if(!uci) return null;
  const g = new Chess(fen);
  const from = uci.slice(0,2), to = uci.slice(2,4);
  const promo = uci.length>4 ? uci[4] : undefined;
  const mv = g.move({from, to, promotion: promo || 'q'});
  return mv;
}

// Normalize an engine score to pawns, from the perspective of the side to move.
function scoreToPawns(res){
  if(!res) return null;
  if(res.mate !== null && res.mate !== undefined){
    return res.mate > 0 ? 100 : -100;   // treat mate as overwhelming
  }
  if(res.cp !== null && res.cp !== undefined) return res.cp/100;
  return null;
}

// Test-only accessor — the app itself never reads engineReady through this,
// it just closes over the module-scoped variable directly. Node tests need
// a way to observe it since `let engineReady` isn't otherwise exported.
function isEngineReady(){
  return engineReady;
}

// Node/Vitest can require() this file directly; the browser (classic
// <script> tag, no `module` global) just skips this block.
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    sfSend, initEngine, handleEngineLine, processQueue, sfAnalyze,
    uciToMove, scoreToPawns, isEngineReady
  };
}
