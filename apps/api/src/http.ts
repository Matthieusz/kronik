import { Api } from "@kronik/contract/api"
import { ApiError } from "@kronik/contract/errors"
import { GitHubUsername, Health } from "@kronik/contract/model"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Scope } from "effect"
import { OpenApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpApiSchemaError } from "effect/unstable/httpapi/HttpApiError"
import {
  Etag,
  HttpPlatform,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { Observability } from "./observability.js"
import { UserActivity } from "./user-activity.js"

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: () => Effect.die("HTTP compression is not available in a Worker"),
  },
  fileResponse: () => Effect.die("File responses are not available in a Worker"),
  fileWebResponse: () => Effect.die("File responses are not available in a Worker"),
})

const RequestIdPattern = /^[A-Za-z0-9._:-]{1,64}$/
const CorsHeaders = {
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type, if-none-match, x-request-id",
  "access-control-max-age": "86400",
}

type CacheState = "hit" | "miss" | "stale"
const DurableCacheStateHeader = "x-kronik-durable-cache"
const CanonicalUsernameHeader = "x-kronik-canonical-username"

/** A cache entry returned by the Cloudflare edge-cache adapter. */
export interface EdgeCacheEntry {
  /** The cached public response. */
  readonly response: Response
  /** The approximate age of the cached response in seconds. */
  readonly ageSeconds: number
  /** Whether the edge served an eligible stale response. */
  readonly stale: boolean
}

/** The narrow cache capability needed by the public HTTP policy. */
export interface EdgeCache {
  /** Look up a normalized public request. Cache failures are handled by the caller. */
  readonly get: (request: Request) => Promise<EdgeCacheEntry | undefined>
  /** Store a cacheable public response. Cache failures are non-fatal. */
  readonly put: (request: Request, response: Response) => Promise<void>
}

/** The narrow approximate per-IP limiter capability needed by the public edge policy. */
export interface RateLimiter {
  /** Return `true` when the request may continue. */
  readonly check: (key: string) => Promise<boolean>
}

/** Optional seams for deterministic tests and platform adapters. */
export interface PublicPolicyOptions {
  /** Cloudflare's approximate per-location rate limiter. */
  readonly rateLimiter?: RateLimiter
  /** Cloudflare's edge cache adapter. */
  readonly edgeCache?: EdgeCache
  /** Request-ID source; invalid supplied IDs are never passed to it. */
  readonly requestId?: () => string
  /** Data-minimized structured observability sink. */
  readonly observability?: Observability.Sink
}

const healthResponse = (): Effect.Effect<Health> => Effect.succeed({ status: "ok" })
const invalidRequestResponse = () =>
  HttpServerResponse.jsonUnsafe(
    {
      type: "https://kronik.dev/problems/invalid-request",
      title: "Invalid request",
      detail: "The request does not match Kronik's public contract",
      instance: "urn:kronik:http",
      status: 400,
    },
    { status: 400, contentType: "application/problem+json" },
  )

const unavailable = <A>(): Effect.Effect<A, ApiError.DomainErrors> =>
  Effect.die("The requested activity capability is not installed")

const makeActivityService = (options: ApplicationOptions): UserActivity.Interface => ({
  latestCommit:
    options.activityService?.latestCommit ??
    options.latestService?.latestCommit ??
    (() => unavailable()),
  commits:
    options.activityService?.commits ?? options.commitsService?.commits ?? (() => unavailable()),
  summarize:
    options.activityService?.summarize ??
    options.summaryService?.summarize ??
    (() => unavailable()),
  streak: options.activityService?.streak ?? options.streakService?.streak ?? (() => unavailable()),
})

const freshLookup = <A>(effect: Effect.Effect<A, ApiError.DomainErrors>) =>
  effect.pipe(Effect.map((value) => ({ value, cacheState: "fresh" as const })))

const makeCacheAwareService = (options: ApplicationOptions): UserActivity.CacheAwareInterface => {
  if (options.activityCacheService !== undefined) return options.activityCacheService
  const activity = makeActivityService(options)
  return {
    latestCommit: (username) => freshLookup(activity.latestCommit(username)),
    commits: (input) => freshLookup(activity.commits(input)),
    summarize: (input) => freshLookup(activity.summarize(input)),
    streak: (username) => freshLookup(activity.streak(username)),
  }
}

const activityResponse = <A extends { readonly user: { readonly login: string } }>({
  value,
  cacheState,
}: UserActivity.LookupResult<A>): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(value, {
    headers: {
      [CanonicalUsernameHeader]: value.user.login,
      ...(cacheState === "stale" ? { [DurableCacheStateHeader]: "stale" } : {}),
    },
  })

const healthHandlers = HttpApiBuilder.group(Api, "health", (handlers) =>
  handlers.handle("get", healthResponse),
)
const activityHandlers = HttpApiBuilder.group(Api, "activity", (handlers) =>
  Effect.gen(function* () {
    const activity = yield* UserActivity.CacheAwareService
    return handlers
      .handle("latestCommit", ({ params }) =>
        activity.latestCommit(params.username).pipe(Effect.map(activityResponse)),
      )
      .handle("commits", ({ params, query }) => {
        if (query.cursor !== undefined && query.limit !== undefined)
          return Effect.fail(
            new ApiError.InvalidRequest({
              type: "https://kronik.dev/problems/invalid-request",
              title: "Invalid request",
              detail: "A cursor cannot be combined with a limit",
              instance: "urn:kronik:activity:commits",
              status: 400,
            }),
          )
        if (query.cursor !== undefined)
          return activity
            .commits({ username: params.username, cursor: query.cursor })
            .pipe(Effect.map(activityResponse))
        if (query.limit !== undefined)
          return activity
            .commits({ username: params.username, limit: query.limit })
            .pipe(Effect.map(activityResponse))
        return activity.commits({ username: params.username }).pipe(Effect.map(activityResponse))
      })
      .handle("summary", ({ params, query }) => {
        if (query.from !== undefined && query.to !== undefined)
          return activity
            .summarize({ username: params.username, from: query.from, to: query.to })
            .pipe(Effect.map(activityResponse))
        if (query.from !== undefined)
          return activity
            .summarize({ username: params.username, from: query.from })
            .pipe(Effect.map(activityResponse))
        if (query.to !== undefined)
          return activity
            .summarize({ username: params.username, to: query.to })
            .pipe(Effect.map(activityResponse))
        return activity.summarize({ username: params.username }).pipe(Effect.map(activityResponse))
      })
      .handle("streak", ({ params }) =>
        activity.streak(params.username).pipe(Effect.map(activityResponse)),
      )
  }),
)

/** Build the complete authoritative v1 HTTP application once per Worker init. */
export const applicationLayer = (docsUrl: URL) =>
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(activityHandlers),
    Layer.provide(healthHandlers),
    Layer.provide(
      HttpRouter.add("GET", "/openapi.json", HttpServerResponse.jsonUnsafe(OpenApi.fromApi(Api))),
    ),
    Layer.provide(HttpRouter.add("GET", "/docs", HttpServerResponse.redirect(docsUrl))),
    Layer.provide([Etag.layer, HttpPlatformStub, FileSystem.layerNoop({}), Path.layer]),
  )

/** Compatibility aliases retained for package-local slice tests; all use the full API now. */
export const latestApplicationLayer = applicationLayer
/** Compatibility alias for the full application. */
export const commitsApplicationLayer = applicationLayer
/** Compatibility alias for the full application. */
export const summaryApplicationLayer = applicationLayer
/** Compatibility alias for the full application. */
export const streakApplicationLayer = applicationLayer

export interface ApplicationOptions extends PublicPolicyOptions {
  /** The complete activity service used by the Worker runtime. */
  readonly activityService?: UserActivity.Interface
  /** The activity service with Durable Object cache provenance. */
  readonly activityCacheService?: UserActivity.CacheAwareInterface
  /** Compatibility seam for latest-route tests. */
  readonly latestService?: UserActivity.LatestInterface
  /** Compatibility seam for commit-route tests. */
  readonly commitsService?: UserActivity.CommitsInterface
  /** Compatibility seam for summary-route tests. */
  readonly summaryService?: UserActivity.SummaryInterface
  /** Compatibility seam for streak-route tests. */
  readonly streakService?: UserActivity.StreakInterface
}

const buildHttpEffect = Effect.fn("Api.buildHttpEffect")(function* (
  docsUrl: URL,
  options: ApplicationOptions = {},
) {
  const service = makeCacheAwareService(options)
  const httpEffect = yield* HttpRouter.toHttpEffect(
    applicationLayer(docsUrl).pipe(
      Layer.provide(Layer.succeed(UserActivity.CacheAwareService, service)),
    ),
  )
  return yield* Effect.succeed(
    httpEffect.pipe(
      Effect.catchIf(
        (error) => HttpApiSchemaError.is(error),
        () => Effect.succeed(invalidRequestResponse()),
      ),
      Effect.catchIf(
        (error) => error.reason instanceof HttpServerError.RouteNotFound,
        () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
    ),
  )
})

const requestId = (request: Request, source: () => string): string => {
  const supplied = request.headers.get("x-request-id")
  if (supplied !== null && RequestIdPattern.test(supplied)) return supplied
  const generated = source()
  if (RequestIdPattern.test(generated)) return generated
  return crypto.randomUUID()
}

const generatedRequestId = (): string => crypto.randomUUID()

const cacheKey = (request: Request): Request => {
  const url = new URL(request.url)
  const path = url.pathname.split("/")
  if (path[1] === "v1" && path[2] === "users" && path[3] !== undefined)
    path[3] = path[3].toLowerCase()
  url.pathname = path.join("/")
  const search = Array.from(url.searchParams.entries()).toSorted(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
  )
  url.search = ""
  for (const [key, value] of search) url.searchParams.append(key, value)
  return new Request(url, { method: "GET" })
}

const cacheTtl = (pathname: string): number | undefined => {
  if (pathname.endsWith("/commits/latest") || pathname.endsWith("/commits")) return 60
  if (pathname.endsWith("/activity") || pathname.endsWith("/streak")) return 300
  return undefined
}

const safeProperty = (value: object, key: string): unknown => Reflect.get(value, key)
const isRecord = (value: unknown): value is object => typeof value === "object" && value !== null
const stringProperty = (value: object, key: string): string | undefined => {
  const property = safeProperty(value, key)
  return typeof property === "string" ? property : undefined
}
const numberProperty = (value: object, key: string): number | undefined => {
  const property = safeProperty(value, key)
  return typeof property === "number" && Number.isSafeInteger(property) ? property : undefined
}

const cloudflareCache = (): object | undefined => {
  const storage = Reflect.get(globalThis, "caches")
  if (!isRecord(storage)) return undefined
  const cache = safeProperty(storage, "default")
  return isRecord(cache) ? cache : undefined
}

/** Cloudflare Workers Cache API adapter used by the Worker composition root. */
export const cloudflareEdgeCache: EdgeCache = {
  get: async (request) => {
    const cache = cloudflareCache()
    if (cache === undefined) return undefined
    const match = safeProperty(cache, "match")
    if (typeof match !== "function") return undefined
    const result: unknown = await match.call(cache, request)
    if (!(result instanceof Response)) return undefined
    const ageHeader = result.headers.get("age")
    const ageSeconds = ageHeader === null ? 0 : Number.parseInt(ageHeader, 10)
    const ttl = cacheTtl(new URL(request.url).pathname)
    if (ttl === undefined || !Number.isFinite(ageSeconds) || ageSeconds > ttl + 3_600)
      return undefined
    return { response: result, ageSeconds, stale: ageSeconds > ttl }
  },
  put: async (request, response) => {
    const cache = cloudflareCache()
    if (cache === undefined) return
    const put = safeProperty(cache, "put")
    if (typeof put !== "function") return
    await put.call(cache, request, response)
  },
}

const publicProblem = (response: Response, id: string): Promise<Response> =>
  response
    .clone()
    .text()
    .then((text) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return response
      }
      if (!isRecord(parsed)) return response
      const status = numberProperty(parsed, "status")
      const type = stringProperty(parsed, "type")
      const title = stringProperty(parsed, "title")
      const detail = stringProperty(parsed, "detail")
      if (status === undefined || type === undefined || title === undefined || detail === undefined)
        return response
      const retryAfterSeconds = numberProperty(parsed, "retryAfterSeconds")
      const body: Record<string, string | number> = {
        type,
        title,
        detail,
        instance: `urn:kronik:request:${id}`,
        status,
      }
      if (retryAfterSeconds !== undefined) body.retryAfterSeconds = retryAfterSeconds
      const headers = new Headers(response.headers)
      headers.set("content-type", "application/problem+json")
      return new Response(JSON.stringify(body), { status, headers })
    })

const digest = async (body: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const withPublicHeaders = async (
  response: Response,
  id: string,
  state: CacheState,
  ageSeconds: number,
  request: Request,
): Promise<Response> => {
  const problem = await publicProblem(response, id)
  const body = await problem.clone().text()
  const headers = new Headers(problem.headers)
  if (problem.status === 429 && headers.get("retry-after") === null) {
    let bodyValue: unknown
    try {
      bodyValue = JSON.parse(body)
    } catch {
      bodyValue = undefined
    }
    if (isRecord(bodyValue)) {
      const seconds = numberProperty(bodyValue, "retryAfterSeconds")
      if (seconds !== undefined) headers.set("retry-after", String(seconds))
    }
  }
  headers.set("access-control-allow-origin", "*")
  for (const [key, value] of Object.entries(CorsHeaders)) headers.set(key, value)
  const durableState = problem.headers.get(DurableCacheStateHeader)
  const effectiveState: CacheState = durableState === "stale" ? "stale" : state
  headers.delete(DurableCacheStateHeader)
  headers.delete(CanonicalUsernameHeader)
  headers.set("x-request-id", id)
  headers.set("x-kronik-cache", effectiveState)
  headers.set("age", String(Math.max(0, Math.floor(ageSeconds))))
  headers.set("etag", `"${await digest(body)}"`)
  if (effectiveState === "stale") headers.set("warning", '110 - "Response is stale"')
  const ttl = problem.status === 200 ? cacheTtl(new URL(request.url).pathname) : undefined
  headers.set(
    "cache-control",
    ttl === undefined ? "no-store" : `public, max-age=${ttl}, stale-while-revalidate=3600`,
  )
  const matches = request.headers.get("if-none-match")
  const etag = headers.get("etag")
  const notModified =
    matches !== null &&
    etag !== null &&
    (matches.split(",").some((value) => value.trim() === etag) || matches.trim() === "*")
  if (notModified) return new Response(null, { status: 304, headers })
  if (request.method === "HEAD") return new Response(null, { status: problem.status, headers })
  return new Response(body, { status: problem.status, headers })
}

const routeName = (pathname: string): Observability.Route => {
  if (pathname === "/health") return "health"
  if (pathname === "/openapi.json") return "openapi"
  if (pathname === "/docs") return "docs"
  if (/^\/v1\/users\/[^/]+\/commits\/latest$/.test(pathname)) return "latestCommit"
  if (/^\/v1\/users\/[^/]+\/commits$/.test(pathname)) return "commits"
  if (/^\/v1\/users\/[^/]+\/activity$/.test(pathname)) return "activity"
  if (/^\/v1\/users\/[^/]+\/streak$/.test(pathname)) return "streak"
  return "unmatched"
}

const canonicalUsername = (response: Response): string | undefined => {
  const decoded = Schema.decodeUnknownOption(GitHubUsername)(
    response.headers.get(CanonicalUsernameHeader),
  )
  return Option.isSome(decoded) ? String(decoded.value) : undefined
}

const ProblemTags: Readonly<Record<string, Observability.ExpectedErrorTag>> = {
  "https://kronik.dev/problems/invalid-request": "InvalidRequest",
  "https://kronik.dev/problems/invalid-cursor": "InvalidCursor",
  "https://kronik.dev/problems/user-not-found": "UserNotFound",
  "https://kronik.dev/problems/latest-commit-not-found": "LatestCommitNotFound",
  "https://kronik.dev/problems/rate-limited": "RateLimited",
  "https://kronik.dev/problems/upstream-failure": "UpstreamFailure",
  "https://kronik.dev/problems/service-unavailable": "ServiceUnavailable",
}

const expectedErrorTag = async (
  response: Response,
): Promise<Observability.ExpectedErrorTag | undefined> => {
  let value: unknown
  try {
    value = JSON.parse(await response.clone().text())
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const type = stringProperty(value, "type")
  return type === undefined ? undefined : ProblemTags[type]
}

const requestAbort = (request: Request): Effect.Effect<never> =>
  Effect.callback((resume, signal) => {
    const abort = () => resume(Effect.interrupt)
    if (request.signal.aborted) abort()
    else request.signal.addEventListener("abort", abort, { once: true, signal })
    return Effect.sync(() => request.signal.removeEventListener("abort", abort))
  })

const rateLimitResponse = (): Response =>
  new Response(
    JSON.stringify({
      type: "https://kronik.dev/problems/rate-limited",
      title: "Too many requests",
      detail: "The anonymous caller exceeded Kronik's public request budget",
      instance: "urn:kronik:request:pending",
      status: 429,
      retryAfterSeconds: 60,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/problem+json",
        "retry-after": "60",
      },
    },
  )

/** Apply the public edge policy to an initialized HTTP application. */
export const makePublicResponse = async (
  request: Request,
  httpEffect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError.HttpServerError,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >,
  options: PublicPolicyOptions,
): Promise<Response> => {
  const startedAt = performance.now()
  const id = requestId(request, options.requestId ?? generatedRequestId)
  const route = routeName(new URL(request.url).pathname)
  const finish = async (
    response: Response,
    state: CacheState,
    ageSeconds: number,
  ): Promise<Response> => {
    const username = canonicalUsername(response)
    const errorTag = await expectedErrorTag(response)
    const publicResponse = await withPublicHeaders(response, id, state, ageSeconds, request)
    const effectiveState = publicResponse.headers.get("x-kronik-cache")
    if (options.observability !== undefined) {
      await Observability.recordSafely(options.observability, {
        kind: "http.request",
        requestId: id,
        route,
        ...(username === undefined ? {} : { canonicalUsername: username }),
        cacheOutcome:
          effectiveState === "hit" || effectiveState === "stale" ? effectiveState : "miss",
        ...(effectiveState === "stale"
          ? { staleAgeSeconds: Math.max(0, Math.floor(ageSeconds)) }
          : {}),
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        status: publicResponse.status,
        ...(errorTag === undefined ? {} : { expectedErrorTag: errorTag }),
      })
    }
    return publicResponse
  }

  const rateKey = request.headers.get("cf-connecting-ip") ?? "unknown"
  let allowed = true
  if (options.rateLimiter !== undefined) {
    try {
      allowed = await options.rateLimiter.check(rateKey)
    } catch {
      allowed = true
    }
  }
  if (!allowed) {
    const response = await finish(rateLimitResponse(), "miss", 0)
    response.headers.set("retry-after", "60")
    return response
  }
  if (request.method === "OPTIONS") {
    return finish(new Response(null, { status: 204 }), "miss", 0)
  }
  const method = request.method === "HEAD" ? "GET" : request.method
  const originRequest =
    method === request.method
      ? request
      : new Request(request.url, { method, headers: request.headers })
  const key = cacheKey(originRequest)
  const ttl = cacheTtl(new URL(originRequest.url).pathname)
  if (options.edgeCache !== undefined && ttl !== undefined && method === "GET") {
    try {
      const cached = await options.edgeCache.get(key)
      if (cached !== undefined) {
        return finish(cached.response, cached.stale ? "stale" : "hit", cached.ageSeconds)
      }
    } catch {
      // Edge cache failures are deliberately fail-open.
    }
  }
  const response = await Effect.runPromiseWith(
    Context.make(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(originRequest)),
  )(
    request.signal.aborted
      ? Effect.interrupt
      : Effect.race(
          Effect.scoped(
            httpEffect.pipe(
              Effect.map(HttpServerResponse.toWeb),
              Effect.tap((webResponse) =>
                Effect.annotateCurrentSpan("http.response.status_code", webResponse.status),
              ),
              Effect.withSpan("http.request", {
                attributes: { "http.route": route, "request.id": id },
              }),
            ),
          ),
          requestAbort(request),
        ),
  )
  const username = canonicalUsername(response)
  const publicResponse = await finish(response, "miss", 0)
  if (
    options.edgeCache !== undefined &&
    ttl !== undefined &&
    publicResponse.status === 200 &&
    publicResponse.headers.get("x-kronik-cache") !== "stale"
  ) {
    try {
      const cachedResponse = publicResponse.clone()
      if (username !== undefined) cachedResponse.headers.set(CanonicalUsernameHeader, username)
      await options.edgeCache.put(key, cachedResponse)
    } catch {
      // Edge cache failures are deliberately fail-open.
    }
  }
  return publicResponse
}

/** Build the initialized full v1 HTTP effect. */
export const makeHttpEffect = Effect.fn("Api.makeHttpEffect")(function* (
  docsUrl: URL,
  options: ApplicationOptions = {},
) {
  return yield* buildHttpEffect(docsUrl, options)
})

/** Build a Fetch handler with the complete public edge/API policy. */
export const makeWebHandler = Effect.fn("Api.makeWebHandler")(function* (
  docsUrl: URL,
  options: ApplicationOptions = {},
) {
  const httpEffect = yield* buildHttpEffect(docsUrl, options)
  const handler = (request: Request) => makePublicResponse(request, httpEffect, options)
  return { handler, dispose: async () => undefined }
})

/** A deterministic in-memory edge cache useful for local acceptance tests. */
export const makeMemoryEdgeCache = (now: () => number = Date.now): EdgeCache => {
  const values = new Map<string, { readonly response: Response; readonly savedAt: number }>()
  return {
    get: async (request) => {
      const value = values.get(request.url)
      if (value === undefined) return undefined
      const ageSeconds = Math.floor((now() - value.savedAt) / 1000)
      const ttl = cacheTtl(new URL(request.url).pathname)
      if (ttl === undefined || ageSeconds > ttl + 3_600) return undefined
      return { response: value.response.clone(), ageSeconds, stale: ageSeconds > ttl }
    },
    put: async (request, response) => {
      values.set(request.url, { response: response.clone(), savedAt: now() })
    },
  }
}
