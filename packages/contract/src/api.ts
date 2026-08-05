export * as KronikApi from "./api.js"

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { HttpDomainErrors } from "./errors.js"
import {
  ActivitySummary,
  CommitPage,
  ContributionStreak,
  Cursor,
  GitHubUsername,
  Health,
  IsoDate,
  LatestCommit,
} from "./model.js"

const UserPath = Schema.Struct({ username: GitHubUsername })
const CommitLimit = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
)

const CommitFeedCodeSamples = [
  {
    id: "initial",
    lang: "bash",
    label: "Initial request",
    source: "curl 'https://api.example.com/v1/users/octocat/commits?limit=25'",
  },
  {
    id: "continuation",
    lang: "bash",
    label: "Continuation request",
    source:
      "curl 'https://api.example.com/v1/users/octocat/commits?cursor=CURSOR_FROM_PREVIOUS_RESPONSE'",
  },
] as const

/** The first commit-feed request may choose a page size and has no cursor. */
export const InitialCommitQuery = Schema.Struct({
  limit: Schema.optionalKey(CommitLimit),
}).annotate({ identifier: "InitialCommitQuery" })

/** A continuation request is identified only by its opaque cursor. */
export const ContinuationCommitQuery = Schema.Struct({
  cursor: Cursor,
}).annotate({ identifier: "ContinuationCommitQuery" })

/** Raw commit-feed query fields before the cross-field mode check. */
export const CommitQueryInput = Schema.Struct({
  limit: Schema.optionalKey(CommitLimit),
  cursor: Schema.optionalKey(Cursor),
}).annotate({ identifier: "CommitQueryInput" })

/** Commit-feed query modes, with cursor and limit deliberately mutually exclusive. */
export const CommitQuery = CommitQueryInput.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: { readonly limit?: number; readonly cursor?: string }) =>
        value.limit === undefined || value.cursor === undefined,
    ),
  ),
).annotate({ identifier: "CommitQuery" })
/** Optional inclusive Activity Window bounds. Both bounds are required together. */
export const ActivityQuery = Schema.Struct({
  from: Schema.optionalKey(IsoDate),
  to: Schema.optionalKey(IsoDate),
}).annotate({ identifier: "ActivityQuery" })

/** Public operational endpoints that do not depend on GitHub. */
export const HealthGroup = HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("get", "/health", { success: Health }).annotateMerge(
      OpenApi.annotations({
        identifier: "health.get",
        summary: "Check Kronik health",
        description: "Report Worker liveness without probing GitHub.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "Health" }))

/** Latest commit endpoint shared by the full and slice-specific runtime APIs. */
export const LatestCommitEndpoint = HttpApiEndpoint.get(
  "latestCommit",
  "/v1/users/:username/commits/latest",
  {
    params: UserPath,
    success: LatestCommit,
    error: HttpDomainErrors,
  },
).annotateMerge(
  OpenApi.annotations({
    identifier: "v1.activity.latestCommit",
    summary: "Get the latest public commit",
    description: "Return the most recently committed matching public default-branch commit.",
  }),
)

/** Latest-commit runtime API used before the remaining activity routes are assembled. */
export const LatestActivityGroup = HttpApiGroup.make("latestActivity")
  .add(LatestCommitEndpoint)
  .annotateMerge(OpenApi.annotations({ title: "Latest Activity" }))

/** Health and latest-commit API used by the slice 2 Worker composition. */
export const LatestApi = HttpApi.make("kronik-latest")
  .add(HealthGroup)
  .add(LatestActivityGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Kronik API",
      version: "1.0.0",
      description: "Portfolio-friendly summaries of a GitHub user's public development activity.",
    }),
  )

/** Health-only API used by the running walking skeleton. */
export const HealthApi = HttpApi.make("kronik-health")
  .add(HealthGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Kronik API",
      version: "1.0.0",
      description: "Portfolio-friendly summaries of a GitHub user's public development activity.",
    }),
  )

/** Public paginated commit-feed endpoint. */
export const CommitsEndpoint = HttpApiEndpoint.get("commits", "/v1/users/:username/commits", {
  params: UserPath,
  query: CommitQueryInput,
  success: CommitPage,
  error: HttpDomainErrors,
}).annotateMerge(
  OpenApi.annotations({
    identifier: "v1.activity.commits",
    summary: "List public commits",
    description:
      "List default-branch commits whose primary author GitHub resolves to the requested user. Initial requests default to ten items; continuation requests use only an opaque cursor.",
    override: { "x-codeSamples": CommitFeedCodeSamples },
  }),
)

/** Health and commit-feed API used by the slice 3 Worker composition. */
export const CommitsActivityGroup = HttpApiGroup.make("commitsActivity")
  .add(CommitsEndpoint)
  .add(LatestCommitEndpoint)
  .annotateMerge(OpenApi.annotations({ title: "Commit Activity" }))

/** Public Activity Summary endpoint. */
export const SummaryEndpoint = HttpApiEndpoint.get("summary", "/v1/users/:username/activity", {
  params: UserPath,
  query: ActivityQuery,
  success: ActivitySummary,
  error: HttpDomainErrors,
}).annotateMerge(
  OpenApi.annotations({
    identifier: "v1.activity.summary",
    summary: "Summarize public activity",
    description:
      "Aggregate at most 100 matching commits and repository language bytes over an inclusive activity window. The default is UTC today and the previous 29 dates.",
  }),
)

/** Public Contribution Streak endpoint. */
export const StreakEndpoint = HttpApiEndpoint.get("streak", "/v1/users/:username/streak", {
  params: UserPath,
  success: ContributionStreak,
  error: HttpDomainErrors,
}).annotateMerge(
  OpenApi.annotations({
    identifier: "v1.activity.streak",
    summary: "Get contribution streaks",
    description:
      "Evaluate current and longest streaks over GitHub's trailing 365-day contribution calendar.",
  }),
)

/** Health and completed activity capabilities used by the slice 4 runtime. */
export const SummaryActivityGroup = HttpApiGroup.make("summaryActivity")
  .add(CommitsEndpoint)
  .add(LatestCommitEndpoint)
  .add(SummaryEndpoint)
  .annotateMerge(OpenApi.annotations({ title: "Activity Summary" }))

/** Health and completed streak capabilities used by the slice 5 runtime. */
export const StreakActivityGroup = HttpApiGroup.make("streakActivity")
  .add(CommitsEndpoint)
  .add(LatestCommitEndpoint)
  .add(SummaryEndpoint)
  .add(StreakEndpoint)
  .annotateMerge(OpenApi.annotations({ title: "Contribution Streak" }))

/** Slice 4 runtime API; streak remains a later capability. */
export const SummaryApi = HttpApi.make("kronik-summary")
  .add(HealthGroup)
  .add(SummaryActivityGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Kronik API",
      version: "1.0.0",
      description: "Portfolio-friendly summaries of a GitHub user's public development activity.",
    }),
  )

/** Slice 5 runtime API with the contribution-streak capability. */
export const StreakApi = HttpApi.make("kronik-streak")
  .add(HealthGroup)
  .add(StreakActivityGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Kronik API",
      version: "1.0.0",
      description: "Portfolio-friendly summaries of a GitHub user's public development activity.",
    }),
  )

/** The complete declared v1 activity contract. */
export const ActivityGroup = HttpApiGroup.make("activity")
  .add(CommitsEndpoint)
  .add(LatestCommitEndpoint)
  .add(SummaryEndpoint)
  .add(StreakEndpoint)
  .annotateMerge(OpenApi.annotations({ title: "Activity" }))

/** Health and paginated commit-feed API used by slice 3 tests. */
export const CommitsApi = HttpApi.make("kronik-commits")
  .add(HealthGroup)
  .add(CommitsActivityGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Kronik API",
      version: "1.0.0",
      description: "Portfolio-friendly summaries of a GitHub user's public development activity.",
    }),
  )

/** The authoritative schema-first Kronik HTTP interface. */
export const Api = HttpApi.make("kronik")
  .add(HealthGroup)
  .add(ActivityGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Kronik API",
      version: "1.0.0",
      description: "Portfolio-friendly summaries of a GitHub user's public development activity.",
    }),
  )
