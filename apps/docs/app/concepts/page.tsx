import type { Metadata } from "next"
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page"

export const metadata: Metadata = {
  title: "Concepts",
  description: "Scope, coverage, caching, and credential semantics for Kronik v1.",
}

const toc = [
  { title: "Commit scope and attribution", url: "#commit-scope", depth: 2 },
  { title: "Pagination", url: "#pagination", depth: 2 },
  { title: "Activity windows and coverage", url: "#activity-windows", depth: 2 },
  { title: "Contribution streaks", url: "#contribution-streaks", depth: 2 },
  { title: "Delivery and errors", url: "#delivery-and-errors", depth: 2 },
  { title: "GitHub credentials", url: "#github-credentials", depth: 2 },
]

/** The conceptual documentation for Kronik's bounded v1 behavior. */
export default function ConceptsPage() {
  return (
    <DocsPage toc={toc}>
      <DocsBody>
        <DocsTitle>How Kronik interprets GitHub activity</DocsTitle>
        <DocsDescription>
          The rules behind attribution, pagination, coverage, delivery, and the data returned by
          Kronik v1.
        </DocsDescription>

        <h2 id="commit-scope">Commit scope and attribution</h2>
        <p>
          Kronik searches public default branches across repositories owned by anyone. A commit is
          included only when GitHub resolves the requested user as its primary author. A co-author,
          merger, or commit appearance alone does not qualify.
        </p>
        <p>
          Responses use the canonical GitHub login. Parent values are the actual commit graph
          references, not inferred links. Messages contain a headline and body; bodies over 8 KiB
          are bounded at both edges without splitting Unicode and are marked <code>bodyTruncated</code>.
        </p>

        <h2 id="pagination">Pagination</h2>
        <p>
          The first commit-feed request chooses a page size from 1 through 100, defaulting to 10.
          Continuations use only an opaque, authenticated cursor. A cursor is bound to its user and
          direction, preserves the initial snapshot, and expires after one hour. GitHub&apos;s
          searchable 1,000-result boundary is not presented as an unlimited feed.
        </p>

        <h2 id="activity-windows">Activity windows and coverage</h2>
        <p>
          Activity windows are inclusive UTC dates. The default is today plus the previous 29 dates;
          an explicit window may contain at most 90 dates. Summaries aggregate at most 100 matching
          commits and expose matched versus aggregated counts. When GitHub reports more matches or
          an incomplete search, coverage is partial and <code>complete</code> is false.
        </p>
        <p>
          Repository Language Breakdown uses exact GitHub language bytes for unique repositories
          containing matching commits. It does not describe code personally authored by the user or
          language proficiency. The top 20 entries are retained and omitted bytes remain in
          <code>otherBytes</code>.
        </p>

        <h2 id="contribution-streaks">Contribution streaks</h2>
        <p>
          Streaks use GitHub&apos;s contribution calendar over the represented trailing 365-day UTC
          range. An empty cell for today is ignored once, so yesterday&apos;s contribution can remain
          current; an earlier empty date ends the current streak. The longest streak is bounded to
          this range and is not an all-time record.
        </p>

        <h2 id="delivery-and-errors">Delivery and errors</h2>
        <p>
          Successful activity responses are edge-cacheable with route-specific freshness: 60 seconds
          for commits and five minutes for summaries and streaks. Responses identify <code>hit</code>,
          <code>miss</code>, or <code>stale</code> cache state, include an age and ETag, and support
          conditional requests with <code>304 Not Modified</code>. Eligible stale successes carry
          <code>Warning: 110 - &quot;Response is stale&quot;</code>.
        </p>
        <p>
          Anonymous callers are protected by approximate per-location, per-IP rate limiting. A
          denied request returns <code>429</code> and <code>Retry-After</code>; limiter failures fail
          open. Public failures use stable <code>application/problem+json</code> details and a
          request-scoped instance. Internal tags, provider bodies, credentials, cursors, and raw IP
          addresses are not exposed.
        </p>

        <h2 id="github-credentials">GitHub credentials</h2>
        <p>
          Kronik owns one least-privilege GitHub service credential. Callers never submit personal
          access tokens. GitHub attribution and the bounded cache, aggregation, and public rate
          policy determine what Kronik can report; the API does not claim all branches, all-time
          streaks, complete totals for partial coverage, personal language proficiency, or Katib wire
          compatibility.
        </p>

        <p>
          <a href="/api-reference">Browse the generated API reference →</a>
        </p>
      </DocsBody>
    </DocsPage>
  )
}
