import { Suspense } from "react";
import { headers } from "next/headers";
import { getCards } from "@/core/getCards";
import { getDraftStats } from "@/core/getDraftStats";
import { isLocalHost } from "@/core/isLocal";
import { PageClient } from "../../components/PageClient";

interface DraftPageProps {
  params: Promise<{ id: string }>;
}

export default async function DraftPage({ params }: DraftPageProps) {
  const { id } = await params;

  const headersList = await headers();
  const host = headersList.get("host") ?? "";
  const isLocal = isLocalHost(host);

  const [data, draftStats] = await Promise.all([
    getCards({ includeMatchData: isLocal }),
    getDraftStats(),
  ]);

  return (
    <Suspense fallback={null}>
      <PageClient
        initialCardData={data}
        initialDraftStats={draftStats}
        initialDraftId={id}
      />
    </Suspense>
  );
}
