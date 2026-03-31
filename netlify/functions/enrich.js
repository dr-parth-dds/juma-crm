/**
 * /api/enrich/* — Provider enrichment proxy
 * Routes:
 *   POST /api/enrich/npi     → NPI Registry lookup
 *   POST /api/enrich/website → Fetch website & extract emails
 *   POST /api/enrich/search  → Google Custom Search
 */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');
  const appSecret = process.env.APP_SECRET;
  const hdr = event.headers['x-app-secret'];
  if (appSecret && hdr !== appSecret) return cors(401, JSON.stringify({error:'Unauthorized'}));
  const route = event.path.replace(/^\/?\.netlify\/functions\/enrich\/?/,'').replace(/^\/?api\/enrich\/?/,'').split('/')[0];
  try {
    if (route==='npi') return handleNPI(event);
    if (route==='website') return handleWebsite(event);
    if (route==='search') return handleSearch(event);
    return cors(404, JSON.stringify({error:'Unknown route: '+route}));
  } catch(err) { return cors(500, JSON.stringify({error:err.message})); }
};

async function handleNPI(event) {
  const {name,city,state,specialty,limit} = JSON.parse(event.body||'{}');
  if (!name) return cors(400, JSON.stringify({error:'name required'}));
  const parts = name.replace(/^dr\.?\s*/i,'').replace(/,?\s*(md|dds|dmd|do|od|dc|pt|phd|np|pa|rn|ms|mba|mbs)\.?\s*/gi,'').trim().split(/\s+/);
  const firstName = parts[0]||'';
  const lastName = parts.length>1 ? parts[parts.length-1] : '';
  const params = new URLSearchParams({version:'2.1',limit:String(limit||5)});
  if (firstName) params.set('first_name',firstName);
  if (lastName) params.set('last_name',lastName);
  if (city) params.set('city',city);
  if (state) params.set('state',state);
  const url = `https://npiregistry.cms.hhs.gov/api/?${params}`;
  const resp = await fetch(url);
  const data = await resp.json();
  const results = (data.results||[]).map(r => {
    const b = r.basic||{}, addrs = r.addresses||[];
    const pr = addrs.find(a=>a.address_purpose==='LOCATION')||addrs[0]||{};
    return {npi:r.number, firstName:b.first_name||'', lastName:b.last_name||'', orgName:b.organization_name||'', credential:b.credential||'', taxonomy:(r.taxonomies||[]).map(t=>t.desc).join(', '), address:{line1:pr.address_1||'',line2:pr.address_2||'',city:pr.city||'',state:pr.state||'',zip:pr.postal_code||'',phone:pr.telephone_number||'',fax:pr.fax_number||''}};
  });
  return cors(200, JSON.stringify({count:data.result_count||0, results}));
}

async function handleWebsite(event) {
  const {url} = JSON.parse(event.body||'{}');
  if (!url) return cors(400, JSON.stringify({error:'url required'}));
  let parsedUrl;
  try { parsedUrl = new URL(url.startsWith('http') ? url : 'https://'+url); }
  catch { return cors(400, JSON.stringify({error:'Invalid URL'})); }
  const baseUrl = parsedUrl.origin;
  const emails = new Set(), phones = new Set();
  const contactPaths = ['/contact','/contact-us','/about','/about-us'];
  try {
    const mainHtml = await fetchPage(parsedUrl.href);
    if (mainHtml) { extractEmails(mainHtml, emails); extractPhones(mainHtml, phones); }
    for (const p of contactPaths) {
      if (emails.size >= 3) break;
      const html = await fetchPage(baseUrl + p);
      if (html) { extractEmails(html, emails); extractPhones(html, phones); }
    }
  } catch(err) { console.error('Scrape error:', err.message); }
  const junk = [/noreply/i,/no-reply/i,/donotreply/i,/example\.com/i,/sentry\.io/i,/wixpress/i,/cloudflare/i,/@[23]x\./i];
  const clean = [...emails].filter(e => !junk.some(p=>p.test(e)) && e.includes('@') && e.includes('.') && !/\.(png|jpg|gif|svg|css|js)$/i.test(e));
  return cors(200, JSON.stringify({website:baseUrl, emails:clean, phones:[...phones]}));
}

async function fetchPage(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(()=>c.abort(), 5000);
    const r = await fetch(url, {signal:c.signal, headers:{'User-Agent':'Mozilla/5.0 (compatible; JumaCRM/1.0)','Accept':'text/html'}, redirect:'follow'});
    clearTimeout(t);
    if (!r.ok) return null;
    if (!(r.headers.get('content-type')||'').includes('text/html')) return null;
    return r.text();
  } catch { return null; }
}

function extractEmails(html, set) {
  const c = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'');
  let m;
  const mp = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
  while ((m=mp.exec(c))!==null) set.add(m[1].toLowerCase());
  const ep = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
  while ((m=ep.exec(c))!==null) { const e=m[1].toLowerCase(); if (!/\.(png|jpg|gif|svg|css|js)$/i.test(e)) set.add(e); }
}

function extractPhones(html, set) {
  const c = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'');
  const pp = /(?:\+?1[-.\ ]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g;
  let m;
  while ((m=pp.exec(c))!==null) set.add('('+m[1]+') '+m[2]+'-'+m[3]);
}

async function handleSearch(event) {
  const {query} = JSON.parse(event.body||'{}');
  if (!query) return cors(400, JSON.stringify({error:'query required'}));
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY, cx = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey||!cx) return cors(400, JSON.stringify({error:'Google Custom Search not configured',notConfigured:true}));
  const params = new URLSearchParams({key:apiKey, cx, q:query, num:'5'});
  const resp = await fetch('https://www.googleapis.com/customsearch/v1?'+params);
  const data = await resp.json();
  if (!resp.ok) return cors(resp.status, JSON.stringify({error:data.error?.message||'Search failed'}));
  const results = (data.items||[]).map(i=>({title:i.title,link:i.link,snippet:i.snippet,displayLink:i.displayLink}));
  return cors(200, JSON.stringify({results}));
}

function cors(statusCode, body) {
  return {statusCode, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, x-app-secret','Access-Control-Allow-Methods':'POST, OPTIONS'}, body};
}
