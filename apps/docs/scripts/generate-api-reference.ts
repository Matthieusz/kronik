import { mkdir } from "node:fs/promises"
import { generateFiles } from "fumadocs-openapi"
import { createOpenAPI } from "fumadocs-openapi/server"

const contractPath = "../../packages/contract/openapi.json"
const openapi = createOpenAPI({ input: [contractPath] })

await generateFiles({
  input: openapi,
  output: "./content/api-reference",
  per: "operation",
  meta: true,
  addGeneratedComment: true,
})

await mkdir("./public", { recursive: true })
await Bun.write("./public/openapi.json", Bun.file(contractPath))
