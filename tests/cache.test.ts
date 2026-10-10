import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
const { exposeRuntime } = createRequire(import.meta.url)('../.github/actions/buildkit-cache-runtime/index.cjs');
const workflow = Bun.YAML.parse(await Bun.file('.github/workflows/image-build.yml').text()) as any;
const steps = workflow.jobs.build.steps;
const build = steps.find((s: any) => s.id === 'build').run;
const args = build.slice(build.indexOf('scope=$(printf'), build.indexOf('started=$(date'));
function cacheArguments(overrides: Record<string,string> = {}) {
  return Bun.spawnSync({ cmd: ['sh', '-c', args + '\nprintf "%s\\n" "$@"'], stdout:'pipe', stderr:'pipe', env: {
    ...process.env, BUILD_IMAGE:'ghcr.io/synthetic/image', BUILD_PLATFORMS:'linux/amd64', BUILD_CONTEXT:'.', BUILD_DOCKERFILE:'Dockerfile',
    BUILD_CACHE:'true', BUILD_CACHE_IMPORT:'true', CACHE_RUNTIME_MODE:'gha-v2', ...overrides,
  }});
}
describe('runtime bridge', () => {
  test('masks token before writing runtime and never logs URL', () => {
    const events: string[] = [];
    exposeRuntime({ ACTIONS_RUNTIME_TOKEN:'synthetic%token', ACTIONS_RESULTS_URL:'https://results.actions.githubusercontent.com/cache', GITHUB_ENV:'env', GITHUB_OUTPUT:'output' },
      (path: string, text: string) => events.push(path+':'+text), (text: string) => events.push(text));
    expect(events[0]).toBe('::add-mask::synthetic%25token');
    expect(events[1]).toContain('env:ACTIONS_RUNTIME_TOKEN=synthetic%token');
    expect(events[2]).toBe('output:mode=gha-v2\n');
  });
  test.each(['https://evil.invalid', 'https://actions.githubusercontent.com.evil.invalid', 'http://x.actions.githubusercontent.com', 'https://user:pass@x.actions.githubusercontent.com', 'https://x.actions.githubusercontent.com\nINJECT=true'])('rejects invalid endpoint %s', (url) => {
    const writes: string[]=[];
    exposeRuntime({ ACTIONS_RUNTIME_TOKEN:'synthetic', ACTIONS_RESULTS_URL:url, GITHUB_OUTPUT:'output' }, (_:string, text:string)=>writes.push(text), ()=>{});
    expect(writes).toEqual(['mode=off\n']);
  });
  test('rejects multiline token', () => {
    const writes: string[]=[];
    exposeRuntime({ ACTIONS_RUNTIME_TOKEN:'a\nb', ACTIONS_RESULTS_URL:'https://x.actions.githubusercontent.com', GITHUB_OUTPUT:'output' }, (_:string,text:string)=>writes.push(text), ()=>{});
    expect(writes).toEqual(['mode=off\n']);
  });
});
describe('actual cache argument builder', () => {
  test('imports and exports v2 max cache with bounded optional export', () => {
    const result=cacheArguments(); expect(result.exitCode).toBe(0);
    const output=result.stdout.toString(); expect(output).toContain('--import-cache'); expect(output).toContain('mode=max,timeout=2m,ignore-error=true'); expect(output).toContain('version=2');
  });
  test('cold exports without importing; disabled and unavailable use no cache', () => {
    expect(cacheArguments({BUILD_CACHE_IMPORT:'false'}).stdout.toString()).not.toContain('--import-cache');
    expect(cacheArguments({BUILD_CACHE_IMPORT:'false'}).stdout.toString()).toContain('--export-cache');
    for (const env of [{BUILD_CACHE:'false'}, {CACHE_RUNTIME_MODE:'off'}]) expect(cacheArguments(env).stdout.toString().trim()).toBe('');
  });
  test('all build configuration dimensions isolate scopes', () => {
    const baseline=cacheArguments().stdout.toString();
    for(const env of [{BUILD_IMAGE:'ghcr.io/synthetic/other'}, {BUILD_PLATFORMS:'linux/amd64,linux/arm64'}, {BUILD_CONTEXT:'sub'}, {BUILD_DOCKERFILE:'Otherfile'}]) expect(cacheArguments(env).stdout.toString()).not.toBe(baseline);
  });
  test('build failures stay fatal and fork gate precedes checkout', () => {
    expect(build).toContain('[ "$build_status" -eq 0 ] || exit "$build_status"');
    expect(steps[0].if).toContain('head.repo.full_name != github.repository');
    expect(steps[0].run).toBe('exit 1');
  });
});

describe('cache import failure cold fallback', () => {
  const classifier=build.slice(build.indexOf('cache_import_unavailable() {'), build.indexOf('if run_build "$@"'));
  const fallback=build.slice(build.indexOf('if [ "$build_status" -ne 0 ]'), build.indexOf('elapsed=$(( '));
  function retry(log: string, retryStatus=0) {
    const script=`work=$(mktemp -d); trap 'rm -rf "$work"' EXIT; printf '%s\\n' "$SYNTHETIC_LOG" > "$work/build.log"; build_status=1; BUILD_CACHE_IMPORT=true; CACHE_RUNTIME_MODE=gha-v2; run_build() { printf 'retry args: %s\\n' "$*"; return "$RETRY_STATUS"; }; ${classifier}\n${fallback}\nprintf 'status=%s mode=%s\\n' "$build_status" "$CACHE_RUNTIME_MODE"`;
    return Bun.spawnSync({cmd:['sh','-c',script], stdout:'pipe',stderr:'pipe',env:{...process.env,SYNTHETIC_LOG:log,RETRY_STATUS:String(retryStatus)}}).stdout.toString();
  }
  test('explicit terminal cache transport error retries once with no cache args', () => {
    const output=retry('ERROR: failed to solve: failed to import cache: unexpected status 503');
    expect(output).toContain('retry args: \n'); expect(output).toContain('status=0 mode=off');
  });
  test('cold retry failure remains fatal', () => {
    expect(retry('ERROR: failed to solve: failed to import cache: timeout',17)).toContain('status=17 mode=off');
  });
  test('compiler error, intermediate cache warnings and ambiguous failures never retry', () => {
    for(const log of ['ERROR: failed to solve: process go build exited 1', 'ERROR: failed to import cache: timeout\nERROR: failed to solve: process go build exited 1', 'ERROR: failed to solve: failed to import cache: invalid data']) {
      const result=retry(log); expect(result).not.toContain('retry args:'); expect(result).toContain('status=1 mode=gha-v2');
    }
  });
});
