import { describe, expect, it } from 'vitest';
import { ApiProblem, unwrap } from '../src/problem';

describe('unwrap', () => {
  it('returns data on success', () => {
    const data = { id: '1' };
    expect(unwrap({ data, error: undefined, response: new Response(null, { status: 200 }) })).toBe(data);
  });

  it('throws ApiProblem with rule BR-01 and params.until from the problem+json body', () => {
    const body = {
      type: '/problems/business-rule',
      title: 'Business rule violated',
      status: 422,
      code: 'BUSINESS_RULE' as const,
      rule: 'BR-01',
      params: { publicCode: 'AT-2026-000123', until: '2026-09-25', substance: 'Хлорпирифос' },
    };

    let thrown: unknown;
    try {
      unwrap({ data: undefined, error: body, response: new Response(null, { status: 422 }) });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiProblem);
    const problem = thrown as ApiProblem;
    expect(problem.status).toBe(422);
    expect(problem.code).toBe('BUSINESS_RULE');
    expect(problem.rule).toBe('BR-01');
    expect(problem.params).toEqual({
      publicCode: 'AT-2026-000123',
      until: '2026-09-25',
      substance: 'Хлорпирифос',
    });
  });

  it('carries errors, detail and title through for VALIDATION problems', () => {
    const body = {
      type: '/problems/validation',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION' as const,
      detail: 'email is invalid',
      errors: { email: ['validation.email'] },
    };

    expect(() => unwrap({ error: body, response: new Response(null, { status: 400 }) })).toThrowError(
      ApiProblem,
    );
    try {
      unwrap({ error: body, response: new Response(null, { status: 400 }) });
    } catch (error) {
      const problem = error as ApiProblem;
      expect(problem.title).toBe('Validation failed');
      expect(problem.detail).toBe('email is invalid');
      expect(problem.errors).toEqual({ email: ['validation.email'] });
      expect(problem.message).toBe('email is invalid');
    }
  });
});
