import { Component, type Provider, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeAll } from 'vitest';
import { UI } from '../../src/app/ui';

// DOM comparisons with the README run with Angular's dev mode switched off while the view renders, i.e. with exactly
// the DOM the production build renders. In dev mode Angular writes `ng-reflect-<input>` debugging attributes for every
// bound input — they never exist in the production build, and the README comparison strips nothing (test/ui/readme.ts
// throws on Angular marker attributes instead). `ngDevMode` is read by Angular at call time. Component definitions are
// compiled (JIT, in tests) while dev mode is still on, so TestBed can restore them between tests.

type G = { ngDevMode?: unknown };
let saved: unknown;
let off = false;

function productionMode(): void {
  if (off) return;
  saved = (globalThis as G).ngDevMode;
  (globalThis as G).ngDevMode = false;
  off = true;
}

function devMode(): void {
  if (!off) return;
  (globalThis as G).ngDevMode = saved;
  off = false;
}

/** Compiles every wrapper up front (dev mode) and switches dev mode back on after each test. */
export function useProductionDom(): void {
  beforeAll(() => {
    for (const t of UI)
      void (
        (t as unknown as Record<string, unknown>)['ɵcmp'] ?? (t as unknown as Record<string, unknown>)['ɵdir']
      );
  });
  afterEach(() => devMode());
}

/** Renders `template` (with `imports`) in a host component and runs the first change detection in production mode.
 * `ctx` becomes fields of the host (event handlers, values). */
export function renderProd<T extends object>(
  template: string,
  imports: readonly Type<unknown>[] = UI,
  ctx: T = {} as T,
  providers: Provider[] = [],
): ComponentFixture<T> {
  @Component({ standalone: true, template, imports: [...imports] })
  class Host {
    constructor() {
      Object.assign(this, ctx);
    }
  }
  TestBed.configureTestingModule({ providers: [provideRouter([]), ...providers] });
  const fixture = TestBed.createComponent(Host) as unknown as ComponentFixture<T>;
  productionMode();
  fixture.detectChanges();
  return fixture;
}
