import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// vitest-pool-workers 0.22 replaced defineWorkersConfig()'s poolOptions.workers
// shape with a Vite plugin taking the same options directly — see that
// package's dist/codemods/vitest-v3-to-v4.mjs for the source of this mapping.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
});
