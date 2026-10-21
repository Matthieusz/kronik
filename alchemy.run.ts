import { Stack, Stage } from "alchemy"
import { providers, state, Website } from "alchemy/Cloudflare"
import { Effect } from "effect"
import KronikApiLive, { KronikApi } from "./apps/api/src/worker.js"

/** Deploy the API and documentation gateway, attaching the public domain in production. */
export default Stack(
  "Kronik",
  { providers: providers(), state: state() },
  Effect.gen(function* () {
    const stage = yield* Stage
    const api = yield* KronikApi

    const docs = yield* Website.StaticSite("KronikDocs", {
      command: "bun run build",
      cwd: "apps/docs",
      main: "apps/docs/worker.ts",
      domain: stage === "prod" ? "kronik.informati.dev" : null,
      env: {
        API: api,
        NEXT_PUBLIC_API_URL: stage === "prod" ? "https://kronik.informati.dev/api" : api.url,
      },
      outdir: "out",
      assets: { htmlHandling: "drop-trailing-slash", runWorkerFirst: ["/api", "/api/*"] },
    })

    return {
      api: stage === "prod" ? "https://kronik.informati.dev/api" : api.url,
      docs: docs.url,
    }
  }).pipe(
    // This stack is the production infrastructure composition root.
    // oxlint-disable-next-line effecttsgo/strict-effect-provide
    Effect.provide(KronikApiLive),
  ),
)
