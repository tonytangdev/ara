import { Schema } from "effect"

/**
 * A hosting service repositories live on. GitHub is the only one today; the
 * literal exists so that every row Ara writes already says which Forge it came
 * from, and adding GitLab is a new member rather than a new column.
 */
export const Forge = Schema.Literal("github")
export type Forge = typeof Forge.Type
