import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Drafts: the prose a Run produced, and what it cost to produce.
 *
 * A Draft points at both the Run that produced it and the Digest it was written
 * from. The Digest reference is the one that earns its keep: it is what makes a
 * Draft explainable after the fact, and what regenerating one reads from
 * instead of going back to the Forge (ADR-0002).
 *
 * `run_id` is deliberately *not* unique. Regenerating keeps the earlier Drafts
 * (#11), so a Run accumulates them; what stops an interrupted Run writing a
 * second one on its next claim is the Draft stage checking first, which is safe
 * because a Run is claimed by at most one worker (ADR-0001).
 *
 * `model` and the token counts are columns rather than a metadata blob because
 * they answer questions asked across Drafts — which model wrote the good ones,
 * what the habit costs per month. Counts are nullable: a provider that declines
 * to report usage is not a reason to lose the Draft.
 *
 * The `check` on `body` is the last line of defence for the rule this table
 * exists to keep: a model that answers with reasoning and no message content
 * must never leave an empty Draft behind. It is caught at the adapter and again
 * before persisting; if both are ever edited away, the database still refuses.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.asVoid(
    Effect.all([
      sql`
        create table drafts (
          id uuid primary key default gen_random_uuid(),
          run_id uuid not null references runs (id) on delete cascade,
          user_id uuid not null references users (id) on delete cascade,
          digest_id uuid not null references digests (id) on delete cascade,
          body text not null constraint drafts_body_not_blank check (btrim(body) <> ''),
          model text not null,
          input_tokens integer,
          output_tokens integer,
          total_tokens integer,
          generated_at timestamptz not null default now(),
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `,
      sql`create index drafts_run_id_idx on drafts (run_id, generated_at desc)`,
      sql`create index drafts_user_id_idx on drafts (user_id, generated_at desc)`,
      sql`
        create trigger drafts_set_updated_at before update on drafts
          for each row execute function set_updated_at()
      `
    ])
  )
)
