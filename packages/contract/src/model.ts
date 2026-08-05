export * as Model from "./model.js"

import { Schema } from "effect"

const IsoDatePattern = /^\d{4}-\d{2}-\d{2}$/
const IsoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const GitHubUsernamePattern = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/
const ShaPattern = /^[0-9a-f]{40}$/

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

/** An opaque, authenticated pagination cursor. */
export const Cursor = Schema.String.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.brand("Cursor"),
).annotate({
  identifier: "Cursor",
})
export type Cursor = typeof Cursor.Type

/** An inclusive ISO calendar date. */
export const IsoDate = Schema.String.pipe(
  Schema.check(Schema.isPattern(IsoDatePattern)),
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
  url: Schema.String,
  avatarUrl: Schema.String,
}).annotate({ identifier: "User" })
export interface User extends Schema.Schema.Type<typeof User> {}

/** A public GitHub repository reference. */
export const Repository = Schema.Struct({
  nameWithOwner: Schema.String,
  url: Schema.String,
}).annotate({ identifier: "Repository" })
export interface Repository extends Schema.Schema.Type<typeof Repository> {}

/** A reference to an actual parent in the Git commit graph. */
export const CommitParent = Schema.Struct({
  sha: CommitSha,
  url: Schema.String,
}).annotate({ identifier: "CommitParent" })
export interface CommitParent extends Schema.Schema.Type<typeof CommitParent> {}

/** A bounded public default-branch commit attributed to the requested user. */
export const CommitSummary = Schema.Struct({
  sha: CommitSha,
  url: Schema.String,
  repository: Repository,
  headline: Schema.String,
  body: Schema.String,
  bodyTruncated: Schema.Boolean,
  authoredAt: IsoTimestamp,
  committedAt: IsoTimestamp,
  additions: Schema.Natural,
  deletions: Schema.Natural,
  changedLines: Schema.Natural,
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
}).annotate({ identifier: "ActivityWindow" })
export interface ActivityWindow extends Schema.Schema.Type<typeof ActivityWindow> {}

/** Evidence describing whether an aggregate covers every matching commit. */
export const ActivityCoverage = Schema.Struct({
  complete: Schema.Boolean,
  matchedCommits: Schema.Natural,
  aggregatedCommits: Schema.Natural,
}).annotate({ identifier: "ActivityCoverage" })
export interface ActivityCoverage extends Schema.Schema.Type<typeof ActivityCoverage> {}

/** Exact aggregate change counts over the commits covered by an activity summary. */
export const ActivityTotals = Schema.Struct({
  commits: Schema.Natural,
  additions: Schema.Natural,
  deletions: Schema.Natural,
  changedLines: Schema.Natural,
}).annotate({ identifier: "ActivityTotals" })
export interface ActivityTotals extends Schema.Schema.Type<typeof ActivityTotals> {}

/** One exact language-byte contribution to the repository language breakdown. */
export const Language = Schema.Struct({
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  bytes: Schema.Natural,
  percentage: Schema.Number,
}).annotate({ identifier: "Language" })
export interface Language extends Schema.Schema.Type<typeof Language> {}

/** A bounded aggregate of public commit changes and repository languages. */
export const ActivitySummary = Schema.Struct({
  user: User,
  window: ActivityWindow,
  coverage: ActivityCoverage,
  totals: ActivityTotals,
  languages: Schema.Array(Language),
  otherBytes: Schema.Natural,
}).annotate({ identifier: "ActivitySummary" })
export interface ActivitySummary extends Schema.Schema.Type<typeof ActivitySummary> {}

/** Contribution streaks evaluated over the trailing 365-day GitHub calendar. */
export const ContributionStreak = Schema.Struct({
  user: User,
  from: IsoDate,
  to: IsoDate,
  currentStreak: Schema.Natural,
  longestStreak: Schema.Natural,
  active: Schema.Boolean,
}).annotate({ identifier: "ContributionStreak" })
export interface ContributionStreak extends Schema.Schema.Type<typeof ContributionStreak> {}

/** Public health response independent of GitHub availability. */
export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
}).annotate({ identifier: "Health" })
export interface Health extends Schema.Schema.Type<typeof Health> {}
