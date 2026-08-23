import { Schema } from "effect"
import { Repository } from "./repository.ts"
import { UserId } from "./user.ts"

export const RepoConnectionId = Schema.UUID.pipe(Schema.brand("RepoConnectionId"))
export type RepoConnectionId = typeof RepoConnectionId.Type

/**
 * A User's authorized link to one repository on one Forge. Owning the
 * connection is what entitles a User to Digests and Drafts for that repository,
 * so every Run starts by proving one of these exists.
 *
 * What is stored is a reference to the authorization — which installation the
 * repository is reachable through — never a credential. The token that actually
 * reads the repository is minted from that reference when it is needed
 * (ADR-0005).
 */
export class RepoConnection extends Schema.Class<RepoConnection>("RepoConnection")({
  id: RepoConnectionId,
  userId: UserId,
  repository: Repository,
  installationExternalId: Schema.String,
  connectedAt: Schema.DateTimeUtc
}) {}

/**
 * Ara cannot read the repository on this User's behalf: they have installed the
 * App nowhere, or installed it somewhere that does not include this repository.
 * The reason is written to be read by the person who asked.
 */
export class RepositoryNotReachable extends Schema.TaggedError<RepositoryNotReachable>()("RepositoryNotReachable", {
  reason: Schema.String
}) {}

/**
 * There is no such Repo Connection *for this User*. Deliberately one failure
 * for two situations — it never existed, or it belongs to someone else — so
 * that asking about another User's connection cannot confirm it exists.
 */
export class RepoConnectionNotFound extends Schema.TaggedError<RepoConnectionNotFound>()(
  "RepoConnectionNotFound",
  {}
) {}
