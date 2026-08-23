# The domain reads Activity from a Forge, not from GitHub

GitHub is the only Forge we support, but the driven port is named
`RepoActivitySource`, not `GitHubActivitySource`. The GitHub client is an adapter
behind it, mirroring how `SystemProbe` has a `ProcessSystemProbe` adapter.

Naming the port after the provider would mean that adding GitLab either renames a
port half the codebase imports, or ships a `GitHubActivitySource` that talks to
GitLab. Neither is acceptable, and the cost of getting it right now is one word.

## Consequences

Authorization deliberately does *not* go behind this port. GitHub has App
installations, GitLab has OAuth apps and project access tokens, and forcing one
abstraction over both would leak. `RepoActivitySource` is only about reading
Activity; credentials stay a Forge-specific concern. Repository identity is
therefore `(forge, owner, name)`, never `owner/name`.
