import { execFileSync } from 'node:child_process';
import { log } from '../log.js';

export function getGitUserEmail(projectDir: string): string {
  try {
    const result = execFileSync('git', ['config', 'user.email'], {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    if (result === '') {
      log.warn('git user.email unset; suppression authorship logged as "unknown"');
      return 'unknown';
    }
    return result;
  } catch {
    log.warn('git user.email unset; suppression authorship logged as "unknown"');
    return 'unknown';
  }
}
