import { loadCardData } from "@/core/dataLoader";
import { PageClient } from "./components/PageClient";

/**
 * Main page Server Component.
 *
 * Fetches card data at build time and passes it to the client component
 * for interactive rendering with state management.
 */
export default async function Home() {
  const data = await loadCardData("data", [], "cache/scryfall.json");

  return (
    <PageClient
      initialCards={data.cards}
      initialPlayers={data.players}
      draftCount={data.draftCount}
      currentCubeCopies={data.currentCubeCopies}
      draftIds={data.draftIds}
      draftMetadata={data.draftMetadata}
      scryfallData={data.scryfallData}
    />
  );
}
