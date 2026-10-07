// Cloudflare Worker: serves the game and calls Discogs on the server so your token stays secret.
const STYLES = ["House","Deep House","Tech House","Techno","Trance","Breakbeat","Breaks","Jungle","Drum n Bass"];
const memo = new Map(); // remembers recent Discogs pages to save requests
const TTL = 6 * 60 * 60 * 1000;
const out = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function getPage(style, page, H) {
  const key = style + "|" + page, hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return { json: hit.json };
  const url = "https://api.discogs.com/database/search?type=release&format=Vinyl&per_page=50&style=" + encodeURIComponent(style) + "&page=" + page;
  const r = await fetch(url, { headers: H });
  if (!r.ok) {
    const lim = r.headers.get("x-discogs-ratelimit"), left = r.headers.get("x-discogs-ratelimit-remaining"), wait = r.headers.get("retry-after");
    let msg = "Discogs returned " + r.status;
    if (r.status === 429) msg += " (too many requests" + (lim ? ", limit " + lim + "/min, " + left + " left" : "") + (wait ? ", retry in " + wait + "s" : "") + "). Wait a minute and try again";
    return { fail: msg, code: r.status };
  }
  const json = await r.json();
  if (memo.size > 300) memo.clear();
  memo.set(key, { at: Date.now(), json });
  return { json };
}

async function fish(request, env) {
  const token = env.DISCOGS_TOKEN;
  if (!token) return out(500, { error: "DISCOGS_TOKEN is not set in Cloudflare" });
  const qs = new URL(request.url).searchParams.get("styles") || "";
  let list = qs.split(",").map(s => s.trim()).filter(s => STYLES.includes(s));
  if (!list.length) list = STYLES;
  const style = list[Math.floor(Math.random() * list.length)];
  const H = { "User-Agent": "CrateFishing/0.1 +https://github.com/calvinndavis12-bit/cratefishing", "Authorization": "Discogs token=" + token.trim() };
  try {
    const first = await getPage(style, 1, H);
    if (first.fail) return out(first.code, { error: first.fail });
    const pages = Math.max(1, Math.min((first.json.pagination || {}).pages || 1, 40));
    const page = 1 + Math.floor(Math.random() * pages);
    const got = page === 1 ? first : await getPage(style, page, H);
    if (got.fail) return out(got.code, { error: got.fail });
    const items = (got.json.results || []).map(x => {
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
