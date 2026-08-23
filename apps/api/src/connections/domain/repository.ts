import { Schema } from "effect"
import { Forge } from "./forge.ts"

/**
 * A repository on a Forge. Identity is `(forge, owner, name)` and never
 * `owner/name` (ADR-0003): the same `owner/name` on GitHub and on GitLab are two
 * different repositories, and the day a second Forge arrives no row should have
 * to be re-parsed to say which one it came from.
 */
export class Repository extends Schema.Class<Repository>("Repository")({
  forge: Forge,
  owner: Schema.NonEmptyString,
  name: Schema.NonEmptyString
}) {}

/**
 * Whether two identities name the same repository. Forges treat owner and name
 * case-insensitively, so `Octocat/Hello-World` and `octocat/hello-world` are one
 * repository and must not become two Repo Connections.
 */
export const sameRepository = (left: Repository, right: Repository): boolean =>
  left.forge === right.forge &&
  left.owner.toLowerCase() === right.owner.toLowerCase() &&
  left.name.toLowerCase() === right.name.toLowerCase()

/**
 * A repository an installation can currently reach, as the Forge spells it.
 * `isPrivate` is carried because connecting a private repository is the point
 * (ADR-0005): a User should be able to see that Ara really can read it.
 */
export class ReachableRepository extends Schema.Class<ReachableRepository>("ReachableRepository")({
  repository: Repository,
  isPrivate: Schema.Boolean,
  /** The installation the repository is reachable through, e.g. GitHub's numeric id. */
  installationExternalId: Schema.String
}) {}
