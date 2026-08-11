// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { DeckZone } from "./DeckZone";
import { createEmptyColumnMap } from "@/core/deckBuilder";
import type { ColumnMap, ScryCard } from "@/core/types";

const { isLocalClientMock } = vi.hoisted(() => ({
  isLocalClientMock: vi.fn(() => true),
}));
vi.mock("@/core/isLocal", () => ({ isLocalClient: isLocalClientMock }));

afterEach(cleanup);
beforeEach(() => isLocalClientMock.mockReturnValue(true));

function renderZone(
  zone: "deck" | "sideboard",
  cardsByColumn: ColumnMap = {},
  props: Partial<React.ComponentProps<typeof DeckZone>> = {}
) {
  return render(
    <DndContext>
      <DeckZone
        zone={zone}
        columns={{ ...createEmptyColumnMap(zone), ...cardsByColumn }}
        scryfallData={new Map()}
        cardStats={new Map()}
        worthCards={new Map()}
        floatedCards={[]}
        queuedCardNames={[]}
        {...props}
      />
    </DndContext>
  );
}

/** The maindeck's mana-value rows, creature row first. */
function rowGrids(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("div.grid-cols-6"));
}

/** The zone-spanning grid: one for the whole sideboard, one for the maindeck's
 *  two rows plus the lands column beside them. */
function zoneGrids(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("div.grid-cols-7"));
}

/** The zone-level summary line (total, picked/floated/queued, c·s·l). */
function zoneHeader(zone: "deck" | "sideboard"): HTMLElement {
  return screen.getByText(zone === "deck" ? "Deck" : "Sideboard").parentElement!;
}

describe("DeckZone", () => {
  it("renders Creatures and Non-Creatures rows for the deck zone", () => {
    const { container } = renderZone("deck");

    expect(screen.getByText("Creatures")).toBeTruthy();
    expect(screen.getByText("Non-Creatures")).toBeTruthy();
    expect(rowGrids(container)).toHaveLength(2);
  });

  it("renders one unlabeled grid for the sideboard", () => {
    const { container } = renderZone("sideboard");

    expect(zoneGrids(container)).toHaveLength(1);
    expect(rowGrids(container)).toHaveLength(0);
    expect(screen.queryByText("Creatures")).toBeNull();
    expect(screen.queryByText("Non-Creatures")).toBeNull();
  });

  it("renders one lands column for the deck zone, outside both rows", () => {
    const { container } = renderZone("deck");

    expect(screen.getAllByText("Lands")).toHaveLength(1);
    for (const row of rowGrids(container)) {
      expect(within(row).queryByText("Lands")).toBeNull();
    }
  });

  it("renders a land beside the rows rather than in one of them", () => {
    const { container } = renderZone("deck", { lands: ["Sacred Foundry"] });

    expect(screen.getByText("Sacred Foundry")).toBeTruthy();
    for (const row of rowGrids(container)) {
      expect(within(row).queryByText("Sacred Foundry")).toBeNull();
    }
  });

  it("renders a card in an nc- column under the Non-Creatures row", () => {
    const { container } = renderZone("deck", {
      "mv-2": ["Grizzly Bears"],
      "nc-mv-2": ["Lightning Bolt"],
    });
    const [creatureRow, noncreatureRow] = rowGrids(container);

    expect(within(creatureRow).getByText("Grizzly Bears")).toBeTruthy();
    expect(within(noncreatureRow).getByText("Lightning Bolt")).toBeTruthy();
    expect(within(creatureRow).queryByText("Lightning Bolt")).toBeNull();

    const noncreatureLabel = screen.getByText("Non-Creatures").parentElement!;
    expect(within(noncreatureLabel).getByText("(1)")).toBeTruthy();
  });

  it("counts every row's cards in the zone total", () => {
    renderZone("deck", {
      "mv-2": ["Grizzly Bears"],
      "nc-mv-3": ["Lightning Bolt"],
      lands: ["Island"],
    });

    expect(within(zoneHeader("deck")).getByText("3")).toBeTruthy();
  });

  it("marks a floated card in an nc- column as floated", () => {
    renderZone(
      "deck",
      { "nc-mv-2": ["Lightning Bolt"] },
      { floatedCards: ["Lightning Bolt"], onRemoveFloat: () => {} }
    );

    expect(screen.getByLabelText("Remove speculative card")).toBeTruthy();
    expect(within(zoneHeader("deck")).getByText("1 floated")).toBeTruthy();
  });
});

describe("DeckZone color sources", () => {
  const scryfallData = new Map<string, ScryCard>([
    [
      "Tarmogoyf",
      {
        name: "Tarmogoyf",
        imageUri: "",
        manaCost: "{1}{G}",
        manaValue: 2,
        typeLine: "Creature — Lhurgoyf",
        colors: ["G"],
        colorIdentity: ["G"],
        oracleText: "",
      },
    ],
  ]);

  /** A green two-drop plus two Forests: eight sources wanted, two held. */
  const GREEN_DECK: ColumnMap = { "mv-2": ["Tarmogoyf"], lands: ["Forest", "Forest"] };

  it("shows sources over the sources the deck's spells want", () => {
    renderZone("deck", GREEN_DECK, { scryfallData });

    expect(within(zoneHeader("deck")).getByText("2")).toBeTruthy();
    expect(within(zoneHeader("deck")).getByText("/8")).toBeTruthy();
    expect(within(zoneHeader("deck")).getByAltText("G")).toBeTruthy();
  });

  it("names the spell driving the requirement", () => {
    renderZone("deck", GREEN_DECK, { scryfallData });

    expect(
      within(zoneHeader("deck")).getByTitle(
        "2 of the 8 green sources Tarmogoyf wants to be castable on curve."
      )
    ).toBeTruthy();
  });

  it("does not show the split off localhost", () => {
    isLocalClientMock.mockReturnValue(false);
    renderZone("deck", GREEN_DECK, { scryfallData });

    expect(within(zoneHeader("deck")).queryByText("/8")).toBeNull();
  });

  it("does not show the split for the sideboard", () => {
    renderZone("sideboard", { "mv-2": ["Tarmogoyf"], lands: ["Forest"] }, { scryfallData });

    expect(within(zoneHeader("sideboard")).queryByText("/8")).toBeNull();
  });
});
