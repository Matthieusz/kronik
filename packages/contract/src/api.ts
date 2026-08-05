export * as KronikApi from "./api.js"

import { OpenApi, HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { DomainErrors } from "./errors.js"
import {
  ActivitySummary,
  CommitPage,
  ContributionStreak,
  GitHubUsername,
  Health,
  LatestCommit,
} from "./model.js"

const UserPath = Schema.Struct({ username: GitHubUsername })
const CommitQuery = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.NumberFromString.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
  cursor: Schema.optionalKey(Schema.String),
})
const ActivityQuery = Schema.Struct({
  from: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
})

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

/** Public v1 GitHub activity endpoints. */
export const ActivityGroup = HttpApiGroup.make("activity")
  .add(
    HttpApiEndpoint.get("commits", "/v1/users/:username/commits", {
      params: UserPath,
      query: CommitQuery,
      success: CommitPage,
      error: DomainErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v1.activity.commits",
        summary: "List public commits",
        description:
          "List default-branch commits whose primary author GitHub resolves to the requested user.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("latestCommit", "/v1/users/:username/commits/latest", {
      params: UserPath,
      success: LatestCommit,
      error: DomainErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v1.activity.latestCommit",
        summary: "Get the latest public commit",
        description: "Return the most recently committed matching public default-branch commit.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("summary", "/v1/users/:username/activity", {
      params: UserPath,
      query: ActivityQuery,
      success: ActivitySummary,
      error: DomainErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v1.activity.summary",
        summary: "Summarize public activity",
        description:
          "Aggregate at most 100 matching commits and repository language bytes over an activity window.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("streak", "/v1/users/:username/streak", {
      params: UserPath,
      success: ContributionStreak,
      error: DomainErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v1.activity.streak",
        summary: "Get contribution streaks",
        description:
          "Evaluate current and longest streaks over GitHub's trailing 365-day contribution calendar.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "Activity" }))

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
