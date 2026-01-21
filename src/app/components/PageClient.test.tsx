// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { PageClient, type PageClientProps } from "./PageClient";
import { DISTRIBUTION_BUCKET_COUNT } from "@/core/calculateStats";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";

// Mock child components to simplify rendering
vi.mock("./CardTable", () => ({
  CardTable: () => <div data-testid="card-table" />,
}));
vi.mock("./ColorFilter", () => ({
  ColorFilter: () => <div data-testid="color-filter" />,
}));
vi.mock("./ActiveDraftIndicator", () => ({
  ActiveDraftIndicator: () => <div data-testid="active-draft-indicator" />,
}));
vi.mock("./Settings", () => ({
  Settings: (props: { onDraftsChange: (s: Set<string>) => void }) => {
    // Expose onDraftsChange so tests can trigger draft selection changes
    (globalThis as Record<string, unknown>).__settingsOnDraftsChange =
      props.onDraftsChange;
    return <div data-testid="settings" />;
  },
}));
vi.mock("./DraftStats", () => ({
  DraftStats: () => <div data-testid="draft-stats" />,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

let mockSyncStatus = {
  lastSyncedAt: "0",
  syncInProgress: false,
  activeDrafts: [] as Array<{ id: string; numSeats: number }>,
  triggerSync: async () => {},
  manualSyncInFlight: false,
  dataChanged: false,
};

vi.mock("../hooks/useSyncStatus", () => ({
  useSyncStatus: () => mockSyncStatus,
}));

const defaultDraftStats: DraftStatsResponse = {
  winRateBySeat: [],
  winRateByColor: [],
  ingestionHash: "abc12345",
};

function makeTestProps(overrides?: Partial<CardStatsResponse>): PageClientProps {
  return {
    initialCardData: {
      cards: [
        {
          cardName: "Lightning Bolt",
          weightedGeomean: 5.0,
          totalPicks: 3,
          timesAvailable: 3,
          draftsPickedIn: 3,
          timesUnpicked: 0,
          maxCopiesInDraft: 1,
          colors: ["R"],
          scoreHistory: [],
          pickDistribution: new Array(DISTRIBUTION_BUCKET_COUNT).fill(0),
        },
      ],
      draftCount: 2,
      cubeCopies: { "Lightning Bolt": 1 },
      draftIds: ["draft-a", "draft-b", "draft-c"],
      completedDraftIds: ["draft-a", "draft-b"],
      draftMetadata: {
        "draft-a": { name: "Draft A", date: "2026-01-01" },
        "draft-b": { name: "Draft B", date: "2026-02-01" },
        "draft-c": { name: "Draft C", date: "2026-03-01" },
      },
      ingestionHash: "abc12345",
      ...overrides,
    },
    initialDraftStats: defaultDraftStats,
  };
}

describe("PageClient", () => {
  afterEach(() => {
    cleanup();
  });

  // ResizeObserver is not available in jsdom
  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).__settingsOnDraftsChange;
    mockSyncStatus = {
      lastSyncedAt: "0",
      syncInProgress: false,
      activeDrafts: [],
      triggerSync: async () => {},
      manualSyncInFlight: false,
      dataChanged: false,
    };
  });

  it("shows precomputed data with default selection", () => {
    render(<PageClient {...makeTestProps()} />);
    expect(screen.getByText(/2 drafts/)).toBeDefined();
  });

  it("does not fetch on initial render with default selection", () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    render(<PageClient {...makeTestProps()} />);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches card data when custom draft selection is made", async () => {
    const mockResponse: CardStatsResponse = {
      ...makeTestProps().initialCardData,
      cards: [],
      draftCount: 1,
      cubeCopies: {},
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    render(<PageClient {...makeTestProps()} />);

    const onDraftsChange = (globalThis as Record<string, unknown>)
      .__settingsOnDraftsChange as (s: Set<string>) => Promise<void>;

    // Select only draft-a (non-default selection triggers fetch)
    await act(async () => {
      await onDraftsChange(new Set(["draft-a"]));
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const urls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls.some((u: string) => u.includes("/api/cards?"))).toBe(true);
    expect(urls.some((u: string) => u.includes("/api/draft-stats?"))).toBe(true);
  });

  it("logs error when fetch fails after custom draft selection", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    render(<PageClient {...makeTestProps()} />);

    const onDraftsChange = (globalThis as Record<string, unknown>)
      .__settingsOnDraftsChange as (s: Set<string>) => Promise<void>;

    // Select only draft-a (non-default selection triggers fetch)
    await act(async () => {
      await onDraftsChange(new Set(["draft-a"]));
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to fetch card data:",
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it("shows 'No card data available.' when initialCards is empty", () => {
    render(
      <PageClient {...makeTestProps({ cards: [], draftCount: 0 })} />
    );
    const matches = screen.getAllByText("No card data available.");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("shows 'No drafts selected' when selection is empty", async () => {
    render(<PageClient {...makeTestProps()} />);

    const onDraftsChange = (globalThis as Record<string, unknown>)
      .__settingsOnDraftsChange as (s: Set<string>) => Promise<void>;

    await act(async () => {
      await onDraftsChange(new Set());
    });

    expect(screen.getByText("No drafts selected")).toBeDefined();
  });

  it("recovers when returning to default selection after failed fetch", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // First fetch fails
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    render(<PageClient {...makeTestProps()} />);

    const onDraftsChange = (globalThis as Record<string, unknown>)
      .__settingsOnDraftsChange as (s: Set<string>) => Promise<void>;

    // Trigger fetch failure with custom selection
    await act(async () => {
      await onDraftsChange(new Set(["draft-a"]));
    });

    // Now set up a successful response for returning to default
    const successResponse: CardStatsResponse = makeTestProps().initialCardData;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(successResponse),
    });

    // Return to default selection (all completed drafts)
    await act(async () => {
      await onDraftsChange(new Set(["draft-a", "draft-b"]));
    });

    expect(screen.getByText(/2 drafts/)).toBeDefined();
    consoleSpy.mockRestore();
  });

  it("filters out banned cards from display when active draft is selected", () => {
    mockSyncStatus = {
      ...mockSyncStatus,
      activeDrafts: [{ id: "draft-c", numSeats: 10 }],
    };
    localStorage.setItem("activeDraft", "draft-c");

    const props = makeTestProps({
      bannedCardNames: ["Lightning Bolt"],
    });
    render(<PageClient {...props} />);

    // The only card is banned + filtered, so we should see the empty state
    const emptyState = screen.queryAllByText("No card data available.");
    expect(emptyState.length).toBeGreaterThan(0);

    localStorage.removeItem("activeDraft");
  });
});
