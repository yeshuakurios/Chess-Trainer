/* ============================================================
   SECOND BOARD — LLM COACH WORKER
   ------------------------------------------------------------
   Cloudflare Worker that proxies chess-coach.html's LLM-coach
   requests to the Anthropic API. Exists ONLY because a static
   GitHub Pages site has nowhere safe to hold an API key — this
   worker holds it server-side (as a Worker secret) and the
   browser talks to this instead of directly to Anthropic.

   Deploy with `wrangler deploy` from this directory. Required
   secrets (set with `wrangler secret put <NAME>`, never committed):
     ANTHROPIC_API_KEY  - from console.anthropic.com
     APP_TOKEN           - any random string you choose; the client
                            sends it back on every request as a
                            LIGHTWEIGHT ABUSE DETERRENT ONLY. It ships
                            in the client-side JS bundle, so anyone who
                            reads that file can read it too — it stops
                            casual/automated scanning of this worker's
                            URL, NOT a determined attacker. For real
                            protection, also add a Cloudflare rate-
                            limiting rule on this route (dashboard ->
                            your zone/worker route -> Rate limiting).

   See ../../HANDOFF.md for the full deployment checklist.
   ============================================================ */

// Update this to the real origin your GitHub Pages site is served
// from once deployed (already matches yeshuakurios.github.io).
const ALLOWED_ORIGINS = new Set([
  'https://yeshuakurios.github.io',
]);

const EXPLAIN_SYSTEM_PROMPT = `You are a concise, encouraging chess coach. A student just played a move that was graded as a mistake, inaccuracy, or blunder by a rule-based grader. You're given the position, the move, the engine's preferred alternative, and (sometimes) a detected tactical pattern.

Write ONE short paragraph (2-4 sentences, no bullet points, no headers) explaining specifically why the played move was worse than the alternative, in plain language a club player can act on. Be concrete: name the actual squares, pieces, and the real consequence — never say vague things like "it concedes ground" or "it's less accurate" without saying exactly what that costs. If a tactical pattern was already detected, you may build on it, but don't just restate it — add the practical lesson (what to watch for next time). If no pattern was detected, do your own honest assessment from the FEN rather than guessing at a mechanism that isn't really there — it's fine to say the move is simply passive or misplaces a piece if that's the real story. Do not use chess notation the student would need to look up (name pieces and squares in words); you may include the algebraic square (e.g. "the knight on f6") since that's standard. No preamble, no "Great question!", just the explanation.`;

const CHAT_SYSTEM_PROMPT = `You are a chess coach in the middle of a conversation with a student about ONE specific position from their game (given below). They already saw an automated grade and explanation for the move that was played; now they're asking follow-up questions.

Answer directly and concretely, referencing actual squares and pieces. Keep answers short (3-6 sentences) unless the student clearly asks for a longer breakdown (e.g. "walk me through the whole line"). Stay focused on this position and this move — if asked something unrelated to chess, gently steer back. No preamble.`;

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
    'Vary': 'Origin',
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'content-type': 'application/json' },
  });
}

async function callClaude(env, { system, messages, model, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

// Shared plain-text summary of the position/move, used as context for
// both the one-shot explanation and the opening turn of a chat.
function positionContext(body) {
  const loss = typeof body.loss === 'number' ? Math.round(body.loss * 100) : null;
  return [
    `FEN before the move: ${body.fen || 'unknown'}`,
    body.playedSan ? `Move played: ${body.playedSan}` : null,
    body.bestSan ? `Engine's top choice instead: ${body.bestSan}` : null,
    body.grade ? `Grade: ${body.grade}${loss !== null ? ` (about ${loss} centipawns lost)` : ''}` : null,
    body.motifTag ? `Detected pattern: ${body.motifTag}` : null,
    body.replySan ? `Opponent's best reply if the mistake goes unaddressed: ${body.replySan}` : null,
    body.playerRating ? `Player's current rating: ${body.playerRating}` : null,
  ].filter(Boolean).join('\n');
}

async function handleExplain(env, body, origin) {
  const text = await callClaude(env, {
    system: EXPLAIN_SYSTEM_PROMPT,
    model: env.EXPLAIN_MODEL || 'claude-haiku-4-5-20251001',
    maxTokens: 260,
    messages: [{ role: 'user', content: positionContext(body) }],
  });
  return jsonResponse({ explanation: text }, 200, origin);
}

async function handleChat(env, body, origin) {
  const history = Array.isArray(body.history) ? body.history : [];
  // Trim to a sane window — this is a single-position Q&A, not a long
  // running conversation, so there's no need to carry unbounded history.
  const trimmedHistory = history.slice(-16).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
  );
  const messages = [
    { role: 'user', content: `Position context:\n${positionContext(body)}\n\nI may now ask follow-up questions about this specific position.` },
    { role: 'assistant', content: 'Got it — ask away.' },
    ...trimmedHistory,
  ];
  const text = await callClaude(env, {
    system: CHAT_SYSTEM_PROMPT,
    model: env.CHAT_MODEL || 'claude-sonnet-5',
    maxTokens: 400,
    messages,
  });
  return jsonResponse({ reply: text }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }
    if (!ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ error: 'Forbidden origin' }, 403, origin);
    }
    if (!env.APP_TOKEN || request.headers.get('X-App-Token') !== env.APP_TOKEN) {
      return jsonResponse({ error: 'Forbidden' }, 403, origin);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'Worker is missing ANTHROPIC_API_KEY' }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Malformed JSON body' }, 400, origin);
    }

    try {
      if (body.mode === 'explain') return await handleExplain(env, body, origin);
      if (body.mode === 'chat') return await handleChat(env, body, origin);
      return jsonResponse({ error: 'Unknown mode — expected "explain" or "chat"' }, 400, origin);
    } catch (e) {
      return jsonResponse({ error: String((e && e.message) || e) }, 502, origin);
    }
  },
};
