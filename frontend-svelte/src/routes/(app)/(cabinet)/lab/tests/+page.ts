import { requireRole } from '$lib/app/guards';

export const load = requireRole('/lab/tests');
