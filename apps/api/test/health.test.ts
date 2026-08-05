/* oxlint-disable effecttsgo/strict-effect-provide */

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Configuration, configurationLayer, testProvider } from "../src/config.js"
import { makeWorkerHttpEffect, makeWorkerResponse } from "../src/worker.js"
import { makeWebHandler } from "../src/http.js"
import { UserActivity } from "../src/user-activity.js"

const docsUrl = new URL("https://docs.example.test")

const withConfiguration = <A>(effect: Effect.Effect<A, never, Configuration>) =>
  effect.pipe(
    Effect.provide(
      configurationLayer.pipe(Layer.provide(testProvider({ DOCS_URL: docsUrl.toString() }))),
    ),
  )

const healthOnlyActivity = UserActivity.CacheAwareService.of({
  latestCommit: () => Effect.die("not used"),
  commits: () => Effect.die("not used"),
  summarize: () => Effect.die("not used"),
  streak: () => Effect.die("not used"),
})

describe("health walking skeleton", () => {
  test("returns health through the Worker HTTP composition without GitHub credentials", async () => {
    const httpEffect = await Effect.runPromise(
      Effect.scoped(
        makeWorkerHttpEffect().pipe(
          Effect.provide(
            Layer.mergeAll(
              configurationLayer.pipe(
                Layer.provide(testProvider({ DOCS_URL: docsUrl.toString() })),
              ),
              Layer.succeed(UserActivity.CacheAwareService, healthOnlyActivity),
            ),
          ),
        ),
      ),
    )
    const response = await makeWorkerResponse(
      new Request("https://api.example.test/health"),
      httpEffect,
      true,
      { record: () => undefined },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
  })

  test("represents an absent GitHub credential without failing configuration", async () => {
    const configuration = await Effect.runPromise(
      withConfiguration(
        Effect.gen(function* () {
          return yield* Configuration
        }),
      ),
    )

    expect(Option.isNone(configuration.githubToken)).toBe(true)
  })

  test("serves the generated full contract document", async () => {
    const web = await Effect.runPromise(Effect.scoped(makeWebHandler(docsUrl)))
    const response = await web.handler(new Request("https://api.example.test/openapi.json"))
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(body).toContain('"title":"Kronik API"')
    expect(body).toContain('"version":"1.0.0"')
    expect(body).toContain('"/health"')

    await web.dispose()
  })

  test("redirects docs to the configured site", async () => {
    const web = await Effect.runPromise(Effect.scoped(makeWebHandler(docsUrl)))
    const response = await web.handler(new Request("https://api.example.test/docs"))

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(docsUrl.toString())

    await web.dispose()
  })

  test("returns not found for an unknown route", async () => {
    const web = await Effect.runPromise(Effect.scoped(makeWebHandler(docsUrl)))
    const response = await web.handler(new Request("https://api.example.test/"))

    expect(response.status).toBe(404)

    await web.dispose()
  })
})
