/**
 * api.js — All external API calls route through Netlify Functions.
 * Zero secrets in the browser. Every call is retried once on network failure.
 */

// ── Config ────────────────────────────────────────────────────
const BASE = window.location.origin;

// APP_SECRET is a shared secret stored in Netlify env + locally.
// Not a user password — just prevents random people hitting your functions.
function getAppSecret() {
  try {
    const state = JSON.parse(localStorage.getItem('juma_crm_v3') || '{}');
    return state.settings?.appSecret || '';
  } catch {
    return '';
  }
}

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'x-app-secret': getAppSecret(),
    ...extra,
  };
}

async function fetchWithRetry(url, options, retries = 1) {
  try {
    const res = await fetch(url, options);
    if (!res.ok && retries > 0 && res.status >= 500) {
      await new Promise(r => setTimeout(r, 600));
      return fetchWithRetry(url, options, retries - 1);
    }
    return res;
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 600));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw err;
  }
}

// ── AI / Claude ───────────────────────────────────────────────
export async function callAI({ messages, maxTokens = 1000, tools = null, system = null }) {
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages,
  };
  if (system) body.system = system;
  if (tools)  body.tools  = tools;

  const res = await fetchWithRetry(`${BASE}/api/ai`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `AI API error ${res.status}`);
  }

  return res.json();
}

export function extractText(aiResponse) {
  if (!aiResponse?.content) return '';
  return aiResponse.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

// ── Airtable ──────────────────────────────────────────────────
export async function airtableList({ baseId, tableId, offset = '' }) {
  const params = new URLSearchParams({ pageSize: '100' });
  if (offset) params.set('offset', offset);

  const res = await fetchWithRetry(
    `${BASE}/api/airtable/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}?${params}`,
    { method: 'GET', headers: headers() }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Airtable error ${res.status}`);
  }
  return res.json();
}

export async function airtableCreate({ baseId, tableId, fields }) {
  const res = await fetchWithRetry(
    `${BASE}/api/airtable/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ records: [{ fields }] }),
    }
  );
  if (!res.ok) throw new Error(`Airtable create error ${res.status}`);
  return res.json();
}

export async function airtablePatch({ baseId, tableId, recordId, fields }) {
  if (!recordId) return; // silently skip if no record ID
  const res = await fetchWithRetry(
    `${BASE}/api/airtable/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}`,
    {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ fields }),
    }
  );
  if (!res.ok) {
    console.warn('[Airtable] Patch failed silently:', res.status);
  }
}

export async function syncAllFromAirtable({ baseId, tableId, onProgress }) {
  const records = [];
  let offset = '';
  let page = 0;

  do {
    const data = await airtableList({ baseId, tableId, offset });
    records.push(...(data.records || []));
    offset = data.offset || '';
    page++;
    if (onProgress) onProgress({ page, count: records.length });
  } while (offset);

  return records;
}

// ── Gmail ─────────────────────────────────────────────────────
export async function gmailSend({ to, subject, body, accessToken }) {
  const res = await fetchWithRetry(`${BASE}/api/gmail/send`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ to, subject, body, accessToken }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Gmail send error ${res.status}`);
  }
  return res.json();
}

export async function gmailExchangeToken({ code, redirectUri }) {
  const res = await fetchWithRetry(`${BASE}/api/gmail/token`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ code, redirectUri }),
  });
  if (!res.ok) throw new Error(`Token exchange failed ${res.status}`);
  return res.json();
}

export async function gmailRefreshToken({ refreshToken }) {
  const res = await fetchWithRetry(`${BASE}/api/gmail/refresh`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) throw new Error(`Token refresh failed ${res.status}`);
  return res.json();
}

// ── Gmail token management ────────────────────────────────────
export function isGmailConnected(settings) {
  if (!settings?.gmailAccessToken) return false;
  if (!settings?.gmailTokenExpiry) return false;
  return Date.now() < settings.gmailTokenExpiry - 60_000; // 1min buffer
}

export async function getValidGmailToken(settings, saveSettings) {
  if (isGmailConnected(settings)) return settings.gmailAccessToken;

  // Try refresh
  if (settings?.gmailRefreshToken) {
    try {
      const data = await gmailRefreshToken({ refreshToken: settings.gmailRefreshToken });
      const updated = {
        ...settings,
        gmailAccessToken: data.access_token,
        gmailTokenExpiry: Date.now() + (data.expires_in || 3600) * 1000,
      };
      saveSettings(updated);
      return data.access_token;
    } catch (err) {
      console.warn('[Gmail] Refresh failed:', err.message);
    }
  }

  return null; // caller must handle re-auth
}
