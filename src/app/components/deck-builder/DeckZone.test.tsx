// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { DeckZone } from "./DeckZone";
import { createEmptyColumnMap } from "@/core/deckBuilder";
import type { ColumnMap } from "@/core/types";

afterEach(cleanup);

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
