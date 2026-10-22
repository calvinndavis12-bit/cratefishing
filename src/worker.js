// Cloudflare Worker for Crate Fishing.
//
// HOW IT SCALES: players never talk to Discogs directly. A background job (cron, once a minute) slowly
// checks a few records at a time, keeps only the ones with an embeddable YouTube video, and saves them in a
// shared database (the "pool"). /api/fish just pulls random records out of that pool, so 10 players cost
// Discogs zero requests. Pool entries are thrown away after 6 hours (Discogs' terms don't allow showing
// data that is more than 6 hours old, or storing it longer than needed).
//
//   /api/fish   -> a batch of random playable records (filters: styles, country, decade)
//   /api/pool   -> a status page: how many records the pool holds per style
//   /api/listen -> backup only: checks one release live (used if the pool isn't set up yet)
//   scheduled() -> the once-a-minute job that fills the pool
const STYLES = ["House","Deep House","Tech House","Techno","Trance","Breakbeat","Breaks","Jungle","Drum n Bass","UK Garage","Speed Garage","2-Step"];
const COUNTRIES = ["US","UK","Germany","Italy","Netherlands","France","Belgium","Japan"];
const DECADES = ["1980","1990","2000","2010"];
const MAX_PAGE = 25;                 // random page 1-25 of each style's search results (1,250 records)
const TTL = 6 * 60 * 60 * 1000;      // everything we keep expires after 6 hours
const BUDGET = 45;                   // Cloudflare's FREE plan allows 50 outside calls (fetches + database calls) per run. Paid plan: raise this.
const COOL_MS = 75000;               // rest this long after Discogs says slow down (their window is 60 seconds)
const SAFE_LEFT = 8;                 // stop a run early if Discogs reports fewer than this many requests left
const MAX_CHECK = 15;                // releases checked per run => about 16 Discogs requests a minute at most (limit is 60)
const memo = new Map();
const out = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const hdrs = token => ({ "User-Agent": "CrateFishing/0.3 +https://github.com/calvinndavis12-bit/cratefishing", "Authorization": "Discogs token=" + token.trim() });
const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function shape(x) {
  const p = (x.title || "").split(" - "), a = p.shift();
  const u = x.uri && x.uri.startsWith("/") ? "https://www.discogs.com" + x.uri : "https://www.discogs.com/release/" + x.id;
  return { id: x.id, a: a || "Unknown", t: p.join(" - ") || x.title || "Untitled", g: (x.style || []).slice(0, 4), c: x.country || "", y: parseInt(x.year) || 0, u, img: x.thumb || "", have: x.community ? x.community.have : null, lbl: (x.label || [])[0] || "" };
}

// ---------- the shared pool (Cloudflare D1 database) ----------
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pool (id INTEGER PRIMARY KEY, style TEXT, country TEXT, year INTEGER, ok INTEGER, yt TEXT, data TEXT, at INTEGER)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS pool_find ON pool (ok, style, at)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
  ]);
  schemaReady = true;
}

async function fromPool(env, list, country, decade) {
  await ensureSchema(env);
  const binds = [Date.now() - TTL, ...list];
  let sql = "SELECT data FROM pool WHERE ok=1 AND at>? AND style IN (" + list.map(() => "?").join(",") + ")";
  if (country) { sql += " AND country=?"; binds.push(country); }
  if (decade) { const d = Number(decade); if (d >= 2010) { sql += " AND year>=?"; binds.push(d); } else { sql += " AND year>=? AND year<?"; binds.push(d, d + 10); } }
  sql += " ORDER BY RANDOM() LIMIT 30";
  const rows = (await env.DB.prepare(sql).bind(...binds).all()).results || [];
  const items = rows.map(r => { try { return JSON.parse(r.data); } catch (e) { return null; } }).filter(Boolean);
  let total = items.length;
  if (!items.length) { const t = await env.DB.prepare("SELECT COUNT(*) AS n FROM pool WHERE ok=1 AND at>?").bind(Date.now() - TTL).first(); total = t ? t.n : 0; }
  return { items, total };
}

async function poolStatus(env) {
  if (!env.DB) return out(200, { configured: false, note: "No database attached yet - the game is using slower live lookups." });
  await ensureSchema(env);
  const since = Date.now() - TTL;
  const per = (await env.DB.prepare("SELECT style, COUNT(*) AS n FROM pool WHERE ok=1 AND at>? GROUP BY style").bind(since).all()).results || [];
  const checked = await env.DB.prepare("SELECT COUNT(*) AS n FROM pool WHERE at>?").bind(since).first();
  const last = await env.DB.prepare("SELECT v FROM meta WHERE k='last'").first();
  const perStyle = Object.fromEntries(STYLES.map(s => [s, 0]));
  per.forEach(r => { perStyle[r.style] = r.n; });
  const cool = await env.DB.prepare("SELECT v FROM meta WHERE k='cool'").first();
  let lastRun = null; try { lastRun = last ? JSON.parse(last.v) : null; } catch (e) {}
  if (lastRun && lastRun.at) lastRun.secondsAgo = Math.round((Date.now() - lastRun.at) / 1000);
  const coolingSeconds = cool ? Math.max(0, Math.round((Number(cool.v) - Date.now()) / 1000)) : 0;
  return out(200, { configured: true, playable: per.reduce((a, r) => a + r.n, 0), checkedLast6h: checked ? checked.n : 0, coolingSeconds, hasToken: !!env.DISCOGS_TOKEN, perStyle, lastRun });
}

// ---------- the once-a-minute job that fills the pool ----------
const YT = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const clean = s => String(s || "").replace(/\s*\(\d+\)\s*$/, "").trim();      // Discogs writes "Artist (2)" to tell same-named artists apart
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function embeddable(id) {       // YouTube answers 401/404 here when a video can't be embedded or is gone
  try {
    const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id));
    return r.ok;
  } catch (e) { return false; }
}

async function refillInner(env) {
  if (!env.DB || !env.DISCOGS_TOKEN) return { skipped: "DB or DISCOGS_TOKEN is not set" };
  await ensureSchema(env);
  const H = hdrs(env.DISCOGS_TOKEN), now = Date.now();
  let ops = 0;                                                     // counts every outside call, to stay under Cloudflare's per-run limit
  const cool = await env.DB.prepare("SELECT v FROM meta WHERE k='cool'").first(); ops++;
  if (cool && now < Number(cool.v)) return { skipped: "cooling down after Discogs said slow down" };
  const coolDown = () => env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('cool', ?)").bind(String(Date.now() + COOL_MS)).run();
  const leftOf = resp => { const v = Number(resp.headers.get("x-discogs-ratelimit-remaining")); return resp.headers.get("x-discogs-ratelimit-remaining") === null || isNaN(v) ? null : v; };
  let low = false;
  // when Discogs refuses, record exactly what it said and which Cloudflare address we came from
  const why = async (resp, what) => {
    const h = n => resp.headers.get(n);
    let body = ""; try { body = (await resp.text()).slice(0, 120); } catch (e) {}
    let egress = null; try { const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text(); egress = { ip: (t.match(/ip=(\S+)/) || [])[1], colo: (t.match(/colo=(\S+)/) || [])[1] }; } catch (e) {}
    return { style, error: what, discogs: { status: resp.status, limit: h("x-discogs-ratelimit"), used: h("x-discogs-ratelimit-used"), remaining: h("x-discogs-ratelimit-remaining"), retryAfter: h("retry-after"), body }, egress };
  };

  await env.DB.prepare("DELETE FROM pool WHERE at<?").bind(now - TTL).run(); ops++;          // forget anything older than 6 hours
  const rows = (await env.DB.prepare("SELECT style, COUNT(*) AS n FROM pool WHERE ok=1 GROUP BY style").all()).results || []; ops++;
  const counts = Object.fromEntries(STYLES.map(s => [s, 0]));
  rows.forEach(r => { if (r.style in counts) counts[r.style] = r.n; });
  const style = shuffle(STYLES).sort((a, b) => counts[a] - counts[b])[0];                     // always top up the emptiest style

  const search = page => fetch("https://api.discogs.com/database/search?type=release&format=Vinyl&per_page=50&style=" + encodeURIComponent(style) + "&page=" + page, { headers: H });
  const page = 1 + Math.floor(Math.random() * MAX_PAGE);
  let r = await search(page); ops++;
  if (r.status === 429) { await coolDown(); return await why(r, "Discogs 429 on search"); }
  if (!r.ok) return await why(r, "Discogs returned " + r.status);
  let json = await r.json();
  if (!(json.results || []).length && page > 1) {
    r = await search(1); ops++;
    if (r.status === 429) { await coolDown(); return await why(r, "Discogs 429 on search"); }
    if (!r.ok) return await why(r, "Discogs returned " + r.status);
    json = await r.json();
  }
  const afterSearch = leftOf(r);
  if (afterSearch !== null && afterSearch < SAFE_LEFT + 4) return { style, skipped: "Discogs says only " + afterSearch + " requests left this minute; waiting" };
  const items = (json.results || []).map(shape);
  if (!items.length) return { style, found: 0 };
  const have = new Set(((await env.DB.prepare("SELECT id FROM pool WHERE id IN (" + items.map(() => "?").join(",") + ")").bind(...items.map(i => i.id)).all()).results || []).map(x => x.id)); ops++;
  const todo = shuffle(items.filter(i => !have.has(i.id))).slice(0, MAX_CHECK);

  const done = []; let checked = 0, cooled = false;
  for (const it of todo) {
    if (ops + 3 > BUDGET - 1) break;                               // keep room for the final save
    const rr = await fetch("https://api.discogs.com/releases/" + it.id, { headers: H }); ops++;
    if (rr.status === 429) { cooled = true; break; }
    const left = leftOf(rr); if (left !== null && left < SAFE_LEFT) low = true;
    let yt = null, track = null;
    if (rr.ok) {
      const rel = await rr.json();
      const ids = [...new Set((rel.videos || []).map(v => { const m = YT.exec(v.uri || ""); return m ? m[1] : null; }).filter(Boolean))];
      for (const v of ids.slice(0, 2)) { if (ops >= BUDGET - 1) break; ops++; if (await embeddable(v)) { yt = v; break; } }
      const tracks = (rel.tracklist || []).filter(t => t.type_ === "track" && t.title);
      track = tracks[0] ? tracks[0].title : null;
    } else if (rr.status !== 404) continue;                        // some other hiccup: try this one again another time
    checked++; done.push({ it, yt, track });
    if (low) break;                                                // Discogs allowance nearly used: save what we have and stop
    await sleep(250);
  }
  const add = done.filter(d => d.yt).length;
  const stmts = done.map(({ it, yt, track }) => env.DB.prepare("INSERT OR REPLACE INTO pool (id,style,country,year,ok,yt,data,at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(it.id, style, it.c || "", it.y || 0, yt ? 1 : 0, yt, yt ? JSON.stringify({ ...it, L: { yt, track } }) : null, now));
  const summary = { at: now, style, checked, added: add, calls: ops + 1 };
  stmts.push(env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('last', ?)").bind(JSON.stringify(summary)));
  if (cooled) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('cool', ?)").bind(String(Date.now() + COOL_MS)));
  await env.DB.batch(stmts);
  return summary;
}

// Every run leaves a note in the database (even when it skips or fails) so /api/pool can say what happened.
async function refill(env) {
  let res;
  try { res = await refillInner(env); } catch (e) { res = { error: String((e && e.message) || e) }; }
  if (env.DB && !res.calls && !String(res.skipped || "").startsWith("DB")) {
    try { await env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('last', ?)").bind(JSON.stringify({ at: Date.now(), ...res })).run(); } catch (e) {}
  }
  return res;
}

// Visiting /api/refill runs one job by hand, but never more than once every 45 seconds (so it can't hammer Discogs).
async function manualRefill(env) {
  if (!env.DB) return out(200, { configured: false });
  await ensureSchema(env);
  const last = await env.DB.prepare("SELECT v FROM meta WHERE k='last'").first();
  let at = 0; try { at = last ? JSON.parse(last.v).at || 0 : 0; } catch (e) {}
  if (Date.now() - at < 45000) return out(200, { skipped: "A run happened " + Math.round((Date.now() - at) / 1000) + "s ago. Try again in under a minute." });
  return out(200, await refill(env));
}

// ---------- /api/fish ----------
async function getPage(style, country, page, H) {   // live lookup, only used until the pool has something in it
  const key = style + "|" + country + "|" + page, hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return { json: hit.json };
  const url = "https://api.discogs.com/database/search?type=release&format=Vinyl&per_page=50&style=" + encodeURIComponent(style) + (country ? "&country=" + encodeURIComponent(country) : "") + "&page=" + page;
  const r = await fetch(url, { headers: H });
  if (!r.ok) {
    const lim = r.headers.get("x-discogs-ratelimit"), left = r.headers.get("x-discogs-ratelimit-remaining");
    let msg = "Discogs returned " + r.status;
    if (r.status === 429) msg = "Discogs is busy (limit " + (lim || "?") + "/min, " + (left || "0") + " left). Try again in a minute";
    return { fail: msg, code: r.status };
  }
  const json = await r.json();
  if (memo.size > 300) memo.clear();
  memo.set(key, { at: Date.now(), json });
  return { json };
}
function staleFor(style, country) {
  for (const [k, v] of memo) if (k.startsWith(style + "|" + country + "|")) return v.json;
  return null;
}
async function pull(style, country, H) {
  const page = 1 + Math.floor(Math.random() * MAX_PAGE);
  let got = await getPage(style, country, page, H);
  if (!got.fail && !(got.json.results || []).length && page > 1) got = await getPage(style, country, 1, H);
  let json = got.json;
  if (got.fail) { json = staleFor(style, country); if (!json) return { fail: got.fail, code: got.code }; }
  return { items: shuffle((json.results || []).map(shape)) };
}

async function fish(request, env) {
  const sp = new URL(request.url).searchParams;
  let list = (sp.get("styles") || "").split(",").map(s => s.trim()).filter(s => STYLES.includes(s));
  if (!list.length) list = STYLES;
  const cq = (sp.get("country") || "").trim(), country = COUNTRIES.includes(cq) ? cq : "";
  const dq = (sp.get("decade") || "").trim(), decade = DECADES.includes(dq) ? dq : "";

  if (env.DB) {                                                    // normal path: serve from the shared pool, zero Discogs requests
    try {
      const r = await fromPool(env, list, country, decade);
      if (r.items.length) return out(200, { source: "pool", items: r.items });
      if (r.total > 0) return out(200, { source: "pool", items: [], thin: true });   // pool has records, just none matching these filters
      return out(503, { error: "The record pool is still filling. Try again in a minute or two" });   // visitors never fall back to Discogs, so they can't use up the allowance the filler needs
    } catch (e) { return out(503, { error: "Record pool is unavailable for a moment. Try again" }); }
  }
  if (!env.DISCOGS_TOKEN) return out(500, { error: "DISCOGS_TOKEN is not set in Cloudflare" });
  const H = hdrs(env.DISCOGS_TOKEN);                               // backup path: pool is empty or not set up yet
  try {
    const order = shuffle(list).slice(0, 3);
    let lastFail = null;
    for (const style of order) {
      const r = await pull(style, country, H);
      if (r.fail) { lastFail = r; if (r.code === 429) break; continue; }
      if (r.items.length) return out(200, { source: "live", style, items: r.items });
    }
    if (lastFail) return out(lastFail.code, { error: lastFail.fail });
    return out(200, { source: "live", items: [] });
  } catch (e) {
    return out(502, { error: "Could not reach Discogs" });
  }
}

// ---------- /api/listen (backup for live lookups) ----------
async function deezer(artist, track) {
  try {
    const q = 'artist:"' + artist.replace(/"/g, "") + '" track:"' + track.replace(/"/g, "") + '"';
    const r = await fetch("https://api.deezer.com/search?limit=3&q=" + encodeURIComponent(q));
    if (!r.ok) return null;
    const j = await r.json(), na = norm(artist);
    for (const d of (j.data || [])) {
      const nd = norm(d.artist && d.artist.name);
      if (d.preview && nd && (nd === na || nd.includes(na) || na.includes(nd))) return d.preview;
    }
  } catch (e) {}
  return null;
}

async function listen(request, env) {
  if (!env.DISCOGS_TOKEN) return out(500, { error: "DISCOGS_TOKEN is not set in Cloudflare" });
  const id = parseInt(new URL(request.url).searchParams.get("id"), 10);
  if (!id || id < 1) return out(400, { error: "bad id" });
  const ck = new Request("https://cratefishing.cache/listen/" + id);
  try { const c = await caches.default.match(ck); if (c) return out(200, await c.json()); } catch (e) {}
  try {
    const r = await fetch("https://api.discogs.com/releases/" + id, { headers: hdrs(env.DISCOGS_TOKEN) });
    if (r.status === 404) return out(200, { none: true });
    if (!r.ok) return out(r.status, { error: r.status === 429 ? "Discogs is busy" : "Discogs returned " + r.status });
    const rel = await r.json();
    const ids = [...new Set((rel.videos || []).map(v => { const m = YT.exec(v.uri || ""); return m ? m[1] : null; }).filter(Boolean))];
    let yt = null;
    for (const v of ids.slice(0, 4)) { if (await embeddable(v)) { yt = v; break; } }
    const tracks = (rel.tracklist || []).filter(t => t.type_ === "track" && t.title);
    const artist = clean(rel.artists && rel.artists[0] && rel.artists[0].name);
    let preview = null, track = tracks[0] ? tracks[0].title : null;
    if (!yt && artist && norm(artist) !== "various") {
      for (const t of tracks.slice(0, 3)) { preview = await deezer(artist, t.title); if (preview) { track = t.title; break; } }
    }
    const body = { yt, preview, track };
    if (!yt && !preview) body.none = true;
    const age = yt ? 21600 : preview ? 600 : 21600;                // never keep Discogs-derived answers longer than 6 hours
    try { await caches.default.put(ck, new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + age } })); } catch (e) {}
    return out(200, body);
  } catch (e) {
    return out(502, { error: "Could not reach Discogs" });
  }
}

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    if (p === "/api/fish") return fish(request, env);
    if (p === "/api/pool") return poolStatus(env);
    if (p === "/api/refill") return manualRefill(env);
    if (p === "/api/listen") return listen(request, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refill(env).then(r => console.log("refill", JSON.stringify(r))).catch(e => console.log("refill failed", String(e))));
  }
};
