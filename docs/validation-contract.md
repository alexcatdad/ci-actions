# Validation contract

Three reusable workflows let application repositories report validation results
on GitHub. They validate and report only. Releases, tags, signing, publication,
deployment and package-tap updates are performed by an explicitly invoked local
tool and are outside these workflows.

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
release no longer bundles it), `leak-scan` (default `true`).

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
by the runner. No secrets are declared or accepted.

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
do not enable Dependabot version-update pull requests.

The `image-build.yml`, `image-tag-release.yml`, `deploy.yml` and `rollout.yml`
workflows are unchanged and remain for unrelated consumers. None of the consumers
above may call them for releases. Removing them would need a separate
consumer audit and migration.

## Scanner

Leak scanning runs gitleaks, pinned to an exact version, via `go run`: the
working tree on pull requests and full Git history after merge. Findings are
redacted in logs.
