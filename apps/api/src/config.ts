import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted, Schema } from "effect"

/** Runtime configuration needed by the API composition root. */
export interface RuntimeConfiguration {
  /** The optional service-owned GitHub credential; activity requests require it. */
  readonly githubToken: Option.Option<Redacted.Redacted>
  /** The optional cursor-signing secret reserved for later slices. */
  readonly cursorSecret: Option.Option<Redacted.Redacted>
  /** The configured documentation site used by the operational redirect. */
  readonly docsUrl: URL
  /** The official GitHub API base URL. */
  readonly githubBaseUrl: URL
  /** A stable, non-secret user agent sent to GitHub. */
  readonly githubUserAgent: string
}

/** Typed configuration service for the API worker. */
export class Configuration extends Context.Service<Configuration, RuntimeConfiguration>()(
  "@kronik/api/Configuration",
) {}

/** Decode API configuration without making operational routes depend on activity credentials. */
export const configurationLayer = Layer.effect(
  Configuration,
  Effect.gen(function* () {
    const githubToken = yield* Config.option(
      Config.schema(
        Schema.RedactedFromValue(Schema.NonEmptyString, { disallowEncode: true }),
        "GITHUB_TOKEN",
      ),
    )
    const cursorSecret = yield* Config.option(Config.redacted("CURSOR_SECRET"))
    const docsUrl = yield* Config.url("DOCS_URL").pipe(
      Config.withDefault(new URL("http://localhost:3001")),
    )
    const githubBaseUrl = yield* Config.url("GITHUB_BASE_URL").pipe(
      Config.withDefault(new URL("https://api.github.com")),
    )
    const githubUserAgent = yield* Config.string("GITHUB_USER_AGENT").pipe(
      Config.withDefault("kronik"),
    )

    return Configuration.of({
      githubToken,
      cursorSecret,
      docsUrl,
      githubBaseUrl,
      githubUserAgent,
    })
  }),
)

/** The configuration layer retained as the package's default layer name. */
export const layer = configurationLayer

/** A deterministic provider for tests and local composition checks. */
export const testProvider = (values: Readonly<Record<string, unknown>>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values))
