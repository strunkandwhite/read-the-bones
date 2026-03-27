import { Suspense } from "react";
import { headers } from "next/headers";
import { getCards } from "@/core/getCards";
import { getDraftStats } from "@/core/getDraftStats";
import { isLocalHost } from "@/core/isLocal";
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

  const headersList = await headers();
  const host = headersList.get("host") ?? "";
  const isLocal = isLocalHost(host);

  const [data, draftStats] = await Promise.all([
    getCards({ includeMatchData: isLocal }),
    getDraftStats(),
  ]);

  return (
    <Suspense fallback={null}>
      <PageClient initialCardData={data} initialDraftStats={draftStats} />
    </Suspense>
  );
}
