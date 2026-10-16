# Repository defaults

This public repository holds reusable workflow/action implementation and generic
repository guidance. Callers own project-specific tests, events, permissions,
secrets and deployment policy. Keep private inventories, audit findings and
operational decisions in the caller's approved private storage.

## Shared contracts

Preserve existing checkout, cache, release and deployment guards. Public PR
checks use GitHub-hosted runners; custom runners need a separately verified
trust boundary. Pass only named secrets required by the called workflow.

Pin consumers to reviewed immutable commits. Document input/output and visible
check-name changes, keep a rollback pin, and verify applicable public/private
callers before broad adoption. A private pilot validates reuse, not paid-only
branch enforcement. Do not introduce a generic workflow for one-off commands.

## Branch rules

[ci-actions-main.json](../rules/ci-actions-main.json) proposes protection for this
repository's default branch: PRs with zero required approvals, resolved review
threads, no deletion/force pushes, and successful checks from GitHub Actions:
`contracts`, `multiarch / build`, `fixture / build` and `digest`. Branches must be
up to date before merging, and the payload grants no bypass actors. All four
checks are required so a skipped dependent job cannot hide a failed build.

The JSON is a proposed repository-ruleset API payload, not an installer. No
workflow reads or applies it. Applying it would immediately enforce the rules;
obtain approval and verify fresh PR results first. Re-read existing controls
before applying and preserve unrelated rules. Other repositories need their own
check names and settings; do not copy these required contexts unchanged.

## GitHub Free personal accounts

Public repositories can use branch rules, native auto-merge, supported security
analysis and deployment environments. Private Free repositories can use ordinary
CI, repository secrets and basic dependency protection, but do not get the same
native merge or environment gates. Shared files do not unlock unavailable
features. A manual workflow trigger is not a separate authorization boundary.

Keep tokens read-only unless a job needs more. Require review of sensitive
workflow/dependency changes; version updates do not authorize automatic merges.
Choose applicable checks instead of adding empty jobs for content-only projects.

References: [reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
[required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks),
[environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
