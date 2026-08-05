import { resolve } from "node:path"
import { loader } from "fumadocs-core/source"
import { createOpenAPI } from "fumadocs-openapi/server"

const contractPath = resolve(process.cwd(), "../../packages/contract/openapi.json")
const openapi = createOpenAPI({ input: [contractPath] })
const source = await openapi.staticSource({ meta: true })

/** The generated OpenAPI pages exposed through the static docs site. */
export const apiReference = loader(source, {
  baseUrl: "/api-reference",
  plugins: [openapi.loaderPlugin()],
})
