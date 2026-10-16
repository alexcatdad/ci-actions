type Unavailable = { status: 'unavailable'; httpStatus: number | null; reason: string };
type Observation<T = any> = { status: 'observed'; value: T } | Unavailable;
type Get = (endpoint: string, paginated?: boolean) => Promise<Observation>;

const unavailable = (reason: string, httpStatus: number | null = null): Unavailable =>
  ({ status: 'unavailable', httpStatus, reason });

export function parseTarget(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--repo' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(args[1]) ||
      ['.', '..'].includes(args[1].split('/')[1])) {
    throw new Error('Usage: bun scripts/audit-repository.ts --repo OWNER/REPO');
  }
  return args[1];
}

export function apiArguments(endpoint: string, paginated = false): string[] {
  return ['gh', 'api', '--hostname', 'github.com', '--method', 'GET',
    '--header', 'Accept: application/vnd.github+json',
    '--header', 'X-GitHub-Api-Version: 2026-03-10', endpoint,
    ...(paginated ? ['--paginate', '--slurp'] : [])];
}

export const readApi: Get = async (endpoint, paginated = false) => {
  try {
    const child = Bun.spawn(apiArguments(endpoint, paginated), {
      stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) {
      const status = stderr.match(/\(HTTP (\d{3})\)/)?.[1];
      // Do not echo CLI diagnostics, response bodies or credential configuration.
      return unavailable('GitHub request failed; check access, feature availability and connectivity',
        status ? Number(status) : null);
    }
    return { status: 'observed', value: JSON.parse(stdout) };
  } catch {
    return unavailable('Could not execute gh or decode its response');
  }
};

function project(result: Observation, select: (value: any) => any): Observation {
  if (result.status !== 'observed') return result;
  try {
    return { status: 'observed', value: select(result.value) };
  } catch {
    return unavailable('Unexpected GitHub response shape');
  }
}

function fields(value: any, names: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('object expected');
  return Object.fromEntries(names.map(name => [name, value[name] ?? null]));
}

function pages(result: Observation, key?: string): Observation {
  return project(result, value => {
    if (!Array.isArray(value)) throw Error('pages expected');
    return value.flatMap(page => {
      const items = key ? page[key] : page;
      if (!Array.isArray(items)) throw Error('array expected');
      return items;
    });
  });
}

export async function auditRepository(target: string, get: Get = readApi) {
  // Validate callers importing this function as well as the CLI entry point.
  parseTarget(['--repo', target]);
  const startedAt = new Date().toISOString();
  const root = `repos/${target}`;
  const metadata = await get(root);
  const repository = project(metadata, value => fields(value, [
    'full_name', 'visibility', 'private', 'archived', 'fork', 'default_branch',
    'allow_auto_merge', 'delete_branch_on_merge', 'allow_merge_commit',
    'allow_squash_merge', 'allow_rebase_merge', 'security_and_analysis',
  ]));
  if (metadata.status !== 'observed' || repository.status !== 'observed') {
    return { schemaVersion: 1, target, startedAt, complete: false, repository };
  }
  const defaultBranch = metadata.value.default_branch;
  if (typeof defaultBranch !== 'string' || !defaultBranch) {
    return { schemaVersion: 1, target, startedAt, complete: false, repository,
      branch: unavailable('No default branch was returned') };
  }
  const branchPath = `${root}/branches/${encodeURIComponent(defaultBranch)}`;
  const [branchResult, actions, workflowPermissions, rulesetPages, effectivePages, classicProtection] =
    await Promise.all([
      get(branchPath), get(`${root}/actions/permissions`),
      get(`${root}/actions/permissions/workflow`),
      get(`${root}/rulesets?includes_parents=true&per_page=100`, true),
      get(`${root}/rules/branches/${encodeURIComponent(defaultBranch)}?per_page=100`, true),
      get(`${branchPath}/protection`),
    ]);
  const branch = project(branchResult, value => {
    if (!/^[a-f0-9]{40}$/.test(value.commit?.sha)) throw Error('commit expected');
    return { name: value.name, sha: value.commit.sha, protected: value.protected ?? null };
  });
  let checkRuns: Observation = unavailable('Default branch commit unavailable');
  let commitStatuses: Observation = unavailable('Default branch commit unavailable');
  let branchUnchanged: Observation = unavailable('Default branch commit unavailable');
  if (branch.status === 'observed') {
    const sha = branch.value.sha;
    const [checks, statuses] = await Promise.all([
      get(`${root}/commits/${sha}/check-runs?filter=latest&per_page=100`, true),
      get(`${root}/commits/${sha}/statuses?per_page=100`, true),
    ]);
    checkRuns = project(pages(checks, 'check_runs'), values => values.map((v: any) => ({
      ...fields(v, ['name', 'status', 'conclusion', 'head_sha']),
      app_id: v.app?.id ?? null,
    })));
    commitStatuses = project(pages(statuses), values => values.map((v: any) =>
      fields(v, ['context', 'state', 'created_at'])));
    branchUnchanged = project(await get(branchPath), value => {
      if (!/^[a-f0-9]{40}$/.test(value.commit?.sha)) throw Error('commit expected');
      return value.commit.sha === sha;
    });
  }
  const observations = {
    repository, branch,
    actions: project(actions, v => fields(v, ['enabled', 'allowed_actions', 'sha_pinning_required'])),
    workflowPermissions: project(workflowPermissions, v =>
      fields(v, ['default_workflow_permissions', 'can_approve_pull_request_reviews'])),
    rulesets: project(pages(rulesetPages), values => values.map((v: any) =>
      fields(v, ['id', 'name', 'target', 'enforcement', 'source_type', 'source']))),
    effectiveBranchRules: pages(effectivePages),
    classicProtection, checkRuns, commitStatuses, branchUnchanged,
  };
  return {
    schemaVersion: 1, target, startedAt, completedAt: new Date().toISOString(),
    complete: Object.values(observations).every(v => v.status === 'observed') &&
      branchUnchanged.status === 'observed' && branchUnchanged.value === true,
    ...observations,
  };
}

if (import.meta.main) {
  try {
    const report = await auditRepository(parseTarget(Bun.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.complete ? 0 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Audit failed');
    process.exitCode = 1;
  }
}
