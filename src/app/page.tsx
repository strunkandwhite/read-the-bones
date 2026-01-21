import { Suspense } from "react";
import { headers } from "next/headers";
import { getCards } from "@/core/getCards";
import { getDraftStats } from "@/core/getDraftStats";
import { PageClient } from "./components/PageClient";

export default async function Home() {
  const headersList = await headers();
  const host = headersList.get("host") ?? "";
  const isLocal =
    host.startsWith("localhost") || host.startsWith("127.0.0.1");

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
