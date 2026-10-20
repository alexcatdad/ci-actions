import { createHash } from 'node:crypto';
import { parseTarget, readApi, repositoryEligibility } from './audit-repository';

type Get = typeof readApi;
const usage = 'Usage: bun scripts/create-ruleset.ts plan --repo OWNER/REPO --rules FILE --evidence-pr NUMBER [--enable-auto-merge]\n' +
  '       bun scripts/create-ruleset.ts apply --plan FILE --approve SHA256';
const requireValue = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const keys = (v: any, allowed: string[]) => requireValue(v && typeof v === 'object' &&
  !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k)), 'Unexpected payload fields');

export function canonical(value: any): string {
  requireValue(value !== undefined, 'Plan contains unavailable JSON fields');
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const fingerprint = (value: any) => createHash('sha256').update(canonical(value)).digest('hex');

// Intentionally support only the reviewed default-branch baseline, not arbitrary policy writes.
export function validateRuleset(value: any) {
  keys(value, ['name', 'target', 'enforcement', 'bypass_actors', 'conditions', 'rules']);
  requireValue(typeof value.name === 'string' && value.name.trim() === value.name &&
    value.name.length > 0 && value.name.length <= 100 && !/[\x00-\x1f]/.test(value.name), 'Invalid ruleset name');
  requireValue(value.target === 'branch' && value.enforcement === 'active', 'Only active branch rulesets are supported');
  requireValue(canonical(value.bypass_actors) === '[]', 'Bypass actors are not supported');
  requireValue(canonical(value.conditions) === canonical({ ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }),
    'Only the default branch without exclusions is supported');
  const types = ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'];
  requireValue(Array.isArray(value.rules) && value.rules.length === types.length &&
    types.every(type => value.rules.filter((r: any) => r?.type === type).length === 1), 'Expected four baseline rules');
  for (const rule of value.rules) {
    keys(rule, rule.type === 'deletion' || rule.type === 'non_fast_forward' ? ['type'] : ['type', 'parameters']);
    if (rule.type === 'pull_request') {
      const p = rule.parameters;
      const bools = ['dismiss_stale_reviews_on_push', 'require_code_owner_review',
        'require_last_push_approval', 'required_review_thread_resolution'];
      keys(p, [...bools, 'allowed_merge_methods', 'required_approving_review_count']);
      requireValue(bools.every(k => typeof p[k] === 'boolean') && p.required_review_thread_resolution,
        'Explicit review booleans and resolved threads are required');
      requireValue(Number.isInteger(p.required_approving_review_count) && p.required_approving_review_count >= 0 &&
        p.required_approving_review_count <= 6, 'Invalid approval count');
      requireValue(Array.isArray(p.allowed_merge_methods) && p.allowed_merge_methods.length > 0 &&
        p.allowed_merge_methods.every((m: string) => ['merge', 'squash', 'rebase'].includes(m)), 'Invalid merge methods');
    }
    if (rule.type === 'required_status_checks') {
      const p = rule.parameters;
      keys(p, ['strict_required_status_checks_policy', 'required_status_checks']);
      requireValue(p.strict_required_status_checks_policy === true && Array.isArray(p.required_status_checks) &&
        p.required_status_checks.length > 0, 'Up-to-date branches and named checks are required');
      for (const check of p.required_status_checks) {
        keys(check, ['context', 'integration_id']);
        requireValue(typeof check.context === 'string' && check.context.trim().length > 0 &&
          !/[\x00-\x1f]/.test(check.context) && Number.isSafeInteger(check.integration_id) && check.integration_id > 0,
          'Each required check needs a name and positive integration ID');
      }
    }
  }
  return value;
}

async function observed(get: Get, endpoint: string, paginated = false) {
  const result = await get(endpoint, paginated);
  requireValue(result.status === 'observed', 'Required evidence unavailable: ' + endpoint);
  return result.status === 'observed' ? result.value : null;
}
async function list(get: Get, endpoint: string, key?: string) {
  const pages = await observed(get, endpoint, true);
  requireValue(Array.isArray(pages), 'Expected paginated evidence');
  return pages.flatMap((page: any) => {
    const items = key ? page[key] : page;
    requireValue(Array.isArray(items), 'Expected evidence list');
    return items;
  });
}

async function baseline(target: string, evidencePR: number, ruleset: any, get: Get) {
  parseTarget(['--repo', target]);
  requireValue(Number.isSafeInteger(evidencePR) && evidencePR > 0, 'Invalid evidence PR number');
  const root = `repos/${target}`;
  const repo = await observed(get, root);
  requireValue(repo.full_name?.toLowerCase() === target.toLowerCase() && Number.isSafeInteger(repo.id), 'Repository identity changed');
  const eligibility = await repositoryEligibility(repo, get);
  requireValue(eligibility.feature === 'supported', eligibility.reason);
  requireValue(eligibility.permission === 'admin', eligibility.permission === 'insufficient'
    ? 'Insufficient repository permissions: admin required'
    : 'Repository admin permission unavailable; cannot authorize a settings plan');
  requireValue(typeof repo.owner?.login === 'string' && Number.isSafeInteger(repo.owner.id) &&
    typeof repo.allow_auto_merge === 'boolean' && typeof repo.allow_merge_commit === 'boolean' &&
    typeof repo.allow_squash_merge === 'boolean' && typeof repo.allow_rebase_merge === 'boolean' &&
    typeof repo.permissions?.admin === 'boolean', 'Repository settings baseline unavailable');
  requireValue(typeof repo.default_branch === 'string' && repo.default_branch.length > 0, 'Default branch unavailable');
  const mergeMethods = { merge: repo.allow_merge_commit, squash: repo.allow_squash_merge, rebase: repo.allow_rebase_merge };
  const requestedMethods = ruleset.rules.find((r: any) => r.type === 'pull_request').parameters.allowed_merge_methods;
  requireValue(requestedMethods.every((method: string) => mergeMethods[method as keyof typeof mergeMethods] === true),
    'Ruleset merge methods must be enabled in repository settings');
  const path = `${root}/branches/${encodeURIComponent(repo.default_branch)}`;
  const [branch, pr, rulesets, effective, classic] = await Promise.all([
    observed(get, path), observed(get, `${root}/pulls/${evidencePR}`),
    list(get, `${root}/rulesets?includes_parents=true&per_page=100`),
    list(get, `${root}/rules/branches/${encodeURIComponent(repo.default_branch)}?per_page=100`),
    get(`${path}/protection`),
  ]);
  requireValue(/^[a-f0-9]{40}$/.test(branch.commit?.sha), 'Default branch SHA unavailable');
  requireValue(!rulesets.some((r: any) => r.name?.toLowerCase() === ruleset.name.toLowerCase()),
    'Ruleset name already exists; updates are not supported');
  requireValue(pr.base?.repo?.full_name?.toLowerCase() === target.toLowerCase() && pr.base.ref === repo.default_branch &&
    pr.head?.repo?.full_name?.toLowerCase() === target.toLowerCase() && /^[a-f0-9]{40}$/.test(pr.head.sha),
    'Evidence must be a same-repository PR targeting the default branch');
  requireValue(classic.status === 'observed' || classic.httpStatus === 404,
    'Classic branch protection evidence unavailable');
  const checks = await list(get, `${root}/commits/${pr.head.sha}/check-runs?filter=latest&per_page=100`, 'check_runs');
  const required = ruleset.rules.find((r: any) => r.type === 'required_status_checks').parameters.required_status_checks;
  for (const check of required) {
    const matches = checks.filter((r: any) => r.name === check.context && r.app?.id === check.integration_id && r.head_sha === pr.head.sha);
    requireValue(matches.length > 0 && matches.every((r: any) => r.status === 'completed' && r.conclusion === 'success'),
      'Required check lacks successful PR evidence: ' + check.context);
  }
  const latest = await observed(get, path);
  requireValue(latest.commit?.sha === branch.commit.sha, 'Default branch changed during collection');
  return {
    repository: { id: repo.id, name: repo.full_name, owner: { type: repo.owner.type, login: repo.owner.login, id: repo.owner.id },
      private: repo.private, archived: repo.archived, admin: repo.permissions.admin, defaultBranch: repo.default_branch,
      allow_auto_merge: repo.allow_auto_merge, allow_merge_commit: repo.allow_merge_commit,
      allow_squash_merge: repo.allow_squash_merge, allow_rebase_merge: repo.allow_rebase_merge },
    eligibility,
    defaultBranchSHA: branch.commit.sha,
    rulesets, effectiveBranchRules: effective, classicProtection: classic,
    evidencePR: { number: evidencePR, headSHA: pr.head.sha, state: pr.state,
      updatedAt: pr.updated_at, checks: checks.map((r: any) => ({ name: r.name, appID: r.app?.id ?? null,
        headSHA: r.head_sha, status: r.status, conclusion: r.conclusion })) },
  };
}

export async function planCreate(target: string, ruleset: any, evidencePR: number, get: Get = readApi,
  enableAutoMerge = false) {
  validateRuleset(ruleset);
  requireValue(typeof enableAutoMerge === 'boolean', 'Invalid auto-merge option');
  const content = { schemaVersion: 1, operation: 'create-repository-ruleset', target, ruleset,
    ...(enableAutoMerge ? { settings: { allow_auto_merge: true } } : {}),
    baseline: await baseline(target, evidencePR, ruleset, get) };
  return { ...content, approvalHash: fingerprint(content) };
}

export async function postRuleset(target: string, ruleset: any) {
  // A single POST with JSON on stdin; no automatic retry after an uncertain outcome.
  const child = Bun.spawn(['gh', 'api', '--hostname', 'github.com', '--method', 'POST',
    '--header', 'Accept: application/vnd.github+json', '--header', 'X-GitHub-Api-Version: 2026-03-10',
    `repos/${target}/rulesets`, '--input', '-'], {
    stdin: new Blob([JSON.stringify(ruleset)]), stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
  });
  const [stdout, , code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  requireValue(code === 0, 'Write outcome uncertain; inspect repository rulesets before retrying');
  try { return JSON.parse(stdout); } catch { throw Error('Write response unreadable; inspect repository rulesets before retrying'); }
}

export async function patchAutoMerge(target: string, patch: any) {
  const child = Bun.spawn(['gh', 'api', '--hostname', 'github.com', '--method', 'PATCH',
    '--header', 'Accept: application/vnd.github+json', '--header', 'X-GitHub-Api-Version: 2026-03-10',
    `repos/${target}`, '--input', '-'], {
    stdin: new Blob([JSON.stringify(patch)]), stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
  });
  const [stdout, , code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  requireValue(code === 0, 'Auto-merge write outcome uncertain; inspect repository settings before retrying');
  try { return JSON.parse(stdout); } catch { throw Error('Auto-merge response unreadable; inspect repository settings before retrying'); }
}

function matchesReviewed(wanted: any, actual: any): boolean {
  if (Array.isArray(wanted)) return Array.isArray(actual) && wanted.length === actual.length &&
    wanted.every((v, i) => matchesReviewed(v, actual[i]));
  if (wanted && typeof wanted === 'object') return actual && Object.keys(wanted).every(k => matchesReviewed(wanted[k], actual[k]));
  return wanted === actual;
}

export async function applyCreate(plan: any, approval: string, get: Get = readApi, post = postRuleset,
  patch = patchAutoMerge) {
  keys(plan, ['schemaVersion', 'operation', 'target', 'ruleset', 'settings', 'baseline', 'approvalHash']);
  const { approvalHash, ...content } = plan;
  requireValue(plan.schemaVersion === 1 && plan.operation === 'create-repository-ruleset' &&
    /^[a-f0-9]{64}$/.test(approval) && approval === approvalHash && fingerprint(content) === approval,
    'Plan approval hash does not match');
  validateRuleset(plan.ruleset);
  requireValue(plan.settings === undefined || canonical(plan.settings) === canonical({ allow_auto_merge: true }),
    'Unsupported repository settings');
  const fresh = await baseline(plan.target, plan.baseline?.evidencePR?.number, plan.ruleset, get);
  requireValue(canonical(fresh) === canonical(plan.baseline), 'Repository evidence changed; generate and review a new plan');
  const created = await post(plan.target, plan.ruleset);
  requireValue(Number.isSafeInteger(created?.id) && created.id > 0, 'Write returned no ruleset ID; inspect repository before retrying');
  const actual = await observed(get, `repos/${plan.target}/rulesets/${created.id}`);
  requireValue(matchesReviewed(plan.ruleset, actual), `Ruleset ${created.id} readback differs; inspect it before further writes`);
  if (plan.settings?.allow_auto_merge === true) {
    // Opt-in only, after the protection has been created and verified. A failed or
    // uncertain PATCH leaves that protection in place for explicit operator review.
    const changed = await patch(plan.target, { allow_auto_merge: true });
    requireValue(changed?.id === plan.baseline.repository.id &&
      changed?.full_name?.toLowerCase() === plan.target.toLowerCase() && changed.allow_auto_merge === true,
      'Auto-merge write readback unavailable or mismatched; inspect repository settings');
    requireValue(changed.owner?.type === plan.baseline.repository.owner.type &&
      changed.owner?.login?.toLowerCase() === plan.baseline.repository.owner.login.toLowerCase() &&
      changed.owner?.id === plan.baseline.repository.owner.id &&
      changed.private === plan.baseline.repository.private && changed.archived === plan.baseline.repository.archived &&
      changed.allow_merge_commit === plan.baseline.repository.allow_merge_commit &&
      changed.allow_squash_merge === plan.baseline.repository.allow_squash_merge &&
      changed.allow_rebase_merge === plan.baseline.repository.allow_rebase_merge,
      'Auto-merge repository identity changed; inspect repository settings');
    const latest = await observed(get, `repos/${plan.target}`);
    requireValue(latest.id === plan.baseline.repository.id &&
      latest.full_name?.toLowerCase() === plan.target.toLowerCase() && latest.allow_auto_merge === true &&
      latest.owner?.type === plan.baseline.repository.owner.type &&
      latest.owner?.login?.toLowerCase() === plan.baseline.repository.owner.login.toLowerCase() &&
      latest.owner?.id === plan.baseline.repository.owner.id && latest.private === plan.baseline.repository.private &&
      latest.archived === plan.baseline.repository.archived && latest.allow_merge_commit === plan.baseline.repository.allow_merge_commit &&
      latest.allow_squash_merge === plan.baseline.repository.allow_squash_merge &&
      latest.allow_rebase_merge === plan.baseline.repository.allow_rebase_merge,
      'Auto-merge setting readback failed; inspect repository settings');
  }
  return { target: plan.target, id: created.id, verified: true,
    url: `https://github.com/${plan.target}/rules/${created.id}` };
}

if (import.meta.main) {
  try {
    const [mode, ...args] = Bun.argv.slice(2);
    const enableAutoMerge = mode === 'plan' && args.at(-1) === '--enable-auto-merge';
    const actualArgs = enableAutoMerge ? args.slice(0, -1) : args;
    const expected = mode === 'plan' ? ['--repo', '--rules', '--evidence-pr'] : ['--plan', '--approve'];
    requireValue(['plan', 'apply'].includes(mode) && actualArgs.length === expected.length * 2 &&
      expected.every((flag, i) => actualArgs[i * 2] === flag), usage);
    const result = mode === 'plan'
      ? await planCreate(actualArgs[1], await Bun.file(actualArgs[3]).json(), Number(actualArgs[5]), readApi, enableAutoMerge)
      : await applyCreate(actualArgs[1] ? await Bun.file(actualArgs[1]).json() : null, actualArgs[3]);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Ruleset operation failed');
    process.exitCode = 1;
  }
}
