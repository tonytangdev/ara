import { HttpApiScalar } from "@effect/platform"

/**
 * Scalar renders `AraApi`'s OpenAPI document at `/docs`. The script is inlined
 * from the package, so the page needs no network access to load.
 */
export const DocsLive = HttpApiScalar.layer({
  path: "/docs",
  scalar: { theme: "default", layout: "modern" }
})
