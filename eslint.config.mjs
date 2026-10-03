import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["**/node_modules/**", "**/.wrangler/**", "dist/**"] },
  js.configs.recommended,
  {
    // Extension : scripts classiques (pas de modules), API chrome.*
    files: ["extension/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...globals.webextensions, module: "readonly", importScripts: "readonly", WP_CONFIG: "readonly", WPCore: "readonly" } },
  },
  {
    files: ["extension/background.js"],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.webextensions, importScripts: "readonly", WP_CONFIG: "readonly", WPCore: "readonly" } },
  },
  {
    // Worker : modules ES, runtime workerd
    files: ["server/src/**/*.js", "server/test/**/*.js", "server/*.mjs"],
    languageOptions: { sourceType: "module", globals: { ...globals.serviceworker, WebSocketPair: "readonly" } },
  },
  {
    files: ["tests/**/*.js", "*.mjs"],
    languageOptions: { sourceType: "module", globals: globals.node },
  },
  { rules: { "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }], "no-empty": ["error", { allowEmptyCatch: true }] } },
];
