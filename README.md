# Shared CI workflows

Small public helpers for project-owned GitHub Actions workflows. This first
workflow builds one Linux amd64 Dockerfile with rootless BuildKit, with an optional
AMD64/ARM64 pair. A separate workflow preserves annotated-tag image releases.
Callers keep
their triggers, tests, release policy and deployment. Go and Node checks stay
in each project until repeated migrations justify extracting them.

## Build an image

Pin the shared workflow to a reviewed commit SHA. The caller must explicitly
grant `contents: read`; add `packages: write` only to its GHCR publishing job.
The reusable workflow preserves caller permissions and requests no additional
permissions. Public projects use the default
GitHub-hosted runner. Private projects can set `runner: homelab` when that runner
has the isolated BuildKit container policy described below.

```yaml
jobs:
  image:
    permissions:
      contents: read
    uses: alexcatdad/ci-actions/.github/workflows/image-build.yml@REVIEWED_COMMIT_SHA
    with:
      runner: homelab # omit for GitHub-hosted ubuntu-latest
      context: .
      dockerfile: Dockerfile
      image: ghcr.io/alexcatdad/example
```

Inputs accept repository-relative paths within the checkout and a fully
qualified lower-case registry/image name without a tag. The workflow fetches the
caller commit (the PR head for pull requests) with a transient contents-read token;
it persists no checkout credentials. Checkout uses a disposable `/tmp` directory
rather than relying on host workspace ownership. Submodules and Git LFS are not fetched.

With `publish: false` (the default), BuildKit exports and verifies a disposable
OCI image, returning `digest` and `image` outputs. Credentials and build outputs
are removed by the build-step exit handler; the image is not available from a
registry. BuildKit snapshot state, including read-only package caches and mapped
UID files, is physically removed when the disposable container is torn down.
Every job has fresh local state; ordinary builds reuse repository-scoped remote layer cache as described below.

## Publish from the default branch

Use a separate caller job with a trusted default-branch push guard and pass only
its registry credentials. The called workflow also checks this policy before
pushing a `sha-<commit>` tag. `image` returns an immutable `name@sha256:...`
reference for a subsequent project-owned deployment job.

```yaml
jobs:
  publish:
    if: github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    permissions:
      contents: read
      packages: write # needed only when GITHUB_TOKEN publishes to GHCR
    uses: alexcatdad/ci-actions/.github/workflows/image-build.yml@REVIEWED_COMMIT_SHA
    with:
      runner: homelab
      image: ghcr.io/alexcatdad/example
      publish: true
    secrets:
      registry-username: ${{ github.actor }}
      registry-password: ${{ secrets.GITHUB_TOKEN }}
```

The caller grants GHCR package access or supplies a repository-specific registry
credential. Do not use `secrets: inherit`. PR build jobs receive no registry
credentials. This workflow deploys nothing and has no production secrets.

## Runner requirements and isolation

The exact BuildKit 0.33.1 rootless image digest is pinned. GitHub-hosted execution
uses a nonprivileged Docker job container with seccomp/AppArmor allowances for
nested user namespaces. Each shell step initially fixes ownership of only its
GitHub file-command files (output, environment, PATH and summary), then immediately
switches to the image user UID/GID 1000. The temporary root shim has only CHOWN,
SETUID and SETGID capabilities; checkout, BuildKit and Dockerfile execution always
run as UID 1000. On ARC, the pod is already UID 1000 and skips the shim. No Docker socket is mounted in the build
container. Rootless BuildKit uses the native snapshotter and no process sandbox,
with the upstream runc keyring workaround for hosts that deny `keyctl`.

ARC must provide an equivalent **dedicated build policy** for this exact image:
UID/GID 1000, writable ephemeral volumes, subordinate-user mappings, the scoped
host seccomp profile and permission for the image's `newuidmap` helpers. The
ordinary restricted check-job template cannot run this image unchanged. Container
`options` are for hosted Docker; they do not configure Kubernetes security.
The runner administrator owns this policy; callers cannot select arbitrary
images or pass shell commands. Run only first-party trusted PRs on homelab.
Each job is disposable and must have no access to production namespaces,
credentials, host Docker sockets or shared build state. Without a process
sandbox, Dockerfile processes share the builder's PID namespace, so do not
combine builds from different projects in one job or daemon.

`checks.yml` calls the reusable workflow against a synthetic Dockerfile that
executes `RUN`, checks fixture bytes, creates a read-only package cache and exports
an OCI image. It then asserts
the immutable output. Publishing requires its own registry smoke test before
production adoption.

## Multiarch and annotated-tag releases

The ordinary image helper accepts the additional platforms input with either
linux/amd64 (default) or the exact linux/amd64,linux/arm64 pair. Other combinations
are rejected. The pinned image includes BuildKit-specific QEMU, so no global
binfmt registration or additional capabilities are needed. The hosted fixture
executes shell processes on both architectures without publishing.

The separate image-tag-release.yml reusable workflow takes runner, release-tag,
context, dockerfile and image inputs, with explicit registry-username and
registry-password secrets. Pass the caller actor and GITHUB_TOKEN respectively;
grant contents read and packages write in that caller job. Omit runner for a
public project or set homelab for an enrolled private project.

It accepts only the matching tag push or a manual run from the caller default
branch. The tag must exist, be annotated and peel to a commit reachable from
that default branch. The GHCR image path must belong to the caller repository
or a package beneath it. Pull requests and arbitrary source SHA inputs are rejected.

Read-only preflight uses a package-read GitHub token and checks both the release
and sha-commit aliases. Only two confirmed 404s permit initial publication;
authorization, network and registry failures block it. Matching aliases are reused
after verifying the AMD64/ARM64 index, matching platform configs and each image's
source/revision/version labels.
Partial or inconsistent aliases fail and require a new patch tag and source commit.
The helper serializes all its publications per caller image; callers must keep
other registry writers from changing these immutable aliases.

A fresh disposable rootless builder checks the annotated tag object again and
publishes both aliases to one AMD64/ARM64 index. Outputs are digest, immutable
image and resolved source-sha. Credentials and temporary outputs are removed
on success, failure or signal; container teardown removes BuildKit state.

The caller retains its release-existence check, package validation, digest bundle
generation and GitHub release creation without replacing assets. Use separate
caller jobs when collecting multiple image outputs; matrix workflow outputs can
collapse to the last completion. The helper creates no GitHub releases, changes
no repository tags and deploys nothing.

Contract tests execute the actual source-validation, read-only registry preflight
and cleanup scripts against synthetic local Git and registry data. Tagged
publication and project release acceptance remain separate from nonpublishing tests.
References: [multi-platform builds](https://github.com/moby/buildkit/blob/v0.33.1/docs/multi-platform.md)
and [BuildKit-specific emulators](https://github.com/tonistiigi/binfmt#buildkit-target).

References: [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[BuildKit rootless operation](https://github.com/moby/buildkit/blob/v0.33.1/docs/rootless.md),
[daemonless builds](https://github.com/moby/buildkit/tree/v0.33.1/examples/buildctl-daemonless).

## Durable image layer cache

Ordinary image builds enable GitHub Actions cache v2 by default. GitHub owns the
storage, repository access boundary, ref visibility, quota and eviction; runners
retain no shared disk state. The scope hashes image, platform, context and
Dockerfile paths, so one image configuration cannot replace another's cache.
GitHub permits branch jobs to read their current/default branch caches; pull
request cache writes remain confined to the merge ref. Cache entries can contain
intermediate image files: never copy credentials into a build layer. Cache mounts
(`RUN --mount=type=cache`) are not persisted by this layer exporter.

Set `cache: false` for a complete cache bypass. Set `cache-import: false` to build
cold and still export for a subsequent fresh runner. A SHA-pinned, owned JavaScript
bridge masks the ephemeral job runtime token before exposing it through GitHub's
environment file. Missing or invalid runtime metadata falls back to a cold build;
cache export failures are ignored and transfers are limited to two minutes.
BuildKit treats missing cache records as misses. A terminal solve error explicitly identifying cache import and a transport,
authorization, timeout or service failure retries once without remote import or
export. Compiler and Dockerfile errors remain fatal. Unclassified fatal errors
also remain fatal; rerun with `cache: false` when investigating a cache outage. Registry publication permissions and default-branch gates
remain independent of cache access.

### Cache acceptance runbook

1. Run local contracts with `bun test tests` and syntax validation with
   `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/*.yml`.
2. After the reviewed workflow and bridge commit are available, manually run
   **Fresh runner cache acceptance** on that exact commit using `ubuntu-latest`.
   The workflow builds the same synthetic fixture twice in separate disposable
   jobs, first without import and then with import. It publishes no image.
3. Verify the evidence job passes: equal image digests, zero cold cache hits,
   at least two warm hits. Record both job links, cached-step counts and measured
   seconds from the summary. CPU counters and memory peak are in each build's
   summary when cgroup v2 exposes them; these are whole job-container counters,
   not isolated Dockerfile CPU measurements. Transfer time can exceed the savings
   for this deliberately small fixture; cache hits, not a speed threshold, prove
   durable reuse.
4. In an enrolled private caller repository, repeat the paired cold/warm workflow
   with `runner: homelab` and the same shared workflow SHA to verify ARC. This
   public helper repository is not enrolled in the private homelab runner fleet.
   Pin consumer workflows to the reviewed shared commit. Monitor cold/warm results
   on each repository. GitHub's cache settings/usage view owns quota monitoring
   and manual eviction; eviction is a safe cold-build fallback. No local disk
   cleanup, credentials, cluster storage or cache server is required.
5. Roll back a consumer by setting `cache: false` or restoring its earlier shared
   workflow SHA. Annotated-tag publication currently retains its existing cold
   build behavior and requires separate release acceptance before adding caching.
