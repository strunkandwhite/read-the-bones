// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Sparkline } from "./Sparkline";
import type { DraftScore } from "@/core/types";

afterEach(cleanup);

function makeEntry(overrides: Partial<DraftScore> & { date: string }): DraftScore {
  return {
    draftId: "d1",
    draftName: "Test Draft",
    pickPosition: 12,
    wasPicked: true,
    numDrafters: 10,
    round: 2,
    ...overrides,
  };
}

const THREE_DRAFTS: DraftScore[] = [
  makeEntry({ date: "2026-04-01", pickPosition: 12 }),
  makeEntry({ date: "2026-05-01", pickPosition: 30 }),
  makeEntry({ date: "2026-06-01", pickPosition: 7 }),
];

// React synthesizes onMouseEnter/onMouseLeave from delegated mouseover/mouseout
// events, so firing "mouseEnter" directly does nothing — fire mouseOver/mouseOut.
function hover(index: number) {
  fireEvent.mouseOver(screen.getByTestId(`sparkline-hit-${index}`));
}

function unhover(index: number) {
  fireEvent.mouseOut(screen.getByTestId(`sparkline-hit-${index}`));
}

describe("Sparkline", () => {
  it("renders a hover target per point and no tooltip until hovered", () => {
    render(<Sparkline history={THREE_DRAFTS} />);
    expect(screen.getAllByTestId(/^sparkline-hit-/)).toHaveLength(3);
    expect(screen.queryByTestId("sparkline-tooltip")).toBeNull();
  });

  it("shows only the hovered point's date and pick label", () => {
    render(<Sparkline history={THREE_DRAFTS} />);
    hover(1);
    expect(screen.getByTestId("sparkline-tooltip").textContent).toBe("2026-05-01: Pick 30");
    expect(screen.queryByText("2026-04-01: Pick 12")).toBeNull();
    expect(screen.queryByText("2026-06-01: Pick 7")).toBeNull();
  });

  it("swaps the tooltip when a different point is hovered", () => {
    render(<Sparkline history={THREE_DRAFTS} />);
    hover(1);
    hover(2);
    expect(screen.getByTestId("sparkline-tooltip").textContent).toBe("2026-06-01: Pick 7");
  });

  it("hides the tooltip when the pointer leaves the point", () => {
    render(<Sparkline history={THREE_DRAFTS} />);
    hover(0);
    expect(screen.getByTestId("sparkline-tooltip")).toBeDefined();
    unhover(0);
    expect(screen.queryByTestId("sparkline-tooltip")).toBeNull();
  });

  it("labels a single unpicked draft as unpicked", () => {
    render(
      <Sparkline
        history={[makeEntry({ date: "2026-04-01", pickPosition: 540, wasPicked: false })]}
      />,
    );
    hover(0);
    expect(screen.getByTestId("sparkline-tooltip").textContent).toBe("2026-04-01: unpicked");
  });

  it("labels an aggregated date with a picked/total suffix", () => {
    render(
      <Sparkline
        history={[
          makeEntry({ date: "2026-04-01", pickPosition: 12, pickedCount: 4, totalCount: 5 }),
        ]}
      />,
    );
    hover(0);
    expect(screen.getByTestId("sparkline-tooltip").textContent).toBe("2026-04-01: Pick 12 (4/5)");
  });

  it("labels an aggregated date with no picks as unpicked with a total", () => {
    render(
      <Sparkline
        history={[
          makeEntry({
            date: "2026-04-01",
            pickPosition: 540,
            wasPicked: false,
            pickedCount: 0,
            totalCount: 5,
          }),
        ]}
      />,
    );
    hover(0);
    expect(screen.getByTestId("sparkline-tooltip").textContent).toBe("2026-04-01: unpicked (0/5)");
  });

  it("renders a dash when there is no history", () => {
    render(<Sparkline history={[]} />);
    expect(screen.getByText("-")).toBeDefined();
    expect(screen.queryByTestId(/^sparkline-hit-/)).toBeNull();
  });
});
