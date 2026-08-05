export * as ActivityRpc from "./rpc.js"

import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { DomainErrors } from "./errors.js"
import {
  ActivitySummary,
  CommitPage,
  ContributionStreak,
  GitHubUsername,
  LatestCommit,
} from "./model.js"

const commits = Rpc.make("commits", {
  payload: {
    username: GitHubUsername,
    limit: Schema.Number,
    cursor: Schema.optionalKey(Schema.String),
  },
  success: CommitPage,
  error: DomainErrors,
})
const latestCommit = Rpc.make("latestCommit", {
  payload: { username: GitHubUsername },
  success: LatestCommit,
  error: DomainErrors,
})
const summary = Rpc.make("summary", {
  payload: {
    username: GitHubUsername,
    from: Schema.optionalKey(Schema.String),
    to: Schema.optionalKey(Schema.String),
  },
  success: ActivitySummary,
  error: DomainErrors,
})
const streak = Rpc.make("streak", {
  payload: { username: GitHubUsername },
  success: ContributionStreak,
  error: DomainErrors,
})

/** Schema-validated Worker-to-Durable-Object activity procedures. */
export class Rpcs extends RpcGroup.make(commits, latestCommit, summary, streak) {}
