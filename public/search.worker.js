/**
 * search.worker.js
 * Runs in a Web Worker — zero main thread blocking.
 * Receives search params, returns filtered + scored results.
 */

let providers = [];
let indexed = false;

// Simple search index: specialty → [indices], state → [indices]
const idx = {
  specialty: new Map(),
  state: new Map(),
  city: new Map(),
};

function buildIndex() {
  if (indexed) return;
  providers.forEach((p, i) => {
    // p = [id, name, specialty, vert, city, state, phone, email, ...]
    const sp = (p[2] || '').toLowerCase();
    const st = (p[5] || '').toLowerCase();
    const ci = (p[4] || '').toLowerCase();

    if (!idx.specialty.has(sp)) idx.specialty.set(sp, []);
    idx.specialty.get(sp).push(i);

    if (!idx.state.has(st)) idx.state.set(st, []);
    idx.state.get(st).push(i);

    if (!idx.city.has(ci)) idx.city.set(ci, []);
    idx.city.get(ci).push(i);
  });
  indexed = true;
}

function score(p, queryLower, specialtyFilter, stateFilter, cityFilter) {
  let s = 0;
  const name = (p[1] || '').toLowerCase();
  const sp   = (p[2] || '').toLowerCase();
  const city = (p[4] || '').toLowerCase();
  const st   = (p[5] || '').toLowerCase();

  if (specialtyFilter && sp !== specialtyFilter) return -1;
  if (stateFilter    && st !== stateFilter)       return -1;
  if (cityFilter     && !city.includes(cityFilter)) return -1;

  if (!queryLower) return 100;

  if (name.startsWith(queryLower))    s += 100;
  else if (name.includes(queryLower)) s += 60;
  if (sp.includes(queryLower))        s += 40;
  if (city.includes(queryLower))      s += 20;

  return s > 0 ? s : -1;
}

self.onmessage = function(e) {
  const { type, data } = e.data;

  if (type === 'INIT') {
    providers = data.providers;
    buildIndex();
    self.postMessage({ type: 'READY', count: providers.length });
    return;
  }

  if (type === 'SEARCH') {
    const {
      query = '',
      specialty = '',
      state = '',
      city = '',
      page = 0,
      perPage = 50,
      requestId,
    } = data;

    const q  = query.trim().toLowerCase();
    const sp = specialty.toLowerCase();
    const st = state.toLowerCase();
    const ci = city.toLowerCase();

    // Candidate selection via index when possible
    let candidates;
    if (sp && idx.specialty.has(sp)) {
      candidates = idx.specialty.get(sp).map(i => providers[i]);
    } else if (st && idx.state.has(st)) {
      candidates = idx.state.get(st).map(i => providers[i]);
    } else {
      candidates = providers;
    }

    // Score + filter
    const scored = [];
    for (let i = 0; i < candidates.length; i++) {
      const s = score(candidates[i], q, sp, st, ci);
      if (s >= 0) scored.push([s, candidates[i]]);
    }

    // Sort by score desc
    scored.sort((a, b) => b[0] - a[0]);

    const total = scored.length;
    const pageResults = scored
      .slice(page * perPage, (page + 1) * perPage)
      .map(([, p]) => p);

    self.postMessage({
      type: 'RESULTS',
      requestId,
      results: pageResults,
      total,
      page,
      perPage,
      pages: Math.ceil(total / perPage),
    });
    return;
  }
};
