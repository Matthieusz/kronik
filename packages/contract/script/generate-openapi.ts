/* oxlint-disable effecttsgo/unstable-api-usage -- Exact versions and integration tests guard unstable Effect HTTP/RPC APIs. */

import { OpenApi } from "effect/http-api"
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
