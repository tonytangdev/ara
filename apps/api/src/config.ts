import { Config, Duration } from "effect"

export const ServerConfig = Config.all({
  port: Config.port("PORT").pipe(Config.withDefault(3000)),
  host: Config.string("HOST").pipe(Config.withDefault("0.0.0.0"))
})

/**
 * Connection details for the application's Postgres. Deliberately has no
 * default for the credentials: an unconfigured deployment should fail to boot
 * rather than quietly try a well-known password.
 */
export const DatabaseConfig = Config.all({
  host: Config.string("DATABASE_HOST").pipe(Config.withDefault("localhost")),
  port: Config.port("DATABASE_PORT").pipe(Config.withDefault(5432)),
  database: Config.string("DATABASE_NAME"),
  username: Config.string("DATABASE_USER"),
  password: Config.redacted("DATABASE_PASSWORD"),
  ssl: Config.boolean("DATABASE_SSL").pipe(Config.withDefault(false))
})

/**
 * The GitHub App Ara authorizes as (ADR-0005). Sign-in identity and repository
 * access both run through this one App: the client credentials identify a
 * person, the private key mints short-lived installation tokens. Every secret
 * is `Config.redacted`, so it prints as `<redacted>` if it ever reaches a log.
 */
export const GithubAppConfig = Config.all({
  appId: Config.string("GITHUB_APP_ID"),
  clientId: Config.string("GITHUB_APP_CLIENT_ID"),
  clientSecret: Config.redacted("GITHUB_APP_CLIENT_SECRET"),
  privateKey: Config.redacted("GITHUB_APP_PRIVATE_KEY"),
  apiBaseUrl: Config.string("GITHUB_API_BASE_URL").pipe(Config.withDefault("https://api.github.com")),
  webBaseUrl: Config.string("GITHUB_WEB_BASE_URL").pipe(Config.withDefault("https://github.com"))
})

/**
 * How a signed-in person is remembered, and where the browser is sent once the
 * Forge hands them back.
 */
export const SessionConfig = Config.all({
  lifetime: Config.duration("SESSION_LIFETIME").pipe(Config.withDefault(Duration.days(30))),
  /** Off only for plain-HTTP local development; the cookie is `Secure` everywhere else. */
  secureCookies: Config.boolean("SESSION_SECURE_COOKIES").pipe(Config.withDefault(true)),
  afterSignInUrl: Config.string("AFTER_SIGN_IN_URL").pipe(Config.withDefault("/v1/me"))
})

/**
 * The key protecting Forge credentials at rest: 32 bytes, base64. Like the
 * database password it has no default, because a well-known encryption key is
 * indistinguishable from no encryption at all.
 */
export const EncryptionConfig = Config.all({
  key: Config.redacted("CREDENTIAL_ENCRYPTION_KEY")
})

/**
 * The background worker. `WORKER_ENABLED` exists so that the API and the worker
 * can be run as two processes the day one machine is not enough, without either
 * of them becoming a different program.
 */
export const WorkerConfig = Config.all({
  enabled: Config.boolean("WORKER_ENABLED").pipe(Config.withDefault(true)),
  /** How long to wait after finding the queue empty. Runs are rare; latency is cheap. */
  pollInterval: Config.duration("WORKER_POLL_INTERVAL").pipe(Config.withDefault(Duration.seconds(1)))
})

/**
 * How a Run recovers.
 *
 * One policy for the whole Run rather than one per stage, because the ceiling
 * has to mean something: two stages retrying five times each is twenty-five
 * attempts, and the Forge reads and model calls that go with them. A Run gets
 * `maxAttempts` attempts in total, wherever it keeps stopping.
 */
export const RunConfig = Config.all({
  /** Total attempts, not retries. Five is the spec's ceiling for a transient failure. */
  maxAttempts: Config.integer("RUN_MAX_ATTEMPTS").pipe(Config.withDefault(5)),
  /** The first backoff; each attempt doubles it, with jitter. */
  retryBaseDelay: Config.duration("RUN_RETRY_BASE_DELAY").pipe(Config.withDefault(Duration.seconds(2))),
  /** Where doubling stops. A Run is not in a hurry, but nor is anybody waiting an hour. */
  retryMaxDelay: Config.duration("RUN_RETRY_MAX_DELAY").pipe(Config.withDefault(Duration.minutes(2)))
})

/**
 * How a Digest is built. Both numbers are thresholds a Day Window has to stay
 * *under* to count as a Quiet Day: fewer than three commits and under fifty
 * changed lines. They are configuration rather than constants because the
 * initial values are a guess, and the honest way to correct a guess is to
 * watch it fire a few times and move it.
 */
export const DigestConfig = Config.all({
  quietBelowCommits: Config.integer("DIGEST_QUIET_BELOW_COMMITS").pipe(Config.withDefault(3)),
  quietBelowChangedLines: Config.integer("DIGEST_QUIET_BELOW_CHANGED_LINES").pipe(Config.withDefault(50))
})

/**
 * How a Draft is written. The model is named here and nowhere else: which model
 * wrote a Draft is a question a User can ask of the answer (#31), and comparing
 * two models has to be a deployment change rather than an edit.
 *
 * Retrying a model that answered with nothing is not configured here: it is one
 * of the transient failures a Run recovers from, and the bound on it belongs to
 * the Run — see `RunConfig`.
 */
export const DraftConfig = Config.all({
  model: Config.string("DRAFT_MODEL").pipe(Config.withDefault("moonshotai/kimi-k3"))
})

/**
 * Where the model is reached. Provider-specific and deliberately separate from
 * `DraftConfig`: application code depends on the provider-agnostic language
 * model tag, and only the composition of the drafts module ever reads this.
 * Swapping OpenRouter for something else changes this block and one layer.
 */
export const ModelProviderConfig = Config.all({
  apiKey: Config.redacted("OPENROUTER_API_KEY"),
  apiUrl: Config.string("OPENROUTER_API_URL").pipe(Config.withDefault("https://openrouter.ai/api/v1"))
})
