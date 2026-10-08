import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = Bun.YAML.parse(await Bun.file('.github/workflows/image-tag-release.yml').text()) as any;
const ordinary = Bun.YAML.parse(await Bun.file('.github/workflows/image-build.yml').text()) as any;
const sourceScript = workflow.jobs.validate.steps.find((step: any) => step.id === 'source').run;
const registryScript = workflow.jobs.validate.steps.find((step: any) => step.id === 'registry').run.split("bun <<'JS'\n")[1].split('\nJS')[0];
const buildScript = workflow.jobs.build.steps.find((step: any) => step.id === 'build').run;
const temporary = mkdtempSync(join(tmpdir(), 'ci-tag-release-tests-'));
let sequence = 0;
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function command(cwd: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: args, cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString());
  return Buffer.from(result.stdout).toString().trim();
}

async function repository(kind = 'annotated') {
  const path = join(temporary, 'repo-' + sequence++);
  mkdirSync(path);
  command(path, ['git', 'init', '-q', '-b', 'main']);
  command(path, ['git', 'config', 'user.name', 'Synthetic CI']);
  command(path, ['git', 'config', 'user.email', 'ci@example.invalid']);
  await Bun.write(join(path, 'fixture'), 'one');
  command(path, ['git', 'add', 'fixture']);
  command(path, ['git', 'commit', '-qm', 'Synthetic initial commit']);
  if (kind === 'outside-main') {
    command(path, ['git', 'switch', '-qc', 'other']);
    await Bun.write(join(path, 'fixture'), 'two');
    command(path, ['git', 'commit', '-qam', 'Synthetic off-branch commit']);
  }
  if (kind === 'lightweight') command(path, ['git', 'tag', 'v1.2.3']);
  else command(path, ['git', 'tag', '-a', 'v1.2.3', '-m', 'Synthetic annotated release']);
  const sha = command(path, ['git', 'rev-parse', 'v1.2.3^{commit}']);
  if (kind === 'outside-main') command(path, ['git', 'switch', '-q', 'main']);
  command(path, ['git', 'remote', 'add', 'origin', path]);
  return { path, sha };
}

function resolveSource(repo: { path: string; sha: string }, overrides: Record<string, string> = {}) {
  const output = join(temporary, 'source-output-' + sequence++);
  const result = Bun.spawnSync({
    cmd: ['bash', '-c', sourceScript], cwd: repo.path, stdout: 'pipe', stderr: 'pipe',
    env: {
      ...process.env, RELEASE_TAG: 'v1.2.3', DEFAULT_BRANCH: 'main', CHECKOUT_TOKEN: 'synthetic-only',
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_SHA: repo.sha,
      GITHUB_OUTPUT: output, ...overrides,
    },
  });
  return { result, output };
}

describe('actual annotated-tag source gate', () => {
  test('annotated tag push derives its immutable object and commit', async () => {
    const repo = await repository();
    const { result, output } = resolveSource(repo);
    expect(result.exitCode).toBe(0);
    const lines = (await Bun.file(output).text()).trim().split('\n');
    expect(lines[0]).toBe('source_sha=' + repo.sha);
    expect(lines[1].slice('tag_object='.length)).toMatch(/^[a-f0-9]{40}$/);
    expect(command(repo.path, ['git', 'config', '--local', '--get-regexp', '^remote'])).not.toContain('AUTHORIZATION');
  });
  test('manual default-branch execution resolves the existing tag', async () => {
    const repo = await repository();
    expect(resolveSource(repo, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' }).result.exitCode).toBe(0);
  });
  test('rejects PR execution, other manual branches, wrong push SHA and malformed tags', async () => {
    const repo = await repository();
    for (const overrides of [
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' },
      { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/other' },
      { GITHUB_SHA: 'a'.repeat(40) }, { RELEASE_TAG: '../escape' },
    ]) expect(resolveSource(repo, overrides).result.exitCode).not.toBe(0);
  });
  test('rejects lightweight tags and commits outside the default branch', async () => {
    expect(resolveSource(await repository('lightweight')).result.exitCode).not.toBe(0);
    expect(resolveSource(await repository('outside-main')).result.exitCode).not.toBe(0);
  });
});

const sourceSha = 'a'.repeat(40);
const image = 'ghcr.io/example/project/sidecar';
function document(value: unknown) {
  const body = JSON.stringify(value);
  return { body, digest: 'sha256:' + new Bun.CryptoHasher('sha256').update(body).digest('hex') };
}
function registryFixture(revision = sourceSha, architectures = ['amd64', 'arm64'], version = 'v1.2.3', falsePlatform = false) {
  const responses: Record<string, { body: string; digest: string }> = {};
  const descriptors = architectures.map(architecture => {
    const config = document({ os: 'linux', architecture: falsePlatform ? 'amd64' : architecture, config: { Labels: {
      'org.opencontainers.image.revision': revision,
      'org.opencontainers.image.source': 'https://github.com/example/project',
      'org.opencontainers.image.version': version,
    } } });
    const platform = document({ schemaVersion: 2, config: { digest: config.digest } });
    responses[config.digest] = config;
    responses[platform.digest] = platform;
    return { platform: { os: 'linux', architecture }, digest: platform.digest };
  });
  const index = document({ schemaVersion: 2, manifests: descriptors });
  responses['v1.2.3'] = index;
  responses['sha-' + sourceSha] = index;
  return responses;
}

function mockFetch(url: string, options: any = {}) {
  // Serialized into the child process below; every request must remain read-only.
  const settings = (globalThis as any).fixtureSettings;
  if (options.method && options.method !== 'GET') throw new Error('Preflight attempted a registry mutation');
  if (!String(url).startsWith('https://ghcr.io/')) throw new Error('Unexpected registry host');
  if (String(url).includes('/token?')) {
    if (!String(url).includes('%3Apull')) throw new Error('Unexpected authorization scope');
    return new Response(JSON.stringify({ token: 'synthetic-pull-only' }), { status: settings.tokenStatus ?? 200 });
  }
  if (settings.status) return new Response('synthetic failure', { status: settings.status });
  const item = settings.responses[String(url).split('/').at(-1)];
  if (!item) return new Response('missing', { status: 404 });
  return new Response(item.body, { headers: { 'docker-content-digest': settings.badDigest ? 'sha256:' + 'f'.repeat(64) : item.digest } });
}

async function inspectRegistry(settings: any = {}) {
  settings.responses ??= {};
  const directory = join(temporary, 'registry-' + sequence++);
  mkdirSync(directory);
  const script = join(directory, 'run.mjs');
  const output = join(directory, 'output');
  await Bun.write(script, 'globalThis.fixtureSettings=' + JSON.stringify(settings) +
    ';\nglobalThis.fetch=' + mockFetch.toString() + ';\n' + registryScript);
  const result = Bun.spawnSync({
    cmd: [process.execPath, script], stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, BUILD_IMAGE: settings.image ?? image, RELEASE_TAG: 'v1.2.3', SOURCE_SHA: sourceSha,
      GITHUB_REPOSITORY: 'example/project', GITHUB_ACTOR: 'synthetic', GH_TOKEN: 'synthetic-only', GITHUB_OUTPUT: output },
  });
  return { result, output };
}

describe('actual read-only immutable registry gate', () => {
  test('only two 404 aliases permit initial publication', async () => {
    const { result, output } = await inspectRegistry();
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(output).text()).toBe('reuse=false\n');
  });
  test('matching two-architecture aliases with source labels are reused', async () => {
    const responses = registryFixture();
    const { result, output } = await inspectRegistry({ responses });
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(output).text()).toContain('reuse=true\ndigest=' + responses['v1.2.3'].digest + '\nimage=' + image + '@');
  });
  test('authorization, permission and registry failures never permit overwrites', async () => {
    for (const status of [401, 403, 429, 500]) expect((await inspectRegistry({ status })).result.exitCode).not.toBe(0);
    expect((await inspectRegistry({ tokenStatus: 401 })).result.exitCode).not.toBe(0);
  });
  test('partial, mismatched, single-architecture and wrong-source aliases fail closed', async () => {
    const partial = registryFixture();
    delete partial['v1.2.3'];
    const mismatched = registryFixture();
    mismatched['v1.2.3'] = document({ schemaVersion: 2, manifests: [] });
    for (const responses of [partial, mismatched, registryFixture(sourceSha, ['amd64']), registryFixture('b'.repeat(40)),
      registryFixture(sourceSha, ['amd64', 'arm64'], 'v9.0.0'), registryFixture(sourceSha, ['amd64', 'arm64'], 'v1.2.3', true)]) {
      expect((await inspectRegistry({ responses })).result.exitCode).not.toBe(0);
    }
  });
  test('digest corruption and escaped/cross-repository image paths are rejected', async () => {
    expect((await inspectRegistry({ responses: registryFixture(), badDigest: true })).result.exitCode).not.toBe(0);
    for (const invalid of ['ghcr.io/example/other/sidecar', 'example.invalid/example/project', 'ghcr.io/example/project/../escape']) {
      expect((await inspectRegistry({ image: invalid })).result.exitCode).not.toBe(0);
    }
  });
});

describe('actual build cleanup and policy', () => {
  const cleanup = buildScript.slice(buildScript.indexOf('cleanup() {'), buildScript.indexOf('test -n "$REGISTRY_USERNAME"'));
  test('EXIT and signals preserve status while removing credentials and outputs', async () => {
    for (const [finish, status] of [['exit 0', 0], ['exit 42', 42], ['kill -HUP $$', 129], ['kill -INT $$', 130], ['kill -TERM $$', 143]] as const) {
      const work = join(temporary, 'cleanup-' + sequence++);
      mkdirSync(join(work, 'auth'), { recursive: true });
      mkdirSync(join(work, 'state/cache'), { recursive: true });
      await Bun.write(join(work, 'auth/config.json'), 'synthetic-only');
      await Bun.write(join(work, 'image.tar'), 'synthetic-output');
      await Bun.write(join(work, 'state/cache/read-only'), 'preserved until container teardown');
      chmodSync(join(work, 'state/cache'), 0o555);
      const result = Bun.spawnSync({ cmd: ['sh', '-c', 'work="$WORK"; DOCKER_CONFIG="$work/auth"; ' + cleanup + '\n' + finish],
        env: { ...process.env, WORK: work }, stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode).toBe(status);
      expect(await Bun.file(join(work, 'auth/config.json')).exists()).toBe(false);
      expect(await Bun.file(join(work, 'image.tar')).exists()).toBe(false);
      expect(await Bun.file(join(work, 'state/cache/read-only')).exists()).toBe(true);
      chmodSync(join(work, 'state/cache'), 0o755);
    }
  });
  test('cleanup failure changes success to a failure', () => {
    const result = Bun.spawnSync({ cmd: ['sh', '-c', 'work=/synthetic; DOCKER_CONFIG=/synthetic/auth; rm() { return 1; }; ' + cleanup + '\nexit 0'], stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(1);
  });
  test('ordinary publishing guard remains intact and release uses bundled emulator', () => {
    expect(ordinary.jobs.build.steps.find((step: any) => step.id === 'build').run).toContain('Publishing requires a push to the default branch');
    expect(buildScript).toContain('/usr/bin/buildkit-qemu-aarch64');
    expect(buildScript).toContain('name=$BUILD_IMAGE:$RELEASE_TAG,$BUILD_IMAGE:sha-$BUILD_SHA');
    expect(workflow.jobs.build.if).toBe("needs.validate.outputs.reuse == 'false'");
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });
  test('ordinary helper rejects unsupported platforms before executing a build', () => {
    const run = ordinary.jobs.build.steps.find((step: any) => step.id === 'build').run;
    for (const platforms of ['linux/arm64', 'linux/amd64,linux/riscv64', 'linux/amd64;echo unsafe']) {
      const result = Bun.spawnSync({ cmd: ['sh', '-c', run], stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, BUILD_PLATFORMS: platforms } });
      expect(result.exitCode).not.toBe(0);
      expect(Buffer.from(result.stderr).toString()).toContain('Unsupported build platforms');
    }
  });
});
