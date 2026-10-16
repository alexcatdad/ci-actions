import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyCreate, fingerprint, planCreate, validateRuleset } from '../scripts/create-ruleset';

const template = await Bun.file('rules/ci-actions-main.json').json();
function payload() {
  const value = structuredClone(template);
  value.name = 'Synthetic baseline';
  value.rules.find((r: any) => r.type === 'required_status_checks').parameters.required_status_checks =
    [{ context: 'test', integration_id: 42 }];
  return value;
}
const mainSHA = 'a'.repeat(40), prSHA = 'b'.repeat(40);
function fixture() {
  const state = {
    repo: { id: 123, full_name: 'example/project', private: false, archived: false,
      owner: { type: 'User' }, default_branch: 'release/main' },
    branch: { commit: { sha: mainSHA } },
    pr: { number: 8, state: 'closed', updated_at: '2026-01-01T00:00:00Z',
      base: { repo: { full_name: 'example/project' }, ref: 'release/main' },
      head: { repo: { full_name: 'example/project' }, sha: prSHA } },
    rulesets: [{ id: 7, name: 'Other controls', enforcement: 'active', updated_at: '2026-01-01' }],
    effective: [{ type: 'required_signatures', ruleset_id: 7 }],
    checks: [{ name: 'test', app: { id: 42 }, head_sha: prSHA, status: 'completed', conclusion: 'success' }],
    created: null as any,
  };
  const calls: string[] = [], writes: any[] = [];
  const get = async (path: string, paginated = false) => {
    calls.push(path);
    let value: any;
    if (path === 'repos/example/project') value = state.repo;
    else if (path.endsWith('/branches/release%2Fmain')) value = state.branch;
    else if (path.endsWith('/pulls/8')) value = state.pr;
    else if (path.includes('/rulesets?')) { expect(paginated).toBe(true); value = [state.rulesets, []]; }
    else if (path.includes('/rules/branches/release%2Fmain?')) { expect(paginated).toBe(true); value = [state.effective]; }
    else if (path.endsWith('/protection')) value = { required_signatures: { enabled: true } };
    else if (path.includes(`/commits/${prSHA}/check-runs?`)) { expect(paginated).toBe(true); value = [{ check_runs: state.checks }, { check_runs: [] }]; }
    else if (path.endsWith('/rulesets/99')) value = state.created;
    else throw Error('Unexpected fixture read: ' + path);
    return { status: 'observed' as const, value: structuredClone(value) };
  };
  const post = async (target: string, value: any) => {
    writes.push({ target, value: structuredClone(value) });
    state.created = { ...structuredClone(value), id: 99, current_user_can_bypass: 'never' };
    state.created.rules.find((r: any) => r.type === 'pull_request').parameters.required_reviewers = [];
    return { id: 99 };
  };
  return { state, calls, writes, get, post };
}

describe('create-only ruleset plan and apply', () => {
  test('plan preserves unrelated controls, uses paginated PR evidence and performs no writes', async () => {
    const f = fixture();
    const plan = await planCreate('example/project', payload(), 8, f.get);
    expect(plan.baseline.rulesets).toEqual(f.state.rulesets);
    expect(plan.baseline.effectiveBranchRules).toEqual(f.state.effective);
    expect(plan.baseline.defaultBranchSHA).toBe(mainSHA);
    expect(plan.baseline.evidencePR.headSHA).toBe(prSHA);
    expect(f.writes).toHaveLength(0);
    expect(plan.approvalHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('approved unchanged plan creates once and verifies server defaults on readback', async () => {
    const f = fixture();
    const plan = await planCreate('example/project', payload(), 8, f.get);
    const result = await applyCreate(plan, plan.approvalHash, f.get, f.post);
    expect(result).toEqual({ target: 'example/project', id: 99, verified: true,
      url: 'https://github.com/example/project/rules/99' });
    expect(f.writes).toEqual([{ target: 'example/project', value: payload() }]);
    expect(f.state.rulesets).toEqual([{ id: 7, name: 'Other controls', enforcement: 'active', updated_at: '2026-01-01' }]);
  });

  test('wrong approval or edited payload refuses before any read or write', async () => {
    const f = fixture();
    const plan = await planCreate('example/project', payload(), 8, f.get);
    f.calls.length = 0;
    await expect(applyCreate(plan, '0'.repeat(64), f.get, f.post)).rejects.toThrow('approval hash');
    plan.ruleset.name = 'Changed after review';
    await expect(applyCreate(plan, plan.approvalHash, f.get, f.post)).rejects.toThrow('approval hash');
    expect(f.calls).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
  });

  for (const kind of ['main', 'identity', 'policy', 'pr'] as const) {
    test(`refuses stale ${kind} evidence before writing`, async () => {
      const f = fixture();
      const plan = await planCreate('example/project', payload(), 8, f.get);
      if (kind === 'main') f.state.branch.commit.sha = 'c'.repeat(40);
      if (kind === 'identity') f.state.repo.id = 456;
      if (kind === 'policy') f.state.rulesets[0].updated_at = '2026-01-02';
      if (kind === 'pr') f.state.pr.updated_at = '2026-01-02T00:00:00Z';
      await expect(applyCreate(plan, plan.approvalHash, f.get, f.post)).rejects.toThrow('evidence changed');
      expect(f.writes).toHaveLength(0);
    });
  }

  test('existing same-name ruleset is never updated', async () => {
    const f = fixture();
    f.state.rulesets[0].name = 'SYNTHETIC BASELINE';
    await expect(planCreate('example/project', payload(), 8, f.get)).rejects.toThrow('name already exists');
    expect(f.writes).toHaveLength(0);
  });

  for (const mode of ['private', 'organization', 'archived'] as const) {
    test(`refuses unsupported ${mode} repository`, async () => {
      const f = fixture();
      if (mode === 'private') f.state.repo.private = true;
      if (mode === 'organization') f.state.repo.owner.type = 'Organization';
      if (mode === 'archived') f.state.repo.archived = true;
      await expect(planCreate('example/project', payload(), 8, f.get)).rejects.toThrow('public personal');
      expect(f.calls).toHaveLength(1);
    });
  }

  for (const mode of ['missing', 'wrong-app', 'failure', 'pending', 'skipped'] as const) {
    test(`refuses ${mode} required-check evidence`, async () => {
      const f = fixture();
      if (mode === 'missing') f.state.checks = [];
      if (mode === 'wrong-app') f.state.checks[0].app.id = 43;
      if (mode === 'failure' || mode === 'skipped') f.state.checks[0].conclusion = mode;
      if (mode === 'pending') f.state.checks[0].status = 'queued';
      await expect(planCreate('example/project', payload(), 8, f.get)).rejects.toThrow('successful PR evidence');
    });
  }

  test('API denial and foreign PR evidence do not produce an applicable plan', async () => {
    const f = fixture();
    const denied = async () => ({ status: 'unavailable' as const, httpStatus: 403, reason: 'synthetic denial' });
    await expect(planCreate('example/project', payload(), 8, denied)).rejects.toThrow('evidence unavailable');
    f.state.pr.head.repo.full_name = 'example/fork';
    await expect(planCreate('example/project', payload(), 8, f.get)).rejects.toThrow('same-repository PR');
  });

  test('readback mismatch and uncertain write are not retried', async () => {
    const f = fixture();
    const plan = await planCreate('example/project', payload(), 8, f.get);
    const changed = async (target: string, value: any) => {
      const response = await f.post(target, value);
      f.state.created.bypass_actors = [{ actor_type: 'User', actor_id: 1 }];
      return response;
    };
    await expect(applyCreate(plan, plan.approvalHash, f.get, changed)).rejects.toThrow('readback differs');
    expect(f.writes).toHaveLength(1);
    let attempts = 0;
    await expect(applyCreate(plan, plan.approvalHash, f.get, async () => {
      attempts++; throw Error('Write outcome uncertain');
    })).rejects.toThrow('uncertain');
    expect(attempts).toBe(1);
  });

  test('bypasses, expanded ref scope, arbitrary rules and unbound checks are rejected', () => {
    for (const edit of [
      (p: any) => { p.bypass_actors = [{ actor_type: 'User', actor_id: 1 }]; },
      (p: any) => { p.conditions.ref_name.include = ['~ALL']; },
      (p: any) => { p.rules[0] = { type: 'update' }; },
      (p: any) => { delete p.rules[3].parameters.required_status_checks[0].integration_id; },
    ]) {
      const p = payload(); edit(p);
      expect(() => validateRuleset(p)).toThrow();
    }
  });
});

// Exercise the real CLI and POST transport against a synthetic gh executable, never GitHub.
const directory = mkdtempSync(join(tmpdir(), 'ruleset-cli-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
await Bun.write(join(directory, 'gh'), `#!/usr/bin/env bun
const a=Bun.argv.slice(2), path=a[9], method=a[4];
const value=await Bun.file(process.env.RULESET_FIXTURE).json();
if(a[0]!=='api'||a[1]!=='--hostname'||a[2]!=='github.com'||a[3]!=='--method')throw Error('unsafe invocation');
if(method==='POST') {
  if(path!=='repos/example/project/rulesets'||a[10]!=='--input'||a[11]!=='-')throw Error('wrong write');
  const body=JSON.parse(await Bun.stdin.text());
  await Bun.write(process.env.RULESET_CAPTURE, JSON.stringify(body));
  console.log(JSON.stringify({id:99}));
} else if(method==='GET') {
  if(path.endsWith('/rulesets/99')) console.log(JSON.stringify({...value.ruleset,id:99}));
  else if(path==='repos/example/project') console.log(JSON.stringify({id:123,full_name:'example/project',private:false,archived:false,owner:{type:'User'},default_branch:'release/main'}));
  else if(path.endsWith('/branches/release%2Fmain')) console.log(JSON.stringify({commit:{sha:value.baseline.defaultBranchSHA}}));
  else if(path.endsWith('/pulls/8')) console.log(JSON.stringify({state:value.baseline.evidencePR.state,updated_at:value.baseline.evidencePR.updatedAt,base:{repo:{full_name:'example/project'},ref:'release/main'},head:{repo:{full_name:'example/project'},sha:value.baseline.evidencePR.headSHA}}));
  else if(path.includes('/rulesets?')) console.log(JSON.stringify([value.baseline.rulesets]));
  else if(path.includes('/rules/branches/')) console.log(JSON.stringify([value.baseline.effectiveBranchRules]));
  else if(path.endsWith('/protection')) console.log(JSON.stringify(value.baseline.classicProtection.value));
  else if(path.includes('/check-runs?')) console.log(JSON.stringify([{check_runs:value.baseline.evidencePR.checks.map(c=>({name:c.name,app:{id:c.appID},head_sha:c.headSHA,status:c.status,conclusion:c.conclusion}))}]));
  else throw Error('unexpected read');
} else throw Error('unexpected method');
`);
chmodSync(join(directory, 'gh'), 0o755);
test('CLI apply sends exact JSON on stdin to one explicit repository and verifies readback', async () => {
  const f = fixture();
  const plan = await planCreate('example/project', payload(), 8, f.get);
  const path = join(directory, 'plan.json'), capture = join(directory, 'created.json');
  await Bun.write(path, JSON.stringify(plan));
  const child = Bun.spawn([process.execPath, resolve('scripts/create-ruleset.ts'), 'apply', '--plan', path,
    '--approve', plan.approvalHash], { stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, PATH: directory + ':' + process.env.PATH, RULESET_FIXTURE: path, RULESET_CAPTURE: capture } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  expect(JSON.parse(stdout).verified).toBe(true);
  expect(await Bun.file(capture).json()).toEqual(payload());
  expect(fingerprint({ b: 1, a: 2 })).toBe(fingerprint({ a: 2, b: 1 }));
});
