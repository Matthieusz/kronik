export * as Observability from "./observability.js"

/** Stable public route names allowed in telemetry. */
export type Route =
  | "health"
  | "openapi"
  | "docs"
  | "latestCommit"
  | "commits"
  | "activity"
  | "streak"
  | "unmatched"

/** Expected public error tags allowed in telemetry. */
export type ExpectedErrorTag =
  | "InvalidRequest"
  | "InvalidCursor"
  | "UserNotFound"
  | "LatestCommitNotFound"
  | "RateLimited"
  | "UpstreamFailure"
  | "ServiceUnavailable"

/** GitHub operations allowed in telemetry. */
export type GitHubOperation =
  | "GitHub.resolveUser"
  | "GitHub.searchCommits"
  | "GitHub.hydrateCommit"
  | "GitHub.getLanguages"
  | "GitHub.contributionStreak"

/** One completed public HTTP request with data-minimized fields. */
export interface HttpRequestEvent {
  readonly kind: "http.request"
  readonly requestId: string
  readonly route: Route
  readonly canonicalUsername?: string
  readonly cacheOutcome: "hit" | "miss" | "stale"
  readonly staleAgeSeconds?: number
  readonly latencyMs: number
  readonly status: number
  readonly expectedErrorTag?: ExpectedErrorTag
}

/** One GitHub HTTP attempt with data-minimized rate evidence. */
export interface GitHubRequestEvent {
  readonly kind: "github.request"
  readonly operation: GitHubOperation
  readonly outcome: "success" | "transport" | "timeout" | "malformed" | "status" | "rate"
  readonly latencyMs: number
  readonly status?: number
  readonly rateRemaining?: number
  readonly retryAfterSeconds?: number
}

/** Every structured event Kronik permits an observability sink to receive. */
export type Event = HttpRequestEvent | GitHubRequestEvent

/** Narrow logging sink. Its closed event algebra prevents arbitrary payload logging. */
export interface Sink {
  /** Emit one already-minimized structured event. */
  readonly record: (event: Event) => void | Promise<void>
}

/** Free structured console sink used by the Worker runtime. */
export const consoleSink: Sink = {
  record: (event) => console.info(JSON.stringify(event)),
}

/** Emit telemetry without allowing a diagnostic sink failure to fail application work. */
export const recordSafely = async (sink: Sink, event: Event): Promise<void> => {
  try {
    await sink.record(event)
  } catch {
    // Observability is deliberately fail-open and never records the sink failure value.
  }
}
