/* Cosmossian on Cloudflare: serves the app and keeps its data fresh.
   - The page and its files are served as static assets (folder ./public).
   - A scheduled job (cron) fetches live catalogues, converts them to the formats the app already uses,
     and stores them in KV. When the page is requested, the stored data is written into it.
   - If anything fails, the page keeps the snapshot it was built with. The page never breaks because of a feed.
   Sources: CelesTrak (satellites), NASA Exoplanet Archive (exoplanets), JPL Small-Body Database (asteroids, comets). */

const SAT_GROUPS = ['active', 'cosmos-1408-debris', 'fengyun-1c-debris', 'iridium-33-debris', 'cosmos-2251-debris'];
const SB_ASTEROID_MAX_H = 11;   // numbered asteroids brighter than this absolute magnitude (a few thousand)
const SB_COMET_MAX_Q = 3;       // comets that come closer to the Sun than this (AU)
const UA = 'Cosmossian/1.0 (+https://cosmossian.com)';

const CANONICAL = 'cosmossian.com';

// security headers on every response the Worker sends (files served straight from ./public get the same set from public/_headers)
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://cloudflareinsights.com",
  "worker-src 'self' blob:",
  "frame-src https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests"
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin'
};
function secure(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request, env, ctx) {
    return secure(await route(request, env, ctx));
  },
  async scheduled(event, env, ctx) {
    // every run refreshes satellites; exoplanets once a day; small bodies once a week
    const h = new Date(event.scheduledTime).getUTCHours(), d = new Date(event.scheduledTime).getUTCDay();
    const jobs = ['sats'];
    if (h < 3) jobs.push('exo');
    if (h < 3 && d === 1) jobs.push('sb');
    ctx.waitUntil(refreshAll(env, jobs));
  }
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;
  const m = request.method;
  // one address for the site: www goes to the bare domain
  if (url.hostname === 'www.' + CANONICAL) { url.hostname = CANONICAL; return Response.redirect(url.toString(), 301); }
  if (p.startsWith('/api/')) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (env.API_LIMIT && !(await env.API_LIMIT.limit({ key: 'api:' + ip })).success) return text('too many requests', 429, { 'Retry-After': '60' });
    if (p === '/api/health') return m === 'GET' || m === 'HEAD' ? health(env) : text('method not allowed', 405, { Allow: 'GET, HEAD' });
    if (p === '/api/human') return m === 'GET' ? json({ human: await isHuman(request, env) }) : text('method not allowed', 405, { Allow: 'GET' });
    if (p === '/api/verify') return m === 'POST' ? verifyHuman(request, env, ip) : text('method not allowed', 405, { Allow: 'POST' });
    if (p === '/api/refresh') {
      if (m !== 'GET' && m !== 'POST') return text('method not allowed', 405, { Allow: 'GET, POST' });
      if (env.REFRESH_LIMIT && !(await env.REFRESH_LIMIT.limit({ key: 'refresh:' + ip })).success) return text('too many requests', 429, { 'Retry-After': '60' });
      // the key may come as "Authorization: Bearer <key>" (preferred: stays out of logs) or as ?key=
      const auth = request.headers.get('authorization') || '';
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : (url.searchParams.get('key') || '');
      if (!(await sameSecret(given, env.REFRESH_KEY))) return text('forbidden', 403);
      const only = url.searchParams.get('only');
      return json(await refreshAll(env, only ? only.split(',') : null));
    }
    return text('not found', 404);
  }
  if (m !== 'GET' && m !== 'HEAD') return text('method not allowed', 405, { Allow: 'GET, HEAD' });
  if (p === '/' || p === '/index.html') return page(request, env);
  return env.ASSETS.fetch(request);
}

/* ---------- human check (Cloudflare Turnstile on the title screen) ----------
   The title screen sends its Turnstile token to /api/verify. The Worker checks it with Cloudflare and answers with a signed,
   HttpOnly cookie, so the same visitor is not checked again for HUMAN_DAYS. /api/human tells the page whether that cookie is valid. */
const HUMAN_COOKIE = '__Host-cs_human';
const HUMAN_DAYS = 30;
const TURNSTILE_TEST_SECRETS = ['1x0000000000000000000000000000000AA', '2x0000000000000000000000000000000AA'];

async function humanSig(secret, exp) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('cs-human:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(exp))));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function isHuman(request, env) {
  if (!env.TURNSTILE_SECRET) return false;
  const c = (request.headers.get('cookie') || '').split(/;\s*/).find(x => x.startsWith(HUMAN_COOKIE + '='));
  if (!c) return false;
  const [exp, sig] = c.slice(HUMAN_COOKIE.length + 1).split('.');
  if (!/^\d{10}$/.test(exp || '') || !sig || Number(exp) < Date.now() / 1000) return false;
  return sameSecret(sig, await humanSig(env.TURNSTILE_SECRET, exp), 1);
}

async function verifyHuman(request, env, ip) {
  if (!env.TURNSTILE_SECRET) return text('human check not configured', 503);
  let token = '';
  try { const body = await request.text(); if (body.length > 4096) return text('bad request', 400); token = String(JSON.parse(body).token || ''); } catch { return text('bad request', 400); }
  if (!token || token.length > 2048) return text('bad request', 400);
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip, idempotency_key: crypto.randomUUID() });
  let out;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    out = await r.json();
  } catch { return text('verification unavailable', 502); }
  const test = TURNSTILE_TEST_SECRETS.includes(env.TURNSTILE_SECRET);
  // Cloudflare's test keys answer with a dummy hostname and no action, so those two checks apply to real keys only
  const ok = !!out && out.success === true && (test || (out.action === 'intro' && out.hostname === CANONICAL));
  if (!ok) return json({ human: false, errors: (out && out['error-codes']) || [] }, 403);
  const exp = Math.floor(Date.now() / 1000) + HUMAN_DAYS * 86400;
  const cookie = `${HUMAN_COOKIE}=${exp}.${await humanSig(env.TURNSTILE_SECRET, exp)}; Path=/; Max-Age=${HUMAN_DAYS * 86400}; Secure; HttpOnly; SameSite=Lax`;
  return json({ human: true }, 200, { 'Set-Cookie': cookie });
}

// constant-time comparison, so the key cannot be guessed from response timing
async function sameSecret(given, secret, minLength = 24) {
  if (!secret || secret.length < minLength || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, secret].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}
const text = (body, status, extra) => new Response(body, { status, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}) });

/* ---------- the page, with live data written in ---------- */
async function page(request, env) {
  // ask the asset store for '/' (asking for /index.html would answer with a redirect back to '/')
  const res = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  if (!env.LIVE) return res;
  const [sats, exo, sb, meta] = await Promise.all(['block:debris', 'block:exocat', 'block:smallbodies', 'meta'].map(k => env.LIVE.get(k)));
  // the stored blocks are JSON from outside feeds. Inside a <script> tag, HTML escaping would corrupt them, and raw "<" could close
  // the tag and inject markup. So <, > and & are written as JSON \u escapes: still the same JSON, but it can never leave the tag.
  const safe = s => s.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const put = (id, val) => ({ element(el) { if (val) el.setInnerContent(safe(val), { html: true }); } });
  const out = new HTMLRewriter()
    .on('script#debris', put('debris', sats))
    .on('script#exocat', put('exocat', exo))
    .on('script#smallbodies', put('smallbodies', sb))
    .on('script#livemeta', put('livemeta', meta))
    .transform(res);
  const h = new Headers(out.headers);
  h.set('Cache-Control', 'public, max-age=300');
  return new Response(out.body, { status: out.status, headers: h });
}

/* ---------- refresh jobs ---------- */
async function refreshAll(env, only) {
  const jobs = { sats: refreshSats, exo: refreshExo, sb: refreshSB };
  const meta = JSON.parse((await env.LIVE.get('meta')) || '{}');
  const report = {};
  for (const k of Object.keys(jobs)) {
    if (only && !only.includes(k)) continue;
    try {
      const r = await jobs[k](env);
      await env.LIVE.put('block:' + r.block, r.text);
      meta[k] = { n: r.n, at: new Date().toISOString(), src: r.src };
      report[k] = { ok: true, n: r.n, bytes: r.text.length };
    } catch (e) {
      report[k] = { ok: false, error: String(e && e.message || e) };
      meta[k + '_error'] = { at: new Date().toISOString(), error: String(e && e.message || e) };
    }
  }
  await env.LIVE.put('meta', JSON.stringify(Object.fromEntries(Object.entries(meta).filter(([k]) => !k.endsWith('_error')))));
  await env.LIVE.put('report', JSON.stringify({ at: new Date().toISOString(), report, errors: Object.fromEntries(Object.entries(meta).filter(([k]) => k.endsWith('_error'))) }));
  return report;
}

async function getJSON(u) {
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(u.split('?')[0] + ' answered ' + r.status);
  return r.json();
}

// satellites and debris -> the app's packed format (7 x uint16 per object, base64)
async function refreshSats() {
  const RE = 6378.137, MU = 398600.4418, TAU = Math.PI * 2;
  const seen = new Set(), rows = [];
  for (const g of SAT_GROUPS) {
    let list;
    try { list = await getJSON(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=json`); } catch (e) { if (g === 'active') throw e; continue; }
    for (const o of list) {
      if (seen.has(o.NORAD_CAT_ID)) continue; seen.add(o.NORAD_CAT_ID);
      const name = String(o.OBJECT_NAME || '');
      const type = g !== 'active' || / DEB/.test(name) ? 3 : / R\/B/.test(name) ? 2 : 1;
      rows.push({ o, type });
    }
  }
  if (rows.length < 1000) throw new Error('too few satellites: ' + rows.length);
  const now = Date.now(), t0 = now / 86400000 + 2440587.5;
  const u = new Uint16Array(rows.length * 7); const counts = { 0: 0, 1: 0, 2: 0, 3: 0 }; let n = 0;
  for (const { o, type } of rows) {
    const nRad = o.MEAN_MOTION * TAU / 86400; if (!(nRad > 0)) continue;
    const a = Math.cbrt(MU / (nRad * nRad)) / RE; if (!(a >= 1 && a <= 100)) continue;
    const ep = Date.parse(o.EPOCH.endsWith('Z') ? o.EPOCH : o.EPOCH + 'Z');
    const M = (((o.MEAN_ANOMALY * Math.PI / 180) + nRad * (now - ep) / 1000) % TAU + TAU) % TAU;
    const k = n * 7, q = x => Math.max(0, Math.min(65535, Math.round(x * 65535)));
    u[k] = q(Math.log(a) / Math.log(100)); u[k + 1] = q(o.ECCENTRICITY); u[k + 2] = q(o.INCLINATION / 180);
    u[k + 3] = q(((o.RA_OF_ASC_NODE % 360) + 360) % 360 / 360); u[k + 4] = q(((o.ARG_OF_PERICENTER % 360) + 360) % 360 / 360); u[k + 5] = q(M / TAU); u[k + 6] = type;
    counts[type]++; n++;
  }
  const bytes = new Uint8Array(u.buffer, 0, n * 14);
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { block: 'debris', n, src: 'CelesTrak', text: JSON.stringify({ t0, n, counts, b64: btoa(bin) }) };
}

// confirmed exoplanets -> the app's catalogue format, grouped by host star
async function refreshExo() {
  const cols = 'pl_name,hostname,ra,dec,sy_dist,st_spectype,st_teff,st_rad,st_lum,st_mass,sy_snum,pl_orbsmax,pl_orbper,pl_rade,pl_bmasse,pl_orbeccen,discoverymethod,disc_year';
  const q = encodeURIComponent(`select ${cols} from pscomppars`);
  const rows = await getJSON(`https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=${q}&format=json`);
  if (!Array.isArray(rows) || rows.length < 4000) throw new Error('too few exoplanets: ' + (rows && rows.length));
  const METH = { 'Transit': 'T', 'Radial Velocity': 'R', 'Microlensing': 'M', 'Imaging': 'I', 'Transit Timing Variations': 'P', 'Eclipse Timing Variations': 'P', 'Pulsar Timing': 'P', 'Pulsation Timing Variations': 'P', 'Astrometry': 'A' };
  const hosts = new Map(); const r1 = x => x == null ? null : Math.round(x * 1000) / 1000;
  for (const r of rows) {
    let h = hosts.get(r.hostname);
    if (!h) { h = [r.hostname, r1(r.ra), r1(r.dec), r.sy_dist != null ? Math.round(r.sy_dist * 3.26156 * 10) / 10 : 0, r.st_spectype || '', r.st_teff ? Math.round(r.st_teff) : 0, r.st_rad ? r1(r.st_rad) : 0, r.st_lum != null ? Math.round(Math.pow(10, r.st_lum) * 1e5) / 1e5 : 0, r.sy_snum || 1, []]; h.mass = r.st_mass || 1; hosts.set(r.hostname, h); }
    let P = r.pl_orbper, a = r.pl_orbsmax, Re = r.pl_rade, flags = '';
    if (!a && P) a = Math.cbrt(Math.pow(P / 365.25, 2) * h.mass);
    if (!Re && r.pl_bmasse) { Re = Math.pow(r.pl_bmasse, 0.28); flags += 'e'; }
    if (!a || !P) continue;
    const letter = String(r.pl_name).slice(String(r.hostname).length).trim() || 'b';
    h[9].push([letter, r1(a), r1(P), Re ? Math.round(Re * 100) / 100 : 1, r.pl_bmasse ? Math.round(r.pl_bmasse * 10) / 10 : 0, r.pl_orbeccen != null ? r1(r.pl_orbeccen) : 0, METH[r.discoverymethod] || '', r.disc_year || 0, flags]);
  }
  const list = [...hosts.values()].filter(h => h[9].length).map(h => { delete h.mass; return h; });
  const n = list.reduce((s, h) => s + h[9].length, 0);
  return { block: 'exocat', n, src: 'NASA Exoplanet Archive', text: JSON.stringify(list) };
}

// brighter numbered asteroids and Sun-grazing-to-Jupiter comets, added to the app's curated list
async function refreshSB(env) {
  const base = 'https://ssd-api.jpl.nasa.gov/sbdb_query.api?full-prec=false&fields=full_name,q,e,i,om,w,tp,H';
  const ast = await getJSON(`${base}&sb-kind=a&sb-ns=n&sb-cdata=${encodeURIComponent(JSON.stringify({ AND: ['H|LT|' + SB_ASTEROID_MAX_H] }))}`);
  const com = await getJSON(`https://ssd-api.jpl.nasa.gov/sbdb_query.api?full-prec=false&fields=full_name,q,e,i,om,w,tp,M1&sb-kind=c&sb-cdata=${encodeURIComponent(JSON.stringify({ AND: ['q|LT|' + SB_COMET_MAX_Q] }))}`);
  // start from the list the page was built with, so curated names and discoverers are kept
  const html = await (await env.ASSETS.fetch('https://assets.local/')).text();
  const m = html.match(/<script type="application\/json" id="smallbodies">([\s\S]*?)<\/script>/);
  const cur = m ? JSON.parse(m[1]) : [];
  const key = s => String(s).replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const have = new Set(cur.map(o => key(o[0])));
  const add = (res, kind) => { const F = res.fields || []; const ix = f => F.indexOf(f); let n = 0;
    for (const d of res.data || []) {
      const name = String(d[ix('full_name')]).trim().replace(/\s*\([^)]*\)\s*$/, '');
      if (!name || have.has(key(name))) continue;
      const q = +d[ix('q')], e = +d[ix('e')], tp = +d[ix('tp')]; if (!(q > 0) || !(e >= 0) || !isFinite(tp)) continue;
      const a = e < 1 ? q / (1 - e) : 0, H = +(d[ix(kind === 'comet' ? 'M1' : 'H')]) || 15;
      const type = kind === 'comet' ? 'comet' : a > 30 ? 'cubewano' : 'asteroid';
      cur.push([name, type, q, e, +d[ix('i')], +d[ix('om')], +d[ix('w')], tp, H, 0, '', '', 'live']); have.add(key(name)); n++;
    } return n; };
  add(ast, 'asteroid'); add(com, 'comet');
  if ((ast.data || []).length < 100) throw new Error('JPL returned too few asteroids: ' + (ast.data || []).length);
  return { block: 'smallbodies', n: cur.length, src: 'JPL SBDB', text: JSON.stringify(cur) };
}

/* ---------- status ---------- */
async function health(env) {
  const out = { kv: !!env.LIVE, now: new Date().toISOString() };
  if (env.LIVE) { out.meta = JSON.parse((await env.LIVE.get('meta')) || '{}'); out.lastRun = JSON.parse((await env.LIVE.get('report')) || 'null'); }
  return json(out);
}
const json = (o, status = 200, extra) => new Response(JSON.stringify(o, null, 2), { status, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra || {}) });
