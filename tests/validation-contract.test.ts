import { describe, expect, test } from 'bun:test';

const names = ['validate-pr', 'validate-main'];
const load = async (path: string) => Bun.YAML.parse(await Bun.file(path).text()) as any;
const workflows: Record<string, any> = {};
const sources: Record<string, string> = {};
for (const name of names) {
  const path = `.github/workflows/${name}.yml`;
  workflows[name] = await load(path);
  sources[name] = await Bun.file(path).text();
}
const trigger = (workflow: any) => workflow.on ?? workflow.true;
const example = await load('docs/examples/consumer-validation.yml');

const allSteps = (workflow: any) => Object.values<any>(workflow.jobs).flatMap(job => job.steps ?? []);
const permissionBlocks = (workflow: any) => [workflow.permissions, ...Object.values<any>(workflow.jobs).map(job => job.permissions)];

describe.each(names)('%s', name => {
  const workflow = workflows[name];

  test('is a reusable workflow only', () => {
    expect(Object.keys(trigger(workflow))).toEqual(['workflow_call']);
  });

  test('grants only contents: read at workflow and job level', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const [id, job] of Object.entries<any>(workflow.jobs)) {
      expect(job.permissions, id).toEqual({ contents: 'read' });
    }
    for (const block of permissionBlocks(workflow)) {
      for (const scope of ['contents', 'packages', 'id-token', 'actions', 'deployments', 'pull-requests', 'attestations']) {
        if (scope !== 'contents') expect(block?.[scope]).toBeUndefined();
      }
      expect(Object.values(block ?? {}).includes('write')).toBe(false);
    }
    expect(sources[name]).not.toMatch(/:\s*write\b/);
  });

  test('declares no secrets and does not use secrets or tokens', () => {
    expect(trigger(workflow).workflow_call.secrets).toBeUndefined();
    expect(sources[name]).not.toMatch(/\$\{\{\s*secrets\.|^\s*secrets:|github\.token|GITHUB_TOKEN|GH_TOKEN/m);
  });

  test('has no release, tag, publish, deploy or dispatch capability', () => {
    const forbidden = /\b(git\s+(tag|push)|gh\s+(release|workflow|api|pr)|docker\s+(push|login)|npm\s+publish|goreleaser|cosign|brew\b|kubectl|helm\b|workflow_dispatch|repository_dispatch|upload-release-asset|create-release|attest|upload-artifact|ghcr\.io|image-build|image-tag-release|deploy\.yml|rollout\.yml)\b/i;
    expect(sources[name].replace(/^\s*#.*$/gm, '')).not.toMatch(forbidden);
    for (const step of allSteps(workflow)) {
      expect(String(step.uses ?? '')).not.toMatch(/release|publish|deploy|dispatch|docker\/(build|login)|attest|cosign/i);
    }
  });

  test('pins every action by full commit SHA with a version comment', () => {
    const lines = sources[name].split('\n').filter(line => /^\s*(-\s+)?uses:/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d/);
    }
  });

  test('checkout never persists credentials', () => {
    const checkouts = allSteps(workflow).filter(step => String(step.uses).startsWith('actions/checkout@'));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) expect(step.with['persist-credentials']).toBe(false);
  });

  test('application commands arrive through env, not script interpolation', () => {
    for (const step of allSteps(workflow)) {
      if (step.run) expect(step.run).not.toContain('${{');
    }
  });

  test('every job sets a timeout', () => {
    for (const [id, job] of Object.entries<any>(workflow.jobs)) expect(job['timeout-minutes'], id).toBeGreaterThan(0);
  });
});

describe('PR and main separation', () => {
  const inputs = (name: string) => Object.keys(trigger(workflows[name]).workflow_call.inputs);

  test('PR contract covers leak, lint and build only', () => {
    expect(Object.keys(workflows['validate-pr'].jobs)).toEqual(['leaks', 'lint', 'build']);
    expect(inputs('validate-pr')).toEqual(expect.arrayContaining(['lint-command', 'build-command']));
    expect(inputs('validate-pr')).not.toContain('test-command');
  });

  test('main contract covers history leak scan, tests, integration and security', () => {
    expect(Object.keys(workflows['validate-main'].jobs)).toEqual(['leaks', 'test', 'integration', 'security']);
    const leaks = workflows['validate-main'].jobs.leaks.steps[0];
    expect(leaks.with['fetch-depth']).toBe(0);
  });

  test('leak scanner is pinned to an exact version', () => {
    for (const name of names) expect(sources[name]).toMatch(/gitleaks\/v8@v\d+\.\d+\.\d+ /);
  });
});

describe('documented consumer example', () => {
  test('separates PR and main callers with read-only permissions', () => {
    expect(example.permissions).toEqual({ contents: 'read' });
    expect(example.jobs.pr.uses).toContain('/validate-pr.yml@');
    expect(example.jobs.main.uses).toContain('/validate-main.yml@');
    expect(example.jobs.pr.if).toContain('pull_request');
    expect(example.jobs.main.if).toContain('push');
    for (const job of Object.values<any>(example.jobs)) {
      expect(job.permissions).toEqual({ contents: 'read' });
      expect(job.secrets).toBeUndefined();
    }
    expect(example.jobs.pr.with['test-command']).toBeUndefined();
  });

  test('never calls the image, deploy or rollout workflows', async () => {
    const text = await Bun.file('docs/examples/consumer-validation.yml').text();
    expect(text).not.toMatch(/image-build|image-tag-release|deploy\.yml|rollout\.yml/);
  });
});

describe('existing shared workflows are retained', () => {
  test.each(['image-build', 'image-tag-release', 'deploy', 'rollout'])('%s.yml exists', async name => {
    expect(await Bun.file(`.github/workflows/${name}.yml`).exists()).toBe(true);
  });
});
