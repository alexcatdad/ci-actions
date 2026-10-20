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
      return unavailable(status === '403' ? 'Access forbidden: check token permissions and feature eligibility' :
        status === '401' ? 'Authentication required or invalid credentials' :
        status === '404' ? 'Resource not found or inaccessible; absence is not proven' :
        'GitHub request failed; check access, feature availability and connectivity',
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

// Plan evidence belongs to the repository owner, never the caller's unrelated subscription.
export async function repositoryEligibility(repo: any, get: Get = readApi) {
  const permission = repo.permissions?.admin === true ? 'admin' :
    repo.permissions?.admin === false ? 'insufficient' : 'unknown';
  let feature: 'supported' | 'unsupported' | 'unknown' = 'unknown';
  let plan: string | null = null;
  let reason = 'Repository visibility or owner type unavailable';
  if (repo.owner?.type !== 'User' || repo.archived !== false) {
    feature = 'unsupported'; reason = 'Only non-archived personal repositories are supported';
  } else if (repo.private === false) {
    feature = 'supported'; reason = 'Public personal repository';
  } else if (repo.private === true) {
    const user = await get('user');
    if (user.status === 'observed' && typeof repo.owner?.login === 'string' &&
        typeof user.value?.login === 'string' && user.value.login.toLowerCase() === repo.owner.login.toLowerCase()) {
      plan = typeof user.value.plan?.name === 'string' ? user.value.plan.name.toLowerCase() : null;
      if (plan === 'pro') { feature = 'supported'; reason = 'Owner GitHub Pro plan observed'; }
      else if (plan === 'free') { feature = 'unsupported'; reason = 'Private personal repositories require GitHub Pro'; }
      else if (plan === null) {
        reason = 'Owner plan unavailable; cannot verify private eligibility';
        // The repository rules endpoints provide positive evidence for private-repository
        // ruleset capability when the owner plan is not exposed. Both reads must be
        // complete and structurally valid; absent or malformed data proves nothing.
        if (typeof repo.default_branch === 'string' && repo.default_branch.length > 0) {
          const root = `repos/${repo.full_name}`;
          const [rulesets, branchRules] = await Promise.all([
            get(`${root}/rulesets?includes_parents=true&per_page=100`, true),
            get(`${root}/rules/branches/${encodeURIComponent(repo.default_branch)}?per_page=100`, true),
          ]);
          const validPages = (result: Observation, rowValid: (row: any) => boolean) => {
            if (result.status !== 'observed' || !Array.isArray(result.value) || result.value.length === 0) return false;
            return result.value.every((page: any) => {
              return Array.isArray(page) && page.every(rowValid);
            });
          };
          if (validPages(rulesets, (row: any) => row && typeof row === 'object' && !Array.isArray(row) &&
              Number.isSafeInteger(row.id) && row.id > 0 && typeof row.name === 'string') &&
              validPages(branchRules, (row: any) => row && typeof row === 'object' && !Array.isArray(row) &&
                typeof row.type === 'string')) {
            feature = 'supported';
            reason = 'Private repository ruleset capability observed from repository rules APIs';
          }
        }
      }
    } else reason = 'Owner plan unavailable; authenticate as the owner with access to private user fields';
  }
  return { feature, permission, plan, reason,
    tokenWritePermission: 'unverified: ruleset creation requires Administration: write; GET access does not prove it' };
}

// A bounded point-in-time sample; elapsed execution time is never a billing total.
export async function auditUsage(target: string, get: Get = readApi) {
  parseTarget(['--repo', target]);
  const root = 'repos/' + target;
  const runs = project(await get(root + '/actions/runs?per_page=20'), v => {
    if (!Array.isArray(v.workflow_runs) || !Number.isSafeInteger(v.total_count) || v.total_count < 0) throw Error('runs expected');
    return { total: v.total_count, runs: v.workflow_runs.slice(0, 20) };
  });
  const billing = unavailable('No personal-account Actions billing endpoint is listed in the current REST billing API; inspect owner Billing and licensing / Usage');
  if (runs.status !== 'observed') return { runs, billing, complete: false };
  const runnerInventory = project(pages(await get(root + '/actions/runners?per_page=100', true), 'runners'), values =>
    values.map((v: any) => {
      if (!Number.isSafeInteger(v.id) || v.id <= 0) throw Error('runner ID expected');
      return v.id;
    }));
  const samples = [];
  for (const run of runs.value.runs) {
    if (!Number.isSafeInteger(run.id) || run.id <= 0) {
      samples.push({ runID: null, jobs: unavailable('Invalid run ID') }); continue;
    }
    const jobs = project(pages(await get(root + '/actions/runs/' + run.id + '/jobs?filter=all&per_page=100', true), 'jobs'), values =>
      values.map((job: any) => {
        const labels = Array.isArray(job.labels) ? job.labels : [];
        // ARC scale-set labels need not contain self-hosted. Never infer hosted from their absence.
        const knownSelfHosted = runnerInventory.status === 'observed' && runnerInventory.value.includes(job.runner_id);
        const standardHostedLabel = labels.some((label: any) => typeof label === 'string' &&
          /^(ubuntu|windows|macos)-(latest|[0-9]+(?:\.[0-9]+)?)(?:-(?:arm|arm64|intel))?$/.test(label));
        const runner = labels.includes('self-hosted') || knownSelfHosted ? 'self-hosted' :
          standardHostedLabel ? 'github-hosted-inferred' : 'unknown';
        const start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
        const seconds = job.status === 'completed' && Number.isFinite(start) && Number.isFinite(end) && end >= start
          ? (end - start) / 1000 : null;
        return { ...fields(job, ['id', 'name', 'status', 'conclusion', 'runner_name', 'runner_group_name']),
          labels, runner, elapsedSeconds: seconds };
      }));
    samples.push({ runID: run.id, workflow: run.name ?? null, createdAt: run.created_at ?? null, jobs });
  }
  const rankedJobs = samples.flatMap(sample => sample.jobs.status === 'observed'
    ? sample.jobs.value.filter((j: any) => j.elapsedSeconds !== null).map((j: any) =>
      ({ runID: sample.runID, workflow: sample.workflow, ...j })) : [])
    .sort((a: any, b: any) => b.elapsedSeconds - a.elapsedSeconds);
  return { billing, scope: 'Latest 20 runs, all attempts; elapsed seconds exclude billing rounding, multipliers and rates',
    totalRuns: runs.value.total, sampledRuns: samples.length, truncated: runs.value.total > samples.length,
    complete: samples.every(s => s.jobs.status === 'observed'), runnerInventory, samples, rankedJobs,
    opportunities: ['Review longest jobs for caching and redundant work',
      'Cancel superseded PR runs using caller concurrency; serialize releases without cancellation',
      'Verify unknown runner types in run details; ARC labels alone do not prove hosting',
      'Use standard hosted Linux for lightweight private CI within the owner allowance; native macOS only when needed'] };
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
    'allow_squash_merge', 'allow_rebase_merge', 'security_and_analysis', 'permissions',
  ]));
  if (metadata.status !== 'observed' || repository.status !== 'observed') {
    return { schemaVersion: 1, target, startedAt, complete: false, repository };
  }
  const eligibility = await repositoryEligibility(metadata.value, get);
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
  let selectedActions: Observation = unavailable('Actions policy unavailable');
  if (actions.status === 'observed') {
    if (actions.value?.allowed_actions === 'selected') {
      selectedActions = project(await get(`${root}/actions/permissions/selected-actions`), value =>
        fields(value, ['github_owned_allowed', 'verified_allowed', 'patterns_allowed']));
    } else if (['all', 'local_only'].includes(actions.value?.allowed_actions)) {
      selectedActions = { status: 'observed', value: { applicable: false } };
    }
  }
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
    repository, branch, selectedActions,
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
    ...observations, eligibility,
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    const usage = args.length === 3 && args[2] === '--usage';
    const target = parseTarget(usage ? args.slice(0, 2) : args);
    const report = { ...await auditRepository(target), ...(usage ? { usage: await auditUsage(target) } : {}) };
    if (report.usage && !report.usage.complete) report.complete = false;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.complete ? 0 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Audit failed');
    process.exitCode = 1;
  }
}
