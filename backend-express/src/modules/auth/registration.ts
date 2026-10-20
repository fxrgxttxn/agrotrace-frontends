/**
 * registerOrganization × DaData (contract registerOrganization, RegisterOrganizationRequest): found → PENDING with the
 * name and address from DaData; not found → 400 `errors.inn: [validation.inn.notFound]`; unavailable → MANUAL_CHECK
 * with the name from the request (400 `errors.name: [validation.required]` without one).
 */
import { validationProblem } from '../../http/problem.js';
import type { PartyLookup } from '../../infra/dadata.js';

export interface RegisteredIdentity {
  name: string;
  address: string | null;
  status: 'PENDING' | 'MANUAL_CHECK';
}

export function registrationIdentity(
  party: PartyLookup,
  requestName: string | undefined,
): RegisteredIdentity {
  if (party.status === 'found') return { name: party.name, address: party.address, status: 'PENDING' };
  if (party.status === 'notFound') throw validationProblem({ inn: ['validation.inn.notFound'] });
  if (requestName === undefined) throw validationProblem({ name: ['validation.required'] });
  return { name: requestName, address: null, status: 'MANUAL_CHECK' };
}
