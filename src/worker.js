// Cloudflare Worker: serves the game and calls Discogs on the server so your token stays secret.
//   /api/fish   -> a batch of random vinyl releases for the chosen styles (+ optional country)
//   /api/listen -> finds something playable for one release (embeddable YouTube video, else a 30s Deezer preview)
const STYLES = ["House","Deep House","Tech House","Techno","Trance","Breakbeat","Breaks","Jungle","Drum n Bass","UK Garage","Speed Garage","2-Step"];
const COUNTRIES = ["US","UK","Germany","Italy","Netherlands","France","Belgium","Japan"];
const MAX_PAGE = 25;                 // only the first 25 pages (1,250 records) per style, so results get reused a lot
const TTL = 6 * 60 * 60 * 1000;      // remember each page for 6 hours
const memo = new Map();
const out = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const hdrs = token => ({ "User-Agent": "CrateFishing/0.2 +https://github.com/calvinndavis12-bit/cratefishing", "Authorization": "Discogs token=" + token.trim() });
const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);

async function getPage(style, country, page, H) {
  const key = style + "|" + country + "|" + page, hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return { json: hit.json };
  const ck = new Request("https://cratefishing.cache/" + encodeURIComponent(key));
  try {
    const c = await caches.default.match(ck);
    if (c) { const json = await c.json(); memo.set(key, { at: Date.now(), json }); return { json }; }
  } catch (e) {}
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
  try { await caches.default.put(ck, new Response(JSON.stringify(json), { headers: { "content-type": "application/json", "cache-control": "public, max-age=21600" } })); } catch (e) {}
  return { json };
}

function staleFor(style, country) {   // if Discogs refuses, reuse anything we saved earlier for this style
  for (const [k, v] of memo) if (k.startsWith(style + "|" + country + "|")) return v.json;
  return null;
}

function shape(x) {
  const p = (x.title || "").split(" - "), a = p.shift();
  const u = x.uri && x.uri.startsWith("/") ? "https://www.discogs.com" + x.uri : "https://www.discogs.com/release/" + x.id;
  return { id: x.id, a: a || "Unknown", t: p.join(" - ") || x.title || "Untitled", g: (x.style || []).slice(0, 4), c: x.country || "", y: parseInt(x.year) || 0, u, img: x.thumb || "", have: x.community ? x.community.have : null, lbl: (x.label || [])[0] || "" };
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
  if (!env.DISCOGS_TOKEN) return out(500, { error: "DISCOGS_TOKEN is not set in Cloudflare" });
  const sp = new URL(request.url).searchParams;
  let list = (sp.get("styles") || "").split(",").map(s => s.trim()).filter(s => STYLES.includes(s));
  if (!list.length) list = STYLES;
  const cq = (sp.get("country") || "").trim(), country = COUNTRIES.includes(cq) ? cq : "";
  const H = hdrs(env.DISCOGS_TOKEN);
  try {
    // try up to 3 of the chosen styles, in case one comes back empty (e.g. a style name Discogs doesn't use)
    const order = shuffle(list).slice(0, 3);
    let lastFail = null;
    for (const style of order) {
      const r = await pull(style, country, H);
      if (r.fail) { lastFail = r; if (r.code === 429) break; continue; }
      if (r.items.length) return out(200, { style, items: r.items });
    }
    if (lastFail) return out(lastFail.code, { error: lastFail.fail });
    return out(200, { style: order[0], items: [] });
  } catch (e) {
    return out(502, { error: "Could not reach Discogs" });
  }
}

// ---------- listening ----------
const YT = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const clean = s => String(s || "").replace(/\s*\(\d+\)\s*$/, "").trim();      // Discogs writes "Artist (2)" to tell same-named artists apart
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function embeddable(id) {       // YouTube answers 401/404 here when a video can't be embedded or is gone
  try {
    const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id));
    return r.ok;
  } catch (e) { return false; }
}

async function deezer(artist, track) { // free 30-second preview, no key needed
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
    const age = yt ? 86400 : preview ? 600 : 21600;        // preview links expire, so keep those briefly
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
    if (p === "/api/listen") return listen(request, env);
    return env.ASSETS.fetch(request);
  }
};
