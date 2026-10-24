# Validation contract

Two reusable workflows let application repositories report validation results
on GitHub. They validate and report only. Releases, tags, signing, publication,
deployment and package-tap updates are performed by an explicitly invoked local
tool and are outside these workflows.

| Workflow | Event it is meant for | Jobs |
| --- | --- | --- |
| `validate-pr.yml` | pull requests | `leaks` (tree scan), `lint`, `build` |
| `validate-main.yml` | push to the default branch | `leaks` (full history), `test`, `integration`, `security` |

Each command job is skipped when its input is empty, so a repository adopts only
what it owns. Product-specific tests, packaging and distribution stay in the
application repository; the workflows run its commands and nothing else.

## Inputs

Common: `runner` (default `ubuntu-latest`), `go-version` (default `1.25`; used
for the leak scanner and available to app commands), `bun-version` (empty skips
installation), `leak-scan` (default `true`).

`validate-pr.yml`: `lint-command`, `build-command`.

`validate-main.yml`: `test-command`, `integration-command`, `security-command`.

Commands run with `bash -euo pipefail -c` from the repository root. They are
passed through an environment variable, never interpolated into a script. Any
other toolchain must be installed or vendored by the command itself or provided
by the runner. No secrets are declared or accepted.

## Permissions

Every workflow and job sets `contents: read` and nothing else. The checkout does
not persist credentials. Callers must grant at most `contents: read`; the
contract tests reject `contents: write`, `packages: write` and `id-token: write`,
and any release, tag, publish, deploy, dispatch or artifact-upload step.

## Outputs and reports

There are no workflow outputs. The result is the check status of each job plus
its log. These are validation reports only. They are not distributables: nothing
produced in CI is a release artifact, and local release tooling must not
require a green run or any CI artifact.

## Consumer usage and pinning

See [the example consumer](examples/consumer-validation.yml). Pin each `uses:`
to a reviewed full commit SHA of this repository; review the diff before moving
the pin and keep the previous SHA as the rollback pin. Tagged versions apply to
the local release tool, not to this repository.

## Consumer inventory and migration

Intended consumers: scratchpad, usb-boop, pr-nanny and paw-proxy. Migration per
repository: add a workflow like the example calling both contracts with its own
commands (for example its `task` targets), keep required-check names stable
(`pr / lint`, `pr / build`, `main / test` and so on), and remove any release,
publish or deploy jobs from its CI after the local release path is in use.

The `image-build.yml`, `image-tag-release.yml`, `deploy.yml` and `rollout.yml`
workflows are unchanged and remain for unrelated consumers. None of the four
applications may call them for releases. Removing them would need a separate
consumer audit and migration.

## Scanner

Leak scanning runs gitleaks, pinned to an exact version, via `go run`: the
working tree on pull requests and full Git history after merge. Findings are
redacted in logs.
