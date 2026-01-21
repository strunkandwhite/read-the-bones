import { loadCardDataFromTurso } from "@/build/tursoDataLoader";
import { PageClient } from "./components/PageClient";

/**
 * Main page Server Component.
 *
 * Fetches card data at build time from Turso database and passes it to
 * the client component for interactive rendering with state management.
 */
export default async function Home() {
  const data = await loadCardDataFromTurso();

  return (
    <PageClient
      initialCards={data.cards}
      draftCount={data.draftCount}
      currentCubeCopies={data.currentCubeCopies}
      draftIds={data.draftIds}
      draftMetadata={data.draftMetadata}
      scryfallData={data.scryfallData}
    />
  );
}
