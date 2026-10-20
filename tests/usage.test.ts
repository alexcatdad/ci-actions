import { expect, test } from 'bun:test';
import { auditUsage, repositoryEligibility } from '../scripts/audit-repository';
const denied = { status: 'unavailable' as const, httpStatus: 403, reason: 'denied' };
const observed = (value: any) => ({ status: 'observed' as const, value });

test('public eligibility needs no paid subscription and reports admin separately', async () => {
  const result = await repositoryEligibility({ private: false, owner: { type: 'User' }, archived: false,
    permissions: { admin: false } }, async () => { throw Error('unnecessary account query'); });
  expect(result.feature).toBe('supported');
  expect(result.permission).toBe('insufficient');
});

test('usage distinguishes empty observed sample from unavailable billing and forbidden reads', async () => {
  const empty = await auditUsage('example/project', async () => observed({ total_count: 0, workflow_runs: [] }));
  expect(empty.complete).toBe(true);
  expect(empty.sampledRuns).toBe(0);
  expect(empty.billing.status).toBe('unavailable');
  const unavailable = await auditUsage('example/project', async () => denied);
  expect(unavailable.complete).toBe(false);
  expect(unavailable.runs).toEqual(denied);
});

test('usage ranks paginated jobs, preserves unknown durations and does not infer ARC is hosted', async () => {
  const calls: string[] = [];
  const result = await auditUsage('example/project', async (path, paginated) => {
    calls.push(path);
    if (path.endsWith('/actions/runs?per_page=20')) return observed({ total_count: 30, workflow_runs: [{ id: 1, name: 'CI' }] });
    expect(paginated).toBe(true);
    if (path.includes('/actions/runners?')) return observed([{ runners: [{ id: 9 }] }]);
    return observed([{ jobs: [{ id: 2, name: 'test', labels: ['self-hosted'], status: 'completed',
      started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:02:00Z' }] },
      { jobs: [{ id: 3, name: 'ARC', labels: ['homelab'], status: 'queued' },
        { id: 4, name: 'hosted', labels: ['ubuntu-latest'], status: 'queued' },
        { id: 5, name: 'registered ARC', labels: ['custom'], runner_id: 9, status: 'queued' }] }]);
  });
  expect(calls).toHaveLength(3);
  expect(result.truncated).toBe(true);
  expect(result.rankedJobs?.[0].elapsedSeconds).toBe(120);
  expect(result.rankedJobs?.[0].runner).toBe('self-hosted');
  expect(result.samples?.[0].jobs.value[1].runner).toBe('unknown');
  expect(result.samples?.[0].jobs.value[1].elapsedSeconds).toBeNull();
  expect(result.samples?.[0].jobs.value[2].runner).toBe('github-hosted-inferred');
  expect(result.samples?.[0].jobs.value[3].runner).toBe('self-hosted');
});

test('malformed or missing job evidence remains unavailable, never zero usage', async () => {
  for (const response of [denied, observed([{ wrong: [] }])]) {
    const result = await auditUsage('example/project', async path => path.endsWith('/actions/runs?per_page=20')
      ? observed({ total_count: 1, workflow_runs: [{ id: 1 }] }) : response);
    expect(result.complete).toBe(false);
    expect(result.samples?.[0].jobs.status).toBe('unavailable');
  }
});
