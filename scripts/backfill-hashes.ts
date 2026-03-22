// scripts/backfill-hashes.ts
// One-time migration script to compute and store per-domain hashes for existing drafts.
import { createClient } from "@libsql/client";
import { loadEnv, log } from "../src/core/db/ingest/utils";
import {
  hashPool,
  hashPicks,
  hashMatches,
  updateDomainHashes,
} from "../src/core/db/sync/domains";

async function main() {
  loadEnv();
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const drafts = await client.execute({
    sql: "SELECT draft_id FROM drafts",
    args: [],
  });

  for (const row of drafts.rows) {
    const draftId = row.draft_id as string;

    // Compute pool hash from cube_snapshot_cards
    const poolResult = await client.execute({
      sql: `SELECT c.name FROM cube_snapshot_cards csc
            JOIN cards c ON csc.card_id = c.card_id
            JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
            WHERE d.draft_id = ?
            ORDER BY c.name`,
      args: [draftId],
    });
    const poolNames = poolResult.rows.map((r) => r.name as string);
    const poolHash = poolNames.length > 0 ? hashPool(poolNames) : null;

    // Compute picks hash from pick_events
    const picksResult = await client.execute({
      sql: `SELECT pe.pick_n, pe.seat, c.name as card_name FROM pick_events pe
            JOIN cards c ON pe.card_id = c.card_id
            WHERE pe.draft_id = ?
            ORDER BY pe.pick_n, pe.seat`,
      args: [draftId],
    });
    const picks = picksResult.rows.map((r) => ({
      cardName: r.card_name as string,
      pickPosition: r.pick_n as number,
      seat: r.seat as number,
      copyNumber: 1,
      wasPicked: true,
      draftId,
      color: "",
    }));
    const picksHash = picks.length > 0 ? hashPicks(picks) : null;

    // Compute matches hash from match_events
    const matchesResult = await client.execute({
      sql: `SELECT seat1, seat2, seat1_wins, seat2_wins FROM match_events
            WHERE draft_id = ? ORDER BY seat1, seat2`,
      args: [draftId],
    });
    const matches = matchesResult.rows.map((r) => ({
      seat1: r.seat1 as number,
      seat2: r.seat2 as number,
      seat1GamesWon: r.seat1_wins as number,
      seat2GamesWon: r.seat2_wins as number,
    }));
    const matchesHash =
      matches.length > 0 ? hashMatches(matches) : null;

    await updateDomainHashes(client, draftId, {
      poolHash,
      picksHash,
      matchesHash,
    });
    log(
      `${draftId}: pool=${poolHash ?? "null"} picks=${picksHash ?? "null"} matches=${matchesHash ?? "null"}`,
    );
  }

  log("Hash backfill complete");
}

main().catch(console.error);
