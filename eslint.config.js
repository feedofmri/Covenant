import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["**/node_modules/**", "contracts/artifacts/**", "contracts/cache/**", "contracts/coverage/**", "web/dist/**", "data/**", "shared/abi/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser, ...globals.mocha },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^[A-Z_]" }], "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  { files: ["**/*.cjs"], languageOptions: { sourceType: "commonjs", globals: globals.node } },
];
