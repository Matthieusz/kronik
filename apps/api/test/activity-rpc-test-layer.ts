import { ApiError } from "@kronik/contract/errors"
import { CommitRpcs, LatestCommitRpcs, StreakRpcs, SummaryRpcs } from "@kronik/contract/rpc"
import { Effect, Layer } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { UserActivity } from "../src/user-activity.js"

/* oxlint-disable effecttsgo/strict-effect-provide */

const fresh = <A>(effect: Effect.Effect<A, ApiError.DomainErrors>) =>
  effect.pipe(Effect.map((value) => ({ value, cacheState: "fresh" as const })))

/** Build a schema-aware in-memory RPC client for latest-route tests. */
export const latestTestLayer = (service: UserActivity.LatestInterface) =>
  Layer.effect(
    UserActivity.LatestService,
    Effect.gen(function* () {
      const handlers = LatestCommitRpcs.toLayer({
        latestCommit: ({ username }) => fresh(service.latestCommit(username)),
      })
      const client = yield* RpcTest.makeClient(LatestCommitRpcs).pipe(Effect.provide(handlers))
      return UserActivity.LatestService.of({
        latestCommit: Effect.fn("UserActivity.latestCommit.testRpc")(function* (username) {
          return yield* client.latestCommit({ username }).pipe(Effect.map(({ value }) => value))
        }),
      })
    }),
  )

/** Build a schema-aware in-memory RPC client for activity-summary tests. */
export const summaryTestLayer = (service: UserActivity.SummaryInterface) =>
  Layer.effect(
    UserActivity.SummaryService,
    Effect.gen(function* () {
      const handlers = SummaryRpcs.toLayer({
        latestCommit: ({ username }) => fresh(service.latestCommit(username)),
        commits: (input) => fresh(service.commits(input)),
        summary: (input) => fresh(service.summarize(input)),
      })
      const client = yield* RpcTest.makeClient(SummaryRpcs).pipe(Effect.provide(handlers))
      return UserActivity.SummaryService.of({
        latestCommit: Effect.fn("UserActivity.latestCommit.testSummaryRpc")(function* (username) {
          return yield* client.latestCommit({ username }).pipe(Effect.map(({ value }) => value))
        }),
        commits: Effect.fn("UserActivity.commits.testSummaryRpc")(function* (input) {
          const payload =
            input.cursor !== undefined
              ? { username: input.username, cursor: input.cursor }
              : input.limit !== undefined
                ? { username: input.username, limit: input.limit }
                : { username: input.username }
          return yield* client.commits(payload).pipe(Effect.map(({ value }) => value))
        }),
        summarize: Effect.fn("UserActivity.summarize.testSummaryRpc")(function* (input) {
          const payload =
            input.from !== undefined && input.to !== undefined
              ? { username: input.username, from: input.from, to: input.to }
              : input.from !== undefined
                ? { username: input.username, from: input.from }
                : input.to !== undefined
                  ? { username: input.username, to: input.to }
                  : { username: input.username }
          return yield* client.summary(payload).pipe(Effect.map(({ value }) => value))
        }),
      })
    }),
  )

/** Build a schema-aware in-memory RPC client for contribution-streak tests. */
export const streakTestLayer = (service: UserActivity.StreakInterface) =>
  Layer.effect(
    UserActivity.StreakService,
    Effect.gen(function* () {
      const handlers = StreakRpcs.toLayer({
        latestCommit: ({ username }) => fresh(service.latestCommit(username)),
        commits: (input) => fresh(service.commits(input)),
        summary: (input) => fresh(service.summarize(input)),
        streak: ({ username }) => fresh(service.streak(username)),
      })
      const client = yield* RpcTest.makeClient(StreakRpcs).pipe(Effect.provide(handlers))
      return UserActivity.StreakService.of({
        latestCommit: Effect.fn("UserActivity.latestCommit.testStreakRpc")(function* (username) {
          return yield* client.latestCommit({ username }).pipe(Effect.map(({ value }) => value))
        }),
        commits: Effect.fn("UserActivity.commits.testStreakRpc")(function* (input) {
          const payload =
            input.cursor !== undefined
              ? { username: input.username, cursor: input.cursor }
              : input.limit !== undefined
                ? { username: input.username, limit: input.limit }
                : { username: input.username }
          return yield* client.commits(payload).pipe(Effect.map(({ value }) => value))
        }),
        summarize: Effect.fn("UserActivity.summarize.testStreakRpc")(function* (input) {
          const payload =
            input.from !== undefined && input.to !== undefined
              ? { username: input.username, from: input.from, to: input.to }
              : input.from !== undefined
                ? { username: input.username, from: input.from }
                : input.to !== undefined
                  ? { username: input.username, to: input.to }
                  : { username: input.username }
          return yield* client.summary(payload).pipe(Effect.map(({ value }) => value))
        }),
        streak: Effect.fn("UserActivity.streak.testRpc")(function* (username) {
          return yield* client.streak({ username }).pipe(Effect.map(({ value }) => value))
        }),
      })
    }),
  )

/** Build a schema-aware in-memory RPC client for commit-feed tests. */
export const commitsTestLayer = (service: UserActivity.CommitsInterface) =>
  Layer.effect(
    UserActivity.CommitsService,
    Effect.gen(function* () {
      const handlers = CommitRpcs.toLayer({
        latestCommit: ({ username }) => fresh(service.latestCommit(username)),
        commits: (input) => fresh(service.commits(input)),
      })
      const client = yield* RpcTest.makeClient(CommitRpcs).pipe(Effect.provide(handlers))
      return UserActivity.CommitsService.of({
        latestCommit: Effect.fn("UserActivity.latestCommit.testCommitRpc")(function* (username) {
          return yield* client.latestCommit({ username }).pipe(Effect.map(({ value }) => value))
        }),
        commits: Effect.fn("UserActivity.commits.testRpc")(function* (input) {
          const payload =
            input.cursor !== undefined
              ? { username: input.username, cursor: input.cursor }
              : input.limit !== undefined
                ? { username: input.username, limit: input.limit }
                : { username: input.username }
          return yield* client.commits(payload).pipe(Effect.map(({ value }) => value))
        }),
      })
    }),
  )
