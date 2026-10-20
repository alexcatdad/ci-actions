# Read-only repository audit

Use Bun and an authenticated GitHub CLI from this checkout. Select one repository
explicitly; the command does not enumerate an account or infer a target from the
current directory. It calls only fixed GitHub REST GET endpoints on github.com.
The optional `--usage` mode adds a bounded workflow-run/job sample; it is an
observation of elapsed execution time, not a billing report.

```sh
umask 077
bun scripts/audit-repository.ts --repo OWNER/REPO > /path/outside/checkout/audit.json
# Optional bounded run/job sample
bun scripts/audit-repository.ts --repo OWNER/REPO --usage > /path/outside/checkout/audit-usage.json
```

The JSON records merge settings (including the observed `allow_auto_merge`
repository setting), visible security-analysis settings, Actions permissions,
default workflow-token permissions, ruleset summaries (including parent
rulesets), active rules for the default branch, classic protection, eligibility
observations, and check runs/legacy commit statuses at the observed
default-branch SHA. Lists are paginated. The branch SHA is read again at the end
to detect concurrent changes. For private personal repositories, eligibility
matches the authenticated `/user` login to the repository owner and observes
the owner's plan; for classic personal access tokens, GitHub requires the
`read:user` scope to return private user fields. Repository `admin` permission
is reported separately. It does not prove `Administration: write` token scope.

With `--usage`, the audit samples at most the latest 20 workflow runs and fetches
all job attempts for each run, with job pages paginated. Completed jobs with
valid start and completion timestamps are ranked by elapsed seconds. The audit
also reads the paginated repository runner inventory (IDs only). It labels a
job `self-hosted` when its labels include `self-hosted` or its runner ID matches
that inventory; conventional `ubuntu`, `windows` or `macos` version/latest
labels are marked `github-hosted-inferred`. This label heuristic is not billing
proof; custom and ARC labels without an inventory match remain `unknown`.
Failed job sampling makes the usage section incomplete. This duration excludes
billing rounding, plan multipliers and rates, and the sample may be truncated.
Billing is reported unavailable because the current REST billing API documents
no personal-account Actions-usage endpoint. Use the owner Billing and licensing
/ Usage view for billed usage; do not extrapolate costs from sampled duration.

As documented on 20 October 2026, GitHub Free includes 2,000 standard-runner
minutes/month, 500 MB shared artifact/Packages storage and 10 GB Actions cache
per repository; Pro includes 3,000 minutes, 1 GB shared storage and the same
10 GB cache allowance. Standard hosted runner use is free for public
repositories; private use consumes the owner's allowance. Larger runners are
always charged. Treat these as plan allowances, not a cost estimate for a
particular workflow.

Unavailable requests retain their HTTP status when gh supplies it. A 403 or 404
can mean missing access or an unavailable feature; the command does not turn it
into an absent control or infer the account's plan. An unprotected branch can
also return 404 for classic protection. Missing JSON fields are null, not false.

Exit codes: `0` means the selected repository settings/check collection was
complete and the branch SHA remained unchanged; with `--usage`, the requested
job sample must also be complete. It does not mean the repository is eligible
for a settings change, optional runner inventory is known, or billing data is
available. `2` means incomplete required evidence or a changed branch; `1` means
invalid arguments or an unexpected fatal error. These are collection results,
not a security grade or a merge decision. Existing CI checks run synthetic tests
without making authenticated API requests.

Keep reports in approved private storage. They may contain private repository
names, rules, actor identifiers and workflow/check names. The tool does not read
secret values or workflow contents, but its output is not automatically safe to
publish. Raw gh diagnostics are omitted from reports.

This is a point-in-time review aid, not a transaction: settings can change during
or after collection, even when the branch SHA is unchanged. Ruleset summaries do
not include disabled/evaluating rule payloads; active rules and classic protection
must be reviewed together. A default-branch check name is evidence of execution,
not proof that every PR emits it. Legacy statuses have no verified integration
binding. Validate a fresh representative PR before requiring any context.

The audit does not inspect environment gates, fork approvals, dependency-alert
coverage, runner isolation, review comments or account recovery. It does not
apply settings, decide which checks to require, enable auto-merge, or unlock paid
features. `allow_auto_merge` is an observation only; the owner must enable that
repository setting where supported. Review changes separately and preserve
unrelated controls before any explicit write.

API references: [gh api](https://cli.github.com/manual/gh_api),
[rulesets and active branch rules](https://docs.github.com/en/rest/repos/rules),
[classic protection](https://docs.github.com/en/rest/branches/branch-protection),
[Actions permissions](https://docs.github.com/en/rest/actions/permissions),
[authenticated user and private fields](https://docs.github.com/en/rest/users/users),
[check runs](https://docs.github.com/en/rest/checks/runs),
[commit statuses](https://docs.github.com/en/rest/commits/statuses),
[workflow jobs and runner labels/timestamps](https://docs.github.com/en/rest/actions/workflow-jobs),
[Actions billing and included allowances](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[REST billing API](https://docs.github.com/en/rest/billing/usage).
