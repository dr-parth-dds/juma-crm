/**
 * /api/airtable/:path  — Airtable proxy
 * Personal Access Token never touches the browser.
 * Set AIRTABLE_PAT in Netlify dashboard → Environment Variables.
 *
 * Routes:
 *   GET  /api/airtable/bases/:baseId/tables/:tableId         → list records
 *   GET  /api/airtable/bases/:baseId/tables/:tableId/:recId  → single record
 *   POST /api/airtable/bases/:baseId/tables/:tableId         → create record
 *   PATCH /api/airtable/bases/:baseId/tables/:tableId/:recId → update record
 */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');

  const appSecret = process.env.APP_SECRET;
  const clientSecret = event.headers['x-app-secret'];
  if (appSecret && clientSecret !== appSecret) {
    return cors(401, JSON.stringify({ error: 'Unauthorized' }));
  }

  // Use env PAT if set, else fall back to client-supplied header (for onboarding flow)
  const pat = process.env.AIRTABLE_PAT || event.headers['x-airtable-pat'];
  if (!pat) {
    return cors(400, JSON.stringify({ error: 'No Airtable PAT configured' }));
  }

  // Strip /api/airtable prefix to get the Airtable path
  const rawPath = event.path.replace(/^\/?api\/airtable\/?/, '');
  const airtableUrl = `https://api.airtable.com/v0/${rawPath}${event.rawQuery ? '?' + event.rawQuery : ''}`;

  try {
    const response = await fetch(airtableUrl, {
      method: event.httpMethod,
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
      },
      body: ['POST', 'PATCH', 'PUT'].includes(event.httpMethod)
        ? event.body
        : undefined,
    });

    const data = await response.json();

    if (!response.ok) {
      return cors(response.status, JSON.stringify({
        error: data.error?.message || 'Airtable error',
        details: data,
      }));
    }

    return cors(200, JSON.stringify(data));
  } catch (err) {
    console.error('Airtable function error:', err);
    return cors(500, JSON.stringify({ error: 'Internal server error' }));
  }
};

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-app-secret, x-airtable-pat',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    },
    body,
  };
}
