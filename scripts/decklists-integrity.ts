/**
 * Audit every stored decklist against its seat's picks, and list every seat
 * that has no decklist at all.
 *
 * Rotisserie gives each card exactly one owner, so a correctly assigned deck
 * scores ~100% precision against its seat's picks. Anything lower is a
 * mis-assignment. This is the check that would have caught the hidden-zone
 * matching defect the day it landed.
 *
 * Usage:
 *   pnpm decklists:integrity
 *   pnpm decklists:integrity --write-report   # refresh docs/decklist-status.md
 */

import { createClient } from "@libsql/client";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnv, log } from "../src/core/db/ingest/utils";
import { normalizeCardName } from "../src/core/parseSheetRows";
import { SEAT_MATCH_PRECISION_THRESHOLD, formatPct } from "./lib/deckMatching";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_FILE = join(__dirname, "..", "docs", "decklist-status.md");

const norm = (name: string) => normalizeCardName(name).toLowerCase();
const key = (draftId: string, seat: number) => `${draftId}:${seat}`;

interface Suspect {
  draftId: string;
  seat: number;
  precision: number;
  stored: number;
  notPicked: number;
}

type AbsenceReason = "opted-out" | "draft-never-collected" | "missing";

interface Absent {
  draftId: string;
  seat: number;
  reason: AbsenceReason;
}

async function main() {
  loadEnv();

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const writeReport = process.argv.includes("--write-report");

  // ---- load ----------------------------------------------------------------

  const picksBySeat = new Map<string, Set<string>>();
  const picksResult = await client.execute(
    `SELECT pe.draft_id, pe.seat, c.name
     FROM pick_events pe JOIN cards c ON c.card_id = pe.card_id`,
  );
  for (const row of picksResult.rows) {
    const k = key(row.draft_id as string, row.seat as number);
    if (!picksBySeat.has(k)) picksBySeat.set(k, new Set());
    picksBySeat.get(k)!.add(norm(row.name as string));
  }

  const deckBySeat = new Map<string, Set<string>>();
  const decksResult = await client.execute(
    `SELECT dc.draft_id, dc.seat, c.name
     FROM deck_cards dc JOIN cards c ON c.card_id = dc.card_id`,
  );
  for (const row of decksResult.rows) {
    const k = key(row.draft_id as string, row.seat as number);
    if (!deckBySeat.has(k)) deckBySeat.set(k, new Set());
    deckBySeat.get(k)!.add(norm(row.name as string));
  }

  const optedOut = new Set<string>();
  const optOutResult = await client.execute(`SELECT draft_id, seat FROM privacy_opt_outs`);
  for (const row of optOutResult.rows) {
    optedOut.add(key(row.draft_id as string, row.seat as number));
  }

  // Seats that demonstrably drafted: a seat with no picks never played.
  const seatsThatDrafted = [...picksBySeat.keys()];
  const draftsWithAnyDeck = new Set([...deckBySeat.keys()].map((k) => k.split(":")[0]));

  // ---- suspect stored decks ------------------------------------------------

  const suspects: Suspect[] = [];
  for (const [k, cards] of deckBySeat) {
    const [draftId, seatStr] = k.split(":");
    const seat = Number(seatStr);
    const picks = picksBySeat.get(k);

    if (!picks) {
      suspects.push({ draftId, seat, precision: 0, stored: cards.size, notPicked: cards.size });
      continue;
    }

    const overlap = [...cards].filter((c) => picks.has(c)).length;
    const precision = cards.size > 0 ? overlap / cards.size : 0;
    if (precision < SEAT_MATCH_PRECISION_THRESHOLD) {
      suspects.push({
        draftId,
        seat,
        precision,
        stored: cards.size,
        notPicked: cards.size - overlap,
      });
    }
  }
  suspects.sort((a, b) => a.precision - b.precision || a.draftId.localeCompare(b.draftId));

  // ---- absent decks --------------------------------------------------------

  const absent: Absent[] = [];
  for (const k of seatsThatDrafted) {
    if (deckBySeat.has(k)) continue;
    const [draftId, seatStr] = k.split(":");
    const seat = Number(seatStr);

    const reason: AbsenceReason = optedOut.has(k)
      ? "opted-out"
      : draftsWithAnyDeck.has(draftId)
        ? "missing"
        : "draft-never-collected";

    absent.push({ draftId, seat, reason });
  }
  absent.sort((a, b) => a.draftId.localeCompare(b.draftId) || a.seat - b.seat);

  // ---- report --------------------------------------------------------------

  const needsAttention = absent.filter((a) => a.reason === "missing");

  log(`stored decklists: ${deckBySeat.size}`);
  log(`suspect (precision < ${formatPct(SEAT_MATCH_PRECISION_THRESHOLD)}): ${suspects.length}`);
  for (const s of suspects) {
    console.log(
      `  ${`${s.draftId}:${s.seat}`.padEnd(34)} ${formatPct(s.precision).padStart(6)}  ` +
        `${s.notPicked} of ${s.stored} cards not picked by this seat`,
    );
  }

  log(`seats that drafted but have no decklist: ${absent.length}`);
  for (const reason of ["missing", "draft-never-collected", "opted-out"] as const) {
    const group = absent.filter((a) => a.reason === reason);
    if (group.length === 0) continue;
    console.log(`  ${reason} (${group.length}): ${group.map((a) => `${a.draftId}:${a.seat}`).join(", ")}`);
  }

  if (writeReport) {
    writeFileSync(REPORT_FILE, renderReport(suspects, absent, deckBySeat.size));
    log(`wrote ${REPORT_FILE}`);
  }

  client.close();

  if (suspects.length > 0) {
    console.error(
      `\n${suspects.length} suspect decklist(s). These seats are attributed cards they never drafted.`,
    );
    process.exit(1);
  }
  if (needsAttention.length > 0) {
    log(`${needsAttention.length} seat(s) await manual remediation — see docs/decklist-status.md`);
  }
}

function renderReport(suspects: Suspect[], absent: Absent[], storedCount: number): string {
  const lines: string[] = [];
  lines.push("# Decklist Status");
  lines.push("");
  lines.push("Generated by `pnpm decklists:integrity --write-report`.");
  lines.push("");
  lines.push(
    "The derived columns come from the database. Narrative notes are added by hand — " +
      "the database cannot know whether a missing deck is awaiting a screenshot or a URL.",
  );
  lines.push("");
  lines.push(`**Stored decklists:** ${storedCount}`);
  lines.push(`**Suspect:** ${suspects.length}`);
  lines.push("");

  lines.push("## Suspect stored decklists");
  lines.push("");
  if (suspects.length === 0) {
    lines.push("None. Every stored decklist is made of cards its seat actually drafted.");
  } else {
    lines.push("| Draft | Seat | Precision | Detail |");
    lines.push("|---|---|---|---|");
    for (const s of suspects) {
      lines.push(
        `| ${s.draftId} | ${s.seat} | ${formatPct(s.precision)} | ${s.notPicked} of ${s.stored} cards not picked by this seat |`,
      );
    }
  }
  lines.push("");

  lines.push("## Seats with no decklist");
  lines.push("");
  lines.push("| Draft | Seat | Reason | Note |");
  lines.push("|---|---|---|---|");
  for (const a of absent) {
    lines.push(`| ${a.draftId} | ${a.seat} | ${a.reason} | |`);
  }
  lines.push("");
  lines.push("**Reasons:** `opted-out` — by design, will never have a deck. ");
  lines.push("`draft-never-collected` — no seat in that draft has a decklist. ");
  lines.push("`missing` — other seats in this draft have decks; this one needs remediation.");
  lines.push("");

  return lines.join("\n");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
