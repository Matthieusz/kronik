# Kronik

Kronik presents a GitHub user’s public development activity as portfolio-friendly summaries.

## Language

**Requested User**:
The canonical GitHub account whose public activity Kronik reports. GitHub usernames are case-insensitive, but responses use GitHub’s current canonical login.
_Avoid_: Kronik user, account

**GitHub Activity**:
A GitHub user’s public default-branch commits across repositories of any owner, repository-language composition, and contribution streak information.
_Avoid_: GitHub stats, profile data

**Commit Summary**:
A public default-branch commit whose primary author GitHub resolves to the requested user, together with its repository, change counts, message, date, and identifier. Merely committing, merging, or appearing in a co-author trailer does not qualify.
_Avoid_: Commit event

**Activity Window**:
The inclusive calendar-date range used to select commits for aggregate statistics and repository language analysis. It defaults to the trailing 30 days and cannot exceed 90 days.
_Avoid_: Reporting period

**Activity Summary**:
Aggregate commit-change totals and repository language analysis for up to 100 matching commits in an Activity Window. Its coverage states whether every match was included; partial aggregates are never presented as complete totals.
_Avoid_: User statistics

**Repository Language Breakdown**:
GitHub’s language-byte composition for the unique repositories containing the requested user’s matching commits within an Activity Window. It does not represent code personally authored by that user.
_Avoid_: User languages, language proficiency

**Contribution Streak**:
A consecutive run of GitHub contribution-calendar dates on which the requested user has at least one contribution. A longest streak is bounded to the evaluated trailing 365-day calendar and is not an all-time record.
_Avoid_: Commit streak, highest streak
