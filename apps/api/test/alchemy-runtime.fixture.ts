import { localState, Stack } from "alchemy"
import { providers } from "alchemy/Cloudflare"
import { Effect } from "effect"
import { KronikApi } from "../src/worker.js"
import KronikApiLive from "./alchemy-runtime.worker.js"

/** Local-only stack used to boot Kronik's production Alchemy Worker declaration. */
export default Stack(
  "KronikRuntimeVerification",
  { providers: providers(), state: localState() },
  // SAFETY: Effect beta.103 retains already-provided Durable Object services in this Layer's type.
  // @ts-expect-error -- the initialized Worker test proves the complete Layer is provided at runtime.
  Effect.gen(function* () {
    const api = yield* KronikApi
    return { api: api.url }
  }).pipe(
    // This fixture stack is the initialized Worker's local composition root.
    // oxlint-disable-next-line effecttsgo/strict-effect-provide
    Effect.provide(KronikApiLive),
  ),
)
