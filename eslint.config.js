import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.svelte-kit/**',
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
);
