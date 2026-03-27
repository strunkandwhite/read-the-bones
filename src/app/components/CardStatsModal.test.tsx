// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CardStatsModal } from "./CardStatsModal";

// Mock the hooks
vi.mock("@/app/hooks/useCardStats", () => ({
  useCardStats: vi.fn(() => ({
    data: {
      pick: { drafts_in_pool: 5, times_picked: 4, avg_pick: 10.2, median_pick: 9, geomean_pick: 12.4 },
      pick_history: [],
      pick_distribution: Array(15).fill(0),
      times_banned: 0,
      color_pair_breakdown: [{ colorPair: "RW", percentage: 55, deckCount: 3 }],
    },
    loading: false,
    error: null,
  })),
}));

afterEach(() => {
  cleanup();
});

describe("CardStatsModal", () => {
  const defaultProps = {
    cardName: "Lightning Bolt",
    scryfallImageUrl: "https://cards.scryfall.io/normal/front/bolt.jpg",
    isOpen: true,
    onClose: vi.fn(),
  };

  it("renders card image when open", () => {
    render(<CardStatsModal {...defaultProps} />);
    const img = screen.getByAltText("Lightning Bolt");
    expect(img).toBeTruthy();
  });

  it("shows pick score", () => {
    render(<CardStatsModal {...defaultProps} />);
    expect(screen.getByText("12.4")).toBeTruthy();
  });

  it("shows color pair breakdown pills", () => {
    render(<CardStatsModal {...defaultProps} />);
    expect(screen.getByText("55%")).toBeTruthy();
  });

  it("does not render when isOpen is false", () => {
    render(<CardStatsModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows action buttons during live draft when it is user's turn", () => {
    render(
      <CardStatsModal
        {...defaultProps}
        isLiveDraft
        isMyTurn
        onPick={vi.fn()}
        onQueue={vi.fn()}
        onFloat={vi.fn()}
        cardStatus="none"
      />
    );
    expect(screen.getByText("Hold to Pick")).toBeTruthy();
    expect(screen.getByText("Queue")).toBeTruthy();
    expect(screen.getByText("Float")).toBeTruthy();
  });

  it("shows no action buttons for historical drafts", () => {
    render(<CardStatsModal {...defaultProps} />);
    expect(screen.queryByText("Hold to Pick")).toBeNull();
    expect(screen.queryByText("Queue")).toBeNull();
  });
});
