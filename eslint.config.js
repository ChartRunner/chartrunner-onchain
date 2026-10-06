import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { console: "readonly", process: "readonly", URL: "readonly", crypto: "readonly", fetch: "readonly", Response: "readonly", TextEncoder: "readonly", AbortSignal: "readonly", Buffer: "readonly" },
    },
    rules: {
      // RPC responses and user-supplied JSON files are untyped and validated field by field at runtime.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
