# Crate Fishing (Discogs edition) - Cloudflare Workers

Files at the TOP of your GitHub repo:
- public/index.html (the game)
- src/worker.js (talks to Discogs: /api/fish finds records, /api/listen finds something playable)
- wrangler.jsonc (tells Cloudflare what to deploy; "name" must match your Cloudflare project name)

## Cloudflare settings
- Build command: leave EMPTY
- Deploy command: npx wrangler deploy
- After the first deploy: project > Settings > Variables and secrets > add secret DISCOGS_TOKEN, then redeploy.

## Quick tests after deploying
- your-site.workers.dev/api/fish?styles=House should show text starting {"style":"House","items":[
- your-site.workers.dev/api/fish?styles=UK%20Garage should return items (try Speed%20Garage and 2-Step too)
- your-site.workers.dev/api/listen?id=RELEASE_ID (any Discogs release number) should show {"yt":...} or {"preview":...} or {"none":true}

## What's new
- UKG GARAGE GULF spot (UK Garage, Speed Garage, 2-Step)
- Tackle box: bottom tab opens a drawer with style, decade and country filters (down arrow closes it and applies them)
- Records are checked for something playable before they can be caught: an embeddable YouTube video from Discogs plays in the game, otherwise a 30-second Deezer preview; records with neither are skipped
- Catch / keep / release animations, sounds and vibration (rarer = bigger)

Data provided by Discogs. Read the Discogs API Terms of Use before sharing publicly.
