# Shared CI workflows

Small public helpers for project-owned GitHub Actions workflows. This first
workflow builds one Linux amd64 Dockerfile with rootless BuildKit. Callers keep
their triggers, tests, release policy and deployment. Go and Node checks stay
in each project until repeated migrations justify extracting them.

## Build an image

Pin the shared workflow to a reviewed commit SHA. Public projects use the default
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
OCI image, returning `digest` and `image` outputs. The OCI file is removed at job
completion; the image is not available from a registry. Every job has fresh local
state; no shared or remote cache is configured.

## Publish from the default branch

Use a separate caller job with a trusted default-branch push guard and pass only
its registry credentials. The called workflow also checks this policy before
pushing a `sha-<commit>` tag. `image` returns an immutable `name@sha256:...`
reference for a subsequent project-owned deployment job.

```yaml
jobs:
  publish:
    if: github.event_name == 'push' && github.ref_name == github.event.repository.default_branch
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
executes `RUN`, checks fixture bytes and exports an OCI image. It then asserts
the immutable output. Publishing requires its own registry smoke test before
production adoption.

References: [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[BuildKit rootless operation](https://github.com/moby/buildkit/blob/v0.33.1/docs/rootless.md),
[daemonless builds](https://github.com/moby/buildkit/tree/v0.33.1/examples/buildctl-daemonless).
