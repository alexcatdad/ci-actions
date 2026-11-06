import { describe, expect, test } from 'bun:test';

const validationNames = ['validate-pr', 'validate-main'];
const names = [...validationNames, 'codeql'];
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
const stripComments = (text: string) => text.replace(/^\s*#.*$/gm, '').replace(/\s+#.*$/gm, '');
// The single documented write scope in the whole contract: CodeQL uploading
// code scanning results. See docs/validation-contract.md#permissions.
const allowedWrites: Record<string, Record<string, Record<string, string>>> = {
  codeql: { analyze: { contents: 'read', 'security-events': 'write' } },
};

describe.each(names)('%s', name => {
  const workflow = workflows[name];

  test('is a reusable workflow only', () => {
    expect(Object.keys(trigger(workflow))).toEqual(['workflow_call']);
  });

  test('grants only contents: read, apart from the documented security-events exception', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const allowed = allowedWrites[name] ?? {};
    for (const [id, job] of Object.entries<any>(workflow.jobs)) {
      expect(job.permissions, id).toEqual(allowed[id] ?? { contents: 'read' });
    }
    for (const block of permissionBlocks(workflow)) {
      for (const scope of ['packages', 'id-token', 'actions', 'deployments', 'pull-requests', 'attestations', 'checks', 'statuses', 'issues']) {
        expect(block?.[scope]).toBeUndefined();
      }
      expect(block?.contents).toBe('read');
      for (const [scope, level] of Object.entries(block ?? {})) {
        if (level === 'write') expect(scope).toBe('security-events');
      }
    }
    const writes = stripComments(sources[name]).match(/^\s*[\w-]+:\s*write\b.*$/gm) ?? [];
    const expected = Object.values(allowed).flatMap(block => Object.entries(block).filter(([, level]) => level === 'write'));
    expect(writes.map(line => line.trim())).toEqual(expected.map(([scope]) => `${scope}: write`));
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

  test('PR contract covers leak, dependency review, lint, build and test only', () => {
    expect(Object.keys(workflows['validate-pr'].jobs)).toEqual(['leaks', 'deps', 'lint', 'build', 'test']);
    expect(inputs('validate-pr')).toEqual(expect.arrayContaining(['lint-command', 'build-command', 'test-command', 'dependency-review']));
  });

  test('PR test job is skipped without a command and runs it through env', () => {
    const declared = trigger(workflows['validate-pr']).workflow_call.inputs;
    expect(declared['test-command'].default).toBe('');
    const job = workflows['validate-pr'].jobs.test;
    expect(job.if).toBe("inputs.test-command != ''");
    expect(job['runs-on']).toBe('${{ inputs.runner }}');
    expect(job.permissions).toEqual({ contents: 'read' });
    const run = job.steps.find((step: any) => step.name === 'Test');
    expect(run.env).toEqual({ COMMAND: '${{ inputs.test-command }}' });
    expect(run.run).toBe('bash -euo pipefail -c "$COMMAND"');
  });

  test('dependency review blocks high severity and non-allowlisted licenses on pull requests', () => {
    const deps = workflows['validate-pr'].jobs.deps;
    expect(trigger(workflows['validate-pr']).workflow_call.inputs['dependency-review'].default).toBe(true);
    expect(deps.if).toContain('inputs.dependency-review');
    expect(deps.if).toContain("github.event_name == 'pull_request'");
    expect(deps.permissions).toEqual({ contents: 'read' });
    const review = deps.steps.find((step: any) => String(step.uses).startsWith('actions/dependency-review-action@'));
    expect(review.with['fail-on-severity']).toBe('high');
    expect(review.with['allow-licenses']).toBe('MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, LicenseRef-scancode-google-patent-license-golang');
  });

  test.each(validationNames)('%s defaults Go to 1.27.3 and offers optional Node with corepack', name => {
    const declared = trigger(workflows[name]).workflow_call.inputs;
    expect(declared['go-version'].default).toBe('1.27.3');
    expect(declared['node-version'].default).toBe('');
    for (const [id, job] of Object.entries<any>(workflows[name].jobs)) {
      const steps = job.steps ?? [];
      const hasBun = steps.some((step: any) => String(step.uses).startsWith('oven-sh/setup-bun@'));
      const nodeIndex = steps.findIndex((step: any) => String(step.uses).startsWith('actions/setup-node@'));
      expect(nodeIndex >= 0, id).toBe(hasBun);
      if (nodeIndex < 0) continue;
      expect(steps[nodeIndex].if).toBe("inputs.node-version != ''");
      expect(steps[nodeIndex + 1].if).toBe("inputs.node-version != ''");
      expect(steps[nodeIndex + 1].run).toContain('corepack enable');
    }
  });

  test('main contract covers history leak scan, tests, integration and security', () => {
    expect(Object.keys(workflows['validate-main'].jobs)).toEqual(['leaks', 'test', 'integration', 'security']);
    const leaks = workflows['validate-main'].jobs.leaks.steps[0];
    expect(leaks.with['fetch-depth']).toBe(0);
  });

  test('leak scanner is pinned to an exact version', () => {
    for (const name of validationNames) expect(sources[name]).toMatch(/gitleaks\/v8@v\d+\.\d+\.\d+ /);
  });
});

describe('codeql contract', () => {
  const workflow = workflows.codeql;
  const declared = trigger(workflow).workflow_call.inputs;
  const analyze = workflow.jobs.analyze;

  test('takes languages, swift build command and swift runner inputs', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['analyze']);
    expect(declared.languages.required).toBe(true);
    expect(declared['swift-build-command'].default).toBe('');
    expect(declared['swift-runner'].default).toBe('macos-26');
    expect(declared['go-version'].default).toBe('1.27.3');
    expect(analyze.strategy.matrix.language).toBe('${{ fromJSON(inputs.languages) }}');
    expect(analyze.name).toBe('${{ matrix.language }}');
  });

  test('runs swift on the swift runner and other languages on ubuntu-latest', () => {
    expect(analyze['runs-on']).toBe("${{ matrix.language == 'swift' && inputs.swift-runner || 'ubuntu-latest' }}");
  });

  test('rejects languages outside actions, go, javascript-typescript and swift', () => {
    const check = analyze.steps[0];
    expect(check.run).toContain('actions|go|javascript-typescript|swift) ;;');
    expect(check.run).toContain('exit 1');
  });

  test('analyzes actions and javascript-typescript without a build', () => {
    const init = analyze.steps.find((step: any) => String(step.uses).startsWith('github/codeql-action/init@'));
    expect(init.with['build-mode']).toBe("${{ (matrix.language == 'actions' || matrix.language == 'javascript-typescript') && 'none' || (matrix.language == 'swift' && inputs.swift-build-command != '' && 'manual') || 'autobuild' }}");
    const setupGo = analyze.steps.find((step: any) => String(step.uses).startsWith('actions/setup-go@'));
    expect(setupGo.if).toBe("matrix.language == 'go'");
    const build = analyze.steps.find((step: any) => step.name === 'Build for analysis');
    expect(build.if).toContain("matrix.language == 'swift'");
  });

  test('pins init and analyze to the same codeql-action commit', () => {
    const pins = sources.codeql.match(/github\/codeql-action\/(init|analyze)@([0-9a-f]{40})/g) ?? [];
    expect(pins.length).toBe(2);
    expect(new Set(pins.map(pin => pin.split('@')[1])).size).toBe(1);
  });
});

describe('documented consumer example', () => {
  test('separates PR and main callers with read-only permissions', () => {
    expect(example.permissions).toEqual({ contents: 'read' });
    expect(example.jobs.pr.uses).toContain('/validate-pr.yml@');
    expect(example.jobs.main.uses).toContain('/validate-main.yml@');
    expect(example.jobs.pr.if).toContain('pull_request');
    expect(example.jobs.main.if).toContain('push');
    for (const [id, job] of Object.entries<any>(example.jobs)) {
      const expected = id === 'codeql' ? { contents: 'read', 'security-events': 'write' } : { contents: 'read' };
      expect(job.permissions, id).toEqual(expected);
      expect(job.secrets).toBeUndefined();
    }
    expect(example.jobs.pr.with['test-command']).toBe(example.jobs.main.with['test-command']);
  });

  test('limits push to main so pull request branches are not validated twice', () => {
    expect(trigger(example).push).toEqual({ branches: ['main'] });
    expect(Object.keys(trigger(example))).toEqual(['pull_request', 'push', 'schedule']);
  });

  test('runs main validation and CodeQL on a weekly schedule', () => {
    expect(trigger(example).schedule).toHaveLength(1);
    expect(example.jobs.main.if).toContain('schedule');
    expect(example.jobs.codeql.uses).toContain('/codeql.yml@');
    expect(example.jobs.codeql.if).toBeUndefined();
  });

  test('never calls the image, deploy or rollout workflows', async () => {
    const text = await Bun.file('docs/examples/consumer-validation.yml').text();
    expect(text).not.toMatch(/image-build|image-tag-release|deploy\.yml|rollout\.yml/);
  });
});

describe('repository checks workflow', () => {
  test('runs on pull requests, manual dispatch and pushes to main only', async () => {
    const checks = await load('.github/workflows/checks.yml');
    expect(trigger(checks).push).toEqual({ branches: ['main'] });
    expect(Object.keys(trigger(checks))).toEqual(['push', 'pull_request', 'workflow_dispatch']);
  });
});

describe('existing shared workflows are retained', () => {
  test.each(['image-build', 'image-tag-release', 'deploy', 'rollout'])('%s.yml exists', async name => {
    expect(await Bun.file(`.github/workflows/${name}.yml`).exists()).toBe(true);
  });
});
