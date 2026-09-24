import { describe, it, expect } from 'vitest';
import { assertTestDatabase } from './guard';

describe('tests/db database guard (R83)', () => {
  it('accepts only databases whose name ends in _test', () => {
    expect(() =>
      assertTestDatabase('postgres://u:p@postgres:5432/agrotrace_test?sslmode=disable', 'X'),
    ).not.toThrow();
    expect(() => assertTestDatabase('postgres://u:p@postgres:5432/agrotrace_test', 'X')).not.toThrow();
    for (const url of [
      'postgres://u:p@postgres:5432/agrotrace?sslmode=disable',
      'postgres://u:p@postgres:5432/agrotrace',
      'postgres://u:p@postgres:5432/agrotrace_test_copy',
      'postgres://u:p@postgres:5432/test',
    ])
      expect(() => assertTestDatabase(url, 'DATABASE_URL'), url).toThrow(/refuses to run against database/);
    expect(() => assertTestDatabase(undefined, 'APP_DATABASE_URL')).toThrow(/APP_DATABASE_URL is not set/);
  });

  it('guards the pools this suite actually uses', () => {
    expect(() => assertTestDatabase(process.env.DATABASE_URL, 'DATABASE_URL')).not.toThrow();
    expect(() => assertTestDatabase(process.env.APP_DATABASE_URL, 'APP_DATABASE_URL')).not.toThrow();
  });
});
