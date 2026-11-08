import { describe, expect, test } from 'bun:test';

const load = async (name: string) => {
  const source = await Bun.file(`.github/workflows/${name}.yml`).text();
  return { source, workflow: Bun.YAML.parse(source) as any };
};
const trigger = (workflow: any) => workflow.on ?? workflow.true;
const stripComments = (text: string) => text.replace(/^\s*#.*$/gm, '').replace(/\s+#.*$/gm, '');
const slotDeploy = await load('slot-deploy');
const flakeUpdate = await load('flake-update');
const validation = Object.fromEntries(await Promise.all(['validate-pr', 'validate-main', 'codeql'].map(async name => [name, await load(name)])));

describe('slot-deploy', () => {
  const { source, workflow } = slotDeploy;
  const call = trigger(workflow).workflow_call;
  const job = workflow.jobs.deploy;

  test('is a reusable workflow with a required slot and a self-hosted runner default', () => {
    expect(Object.keys(trigger(workflow))).toEqual(['workflow_call']);
    expect(call.inputs.slot).toEqual(expect.objectContaining({ type: 'string', required: true }));
    expect(call.inputs.runner.default).toBe('self-hosted');
    expect(job['runs-on']).toBe('${{ inputs.runner }}');
    expect(job['timeout-minutes']).toBe('${{ inputs.timeout-minutes }}');
    expect(call.inputs['timeout-minutes'].default).toBeGreaterThan(0);
  });

  test('holds no token permissions, secrets or actions of any kind', () => {
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({});
    expect(call.secrets).toBeUndefined();
    expect(stripComments(source)).not.toMatch(/\buses:|secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN|checkout/);
    expect(Object.keys(workflow.jobs)).toEqual(['deploy']);
  });

  test('deploys only from the default branch', () => {
    expect(job.if).toBe("(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  });

  test('runs exactly homelab-deploy-slot with the slot and the triggering commit', () => {
    expect(job.steps).toHaveLength(1);
    const step = job.steps[0];
    expect(step.env).toEqual({ SLOT: '${{ inputs.slot }}', COMMIT: '${{ github.sha }}' });
    expect(step.run).not.toContain('${{');
    expect(step.run).toContain('[[ "$SLOT" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]');
    expect(step.run).toContain('[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]');
    const commands = step.run.split('\n').filter((line: string) => /\bsudo\b/.test(line));
    expect(commands).toEqual(['sudo --non-interactive homelab-deploy-slot "$SLOT" "$COMMIT"']);
  });

  test('serializes per repository and slot without cancelling a running deploy', () => {
    expect(job.concurrency).toEqual({
      group: 'slot-deploy-${{ github.repository }}-${{ inputs.slot }}',
      'cancel-in-progress': false,
    });
  });
});

describe('flake-update', () => {
  const { source, workflow } = flakeUpdate;
  const call = trigger(workflow).workflow_call;
  const job = workflow.jobs.update;
  const steps: any[] = job.steps;
  const index = (predicate: (step: any) => boolean) => steps.findIndex(predicate);

  test('is a reusable workflow that requires the App secrets', () => {
    expect(Object.keys(trigger(workflow))).toEqual(['workflow_call']);
    expect(Object.keys(call.secrets)).toEqual(['app-client-id', 'app-private-key']);
    for (const secret of Object.values<any>(call.secrets)) expect(secret.required).toBe(true);
    expect(call.inputs.base.default).toBe('main');
    expect(call.inputs.branch.default).toBe('flake-update');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job.concurrency['cancel-in-progress']).toBe(false);
  });

  test('holds only contents: read and never uses GITHUB_TOKEN for writes', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(stripComments(source)).not.toMatch(/github\.token|secrets\.GITHUB_TOKEN/);
  });

  test('pins every action by full commit SHA and never persists checkout credentials', () => {
    const lines = source.split('\n').filter(line => /^\s*(-\s+)?uses:/.test(line));
    expect(lines.length).toBe(4);
    for (const line of lines) expect(line).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d/);
    const checkout = steps[index(step => String(step.uses).startsWith('actions/checkout@'))];
    expect(checkout.with).toEqual({ ref: '${{ inputs.base }}', 'persist-credentials': false });
  });

  test('gives Nix a separate owner-wide read-only token', () => {
    const read = steps[index(step => step.id === 'read-token')];
    expect(read.with['permission-contents']).toBe('read');
    expect(read.with.owner).toBe('${{ github.repository_owner }}');
    expect(Object.keys(read.with).filter(key => key.startsWith('permission-'))).toEqual(['permission-contents']);
    const nix = steps[index(step => String(step.uses).startsWith('cachix/install-nix-action@'))];
    expect(nix.with).toEqual({
      install_url: 'https://releases.nixos.org/nix/nix-2.35.4/install',
      github_access_token: '${{ steps.read-token.outputs.token }}',
    });
  });

  test('mints the repository-scoped write token only after Nix ran and only on a change', () => {
    const update = index(step => step.id === 'update');
    const write = index(step => step.id === 'write-token');
    expect(update).toBeGreaterThan(index(step => String(step.uses).startsWith('cachix/install-nix-action@')));
    expect(write).toBe(update + 1);
    expect(steps[update].run).toContain('nix flake update');
    expect(steps[update].run).toContain('git status --porcelain -- flake.lock');
    expect(steps[write].if).toBe("steps.update.outputs.changed == 'true'");
    expect(steps[write].with.owner).toBeUndefined();
    expect(steps[write].with.repositories).toBeUndefined();
    expect(steps[write].with['permission-contents']).toBe('write');
    expect(steps[write].with['permission-pull-requests']).toBe('write');
  });

  test('opens or updates one pull request with the App token', () => {
    const publish = steps[steps.length - 1];
    expect(publish.if).toBe("steps.update.outputs.changed == 'true'");
    expect(publish.env.GH_TOKEN).toBe('${{ steps.write-token.outputs.token }}');
    for (const step of steps) if (step.run) expect(step.run).not.toContain('${{');
    expect(publish.run).toContain('push --force origin "HEAD:refs/heads/$BRANCH"');
    expect(publish.run).toContain('gh pr edit "$pr"');
    expect(publish.run).toContain('gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH"');
    expect(publish.run).toContain('[[ "$BRANCH" != "$BASE"');
  });
});

describe('validation workflows stay validation-only', () => {
  test.each(['validate-pr', 'validate-main', 'codeql'])('%s calls neither deploy nor flake update', name => {
    const { source } = validation[name];
    expect(stripComments(source)).not.toMatch(/slot-deploy|flake-update|homelab-deploy-slot|nix flake update|sudo/);
  });
});
