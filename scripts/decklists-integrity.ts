/**
 * Audit every stored decklist against its seat's picks, and list every seat
 * that has no decklist at all.
 *
 * Rotisserie gives each card exactly one owner, so a correctly assigned deck
 * scores ~100% precision against its seat's picks. Anything lower is a
 * mis-assignment: cards in the stored deck that the seat never drafted.
 *
 * Usage:
 *   pnpm decklists:integrity
 *   pnpm decklists:integrity --write-report   # refresh data/decklist-status.md
 */

import { createClient } from "@libsql/client";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnv, log } from "../src/core/db/ingest/utils";
import { cardNameKey } from "../src/core/parseSheetRows";
import { isCompletedForStats } from "../src/core/draftPhases";
import {
  SEAT_MATCH_PRECISION_THRESHOLD,
  scoreAgainstSeat,
  formatPct,
} from "./lib/deckMatching";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Gitignored: the report names seats and their decklist coverage, which is private
// stats data the public app does not expose.
const REPORT_FILE = join(__dirname, "..", "data", "decklist-status.md");

// The same key the matcher scores by (`scripts/decklists.ts`) and the write
// path resolves by. Folding a double-faced card to its front face matters here
// too: a checker that keys names differently from the matcher certifies data
// the matcher would have rejected, and vice versa.
const norm = cardNameKey;
const key = (draftId: string, seat: number) => `${draftId}:${seat}`;

/**
 * Coverage below which a stored deck is worth a look.
 *
 * Precision on its own certifies a deck holding 8 of a seat's 45 picks as
 * correct, because every card in it is legitimately that seat's. Coverage is
 * the other direction, and it is only ever suspicious, never proof of an
 * error — a submitter may genuinely have left most of their pool in
 * sealeddeck's `hidden` zone — so it is listed and never fails the run.
 *
 * Set from the measured distribution rather than from principle: across the
 * 190 decks that pass the precision gate, the median covers 100% of its seat's
 * picks and the 10th percentile 97.7%, with the two lowest at 78%. The
 * matcher's own recall floor (`SEAT_MATCH_RECALL_THRESHOLD`, 0.5) is the wrong
 * line here — nothing in the corpus comes near it, so a check keyed to it
 * would never fire. 0.8 means "a fifth of this seat's picks are unaccounted
 * for", which against that distribution is a genuine outlier.
 */
const COVERAGE_FLAG_THRESHOLD = 0.8;

interface StoredDeck {
  draftId: string;
  seat: number;
  precision: number;
  /** Share of the seat's picks this deck holds — `scoreAgainstSeat`'s recall. */
  coverage: number;
  stored: number;
  picked: number;
  notPicked: number;
}

type AbsenceReason = "missing" | "draft-never-collected" | "in-progress";

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

  // Redaction happens at ingest: an opted-out seat's picks are never written,
  // so this tool can never observe an opted-out seat via pick_events. Count
  // opt-outs directly rather than trying (and failing) to classify absences
  // as opted-out.
  const optOutResult = await client.execute(`SELECT draft_id, seat FROM privacy_opt_outs`);
  const optOutCount = optOutResult.rows.length;

  const draftPhaseById = new Map<string, string>();
  const draftsResult = await client.execute(`SELECT draft_id, phase FROM drafts`);
  for (const row of draftsResult.rows) {
    draftPhaseById.set(row.draft_id as string, row.phase as string);
  }
  const isDraftComplete = (draftId: string) => isCompletedForStats(draftPhaseById.get(draftId) ?? "");

  // Seats that demonstrably drafted: a seat with no picks never played.
  const seatsThatDrafted = [...picksBySeat.keys()];
  // Only a *completed* draft's decks count toward "some seats have decks,
  // this one is missing" — an early submission in a still-drafting pod
  // shouldn't make its other seats look like remediation targets.
  const draftsWithAnyDeck = new Set(
    [...deckBySeat.keys()].map((k) => k.split(":")[0]).filter(isDraftComplete),
  );

  // ---- suspect stored decks ------------------------------------------------

  const scored: StoredDeck[] = [];
  for (const [k, cards] of deckBySeat) {
    const [draftId, seatStr] = k.split(":");
    const picks = picksBySeat.get(k) ?? new Set<string>();
    const score = scoreAgainstSeat(cards, picks);

    scored.push({
      draftId,
      seat: Number(seatStr),
      precision: score.precision,
      coverage: score.recall,
      stored: cards.size,
      picked: picks.size,
      notPicked: cards.size - score.overlap,
    });
  }

  const suspects = scored
    .filter((s) => s.precision < SEAT_MATCH_PRECISION_THRESHOLD)
    .sort((a, b) => a.precision - b.precision || a.draftId.localeCompare(b.draftId));

  // Coverage is only reported for decks that pass the precision gate. A suspect
  // deck covers nothing by construction, and listing it twice would bury the
  // seats where low coverage is the *only* thing wrong.
  const lowCoverage = scored
    .filter((s) => s.precision >= SEAT_MATCH_PRECISION_THRESHOLD && s.coverage < COVERAGE_FLAG_THRESHOLD)
    .sort((a, b) => a.coverage - b.coverage || a.draftId.localeCompare(b.draftId));

  // ---- absent decks --------------------------------------------------------

  const absent: Absent[] = [];
  for (const k of seatsThatDrafted) {
    if (deckBySeat.has(k)) continue;
    const [draftId, seatStr] = k.split(":");
    const seat = Number(seatStr);

    // A still-drafting pod hasn't finished, so nobody has built a deck yet —
    // that's expected, not a gap. Only classify as missing/never-collected
    // once the draft is done and decks should exist.
    const reason: AbsenceReason = !isDraftComplete(draftId)
      ? "in-progress"
      : draftsWithAnyDeck.has(draftId)
        ? "missing"
        : "draft-never-collected";

    absent.push({ draftId, seat, reason });
  }
  absent.sort((a, b) => a.draftId.localeCompare(b.draftId) || a.seat - b.seat);

  // ---- report --------------------------------------------------------------

  const inProgress = absent.filter((a) => a.reason === "in-progress");
  const actionable = absent.filter((a) => a.reason !== "in-progress");
  const needsAttention = absent.filter((a) => a.reason === "missing");

  log(`stored decklists: ${deckBySeat.size}`);
  log(`suspect (precision < ${formatPct(SEAT_MATCH_PRECISION_THRESHOLD)}): ${suspects.length}`);
  for (const s of suspects) {
    console.log(
      `  ${`${s.draftId}:${s.seat}`.padEnd(34)} ${formatPct(s.precision).padStart(6)}  ` +
        `coverage ${formatPct(s.coverage).padStart(6)}  ` +
        `${s.notPicked} of ${s.stored} cards not picked by this seat`,
    );
  }

  log(
    `low coverage (holds < ${formatPct(COVERAGE_FLAG_THRESHOLD)} of the seat's picks, ` +
      `but every card is that seat's): ${lowCoverage.length}`,
  );
  for (const s of lowCoverage) {
    console.log(
      `  ${`${s.draftId}:${s.seat}`.padEnd(34)} ${formatPct(s.coverage).padStart(6)}  ` +
        `${s.stored} of this seat's ${s.picked} picks stored`,
    );
  }

  log(
    `seats that drafted but have no decklist: ${absent.length} ` +
      `(${actionable.length} actionable, ${inProgress.length} in-progress — not yet actionable)`,
  );
  for (const reason of ["missing", "draft-never-collected", "in-progress"] as const) {
    const group = absent.filter((a) => a.reason === reason);
    if (group.length === 0) continue;
    const label = reason === "in-progress" ? "in-progress (draft not complete, not actionable)" : reason;
    console.log(`  ${label} (${group.length}): ${group.map((a) => `${a.draftId}:${a.seat}`).join(", ")}`);
  }

  log(
    `opted out: ${optOutCount} seat(s) (not evaluated — redaction happens at ingest, so these seats have no picks)`,
  );

  if (writeReport) {
    writeFileSync(
      REPORT_FILE,
      renderReport(suspects, lowCoverage, absent, deckBySeat.size, optOutCount),
    );
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
    log(`${needsAttention.length} seat(s) await manual remediation — see data/decklist-status.md`);
  }
}

function renderReport(
  suspects: StoredDeck[],
  lowCoverage: StoredDeck[],
  absent: Absent[],
  storedCount: number,
  optOutCount: number,
): string {
  const inProgress = absent.filter((a) => a.reason === "in-progress");
  const actionable = absent.filter((a) => a.reason !== "in-progress");

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
  lines.push(`**Low coverage (not an error):** ${lowCoverage.length}`);
  lines.push(`**Actionable absences:** ${actionable.length}`);
  lines.push(`**In progress (not yet actionable):** ${inProgress.length}`);
  lines.push(`**Opted out (not evaluated):** ${optOutCount}`);
  lines.push("");

  lines.push("## Suspect stored decklists");
  lines.push("");
  if (suspects.length === 0) {
    lines.push("None. Every stored decklist is made of cards its seat actually drafted.");
  } else {
    lines.push("| Draft | Seat | Precision | Coverage | Detail |");
    lines.push("|---|---|---|---|---|");
    for (const s of suspects) {
      lines.push(
        `| ${s.draftId} | ${s.seat} | ${formatPct(s.precision)} | ${formatPct(s.coverage)} | ` +
          `${s.notPicked} of ${s.stored} cards not picked by this seat |`,
      );
    }
  }
  lines.push("");

  lines.push("## Low-coverage stored decklists");
  lines.push("");
  lines.push(
    "Every card in these decks belongs to the seat, so precision certifies them — but they " +
      `hold under ${formatPct(COVERAGE_FLAG_THRESHOLD)} of what that seat drafted. That is ` +
      "suspicious rather than wrong (a submitter may have left most of their pool in " +
      "sealeddeck's `hidden` zone), so it is listed, not failed.",
  );
  lines.push("");
  if (lowCoverage.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Draft | Seat | Coverage | Detail |");
    lines.push("|---|---|---|---|");
    for (const s of lowCoverage) {
      lines.push(
        `| ${s.draftId} | ${s.seat} | ${formatPct(s.coverage)} | ` +
          `${s.stored} of this seat's ${s.picked} picks stored |`,
      );
    }
  }
  lines.push("");

  lines.push("## Seats with no decklist (actionable)");
  lines.push("");
  if (actionable.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Draft | Seat | Reason | Note |");
    lines.push("|---|---|---|---|");
    for (const a of actionable) {
      lines.push(`| ${a.draftId} | ${a.seat} | ${a.reason} | |`);
    }
  }
  lines.push("");

  lines.push("## Seats still drafting (not yet actionable)");
  lines.push("");
  lines.push(
    "These drafts have not finished, so no deck is expected yet. Not part of the " +
      "remediation queue — listed separately so they are not mistaken for work to do.",
  );
  lines.push("");
  if (inProgress.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Draft | Seat |");
    lines.push("|---|---|");
    for (const a of inProgress) {
      lines.push(`| ${a.draftId} | ${a.seat} |`);
    }
  }
  lines.push("");

  lines.push(
    "**Reasons:** `draft-never-collected` — the draft is complete but no seat in it has a decklist. ",
  );
  lines.push("`missing` — other seats in this (complete) draft have decks; this one needs remediation. ");
  lines.push("`in-progress` — the draft has not finished; no deck is expected yet.");
  lines.push("");
  lines.push(
    `**Opted-out seats (${optOutCount}) are not evaluated above.** Privacy redaction happens at ` +
      "ingest — an opted-out seat's picks are never written — so this tool, which finds absent " +
      "decks by looking for seats with picks and no deck, structurally cannot see them. Counted " +
      "directly from `privacy_opt_outs` instead.",
  );
  lines.push("");

  return lines.join("\n");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
