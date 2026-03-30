/**
 * app.js — JUMA Provider CRM
 * ES6 module. All API calls go through /api/* (Netlify Functions).
 * No secrets in this file.
 */

// Bridge from window globals set by index.html module loader
const { loadState, saveState, exportBackup, importBackup } = window._store;
const {
  callAI, extractText,
  airtableList, airtablePatch, airtableCreate, syncAllFromAirtable,
  gmailSend, gmailRefreshToken, gmailExchangeToken,
  getValidGmailToken, isGmailConnected,
} = window._api;
const { FULL_RAW, STATES, VERTS, CITIES } = window;


// ── INDEX MAP ─────────────────────────────────────────────────
let I = Object.freeze({ID:0,N:1,SP:2,V:3,CI:4,ST:5,PH:6,EM:7,CO:8,NP:9,PR:10,TX:11,AD:12});
let PER_PAGE = 50;
let STATUS_LABELS = Object.freeze({new:'New',contacted:'Called',warm:'Warm',signed:'Signed',dead:'Dead'});
let STATUS_ICONS  = Object.freeze({new:'⭐',contacted:'📞',warm:'🔥',signed:'✅',dead:'💀'});
let STATUS_CYCLE  = ['new','contacted','warm','signed','dead'];

// ── EMAIL TEMPLATES (template literals OK here — not HTML) ────
let TEMPLATES = {
  intro:    function(n,sp) { return 'Hi ' + ln(n) + ',\n\nMy name is Dr. Parth Kansagra — dentist, entrepreneur, founder of JŪMA, a prepaid healthcare wallet that sends your practice pre-funded cash-pay patients.\n\nI\'m building the JŪMA provider network' + (sp ? ' in ' + sp.toLowerCase() : '') + ' and want you as a founding partner.\n\nHow it works: Members pre-load a digital wallet — like a Starbucks card for healthcare — and spend credits at participating providers. You get paid in full at your rates. Zero insurance. Zero billing overhead. Zero prior auth. JŪMA takes a small transaction fee only when a patient pays.\n\nNo cost to join. No contract. Your rates, your schedule.\n\nWorth a 15-minute call?\n\nDr. Parth Kansagra, DMD MBS MBA\nFounder, JŪMA · juma.com/providers'; },
  pain:     function(n)    { return 'Hi ' + ln(n) + ',\n\nHow many hours per week does your practice spend on insurance claims, prior auths, and billing disputes?\n\nI built JŪMA to eliminate all of it. Pre-funded patients arrive with credits already loaded — they pay you at your full rate instantly. No claims. No denials. No 90-day wait.\n\nWe\'re onboarding founding providers now. First practices in get rates locked permanently.\n\n10 minutes this week?\n\nDr. Parth Kansagra — Founder, JŪMA\njuma.com/providers'; },
  short:    function(n)    { return 'Hi ' + ln(n) + ',\n\nDr. Parth Kansagra here — cash-pay dentist in OC, founder of JŪMA. We send pre-funded patients to cash-pay practices. You get paid your full rate, zero billing friction.\n\nBuilding the network in your area. Open to a 10-minute call?\n\n— Parth · juma.com/providers'; },
  followup: function(n)    { return 'Hi ' + ln(n) + ',\n\nFollowing up on my note about JŪMA — pre-funded cash-pay patients, zero billing overhead, your rates. No cost to join.\n\nIf there\'s 10 minutes, I\'d love to show you the economics.\n\n— Dr. Parth Kansagra · juma.com/providers'; },
  linkedin: function(n,sp) { return 'Hi ' + ln(n) + ' — came across your' + (sp ? ' ' + sp.toLowerCase() : '') + ' practice and wanted to connect.\n\nBuilding JŪMA — prepaid healthcare wallet. Members pre-load credits, spend at participating providers. You set your rates.\n\n10 minutes to show you the model?\n\n— Dr. Parth Kansagra, Founder JŪMA'; }
};

let DRIP_SCHEDULE = [
  { day:3, label:'Follow-up #1', subject:'Quick follow-up — JŪMA Provider Partnership',
    body: function(n) { return 'Hi ' + ln(n) + ',\n\nJust following up on my note from a few days ago about JŪMA.\n\nHere\'s the one-sentence version: JŪMA sends your practice pre-funded cash-pay patients who pay instantly at your full rate — no insurance, no billing overhead, no prior auth.\n\nWorth 10 minutes to show you the economics?\n\n— Dr. Parth Kansagra\njuma.com/providers'; }
  },
  { day:7, label:'Follow-up #2 — The Math', subject:'What JŪMA actually means for your revenue',
    body: function(n) { return 'Hi ' + ln(n) + ',\n\nOne number: the average insurance reimbursement is 60–70 cents on the dollar. Every JŪMA patient pays 100 cents — at your rate, instantly.\n\nFor a practice doing $500K/year in cash-pay, that gap is real money.\n\nNo contract to join. No monthly fee. JŪMA takes a small % only when a patient transacts.\n\n10 minutes this week?\n\n— Dr. Parth Kansagra, DMD MBS MBA\nFounder, JŪMA · juma.com/providers'; }
  },
  { day:14, label:'Final Email', subject:'Last note — JŪMA',
    body: function(n) { return 'Hi ' + ln(n) + ',\n\nLast note from me — I promise.\n\nIf the timing isn\'t right for JŪMA, no worries. I\'ll circle back in a few months.\n\nIf you\'ve been curious but haven\'t had a chance to respond, I\'d love 10 minutes anytime.\n\n— Dr. Parth Kansagra\njuma.com/providers'; }
  }
];

// ── INTEGRATION CONFIG (persisted) ───────────────────────────
// cfg is kept as a compatibility shim — reads/writes go through state.settings
// All real persistence goes through store.js saveState/loadState
const cfg = new Proxy({}, {
  get(_, key) {
    const map = {
      airtableKey: 'airtableKey', airtableBaseId: 'airtableBaseId',
      airtableTableId: 'airtableTableId', gmailUser: 'gmailUser',
      gmailClientId: 'gmailClientId', gmailConnected: 'gmailConnected',
    };
    return state.settings?.[map[key]] ?? '';
  },
  set(_, key, value) {
    const map = {
      airtableKey: 'airtableKey', airtableBaseId: 'airtableBaseId',
      airtableTableId: 'airtableTableId', gmailUser: 'gmailUser',
      gmailClientId: 'gmailClientId', gmailConnected: 'gmailConnected',
    };
    if (map[key] && state.settings) state.settings[map[key]] = value;
    return true;
  },
});

// ── STATE ─────────────────────────────────────────────────────
let state = {
  pipeline:     [],
  pState:       {},
  actLog:       [],
  scheduled:    [],
  settings: {
    gmailUser: '', gmailClientId: '', gmailAccessToken: '',
    gmailRefreshToken: '', gmailTokenExpiry: 0, gmailConnected: false,
    airtableKey: '', airtableBaseId: '', airtableTableId: '',
    appSecret: '',
  },
  view:         'pipeline',
  tab:          'pipeline',
  filterStatus: 'all',
  filterVert:   '',
  sortKey:      'N',
  sortDir:      1,
  page:         0,
  selected:     null,
  findResults:  [],
  findVert:     '',
  drawerOpen:   false,
  drawerId:     null,
  emailOpen:    false,
  emailId:      null,
  emailBulkIds: [],
  briefOpen:    false,
  briefId:      null,
  briefContent: null,
  dripOpen:     false,
  schedOpen:    false,
  schedId:      null,
  airtableStatus: 'idle',  // idle | loading | ok | error
  setupDone:    false
};

// ── WEB WORKER (search) ──────────────────────────────────────
let searchWorker = null;
let searchRequestId = 0;
const pendingSearches = new Map();

function initSearchWorker() {
  try {
    searchWorker = new Worker('./search.worker.js');
    searchWorker.onmessage = (e) => {
      const { type, requestId, results, total, pages } = e.data;
      if (type === 'READY') {
        console.info('[Worker] Ready with', e.data.count, 'providers');
      }
      if (type === 'RESULTS' && pendingSearches.has(requestId)) {
        const resolve = pendingSearches.get(requestId);
        pendingSearches.delete(requestId);
        resolve({ results, total, pages });
      }
    };
    searchWorker.onerror = (err) => {
      console.warn('[Worker] Error — falling back to main thread search:', err.message);
      searchWorker = null;
    };
    // Init worker with provider data
    searchWorker.postMessage({ type: 'INIT', data: { providers: FULL_RAW } });
  } catch {
    console.warn('[Worker] Web Workers not supported — using main thread search');
    searchWorker = null;
  }
}

function searchViaWorker({ query, specialty, state: provState, city, page, perPage }) {
  return new Promise((resolve) => {
    if (!searchWorker) {
      // Fallback: main thread search
      resolve({ results: getFindResultsSync({ query, specialty, state: provState, city, page, perPage }), total: 0, pages: 1 });
      return;
    }
    const reqId = ++searchRequestId;
    pendingSearches.set(reqId, resolve);
    searchWorker.postMessage({
      type: 'SEARCH',
      data: { query, specialty, state: provState, city, page: page || 0, perPage: perPage || 50, requestId: reqId },
    });
  });
}

// ── DEBOUNCE ──────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

const debouncedFindSearch = debounce(async () => {
  const q  = document.getElementById('find-q')?.value || '';
  const st = document.getElementById('find-state')?.value || '';
  const ci = document.getElementById('find-city')?.value || '';
  const vt = state.findVert || '';
  const { results, total, pages } = await searchViaWorker({
    query: q, specialty: vt, state: st, city: ci, page: state.findPage || 0,
  });
  state.findResultsAsync = results;
  state.findTotal = total;
  state.findPages = pages;
  renderFindTableFromResults(results, total, pages);
}, 280);

// ── HELPERS ──────────────────────────────────────────────────
function ln(n) {
  if (!n) return 'there';
  return String(n).replace(/,.*$/, '').trim().split(' ').pop() || 'there';
}
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function nowISO()  { return new Date().toISOString(); }
function todayStr(){ return new Date().toISOString().slice(0,10); }
function uid()     { return 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2,7); }

function relTime(iso) {
  if (!iso) return '—';
  let d = new Date(iso), diff = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diff < 1)    return 'just now';
  if (diff < 60)   return diff + 'm ago';
  if (diff < 1440) return Math.floor(diff/60) + 'h ago';
  if (diff < 10080)return Math.floor(diff/1440) + 'd ago';
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
}

function fmtDateTime(iso) {
  if (!iso) return '';
  let d = new Date(iso);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + ' at ' + d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true});
}

function findProv(id) {
  let p = state.pipeline.find(function(x){ return x[I.ID]===id; });
  if (p) return p;
  if (typeof FULL_RAW !== 'undefined') return FULL_RAW.find(function(x){ return x[I.ID]===id; }) || null;
  return null;
}
function nameOf(id) { let p = findProv(id); return p ? p[I.N] : 'Unknown'; }

function getS(id) {
  return state.pState[id] || {status:'new',priority:2,notes:'',followUp:'',lastContact:'',activity:[],dripStarted:null,dripDates:[],dripSent:[false,false,false],dripStatus:'inactive',emails:[]};
}
function ensureS(id) {
  if (!state.pState[id]) state.pState[id] = {status:'new',priority:2,notes:'',followUp:'',lastContact:'',activity:[],dripStarted:null,dripDates:[],dripSent:[false,false,false],dripStatus:'inactive',emails:[]};
  if (!state.pState[id].emails) state.pState[id].emails = [];
}
function updS(id, obj) { ensureS(id); Object.assign(state.pState[id], obj); }
function logAct(id, entry) {
  ensureS(id);
  state.pState[id].activity = state.pState[id].activity || [];
  state.pState[id].activity.unshift(entry);
  if (state.pState[id].activity.length > 50) state.pState[id].activity = state.pState[id].activity.slice(0,50);
}
function addFeed(text, icon) {
  state.actLog.push({text:text, icon:icon, time:nowISO()});
  if (state.actLog.length > 500) state.actLog = state.actLog.slice(-500);
}

// ── PERSIST ──────────────────────────────────────────────────
function save() {
  const ok = saveState(state);
  if (!ok) showToast('Save failed — storage may be full', 'error');
  const el = document.getElementById('top-status');
  if (el) el.textContent = new Date().toLocaleTimeString() + ' · saved';
}

function loadSaved() {
  const loaded = loadState();
  // Merge loaded state into current state object
  Object.assign(state, {
    pipeline:  loaded.pipeline  || [],
    pState:    loaded.pState    || {},
    actLog:    loaded.actLog    || [],
    scheduled: loaded.scheduled || [],
    settings:  { ...state.settings, ...(loaded.settings || {}) },
  });
  // Backward compat: if old juma_crm_cfg key exists, migrate it
  try {
    const oldCfg = localStorage.getItem('juma_crm_cfg');
    if (oldCfg) {
      const c = JSON.parse(oldCfg);
      if (c.airtableKey)     state.settings.airtableKey     = c.airtableKey;
      if (c.airtableBaseId)  state.settings.airtableBaseId  = c.airtableBaseId;
      if (c.airtableTableId) state.settings.airtableTableId = c.airtableTableId;
      if (c.gmailUser)       state.settings.gmailUser        = c.gmailUser;
      if (c.gmailClientId)   state.settings.gmailClientId   = c.gmailClientId;
      // Migrate once then delete old keys
      localStorage.removeItem('juma_crm_cfg');
      localStorage.removeItem('juma_crm_pipeline');
      localStorage.removeItem('juma_crm_pstate');
      localStorage.removeItem('juma_crm_log');
      localStorage.removeItem('juma_crm_scheduled');
      localStorage.removeItem('juma_crm_setup');
      save(); // write to new key
    }
  } catch { /* ignore migration errors */ }
}

// ── AIRTABLE SYNC ────────────────────────────────────────────
async function syncAirtable() {
  const { airtableBaseId, airtableTableId } = state.settings;
  if (!airtableBaseId || !airtableTableId) {
    showToast('Configure Airtable in Settings first', 'warn');
    openSetup();
    return;
  }
  state.airtableStatus = 'loading';
  updAirtableBtn();
  showToast('Syncing from Airtable…', 'ok');
  try {
    const records = await syncAllFromAirtable({
      baseId: airtableBaseId,
      tableId: airtableTableId,
      onProgress: ({ count }) => {
        const btn = document.getElementById('airtable-sync-btn');
        if (btn) btn.textContent = '⟳ Syncing… ' + count;
      },
    });
    // Map records to pipeline entries
    let added = 0, updated = 0;
    records.forEach(rec => {
      const f = rec.fields || {};
      const name    = f['Name'] || f['Provider Name'] || f['Practice Name'] || '';
      const email   = f['Email'] || f['Email Address'] || '';
      const phone   = f['Phone'] || f['Phone Number'] || '';
      const city    = f['City'] || '';
      const provSt  = f['State'] || '';
      const sp      = f['Specialty'] || f['Type'] || '';
      if (!name) return;
      const id = 'at_' + rec.id;
      const exists = state.pipeline.find(p => p[0] === id);
      if (!exists) {
        state.pipeline.push([id, name, sp, sp.toLowerCase(), city, provSt, phone, email, '', '', 2, sp, '']);
        added++;
      }
      // Always update pState with latest Airtable data
      const existing = getS(id);
      updS(id, {
        airtableRecordId: rec.id,
        status:   f['Status']     || existing.status   || 'new',
        notes:    f['Notes']      || existing.notes     || '',
        priority: f['Priority']   || existing.priority  || 2,
        followUp: f['Follow Up']  || existing.followUp  || '',
      });
      if (exists) updated++;
    });
    state.airtableStatus = 'ok';
    save();
    renderAll();
    showToast('Synced: ' + added + ' new, ' + updated + ' updated', 'ok');
  } catch (err) {
    state.airtableStatus = 'error';
    showToast('Airtable sync failed: ' + err.message, 'error');
    console.error('[Airtable sync]', err);
  }
  updAirtableBtn();
}

// ── PUSH STATUS BACK TO AIRTABLE ─────────────────────────────
async function pushToAirtable(providerId) {
  const { airtableBaseId, airtableTableId } = state.settings;
  if (!airtableBaseId || !airtableTableId) return;
  const s = getS(providerId);
  if (!s?.airtableRecordId) return;
  try {
    await airtablePatch({
      baseId: airtableBaseId,
      tableId: airtableTableId,
      recordId: s.airtableRecordId,
      fields: {
        ...(s.status   && { 'Status':       s.status }),
        ...(s.notes    && { 'Notes':         s.notes }),
        ...(s.priority && { 'Priority':      String(s.priority) }),
        ...(s.followUp && { 'Follow Up':     s.followUp }),
        'Last Contact': new Date().toISOString().slice(0, 10),
      },
    });
  } catch (err) {
    // Silent fail — local state is source of truth
    console.warn('[pushToAirtable] silent fail:', err.message);
  }
}

// ── SETUP MODAL ──────────────────────────────────────────────
function openSetup() {
  const modal = document.getElementById('setup-modal');
  if (!modal) return;
  const s = state.settings;
  document.getElementById('setup-airtable-key').value   = s.airtableKey     || '';
  document.getElementById('setup-airtable-base').value  = s.airtableBaseId  || '';
  document.getElementById('setup-airtable-table').value = s.airtableTableId || '';
  document.getElementById('setup-gmail').value          = s.gmailUser       || '';
  const cidEl = document.getElementById('setup-gmail-client-id');
  if (cidEl) cidEl.value = s.gmailClientId || '';
  modal.classList.add('open');
}

function triggerExportBackup() {
  exportBackup(state);
  localStorage.setItem('juma_last_backup', String(Date.now()));
  showToast('Backup downloaded', 'ok');
}

function triggerImportBackup(inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const imported = importBackup(e.target.result);
    if (!imported) { showToast('Invalid backup file', 'error'); return; }
    Object.assign(state, imported);
    save();
    renderAll();
    showToast('Backup restored — ' + state.pipeline.length + ' providers loaded', 'ok');
  };
  reader.readAsText(file);
}

function closeSetup() {
  document.getElementById('setup-modal').classList.remove('open');
}

function saveSetup() {
  state.settings.airtableKey     = (document.getElementById('setup-airtable-key')?.value    || '').trim();
  state.settings.airtableBaseId  = (document.getElementById('setup-airtable-base')?.value   || '').trim();
  state.settings.airtableTableId = (document.getElementById('setup-airtable-table')?.value  || '').trim();
  state.settings.gmailUser       = (document.getElementById('setup-gmail')?.value            || '').trim();
  const cidEl = document.getElementById('setup-gmail-client-id');
  if (cidEl) state.settings.gmailClientId = (cidEl.value || '').trim();
  save();
  closeSetup();
  updGmailBtn();
  showToast('Settings saved', 'ok');
  if (state.settings.airtableBaseId && state.settings.airtableTableId) {
    showToast('Airtable connected — click Sync to import providers', 'ok');
  }
}

// ── DRIP ENGINE ──────────────────────────────────────────────
function startDrip(id) {
  let s = getS(id);
  if (s.dripStarted) return;
  let now = new Date();
  let dates = DRIP_SCHEDULE.map(function(d) {
    let dt = new Date(now); dt.setDate(dt.getDate() + d.day); return dt.toISOString().slice(0,10);
  });
  updS(id, {dripStarted:nowISO(), dripDates:dates, dripSent:[false,false,false], dripStatus:'active'});
  logAct(id, {type:'drip', text:'Drip campaign started (3 emails scheduled)', time:nowISO()});
  addFeed('Drip started for ' + nameOf(id), '📧');
}

function getDripInfo(id) {
  let s = getS(id);
  if (!s.dripStarted) return null;
  let today = todayStr();
  let sent  = s.dripSent  || [false,false,false];
  let dates = s.dripDates || [];
  let due   = DRIP_SCHEDULE.map(function(d,i){ return {label:d.label, idx:i, date:dates[i]||'', sent:sent[i]}; })
                           .filter(function(d){ return !d.sent && d.date && d.date <= today; });
  let next  = DRIP_SCHEDULE.map(function(d,i){ return {label:d.label, idx:i, date:dates[i]||'', sent:sent[i]}; })
                           .find(function(d){ return !d.sent && d.date && d.date > today; });
  return {
    active:  s.dripStatus === 'active',
    due:     due,
    next:    next || null,
    allSent: sent.every(Boolean),
    steps:   DRIP_SCHEDULE.map(function(d,i){ return {label:d.label, idx:i, date:dates[i]||'', sent:sent[i], isDue: dates[i] && dates[i]<=today && !sent[i]}; })
  };
}

function sendDripEmail(id, idx) {
  let p = findProv(id); if (!p) return;
  let drip = DRIP_SCHEDULE[idx];
  let body = drip.body(p[I.N]);
  sendViaGmail(p[I.EM] || '', drip.subject, body);
  let s = getS(id);
  let dripSent = (s.dripSent||[false,false,false]).slice();
  dripSent[idx] = true;
  updS(id, {dripSent:dripSent});
  recordEmailSent(id, drip.subject, body);
  logAct(id, {type:'email', text:'Drip sent: ' + drip.label, time:nowISO()});
  addFeed('Drip email sent to ' + nameOf(id) + ': ' + drip.label, '📧');
  save(); renderAll();
  showToast('Drip email opened in Gmail', 'ok');
}

function pauseDrip(id)  { updS(id, {dripStatus:'paused'}); save(); if(state.drawerOpen&&state.drawerId===id)renderDrawer(); showToast('Drip paused','warn'); }
function resumeDrip(id) { updS(id, {dripStatus:'active'}); save(); if(state.drawerOpen&&state.drawerId===id)renderDrawer(); showToast('Drip resumed','ok'); }

function getDripDueCount() {
  let today = todayStr(), count = 0;
  Object.keys(state.pState).forEach(function(id) {
    let info = getDripInfo(id);
    if (info && info.due.length > 0) count++;
  });
  return count;
}

// ── EMAIL RECORD KEEPING ──────────────────────────────────────
function recordEmailSent(id, subject, body) {
  ensureS(id);
  let entry = {type:'sent', subject:subject, body:body, time:nowISO()};
  state.pState[id].emails = state.pState[id].emails || [];
  state.pState[id].emails.unshift(entry);
  updS(id, {lastContact: nowISO()});
}

// ── EMAIL SCHEDULER ───────────────────────────────────────────
function openScheduler(id) {
  state.schedId = id;
  state.schedOpen = true;
  let p = findProv(id);
  let modal = document.getElementById('sched-modal');
  if (!modal) return;

  // Pre-fill fields
  let nameEl = document.getElementById('sched-provider-name');
  if (nameEl && p) nameEl.textContent = p[I.N];

  let toEl = document.getElementById('sched-to');
  if (toEl && p) toEl.value = p[I.EM] || '';

  let subjEl = document.getElementById('sched-subject');
  if (subjEl) subjEl.value = 'JŪMA Provider Partnership — Pre-Funded Cash-Pay Patients';

  let bodyEl = document.getElementById('sched-body');
  if (bodyEl && p) bodyEl.value = TEMPLATES.followup(p[I.N]);

  // Default send time: tomorrow 9am
  let tm = document.getElementById('sched-datetime');
  if (tm) {
    let tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1); tomorrow.setHours(9,0,0,0);
    // Format as datetime-local: YYYY-MM-DDTHH:MM
    let pad = function(n){ return n < 10 ? '0'+n : n; };
    tm.value = tomorrow.getFullYear() + '-' + pad(tomorrow.getMonth()+1) + '-' + pad(tomorrow.getDate()) + 'T' + pad(tomorrow.getHours()) + ':' + pad(tomorrow.getMinutes());
  }

  renderSchedQueue(id);
  modal.classList.add('open');
}

function closeScheduler() {
  state.schedOpen = false; state.schedId = null;
  document.getElementById('sched-modal').classList.remove('open');
}

function saveScheduled() {
  let id      = state.schedId;
  let to      = (document.getElementById('sched-to').value || '').trim();
  let subject = (document.getElementById('sched-subject').value || '').trim();
  let body    = (document.getElementById('sched-body').value || '').trim();
  let sendAt  = document.getElementById('sched-datetime').value;

  if (!to)      { showToast('To email is required', 'warn'); return; }
  if (!subject) { showToast('Subject is required', 'warn'); return; }
  if (!body)    { showToast('Email body is required', 'warn'); return; }
  if (!sendAt)  { showToast('Send time is required', 'warn'); return; }

  let sendAtISO = new Date(sendAt).toISOString();

  let entry = {
    id:         uid(),
    providerId: id,
    to:         to,
    subject:    subject,
    body:       body,
    sendAt:     sendAtISO,
    sent:       false,
    sentAt:     null,
    created:    nowISO()
  };
  state.scheduled.push(entry);
  state.scheduled.sort(function(a,b){ return new Date(a.sendAt) - new Date(b.sendAt); });

  logAct(id, {type:'scheduled', text:'Email scheduled: ' + subject + ' for ' + fmtDateTime(sendAtISO), time:nowISO()});
  addFeed('Email scheduled for ' + nameOf(id), '📅');
  save();
  renderSchedQueue(id);
  showToast('Email scheduled for ' + fmtDateTime(sendAtISO), 'ok');

  // Clear body for next one
  let bodyEl = document.getElementById('sched-body');
  if (bodyEl) bodyEl.value = '';
}

function renderSchedQueue(id) {
  let listEl = document.getElementById('sched-queue-list');
  if (!listEl) return;

  // Show: all scheduled (unsent) for this provider + sent email history
  let pending = state.scheduled.filter(function(e){ return e.providerId===id && !e.sent; })
    .sort(function(a,b){ return new Date(a.sendAt)-new Date(b.sendAt); });

  let s = getS(id);
  let sent = (s.emails || []).slice(0,10);

  let html = '';

  if (pending.length) {
    html += '<div class="chain-section-label">📅 Scheduled</div>';
    for (let i=0; i<pending.length; i++) {
      let e = pending[i];
      let isPast = new Date(e.sendAt) < new Date();
      html += '<div class="chain-email' + (isPast ? ' chain-overdue' : '') + '">';
      html += '<div class="chain-email-header">';
      html += '<span class="chain-email-time">' + (isPast ? '⚠ PAST DUE — ' : '') + fmtDateTime(e.sendAt) + '</span>';
      html += '<div style="display:flex;gap:4px">';
      html += '<button class="chain-action-btn chain-send-now" data-sched-send="' + esc(e.id) + '">Send Now</button>';
      html += '<button class="chain-action-btn chain-edit-btn" data-sched-edit="' + esc(e.id) + '">Edit</button>';
      html += '<button class="chain-action-btn chain-del-btn"  data-sched-del="'  + esc(e.id) + '">✕</button>';
      html += '</div></div>';
      html += '<div class="chain-email-subject">' + esc(e.subject) + '</div>';
      html += '<div class="chain-email-preview">' + esc(e.body.slice(0,120)) + (e.body.length>120?'…':'') + '</div>';
      html += '</div>';
    }
  }

  if (sent.length) {
    html += '<div class="chain-section-label" style="margin-top:' + (pending.length?'12px':'0') + '">✉ Sent</div>';
    for (let j=0; j<sent.length; j++) {
      let em = sent[j];
      html += '<div class="chain-email chain-sent">';
      html += '<div class="chain-email-header"><span class="chain-email-time">' + fmtDateTime(em.time) + '</span></div>';
      html += '<div class="chain-email-subject">' + esc(em.subject) + '</div>';
      html += '<div class="chain-email-preview">' + esc((em.body||'').slice(0,120)) + (em.body&&em.body.length>120?'…':'') + '</div>';
      html += '</div>';
    }
  }

  if (!html) {
    html = '<div class="chain-empty">No emails yet. Schedule one above or send directly.</div>';
  }

  listEl.innerHTML = html;
}

function sendScheduledNow(schedId) {
  let entry = state.scheduled.find(function(e){ return e.id === schedId; });
  if (!entry) return;
  sendViaGmail(entry.to, entry.subject, entry.body);
  entry.sent = true; entry.sentAt = nowISO();
  if (entry.providerId) {
    recordEmailSent(entry.providerId, entry.subject, entry.body);
    logAct(entry.providerId, {type:'email', text:'Sent now: ' + entry.subject, time:nowISO()});
  }
  save();
  renderSchedQueue(state.schedId || entry.providerId);
  renderSchedulerView();
  renderCounts();
  showToast('Email opened in Gmail', 'ok');
}

function deleteScheduled(schedId) {
  state.scheduled = state.scheduled.filter(function(e){ return e.id !== schedId; });
  save();
  renderSchedQueue(state.schedId);
  renderSchedulerView();
  renderCounts();
  showToast('Scheduled email removed', 'warn');
}

function editScheduled(schedId) {
  let entry = state.scheduled.find(function(e){ return e.id === schedId; });
  if (!entry) return;
  let toEl   = document.getElementById('sched-to');
  let subjEl = document.getElementById('sched-subject');
  let bodyEl = document.getElementById('sched-body');
  let tmEl   = document.getElementById('sched-datetime');
  if (toEl)   toEl.value   = entry.to;
  if (subjEl) subjEl.value = entry.subject;
  if (bodyEl) bodyEl.value = entry.body;
  if (tmEl) {
    let d = new Date(entry.sendAt);
    let pad = function(n){ return n<10?'0'+n:n; };
    tmEl.value = d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
  }
  // Remove the old one so saving replaces it
  state.scheduled = state.scheduled.filter(function(e){ return e.id !== schedId; });
  showToast('Edit the email above then click Schedule', 'ok');
}

// Check for due scheduled emails (runs every 60s)
function checkScheduled() {
  let now = new Date();
  let due = state.scheduled.filter(function(e){ return !e.sent && new Date(e.sendAt) <= now; });
  if (!due.length) return;
  let cnt = document.getElementById('cnt-sched-due');
  if (cnt) cnt.textContent = due.length;
  // Show badge on scheduler nav
  let navBadge = document.getElementById('sched-nav-badge');
  if (navBadge) { navBadge.textContent = due.length; navBadge.style.display = due.length ? 'inline' : 'none'; }
}

// ── GMAIL INTEGRATION ─────────────────────────────────────────
// Opens Gmail compose with pre-filled fields.
// For true background sending, user would need to authorize Google OAuth.
// This version: opens Gmail web → user sends manually (correct TCPA approach)
// Advanced: will detect if Gmail API token is present and use direct send.
function sendViaGmail(to, subject, body) {
  let url = 'https://mail.google.com/mail/?view=cm&fs=1' +
    (to      ? '&to='   + encodeURIComponent(to)      : '') +
    (subject ? '&su='   + encodeURIComponent(subject) : '') +
    (body    ? '&body=' + encodeURIComponent(body)    : '');
  window.open(url, '_blank');
}

function sendViaOutlook(to, subject, body) {
  window.open('https://outlook.office.com/mail/deeplink/compose?to=' + encodeURIComponent(to) + '&subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body), '_blank');
}

// ── FILTERING ─────────────────────────────────────────────────
function getFiltered() {
  let q = '';
  let gs = document.getElementById('gSearch');
  if (gs) q = (gs.value || '').toLowerCase();
  return state.pipeline.filter(function(p) {
    let s = getS(p[I.ID]);
    if (state.filterStatus !== 'all' && s.status !== state.filterStatus) return false;
    if (state.filterVert && p[I.V] !== state.filterVert) return false;
    if (q) {
      let hay = (p[I.N]+' '+p[I.SP]+' '+p[I.CI]+' '+p[I.ST]+' '+(p[I.EM]||'')+' '+(p[I.PH]||'')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
}

function sortRows(rows) {
  return rows.slice().sort(function(a,b) {
    let sa = getS(a[I.ID]), sb = getS(b[I.ID]);
    let va, vb;
    if      (state.sortKey==='status')      { va=sa.status;           vb=sb.status; }
    else if (state.sortKey==='followUp')    { va=sa.followUp||'9999'; vb=sb.followUp||'9999'; }
    else if (state.sortKey==='lastContact') { va=sa.lastContact||'';  vb=sb.lastContact||''; }
    else if (state.sortKey==='PR')          { return (+(sb.priority||b[I.PR]||2)) - (+(sa.priority||a[I.PR]||2)); }
    else { va = a[I[state.sortKey]]||''; vb = b[I[state.sortKey]]||''; }
    return va<vb ? -state.sortDir : va>vb ? state.sortDir : 0;
  });
}

// Synchronous fallback for when Web Worker isn't available
function getFindResultsSync({ query, specialty, state: provState, city, page = 0, perPage = 50 }) {
  const q  = (query || '').toLowerCase();
  const sp = (specialty || '').toLowerCase();
  const st = (provState || '').toLowerCase();
  const ci = (city || '').toLowerCase();
  const scored = [];
  for (const p of FULL_RAW) {
    const pSp = (p[2] || '').toLowerCase();
    const pSt = (p[5] || '').toLowerCase();
    const pCi = (p[4] || '').toLowerCase();
    if (sp && pSp !== sp) continue;
    if (st && pSt !== st) continue;
    if (ci && !pCi.includes(ci)) continue;
    if (!q) { scored.push([100, p]); continue; }
    const name = (p[1] || '').toLowerCase();
    let s = 0;
    if (name.startsWith(q))    s += 100;
    else if (name.includes(q)) s += 60;
    if (pSp.includes(q))       s += 40;
    if (pCi.includes(q))       s += 20;
    if (s > 0) scored.push([s, p]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(page * perPage, (page + 1) * perPage).map(([, p]) => p);
}

function getFindResults() {
  // Legacy sync call — use for immediate/non-debounced needs
  const q  = document.getElementById('find-q')?.value  || '';
  const st = document.getElementById('find-state')?.value || '';
  const ci = document.getElementById('find-city')?.value  || '';
  const sp = state.findVert || '';
  return getFindResultsSync({ query: q, specialty: sp, state: st, city: ci });
}

function renderFindTableFromResults(results, total, pages) {
  const el = document.getElementById('find-table');
  if (!el) return;
  if (!results || !results.length) {
    el.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No providers found</div><div class="empty-text">Try adjusting your search or filters</div></div></td></tr>';
    return;
  }
  let html = '';
  for (const p of results) {
    const id = p[I.ID];
    const s  = getS(id);
    const inPipe = state.pipeline.find(x => x[0] === id);
    html += '<tr class="find-row">';
    html += '<td><div class="find-name">' + esc(p[I.N]) + '</div><div class="find-sp">' + esc(p[I.SP]) + '</div></td>';
    html += '<td>' + esc(p[I.CI]) + ', ' + esc(p[I.ST]) + '</td>';
    html += '<td>' + (p[I.PH] ? '<a href="tel:' + esc(p[I.PH]) + '" class="find-phone">' + esc(p[I.PH]) + '</a>' : '<span style="color:var(--t3)">—</span>') + '</td>';
    html += '<td>' + (p[I.EM] ? '<span class="find-email">' + esc(p[I.EM]) + '</span>' : '<span style="color:var(--t3)">—</span>') + '</td>';
    html += '<td>';
    if (inPipe) {
      html += '<span style="color:var(--sage);font-size:10px;font-weight:700">✓ In Pipeline</span>';
    } else {
      html += '<button class="find-add-btn" data-addPipeline="' + esc(id) + '">+ Add</button>';
      html += '<button class="find-add-btn" data-quickEmail="' + esc(id) + '" style="margin-left:4px;background:var(--lbg);border-color:var(--lbd);color:var(--lime)">✦ Email</button>';
    }
    html += '</td>';
    html += '</tr>';
  }
  el.innerHTML = html;
  // Update total count display
  const totalEl = document.getElementById('find-total');
  if (totalEl) totalEl.textContent = total ? total.toLocaleString() + ' providers found' : '';
}


function cycleStatus(id) {
  let s = getS(id);
  let idx = STATUS_CYCLE.indexOf(s.status);
  let ns  = STATUS_CYCLE[(idx+1) % STATUS_CYCLE.length];
  updS(id, {status:ns, lastContact:nowISO()});
  logAct(id, {type:'status', text:'Status → ' + STATUS_LABELS[ns], time:nowISO()});
  addFeed(nameOf(id) + ' → ' + STATUS_LABELS[ns], STATUS_ICONS[ns]);
  save(); renderAll();
}

function setStatus(id, status) {
  updS(id, {status:status, lastContact:nowISO()});
  logAct(id, {type:'status', text:'Status → ' + STATUS_LABELS[status], time:nowISO()});
  addFeed(nameOf(id) + ' → ' + STATUS_LABELS[status], STATUS_ICONS[status]);
  save(); renderAll();
}

function logCall(id) {
  let s = getS(id);
  let ns = (s.status === 'new') ? 'contacted' : s.status;
  updS(id, {status:ns, lastContact:nowISO()});
  logAct(id, {type:'call', text:'Call logged', time:nowISO()});
  addFeed('Called ' + nameOf(id), '📞');
  save(); renderAll();
  let p = findProv(id);
  if (p && p[I.EM]) {
    let t = document.getElementById('toast');
    t.innerHTML = 'Call logged — <button onclick="openEmailModal(\'' + id + '\');document.getElementById(\'toast\').classList.remove(\'visible\')" style="margin-left:6px;padding:2px 8px;border-radius:3px;border:1px solid currentColor;background:none;color:inherit;font-family:Syne,sans-serif;font-size:10px;cursor:pointer;font-weight:700">Write Follow-up</button>';
    t.className = 'toast visible ok';
    clearTimeout(window._toastT);
    window._toastT = setTimeout(function(){ t.classList.remove('visible'); }, 5000);
  }
}

function setFollowUp(id, v)  { updS(id, {followUp:v}); save(); renderAll(); }
function setPriority(id, v)  { updS(id, {priority:+v}); save(); renderAll(); }

function setFUDays(id, days) {
  let d = new Date(); d.setDate(d.getDate() + days);
  let v = d.toISOString().slice(0,10);
  updS(id, {followUp:v});
  let el = document.getElementById('fu-date-'+id); if (el) el.value = v;
  save(); renderAll();
  showToast('Follow-up: ' + v, 'ok');
}

function saveNotes(id) {
  let el = document.getElementById('notes-'+id); if (!el) return;
  updS(id, {notes:el.value});
  logAct(id, {type:'note', text:'Notes saved', time:nowISO()});
  save(); showToast('Notes saved', 'ok');
}

function delProv(id) {
  let name = nameOf(id);
  let savedProv  = state.pipeline.find(function(p){ return p[I.ID]===id; });
  let savedState = state.pState[id] ? Object.assign({}, state.pState[id]) : null;
  state.pipeline = state.pipeline.filter(function(p){ return p[I.ID]!==id; });
  delete state.pState[id];
  if (state.selected) state.selected.delete(id);
  if (state.drawerOpen && state.drawerId === id) closeDrawer();
  renderAll();
  window._undoData = {id:id, prov:savedProv, st:savedState};
  let t = document.getElementById('toast');
  t.innerHTML = 'Removed ' + esc(name) + ' — <button onclick="undoDel()" style="margin-left:6px;padding:2px 8px;border-radius:3px;border:1px solid currentColor;background:none;color:inherit;font-family:Syne,sans-serif;font-size:10px;cursor:pointer;font-weight:700">UNDO</button>';
  t.className = 'toast visible warn';
  clearTimeout(window._toastT);
  window._deleteT = setTimeout(function(){ addFeed('Removed '+name,'🗑️'); save(); t.classList.remove('visible'); }, 4000);
}

function undoDel() {
  if (!window._undoData) return;
  clearTimeout(window._deleteT);
  if (window._undoData.prov) state.pipeline.push(window._undoData.prov);
  if (window._undoData.st)   state.pState[window._undoData.id] = window._undoData.st;
  window._undoData = null;
  renderAll(); showToast('Restored', 'ok');
}

function addManual() {
  let name = window.prompt('Provider / Practice Name:'); if (!name) return;
  let spec = window.prompt('Specialty:') || '';
  let ph   = window.prompt('Phone:') || '';
  let em   = window.prompt('Email:') || '';
  let ci   = window.prompt('City:') || '';
  let st   = window.prompt('State (2-letter):') || '';
  let id   = uid();
  state.pipeline.unshift([id,name,spec,'',ci,st,ph,em,'','',2,spec,'']);
  ensureS(id);
  addFeed('Added ' + name, '✏️');
  save(); renderAll();
  showToast(name + ' added', 'ok');
}

function addToPipeline(id) {
  if (typeof FULL_RAW === 'undefined') return;
  let p = FULL_RAW.find(function(x){ return x[I.ID]===id; });
  if (!p || state.pipeline.find(function(x){ return x[I.ID]===id; })) return;
  state.pipeline.push(p);
  ensureS(id);
  addFeed('Added ' + p[I.N], '➕');
  save(); renderCounts(); renderFindTable();
  showToast(p[I.N] + ' added to pipeline', 'ok');
}

// ── SELECTION ─────────────────────────────────────────────────
function toggleSel(id, checked) {
  if (checked) state.selected.add(id); else state.selected.delete(id);
  let row = document.getElementById('row-'+id); if (row) row.classList.toggle('selected', checked);
  updSelBar();
}
function toggleSelAll(checked) {
  getFiltered().forEach(function(p){ checked ? state.selected.add(p[I.ID]) : state.selected.delete(p[I.ID]); });
  updSelBar(); renderPipeTable();
}
function clearSel() {
  state.selected.clear();
  let c = document.getElementById('chk-all'); if (c) c.checked = false;
  updSelBar(); renderPipeTable();
}
function updSelBar() {
  let bar = document.getElementById('sel-bar');
  let bulk = document.getElementById('bulk-panel');
  if (!bar) return;
  if (state.selected.size > 0) {
    bar.classList.add('visible');
    if (bulk) bulk.classList.add('open');
    let txt = document.getElementById('sel-bar-text');
    if (txt) txt.textContent = state.selected.size + ' selected';
  } else {
    bar.classList.remove('visible');
    if (bulk) bulk.classList.remove('open');
  }
}
function bulkMarkCalled() {
  state.selected.forEach(function(id){ let s=getS(id); if(s.status==='new') updS(id,{status:'contacted',lastContact:nowISO()}); });
  let n = state.selected.size; addFeed('Bulk marked ' + n + ' as called', '📞');
  clearSel(); save(); renderAll(); showToast(n + ' marked called', 'ok');
}
function bulkEmail() {
  if (!state.selected.size) { showToast('Nothing selected','warn'); return; }
  state.emailId = null; state.emailBulkIds = Array.from(state.selected); state.emailOpen = true;
  renderEmailModal(); document.getElementById('email-modal').classList.add('open');
}
function bulkSetFollowUp() {
  if (!state.selected.size) { showToast('Select providers first','warn'); return; }
  let days = parseInt(document.getElementById('bulk-days-val').value || '7');
  let d = new Date(); d.setDate(d.getDate() + days);
  let v = d.toISOString().slice(0,10);
  state.selected.forEach(function(id){ updS(id, {followUp:v}); });
  let n = state.selected.size;
  addFeed('Bulk set ' + n + ' follow-ups to ' + v, '📅');
  clearSel(); save(); renderAll(); showToast(n + ' follow-ups set to ' + v, 'ok');
}
function exportCSV() {
  let rows = [['Name','Specialty','City','State','Phone','Email','Status','Priority','Follow-up','Last Contact','Notes']];
  getFiltered().forEach(function(p) {
    let s = getS(p[I.ID]);
    rows.push([p[I.N],p[I.SP],p[I.CI],p[I.ST],p[I.PH],p[I.EM],s.status,s.priority||2,s.followUp||'',s.lastContact?relTime(s.lastContact):'',s.notes||'']);
  });
  let csv = rows.map(function(r){ return r.map(function(v){ return '"'+String(v||'').replace(/"/g,'""')+'"'; }).join(','); }).join('\n');
  let a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download = 'juma-pipeline-' + todayStr() + '.csv';
  a.click(); showToast('CSV exported','ok');
}

// ── RENDER ENGINE — ALL string concatenation, ZERO template literals ──
function renderAll() {
  renderCounts();
  if (state.view === 'pipeline') renderPipeTable();
  if (state.view === 'today')    renderTodayTable();
  if (state.view === 'dash')     renderDashboard();
  if (state.view === 'cc')       renderCommandCenter();
  if (state.view === 'sched')    renderSchedulerView();
  if (state.drawerOpen)          renderDrawer();
}

function setEl(id, val) { let el = document.getElementById(id); if (el) el.textContent = val; }

function renderCounts() {
  let counts = {new:0,contacted:0,warm:0,signed:0,dead:0};
  Object.values(state.pState).forEach(function(s){ counts[s.status] = (counts[s.status]||0) + 1; });
  let today = todayStr();
  let todayCnt = state.pipeline.filter(function(p){ let s=getS(p[I.ID]); return s.followUp&&s.followUp<=today&&s.status!=='signed'&&s.status!=='dead'; }).length;
  let dripDue = getDripDueCount();
  let schedDue = state.scheduled.filter(function(e){ return !e.sent && new Date(e.sendAt)<=new Date(); }).length;
  setEl('cnt-pipeline', state.pipeline.length.toLocaleString());
  setEl('cnt-new',       (counts.new||0).toLocaleString());
  setEl('cnt-contacted', (counts.contacted||0).toLocaleString());
  setEl('cnt-warm',      (counts.warm||0).toLocaleString());
  setEl('cnt-signed',    (counts.signed||0).toLocaleString());
  setEl('cnt-dead',      (counts.dead||0).toLocaleString());
  setEl('cnt-today',     todayCnt||'');
  setEl('cnt-drip',      dripDue > 0 ? dripDue : '');
  setEl('stat-total',    state.pipeline.length.toLocaleString());
  setEl('stat-signed',   (counts.signed||0).toLocaleString());
  let sn = document.getElementById('nav-today'); if (sn) sn.classList.toggle('alert', todayCnt>0);
  let sd = document.getElementById('nav-drip');  if (sd) sd.classList.toggle('alert', dripDue>0);
  // Sched badge
  let sb = document.getElementById('sched-nav-badge');
  if (sb) { sb.textContent = schedDue; sb.style.display = schedDue ? 'inline' : 'none'; }
}

function emptyHTML(icon, title, text) {
  return '<tr><td colspan="12"><div class="empty-state" style="height:200px"><div class="empty-icon">' + icon + '</div><div class="empty-title">' + esc(title) + '</div><div class="empty-text">' + esc(text) + '</div></div></td></tr>';
}

function renderPipeTable() {
  // Empty state — show onboarding prompt
  if (!state.pipeline.length) {
    let tbody = document.getElementById('main-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="12"><div class="empty-state" style="height:300px"><div class="empty-icon">📭</div><div class="empty-title">No providers yet</div><div class="empty-text">Sync from Airtable, search the 52k provider database below, or add manually.</div><div style="display:flex;gap:8px;justify-content:center;margin-top:16px"><button class="btn btn-primary" onclick="syncAirtable()" style="font-size:12px;padding:10px 20px">🔄 Sync Airtable</button><button class="btn" onclick="setTab(\'find\')" style="font-size:12px;padding:10px 20px">🔍 Search Database</button><button class="btn" onclick="addManual()" style="font-size:12px;padding:10px 20px">✏️ Add Manually</button></div></div></td></tr>';
    renderPag(0);
    let pgInfo = document.getElementById('pag-info'); if (pgInfo) pgInfo.textContent = '0 providers';
    return;
  }
  let rows = sortRows(getFiltered());
  let total = rows.length, start = state.page * PER_PAGE, end = Math.min(start+PER_PAGE, total);
  let page  = rows.slice(start, end);
  let today = todayStr();
  let pgInfo = document.getElementById('pag-info'); if (pgInfo) pgInfo.textContent = total.toLocaleString() + ' providers · showing ' + (start+1) + '–' + end;
  renderPag(total);
  let tbody = document.getElementById('main-tbody'); if (!tbody) return;
  if (!page.length) { tbody.innerHTML = emptyHTML('🔍','No providers match','Try clearing filters.'); return; }
  let html = '';
  for (let i = 0; i < page.length; i++) {
    let p  = page[i], id = p[I.ID], s = getS(id);
    let vm = (typeof VERTS !== 'undefined' && VERTS[p[I.V]]) ? VERTS[p[I.V]] : {ico:'•'};
    let fu = s.followUp||'', isOD = fu&&fu<today, isTD = fu===today;
    let di = getDripInfo(id), hasDripDue = di&&di.due.length>0;
    let pr = +(s.priority||p[I.PR]||2);
    let schedCount = state.scheduled.filter(function(e){ return e.providerId===id && !e.sent; }).length;
    let rowCls = (state.selected.has(id) ? ' selected' : '') + (isOD ? ' overdue' : '');
    let fuHtml = '—';
    if (fu) { fuHtml = '<span class="fu-chip' + (isOD?' overdue':isTD?' today':'') + '">' + (isOD?'⚠ ':isTD?'→ ':'') + esc(fu) + '</span>'; }
    if (di&&!di.allSent) { fuHtml += ' <span class="drip-chip">' + (hasDripDue?'⚠ ':'') + '📧</span>'; }
    if (schedCount)       { fuHtml += ' <span class="drip-chip" style="background:rgba(91,156,246,.12);color:var(--blue);border-color:var(--bbd)">📅' + schedCount + '</span>'; }
    html += '<tr id="row-' + esc(id) + '" class="' + rowCls + '">';
    html += '<td data-stop="1"><input type="checkbox"' + (state.selected.has(id)?' checked':'') + ' data-select="' + esc(id) + '" style="accent-color:var(--lime)"></td>';
    html += '<td data-open="' + esc(id) + '"><div class="td-primary">' + esc(p[I.N]) + '</div><div class="td-secondary">' + esc(vm.ico||'') + ' ' + esc(p[I.TX]||p[I.SP]) + '</div></td>';
    html += '<td data-open="' + esc(id) + '">' + esc(p[I.SP]) + '</td>';
    html += '<td data-open="' + esc(id) + '">' + esc(p[I.CI]) + '</td>';
    html += '<td data-open="' + esc(id) + '" style="color:var(--t3)">' + esc(p[I.ST]) + '</td>';
    html += '<td data-open="' + esc(id) + '"><div class="td-mono">' + esc(p[I.PH]||'—') + '</div></td>';
    html += '<td data-open="' + esc(id) + '"><div class="td-email">' + esc(p[I.EM]||'—') + '</div></td>';
    html += '<td data-stop="1"><span class="badge badge-' + s.status + '" data-cycle="' + esc(id) + '">' + esc(STATUS_LABELS[s.status]) + '</span></td>';
    html += '<td data-open="' + esc(id) + '"><span class="stars">' + '★'.repeat(pr) + '☆'.repeat(3-pr) + '</span></td>';
    html += '<td data-open="' + esc(id) + '">' + fuHtml + '</td>';
    html += '<td data-open="' + esc(id) + '" class="td-mono" style="font-size:10.5px;color:var(--t3)">' + relTime(s.lastContact) + '</td>';
    html += '<td data-stop="1"><div class="row-actions">';
    html += '<button class="action-btn action-email" data-email="' + esc(id) + '">✦ Email</button>';
    html += '<button class="action-btn action-sched" data-sched="' + esc(id) + '">📅</button>';
    html += '<button class="action-btn action-call"  data-call="'  + esc(id) + '">📞</button>';
    html += '<button class="action-btn action-brief" data-brief="' + esc(id) + '">📋</button>';
    html += '<button class="action-btn action-delete" data-del="' + esc(id) + '">✕</button>';
    html += '</div></td></tr>';
  }
  tbody.innerHTML = html;
}

function renderTodayTable() {
  let today = todayStr();
  let due = state.pipeline.filter(function(p){ let s=getS(p[I.ID]); return s.followUp&&s.followUp<=today&&s.status!=='signed'&&s.status!=='dead'; })
    .sort(function(a,b){ return (getS(a[I.ID]).followUp||'').localeCompare(getS(b[I.ID]).followUp||''); });
  renderCounts();
  let tbody = document.getElementById('today-tbody'); if (!tbody) return;
  if (!due.length) { tbody.innerHTML = emptyHTML('✅','All caught up','No follow-ups due. Set follow-up dates to see them here.'); return; }
  let html = '';
  for (let i = 0; i < due.length; i++) {
    let p = due[i], id = p[I.ID], s = getS(id);
    let fu = s.followUp||'', isOD = fu<today;
    html += '<tr data-open="' + esc(id) + '" class="' + (isOD?'overdue':'') + '">';
    html += '<td><div class="td-primary">' + esc(p[I.N]) + '</div><div class="td-secondary">' + esc(p[I.SP]) + '</div></td>';
    html += '<td>' + esc(p[I.SP]) + '</td>';
    html += '<td>' + esc(p[I.CI]) + ', ' + esc(p[I.ST]) + '</td>';
    html += '<td><div class="td-mono">' + esc(p[I.PH]||'—') + '</div></td>';
    html += '<td data-stop="1"><span class="badge badge-' + s.status + '" data-cycle="' + esc(id) + '">' + esc(STATUS_LABELS[s.status]) + '</span></td>';
    html += '<td><span class="fu-chip ' + (isOD?'overdue':'today') + '">' + (isOD?'⚠ OVERDUE':'→ TODAY') + ': ' + esc(fu) + '</span></td>';
    html += '<td data-stop="1"><div class="row-actions" style="opacity:1">';
    html += '<button class="action-btn action-email" data-email="' + esc(id) + '">✦ Email</button>';
    html += '<button class="action-btn action-sched" data-sched="' + esc(id) + '">📅</button>';
    html += '<button class="action-btn action-call"  data-call="'  + esc(id) + '">📞</button>';
    html += '<button class="action-btn action-brief" data-brief="' + esc(id) + '">📋</button>';
    html += '</div></td></tr>';
  }
  tbody.innerHTML = html;
}

function renderFindTable() {
  let results = getFindResults();
  let infoEl = document.getElementById('find-info'); if (infoEl) infoEl.textContent = results.length.toLocaleString() + ' providers';
  let tbody = document.getElementById('find-tbody'); if (!tbody) return;
  if (!results.length) { tbody.innerHTML = emptyHTML('🔍','52,935 providers available','Filter by vertical, state, or city to search.'); return; }
  let html = '';
  for (let i = 0; i < results.length; i++) {
    let p = results[i], id = p[I.ID];
    let vm = (typeof VERTS !== 'undefined' && VERTS[p[I.V]]) ? VERTS[p[I.V]] : {ico:'•'};
    html += '<tr>';
    html += '<td><div class="td-primary">' + esc(p[I.N]) + '</div><div class="td-secondary">' + esc(vm.ico||'') + ' ' + esc(p[I.TX]||p[I.SP]) + '</div></td>';
    html += '<td>' + esc(p[I.SP]) + '</td>';
    html += '<td>' + esc(p[I.CI]) + ', ' + esc(p[I.ST]) + '</td>';
    html += '<td><div class="td-mono">' + esc(p[I.PH]||'—') + '</div></td>';
    html += '<td><div class="td-email">' + esc(p[I.EM]||'—') + '</div></td>';
    html += '<td data-stop="1" style="text-align:right"><div style="display:flex;gap:5px;justify-content:flex-end">';
    html += '<button class="action-btn action-email" data-quick-email="' + esc(id) + '">✦ Email</button>';
    html += '<button class="action-btn" style="background:var(--lbg);color:var(--lime);border:1px solid var(--lbd)" data-add-pipeline="' + esc(id) + '">+ Add</button>';
    html += '</div></td></tr>';
  }
  tbody.innerHTML = html;
}

function renderPag(total) {
  let pages = Math.ceil(total/PER_PAGE);
  let prev = document.getElementById('pag-prev'), next = document.getElementById('pag-next');
  if (prev) prev.disabled = (state.page===0);
  if (next) next.disabled = (state.page>=pages-1);
  let nums = document.getElementById('pag-nums'); if (!nums) return;
  if (pages<=1) { nums.innerHTML=''; return; }
  let range = [], html = '';
  for (let i=0;i<pages;i++) { if(i===0||i===pages-1||Math.abs(i-state.page)<=2) range.push(i); else if(range[range.length-1]!=='...') range.push('...'); }
  for (let j=0;j<range.length;j++) {
    if (range[j]==='...') html += '<span class="pag-ellipsis">…</span>';
    else html += '<button class="pag-btn' + (range[j]===state.page?' active':'') + '" data-page="' + range[j] + '">' + (range[j]+1) + '</button>';
  }
  nums.innerHTML = html;
}

// ── DRAWER ────────────────────────────────────────────────────
function openDrawer(id) {
  state.drawerOpen = true; state.drawerId = id;
  renderDrawer();
  document.getElementById('drawer').classList.add('open');
}
function closeDrawer() {
  state.drawerOpen = false; state.drawerId = null;
  document.getElementById('drawer').classList.remove('open');
}

function renderDrawer() {
  let id = state.drawerId; if (!id) return;
  let p  = findProv(id);  if (!p) return;
  let s  = getS(id);
  let vm = (typeof VERTS !== 'undefined' && VERTS[p[I.V]]) ? VERTS[p[I.V]] : {ico:'•', name:p[I.SP]};
  let pr = +(s.priority||p[I.PR]||2);
  let di = getDripInfo(id);
  let today = todayStr();

  document.getElementById('drawer-name').textContent = p[I.N];
  document.getElementById('drawer-spec').textContent = (vm.ico ? vm.ico+' ' : '') + p[I.SP];

  // Activity
  let actHtml = '<div style="color:var(--t3);font-size:11px;padding:4px 0">No activity yet.</div>';
  if (s.activity && s.activity.length) {
    let icons = {call:'📞',email:'✉',status:'🔄',note:'📝',drip:'📧',scheduled:'📅',sms:'📱',linkedin:'🔗'};
    actHtml = '';
    for (let ai=0; ai<Math.min(s.activity.length,15); ai++) {
      let a = s.activity[ai];
      actHtml += '<div class="activity-item"><span class="activity-icon">' + (icons[a.type]||'•') + '</span><span class="activity-text">' + esc(a.text) + '</span><span class="activity-time">' + relTime(a.time) + '</span></div>';
    }
  }

  // Drip section
  let dripSec = '';
  if (!di) {
    dripSec = '<div style="font-size:11.5px;color:var(--t3);margin-bottom:8px">No drip active. Email this provider to auto-start a 3-email sequence.</div>';
  } else if (di.allSent) {
    dripSec = '<div style="font-size:11.5px;color:var(--sage);margin-bottom:8px">✅ Sequence complete — all 3 follow-ups sent.</div>';
  } else {
    dripSec = '<div class="drip-tracker">';
    for (let di2=0; di2<di.steps.length; di2++) {
      let step = di.steps[di2];
      let dotCls = step.sent ? 'sent' : (step.isDue ? 'due' : '');
      let dotIcon = step.sent ? '✓' : (step.isDue ? '!' : '○');
      let dateColor = step.sent ? 'var(--sage)' : (step.isDue ? 'var(--amber)' : 'var(--t3)');
      let dateLabel = step.sent ? 'Sent' : (step.isDue ? 'DUE' : esc(step.date));
      dripSec += '<div class="drip-step"><span class="drip-dot ' + dotCls + '">' + dotIcon + '</span><span class="drip-step-label">' + esc(step.label) + '</span><span class="drip-step-date" style="color:' + dateColor + '">' + dateLabel + '</span>';
      if (step.isDue && !step.sent) { dripSec += '<button class="drip-send-btn" data-drip-send="' + esc(id) + '" data-drip-idx="' + step.idx + '">Send</button>'; }
      dripSec += '</div>';
    }
    dripSec += '</div>';
    if (di.active) { dripSec += '<button class="drawer-btn dbtn-ghost" data-pause-drip="' + esc(id) + '" style="font-size:9.5px;padding:5px 11px">Pause Drip</button>'; }
    else           { dripSec += '<button class="drawer-btn dbtn-lime"  data-resume-drip="' + esc(id) + '" style="font-size:9.5px;padding:5px 11px">Resume Drip</button>'; }
  }

  // Email thread preview
  let emails = (s.emails || []).slice(0, 5);
  let emailThread = '';
  let schedForThis = state.scheduled.filter(function(e){ return e.providerId===id && !e.sent; });
  if (schedForThis.length) {
    emailThread += '<div style="margin-bottom:6px">';
    for (let si=0; si<Math.min(schedForThis.length,3); si++) {
      let sc = schedForThis[si];
      emailThread += '<div style="padding:7px 9px;background:var(--bbg);border:1px solid var(--bbd);border-radius:4px;margin-bottom:4px;font-size:10.5px">';
      emailThread += '<div style="color:var(--blue);font-size:9px;margin-bottom:2px">📅 Scheduled: ' + esc(fmtDateTime(sc.sendAt)) + '</div>';
      emailThread += '<div style="font-weight:600;color:var(--t1)">' + esc(sc.subject) + '</div>';
      emailThread += '<div style="color:var(--t3);margin-top:2px">' + esc(sc.body.slice(0,80)) + '…</div>';
      emailThread += '</div>';
    }
    emailThread += '</div>';
  }
  if (emails.length) {
    for (let ei=0; ei<emails.length; ei++) {
      let em = emails[ei];
      emailThread += '<div style="padding:7px 9px;background:var(--bg4);border:1px solid var(--b1);border-radius:4px;margin-bottom:4px;font-size:10.5px">';
      emailThread += '<div style="color:var(--t3);font-size:9px;margin-bottom:2px">✉ Sent: ' + esc(fmtDateTime(em.time)) + '</div>';
      emailThread += '<div style="font-weight:600;color:var(--t1)">' + esc(em.subject) + '</div>';
      emailThread += '<div style="color:var(--t3);margin-top:2px">' + esc((em.body||'').slice(0,80)) + '…</div>';
      emailThread += '</div>';
    }
  }
  if (!emailThread) emailThread = '<div style="color:var(--t3);font-size:11px;padding:4px 0">No emails sent yet.</div>';

  // Status/priority selects
  let statusOpts = '';
  for (let si2=0; si2<STATUS_CYCLE.length; si2++) {
    statusOpts += '<option value="' + STATUS_CYCLE[si2] + '"' + (s.status===STATUS_CYCLE[si2]?' selected':'') + '>' + esc(STATUS_LABELS[STATUS_CYCLE[si2]]) + '</option>';
  }
  let prOpts = '<option value="1"' + (pr===1?' selected':'') + '>☆ Low</option>' +
               '<option value="2"' + (pr===2?' selected':'') + '>★ Medium</option>' +
               '<option value="3"' + (pr===3?' selected':'') + '>★★ High</option>';

  // Quick date buttons
  let quickDates = [{l:'Today',d:0},{l:'Tomorrow',d:1},{l:'3 days',d:3},{l:'1 week',d:7},{l:'2 weeks',d:14}];
  let qdHtml = '';
  for (let qi=0; qi<quickDates.length; qi++) {
    qdHtml += '<button class="quick-date-btn" data-quick-date="' + esc(id) + '" data-days="' + quickDates[qi].d + '">' + quickDates[qi].l + '</button>';
  }

  let phoneHtml = p[I.PH] ? '<a href="tel:' + esc(p[I.PH]) + '">' + esc(p[I.PH]) + '</a>' : 'Not listed';
  let emailHtml = p[I.EM] ? '<a href="mailto:' + esc(p[I.EM]) + '" style="color:var(--blue)">' + esc(p[I.EM]) + '</a>' : 'Not listed';
  let locParts  = [p[I.AD], p[I.CI], p[I.ST]].filter(Boolean);
  let locHtml   = locParts.length ? esc(locParts.join(', ')) : '—';
  let callBtnHtml = p[I.PH] ? '<a href="tel:' + esc(p[I.PH]) + '" style="flex:1;text-decoration:none"><button class="drawer-btn dbtn-blue" style="width:100%">📱 Tap to Call</button></a>' : '';

  let html = '';
  html += '<div class="drawer-section">';
  html += '<div class="drawer-section-title">Contact Info</div>';
  html += '<div class="field"><div class="field-label">Phone</div><div class="field-value mono">' + phoneHtml + '</div></div>';
  html += '<div class="field"><div class="field-label">Email</div><div class="field-value email-link">' + emailHtml + '</div></div>';
  html += '<div class="field"><div class="field-label">Location</div><div class="field-value">' + locHtml + '</div></div>';
  if (p[I.CO]) html += '<div class="field"><div class="field-label">County</div><div class="field-value">' + esc(p[I.CO]) + '</div></div>';
  if (p[I.NP]) html += '<div class="field"><div class="field-label">NPI</div><div class="field-value mono">' + esc(p[I.NP]) + '</div></div>';
  html += '</div>';

  html += '<div class="drawer-section">';
  html += '<div class="drawer-section-title">Outreach</div>';
  html += '<div class="outreach-grid">';
  html += '<button class="outreach-btn ob-email" data-email="' + esc(id) + '">✦ Email</button>';
  html += '<button class="outreach-btn ob-sched" data-sched="' + esc(id) + '">📅 Schedule</button>';
  html += (p[I.PH] ? '<a href="tel:' + esc(p[I.PH]) + '" style="text-decoration:none"><button class="outreach-btn ob-call">📞 Call</button></a>' : '<button class="outreach-btn ob-call" disabled style="opacity:.35">📞 No Phone</button>');
  html += '<button class="outreach-btn ob-brief" data-brief="' + esc(id) + '">📋 Call Brief</button>';
  html += (p[I.PH] ? '<button class="outreach-btn ob-sms" onclick="openSMS(\'' + id + '\')">📱 SMS</button>' : '<button class="outreach-btn ob-sms" disabled style="opacity:.35">📱 No Phone</button>');
  html += '<button class="outreach-btn ob-li" onclick="copyLinkedInDM(\'' + id + '\')">🔗 LinkedIn DM</button>';
  html += '</div>';
  // AI Drip full-width button
  let dripS = getS(id);
  if (dripS.dripStarted && dripS.dripStatus === 'active') {
    let dripInfo = getDripInfo(id);
    let allDone = dripInfo && dripInfo.allSent;
    html += '<button class="outreach-btn" style="width:100%;margin-top:5px;background:rgba(138,184,122,.1);border:1px solid rgba(138,184,122,.28);color:var(--sage)" onclick="openDripDashboard()">' + (allDone ? '✓ Drip Complete — View' : '📧 Drip Running — View Progress') + '</button>';
  } else {
    html += '<button class="outreach-btn" style="width:100%;margin-top:5px;background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.28);color:#a78bfa" onclick="startAutoDrip(\'' + esc(id) + '\')">🤖 Start AI Drip (3 Auto-Emails)</button>';
  }
  html += '<div class="drawer-btn-row" style="margin-top:6px">';
  html += '<button class="drawer-btn dbtn-amber" data-cycle="' + esc(id) + '">→ Advance Stage</button>';
  html += callBtnHtml;
  html += '</div></div>';

  html += '<div class="drawer-section">';
  html += '<div class="drawer-section-title">Pipeline Status</div>';
  html += '<select class="drawer-select" data-set-status="' + esc(id) + '">' + statusOpts + '</select>';
  html += '<select class="drawer-select" data-set-priority="' + esc(id) + '">' + prOpts + '</select>';
  html += '</div>';

  html += '<div class="drawer-section">';
  html += '<div class="drawer-section-title">Follow-up Date</div>';
  html += '<input type="date" class="date-input" id="fu-date-' + esc(id) + '" value="' + esc(s.followUp||'') + '" data-set-followup="' + esc(id) + '">';
  html += '<div class="quick-dates">' + qdHtml + '</div>';
  html += '</div>';

  html += '<div class="drawer-section">';
  html += '<div class="drawer-section-title">Email Chain</div>';
  html += emailThread;
  html += '<button class="drawer-btn dbtn-blue" data-sched="' + esc(id) + '" style="margin-top:8px;width:100%">📅 Schedule Next Email</button>';
  html += '</div>';

  html += '<div class="drawer-section">';
  html += '<div class="drawer-section-title">Email Drip</div>';
  html += dripSec;
  html += '</div>';

  html += '<div class="drawer-section">';
  html += '<div class="drawer-section-title">Notes</div>';
  html += '<textarea class="notes-input" id="notes-' + esc(id) + '" placeholder="Add notes…">' + esc(s.notes||'') + '</textarea>';
  html += '<button class="drawer-btn dbtn-ghost" data-save-notes="' + esc(id) + '" style="margin-top:5px;width:100%">Save Notes</button>';
  html += '</div>';

  html += '<div class="drawer-section">';
  html += '<div class="drawer-section-title">Activity (' + (s.activity||[]).length + ')</div>';
  html += '<div class="activity-log">' + actHtml + '</div>';
  html += '</div>';

  html += '<div class="drawer-section">';
  html += '<div class="drawer-btn-row"><button class="drawer-btn dbtn-ghost" data-del="' + esc(id) + '">Remove from Pipeline</button></div>';
  html += '</div>';

  document.getElementById('drawer-body').innerHTML = html;
}

// ── EMAIL MODAL ───────────────────────────────────────────────
function openEmailModal(id) {
  state.emailId = id; state.emailBulkIds = []; state.emailOpen = true;
  renderEmailModal(); document.getElementById('email-modal').classList.add('open');
}
function closeEmailModal() {
  let id = state.emailId;
  if (id) {
    let s = getS(id);
    updS(id, {lastContact:nowISO(), status: s.status==='new'?'contacted':s.status});
    logAct(id, {type:'email', text:'Email sent', time:nowISO()});
    addFeed('Emailed ' + nameOf(id), '✉');
    let di = getDripInfo(id); if (!di) startDrip(id);
    save(); renderAll();
    if (state.drawerId===id) renderDrawer();
  }
  state.emailOpen=false; state.emailId=null; state.emailBulkIds=[];
  document.getElementById('email-modal').classList.remove('open');
}
function renderEmailModal() {
  let id = state.emailId;
  let isBulk = !id && state.emailBulkIds.length > 0;
  let p  = id ? findProv(id) : null;
  let nameStr = isBulk ? (state.emailBulkIds.length + ' providers') : (p ? p[I.N] : '');
  let sp   = (p && !isBulk) ? (p[I.SP]||'') : '';
  let emailStr = isBulk
    ? state.emailBulkIds.slice(0,5).map(function(bid){ let bp=findProv(bid); return bp?bp[I.EM]||'':''; }).filter(Boolean).join(', ') + (state.emailBulkIds.length>5?' +more':'')
    : (p ? p[I.EM]||'(no email)' : '');

  let toSub  = document.getElementById('em-to-sub');
  let toVal  = document.getElementById('em-to-val');
  let subjEl = document.getElementById('em-subject');
  let bodyEl = document.getElementById('em-body');
  if (toSub)  toSub.textContent  = nameStr + (p&&p[I.CI] ? ' · ' + p[I.CI]+', '+p[I.ST] : '');
  if (toVal)  toVal.textContent  = emailStr;
  if (subjEl) subjEl.value       = 'JŪMA Provider Partnership — Pre-Funded Cash-Pay Patients';
  if (bodyEl) bodyEl.value       = TEMPLATES.intro(isBulk ? '[Provider Name]' : nameStr, sp);
  document.querySelectorAll('.tmpl-chip').forEach(function(c){ c.classList.remove('active'); });
  let first = document.querySelector('.tmpl-chip'); if (first) first.classList.add('active');
  let aiBtn  = document.getElementById('ai-gen-btn');
  let aiSpin = document.getElementById('ai-spin');
  if (aiBtn)  { aiBtn.disabled=false; aiBtn.style.display='flex'; }
  if (aiSpin) aiSpin.style.display='none';
}

function switchTemplate(key, btn) {
  document.querySelectorAll('.tmpl-chip').forEach(function(c){ c.classList.remove('active'); });
  btn.classList.add('active');
  let id = state.emailId;
  let p  = id ? findProv(id) : null;
  let name = id ? (p ? p[I.N] : '') : '[Provider Name]';
  let sp   = id ? (p ? p[I.SP]||'' : '') : '';
  let bodyEl = document.getElementById('em-body');
  if (bodyEl && TEMPLATES[key]) bodyEl.value = TEMPLATES[key](name, sp);
}

async function generateAIEmail() {
  const id = state.emailId;
  const p  = id ? findProv(id) : null;
  const name = p ? p[I.N] : '[Provider Name]';
  const sp   = p ? p[I.SP] || 'healthcare' : 'healthcare';
  const city = p ? p[I.CI] + ', ' + p[I.ST] : '';
  const ctx  = (document.getElementById('ai-context') || {}).value || '';
  const btn  = document.getElementById('ai-gen-btn');
  const spin = document.getElementById('ai-spin');
  const bodyEl = document.getElementById('em-body');
  if (btn)  { btn.disabled = true; btn.style.display = 'none'; }
  if (spin) spin.style.display = 'flex';
  try {
    const data = await callAI({
      maxTokens: 800,
      messages: [{ role: 'user', content:
        'Write a provider outreach email from Dr. Parth Kansagra, founder of JUMA (prepaid healthcare wallet). Direct, confident, dentist-to-doctor tone, zero fluff.\n\nProvider: ' + name + '\nSpecialty: ' + sp + '\nCity: ' + city + '\nContext: ' + (ctx || 'Tailor to specialty-specific insurance billing pain.') + '\n\nEmail must: open with their specific insurance billing pain, explain JUMA in 2 sentences (members pre-load wallet, pay providers full rate instantly, JUMA takes small %), ask for 15-min call, sign "Dr. Parth Kansagra, DMD MBS MBA — Founder, JUMA". Under 160 words.'
      }],
    });
    const txt = extractText(data);
    if (bodyEl && txt) { bodyEl.value = txt; showToast('AI email ready', 'ok'); }
    else showToast('AI failed — try again', 'warn');
  } catch (err) { showToast('AI error: ' + err.message, 'error'); }
  finally {
    if (btn)  { btn.disabled = false; btn.style.display = 'flex'; }
    if (spin) spin.style.display = 'none';
  }
}
// _REPLACED_MARKER_
function getEmailParts() {
  let to = '';
  if (state.emailBulkIds.length) {
    to = state.emailBulkIds.map(function(bid){ let pp=findProv(bid); return pp?pp[I.EM]||'':''; }).filter(Boolean).join(',');
  } else if (state.emailId) {
    let pp2 = findProv(state.emailId); to = pp2 ? pp2[I.EM]||'' : '';
  }
  let subj = document.getElementById('em-subject') ? document.getElementById('em-subject').value||'' : '';
  let body = document.getElementById('em-body')    ? document.getElementById('em-body').value||'' : '';
  return {to:to, subj:subj, body:body};
}

function sendGmail() {
  let ep=getEmailParts();
  let id = state.emailId;
  if (id) recordEmailSent(id, ep.subj, ep.body);
  sendViaGmail(ep.to, ep.subj, ep.body);
  closeEmailModal();
}
function sendOutlook() {
  let ep=getEmailParts();
  let id = state.emailId;
  if (id) recordEmailSent(id, ep.subj, ep.body);
  sendViaOutlook(ep.to, ep.subj, ep.body);
  closeEmailModal();
}
function sendMailto() {
  let ep=getEmailParts();
  window.location.href='mailto:'+ep.to+'?subject='+encodeURIComponent(ep.subj)+'&body='+encodeURIComponent(ep.body);
  closeEmailModal();
}
function copyEmail() { let ep=getEmailParts(); navigator.clipboard && navigator.clipboard.writeText('Subject: '+ep.subj+'\n\n'+ep.body).catch(function(){}); showToast('Copied','ok'); }

// ── CALL BRIEF ────────────────────────────────────────────────
async function openCallBrief(id) {
  if (!id) { showToast('Open a provider first','warn'); return; }
  state.briefOpen = true; state.briefId = id; state.briefContent = null;
  state.callBriefId = id;
  document.getElementById('call-brief-modal').classList.add('open');
  renderCallBrief();
  await generateCallBrief(id);
}

async function generateCallBrief(id) {
  let p = findProv(id); if (!p) return;
  let s = getS(id);
  let name    = p[I.N]  || 'Doctor';
  let sp      = p[I.SP] || 'healthcare';
  let city    = p[I.CI] || '';
  let provSt  = p[I.ST] || '';
  let phone   = p[I.PH] || '';
  let email   = p[I.EM] || '';
  let address = p[I.AD] || '';
  let notes   = s.notes || '';
  let history = (s.emails || []).slice(0,3).map(function(e){ return 'Email sent: ' + e.subject; }).join('; ');
  let status  = s.status || 'new';
  let dripStarted = s.dripStarted ? 'Yes - drip emails sent' : 'No emails sent yet';

  // Build research context from what we know
  let knownInfo = 'Provider: ' + name +
    '\nSpecialty: ' + sp +
    '\nLocation: ' + city + (provSt ? ', ' + provSt : '') +
    (address ? '\nAddress: ' + address : '') +
    (phone ? '\nPhone: ' + phone : '') +
    (email ? '\nEmail: ' + email : '') +
    '\nPipeline status: ' + status +
    '\nEmails sent: ' + dripStarted +
    (history ? '\nEmail history: ' + history : '') +
    (notes ? '\n\nNotes from Parth: ' + notes : '\n\nNo personal notes yet.');

  let prompt = 'You are a sales coach preparing Dr. Parth Kansagra (dentist, DMD MBS MBA, founder of JUMA) for a cold call to this provider.' +
    '\n\n' + knownInfo +
    '\n\nJUMA overview: Prepaid healthcare wallet. Members pre-load credits like a Starbucks card for healthcare. They spend at participating providers. Provider gets paid 100% of their rate instantly. Zero insurance, zero billing overhead, zero prior auth. JUMA takes a small transaction fee only on spend. Free to join, no contract, no monthly fee.' +
    '\n\nParths call goal: Book a 15-minute discovery call or get them to say yes to receiving the provider deck.' +
    '\n\nUsing everything you know about ' + sp + ' practices, insurance pain points in this specialty, and the notes above, generate a highly specific call script.' +
    '\n\nRespond ONLY in valid JSON with no markdown, no backticks, exactly this structure:' +
    '\n{' +
    '\n  "research": "2-3 sentences of what Parth should know about this specific type of practice and their typical insurance pain points",' +
    '\n  "opening": "exact word-for-word opening line - natural, peer to peer, not salesy",' +
    '\n  "permission": "one sentence asking for 30 seconds to explain why he is calling",' +
    '\n  "hook": "the single biggest insurance pain point for this specialty - be specific",' +
    '\n  "pitch": ["point 1 - specific benefit", "point 2 - the math", "point 3 - social proof or scarcity"],' +
    '\n  "objections": [' +
    '\n    {"q": "most likely objection from this specialty", "a": "exact response"},' +
    '\n    {"q": "second objection", "a": "exact response"},' +
    '\n    {"q": "third objection", "a": "exact response"}' +
    '\n  ],' +
    '\n  "close": "exact words to book the 15-min call - give two time options",' +
    '\n  "voicemail": "exact 20-second voicemail if they dont pick up - include callback number placeholder",' +
    '\n  "notes_response": "' + (notes ? 'How to use the specific notes above in the call' : 'No notes yet - add notes in the drawer to get personalized talking points') + '"' +
    '\n}';

  state.briefContent = null;
  renderCallBrief();

  try {
    let resp = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1800,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: 'First, search the web for "' + name + ' ' + sp + ' ' + city + '" to find their practice website, reviews, or any public info. Then use what you find plus this prompt to generate the call brief.\n\n' + prompt
        }]
      })
    });
    let data = await resp.json();
    // Extract text from response - may have tool_use blocks
    let txt = '';
    let webFindings = '';
    if (data.content) {
      data.content.forEach(function(block) {
        if (block.type === 'text') txt += block.text;
        if (block.type === 'tool_result') webFindings += JSON.stringify(block.content || '');
      });
    }
    // Clean JSON from response
    let jsonMatch = txt.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        state.briefContent = JSON.parse(jsonMatch[0]);
        if (webFindings) state.briefContent.webFindings = webFindings.slice(0, 200);
      } catch(e) {
        state.briefContent = { error: 'Could not parse response. Raw: ' + txt.slice(0, 200) };
      }
    } else {
      state.briefContent = { error: 'No JSON in response: ' + txt.slice(0, 300) };
    }
  } catch(e) {
    state.briefContent = { error: e.message };
  }
  renderCallBrief();
}
function openPostCallEmail(id) {
  if (!id) return;
  closeCallBrief();
  // Pre-populate email with post-call context
  let s = getS(id);
  let notes = s.callNotes || s.notes || '';
  state.emailId = id;
  state.emailBulkIds = [];
  openEmailModal(id);
  // After modal opens, pre-fill subject and trigger AI with call context
  setTimeout(function() {
    let subjEl = document.getElementById('em-subject');
    if (subjEl) subjEl.value = 'Following up from our call — JUMA Provider Partnership';
    let ctxEl = document.getElementById('ai-context');
    if (ctxEl) ctxEl.value = 'Just got off a call with them. ' + (notes ? 'Call notes: ' + notes : 'Follow up on the JUMA partnership discussion.');
    // Auto-trigger AI generation
    generateAIEmail();
  }, 300);
}

function closeCallBrief() {
  state.briefOpen=false; state.briefId=null; state.briefContent=null;
  document.getElementById('call-brief-modal').classList.remove('open');
}
function renderCallBrief() {
  let id = state.briefId;
  let p  = id ? findProv(id) : null;
  let s  = id ? getS(id) : {};
  let brief = state.briefContent;
  let nameEl  = document.getElementById('brief-provider-name');
  let bodyEl  = document.getElementById('brief-body');
  let callBtn = document.getElementById('brief-call-btn');
  if (nameEl && p) nameEl.textContent = p[I.N] + ' · ' + p[I.SP] + ' · ' + p[I.CI] + ', ' + p[I.ST];
  if (callBtn) { callBtn.href = p&&p[I.PH] ? 'tel:'+p[I.PH] : '#'; callBtn.textContent = p&&p[I.PH] ? '📱 '+p[I.PH] : 'No phone'; }
  if (!bodyEl) return;
  if (!brief) {
    bodyEl.innerHTML = '<div class="brief-loading"><span class="spinner"></span>' +
      '<div style="margin-top:12px">' +
      '<div style="color:var(--lime);font-weight:700;font-size:13px;margin-bottom:6px">Researching ' + esc(p ? p[I.N] : 'provider') + '…</div>' +
      '<div style="color:var(--t3);font-size:11px;line-height:1.6">Searching the web for their practice info,<br>then building your personalized call script.</div>' +
      '</div></div>';
    return;
  }
  if (brief.error) { bodyEl.innerHTML = '<div style="color:var(--rose);padding:20px;font-size:12px">Could not generate brief: ' + esc(brief.error) + '<br><br><button onclick="generateCallBrief(state.briefId);" style="padding:8px 16px;background:var(--lbg);border:1px solid var(--lbd);border-radius:4px;color:var(--lime);cursor:pointer;font-size:11px">Try Again</button></div>'; return; }
  let html = '';
  // Notes context banner
  if (s.notes) {
    html += '<div style="background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.28);border-radius:5px;padding:10px 14px;margin-bottom:12px;font-size:11px;color:#a78bfa">';
    html += '<span style="font-weight:700;letter-spacing:1px;font-size:9px;text-transform:uppercase">Using your notes: </span>' + esc(s.notes.slice(0,120)) + (s.notes.length>120?'…':'');
    html += '</div>';
  } else {
    html += '<div style="background:var(--bg3);border:1px solid var(--b1);border-radius:5px;padding:10px 14px;margin-bottom:12px;font-size:11px;color:var(--t3)">';
    html += '💡 <strong style="color:var(--t2)">Add notes in the drawer</strong> to personalize this script — the more context you give, the sharper the brief gets. Hit Refresh after saving.';
    html += '</div>';
  }
  // Research findings
  if (brief.research) {
    html += '<div class="brief-section" style="background:rgba(91,156,246,.07);border-color:rgba(91,156,246,.2)">';
    html += '<span class="brief-section-label" style="color:var(--blue)">🔍 Practice Research</span>';
    html += '<div class="brief-content" style="color:var(--t1)">' + esc(brief.research) + '</div>';
    html += '</div>';
  }
  // Opening
  html += '<div class="brief-section"><span class="brief-section-label">👋 Opening Line</span>';
  html += '<div class="brief-content brief-script">' + esc(brief.opening||'') + '</div></div>';
  // Permission
  if (brief.permission) {
    html += '<div class="brief-section"><span class="brief-section-label">⏱ Ask for 30 Seconds</span>';
    html += '<div class="brief-content brief-script">' + esc(brief.permission) + '</div></div>';
  }
  // Hook
  html += '<div class="brief-section"><span class="brief-section-label">🎯 Their Pain Point</span>';
  html += '<div class="brief-content">' + esc(brief.hook||'') + '</div></div>';
  // Pitch
  html += '<div class="brief-section"><span class="brief-section-label">💡 The Pitch — 30 Seconds</span>';
  let pitch = brief.pitch || [];
  for (let pi=0; pi<pitch.length; pi++) {
    html += '<div class="brief-point"><span class="brief-point-dot">' + (pi+1) + '</span><span>' + esc(pitch[pi]) + '</span></div>';
  }
  html += '</div>';
  // Notes response
  if (brief.notes_response && s.notes) {
    html += '<div class="brief-section" style="background:rgba(139,92,246,.07);border-color:rgba(139,92,246,.2)">';
    html += '<span class="brief-section-label" style="color:#a78bfa">📝 Use Your Notes In the Call</span>';
    html += '<div class="brief-content">' + esc(brief.notes_response) + '</div>';
    html += '</div>';
  }
  // Objections
  html += '<div class="brief-section"><span class="brief-section-label">🛡 Objections &amp; Comebacks</span>';
  let objs = brief.objections || [];
  for (let oi=0; oi<objs.length; oi++) {
    html += '<div class="brief-objection">';
    html += '<div class="brief-obj-q">They say: &ldquo;' + esc(objs[oi].q||'') + '&rdquo;</div>';
    html += '<div class="brief-obj-a">You say: → ' + esc(objs[oi].a||'') + '</div>';
    html += '</div>';
  }
  html += '</div>';
  // Close
  html += '<div class="brief-section"><span class="brief-section-label">✅ The Close</span>';
  html += '<div class="brief-content brief-script">' + esc(brief.close||'') + '</div></div>';
  // Voicemail
  html += '<div class="brief-section"><span class="brief-section-label">📱 If Voicemail — 20 Seconds</span>';
  html += '<div class="brief-content brief-script" style="font-style:italic">' + esc(brief.voicemail||'') + '</div></div>';
  // Refresh button
  html += '<div style="display:flex;gap:8px;margin-bottom:12px">';
  html += '<button onclick="state.briefContent=null;renderCallBrief();generateCallBrief(state.briefId)" style="flex:1;padding:9px;background:var(--bg3);border:1px solid var(--b2);border-radius:4px;color:var(--t2);font-family:Syne,sans-serif;font-size:10px;font-weight:700;letter-spacing:1px;cursor:pointer">🔄 Refresh Script (after adding notes)</button>';
  html += '</div>';
  // Live call notes
  let s2 = getS(id);
  html += '<div class="call-notes-box"><div class="call-notes-title">📝 Live Call Notes — auto-saved</div><textarea class="call-notes-ta" id="live-call-notes-' + esc(id) + '" placeholder="Type here while on the call. Auto-saves every second.">' + esc(s.notes||'') + '</textarea></div>';
  bodyEl.innerHTML = html;
  // Auto-save notes wiring
  let ta = document.getElementById('live-call-notes-'+id);
  if (ta) {
    ta.addEventListener('input', function() {
      clearTimeout(window._callNotesTimer);
      window._callNotesTimer = setTimeout(function(){ updS(id,{notes:ta.value}); save(); }, 900);
    });
  }
}

// ── DRIP DASHBOARD ────────────────────────────────────────────
function openDripDashboard()  { state.dripOpen=true; document.getElementById('drip-modal').classList.add('open'); renderDripDashboard(); }
function closeDripDashboard() { state.dripOpen=false; document.getElementById('drip-modal').classList.remove('open'); }
function renderDripDashboard() {
  let today = todayStr();
  let due=[], active=[], completed=[];
  Object.keys(state.pState).forEach(function(id) {
    let info=getDripInfo(id); if(!info)return;
    let p=findProv(id); if(!p)return;
    if(info.allSent) completed.push({id,p,info});
    else if(info.due.length>0) due.push({id,p,info});
    else active.push({id,p,info});
  });
  let statsEl = document.getElementById('drip-stats');
  if (statsEl) {
    statsEl.innerHTML =
      '<div class="drip-stat"><div class="drip-stat-num" style="color:var(--lime)">'+(active.length+due.length)+'</div><div class="drip-stat-label">Active</div></div>' +
      '<div class="drip-stat" style="border-color:var(--abd)"><div class="drip-stat-num" style="color:var(--amber)">'+due.length+'</div><div class="drip-stat-label">Emails Due</div></div>' +
      '<div class="drip-stat" style="border-color:var(--sgbd)"><div class="drip-stat-num" style="color:var(--sage)">'+completed.length+'</div><div class="drip-stat-label">Complete</div></div>';
  }
  function provRow(item) {
    let html = '<div class="drip-provider-row"><div style="min-width:0;flex:1"><div class="drip-provider-name">'+esc(item.p[I.N])+'</div><div class="drip-provider-sub">'+esc(item.p[I.SP])+' · '+esc(item.p[I.CI])+'</div></div>';
    if(item.info.due.length>0){
      for(let di=0;di<item.info.due.length;di++) html+='<button class="drip-send-btn" data-drip-send="'+esc(item.id)+'" data-drip-idx="'+item.info.due[di].idx+'">📤 '+esc(item.info.due[di].label)+'</button>';
    } else if(item.info.next) {
      html+='<span style="font-size:9.5px;color:var(--t3);font-family:DM Mono,monospace">'+esc(item.info.next.label)+': '+esc(item.info.next.date)+'</span>';
    } else if(item.info.allSent) {
      html+='<span style="font-size:9.5px;color:var(--sage)">Complete</span>';
    }
    html+='<button style="padding:4px 9px;background:transparent;border:1px solid var(--b2);border-radius:3px;color:var(--t2);font-family:Syne,sans-serif;font-size:9.5px;cursor:pointer" data-drip-view="'+esc(item.id)+'">View</button>';
    html+='</div>';
    return html;
  }
  let listEl = document.getElementById('drip-list'); if(!listEl)return;
  let html='';
  if(due.length){html+='<div style="font-size:9px;letter-spacing:3px;text-transform:uppercase;color:var(--amber);margin-bottom:8px;font-weight:700">⚠ Due Now</div>';for(let i=0;i<due.length;i++)html+=provRow(due[i]);}
  if(active.length){html+='<div style="font-size:9px;letter-spacing:3px;text-transform:uppercase;color:var(--t3);margin:14px 0 8px;font-weight:700">Active</div>';for(let j=0;j<active.length;j++)html+=provRow(active[j]);}
  if(completed.length){html+='<div style="font-size:9px;letter-spacing:3px;text-transform:uppercase;color:var(--t3);margin:14px 0 8px;font-weight:700">Completed</div>';for(let k=0;k<Math.min(completed.length,5);k++)html+=provRow(completed[k]);}
  if(!html)html='<div style="color:var(--t3);font-size:13px;text-align:center;padding:40px 0">No active drip campaigns yet.<br><span style="font-size:11px">Email a provider to start a sequence automatically.</span></div>';
  listEl.innerHTML=html;
}

// ── COMMAND CENTER ────────────────────────────────────────────
function renderCommandCenter() {
  let today = todayStr(), now = new Date();
  function score(p) {
    let s = getS(p[I.ID]), pts = 0;
    let sp = {warm:40,contacted:20,new:10,signed:0,dead:-999};
    pts += sp[s.status]||0;
    pts += (+(s.priority||p[I.PR]||2)) * 10;
    if (s.followUp&&s.followUp<today) pts+=50;
    else if (s.followUp&&s.followUp===today) pts+=30;
    let di = getDripInfo(p[I.ID]); if(di&&di.due.length>0) pts+=25;
    if(!s.lastContact) pts+=15;
    else { let ds=Math.floor((now-new Date(s.lastContact))/86400000); if(ds>14)pts+=15; else if(ds>7)pts+=8; }
    return pts;
  }
  let allActive = state.pipeline.filter(function(p){ let s=getS(p[I.ID]); return s.status!=='signed'&&s.status!=='dead'; });
  allActive.sort(function(a,b){ return score(b)-score(a); });
  let callNow  = allActive.filter(function(p){ let s=getS(p[I.ID]); return p[I.PH]&&(s.status==='warm'||(s.followUp&&s.followUp<=today)); }).slice(0,5);
  let emailNow = allActive.filter(function(p){ let s=getS(p[I.ID]); let di=getDripInfo(p[I.ID]); return p[I.EM]&&((di&&di.due.length>0)||(!s.lastContact)||s.status==='new'); }).slice(0,5);
  let warmUp   = allActive.filter(function(p){ let s=getS(p[I.ID]); return s.status==='warm'&&p[I.EM]; }).slice(0,5);
  let counts   = {new:0,contacted:0,warm:0,signed:0,dead:0};
  Object.values(state.pState).forEach(function(s){ counts[s.status]=(counts[s.status]||0)+1; });
  let overdueCount = state.pipeline.filter(function(p){ let s=getS(p[I.ID]); return s.followUp&&s.followUp<today&&s.status!=='signed'&&s.status!=='dead'; }).length;
  let dripDue = getDripDueCount();
  let cc = document.getElementById('cc-body'); if(!cc)return;
  let html='';
  html+='<div class="cc-hero"><div class="cc-date">'+now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})+'</div>';
  html+='<div class="cc-title">Good '+(now.getHours()<12?'morning':now.getHours()<17?'afternoon':'evening')+', Parth.</div>';
  let todoCount=callNow.length+emailNow.length+dripDue;
  html+='<div class="cc-sub">'+(todoCount>0?todoCount+' actions waiting for you today.':'All clear — add follow-up dates to fill your queue.')+'</div></div>';
  html+='<div class="cc-stat-row">';
  html+='<div class="cc-stat"><div class="cc-stat-num" style="color:var(--amber)">'+overdueCount+'</div><div class="cc-stat-lbl">Overdue</div></div>';
  html+='<div class="cc-stat"><div class="cc-stat-num" style="color:var(--lime)">'+dripDue+'</div><div class="cc-stat-lbl">Drips Due</div></div>';
  html+='<div class="cc-stat"><div class="cc-stat-num" style="color:var(--rose)">'+(counts.warm||0)+'</div><div class="cc-stat-lbl">Warm Leads</div></div>';
  html+='<div class="cc-stat"><div class="cc-stat-num" style="color:var(--sage)">'+(counts.signed||0)+'</div><div class="cc-stat-lbl">Signed</div></div></div>';
  html+='<div class="cc-grid">';
  // Col 1: Call
  html+='<div class="cc-card urgent"><div class="cc-card-label amber">📞 Call Now</div><div class="cc-action-list">';
  if(callNow.length){for(let ci=0;ci<callNow.length;ci++){let cp=callNow[ci],cs=getS(cp[I.ID]);let cwhy=cs.status==='warm'?'Warm lead':(cs.followUp<=today?'⚠ Overdue':'Follow-up today');html+='<div class="cc-action priority-'+(+(cs.priority||cp[I.PR]||2))+'" data-open="'+esc(cp[I.ID])+'"><span class="cc-action-icon">'+STATUS_ICONS[cs.status]+'</span><div class="cc-action-body"><div class="cc-action-name">'+esc(cp[I.N])+'</div><div class="cc-action-why">'+esc(cp[I.SP])+' · '+esc(cwhy)+'</div></div><div class="cc-action-btns"><button class="cc-btn ccb-brief" data-brief="'+esc(cp[I.ID])+'">📋</button>'+(cp[I.PH]?'<a href="tel:'+esc(cp[I.PH])+'" style="text-decoration:none"><button class="cc-btn ccb-call">📞</button></a>':'')+'</div></div>';}}
  else{html+='<div class="cc-empty">No urgent calls. Set follow-up dates to fill this.</div>';}
  html+='</div></div>';
  // Col 2: Email
  html+='<div class="cc-card hot"><div class="cc-card-label lime">✦ Email Now</div><div class="cc-action-list">';
  if(emailNow.length){for(let ei=0;ei<emailNow.length;ei++){let ep2=emailNow[ei],es2=getS(ep2[I.ID]);let di2=getDripInfo(ep2[I.ID]);let ewhy=di2&&di2.due.length>0?'Drip email due':(!es2.lastContact?'Never contacted':'New lead');html+='<div class="cc-action priority-'+(+(es2.priority||ep2[I.PR]||2))+'" data-open="'+esc(ep2[I.ID])+'"><span class="cc-action-icon">✉</span><div class="cc-action-body"><div class="cc-action-name">'+esc(ep2[I.N])+'</div><div class="cc-action-why">'+esc(ep2[I.SP])+' · '+esc(ewhy)+'</div></div><div class="cc-action-btns">'+(di2&&di2.due.length>0?'<button class="cc-btn ccb-email" data-drip-send="'+esc(ep2[I.ID])+'" data-drip-idx="'+di2.due[0].idx+'">📧 Drip</button>':'<button class="cc-btn ccb-email" data-email="'+esc(ep2[I.ID])+'">✦</button>')+'</div></div>';}}
  else{html+='<div class="cc-empty">No urgent emails. Email providers to build your queue.</div>';}
  html+='</div></div>';
  // Col 3: Warm close
  html+='<div class="cc-card"><div class="cc-card-label">🔥 Close These</div><div class="cc-action-list">';
  if(warmUp.length){for(let wi=0;wi<warmUp.length;wi++){let wp=warmUp[wi],ws=getS(wp[I.ID]);let wlc=ws.lastContact?Math.floor((now-new Date(ws.lastContact))/86400000)+'d ago':'never';html+='<div class="cc-action priority-'+(+(ws.priority||wp[I.PR]||2))+'" data-open="'+esc(wp[I.ID])+'"><span class="cc-action-icon">🔥</span><div class="cc-action-body"><div class="cc-action-name">'+esc(wp[I.N])+'</div><div class="cc-action-why">'+esc(wp[I.SP])+' · last: '+wlc+'</div></div><div class="cc-action-btns"><button class="cc-btn ccb-brief" data-brief="'+esc(wp[I.ID])+'">📋</button><button class="cc-btn ccb-email" data-email="'+esc(wp[I.ID])+'">✦</button></div></div>';}}
  else{html+='<div class="cc-empty">No warm leads yet. Start outreach to build pipeline.</div>';}
  html+='</div></div></div>';
  // Priority queue
  html+='<div class="dash-card" style="margin-top:0"><div class="dash-card-title">Full Priority Queue — Top 20</div><div style="display:flex;flex-direction:column;gap:4px">';
  for(let qi=0;qi<Math.min(allActive.length,20);qi++){let qp=allActive[qi],qs=getS(qp[I.ID]);let qdi=getDripInfo(qp[I.ID]);let qwhy=[];if(qs.followUp&&qs.followUp<=today)qwhy.push('⚠ overdue');if(qdi&&qdi.due.length>0)qwhy.push('drip due');if(qs.status==='warm')qwhy.push('warm lead');if(!qs.lastContact)qwhy.push('never contacted');let qpr=+(qs.priority||qp[I.PR]||2);html+='<div style="display:flex;align-items:center;gap:9px;padding:7px 10px;background:var(--bg3);border-radius:4px;border-left:2px solid '+(qpr===3?'var(--lime)':qpr===2?'var(--amber)':'var(--t4)')+'" data-open="'+esc(qp[I.ID])+'"><span style="font-size:11px;width:14px;text-align:center;flex-shrink:0">'+(qi+1)+'</span><span class="badge badge-'+qs.status+'" style="cursor:default;font-size:9px">'+esc(STATUS_LABELS[qs.status])+'</span><span style="flex:1;font-size:12px;font-weight:600;color:var(--t1);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(qp[I.N])+'</span><span style="font-size:10px;color:var(--t3)">'+esc(qp[I.SP])+' · '+esc(qp[I.CI])+'</span>'+(qwhy.length?'<span style="font-size:9px;color:var(--amber);white-space:nowrap">'+qwhy.join(', ')+'</span>':'')+'<div style="display:flex;gap:3px">'+(qp[I.PH]?'<a href="tel:'+esc(qp[I.PH])+'" style="text-decoration:none"><button class="cc-btn ccb-call">📞</button></a>':'')+'<button class="cc-btn ccb-email" data-email="'+esc(qp[I.ID])+'">✦</button><button class="cc-btn ccb-brief" data-brief="'+esc(qp[I.ID])+'">📋</button></div></div>';}
  if(!allActive.length)html+='<div class="cc-empty" style="padding:30px">No active providers. Sync Airtable or add providers to get started.</div>';
  html+='</div></div>';
  cc.innerHTML=html;
}

// ── SCHEDULER VIEW (standalone view) ─────────────────────────
function renderSchedulerView() {
  let el = document.getElementById('sched-view-body'); if (!el) return;
  let now = new Date();
  let pending = state.scheduled.filter(function(e){ return !e.sent; }).sort(function(a,b){ return new Date(a.sendAt)-new Date(b.sendAt); });
  let sent = state.scheduled.filter(function(e){ return e.sent; }).sort(function(a,b){ return new Date(b.sentAt)-new Date(a.sentAt); }).slice(0,20);
  let html = '';
  html += '<div class="cc-stat-row" style="margin-bottom:16px">';
  html += '<div class="cc-stat"><div class="cc-stat-num" style="color:var(--blue)">'+pending.length+'</div><div class="cc-stat-lbl">Scheduled</div></div>';
  let overdue = pending.filter(function(e){ return new Date(e.sendAt)<=now; }).length;
  html += '<div class="cc-stat"><div class="cc-stat-num" style="color:var(--amber)">'+overdue+'</div><div class="cc-stat-lbl">Due Now</div></div>';
  html += '<div class="cc-stat"><div class="cc-stat-num" style="color:var(--sage)">'+sent.length+'</div><div class="cc-stat-lbl">Sent</div></div>';
  html += '<div class="cc-stat"><div class="cc-stat-num" style="color:var(--t2)">'+state.scheduled.length+'</div><div class="cc-stat-lbl">Total</div></div>';
  html += '</div>';
  if (pending.length) {
    html += '<div class="dash-card-title" style="margin-bottom:8px">📅 Scheduled Queue</div>';
    for (let i=0; i<pending.length; i++) {
      let e = pending[i]; let isPast = new Date(e.sendAt) < now;
      let prov = findProv(e.providerId);
      html += '<div class="chain-email'+(isPast?' chain-overdue':'')+'" style="margin-bottom:8px">';
      html += '<div class="chain-email-header"><div><span class="chain-email-time">'+(isPast?'⚠ PAST DUE — ':'')+esc(fmtDateTime(e.sendAt))+'</span><div style="font-size:10px;color:var(--t3);margin-top:1px">'+(prov?esc(prov[I.N]):esc(e.to))+'</div></div>';
      html += '<div style="display:flex;gap:4px"><button class="chain-action-btn chain-send-now" data-sched-send="'+esc(e.id)+'">Send Now via Gmail</button><button class="chain-action-btn chain-edit-btn" data-sched-edit="'+esc(e.id)+'">Edit</button><button class="chain-action-btn chain-del-btn" data-sched-del="'+esc(e.id)+'">✕</button></div></div>';
      html += '<div class="chain-email-subject">'+esc(e.subject)+'</div>';
      html += '<div class="chain-email-preview">'+esc(e.body.slice(0,150))+(e.body.length>150?'…':'')+'</div></div>';
    }
  }
  if (sent.length) {
    html += '<div class="dash-card-title" style="margin-bottom:8px;margin-top:16px">✉ Sent Emails</div>';
    for (let j=0; j<sent.length; j++) {
      let s2 = sent[j]; let prov2 = findProv(s2.providerId);
      html += '<div class="chain-email chain-sent" style="margin-bottom:6px">';
      html += '<div class="chain-email-header"><div><span class="chain-email-time">Sent '+esc(fmtDateTime(s2.sentAt))+'</span><div style="font-size:10px;color:var(--t3);margin-top:1px">'+(prov2?esc(prov2[I.N]):esc(s2.to))+'</div></div></div>';
      html += '<div class="chain-email-subject">'+esc(s2.subject)+'</div></div>';
    }
  }
  if (!pending.length && !sent.length) {
    html = '<div class="cc-empty" style="padding:60px;text-align:center">No scheduled emails yet.<br><span style="font-size:11px;color:var(--t3)">Open any provider and click 📅 Schedule to queue an email.</span></div>';
  }
  el.innerHTML = html;
}

// ── SCHEDULER VIEW COMPOSE ───────────────────────────────────
function openSchedCompose() {
  let panel = document.getElementById('sched-compose-panel');
  if (!panel) return;
  panel.style.display = 'block';
  // Set default date to tomorrow
  let tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  let dateEl = document.getElementById('sv-date');
  if (dateEl) dateEl.value = tomorrow.toISOString().slice(0,10);
  let toEl = document.getElementById('sv-to-name');
  if (toEl) toEl.focus();
}

function closeSchedCompose() {
  let panel = document.getElementById('sched-compose-panel');
  if (panel) panel.style.display = 'none';
}

function svSaveScheduled() {
  let toName  = (document.getElementById('sv-to-name').value  || '').trim();
  let toEmail = (document.getElementById('sv-to-email').value || '').trim();
  let subject = (document.getElementById('sv-subject').value  || '').trim();
  let body    = (document.getElementById('sv-body').value     || '').trim();
  let date    = (document.getElementById('sv-date').value     || '').trim();
  let time    = (document.getElementById('sv-time').value     || '09:00').trim();
  if (!subject || !body) { showToast('Subject and message are required', 'warn'); return; }
  if (!date) { showToast('Pick a send date', 'warn'); return; }
  let sendAt = date + 'T' + time + ':00';
  let entry = {
    id: 'sched_' + Date.now(),
    providerId: null,
    to: toEmail,
    toName: toName || toEmail || 'General',
    subject: subject,
    body: body,
    sendAt: sendAt,
    sent: false,
    sentAt: null,
    createdAt: nowISO(),
    isDrip: false
  };
  state.scheduled.push(entry);
  save();
  closeSchedCompose();
  // Reset fields
  document.getElementById('sv-to-name').value  = '';
  document.getElementById('sv-to-email').value = '';
  document.getElementById('sv-body').value     = '';
  showToast('Email scheduled for ' + new Date(sendAt).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}), 'ok');
  renderSchedulerView();
  renderCounts();
}

function svSendNow() {
  let toEmail = (document.getElementById('sv-to-email').value || '').trim();
  let subject = (document.getElementById('sv-subject').value  || '').trim();
  let body    = (document.getElementById('sv-body').value     || '').trim();
  if (!toEmail) { showToast('Enter a recipient email address', 'warn'); return; }
  if (!subject || !body) { showToast('Subject and message are required', 'warn'); return; }
  sendViaGmail(toEmail, subject, body);
  // Record as sent scheduled entry
  let entry = {
    id: 'sched_' + Date.now(),
    providerId: null,
    to: toEmail,
    toName: (document.getElementById('sv-to-name').value || '').trim() || toEmail,
    subject: subject,
    body: body,
    sendAt: nowISO(),
    sent: true,
    sentAt: nowISO(),
    createdAt: nowISO(),
    isDrip: false
  };
  state.scheduled.push(entry);
  save();
  closeSchedCompose();
  showToast('Opened in Gmail', 'ok');
  renderSchedulerView();
}

// ── DASHBOARD ─────────────────────────────────────────────────
function renderDashboard() {
  let counts={new:0,contacted:0,warm:0,signed:0,dead:0};
  let weekAgo=new Date(Date.now()-7*24*60*60*1000);
  let weekEmails=0,weekCalls=0,weekWarm=0;
  Object.values(state.pState).forEach(function(s){
    counts[s.status]=(counts[s.status]||0)+1;
    (s.activity||[]).forEach(function(a){
      if(new Date(a.time)>weekAgo){if(a.type==='email')weekEmails++;if(a.type==='call')weekCalls++;if(a.type==='status'&&a.text&&a.text.indexOf('Warm')>-1)weekWarm++;}
    });
  });
  let total=state.pipeline.length,contacted=total-(counts.new||0),signed=counts.signed||0;
  let conv=contacted>0?Math.round((signed/contacted)*100)+'%':'0%';
  let signedPct=Math.min(Math.round((signed/200)*100),100);
  setEl('dash-total',total.toLocaleString()); setEl('dash-contacted',contacted.toLocaleString()); setEl('dash-warm',(counts.warm||0).toLocaleString()); setEl('dash-signed',signed.toLocaleString()); setEl('dash-conv',conv);
  STATUS_CYCLE.forEach(function(s){ setEl('stage-'+s,(counts[s]||0).toLocaleString()); });
  let velMax=Math.max(weekEmails,weekCalls,weekWarm,1);
  let velEl=document.getElementById('vel-list');
  if(velEl){let velData=[['Emails sent',weekEmails,'var(--lime)'],['Calls logged',weekCalls,'var(--blue)'],['Warm leads created',weekWarm,'var(--amber)']];let velHtml='';for(let vi=0;vi<velData.length;vi++){let pct=Math.round((velData[vi][1]/velMax)*100);velHtml+='<div class="velocity-item"><span class="velocity-label">'+velData[vi][0]+'</span><div class="velocity-track"><div class="velocity-fill" style="width:'+pct+'%;background:'+velData[vi][2]+'"></div></div><span class="velocity-count">'+velData[vi][1]+'</span></div>';}velEl.innerHTML=velHtml;}
  let today=todayStr();
  let dueItems=state.pipeline.filter(function(p){let s=getS(p[I.ID]);return s.followUp&&s.followUp<=today&&s.status!=='signed'&&s.status!=='dead';}).sort(function(a,b){return(getS(a[I.ID]).followUp||'').localeCompare(getS(b[I.ID]).followUp||'');}).slice(0,8);
  let dueEl=document.getElementById('due-list');
  if(dueEl){if(!dueItems.length){dueEl.innerHTML='<div style="color:var(--t3);font-size:11.5px;padding:4px">No follow-ups due.</div>';}else{let dueHtml='';for(let di=0;di<dueItems.length;di++){let dp=dueItems[di],ds=getS(dp[I.ID]),dfu=ds.followUp||'',dod=dfu<today;dueHtml+='<div class="due-item" data-open="'+esc(dp[I.ID])+'"><span>'+(dod?'⚠️':'📅')+'</span><span class="due-name">'+esc(dp[I.N])+'</span><span class="due-badge" style="background:'+(dod?'var(--redbg)':'var(--abg)')+';color:'+(dod?'var(--red)':'var(--amber)')+';border:1px solid '+(dod?'rgba(240,112,112,.28)':'var(--abd)')+'">'+esc(dfu)+'</span></div>';}dueEl.innerHTML=dueHtml;}}
  let feedEl=document.getElementById('activity-feed');
  if(feedEl){if(!state.actLog.length){feedEl.innerHTML='<div style="color:var(--t3);font-size:11.5px;padding:4px">No activity yet.</div>';}else{let feedHtml='',feed=state.actLog.slice(-10).reverse();for(let fi=0;fi<feed.length;fi++){feedHtml+='<div class="feed-item"><span class="feed-icon">'+(feed[fi].icon||'•')+'</span><span class="feed-text">'+esc(feed[fi].text)+'</span><span class="feed-time">'+relTime(feed[fi].time)+'</span></div>';}feedEl.innerHTML=feedHtml;}}
  let need=Math.max(200-signed,0);
  let pathEl=document.getElementById('path-to-200');
  if(pathEl){let pathHtml='';pathHtml+='<div style="display:flex;justify-content:space-between;font-size:9.5px;color:var(--t3);margin-bottom:5px"><span>PROGRESS TO 200 SIGNED</span><span style="color:var(--lime)">'+signed+'/200</span></div>';pathHtml+='<div class="path-bar-wrap"><div class="path-bar-fill" style="width:'+signedPct+'%"></div></div>';let rates=[['0.5% (cold email)',Math.round(need/0.005),'var(--red)'],['3% (personal call)',Math.round(need/0.03),'var(--amber)'],['10% (warm intro)',Math.round(need/0.1),'var(--lime)']];for(let ri=0;ri<rates.length;ri++){pathHtml+='<div class="path-rate"><span class="path-rate-label">'+rates[ri][0]+'</span><span class="path-rate-count" style="color:'+rates[ri][2]+'">'+rates[ri][1].toLocaleString()+' outreaches</span></div>';}pathHtml+='<div style="font-size:10px;color:var(--t3);margin-top:7px;line-height:1.5">Need '+need+' more signed. '+(typeof FULL_RAW!=='undefined'?FULL_RAW.length.toLocaleString():'52,935')+' providers available.</div>';pathEl.innerHTML=pathHtml;}
  let scoreEl=document.getElementById('scorecard');
  if(scoreEl&&total>0){let rr=contacted>0?Math.round((contacted/total)*100):0;let cr=contacted>0?Math.round((signed/contacted)*100):0;let wr=contacted>0?Math.round(((counts.warm||0)/contacted)*100):0;let da=Object.keys(state.pState).filter(function(id){let di=getDripInfo(id);return di&&!di.allSent;}).length;scoreEl.innerHTML='<div class="scorecard-grid"><div class="score-item"><div class="score-label">Response Rate</div><div class="score-val" style="color:var(--lime)">'+rr+'%</div></div><div class="score-item"><div class="score-label">Close Rate</div><div class="score-val" style="color:var(--amber)">'+cr+'%</div></div><div class="score-item"><div class="score-label">Warm Rate</div><div class="score-val" style="color:var(--rose)">'+wr+'%</div></div><div class="score-item"><div class="score-label">Active Drips</div><div class="score-val" style="color:var(--blue)">'+da+'</div></div></div>';}
}

// ── SMS + LINKEDIN ────────────────────────────────────────────
function openSMS(id) {
  let p = findProv(id); if (!p || !p[I.PH]) { showToast('No phone number on file','warn'); return; }
  let msg = 'Hi ' + ln(p[I.N]) + ', this is Dr. Parth Kansagra — dentist, founder of JŪMA. Quick question: would you be open to a 10-min call about a cash-pay patient wallet that pays your practice full rate, no insurance? — juma.com/providers';
  window.open('sms:' + p[I.PH] + '?body=' + encodeURIComponent(msg));
  logAct(id, {type:'sms', text:'SMS sent', time:nowISO()});
  addFeed('SMS sent to ' + p[I.N], '📱');
  let s = getS(id); if (s.status==='new') updS(id, {status:'contacted', lastContact:nowISO()});
  save(); renderAll(); showToast('SMS opened', 'ok');
}

function copyLinkedInDM(id) {
  let p = findProv(id); if (!p) return;
  let sp = p[I.SP] || '';
  let msg = 'Hi ' + ln(p[I.N]) + ' — came across your' + (sp?' '+sp.toLowerCase():'') + ' practice and wanted to reach out.\n\nI\'m building JŪMA — a prepaid healthcare wallet where patients pre-load credits and spend them at participating providers. You get paid full rate instantly, zero insurance friction.\n\nWould you be open to a quick 10-minute call?\n\n— Dr. Parth Kansagra, Founder JŪMA';
  navigator.clipboard && navigator.clipboard.writeText(msg).then(function(){
    showToast('LinkedIn DM copied — paste into LinkedIn', 'ok');
    logAct(id, {type:'linkedin', text:'LinkedIn DM copied', time:nowISO()});
    addFeed('LinkedIn DM copied for ' + p[I.N], '🔗');
    save();
  }).catch(function(){ showToast('Copy failed — check clipboard permissions','warn'); });
}

// ── TOAST ─────────────────────────────────────────────────────
function showToast(msg, type) {
  let el = document.getElementById('toast'); if (!el) return;
  el.textContent = msg; el.className = 'toast visible ' + (type||'ok');
  clearTimeout(window._toastT);
  window._toastT = setTimeout(function(){ el.classList.remove('visible'); }, 3000);
}

// ── NAVIGATION ────────────────────────────────────────────────
function setView(v) {
  state.view = v; state.page = 0;
  document.querySelectorAll('.view').forEach(function(el){ el.classList.remove('active'); });
  document.querySelectorAll('.nav-item[data-view]').forEach(function(n){ n.classList.remove('active'); });
  let vEl = document.getElementById('view-'+v); if (vEl) vEl.classList.add('active');
  let nEl = document.querySelector('.nav-item[data-view="'+v+'"]'); if (nEl) nEl.classList.add('active');
  if (v==='dash')     renderDashboard();
  else if (v==='today')    renderTodayTable();
  else if (v==='pipeline') renderPipeTable();
  else if (v==='sched')    renderSchedulerView();
  else if (v==='cc')       renderCommandCenter();
  else if (v==='sched')    renderSchedulerView();
}

function setFilterStatus(status) {
  state.filterStatus = status; state.page = 0;
  document.querySelectorAll('.filter-tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.filter-tab[data-filter="'+status+'"]').forEach(function(t){ t.classList.add('active'); });
  document.querySelectorAll('.nav-item[data-status]').forEach(function(n){ n.classList.remove('active'); });
  if (status!=='all') { document.querySelectorAll('.nav-item[data-status="'+status+'"]').forEach(function(n){ n.classList.add('active'); }); }
  setView('pipeline'); renderCounts();
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.tab[data-tab="'+tab+'"]').forEach(function(t){ t.classList.add('active'); });
  let pEl = document.getElementById('tab-pipeline'), fEl = document.getElementById('tab-find');
  if (pEl) pEl.style.display = tab==='pipeline' ? 'flex' : 'none';
  if (fEl) fEl.style.display = tab==='find'     ? 'flex' : 'none';
  if (tab==='find') renderFindTable();
}

function sortBy(key) {
  if (state.sortKey===key) state.sortDir*=-1; else { state.sortKey=key; state.sortDir=1; }
  state.page=0; renderPipeTable();
}

function buildPills(containerId, onSelect) {
  let container = document.getElementById(containerId); if (!container) return;
  let allBtn = document.createElement('button');
  allBtn.className='pill active'; allBtn.textContent='All Verticals'; allBtn.dataset.all='1';
  container.appendChild(allBtn);
  if (typeof VERTS === 'undefined') return;
  Object.entries(VERTS).sort(function(a,b){ return a[1].name.localeCompare(b[1].name); }).forEach(function(kv) {
    let btn = document.createElement('button');
    btn.className='pill'; btn.textContent=(kv[1].ico||'')+' '+kv[1].name; btn.dataset.vert=kv[0];
    container.appendChild(btn);
  });
  container.addEventListener('click', function(e) {
    let btn = e.target.closest('.pill'); if (!btn) return;
    container.querySelectorAll('.pill').forEach(function(p){ p.classList.remove('active'); });
    btn.classList.add('active');
    onSelect(btn.dataset.vert || '');
  });
}

function buildStateSelect(id) {
  let sel = document.getElementById(id); if (!sel) return;
  if (typeof STATES === 'undefined') return;
  STATES.forEach(function(s){ let o=document.createElement('option'); o.value=s; o.textContent=s; sel.appendChild(o); });
}

function onFindStateChange() {
  let st = document.getElementById('find-state') ? document.getElementById('find-state').value : '';
  let cs = document.getElementById('find-city'); if (!cs) return;
  cs.innerHTML = '<option value="">All Cities</option>';
  if (typeof CITIES !== 'undefined' && st && CITIES[st]) CITIES[st].forEach(function(c){ let o=document.createElement('option'); o.value=c; o.textContent=c; cs.appendChild(o); });
  renderFindTable();
}

// ── EVENT DELEGATION ──────────────────────────────────────────
function initEvents() {
  document.addEventListener('click', function(e) {
    let t = e.target;
    if (!t.closest('[data-stop]') && t.closest('[data-open]')) {
      let oid = t.closest('[data-open]').dataset.open; if (oid) { openDrawer(oid); return; }
    }
    if (t.dataset.cycle)        { cycleStatus(t.dataset.cycle); return; }
    if (t.dataset.email)        { openEmailModal(t.dataset.email); return; }
    if (t.dataset.sched)        { openScheduler(t.dataset.sched); return; }
    if (t.dataset.call)         { logCall(t.dataset.call); return; }
    if (t.dataset.brief)        { openCallBrief(t.dataset.brief); return; }
    if (t.dataset.del)          { delProv(t.dataset.del); return; }
    if (t.dataset.addPipeline)  { addToPipeline(t.dataset.addPipeline); return; }
    if (t.dataset.quickEmail)   { addToPipeline(t.dataset.quickEmail); openEmailModal(t.dataset.quickEmail); return; }
    if (t.dataset.pauseDrip)    { pauseDrip(t.dataset.pauseDrip); return; }
    if (t.dataset.resumeDrip)   { resumeDrip(t.dataset.resumeDrip); return; }
    if (t.dataset.dripSend)     { sendDripEmail(t.dataset.dripSend, +t.dataset.dripIdx); return; }
    if (t.dataset.dripView)     { closeDripDashboard(); openDrawer(t.dataset.dripView); return; }
    if (t.dataset.quickDate)    { setFUDays(t.dataset.quickDate, +t.dataset.days); return; }
    if (t.dataset.saveNotes)    { saveNotes(t.dataset.saveNotes); return; }
    if (t.dataset.view)         { setView(t.dataset.view); return; }
    if (t.dataset.status)       { setFilterStatus(t.dataset.status); return; }
    if (t.dataset.filter)       { setFilterStatus(t.dataset.filter); return; }
    if (t.dataset.tab)          { setTab(t.dataset.tab); return; }
    if (t.dataset.sort)         { sortBy(t.dataset.sort); return; }
    if (t.dataset.schedSend)    { sendScheduledNow(t.dataset.schedSend); return; }
    if (t.dataset.schedEdit)    { editScheduled(t.dataset.schedEdit); return; }
    if (t.dataset.schedDel)     { deleteScheduled(t.dataset.schedDel); return; }
    if (t.dataset.page !== undefined && t.dataset.page !== '') { state.page=+t.dataset.page; renderPipeTable(); return; }
  });

  document.addEventListener('change', function(e) {
    let t = e.target;
    if (t.dataset.setStatus)   { setStatus(t.dataset.setStatus, t.value); return; }
    if (t.dataset.setPriority) { setPriority(t.dataset.setPriority, t.value); return; }
    if (t.dataset.setFollowup) { setFollowUp(t.dataset.setFollowup, t.value); return; }
    if (t.id==='find-state')   { onFindStateChange(); return; }
    if (t.id==='find-city')    { renderFindTable(); return; }
    if (t.id==='chk-all')      { toggleSelAll(t.checked); return; }
    if (t.dataset.select)      { toggleSel(t.dataset.select, t.checked); return; }
  });

  let gs = document.getElementById('gSearch');
  if (gs) gs.addEventListener('input', function(){ state.page=0; renderPipeTable(); });
  let fq = document.getElementById('find-q');
  if (fq) fq.addEventListener('input', renderFindTable);
  let prev = document.getElementById('pag-prev');
  if (prev) prev.addEventListener('click', function(){ if(state.page>0){state.page--;renderPipeTable();} });
  let next = document.getElementById('pag-next');
  if (next) next.addEventListener('click', function(){ let t=getFiltered().length; if((state.page+1)*PER_PAGE<t){state.page++;renderPipeTable();} });

  ['email-modal','call-brief-modal','drip-modal','sched-modal','setup-modal'].forEach(function(mid) {
    let el = document.getElementById(mid); if (!el) return;
    el.addEventListener('click', function(e) {
      if (e.target !== el) return;
      if (mid==='email-modal')      closeEmailModal();
      else if (mid==='call-brief-modal') closeCallBrief();
      else if (mid==='drip-modal')  closeDripDashboard();
      else if (mid==='sched-modal') closeScheduler();
      else if (mid==='setup-modal') closeSetup();
    });
  });

  document.addEventListener('keydown', function(e) {
    if (e.key==='Escape') {
      if (state.briefOpen) { closeCallBrief(); return; }
      if (state.emailOpen) { closeEmailModal(); return; }
      if (state.dripOpen)  { closeDripDashboard(); return; }
      if (state.schedOpen) { closeScheduler(); return; }
      if (state.drawerOpen){ closeDrawer(); return; }
    }
    if ((e.metaKey||e.ctrlKey) && e.key==='k') { e.preventDefault(); let s=document.getElementById('gSearch'); if(s)s.focus(); }
    if ((e.metaKey||e.ctrlKey) && e.key==='s') { e.preventDefault(); save(); }
  });
}

// ── INIT ──────────────────────────────────────────────────────
// ── GMAIL OAUTH + AUTO-SEND ──────────────────────────────────
// Token lives in state.settings (persisted to localStorage via store.js).
// All sends go through /api/gmail/send (Netlify Function).

function startGmailOAuth() {
  if (!state.settings.gmailClientId) {
    document.getElementById('gmail-oauth-modal').classList.add('open');
    return;
  }
  launchGmailOAuth();
}

function saveGmailClientId() {
  const cid = (document.getElementById('gmail-client-id').value || '').trim();
  if (!cid || !cid.includes('.apps.googleusercontent.com')) {
    const st = document.getElementById('gmail-oauth-status');
    if (st) { st.textContent = '⚠ Paste a valid Google OAuth Client ID'; st.style.color = 'var(--amber)'; }
    return;
  }
  state.settings.gmailClientId = cid;
  save();
  document.getElementById('gmail-oauth-modal').classList.remove('open');
  launchGmailOAuth();
}

function launchGmailOAuth() {
  const clientId = state.settings.gmailClientId;
  if (!clientId) { showToast('Add Google Client ID in Settings first', 'warn'); return; }
  // Authorization code flow (not implicit — code handled server-side)
  const redirectUri = window.location.origin + '/oauth/callback';
  const url = 'https://accounts.google.com/o/oauth2/v2/auth' +
    '?client_id=' + encodeURIComponent(clientId) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&response_type=code' +
    '&scope=' + encodeURIComponent('https://www.googleapis.com/auth/gmail.send') +
    '&access_type=offline' +
    '&prompt=consent';
  window.location.href = url;
}

async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return;
  // Clean URL immediately
  window.history.replaceState(null, '', window.location.pathname);
  try {
    const redirectUri = window.location.origin + '/oauth/callback';
    const data = await gmailExchangeToken({ code, redirectUri });
    state.settings.gmailAccessToken  = data.access_token;
    state.settings.gmailRefreshToken = data.refresh_token || state.settings.gmailRefreshToken;
    state.settings.gmailTokenExpiry  = Date.now() + ((data.expires_in || 3600) * 1000);
    save();
    updGmailBtn();
    showToast('✓ Gmail connected — drip emails will send automatically', 'ok');
  } catch (err) {
    showToast('Gmail auth failed: ' + err.message, 'error');
  }
}

function updAirtableBtn() {
  const btn = document.getElementById('airtable-sync-btn');
  if (!btn) return;
  const s = state.airtableStatus;
  if (s === 'loading') {
    btn.textContent = '\u27f3 Syncing\u2026';
    btn.style.background = 'rgba(138,184,122,.12)';
    btn.style.color = 'var(--sage)';
  } else if (s === 'ok') {
    btn.textContent = '\u2713 Airtable Synced';
    btn.style.background = 'rgba(138,184,122,.12)';
    btn.style.color = 'var(--sage)';
  } else if (s === 'error') {
    btn.textContent = '\u26a0 Sync Error';
    btn.style.background = 'rgba(234,67,53,.12)';
    btn.style.color = '#ea4335';
  } else {
    btn.textContent = '\u27f3 Sync Airtable';
    btn.style.background = '';
    btn.style.color = '';
  }
}
function updGmailBtn() {
  const btn   = document.getElementById('gmail-connect-btn');
  const label = document.getElementById('gmail-btn-label');
  if (!btn || !label) return;
  const connected = isGmailConnected(state.settings);
  label.textContent = connected ? '✓ Gmail Connected' : 'Connect Gmail';
  btn.style.background    = connected ? 'rgba(138,184,122,.12)' : 'rgba(234,67,53,.12)';
  btn.style.borderColor   = connected ? 'rgba(138,184,122,.3)'  : 'rgba(234,67,53,.3)';
  btn.style.color         = connected ? 'var(--sage)'           : '#ea4335';
}

async function sendViaGmailAPI(to, subject, body) {
  try {
    const token = await getValidGmailToken(state.settings, (updated) => {
      state.settings = { ...state.settings, ...updated };
      save();
      updGmailBtn();
    });
    if (!token) {
      // No token — fall back to compose window
      sendViaGmail(to, subject, body);
      return false;
    }
    await gmailSend({ to, subject, body, accessToken: token });
    return true;
  } catch (err) {
    console.error('[sendViaGmailAPI]', err);
    // If token expired, update state and fall back
    if (err.message.includes('401') || err.message.includes('expired')) {
      state.settings.gmailAccessToken = '';
      save();
      updGmailBtn();
      showToast('Gmail token expired — re-connect Gmail to resume auto-send', 'warn');
    }
    sendViaGmail(to, subject, body);
    return false;
  }
}

// ── AI EMAIL GENERATION (drips) ──────────────────────────────
async function generateDripEmail(provider, dripStep) {
  const name   = provider[I.N]  || 'Doctor';
  const sp     = provider[I.SP] || 'healthcare';
  const city   = provider[I.CI] || '';
  const provSt = provider[I.ST] || '';
  const provData = getS(provider[I.ID]);
  const notes  = (provData && provData.notes) || '';

  const stepPrompts = [
    'Write cold outreach email #1 (intro). Open with their SPECIFIC specialty pain point around insurance/billing. 2-sentence JUMA explanation: members pre-load wallet like a Starbucks card for healthcare, they pay providers full rate instantly, JUMA takes small %. End: soft ask for 15-min call. Sign: Dr. Parth Kansagra DMD MBS MBA, Founder JUMA. MAX 130 words. No subject line.',
    'Write cold outreach email #2 (follow-up, no reply yet). New angle: the math. Insurance pays 60-70 cents per dollar. JUMA pays 100 cents instantly. For a $500K cash-pay practice that is real money. No contract to join, no monthly fee. One clear CTA: 10-min call this week. Sign: Dr. Parth Kansagra. MAX 100 words. No subject line.',
    'Write cold outreach email #3 (final breakup email). Short, human, no hard sell. Tell them this is the last email. If timing is not right, no worries, will circle back. If they have been curious but busy, 10 min is all it takes. Leave door open. Sign: Dr. Parth. MAX 80 words. No subject line.',
  ];

  const subjectLines = [
    { dental: 'Your patients already have the budget — JŪMA gets them in the chair',
      medspa: 'Pre-funded aesthetic patients in ' + city,
      chiropractic: 'No more insurance delays — JŪMA pays you same-day',
      dermatology: 'Cash-pay derm patients who have pre-loaded their wallet',
      default: 'JŪMA Provider Partnership — Pre-Funded Cash-Pay Patients in ' + city },
    { default: 'Quick follow-up — JŪMA Provider Partnership' },
    { default: 'Last note — JŪMA (I promise)' },
  ];

  const subMap = subjectLines[dripStep];
  const spLow = sp.toLowerCase();
  const subject = subMap[spLow] || subMap['default'] || 'JŪMA Provider Partnership';

  const prompt = 'You are writing a cold outreach email on behalf of Dr. Parth Kansagra, DMD MBS MBA — dentist, entrepreneur, founder of JUMA (prepaid healthcare wallet).' +
    '\n\nProvider details:\nName: ' + name + '\nSpecialty: ' + sp +
    '\nLocation: ' + city + (provSt ? ', ' + provSt : '') +
    (notes ? '\nContext/Notes: ' + notes : '') +
    '\n\nTask: ' + stepPrompts[dripStep] +
    '\n\nTone: Doctor-to-doctor. Peer credibility, not salesy. Direct, confident, zero corporate fluff. Gets to the point fast.' +
    '\n\nRespond with ONLY the email body text. No subject line. No preamble.';

  try {
    const data = await callAI({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 400,
    });
    const body = extractText(data).trim();
    return { subject, body: body || '' };
  } catch {
    const fallbacks = [
      'Hi ' + ln(name) + ',\n\nMy name is Dr. Parth Kansagra — dentist and founder of JUMA, a prepaid healthcare wallet.\n\nJUMA members pre-load credits and spend them at participating providers. You get paid in full at your rates, instantly. No insurance. No billing overhead.\n\nWorth 15 minutes?\n\nDr. Parth Kansagra, DMD MBS MBA\nFounder, JUMA',
      'Hi ' + ln(name) + ',\n\nFollowing up on JUMA — insurance pays 60-70 cents on the dollar. JUMA pays 100 cents, instantly.\n\n10 minutes this week?\n\nDr. Parth Kansagra',
      'Hi ' + ln(name) + ',\n\nLast note from me. If timing is ever right for JUMA, I would love to connect.\n\nDr. Parth',
    ];
    return { subject, body: fallbacks[dripStep] || fallbacks[0] };
  }
}

// ── AUTO-DRIP ENGINE ──────────────────────────────────────────
async function startAutoDrip(id) {
  const s = getS(id);
  if (s.dripStarted) { showToast('Drip already running for this provider', 'warn'); return; }
  const p = findProv(id);
  if (!p) return;
  showToast('Generating AI emails for ' + nameOf(id) + '…', 'ok');
  const DRIP_DAYS = [0, 4, 9];
  const emails = [];
  for (let i = 0; i < 3; i++) {
    const result = await generateDripEmail(p, i);
    emails.push(result);
  }
  const now = new Date();
  const toEmail = p[I.EM] || '';
  DRIP_DAYS.forEach((dayOffset, idx) => {
    const sendAt = new Date(now);
    sendAt.setDate(sendAt.getDate() + dayOffset);
    if (dayOffset === 0) {
      sendAt.setTime(now.getTime() + 2000);
    } else {
      sendAt.setHours(9, 0, 0, 0);
    }
    state.scheduled.push({
      id: 'drip_' + id + '_' + idx + '_' + Date.now(),
      providerId: id,
      to: toEmail,
      toName: nameOf(id),
      subject: emails[idx].subject,
      body: emails[idx].body,
      sendAt: sendAt.toISOString(),
      sent: false, sentAt: null,
      createdAt: now.toISOString(),
      isDrip: true, dripIdx: idx,
    });
  });
  const dates = DRIP_DAYS.map(d => { const dt = new Date(now); dt.setDate(dt.getDate() + d); return dt.toISOString().slice(0, 10); });
  updS(id, { dripStarted: now.toISOString(), dripDates: dates, dripSent: [false, false, false], dripStatus: 'active' });
  logAct(id, { type: 'drip', text: 'AI drip campaign started — 3 personalized emails queued', time: now.toISOString() });
  addFeed('AI drip started for ' + nameOf(id), '🤖');
  save();
  renderAll();
  showToast('✓ AI drip queued for ' + nameOf(id) + ' — email 1 sends in ~2 seconds', 'ok');
  setTimeout(checkAndAutoSend, 2500);
}

// ── BACKGROUND AUTO-SENDER ────────────────────────────────────
let autoSendRunning = false;

async function checkAndAutoSend() {
  if (autoSendRunning) return;
  autoSendRunning = true;
  try {
    const now = new Date();
    const due = state.scheduled.filter(e => !e.sent && new Date(e.sendAt) <= now);
    if (!due.length) { autoSendRunning = false; return; }
    const connected = isGmailConnected(state.settings);
    for (const entry of due) {
      if (!entry.to) { entry.sent = true; entry.sentAt = now.toISOString(); entry.skipped = true; continue; }
      if (connected) {
        const ok = await sendViaGmailAPI(entry.to, entry.subject, entry.body);
        entry.sent = true; entry.sentAt = now.toISOString(); entry.autoSent = ok;
        if (entry.providerId) {
          recordEmailSent(entry.providerId, entry.subject, entry.body);
          logAct(entry.providerId, { type: 'email', text: (ok ? '✓ Auto-sent: ' : '📤 Opened compose: ') + entry.subject, time: now.toISOString() });
          if (entry.isDrip && entry.dripIdx !== undefined) {
            const ps = getS(entry.providerId);
            const dripSent = (ps.dripSent || [false, false, false]).slice();
            dripSent[entry.dripIdx] = true;
            updS(entry.providerId, { dripSent });
          }
          pushToAirtable(entry.providerId);
        }
        if (ok) { addFeed('Auto-sent to ' + (entry.toName || entry.to), '✉'); showToast('✉ Auto-sent to ' + (entry.toName || entry.to), 'ok'); }
      } else {
        sendViaGmail(entry.to, entry.subject, entry.body);
        entry.sent = true; entry.sentAt = now.toISOString(); entry.autoSent = false;
        if (entry.providerId) recordEmailSent(entry.providerId, entry.subject, entry.body);
        showToast('Connect Gmail to enable auto-send for scheduled drip emails', 'warn');
        break;
      }
    }
    save();
    renderCounts();
    if (state.view === 'sched') renderSchedulerView();
  } catch (err) {
    console.error('[checkAndAutoSend]', err);
  }
  autoSendRunning = false;
}

// ── ONBOARDING ───────────────────────────────────────────────
async function obTestAirtable() {
  let key   = (document.getElementById('ob-at-key').value   || '').trim();
  let base  = (document.getElementById('ob-at-base').value  || '').trim();
  let table = (document.getElementById('ob-at-table').value || '').trim();
  let st    = document.getElementById('ob-at-status');
  if (!key || !base || !table) { st.textContent = '⚠ Enter API key, Base ID, and Table name first'; st.style.color='var(--amber)'; return; }
  st.textContent = 'Testing…'; st.style.color = 'var(--t3)';
  try {
    let r = await fetch('https://api.airtable.com/v0/' + encodeURIComponent(base) + '/' + encodeURIComponent(table) + '?maxRecords=1', {
      headers: { 'Authorization': 'Bearer ' + key }
    });
    if (r.ok) {
      let d = await r.json();
      let cnt = d.records ? d.records.length : 0;
      st.textContent = '✓ Connected! Found ' + cnt + ' record(s). Click Launch to import all.';
      st.style.color = 'var(--lime)';
    } else {
      let err = await r.json();
      st.textContent = '✗ Error: ' + (err.error ? err.error.message : 'HTTP ' + r.status);
      st.style.color = 'var(--rose)';
    }
  } catch(e) {
    st.textContent = '✗ Network error — check your credentials';
    st.style.color = 'var(--rose)';
  }
}

function obSaveAndLaunch() {
  let key   = (document.getElementById('ob-at-key').value   || '').trim();
  let base  = (document.getElementById('ob-at-base').value  || '').trim();
  let table = (document.getElementById('ob-at-table').value || '').trim();
  let gmail = (document.getElementById('ob-gmail').value    || '').trim();
  // Save to cfg
  cfg.airtableKey     = key;
  cfg.airtableBaseId  = base;
  cfg.airtableTableId = table;
  cfg.gmailUser       = gmail;
  save();
  // Populate settings modal fields too
  let sk = document.getElementById('setup-airtable-key');   if (sk) sk.value = key;
  let sb = document.getElementById('setup-airtable-base');  if (sb) sb.value = base;
  let st = document.getElementById('setup-airtable-table'); if (st) st.value = table;
  let sg = document.getElementById('setup-gmail');          if (sg) sg.value = gmail;
  // Hide onboarding
  let banner = document.getElementById('welcome-banner');
  if (banner) banner.style.display = 'none';
  // If credentials provided, sync Airtable
  if (key && base && table) {
    showToast('Credentials saved — syncing Airtable…', 'ok');
    syncAirtable();
  } else {
    showToast('Settings saved. You can connect Airtable anytime in ⚙ Settings.', 'ok');
  }
  updAirtableBtn();
}

function obSkip() {
  let banner = document.getElementById('welcome-banner');
  if (banner) banner.style.display = 'none';
  state.setupDone = true;
  save();
  showToast('Welcome to JŪMA CRM — Search 52K+ providers in the Find tab', 'ok');
}

function init() {
  state.selected  = new Set();
  loadSaved();

  // First-run: if no airtable key AND no pipeline, force onboarding overlay
  let isFirstRun = !cfg.airtableKey && !cfg.gmailUser && !state.pipeline.length;
  let banner = document.getElementById('welcome-banner');
  if (banner) {
    if (isFirstRun) {
      banner.style.display = 'flex';
      // Make it fully blocking (no close-on-outside-click until setup done)
      banner.setAttribute('data-onboarding', '1');
    } else {
      banner.style.display = 'none';
    }
  }

  buildPills('pill-row', function(vert){ state.filterVert=vert; state.page=0; renderPipeTable(); });
  buildPills('find-pill-row', function(vert){ state.findVert=vert; renderFindTable(); });
  buildStateSelect('find-state');
  initEvents();
  updAirtableBtn();
  setView('pipeline');
  renderCounts();

  let dateEl = document.getElementById('today-date-label');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  let statusEl = document.getElementById('top-status');
  if (statusEl) statusEl.textContent = state.pipeline.length ? state.pipeline.length + ' providers loaded' : 'Connect Airtable to import providers';

  // Handle Gmail OAuth callback (returning from Google auth)
  handleOAuthCallback();
  updGmailBtn();

  // Init Web Worker for off-thread search
  initSearchWorker();

  // Wire debounced search to find inputs
  const fq = document.getElementById('find-q');
  if (fq) fq.addEventListener('input', debouncedFindSearch);

  // Check + auto-send scheduled emails every 30s
  setInterval(checkAndAutoSend, 30000);
  checkAndAutoSend();

  // Update badge every 60s
  setInterval(checkScheduled, 60000);
  checkScheduled();

  // Auto-backup reminder every 7 days
  const lastBackup = localStorage.getItem('juma_last_backup');
  if (!lastBackup || Date.now() - Number(lastBackup) > 7 * 24 * 60 * 60 * 1000) {
    setTimeout(() => showToast('Tip: Export a backup from Settings → Export Backup', 'ok'), 5000);
  }
}

// Expose functions to global scope for HTML onclick handlers
window.state = state;
window.obTestAirtable = obTestAirtable;
window.obSaveAndLaunch = obSaveAndLaunch;
window.obSkip = obSkip;
window.setView = setView;
window.openDripDashboard = openDripDashboard;
window.syncAirtable = syncAirtable;
window.startGmailOAuth = startGmailOAuth;
window.save = save;
window.showToast = showToast;
window.exportCSV = exportCSV;
window.addManual = addManual;
window.bulkEmail = bulkEmail;
window.bulkMarkCalled = bulkMarkCalled;
window.clearSelection = clearSelection;
window.openSchedCompose = openSchedCompose;
window.svSaveScheduled = svSaveScheduled;
window.svSendNow = svSendNow;
window.closeSchedCompose = closeSchedCompose;
window.closeDrawer = closeDrawer;
window.closeEmailModal = closeEmailModal;
window.switchTemplate = switchTemplate;
window.generateAIEmail = generateAIEmail;
window.sendGmail = sendGmail;
window.sendOutlook = sendOutlook;
window.sendMailto = sendMailto;
window.copyEmailToClip = copyEmailToClip;
window.closeCallBrief = closeCallBrief;
window.logCall = logCall;
window.openPostCallEmail = openPostCallEmail;
window.renderCallBrief = renderCallBrief;
window.generateCallBrief = generateCallBrief;
window.closeDripDashboard = closeDripDashboard;
window.closeSetup = closeSetup;
window.saveSetup = saveSetup;
window.closeScheduler = closeScheduler;
window.schedApplyTemplate = schedApplyTemplate;
window.saveScheduled = saveScheduled;
window.sendViaGmail = sendViaGmail;
window.sendViaOutlook = sendViaOutlook;
window.recordEmailSent = recordEmailSent;
window.renderAll = renderAll;
window.updAirtableBtn = updAirtableBtn;
init();

function schedApplyTemplate(key, btn) {
  document.querySelectorAll('#sched-modal .tmpl-chip').forEach(function(c){ c.classList.remove('active'); });
  btn.classList.add('active');
  let id = state.schedId;
  let p  = id ? findProv(id) : null;
  let name = p ? p[I.N] : '[Provider Name]';
  let sp   = p ? (p[I.SP]||'') : '';
  let bodyEl = document.getElementById('sched-body');
  if (bodyEl && TEMPLATES[key]) bodyEl.value = TEMPLATES[key](name, sp);
}
