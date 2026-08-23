# The Digest reads every branch, and a commit belongs to the day it was authored

A Digest covers **every branch** of the repository, not the default branch, and
a commit counts on the day of its **author date** rather than its committer
date.

Reading only the default branch was never decided; it was GitHub's default for
`GET /repos/{owner}/{repo}/commits` when no `sha` is given, and it silently cost
Ara most of a day's work. On 2026-08-23 this repository had 21 commits, 16 of
them on `feat/mvp-day-to-draft`; the Digest reported the 5 that were on `main`
and the Draft honestly described a day nobody had lived. Working on a branch is
the normal case, so this is the normal case being wrong.

## Considered Options

**Branch fan-out (chosen).** List the repository's branches, then ask for
commits on each with `sha=<branch>`, and merge the answers. One GitHub surface —
the ordinary commits API the adapter already reads — strongly consistent, and
no new failure mode to classify. The cost is a listing per branch on top of the
two calls a day used to take, which is why the branch set is bounded (see
below).

**`/search/commits?q=repo:X committer-date:…`.** One call for every branch at
once, and tempting for that alone. Rejected: the Search API has its own much
tighter budget (30 requests a minute, and not the per-installation quota
ADR-0005 was chosen for), it is eventually consistent — so a Run at the end of
the day can miss commits pushed an hour ago — and it is a second GitHub surface
with its own shapes and refusals for the adapter to depend on.

**Events API.** Closest in spirit to "what did this person do today", but
retains only 90 days, is scoped to an actor or a repository rather than to a Day
Window, and would not answer at all for a Digest rebuilt for an older day.

## What a day contains

**Every branch, not every author.** A Digest stays "what happened in this
repository during this Day Window". Scoping it to "what *I* did" is a real
product question and a defensible one, but it is a separate decision: it needs
the User's Forge login on the Repo Connection, and it would change what a Digest
means for a repository with more than one contributor. Bot Activity is already
excluded when the Digest is built, which removes the noise that made the
narrower scoping attractive.

**Bounded at 50 branches**, in one page, in the order GitHub lists them. A Run
is not entitled to unbounded reads of a repository with hundreds of stale
branches, and the ceiling belongs beside the existing ones on pages and commits.
A repository that outgrows it loses branches it was not committing to anyway; if
that turns out to be wrong, the fix is a smarter branch set, not a larger `N`.

**The default branch is asked for by name**, at the cost of one more call, and
put at the head of that 50. GitHub lists branches alphabetically, so a
repository with fifty branches sorted before `main` would otherwise lose the one
branch Ara could already read — this decision must never make a day worse than
the day it is fixing.

## Counting a commit once

Three things stop the same work being counted twice, and each covers a case the
others do not.

**Across branches, within one day: the sha.** Every branch that has `main`'s
history in it answers with `main`'s commits too. Commits are deduplicated by sha
after the fan-out, so a commit reachable from ten branches is one commit.

**Across days, when a branch is merged: the merge commit is excluded.** A true
merge does not rewrite the branch's commits, so their committer dates keep them
in the day they were made and no later Day Window asks for them. The merge
commit itself has two parents and is dropped when the Digest is built — a rule
that predates this decision and now carries more weight, because the branch
commits it would otherwise stand in for are already in the Digest of the day
they were written.

**Across days, when a branch is squashed or rebased: the author date.** A squash
or rebase produces new shas with *today's* committer date and the *original*
author date. Reading membership from the committer date would report a week of
branch work again on the day it landed. The author date is stable across
rebases, squashes and cherry-picks, and it is the honest answer to "when was
this work done".

## Consequences

Reading a day costs one call for the branch list, then a paged commit listing
per branch, then one detail call per distinct commit — instead of the two-call
listing it was. Every one of them is spent against the installation's own budget
(ADR-0005) through the same limiter as before, and each is bounded: 50 branches,
5 pages a branch, 200 commits in a day. Deduplication happens before the detail
reads, so the branches sharing a history cost list calls and nothing more.

The commit ceiling is spent before the Digest's own rules are applied. Merge
commits and bot commits are excluded when the Digest is built, deliberately, and
the fan-out now finds more of both; on a day over 200 commits some of that
ceiling therefore goes on commits the Digest then drops. Moving those rules into
the adapter would buy a rare day some accuracy at the price of the boundary that
keeps them testable without a network (ADR-0003), which is not a trade worth
making until a real day hits the ceiling.

Commits are still asked for with GitHub's `since`/`until`, which filter on the
committer date, and membership is then decided by author date. Work authored
inside the Day Window but first pushed after it, with its committer date
rewritten, is therefore never reported: it was invisible to the Forge on the day
it was written and belongs to no later day either. Unpushed work is invisible to
any Forge read, so this loses nothing that was ever available.

Nothing about ADR-0004 changes. The branch fan-out asks the same two questions
of each branch — what was committed, and which files it touched — and no diff is
decoded, held or stored.
