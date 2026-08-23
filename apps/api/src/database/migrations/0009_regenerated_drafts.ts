import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Regeneration: a Run that writes from a Digest it did not collect.
 *
 * This is where the split in ADR-0002 is cashed in. A User who does not like a
 * Draft asks for another one, and the second Run starts at the Draft stage
 * against the Digest the first Run already persisted — one model call, and not
 * a single Forge call. `source_digest_id` is the whole of that fact: null means
 * "collect the day first", set means "the day is already collected, write".
 *
 * It is a new Run rather than a second go at the old one because a Run is what
 * a User asks for, polls, and is billed for. Reusing the first Run would make
 * "how many times has this been written?" unanswerable and would leave no way
 * to tell a User-asked rewrite from a deploy handing an interrupted Run back to
 * the queue — and those two must not behave the same.
 *
 * The two partial unique indexes are the double-click guard (user story 11),
 * split because the two kinds of Run are deduplicated on different things:
 *
 * - a collecting Run, on the day it is about, so two requests for the same day
 *   cost one read of the Forge;
 * - a regenerating Run, on the Digest it writes from, so a twice-clicked
 *   regenerate button costs one model call.
 *
 * Splitting them is also what stops a regeneration colliding with an unrelated
 * Run for the same day that happens to still be in flight.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.asVoid(
    Effect.all([
      sql`
        alter table runs
          add column source_digest_id uuid references digests (id) on delete cascade
      `,
      sql`drop index runs_in_flight_idx`,
      sql`
        create unique index runs_in_flight_idx on runs (user_id, forge, owner, name, day)
          where source_digest_id is null and state in ('queued', 'collecting', 'drafting')
      `,
      sql`
        create unique index runs_regenerating_idx on runs (user_id, source_digest_id)
          where source_digest_id is not null and state in ('queued', 'collecting', 'drafting')
      `
    ])
  )
)
