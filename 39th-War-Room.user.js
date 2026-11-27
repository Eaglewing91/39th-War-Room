// ==UserScript==
// @name         39th War Room
// @namespace    eaglewing.torn.39th.warroom
// @version      1.12.1
// @description  39th factions only. Opened from a button on your faction page. Ranked war overview: enemy members by status with hospital timers, who is out next, both chains to the second, dibs, and an optional chain-timeout alert. Names are plain links to attack pages that you click yourself.
// @author       Eaglewing [571041]
// @match        https://www.torn.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_addStyle
// @connect      api.torn.com
// @connect      ultimata.net
// @homepageURL  https://github.com/Eaglewing91/39th-War-Room
// @updateURL    https://raw.githubusercontent.com/Eaglewing91/39th-War-Room/main/39th-War-Room.user.js
// @downloadURL  https://raw.githubusercontent.com/Eaglewing91/39th-War-Room/main/39th-War-Room.user.js
// @license      GPL-3.0-or-later
// ==/UserScript==

/*
 * Terms of use
 * | Data Storage          | Only locally: your settings and your API key. The last reading is kept on this device    |
 * |                       | for under a minute, so the window can carry on when you change Torn page.                |
 * | Data Sharing          | Nobody. A dib you place is sent to ultimata.net and shown to your faction there.          |
 * | Purpose of Use        | Competitive advantage: faster war status and dibs during ranked wars.                     |
 * | Key Storage & Sharing | Stored locally, used only for Torn API calls. Not shared; never sent to ultimata.net.     |
 * | Key Access Level      | Public.                                                                                   |
 *
 * Compliance notes
 * - A "39th War Room" button is added to your own faction page, under Torn's war list. The page you are viewing is
 *   read only to find that spot; nothing of Torn's is clicked or changed, and no request is made for it.
 * - 39th factions only: your faction ID is read from the Torn API with your key and checked on this device against the
 *   39th list. For any other faction War Room stops: no further API calls, no faction site requests, no dibs.
 * - Torn: reads only the Torn API (api.torn.com), key in the Authorization header. No clicks, submits or requests to
 *   torn.com pages; attack links are ordinary links you click yourself (one click = one page load).
 * - Refreshes only while the window is open and the tab is visible, and never stacks calls. All Torn API calls share
 *   one budget of 40 a minute (Torn's limit is 100); calls over the budget wait their turn.
 * - 39th site link (off until you turn it on): reads from https://ultimata.net/ using your browser's own login there:
 *   the war list (to find the current war), that war's data (members, spies, dibs, dibs limit, assigned targets),
 *   your own spy entry (for fair fight) and your target groups. No other site can be contacted, and no Torn API key
 *   is sent there.
 * - Own window: the "Own window" button opens your faction page in a separate small browser window (your click, one
 *   page load) and War Room fills it. That window never changes page, so War Room stays up while you play in the other.
 * - Alerts (your switch): a notification when a target you dibbed leaves hospital, and when several enemies leave
 *   hospital early in a short time. Worked out from data already loaded; no extra requests. Clicking the dibbed-target
 *   notification opens that attack page (your click, one page load).
 * - Stats source (your choice): the site's spies, or figures Battle Stats Predictor by TDup has already saved on this
 *   device. BSP's data is only read; no request is made for it and its key is never read.
 *   BSP's terms: https://www.torn.com/forums.php#/p=threads&f=67&t=16290324
 * - Dib / Undib: one real press sends one dib message to ultimata.net. Scripted presses are ignored.
 */

(function () {
'use strict';
if (window.top !== window.self || window.__warRoom39) return;
window.__warRoom39 = true;
// Own-window mode: this browser window was opened by the "Own window" button to hold War Room and nothing else.
const POP_NAME = 'wr39popout', POPOUT = window.name === POP_NAME;

/* ---------- small engine: key, Torn API with a shared per-minute budget, timers, window ---------- */
const now = () => Date.now();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = {
  num: (n, d) => (n == null || isNaN(n) ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d == null ? 0 : d })),
  dur: (s) => { s = Math.max(0, Math.round(s)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`; },
  ago: (ts) => { const s = Math.round(now() / 1000 - ts); return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; },
};
const BUDGET = 40, sentAt = [], waiting = [], cache = new Map();
// Timers follow Torn's clock, not this device's: the gap is measured from the time stamped on Torn API replies
// (taken from the quickest reply, and applied only when this device is more than 1.5 seconds out).
let skew = 0, bestLag = Infinity;
const clock = () => Date.now() + skew;
function sync(r, t0) {
  const m = /^date:\s*(.+)$/mi.exec((r && r.responseHeaders) || ''), sv = m ? Date.parse(m[1]) : 0, lag = Date.now() - t0;
  if (!sv || lag > bestLag + 150) return;
  bestLag = Math.min(bestLag, lag); const gap = sv + 500 - Date.now(); skew = Math.abs(gap) > 1500 ? gap : 0;
}
let pumping = null, fullAt = 0;   // fullAt: when a call last had to wait because the minute's 40 were used
function pump() {
  pumping = null;
  while (waiting.length) {
    const t = now(); while (sentAt.length && t - sentAt[0] > 60000) sentAt.shift();
    if (sentAt.length >= BUDGET) { fullAt = t; pumping = setTimeout(pump, Math.max(250, 60000 - (t - sentAt[0]) + 50)); return; }
    sentAt.push(t); waiting.shift()();
  }
}
const tornErr = (msg, code) => { const e = new Error(msg); e.code = code; return e; };
function api(path, params, opt) {
  const key = String(GM_getValue('api_key', '') || '');
  if (!key) return Promise.reject(tornErr('No API key.', 'nokey'));
  const u = new URL('https://api.torn.com' + path); Object.keys(params || {}).forEach((k) => u.searchParams.set(k, params[k])); u.searchParams.set('comment', '39thWarRoom');
  const ck = path, ttl = Math.max(0, Number(opt && opt.ttl) || 0) * 1000, hit = cache.get(ck);
  if (ttl && hit && now() - hit.at < ttl) return Promise.resolve(hit.v);
  return new Promise((resolve, reject) => {
    waiting.push(() => { const t0 = Date.now(); GM_xmlhttpRequest({ method: 'GET', url: u.toString(), headers: { Authorization: 'ApiKey ' + key, Accept: 'application/json' }, timeout: 15000, anonymous: true,
      onload: (r) => { sync(r, t0); let j = null; try { j = JSON.parse(r.responseText); } catch (e) {}
        if (!j) return reject(new Error('Torn API answered with error ' + r.status + '.'));
        if (j.error) return reject(tornErr(j.error.code === 2 ? 'Torn says the API key is wrong.' : j.error.code === 5 ? 'Too many API calls: slowing down.' : 'Torn API: ' + (j.error.error || 'error'), j.error.code === 2 ? 'badkey' : 'api'));
        cache.set(ck, { at: now(), v: j }); resolve(j); },
      onerror: () => reject(new Error('Could not reach the Torn API.')), ontimeout: () => reject(new Error('The Torn API did not answer.')) }); });
    if (!pumping) pump();
  });
}
// Runs fn now and then every `ms` while this tab is visible.
const every = (ms, fn) => {
  let t = null, stopped = false, last = 0;
  const run = () => { if (stopped) return; clearTimeout(t); if (!document.hidden || POPOUT) { last = now(); try { fn(); } catch (e) { console.warn('[39th War Room]', e); } } t = setTimeout(run, ms); };
  const vis = () => { if (!document.hidden && now() - last >= ms) run(); };
  document.addEventListener('visibilitychange', vis);
  run();
  return { stop() { stopped = true; clearTimeout(t); t = null; document.removeEventListener('visibilitychange', vis); }, now: () => { stopped = false; run(); } };
};
const alerted = {};
function alertUser(a) {
  if (alerted[a.id] && now() - alerted[a.id] < (a.repeatAfter || 300) * 1000) return;
  alerted[a.id] = now();
  try { GM_notification({ title: a.title, text: a.text || '', timeout: 15000, onclick: a.url ? () => { try { window.open(a.url, '_blank'); } catch (e) {} } : undefined }); } catch (e) {}
}
GM_addStyle(`.wr39w,#wr39-open{--wr39-bg:#111113;--wr39-s1:#18181b;--wr39-s2:#202024;--wr39-s3:#2a2a30;--wr39-line:#3a3a42;--wr39-line2:#52525b;--wr39-text:#f4f4f5;--wr39-muted:#c9c9d1;--wr39-dim:#a1a1aa;
  --wr39-accent:#fca5a5;--wr39-accent-fill:#b91c1c;--wr39-accent-fill-hover:#991b1b;--wr39-accent-ink:#ffffff;
  --wr39-good:#4ade80;--wr39-good-soft:rgba(74,222,128,.14);--wr39-bad:#fda4af;--wr39-bad-soft:rgba(253,164,175,.14);--wr39-warn:#fbbf24;--wr39-warn-soft:rgba(251,191,36,.14);--wr39-info:#93c5fd;
  --wr39-font:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;--wr39-fs:13.5px;--wr39-r:12px;--wr39-r2:8px;--wr39-shadow:0 24px 60px rgba(0,0,0,.6)}

    .wr39w{position:fixed;right:14px;top:70px;width:min(540px,calc(100vw - 28px));max-height:calc(100vh - 150px);z-index:2147483005;display:none;flex-direction:column;
      background:var(--wr39-bg) !important;color:var(--wr39-text) !important;border:1px solid var(--wr39-line);border-top:3px solid var(--wr39-accent-fill);border-radius:var(--wr39-r);box-shadow:var(--wr39-shadow);font:var(--wr39-fs)/1.45 var(--wr39-font);overflow:hidden}
    .wr39w.open{display:flex}
    .wr39w *{box-sizing:border-box;font-family:inherit}
    .wr39w div,.wr39w span,.wr39w td,.wr39w label,.wr39w p,.wr39w li,.wr39w b{color:inherit}
    .wr39w .tw-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--wr39-s1);border-bottom:1px solid var(--wr39-line);cursor:move;user-select:none}
    .wr39w .tw-t{font-weight:700;font-size:14.5px;color:var(--wr39-text) !important}
    .wr39w .tw-s{font-size:12px;font-weight:700;letter-spacing:.04em;color:var(--wr39-accent) !important;margin-left:4px}
    .wr39w .tw-x{margin-left:auto;background:var(--wr39-s2);border:1px solid var(--wr39-line);color:var(--wr39-text) !important;border-radius:var(--wr39-r2);width:30px;height:30px;font-size:14px;cursor:pointer}
    .wr39w .tw-x:hover{border-color:var(--wr39-accent)}
    .wr39w .tw-bd{overflow:auto;padding:12px}
    .wr39w table{width:100%;border-collapse:collapse;font-size:13px}
    .wr39w th,.wr39w td{text-align:left;padding:6px 6px !important;border-bottom:1px solid var(--wr39-line);vertical-align:top}.wr39w th.n,.wr39w td.n{text-align:right}
    .wr39w th{color:var(--wr39-muted) !important;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
    .wr39w td{color:var(--wr39-text) !important}
    .wr39w td.n,.wr39w th.n{text-align:right;font-variant-numeric:tabular-nums}
    .wr39w td.sec{font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--wr39-accent) !important;background:var(--wr39-s1);border-bottom:0}
    .wr39w tr.up td{background:var(--wr39-s2)}
    .wr39w a{color:var(--wr39-accent) !important;text-decoration:none}.wr39w a:hover{text-decoration:underline}
    .wr39w td a{color:var(--wr39-text) !important;font-weight:600}.wr39w td a:hover{color:var(--wr39-accent) !important}
    .wr39w .muted{color:var(--wr39-dim) !important}.wr39w .good{color:var(--wr39-good) !important}.wr39w .bad{color:var(--wr39-bad) !important}.wr39w .warn{color:var(--wr39-warn) !important}
    .wr39w .card{background:var(--wr39-s2);border:1px solid var(--wr39-line);border-radius:var(--wr39-r2);padding:9px 11px;margin-bottom:8px}
    .wr39w .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .wr39w .kpi{flex:1;min-width:90px;background:var(--wr39-s2);border:1px solid var(--wr39-line);border-radius:var(--wr39-r2);padding:7px 9px}
    .wr39w .kpi b{display:block;font-size:17px;font-variant-numeric:tabular-nums}.wr39w .kpi span{font-size:12px;color:var(--wr39-muted) !important}
    .wr39w button.b{background:var(--wr39-s2);color:var(--wr39-text) !important;border:1px solid var(--wr39-line);border-radius:var(--wr39-r2);padding:5px 11px;font-size:12.5px;font-weight:600;cursor:pointer}
    .wr39w button.b:hover{border-color:var(--wr39-accent)}.wr39w button.b.pri{background:var(--wr39-accent-fill);border-color:var(--wr39-accent-fill);color:var(--wr39-accent-ink) !important}
    .wr39w button.b.pri:hover{background:var(--wr39-accent-fill-hover)}
    .wr39w button.b:disabled{opacity:.45;cursor:default}
    .wr39w button:focus-visible,.wr39w input:focus-visible,.wr39w select:focus-visible{outline:2px solid var(--wr39-accent);outline-offset:1px}
    .wr39w input,.wr39w select{background:var(--wr39-s1) !important;color:var(--wr39-text) !important;border:1px solid var(--wr39-line);border-radius:var(--wr39-r2);padding:5px 7px;font-size:13px}
    .wr39w input[type=checkbox],.wr39w input[type=radio],.wr39w input[type=range]{accent-color:var(--wr39-accent-fill)}
    .wr39w .pill{display:inline-block;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;font-size:12px;font-weight:700;padding:1px 8px;border-radius:999px;background:var(--wr39-s3);color:var(--wr39-muted) !important}
    .wr39w .pill.ok{background:var(--wr39-good-soft);color:var(--wr39-good) !important}.wr39w .pill.hosp{background:var(--wr39-bad-soft);color:var(--wr39-bad) !important}
    .wr39w .pill.trav{background:rgba(147,197,253,.14);color:var(--wr39-info) !important}.wr39w .pill.jail{background:var(--wr39-warn-soft);color:var(--wr39-warn) !important}
    .wr39w .bar{height:8px;background:var(--wr39-s3);border-radius:999px;overflow:hidden;margin:4px 0}.wr39w .bar i{display:block;height:100%;background:var(--wr39-accent-fill)}
    .wr39w .note{font-size:12.5px;color:var(--wr39-muted) !important;margin:6px 0}
    @media (max-width:640px){.wr39w{right:0;left:0;top:auto;bottom:0;width:100vw;max-height:80vh;border-radius:var(--wr39-r) var(--wr39-r) 0 0}}
  
  .wr39w .pill.good{background:var(--wr39-good-soft);color:var(--wr39-good) !important}.wr39w .pill.warn{background:var(--wr39-warn-soft);color:var(--wr39-warn) !important}
  .wr39w .tw-p{margin-left:auto}.wr39w .tw-p + .tw-k{margin-left:0}.wr39w .tw-k{margin-left:auto}.wr39w .tw-k + .tw-x{margin-left:0}
  .wr39w.pop{box-sizing:border-box;left:0 !important;top:0 !important;right:0 !important;bottom:0 !important;width:100vw !important;height:100vh;max-height:100vh !important;border-radius:0;border-left:0;border-right:0;z-index:2147483647}.wr39w.pop .tw-hd{cursor:default}
  .wr39w .tw-key{display:none;padding:10px 12px;border-bottom:1px solid var(--wr39-line);background:var(--wr39-s1)}.wr39w .tw-key.open{display:block}
  .wr39w .tw-key input{flex:1;min-width:0}
  #wr39-open{clear:both;display:block;width:100%;margin:10px 0;padding:9px 12px;box-sizing:border-box;border:1px solid var(--wr39-line);border-left:3px solid var(--wr39-accent-fill);border-radius:var(--wr39-r2);background:var(--wr39-s1);color:var(--wr39-text);font:600 13.5px/1.3 var(--wr39-font);text-align:left;cursor:pointer}
  #wr39-open:hover{border-color:var(--wr39-accent)}#wr39-open.on{background:var(--wr39-s3)}`);
function makeWindow(id, title, sub) {
  const el = document.createElement('div'); el.id = 'wr39w-' + id; el.className = 'wr39w'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', title);
  el.innerHTML = `<div class="tw-hd"><span class="tw-t">${esc(title)}</span><span class="tw-s">${esc(sub || '')}</span>${POPOUT ? '' : '<button type="button" class="b tw-p" title="Open in its own window, so it stays up while you change Torn pages">Own window</button>'}<button type="button" class="b tw-k">Key</button><button type="button" class="tw-x" aria-label="Close">✕</button></div>
    <div class="tw-key"><div class="row" style="flex-wrap:nowrap"><input type="password" autocomplete="off" placeholder="Torn API key (Public)" aria-label="Torn API key"><button type="button" class="b pri" data-k="save">Save</button><button type="button" class="b" data-k="clear">Remove</button></div>
    <div class="note" style="margin:6px 0 0">Kept on this device. Used only for the Torn API.</div></div><div class="tw-bd"></div>`;
  (document.body || document.documentElement).appendChild(el);
  const pos = POPOUT ? null : GM_getValue('winpos', null);
  if (POPOUT) el.classList.add('pop');
  if (pos && window.innerWidth > 640) { el.style.left = Math.max(0, Math.min(window.innerWidth - 80, pos.x)) + 'px'; el.style.top = Math.max(0, Math.min(window.innerHeight - 60, pos.y)) + 'px'; el.style.right = 'auto'; }
  el.querySelector('.tw-hd').addEventListener('pointerdown', (e) => {
    if (POPOUT || e.target.closest('button') || window.innerWidth <= 640) return;
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const mv = (ev) => { el.style.left = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx)) + 'px'; el.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + 'px'; el.style.right = 'auto'; };
    const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); const rr = el.getBoundingClientRect(); GM_setValue('winpos', { x: Math.round(rr.left), y: Math.round(rr.top) }); };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
  const body = el.querySelector('.tw-bd'), keyBox = el.querySelector('.tw-key');
  const w = {
    el, body,
    isOpen: () => el.classList.contains('open'),
    open() { el.classList.add('open'); if (!POPOUT) GM_setValue('winopen', true); if (!GM_getValue('api_key', '')) keyBox.classList.add('open'); w.onopen && w.onopen(); },
    close() { el.classList.remove('open'); if (!POPOUT) GM_setValue('winopen', false); w.onclose && w.onclose(); },
    wasOpen: () => !!GM_getValue('winopen', false),
    set(html) { body.innerHTML = html; },
  };
  el.querySelector('.tw-x').onclick = () => { if (POPOUT) { try { GM_setValue('popAt', 0); } catch (e) {} window.close(); } else w.close(); };
  // Your click opens your faction page in a small window of its own; War Room fills that window and this one is closed here.
  if (!POPOUT) el.querySelector('.tw-p').onclick = (e) => { if (!e.isTrusted) return; const win = window.open('https://www.torn.com/factions.php?step=your&type=1', POP_NAME, 'popup=yes,width=580,height=900'); if (win) w.close(); };
  el.querySelector('.tw-k').onclick = () => keyBox.classList.toggle('open');
  keyBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return; const inp = keyBox.querySelector('input');
    if (b.dataset.k === 'save') { const v = inp.value.trim(); if (!/^[A-Za-z0-9]{16}$/.test(v)) { inp.value = ''; inp.placeholder = 'A Torn key is 16 letters and numbers'; return; } GM_setValue('api_key', v); }
    else GM_setValue('api_key', '');
    inp.value = ''; cache.clear(); w.onkey && w.onkey(); keyBox.classList.toggle('open', !GM_getValue('api_key', '')); if (w.isOpen()) { w.close(); w.open(); }
  });
  return w;
}
const tucc = { esc, fmt, api, every, alert: alertUser, ui: { window: makeWindow }, menu: (label, fn) => { try { GM_registerMenuCommand(label, fn); } catch (e) {} } };

/* ---------- War Room ---------- */
const S = { stats: GM_getValue('stats', 'spy') === 'bsp' ? 'bsp' : 'spy', alerts: GM_getValue('alerts', true) !== false, filter: GM_getValue('filter', 'all'), chainWatch: !!GM_getValue('chainWatch', false), enemyManual: GM_getValue('enemyManual', ''), sort: GM_getValue('sort', ''), speed: [1, 5, 30].includes(Number(GM_getValue('speed', 5))) ? Number(GM_getValue('speed', 5)) : 5, feedUrl: String(GM_getValue('feedUrl', '') || ''), feedData: '', free: !!GM_getValue('free', false), site: !!GM_getValue('site', /^https:\/\/(www\.)?ultimata\.net\//.test(String(GM_getValue('feedUrl', '') || ''))) };
const save = () => { GM_setValue('stats', S.stats); GM_setValue('alerts', S.alerts); GM_setValue('filter', S.filter); GM_setValue('chainWatch', S.chainWatch); GM_setValue('enemyManual', S.enemyManual); GM_setValue('sort', S.sort); GM_setValue('speed', S.speed); GM_setValue('feedUrl', S.feedUrl); GM_setValue('feedData', S.feedData); GM_setValue('free', S.free); GM_setValue('site', S.site); };

/* ---------- battle stats shown in the table: the 39th site's spies, or Battle Stats Predictor's saved figures (your choice) ---------- */
const BSP = 'tdup.battleStatsPredictor.', BSP_LINK = 'https://www.torn.com/forums.php#/p=threads&f=67&t=16290324';
const ls = (k) => { try { const v = (typeof localStorage !== 'undefined' ? localStorage : window.localStorage).getItem(k); return v == null ? undefined : v; } catch (e) { return undefined; } };
const lsJson = (k) => { const v = ls(k); if (!v || v === '[object Object]') return null; try { return JSON.parse(v); } catch (e) { return null; } };
// Is BSP set up in this browser? Only checks that its "key is valid" flag exists; the key itself is never read.
const bspHere = () => ls(BSP + 'IsPrimaryAPIKeyValid') !== undefined;
// The figure BSP would show for this player: a recent spy first, else its prediction while BSP still treats it as current (5 days).
function bspOf(id) {
  let spy = null;
  for (const src of ['tornstats_', 'yata_']) { const o = lsJson(BSP + 'cache.spy_v2.' + src + id); if (o && Number(o.total) > 0 && (!spy || Number(o.timestamp) >= Number(spy.timestamp))) spy = o; }
  const spyAt = spy ? Number(spy.timestamp) * 1000 : 0, keep = (parseInt(ls(BSP + 'DaysToUseTornStatsSpy'), 10) || 30) * 86400000;
  if (spy && spyAt > Date.now() - keep) return { total: Number(spy.total), at: spyAt, label: 'BSP spy' };
  const p = lsJson(BSP + 'cache.prediction.' + id);
  if (!p || p.Result === 0 || p.Result === 4) return null;
  const at = Date.parse(p.DateFetched || p.PredictionDate || '') || 0;
  if (!at || at < Date.now() - 5 * 86400000) return null;
  const tbs = parseInt(String(p.TBS == null ? '' : p.TBS).replace(/[^\d.]/g, ''), 10);
  if (!(tbs > 0)) return null;
  return spy && Number(spy.total) > tbs ? { total: Number(spy.total), at: spyAt, label: 'BSP spy' } : { total: tbs, at, label: 'BSP prediction' };
}
const myTotal = () => { const o = lsJson(BSP + 'playerBattleStats'); if (!o) return 0; const t = Number(o.TBS) || [o.Str, o.Def, o.Spd, o.Dex].reduce((a, v) => a + (Number(v) || 0), 0); return t > 0 ? t : 0; };
const short = (n) => (n >= 1e12 ? (n / 1e12).toFixed(2) + 't' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'b' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)));
function statCell(b, mine) {
  if (!b) return '<span class="muted">–</span>';
  const r = mine ? b.total / mine : 0, cls = !mine ? '' : r <= 0.75 ? 'good' : r <= 1.25 ? 'warn' : 'bad';
  const days = b.at ? Math.floor((Date.now() - b.at) / 86400000) : -1;
  const tip = [['Strength', b.str], ['Defence', b.def], ['Speed', b.spd], ['Dexterity', b.dex]].filter((x) => x[1] > 0).map((x) => x[0] + ' ' + short(x[1]));
  if (days >= 0) tip.push((b.label || 'Spy') + ' ' + (days ? days + 'd old' : 'today'));
  return `<span class="${cls}" title="${esc(tip.join('\n'))}" style="cursor:help">${short(b.total)}</span>`;
}

let own = null;          // { id, name, at }
// 39th factions only: the five 39th tranches, by Torn faction ID.
const FACTIONS_39TH = [19, 16312, 7049, 22680, 31764];
let locked = false, lockedAs = '';
const lockErr = () => tornErr('39th factions only.', 'locked');
const blank = () => ({ war: null, enemy: null, members: [], ourChain: null, theirChain: null, at: 0, error: '' });
// Not a 39th faction: stop every timer and drop anything already loaded.
function lockOut(name, id) {
  locked = true; lockedAs = `${name || 'Faction'} [${id}]`; own = null; data = blank();
  Object.assign(feed, { live: false, dibs: null, error: '' });
  if (poll) { poll.stop(); poll = null; } if (chainPoll) { chainPoll.stop(); chainPoll = null; } if (watch) { watch.stop(); watch = null; }
  lastSig = ''; render();
}
let data = { war: null, enemy: null, members: [], ourChain: null, theirChain: null, at: 0, error: '' };
const nowS = () => Math.floor(clock() / 1000);

const w = tucc.ui.window('warroom39', '39th War Room', 'ranked war');
w.body.addEventListener('click', onClick);
w.body.addEventListener('change', onChange);

async function ownFaction() {
  if (locked) throw lockErr();
  if (own && Date.now() - own.at < 3600000) return own;   // membership is checked again every hour
  const j = await tucc.api('/v2/faction/basic', {}, { ttl: 3600 });
  const b = (j && j.basic) || {};
  if (!b.id) { own = null; throw new Error('You are not in a faction (or the key cannot see it).'); }
  if (!FACTIONS_39TH.includes(Number(b.id))) { lockOut(b.name, Number(b.id)); throw lockErr(); }
  own = { id: Number(b.id), name: b.name || 'Your faction', at: Date.now() };
  return own;
}

/* ---------- optional link to your own faction website's war data ---------- */
// Only the 39th site is accepted.
const SITE = 'ultimata.net';
function feedOk(u) {
  try { const x = new URL(String(u || '').trim()); return x.protocol === 'https:' && (x.hostname === SITE || x.hostname === 'www.' + SITE) && !x.username && !x.password; } catch (e) { return false; }
}
const warIdOf = (u) => { try { const m = new URL(u).pathname.match(/(\d+)\/?$/); return m ? Number(m[1]) : 0; } catch (e) { return 0; } };
// The war on the site: the number you gave, else the one found for the faction you are fighting.
const found = { id: 0, enemy: -1, at: 0 };
const siteId = () => (feedOk(S.feedUrl) && warIdOf(S.feedUrl)) || found.id || 0;
// A spy as the site holds it. "bs" is the battle score used for fair fight.
const spyOf = (d) => { if (!d || !(Number(d.total) > 0)) return null; const q = ['strength', 'defense', 'speed', 'dexterity'].map((k) => Number(d[k]) || 0); return { str: q[0], def: q[1], spd: q[2], dex: q[3], total: Number(d.total), at: Date.parse(d.spy_date || '') || 0, bs: q.every((v) => v > 0) ? q.reduce((a, v) => a + Math.sqrt(v), 0) : 0 }; };
const side = { me: null, meAt: 0, groups: [], groupsAt: 0 };
const ffOf = (m) => (side.me && side.me.bs && m.spy && m.spy.bs ? Math.min(3, 1 + (8 / 3) * m.spy.bs / side.me.bs) : 0);
const myTargets = () => new Set((feed.assigned || []).filter((x) => (myId && x.p === myId) || (x.p < 0 && side.groups.includes(-x.p))).map((x) => x.t));
// While the site is on it is read once a second. This costs no Torn API calls.
const feedMin = () => 900;
const feed = { fails: 0, retryAt: 0, live: false, ms: 0, error: '', open: false, found: 0, askedAt: 0, dibs: null, rules: null, assigned: [] };
const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return undefined; };
const looksLikeMember = (m) => !!m && typeof m === 'object' && pick(m, ['id', 'user_id', 'userId', 'userID', 'player_id', 'playerId', 'XID']) != null && pick(m, ['name', 'username', 'player_name', 'playerName']) != null;
// Finds the member list in whatever the site sends: a plain list, a list under a name such as "members", or a set keyed by player ID.
function seekMembers(o, depth) {
  if (!o || typeof o !== 'object' || depth > 4) return null;
  if (Array.isArray(o)) { if (o.length && o.filter(looksLikeMember).length >= Math.max(1, o.length * 0.6)) return o; for (const v of o.slice(0, 5)) { const r = seekMembers(v, depth + 1); if (r) return r; } return null; }
  const vals = Object.values(o), keys = Object.keys(o);
  if (vals.length && keys.every((k) => /^\d+$/.test(k)) && vals.filter((v) => v && typeof v === 'object' && pick(v, ['name', 'username', 'player_name', 'playerName']) != null).length >= Math.max(1, vals.length * 0.6)) return keys.map((k) => Object.assign({ id: Number(k) }, o[k]));
  for (const k of ['members', 'enemy', 'enemies', 'targets', 'data', 'war', 'result', 'players', ...keys]) { const r = o[k] && typeof o[k] === 'object' ? seekMembers(o[k], depth + 1) : null; if (r) return r; }
  return null;
}
// Only plain values are kept, turned into the same shape the Torn API uses for faction members.
function feedMembers(list) {
  const str = (v, n) => String(v == null ? '' : v).slice(0, n), num = (v) => (isFinite(Number(v)) ? Number(v) : 0);
  const secs = (v) => { const n = num(v); return n > 1e11 ? Math.floor(n / 1000) : n; };
  return list.slice(0, 250).map((m) => {
    const id = num(pick(m, ['id', 'user_id', 'userId', 'userID', 'player_id', 'playerId', 'XID'])); if (!(id > 0)) return null;
    const st = m.status, so = st && typeof st === 'object' ? st : {};
    let state = str(pick(so, ['state', 'status', 'name']) || (typeof st === 'string' ? st : '') || pick(m, ['state', 'status_state', 'statusState']), 20) || 'Okay';
    const desc = str(pick(so, ['description', 'details', 'text']) || pick(m, ['status_description', 'statusDescription', 'description']), 80);
    if (/hosp/i.test(state + ' ' + desc)) state = 'Hospital'; else if (/jail/i.test(state + ' ' + desc)) state = 'Jail'; else if (/travel|abroad|flying|returning/i.test(state + ' ' + desc)) state = /abroad/i.test(state) ? 'Abroad' : 'Traveling'; else if (/^ok/i.test(state)) state = 'Okay';
    const until = secs(pick(so, ['until', 'end', 'ends']) || pick(m, ['until', 'status_until', 'statusUntil', 'hospital_until', 'hospitalUntil', 'hosp_until', 'out_at']));
    const la = m.last_action || m.lastAction, lo = la && typeof la === 'object' ? la : {};
    const on = str(pick(lo, ['status', 'state']) || (typeof la === 'string' ? la : '') || pick(m, ['online', 'activity', 'online_status']), 12);
    return { id, spy: spyOf(m.spy), rev: m.reviveson === true, name: str(pick(m, ['name', 'username', 'player_name', 'playerName']), 40), level: num(pick(m, ['level', 'lvl'])), status: { state, description: desc, until }, last_action: { status: /^on/i.test(on) || on === 'true' ? 'Online' : /idle/i.test(on) ? 'Idle' : on ? 'Offline' : '', relative: str(pick(lo, ['relative', 'ago']), 40) } };
  }).filter(Boolean);
}
const feedGet = () => feedGetAt('https://' + SITE + '/api/war/' + siteId());
// Finds the current war on the site: the newest one against the faction you are fighting (or the newest, if none is known).
async function findWar(me, enemy) {
  found.at = Date.now(); found.enemy = enemy ? enemy.id : 0;
  const j = JSON.parse(await siteReq('GET', 'https://' + SITE + '/api/wars?selected_faction=' + encodeURIComponent(me.id) + '&search=&page=1&rowCount=20'));
  const list = (j && Array.isArray(j.wars) ? j.wars : []).filter((x) => x && x.active !== false && Number(x.id) > 0);
  const hit = enemy && enemy.id ? list.find((x) => Number(x.factionid) === enemy.id) : list[0];
  found.id = hit ? Number(hit.id) : 0;
  if (!found.id) throw new Error('No war on the site for this faction.');
}
// Dibs limits and assigned targets carried in the war data.
function siteExtras(j) {
  const a = (j && j.war && typeof j.war === 'object' && j.war) || {};
  feed.rules = { mine: Number(a.max_dibs_one_person) || 0, per: Number(a.max_dibs) || 0 };
  feed.push = { n: Number(a.medout_alert_count) || 0, secs: Number(a.medout_alert_window_seconds) || 0 };   // the site's own "several out early" setting for this war
  feed.assigned = (Array.isArray(a.wars_assigned_targets) ? a.wars_assigned_targets : []).slice(0, 500).map((x) => ({ t: Number(x && x.target_id) || 0, p: Number(x && x.player_id) || 0 })).filter((x) => x.t && x.p);
}
// Your own spy (hourly) for fair fight, and your target groups (every 10 minutes, only when a group has targets).
function siteSide(me) {
  if (!myId) return;
  const done = () => { lastSig = ''; render(); };
  if (Date.now() - side.meAt > 3600000) { side.meAt = Date.now(); siteReq('GET', 'https://' + SITE + '/api/spybase/player/' + myId + '?maxRange=15768000').then((t) => { side.me = spyOf((JSON.parse(t) || {}).data); done(); }).catch(() => {}); }
  if (feed.assigned.some((x) => x.p < 0) && Date.now() - side.groupsAt > 600000) { side.groupsAt = Date.now(); siteReq('GET', 'https://' + SITE + '/api/war/groups?facid=' + encodeURIComponent(me.id)).then((t) => { const g = (JSON.parse(t) || {}).groups; side.groups = (Array.isArray(g) ? g : []).filter((x) => (x.war_faction_group_players || []).some((q) => Number(q.player_id) === myId)).map((x) => Number(x.id)); done(); }).catch(() => {}); }
}
function feedGetAt(url) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    try {
      // No "anonymous" here on purpose: the browser attaches your own login for that site. No key or other header is added by TUCC.
      GM_xmlhttpRequest({ method: 'GET', url, headers: { Accept: 'application/json, text/plain, */*' }, timeout: 8000,
        onload: (r) => {
          const text = String(r.responseText || ''), head = text.trim().slice(0, 1);
          if (r.status === 401 || r.status === 403) return reject(new Error('The site refused: log in to it in this browser.'));
          if (r.status < 200 || r.status >= 300) return reject(new Error('The site answered with error ' + r.status + '.'));
          if (head === '<') { const e = new Error('Got a web page, not data. Log in to the site in this browser, or check the address.'); e.page = true; return reject(e); }
          let j = null; try { j = JSON.parse(text); } catch (e) { return reject(new Error('The reply is not data War Room can read.')); }
          const wd = j && j.warData && j.warData.data;
          const list = (wd && Array.isArray(wd.members) && wd.members.length ? wd.members : null) || seekMembers(j, 0);
          if (!list) return reject(new Error('Data received, but no member list found in it' + (j && typeof j === 'object' && !Array.isArray(j) ? ' (top level: ' + Object.keys(j).slice(0, 8).join(', ') + ').' : '.')));
          feed.ms = Date.now() - t0; feed.gotAt = Date.now(); resolve({ j, list });
        },
        onerror: () => reject(new Error('Could not reach the site (or the browser blocked it).')), ontimeout: () => reject(new Error('The site took too long to answer.')) });
    } catch (e) { reject(new Error('Could not reach the site.')); }
  });
}
// Dibs, if the site's data carries a list of them: which enemy is claimed, and by whom when the site says.
function seekDibs(o, depth) {
  if (!o || typeof o !== 'object' || depth > 2) return null;
  if (Array.isArray(o.dibs)) return o.dibs;
  if (o.dibs && typeof o.dibs === 'object') return Object.keys(o.dibs).map((k) => (o.dibs[k] && typeof o.dibs[k] === 'object' ? Object.assign({ target_id: /^\d+$/.test(k) ? Number(k) : undefined }, o.dibs[k]) : { target_id: Number(k), dibser_name: String(o.dibs[k]) }));
  if (Array.isArray(o)) return null;
  for (const k of Object.keys(o)) { const r = o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? seekDibs(o[k], depth + 1) : null; if (r) return r; }
  return null;
}
function feedDibs(list) {
  const out = {};
  for (const d of (list || []).slice(0, 500)) {
    if (!d || typeof d !== 'object') continue;
    const tgt = Number(pick(d, ['target_id', 'targetId', 'target', 'targetid', 'dibbed_id', 'dibbedId', 'enemy_id', 'enemyId', 'victim_id', 'player_id', 'playerId', 'XID']));
    if (!(tgt > 0)) continue;
    let who = pick(d, ['dibser_name', 'dibserName', 'dibser', 'by_name', 'byName', 'player_name', 'playername', 'username', 'user_name', 'name']);
    if (typeof who !== 'string' && d.player) { try { const q = typeof d.player === 'string' ? JSON.parse(d.player) : d.player; if (q && typeof q.name === 'string') who = q.name; } catch (e) {} }
    const by = Number(pick(d, ['dibser_id', 'dibserId', 'by_id', 'byId', 'by', 'user_id', 'userId'].concat(d.target_id != null || d.targetId != null ? ['player_id', 'playerId'] : []))) || 0;
    (out[tgt] = out[tgt] || []).push({ name: typeof who === 'string' ? who.slice(0, 30) : '', by });
  }
  return out;
}
// Placing a dib: one press sends one "dibs" message to your faction site over its own message channel (plain web
// requests, your browser's login for that site, nothing added by TUCC). This only fits sites built that way.
const siteReq = (method, url, body, ms) => new Promise((resolve, reject) => {
  try { GM_xmlhttpRequest({ method, url, data: body, headers: body != null ? { 'Content-Type': 'text/plain;charset=UTF-8' } : {}, timeout: ms || 6000,
    onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(String(r.responseText || '')) : reject(new Error(r.status === 401 || r.status === 403 ? 'The site refused: log in to it in this browser.' : 'The site answered with error ' + r.status + '.'))),
    onerror: () => reject(new Error('Could not reach the site.')), ontimeout: () => reject(new Error('The site did not answer.')) });
  } catch (e) { reject(new Error('Could not reach the site.')); }
});
const siteRoom = () => siteId();
let dibBusy = false;
async function siteDib(id, name) {
  const room = siteRoom(), origin = 'https://' + SITE;
  if (!room) throw new Error('No war found on the site.');
  const at = () => origin + '/socket.io/?EIO=4&transport=polling&t=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let hello;
  try { hello = await siteReq('GET', at()); } catch (e) { await siteReq('GET', origin + '/api/socket').catch(() => ''); hello = await siteReq('GET', at()); }
  const sid = (/"sid":"([\w-]+)"/.exec(hello) || [])[1];
  if (hello[0] !== '0' || !sid) throw new Error('This site does not take dibs this way.');
  const u = () => at() + '&sid=' + encodeURIComponent(sid);
  // Sites often keep each section on its own channel named after the page ("/war/123" -> "/war"); try that, then the plain one.
  const seg = 'war';
  let ch = '';
  for (const c of seg ? ['/' + seg + ',', ''] : ['']) {
    await siteReq('POST', u(), '40' + c);
    const joined = await siteReq('GET', u(), null, 4000).catch(() => '');
    if (joined.split('\x1e').some((pk) => pk.startsWith('40' + c))) { ch = c; break; }
    if (!seg || c === '') throw new Error('The site refused: log in to it in this browser.');
  }
  // Join the war first and give the site a moment to recognise you, then send the dib on its own.
  await siteReq('POST', u(), '42' + ch + JSON.stringify(['join-war-room', room]));
  await siteReq('GET', u(), null, 900).catch(() => '');
  await siteReq('POST', u(), '42' + ch + JSON.stringify(['dibs', Number(id), String(name), room]));
  // Listen briefly for the site's own "dibs" notice: it confirms the dib and carries the fresh list.
  let heard = false; const until = Date.now() + 3500;
  while (!heard && Date.now() < until) {
    const got = await siteReq('GET', u(), null, Math.max(300, until - Date.now())).catch(() => '');
    if (!got) break;
    for (const pk of got.split('\x1e')) { if (!pk.startsWith('42' + ch + '["dibs"')) continue; heard = true; try { const a = JSON.parse(pk.slice(2 + ch.length)); if (Array.isArray(a[1])) feed.dibs = feedDibs(a[1]); } catch (e) {} }
  }
  siteReq('POST', u(), '41' + ch, 3000).catch(() => '').then(() => siteReq('POST', u(), '1', 3000).catch(() => ''));   // hang up
  return heard;
}
let myId = 0;
const whoAmI = () => { if (!myId) tucc.api('/v2/user/basic', {}, { ttl: 3600 }).then((j) => { myId = Number(j && j.profile && j.profile.id) || 0; if (myId) { lastSig = ''; render(); } }).catch(() => {}); };
// The page to open for placing a dib: the address you pasted, if it is the page rather than the data address.
const sitePage = () => 'https://' + SITE + '/war/' + siteId();
const feedOn = () => S.site && siteId() > 0;

let busy = false, lastSig = '';
/* ---------- hospital exits: your dibbed target coming out, and several coming out early at once (a push) ---------- */
const seen = new Map();   // player id -> { hosp, until } as of the last reading
let outs = [];            // early exits: { t, id, name }
const pushRule = () => { const p = (siteLive() && feed.push) || {}; return { n: p.n >= 2 ? p.n : 3, secs: p.secs >= 10 ? p.secs : 60 }; };
const pushNow = () => { const r = pushRule(), cut = Date.now() - r.secs * 1000, list = outs.filter((o) => o.t >= cut); return list.length >= r.n ? list : null; };
function watchOuts(members, enemyId) {
  if (watchOuts.enemy !== enemyId) { seen.clear(); outs = []; watchOuts.enemy = enemyId; }   // a different faction: start afresh
  const first = !seen.size, n = nowS(), dibs = siteLive() ? feed.dibs : null;
  for (const m of members) {
    const was = seen.get(m.id), hosp = stateOf(m) === 'hospital' && !abroadHosp(m), until = Number(m.status && m.status.until) || 0;
    if (!first && was && was.hosp && !hosp) {
      const early = was.until - n > 3;
      if (early) outs.push({ t: Date.now(), id: m.id, name: m.name });
      const mine = myId && dibs && dibs[m.id] && dibs[m.id].some((x) => x.by === myId);
      if (mine && S.alerts) tucc.alert({ id: 'out-' + m.id, title: `${m.name} is out of hospital${early ? ' early' : ''}`, text: 'Your dibbed target. Click to open the attack page.', url: 'https://www.torn.com/page.php?sid=attack&user2ID=' + encodeURIComponent(m.id), repeatAfter: 20 });
    }
    seen.set(m.id, { hosp, until });
  }
  outs = outs.filter((o) => Date.now() - o.t < 300000);
  const p = pushNow();
  if (p && S.alerts) tucc.alert({ id: 'push-' + enemyId, title: `Push warning: ${p.length} out of hospital early`, text: p.slice(-6).map((o) => o.name).join(', '), repeatAfter: pushRule().secs });
}
// The war and both chains keep their own slower schedule whatever the refresh speed; only the member list is asked for every time.
const kept = {};
// A chain reply is stamped with the second it arrived, so its countdown runs from Torn's own deadline and not from when it was drawn.
const chainAt = (id) => { const sent = Date.now();   // only used to stop Torn handing back an older saved answer
  return tucc.api(`/v2/faction/${id}/chain`, { timestamp: Math.floor(sent / 1000) }, { ttl: 0 }).then((j) => { if (j && j.chain) { j.chain._due = Math.floor((clock() - 200) / 1000) + (Number(j.chain.timeout) || 0); } return j; }); };
// A fresh reading within a second of the last one keeps the old deadline, so the countdown never jitters and the window is not redrawn for nothing.
const steady = (prev, c) => { if (c && prev && prev !== c && prev._due && c._due && Number(prev.current) === Number(c.current) && Math.abs(prev._due - c._due) <= 1) c._due = Math.min(prev._due, c._due); return c; };
const chainKey = (c) => c && [c.current, c.max, c._due, Number(c.cooldown) > 0];
// How long a chain reading is kept before Torn is asked again (seconds). With the site live, a change in the site's
// chain count asks at once, so the wait can be long. In the last 90 seconds of a chain it is asked every 2 to 2.5 seconds.
const near = (c) => { if (!c || !(Number(c.current) > 0) || !c._due) return false; const t = c._due - nowS(); return t > 0 && t < 90; };
const siteLive = () => feedOn() && feed.live;
const ourGap = () => (near(data.ourChain) ? (siteLive() ? 2 : 2.5) : 4.5);   // our chain: every 5 seconds
const theirGap = () => (near(data.theirChain) && siteLive() ? 5 : 30);
// Enemy members from the Torn API (only when the site is not live): never more often than every 2.4 seconds.
const memberTtl = () => (S.speed >= 30 ? 20 : Math.max(near(data.ourChain) ? 5 : 2.4, S.speed * 0.8));
const slow = (name, secs, fn) => { const k = kept[name]; if (k && k.p) return k.p; if (k && Date.now() - k.at < secs * 1000) return Promise.resolve(k.v); const p = fn().then((v) => { kept[name] = { at: Date.now(), v }; return v; }, (e) => { if (kept[name]) kept[name].p = null; throw e; }); kept[name] = Object.assign(k || { at: 0, v: null }, { p }); return p; };
async function load() {
  if (locked) { render(); return; }
  if (busy) return;                      // the last refresh is still waiting its turn: don't stack another
  busy = true;
  const began = Date.now();
  try {
    const me = await ownFaction();
    let war = null, enemy = null;
    try {
      const wj = await slow('wars', 55, () => tucc.api(`/v2/faction/${me.id}/wars`, {}, { ttl: 60 }));
      const r = wj && wj.wars && wj.wars.ranked;
      if (r && Array.isArray(r.factions) && !(r.end && r.end < nowS() && r.winner)) {
        war = r;
        const e = r.factions.find((f) => Number(f.id) !== me.id);
        if (e) enemy = { id: Number(e.id), name: e.name || ('Faction ' + e.id) };
      }
    } catch (e) { if (e.code === 'nokey') throw e; }
    if (!enemy && /^\d+$/.test(String(S.enemyManual))) enemy = { id: Number(S.enemyManual), name: 'Faction ' + S.enemyManual, manual: true };
    const jobs = [slow('chain:' + me.id, ourGap(), () => chainAt(me.id)).catch(() => null)];
    // Members: from your faction site when an address is set and answering; otherwise from the Torn API.
    let fromFeed = null;
    if (S.site && !(feedOk(S.feedUrl) && warIdOf(S.feedUrl)) && (Date.now() - found.at > 300000 || found.enemy !== (enemy ? enemy.id : 0))) { try { await findWar(me, enemy); feed.retryAt = 0; } catch (e) { feed.error = e.message; } }
    if (feedOn() && Date.now() >= feed.retryAt && Date.now() - feed.askedAt < feedMin() && data.members.length && feed.live) fromFeed = data.members;
    else if (feedOn() && Date.now() >= feed.retryAt) {
      feed.askedAt = Date.now();
      try { const r = await feedGet(); fromFeed = feedMembers(r.list); feed.found = fromFeed.length; { const dl = seekDibs(r.j, 0); feed.dibs = dl ? feedDibs(dl) : null; } feed.fails = 0; feed.live = true; feed.error = ''; siteExtras(r.j); whoAmI(); siteSide(me);
        const wd = r.j && r.j.warData && r.j.warData.data;
        // Score and chain counts as the site has them. A changed chain count means a hit landed: ask Torn for the new timer now.
        const rk = wd && wd.ranked && Array.isArray(wd.ranked.factions) ? wd.ranked.factions.map((f) => ({ id: Number(f.id), score: Number(f.score) || 0, chain: Number(f.chain) || 0 })) : null;
        if (rk && feed.rk) rk.forEach((f) => { const o = feed.rk.find((x) => x.id === f.id); if (o && o.chain !== f.chain && kept['chain:' + f.id]) kept['chain:' + f.id].at = 0; });
        feed.rk = rk;
        if (!enemy && wd && Number(wd.id) > 0) enemy = { id: Number(wd.id), name: String(wd.name || 'Faction ' + wd.id).slice(0, 60) };
        const fe = r.j && typeof r.j === 'object' && (r.j.enemy || r.j.enemy_faction || r.j.opponent);
        if (!enemy && fe && Number(fe.id) > 0) enemy = { id: Number(fe.id), name: String(fe.name || 'Faction ' + fe.id).slice(0, 60) };
        if (!enemy) enemy = { id: 0, name: 'Faction site' };
      } catch (e) { feed.error = e.message; if (++feed.fails >= 3 || !feed.live) { feed.live = false; feed.retryAt = Date.now() + 30000; feed.fails = 0; } }
    } else if (!feedOn()) { feed.live = false; if (!S.site) feed.error = ''; feed.dibs = null; feed.rules = null; feed.assigned = []; feed.rk = null; }
    if (enemy) {
      jobs.push(fromFeed ? Promise.resolve({ members: fromFeed }) : feedOn() && feed.live && data.members.length ? Promise.resolve({ members: data.members }) : !enemy.id ? Promise.resolve({ members: [] }) : tucc.api(`/v2/faction/${enemy.id}/members`, {}, { ttl: memberTtl() }).catch((e) => ({ __err: e })));
      jobs.push(!enemy.id ? Promise.resolve(null) : slow('chain:' + enemy.id, theirGap(), () => chainAt(enemy.id)).catch(() => null));
    }
    const [oc, mj, tc] = await Promise.all(jobs);
    data = { war, enemy, members: [], ourChain: steady(data.ourChain, oc && oc.chain), theirChain: steady(data.theirChain, tc && tc.chain), at: Date.now(), error: '' };
    if (mj && mj.__err) data.error = mj.__err.message;
    else if (mj) {
      const list = Array.isArray(mj.members) ? mj.members : Object.entries(mj.members || {}).map(([id, m]) => Object.assign({ id: Number(id) }, m));
      data.members = list.filter((m) => m && m.id);
      if (data.members.length) watchOuts(data.members, enemy ? enemy.id : 0);
    }
  } catch (e) {
    if (e.code === 'locked') { busy = false; return; }
    data = Object.assign({}, data, { error: e.code === 'nokey' ? 'Add your API key with the Key button. A Public key is enough.' : e.message, at: Date.now() });
  }
  busy = false;
  // Redraw only when something changed, so the list doesn't flicker or lose your place every second.
  const d = data, sig = JSON.stringify([S.site, siteId(), feedOn(), feed.live, feed.error, feed.urlErr, feed.found, feed.dibs, feed.rules, feed.assigned, feed.rk && feed.rk.map((f) => f.score), S.alerts, (pushNow() || []).map((o) => o.id), side.me && side.me.total, side.groups, d.error, d.war && d.war.factions, d.enemy, chainKey(d.ourChain), chainKey(d.theirChain), d.members.map((m) => [m.id, m.name, m.level, m.status, m.last_action && m.last_action.status, m.spy && m.spy.total, m.rev])]) + (fullAt && Date.now() - fullAt < 20000 ? 's' : '');
  saveSnap();
  if (sig === lastSig && w.body.querySelector('table')) return;
  lastSig = sig;
  render();
}

const stateOf = (m) => String((m.status && m.status.state) || 'Okay').toLowerCase();
const online = (m) => String((m.last_action && m.last_action.status) || '').toLowerCase();
// In a hospital in another country ("In a Swiss hospital for 20 mins"): not in Torn, so not a target when the timer ends.
const abroadHosp = (m) => stateOf(m) === 'hospital' && /^in an? .+ hospital/i.test(String((m.status && m.status.description) || '').trim());
function group(m) {
  const s = stateOf(m);
  if (abroadHosp(m)) return 'travel';
  if ((s === 'hospital' || s === 'jail') && Number(m.status && m.status.until) > 0 && Number(m.status.until) <= nowS()) return 'okay';   // timer ran out: free now
  if (s === 'okay') return 'okay';
  if (s === 'hospital') return 'hospital';
  if (s === 'traveling' || s === 'travelling' || s === 'abroad') return 'travel';
  if (s === 'jail') return 'jail';
  return 'other';
}
const rank = { okay: 0, hospital: 1, jail: 2, travel: 3, other: 4 };
const onRank = { online: 0, idle: 1, offline: 2 };
function sorted(list) {
  return list.slice().sort((a, b) => {
    const ga = group(a), gb = group(b);
    if (ga !== gb) return rank[ga] - rank[gb];
    if (ga === 'okay') return (onRank[online(a)] ?? 3) - (onRank[online(b)] ?? 3);
    if (ga === 'hospital' || ga === 'jail') return (Number(a.status.until) || 0) - (Number(b.status.until) || 0);
    return 0;
  });
}
// A short form of the travel text ("To UK", "From UK", "In UK"); the full text shows on hover.
const PLACE = { 'United Kingdom': 'UK', 'United Arab Emirates': 'UAE', 'South Africa': 'S. Africa', 'Cayman Islands': 'Caymans' };
function trip(desc) {
  const d = String(desc || '').trim(), place = (x) => PLACE[x.trim()] || x.trim();
  let m = /^(?:travell?ing|flying) from (.+?) to (.+)$/i.exec(d);
  if (m) return /^torn$/i.test(m[2].trim()) ? 'From ' + place(m[1]) : 'To ' + place(m[2]);
  m = /^returning to torn from (.+)$/i.exec(d); if (m) return 'From ' + place(m[1]);
  m = /^travell?ing to (.+)$/i.exec(d); if (m) return 'To ' + place(m[1]);
  m = /^in (.+)$/i.exec(d); if (m) return 'In ' + place(m[1]);
  return d || 'Travelling';
}
function pill(m) {
  const g = group(m), until = Number(m.status && m.status.until) || 0;
  const left = until > nowS() ? `<span data-until="${until}">${fmt.dur(until - nowS())}</span>` : '';
  if (g === 'okay') return '<span class="pill ok">Okay</span>';
  if (g === 'hospital') return `<span class="pill hosp">Hosp ${left}</span>`;
  if (g === 'jail') return `<span class="pill jail">Jail ${left}</span>`;
  if (g === 'travel' && abroadHosp(m)) return `<span class="pill trav" title="${esc(m.status.description || '')}">Hosp abroad ${left}</span>`;
  if (g === 'travel') return `<span class="pill trav" title=""${esc(m.status.description || '')}">${esc(trip(m.status.description))}</span>`;
  return `<span class="pill">${esc((m.status && m.status.state) || '?')}</span>`;
}
const atk = (m) => `<a href="https://www.torn.com/page.php?sid=attack&amp;user2ID=${encodeURIComponent(m.id)}" title="Open attack page">${esc(m.name || m.id)}</a>`;
const dot = (m) => { const o = online(m); return `<span title="${esc((m.last_action && m.last_action.relative) || '')}" class="${o === 'online' ? 'good' : o === 'idle' ? 'warn' : 'muted'}">●</span>`; };

function chainKpi(label, c) {
  if (!c) return `<div class="kpi"><b>–</b><span>${label}</span></div>`;
  const due = c._due || nowS() + (Number(c.timeout) || 0), t = Math.max(0, due - nowS()), cur = Number(c.current) || 0;
  const live = cur > 0 && t > 0 ? ` · <span data-left="${due}" class="${t < 90 ? 'bad' : ''}">${fmt.dur(t)}</span>` : (Number(c.cooldown) > 0 ? ` · cooldown ${fmt.dur(c.cooldown)}` : '');
  return `<div class="kpi"><b>${fmt.num(cur)}${c.max ? `<span class="muted" style="font-size:12px"> / ${fmt.num(c.max)}</span>` : ''}</b><span>${label}${live}</span></div>`;
}

function render() {
  if (!w.isOpen()) return;
  if (locked) { w.set(`<div class="card"><b>39th factions only</b><div class="note" style="margin-bottom:0">${esc(lockedAs)}</div></div>`); return; }
  const d = data, war = d.war;
  const filters = [['all', 'All'], ['okay', 'Okay'], ['hospital', 'Hospital'], ['travel', 'Travelling'], ['jail', 'Jail'], ['online', 'Online']];
  let html = '';
  if (d.error) html += `<div class="card bad">${esc(d.error)}</div>`;
  const push = d.enemy ? pushNow() : null;
  if (push) html += `<div class="card bad" data-push><b>Push warning</b> · ${push.length} out of hospital early in the last ${pushRule().secs}s<div class="note" style="margin:4px 0 0">${push.slice(-8).map((o) => esc(o.name)).join(', ')}</div></div>`;
  if (war) {
    const sc = (f) => { const x = siteLive() && feed.rk && feed.rk.find((y) => y.id === Number(f.id)); return Object.assign({}, f, x ? { score: x.score } : {}); };
    const us = sc(war.factions.find((f) => Number(f.id) === (own && own.id)) || {}), them = sc(war.factions.find((f) => Number(f.id) !== (own && own.id)) || {});
    const st = Number(war.start) || 0;
    const when = st > nowS() ? `starts in <span data-left="${st}">${fmt.dur(st - nowS())}</span>` : `running ${fmt.dur(nowS() - st)}`;
    html += `<div class="row" style="margin-bottom:8px"><div class="kpi"><b>${fmt.num(us.score)} <span class="muted">vs</span> ${fmt.num(them.score)}</b><span>${esc(us.name || 'Us')} vs ${esc(them.name || 'Them')}${war.target ? ` · target ${fmt.num(war.target)}` : ''}</span></div><div class="kpi"><b style="font-size:13px">${when}</b><span>Ranked war</span></div></div>`;
  } else if (own || S.enemyManual) {
    const m = S.enemyManual;
    html += `<div class="card"><div class="note" style="margin-top:0">${m ? `Watching faction <b>[${esc(m)}]</b> by ID. Change it or stop watching:` : 'No ranked war found for your faction. Watch another faction by ID:'}</div>
      <div class="row"><input type="text" data-enemy value="${esc(m)}" placeholder="Enemy faction ID" inputmode="numeric" style="width:140px"><button type="button" class="b pri" data-act="enemy">${m ? 'Change' : 'Watch'}</button>${m ? '<button type="button" class="b" data-act="clear">Stop watching this faction</button>' : ''}</div></div>`;
  }
  html += `<div class="row" style="margin-bottom:8px">${chainKpi('Our chain', d.ourChain)}${d.enemy ? chainKpi('Their chain', d.theirChain) : ''}</div>`;
  html += `<label class="row note" style="margin:0 0 8px;flex-wrap:nowrap;align-items:flex-start"><input type="checkbox" style="margin-top:2px;flex:none" data-chainwatch${S.chainWatch ? ' checked' : ''}> Chain watch: alert me when our chain is about to time out (checks every 30s while a Torn tab is open)</label>`;
  html += `<label class="row note" style="margin:0 0 8px"><input type="checkbox" data-alerts${S.alerts ? ' checked' : ''}> Alerts: dibbed target out · push warning</label>`;
  // The speed buttons only matter when the Torn API supplies the list; with the site live it is read every second.
  const speedBtns = siteLive() ? '' : `<span class="muted">Refresh</span>${[[1, '1s'], [5, '5s'], [30, '30s']].map(([v, l]) => `<button type="button" class="b${S.speed === v ? ' pri' : ''}" data-speed="${v}">${l}</button>`).join('')}`;
  html += `<div class="row" style="margin-bottom:6px">${speedBtns}${fullAt && Date.now() - fullAt < 20000 ? '<span class="warn" title="This minute\'s 40 Torn API calls are used; the next ones wait their turn">API limit reached</span>' : ''}<button type="button" class="b${S.site ? ' pri' : ''}" data-act="feed" style="margin-left:auto">Site</button>${S.site ? (feed.live ? `<span class="good" data-age title="${feed.found} members, ${feed.ms} ms">● live</span>` : `<span class="warn" title="${esc(feed.error)}">● using API</span>`) : ''}</div>`;
  if (feed.open) html += `<div class="card"><div class="row"><input type="text" data-feedurl value="${esc(feedOk(S.feedUrl) && warIdOf(S.feedUrl) ? warIdOf(S.feedUrl) : '')}" placeholder="War number (blank = current war)" inputmode="numeric" style="flex:1 1 200px"><button type="button" class="b pri" data-act="feedsave">${S.site ? 'Save' : 'Turn on'}</button>${S.site ? '<button type="button" class="b" data-act="feedclear">Turn off</button>' : ''}</div>${feed.urlErr || (S.site && feed.error) ? `<div class="note bad">${esc(feed.urlErr || feed.error)}</div>` : feedOn() && feed.live ? `<div class="note good">War ${siteId()} · ${feed.found} members</div>` : ''}<div class="note" style="margin-bottom:0"><a href="https://${SITE}/" target="_blank" rel="noopener">${SITE}</a></div></div>`;
  if (d.enemy) {
    const ms = d.members;
    const next = ms.filter((m) => group(m) === 'hospital' && Number(m.status.until) > nowS()).sort((a, b) => a.status.until - b.status.until).slice(0, 5);
    const counts = { okay: 0, hospital: 0, travel: 0, jail: 0, online: 0 };
    ms.forEach((m) => { counts[group(m)] = (counts[group(m)] || 0) + 1; if (online(m) === 'online') counts.online++; });
    const live = feedOn() && feed.live, dibs = live ? feed.dibs : null;
    const rules = (live && feed.rules) || { mine: 0, per: 0 }, mineN = dibs && myId ? Object.keys(dibs).filter((k) => dibs[k].some((x) => x.by === myId)).length : 0, capped = rules.mine > 0 && mineN >= rules.mine;
    const yours = live ? myTargets() : new Set();
    if (yours.size) { filters.push(['mine', 'Mine']); counts.mine = yours.size; }
    const dibBtn = (m, label) => `<button type="button" class="b" data-act="dib" data-id="${esc(m.id)}" data-name="${esc(m.name || '')}"${dibBusy || (label === 'Dib' && capped) ? ' disabled' : ''}${label === 'Dib' && capped ? ' title="Dibs limit reached"' : ''}>${label}</button>`;
    const dibCell = (m) => { const d = dibs[m.id]; if (!d) return dibBtn(m, 'Dib'); const mine = myId && d.some((x) => x.by === myId); return `<span class="pill ${mine ? 'good' : 'warn'}">${esc(d.map((x) => x.name || (x.by ? '#' + x.by : 'Dibbed')).join(', '))}</span>${mine ? ' ' + dibBtn(m, 'Undib') : rules.per > d.length ? ' ' + dibBtn(m, 'Dib') : ''}`; };
    const tag = (m) => `${m.rev ? ' <span class="good" title="Revives on" style="font-size:15px;line-height:1">♥</span>' : ''}${yours.has(m.id) ? ' <span class="pill good">Yours</span>' : ''}`;
    whoAmI();
    const nextUp = dibs && S.free ? next.filter((m) => !dibs[m.id]) : next;
    html += `<div class="row" style="margin-bottom:6px">${filters.map(([k, l]) => `<button type="button" class="b${(S.filter === 'mine' && !yours.size ? 'all' : S.filter) === k ? ' pri' : ''}" data-filter="${k}">${l}${k === 'all' ? ` ${ms.length}` : counts[k] != null ? ` ${counts[k]}` : ''}</button>`).join('')}</div>`;
    const flt = S.filter === 'mine' && !yours.size ? 'all' : S.filter;
    let shown = sorted(ms).filter((m) => flt === 'all' || (flt === 'online' ? online(m) === 'online' : flt === 'mine' ? yours.has(m.id) : group(m) === flt));
    if (dibs && S.free) shown = shown.filter((m) => !dibs[m.id]);
    // Anyone in "Out of hospital next" is not repeated in the list below.
    const upIds = new Set(nextUp.map((m) => m.id)); shown = shown.filter((m) => !upIds.has(m.id));
    // Stats: the site's spies or BSP's saved figures. You choose when both are there; otherwise whichever exists is used.
    const hasSpy = live && ms.some((m) => m.spy), hasBsp = bspHere();
    const src = hasSpy && hasBsp ? S.stats : hasBsp ? 'bsp' : hasSpy ? 'spy' : '';
    const col = !!src, mine = (side.me && side.me.total) || (hasBsp ? myTotal() : 0), st = {};
    // Fair fight needs each side's four stats. With only a total (BSP), an even split is assumed and the figure is marked "~".
    const myBs = (side.me && side.me.bs) || (mine ? 2 * Math.sqrt(mine) : 0), ffCol = col && myBs > 0;
    const ffCell = (m) => { const b = st[m.id]; if (!b) return '<span class="muted">–</span>'; const est = !b.bs || !(side.me && side.me.bs), f = Math.min(3, 1 + (8 / 3) * (b.bs || 2 * Math.sqrt(b.total)) / myBs); return `<span${est ? ' title="Estimate from totals" style="cursor:help"' : ''}>${est ? '~' : ''}x${+f.toFixed(2)}</span>`; };
    if (col) {
      shown.concat(nextUp).forEach((m) => { st[m.id] = (src === 'bsp' ? bspOf(m.id) : m.spy) || null; });
      if (S.sort) shown = shown.slice().sort((a, b) => { const x = st[a.id], y = st[b.id]; if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1); return S.sort === 'up' ? x.total - y.total : y.total - x.total; });
    }
    if (dibs && feed.dibErr) html += `<div class="note bad" style="margin:0 0 6px">${esc(feed.dibErr)}</div>`;
    if (dibs) html += `<label class="row note" style="margin:0 0 6px"><input type="checkbox" data-free${S.free ? ' checked' : ''}> Hide dibbed (${Object.keys(dibs).length})${rules.mine ? ` · yours ${mineN}/${rules.mine}` : ''}</label>`;
    if (hasBsp) html += `<div class="row note" style="margin:0 0 6px"><span>Stats</span>${hasSpy ? [['spy', 'Spy'], ['bsp', 'BSP']].map(([k, l]) => `<button type="button" class="b${src === k ? ' pri' : ''}" data-stats="${k}">${l}</button>`).join('') : '<span class="pill">BSP</span>'}<a href="${BSP_LINK}" target="_blank" rel="noopener">BSP terms</a></div>`;
    const cols = (col ? 5 : 4) + (ffCol ? 1 : 0) + (dibs ? 1 : 0);
    const rowOf = (m, cls) => `<tr${cls ? ` class="${cls}"` : ''}><td>${dot(m)}</td><td>${atk(m)}${tag(m)}</td><td class="n">${fmt.num(m.level)}</td>${col ? `<td class="n">${statCell(st[m.id], mine)}</td>` : ''}${ffCol ? `<td class="n">${ffCell(m)}</td>` : ''}<td>${pill(m)}</td>${dibs ? `<td>${dibCell(m)}</td>` : ''}</tr>`;
    // "Out of hospital next" heads the table as its own rows, soonest first, in the same columns as everyone else.
    const upRows = nextUp.length ? `<tr><td colspan="${cols}" class="sec">Out of hospital next</td></tr>${nextUp.map((m) => rowOf(m, 'up')).join('')}` : '';
    html += `<table><thead><tr><th></th><th>Name</th><th class="n">Lvl</th>${col ? `<th class="n"><a href="#" data-act="sort" title="Sort by stats">Stats${S.sort === 'up' ? ' ▴' : S.sort === 'down' ? ' ▾' : ''}</a></th>` : ''}${ffCol ? '<th class="n">FF</th>' : ''}<th>Status</th>${dibs ? '<th>Dibs</th>' : ''}</tr></thead><tbody>${upRows}${shown.map((m) => rowOf(m)).join('') || (upRows ? '' : `<tr><td colspan="${cols}" class="muted">Nobody in this filter.</td></tr>`)}</tbody></table>`;
    html += `<div class="note">${esc(d.enemy.name)}${d.enemy.id ? ` [${d.enemy.id}]` : ''}${d.enemy.manual ? ` · <a href="#" data-act="clear">stop watching</a>` : ''} · updated <span data-ago>${d.at ? fmt.ago(Math.floor(d.at / 1000)) : '–'}</span> · refreshes every ${siteLive() || S.speed === 1 ? 'second' : S.speed + 's'} while open. Names open the attack page when you click them.</div>`;
  }
  // Keep whatever is being typed (and the cursor) across a redraw.
  const typed = [...w.body.querySelectorAll('input[data-feedurl],input[data-enemy]')].map((el) => ({ sel: el.matches('[data-feedurl]') ? '[data-feedurl]' : '[data-enemy]', v: el.value, on: document.activeElement === el, a: el.selectionStart, b: el.selectionEnd, dirty: el.value !== el.defaultValue }));
  w.set(html);
  for (const k of typed) { const el = w.body.querySelector('input' + k.sel); if (!el) continue; if (k.dirty) el.value = k.v; if (k.on) { el.focus(); try { el.setSelectionRange(k.a, k.b); } catch (e) {} } }
}

function onClick(e) {
  const sp = e.target.closest('[data-speed]');
  if (sp) { S.speed = Number(sp.dataset.speed); save(); lastSig = ''; render(); restart(); return; }
  const sb = e.target.closest('[data-stats]');
  if (sb) { S.stats = sb.dataset.stats === 'bsp' ? 'bsp' : 'spy'; save(); lastSig = ''; render(); return; }
  const f = e.target.closest('[data-filter]');
  if (f) { S.filter = f.dataset.filter; save(); render(); return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  if (a.dataset.act === 'feed') { feed.open = !feed.open; render(); return; }
  if (a.dataset.act === 'dib') {
    if (!e.isTrusted || dibBusy || locked || !feedOn()) return;
    dibBusy = true; lastSig = ''; render();
    siteDib(a.dataset.id, a.dataset.name).then((heard) => { feed.dibErr = heard ? '' : 'Sent, but the site did not confirm it.'; }, (err) => { feed.dibErr = err.message; })
      .then(() => { dibBusy = false; feed.askedAt = 0; lastSig = ''; render(); setTimeout(() => { if (poll) poll.now(); }, 700); });
    return;
  }
  const siteReset = (open) => { Object.assign(feed, { fails: 0, retryAt: 0, live: false, error: '', urlErr: '', found: 0, dibs: null, rules: null, assigned: [], open }); Object.assign(found, { id: 0, enemy: -1, at: 0 }); lastSig = ''; };
  if (a.dataset.act === 'feedsave') {
    let u = ((w.body.querySelector('[data-feedurl]') || {}).value || '').trim();
    if (/^\d+$/.test(u)) u = 'https://' + SITE + '/war/' + u;
    if (u && !(feedOk(u) && warIdOf(u))) { feed.urlErr = 'Use a war number.'; lastSig = ''; render(); return; }
    S.feedUrl = u; S.site = true; save(); siteReset(true); render(); restart(); return;
  }
  if (a.dataset.act === 'feedclear') { S.feedUrl = ''; S.site = false; save(); siteReset(false); render(); restart(); return; }
  if (a.dataset.act === 'sort') { e.preventDefault(); S.sort = S.sort === '' ? 'up' : S.sort === 'up' ? 'down' : ''; save(); render(); return; }
  if (a.dataset.act === 'enemy') {
    const v = (w.body.querySelector('[data-enemy]') || {}).value || '';
    if (/^\d+$/.test(v.trim())) { S.enemyManual = v.trim(); save(); load(); }
    else if (!v.trim() && S.enemyManual) { S.enemyManual = ''; save(); data = Object.assign({}, data, { enemy: null, members: [], theirChain: null, error: '' }); render(); load(); }
  } else if (a.dataset.act === 'clear') { e.preventDefault(); S.enemyManual = ''; save(); data = Object.assign({}, data, { enemy: null, members: [], theirChain: null, error: '' }); render(); load(); }
}
function onChange(e) {
  if (e.target.matches('[data-alerts]')) { S.alerts = e.target.checked; save(); }
  if (e.target.matches('[data-chainwatch]')) { S.chainWatch = e.target.checked; save(); startWatch(); }
  if (e.target.matches('[data-free]')) { S.free = e.target.checked; save(); render(); }
}

// live countdowns (display only)
setInterval(() => {
  if (!w.isOpen()) return;
  const n = nowS();
  const ag = w.body.querySelector('[data-ago]'); if (ag && data.at) ag.textContent = fmt.ago(Math.floor(data.at / 1000));
  let freed = false;
  w.body.querySelectorAll('[data-until],[data-left]').forEach((el) => { const t = Number(el.dataset.until || el.dataset.left); if (t > n) el.textContent = fmt.dur(t - n); else { el.textContent = 'now'; if (el.dataset.until) freed = true; } });
  // How old the site's data is, once it is more than a few seconds.
  const ag2 = w.body.querySelector('[data-age]'); if (ag2 && feed.gotAt) { const old = Math.floor((Date.now() - feed.gotAt) / 1000); ag2.textContent = old >= 6 ? '● ' + old + 's old' : '● live'; ag2.className = old >= 6 ? 'warn' : 'good'; }
  if (!!w.body.querySelector('[data-push]') !== !!(data.enemy && pushNow())) freed = true;   // push warning appears or clears on time
  if (freed) { lastSig = ''; render(); }   // a hospital or jail timer just ran out: show them as Okay this second
}, 1000);

// refresh while open, at the speed you chose (30s, 5s or 1s)
let poll = null, chainPoll = null;
function restart() {
  if (poll) { poll.stop(); poll = null; }
  if (chainPoll) { chainPoll.stop(); chainPoll = null; }
  if (!w.isOpen() || locked) return;
  const mine = {};
  poll = tucc.every((S.site ? 1 : S.speed) * 1000, () => { if (w.isOpen() && poll === mine.h) load(); }); mine.h = poll;
  poll.now();
  // Our own chain has its own fast look at every speed, so a new hit resets the countdown at once:
  // every second when the member list comes from your faction site, else every 2s (3s at the 1s speed, to leave room for members).
  const cm = {}; chainPoll = tucc.every(1000, async () => { if (!w.isOpen() || chainPoll !== cm.h || !data.at) return; try { const me = await ownFaction(); const j = await slow('chain:' + me.id, ourGap(), () => chainAt(me.id)); if (j && j.chain && j.chain !== data.ourChain) { const was = JSON.stringify(chainKey(data.ourChain)); data.ourChain = steady(data.ourChain, j.chain); if (JSON.stringify(chainKey(data.ourChain)) !== was) { lastSig = ''; render(); } } } catch (e) {} }); cm.h = chainPoll;
}
w.onopen = () => { lastSig = ''; render(); if (!poll) restart(); else poll.now(); };
// A new or removed key is checked from scratch.
w.onkey = () => { try { GM_setValue('snap', ''); } catch (e) {} Object.assign(side, { me: null, meAt: 0, groups: [], groupsAt: 0 }); Object.assign(found, { id: 0, enemy: -1, at: 0 }); own = null; locked = false; lockedAs = ''; myId = 0; Object.keys(kept).forEach((k) => delete kept[k]); data = blank(); lastSig = ''; startWatch(); };
w.onclose = () => { if (poll) { poll.stop(); poll = null; } if (chainPoll) { chainPoll.stop(); chainPoll = null; } };

// chain watch (your switch): own chain only
let watch = null;
function startWatch() {
  if (watch) { watch.stop(); watch = null; }
  if (!S.chainWatch || locked) return;
  const mine = {};
  watch = tucc.every(30000, async () => {
    if (!S.chainWatch || watch !== mine.h) return;
    try {
      const me = await ownFaction();
      const j = await tucc.api(`/v2/faction/${me.id}/chain`, {}, { ttl: 10 });
      const c = j && j.chain;
      if (!c) return;
      if (w.isOpen()) { data.ourChain = c; render(); }
      const t = Number(c.timeout) || 0, cur = Number(c.current) || 0;
      if (t > 0 && t < 90 && cur >= 10) {
        tucc.alert({ id: 'chain-' + (c.start || c.id || 'x'), title: `Chain ${fmt.num(cur)} times out in ${fmt.dur(t)}`, text: 'Hit someone to keep the chain going.', level: 'urgent', url: 'https://www.torn.com/factions.php?step=your#/', repeatAfter: 60 });
      }
    } catch (e) { /* quiet: shown in the window when open */ }
  });
  mine.h = watch;
  watch.now();
}
startWatch();

tucc.menu('Open War Room', () => w.open());
// The button that opens it: on your own faction page, under Torn's war list. If Torn redraws that part of the page, it is put back.
const btn = document.createElement('button'); btn.id = 'wr39-open'; btn.type = 'button'; btn.textContent = '39th War Room';
btn.onclick = () => (w.isOpen() ? w.close() : w.open());
const place = () => {
  if (POPOUT) return;
  btn.classList.toggle('on', w.isOpen());
  if (btn.isConnected || location.pathname !== '/factions.php' || !/[?&]step=your\b/.test(location.search)) return;
  const at = document.querySelector('#faction_war_list_id') || document.querySelector('#faction-main .f-war-list') || document.querySelector('#faction-main .f-msg');
  if (at) at.insertAdjacentElement('afterend', btn);
};
place(); setInterval(place, 500);
// Stays open across Torn pages until you close it (the open/closed state is remembered).
/* ---------- carrying on across Torn pages ----------
 * A new Torn page starts the script afresh. So the last reading is kept on this device (replaced every couple of
 * seconds, ignored once it is a minute old) and the window is redrawn from it at once, before any new data arrives.
 * Timers, dibs, alerts and the push count all continue from where they were. */
let snapAt = 0;
function saveSnap(force) {
  if (locked || !data.at || !w.isOpen() || (!force && Date.now() - snapAt < 2000)) return;
  snapAt = Date.now();
  try { GM_setValue('snap', JSON.stringify({ at: Date.now(), data, own, myId, skew, found, side, scroll: w.body.scrollTop,
    feed: { live: feed.live, found: feed.found, dibs: feed.dibs, rules: feed.rules, assigned: feed.assigned, rk: feed.rk, push: feed.push, gotAt: feed.gotAt, ms: feed.ms },
    seen: [...seen], outs, watching: watchOuts.enemy })); } catch (e) {}
}
window.addEventListener('pagehide', () => saveSnap(true));
function loadSnap() {
  let p = null; try { p = JSON.parse(GM_getValue('snap', '') || 'null'); } catch (e) {}
  if (!p || !p.data || !p.own || Date.now() - p.at > 60000 || !FACTIONS_39TH.includes(Number(p.own.id))) return 0;
  data = Object.assign(blank(), p.data); own = p.own; myId = Number(p.myId) || 0; skew = Number(p.skew) || 0;
  Object.assign(found, p.found || {}); Object.assign(side, p.side || {}); Object.assign(feed, p.feed || {});
  (p.seen || []).forEach(([k, v]) => seen.set(k, v)); outs = Array.isArray(p.outs) ? p.outs : []; watchOuts.enemy = p.watching;
  return Number(p.scroll) || 0;
}
// While War Room has its own window, that window says so every few seconds; other Torn pages then leave theirs closed.
const popLive = () => Date.now() - Number(GM_getValue('popAt', 0) || 0) < 12000;
if (POPOUT) {
  const beat = () => { try { GM_setValue('popAt', Date.now()); } catch (e) {} }; beat(); setInterval(beat, 4000);
  window.addEventListener('pagehide', () => { try { GM_setValue('popAt', 0); } catch (e) {} });
  try { document.title = '39th War Room'; } catch (e) {}
  loadSnap(); w.open();
} else if (w.wasOpen() && !popLive()) { const sc = loadSnap(); w.open(); if (sc) w.body.scrollTop = sc; }
})();
