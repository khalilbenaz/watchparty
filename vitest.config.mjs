import { defineConfig } from "vitest/config";

// Logique pure de l'extension (extension/wp-core.js) : environnement Node.
// Les tests du Worker vivent dans server/ (runtime workerd).
export default defineConfig({ test: { include: ["tests/**/*.test.js"], environment: "node" } });
