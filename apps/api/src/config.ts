import { Config } from "effect"

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
