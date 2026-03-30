/**
 * /api/ai  — Anthropic Claude proxy
 * API key never touches the browser.
 * Set ANTHROPIC_API_KEY in Netlify dashboard → Environment Variables.
 */

const ALLOWED_MODELS = ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'];
const MAX_TOKENS_CAP = 2000;

exports.handler = async (event) => {
  // ── CORS preflight ────────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return cors(204, '');
  }

  if (event.httpMethod !== 'POST') {
    return cors(405, JSON.stringify({ error: 'Method not allowed' }));
  }

  // ── Auth: simple shared secret ────────────────────────────
  const appSecret = process.env.APP_SECRET;
  const clientSecret = event.headers['x-app-secret'];
  if (appSecret && clientSecret !== appSecret) {
    return cors(401, JSON.stringify({ error: 'Unauthorized' }));
  }

  // ── Parse + validate body ─────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return cors(400, JSON.stringify({ error: 'Invalid JSON' }));
  }

  const { messages, max_tokens, tools, system } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return cors(400, JSON.stringify({ error: 'messages array required' }));
  }

  // ── Build Claude request ──────────────────────────────────
  const model = ALLOWED_MODELS.includes(body.model)
    ? body.model
    : ALLOWED_MODELS[0];

  const payload = {
    model,
    max_tokens: Math.min(Number(max_tokens) || 1000, MAX_TOKENS_CAP),
    messages,
  };

  if (system) payload.system = system;
  if (tools && Array.isArray(tools)) payload.tools = tools;

  // ── Call Anthropic ────────────────────────────────────────
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic error:', data);
      return cors(response.status, JSON.stringify({
        error: data.error?.message || 'Anthropic API error',
      }));
    }

    return cors(200, JSON.stringify(data));
  } catch (err) {
    console.error('AI function error:', err);
    return cors(500, JSON.stringify({ error: 'Internal server error' }));
  }
};

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-app-secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
    body,
  };
}
