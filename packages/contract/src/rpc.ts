export * as ActivityRpc from "./rpc.js"

import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { DomainErrors } from "./errors.js"
import {
  ActivitySummary,
  CommitPage,
  ContributionStreak,
  Cursor,
  GitHubUsername,
  IsoDate,
  LatestCommit,
} from "./model.js"

const CacheState = Schema.Literals(["fresh", "stale"])

export const CachedLatestCommit = Schema.Struct({
  value: LatestCommit,
  cacheState: CacheState,
})
export const CachedCommitPage = Schema.Struct({
  value: CommitPage,
  cacheState: CacheState,
})
export const CachedActivitySummary = Schema.Struct({
  value: ActivitySummary,
  cacheState: CacheState,
})
export const CachedContributionStreak = Schema.Struct({
  value: ContributionStreak,
  cacheState: CacheState,
})

const latestCommit = Rpc.make("latestCommit", {
  payload: { username: GitHubUsername },
  success: CachedLatestCommit,
  error: DomainErrors,
})

/** The slice 2 RPC group. No unfinished procedures cross the runtime boundary. */
export class LatestCommitRpcs extends RpcGroup.make(latestCommit) {}

const CommitLimit = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
)

const CommitPayload = Schema.Struct({
  username: GitHubUsername,
  limit: Schema.optionalKey(CommitLimit),
  cursor: Schema.optionalKey(Cursor),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (value: { readonly limit?: number; readonly cursor?: string }) =>
        value.limit === undefined || value.cursor === undefined,
    ),
  ),
)

const commits = Rpc.make("commits", {
  payload: CommitPayload,
  success: CachedCommitPage,
  error: DomainErrors,
})
const summary = Rpc.make("summary", {
  payload: {
    username: GitHubUsername,
    from: Schema.optionalKey(IsoDate),
    to: Schema.optionalKey(IsoDate),
  },
  success: CachedActivitySummary,
  error: DomainErrors,
})
/** The validated payload for a contribution-streak lookup. */
export const StreakPayload = Schema.Struct({ username: GitHubUsername })

const streak = Rpc.make("streak", {
  payload: StreakPayload,
  success: CachedContributionStreak,
  error: DomainErrors,
})

/** The validated commit procedures exercised by the slice 3 runtime. */
export class CommitRpcs extends RpcGroup.make(commits, latestCommit) {}

/** The validated activity-summary procedures exercised by slice 4. */
export class SummaryRpcs extends RpcGroup.make(commits, latestCommit, summary) {}

/** The validated activity procedures exercised by the slice 5 runtime. */
export class StreakRpcs extends RpcGroup.make(commits, latestCommit, summary, streak) {}

/** Full Worker-to-Durable-Object activity procedure declarations. */
export class Rpcs extends RpcGroup.make(commits, latestCommit, summary, streak) {}
