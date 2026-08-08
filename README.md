# PrimeVue photo albums web app

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#after-deploying-app-to-cloudflare">After deploying app to Cloudflare</a></li>
        <li><a href="#integrate-with-imagekit">Integrate with ImageKit</a></li>
        <li><a href="#mapbox-api-key">Mapbox API key</a></li>
        <li><a href="#vite_-variables-are-public">Which variables are public</a></li>
        <li><a href="#google-oauth-20-client-id">Google OAuth 2.0 client ID</a></li>
        <li><a href="#rapidapi-aerodatabox">RapidAPI (AeroDataBox)</a></li>
      </ul>
    </li>
    <li>
      <a href="#public-demo-mirror">Public demo mirror</a>
    </li>
    <li>
      <a href="#how-to-run-locally">How to run locally</a>
    </li>
  </ol>
</details>

## About The Project

This is a fullstack photo album web app using Vue3, PrimeVue, Tailwind CSS, Tanstack Query, Hono, Cloudflare Workers, Cloudflare D1 and Cloudflare R2. You can use this web app to display your photos in R2 bucket and manage your photos and albums. This app is supposed to be used by a small group of people (e.g. family members) so it doesn't have any user management feature.

### Built With

[![Vite][vite]][vite-url][![Vue][Vue.js]][Vue-url][![Tailwind CSS][tailwindcss]][tailwindcss-url][![TypeScript][typescript]][type-url][![Vitest][vitest]][vitest-url][![Hono][hono]][hono-url][![Cloudflare][cloudflare]][cloudflare-url]

## Getting started

### Prerequisites

You will need the follows:

1. Google OAuth 2.0 Client ID (For admin access)
2. Cloudflare account (For Workers, D1 database and R2 storage)
3. Cloudflare R2 bucket (For storing photos. **You need to create this manually.** )
4. ImageKit account (It's optional)
5. **Two** Mapbox API keys — one public token for displaying maps in the browser, and a
   second, separate one for place search on the server. See
   [Mapbox API key](#mapbox-api-key) for why they cannot be the same token.
6. RapidAPI key with AeroDataBox subscription (For flight data lookup in travel records, optional)

‼️ **️Important** ‼️

Before you start local development, you will need to set up Cloudflare D1 and environment variables. Please check further
information in the `server` folder [here](server/README.md).

### After deploying app to Cloudflare

After deploying the backend to Cloudflare, replace properties `VITE_STATIC_FILES_URL` and
`VITE_IMAGEKIT_CDN_URL` (There are 2 `VITE_IMAGEKIT_CDN_URL` env variables, one is in the root folder, another one is in the server folder) with your configured URLs in `.env.example` and modify file name to `.env`.

### Integrate with ImageKit

In order to reduce the traffic with R2 bucket (to save money!), this project integrate with ImageKit CDN. ImageKit.io is a cloud-based image CDN with real-time image optimisation and transformation features that help you deliver perfectly optimised images across all devices[2]. You can follow this [documentation](https://imagekit.io/blog/image-optimization-resize-aws-s3-imagekit/) to create an account in the ImageKit. You will have 20GB bandwidth per month as a free user. Once you have your own ImageKit URL, replace this property `VITE_IMAGEKIT_CDN_URL` with your real information in`.env.example` and modify file name to `.env`. And
use the same URL in the `server` folder.

#### Important

If you change R2 bucket name, don't forget to update the configuration in ImageKit.

### Mapbox API key

This project uses Mapbox to display the [map](https://simple-photo-albums.pages.dev/map/albums). You can get your own Mapbox API key [here](https://account.mapbox.com/auth/signup/). Once you have your own Mapbox API key, replace this property `VITE_MAPBOX_API_KEY` with your real information in `.env.example` and modify file name to `.env`.

Use a **public** token (`pk.*`) and add a URL restriction for your own domain in the Mapbox
dashboard — see the note below on why. A secret token (`sk.*`) must never be used here.

#### Two Mapbox tokens are required

| Variable | Used by | Restriction |
| --- | --- | --- |
| `VITE_MAPBOX_API_KEY` | The browser, for map tiles | Public `pk.*`, **URL-restricted** to your own domain |
| `MAPBOXAPI_KEY` | The Worker, for place search | Public `pk.*`, **no URL restriction** |

They must be **separate tokens**. A URL restriction is enforced against the `Referer`
header, and a `fetch` from a Cloudflare Worker sends none — so the URL-restricted token
is rejected server-side. Keeping them separate also means a leak of the public one does
not force rotation of the server one.

`MAPBOXAPI_KEY` has no `VITE_` prefix on purpose: it is a Worker secret and must never
reach the client bundle.

#### `SEARCH_PROXIMITY` (optional)

Without a location hint, Mapbox ranks *partial* search queries by the caller's IP — which in
production is whichever Cloudflare datacentre served the request, so results vary by datacentre
and won't match what you see locally. Set `SEARCH_PROXIMITY` to pin it:

```properties
SEARCH_PROXIMITY=174.7633,-36.8485
```

**Longitude first** — the reverse of what Google Maps gives you when you right-click. The
literal `ip` is also accepted and is equivalent to leaving it unset. An invalid value is
logged and ignored rather than sent.

Only partial queries are affected; fully-typed searches rank the same either way, so this
does not bias searches for other countries.

In production it comes from `vars.SEARCH_PROXIMITY` — a GitHub Actions **variable**, not a
secret. Set it on the `prod` environment (Settings → Environments → `prod` → Variables).

⚠️ The deploy skips the upload when the value is empty, so **clearing the variable does not
unset it on the Worker** — an already-uploaded value stays. To actually remove it, run
`wrangler secret delete SEARCH_PROXIMITY` against the Worker.

### `VITE_*` variables are public

Vite inlines every `VITE_`-prefixed variable into the client bundle at build time, so all of them
are readable by anyone who loads the site. Storing them as GitHub *secrets* does not change that.
This is fine for the ones that are public by design, but it means:

- `VITE_MAPBOX_API_KEY` — **billable**. Must be a public `pk.*` token with URL restrictions set in
  the Mapbox dashboard, or anyone can spend your quota.
- `VITE_GOOGLE_CLIENT_ID` — public by design for Google Identity Services. Restrict "Authorized
  JavaScript origins" to your own domain.
- `VITE_GTAG_ID`, `VITE_IMAGEKIT_CDN_URL`, `VITE_WORKER_API_URL`, `VITE_STATIC_FILES_URL` — public
  identifiers, no action needed.

Anything that must stay confidential belongs in the Worker as a `wrangler secret` and must **not**
carry a `VITE_` prefix: `JWT_SECRET`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `MAPBOXAPI_KEY`,
`RAPIDAPI_KEY`. (`VITE_GOOGLE_CLIENT_ID` is also uploaded as a Worker secret because the Worker
needs it as the token `audience` — the name is misleading, but the value is not confidential.)

### Google OAuth 2.0 client ID

Please check [here](https://developers.google.com/identity/protocols/oauth2) for further information. You will also need to set up OAuth consent screen. Please check [here](https://developers.google.com/identity/protocols/oauth2/openid-connect#consent-screen). Once you have Google OAuth 2.0 client ID, replace this property `VITE_GOOGLE_CLIENT_ID` with your real information in `.env.example` and modify file name to `.env`. And use the same client ID in the `server` folder.

#### Login UI

This project uses Google OAuth 2.0 to authenticate users. If you don't want to use Google OAuth 2.0, you will need to implement login UI and authentication process by yourself. Once you set up Google OAuth 2.0 client ID and OAuth consent screen, you can access login UI by going to `http://localhost:9000/login`. You will also need to add your Google account information in the D1 database you created. If every thing is set up correctly, you should be able to login with your Google account and see the admin features including album and photo management. If you just want to have a quick glance of UI, you can simply run `bun run --cwd ui msw`, it will launch UI on http://localhost:5173.

### RapidAPI (AeroDataBox)

The travel records feature supports auto-populating flight data (departure, destination, airline, aircraft type, duration, distance) from a flight number and date. This uses the [AeroDataBox API](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) via RapidAPI. Sign up at [RapidAPI](https://rapidapi.com/) and subscribe to the AeroDataBox API to get your API key. Once you have the key, add `RAPIDAPI_KEY` to your server `.dev.vars` file. This is optional — travel records can still be created manually without it.

### Cloudflare Workers

This project uses Cloudflare Workers to handle all APIs (as BFF, backend for frontend) and authentication process.

## Public demo mirror

This repository is private, and `.github/workflows/sync-demo.yaml` pushes `master` to a public
mirror after every merge — so **anything merged becomes public**. The workflow scans the tree,
filenames and full history for private identifiers before pushing, and fails closed.

Keep `.private-strings` (gitignored) in step with the `PRIVATE_STRING_PATTERNS` secret; the
pre-commit hook silently does nothing without the file.

One-time setup is in [docs/demo-mirror-setup.md](docs/demo-mirror-setup.md).

## How to run locally

### Install the dependencies

```bash
$ bun install
```

### Start the app in MSW mode (without server running)

```bash
$ bun run --cwd ui msw
```

### Start the app in development mode (hot-code reloading, error reporting, etc.)

```bash
$ bun run dev
```

### Lint the files

```bash
$ bun run lint
```

### Run unit tests

```bash
$ bun run test:all
```

This runs both workspaces. For one only: `bun run --cwd ui test:unit` or
`bun run --cwd server test:server`.

### Build the app for production

```bash
$ bun run build
```

### References

1. [Optimize and resize images with ImageKit](https://imagekit.io/blog/image-optimization-resize-aws-s3-imagekit/)

<!-- MARKDOWN LINKS & IMAGES -->

[vitest]: https://img.shields.io/badge/Vitest-%236E9F18?style=for-the-badge&logo=Vitest&logoColor=%23fcd703
[vitest-url]: https://vitest.dev/
[Vue.js]: https://img.shields.io/badge/Vue%20js-35495E?style=for-the-badge&logo=vuedotjs&logoColor=4FC08D
[Vue-url]: https://vuejs.org/
[typescript]: https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white
[type-url]: https://www.typescriptlang.org/
[vite]: https://img.shields.io/badge/Vite-B73BFE?style=for-the-badge&logo=vite&logoColor=FFD62E
[vite-url]: https://vitejs.dev/
[tailwindcss]: https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white
[tailwindcss-url]: https://tailwindcss.com/
[hono]: https://img.shields.io/badge/Hono-E36002?style=for-the-badge&logo=hono&logoColor=white
[hono-url]: https://hono.dev/
[cloudflare]: https://img.shields.io/badge/Cloudflare-F38020?style=for-the-badge&logo=cloudflare&logoColor=white
[cloudflare-url]: https://www.cloudflare.com/
