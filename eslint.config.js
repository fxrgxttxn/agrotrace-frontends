import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import angular from 'angular-eslint';
import svelte from 'eslint-plugin-svelte';
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-mock/**',
      '**/dist-public/**',
      '**/node_modules/**',
      '**/.svelte-kit/**',
      '**/.svelte-kit-mock/**',
      'frontend-svelte/build/**',
      'frontend-svelte/build-mock/**',
      '**/test-results/**',
      '**/.angular/**',
      '**/coverage/**',
      'contracts/**',
      'packages/mock-api/public/**',
      // P33: the user's untracked document generators.
      'docs/reports/**',
    ],
  },
  // TypeScript rules for script files and Svelte components only (the Angular inline templates are linted as HTML below).
  // Configs with their own `files` (typescript-eslint's eslint-recommended overrides for .ts) keep them.
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: c.files ?? ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}', 'frontend-svelte/**/*.svelte'],
  })),
  {
    files: ['frontend-react/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  // Angular (spec §9.7 @angular-eslint): TypeScript rules plus the inline templates (processed as HTML).
  {
    files: ['frontend-angular/src/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      // The wrappers' hosts ARE the design-system README elements (`button.at-button`, `div.at-field`, routed pages
      // `div.at-page`): class/element selectors instead of `at-*` custom elements, so the DOM has no extra host element.
      '@angular-eslint/component-selector': 'off',
      '@angular-eslint/directive-selector': 'off',
      // Outputs are named after what happened in README terms (`select`, `search`, `closed`, `toggled`).
      '@angular-eslint/no-output-native': 'off',
      // Routed screens are `…Page` (as in the React app), the public root `PublicApp`.
      '@angular-eslint/component-class-suffix': ['error', { suffixes: ['Component', 'Page', 'App'] }],
    },
  },
  {
    files: ['frontend-angular/src/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    rules: {
      // `<label class="at-check">`, `<label class="at-radio">` are wrapper components that render their own input inside
      // the label (README «Флажок»); the association is checked by the README DOM tests.
      '@angular-eslint/template/label-has-associated-control': 'off',
    },
  },
  // Svelte app (spec §9.7: eslint-plugin-svelte): components and runes modules, TypeScript inside <script lang="ts">.
  ...svelte.configs.recommended.map((c) => ({
    ...c,
    files: ['frontend-svelte/**/*.svelte', 'frontend-svelte/**/*.svelte.ts'],
  })),
  {
    files: ['frontend-svelte/**/*.svelte', 'frontend-svelte/**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.svelte'] } },
    // The app is served at the site root (no `paths.base`): app links are plain root-relative paths, the same in the
    // three frontends; `resolve()` would add nothing.
    rules: { 'svelte/no-navigation-without-resolve': 'off' },
  },
);
