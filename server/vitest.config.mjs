import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Les tests du Worker tournent dans le vrai runtime workerd (Miniflare).
// Les liaisons ci-dessous sont des valeurs de TEST, jamais des secrets réels.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          ROOM_SECRET: "secret-de-test-uniquement",
          ALLOWED_ORIGINS: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.js"] },
});
