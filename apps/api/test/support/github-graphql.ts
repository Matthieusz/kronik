/* oxlint-disable effecttsgo/unstable-api-usage */
import { Predicate, Schema } from "effect"
import type { HttpClientRequest } from "effect/http/HttpClientRequest"

/** JSON envelope accepted by the GitHub GraphQL test transport. */
export const GraphqlRequest = Schema.Struct({
  query: Schema.String,
  variables: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
})

/** Decode the JSON request body emitted by the real GitHub adapter. */
export const readGraphqlRequest = (request: HttpClientRequest) => {
  if (!Predicate.isTagged(request.body, "Uint8Array"))
    throw new Error("Expected a JSON GraphQL request")

  return Schema.decodeUnknownSync(GraphqlRequest)(
    JSON.parse(new TextDecoder().decode(request.body.body)),
  )
}

/** A complete commit with one parent, without a REST repository field. */
export const commitFixture = (
  sha: string,
  repository: string,
  filesChanged: number | null = 2,
) => ({
  oid: sha,
  url: `https://github.com/${repository}/commit/${sha}`,
  message: "Implement latest\n\nWith details",
  authoredDate: "2026-01-02T03:04:05Z",
  committedDate: "2026-01-02T03:05:06Z",
  additions: 3,
  deletions: 1,
  changedFilesIfAvailable: filesChanged,
  parents: {
    nodes: [{ oid: sha, url: `https://github.com/${repository}/commit/${sha}` }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
})

/** Respond to batch selections while leaving the contribution-calendar query to its fixture. */
export const batchFixture = (
  request: ReturnType<typeof readGraphqlRequest>,
  commit: (sha: string, repository: string) => ReturnType<typeof commitFixture> = commitFixture,
) => {
  const data: Record<string, Schema.Json> = {}

  if (
    !request.query.includes("query CommitBatch") &&
    !request.query.includes("query LanguageBatch")
  )
    return undefined

  for (const key of Object.keys(request.variables)) {
    if (!key.startsWith("owner")) continue
    const index = key.slice(5)
    const owner = request.variables[key]
    const name = request.variables[`name${index}`]
    const sha = request.variables[`sha${index}`]

    if (request.query.includes("query CommitBatch")) {
      if (sha === undefined || sha === null) throw new Error("Missing requested commit SHA")
      data[`c${index}`] = { object: commit(sha, `${owner}/${name}`) }
      continue
    }

    data[`r${index}`] = {
      languages: {
        edges: [
          { size: 100, node: { name: "TypeScript" } },
          { size: 50, node: { name: "JavaScript" } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }
  }

  return { data }
}
