# Ara

Ara turns the work you actually did in a code repository into a written
build-in-public post, so that shipping something and telling people about it
stop being two separate chores.

## Language

**Digest**:
The factual, prose-free record of what happened in a repository during one Day
Window: which commits, which pull requests, which areas of the codebase. Covers
every branch, and dates a commit by when it was written rather than by when it
landed (ADR-0006). Derived from the Forge alone, with no language model
involved.
_Avoid_: Summary, report, activity log

**Draft**:
The written build-in-public post generated from a Digest. Prose, in the User's
voice, meant to be read and edited by a human before it goes anywhere. Takes one
of two shapes depending on how much the Digest contains: a full Draft, or a
Quiet Draft.
_Avoid_: Post, article, content, output

**Quiet Draft**:
The shape a Draft takes on a Quiet Day: a few honest sentences saying the day was
light, rather than a full-length post stretched over thin material.

**Activity**:
A single unit of recorded work in a repository that a Digest is built from: a
commit, a pull request opened, a pull request merged.
_Avoid_: Event, change, contribution

**Day Window**:
The span of time a Digest covers: one calendar day in the User's own timezone,
not a rolling 24 hours and not UTC.
_Avoid_: Today, period, range

**Quiet Day**:
A Day Window whose Activity is too slight to carry a full Draft. A normal part of
building, not a failure, and never a reason to pad a Draft with invention.

**Run**:
One attempt to go from a repository and a Day Window to a Draft. Carries its own
outcome, so a User can be told what happened without reading logs.
_Avoid_: Job, task, execution

**Trigger**:
What caused a Run to start: the User asking for one, or the schedule firing.

**Forge**:
A hosting service that repositories and their Activity live on. GitHub today,
GitLab and others later. Ara reads Activity the same way from every Forge, but
authorizes against each one on its own terms.
_Avoid_: Provider, platform, VCS, Git host

**Repo Connection**:
A User's authorized link to one repository on one Forge. Owning the connection is
what entitles a User to Digests and Drafts for that repository.
_Avoid_: Repo, project, integration

**User**:
The person whose work is being written about, and whose voice the Draft imitates.
_Avoid_: Account, author, customer
