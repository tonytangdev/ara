import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi
} from "@effect/platform"
import { Schema } from "effect"
import { CurrentUser } from "./domain/current-user.ts"
import { Forge } from "./domain/forge.ts"

/** The cookie a signed-in browser carries. Opaque; the value is only a lookup key. */
export const SESSION_COOKIE = "ara_session"

/** Holds the CSRF state between leaving for GitHub and coming back. */
export const SIGN_IN_STATE_COOKIE = "ara_sign_in_state"

export const SessionSecurity = HttpApiSecurity.apiKey({ in: "cookie", key: SESSION_COOKIE })

/** Returned whenever a request has no usable session. Never says why. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 401 })
) {}

/** Sign-in could not be completed. The reason is safe to show; it never quotes a credential. */
export class SignInFailed extends Schema.TaggedError<SignInFailed>()(
  "SignInFailed",
  { reason: Schema.String },
  HttpApiSchema.annotations({ status: 400 })
) {}

/**
 * Endpoints that need a signed-in caller declare this middleware, which turns
 * the session cookie into a `CurrentUser`. A handler cannot opt out of it and
 * cannot see an unauthenticated request.
 */
export class SessionAuthentication extends HttpApiMiddleware.Tag<SessionAuthentication>()(
  "connections/SessionAuthentication",
  {
    provides: CurrentUser,
    failure: Unauthorized,
    security: { session: SessionSecurity }
  }
) {}

/** One App installation, as `GET /v1/me` reports it. */
export class InstallationResponse extends Schema.Class<InstallationResponse>("InstallationResponse")({
  forge: Forge,
  id: Schema.String,
  accountLogin: Schema.String
}) {}

/**
 * Who the caller is. `installations` being empty is a normal, complete answer:
 * the person is signed in and has not installed the App on anything yet.
 */
export class MeResponse extends Schema.Class<MeResponse>("MeResponse")({
  id: Schema.String,
  forge: Forge,
  login: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  installations: Schema.Array(InstallationResponse)
}) {}

/**
 * The connections module's HTTP contract: signing in with a Forge, and saying
 * who is signed in. Everything lives under `/v1`; the unversioned `/health`
 * stays where platform probes expect it.
 */
export class ConnectionsApiGroup extends HttpApiGroup.make("connections")
  .add(
    HttpApiEndpoint.get("startGithubSignIn", "/v1/auth/github")
      .addSuccess(HttpApiSchema.Empty(302))
      .annotate(OpenApi.Summary, "Redirect to GitHub to sign in")
  )
  .add(
    HttpApiEndpoint.get("completeGithubSignIn", "/v1/auth/github/callback")
      .setUrlParams(Schema.Struct({ code: Schema.String, state: Schema.String }))
      .addSuccess(HttpApiSchema.Empty(302))
      .addError(SignInFailed)
      .annotate(OpenApi.Summary, "GitHub sign-in callback")
  )
  .add(
    HttpApiEndpoint.get("recordGithubInstallation", "/v1/auth/github/installation")
      .setUrlParams(Schema.Struct({ installation_id: Schema.String }))
      .addSuccess(HttpApiSchema.Empty(302))
      .addError(SignInFailed)
      .middleware(SessionAuthentication)
      .annotate(OpenApi.Summary, "GitHub App installation callback")
  )
  .add(
    HttpApiEndpoint.get("me", "/v1/me")
      .addSuccess(MeResponse)
      .middleware(SessionAuthentication)
      .annotate(OpenApi.Summary, "The signed-in User")
  )
  .annotate(OpenApi.Description, "Signing in with a Forge, and who is signed in.") {}

/** One repository the caller's installation can reach, as the Forge spells it. */
export class ReachableRepositoryResponse extends Schema.Class<ReachableRepositoryResponse>(
  "ReachableRepositoryResponse"
)({
  forge: Forge,
  owner: Schema.String,
  name: Schema.String,
  isPrivate: Schema.Boolean,
  installationId: Schema.String
}) {}

/** What the caller has to say to connect a repository: its identity, per ADR-0003. */
export class ConnectRepositoryRequest extends Schema.Class<ConnectRepositoryRequest>("ConnectRepositoryRequest")({
  forge: Forge,
  owner: Schema.NonEmptyTrimmedString,
  name: Schema.NonEmptyTrimmedString
}) {}

/** One Repo Connection. Says which installation it reads through, never a credential. */
export class RepoConnectionResponse extends Schema.Class<RepoConnectionResponse>("RepoConnectionResponse")({
  id: Schema.String,
  forge: Forge,
  owner: Schema.String,
  name: Schema.String,
  installationId: Schema.String,
  connectedAt: Schema.DateTimeUtc
}) {}

/**
 * The repository cannot be reached through any of the caller's installations.
 * The reason names the next step, because the fix is on the Forge and only the
 * User can perform it.
 */
export class RepositoryNotConnectable extends Schema.TaggedError<RepositoryNotConnectable>()(
  "RepositoryNotConnectable",
  { reason: Schema.String },
  HttpApiSchema.annotations({ status: 422 })
) {}

/**
 * No such Repo Connection for the caller. The same answer whether it never
 * existed or belongs to somebody else, so a 404 confirms nothing.
 */
export class NoSuchRepoConnection extends Schema.TaggedError<NoSuchRepoConnection>()(
  "NoSuchRepoConnection",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

/**
 * Repo Connections: what a User has entitled Ara to write about.
 *
 * The whole group sits behind `SessionAuthentication`, so there is no endpoint
 * here that can be reached without a `CurrentUser` to scope it to. Every path
 * is implicitly "mine": the caller cannot name another User, and asking for a
 * connection that is not theirs is answered exactly as asking for one that does
 * not exist.
 */
export class RepoConnectionsApiGroup extends HttpApiGroup.make("repo-connections")
  .add(
    HttpApiEndpoint.get("listReachableRepositories", "/v1/repositories")
      .addSuccess(Schema.Array(ReachableRepositoryResponse))
      .addError(RepositoryNotConnectable)
      .annotate(OpenApi.Summary, "Repositories the caller's installations can reach")
  )
  .add(
    HttpApiEndpoint.post("connect", "/v1/repo-connections")
      .setPayload(ConnectRepositoryRequest)
      .addSuccess(RepoConnectionResponse, { status: 201 })
      .addError(RepositoryNotConnectable)
      .annotate(OpenApi.Summary, "Connect a repository")
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/repo-connections")
      .addSuccess(Schema.Array(RepoConnectionResponse))
      .annotate(OpenApi.Summary, "The caller's Repo Connections")
  )
  .add(
    HttpApiEndpoint.del("disconnect", "/v1/repo-connections/:id")
      .setPath(Schema.Struct({ id: Schema.UUID }))
      .addSuccess(HttpApiSchema.NoContent)
      .addError(NoSuchRepoConnection)
      .annotate(OpenApi.Summary, "Remove a Repo Connection")
  )
  .middleware(SessionAuthentication)
  .annotate(OpenApi.Description, "The repositories a User has entitled Ara to write about.") {}
