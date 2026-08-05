import { Stack } from "alchemy"
import { providers, state, Website } from "alchemy/Cloudflare"
import { Effect } from "effect"
import { KronikApi } from "./apps/api/src/worker.js"

/** Non-deployed Alchemy declaration for the API and static documentation Workers. */
export default Stack(
  "Kronik",
  { providers: providers(), state: state() },
  Effect.gen(function* () {
    const api = yield* KronikApi
    const docs = yield* Website.StaticSite("KronikDocs", {
      command: "bun run build",
      cwd: "apps/docs",
      outdir: "out",
      assets: { htmlHandling: "drop-trailing-slash" },
    })

    return { api: api.url, docs: docs.url }
  }),
)
