/**
 * The repo's command wrappers (R85, R88 M6), run with bash inside the tools container. `up` is exercised
 * with AT_DRY_RUN=1, which prints the docker commands instead of running them.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

function sh(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const git = (...args: string[]) =>
  spawnSync('git', ['-c', `safe.directory=${REPO.replace(/\/$/, '')}`, ...args], {
    cwd: REPO,
    encoding: 'utf8',
  }).stdout;

describe('./at wrapper (R88 M6)', () => {
  it('is an executable bash script that runs at.sh with the same arguments', () => {
    expect(git('ls-files', '-s', 'at')).toMatch(/^100755 /);
    expect(readFileSync(`${REPO}at`, 'utf8')).toMatch(
      /^#!\/usr\/bin\/env bash\n[\s\S]*exec "\$\(dirname "\$0"\)\/at\.sh" "\$@"/,
    );
    const viaAt = sh(['./at', 'help']);
    expect(viaAt.code).toBe(0);
    expect(viaAt.out).toBe(sh(['./at.sh', 'help']).out);
  });

  it('help lists the top-level commands only', () => {
    const cmds = sh(['./at', 'help']).out.trim().split('\n');
    expect(cmds).toEqual(expect.arrayContaining(['up', 'test', 'test:all', 'seed', 'seed:docs', 'check']));
    expect(cmds).not.toContain('infra');
    expect(cmds).not.toContain('gateway');
    expect(cmds).not.toContain('express');
  });

  it.each([
    ['express', 'api-express worker-express scheduler-express'],
    ['django', 'api-django worker-django beat-django'],
    ['laravel', 'api-laravel worker-laravel scheduler-laravel'],
  ])('up <front> %s starts infra, the backend services and the gateway', (back, services) => {
    for (const front of ['react', 'angular', 'svelte']) {
      const r = sh(['./at', 'up', front, back], { AT_DRY_RUN: '1' });
      expect(r.code, r.err).toBe(0);
      expect(r.out.split('\n').filter((l) => l.startsWith('+ '))).toEqual([
        '+ docker compose up -d --build --wait postgres redis rabbitmq minio mailpit mercury-mock',
        '+ docker compose up --build minio-init',
        `+ docker compose up -d --build --wait ${services} gateway`,
      ]);
      expect(r.out).toMatch(new RegExp(`http://${front}-${back}\\.localhost:\\d+/`));
    }
  });

  it('rejects an unknown frontend or backend with a usage message', () => {
    for (const args of [
      ['up', 'react', 'rails'],
      ['up', 'react'],
      ['up', 'vue', 'express'],
    ]) {
      const r = sh(['./at', ...args], { AT_DRY_RUN: '1' });
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toMatch(/usage: \.\/at up/);
    }
  });

  it('up <back> starts infra and the backend services only (no gateway)', () => {
    const r = sh(['./at', 'up', 'express'], { AT_DRY_RUN: '1' });
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n').filter((l) => l.startsWith('+ '))).toEqual([
      '+ docker compose up -d --build --wait postgres redis rabbitmq minio mailpit mercury-mock',
      '+ docker compose up --build minio-init',
      '+ docker compose up -d --build --wait api-express worker-express scheduler-express',
    ]);
  });

  it('api:test [back] [--reset] runs tests/api against api-<back> after starting it', () => {
    const plain = sh(['./at', 'api:test'], { AT_DRY_RUN: '1' })
      .out.split('\n')
      .filter((l) => l.startsWith('+ '));
    expect(plain.at(-1)).toBe(
      '+ docker compose run --rm -e API_URL=http://api-express:8000/api/v1 -e API_BACKEND=express tools pnpm --filter @agrotrace/tests-api test',
    );
    expect(plain).toContain(
      '+ docker compose up -d --build --wait api-express worker-express scheduler-express',
    );
    const r = sh(['./at', 'api:test', 'express', '--reset', 'health'], { AT_DRY_RUN: '1' });
    const cmds = r.out.split('\n').filter((l) => l.startsWith('+ '));
    expect(cmds.at(-2)).toMatch(/^\+ \S*at\.sh reset$/);
    expect(cmds.at(-1)).toMatch(/pnpm --filter @agrotrace\/tests-api test health$/);
  });

  it('docs:test [back] starts the backend and the gateway, then the Playwright Swagger UI check (P5)', () => {
    const cmds = sh(['./at', 'docs:test'], { AT_DRY_RUN: '1' })
      .out.split('\n')
      .filter((l) => l.startsWith('+ '));
    expect(cmds.slice(-2)).toEqual([
      '+ docker compose up -d --build --wait gateway',
      '+ docker compose run --rm -e DOCS_BACKEND=express playwright npx --no-install playwright test -c api-docs/playwright.config.ts',
    ]);
    expect(cmds).toContain(
      '+ docker compose up -d --build --wait api-express worker-express scheduler-express',
    );
    expect(readFileSync(`${REPO}at.sh`, 'utf8')).toMatch(/"\$0" gw:test\n {4}"\$0" docs:test express\n/);
  });

  it('up infra starts mercury-mock too (R88 M4)', () => {
    const r = sh(['./at', 'up', 'infra'], { AT_DRY_RUN: '1' });
    expect(r.out).toContain(
      '+ docker compose up -d --build --wait postgres redis rabbitmq minio mailpit mercury-mock',
    );
  });
});

describe('Windows wrappers (R85, R88 M6)', () => {
  it('at.ps1 resolves Git Bash from git, never a bare `bash` (WSL)', () => {
    const ps1 = readFileSync(`${REPO}at.ps1`, 'utf8');
    expect(ps1).toMatch(/Get-Command git/);
    expect(ps1).toMatch(/'\.\.\\bin\\bash\.exe'/);
    expect(ps1).toMatch(/\$env:ProgramFiles 'Git\\bin\\bash\.exe'/);
    expect(ps1).toMatch(/& \$bash "\$PSScriptRoot\/at\.sh" @args/);
    expect(ps1).not.toMatch(/^\s*& bash /m);
  });

  it('at.cmd delegates to at.ps1 and keeps the exit code', () => {
    const cmd = readFileSync(`${REPO}at.cmd`, 'utf8');
    expect(cmd).toMatch(/powershell\.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0at\.ps1" %\*/);
    expect(cmd).toMatch(/exit \/b %ERRORLEVEL%/);
  });
});
