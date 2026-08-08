// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

describe("Sparkline label formatting", () => {
  it("labels a single picked draft with its pick position", () => {
    render(<Sparkline history={[makeEntry({ date: "2026-04-01", pickPosition: 12 })]} />);
    expect(screen.getByText("2026-04-01: Pick 12")).toBeDefined();
  });

  it("labels a single unpicked draft as unpicked", () => {
    render(
      <Sparkline
        history={[makeEntry({ date: "2026-04-01", pickPosition: 540, wasPicked: false })]}
      />,
    );
    expect(screen.getByText("2026-04-01: unpicked")).toBeDefined();
  });

  it("labels an aggregated date with a picked/total suffix", () => {
    render(
      <Sparkline
        history={[
          makeEntry({ date: "2026-04-01", pickPosition: 12, pickedCount: 4, totalCount: 5 }),
        ]}
      />,
    );
    expect(screen.getByText("2026-04-01: Pick 12 (4/5)")).toBeDefined();
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
    expect(screen.getByText("2026-04-01: unpicked (0/5)")).toBeDefined();
  });
});
