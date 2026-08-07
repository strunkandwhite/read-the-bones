// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { DeckCard } from "./DeckCard";

const CARD_ID = "deck:mv-2:0:Lightning Bolt";

function renderDeckCard(props: Partial<React.ComponentProps<typeof DeckCard>> = {}) {
  return render(
    <DndContext>
      <SortableContext items={[CARD_ID]}>
        <DeckCard
          id={CARD_ID}
          cardName="Lightning Bolt"
          imageUri="https://example.test/bolt.jpg"
          isFloated={false}
          isQueued={false}
          isLast
          {...props}
        />
      </SortableContext>
    </DndContext>
  );
}

/** Hovering the card is what mounts the portaled preview and its stats bar. */
function hoverCard() {
  fireEvent.mouseEnter(screen.getAllByAltText("Lightning Bolt")[0].parentElement!);
}

afterEach(cleanup);

describe("DeckCard hover stats", () => {
  it("renders Worth when it is provided", () => {
    renderDeckCard({ worth: 0.047 });
    hoverCard();

    expect(screen.getByText("Worth")).toBeTruthy();
    expect(screen.getByText("+4.7%")).toBeTruthy();
  });

  it("omits Worth when undefined but still shows the Pick stat", () => {
    renderDeckCard({ pickScore: 12.3 });
    hoverCard();

    expect(screen.queryByText("Worth")).toBeNull();
    expect(screen.getByText("Pick")).toBeTruthy();
    expect(screen.getByText("12.3")).toBeTruthy();
  });

  it("shows the stats bar when only worth is present", () => {
    renderDeckCard({ worth: -0.023 });
    hoverCard();

    expect(screen.getByText("Worth")).toBeTruthy();
    expect(screen.getByText("-2.3%")).toBeTruthy();
    expect(screen.queryByText("Pick")).toBeNull();
    expect(screen.queryByText("GPWR")).toBeNull();
  });
});
