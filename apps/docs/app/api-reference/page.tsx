import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { apiReference } from "../../lib/api-reference"

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
  const endpointCount = Object.keys(document.paths ?? {}).length

  const paths = Object.keys(document.paths ?? {})
  const operations = apiReference.getPages()

  return (
    <main>
      <p>Kronik v1 API reference</p>
      <h1>{document.info?.title ?? "Kronik API"}</h1>
      <p>Version {document.info?.version ?? "unknown"}</p>
      <p>{endpointCount} endpoint paths are generated from the contract package.</p>
      <ul>
        {paths.map((path) => (
          <li key={path}>
            <code>{path}</code>
          </li>
        ))}
      </ul>
      <h2>Operations</h2>
      <ul>
        {operations.map((operation) => (
          <li key={operation.url}>
            <a href={operation.url}>{operation.data.title ?? operation.url}</a>
          </li>
        ))}
      </ul>
      <p>
        Fumadocs publishes one generated operation page per contract operation; endpoint schemas
        are never duplicated in the docs app.
      </p>
      <p>
        <a href="/concepts">Read the conceptual guide</a>
      </p>
      <p>
        <a href="/openapi.json">View the generated OpenAPI document</a>
      </p>
      <p>
        <a href="/">Back to Kronik</a>
      </p>
    </main>
  )
}
