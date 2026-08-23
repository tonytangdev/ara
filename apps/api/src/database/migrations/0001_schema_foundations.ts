import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * The conventions the rest of the schema is written against. Every table added
 * from here on carries `updated_at` and attaches this trigger, so the rule
 * lives in one place instead of being restated per table.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.asVoid(sql`
    create or replace function set_updated_at() returns trigger as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$ language plpgsql
  `)
)
