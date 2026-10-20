// Cache keys shared by the screens (QueryCache: a prefix invalidates the whole family) — a module of its own so a screen
// never pulls another screen's chunk in for a key.

export const FIELDS_KEY = 'fields?';
export const fieldKey = (id: string) => `field:${id}`;

export const BATCHES_KEY = 'batches?';
/** A batch card; its tabs are `batch:<id>:<tab>`. */
export const batchKey = (id: string) => `batch:${id}`;
/** Every batch card and tab. */
export const BATCH_PREFIX = 'batch:';

export const WAYBILLS_KEY = 'waybills?';
export const waybillKey = (id: string) => `waybill:${id}`;

export const LAB_TESTS_KEY = 'labTests?';
export const labTestKey = (id: string) => `labTest:${id}`;
export const DASHBOARD_KEY = 'dashboard?';
export const RECALLS_KEY = 'recalls?';
export const recallKey = (id: string) => `recall:${id}`;
export const RECALL_TASKS_KEY = 'recallTasks?';
export const COMPLAINTS_KEY = 'complaints?';
export const complaintKey = (id: string) => `complaint:${id}`;
