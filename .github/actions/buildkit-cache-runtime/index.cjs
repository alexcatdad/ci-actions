const { appendFileSync } = require('node:fs');

function exposeRuntime(env, append = appendFileSync, log = console.log) {
  const token = env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = env.ACTIONS_RESULTS_URL;
  const singleLine = (value) => typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value);
  let validUrl = false;
  try {
    const url = new URL(resultsUrl);
    validUrl = url.protocol === 'https:' && !url.username && !url.password &&
      url.hostname.endsWith('.actions.githubusercontent.com');
  } catch {}
  if (!singleLine(token) || !singleLine(resultsUrl) || !validUrl) {
    append(env.GITHUB_OUTPUT, 'mode=off\n');
    log('Cache runtime unavailable; continue with a cold image build.');
    return;
  }
  // Register masking before passing the ephemeral token through the runner's
  // protected environment file. Never interpolate it into process arguments.
  log(`::add-mask::${token.replaceAll('%', '%25')}`);
  append(env.GITHUB_ENV, `ACTIONS_RUNTIME_TOKEN=${token}\nACTIONS_RESULTS_URL=${resultsUrl}\n`);
  append(env.GITHUB_OUTPUT, 'mode=gha-v2\n');
}

if (require.main === module) {
  try {
    exposeRuntime(process.env);
  } catch {
    console.log('Cache runtime bridge unavailable; continue with a cold image build.');
    process.exitCode = 1;
  }
}
module.exports = { exposeRuntime };
