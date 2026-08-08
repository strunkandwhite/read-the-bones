// @vitest-environment jsdom
/**
 * Regression coverage for the ingest-time-redaction pick-count defect:
 * DraftBoardModal derived the "next pick" from `board.picks.length`, a row
 * count. Once opted-out seats' picks stop being stored (ingest-time
 * redaction), `pick_n` gets gaps and `.length` undercounts — the pod view
 * would highlight the wrong seat on the clock. `latestPickN`
 * (MAX(pick_n), from liveDraftStatus) is robust to those gaps and is what
 * `getNextPick` must be given as its "picks made so far" argument.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DraftBoardModal } from "./DraftBoardModal";
import { useDraftStore } from "@/app/stores/draftStore";
import type { BoardData, LiveDraftStatus } from "@/app/stores/draftStore";

// Child components are irrelevant to the next-pick derivation under test —
// mock them out so the modal renders without their own data requirements,
// and have the matrix mock surface the prop we care about.
vi.mock("./DraftBoardMatrix", () => ({
  DraftBoardMatrix: ({ nextPickN }: { nextPickN: number | null }) => (
    <div data-testid="next-pick-n">{String(nextPickN)}</div>
  ),
}));
vi.mock("./StandingsSection", () => ({
  StandingsSection: () => <div data-testid="standings" />,
}));
vi.mock("./QueuePanel", () => ({
  QueuePanel: () => <div data-testid="queue-panel" />,
}));

afterEach(() => {
  cleanup();
});

function makePicks(count: number): BoardData["picks"] {
  return Array.from({ length: count }, (_, i) => ({
    pickN: i + 1,
    seat: 1,
    cardName: `Card ${i + 1}`,
    oracleId: `oracle-${i + 1}`,
    colorIdentity: [],
    manaCost: "",
  }));
}

function makeBoard(overrides: Partial<BoardData> = {}): BoardData {
  return {
    picks: makePicks(16),
    numSeats: 10,
    picksPerPlayer: 45,
    doublePickAfterRound: 25,
    phase: "drafting",
    seatNames: {},
    bannedCards: [],
    isSheetDraft: false,
    redactedSeats: [],
    ...overrides,
  };
}

function makeStatus(overrides: Partial<LiveDraftStatus> = {}): LiveDraftStatus {
  return {
    latestPickN: 16,
    nextSeat: null,
    recentPicks: [],
    matchCount: 0,
    totalMatches: 0,
    ...overrides,
  };
}

describe("DraftBoardModal next-pick derivation", () => {
  it("derives the next pick from latestPickN, not board.picks.length, when redacted picks leave gaps", () => {
    // 16 stored pick rows, but MAX(pick_n) is 20 — 4 picks were made by
    // opted-out seats and were never stored. numSeats=10, picksPerPlayer=45,
    // doublePickAfterRound=25 puts pick 21 in the single-pick region:
    // round 3 (odd/forward), posInRound 0 -> seat 1, pickNumber 21.
    // A `.picks.length`-based implementation would instead compute pick 17
    // (round 2, even/backward, posInRound 6 -> seat 4).
    useDraftStore.setState({
      board: makeBoard({ picks: makePicks(16) }),
      liveDraftStatus: makeStatus({ latestPickN: 20 }),
    });

    render(<DraftBoardModal draftId="d1" isOpen onClose={() => {}} />);

    expect(screen.getByTestId("next-pick-n").textContent).toBe("21");
  });

  it("matches board.picks.length when there are no opted-out seats (sanity check)", () => {
    useDraftStore.setState({
      board: makeBoard({ picks: makePicks(16) }),
      liveDraftStatus: makeStatus({ latestPickN: 16 }),
    });

    render(<DraftBoardModal draftId="d1" isOpen onClose={() => {}} />);

    // 16 picks made, single-pick region: round 2 (even/backward), pick 17
    // is posInRound 6 -> seat 10-6=4.
    expect(screen.getByTestId("next-pick-n").textContent).toBe("17");
  });
});
