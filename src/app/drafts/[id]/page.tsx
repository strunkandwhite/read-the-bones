import { Suspense } from "react";
import { getCards } from "@/core/getCards";
import { getDraftStats } from "@/core/getDraftStats";
import { PageClient } from "../../components/PageClient";

interface DraftPageProps {
  params: Promise<{ id: string }>;
}

export default async function DraftPage({ params }: DraftPageProps) {
  const { id } = await params;

  const [data, draftStats] = await Promise.all([
    getCards({}),
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
