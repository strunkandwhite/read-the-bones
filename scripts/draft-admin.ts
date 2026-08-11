// scripts/draft-admin.ts
//
// Admin subcommands for live draft management.
// Usage: pnpm draft:admin <subcommand> <name> [options]
//
// Subcommands:
//   undo-pick <name> [--pick <n>]              Delete most recent pick (or specific pick_n)
//   edit-pick <name> --pick <n> --card <name>  Update card on a pick event
//   regen-token <name> --seat <n>              Regenerate a seat token
//   set-phase <name> --phase <phase>           Update draft phase
//   add-ban <name> --card <name>               Add a card to banned list
//   remove-ban <name> --card <name>            Remove a card from banned list
//   enter-match <name> --seats 1,5 --wins 2,1  Record a match result
//   reorder-seats <name> --order 3,1,4,2,...   Reorder seat pick positions (setup phase only)

import { createClient, type Client } from "@libsql/client";
import { loadEnv } from "../src/core/db/ingest/utils";
import { regenerateToken } from "../src/core/db/queries/seatTokens";
import { CardCache } from "../src/core/db/sync/card-cache";
import { loadScryfallCache } from "../src/core/db/ingest/scryfall";
import { resolveCardNamesToCache } from "../src/core/db/ingest/serializeScryfall";
import { resumeAutoPickForCurrentSeat } from "../src/core/processPick";
import { slugify } from "./lib/slugify";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function requireArg(args: string[], flag: string): string {
  const value = getArg(args, flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

const VALID_PHASES = ["setup", "drafting", "playing", "complete"] as const;

function createDbClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function undoPick(client: Client, draftId: string, args: string[]) {
  const pickArg = getArg(args, "--pick");

  if (pickArg) {
    const pickN = parseInt(pickArg, 10);
    if (isNaN(pickN)) throw new Error("--pick must be a number");

    const result = await client.execute({
      sql: "DELETE FROM pick_events WHERE draft_id = ? AND pick_n = ?",
      args: [draftId, pickN],
    });
    if (result.rowsAffected === 0) throw new Error(`Pick ${pickN} not found in draft "${draftId}"`);
    console.log(`Deleted pick ${pickN} from draft "${draftId}"`);
  } else {
    // Delete most recent pick
    const latest = await client.execute({
      sql: "SELECT pick_n FROM pick_events WHERE draft_id = ? ORDER BY pick_n DESC LIMIT 1",
      args: [draftId],
    });
    if (latest.rows.length === 0) throw new Error(`No picks found in draft "${draftId}"`);

    const pickN = latest.rows[0].pick_n as number;
    await client.execute({
      sql: "DELETE FROM pick_events WHERE draft_id = ? AND pick_n = ?",
      args: [draftId, pickN],
    });
    console.log(`Deleted most recent pick (pick_n=${pickN}) from draft "${draftId}"`);
  }
}

async function editPick(client: Client, draftId: string, args: string[]) {
  const pickN = parseInt(requireArg(args, "--pick"), 10);
  if (isNaN(pickN)) throw new Error("--pick must be a number");

  const cardName = requireArg(args, "--card");

  // Resolve card name to card_id
  const cardCache = new CardCache();
  await cardCache.loadAll(client);

  let cardId = cardCache.get(cardName);
  if (cardId === undefined) {
    // Try resolving via Scryfall cache
    const scryfallCache = loadScryfallCache();
    resolveCardNamesToCache([cardName], cardCache, scryfallCache);
    await cardCache.flushMissing(client);
    cardId = cardCache.get(cardName);
  }

  if (cardId === undefined) throw new Error(`Could not resolve card "${cardName}"`);

  const result = await client.execute({
    sql: "UPDATE pick_events SET card_id = ? WHERE draft_id = ? AND pick_n = ?",
    args: [cardId, draftId, pickN],
  });
  if (result.rowsAffected === 0) throw new Error(`Pick ${pickN} not found in draft "${draftId}"`);

  console.log(`Updated pick ${pickN} in draft "${draftId}" to "${cardName}" (card_id=${cardId})`);
}

async function regenToken(client: Client, draftId: string, args: string[]) {
  const seat = parseInt(requireArg(args, "--seat"), 10);
  if (isNaN(seat)) throw new Error("--seat must be a number");

  const newToken = await regenerateToken(client, draftId, seat);
  console.log(`Regenerated token for seat ${seat} in draft "${draftId}"`);
  console.log(`  New URL: https://read-the-bones.vercel.app/drafts/${draftId}?token=${newToken}`);
}

async function setPhase(client: Client, draftId: string, args: string[]) {
  const phase = requireArg(args, "--phase");
  if (!VALID_PHASES.includes(phase as (typeof VALID_PHASES)[number])) {
    throw new Error(`Invalid phase "${phase}". Valid phases: ${VALID_PHASES.join(", ")}`);
  }

  const result = await client.execute({
    sql: "UPDATE drafts SET phase = ? WHERE draft_id = ?",
    args: [phase, draftId],
  });
  if (result.rowsAffected === 0) throw new Error(`Draft "${draftId}" not found`);

  console.log(`Draft "${draftId}" phase set to "${phase}"`);

  if (phase === "drafting") {
    try {
      const resumed = await resumeAutoPickForCurrentSeat(client, draftId);
      if (resumed.picks.length > 0) {
        console.log(`Auto-picked ${resumed.picks.length} card(s) on resume:`);
        for (const p of resumed.picks) {
          console.log(`  pick ${p.pickN}  seat ${p.seat}  ${p.cardName}`);
        }
      }
    } catch (e) {
      console.warn(`  (auto-pick on resume skipped: ${e instanceof Error ? e.message : e})`);
    }
  }
}

async function addBan(client: Client, draftId: string, args: string[]) {
  const cardName = requireArg(args, "--card");

  const draft = await client.execute({
    sql: "SELECT banned_cards FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (draft.rows.length === 0) throw new Error(`Draft "${draftId}" not found`);

  const existing: string[] = draft.rows[0].banned_cards
    ? JSON.parse(draft.rows[0].banned_cards as string)
    : [];

  if (existing.includes(cardName)) {
    console.log(`"${cardName}" is already banned in draft "${draftId}"`);
    return;
  }

  existing.push(cardName);
  await client.execute({
    sql: "UPDATE drafts SET banned_cards = ? WHERE draft_id = ?",
    args: [JSON.stringify(existing), draftId],
  });

  console.log(`Added "${cardName}" to banned cards in draft "${draftId}"`);
  console.log(`  Banned cards: ${existing.join(", ")}`);
}

async function removeBan(client: Client, draftId: string, args: string[]) {
  const cardName = requireArg(args, "--card");

  const draft = await client.execute({
    sql: "SELECT banned_cards FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (draft.rows.length === 0) throw new Error(`Draft "${draftId}" not found`);

  const existing: string[] = draft.rows[0].banned_cards
    ? JSON.parse(draft.rows[0].banned_cards as string)
    : [];

  const idx = existing.indexOf(cardName);
  if (idx === -1) {
    console.log(`"${cardName}" is not banned in draft "${draftId}"`);
    return;
  }

  existing.splice(idx, 1);
  await client.execute({
    sql: "UPDATE drafts SET banned_cards = ? WHERE draft_id = ?",
    args: [existing.length > 0 ? JSON.stringify(existing) : null, draftId],
  });

  console.log(`Removed "${cardName}" from banned cards in draft "${draftId}"`);
  if (existing.length > 0) {
    console.log(`  Remaining banned cards: ${existing.join(", ")}`);
  } else {
    console.log(`  No banned cards remaining`);
  }
}

async function enterMatch(client: Client, draftId: string, args: string[]) {
  const seatsArg = requireArg(args, "--seats");
  const winsArg = requireArg(args, "--wins");

  const seatParts = seatsArg.split(",").map((s) => parseInt(s.trim(), 10));
  const winParts = winsArg.split(",").map((s) => parseInt(s.trim(), 10));

  if (seatParts.length !== 2) throw new Error("--seats must be two comma-separated seat numbers");
  if (winParts.length !== 2) throw new Error("--wins must be two comma-separated win counts");
  if (seatParts.some(isNaN)) throw new Error("--seats values must be numbers");
  if (winParts.some(isNaN)) throw new Error("--wins values must be numbers");

  const rawSeat1 = seatParts[0];
  const rawSeat2 = seatParts[1];

  if (rawSeat1 === rawSeat2) throw new Error("--seats must be two different seat numbers");

  // Validate seat bounds against the draft's num_seats
  const draft = await client.execute({
    sql: "SELECT num_seats FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (draft.rows.length === 0) throw new Error(`Draft "${draftId}" not found`);
  const numSeats = draft.rows[0].num_seats as number;
  if (rawSeat1 < 1 || rawSeat1 > numSeats)
    throw new Error(`Seat ${rawSeat1} out of range (1–${numSeats})`);
  if (rawSeat2 < 1 || rawSeat2 > numSeats)
    throw new Error(`Seat ${rawSeat2} out of range (1–${numSeats})`);

  // Normalize seat order: seat1 < seat2, rearranging wins accordingly
  let [seat1, seat2] = seatParts;
  let [seat1Wins, seat2Wins] = winParts;
  if (seat1 > seat2) {
    [seat1, seat2] = [seat2, seat1];
    [seat1Wins, seat2Wins] = [seat2Wins, seat1Wins];
  }

  // Record reported_by_seat as the lower-numbered seat (admin entry — both
  // players are presumed to agree). This mirrors the convention in reportMatchResult.
  const reportedBySeat = seat1;

  await client.execute({
    sql: "INSERT OR REPLACE INTO match_events (draft_id, seat1, seat2, seat1_wins, seat2_wins, reported_by_seat) VALUES (?, ?, ?, ?, ?, ?)",
    args: [draftId, seat1, seat2, seat1Wins, seat2Wins, reportedBySeat],
  });

  console.log(
    `Recorded match in draft "${draftId}": seat ${seat1} (${seat1Wins}W) vs seat ${seat2} (${seat2Wins}W)`
  );
}

async function reorderSeats(client: Client, draftId: string, args: string[]) {
  const orderArg = requireArg(args, "--order");
  const order = orderArg.split(",").map((s) => parseInt(s.trim(), 10));

  // Validate
  const draft = await client.execute({
    sql: "SELECT phase, num_seats FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (draft.rows.length === 0) throw new Error(`Draft not found: ${draftId}`);
  if (draft.rows[0].phase !== "setup") throw new Error("Can only reorder seats during setup phase");

  const numSeats = draft.rows[0].num_seats as number;
  if (order.length !== numSeats) throw new Error(`Expected ${numSeats} seats, got ${order.length}`);

  const sorted = [...order].sort((a, b) => a - b);
  const expected = Array.from({ length: numSeats }, (_, i) => i + 1);
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
    throw new Error(`Order must be a permutation of 1-${numSeats}`);
  }

  // Reorder by updating seat numbers on seat_tokens
  // Use temporary negative seats to avoid unique constraint conflicts
  const statements = [];

  // Phase 1: move all to negative temporaries
  for (let i = 0; i < order.length; i++) {
    statements.push({
      sql: "UPDATE seat_tokens SET seat = ? WHERE draft_id = ? AND seat = ?",
      args: [-(i + 1), draftId, order[i]],
    });
  }

  // Phase 2: move from negative to final positions
  for (let i = 0; i < order.length; i++) {
    statements.push({
      sql: "UPDATE seat_tokens SET seat = ? WHERE draft_id = ? AND seat = ?",
      args: [i + 1, draftId, -(i + 1)],
    });
  }

  await client.batch(statements);

  console.log(`Reordered seats for "${draftId}": ${order.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `Usage: pnpm draft:admin <subcommand> <name> [options]

Subcommands:
  undo-pick <name> [--pick <n>]              Delete most recent pick (or specific pick_n)
  edit-pick <name> --pick <n> --card <name>  Update card on a pick event
  regen-token <name> --seat <n>              Regenerate a seat token
  set-phase <name> --phase <phase>           Update draft phase
  add-ban <name> --card <name>               Add a card to banned list
  remove-ban <name> --card <name>            Remove a card from banned list
  enter-match <name> --seats 1,5 --wins 2,1  Record a match result
  reorder-seats <name> --order 3,1,4,2,...   Reorder seat pick positions (setup phase only)`;

async function main() {
  loadEnv();

  const subcommand = process.argv[2];
  const draftName = process.argv[3];

  if (!subcommand || !draftName) {
    console.log(USAGE);
    process.exit(1);
  }

  const draftId = slugify(draftName);
  const client = createDbClient();
  const remainingArgs = process.argv.slice(4);

  switch (subcommand) {
    case "undo-pick":
      await undoPick(client, draftId, remainingArgs);
      break;
    case "edit-pick":
      await editPick(client, draftId, remainingArgs);
      break;
    case "regen-token":
      await regenToken(client, draftId, remainingArgs);
      break;
    case "set-phase":
      await setPhase(client, draftId, remainingArgs);
      break;
    case "add-ban":
      await addBan(client, draftId, remainingArgs);
      break;
    case "remove-ban":
      await removeBan(client, draftId, remainingArgs);
      break;
    case "enter-match":
      await enterMatch(client, draftId, remainingArgs);
      break;
    case "reorder-seats":
      await reorderSeats(client, draftId, remainingArgs);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
