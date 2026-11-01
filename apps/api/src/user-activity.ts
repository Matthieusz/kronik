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

/** An activity result with its coordinator cache provenance preserved. */
export interface LookupResult<A> {
  readonly value: A
  readonly cacheState: CacheState
}

/** The complete Requested User activity interface, including cache provenance. */
export interface CacheAwareInterface {
  /** Resolve the most recently committed matching public commit. */
  readonly latestCommit: (
    username: GitHubUsername,
  ) => Effect.Effect<LookupResult<LatestCommit>, ApiError.DomainErrors>
  /** List matching commits using the v1 cursor contract. */
  readonly commits: (input: {
    readonly username: GitHubUsername
    readonly limit?: number
    readonly cursor?: Cursor
  }) => Effect.Effect<LookupResult<CommitPage>, ApiError.DomainErrors>
  /** Summarize bounded activity over an inclusive Activity Window. */
  readonly summarize: (input: {
    readonly username: GitHubUsername
    readonly from?: IsoDate
    readonly to?: IsoDate
  }) => Effect.Effect<LookupResult<ActivitySummary>, ApiError.DomainErrors>
  /** Calculate the bounded Contribution Streak. */
  readonly streak: (
    username: GitHubUsername,
  ) => Effect.Effect<LookupResult<ContributionStreak>, ApiError.DomainErrors>
}

/** Effect tag for the complete activity interface used by production and tests. */
export class CacheAwareService extends Context.Service<CacheAwareService, CacheAwareInterface>()(
  "@kronik/api/UserActivity.CacheAwareService",
) {}
