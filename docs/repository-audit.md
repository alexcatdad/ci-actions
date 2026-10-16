# Read-only repository audit

Use Bun and an authenticated GitHub CLI from this checkout. Select one repository
explicitly; the command does not enumerate an account or infer a target from the
current directory. It calls only fixed GitHub REST GET endpoints on github.com.

```sh
umask 077
bun scripts/audit-repository.ts --repo OWNER/REPO > /path/outside/checkout/audit.json
```

The JSON records merge settings, visible security-analysis settings, Actions
permissions, default workflow-token permissions, ruleset summaries (including
parent rulesets), active rules for the default branch, classic protection, and
check runs/legacy commit statuses at the observed default-branch SHA. Lists are
paginated. The branch SHA is read again at the end to detect concurrent changes.

Unavailable requests retain their HTTP status when gh supplies it. A 403 or 404
can mean missing access or an unavailable feature; the command does not turn it
into an absent control or infer the account's plan. An unprotected branch can
also return 404 for classic protection. Missing JSON fields are null, not false.

Exit codes: `0` means all selected requests were observed and the branch SHA
remained unchanged; `2` means incomplete evidence or a changed branch; `1` means
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
apply settings, decide which checks to require, or unlock paid features. Review
changes separately and preserve unrelated controls before any explicit write.

API references: [gh api](https://cli.github.com/manual/gh_api),
[rulesets and active branch rules](https://docs.github.com/en/rest/repos/rules),
[classic protection](https://docs.github.com/en/rest/branches/branch-protection),
[Actions permissions](https://docs.github.com/en/rest/actions/permissions),
[check runs](https://docs.github.com/en/rest/checks/runs),
[commit statuses](https://docs.github.com/en/rest/commits/statuses).
