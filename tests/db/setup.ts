import { afterAll } from 'vitest';
import { appPool, ownerPool } from './helpers';

afterAll(() => Promise.all([appPool.end(), ownerPool.end()]));
