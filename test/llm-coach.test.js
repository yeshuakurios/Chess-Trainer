// Unit tests for src/llm-coach.js (LLM-coach integration: richer move
// explanations + follow-up chat, proxied through a Cloudflare Worker).
//
// IMPORTANT CAVEAT: same as test/opening-explorer.test.js — this sandbox's
// network policy blocks every third-party host, including *.workers.dev
// (confirmed blocked for an existing workers.dev URL earlier in this
// project's development). Every test here uses a MOCKED fetch built from
// worker/second-board-coach/index.js's own documented response shape
// ({explanation} / {reply}) — none of it has been verified against a real
// deployed worker. fetchFn failures should always degrade to null, never a
// throw, but the worker's exact response shape should be spot-checked
// against a real deployment once one exists and is reachable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  LLM_COACH_ENDPOINT_STORAGE_KEY, LLM_COACH_APP_TOKEN_STORAGE_KEY,
  getLLMCoachConfig, setLLMCoachConfig, clearLLMCoachConfig, isLLMCoachConfigured,
  callCoachWorker, explainMoveWithLLM, sendCoachChatMessage,
} = require('../src/llm-coach.js');

const FAKE_CONFIG = {endpoint: 'https://second-board-coach.example.workers.dev', appToken: 'test-token-123'};

function mockFetchReturning(data, {ok = true, status = 200} = {}){
  return async (url, init) => ({
    ok, status,
    url, init, // exposed so a test can assert on what was actually sent
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
  });
}

// A minimal localStorage stand-in — plain Node has no global localStorage.
function makeFakeLocalStorage(){
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

describe('localStorage-backed config (getLLMCoachConfig / setLLMCoachConfig / clearLLMCoachConfig)', () => {
  beforeEach(() => { global.localStorage = makeFakeLocalStorage(); });
  afterEach(() => { delete global.localStorage; });

  it('returns null when nothing has been configured yet', () => {
    expect(getLLMCoachConfig()).toBeNull();
    expect(isLLMCoachConfigured()).toBe(false);
  });

  it('round-trips endpoint + app token through setLLMCoachConfig/getLLMCoachConfig', () => {
    setLLMCoachConfig('https://example.workers.dev', 'my-token');
    expect(getLLMCoachConfig()).toEqual({endpoint: 'https://example.workers.dev', appToken: 'my-token'});
    expect(isLLMCoachConfigured()).toBe(true);
  });

  it('returns null when only one of endpoint/appToken is set', () => {
    global.localStorage.setItem(LLM_COACH_ENDPOINT_STORAGE_KEY, 'https://example.workers.dev');
    expect(getLLMCoachConfig()).toBeNull();
  });

  it('clearLLMCoachConfig removes both values', () => {
    setLLMCoachConfig('https://example.workers.dev', 'my-token');
    clearLLMCoachConfig();
    expect(getLLMCoachConfig()).toBeNull();
  });

  it('getLLMCoachConfig returns null (not a throw) when localStorage itself throws', () => {
    global.localStorage = {
      getItem: () => { throw new Error('SecurityError: access denied'); },
    };
    expect(getLLMCoachConfig()).toBeNull();
  });
});

describe('callCoachWorker', () => {
  it('returns null immediately when no config is available (no localStorage, no override)', async () => {
    const result = await callCoachWorker({mode:'explain'}, {fetchFn: mockFetchReturning({explanation:'x'})});
    expect(result).toBeNull();
  });

  it('posts to the configured endpoint with the app token header and JSON body', async () => {
    const fetchFn = mockFetchReturning({explanation: 'It weakens your king safety.'});
    let captured;
    const wrappedFetch = async (url, init) => { captured = {url, init}; return fetchFn(url, init); };
    const result = await callCoachWorker({mode:'explain', fen:'startpos'}, {config: FAKE_CONFIG, fetchFn: wrappedFetch});
    expect(result).toEqual({explanation: 'It weakens your king safety.'});
    expect(captured.url).toBe(FAKE_CONFIG.endpoint);
    expect(captured.init.method).toBe('POST');
    expect(captured.init.headers['X-App-Token']).toBe(FAKE_CONFIG.appToken);
    expect(JSON.parse(captured.init.body)).toEqual({mode:'explain', fen:'startpos'});
  });

  it('returns null on a non-OK HTTP status', async () => {
    const result = await callCoachWorker({mode:'explain'}, {
      config: FAKE_CONFIG, fetchFn: mockFetchReturning(null, {ok:false, status:403}),
    });
    expect(result).toBeNull();
  });

  it('returns null when the fetch throws (network error)', async () => {
    const result = await callCoachWorker({mode:'explain'}, {config: FAKE_CONFIG, fetchFn: mockFetchThatThrows()});
    expect(result).toBeNull();
  });

  it('returns null on timeout rather than hanging forever', async () => {
    const start = Date.now();
    const result = await callCoachWorker({mode:'explain'}, {
      config: FAKE_CONFIG, fetchFn: mockFetchThatHangsUntilAborted(), timeoutMs: 100,
    });
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('explainMoveWithLLM', () => {
  it('returns the trimmed explanation string on success', async () => {
    const fetchFn = mockFetchReturning({explanation: '  It hangs the knight on f6 to a simple fork.  '});
    const result = await explainMoveWithLLM(
      {fen:'startpos', playedSan:'Ng4', bestSan:'Nf3', loss:1.2, grade:'mistake'},
      {config: FAKE_CONFIG, fetchFn}
    );
    expect(result).toBe('It hangs the knight on f6 to a simple fork.');
  });

  it('returns null when the worker response is missing the explanation field', async () => {
    const result = await explainMoveWithLLM({fen:'startpos'}, {config: FAKE_CONFIG, fetchFn: mockFetchReturning({})});
    expect(result).toBeNull();
  });

  it('returns null when the worker is not configured', async () => {
    const result = await explainMoveWithLLM({fen:'startpos'}, {fetchFn: mockFetchReturning({explanation:'x'})});
    expect(result).toBeNull();
  });
});

describe('sendCoachChatMessage', () => {
  it('returns the trimmed reply string on success and forwards history', async () => {
    let captured;
    const fetchFn = async (url, init) => {
      captured = JSON.parse(init.body);
      return {ok:true, status:200, json: async () => ({reply: 'Because the rook is undefended on a8.'})};
    };
    const history = [{role:'user', content:'Why is this bad?'}];
    const result = await sendCoachChatMessage({fen:'startpos', playedSan:'Rb8'}, history, {config: FAKE_CONFIG, fetchFn});
    expect(result).toBe('Because the rook is undefended on a8.');
    expect(captured.mode).toBe('chat');
    expect(captured.history).toEqual(history);
  });

  it('trims history to the last 16 entries before sending', async () => {
    let captured;
    const fetchFn = async (url, init) => {
      captured = JSON.parse(init.body);
      return {ok:true, status:200, json: async () => ({reply:'ok'})};
    };
    const longHistory = Array.from({length: 30}, (_, i) => ({role: i%2===0?'user':'assistant', content:`msg ${i}`}));
    await sendCoachChatMessage({fen:'startpos'}, longHistory, {config: FAKE_CONFIG, fetchFn});
    expect(captured.history.length).toBe(16);
    expect(captured.history[captured.history.length-1].content).toBe('msg 29');
  });

  it('returns null when the worker response is missing the reply field', async () => {
    const result = await sendCoachChatMessage({fen:'startpos'}, [], {config: FAKE_CONFIG, fetchFn: mockFetchReturning({})});
    expect(result).toBeNull();
  });
});
