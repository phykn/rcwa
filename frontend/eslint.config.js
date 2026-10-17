import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "test-results/**", "playwright-report/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { ...reactHooks.configs.flat.recommended, files: ["src/**/*.{ts,tsx}"] },
  { files: ["src/**/*.{ts,tsx}"], languageOptions: { globals: globals.browser } },
  { files: ["*.ts", "*.js", "e2e/**/*.ts", "src/**/*.engine.test.ts"], languageOptions: { globals: globals.node } },
);
