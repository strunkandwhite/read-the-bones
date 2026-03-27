import { Suspense } from "react";
import { getCards } from "@/core/getCards";
import { getDraftStats } from "@/core/getDraftStats";
import { PageClient } from "./components/PageClient";

export default async function Home() {
  if (process.env.E2E_TEST) {
    const fixtures = await import("../../e2e/fixtures/ssr-fixtures");
    return (
      <Suspense fallback={null}>
        <PageClient
          initialCardData={fixtures.cards}
          initialDraftStats={fixtures.draftStats}
        />
      </Suspense>
    );
  }

  const [data, draftStats] = await Promise.all([
    getCards({}),
    getDraftStats(),
  ]);

  return (
    <Suspense fallback={null}>
      <PageClient initialCardData={data} initialDraftStats={draftStats} />
    </Suspense>
  );
}
