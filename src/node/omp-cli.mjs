import { execFile } from 'node:child_process';
import path from 'node:path';

const PROFILE_ENV = ['OMP_PROFILE', 'PI_PROFILE', 'PI_CODING_AGENT_DIR', 'PI_SESSION_FILE', 'PI_SESSION_ID'];

export async function ompUsage(profile, { command = '', home, env = process.env, timeoutMs = 60_000 } = {}) {
  const childEnv = { ...env };
  for (const key of PROFILE_ENV) delete childEnv[key];
  if (profile !== 'default') childEnv.OMP_PROFILE = profile;
  const candidates = command ? [command] : ['omp', ...(home ? [path.join(home, '.local', 'bin', 'omp')] : [])];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await run(candidate, childEnv, timeoutMs));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('omp was not found. Set its path in Settings → Plugins → Usage Insights → omp command.');
}

function run(command, env, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, ['usage', '--json'], { env, timeout, maxBuffer: 32 << 20, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
