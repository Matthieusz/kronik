/* oxlint-disable effecttsgo/unstable-api-usage */
/* oxlint-disable effecttsgo/strict-effect-provide */
import { describe, expect, test } from "bun:test"
import { ApiError } from "@kronik/contract/errors"
import { CommitSha, GitHubUsername, IsoDate, IsoTimestamp } from "@kronik/contract/model"
import { Deferred, Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Configuration } from "../src/config.js"
import { GitHub } from "../src/github.js"
import { batchFixture, commitFixture, readGraphqlRequest } from "./support/github-graphql.js"

type GraphqlRequest = ReturnType<typeof readGraphqlRequest>

const username = Schema.decodeUnknownSync(GitHubUsername)("MixedUser")

const from = Schema.decodeUnknownSync(IsoDate)("2026-01-01")

const to = Schema.decodeUnknownSync(IsoDate)("2026-01-30")

const snapshot = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T12:00:00Z")

const shaFor = (index: number) =>
  Schema.decodeUnknownSync(CommitSha)((index + 1).toString(16).padStart(40, "0"))

const configuration = {
  githubToken: Option.some(Redacted.make("test-token")),
  cursorSecret: Option.none<Redacted.Redacted>(),
  docsUrl: new URL("http://localhost:3001"),
  githubBaseUrl: new URL("https://api.github.test"),
  githubUserAgent: "kronik-test",
}

const makeFixture = (
  options: {
    readonly count?: number
    readonly repositories?: number
    readonly modify?: (request: GraphqlRequest, body: Schema.Json) => Schema.Json
    readonly beforeResponse?: (request: GraphqlRequest) => Effect.Effect<void>
  } = {},
) => {
  const calls: string[] = []
  const queries: GraphqlRequest[] = []
  const count = options.count ?? 100
  const repositories = options.repositories ?? count

  const client = HttpClient.make((request, url) => {
    calls.push(url.pathname)

    const response = (body: Schema.Json) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      )

    if (url.pathname === "/users/MixedUser")
      return response({
        login: "MixedUser",
        html_url: "https://github.com/MixedUser",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
      })

    if (url.pathname === "/search/commits")
      return response({
        total_count: count,
        incomplete_results: false,
        items: Array.from({ length: count }, (_, index) => ({
          sha: shaFor(index),
          html_url: `https://github.com/owner/repo-${index % repositories}/commit/${shaFor(index)}`,
          author: { login: "MixedUser" },
          repository: {
            full_name: `owner/repo-${index % repositories}`,
            html_url: `https://github.com/owner/repo-${index % repositories}`,
          },
        })),
      })

    if (url.pathname !== "/graphql") throw new Error(`Unexpected REST request: ${url.pathname}`)
    const query = readGraphqlRequest(request)
    queries.push(query)
    const body = batchFixture(query)

    if (body === undefined) throw new Error("Unexpected GraphQL operation")

    return (options.beforeResponse?.(query) ?? Effect.void).pipe(
      Effect.andThen(response(options.modify === undefined ? body : options.modify(query, body))),
    )
  })

  const layer = GitHub.layerWithClient(client).pipe(
    Layer.provide(Layer.succeed(Configuration, configuration)),
  )

  const activity = Effect.gen(function* () {
    const github = yield* GitHub.Service

    return yield* github.activity({ username, from, to })
  }).pipe(Effect.provide(layer))

  const commits = Effect.gen(function* () {
    const github = yield* GitHub.Service

    return yield* github.commits({ username, snapshot, pageSize: 100, position: 1 })
  }).pipe(Effect.provide(layer))

  return { calls, queries, activity, commits }
}

const commitQueries = (queries: ReadonlyArray<GraphqlRequest>) =>
  queries.filter((request) => request.query.includes("query CommitBatch"))

const languageQueries = (queries: ReadonlyArray<GraphqlRequest>) =>
  queries.filter((request) => request.query.includes("query LanguageBatch"))

const expectUpstreamFailure = async (effect: Effect.Effect<unknown, GitHub.Failure>) => {
  const result = await Effect.runPromise(Effect.result(effect))
  expect(Result.isFailure(result)).toBe(true)

  if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ApiError.UpstreamFailure)
}

describe("GitHub GraphQL batches", () => {
  test("hydrates 100 commits and 100 repository languages in 12 HTTP requests", async () => {
    const fixture = makeFixture()
    const result = await Effect.runPromise(fixture.activity)
    expect(result.items.map((item) => item.sha)).toEqual(
      Array.from({ length: 100 }, (_, index) => shaFor(index)),
    )
    expect(result.repositories).toHaveLength(100)
    expect(result.matchedCommits).toBe(100)
    expect(result.incompleteResults).toBe(false)
    expect(fixture.calls).toHaveLength(12)
    expect(commitQueries(fixture.queries)).toHaveLength(5)
    expect(languageQueries(fixture.queries)).toHaveLength(5)

    for (const query of fixture.queries) {
      expect(Object.keys(query.variables).filter((key) => key.startsWith("owner"))).toHaveLength(20)
      expect(query.query).not.toContain("repo-0")
    }

    expect(result.items[99]?.repository.nameWithOwner).toBe("owner/repo-99")
    expect(result.repositories[99]?.languages).toEqual([
      { name: "TypeScript", bytes: 100 },
      { name: "JavaScript", bytes: 50 },
    ])
  })
  test("runs a bounded number of hydration batches concurrently and preserves order", async () => {
    const ready = Deferred.makeUnsafe<void>()
    let active = 0
    let maximum = 0

    const fixture = makeFixture({
      repositories: 1,
      beforeResponse: (query) => {
        if (!query.query.includes("CommitBatch")) return Effect.void

        return Effect.gen(function* () {
          active += 1
          maximum = Math.max(maximum, active)

          if (active === 3) yield* Deferred.succeed(ready, undefined)
          yield* Deferred.await(ready)
          active -= 1
        })
      },
    })

    const result = await Effect.runPromise(fixture.activity.pipe(Effect.timeout("1 second")))
    expect(maximum).toBe(3)
    expect(result.items.map((item) => item.sha)).toEqual(
      Array.from({ length: 100 }, (_, index) => shaFor(index)),
    )
  })
  test("interrupts other hydration batches when a batch fails", async () => {
    const started = Deferred.makeUnsafe<void>()
    let interrupted = false

    const fixture = makeFixture({
      count: 40,
      beforeResponse: (query) => {
        if (!query.query.includes("CommitBatch")) return Effect.void

        if (query.variables.sha0 === shaFor(0)) return Deferred.await(started)

        return Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => (interrupted = true))),
        )
      },
      modify: (query, body) =>
        query.variables.sha0 === shaFor(0) ? { errors: [{ message: "Unavailable" }] } : body,
    })

    await expectUpstreamFailure(
      fixture.activity.pipe(
        Effect.timeout("1 second"),
        Effect.catchTag("TimeoutError", (error) => Effect.die(error)),
      ),
    )
    expect(interrupted).toBe(true)
  })
  test("uses batches for 100-item commit pages too", async () => {
    const fixture = makeFixture()
    const result = await Effect.runPromise(fixture.commits)
    expect(result.items).toHaveLength(100)
    expect(fixture.calls).toHaveLength(7)
    expect(languageQueries(fixture.queries)).toHaveLength(0)
  })
  test("handles a final partial batch and deduplicates repository languages", async () => {
    const fixture = makeFixture({ count: 21, repositories: 2 })
    const result = await Effect.runPromise(fixture.activity)
    expect(result.items).toHaveLength(21)
    expect(result.repositories).toHaveLength(2)
    expect(commitQueries(fixture.queries)).toHaveLength(2)
    expect(languageQueries(fixture.queries)).toHaveLength(1)
    expect(fixture.calls).toHaveLength(5)
  })
  test("skips GraphQL requests for an empty activity window", async () => {
    const fixture = makeFixture({ count: 0 })
    const result = await Effect.runPromise(fixture.activity)
    expect(result.items).toEqual([])
    expect(result.repositories).toEqual([])
    expect(fixture.calls).toHaveLength(2)
  })
  test.each(["commit", "language"])("rejects partial GraphQL %s failures", async (operation) => {
    const fixture = makeFixture({
      count: 1,
      modify: (query, body) => {
        const selected = operation === "commit" ? "CommitBatch" : "LanguageBatch"

        if (query.query.includes(selected))
          return {
            data: query.query.includes("CommitBatch")
              ? { c0: { object: commitFixture(shaFor(0), "owner/repo-0") } }
              : {
                  r0: {
                    languages: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  },
                },
            errors: [{ message: "Resolver unavailable" }],
          }

        return body
      },
    })

    await expectUpstreamFailure(fixture.activity)
  })
  test.each([
    { data: {} },
    { data: { c0: null } },
    { data: { c0: { object: null } } },
    { data: { c0: { object: commitFixture(shaFor(99), "owner/repo-0") } } },
    { data: { c0: { object: { ...commitFixture(shaFor(0), "owner/repo-0"), additions: -1 } } } },
  ])("rejects missing, mismatched, or malformed commits: %#", async (body) => {
    await expectUpstreamFailure(makeFixture({ count: 1, modify: () => body }).activity)
  })
  test.each([
    { data: {} },
    { data: { r0: null } },
    { data: { r0: { languages: null } } },
    {
      data: {
        r0: {
          languages: {
            edges: [{ size: -1, node: { name: "TypeScript" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ])("rejects missing or malformed language evidence: %#", async (body) => {
    const fixture = makeFixture({
      count: 1,
      modify: (query, original) => (query.query.includes("LanguageBatch") ? body : original),
    })

    await expectUpstreamFailure(fixture.activity)
  })
  test("paginates parents and languages without refetching completed selections", async () => {
    const parentSha = shaFor(55)

    const fixture = makeFixture({
      count: 2,
      modify: (query) => {
        const continued = query.variables.after0 === "next"
        const pageInfo = { hasNextPage: !continued, endCursor: continued ? null : "next" }

        if (query.query.includes("CommitBatch")) {
          const commit = commitFixture(shaFor(0), "owner/repo-0")

          const c0 = {
            object: {
              ...commit,
              parents: {
                nodes: continued
                  ? [{ oid: parentSha, url: `https://github.com/owner/repo-0/commit/${parentSha}` }]
                  : commit.parents.nodes,
                pageInfo,
              },
            },
          }

          if (continued) return { data: { c0 } }

          return { data: { c0, c1: { object: commitFixture(shaFor(1), "owner/repo-1") } } }
        }

        const r0 = {
          languages: {
            edges: [{ size: continued ? 7 : 5, node: { name: continued ? "Rust" : "TypeScript" } }],
            pageInfo,
          },
        }

        if (continued) return { data: { r0 } }

        return {
          data: {
            r0,
            r1: { languages: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          },
        }
      },
    })

    const result = await Effect.runPromise(fixture.activity)
    expect(result.items[0]?.parents.map((parent) => parent.sha)).toEqual([shaFor(0), parentSha])
    expect(result.items[1]?.sha).toBe(shaFor(1))
    expect(
      result.repositories.find((repository) => repository.nameWithOwner === "owner/repo-0")
        ?.languages,
    ).toEqual([
      { name: "TypeScript", bytes: 5 },
      { name: "Rust", bytes: 7 },
    ])
    expect(fixture.calls).toHaveLength(6)

    for (const query of fixture.queries.filter((request) => request.variables.after0 === "next"))
      expect(query.variables).not.toHaveProperty("owner1")
  })
  test.each([null, "repeated"])("rejects unusable pagination cursors: %s", async (cursor) => {
    const fixture = makeFixture({
      count: 1,
      modify: () => ({
        data: {
          c0: {
            object: {
              ...commitFixture(shaFor(0), "owner/repo-0"),
              parents: { nodes: [], pageInfo: { hasNextPage: true, endCursor: cursor } },
            },
          },
        },
      }),
    })

    await expectUpstreamFailure(fixture.activity)
    expect(fixture.calls.length).toBeLessThanOrEqual(4)
  })
  test.each(["FORBIDDEN", "RATE_LIMITED"])("preserves typed GraphQL %s failures", async (type) => {
    const fixture = makeFixture({
      count: 1,
      modify: () => ({ errors: [{ type, message: "Unavailable" }] }),
    })

    const result = await Effect.runPromise(Effect.result(fixture.activity))

    expect(Result.isFailure(result)).toBe(true)

    if (Result.isFailure(result))
      expect(result.failure).toBeInstanceOf(
        type === "FORBIDDEN" ? GitHub.CredentialRejected : ApiError.RateLimited,
      )
  })

  test.each(["CommitBatch", "LanguageBatch"])(
    "bounds pathological %s pagination",
    async (operation) => {
      let page = 0

      const fixture = makeFixture({
        count: 1,
        modify: (query, original) => {
          if (!query.query.includes(operation)) return original
          page += 1
          const pageInfo = { hasNextPage: true, endCursor: `page-${page}` }

          if (operation === "CommitBatch")
            return {
              data: {
                c0: {
                  object: {
                    ...commitFixture(shaFor(0), "owner/repo-0"),
                    parents: { nodes: [], pageInfo },
                  },
                },
              },
            }

          return { data: { r0: { languages: { edges: [], pageInfo } } } }
        },
      })

      await expectUpstreamFailure(fixture.activity)
      expect(page).toBe(10)
    },
  )
  test.each([0, 7, null])(
    "returns filesChanged from GitHub, including unavailable counts: %s",
    async (count) => {
      const fixture = makeFixture({
        count: 1,
        modify: () => ({
          data: {
            c0: {
              object: commitFixture(shaFor(0), "owner/repo-0", count),
            },
          },
        }),
      })

      const result = await Effect.runPromise(fixture.commits)

      expect(result.items[0]?.filesChanged).toBe(count)
      expect(commitQueries(fixture.queries)[0]?.query).toContain("changedFilesIfAvailable")
    },
  )

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid GitHub file counts: %s",
    async (count) => {
      const fixture = makeFixture({
        count: 1,
        modify: () => ({
          data: {
            c0: {
              object: commitFixture(shaFor(0), "owner/repo-0", count),
            },
          },
        }),
      })

      await expectUpstreamFailure(fixture.commits)
    },
  )
})
