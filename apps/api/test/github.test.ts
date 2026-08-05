import { describe, expect, test } from "bun:test"
import { Configuration } from "../src/config.js"
import { GitHub } from "../src/github.js"
import { Observability } from "../src/observability.js"
import { CommitSha, GitHubUsername, IsoDate, IsoTimestamp } from "@kronik/contract/model"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

const sha = "0123456789abcdef0123456789abcdef01234567"
const username = Schema.decodeUnknownSync(GitHubUsername)("MixedUser")
const commitSha = Schema.decodeUnknownSync(CommitSha)(sha)
const contributionFrom = "2025-01-02"
const contributionTo = "2026-01-01"
const contributionDays = Array.from({ length: 365 }, (_, index) => ({
  date: new Date(Date.parse(`${contributionFrom}T00:00:00Z`) + index * 86_400_000)
    .toISOString()
    .slice(0, 10),
  contributionCount: index === 364 ? 1 : 0,
}))
const contributionWeeks = Array.from({ length: 53 }, (_, index) => ({
  contributionDays: contributionDays.slice(index * 7, index * 7 + 7),
})).filter((week) => week.contributionDays.length > 0)

const responseFor = (pathname: string): { readonly status: number; readonly body: unknown } => {
  if (pathname === "/users/MixedUser") {
    return {
      status: 200,
      body: {
        login: "MixedUser",
        html_url: "https://github.com/MixedUser",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
      },
    }
  }
  if (pathname === "/search/commits") {
    return {
      status: 200,
      body: {
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            sha,
            html_url: `https://github.com/owner/repo/commit/${sha}`,
            repository: {
              full_name: "owner/repo",
              html_url: "https://github.com/owner/repo",
            },
            author: { login: "MixedUser" },
          },
        ],
      },
    }
  }
  if (pathname === "/graphql") {
    return {
      status: 200,
      body: {
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: { weeks: contributionWeeks },
            },
          },
        },
      },
    }
  }
  if (pathname.endsWith("/languages")) {
    return { status: 200, body: { TypeScript: 100, JavaScript: 50 } }
  }
  return {
    status: 200,
    body: {
      sha,
      html_url: `https://github.com/owner/repo/commit/${sha}`,
      repository: {
        full_name: "owner/repo",
        html_url: "https://github.com/owner/repo",
      },
      commit: {
        message: "Implement latest\n\nWith details",
        author: { date: "2026-01-02T03:04:05Z" },
        committer: { date: "2026-01-02T03:05:06Z" },
      },
      stats: { additions: 3, deletions: 1 },
      parents: [{ sha, html_url: `https://github.com/owner/repo/commit/${sha}` }],
    },
  }
}

const fakeClient = HttpClient.make((request, url) => {
  const fixture = responseFor(url.pathname)
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(fixture.body), {
        status: fixture.status,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4999",
        },
      }),
    ),
  )
})

const configuration = {
  githubToken: Redacted.make("kronik-test-github-token"),
  cursorSecret: Option.none<Redacted.Redacted>(),
  docsUrl: new URL("http://localhost:3001"),
  githubBaseUrl: new URL("https://api.github.test"),
  githubUserAgent: "kronik-test",
}

describe("GitHub adapter", () => {
  test("hydrates a stable commit page with the requested search position", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHub.Service
        const snapshot = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-02T04:00:00Z")
        return yield* github.commits({
          username,
          snapshot,
          pageSize: 10,
          position: 1,
        })
      }).pipe(
        Effect.provide(
          GitHub.layerWithClient(fakeClient).pipe(
            Layer.provide(Layer.succeed(Configuration, configuration)),
          ),
        ),
      ),
    )

    expect(result.items).toHaveLength(1)
    expect(String(result.user.login)).toBe("MixedUser")
  })

  test("accepts the final searchable position for a one-item page", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHub.Service
        const snapshot = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-02T04:00:00Z")
        return yield* github.commits({
          username,
          snapshot,
          pageSize: 1,
          position: 1_000,
        })
      }).pipe(
        Effect.provide(
          GitHub.layerWithClient(fakeClient).pipe(
            Layer.provide(Layer.succeed(Configuration, configuration)),
          ),
        ),
      ),
    )

    expect(result.items).toHaveLength(1)
  })

  test("aggregates bounded commits and repository languages", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHub.Service
        return yield* github.activity({
          username,
          from: Schema.decodeUnknownSync(IsoDate)("2026-01-01"),
          to: Schema.decodeUnknownSync(IsoDate)("2026-01-30"),
        })
      }).pipe(
        Effect.provide(
          GitHub.layerWithClient(fakeClient).pipe(
            Layer.provide(Layer.succeed(Configuration, configuration)),
          ),
        ),
      ),
    )

    expect(result.matchedCommits).toBe(1)
    expect(result.incompleteResults).toBe(false)
    expect(result.repositories).toEqual([
      {
        nameWithOwner: "owner/repo",
        languages: [
          { name: "TypeScript", bytes: 100 },
          { name: "JavaScript", bytes: 50 },
        ],
      },
    ])
  })

  test("reads a bounded contribution calendar through GraphQL", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHub.Service
        return yield* github.streak({
          username,
          from: Schema.decodeUnknownSync(IsoDate)(contributionFrom),
          to: Schema.decodeUnknownSync(IsoDate)(contributionTo),
        })
      }).pipe(
        Effect.provide(
          GitHub.layerWithClient(fakeClient).pipe(
            Layer.provide(Layer.succeed(Configuration, configuration)),
          ),
        ),
      ),
    )

    expect(result.days).toHaveLength(365)
    expect(result.days.at(-1)?.contributionCount).toBe(1)
  })

  test("emits safe GitHub operation and rate evidence", async () => {
    const events: Array<Observability.Event> = []
    const observability: Observability.Sink = {
      record: (event) => {
        events.push(event)
      },
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHub.Service
        return yield* github.latestCommit(username)
      }).pipe(
        Effect.provide(
          GitHub.layerWithClient(fakeClient, observability).pipe(
            Layer.provide(Layer.succeed(Configuration, configuration)),
          ),
        ),
      ),
    )

    expect(events.map((event) => event.kind)).toEqual([
      "github.request",
      "github.request",
      "github.request",
    ])
    expect(events[0]).toMatchObject({
      kind: "github.request",
      operation: "GitHub.resolveUser",
      outcome: "success",
      status: 200,
      rateRemaining: 4999,
    })
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("kronik-test-github-token")
    expect(serialized).not.toContain(sha)
    expect(serialized).not.toContain("MixedUser")
  })

  test("resolves canonical identity and hydrates exact parents", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHub.Service
        return yield* github.latestCommit(username)
      }).pipe(
        Effect.provide(
          GitHub.layerWithClient(fakeClient).pipe(
            Layer.provide(Layer.succeed(Configuration, configuration)),
          ),
        ),
      ),
    )

    expect(String(result.user.login)).toBe("MixedUser")
    expect(String(result.commit.committedAt)).toBe("2026-01-02T03:05:06Z")
    expect(result.commit.parents).toEqual([
      { sha: commitSha, url: `https://github.com/owner/repo/commit/${sha}` },
    ])
    expect(result.commit.changedLines).toBe(4)
  })
})
