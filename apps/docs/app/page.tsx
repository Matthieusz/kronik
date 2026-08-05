export default function HomePage() {
  return (
    <main>
      <p>Kronik v1</p>
      <h1>Public GitHub activity, presented clearly.</h1>
      <p>
        Kronik reports public default-branch activity attributed to a requested GitHub user.
      </p>
      <h2>Commit scope</h2>
      <p>
        Latest commits come from public default branches across repositories of any owner. A
        commit qualifies only when GitHub resolves the requested user as its primary author;
        co-authors and merge appearances do not qualify.
      </p>
      <p>
        Parents are the commit graph&apos;s actual parent references. Commit messages expose a
        headline and body; bodies over 8 KiB are Unicode-safe bounded at both edges and marked
        with <code>bodyTruncated</code>.
      </p>
      <p>
        A valid GitHub user with no matching commit is distinct from an absent user. Commits are
        ordered by committed time, not authored time, and Kronik uses a service-owned GitHub
        credential rather than caller tokens.
      </p>
      <h2>Commit pagination</h2>
      <p>
        An initial request may use <code>limit</code> from 1 through 100; it defaults to 10. For
        example, <code>GET /v1/users/octocat/commits?limit=25</code> returns opaque
        <code>previous</code> and <code>next</code> cursors when navigation is supported.
      </p>
      <p>
        Follow-up requests use only the returned cursor, such as
        <code>GET /v1/users/octocat/commits?cursor=...</code>. Cursors are authenticated,
        user-bound, directional, and expire after one hour. They preserve the initial snapshot,
        so commits arriving later do not shift an existing feed. GitHub&apos;s searchable 1,000-result
        boundary is never presented as an unlimited feed.
      </p>
      <h2>Activity Summary</h2>
      <p>
        Activity uses an inclusive UTC window: it defaults to today and the previous 29 dates, and
        explicit windows may span at most 90 dates. Kronik aggregates at most 100 matching commits
        and marks coverage partial when GitHub reports more matches or an incomplete search.
      </p>
      <p>
        Repository Language Breakdown uses GitHub&apos;s exact language bytes for unique repositories
        containing matching commits. It does not represent code personally authored or language
        proficiency; omitted languages are conserved in <code>otherBytes</code>.
      </p>
      <h2>Contribution Streak</h2>
      <p>
        Streaks use GitHub&apos;s contribution calendar over exactly the trailing 365 UTC dates. An
        empty cell for today is ignored once, so a contribution yesterday can remain the current
        streak; any earlier empty date breaks it. The longest streak is bounded to this represented
        range and is not an all-time record.
      </p>
      <p>
        <a href="/concepts">Read the conceptual guide</a>
      </p>
      <p>
        <a href="/api-reference">Open the generated API reference</a>
      </p>
    </main>
  )
}
