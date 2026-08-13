/* ============================================================
   LLM COACH INTEGRATION
   ------------------------------------------------------------
   Talks to a small Cloudflare Worker (see worker/second-board-coach/)
   that proxies requests to the Anthropic API — this static site has no
   backend of its own, so the API key can never live here. Two things:

     1. explainMoveWithLLM() — a richer, non-templated explanation for
        a graded move, upgrading the card in place once it resolves
        (same async-upgrade pattern as src/opening-explorer.js).
     2. sendCoachChatMessage() — a follow-up-question chat about the
        current position.

   IMPORTANT — like src/opening-explorer.js, this file's live network
   calls were never tested against a real deployed worker from this
   development session: the sandbox's network policy blocks every
   third-party host, including any *.workers.dev domain (confirmed
   blocked for an existing workers.dev URL earlier this session).
   Every function here is built and unit-tested against a MOCKED
   fetch. It fails soft (returns null) on any network error, timeout,
   missing configuration, non-OK status, or unexpected shape — a wrong
   assumption about the worker's exact response shape degrades to "no
   LLM enhancement this time," never a broken grading/chat flow — but
   should be spot-checked against the real deployed worker once that
   exists and is reachable.

   Loaded via <script src="src/llm-coach.js"> in the browser (classic
   script — declarations land in the shared page scope). Also
   require()-able from Node for testing.
   ============================================================ */

const LLM_COACH_DEFAULT_TIMEOUT_MS = 12000;
const LLM_COACH_ENDPOINT_STORAGE_KEY = 'scb_coach_endpoint';
const LLM_COACH_APP_TOKEN_STORAGE_KEY = 'scb_coach_app_token';
const LLM_COACH_CHAT_HISTORY_LIMIT = 16; // matches the worker's own trim window

// Reads endpoint/app-token from localStorage (set once via the "Coach"
// toggle's setup prompt in chess-coach.html — see wireLLMCoachToggle()).
// Returns null when either piece is missing, so callers can silently no-op
// rather than firing requests at a URL that doesn't exist yet.
function getLLMCoachConfig(){
  if(typeof localStorage === 'undefined') return null;
  let endpoint, appToken;
  try{
    endpoint = localStorage.getItem(LLM_COACH_ENDPOINT_STORAGE_KEY);
    appToken = localStorage.getItem(LLM_COACH_APP_TOKEN_STORAGE_KEY);
  }catch(e){ return null; } // localStorage can throw in locked-down contexts (private browsing, etc.)
  if(!endpoint || !appToken) return null;
  return {endpoint, appToken};
}

function setLLMCoachConfig(endpoint, appToken){
  if(typeof localStorage === 'undefined') return false;
  try{
    localStorage.setItem(LLM_COACH_ENDPOINT_STORAGE_KEY, endpoint);
    localStorage.setItem(LLM_COACH_APP_TOKEN_STORAGE_KEY, appToken);
    return true;
  }catch(e){ return false; }
}

function clearLLMCoachConfig(){
  if(typeof localStorage === 'undefined') return;
  try{
    localStorage.removeItem(LLM_COACH_ENDPOINT_STORAGE_KEY);
    localStorage.removeItem(LLM_COACH_APP_TOKEN_STORAGE_KEY);
  }catch(e){ /* ignore */ }
}

function isLLMCoachConfigured(){
  return getLLMCoachConfig() !== null;
}

// Posts to the worker. Always resolves — never rejects — with either the
// parsed JSON body or null. `options.config` overrides the localStorage-
// resolved endpoint/token (used by tests); `options.fetchFn` overrides the
// fetch implementation.
async function callCoachWorker(payload, options){
  const opts = options || {};
  const config = opts.config || getLLMCoachConfig();
  if(!config) return null;

  const fetchFn = opts.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if(!fetchFn) return null;

  const timeoutMs = opts.timeoutMs || LLM_COACH_DEFAULT_TIMEOUT_MS;
  const hasAbort = typeof AbortController !== 'undefined';
  const controller = hasAbort ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(()=>controller.abort(), timeoutMs) : null;

  try{
    const res = await fetchFn(config.endpoint, {
      method: 'POST',
      headers: {'content-type':'application/json', 'X-App-Token': config.appToken},
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    if(!res || !res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  }catch(e){
    // Network error, timeout (abort rejects the fetch), bad JSON — all
    // fail soft. This is a coaching enhancement, not a critical path; it
    // must never be the thing that breaks grading a move or the chat UI.
    return null;
  }finally{
    if(timeoutId) clearTimeout(timeoutId);
  }
}

// context: {fen, playedSan, bestSan, loss, grade, motifTag, replySan, playerRating}
async function explainMoveWithLLM(context, options){
  const data = await callCoachWorker({mode:'explain', ...context}, options);
  return (data && typeof data.explanation === 'string' && data.explanation.trim()) ? data.explanation.trim() : null;
}

// history: array of {role:'user'|'assistant', content:string}, already
// including the newest user question as the last entry.
async function sendCoachChatMessage(context, history, options){
  const trimmed = Array.isArray(history) ? history.slice(-LLM_COACH_CHAT_HISTORY_LIMIT) : [];
  const data = await callCoachWorker({mode:'chat', ...context, history: trimmed}, options);
  return (data && typeof data.reply === 'string' && data.reply.trim()) ? data.reply.trim() : null;
}

// Node/Vitest can require() this file directly; the browser (classic
// <script> tag, no `module` global) just skips this block.
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    LLM_COACH_ENDPOINT_STORAGE_KEY, LLM_COACH_APP_TOKEN_STORAGE_KEY, LLM_COACH_CHAT_HISTORY_LIMIT,
    getLLMCoachConfig, setLLMCoachConfig, clearLLMCoachConfig, isLLMCoachConfigured,
    callCoachWorker, explainMoveWithLLM, sendCoachChatMessage,
  };
}
