# Repository defaults

This public repository holds reusable workflow/action implementation and generic
repository guidance. Callers own project-specific tests, events, permissions,
secrets and deployment policy. Keep private inventories, audit findings and
operational decisions in approved private storage. These plan details were
checked against GitHub documentation on 20 October 2026.

## Shared contracts and runner choice

Preserve existing checkout, cache, release and deployment guards. Pin consumers
to reviewed immutable commits, document input/output and check-name changes,
keep a rollback pin, and validate the relevant public and private callers before
broad adoption. A reusable workflow does not change caller-owned project policy.
Pass only named secrets required by the called workflow.

Use standard GitHub-hosted Linux for lightweight checks, including private
personal repositories when the owner's included allowance is suitable. Keep
ordinary CI small: avoid redundant jobs, use caller concurrency to cancel
superseded pull request runs, and serialize releases without cancellation. Use
homelab runners for heavier jobs that need their specialized infrastructure,
after confirming the repository's trust boundary and the runner's isolation.
Keep sensitive workloads on infrastructure that meets their existing trust
requirements; do not move them to less trusted infrastructure to reduce cost.
Use native macOS runners only when a check requires macOS. Do not infer savings
from runner labels or elapsed duration alone; compare actual workload, included
minutes, multipliers and measured results.

Treat cache as shared build data. Scope entries to the repository and relevant
build inputs, keep credentials out of layers, and review which PR refs may read
or write them. This repository's image workflow uses GitHub Actions cache v2
with fresh local runner state; see the [README cache contract](../README.md#durable-image-layer-cache).

## Branch rules and plan eligibility

[ci-actions-main.json](../rules/ci-actions-main.json) proposes protection for
this repository's default branch: PRs with zero required approvals, resolved
review threads, no deletion/force pushes, and successful checks from GitHub
Actions: `contracts`, `multiarch / build`, `fixture / build` and `digest`.
Branches must be up to date before merging, and the payload grants no bypass
actors. All four checks are required so a skipped dependent job cannot hide a
failed build.

GitHub rulesets are available for public repositories on GitHub Free and for
public and private repositories on GitHub Pro. Native PR auto-merge has the
same public-Free and public/private-Pro availability. Private Free personal
repositories do not have those two features. This ruleset command additionally
supports only non-archived personal repositories; it verifies the private
repository owner by matching `/user` to the repository owner and observing
`plan.name == pro`. The authenticated-user response needs appropriate access to
private user fields; for classic personal access tokens this requires the
`read:user` scope. Missing or unrecognized plan information fails closed.

The audit's repository metadata reports the caller's repository permission,
including whether `admin` is true. That supports a plan-readiness check, but a
GET response does not prove the token has `Administration: write`. The API
write permission remains unverified until the owner configures credentials and
GitHub authorizes a write. Do not treat a plan or a successful read as approval
to change settings.

The JSON is a proposed repository-ruleset API payload, not an installer.
Creating an active ruleset immediately enforces its rules. Review existing
controls, the proposed rules and fresh representative PR results together;
preserve unrelated rules. Other repositories need their own check names and
settings. No implementation should copy these contexts unchanged by default.

## Native auto-merge

Repository-level auto-merge must first be enabled by the repository owner in
repository settings. That setting is outside this repository's audit writes and
ruleset creation tool. After owner approval, use GitHub's native auto-merge for
an individually reviewed PR only after checking its exact head, required checks
and reviews. GitHub waits for configured requirements; auto-merge does not
approve a change or waive a required review.

References: [ruleset availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
[native auto-merge availability and behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request),
[authenticated user and private fields](https://docs.github.com/en/rest/users/users),
[ruleset API permissions](https://docs.github.com/en/rest/repos/rules),
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
