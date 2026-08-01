# PrimeVue photo albums web app

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
        <li><a href="#architecture">Architecture</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#create-r2-bucket">Create R2 bucket</a></li>
        <li><a href="#integrate-with-imagekit">Integrate with ImageKit</a></li>
        <li><a href="#mapbox-api-key">Mapbox API key</a></li>
        <li><a href="#aws-lambda-function">AWS Lambda Function</a></li>
      </ul>
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

1. Google Place API key (For admin manage albums and travel records)
2. Google OAuth 2.0 Client ID (For admin access)
3. Cloudflare account (For Workers, D1 database and R2 storage)
4. Cloudflare R2 bucket (For storing photos. **You need to create this manually.** )
5. ImageKit account (It's optional)
6. Mapbox API key (For displaying map)
7. RapidAPI key with AeroDataBox subscription (For flight data lookup in travel records, optional)

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
carry a `VITE_` prefix: `JWT_SECRET`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `GOOGLE_PLACES_API_KEY`,
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

This repository is private. A public mirror at `simple-photo-albums-demo` exists so the code can
be shown to people, and `.github/workflows/sync-demo.yaml` pushes `master` to it after every
merge.

It publishes full history rather than a squashed snapshot. `master`'s history was purged of
private identifiers, and the workflow re-verifies that on every run rather than assuming it.

### Setup

1. **Create the demo repo empty.** No README, no `.gitignore`, no licence. GitHub's default
   "create repository" flow adds a README, which gives the mirror an unrelated root commit and
   makes the un-forced push fail as a non-fast-forward.

   This repo's `master` is pushed to the demo repo's `main`, so the mirrored code lands on the
   default branch and visitors see it immediately rather than an unborn default.

2. **Create a fine-grained personal access token**, under Settings → Developer settings →
   Personal access tokens → Fine-grained tokens:

   - **Resource owner:** your account
   - **Repository access:** *Only select repositories* → the demo repo, and nothing else
   - **Permissions:** Contents → *Read and write*, Workflows → *Read and write*

   A deploy key would be narrower and was the original choice, but **GitHub refuses any push
   from a deploy key that creates or updates a file under `.github/workflows/`** — a platform
   rule with no setting behind it. This repo's history is full of workflow files, so a deploy
   key can never mirror it. The fine-grained token scoped to one repository is the next
   narrowest thing; a *classic* PAT would reach every repo on the account and should not be
   used here.

   Fine-grained tokens expire. Note the date — when it lapses the sync fails with a `403`,
   and the fix is to regenerate and update the secret.

3. **Add two repository secrets here**, under Settings → Secrets and variables → Actions →
   *Repository secrets*. Not environment secrets: this job declares no `environment:`, so
   anything scoped to `dev` or `prod` is invisible to it and the run aborts.

   | Secret | Value |
   | --- | --- |
   | `DEMO_REPO_TOKEN` | the fine-grained token from step 2 |
   | `PRIVATE_STRING_PATTERNS` | contents of your local `.private-strings` |

   ```bash
   gh secret set DEMO_REPO_TOKEN            # paste when prompted
   gh secret set PRIVATE_STRING_PATTERNS < .private-strings
   ```

   **Keep `.private-strings`** — it is gitignored, and the pre-commit hook silently does
   nothing without it.

   `.private-strings` can be pasted whole; the workflow strips comments and blank lines. That
   filtering is load-bearing rather than tidy-minded: a blank line in a `grep -f` pattern file
   matches *every* line and would block every push, and a CRLF-terminated one (which GitHub's
   web textarea produces) would match *nothing* while still reporting success.

4. **Disable Actions on the demo repo.** The workflows are mirrored along with everything else,
   and over there they would fire on every push, find no secrets and fail. Note `-F`, not `-f`
   — the endpoint wants a boolean and `-f` sends a string, which 422s:

   ```bash
   gh api -X PUT repos/<owner>/simple-photo-albums-demo/actions/permissions -F enabled=false
   gh api repos/<owner>/simple-photo-albums-demo/actions/permissions   # verify
   ```

5. **Bootstrap** by merging to `master`, or by running the workflow manually from the Actions
   tab.

### Why the scan step exists

An automated push means anything reaching `master` becomes public with nobody reviewing it in
between. Before pushing, the job checks the tree at `HEAD`, the tracked filenames, and every
commit in the history.

The full history every run, not just the newly pushed commits: `git push` publishes everything
reachable from `HEAD`, so on the first run — when the mirror is empty — an incremental scan
would check one commit while shipping all of them.

It **fails closed** throughout. An unset secret, a secret of only comments, or a malformed
regex all abort the run rather than letting it pass silently. That matters more than it sounds:
the natural way to write these checks (`if grep ...; then`) reads a `grep` *error* as "nothing
found" and would publish unscanned.

`.private-strings` is gitignored, so CI cannot read it; that is why the same patterns are
duplicated into a secret. Keep the two in step.

### If the sync starts failing

The push deliberately omits `--force`. Rewriting `master`'s history will therefore break the
sync until you force-push the demo repo once by hand. That is intended: a diverged public
mirror should be a loud failure rather than a silent overwrite.

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
