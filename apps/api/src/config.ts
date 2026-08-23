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
