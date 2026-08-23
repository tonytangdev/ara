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
 * The attempt bounds belong to the Draft rather than to the provider, because
 * the failure they exist for is not the provider's fault: a model that answers
 * with reasoning and no content has returned a perfectly good HTTP 200.
 */
export const DraftConfig = Config.all({
  model: Config.string("DRAFT_MODEL").pipe(Config.withDefault("moonshotai/kimi-k3")),
  /** Total attempts, not retries. Five is the spec's ceiling for a transient failure. */
  maxAttempts: Config.integer("DRAFT_MAX_ATTEMPTS").pipe(Config.withDefault(5)),
  /** The first backoff; each attempt doubles it, with jitter. */
  retryBaseDelay: Config.duration("DRAFT_RETRY_BASE_DELAY").pipe(Config.withDefault(Duration.seconds(2)))
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

/**
 * How hard Ara is willing to lean on one GitHub App installation.
 *
 * Per installation, not per process: ADR-0005 chose the App model partly
 * because the budget is GitHub's own per-installation quota, so one heavy User
 * cannot exhaust everybody else's. The default matches what GitHub grants an
 * installation — 5,000 requests an hour — and leaving it there means Ara
 * queues behind its own limiter instead of being told off by GitHub's.
 *
 * `requestTimeout` bounds one call, waiting for a turn included. A Forge that
 * has stopped answering must not be able to pin a worker to a Run forever.
 */
export const GithubRateLimitConfig = Config.all({
  limit: Config.integer("GITHUB_RATE_LIMIT").pipe(Config.withDefault(5_000)),
  interval: Config.duration("GITHUB_RATE_LIMIT_INTERVAL").pipe(Config.withDefault(Duration.hours(1))),
  requestTimeout: Config.duration("GITHUB_REQUEST_TIMEOUT").pipe(Config.withDefault(Duration.seconds(30)))
})

/**
 * How hard Ara is willing to lean on the model provider, and how long it will
 * wait for an answer.
 *
 * One budget rather than one per User: model spend is Ara's own bill, and the
 * thing being protected is the account, not a per-caller quota. The timeout is
 * generous because a reasoning model thinks before it writes, and a Draft that
 * takes ninety seconds is a Draft, not a hang — but it is bounded, because
 * a provider that never answers would otherwise hold a worker for good.
 *
 * Both the wait for a turn and the call itself sit inside `requestTimeout`, so
 * a saturated limiter degrades into the same retryable failure as a slow
 * provider rather than into an unbounded wait.
 */
export const ModelCallConfig = Config.all({
  limit: Config.integer("MODEL_RATE_LIMIT").pipe(Config.withDefault(20)),
  interval: Config.duration("MODEL_RATE_LIMIT_INTERVAL").pipe(Config.withDefault(Duration.minutes(1))),
  requestTimeout: Config.duration("MODEL_REQUEST_TIMEOUT").pipe(Config.withDefault(Duration.minutes(2)))
})

/**
 * What the configured model charges, in US dollars per million tokens.
 *
 * Prices belong beside the model name because they change together: pointing
 * `DRAFT_MODEL` at something else without moving these would keep reporting
 * the old model's cost, confidently and wrongly. The defaults are Kimi K3's
 * published rates.
 *
 * Reasoning tokens are billed at the *output* rate and are already counted
 * inside the provider's output token figure, which is why there is no third
 * price here. They are reported separately because on a reasoning model they
 * are most of the bill, and a number that big should be visible rather than
 * folded into a total.
 */
export const ModelPricingConfig = Config.all({
  inputUsdPerMillionTokens: Config.number("MODEL_INPUT_USD_PER_MILLION_TOKENS").pipe(Config.withDefault(0.6)),
  outputUsdPerMillionTokens: Config.number("MODEL_OUTPUT_USD_PER_MILLION_TOKENS").pipe(Config.withDefault(2.5))
})
