# Cloudflare Workers with Hono

## Prerequisites

### Cloudflare Account and Wrangler

1. Create a [Cloudflare account](https://dash.cloudflare.com/sign-up).
2. Install Wrangler CLI:
   ```bash
   npm install -g wrangler
   ```
3. Login to Cloudflare:
   ```bash
   wrangler login
   ```

### Create R2 Bucket

You need to manually create an R2 bucket in your Cloudflare dashboard. This bucket will be used to store photos.

1. Go to **R2 Object Storage** in your Cloudflare dashboard.
2. Create a new bucket.
3. Create an R2 API token with read/write permissions. You will need the access key and secret key for your `.dev.vars` file.

### Cloudflare D1 Database

You need to create a D1 database for your project.

1. Create a database:
   ```bash
   wrangler d1 create photo-albums-db
   ```
2. Note the `database_name` and `database_id` from the output. You will need to update your `wrangler.toml` with these values.

## Setup

### Install dependencies

```bash
bun install
```

### Environment Variables

1. Create a `.dev.vars` file in the `server` directory for your local secrets:

   ```properties
   R2_ACCESS_KEY=your_access_key
   R2_SECRET_KEY=your_secret_key
   JWT_SECRET=your_jwt_secret
   GOOGLE_PLACES_API_KEY=your_google_places_api_key
   VITE_GOOGLE_CLIENT_ID=your_google_client_id
   RAPIDAPI_KEY=your_rapidapi_key
   DEVELOPMENT=true
   ```

   `GOOGLE_PLACES_API_KEY` is a Worker secret used for place search. It has no `VITE_`
   prefix on purpose - it must never reach the client bundle. Create it in the Google
   Cloud console with the Places API (New) enabled, and restrict it to that API.

   `DEVELOPMENT=true` is required for local development: the worker only adds
   `http://localhost:9000` to its allowed CORS origins when this flag is set. Without it, the UI
   dev server's requests are rejected. The same flag drives `verifyOrigin`, the CSRF check on
   state-changing requests, so an unset flag also rejects local POST/PUT/DELETE calls.

   `JWT_SECRET` must be a real, random, high-entropy value in **every** environment, including
   demo/preview. It is the HS256 signing key for the session cookie: anyone who knows it can forge
   an admin session. Generate one with `openssl rand -hex 32`, and never reuse the production value
   elsewhere.

2. Update `wrangler.toml` with your configuration (non-secret values):
   ```toml
   [vars]
   R2_BUCKET_NAME = "your-bucket-name"
   REGION_NAME = "your-region"
   VITE_IMAGEKIT_CDN_URL = "your-imagekit-url"
   ALBUM_URL = "http://localhost:5173"
   ```

   `wrangler.toml` is gitignored, so it does not carry over between machines. It also needs the
   rate-limiting binding, in the default block and under `[env.production]` — copy it from
   `wrangler.ci.toml`:

   ```toml
   # Default (dev) block
   [[unsafe.bindings]]
   name = "RATE_LIMITER"
   type = "ratelimit"
   namespace_id = "1001"
   simple = { limit = 300, period = 60 }

   # Under [env.production] — note the different namespace_id
   [[env.production.unsafe.bindings]]
   name = "RATE_LIMITER"
   type = "ratelimit"
   namespace_id = "1002"
   simple = { limit = 300, period = 60 }
   ```

   The two `namespace_id` values must differ. Cloudflare shares counters across bindings using the
   same namespace in one account, so reusing an id would give an IP hitting both Workers 300 req/60s
   combined instead of 300 against each.

   The middleware fails open when the binding is missing, so local dev still works without it —
   you just get no rate limiting.

3. `wrangler.toml` also needs the R2 bucket binding, and in the **default (dev) block it must be
   marked `remote`**:

   ```toml
   # Default (dev) block
   [[r2_buckets]]
   binding = "BUCKET"
   bucket_name = "your-bucket-name"
   remote = true

   # Under [env.production] — no `remote`, it is already the real bucket there
   [[env.production.r2_buckets]]
   binding = "BUCKET"
   bucket_name = "your-bucket-name"
   ```

   **Why `remote = true` matters.** The photo listing reads `customMetadata` — where each photo's
   GPS coordinates live — and only the native binding returns that with a listing, so it cannot use
   the S3 client. A plain local binding is an empty Miniflare store, which makes every album show
   **zero photos** in local dev. `remote = true` proxies just this binding to the real bucket; D1,
   the rate limiter and every var stay local.

   This is why `start:wrangler` runs `wrangler dev` rather than `wrangler dev --local` — `--local`
   means "run locally with remote bindings disabled", which would switch the proxying back off.
   Remote bindings authenticate with your Cloudflare login, so run `wrangler login` once (or set
   `CLOUDFLARE_API_TOKEN`). Note that local dev then performs real R2 Class A operations.

4. The **dev** D1 binding is marked `remote` for the same reason:

   ```toml
   # Default (dev) block
   [[d1_databases]]
   binding = "DB"
   database_name = "your-dev-db-name"
   database_id = "your-dev-db-id"
   remote = true
   ```

   Keeping a local SQLite copy in step with the remote one by hand drifts out of sync, and an
   album row that exists in one but not the other is confusing to debug — the photo list reads the
   album from D1 and the photos from R2, so a mismatch shows as an album that exists but appears
   empty, or photos with no album.

   > **Local writes are real writes.** With this set, deleting or renaming an album in local dev
   > changes the deployed dev/demo site too. If you want a throwaway database for a destructive
   > experiment, drop `remote = true` from this block and run the migrations locally first.

   Leave `[env.production]` without `remote` — it is already the real database there, and the flag
   only affects local dev.

### Database Migration

Run the migrations to set up your database schema:

```bash
# Dev database. `--remote` even for development: the dev D1 binding is marked
# `remote = true`, so local dev reads this database rather than a local copy.
wrangler d1 execute <your-dev-db-name> --remote --file=./migrations/0000_initial.sql

# Production
wrangler d1 execute <your-prod-db-name> --remote --file=./migrations/0000_initial.sql
```

`--local` only makes sense if you have dropped `remote = true` from the dev `[[d1_databases]]`
block to work against a throwaway database; the Worker ignores the local copy otherwise.

For existing databases, run the flight columns migration:

```bash
# For local development
wrangler d1 execute photo-albums-db --local --file=./migrations/0001_add_flight_columns.sql

# For production
wrangler d1 execute photo-albums-db --remote --file=./migrations/0001_add_flight_columns.sql
```

`0002` removes the placeholder admin row that `0000` seeds. Optional — no code reads that row, and it
is not reachable as a login (its `uid` would have to be issued by Google) — but a stray `admin` row
is worth clearing out:

```bash
# For local development
wrangler d1 execute photo-albums-db --local --file=./migrations/0002_remove_seed_admin_user.sql

# For production
wrangler d1 execute photo-albums-db --remote --file=./migrations/0002_remove_seed_admin_user.sql
```

`0003` renames `isPrivate` to `isUnlisted`:

```bash
# For local development
wrangler d1 execute photo-albums-db --local --file=./migrations/0003_rename_is_private_to_is_unlisted.sql

# For production
wrangler d1 execute photo-albums-db --remote --file=./migrations/0003_rename_is_private_to_is_unlisted.sql
```

> **`0003` is the one migration whose timing matters.** The code queries `isUnlisted` while the
> column is still `isPrivate` until this runs, so the anonymous album and aggregate queries fail in
> the gap between deploying and migrating. There is a window either way, so close it deliberately:
> merge, watch the Actions run, and apply the migration the moment the deploy step completes. That
> order leaves a single `ALTER TABLE` — far more reliable than a CI deploy — as the step that closes
> the window. `0003` carries the rollback statement in a comment.

## Local development

### Run the worker locally

```bash
bun run start:wrangler
```

This command runs `wrangler dev --local`, which starts the worker on a local server.

### Run unit tests

```bash
bun run test:server
```

This script sets `NODE_OPTIONS='--require ./test/slowbuffer-polyfill.cjs'`, which the test suite
depends on — running `vitest` directly will not work.

## Deployment

There is no `deploy` script. Deployment is handled by GitHub Actions
(`.github/workflows/api-build-deploy.yaml`) on push to `master`, filtered to changes in
`server/src/**`, `server/package.json`, or `server/wrangler.ci.toml`.

The workflow regenerates `wrangler.toml` from `wrangler.ci.toml` with `envsubst`, uploads secrets,
then runs `wrangler deploy --env production`. Production values come from GitHub secrets, so
**edit `wrangler.ci.toml` (not `wrangler.toml`) for production config changes** — the local
`wrangler.toml` is dev-only and gets overwritten in CI.

There is deliberately no hand-deploy command documented here. The local `wrangler.toml` uses
`name = "my-albums-worker"`, so `wrangler deploy --env production` would target
`my-albums-worker-production` — **not** the production worker, which CI names via the
`D1_PHOTO_ALBUMS_WORKER` secret and passes explicitly as `--name`. A manual deploy must pass that
same `--name` value, or it will silently create/update the wrong worker.

### Environment-scoped GitHub secrets

Both workflows declare a GitHub `environment` (`prod` and `dev`), so identically-named secrets
resolve to different values per environment. `wrangler.ci.toml` therefore uses the *same*
unprefixed `${R2_BUCKET_NAME}` / `${ALBUM_URL}` / `${VITE_IMAGEKIT_CDN_URL}` in its default block
and under `[env.production]`. That looks like a dev/prod leak but is not: `wrangler deploy --env
production` reads only `[env.production]`, the demo deploy (`--env=""`) reads only the default
block, and the block that received the other environment's value is never consulted. **Do not
"fix" this by prefixing the names** — it adds no safety and GitHub has no rename, only
delete-and-recreate.

Each environment needs its own values for:

| Secret / variable | Notes |
| --- | --- |
| `R2_BUCKET_NAME` | `dev` must name a bucket separate from `prod` |
| `ALBUM_URL` | UI origin; drives CORS **and** the `verifyOrigin` CSRF check, so a stale value 403s every mutation |
| `VITE_IMAGEKIT_CDN_URL` | ImageKit endpoint (raw R2 bucket in dev) |
| `JWT_SECRET` | Random and **unique per environment** — see the warning in Environment Variables above |
| `DEV_PHOTO_ALBUMS_DB_NAME` / `_ID`, `PROD_PHOTO_ALBUMS_DB_NAME` / `_ID` | Already environment-prefixed, since both appear in the same rendered file |

Each workflow's "Configure Wrangler" step fails fast if any required value is empty, rather than
deploying a Worker bound to a nameless bucket or an empty CORS origin.

`R2_ACCESS_KEY` / `R2_SECRET_KEY` are used by both environments. Scope them to the buckets they
need in the Cloudflare R2 dashboard rather than granting account-wide object access.

## API endpoint list

### Authentication

- /api/auth/user-info - GET: Get user information
- /api/auth/verify-id-token - POST: Verify user ID token with Firebase by using Google IDP
- /api/auth/logout - POST: User logout

### Album

- /api/albums/:year - GET: Get albums by year
- /api/albums - POST: Create a new album
- /api/albums - PUT: Update an album
- /api/albums - DELETE: Delete an album

### Album tags

- /api/album-tags - GET: Get all album tags
- /api/album-tags - POST: Create a new album tags
- /api/album-tags/:tagId - DELETE: Delete album tag

### Photos

- /api/photos/:year/:albumId - GET: Get photos by album ID
- /api/photos - DELETE: Delete photos
- /api/photos - PUT: Move photos to different folder
- /api/photos/rename - PUT: Rename photo
- /api/photos/upload/:albumId - POST: Mint a presigned R2 upload URL

### Travel Records

- /api/travel-records - GET: Get all travel records
- /api/travel-records - POST: Create a new travel record (supports flight API mode with automatic flight data lookup)
- /api/travel-records/backfill-country - POST: Backfill country data for existing travel records
- /api/travel-records - PUT: Update a travel record
- /api/travel-records/:recordId - DELETE: Delete a travel record

### Location

- /api/location/search - GET: Search location by keyword

### Aggregate

- /api/aggregate/:type - GET: Get aggregate data by type (albums-with-location, count-albums-by-year, featured-albums)
