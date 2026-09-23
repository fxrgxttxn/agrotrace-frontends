import tseslint from 'typescript-eslint';
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.svelte-kit/**',
      '**/.angular/**',
      '**/coverage/**',
      'contracts/**',
    ],
  },
  ...tseslint.configs.recommended,
);
