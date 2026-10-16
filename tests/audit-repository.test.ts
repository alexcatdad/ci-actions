import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixture = mkdtempSync(join(tmpdir(), 'repository-audit-'));
const script = resolve('scripts/audit-repository.ts');
const sha = 'a'.repeat(40);
await Bun.write(join(fixture, 'gh'), `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
await Bun.write(process.env.AUDIT_CALLS, args.join(' ') + '\\n', { createPath: true });
if(args[0] !== 'api' || args[1] !== '--hostname' || args[2] !== 'github.com' ||
   args[3] !== '--method' || args[4] !== 'GET') throw Error('unexpected API command');
const path = args[9];
const mode = process.env.AUDIT_MODE;
const sha = 'a'.repeat(40);
const root = 'repos/example/project';
let value;
if(mode === 'denied' || (mode === 'partial' && path.endsWith('/actions/permissions')) ||
   (mode === 'classic404' && path.endsWith('/protection'))) {
  console.error('gh: synthetic-private-diagnostic (HTTP ' + (mode === 'classic404' ? 404 : 403) + ')');
  process.exit(1);
}
if(path === root) value = { full_name:'example/project', private:mode === 'partial',
  visibility:mode === 'partial' ? 'private' : 'public', default_branch:'release/main',
  allow_auto_merge:false, delete_branch_on_merge:true };
else if(path === root+'/branches/release%2Fmain') {
  const marker=process.env.AUDIT_MARKER;
  const seen=await Bun.file(marker).exists();
  await Bun.write(marker, 'seen');
  value={name:'release/main', protected:true, commit:{sha:mode==='moving' && seen ? 'b'.repeat(40) : sha}};
}
else if(path.endsWith('/protection')) value={required_status_checks:{strict:true,contexts:['external']}};
else if(path.endsWith('/actions/permissions/workflow')) value={default_workflow_permissions:'read',can_approve_pull_request_reviews:false};
else if(path.endsWith('/actions/permissions')) value={enabled:true,allowed_actions:'all'};
else if(path.includes('/rulesets?')) value=[[{id:1,name:'parent',source_type:'Organization',enforcement:'active'}],[{id:2,name:'local',source_type:'Repository',enforcement:'disabled'}]];
else if(path.includes('/rules/branches/')) value=[[{type:'pull_request',ruleset_id:1}],[{type:'non_fast_forward',ruleset_id:1}]];
else if(path.includes('/check-runs?')) value=[{check_runs:[{name:'build',status:'completed',conclusion:'failure',head_sha:sha,app:{id:42}}]}, {check_runs:[{name:'test',status:'queued',conclusion:null,head_sha:sha,app:{id:42}},{name:'optional',status:'completed',conclusion:'skipped',head_sha:sha,app:{id:42}}]}];
else if(path.includes('/statuses?')) value=[[{context:'external',state:'pending',created_at:'2026-01-01T00:00:00Z'}],[]];
else throw Error('unexpected endpoint '+path);
if((path.includes('?per_page=') || path.includes('&per_page=')) &&
   (!args.includes('--paginate') || !args.includes('--slurp'))) throw Error('pagination missing');
if(mode === 'invalid' && path.endsWith('/actions/permissions')) console.log('invalid-json');
else console.log(JSON.stringify(value));
`);
chmodSync(join(fixture, 'gh'), 0o755);
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

let sequence = 0;
async function run(mode = 'normal', args = ['--repo', 'example/project']) {
  const id = sequence++;
  const child = Bun.spawn([process.execPath, script, ...args], {
    env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`,
      AUDIT_MODE: mode, AUDIT_MARKER: join(fixture, `marker-${id}`),
      AUDIT_CALLS: join(fixture, `calls-${id}`) },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code,
    report: stdout ? JSON.parse(stdout) : null,
    called: await Bun.file(join(fixture, `calls-${id}`)).exists() };
}

describe('read-only repository audit CLI', () => {
  test('collects paginated rules, checks and legacy statuses without grading CI', async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.report.complete).toBe(true);
    expect(result.report.branch.value.sha).toBe(sha);
    expect(result.report.branch.value.name).toBe('release/main');
    expect(result.report.rulesets.value.map((v: any) => v.source_type)).toEqual(['Organization', 'Repository']);
    expect(result.report.effectiveBranchRules.value).toHaveLength(2);
    expect(result.report.classicProtection.value.required_status_checks.contexts).toEqual(['external']);
    expect(result.report.checkRuns.value.map((v: any) => v.conclusion)).toEqual(['failure', null, 'skipped']);
    expect(result.report.checkRuns.value[0].app_id).toBe(42);
    expect(result.report.commitStatuses.value[0].state).toBe('pending');
    expect(result.report.repository.value.allow_auto_merge).toBe(false);
    expect(result.report.repository.value.archived).toBeNull();
    expect(result.stderr).toBe('');
  });

  test('marks partial private evidence unknown and omits raw diagnostics', async () => {
    const result = await run('partial');
    expect(result.code).toBe(2);
    expect(result.report.repository.value.private).toBe(true);
    expect(result.report.actions.status).toBe('unavailable');
    expect(result.report.actions.httpStatus).toBe(403);
    expect(result.report.checkRuns.status).toBe('observed');
    expect(result.stdout + result.stderr).not.toContain('synthetic-private-diagnostic');
  });

  test('does not infer absent protection from an HTTP 404', async () => {
    const result = await run('classic404');
    expect(result.code).toBe(2);
    expect(result.report.classicProtection.status).toBe('unavailable');
    expect(result.report.classicProtection.httpStatus).toBe(404);
    expect(result.report.effectiveBranchRules.value).toHaveLength(2);
  });

  test('detects a branch moving during collection', async () => {
    const result = await run('moving');
    expect(result.code).toBe(2);
    expect(result.report.branchUnchanged.value).toBe(false);
    expect(result.report.checkRuns.value[0].head_sha).toBe(sha);
  });

  test('reports metadata denial and malformed JSON as incomplete evidence', async () => {
    const denied = await run('denied');
    expect(denied.code).toBe(2);
    expect(denied.report.repository.status).toBe('unavailable');
    expect(denied.report.repository.httpStatus).toBe(403);
    const malformed = await run('invalid');
    expect(malformed.code).toBe(2);
    expect(malformed.report.actions.status).toBe('unavailable');
    expect(malformed.report.actions.httpStatus).toBeNull();
  });

  for (const args of [[], ['--repo', 'example/project', '--apply'], ['--repo', 'example/../project'],
    ['--repo', 'https://github.com/example/project'], ['--repo', 'example/project\nother'],
    ['--repo', 'example/..']]) {
    test(`rejects invalid arguments before gh executes: ${JSON.stringify(args)}`, async () => {
      const result = await run('normal', args);
      expect(result.code).toBe(1);
      expect(result.called).toBe(false);
      expect(result.stderr).toContain('Usage:');
    });
  }
});
