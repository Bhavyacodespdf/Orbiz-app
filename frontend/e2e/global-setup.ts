import { execSync } from 'node:child_process';
import { backendEnv } from '../playwright.config';

/** Migrates and resets the isolated e2e database (the script refuses anything not named *_e2e). */
export default function globalSetup() {
  execSync('npm run e2e:prepare', {
    cwd: new URL('../../backend', import.meta.url).pathname,
    env: { ...process.env, ...backendEnv },
    stdio: 'inherit',
  });
}
