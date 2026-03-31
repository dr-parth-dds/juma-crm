/**
 * enrich-ui.js - Provider Email Enrichment Engine
 * Self-contained module. Loaded after app.js.
 * Uses NPI Registry + website scraping to find real emails.
 */
(function() {
  'use strict';
  const I = {ID:0,N:1,SP:2,V:3,CI:4,ST:5,PH:6,EM:7,CO:8,NP:9,PR:10,TX:11,AD:12};
  const BASE = window.location.origin;
  const SK = 'juma_crm_v3';
  function getAS() { try { return JSON.parse(localStorage.getItem(SK)||'{}').settings?.appSecret||''; } catch{return '';} }
  function hdr() { return {'Content-Type':'application/json','x-app-secret':getAS()}; }

  let E = {running:false, paused:false, queue:[], processed:0, found:0, errors:0, skipped:0, results:[], batchSize:5, delayMs:1500};

  async function api(path, body) {
    const r = await fetch(BASE+path, {method:'POST', headers:hdr(), body:JSON.stringify(body)});
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error||'API error '+r.status); }
    return r.json();
  }

  async function enrichOne(p) {
    const name=p[I.N]||'', city=p[I.CI]||'', st=p[I.ST]||'CA', spec=p[I.SP]||'', id=p[I.ID];
    const res = {id, name, oldEmail:p[I.EM]||'', newEmail:null, newPhone:null, website:null, npi:null, source:null};
    // Step 1: NPI lookup
    try {
      const d = await api('/api/enrich/npi', {name,city,state:st,specialty:spec});
      if (d.count>0) { res.npi=d.results[0].npi; if(d.results[0].address.phone) res.newPhone=fmtPh(d.results[0].address.phone); }
    } catch(e) { console.warn('[Enrich] NPI fail:', name, e.message); }
    // Step 2: Google search for website
    let webUrl = null;
    try {
      const sd = await api('/api/enrich/search', {query: name+' '+city+' '+st+' dentist'});
      if (sd.results) {
        const skip = ['yelp.com','healthgrades.com','zocdoc.com','vitals.com','webmd.com','npidb.org','yellowpages.com','facebook.com','instagram.com','linkedin.com'];
        for (const sr of sd.results) { const dm=(sr.displayLink||'').toLowerCase(); if(!skip.some(d=>dm.includes(d))){webUrl=sr.link; res.website=sr.link; break;} }
      }
    } catch(e) { if(!e.message.includes('not configured')) console.warn('[Enrich] Search fail:', e.message); }
    // Step 3: Scrape website for emails
    if (webUrl) {
      try {
        const wd = await api('/api/enrich/website', {url:webUrl});
        if (wd.emails && wd.emails.length>0) {
          const sorted = wd.emails.sort((a,b)=>(/^(info|contact|office|admin|hello)@/i.test(a)?0:1)-(/^(info|contact|office|admin|hello)@/i.test(b)?0:1));
          res.newEmail=sorted[0]; res.source='website';
        }
        if (wd.phones && wd.phones.length>0 && !res.newPhone) res.newPhone=wd.phones[0];
      } catch(e) { console.warn('[Enrich] Scrape fail:', e.message); }
    }
    // Step 4: Try domain guesses if no website found
    if (!res.newEmail && !webUrl) {
      const cn = name.replace(/^dr\.?\s*/i,'').replace(/,.*$/,'').trim().toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/).filter(Boolean);
      const guesses = [];
      if(cn.length>=2) { guesses.push(cn.join('')+'.com'); guesses.push(cn[0]+cn[cn.length-1]+'.com'); }
      if(cn.length>=1) { guesses.push('dr'+cn[0]+'.com'); guesses.push(cn[0]+'dental.com'); }
      for (const g of guesses.slice(0,3)) {
        try { const wd = await api('/api/enrich/website',{url:'https://'+g}); if(wd.emails&&wd.emails.length>0){res.newEmail=wd.emails[0];res.website='https://'+g;res.source='domain-guess';break;} } catch{}
      }
    }
    return res;
  }

  function fmtPh(r) { const d=(r||'').replace(/\D/g,''); if(d.length===10) return '('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6); if(d.length===11&&d[0]==='1') return '('+d.slice(1,4)+') '+d.slice(4,7)+'-'+d.slice(7); return r; }

  // Batch engine
  async function runBatch() {
    if (!E.running || E.paused) return;
    const batch = E.queue.splice(0, E.batchSize);
    if (!batch.length) { E.running=false; updUI(); showDone(); return; }
    const promises = batch.map(async(prov) => {
      try {
        const r = await enrichOne(prov);
        E.processed++;
        if (r.newEmail||r.newPhone||r.website) { E.found++; E.results.push(r); applyResult(r); }
        else E.skipped++;
      } catch(e) { E.processed++; E.errors++; }
    });
    await Promise.all(promises);
    updUI();
    if (E.running && !E.paused && E.queue.length>0) setTimeout(runBatch, E.delayMs);
    else if (!E.queue.length) { E.running=false; updUI(); showDone(); }
  }

  function applyResult(r) {
    const st = JSON.parse(localStorage.getItem(SK)||'{}');
    const idx = st.pipeline.findIndex(function(p){return p[I.ID]===r.id;});
    if (idx!==-1) { if(r.newEmail) st.pipeline[idx][I.EM]=r.newEmail; if(r.newPhone) st.pipeline[idx][I.PH]=r.newPhone; }
    if (!st.pState[r.id]) st.pState[r.id]={};
    const ps = st.pState[r.id];
    if(r.newEmail) ps.verifiedEmail=r.newEmail;
    if(r.newPhone) ps.verifiedPhone=r.newPhone;
    if(r.website) ps.website=r.website;
    if(r.npi) ps.npiNumber=r.npi;
    ps.enrichedAt=new Date().toISOString(); ps.enrichSource=r.source;
    localStorage.setItem(SK, JSON.stringify(st));
    if (window.FULL_RAW) {
      const ri = window.FULL_RAW.findIndex(function(x){return x[I.ID]===r.id;});
      if(ri!==-1) { if(r.newEmail) window.FULL_RAW[ri][I.EM]=r.newEmail; if(r.newPhone) window.FULL_RAW[ri][I.PH]=r.newPhone; }
    }
  }

  function showDone() { if(typeof window.showToast==='function') window.showToast('Enrichment done! Found '+E.found+' emails from '+E.processed+' providers.','ok'); }
  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function sUrl(u) { return (u||'').replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,'').substring(0,40); }
  function $$(id) { return document.getElementById(id); }
  function setT(id,v) { var e=$$(id); if(e) e.textContent=v; }
  function sh(id) { var e=$$(id); if(e) e.style.display=''; }
  function hi(id) { var e=$$(id); if(e) e.style.display='none'; }

  // UI Panel
  function createPanel() {
    if ($$('enrich-panel')) return;
    const d = document.createElement('div'); d.id='enrich-panel';
    d.style.cssText='display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.85);overflow-y:auto;';
    d.innerHTML = '<div style="max-width:800px;margin:40px auto;padding:30px;background:#1a1f2e;border-radius:12px;border:1px solid #2d3548;">'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">'
    +'<h2 style="margin:0;color:#e8ecf1;font-size:22px;">Email Enrichment Engine</h2>'
    +'<button onclick="window._enrichClose()" style="background:none;border:none;color:#8892a4;font-size:24px;cursor:pointer;">&times;</button></div>'
    +'<div style="background:#141824;border-radius:8px;padding:16px;margin-bottom:20px;">'
    +'<p style="color:#8892a4;margin:0 0 12px;font-size:13px;">Finds <strong style="color:#e8ecf1;">real email addresses</strong> by searching NPI Registry and scraping provider websites. Replaces fake generated emails with verified ones.</p>'
    +'<div style="display:flex;gap:12px;flex-wrap:wrap;">'
    +'<div style="flex:1;min-width:180px;background:#1a1f2e;border-radius:6px;padding:12px;"><div style="color:#8892a4;font-size:11px;text-transform:uppercase;">Pipeline</div><div id="enrich-total" style="color:#e8ecf1;font-size:24px;font-weight:bold;">0</div></div>'
    +'<div style="flex:1;min-width:180px;background:#1a1f2e;border-radius:6px;padding:12px;"><div style="color:#8892a4;font-size:11px;text-transform:uppercase;">Enriched</div><div id="enrich-done" style="color:#4ade80;font-size:24px;font-weight:bold;">0</div></div>'
    +'<div style="flex:1;min-width:180px;background:#1a1f2e;border-radius:6px;padding:12px;"><div style="color:#8892a4;font-size:11px;text-transform:uppercase;">Remaining</div><div id="enrich-remaining" style="color:#f59e0b;font-size:24px;font-weight:bold;">0</div></div>'
    +'</div></div>'
    +'<div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">'
    +'<button id="enrich-start-btn" onclick="window._enrichStart(\'pipeline\')" style="padding:10px 20px;background:#1a568e;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">Enrich Pipeline</button>'
    +'<button id="enrich-sel-btn" onclick="window._enrichStart(\'selected\')" style="padding:10px 20px;background:#2d7db3;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">Enrich Selected</button>'
    +'<button id="enrich-pause-btn" onclick="window._enrichPause()" style="padding:10px 20px;background:#f59e0b;color:#000;border:none;border-radius:6px;cursor:pointer;font-size:14px;display:none;">Pause</button>'
    +'<button id="enrich-stop-btn" onclick="window._enrichStop()" style="padding:10px 20px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;display:none;">Stop</button>'
    +'</div>'
    +'<div style="margin-bottom:20px;display:flex;align-items:center;gap:10px;">'
    +'<label style="color:#8892a4;font-size:13px;">Batch:</label>'
    +'<select id="enrich-bs" onchange="window._enrichSetBatch(this.value)" style="background:#141824;color:#e8ecf1;border:1px solid #2d3548;border-radius:4px;padding:4px 8px;"><option value="1">1</option><option value="3">3</option><option value="5" selected>5</option><option value="10">10</option></select>'
    +'<label style="color:#8892a4;font-size:13px;margin-left:10px;">Delay:</label>'
    +'<select id="enrich-dl" onchange="window._enrichSetDelay(this.value)" style="background:#141824;color:#e8ecf1;border:1px solid #2d3548;border-radius:4px;padding:4px 8px;"><option value="500">0.5s</option><option value="1500" selected>1.5s</option><option value="3000">3s</option></select>'
    +'</div>'
    +'<div id="enrich-prog-wrap" style="display:none;margin-bottom:20px;">'
    +'<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span id="enrich-prog-text" style="color:#8892a4;font-size:13px;">Processing...</span><span id="enrich-prog-pct" style="color:#e8ecf1;font-size:13px;">0%</span></div>'
    +'<div style="background:#141824;border-radius:4px;height:8px;overflow:hidden;"><div id="enrich-prog-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#1a568e,#4ade80);border-radius:4px;transition:width 0.3s;"></div></div>'
    +'<div style="display:flex;gap:20px;margin-top:8px;"><span style="color:#4ade80;font-size:12px;">Found: <b id="enrich-fc">0</b></span><span style="color:#8892a4;font-size:12px;">Skipped: <b id="enrich-sc">0</b></span><span style="color:#ef4444;font-size:12px;">Errors: <b id="enrich-ec">0</b></span></div>'
    +'</div>'
    +'<div id="enrich-res-wrap" style="display:none;margin-top:16px;">'
    +'<h3 style="color:#e8ecf1;font-size:16px;margin-bottom:12px;">Results</h3>'
    +'<div style="max-height:400px;overflow-y:auto;border:1px solid #2d3548;border-radius:6px;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:#141824;position:sticky;top:0;"><th style="padding:8px;text-align:left;color:#8892a4;">Provider</th><th style="padding:8px;text-align:left;color:#8892a4;">Email</th><th style="padding:8px;text-align:left;color:#8892a4;">Website</th><th style="padding:8px;text-align:left;color:#8892a4;">Source</th></tr></thead><tbody id="enrich-tbody"></tbody></table></div>'
    +'<button onclick="window._enrichExport()" style="margin-top:10px;padding:8px 16px;background:#1a568e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;">Export CSV</button>'
    +'</div></div>';
    document.body.appendChild(d);
  }

  function updUI() {
    const st = JSON.parse(localStorage.getItem(SK)||'{}');
    const pipe = st.pipeline||[], ps = st.pState||{};
    const total=pipe.length, done=pipe.filter(function(p){var s=ps[p[I.ID]];return s&&s.enrichedAt;}).length;
    setT('enrich-total',total); setT('enrich-done',done); setT('enrich-remaining',total-done);
    if (E.running||E.processed>0) {
      sh('enrich-prog-wrap');
      const tot=E.processed+E.queue.length, pct=tot>0?Math.round(E.processed/tot*100):0;
      setT('enrich-prog-pct',pct+'%');
      setT('enrich-prog-text', E.running?(E.paused?'Paused':'Processing '+E.processed+'/'+tot+'...'):'Complete - '+E.processed+' processed');
      var bar=$$('enrich-prog-bar'); if(bar) bar.style.width=pct+'%';
      setT('enrich-fc',E.found); setT('enrich-sc',E.skipped); setT('enrich-ec',E.errors);
      if(E.running){hi('enrich-start-btn');hi('enrich-sel-btn');sh('enrich-pause-btn');sh('enrich-stop-btn');var pb=$$('enrich-pause-btn');if(pb){pb.textContent=E.paused?'Resume':'Pause';pb.style.background=E.paused?'#4ade80':'#f59e0b';}}
      else{sh('enrich-start-btn');sh('enrich-sel-btn');hi('enrich-pause-btn');hi('enrich-stop-btn');}
    }
    if (E.results.length>0) {
      sh('enrich-res-wrap');
      var tb=$$('enrich-tbody');
      if(tb) tb.innerHTML=E.results.map(function(r){return '<tr style="border-bottom:1px solid #2d3548;"><td style="padding:6px 8px;color:#e8ecf1;">'+esc(r.name)+'</td><td style="padding:6px 8px;color:#4ade80;">'+esc(r.newEmail||'-')+'</td><td style="padding:6px 8px;color:#60a5fa;"><a href="'+esc(r.website||'')+'" target="_blank" style="color:#60a5fa;text-decoration:none;">'+esc(r.website?sUrl(r.website):'-')+'</a></td><td style="padding:6px 8px;color:#8892a4;">'+esc(r.source||'-')+'</td></tr>';}).join('');
    }
  }

  // Public API
  window._enrichOpen = function() { createPanel(); $$('enrich-panel').style.display=''; updUI(); };
  window._enrichClose = function() { var p=$$('enrich-panel'); if(p) p.style.display='none'; };
  window._enrichStart = function(mode) {
    var st=JSON.parse(localStorage.getItem(SK)||'{}'), pipe=st.pipeline||[], ps=st.pState||{};
    var provs;
    if(mode==='selected'&&window.state&&window.state.selected&&window.state.selected.size>0) provs=pipe.filter(function(p){return window.state.selected.has(p[I.ID]);});
    else provs=pipe.filter(function(p){var s=ps[p[I.ID]];return !s||!s.enrichedAt;});
    if(!provs.length){if(typeof window.showToast==='function')window.showToast('No providers to enrich','warn');return;}
    E.running=true;E.paused=false;E.queue=provs.slice();E.processed=0;E.found=0;E.errors=0;E.skipped=0;E.results=[];
    updUI(); runBatch();
  };
  window._enrichPause = function() { E.paused=!E.paused; if(!E.paused) runBatch(); updUI(); };
  window._enrichStop = function() { E.running=false;E.paused=false;E.queue=[]; updUI(); };
  window._enrichSetBatch = function(v) { E.batchSize=parseInt(v)||5; };
  window._enrichSetDelay = function(v) { E.delayMs=parseInt(v)||1500; };
  window._enrichExport = function() {
    if(!E.results.length) return;
    var rows=[['Provider','Old Email','New Email','Website','Phone','NPI','Source']];
    E.results.forEach(function(r){rows.push([r.name,r.oldEmail,r.newEmail||'',r.website||'',r.newPhone||'',r.npi||'',r.source||'']);});
    var csv=rows.map(function(r){return r.map(function(v){return '"'+String(v).replace(/"/g,'""')+'"';}).join(',');}).join('\n');
    var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='enrichment-'+new Date().toISOString().slice(0,10)+'.csv';a.click();
  };

  // Add button to CRM header
  function addBtn() {
    if($$('enrich-btn')) return;
    var gmBtn=document.querySelector('button[onclick*="Gmail"],button[onclick*="gmail"]');
    var btn=document.createElement('button'); btn.id='enrich-btn';
    btn.textContent='ENRICH EMAILS';
    btn.style.cssText='padding:6px 14px;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;letter-spacing:0.5px;margin-left:8px;';
    btn.onclick=window._enrichOpen;
    if(gmBtn&&gmBtn.parentElement) gmBtn.parentElement.insertBefore(btn,gmBtn);
    else { var h=document.querySelector('header'); if(h) h.appendChild(btn); }
  }

  function waitInit() {
    if(document.querySelector('header')||document.querySelector('button')) addBtn();
    else setTimeout(waitInit, 500);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',waitInit);
  else setTimeout(waitInit, 1000);
})();
