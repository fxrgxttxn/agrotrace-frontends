/**
 * The run's file order (vitest `sequence.sequencer`, main process, called once per run before any file starts):
 * vitest's own order (failed first, then by duration/size), except that contract-coverage.test.ts always runs LAST —
 * it reads what the other files recorded. It also starts the coverage registry of the run (lib/registry.ts):
 * truncates CALLS_FILE and writes the `run` record (the files of this run and the name filter).
 */
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { BaseSequencer, type WorkspaceSpec } from 'vitest/node';
import { CALLS_FILE, type RegistryRecord } from './registry.js';

export const COVERAGE_FILE = 'contract-coverage.test.ts';

export class CoverageLastSequencer extends BaseSequencer {
  override async sort(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    const sorted = await super.sort(files);
    const isCoverage = (s: WorkspaceSpec) => basename(s.moduleId) === COVERAGE_FILE;
    const ordered = [...sorted.filter((s) => !isCoverage(s)), ...sorted.filter(isCoverage)];
    const pattern = this.ctx.config.testNamePattern;
    const run: RegistryRecord = {
      kind: 'run',
      files: ordered.map((s) => basename(s.moduleId)),
      testNamePattern: pattern ? String(pattern) : null,
    };
    writeFileSync(CALLS_FILE, `${JSON.stringify(run)}\n`);
    return ordered;
  }
}
