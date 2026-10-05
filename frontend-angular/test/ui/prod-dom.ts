import { Component, type Provider, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeAll } from 'vitest';
import { UI } from '../../src/app/ui';

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

export function useProductionDom(): void {
  beforeAll(() => {
    for (const t of UI)
      void (
        (t as unknown as Record<string, unknown>)['ɵcmp'] ?? (t as unknown as Record<string, unknown>)['ɵdir']
      );
  });
  afterEach(() => devMode());
}

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
