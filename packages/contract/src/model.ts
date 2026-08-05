export * as Model from "./model.js"

import { Schema } from "effect"

const IsoDatePattern = /^\d{4}-\d{2}-\d{2}$/
const IsoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const GitHubUsernamePattern = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/
const ShaPattern = /^[0-9a-f]{40}$/
const HttpUrlPattern = /^https?:\/\/[^\s]+$/
const MaxSafeInteger = Number.MAX_SAFE_INTEGER
const MaxUtf8Bytes = 8192

const isCalendarDate = (value: string): boolean => {
  const match = IsoDatePattern.exec(value)
  if (match === null) return false
  const year = Number.parseInt(value.slice(0, 4), 10)
  const month = Number.parseInt(value.slice(5, 7), 10)
  const day = Number.parseInt(value.slice(8, 10), 10)
  if (month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= (daysInMonth[month - 1] ?? 0)
}

const HttpUrl = Schema.String.pipe(Schema.check(Schema.isPattern(HttpUrlPattern))).annotate({
  format: "uri",
})
const SafeNatural = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 0, maximum: MaxSafeInteger })),
)
const BoundedUtf8String = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => new TextEncoder().encode(value).length <= MaxUtf8Bytes),
  ),
)

/** A syntactically valid GitHub username supplied at the HTTP boundary. */
export const GitHubUsername = Schema.String.pipe(
  Schema.check(Schema.isPattern(GitHubUsernamePattern)),
  Schema.brand("GitHubUsername"),
).annotate({ identifier: "GitHubUsername" })
export type GitHubUsername = typeof GitHubUsername.Type

/** A full Git commit SHA-1 identifier. */
export const CommitSha = Schema.String.pipe(
  Schema.check(Schema.isPattern(ShaPattern)),
  Schema.brand("CommitSha"),
).annotate({
  identifier: "CommitSha",
})
export type CommitSha = typeof CommitSha.Type

/** An opaque pagination cursor validated by the application cursor authority. */
export const Cursor = Schema.String.pipe(Schema.brand("Cursor")).annotate({
  identifier: "Cursor",
})
export type Cursor = typeof Cursor.Type

/** An inclusive, calendar-valid ISO date. */
export const IsoDate = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isCalendarDate)),
  Schema.brand("IsoDate"),
).annotate({
  identifier: "IsoDate",
})
export type IsoDate = typeof IsoDate.Type

/** An RFC 3339 timestamp normalized to UTC. */
export const IsoTimestamp = Schema.String.pipe(
  Schema.check(Schema.isPattern(IsoTimestampPattern)),
  Schema.brand("IsoTimestamp"),
).annotate({ identifier: "IsoTimestamp" })
export type IsoTimestamp = typeof IsoTimestamp.Type

/** The canonical public GitHub identity attached to a Kronik response. */
export const User = Schema.Struct({
  login: GitHubUsername,
  url: HttpUrl,
  avatarUrl: HttpUrl,
}).annotate({ identifier: "User" })
export interface User extends Schema.Schema.Type<typeof User> {}

/** A public GitHub repository reference. */
export const Repository = Schema.Struct({
  nameWithOwner: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  url: HttpUrl,
}).annotate({ identifier: "Repository" })
export interface Repository extends Schema.Schema.Type<typeof Repository> {}

/** A reference to an actual parent in the Git commit graph. */
export const CommitParent = Schema.Struct({
  sha: CommitSha,
  url: HttpUrl,
}).annotate({ identifier: "CommitParent" })
export interface CommitParent extends Schema.Schema.Type<typeof CommitParent> {}

/** A bounded public default-branch commit attributed to the requested user. */
export const CommitSummary = Schema.Struct({
  sha: CommitSha,
  url: HttpUrl,
  repository: Repository,
  headline: BoundedUtf8String,
  body: BoundedUtf8String,
  bodyTruncated: Schema.Boolean,
  authoredAt: IsoTimestamp,
  committedAt: IsoTimestamp,
  additions: SafeNatural,
  deletions: SafeNatural,
  changedLines: SafeNatural,
  parents: Schema.Array(CommitParent),
}).annotate({ identifier: "CommitSummary" })
export interface CommitSummary extends Schema.Schema.Type<typeof CommitSummary> {}

/** A bounded, bidirectional page whose cursors are meaningful only to Kronik. */
export const CommitPage = Schema.Struct({
  user: User,
  items: Schema.Array(CommitSummary),
  previous: Schema.NullOr(Cursor),
  next: Schema.NullOr(Cursor),
}).annotate({ identifier: "CommitPage" })
export interface CommitPage extends Schema.Schema.Type<typeof CommitPage> {}

/** A required latest-commit lookup result. */
export const LatestCommit = Schema.Struct({
  user: User,
  commit: CommitSummary,
}).annotate({ identifier: "LatestCommit" })
export interface LatestCommit extends Schema.Schema.Type<typeof LatestCommit> {}

/** The inclusive calendar range used for activity aggregation. */
export const ActivityWindow = Schema.Struct({
  from: IsoDate,
  to: IsoDate,
})
  .pipe(
    Schema.check(
      Schema.makeFilter((value: { readonly from: string; readonly to: string }) => {
        const span =
          (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) /
            86_400_000 +
          1
        return span >= 1 && span <= 90
      }),
    ),
  )
  .annotate({ identifier: "ActivityWindow" })
export interface ActivityWindow extends Schema.Schema.Type<typeof ActivityWindow> {}

/** Evidence describing whether an aggregate covers every matching commit. */
export const ActivityCoverage = Schema.Struct({
  complete: Schema.Boolean,
  matchedCommits: SafeNatural,
  aggregatedCommits: SafeNatural,
}).annotate({ identifier: "ActivityCoverage" })
export interface ActivityCoverage extends Schema.Schema.Type<typeof ActivityCoverage> {}

/** Exact aggregate change counts over the commits covered by an activity summary. */
export const ActivityTotals = Schema.Struct({
  commits: SafeNatural,
  additions: SafeNatural,
  deletions: SafeNatural,
  changedLines: SafeNatural,
}).annotate({ identifier: "ActivityTotals" })
export interface ActivityTotals extends Schema.Schema.Type<typeof ActivityTotals> {}

/** One exact language-byte contribution to the repository language breakdown. */
export const Language = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  color: Schema.NullOr(Schema.String),
  bytes: SafeNatural,
  percentage: Schema.Number.pipe(
    Schema.check(Schema.isFinite()),
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ),
}).annotate({ identifier: "Language" })
export interface Language extends Schema.Schema.Type<typeof Language> {}

/** A bounded aggregate of public commit changes and repository languages. */
export const ActivitySummary = Schema.Struct({
  user: User,
  window: ActivityWindow,
  coverage: ActivityCoverage,
  totals: ActivityTotals,
  languages: Schema.Array(Language).pipe(
    Schema.check(Schema.makeFilter((languages: ReadonlyArray<Language>) => languages.length <= 20)),
  ),
  otherBytes: SafeNatural,
}).annotate({ identifier: "ActivitySummary" })
export interface ActivitySummary extends Schema.Schema.Type<typeof ActivitySummary> {}

/** Contribution streaks evaluated over exactly the trailing 365-day GitHub calendar. */
const StreakCount = SafeNatural.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 365 })))
export const ContributionStreak = Schema.Struct({
  user: User,
  from: IsoDate,
  to: IsoDate,
  currentStreak: StreakCount,
  longestStreak: StreakCount,
  active: Schema.Boolean,
})
  .pipe(
    Schema.check(
      Schema.makeFilter(
        (value: {
          readonly from: string
          readonly to: string
          readonly currentStreak: number
          readonly longestStreak: number
          readonly active: boolean
        }) => {
          const span =
            (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) /
              86_400_000 +
            1
          return (
            span === 365 &&
            value.currentStreak <= value.longestStreak &&
            value.active === value.currentStreak > 0
          )
        },
      ),
    ),
  )
  .annotate({ identifier: "ContributionStreak" })
export interface ContributionStreak extends Schema.Schema.Type<typeof ContributionStreak> {}

/** Public health response independent of GitHub availability. */
export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
}).annotate({ identifier: "Health" })
export interface Health extends Schema.Schema.Type<typeof Health> {}
