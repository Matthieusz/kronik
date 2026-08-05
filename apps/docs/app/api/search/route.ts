import { createFromSource } from "fumadocs-core/search/server"
import { apiReference } from "../../../lib/api-reference"

const search = createFromSource(apiReference)

/** Generate a static search index for the exported documentation site. */
export const revalidate = false

/** Serve the generated Fumadocs search index. */
export const GET = search.staticGET
