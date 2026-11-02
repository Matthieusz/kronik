// Effect's HTTP/RPC adapters remain unstable in v4; exact versions and integration tests guard upgrades.
/* oxlint-disable effecttsgo/unstable-api-usage */

export * as ActivityObjectModule from "./activity-object.js"

import { ApiError } from "@kronik/contract/errors"
import { GitHubUsername } from "@kronik/contract/model"
import { Rpcs } from "@kronik/contract/rpc"
import { DurableObjectState, RpcDurableObject } from "@alchemy.run/cloudflare"
import { Context, Effect, Layer, Scope } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { UserActivity } from "./user-activity.js"
import type { ActivityStorage } from "./activity-cache.js"

export type { ActivityStorage } from "./activity-cache.js"

/** The state needed by the activity coordinator, independent of Cloudflare's constructor. */
export interface ActivityObjectState {
  /** The Durable Object name, used to bind RPC payloads to the instance. */
  readonly objectName: string | undefined
  /** The Durable Object's persistent storage. */
  readonly storage: ActivityStorage
}

/** Testable state seam for the activity coordinator. */
export class ActivityState extends Context.Service<ActivityState, ActivityObjectState>()(
  "@kronik/api/ActivityState",
) {}

/** Schema-validated Durable Object keyed by normalized requested username. */
export class ActivityObject extends RpcDurableObject<ActivityObject>()("KronikActivity", {
  schema: Rpcs,
}) {}

/** Bind decoded RPC requests to this object's identity and delegate lookup behavior. */
export const activityRuntime = Effect.fn("ActivityObject.runtime")(function* () {
  const state = yield* ActivityState
  const activity = yield* UserActivity.make(state.storage)

  const requestedUser = Effect.fn("ActivityObject.requestedUser")(function* (
    username: GitHubUsername,
  ) {
    if (state.objectName !== undefined && state.objectName.toLowerCase() !== username.toLowerCase())
      return yield* Effect.fail(
        new ApiError.InvalidRequest({
          type: "https://kronik.dev/problems/invalid-request",
          title: "Invalid request",
          detail: "The RPC username does not match the Durable Object identity",
          instance: "urn:kronik:activity:request",
          status: 400,
        }),
      )

    return username
  })

  const handlers = Rpcs.toLayer({
    latestCommit: ({ username }) =>
      requestedUser(username).pipe(Effect.flatMap(activity.latestCommit)),
    commits: (payload) =>
      requestedUser(payload.username).pipe(Effect.flatMap(() => activity.commits(payload))),
    summary: (payload) =>
      requestedUser(payload.username).pipe(Effect.flatMap(() => activity.summarize(payload))),
    streak: ({ username }) => requestedUser(username).pipe(Effect.flatMap(activity.streak)),
  })

  return yield* RpcServer.toHttpEffect(Rpcs).pipe(
    // The Durable Object initializer is this RPC server's composition root.
    // oxlint-disable-next-line effecttsgo/strict-effect-provide
    Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
  )
})

/** Cloudflare Durable Object adapter for the testable activity coordinator. */
export const ActivityObjectLive = ActivityObject.make(
  Effect.gen(function* () {
    const durableState = yield* DurableObjectState
    const runtimeContext = yield* RuntimeContext
    // Cloudflare has no Durable Object deactivation hook; this instance scope owns its caches.
    const instanceScope = yield* Scope.make()

    const initialized = activityRuntime().pipe(
      Effect.provideService(ActivityState, {
        get objectName() {
          return durableState.id?.name
        },
        storage: {
          get: (key) =>
            durableState.storage
              .get(key)
              .pipe(Effect.provideService(RuntimeContext, runtimeContext)),
          list: (options) =>
            durableState.storage
              .list(options)
              .pipe(Effect.provideService(RuntimeContext, runtimeContext)),
          put: (key, value) =>
            durableState.storage
              .put(key, value)
              .pipe(Effect.provideService(RuntimeContext, runtimeContext)),
          delete: (key) =>
            durableState.storage
              .delete(key)
              .pipe(Effect.provideService(RuntimeContext, runtimeContext)),
          deleteMany: (keys) =>
            durableState.storage
              .delete([...keys])
              .pipe(Effect.provideService(RuntimeContext, runtimeContext)),
        },
      }),
      Effect.provideService(Scope.Scope, instanceScope),
    )

    // The RPC Durable Object API requires the HTTP handler inside one more initializer effect.
    // oxlint-disable-next-line effecttsgo/return-effect-in-gen
    return Effect.succeed(initialized)
  }),
)

export default ActivityObjectLive
