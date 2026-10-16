# Contributing

Keep shared changes small and preserve caller-owned triggers, permissions,
tests and deployment policy. Extract repeated behavior only when its contract
is clear; project-specific commands belong in the caller.

Run from the repository root with Bun, Go and ShellCheck available:

```sh
bun test tests
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/*.yml
git diff --check
```

The contract tests use synthetic local Git/registry data. Hosted image fixtures,
cache acceptance and actual registry publication are separate checks. Run the
applicable hosted fixtures before adopting a changed shared workflow; use the
README runbook for an explicitly authorized cache acceptance run.

Describe input/output, permission, runner or visible check-name changes in the
PR. Keep existing callers compatible or document the migration and rollback
pin. Consumers should adopt a reviewed immutable commit rather than a moving
branch. Resolve actionable review feedback and recheck the latest PR commit.
