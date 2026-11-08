# Validation contract

Three reusable workflows let application repositories report validation results
on GitHub. They validate and report only. Deploys are separate from validation:
a homelab slot deploys through `slot-deploy.yml` in its own caller job after
validation passed (see [Deploys](#deploys-are-separate-from-validation)), and
Nix repositories receive lock updates through `flake-update.yml`. Releases,
tags, signing, publication and package-tap updates are performed by an
explicitly invoked local tool and are outside all of these workflows.

| Workflow | Event it is meant for | Jobs |
| --- | --- | --- |
| `validate-pr.yml` | pull requests | `leaks` (tree scan), `deps` (dependency review), `lint`, `build`, `test` |
| `validate-main.yml` | push to the default branch, or a schedule | `leaks` (full history), `test`, `integration`, `security` |
| `codeql.yml` | pull requests, push to the default branch and a schedule | `analyze`, one check per language |

Each command job is skipped when its input is empty, so a repository adopts only
what it owns. Product-specific tests, packaging and distribution stay in the
application repository; the workflows run its commands and nothing else.

## Caller triggers

Callers trigger on `pull_request`, on `push` with `branches: [main]` (the
default branch only) and on a weekly `schedule`; `workflow_dispatch` may be
added. Do not use an unfiltered `push` trigger: a branch with an open pull
request would then run every check twice, once per event. Route
`pull_request` to `validate-pr.yml`, `push` and `schedule` to
`validate-main.yml`, and all three to `codeql.yml`.

## Inputs

Common to `validate-pr.yml` and `validate-main.yml`: `runner` (default
`ubuntu-latest`; the macOS applications pass `macos-26`), `go-version` (default
`1.27.3`; used for the leak scanner and available to app commands; empty uses
the runner default), `bun-version` (empty skips installation), `node-version`
(empty skips installation; otherwise installs Node.js and runs `corepack enable`
so commands can use pnpm or npm, installing a pinned corepack when the Node.js
release no longer bundles it), `nix` (default `false`; `true` installs Nix
2.35.4 with flakes enabled through `cachix/install-nix-action`, because
GitHub-hosted runners have no Nix), `leak-scan` (default `true`).

Optional secrets, common to both: `app-client-id` and `app-private-key` of a
GitHub App installed on the repository owner. They are used only when `nix` is
`true`: each command job then mints an installation token with
`actions/create-github-app-token`, limited to `contents: read` on the owner's
repositories the App can reach, and configures it as Nix's `github.com` access
token so private flake inputs can be fetched. The token is revoked when the job
ends. Without the secrets Nix uses the job's read-only `GITHUB_TOKEN` for
github.com, which reaches public inputs only. Repository commands run in the
same job and can read the Nix configuration, so pass these secrets only where
the App's read access is acceptable for code on the repository's own branches.
GitHub withholds secrets from fork pull requests, which therefore cannot fetch
private inputs.

`validate-pr.yml`: `lint-command`, `build-command`, `test-command`,
`dependency-review` (default `true`). `test-command` runs the repository's tests
on the pull request so a change that breaks them cannot merge; pass the same
command as to `validate-main.yml`. The `deps` job runs `actions/dependency-review-action` on
`ubuntu-latest` for `pull_request` events only, failing on newly introduced
dependencies with `high` or `critical` advisories or with a license outside
`MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC,
LicenseRef-scancode-google-patent-license-golang`. The last entry is the Go
project's additional patent grant (`PATENTS`), which every `golang.org/x`
module carries alongside BSD-3-Clause; without it every Go dependency on those
modules fails the check. It reads the dependency graph with `contents: read`.

`validate-main.yml`: `test-command`, `integration-command`, `security-command`.
Its `test` job reruns the tests after merge. It does not depend on the calling event, so callers may invoke it from `push`
to the default branch and from a `schedule` (for example a weekly run so the
security command sees newly published advisories).

`codeql.yml`: `languages` (required JSON array of `actions`, `go`,
`javascript-typescript`, `swift`), `go-version` (default `1.27.3`),
`swift-build-command` (traced in manual build mode; empty uses CodeQL
autobuild), `swift-runner` (default `macos-26`), `queries` (default
`security-extended`). Actions, Go and JavaScript/TypeScript run on
`ubuntu-latest`; Actions (the repository's GitHub Actions workflows) and
JavaScript/TypeScript use build mode `none`, Go uses autobuild. Include
`actions` so pull requests produce the `/language:actions` code scanning
category; a code scanning ruleset blocks merges when the default branch has
results for a category no pull request analyzes.

Commands run with `bash -euo pipefail -c` from the repository root. They are
passed through an environment variable, never interpolated into a script. Any
other toolchain must be installed or vendored by the command itself or provided
by the runner. The only secrets declared or accepted are the optional Nix App
secrets above, which reach only the token step.

## Permissions

Every workflow and job sets `contents: read` and nothing else, with one
documented exception: the `analyze` job of `codeql.yml` also holds
`security-events: write`, which only uploads CodeQL results to the repository's
code scanning alerts. The calling job for `codeql.yml` must grant exactly
`contents: read` and `security-events: write`; every other caller grants at most
`contents: read`. The checkout does not persist credentials. The contract tests
reject any other write scope (including `contents: write`, `packages: write`
and `id-token: write`) and any release, tag, publish, deploy, dispatch or
artifact-upload step.

Outside the validation contract, `slot-deploy.yml` holds no token permissions
at all (`permissions: {}`, callers grant `{}`), and `flake-update.yml` holds
`contents: read`; its writes (the update branch and pull request) go only
through the GitHub App token passed in as a secret.

## Outputs and reports

There are no workflow outputs. The result is the check status of each job plus
its log, and for `codeql.yml` the code scanning alerts in the Security tab,
where Copilot Autofix (free for public repositories, enabled in repository
settings) proposes fixes. These are validation reports only. They are not distributables: nothing
produced in CI is a release artifact, and local release tooling must not
require a green run or any CI artifact.

## Consumer usage and pinning

See [the example consumer](examples/consumer-validation.yml). Pin each `uses:`
to a reviewed full commit SHA of this repository; review the diff before moving
the pin and keep the previous SHA as the rollback pin. Tagged versions apply to
the local release tool, not to this repository.

## Consumer inventory and migration

Consumers: scratchpad, usb-boop, pr-nanny, paw-proxy and menubar-kit. Migration
per repository: add a workflow like the example calling the contracts with its
own commands (for example its `task` targets), keep required-check names stable
(`pr / leaks`, `pr / deps`, `pr / lint`, `pr / build`, `pr / test`, `main / test`, and
`codeql / <language>` such as `codeql / actions`, `codeql / go` or `codeql / swift`), and remove any
release, publish or deploy jobs from its CI after the local release path is in
use. `pr / leaks`, `pr / deps`, `pr / lint`, `pr / build`, `pr / test` and the
`codeql / *` checks are intended as required pull request checks; consumers
that pass `test-command` should require `pr / test` in their default-branch
ruleset. Dependency updates arrive as Dependabot alerts only; consumers
do not enable Dependabot version-update pull requests. The one exception is
`flake.lock` in Nix repositories: Dependabot does not update it, so those
repositories call `flake-update.yml` nightly instead (see below).

The `image-build.yml` and `image-tag-release.yml` workflows are unchanged and
remain for unrelated consumers. `deploy.yml` and `rollout.yml` targeted the
Kubernetes cluster removed on 3 November 2026 and are removed;
`whisker-shogunate-website`'s pinned call to `deploy.yml` is dead until that
project is revived. None of the consumers above may call these workflows for
releases.

## Deploys are separate from validation

`slot-deploy.yml` deploys one homelab slot. Callers add it as its own job that
`needs:` the main validation jobs, so it runs only after they succeed:

```yaml
  deploy:
    needs: main # the job calling validate-main.yml (main / test, main / security)
    if: github.event_name == 'push'
    permissions: {}
    uses: alexcatdad/ci-actions/.github/workflows/slot-deploy.yml@REVIEWED_COMMIT_SHA
    with:
      slot: komga
```

Inputs: `slot` (required; lower-case letters, digits and hyphens), `runner`
(default `self-hosted`; the label of the repository's deploy runner) and
`timeout-minutes` (default `60`). No secrets. Each run is recorded as a
deployment to the environment `homelab-<slot>` (created on first use), so the
repository's Deployments page shows which commit is live on the homelab. The job runs only for a `push`
or `workflow_dispatch` on the default branch and runs one command,
`homelab-deploy-slot <slot> <github.sha>`, on the repository's own
self-hosted runner, as the runner's unprivileged user: the host, not the
workflow, grants the one privileged step (on the homelab, a polkit rule lets
each runner start the root deploy unit for its own slot only). It uses no actions at all, not even
checkout, and holds no token permissions (`permissions: {}`): the runner
connects outbound only, and the host checks that the commit is the tip of
`main`, builds it from GitHub itself, scans it with vulnix, switches the slot's
profile, checks health and rolls back on failure. No build artifact travels
from CI to the host. A concurrency group per repository and slot runs one
deploy at a time; a newer deploy replaces an older one still queued, and a
running deploy is never cancelled.

`flake-update.yml` is called nightly (`schedule`, optionally
`workflow_dispatch`) by repositories with a `flake.lock`:

```yaml
on:
  schedule:
    - cron: '23 3 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  flake-update:
    permissions:
      contents: read
    uses: alexcatdad/ci-actions/.github/workflows/flake-update.yml@REVIEWED_COMMIT_SHA
    secrets:
      app-client-id: ${{ secrets.FLAKE_UPDATE_APP_CLIENT_ID }}
      app-private-key: ${{ secrets.FLAKE_UPDATE_APP_PRIVATE_KEY }}
```

Inputs: `runner` (default `ubuntu-latest`), `base` (default `main`), `branch`
(default `flake-update`). Required secrets: `app-client-id` and
`app-private-key` of a GitHub App with contents and pull request write access
on the repository (and contents read on any private flake inputs). It runs
`nix flake update` on `base` with Nix 2.35.4. If `flake.lock` is unchanged it
stops. Otherwise it force-pushes one commit to `branch` and opens a pull
request, or updates the one still open from a previous night; when that open
pull request already holds the same lock on the current base it does nothing.
The pull request is opened with an App installation token, not
`GITHUB_TOKEN`, because pull requests opened with `GITHUB_TOKEN` start no
other workflows and would never be validated. The App token for git and `gh`
is limited to the calling repository and minted only after Nix has run; Nix
gets a separate read-only token. The update merges through the repository's
normal pull request checks.

## Scanner

Leak scanning runs gitleaks, pinned to an exact version, via `go run`: the
working tree on pull requests and full Git history after merge. Findings are
redacted in logs.
