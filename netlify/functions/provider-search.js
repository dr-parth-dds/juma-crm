/**
 * /api/provider-search/* â Real provider data collection
 *
 * Routes:
 *   POST /api/provider-search/places   â Google Places nearby search
 *   POST /api/provider-search/details  â Google Places details (website, email)
 *   POST /api/provider-search/bulk-npi â Bulk NPI lookup by city+taxonomy
 */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(204, '');

  /* ââ Auth ââ */
  const appSecret = process.env.APP_SECRET;
  const clientSecret = event.headers['x-app-secret'];
  if (appSecret && clientSecret !== appSecret) {
    return cors(401, JSON.stringify({ error: 'Unauthorized' }));
  }

  const route = event.path
    .replace(/^\/?\.netlify\/functions\/provider-search\/?/, '')
    .replace(/^\/?api\/provider-search\/?/, '')
    .split('/')[0];

  try {
    switch (route) {
      case 'places':   return await handlePlaces(event);
      case 'details':  return await handleDetails(event);
      case 'bulk-npi': return await handleBulkNPI(event);
      default:         return cors(404, JSON.stringify({ error: `Unknown route: ${route}` }));
    }
  } catch (err) {
    console.error('Provider search error:', err);
    return cors(500, JSON.stringify({ error: err.message }));
  }
};

/* ââ Google Places Nearby Search ââ */
async function handlePlaces(event) {
  const { lat, lng, radius, type, keyword, pageToken } = JSON.parse(event.body || '{}');

  const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_SEARCH_API_KEY;
  if (!apiKey) {
    return cors(400, JSON.stringify({
      error: 'Google API key not configured. Set GOOGLE_PLACES_API_KEY in Netlify env vars.',
      notConfigured: true,
    }));
  }

  if (!lat || !lng) {
    return cors(400, JSON.stringify({ error: 'lat and lng required' }));
  }

  const params = new URLSearchParams({
    key: apiKey,
    location: `${lat},${lng}`,
    radius: String(radius || 50000), // default ~31 miles
    type: type || 'doctor',
  });

  if (keyword) params.set('keyword', keyword);
  if (pageToken) params.set('pagetoken', pageToken);

  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params}`;
  console.log('Places search:', url.replace(apiKey, 'KEY'));

  const resp = await fetch(url);
  const data = await resp.json();

  if (data.status === 'REQUEST_DENIED') {
    return cors(400, JSON.stringify({ error: data.error_message || 'Places API denied', notConfigured: true }));
  }

  const results = (data.results || []).map(p => ({
    placeId: p.place_id,
    name: p.name,
    address: p.vicinity || '',
    lat: p.geometry?.location?.lat,
    lng: p.geometry?.location?.lng,
    rating: p.rating || null,
    totalRatings: p.user_ratings_total || 0,
    types: p.types || [],
    openNow: p.opening_hours?.open_now ?? null,
    priceLevel: p.price_level ?? null,
  }));

  return cors(200, JSON.stringify({
    results,
    nextPageToken: data.next_page_token || null,
    status: data.status,
  }));
}

/* ââ Google Places Details (get website, phone, full address) ââ */
async function handleDetails(event) {
  const { placeId } = JSON.parse(event.body || '{}');

  const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_SEARCH_API_KEY;
  if (!apiKey) {
    return cors(400, JSON.stringify({ error: 'Google API key not configured', notConfigured: true }));
  }

  if (!placeId) {
    return cors(400, JSON.stringify({ error: 'placeId required' }));
  }

  const params = new URLSearchParams({
    key: apiKey,
    place_id: placeId,
    fields: 'name,formatted_address,formatted_phone_number,website,url,types,rating,user_ratings_total,business_status',
  });

  const url = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
  const resp = await fetch(url);
  const data = await resp.json();

  if (data.status !== 'OK') {
    return cors(400, JSON.stringify({ error: `Places details failed: ${data.status}` }));
  }

  const r = data.result || {};
  return cors(200, JSON.stringify({
    name: r.name || '',
    address: r.formatted_address || '',
    phone: r.formatted_phone_number || '',
    website: r.website || '',
    googleMapsUrl: r.url || '',
    types: r.types || [],
    rating: r.rating || null,
    totalRatings: r.user_ratings_total || 0,
    businessStatus: r.business_status || '',
  }));
}

/* ââ Bulk NPI Lookup ââ */
async function handleBulkNPI(event) {
  const { city, state, taxonomy, limit, skip } = JSON.parse(event.body || '{}');

  if (!state) return cors(400, JSON.stringify({ error: 'state required' }));

  const params = new URLSearchParams({
    version: '2.1',
    limit: String(limit || 200),
    enumeration_type: 'NPI-1', // individual providers only
  });

  if (city)     params.set('city', city);
  if (state)    params.set('state', state);
  if (taxonomy) params.set('taxonomy_description', taxonomy);
  if (skip)     params.set('skip', String(skip));

  const url = `https://npiregistry.cms.hhs.gov/api/?${params}`;
  console.log('NPI bulk lookup:', url);

  const resp = await fetch(url);
  const data = await resp.json();

  const results = (data.results || []).map(r => {
    const basic = r.basic || {};
    const addrs = r.addresses || [];
    const practice = addrs.find(a => a.address_purpose === 'LOCATION') || addrs[0] || {};
    const taxonomies = (r.taxonomies || []).map(t => t.desc).join(', ');
    const primaryTaxonomy = (r.taxonomies || []).find(t => t.primary) || r.taxonomies?.[0] || {};

    return {
      npi: r.number,
      firstName: basic.first_name || '',
      lastName: basic.last_name || '',
      credential: basic.credential || '',
      gender: basic.gender || '',
      taxonomy: taxonomies,
      taxonomyCode: primaryTaxonomy.code || '',
      address: {
        line1: practice.address_1 || '',
        line2: practice.address_2 || '',
        city: practice.city || '',
        state: practice.state || '',
        zip: (practice.postal_code || '').substring(0, 5),
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

/* ââ CORS helper ââ */
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
