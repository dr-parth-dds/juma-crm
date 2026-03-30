/**
 * /api/gmail/*  — Gmail API proxy
 * Gmail OAuth client secret lives server-side only.
 * Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in Netlify dashboard.
 *
 * Routes:
 *   POST /api/gmail/send          → send email via Gmail API
 *   POST /api/gmail/token         → exchange auth code for access token
 *   POST /api/gmail/refresh       → refresh access token
 */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');

  const appSecret = process.env.APP_SECRET;
  const clientSecret = event.headers['x-app-secret'];
  if (appSecret && clientSecret !== appSecret) {
    return cors(401, JSON.stringify({ error: 'Unauthorized' }));
  }

  const route = event.path.replace(/^\/?api\/gmail\/?/, '').split('/')[0];

  try {
    if (route === 'send') {
      return await handleSend(event);
    } else if (route === 'token') {
      return await handleTokenExchange(event);
    } else if (route === 'refresh') {
      return await handleRefresh(event);
    } else {
      return cors(404, JSON.stringify({ error: 'Unknown route' }));
    }
  } catch (err) {
    console.error('Gmail function error:', err);
    return cors(500, JSON.stringify({ error: err.message }));
  }
};

async function handleSend(event) {
  const { to, subject, body, accessToken } = JSON.parse(event.body || '{}');

  if (!to || !subject || !body || !accessToken) {
    return cors(400, JSON.stringify({ error: 'Missing required fields' }));
  }

  // Build RFC 2822 message
  const rawMessage = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    body,
  ].join('\r\n');

  // Base64url encode
  const encoded = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encoded }),
    }
  );

  const data = await response.json();
  if (!response.ok) {
    return cors(response.status, JSON.stringify({ error: data.error?.message }));
  }
  return cors(200, JSON.stringify({ success: true, messageId: data.id }));
}

async function handleTokenExchange(event) {
  const { code, redirectUri } = JSON.parse(event.body || '{}');
  if (!code) return cors(400, JSON.stringify({ error: 'code required' }));

  const params = new URLSearchParams({
    code,
    client_id: process.env.GMAIL_CLIENT_ID || '',
    client_secret: process.env.GMAIL_CLIENT_SECRET || '',
    redirect_uri: redirectUri || '',
    grant_type: 'authorization_code',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await response.json();
  if (!response.ok) {
    return cors(response.status, JSON.stringify({ error: data.error_description }));
  }
  return cors(200, JSON.stringify(data));
}

async function handleRefresh(event) {
  const { refreshToken } = JSON.parse(event.body || '{}');
  if (!refreshToken) return cors(400, JSON.stringify({ error: 'refreshToken required' }));

  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: process.env.GMAIL_CLIENT_ID || '',
    client_secret: process.env.GMAIL_CLIENT_SECRET || '',
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await response.json();
  if (!response.ok) {
    return cors(response.status, JSON.stringify({ error: data.error_description }));
  }
  return cors(200, JSON.stringify(data));
}

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
