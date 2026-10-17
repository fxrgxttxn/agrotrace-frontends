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
      '_site/**',
      '**/test-results/**',
      '**/.angular/**',
      '**/coverage/**',
      'contracts/**',
      'packages/mock-api/public/**',
    ],
  },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: c.files ? [...c.files, '**/*.{js,mjs,cjs}'] : ['**/*.{ts,tsx,mts,cts,js,mjs,cjs,svelte}'],
  })),
  {
    files: ['frontend-react/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['frontend-angular/src/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/component-selector': 'off',
      '@angular-eslint/directive-selector': 'off',
      '@angular-eslint/no-output-native': 'off',
      '@angular-eslint/component-class-suffix': ['error', { suffixes: ['Component', 'Page', 'App'] }],
    },
  },
  {
    files: ['frontend-angular/src/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    rules: {
      '@angular-eslint/template/label-has-associated-control': 'off',
    },
  },
  ...svelte.configs.recommended.map((c) => ({
    ...c,
    files: ['frontend-svelte/**/*.svelte', 'frontend-svelte/**/*.svelte.ts'],
  })),
  {
    files: ['frontend-svelte/**/*.svelte', 'frontend-svelte/**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.svelte'] } },
    rules: { 'svelte/no-navigation-without-resolve': 'off' },
  },
);
