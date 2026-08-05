export * as ActivityRpcClient from "./activity-rpc.js"

import { ApiError } from "@kronik/contract/errors"
import { Context, Effect, Layer } from "effect"
import { ActivityObject } from "./activity-object.js"
import { UserActivity } from "./user-activity.js"

const coordinatorFailure = () =>
  new ApiError.UpstreamFailure({
    type: "https://kronik.dev/problems/upstream-failure",
    title: "Durable Object unavailable",
    detail: "Kronik could not reach the activity coordinator",
    instance: "urn:kronik:rpc",
    status: 502,
  })

/** The namespace capability needed by the Worker-side application service adapter. */
export type ActivityNamespace = Pick<Effect.Success<typeof ActivityObject>, "getByName">

/** Bind an activity namespace to the Worker-side application services. */
export const layerWithNamespace = (namespace: ActivityNamespace) => {
  const cacheAware = UserActivity.CacheAwareService.of({
    latestCommit: Effect.fn("UserActivity.latestCommit.rpc")(function* (username) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* namespace.getByName(username.toLowerCase())
          return yield* client
            .latestCommit({ username })
            .pipe(Effect.catchTag("RpcClientError", () => Effect.fail(coordinatorFailure())))
        }),
      )
    }),
    commits: Effect.fn("UserActivity.commits.rpc")(function* (input) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* namespace.getByName(input.username.toLowerCase())
          const payload =
            input.cursor !== undefined
              ? { username: input.username, cursor: input.cursor }
              : input.limit !== undefined
                ? { username: input.username, limit: input.limit }
                : { username: input.username }
          return yield* client
            .commits(payload)
            .pipe(Effect.catchTag("RpcClientError", () => Effect.fail(coordinatorFailure())))
        }),
      )
    }),
    summarize: Effect.fn("UserActivity.summarize.rpc")(function* (input) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* namespace.getByName(input.username.toLowerCase())
          const payload =
            input.from !== undefined && input.to !== undefined
              ? { username: input.username, from: input.from, to: input.to }
              : input.from !== undefined
                ? { username: input.username, from: input.from }
                : input.to !== undefined
                  ? { username: input.username, to: input.to }
                  : { username: input.username }
          return yield* client
            .summary(payload)
            .pipe(Effect.catchTag("RpcClientError", () => Effect.fail(coordinatorFailure())))
        }),
      )
    }),
    streak: Effect.fn("UserActivity.streak.rpc")(function* (username) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* namespace.getByName(username.toLowerCase())
          return yield* client
            .streak({ username })
            .pipe(Effect.catchTag("RpcClientError", () => Effect.fail(coordinatorFailure())))
        }),
      )
    }),
  })
  const service = UserActivity.StreakService.of({
    latestCommit: (username) =>
      cacheAware.latestCommit(username).pipe(Effect.map(({ value }) => value)),
    commits: (input) => cacheAware.commits(input).pipe(Effect.map(({ value }) => value)),
    summarize: (input) => cacheAware.summarize(input).pipe(Effect.map(({ value }) => value)),
    streak: (username) => cacheAware.streak(username).pipe(Effect.map(({ value }) => value)),
  })
  return Layer.succeedContext(
    Context.empty().pipe(
      Context.add(UserActivity.CacheAwareService, cacheAware),
      Context.add(UserActivity.SummaryService, service),
      Context.add(UserActivity.StreakService, service),
    ),
  )
}

/** Bind the live Cloudflare Durable Object namespace. */
export const activityRpcLayer = Layer.unwrap(
  Effect.gen(function* () {
    const namespace = yield* ActivityObject
    return layerWithNamespace(namespace)
  }),
)

/** The live RPC layer retained as the package's default layer name. */
export const layer = activityRpcLayer
