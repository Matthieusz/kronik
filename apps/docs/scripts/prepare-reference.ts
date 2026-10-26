import { Config, Effect } from "effect"

// This build entrypoint owns environment decoding. The contract itself stays unchanged.
const apiUrl = Effect.runSync(
  Effect.gen(function* () {
    return yield* Config.URL("API_URL").pipe(
      Config.withDefault(new URL("https://kronik.informati.dev/api")),
    )
  }),
)

await Bun.write(
  "./.generated/api-server.json",
  JSON.stringify({
    overlay: "1.1.0",
    info: { title: "Kronik documentation server", version: "1.0.0" },
    actions: [{ target: "$", update: { servers: [{ url: apiUrl.toString() }] } }],
  }),
)

// Publish the unmodified, authoritative contract, not Blume's own docs API schema.
await Bun.write("./public/openapi.json", Bun.file("../../packages/contract/openapi.json"))
