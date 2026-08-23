import { Config } from "effect"

export const ServerConfig = Config.all({
  port: Config.port("PORT").pipe(Config.withDefault(3000)),
  host: Config.string("HOST").pipe(Config.withDefault("0.0.0.0"))
})
