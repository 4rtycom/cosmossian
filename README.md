# Cosmossian

Static 3D atlas in `public/`, plus a Cloudflare Worker in `src/worker.js` that refreshes live catalogues into Workers KV and writes them into the page. If a feed fails, the page keeps the snapshot already embedded in `public/index.html`.

## Project structure

```
cosmossian/
  package.json          # npm scripts: dev, deploy
  wrangler.toml         # Worker, assets, routes, cron, KV binding
  src/worker.js         # request handler and scheduled refresh
  public/index.html     # the site, including built-in data snapshots
  public/logo.png
  public/data/          # stars, constellations, deep-sky objects
  public/tex/           # planet and moon textures
  public/deck/          # cockpit photos
  .env.example          # variable names only
```

`public/index.html` is the site. It loads Three.js from a CDN and Google fonts. Local catalogues are `data/stars.json`, `data/constellations.json`, and `data/dso.json`. Planet textures load from `tex/`. Cockpit photos load from `deck/`.

Embedded `<script>` snapshots in `index.html`:

| id | Role |
| --- | --- |
| `debris` | satellite and debris orbits; replaced from KV key `block:debris` |
| `exocat` | confirmed exoplanets; replaced from KV key `block:exocat` |
| `smallbodies` | asteroids and comets; replaced from KV key `block:smallbodies` |
| `livemeta` | refresh metadata; replaced from KV key `meta` |
| `meteorites` | static snapshot; the Worker does not refresh this |
| `showers` | static snapshot; the Worker does not refresh this |

## Requirements

- Node.js LTS
- A Cloudflare account that can run this Worker
- The domain names in `wrangler.toml` on that same Cloudflare account, when you choose to attach them
- No separate build step. Dependencies are the `wrangler` devDependency.

## Local setup

```bash
npm install
copy .env.example .dev.vars
```

Edit `.dev.vars` and replace `REFRESH_KEY` with a long random string. That file stays on this machine.

```bash
npx wrangler login
npx wrangler kv namespace create LIVE
```

The `LIVE` namespace already exists (`cosmossian-LIVE`) and its id is in `wrangler.toml`; only create a new one for a different account. Leave `REFRESH_KEY` out of `wrangler.toml`.

```bash
npm run dev
```

`npm run dev` runs `wrangler dev`.

## Scheduled refresh

`wrangler.toml` cron: `7 */3 * * *` (minute 7 of every third hour, UTC).

Each run in `src/worker.js`:

- Always refreshes satellites and debris from CelesTrak (`sats`).
- Refreshes confirmed exoplanets from the NASA Exoplanet Archive when the UTC hour is less than 3 (`exo`), which is the 00:07 UTC run.
- Refreshes brighter numbered asteroids and nearer comets from the JPL Small-Body Database when that same run falls on Monday UTC (`sb`).

Feeds used by the Worker:

- `https://celestrak.org/NORAD/elements/gp.php`
- `https://exoplanetarchive.ipac.caltech.edu/TAP/sync`
- `https://ssd-api.jpl.nasa.gov/sbdb_query.api`

Results are stored in the `LIVE` KV namespace. The homepage reads those keys and injects them into the matching script tags. A failed fetch leaves the previous KV value, or the HTML snapshot when KV is empty.

Manual refresh (after deploy, with the secret you set). Sending the key in a header keeps it out of logs:

```bash
curl -H "Authorization: Bearer <REFRESH_KEY>" https://cosmossian.com/api/refresh
curl -H "Authorization: Bearer <REFRESH_KEY>" "https://cosmossian.com/api/refresh?only=sats"
curl https://cosmossian.com/api/health
```

`?key=<REFRESH_KEY>` still works. The key must be at least 24 characters.

`only` accepts `sats`, `exo`, and `sb`. `/api/health` reports whether `LIVE` is bound and the last refresh metadata.

## Routes

| Path | Behavior |
| --- | --- |
| `/`, `/index.html` | HTML with live KV blocks written in |
| `/api/health` | JSON status |
| `/api/refresh` | refresh; requires `REFRESH_KEY` |
| `/api/verify` | POST a Turnstile token; sets the human-check cookie |
| `/api/human` | JSON `{ "human": true/false }` for the current visitor |
| everything else | static file from `public/` |

`wrangler.toml` lists custom domains `cosmossian.com` and `www.cosmossian.com`. Publishing with those routes attaches the Worker to those hostnames. This repository does not change DNS by itself.

## Security

- Every response carries a Content-Security-Policy, HSTS, `X-Frame-Options: DENY`, `nosniff`, a Referrer-Policy and a Permissions-Policy. The Worker sets them on its own responses; `public/_headers` sets the same on files served straight from `public/`.
- `www.cosmossian.com` redirects to `cosmossian.com`.
- `/api/*` is rate limited per visitor (`API_LIMIT`, 30 per minute; `REFRESH_LIMIT`, 3 per minute) and only accepts the methods it uses.
- The refresh key is compared in constant time.
- Human check: the title screen runs Cloudflare Turnstile (widget "Cosmossian title screen", managed mode, invisible unless Cloudflare is unsure). "Explore the Galaxy" stays locked until the Worker has verified the token with Siteverify (checking action `intro` and hostname `cosmossian.com`). The Worker then sets `__Host-cs_human`, an HMAC-signed HttpOnly cookie, valid 30 days, so returning visitors are not checked again. `#explore` links also wait for the check. This gates the interface; the static files under `public/` stay publicly fetchable.
- Live data written into the page is escaped so a feed can never break out of its `<script>` tag.
- Zone-level protection (SSL mode, WAF, bots, DDoS) is set in the Cloudflare dashboard, not in this repository.

## Deploy

Do this only when you intend to publish.

```bash
npx wrangler secret put REFRESH_KEY
npm run deploy
```

`npm run deploy` runs `wrangler deploy`.

Workers Paid is what the original handoff specified for the scheduled jobs, because those runs download multi-megabyte catalogues. The static site can still be served if a scheduled run fails; the page keeps its built-in snapshots.

GitHub integration, if you connect this repository in the Cloudflare dashboard: build command empty, deploy command `npx wrangler deploy`.

## Cloudflare resources to configure separately

Create or confirm these in the Cloudflare account. This repo does not contain their real ids or secret values.

| Name | Kind |
| --- | --- |
| `LIVE` | Workers KV namespace `cosmossian-LIVE` (created; id in `wrangler.toml`) |
| `API_LIMIT`, `REFRESH_LIMIT` | rate limiting bindings (declared in `wrangler.toml`) |
| `REFRESH_KEY` | Worker secret (`wrangler secret put`) |
| `TURNSTILE_SECRET` | Worker secret: secret key of the Turnstile widget "Cosmossian title screen" (site key is in `public/index.html`) |
| `ASSETS` | assets binding for `./public` (declared in `wrangler.toml`) |
| Worker name `cosmossian` | Workers script |
| Cron trigger `7 */3 * * *` | scheduled trigger declared in `wrangler.toml` |
| `cosmossian.com` | custom domain route |
| `www.cosmossian.com` | custom domain route |

## Secrets

The Worker reads two secrets: `REFRESH_KEY` and `TURNSTILE_SECRET`. Keep it in `.dev.vars` locally and in the Cloudflare secret store for the deployed Worker. Do not commit `.env`, `.dev.vars`, or a filled-in key.

## Credits

- CelesTrak (Dr. T.S. Kelso): orbital elements.
- NASA Exoplanet Archive (Caltech/IPAC).
- JPL Small-Body Database (NASA/JPL-Caltech).
