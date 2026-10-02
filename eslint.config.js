import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import svelte from 'eslint-plugin-svelte';
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-mock/**',
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
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['frontend-react/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
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
