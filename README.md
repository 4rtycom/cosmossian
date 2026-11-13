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

## Textures

Planet photos load on demand: a body's textures are fetched once it is a few pixels across on screen or is the focus, so the first visit only downloads the page and the sky catalogues. The 4096 px files (Earth, Moon, Jupiter, Saturn, Neptune) have 2048 px copies in `public/tex/2k/`, which are used by default; the 4096 px originals are loaded only up close on desktops whose GPU supports 8192 px textures. Cockpit photos (`public/deck/`) load after the visitor has entered. If you replace a 4096 px texture, regenerate its copy in `tex/2k/`.

## ISS model

Selecting the ISS (its label, or "ISS" in search) flies the camera to the station and loads NASA's 3D model on demand: `public/models/iss-hd/` (NASA 3D Resources "ISS (D) (IGOAL)", ~2.7 million triangles, ~33 MB, Draco-compressed geometry and WebP textures, split into files under Cloudflare's 25 MB asset limit) on desktops, `public/models/iss-lite.glb` (~175,000 triangles, 0.5 MB) on phones and tablets. The loaders and Draco decoder are self-hosted in `public/lib/`. The model replaces the simple stand-in only when it is large on screen. Credits and licences: `public/lib/README.txt`.

## Live ISS position

A separate `iss` job on the 3-hourly run stores the ISS's own orbital elements in KV (`block:iss`): CelesTrak (NORAD 25544) first, then the TLE republished by wheretheiss.at, because CelesTrak currently answers the Worker with 403, written into `<script id="iss">` on the page; the page ships with a snapshot as a fallback. The page propagates them with SGP4's secular J2 terms (checked against wheretheiss.at: within ~2–11 km over 24 h of the element epoch). Earth's rotation follows Greenwich sidereal time whenever the clock runs slowly enough to follow it, and Earth's axis now leans the right way, so with the clock on today at normal speed the station is over the right spot, day and night fall where they do now, and the seasons are right. The ISS card shows where it is right now.

## Today's clouds

Every scheduled run checks for a new day of NASA GIBS imagery (VIIRS NOAA-20 true colour, global day composite; NOAA-21 or MODIS Terra if that day is missing) and stores yesterday's image in KV (`img:earth`, ~0.5 MB, fetched once per day). `GET /api/earth-today.jpg` serves it. When Earth's textures load, the page reads the clouds from it (bright, colourless pixels) and uses them for the cloud layer and cloud shadows instead of the static cloud map; polar night and other gaps keep the static clouds, and toward the poles the static map is trusted more because snow and ice also look white. The Earth card names the date.

## Space weather

A second cron trigger (`*/30 * * * *`) runs only the `space` job: NOAA SWPC's OVATION aurora forecast (packed to a 2° grid, `block:space`, written into `<script id="space">`), the latest planetary Kp index and the past week's GOES X-ray flares. Earth's aurora is drawn from the OVATION grid at its real geographic position (it turns with Earth); without data it falls back to the old fixed oval. The Earth card shows the forecast time and Kp, the Sun card the strongest and latest flares.

## Routes

| Path | Behavior |
| --- | --- |
| `/`, `/index.html` | HTML with live KV blocks written in |
| `/api/health` | JSON status |
| `/api/refresh` | refresh; requires `REFRESH_KEY` |
| `/api/verify` | POST a Turnstile token; sets the human-check cookie |
| `/api/human` | JSON `{ "human": true/false }` for the current visitor |
| `/api/earth-today.jpg` | yesterday's NASA GIBS image of the whole Earth (for today's clouds) |
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
| Cron triggers `7 */3 * * *`, `*/30 * * * *` | scheduled triggers declared in `wrangler.toml` |
| `cosmossian.com` | custom domain route |
| `www.cosmossian.com` | custom domain route |

## Secrets

The Worker reads two secrets: `REFRESH_KEY` and `TURNSTILE_SECRET`. Keep it in `.dev.vars` locally and in the Cloudflare secret store for the deployed Worker. Do not commit `.env`, `.dev.vars`, or a filled-in key.

## Credits

- CelesTrak (Dr. T.S. Kelso): orbital elements.
- NASA Exoplanet Archive (Caltech/IPAC).
- JPL Small-Body Database (NASA/JPL-Caltech).
