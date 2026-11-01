// Effect's HTTP/RPC adapters remain unstable in v4; exact versions and integration tests guard upgrades.
/* oxlint-disable effecttsgo/unstable-api-usage */
/* oxlint-disable effecttsgo/strict-effect-provide */

import { Rpcs } from "@kronik/contract/rpc"
import { Effect, Layer } from "effect"
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import { ActivityRpcClient } from "../src/activity-rpc.js"
import { UserActivity } from "../src/user-activity.js"

/** Explicit test adapter for routes that must not invoke any activity lookup. */
export const unusedActivity: UserActivity.CacheAwareInterface = {
  latestCommit: () => Effect.die("Unexpected latest commit lookup"),
  commits: () => Effect.die("Unexpected commit page lookup"),
  summarize: () => Effect.die("Unexpected activity summary lookup"),
  streak: () => Effect.die("Unexpected contribution streak lookup"),
}

/** Exercise the production namespace adapter through schema-validated, in-memory NDJSON RPC. */
export const activityTestLayer = (activity: UserActivity.CacheAwareInterface) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const handlers = Rpcs.toLayer({
        latestCommit: ({ username }) => activity.latestCommit(username),
        commits: (input) => activity.commits(input),
        summary: (input) => activity.summarize(input),
        streak: ({ username }) => activity.streak(username),
      })

      const server = yield* RpcServer.toHttpEffect(Rpcs).pipe(
        Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
      )

      const transport = HttpClient.make((request) =>
        Effect.gen(function* () {
          const webRequest = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)

          const webResponse = yield* Effect.scoped(
            server.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(webRequest),
              ),
              Effect.map(HttpServerResponse.toWeb),
            ),
          ).pipe(Effect.orDie)

          return HttpClientResponse.fromWeb(request, webResponse)
        }),
      )

      const protocol = yield* RpcClient.makeProtocolHttp(
        HttpClient.mapRequest(transport, HttpClientRequest.prependUrl("http://local")),
      ).pipe(Effect.provide(RpcSerialization.layerNdjson))

      const client = yield* RpcClient.make(Rpcs).pipe(
        Effect.provide(Layer.succeed(RpcClient.Protocol, protocol)),
      )

      return ActivityRpcClient.layerWithNamespace({
        getByName: () => Effect.succeed(client),
      })
    }),
  )
