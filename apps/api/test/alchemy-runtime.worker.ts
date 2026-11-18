import { Layer, Option, Redacted } from "effect"
import { Configuration } from "../src/config.js"
import { KronikApi, makeKronikWorkerInitializer } from "../src/worker.js"

const configuration = Configuration.of({
  githubToken: Option.some(Redacted.make("initialized-worker-test-token")),
  cursorSecret: Option.some(Redacted.make("initialized-worker-test-secret")),
  docsUrl: new URL("https://docs.example.test"),
  githubBaseUrl: new URL("http://127.0.0.1:43119"),
  githubUserAgent: "kronik-initialized-worker-test",
})

/** Initialized Worker fixture with production bindings and deterministic boundary configuration. */
export default KronikApi.make(
  { main: import.meta.url },
  makeKronikWorkerInitializer(Layer.succeed(Configuration, configuration)),
)
