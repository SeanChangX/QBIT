// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Allow explicit any for pragmatic use (gradually tighten later)
      '@typescript-eslint/no-explicit-any': 'warn',
      // Prefer const assertions
      'prefer-const': 'error',
      // No console (use pino logger instead)
      'no-console': 'warn',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'eslint.config.mjs'],
  }
);
