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
      allow_auto_merge: false, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true,
      owner: { type: 'User', id: 1, login: 'example' }, permissions: { admin: true }, default_branch: 'release/main' },
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
    if (path === 'user') value = { login: 'example', plan: { name: 'pro' } };
    else if (path === 'repos/example/project') value = state.repo;
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
  const patches: any[] = [];
  const patch = async (target: string, value: any) => {
    patches.push({ target, value: structuredClone(value) });
    state.repo.allow_auto_merge = value.allow_auto_merge;
    return { ...structuredClone(state.repo), full_name: target };
  };
  return { state, calls, writes, patches, get, post, patch };
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

  test('edited target refuses under the original approval hash', async () => {
    const f = fixture();
    const plan = await planCreate('example/project', payload(), 8, f.get);
    f.calls.length = 0;
    plan.target = 'example/other';
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

  for (const mode of ['organization', 'archived'] as const) {
    test(`refuses unsupported ${mode} repository`, async () => {
      const f = fixture();
      if (mode === 'organization') f.state.repo.owner.type = 'Organization';
      if (mode === 'archived') f.state.repo.archived = true;
      await expect(planCreate('example/project', payload(), 8, f.get)).rejects.toThrow('personal repositories');
      expect(f.calls).toHaveLength(1);
    });
  }

  test('private Pro owner can plan and apply zero-approval protection', async () => {
    const f = fixture(); f.state.repo.private = true;
    const plan = await planCreate('example/project', payload(), 8, f.get);
    expect(plan.baseline.eligibility.plan).toBe('pro');
    expect(plan.ruleset.rules.find((r: any) => r.type === 'pull_request').parameters.required_approving_review_count).toBe(0);
    expect((await applyCreate(plan, plan.approvalHash, f.get, f.post)).verified).toBe(true);
  });

  test('default plan leaves merge settings out of approval and apply never patches them', async () => {
    const f = fixture();
    const plan = await planCreate('example/project', payload(), 8, f.get);
    expect((plan as any).settings).toBeUndefined();
    await applyCreate(plan, plan.approvalHash, f.get, f.post, f.patch);
    expect(f.patches).toHaveLength(0);
  });

  test('opt-in auto-merge plan fingerprints settings and patches once after verified protection creation', async () => {
    const f = fixture();
    const plan = await planCreate('example/project', payload(), 8, f.get, true);
    expect(plan.settings).toEqual({ allow_auto_merge: true });
    const originalHash = plan.approvalHash;
    plan.settings.allow_auto_merge = false;
    await expect(applyCreate(plan, originalHash, f.get, f.post, f.patch)).rejects.toThrow('approval hash');
    expect(f.writes).toHaveLength(0);
    expect(f.patches).toHaveLength(0);
    plan.settings.allow_auto_merge = true;
    await applyCreate(plan, originalHash, f.get, f.post, f.patch);
    expect(f.patches).toEqual([{ target: 'example/project', value: { allow_auto_merge: true } }]);
    expect(f.state.repo.allow_auto_merge).toBe(true);
  });

  test('settings drift, target mismatch, and permission loss prevent auto-merge patch', async () => {
    for (const change of ['drift', 'target', 'permission', 'auto-merge'] as const) {
      const f = fixture();
      const plan = await planCreate('example/project', payload(), 8, f.get, true);
      if (change === 'drift') f.state.repo.allow_squash_merge = false;
      if (change === 'target') f.state.repo.full_name = 'example/other';
      if (change === 'permission') f.state.repo.permissions.admin = false;
      if (change === 'auto-merge') f.state.repo.allow_auto_merge = true;
      await expect(applyCreate(plan, plan.approvalHash, f.get, f.post, f.patch)).rejects.toThrow();
      expect(f.writes).toHaveLength(0);
      expect(f.patches).toHaveLength(0);
    }
  });

  test('failed ruleset readback prevents auto-merge patch', async () => {
    const f = fixture();
    const plan = await planCreate('example/project', payload(), 8, f.get, true);
    const get = async (path: string, paginated?: boolean): Promise<any> => {
      if (path.endsWith('/rulesets/99')) return { status: 'unavailable', httpStatus: 403 };
      return f.get(path, paginated);
    };
    await expect(applyCreate(plan, plan.approvalHash, get, f.post, f.patch)).rejects.toThrow('evidence unavailable');
    expect(f.writes).toHaveLength(1);
    expect(f.patches).toHaveLength(0);
  });

  test('uncertain settings patch is attempted once and bad settings readback preserves created protection', async () => {
    const f = fixture();
    const plan = await planCreate('example/project', payload(), 8, f.get, true);
    let attempts = 0;
    await expect(applyCreate(plan, plan.approvalHash, f.get, f.post, async () => {
      attempts++;
      throw Error('Settings update outcome uncertain');
    })).rejects.toThrow('uncertain');
    expect(attempts).toBe(1);
    expect(f.writes).toHaveLength(1);

    const g = fixture();
    const autoPlan = await planCreate('example/project', payload(), 8, g.get, true);
    const patchButIgnore = async (_target: string, _value: any) => { g.patches.push('attempted'); };
    await expect(applyCreate(autoPlan, autoPlan.approvalHash, g.get, g.post, patchButIgnore)).rejects.toThrow();
    expect(g.writes).toHaveLength(1);
    expect(g.patches).toEqual(['attempted']);
  });

  for (const mode of ['free', 'wrong-owner', 'denied', 'no-admin', 'unknown-admin']) {
    test('refuses private eligibility failure: ' + mode, async () => {
      const f = fixture(); f.state.repo.private = true;
      if (mode === 'no-admin') f.state.repo.permissions.admin = false;
      if (mode === 'unknown-admin') delete (f.state.repo as any).permissions;
      const get = async (path: string, paginated?: boolean): Promise<any> => {
        if (path !== 'user') return f.get(path, paginated);
        if (mode === 'denied') return { status: 'unavailable', httpStatus: 403, reason: 'denied' };
        return { status: 'observed', value: { login: mode === 'wrong-owner' ? 'other' : 'example',
          plan: { name: mode === 'free' ? 'free' : 'pro' } } };
      };
      await expect(planCreate('example/project', payload(), 8, get)).rejects.toThrow();
      expect(f.writes).toHaveLength(0);
    });
  }

  test('private owner with missing plan uses valid repository rules reads as capability evidence', async () => {
    const f = fixture(); f.state.repo.private = true;
    const get = async (path: string, paginated?: boolean): Promise<any> => path === 'user'
      ? { status: 'observed', value: { login: 'example' } } : f.get(path, paginated);
    const plan = await planCreate('example/project', payload(), 8, get);
    expect(plan.baseline.eligibility.plan).toBeNull();
    expect(plan.baseline.eligibility.feature).toBe('supported');
  });

  test('private owner with missing plan and malformed rules reads remains unknown', async () => {
    const f = fixture(); f.state.repo.private = true;
    const get = async (path: string, paginated?: boolean): Promise<any> => {
      if (path === 'user') return { status: 'observed', value: { login: 'example' } };
      if (path.includes('/rulesets?')) return { status: 'observed', value: [{ malformed: true }] };
      return f.get(path, paginated);
    };
    await expect(planCreate('example/project', payload(), 8, get)).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
  });

  for (const mode of ['rulesets-403', 'rulesets-404', 'effective-403', 'effective-404'] as const) {
    test(`private missing-plan capability rejects ${mode}`, async () => {
      const f = fixture(); f.state.repo.private = true;
      const get = async (path: string, paginated?: boolean): Promise<any> => {
        if (path === 'user') return { status: 'observed', value: { login: 'example' } };
        if (mode === 'rulesets-403' && path.includes('/rulesets?')) return { status: 'unavailable', httpStatus: 403 };
        if (mode === 'rulesets-404' && path.includes('/rulesets?')) return { status: 'unavailable', httpStatus: 404 };
        if (mode === 'effective-403' && path.includes('/rules/branches/')) return { status: 'unavailable', httpStatus: 403 };
        if (mode === 'effective-404' && path.includes('/rules/branches/')) return { status: 'unavailable', httpStatus: 404 };
        return f.get(path, paginated);
      };
      await expect(planCreate('example/project', payload(), 8, get)).rejects.toThrow();
      expect(f.writes).toHaveLength(0);
    });
  }

  test('explicit private free plan does not use repository rules capability fallback', async () => {
    const f = fixture(); f.state.repo.private = true;
    const seen: string[] = [];
    const get = async (path: string, paginated?: boolean): Promise<any> => {
      seen.push(path);
      if (path === 'user') return { status: 'observed', value: { login: 'example', plan: { name: 'free' } } };
      return f.get(path, paginated);
    };
    await expect(planCreate('example/project', payload(), 8, get)).rejects.toThrow('GitHub Pro');
    expect(seen.some(path => path.includes('/rulesets?'))).toBe(false);
    expect(seen.some(path => path.includes('/rules/branches/'))).toBe(false);
  });

  test('private missing-plan empty outer ruleset pages are not capability evidence', async () => {
    const f = fixture(); f.state.repo.private = true;
    const get = async (path: string, paginated?: boolean): Promise<any> => {
      if (path === 'user') return { status: 'observed', value: { login: 'example' } };
      if (path.includes('/rulesets?')) return { status: 'observed', value: [] };
      return f.get(path, paginated);
    };
    await expect(planCreate('example/project', payload(), 8, get)).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
  });

  test('auto-merge patch response for a different repository is rejected', async () => {
    const f = fixture();
    const plan = await planCreate('example/project', payload(), 8, f.get, true);
    await expect(applyCreate(plan, plan.approvalHash, f.get, f.post, async () => ({
      ...f.state.repo, full_name: 'example/other', allow_auto_merge: true,
    }))).rejects.toThrow('readback unavailable or mismatched');
    expect(f.writes).toHaveLength(1);
  });

  test('plan downgrade and admin revocation prevent an approved write', async () => {
    for (const change of ['plan', 'permission']) {
      const f = fixture(); f.state.repo.private = true;
      const plan = await planCreate('example/project', payload(), 8, f.get);
      if (change === 'permission') f.state.repo.permissions.admin = false;
      const get = async (path: string, paginated?: boolean): Promise<any> =>
        path === 'user' && change === 'plan'
          ? { status: 'observed', value: { login: 'example', plan: { name: 'free' } } } : f.get(path, paginated);
      await expect(applyCreate(plan, plan.approvalHash, get, f.post)).rejects.toThrow();
      expect(f.writes).toHaveLength(0);
    }
  });

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
} else if(method==='PATCH') {
  if(path!=='repos/example/project'||a[10]!=='--input'||a[11]!=='-')throw Error('wrong settings PATCH');
  const body=JSON.parse(await Bun.stdin.text());
  await Bun.write(process.env.RULESET_PATCH_CAPTURE, JSON.stringify(body));
  console.log(JSON.stringify({id:123,full_name:'example/project',owner:{type:'User',id:1,login:'example'},private:false,archived:false,allow_auto_merge:true,allow_merge_commit:true,allow_squash_merge:true,allow_rebase_merge:true}));
} else if(method==='GET') {
  if(path.endsWith('/rulesets/99')) console.log(JSON.stringify({...value.ruleset,id:99}));
  else if(path==='repos/example/project') {
    const patched=Boolean(process.env.RULESET_PATCH_CAPTURE && await Bun.file(process.env.RULESET_PATCH_CAPTURE).exists());
    console.log(JSON.stringify({id:123,full_name:'example/project',private:false,archived:false,allow_auto_merge:patched,allow_merge_commit:true,allow_squash_merge:true,allow_rebase_merge:true,owner:{type:'User',id:1,login:'example'},permissions:{admin:true},default_branch:'release/main'}));
  }
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

test('CLI opt-in applies protection before a one-field auto-merge PATCH and verifies repository readback', async () => {
  const f = fixture();
  const plan = await planCreate('example/project', payload(), 8, f.get, true);
  const path = join(directory, 'auto-plan.json'), capture = join(directory, 'auto-created.json');
  const patchCapture = join(directory, 'auto-patch.json');
  await Bun.write(path, JSON.stringify(plan));
  const child = Bun.spawn([process.execPath, resolve('scripts/create-ruleset.ts'), 'apply', '--plan', path,
    '--approve', plan.approvalHash], { stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, PATH: directory + ':' + process.env.PATH, RULESET_FIXTURE: path,
      RULESET_CAPTURE: capture, RULESET_PATCH_CAPTURE: patchCapture } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  expect(JSON.parse(stdout).verified).toBe(true);
  expect(await Bun.file(capture).json()).toEqual(payload());
  expect(await Bun.file(patchCapture).json()).toEqual({ allow_auto_merge: true });
});
