import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Metadata } from "next"
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page"
import { apiReference } from "../../lib/api-reference"

export const metadata: Metadata = {
  title: "API reference",
  description: "Generated reference documentation for the Kronik HTTP API.",
}

interface OpenApiDocument {
  readonly info?: {
    readonly title?: string
    readonly version?: string
  }
  readonly paths?: Readonly<Record<string, unknown>>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const readContract = async (): Promise<OpenApiDocument> => {
  const source = await readFile(resolve(process.cwd(), "../../packages/contract/openapi.json"), "utf8")
  const parsed: unknown = JSON.parse(source)

  if (!isRecord(parsed)) {
    throw new Error("The generated OpenAPI document must be an object")
  }

  const infoValue = parsed.info
  const title = isRecord(infoValue) ? optionalString(infoValue.title) : undefined
  const version = isRecord(infoValue) ? optionalString(infoValue.version) : undefined
  const info =
    title === undefined && version === undefined
      ? undefined
      : {
          ...(title === undefined ? {} : { title }),
          ...(version === undefined ? {} : { version }),
        }
  const paths = isRecord(parsed.paths) ? parsed.paths : undefined

  return {
    ...(info === undefined ? {} : { info }),
    ...(paths === undefined ? {} : { paths }),
  }
}

export default async function ApiReferencePage() {
  const document = await readContract()
  const paths = Object.keys(document.paths ?? {})
  const operations = apiReference.getPages()

  return (
    <DocsPage breadcrumb={{ enabled: false }} tableOfContent={{ enabled: false }}>
      <DocsBody>
        <DocsTitle>{document.info?.title ?? "Kronik API"}</DocsTitle>
        <DocsDescription>
          A generated reference for the Kronik HTTP API. Every operation below is derived from the
          shared contract package.
        </DocsDescription>

        <div className="not-prose kronik-card-grid">
          <div className="kronik-card">
            <h3>{paths.length} endpoint paths</h3>
            <p>Public routes exposed by the current contract.</p>
          </div>
          <div className="kronik-card">
            <h3>{operations.length} operations</h3>
            <p>Generated pages with parameters, schemas, responses, and examples.</p>
          </div>
          <div className="kronik-card">
            <h3>Version {document.info?.version ?? "unknown"}</h3>
            <p>Keep your integration aligned with the published contract.</p>
          </div>
        </div>

        <h2>Operations</h2>
        <div className="not-prose kronik-endpoints">
          {operations.map((operation) => (
            <a className="kronik-endpoint" href={operation.url} key={operation.url}>
              <span className="kronik-endpoint-title">{operation.data.title ?? operation.url}</span>
              <code className="kronik-endpoint-path">{operation.url}</code>
            </a>
          ))}
        </div>

        <p>
          <a href="/openapi.json">View the generated OpenAPI document →</a>
        </p>
      </DocsBody>
    </DocsPage>
  )
}
