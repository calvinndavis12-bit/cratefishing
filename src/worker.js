// Cloudflare Worker: serves the game and calls Discogs on the server so your token stays secret.
const STYLES = ["House","Deep House","Tech House","Techno","Trance","Breakbeat","Breaks","Jungle","Drum n Bass"];
const pagesCache = {};
const out = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function fish(request, env) {
  const token = env.DISCOGS_TOKEN;
  if (!token) return out(500, { error: "DISCOGS_TOKEN is not set in Cloudflare" });
  const qs = new URL(request.url).searchParams.get("styles") || "";
  let list = qs.split(",").map(s => s.trim()).filter(s => STYLES.includes(s));
  if (!list.length) list = STYLES;
  const style = list[Math.floor(Math.random() * list.length)];
  const H = { "User-Agent": "CrateFishing/0.1", "Authorization": "Discogs token=" + token };
  const base = "https://api.discogs.com/database/search?type=release&format=Vinyl&per_page=50&style=" + encodeURIComponent(style) + "&page=";
  try {
    let json = null, pages = pagesCache[style];
    if (!pages) {
      const r = await fetch(base + "1", { headers: H });
      if (!r.ok) return out(r.status, { error: "Discogs returned " + r.status });
      json = await r.json();
      pages = pagesCache[style] = Math.max(1, Math.min((json.pagination || {}).pages || 1, 200));
    }
    const page = 1 + Math.floor(Math.random() * pages);
    if (!json || page !== 1) {
      const r = await fetch(base + page, { headers: H });
      if (!r.ok) return out(r.status, { error: "Discogs returned " + r.status });
      json = await r.json();
    }
    const items = (json.results || []).map(x => {
      const p = (x.title || "").split(" - "), a = p.shift();
      const u = x.uri && x.uri.startsWith("/") ? "https://www.discogs.com" + x.uri : "https://www.discogs.com/release/" + x.id;
      return { id: x.id, a: a || "Unknown", t: p.join(" - ") || x.title || "Untitled", g: (x.style || []).slice(0, 4), c: x.country || "", y: parseInt(x.year) || 0, u, img: x.thumb || "", have: x.community ? x.community.have : null, lbl: (x.label || [])[0] || "" };
    }).sort(() => Math.random() - 0.5).slice(0, 12);
    return out(200, { style, items });
  } catch (e) {
    return out(502, { error: "Could not reach Discogs" });
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/fish") return fish(request, env);
    return env.ASSETS.fetch(request);
  }
};
