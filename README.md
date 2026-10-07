# Crate Fishing (Discogs edition) - Cloudflare Workers

Files at the TOP of your GitHub repo:
- public/index.html (the game)
- src/worker.js (talks to Discogs at /api/fish)
- wrangler.jsonc (tells Cloudflare what to deploy; "name" must match your Cloudflare project name)

## Cloudflare settings
- Build command: leave EMPTY
- Deploy command: npx wrangler deploy
- After the first deploy: project > Settings > Variables and secrets > add secret DISCOGS_TOKEN, then redeploy.
- Test: your-site.workers.dev/api/fish?styles=House should show text starting {"style":"House","items":[

Data provided by Discogs. Read the Discogs API Terms of Use before sharing publicly.
