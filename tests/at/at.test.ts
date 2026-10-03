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
    // P10: the suite runs against the api-test overrides, then the plain backend is restored.
    expect(plain.slice(-3)).toEqual([
      '+ docker compose -f docker-compose.yml -f docker-compose.api-test.yml up -d --no-build --wait api-express',
      '+ docker compose run --rm -e API_URL=http://api-express:8000/api/v1 -e API_BACKEND=express tools pnpm --filter @agrotrace/tests-api test',
      '+ docker compose up -d --no-build --wait api-express',
    ]);
    expect(plain).toContain(
      '+ docker compose up -d --build --wait api-express worker-express scheduler-express',
    );
    const r = sh(['./at', 'api:test', 'express', '--reset', 'health'], { AT_DRY_RUN: '1' });
    const cmds = r.out.split('\n').filter((l) => l.startsWith('+ '));
    expect(cmds.at(-4)).toMatch(/^\+ \S*at\.sh reset$/);
    expect(cmds.at(-2)).toMatch(/pnpm --filter @agrotrace\/tests-api test health$/);
  });

  it('api:test [back] --ratelimits runs only the [ratelimit] tests against the plain backend (P10)', () => {
    const cmds = sh(['./at', 'api:test', 'express', '--ratelimits'], { AT_DRY_RUN: '1' })
      .out.split('\n')
      .filter((l) => l.startsWith('+ '));
    expect(cmds.at(-1)).toBe(
      '+ docker compose run --rm -e API_URL=http://api-express:8000/api/v1 -e API_BACKEND=express -e API_RATELIMITS=1 tools pnpm --filter @agrotrace/tests-api test',
    );
    expect(cmds.some((l) => l.includes('docker-compose.api-test.yml'))).toBe(false);
    expect(readFileSync(`${REPO}docker-compose.api-test.yml`, 'utf8')).toMatch(
      /RATE_LIMIT_OVERRIDES: '\{"user":100000,"login-ip":100000\}'/,
    );
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

  it('fmt formats explicit paths only; no arguments or a flag is refused before prettier runs (P13)', () => {
    const ok = sh(['./at', 'fmt', 'backend-express/src', 'at.sh'], { AT_DRY_RUN: '1' });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out.split('\n').filter((l) => l.startsWith('+ '))).toEqual([
      '+ docker compose run --rm tools pnpm exec prettier --write -- backend-express/src at.sh',
    ]);
    for (const args of [[], ['--help'], ['-w'], ['src', '--check'], ['--', 'src']]) {
      const r = sh(['./at', 'fmt', ...args], { AT_DRY_RUN: '1' });
      expect(r.code, `fmt ${args.join(' ')}`).toBe(2);
      expect(r.out).not.toContain('prettier');
      expect(r.err).toMatch(/explicit paths only|only paths are accepted/);
    }
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

describe('fe:* (Plan 2): frontend build, tests, the separate React gateway, the smoke e2e', () => {
  const plus = (out: string) => out.split('\n').filter((l) => l.startsWith('+ '));

  it('help lists the fe commands', () => {
    const cmds = sh(['./at', 'help']).out.trim().split('\n');
    expect(cmds).toEqual(
      expect.arrayContaining(['fe:build', 'fe:test', 'fe:dev', 'fe:gateway', 'fe:e2e-smoke']),
    );
  });

  it('fe:build / fe:test react run in the tools container', () => {
    expect(plus(sh(['./at', 'fe:build', 'react'], { AT_DRY_RUN: '1' }).out)).toEqual([
      '+ docker compose run --rm tools pnpm --filter @agrotrace/frontend-react build',
    ]);
    expect(plus(sh(['./at', 'fe:test', 'react', '-t', 'shell'], { AT_DRY_RUN: '1' }).out)).toEqual([
      '+ docker compose run --rm tools pnpm --filter @agrotrace/frontend-react test -t shell',
    ]);
  });

  it('fe:gateway react starts and stops only gateway-react of project agrotrace-react', () => {
    expect(plus(sh(['./at', 'fe:gateway', 'react'], { AT_DRY_RUN: '1' }).out)).toEqual([
      '+ docker compose -f docker-compose.react-dev.yml up -d --build --wait gateway-react',
    ]);
    expect(plus(sh(['./at', 'fe:gateway', 'react', 'down'], { AT_DRY_RUN: '1' }).out)).toEqual([
      '+ docker compose -f docker-compose.react-dev.yml down',
    ]);
    const compose = readFileSync(`${REPO}docker-compose.react-dev.yml`, 'utf8');
    expect(compose).toMatch(/^name: agrotrace-react$/m);
    expect(compose).toMatch(/name: agrotrace_at\n\s+external: true/);
    expect(compose).toMatch(/- \.\/frontend-react\/dist:\/srv\/react:ro/);
    expect(compose).toMatch(/'8089:80'/);
  });

  it('fe:e2e-smoke react runs Playwright on the shared network against gateway-react', () => {
    expect(plus(sh(['./at', 'fe:e2e-smoke', 'react'], { AT_DRY_RUN: '1' }).out).at(-1)).toBe(
      '+ docker compose run --rm -w //repo/frontend-react playwright npx --no-install playwright test -c e2e/playwright.config.ts',
    );
  });

  it('fe:gateway svelte starts and stops only gateway-svelte of project agrotrace-svelte (own network, port 8091)', () => {
    expect(plus(sh(['./at', 'fe:gateway', 'svelte'], { AT_DRY_RUN: '1' }).out)).toEqual([
      '+ docker compose -f docker-compose.svelte-mock.yml up -d --build --force-recreate --wait gateway-svelte',
    ]);
    expect(plus(sh(['./at', 'fe:gateway', 'svelte', 'down'], { AT_DRY_RUN: '1' }).out)).toEqual([
      '+ docker compose -f docker-compose.svelte-mock.yml down',
    ]);
    const compose = readFileSync(`${REPO}docker-compose.svelte-mock.yml`, 'utf8');
    expect(compose).toMatch(/^name: agrotrace-svelte$/m);
    expect(compose).not.toMatch(/agrotrace_at/);
    expect(compose).toMatch(/- \.\/frontend-svelte\/build:\/srv\/svelte:ro/);
    expect(compose).toMatch(/'8091:80'/);
  });

  it('fe:build / fe:test / fe:e2e-smoke svelte', () => {
    expect(plus(sh(['./at', 'fe:build', 'svelte'], { AT_DRY_RUN: '1' }).out)).toEqual([
      '+ docker compose run --rm tools pnpm --filter @agrotrace/frontend-svelte build',
    ]);
    expect(plus(sh(['./at', 'fe:build', 'svelte', '--mock'], { AT_DRY_RUN: '1' }).out)).toEqual([
      '+ docker compose run --rm tools pnpm --filter @agrotrace/frontend-svelte build:mock',
    ]);
    expect(sh(['./at', 'fe:build', 'svelte', '--prod'], { AT_DRY_RUN: '1' }).code).toBe(2);
    // Polish P2: a running stand holds the build directory as a bind mount — stopped for the build, recreated after.
    expect(
      plus(sh(['./at', 'fe:build', 'svelte', '--mock'], { AT_DRY_RUN: '1', AT_DRY_STAND: '1' }).out),
    ).toEqual([
      '+ docker compose -f docker-compose.svelte-mock.yml stop gateway-svelte',
      '+ docker compose run --rm tools pnpm --filter @agrotrace/frontend-svelte build:mock',
      '+ docker compose -f docker-compose.svelte-mock.yml up -d --build --force-recreate --wait gateway-svelte',
    ]);
    // …and the shared suite says what to do when the stand is down, instead of failing on every page.
    const down = sh(['./at', 'e2e', 'svelte', 'mock'], { AT_DRY_RUN: '1', AT_DRY_STAND: '0' });
    expect(down.code).toBe(1);
    expect(down.err).toMatch(/Svelte stand .* is not running .* \.\/at fe:gateway svelte up/);
    expect(plus(sh(['./at', 'fe:test', 'svelte'], { AT_DRY_RUN: '1' }).out)).toEqual([
      '+ docker compose run --rm tools pnpm --filter @agrotrace/frontend-svelte test',
    ]);
    expect(plus(sh(['./at', 'fe:e2e-smoke', 'svelte'], { AT_DRY_RUN: '1' }).out).at(-1)).toBe(
      '+ docker compose -f docker-compose.svelte-mock.yml run --rm -w //repo/frontend-svelte playwright-svelte npx --no-install playwright test -c e2e/playwright.config.ts',
    );
  });

  it('rejects frontends that do not exist yet', () => {
    const r = sh(['./at', 'fe:build', 'angular'], { AT_DRY_RUN: '1' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/frontend-angular does not exist yet/);
    expect(sh(['./at', 'fe:test'], { AT_DRY_RUN: '1' }).code).toBe(2);
  });
});
