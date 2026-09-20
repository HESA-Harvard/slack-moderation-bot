import type { Env as WorkerEnv } from "../src/index";

// @cloudflare/vitest-pool-workers now types `cloudflare:test`'s `env` export as
// the ambient `Cloudflare.Env` from @cloudflare/workers-types, merged across
// declarations (see that package's index.d.ts) — not a module-local
// `ProvidedEnv` as in prior versions.
// The top-level import makes this file a module, so the namespace below must be
// wrapped in `declare global` — otherwise it'd be a module-local `Cloudflare`
// namespace instead of merging with the ambient global one.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
