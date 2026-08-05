export * as GitHub from "./github.js"

import { ApiError } from "@kronik/contract/errors"
import {
  CommitParent,
  CommitSha,
  GitHubUsername,
  IsoDate,
  IsoTimestamp,
  LatestCommit,
  Repository,
  User,
} from "@kronik/contract/model"
import { Clock, Context, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect"
import { HttpClient, TracerDisabledWhen, mapRequest } from "effect/unstable/http/HttpClient"
import { bodyJsonUnsafe, empty, prependUrl } from "effect/unstable/http/HttpClientRequest"
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse"
import { ActivityDomain } from "./activity-domain.js"
import { CommitDomain } from "./commit-domain.js"
import { Configuration } from "./config.js"
import { Observability } from "./observability.js"
import { StreakDomain } from "./streak-domain.js"

const GitHubUserResponse = Schema.Struct({
  login: Schema.String,
  html_url: Schema.String,
  avatar_url: Schema.String,
})
const SearchRepositoryResponse = Schema.Struct({
  full_name: Schema.String,
  html_url: Schema.String,
})
const SearchPersonResponse = Schema.Struct({ login: Schema.String })
const SearchCommitResponse = Schema.Struct({
  sha: Schema.String,
  html_url: Schema.String,
  repository: SearchRepositoryResponse,
  author: Schema.NullOr(SearchPersonResponse),
})
const SearchResponse = Schema.Struct({
  total_count: Schema.optionalKey(Schema.Number),
  incomplete_results: Schema.optionalKey(Schema.Boolean),
  items: Schema.Array(SearchCommitResponse),
})
const CommitIdentityResponse = Schema.Struct({ date: Schema.String })
const CommitDetailsResponse = Schema.Struct({
  sha: Schema.String,
  html_url: Schema.String,
  repository: SearchRepositoryResponse,
  commit: Schema.Struct({
    message: Schema.String,
    author: CommitIdentityResponse,
    committer: CommitIdentityResponse,
  }),
  stats: Schema.Struct({
    additions: Schema.Number,
    deletions: Schema.Number,
  }),
  parents: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      html_url: Schema.String,
    }),
  ),
})
const LanguageBytes = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
)
const RateHeaders = Schema.Struct({
  "x-ratelimit-remaining": Schema.optionalKey(Schema.String),
  "retry-after": Schema.optionalKey(Schema.String),
})
const LanguageResponse = Schema.Record(Schema.String, LanguageBytes)
const ContributionDayResponse = Schema.Struct({
  date: Schema.String,
  contributionCount: Schema.Number,
})
const ContributionCalendarResponse = Schema.Struct({
  weeks: Schema.Array(Schema.Struct({ contributionDays: Schema.Array(ContributionDayResponse) })),
})
const ContributionGraphqlResponse = Schema.Struct({
  data: Schema.Struct({
    user: Schema.NullOr(
      Schema.Struct({
        contributionsCollection: Schema.Struct({
          contributionCalendar: ContributionCalendarResponse,
        }),
      }),
    ),
  }),
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.String }))),
})
const ContributionCount = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
)
/** Keep independent repository-language requests bounded for the shared GitHub budget. */
const LanguageConcurrency = 4

type SearchResponse = typeof SearchResponse.Type
type CommitDetailsResponse = typeof CommitDetailsResponse.Type

/** The semantic page request passed from the coordinator to the GitHub adapter. */
export interface CommitPageInput {
  readonly username: GitHubUsername
  readonly snapshot: IsoTimestamp
  readonly pageSize: number
  readonly position: number
}

/** Decoded GitHub evidence for one commit page. */
export interface CommitPageEvidence {
  readonly user: User
  readonly items: ReadonlyArray<CommitDomain.Evidence>
  readonly totalCount: number
  readonly incompleteResults: boolean
}

/** The bounded activity search request passed to GitHub. */
export interface ActivityInput {
  readonly username: GitHubUsername
  readonly from: IsoDate
  readonly to: IsoDate
}

/** Decoded GitHub evidence for an Activity Summary. */
export interface ActivityEvidence extends ActivityDomain.Evidence {}

/** The bounded contribution-calendar request passed from the coordinator. */
export interface StreakInput {
  readonly username: GitHubUsername
  readonly from: IsoDate
  readonly to: IsoDate
}

/** Decoded GitHub evidence for a contribution streak. */
export interface StreakEvidence {
  readonly user: User
  readonly days: ReadonlyArray<StreakDomain.CalendarDay>
}

class ProviderFailure extends Schema.TaggedErrorClass<ProviderFailure>()("GitHub.ProviderFailure", {
  operation: Schema.String,
  kind: Schema.Literals(["transport", "timeout", "malformed", "status", "rate"]),
  status: Schema.optionalKey(Schema.Number),
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Narrow adapter interface used by UserActivity and Durable Object tests. */
export interface Interface {
  /** Resolve and hydrate the latest matching public commit. */
  readonly latestCommit: (
    username: GitHubUsername,
  ) => Effect.Effect<LatestCommit, ApiError.DomainErrors>
  /** Search and hydrate one stable page of matching public commits. */
  readonly commits: (
    input: CommitPageInput,
  ) => Effect.Effect<CommitPageEvidence, ApiError.DomainErrors>
  /** Search and hydrate at most 100 matching commits and their repository languages. */
  readonly activity: (
    input: ActivityInput,
  ) => Effect.Effect<ActivityEvidence, ApiError.DomainErrors>
  /** Read the requested user's bounded contribution calendar. */
  readonly streak: (input: StreakInput) => Effect.Effect<StreakEvidence, ApiError.DomainErrors>
}

/** Effect service for GitHub's official HTTP API. */
export class Service extends Context.Service<Service, Interface>()("@kronik/api/GitHub") {}

const decodeResponse =
  <S extends Schema.Constraint & { readonly DecodingServices: never }>(schema: S) =>
  (response: HttpClientResponse, operation: string) =>
    Effect.gen(function* () {
      const body = yield* response.json.pipe(
        Effect.mapError((cause) => new ProviderFailure({ operation, kind: "malformed", cause })),
      )
      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError((cause) => new ProviderFailure({ operation, kind: "malformed", cause })),
      )
    })

const AuthorizationFailureDetail = "Kronik's GitHub credential was rejected"

const classifyProviderFailure = (failure: ProviderFailure): ApiError.DomainErrors => {
  const instance = "urn:kronik:github"
  const common = {
    type: "https://kronik.dev/problems/upstream-failure",
    title: "GitHub unavailable",
    instance,
  }
  if (failure.kind === "status" && (failure.status === 401 || failure.status === 403)) {
    return new ApiError.UpstreamFailure({
      ...common,
      detail: AuthorizationFailureDetail,
      status: 502,
    })
  }
  if (failure.kind === "rate") {
    return new ApiError.RateLimited({
      ...common,
      detail: "GitHub rate limit reached",
      status: 429,
      retryAfterSeconds: failure.retryAfterSeconds ?? 60,
      type: "https://kronik.dev/problems/rate-limited",
      title: "Upstream rate limit reached",
    })
  }
  if (failure.kind === "timeout") {
    return new ApiError.ServiceUnavailable({
      ...common,
      detail: "GitHub did not respond within the upstream timeout",
      status: 503,
      type: "https://kronik.dev/problems/service-unavailable",
      title: "Service unavailable",
    })
  }
  return new ApiError.UpstreamFailure({
    ...common,
    detail: "GitHub returned an unusable response",
    status: 502,
  })
}

const invalidUpstream = (detail: string) =>
  new ApiError.UpstreamFailure({
    type: "https://kronik.dev/problems/upstream-failure",
    title: "Malformed GitHub response",
    detail,
    instance: "urn:kronik:github",
    status: 502,
  })

const retrySchedule = Schedule.recurs(1)
const silentObservability: Observability.Sink = { record: () => undefined }

const safeHeaderInteger = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

const observe = (sink: Observability.Sink, event: Observability.GitHubRequestEvent) =>
  Effect.promise(() => Observability.recordSafely(sink, event))

const makeClient = Effect.fn("GitHub.makeClient")(function* (observability: Observability.Sink) {
  const rawClient = yield* HttpClient
  const configuration = yield* Configuration
  const client = mapRequest(rawClient, prependUrl(configuration.githubBaseUrl.toString()))
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": configuration.githubUserAgent,
    Authorization: `Bearer ${Redacted.value(configuration.githubToken)}`,
  }
  const request = Effect.fn("GitHub.request")(function* (
    operation: Observability.GitHubOperation,
    path: string,
    body?: unknown,
  ) {
    const clock = yield* Clock.Clock
    const startedAt = yield* clock.currentTimeMillis
    const attempt = Effect.gen(function* () {
      const responseEffect =
        body === undefined
          ? client.get(path, { headers })
          : client.post(path, {
              headers,
              body: bodyJsonUnsafe(empty, body).body,
            })
      const response = yield* responseEffect.pipe(
        Effect.timeout("5 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(new ProviderFailure({ operation, kind: "timeout" })),
        ),
        Effect.mapError((cause) =>
          cause instanceof ProviderFailure
            ? cause
            : new ProviderFailure({ operation, kind: "transport", cause }),
        ),
      )
      yield* Effect.annotateCurrentSpan("github.status", response.status)

      const rateHeaders = yield* Schema.decodeUnknownEffect(RateHeaders)(response.headers).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderFailure({
              operation,
              kind: "malformed",
              status: response.status,
              cause,
            }),
        ),
      )
      const remainingValue = rateHeaders["x-ratelimit-remaining"]
      const rateRemaining = safeHeaderInteger(remainingValue)
      const retryAfterValue = rateHeaders["retry-after"]
      const retryAfterSeconds =
        retryAfterValue === undefined ? 60 : Number.parseInt(retryAfterValue, 10)
      const rateLimited =
        response.status === 429 || (response.status === 403 && remainingValue === "0")
      if (rateLimited) {
        return yield* Effect.fail(
          new ProviderFailure({
            operation,
            kind: "rate",
            status: response.status,
            retryAfterSeconds:
              Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0
                ? retryAfterSeconds
                : 60,
          }),
        )
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          new ProviderFailure({ operation, kind: "status", status: response.status }),
        )
      }
      return { response, rateRemaining }
    }).pipe(
      Effect.provideService(TracerDisabledWhen, () => true),
      Effect.withSpan("github.request", { attributes: { "github.operation": operation } }),
    )

    return yield* attempt.pipe(
      Effect.tap(({ rateRemaining, response }) =>
        Effect.gen(function* () {
          const finishedAt = yield* clock.currentTimeMillis
          yield* observe(observability, {
            kind: "github.request",
            operation,
            outcome: "success",
            latencyMs: Math.max(0, finishedAt - startedAt),
            status: response.status,
            ...(rateRemaining === undefined ? {} : { rateRemaining }),
          })
        }),
      ),
      Effect.tapError((failure) =>
        Effect.gen(function* () {
          const finishedAt = yield* clock.currentTimeMillis
          yield* observe(observability, {
            kind: "github.request",
            operation,
            outcome: failure.kind,
            latencyMs: Math.max(0, finishedAt - startedAt),
            ...(failure.status === undefined ? {} : { status: failure.status }),
            ...(failure.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: failure.retryAfterSeconds }),
          })
        }),
      ),
      Effect.map(({ response }) => response),
    )
  })

  const requestJson = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
    operation: Observability.GitHubOperation,
    path: string,
    schema: S,
    body?: unknown,
  ) =>
    request(operation, path, body).pipe(
      Effect.retry({
        schedule: retrySchedule,
        while: (failure) =>
          failure instanceof ProviderFailure &&
          (failure.kind === "transport" ||
            failure.kind === "timeout" ||
            (failure.kind === "status" &&
              (failure.status === 502 || failure.status === 503 || failure.status === 504))),
      }),
      Effect.flatMap((response) => decodeResponse(schema)(response, operation)),
    )

  const resolveUser = Effect.fn("GitHub.resolveUser")(function* (username: GitHubUsername) {
    const response = yield* requestJson(
      "GitHub.resolveUser",
      `/users/${encodeURIComponent(username)}`,
      GitHubUserResponse,
    ).pipe(
      Effect.mapError((failure) =>
        failure instanceof ProviderFailure && failure.status === 404
          ? new ApiError.UserNotFound({
              type: "https://kronik.dev/problems/user-not-found",
              title: "User not found",
              detail: "GitHub does not resolve the requested user",
              instance: "urn:kronik:github:user",
              status: 404,
            })
          : failure instanceof ProviderFailure
            ? classifyProviderFailure(failure)
            : failure,
      ),
    )
    return yield* Schema.decodeUnknownEffect(User)({
      login: response.login,
      url: response.html_url,
      avatarUrl: response.avatar_url,
    }).pipe(
      Effect.mapError(
        () =>
          new ApiError.UpstreamFailure({
            type: "https://kronik.dev/problems/upstream-failure",
            title: "GitHub returned malformed user data",
            detail: "GitHub returned a user that Kronik cannot represent",
            instance: "urn:kronik:github:user",
            status: 502,
          }),
      ),
    )
  })

  const searchCommits = Effect.fn("GitHub.searchCommits")(function* (
    user: User,
    pageSize: number,
    position: number,
    snapshot?: string,
    window?: { readonly from: IsoDate; readonly to: IsoDate },
  ) {
    const qualifiers = [`author:${user.login}`]
    if (window !== undefined) {
      qualifiers.push(`committer-date:>=${window.from}`)
      qualifiers.push(`committer-date:<=${window.to}`)
    } else if (snapshot !== undefined) qualifiers.push(`committer-date:<=${snapshot}`)
    const query = encodeURIComponent(qualifiers.join(" "))
    return yield* requestJson(
      "GitHub.searchCommits",
      `/search/commits?q=${query}&sort=committer-date&order=desc&per_page=${pageSize}&page=${position}`,
      SearchResponse,
    ).pipe(
      Effect.mapError((failure) =>
        failure instanceof ProviderFailure ? classifyProviderFailure(failure) : failure,
      ),
    )
  })

  const hydrateCommit = Effect.fn("GitHub.hydrateCommit")(function* (
    item: SearchResponse["items"][number],
  ) {
    const parts = item.repository.full_name.split("/")
    const owner = parts[0]
    const name = parts[1]
    if (
      parts.length !== 2 ||
      owner === undefined ||
      name === undefined ||
      owner.length === 0 ||
      name.length === 0
    ) {
      return yield* Effect.fail(invalidUpstream("GitHub returned an unrepresentable repository"))
    }
    const sha = yield* Schema.decodeUnknownEffect(CommitSha)(item.sha).pipe(
      Effect.mapError(() => invalidUpstream("GitHub returned an unrepresentable commit SHA")),
    )
    const details = yield* requestJson(
      "GitHub.hydrateCommit",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(sha)}`,
      CommitDetailsResponse,
    ).pipe(
      Effect.mapError((failure) =>
        failure instanceof ProviderFailure ? classifyProviderFailure(failure) : failure,
      ),
    )
    return { sha, details }
  })

  const toEvidence = Effect.fn("GitHub.toEvidence")(function* (
    user: User,
    hydrated: {
      readonly sha: CommitDomain.Evidence["sha"]
      readonly details: CommitDetailsResponse
    },
  ) {
    const details = hydrated.details
    const repository = yield* Schema.decodeUnknownEffect(Repository)({
      nameWithOwner: details.repository.full_name,
      url: details.repository.html_url,
    }).pipe(Effect.mapError(() => invalidUpstream("GitHub returned an unrepresentable repository")))
    const parents = yield* Effect.forEach(details.parents, (parent) =>
      Schema.decodeUnknownEffect(CommitParent)({ sha: parent.sha, url: parent.html_url }).pipe(
        Effect.mapError(() => invalidUpstream("GitHub returned an unrepresentable parent")),
      ),
    )
    const authoredAt = yield* Schema.decodeUnknownEffect(IsoTimestamp)(
      details.commit.author.date,
    ).pipe(Effect.mapError(() => invalidUpstream("GitHub returned an invalid author timestamp")))
    const committedAt = yield* Schema.decodeUnknownEffect(IsoTimestamp)(
      details.commit.committer.date,
    ).pipe(Effect.mapError(() => invalidUpstream("GitHub returned an invalid committer timestamp")))
    const commitUrl = yield* Schema.decodeUnknownEffect(Repository.fields.url)(
      details.html_url,
    ).pipe(Effect.mapError(() => invalidUpstream("GitHub returned an invalid commit URL")))
    return {
      user,
      sha: hydrated.sha,
      url: commitUrl,
      repository,
      message: details.commit.message,
      authoredAt,
      committedAt,
      additions: details.stats.additions,
      deletions: details.stats.deletions,
      parents,
    } satisfies CommitDomain.Evidence
  })

  const getLanguages = Effect.fn("GitHub.getLanguages")(function* (repository: Repository) {
    const parts = repository.nameWithOwner.split("/")
    const owner = parts[0]
    const name = parts[1]
    if (
      parts.length !== 2 ||
      owner === undefined ||
      name === undefined ||
      owner.length === 0 ||
      name.length === 0
    ) {
      return yield* Effect.fail(invalidUpstream("GitHub returned an unrepresentable repository"))
    }

    const response = yield* requestJson(
      "GitHub.getLanguages",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/languages`,
      LanguageResponse,
    ).pipe(
      Effect.catchIf(
        (failure) => failure instanceof ProviderFailure && failure.status === 404,
        () => Effect.succeed({}),
      ),
      Effect.mapError((failure) =>
        failure instanceof ProviderFailure ? classifyProviderFailure(failure) : failure,
      ),
    )
    return {
      nameWithOwner: repository.nameWithOwner,
      languages: Object.entries(response).map(([languageName, bytes]) => ({
        name: languageName,
        bytes,
      })),
    }
  })

  const contributionStreak = Effect.fn("GitHub.contributionStreak")(function* (input: StreakInput) {
    const user = yield* resolveUser(input.username)
    const query = `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays { date contributionCount }
            }
          }
        }
      }
    }`
    const response = yield* requestJson(
      "GitHub.contributionStreak",
      "/graphql",
      ContributionGraphqlResponse,
      {
        query,
        variables: {
          login: user.login,
          from: `${input.from}T00:00:00Z`,
          to: `${input.to}T23:59:59Z`,
        },
      },
    ).pipe(
      Effect.mapError((failure) =>
        failure instanceof ProviderFailure ? classifyProviderFailure(failure) : failure,
      ),
    )
    if (response.errors !== undefined && response.errors.length > 0)
      return yield* Effect.fail(invalidUpstream("GitHub returned GraphQL errors"))
    const graphUser = response.data.user
    if (graphUser === null)
      return yield* Effect.fail(
        new ApiError.UserNotFound({
          type: "https://kronik.dev/problems/user-not-found",
          title: "User not found",
          detail: "GitHub does not resolve the requested user",
          instance: "urn:kronik:github:user",
          status: 404,
        }),
      )
    const rawDays = graphUser.contributionsCollection.contributionCalendar.weeks.flatMap(
      (week) => week.contributionDays,
    )
    const days = yield* Effect.forEach(rawDays, (day) =>
      Effect.gen(function* () {
        const date = yield* Schema.decodeUnknownEffect(IsoDate)(day.date).pipe(
          Effect.mapError(() => invalidUpstream("GitHub returned an invalid contribution date")),
        )
        const contributionCount = yield* Schema.decodeUnknownEffect(ContributionCount)(
          day.contributionCount,
        ).pipe(
          Effect.mapError(() => invalidUpstream("GitHub returned an invalid contribution count")),
        )
        return { date, contributionCount }
      }),
    )
    if (!StreakDomain.isRepresentedRange(input.from, input.to, days))
      return yield* Effect.fail(
        invalidUpstream("GitHub returned an incomplete contribution calendar"),
      )
    return { user, days }
  })

  const latestCommit = Effect.fn("GitHub.latestCommit")(function* (username: GitHubUsername) {
    const user = yield* resolveUser(username)
    const search = yield* searchCommits(user, 10, 1)
    const item = search.items.find(
      (candidate) => candidate.author?.login.toLowerCase() === user.login.toLowerCase(),
    )
    if (item === undefined) {
      return yield* Effect.fail(
        new ApiError.LatestCommitNotFound({
          type: "https://kronik.dev/problems/latest-commit-not-found",
          title: "Latest commit not found",
          detail: "The requested user has no matching public default-branch commit",
          instance: "urn:kronik:github:latest",
          status: 404,
        }),
      )
    }
    const hydrated = yield* hydrateCommit(item)
    const evidence = yield* toEvidence(user, hydrated)
    const projected = CommitDomain.projectLatest(evidence)
    if (projected._tag === "Failure") {
      return yield* Effect.fail(
        new ApiError.UpstreamFailure({
          type: "https://kronik.dev/problems/upstream-failure",
          title: "GitHub returned unsafe change counts",
          detail: "GitHub returned numeric commit evidence Kronik cannot safely represent",
          instance: "urn:kronik:github:commit",
          status: 502,
        }),
      )
    }
    return projected.success
  })

  const activity = Effect.fn("GitHub.activity")(function* (input: ActivityInput) {
    const user = yield* resolveUser(input.username)
    const search = yield* searchCommits(user, 100, 1, undefined, {
      from: input.from,
      to: input.to,
    })
    const matchingItems = search.items
      .filter((candidate) => candidate.author?.login.toLowerCase() === user.login.toLowerCase())
      .slice(0, 100)
    const items = yield* Effect.forEach(matchingItems, (item) =>
      hydrateCommit(item).pipe(Effect.flatMap((hydrated) => toEvidence(user, hydrated))),
    )
    const repositories = new Map<string, Repository>()
    for (const item of items) repositories.set(item.repository.nameWithOwner, item.repository)
    const repositoryLanguages = yield* Effect.forEach(
      [...repositories.values()],
      (repository) => getLanguages(repository),
      { concurrency: LanguageConcurrency },
    )
    const totalCount = search.total_count ?? matchingItems.length
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      return yield* Effect.fail(invalidUpstream("GitHub returned an invalid activity total"))
    }
    return {
      user,
      items,
      matchedCommits: totalCount,
      incompleteResults: search.incomplete_results ?? false,
      repositories: repositoryLanguages,
    }
  })

  const commits = Effect.fn("GitHub.commits")(function* (input: CommitPageInput) {
    if (
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > 100 ||
      !Number.isSafeInteger(input.position) ||
      input.position < 1 ||
      input.position > 1_000
    ) {
      return yield* Effect.fail(invalidUpstream("Kronik produced an invalid search page"))
    }
    const user = yield* resolveUser(input.username)
    const search = yield* searchCommits(user, input.pageSize, input.position, input.snapshot)
    const matchingItems = search.items.filter(
      (candidate) => candidate.author?.login.toLowerCase() === user.login.toLowerCase(),
    )
    const items = yield* Effect.forEach(matchingItems, (item) =>
      hydrateCommit(item).pipe(Effect.flatMap((hydrated) => toEvidence(user, hydrated))),
    )
    const totalCount = search.total_count ?? search.items.length
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      return yield* Effect.fail(invalidUpstream("GitHub returned an invalid search total"))
    }
    const sortedItems = items.toSorted((left, right) => {
      const committedAt = String(right.committedAt).localeCompare(String(left.committedAt))
      return committedAt === 0 ? String(left.sha).localeCompare(String(right.sha)) : committedAt
    })
    return {
      user,
      items: sortedItems,
      totalCount,
      incompleteResults: search.incomplete_results ?? false,
    }
  })

  return Service.of({ latestCommit, commits, activity, streak: contributionStreak })
})

/** Live adapter layer. It keeps transport and credential policy inside the boundary. */
export const layer = Layer.effect(Service, makeClient(Observability.consoleSink))

/** Construct the adapter layer from an explicit HTTP client for deterministic tests. */
export const layerWithClient = (
  client: HttpClient,
  observability: Observability.Sink = silentObservability,
) =>
  Layer.effect(Service, makeClient(observability)).pipe(
    Layer.provide(Layer.succeed(HttpClient, client)),
  )

/** Construct configuration values for standalone adapter tests. */
export const testConfiguration = {
  githubToken: Redacted.make("kronik-test-github-token"),
  cursorSecret: Option.none<Redacted.Redacted>(),
  docsUrl: new URL("http://localhost:3001"),
  githubBaseUrl: new URL("https://api.github.test"),
  githubUserAgent: "kronik-test",
}
