export * as UserActivity from "./user-activity.js"

import { ApiError } from "@kronik/contract/errors"
import type {
  ActivitySummary,
  CommitPage,
  ContributionStreak,
  Cursor,
  GitHubUsername,
  IsoDate,
  LatestCommit,
} from "@kronik/contract/model"
import { Context, Effect } from "effect"

/** Cache provenance returned by the Durable Object coordinator. */
export type CacheState = "fresh" | "stale"

export interface LookupResult<A> {
  readonly value: A
  readonly cacheState: CacheState
}

/** The activity capability including coordinator cache provenance. */
export interface CacheAwareInterface {
  readonly latestCommit: (
    username: GitHubUsername,
  ) => Effect.Effect<LookupResult<LatestCommit>, ApiError.DomainErrors>
  readonly commits: (input: {
    readonly username: GitHubUsername
    readonly limit?: number
    readonly cursor?: Cursor
  }) => Effect.Effect<LookupResult<CommitPage>, ApiError.DomainErrors>
  readonly summarize: (input: {
    readonly username: GitHubUsername
    readonly from?: IsoDate
    readonly to?: IsoDate
  }) => Effect.Effect<LookupResult<ActivitySummary>, ApiError.DomainErrors>
  readonly streak: (
    username: GitHubUsername,
  ) => Effect.Effect<LookupResult<ContributionStreak>, ApiError.DomainErrors>
}

/** Service tag for activity results that retain cache provenance. */
export class CacheAwareService extends Context.Service<CacheAwareService, CacheAwareInterface>()(
  "@kronik/api/UserActivity.CacheAwareService",
) {}

/** The complete v1 application-service surface for requested-user activity. */
export interface Interface {
  /** Resolve the most recently committed matching public commit. */
  readonly latestCommit: (
    username: GitHubUsername,
  ) => Effect.Effect<LatestCommit, ApiError.DomainErrors>
  /** List matching commits using the v1 cursor contract. */
  readonly commits: (input: {
    readonly username: GitHubUsername
    readonly limit?: number
    readonly cursor?: Cursor
  }) => Effect.Effect<CommitPage, ApiError.DomainErrors>
  /** Summarize bounded activity over an inclusive window. */
  readonly summarize: (input: {
    readonly username: GitHubUsername
    readonly from?: IsoDate
    readonly to?: IsoDate
  }) => Effect.Effect<ActivitySummary, ApiError.DomainErrors>
  /** Calculate the bounded contribution streak. */
  readonly streak: (
    username: GitHubUsername,
  ) => Effect.Effect<ContributionStreak, ApiError.DomainErrors>
}

/** The latest-commit capability used by the slice 2 compatibility tests. */
export interface LatestInterface {
  /** Resolve the most recently committed matching public commit. */
  readonly latestCommit: (
    username: GitHubUsername,
  ) => Effect.Effect<LatestCommit, ApiError.DomainErrors>
}

/** The completed slice 4 capability exposed to the public activity routes. */
export interface SummaryInterface extends CommitsInterface {
  /** Summarize bounded activity over an inclusive window. */
  readonly summarize: (input: {
    readonly username: GitHubUsername
    readonly from?: IsoDate
    readonly to?: IsoDate
  }) => Effect.Effect<ActivitySummary, ApiError.DomainErrors>
}

/** The completed slice 5 capability exposed to the public activity routes. */
export interface StreakInterface extends SummaryInterface {
  /** Calculate the bounded contribution streak. */
  readonly streak: (
    username: GitHubUsername,
  ) => Effect.Effect<ContributionStreak, ApiError.DomainErrors>
}

/** The slice 3 capability exposed to the public activity routes. */
export interface CommitsInterface extends LatestInterface {
  /** List matching commits using the opaque cursor contract. */
  readonly commits: (input: {
    readonly username: GitHubUsername
    readonly limit?: number
    readonly cursor?: Cursor
  }) => Effect.Effect<CommitPage, ApiError.DomainErrors>
}

/** Service tag for the latest-commit application capability. */
export class LatestService extends Context.Service<LatestService, LatestInterface>()(
  "@kronik/api/UserActivity.LatestService",
) {}

/** Service tag for the latest and paginated commit capabilities. */
export class CommitsService extends Context.Service<CommitsService, CommitsInterface>()(
  "@kronik/api/UserActivity.CommitsService",
) {}

/** Service tag for the slice 4 summary capability. */
export class SummaryService extends Context.Service<SummaryService, SummaryInterface>()(
  "@kronik/api/UserActivity.SummaryService",
) {}

/** Service tag for the slice 5 contribution-streak capability. */
export class StreakService extends Context.Service<StreakService, StreakInterface>()(
  "@kronik/api/UserActivity.StreakService",
) {}

/** Service tag for the complete future application-service surface. */
export class Service extends Context.Service<Service, Interface>()("@kronik/api/UserActivity") {}
