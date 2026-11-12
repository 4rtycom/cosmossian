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

Paste the printed namespace id into `wrangler.toml` at `PASTE_THE_KV_ID_HERE`. Leave `REFRESH_KEY` out of `wrangler.toml`.

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

Manual refresh (after deploy, with the secret you set):

```text
https://<your-worker-host>/api/refresh?key=<REFRESH_KEY>
https://<your-worker-host>/api/refresh?key=<REFRESH_KEY>&only=sats
https://<your-worker-host>/api/health
```

`only` accepts `sats`, `exo`, and `sb`. `/api/health` reports whether `LIVE` is bound and the last refresh metadata.

## Routes

| Path | Behavior |
| --- | --- |
| `/`, `/index.html` | HTML with live KV blocks written in |
| `/api/health` | JSON status |
| `/api/refresh` | refresh; requires `REFRESH_KEY` |
| everything else | static file from `public/` |

`wrangler.toml` lists custom domains `cosmossian.com` and `www.cosmossian.com`. Publishing with those routes attaches the Worker to those hostnames. This repository does not change DNS by itself.

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
| `LIVE` | Workers KV namespace; binding name in `wrangler.toml` |
| `REFRESH_KEY` | Worker secret (`wrangler secret put`) |
| `ASSETS` | assets binding for `./public` (declared in `wrangler.toml`) |
| Worker name `cosmossian` | Workers script |
| Cron trigger `7 */3 * * *` | scheduled trigger declared in `wrangler.toml` |
| `cosmossian.com` | custom domain route |
| `www.cosmossian.com` | custom domain route |

## Secrets

`REFRESH_KEY` is the only secret the Worker reads. Keep it in `.dev.vars` locally and in the Cloudflare secret store for the deployed Worker. Do not commit `.env`, `.dev.vars`, or a filled-in key.

## Credits

- CelesTrak (Dr. T.S. Kelso): orbital elements.
- NASA Exoplanet Archive (Caltech/IPAC).
- JPL Small-Body Database (NASA/JPL-Caltech).
