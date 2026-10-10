import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'artifacts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**/*.{ts,tsx}', 'vite.config.ts'], languageOptions: { globals: globals.browser } },
  { files: ['*.js', 'scripts/**/*.mjs'], languageOptions: { globals: globals.node } },
);
