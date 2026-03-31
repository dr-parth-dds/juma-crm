/**
 * enrich-ui.js â Provider Email Enrichment Engine
 *
 * Self-contained module that adds email enrichment to JUMA CRM.
 * Uses NPI Registry (free) + website scraping to find real emails.
 *
 * Loaded after app.js â hooks into existing CRM globals.
 */

(function() {
  'use strict';

  /* ââ Globals from app.js and api.js âââââââââââââââââââââââ */
  const I = Object.freeze({ID:0,N:1,SP:2,V:3,CI:4,ST:5,PH:6,EM:7,CO:8,NP:9,PR:10,TX:11,AD:12});
  const BASE = window.location.origin;
  const STORE_KEY = 'juma_crm_v3';

  function getAppSecret() {
    try {
      const state = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return state.settings?.appSecret || '';
    } catch { return ''; }
  }

  function apiHeaders() {
    return { 'Content-Type': 'application/json', 'x-app-secret': getAppSecret() };
  }

  /* ââ Enrichment state âââââââââââââââââââââââââââââââââââââ */
  let enrichState = {
    running: false,
    paused: false,
    queue: [],        // array of pipeline indices to process
    processed: 0,
    found: 0,
    errors: 0,
    skipped: 0,
    results: [],      // {id, name, oldEmail, newEmail, website, phone, source}
    batchSize: 10,    // concurrent lookups (higher default since NPI-only is fast)
    delayMs: 500,     // delay between batches
    mode: 'pipeline', // 'pipeline' or 'all'
  };

  /* ââ Capability cache (avoid repeated failed calls) âââââââ */
  let googleSearchAvailable = null; // null=unknown, true/false after first call
  let npiAvailable = true;

  /* ââ API calls (duplicated here to be self-contained) âââââ */
  async function fetchJSON(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'API error ' + res.status);
    }
    return res.json();
  }

  async function npiLookup(name, city, state, specialty) {
    return fetchJSON(BASE + '/api/enrich/npi', { name, city, state, specialty });
  }

  async function websiteScrape(url) {
    return fetchJSON(BASE + '/api/enrich/website', { url });
  }

  async function googleSearch(query) {
    return fetchJSON(BASE + '/api/enrich/search', { query });
  }

  /* ââ Core enrichment logic for one provider âââââââââââââââ */
  async function enrichProvider(providerRow) {
    const name = providerRow[I.N] || '';
    const city = providerRow[I.CI] || '';
    const state = providerRow[I.ST] || 'CA';
    const specialty = providerRow[I.SP] || '';
    const currentEmail = providerRow[I.EM] || '';
    const currentPhone = providerRow[I.PH] || '';
    const id = providerRow[I.ID];

    const result = {
      id,
      name,
      oldEmail: currentEmail,
      newEmail: null,
      newPhone: null,
      website: null,
      npiNumber: null,
      source: null,
    };

    // Detect if current email looks fake (truncated domain)
    const emailDomain = currentEmail.split('@')[1] || '';
    const looksLegit = emailDomain && emailDomain.length > 8 &&
      /\.(com|net|org|edu|gov|io|co)$/i.test(emailDomain);

    // Step 1: NPI Registry lookup (only if name looks like a person, not a fake org)
    if (npiAvailable) {
      try {
        const npiData = await npiLookup(name, city, state, specialty);
        if (npiData.count > 0) {
          const best = npiData.results[0];
          result.npiNumber = best.npi;
          if (best.address.phone) {
            result.newPhone = formatPhone(best.address.phone);
          }
          // If NPI matched, try scraping the practice address area
          if (best.address.city && best.lastName) {
            result.source = 'npi';
          }
        }
      } catch (err) {
        console.warn('[Enrich] NPI failed:', name, err.message);
        // If NPI API is completely down, stop wasting calls
        if (err.message.includes('503') || err.message.includes('timeout')) {
          npiAvailable = false;
        }
      }
    }

    // Step 2: Google Custom Search for website (skip if already known to be unconfigured)
    let websiteUrl = null;
    if (googleSearchAvailable !== false) {
      try {
        const searchQuery = name + ' ' + city + ' ' + state + ' dentist';
        const searchData = await googleSearch(searchQuery);
        googleSearchAvailable = true; // it worked!
        if (searchData.results && searchData.results.length > 0) {
          const skipDomains = ['yelp.com','healthgrades.com','zocdoc.com','vitals.com',
            'webmd.com','npidb.org','yellowpages.com','facebook.com','instagram.com',
            'linkedin.com','twitter.com','x.com','bbb.org','mapquest.com'];
          for (const sr of searchData.results) {
            const domain = (sr.displayLink || '').toLowerCase();
            if (!skipDomains.some(d => domain.includes(d))) {
              websiteUrl = sr.link;
              result.website = sr.link;
              break;
            }
          }
        }
      } catch (err) {
        if (err.message.includes('not configured') || err.message.includes('400')) {
          googleSearchAvailable = false;
          console.warn('[Enrich] Google Search not configured â skipping for all future providers');
          updateSearchWarning();
        } else {
          console.warn('[Enrich] Search failed:', name, err.message);
        }
      }
    }

    // Step 3: Scrape found website for emails
    if (websiteUrl) {
      try {
        const scrapeData = await websiteScrape(websiteUrl);
        if (scrapeData.emails && scrapeData.emails.length > 0) {
          const prioritized = scrapeData.emails.sort((a, b) => {
            const aScore = /^(info|contact|office|admin|hello|reception)@/i.test(a) ? 0 : 1;
            const bScore = /^(info|contact|office|admin|hello|reception)@/i.test(b) ? 0 : 1;
            return aScore - bScore;
          });
          result.newEmail = prioritized[0];
          result.source = 'website';
        }
        if (!result.website) result.website = scrapeData.website;
        if (scrapeData.phones && scrapeData.phones.length > 0 && !result.newPhone) {
          result.newPhone = scrapeData.phones[0];
        }
      } catch (err) {
        console.warn('[Enrich] Scrape failed:', websiteUrl, err.message);
      }
    }

    // Step 4: Domain guessing â ONLY if Google Search IS configured but found nothing,
    // AND the email looks fake. Skip entirely if Google Search is unavailable
    // (guessing fake names wastes ~15s per provider on timeouts).
    if (!result.newEmail && !websiteUrl && googleSearchAvailable === true && !looksLegit) {
      const cleanName = name.replace(/^dr\.?\s*/i, '').replace(/,.*$/, '').trim();
      const domainGuesses = buildDomainGuesses(cleanName, city);

      for (const guess of domainGuesses.slice(0, 2)) {
        try {
          const scrapeData = await websiteScrape('https://' + guess);
          if (scrapeData.emails && scrapeData.emails.length > 0) {
            result.newEmail = scrapeData.emails[0];
            result.website = 'https://' + guess;
            result.source = 'domain-guess';
            break;
          }
        } catch {
          // Domain doesn't exist
        }
      }
    }

    return result;
  }

  function updateSearchWarning() {
    const existing = document.getElementById('enrich-search-warning');
    if (existing) return; // already shown
    const wrap = document.getElementById('enrich-progress-wrap');
    if (!wrap) return;
    const warn = document.createElement('div');
    warn.id = 'enrich-search-warning';
    warn.style.cssText = 'background:#78350f;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;margin-bottom:12px;color:#fef3c7;font-size:13px;';
    warn.innerHTML = '<strong>Google Search API not configured.</strong> Without it, the enrichment can only use NPI Registry lookups (which need real doctor names). '
      + 'To enable full website discovery: set <code>GOOGLE_SEARCH_API_KEY</code> and <code>GOOGLE_SEARCH_CX</code> in your Netlify environment variables. '
      + '<a href="https://programmablesearchengine.google.com/" target="_blank" style="color:#60a5fa;">Set up here</a>';
    wrap.parentElement.insertBefore(warn, wrap);
  }

  function formatPhone(raw) {
    const digits = (raw || '').replace(/\D/g, '');
    if (digits.length === 10) {
      return '(' + digits.slice(0,3) + ') ' + digits.slice(3,6) + '-' + digits.slice(6);
    }
    if (digits.length === 11 && digits[0] === '1') {
      return '(' + digits.slice(1,4) + ') ' + digits.slice(4,7) + '-' + digits.slice(7);
    }
    return raw;
  }

  function buildDomainGuesses(practiceName, city) {
    const words = practiceName.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const guesses = [];

    if (words.length >= 2) {
      guesses.push(words.join('') + '.com');
      guesses.push(words[0] + words[words.length-1] + '.com');
      guesses.push(words.join('-') + '.com');
    }
    if (words.length >= 1) {
      guesses.push('dr' + words[0] + '.com');
      guesses.push(words[0] + 'dental.com');
      guesses.push(words[0] + 'dds.com');
    }
    return guesses;
  }

  /* ââ Batch processing engine ââââââââââââââââââââââââââââââ */
  async function runEnrichmentBatch() {
    if (!enrichState.running || enrichState.paused) return;

    const batch = enrichState.queue.splice(0, enrichState.batchSize);
    if (batch.length === 0) {
      enrichState.running = false;
      updateEnrichUI();
      showEnrichComplete();
      return;
    }

    // Process batch concurrently with per-provider UI updates
    const promises = batch.map(async (providerRow) => {
      try {
        const result = await enrichProvider(providerRow);
        enrichState.processed++;

        if (result.newEmail || result.newPhone || result.website) {
          enrichState.found++;
          enrichState.results.push(result);
          applyEnrichment(result);
        } else {
          enrichState.skipped++;
        }
        // Update UI after EACH provider (not just per batch)
        updateEnrichUI();
      } catch (err) {
        enrichState.processed++;
        enrichState.errors++;
        console.error('[Enrich] Error:', err);
        updateEnrichUI();
      }
    });

    await Promise.all(promises);
    updateEnrichUI();

    // Delay before next batch
    if (enrichState.running && !enrichState.paused && enrichState.queue.length > 0) {
      setTimeout(runEnrichmentBatch, enrichState.delayMs);
    } else if (enrichState.queue.length === 0) {
      enrichState.running = false;
      updateEnrichUI();
      showEnrichComplete();
    }
  }

  /* ââ Apply enrichment results to CRM state ââââââââââââââââ */
  function applyEnrichment(result) {
    const state = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');

    // Update pipeline entry
    const pipeIdx = state.pipeline.findIndex(function(p) { return p[I.ID] === result.id; });
    if (pipeIdx !== -1) {
      if (result.newEmail) state.pipeline[pipeIdx][I.EM] = result.newEmail;
      if (result.newPhone) state.pipeline[pipeIdx][I.PH] = result.newPhone;
    }

    // Update pState with enrichment data
    if (!state.pState[result.id]) state.pState[result.id] = {};
    const ps = state.pState[result.id];
    if (result.newEmail) ps.verifiedEmail = result.newEmail;
    if (result.newPhone) ps.verifiedPhone = result.newPhone;
    if (result.website) ps.website = result.website;
    if (result.npiNumber) ps.npiNumber = result.npiNumber;
    ps.enrichedAt = new Date().toISOString();
    ps.enrichSource = result.source;

    localStorage.setItem(STORE_KEY, JSON.stringify(state));

    // Also update FULL_RAW if the provider exists there
    if (window.FULL_RAW) {
      const rawIdx = window.FULL_RAW.findIndex(function(r) { return r[I.ID] === result.id; });
      if (rawIdx !== -1) {
        if (result.newEmail) window.FULL_RAW[rawIdx][I.EM] = result.newEmail;
        if (result.newPhone) window.FULL_RAW[rawIdx][I.PH] = result.newPhone;
      }
    }
  }

  /* ââ UI âââââââââââââââââââââââââââââââââââââââââââââââââââ */
  function createEnrichPanel() {
    // Check if panel already exists
    if (document.getElementById('enrich-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'enrich-panel';
    panel.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.85);overflow-y:auto;';

    panel.innerHTML = '<div style="max-width:800px;margin:40px auto;padding:30px;background:#1a1f2e;border-radius:12px;border:1px solid #2d3548;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">'
      + '<h2 style="margin:0;color:#e8ecf1;font-size:22px;">Email Enrichment Engine</h2>'
      + '<button onclick="window._enrichClose()" style="background:none;border:none;color:#8892a4;font-size:24px;cursor:pointer;">&times;</button>'
      + '</div>'

      + '<div style="background:#141824;border-radius:8px;padding:16px;margin-bottom:20px;">'
      + '<p style="color:#8892a4;margin:0 0 12px 0;font-size:13px;">This tool finds <strong style="color:#e8ecf1;">real email addresses</strong> for your providers by searching the NPI Registry and scraping provider websites. The fake generated emails will be replaced with verified ones.</p>'
      + '<div style="display:flex;gap:12px;flex-wrap:wrap;">'
      + '<div style="flex:1;min-width:200px;background:#1a1f2e;border-radius:6px;padding:12px;">'
      + '<div style="color:#8892a4;font-size:11px;text-transform:uppercase;">Pipeline Providers</div>'
      + '<div id="enrich-total" style="color:#e8ecf1;font-size:24px;font-weight:bold;">0</div>'
      + '</div>'
      + '<div style="flex:1;min-width:200px;background:#1a1f2e;border-radius:6px;padding:12px;">'
      + '<div style="color:#8892a4;font-size:11px;text-transform:uppercase;">Already Enriched</div>'
      + '<div id="enrich-done" style="color:#4ade80;font-size:24px;font-weight:bold;">0</div>'
      + '</div>'
      + '<div style="flex:1;min-width:200px;background:#1a1f2e;border-radius:6px;padding:12px;">'
      + '<div style="color:#8892a4;font-size:11px;text-transform:uppercase;">Remaining</div>'
      + '<div id="enrich-remaining" style="color:#f59e0b;font-size:24px;font-weight:bold;">0</div>'
      + '</div>'
      + '</div></div>'

      // Controls
      + '<div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">'
      + '<button id="enrich-start-btn" onclick="window._enrichStart(\'pipeline\')" style="padding:10px 20px;background:#1a568e;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">Enrich Pipeline (1000)</button>'
      + '<button id="enrich-selected-btn" onclick="window._enrichStart(\'selected\')" style="padding:10px 20px;background:#2d7db3;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">Enrich Selected</button>'
      + '<button id="enrich-pause-btn" onclick="window._enrichPause()" style="padding:10px 20px;background:#f59e0b;color:#000;border:none;border-radius:6px;cursor:pointer;font-size:14px;display:none;">Pause</button>'
      + '<button id="enrich-stop-btn" onclick="window._enrichStop()" style="padding:10px 20px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;display:none;">Stop</button>'
      + '</div>'

      // Batch size control
      + '<div style="margin-bottom:20px;display:flex;align-items:center;gap:10px;">'
      + '<label style="color:#8892a4;font-size:13px;">Batch size:</label>'
      + '<select id="enrich-batch-size" onchange="window._enrichSetBatch(this.value)" style="background:#141824;color:#e8ecf1;border:1px solid #2d3548;border-radius:4px;padding:4px 8px;">'
      + '<option value="1">1 (safest)</option>'
      + '<option value="5">5</option>'
      + '<option value="10" selected>10 (default)</option>'
      + '<option value="20">20 (fast)</option>'
      + '</select>'
      + '<label style="color:#8892a4;font-size:13px;margin-left:10px;">Delay:</label>'
      + '<select id="enrich-delay" onchange="window._enrichSetDelay(this.value)" style="background:#141824;color:#e8ecf1;border:1px solid #2d3548;border-radius:4px;padding:4px 8px;">'
      + '<option value="200">0.2s (fast)</option>'
      + '<option value="500" selected>0.5s (default)</option>'
      + '<option value="1500">1.5s (polite)</option>'
      + '<option value="3000">3s (very polite)</option>'
      + '</select>'
      + '</div>'

      // Progress bar
      + '<div id="enrich-progress-wrap" style="display:none;margin-bottom:20px;">'
      + '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">'
      + '<span id="enrich-progress-text" style="color:#8892a4;font-size:13px;">Processing...</span>'
      + '<span id="enrich-progress-pct" style="color:#e8ecf1;font-size:13px;">0%</span>'
      + '</div>'
      + '<div style="background:#141824;border-radius:4px;height:8px;overflow:hidden;">'
      + '<div id="enrich-progress-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#1a568e,#4ade80);border-radius:4px;transition:width 0.3s;"></div>'
      + '</div>'
      + '<div style="display:flex;gap:20px;margin-top:8px;">'
      + '<span style="color:#4ade80;font-size:12px;">Found: <strong id="enrich-found-count">0</strong></span>'
      + '<span style="color:#8892a4;font-size:12px;">Skipped: <strong id="enrich-skipped-count">0</strong></span>'
      + '<span style="color:#ef4444;font-size:12px;">Errors: <strong id="enrich-error-count">0</strong></span>'
      + '</div>'
      + '</div>'

      // Results table
      + '<div id="enrich-results-wrap" style="display:none;margin-top:16px;">'
      + '<h3 style="color:#e8ecf1;font-size:16px;margin-bottom:12px;">Enrichment Results</h3>'
      + '<div style="max-height:400px;overflow-y:auto;border:1px solid #2d3548;border-radius:6px;">'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px;">'
      + '<thead><tr style="background:#141824;position:sticky;top:0;">'
      + '<th style="padding:8px;text-align:left;color:#8892a4;border-bottom:1px solid #2d3548;">Provider</th>'
      + '<th style="padding:8px;text-align:left;color:#8892a4;border-bottom:1px solid #2d3548;">New Email</th>'
      + '<th style="padding:8px;text-align:left;color:#8892a4;border-bottom:1px solid #2d3548;">Website</th>'
      + '<th style="padding:8px;text-align:left;color:#8892a4;border-bottom:1px solid #2d3548;">Source</th>'
      + '</tr></thead>'
      + '<tbody id="enrich-results-tbody"></tbody>'
      + '</table></div>'
      + '<button onclick="window._enrichExportCSV()" style="margin-top:10px;padding:8px 16px;background:#1a568e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;">Export Results CSV</button>'
      + '</div>'

      + '</div>';

    document.body.appendChild(panel);
  }

  function updateEnrichUI() {
    const state = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const pipeline = state.pipeline || [];
    const pState = state.pState || {};

    const total = pipeline.length;
    const enriched = pipeline.filter(function(p) {
      const ps = pState[p[I.ID]];
      return ps && ps.enrichedAt;
    }).length;

    setTextSafe('enrich-total', total);
    setTextSafe('enrich-done', enriched);
    setTextSafe('enrich-remaining', total - enriched);

    // Update progress
    if (enrichState.running || enrichState.processed > 0) {
      showEl('enrich-progress-wrap');
      const totalInQueue = enrichState.processed + enrichState.queue.length;
      const pct = totalInQueue > 0 ? Math.round((enrichState.processed / totalInQueue) * 100) : 0;

      setTextSafe('enrich-progress-pct', pct + '%');
      setTextSafe('enrich-progress-text', enrichState.running
        ? (enrichState.paused ? 'Paused' : 'Processing ' + enrichState.processed + ' of ' + totalInQueue + '...')
        : 'Complete â ' + enrichState.processed + ' processed');

      const bar = document.getElementById('enrich-progress-bar');
      if (bar) bar.style.width = pct + '%';

      setTextSafe('enrich-found-count', enrichState.found);
      setTextSafe('enrich-skipped-count', enrichState.skipped);
      setTextSafe('enrich-error-count', enrichState.errors);

      // Show/hide buttons
      if (enrichState.running) {
        hideEl('enrich-start-btn');
        hideEl('enrich-selected-btn');
        showEl('enrich-pause-btn');
        showEl('enrich-stop-btn');

        const pauseBtn = document.getElementById('enrich-pause-btn');
        if (pauseBtn) {
          pauseBtn.textContent = enrichState.paused ? 'Resume' : 'Pause';
          pauseBtn.style.background = enrichState.paused ? '#4ade80' : '#f59e0b';
        }
      } else {
        showEl('enrich-start-btn');
        showEl('enrich-selected-btn');
        hideEl('enrich-pause-btn');
        hideEl('enrich-stop-btn');
      }
    }

    // Update results table
    if (enrichState.results.length > 0) {
      showEl('enrich-results-wrap');
      const tbody = document.getElementById('enrich-results-tbody');
      if (tbody) {
        tbody.innerHTML = enrichState.results.map(function(r) {
          return '<tr style="border-bottom:1px solid #2d3548;">'
            + '<td style="padding:6px 8px;color:#e8ecf1;">' + esc(r.name) + '</td>'
            + '<td style="padding:6px 8px;color:#4ade80;">' + esc(r.newEmail || '-') + '</td>'
            + '<td style="padding:6px 8px;color:#60a5fa;"><a href="' + esc(r.website || '') + '" target="_blank" style="color:#60a5fa;text-decoration:none;">' + esc(r.website ? shortenUrl(r.website) : '-') + '</a></td>'
            + '<td style="padding:6px 8px;color:#8892a4;">' + esc(r.source || '-') + '</td>'
            + '</tr>';
        }).join('');
      }
    }
  }

  function showEnrichComplete() {
    if (typeof window.showToast === 'function') {
      window.showToast('Enrichment complete! Found ' + enrichState.found + ' emails out of ' + enrichState.processed + ' providers.', 'ok');
    }
  }

  /* ââ UI helpers âââââââââââââââââââââââââââââââââââââââââââ */
  function setTextSafe(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  function showEl(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = '';
  }
  function hideEl(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function shortenUrl(url) {
    return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').substring(0, 40);
  }

  /* ââ Public API (window-level for onclick handlers) âââââââ */
  window._enrichOpen = function() {
    createEnrichPanel();
    document.getElementById('enrich-panel').style.display = '';
    updateEnrichUI();
  };

  window._enrichClose = function() {
    var panel = document.getElementById('enrich-panel');
    if (panel) panel.style.display = 'none';
  };

  window._enrichStart = function(mode) {
    var state = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    var pipeline = state.pipeline || [];
    var pState = state.pState || {};

    var providers;
    if (mode === 'selected' && window.state && window.state.selected && window.state.selected.size > 0) {
      providers = pipeline.filter(function(p) { return window.state.selected.has(p[I.ID]); });
    } else {
      // Skip already enriched
      providers = pipeline.filter(function(p) {
        var ps = pState[p[I.ID]];
        return !ps || !ps.enrichedAt;
      });
    }

    if (providers.length === 0) {
      if (typeof window.showToast === 'function') {
        window.showToast('No providers to enrich (all already done or none selected)', 'warn');
      }
      return;
    }

    enrichState.running = true;
    enrichState.paused = false;
    enrichState.queue = providers.slice(); // copy
    enrichState.processed = 0;
    enrichState.found = 0;
    enrichState.errors = 0;
    enrichState.skipped = 0;
    enrichState.results = [];
    enrichState.mode = mode;

    updateEnrichUI();
    runEnrichmentBatch();
  };

  window._enrichPause = function() {
    enrichState.paused = !enrichState.paused;
    if (!enrichState.paused) {
      // Resume
      runEnrichmentBatch();
    }
    updateEnrichUI();
  };

  window._enrichStop = function() {
    enrichState.running = false;
    enrichState.paused = false;
    enrichState.queue = [];
    updateEnrichUI();
  };

  window._enrichSetBatch = function(val) {
    enrichState.batchSize = parseInt(val) || 5;
  };

  window._enrichSetDelay = function(val) {
    enrichState.delayMs = parseInt(val) || 1500;
  };

  window._enrichExportCSV = function() {
    if (enrichState.results.length === 0) return;

    var rows = [['Provider','Old Email','New Email','Website','Phone','NPI','Source']];
    enrichState.results.forEach(function(r) {
      rows.push([r.name, r.oldEmail, r.newEmail||'', r.website||'', r.newPhone||'', r.npiNumber||'', r.source||'']);
    });

    var csv = rows.map(function(r) {
      return r.map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');

    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'enrichment-results-' + new Date().toISOString().slice(0,10) + '.csv';
    a.click();
  };

  /* ââ Add Enrich button to CRM header ââââââââââââââââââââââ */
  function addEnrichButton() {
    // Don't add if already exists
    if (document.getElementById('enrich-btn')) return;

    // Find the header area â look for the Gmail button or the header bar
    var headerBar = document.querySelector('header') || document.querySelector('.header') || document.querySelector('[class*="header"]');

    // Try to find the row with action buttons
    var gmailBtn = document.querySelector('[onclick*="Gmail"], [onclick*="gmail"], button[class*="gmail"]');
    var container = gmailBtn ? gmailBtn.parentElement : headerBar;

    if (!container) {
      // Fallback: find the TODAY button area
      var todayBtn = document.querySelector('[onclick*="today"], [onclick*="Today"]');
      container = todayBtn ? todayBtn.parentElement : null;
    }

    if (!container) {
      // Last resort: add to top of body
      container = document.body;
    }

    var btn = document.createElement('button');
    btn.id = 'enrich-btn';
    btn.textContent = 'ENRICH EMAILS';
    btn.style.cssText = 'padding:6px 14px;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;letter-spacing:0.5px;margin-left:8px;';
    btn.onclick = window._enrichOpen;

    // Insert before Gmail btn or append
    if (gmailBtn) {
      gmailBtn.parentElement.insertBefore(btn, gmailBtn);
    } else {
      container.appendChild(btn);
    }
  }

  /* ââ Initialize âââââââââââââââââââââââââââââââââââââââââââ */
  // Wait for CRM to load, then add our button
  function waitAndInit() {
    if (document.querySelector('header') || document.querySelector('[class*="header"]') || document.querySelector('button')) {
      addEnrichButton();
    } else {
      setTimeout(waitAndInit, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitAndInit);
  } else {
    setTimeout(waitAndInit, 1000);
  }

})();
