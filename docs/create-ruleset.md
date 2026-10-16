# Create a reviewed default-branch ruleset

This opt-in Bun/GitHub CLI command creates one ruleset in one explicitly selected
public personal repository. It does not update/delete existing rulesets or change
other repository settings. Private, organization-owned and archived repositories
are outside this command's scope. Use the read-only audit before proposing policy.

The supported payload is the four-rule baseline illustrated in
[ci-actions-main.json](../rules/ci-actions-main.json): PRs with resolved threads,
required checks from explicit integration IDs, up-to-date branches, and protection
against deletion/force pushes. Approval counts and merge methods remain explicit
payload choices. No bypass actors or expanded branch/tag scope are accepted.
Other rule types and advanced parameters need a separate reviewed implementation.
The ci-actions payload's check names are specific to that repository.

## Plan without writes

```sh
umask 077
bun scripts/create-ruleset.ts plan --repo OWNER/REPO --rules /private/review/rules.json --evidence-pr 123 > /private/review/plan.json
```

The evidence PR must be from the same repository, targeting its current default
branch. Every proposed check must have successful completed check runs at that
PR's head SHA from the specified integration. Pending, skipped, failed, missing
or wrong-integration checks are refused. Choose a recent representative PR and
review the meaning and event coverage of its jobs; success at one SHA does not
prove all future PRs emit a check. This command does not approve code or reviews.

The plan includes the target repository ID/name, default branch SHA, current
ruleset summaries, active branch rules, classic-protection observation, PR/check
evidence, exact proposed payload and SHA-256 approval hash. A classic-protection
404 remains unknown evidence in the plan; other unavailable reads stop planning.
Review existing controls and the proposed addition together. A case-insensitive
ruleset-name collision is refused instead of silently updating or duplicating it.

## Apply only an approved plan

After the owner approves the exact plan and target, use its reviewed hash:

```sh
bun scripts/create-ruleset.ts apply --plan /private/review/plan.json --approve REVIEWED_SHA256
```

Apply validates the payload and hash, re-reads the repository/PR evidence and
refuses any recorded change before issuing one POST. It reads back the created
ruleset and verifies every submitted value, allowing GitHub-added default fields.
The hash detects changed content; it is not authentication or a substitute for
owner authorization. Merging this tooling does not authorize applying a plan.

GitHub provides no atomic compare-and-create guard here. Coordinate one writer:
another writer can change settings or create a duplicate after the last read.
Do not run this concurrently or treat a saved plan as a permanent approval.

On an uncertain write or failed readback, inspect the repository and any returned
ruleset ID before doing anything else. The command does not automatically retry,
delete or roll back policy. Regenerate and review a plan after drift; never edit
the saved baseline to force it through. An API schema error can still reject a
locally validated payload. Creating an active ruleset immediately changes gates.

Keep plans/reports in approved private storage outside the public checkout. They
can contain repository/check names and rule actor metadata. No workflow invokes
this command automatically. Existing contract CI tests use synthetic API/CLI
fixtures; a live write and its operational enforcement require separate approval.

References: [ruleset REST API](https://docs.github.com/en/rest/repos/rules),
[PR evidence](https://docs.github.com/en/rest/pulls/pulls),
[check-run evidence](https://docs.github.com/en/rest/checks/runs),
[GitHub CLI API input](https://cli.github.com/manual/gh_api).
