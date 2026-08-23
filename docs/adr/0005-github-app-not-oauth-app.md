# Authorize against GitHub as a GitHub App, not an OAuth App

Ara needs to read Activity from repositories that are often private, for many Users. An
OAuth App would be less work — one sign-in, one user-scoped token — but that token can read
every repository the User can see, which is far more blast radius than a product that only
needs a handful of repositories should be holding. We authorize as a **GitHub App** instead:
the User installs it on exactly the repositories they choose, and Ara holds short-lived
installation tokens rather than a broad long-lived user token.

## Considered options

- **OAuth App.** Simplest possible setup and the easiest local development story. Rejected:
  a single stolen token reads every private repository of every User, and the API rate limit
  is shared across the whole account rather than per installation.
- **Personal access tokens pasted by the User.** No callback URL, trivial to build. Rejected:
  pushes the security decision onto the User, who will almost always over-grant, and it makes
  onboarding a chore in a product whose entire point is removing chores.
- **GitHub App.** Chosen.

## Consequences

- Repository selection happens on GitHub's installation screen, not in Ara's UI. Ara lists
  what the installation can reach; it does not ask GitHub for everything the User owns.
- Rate limits are per installation, so one heavy User cannot exhaust everyone else's budget.
  This is what makes ticket 12's per-installation rate limiting meaningful.
- Local development needs a real GitHub App and a callback URL that reaches the developer's
  machine. This is the price paid; it is not a reason to fall back to an OAuth App.
- Installation tokens expire in an hour, so the adapter must mint and refresh them rather
  than reading a stored credential. Whatever *is* stored at rest is encrypted.
- Sign-in identity and repository access are separate concerns: a User can be signed in and
  have no installation. The API must handle that state rather than assuming it away.
- This decision sits **outside** the `RepoActivitySource` port, as ADR-0003 requires. GitLab
  will authorize on entirely different terms and must not be forced through GitHub's model.
