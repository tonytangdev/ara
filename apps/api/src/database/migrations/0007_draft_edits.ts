import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * The User's edit, kept beside the generated prose rather than on top of it.
 *
 * `body` stays exactly what the model wrote. What a human then made of it lands
 * in `edited_body`, and the two are never merged. Two things depend on that
 * separation: regeneration must be able to see that there is human work here
 * before it writes over anything (#11), and Ara can later learn what a User
 * always changes (user story 18) — neither is possible once the generated text
 * has been overwritten.
 *
 * `edited_at` is not decoration. It is what makes an edited Draft
 * distinguishable in the list, where the bodies are deliberately absent, and
 * the constraint below keeps the pair honest: a Draft is either untouched or it
 * carries both the edit and when it happened.
 *
 * The blankness check mirrors the one on `body`. Saving an edit that is nothing
 * but whitespace would leave a Draft with no postable text at all while
 * claiming to have been edited.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.asVoid(
    Effect.all([
      sql`
        alter table drafts
          add column edited_body text
            constraint drafts_edited_body_not_blank check (edited_body is null or btrim(edited_body) <> ''),
          add column edited_at timestamptz
      `,
      sql`
        alter table drafts
          add constraint drafts_edited_together check ((edited_body is null) = (edited_at is null))
      `
    ])
  )
)
