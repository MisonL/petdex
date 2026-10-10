import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

// This is the one `apply-*` script that does something irreversible: it drops
// `user_profiles.featured_pet_slug` after backfilling it. The other 21 only
// add tables, columns and indexes, so a rerun is harmless; a dropped column
// is not, and the backfill above only carries rows where the old column was
// non-null AND the new one was still empty. Gate the destructive step the way
// the other maintenance scripts on this branch do — dry by default, write on
// `--apply`.
const apply = process.argv.includes("--apply");

const sql = neon(requiredEnv("DATABASE_URL"));

async function tryRun(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /already exists/i.test(msg) ||
      /duplicate column/i.test(msg) ||
      /does not exist/i.test(msg)
    ) {
      console.log(`skip ${label} (${msg.split("\n")[0]})`);
    } else {
      throw err;
    }
  }
}

await tryRun(
  "add featured_pet_slugs column",
  () =>
    sql`ALTER TABLE user_profiles ADD COLUMN featured_pet_slugs jsonb NOT NULL DEFAULT '[]'::jsonb`,
);

// Backfill: any row with a non-null featured_pet_slug becomes a single-
// element array in the new column. Safe to run multiple times — uses
// jsonb_array_length to detect already-migrated rows.
await tryRun("backfill from featured_pet_slug", async () => {
  await sql`
    UPDATE user_profiles
    SET featured_pet_slugs = jsonb_build_array(featured_pet_slug)
    WHERE featured_pet_slug IS NOT NULL
      AND jsonb_array_length(featured_pet_slugs) = 0
  `;
});

if (!apply) {
  console.log(
    "\n(dry run — the add + backfill above ran; pass --apply to drop the " +
      "legacy featured_pet_slug column. Dropping it is irreversible.)",
  );
} else {
  await tryRun(
    "drop legacy featured_pet_slug column",
    () => sql`ALTER TABLE user_profiles DROP COLUMN featured_pet_slug`,
  );
}

console.log("done");
