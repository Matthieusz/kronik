import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Redacted } from "effect"
import { Configuration, layer, testProvider } from "../src/config.js"
import { makeWebHandler } from "../src/http.js"

const docsUrl = new URL("https://docs.example.test")

const withConfiguration = <A>(effect: Effect.Effect<A, never, Configuration>) =>
  effect.pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          testProvider({
            DOCS_URL: docsUrl.toString(),
            GITHUB_TOKEN: "kronik-test-github-token",
          }),
        ),
      ),
    ),
  )

describe("health walking skeleton", () => {
  test("returns health without making a GitHub request", async () => {
    const configuration = await Effect.runPromise(
      withConfiguration(
        Effect.gen(function* () {
          return yield* Configuration
        }),
      ),
    )

    expect(Redacted.isRedacted(configuration.githubToken)).toBe(true)

    const web = await Effect.runPromise(Effect.scoped(makeWebHandler(configuration.docsUrl)))
    const response = await web.handler(new Request("https://api.example.test/health"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })

    await web.dispose()
  })

  test("requires a service-owned GitHub credential", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* Configuration
      }).pipe(
        Effect.provide(layer.pipe(Layer.provide(testProvider({ DOCS_URL: docsUrl.toString() })))),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
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
