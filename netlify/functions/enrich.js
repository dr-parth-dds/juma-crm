/**
 * /api/enrich/* â Provider enrichment proxy
 *
 * Routes:
 *   POST /api/enrich/npi     â NPI Registry lookup
 *   POST /api/enrich/website â Fetch a website and extract emails
 *   POST /api/enrich/search  â Google Custom Search (if API key set)
 */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');

  /* ââ Auth âââââââââââââââââââââââââââââââââââââââââââââââââ */
  const appSecret = process.env.APP_SECRET;
  const clientSecret = event.headers['x-app-secret'];
  if (appSecret && clientSecret !== appSecret) {
    return cors(401, JSON.stringify({ error: 'Unauthorized' }));
  }

  const route = event.path
    .replace(/^\/?\.netlify\/functions\/enrich\/?/, '')
    .replace(/^\/?api\/enrich\/?/, '')
    .split('/')[0];

  try {
    switch (route) {
      case 'npi':     return await handleNPI(event);
      case 'website': return await handleWebsite(event);
      case 'search':  return await handleSearch(event);
      default:        return cors(404, JSON.stringify({ error: `Unknown route: ${route}` }));
    }
  } catch (err) {
    console.error('Enrich function error:', err);
    return cors(500, JSON.stringify({ error: err.message }));
  }
};

/* ââ NPI Registry Lookup âââââââââââââââââââââââââââââââââââ */
async function handleNPI(event) {
  const { name, city, state, specialty, limit } = JSON.parse(event.body || '{}');
  if (!name) return cors(400, JSON.stringify({ error: 'name required' }));

  // Parse name â try to split into first/last
  const parts = name
    .replace(/^dr\.?\s*/i, '')
    .replace(/,?\s*(md|dds|dmd|do|od|dc|pt|phd|np|pa|rn|ms|mba|mbs)\.?\s*/gi, '')
    .trim()
    .split(/\s+/);

  const firstName = parts[0] || '';
  const lastName  = parts.length > 1 ? parts[parts.length - 1] : '';

  const params = new URLSearchParams({
    version: '2.1',
    limit: String(limit || 5),
  });

  if (firstName) params.set('first_name', firstName);
  if (lastName)  params.set('last_name', lastName);
  if (city)      params.set('city', city);
  if (state)     params.set('state', state);

  // NPI taxonomy codes for dental
  const taxonomyMap = {
    'general':      '1223G0001X',
    'orthodon':     '1223X0400X',
    'periodon':     '1223P0106X',
    'endodon':      '1223E0200X',
    'oral surg':    '1223S0112X',
    'pediatric':    '1223P0221X',
    'prosthodon':   '1223P0700X',
  };

  if (specialty) {
    const specLower = specialty.toLowerCase();
    for (const [key, code] of Object.entries(taxonomyMap)) {
      if (specLower.includes(key)) {
        params.set('taxonomy_description', key);
        break;
      }
    }
  }

  const url = `https://npiregistry.cms.hhs.gov/api/?${params}`;
  console.log('NPI lookup:', url);

  const resp = await fetch(url);
  const data = await resp.json();

  // Extract clean results
  const results = (data.results || []).map(r => {
    const basic = r.basic || {};
    const addrs = r.addresses || [];
    const practice = addrs.find(a => a.address_purpose === 'LOCATION') || addrs[0] || {};
    const taxonomies = (r.taxonomies || []).map(t => t.desc).join(', ');

    return {
      npi: r.number,
      firstName: basic.first_name || '',
      lastName: basic.last_name || '',
      orgName: basic.organization_name || '',
      credential: basic.credential || '',
      taxonomy: taxonomies,
      address: {
        line1: practice.address_1 || '',
        line2: practice.address_2 || '',
        city: practice.city || '',
        state: practice.state || '',
        zip: practice.postal_code || '',
        phone: practice.telephone_number || '',
        fax: practice.fax_number || '',
      }
    };
  });

  return cors(200, JSON.stringify({
    count: data.result_count || 0,
    results,
  }));
}

/* ââ Website Fetch & Email Extraction âââââââââââââââââââââ */
async function handleWebsite(event) {
  const { url } = JSON.parse(event.body || '{}');
  if (!url) return cors(400, JSON.stringify({ error: 'url required' }));

  // Validate URL
  let parsedUrl;
  try {
    parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return cors(400, JSON.stringify({ error: 'Invalid URL' }));
  }

  const baseUrl = parsedUrl.origin;
  const emails = new Set();
  const phones = new Set();
  let website = baseUrl;

  // Fetch homepage
  const pages = [parsedUrl.href];
  // Also try /contact and /about pages
  const contactPaths = ['/contact', '/contact-us', '/about', '/about-us', '/team', '/staff'];

  try {
    // Fetch main page first
    const mainHtml = await fetchPage(parsedUrl.href);
    if (mainHtml) {
      extractEmails(mainHtml, emails);
      extractPhones(mainHtml, phones);

      // Find contact/about links in the HTML
      const linkPattern = /href=["']([^"']*(?:contact|about|team|staff)[^"']*)["']/gi;
      let match;
      while ((match = linkPattern.exec(mainHtml)) !== null) {
        try {
          const linkUrl = new URL(match[1], baseUrl).href;
          if (linkUrl.startsWith(baseUrl) && !pages.includes(linkUrl)) {
            pages.push(linkUrl);
          }
        } catch {}
      }
    }

    // Fetch additional pages (contact, about) â limit to 3 extra pages
    const extraPages = pages.slice(1).concat(
      contactPaths.map(p => `${baseUrl}${p}`)
    );
    const seen = new Set(pages);

    let fetched = 0;
    for (const pageUrl of extraPages) {
      if (fetched >= 3) break;
      if (seen.has(pageUrl)) continue;
      seen.add(pageUrl);

      const html = await fetchPage(pageUrl);
      if (html) {
        extractEmails(html, emails);
        extractPhones(html, phones);
        fetched++;
      }
    }
  } catch (err) {
    console.error('Website scrape error:', err.message);
  }

  // Filter out common junk emails
  const junkPatterns = [
    /noreply/i, /no-reply/i, /donotreply/i,
    /example\.com/i, /test\.com/i, /domain\.com/i,
    /sentry\.io/i, /wixpress/i, /cloudflare/i,
    /@2x\./i, /@3x\./i,
  ];

  const cleanEmails = [...emails].filter(e => {
    return !junkPatterns.some(p => p.test(e)) && e.includes('@') && e.includes('.');
  });

  return cors(200, JSON.stringify({
    website,
    emails: cleanEmails,
    phones: [...phones],
  }));
}

async function fetchPage(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JumaCRM/1.0; +https://jumacrm.com)',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    return await resp.text();
  } catch {
    return null;
  }
}

function extractEmails(html, emailSet) {
  // Remove scripts and style tags first
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                       .replace(/<style[\s\S]*?<\/style>/gi, '');

  // mailto: links
  const mailtoPattern = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
  let match;
  while ((match = mailtoPattern.exec(cleaned)) !== null) {
    emailSet.add(match[1].toLowerCase());
  }

  // General email pattern in text
  const emailPattern = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
  while ((match = emailPattern.exec(cleaned)) !== null) {
    const email = match[1].toLowerCase();
    // Skip image/file extensions
    if (!/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(email)) {
      emailSet.add(email);
    }
  }
}

function extractPhones(html, phoneSet) {
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                       .replace(/<style[\s\S]*?<\/style>/gi, '');

  // US phone patterns
  const phonePattern = /(?:tel:|phone:?\s*)?(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g;
  let match;
  while ((match = phonePattern.exec(cleaned)) !== null) {
    const phone = `(${match[1]}) ${match[2]}-${match[3]}`;
    phoneSet.add(phone);
  }
}

/* ââ Google Custom Search ââââââââââââââââââââââââââââââââââ */
async function handleSearch(event) {
  const { query } = JSON.parse(event.body || '{}');
  if (!query) return cors(400, JSON.stringify({ error: 'query required' }));

  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx     = process.env.GOOGLE_SEARCH_CX;

  if (!apiKey || !cx) {
    return cors(400, JSON.stringify({
      error: 'Google Custom Search not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX in Netlify env vars.',
      notConfigured: true,
    }));
  }

  const params = new URLSearchParams({
    key: apiKey,
    cx,
    q: query,
    num: '5',
  });

  const resp = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
  const data = await resp.json();

  if (!resp.ok) {
    return cors(resp.status, JSON.stringify({ error: data.error?.message || 'Search failed' }));
  }

  const results = (data.items || []).map(item => ({
    title: item.title,
    link: item.link,
    snippet: item.snippet,
    displayLink: item.displayLink,
  }));

  return cors(200, JSON.stringify({ results }));
}

/* ââ CORS helper âââââââââââââââââââââââââââââââââââââââââââ */
function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                 'application/json',
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-app-secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
    body,
  };
}
