# Public demo mirror — one-time setup

> Owner runbook, not part of getting the app running. If you are setting up the app for
> development, you can ignore this file entirely.

This repository is private. A public mirror at `simple-photo-albums-demo` exists so the code can
be shown to people, and `.github/workflows/sync-demo.yaml` pushes `master` to it after every
merge.

It publishes full history rather than a squashed snapshot. `master`'s history was purged of
private identifiers, and the workflow re-verifies that on every run rather than assuming it.

## Setup

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

## Why the scan step exists

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

## If the sync starts failing

The push deliberately omits `--force`. Rewriting `master`'s history will therefore break the
sync until you force-push the demo repo once by hand. That is intended: a diverged public
mirror should be a loud failure rather than a silent overwrite.
