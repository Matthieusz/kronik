import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "../src/api.js"

const document = `${JSON.stringify(OpenApi.fromApi(Api), null, 2)}\n`
const target = new URL("../openapi.json", import.meta.url)

if (process.argv.includes("--check")) {
  if ((await Bun.file(target).text()) !== document) {
    console.error(
      "Generated OpenAPI document is stale. Run `bun run openapi:generate` from packages/contract.",
    )
    process.exit(1)
  }
  process.exit(0)
}

await Bun.write(target, document)
